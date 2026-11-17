import type { WorkerConfig } from '../config/config.js';
import { statSync } from 'node:fs';
import { modelCatalogSchema, type ModelCatalog } from '../core/model-catalog.js';
import { readBounded, sha, writePrivate, Fault } from '../core/util.js';
import { ModelCatalogCache } from '../engines/model-catalog.js';
import { discoverAgentModels } from '../engines/model-discovery.js';

/** Owns discovery per worker/configuration, never per HTTP caller or API credential. */
export class AgentModelCatalogs {
  private caches = new Map<string, ModelCatalogCache>();
  private timer?: NodeJS.Timeout;
  private readonly life = new AbortController();
  private pending = new Set<Promise<ModelCatalog>>();
  private persisting: Promise<unknown> = Promise.resolve();
  private readonly loaded: Promise<void>;
  onChange?: () => void;
  constructor(private readonly config: WorkerConfig) {
    this.loaded = this.restore();
  }
  private cache(engine: string): ModelCatalogCache {
    let cache = this.caches.get(engine);
    if (!cache) {
      cache = new ModelCatalogCache(() =>
        discoverAgentModels(this.config, engine, this.life.signal),
      );
      this.caches.set(engine, cache);
    }
    return cache;
  }
  private async restore(): Promise<void> {
    try {
      const value = JSON.parse(
        (await readBounded(this.config.dataDir, 'model-catalog.json', 4_000_000)).toString(),
      ) as { entries?: { engine?: unknown; identity?: unknown; catalog?: unknown }[] };
      for (const entry of Array.isArray(value.entries) ? value.entries.slice(0, 100) : []) {
        if (typeof entry.engine !== 'string' || entry.identity !== this.identity(entry.engine))
          continue;
        const catalog = modelCatalogSchema.safeParse(entry.catalog);
        if (catalog.success)
          this.cache(entry.engine).restore(this.identity(entry.engine), catalog.data);
      }
    } catch {
      /* A cache is optional and never an authentication source. */
    }
  }
  private persist(): Promise<unknown> {
    this.persisting = this.persisting
      .catch(() => {})
      .then(() =>
        writePrivate(
          this.config.dataDir,
          'model-catalog.json',
          JSON.stringify({
            version: 1,
            entries: Object.entries(this.snapshot()).map(([engine, catalog]) => ({
              engine,
              identity: this.identity(engine),
              catalog,
            })),
          }),
        ),
      );
    return this.persisting;
  }
  identity(engine: string): string {
    const native = this.config.native[engine as keyof WorkerConfig['native']];
    const adapter = this.config.adapters[engine.slice(8)];
    const executable =
      native?.executable ?? (adapter && 'command' in adapter ? adapter.command : undefined);
    let stamp: unknown;
    try {
      const stat = executable ? statSync(executable) : undefined;
      stamp = stat ? [stat.mtimeMs, stat.size, stat.ino] : undefined;
    } catch {
      stamp = null;
    }
    return sha(
      JSON.stringify(
        native
          ? [native.executable, native.args, native.enabled, native.models, stamp]
          : adapter
            ? [
                adapter.transport,
                'command' in adapter ? adapter.command : adapter.url,
                'args' in adapter ? adapter.args : [],
                adapter.enabled,
                stamp,
              ]
            : [],
      ),
    );
  }
  async refresh(engine: string, force = false): Promise<ModelCatalog> {
    await this.loaded;
    if (this.life.signal.aborted) throw new Fault('cancelled', 'Model discovery is closed.', 409);
    const cache = this.cache(engine);
    this.timer ??= setInterval(() => {
      for (const name of this.caches.keys()) void this.refresh(name).catch(() => {});
    }, 60_000).unref();
    const before = cache.snapshot(this.identity(engine));
    const pending = cache.refresh(this.identity(engine), force).then(async (catalog) => {
      if (before !== catalog && !this.life.signal.aborted) {
        await this.persist().catch(() => {});
        this.onChange?.();
      }
      return catalog;
    });
    this.pending.add(pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(pending);
    }
  }
  snapshot(): Record<string, ModelCatalog> {
    return Object.fromEntries(
      [...this.caches].flatMap(([engine, cache]) => {
        const value = cache.snapshot(this.identity(engine));
        return value ? [[engine, value]] : [];
      }),
    );
  }
  async close(): Promise<void> {
    this.life.abort();
    clearInterval(this.timer);
    await Promise.allSettled([...this.pending, this.loaded, this.persisting]);
  }
  claims(engines: string[]) {
    return Object.fromEntries(
      engines.map((engine) => [
        engine,
        engine === 'dsh'
          ? {
              mode: 'allowlist' as const,
              models: [
                'default',
                ...Object.entries(this.config.native.dsh?.models ?? {})
                  .filter(([, args]) => args.length)
                  .map(([name]) => name),
              ],
            }
          : { mode: 'declared' as const },
      ]),
    );
  }
}
