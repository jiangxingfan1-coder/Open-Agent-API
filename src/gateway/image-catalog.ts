/**
 * Whether an agent accepts images right now (docs/images.md), for `GET /v1/models` and the agent
 * listings: some route of it can be placed on a worker that declares image-input-v1 for that
 * provider (kernel) or engine (external agents). Callers can check before sending a screenshot.
 */
import type { AgentBundle } from '../core/contracts.js';

type Published = Pick<AgentBundle, 'agent' | 'digest'>;
import type { NodeHub } from '../fabric/network.js';

export function acceptsImages(
  hub: NodeHub,
  owner: string,
  bundle: Published,
  routes: readonly { provider: string; model: string }[],
): boolean {
  return routes.some(
    (r) =>
      hub.availability(
        owner,
        { ...bundle.agent, provider: r.provider, model: r.model },
        [],
        undefined,
        bundle.digest,
        false,
        false,
        false,
        false,
        'inline',
      ).available,
  );
}
