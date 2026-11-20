import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.js';
import type { Store } from '../store/store.js';
import type { GatewayConfig } from '../config/config.js';
import { isOwnerWide } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { prune, type PrunableStore, type PruneOptions } from '../store/retention.js';

const DAY = 86_400_000;
/** Yield to the event loop between prune batches so requests keep flowing. */
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The Store keeps per-run caches; evict deleted runs from them. */
function prunable(store: Store): PrunableStore {
  const caches = store as unknown as Record<
    'projections' | 'runOwners' | 'eventRing',
    Map<string, unknown>
  >;
  return {
    db: store.db,
    root: store.root,
    forget: (ids, owners) => {
      for (const runId of ids)
        for (const cache of [caches.projections, caches.runOwners, caches.eventRing])
          cache?.delete(runId);
      // The same notification a run change sends: overview and activity caches recompute.
      for (const owner of owners) store.events.emit('summary', { owner });
    },
  };
}

/**
 * `POST /v1/maintenance/prune` (owner-wide admin; prunes that owner's data) and, when
 * `retention.runsDays` is configured, a periodic prune of every owner. Without that setting no
 * timer starts and nothing is deleted.
 */
export function registerRetention(
  app: FastifyInstance,
  { auth, store, config }: { auth: Auth; store: Store; config: GatewayConfig },
): void {
  const target = prunable(store);
  const workerDataDir = config.localWorker?.dataDir;
  let running: Promise<void> | undefined;
  let closing = false;
  /** One prune at a time: a second request waits for the first, then runs. */
  const once = async (options: PruneOptions) => {
    const enqueued = performance.now();
    while (running && !closing) await running;
    if (closing) throw new Fault('shutting_down', 'Maintenance is closing.', 503);
    const idle = Promise.withResolvers<void>();
    running = idle.promise;
    try {
      return await prune(target, {
        workerDataDir,
        pause,
        live: true,
        queueMs: performance.now() - enqueued,
        ...options,
      });
    } finally {
      running = undefined;
      idle.resolve();
    }
  };
  app.post('/v1/maintenance/prune', async (req) => {
    auth.require(req.principal, 'admin');
    if (!isOwnerWide(req.principal))
      throw new Fault('scope_denied', 'Pruning requires an owner-wide admin key.', 403);
    const b = z
      .object({
        older_than_ms: z.number().int().min(60_000),
        dry_run: z.boolean().default(false),
      })
      .strict()
      .parse(req.body ?? {});
    return once({
      olderThanMs: b.older_than_ms,
      dryRun: b.dry_run,
      owner: req.principal.owner,
      // Workspaces are keyed by owner hash only; leave them to the gateway-wide prune.
      workerDataDir: undefined,
    });
  });
  const days = config.retention?.runsDays;
  let timer: NodeJS.Timeout | undefined, first: NodeJS.Timeout | undefined;
  app.addHook('preClose', async () => {
    closing = true;
    clearInterval(timer);
    clearTimeout(first);
    await running;
  });
  if (days === undefined) return;
  const tick = () => {
    if (running) return;
    once({ olderThanMs: days * DAY }).then(
      (report) => {
        if (report.runs || report.files || report.workspaces)
          app.log.info({ retention: report }, 'retention prune finished');
      },
      (error: unknown) => app.log.warn({ err: error }, 'retention prune failed'),
    );
  };
  timer = setInterval(tick, (config.retention?.intervalMinutes ?? 60) * 60_000);
  timer.unref();
  // First pass shortly after startup, off the startup path.
  first = setTimeout(tick, 5_000);
  first.unref();
}
