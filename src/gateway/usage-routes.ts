import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/config.js';
import type { Store } from '../store/store.js';
import type { Auth } from './auth.js';
import { Fault } from '../core/util.js';
import { usageSettingsSchema } from '../core/usage-monitor.js';
import { usageReport } from '../store/usage-monitor.js';
import { UsageMonitor } from './usage-monitor.js';

export function registerUsageRoutes(
  app: FastifyInstance,
  deps: {
    auth: Auth;
    store: Store;
    config: GatewayConfig;
    isLocalRequest: (req: FastifyRequest) => boolean;
  },
) {
  const { auth, store, config } = deps;
  const monitor =
    config.localWorker && config.security.profile === 'local'
      ? new UsageMonitor(config.dataDir)
      : undefined;
  app.addHook('preClose', async () => {
    await monitor?.close();
  });
  const guard = (req: FastifyRequest) => {
    auth.requireNodeAdmin(req.principal);
    if (
      !monitor ||
      !deps.isLocalRequest(req) ||
      config.security.profile !== 'local' ||
      req.principal.owner !== config.localWorker?.owner
    )
      throw new Fault(
        'scope_denied',
        'Usage monitoring requires a direct local owner-admin connection.',
        403,
      );
    if (req.headers.origin) {
      let same = false;
      try {
        const origin = new URL(req.headers.origin);
        same = origin.host === req.headers.host && origin.protocol === `${req.protocol}:`;
      } catch {}
      if (!same) throw new Fault('scope_denied', 'Usage monitoring requires the same origin.', 403);
    }
    return monitor;
  };
  app.get('/v1/local/usage', async (req) => {
    const monitor = guard(req);
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(90).default(7) })
      .strict()
      .parse(req.query);
    const keys = auth.list(req.principal).map((k) => {
      const quota = (k.quota ?? {}) as {
        maxTotalTokens?: number;
        maxRuns?: number;
        expiresAt?: number;
      };
      const usage = k.usage as { usedTokens: number; usedRuns: number; activeRuns: number };
      return {
        id: k.id,
        name: k.name,
        agents: k.agents,
        usage,
        quota,
        remaining_tokens:
          quota.maxTotalTokens === undefined
            ? null
            : Math.max(0, quota.maxTotalTokens - usage.usedTokens),
        remaining_runs:
          quota.maxRuns === undefined ? null : Math.max(0, quota.maxRuns - usage.usedRuns),
      };
    });
    return {
      ledger: usageReport(store, req.principal.owner, days),
      keys,
      collectors: await monitor.view(),
    };
  });
  app.post('/v1/local/usage/settings', async (req) => {
    const monitor = guard(req);
    const body = z
      .object({
        settings: usageSettingsSchema,
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    return monitor.configure(body.settings, body.revision, () => {
      const current = auth.revalidate(req.headers.authorization);
      auth.requireNodeAdmin(current);
      if (current.owner !== req.principal.owner || current.keyId !== req.principal.keyId)
        throw new Fault('scope_denied', 'Administrator identity changed.', 403);
    });
  });
  app.post('/v1/local/usage/refresh', async (req) => {
    const monitor = guard(req);
    await monitor.refresh();
    return monitor.view();
  });
  app.post('/v1/local/usage/import', { bodyLimit: 2_097_152 }, async (req) => {
    const monitor = guard(req);
    const body = z
      .object({ collector: z.enum(['codexbar', 'ccusage']), snapshot: z.unknown() })
      .strict()
      .parse(req.body);
    return monitor.import(body.collector, body.snapshot);
  });
}
