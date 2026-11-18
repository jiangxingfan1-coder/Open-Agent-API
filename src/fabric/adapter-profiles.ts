import type { WorkerConfig } from '../config/config.js';
import type { NodeAdvertisement } from '../core/contracts.js';
import {
  agentConversionProfile,
  conversionProfile,
  type ConversionProfile,
} from '../engines/conformance.js';

export type ProfileHubView = {
  nodes: ReadonlyMap<
    string,
    {
      credential: { owner: string; nodeId: string; agents: string[] };
      executor: { advertisement(): NodeAdvertisement };
    }
  >;
  policy(nodeId: string): string;
};

/** Static ConversionProfiles for all enabled `adapter/<name>` entries on a worker. */
export function advertisedAdapterProfiles(
  config: WorkerConfig,
  readyNames: readonly string[],
): Record<string, ConversionProfile> {
  const out: Record<string, ConversionProfile> = {};
  for (const name of readyNames) {
    const engine = `adapter/${name}`;
    out[engine] = conversionProfile(engine, config);
  }
  return out;
}

/** Advertisement fragment for `WorkerRuntime.advertisement()`. */
export function adapterProfileAdvert(
  config: WorkerConfig,
  adapters: readonly (readonly [string, unknown])[],
): { adapterProfiles?: Record<string, ConversionProfile> } {
  return adapters.length
    ? {
        adapterProfiles: advertisedAdapterProfiles(
          config,
          adapters.map(([n]) => n),
        ),
      }
    : {};
}

/**
 * Resolve an agent's ConversionProfile: uses local worker config first, then falls back to any
 * online remote node of the same owner that advertised a profile for `adapter/<name>`.
 */
export function resolveConversionProfile(
  agent: { id?: string; engine: string; access?: { approval: string } },
  localWorker: WorkerConfig | undefined,
  hub: ProfileHubView,
  owner: string,
): ConversionProfile {
  const local = agentConversionProfile(agent, localWorker);
  if (local.access !== 'unknown' || !agent.engine.startsWith('adapter/')) return local;
  for (const node of hub.nodes.values()) {
    if (node.credential.owner !== owner || hub.policy(node.credential.nodeId) === 'revoked')
      continue;
    if (!permitsEngine(node.credential.agents, agent)) continue;
    const remote = node.executor.advertisement().execution?.adapterProfiles?.[agent.engine];
    if (remote) return remote;
  }
  return local;
}

function permitsEngine(grantedAgents: readonly string[], agent: { id?: string }): boolean {
  if (!agent.id || grantedAgents.includes('*')) return true;
  return grantedAgents.includes(agent.id);
}
