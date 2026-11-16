import {
  MAX_AGENT_MODELS,
  type DiscoveredModel,
  type ModelCatalog,
} from '../core/model-catalog.js';
import { record } from './shared.js';
import { Fault, redact } from '../core/util.js';

export function normalizedModels(
  models: DiscoveredModel[],
  limit = MAX_AGENT_MODELS,
): DiscoveredModel[] {
  const unique = new Map<string, DiscoveredModel>();
  for (const m of models) {
    if (!m.id || m.id.length > 200 || /[\s\x00-\x1f\x7f]/.test(m.id) || redact(m.id) !== m.id)
      continue;
    if (!unique.has(m.id)) unique.set(m.id, { ...m, name: redact(m.name).slice(0, 240) || m.id });
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

export function parseAgyModels(text: string, limit = MAX_AGENT_MODELS): DiscoveredModel[] {
  return normalizedModels(
    text.split(/\r?\n/).flatMap((line) => {
      const fields = line.split('\t');
      const id = fields[0]?.trim();
      const name = fields.slice(1).join(' ').trim();
      return id && name ? [{ id, name, verification: 'discovered' as const }] : [];
    }),
    limit,
  );
}

export function parseAcpModels(value: unknown, limit = MAX_AGENT_MODELS): DiscoveredModel[] {
  const session = record(value);
  const config = (Array.isArray(session.configOptions) ? session.configOptions : [])
    .map(record)
    .find((o) => o.category === 'model' && o.type === 'select');
  const flatten = (items: unknown): DiscoveredModel[] =>
    !Array.isArray(items)
      ? []
      : items.flatMap((raw) => {
          const item = record(raw);
          if (Array.isArray(item.options)) return flatten(item.options);
          return typeof item.value === 'string'
            ? [
                {
                  id: item.value,
                  name: String(item.name ?? item.value),
                  isDefault: item.value === config?.currentValue,
                  verification: 'discovered' as const,
                },
              ]
            : [];
        });
  const legacy = record(session.models);
  if (!Array.isArray(legacy.availableModels) || !legacy.availableModels.length)
    return config ? normalizedModels(flatten(config.options), limit) : [];
  return normalizedModels(
    (Array.isArray(legacy.availableModels) ? legacy.availableModels : []).flatMap((raw) => {
      const m = record(raw);
      return typeof m.modelId === 'string'
        ? [
            {
              id: m.modelId,
              name: String(m.name ?? m.modelId),
              isDefault: m.modelId === legacy.currentModelId,
              verification: 'discovered' as const,
            },
          ]
        : [];
    }),
    limit,
  );
}

export type ModelDiscoveryResult = {
  source: string;
  models: DiscoveredModel[];
  unsupported?: boolean;
  clientTools?: 'hybrid';
  truncated?: boolean;
};

/** A failed refresh may preserve evidence, never an assertion of current availability. */
export class ModelCatalogCache {
  private identity = '';
  private value?: ModelCatalog;
  private pending?: Promise<ModelCatalog>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(
    private readonly discover: () => Promise<ModelDiscoveryResult>,
    options: { now?: () => number; ttlMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 300_000;
  }
  snapshot(identity = this.identity): ModelCatalog | undefined {
    if (identity !== this.identity) return undefined;
    if (!this.value) return undefined;
    return this.value.status === 'ready' && this.now() >= this.value.expiresAt
      ? { ...this.value, status: 'stale' }
      : this.value;
  }
  restore(identity: string, value: ModelCatalog): void {
    if (this.pending || this.value) return;
    this.identity = identity;
    this.value = { ...value, status: value.models.length ? 'stale' : value.status, expiresAt: 0 };
  }
  async refresh(identity: string, force = false): Promise<ModelCatalog> {
    if (this.identity !== identity) {
      this.identity = identity;
      this.value = undefined;
      this.pending = undefined;
    }
    if (this.pending) return this.pending;
    if (!force && this.value && this.value.expiresAt > this.now()) return this.value;
    const previous = this.value;
    const pending = Promise.resolve()
      .then(this.discover)
      .then((result): ModelCatalog => {
        const models = normalizedModels(result.models, MAX_AGENT_MODELS + 1);
        return {
          status: result.unsupported ? 'unsupported' : models.length ? 'ready' : 'unavailable',
          source: result.source,
          checkedAt: this.now(),
          expiresAt: this.now() + this.ttlMs,
          models: models.slice(0, MAX_AGENT_MODELS),
          ...(result.truncated || models.length > MAX_AGENT_MODELS ? { truncated: true } : {}),
          ...(result.clientTools ? { clientTools: result.clientTools } : {}),
        };
      })
      .catch((error: unknown): ModelCatalog => ({
        status: previous?.models.length ? 'stale' : 'unavailable',
        source: previous?.source ?? 'agent',
        checkedAt: previous?.checkedAt ?? 0,
        expiresAt: this.now() + Math.min(this.ttlMs, 30_000),
        models: previous?.models ?? [],
        ...(previous?.truncated ? { truncated: true } : {}),
        error:
          error instanceof Fault && error.code === 'adapter_auth_required'
            ? 'adapter_auth_required'
            : 'model_discovery_failed',
        ...(previous?.clientTools ? { clientTools: previous.clientTools } : {}),
      }))
      .then((value) => {
        if (identity === this.identity) this.value = value;
        return value;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }
}
