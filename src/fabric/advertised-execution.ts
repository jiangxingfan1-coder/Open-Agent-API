/**
 * Execution metadata a worker may send. Newer fields that an older gateway's strict schema would
 * reject are included only after the gateway offered the matching feature in `welcome.features`.
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
  traceContext?: boolean;
  adapterProfiles?: boolean;
};
export const NO_NEGOTIATION: Negotiated = {
  byok: false,
  sandbox: false,
  providerState: false,
  clientTools: false,
  imageInput: false,
  modelCatalogs: false,
  agentPolicy: false,
  toolFreeReasoning: false,
  traceContext: false,
  adapterProfiles: false,
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
    traceContextVersion,
    adapterProfiles,
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
    ...(negotiated.traceContext && traceContextVersion ? { traceContextVersion } : {}),
    ...(negotiated.adapterProfiles && adapterProfiles && Object.keys(adapterProfiles).length
      ? { adapterProfiles }
      : {}),
  };
}
