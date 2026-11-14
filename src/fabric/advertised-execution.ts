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
};
export const NO_NEGOTIATION = {
  byok: false,
  sandbox: false,
  providerState: false,
  clientTools: false,
  imageInput: false,
};

export function advertisedExecution(
  execution: NodeAdvertisement['execution'],
  negotiated: Negotiated,
): NodeAdvertisement['execution'] {
  if (!execution) return execution;
  const { byokProviders, sandbox, providerStateProviders, clientTools, imageInput, ...legacy } =
    execution;
  return {
    ...legacy,
    ...(negotiated.clientTools && clientTools ? { clientTools } : {}),
    ...(negotiated.byok && byokProviders ? { byokProviders } : {}),
    ...(negotiated.sandbox && sandbox ? { sandbox } : {}),
    ...(negotiated.providerState && providerStateProviders ? { providerStateProviders } : {}),
    ...(negotiated.imageInput && imageInput ? { imageInput } : {}),
  };
}
