/**
 * Execution metadata a worker may send. `byokProviders`, `sandbox`, `providerStateProviders`,
 * `clientTools` and `imageInput` are newer fields that an older gateway's strict schema would
 * reject, so each is included only after the gateway offered the matching feature.
 */
import type { NodeAdvertisement } from '../core/contracts.js';

export type Negotiated = {
  byok: boolean;
  sandbox: boolean;
  providerState?: boolean;
  clientTools?: boolean;
  imageInput?: boolean;
  modelCatalogs?: boolean;
  agentPolicy?: boolean;
  toolFreeReasoning?: boolean;
};
export const NO_NEGOTIATION = {
  byok: false,
  sandbox: false,
  providerState: false,
  clientTools: false,
  imageInput: false,
  modelCatalogs: false,
  agentPolicy: false,
  toolFreeReasoning: false,
};

export function advertisedExecution(
  execution: NodeAdvertisement['execution'],
  negotiated: Negotiated,
): NodeAdvertisement['execution'] {
  if (!execution) return execution;
  const {
    byokProviders,
    sandbox,
    providerStateProviders,
    clientTools,
    imageInput,
    modelCatalogs,
    agentPolicyVersion,
    projectWorkspaces,
    projectEngines,
    toolFreeReasoning,
    ...legacy
  } = execution;
  return {
    ...legacy,
    ...(negotiated.clientTools && clientTools ? { clientTools } : {}),
    ...(negotiated.byok && byokProviders ? { byokProviders } : {}),
    ...(negotiated.sandbox && sandbox ? { sandbox } : {}),
    ...(negotiated.providerState && providerStateProviders ? { providerStateProviders } : {}),
    ...(negotiated.imageInput && imageInput ? { imageInput } : {}),
    ...(negotiated.modelCatalogs && modelCatalogs ? { modelCatalogs } : {}),
    ...(negotiated.agentPolicy && agentPolicyVersion ? { agentPolicyVersion } : {}),
    ...(negotiated.agentPolicy && projectWorkspaces ? { projectWorkspaces } : {}),
    ...(negotiated.agentPolicy && projectEngines ? { projectEngines } : {}),
    ...(negotiated.toolFreeReasoning && toolFreeReasoning ? { toolFreeReasoning } : {}),
  };
}
