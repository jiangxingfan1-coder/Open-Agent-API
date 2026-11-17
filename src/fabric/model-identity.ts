import type { AgentDefinition } from '../core/contracts.js';
import type { NodeHub } from './network.js';
import { WorkerRuntime } from './worker.js';
import { canonical, sha } from '../core/util.js';
import { EVALUATION_SUITE } from '../core/model-evaluation.js';

export function modelIdentity(hub: NodeHub, owner: string, agent: AgentDefinition): string {
  return sha(
    canonical({
      suite: EVALUATION_SUITE,
      agent,
      catalogs: hub
        .inventory(owner)
        .map((node) => {
          const catalog = (
            node.execution as
              { modelCatalogs?: Record<string, { source: string; models: unknown[] }> } | undefined
          )?.modelCatalogs?.[agent.engine];
          const executor = [...hub.nodes.values()].find(
            (n) => n.credential.nodeId === node.nodeId && n.credential.owner === owner,
          )?.executor;
          return [
            node.nodeId,
            catalog?.source,
            executor instanceof WorkerRuntime
              ? executor.modelCatalogs.identity(agent.engine)
              : undefined,
            catalog?.models,
          ];
        })
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    }),
  );
}
