import type {
  AgentDefinition,
  FilePayload,
  ImageMode,
  NodeAdvertisement,
  NodeCredential,
  ToolBinding,
  Work,
} from '../core/contracts.js';
import { canonical } from '../core/util.js';

export type PlacementCode =
  | 'node_draining'
  | 'node_revoked'
  | 'agent_scope'
  | 'agent_node_restriction'
  | 'session_node_affinity'
  | 'file_node_restriction'
  | 'provider_unavailable'
  | 'native_disabled'
  | 'native_model_unsupported'
  | 'native_model_unreported'
  | 'capability_scope'
  | 'host_binding'
  | 'capability_unavailable'
  | 'capability_mismatch'
  | 'builtin_unreported'
  | 'script_runtime_disabled'
  | 'result_export_denied'
  | 'tool_selection_unreported'
  | 'byok_unsupported'
  | 'provider_state_unsupported'
  | 'sandbox_unavailable'
  | 'client_tools_unsupported'
  | 'image_input_unsupported';
export type PlacementReason = { code: PlacementCode; message: string };
export type PlacementNode = { credential: NodeCredential; advertisement: NodeAdvertisement };
export type PlacementRequest = {
  owner: string;
  agent: AgentDefinition;
  files: Pick<FilePayload, 'allowedNodes'>[];
  preferred?: string;
  /** The model call carries a caller-supplied key: only BYOK-advertising nodes qualify. */
  byok?: boolean;
  /** Scripts must run inside a verified OS sandbox (a `sandbox`-level caller). */
  sandbox?: boolean;
  providerState?: boolean;
  /** Caller tools are bridged (docs/harness.md): only workers declaring `clientTools` qualify. */
  clientTools?: boolean;
  /** The work carries images (docs/images.md): `url` when any of them is a URL. */
  images?: ImageMode;
};
/** Whether a worker's image-input-v1 declaration covers `demand` for this agent. */
export function imagesSupported(
  advert: NodeAdvertisement,
  agent: AgentDefinition,
  demand: ImageMode,
): boolean {
  const caps = advert.execution?.imageInput;
  if (!caps) return false;
  if (agent.engine !== 'kernel') return demand === 'inline' && !!caps.native[agent.engine];
  const mode = caps.providers[agent.provider];
  return mode === 'url' || (mode === 'inline' && demand === 'inline');
}
export const permits = (patterns: string[], value: string) =>
  patterns.includes('*') || patterns.includes(value);
const reason = (code: PlacementCode, message: string): PlacementReason => ({ code, message });

export function commonPlacement(request: PlacementRequest, node: PlacementNode): PlacementReason[] {
  const reasons: PlacementReason[] = [];
  const id = node.credential.nodeId;
  if (node.credential.owner !== request.owner || !permits(node.credential.agents, request.agent.id))
    reasons.push(reason('agent_scope', 'Node is not granted this agent.'));
  if (request.agent.allowedNodes && !request.agent.allowedNodes.includes(id))
    reasons.push(reason('agent_node_restriction', 'Agent is restricted to other nodes.'));
  if (request.preferred && request.preferred !== id)
    reasons.push(
      reason('session_node_affinity', 'The native session belongs to a different node.'),
    );
  if (request.files.some((f) => f.allowedNodes && !f.allowedNodes.includes(id)))
    reasons.push(
      reason(
        'file_node_restriction',
        'At least one input or artifact cannot be transferred to this node.',
      ),
    );
  return reasons;
}
export function modelPlacement(
  request: PlacementRequest,
  node: PlacementNode,
  toolNames?: string[],
): PlacementReason[] {
  const reasons = commonPlacement(request, node);
  const a = request.agent;
  const advert = node.advertisement;
  if (request.images && !imagesSupported(advert, a, request.images))
    reasons.push(
      reason(
        'image_input_unsupported',
        request.images === 'url'
          ? 'Worker cannot hand image URLs to this provider or engine (image-input-v1).'
          : 'Worker has not declared image input (image-input-v1) for this provider or engine.',
      ),
    );
  if (request.clientTools && !advert.execution?.clientTools?.native.includes(a.engine))
    reasons.push(
      reason(
        'client_tools_unsupported',
        'Worker has not declared caller-tool bridging (client-tools-v1) for this engine.',
      ),
    );
  if (a.engine === 'kernel') {
    if (request.providerState && !advert.execution?.providerStateProviders?.includes(a.provider))
      reasons.push(
        reason(
          'provider_state_unsupported',
          "Worker cannot preserve this provider's native turn state.",
        ),
      );
    if (request.byok) {
      // Never fall back to the node's own key: the provider must explicitly accept caller keys.
      if (!advert.execution?.byokProviders?.includes(a.provider))
        reasons.push(
          reason('byok_unsupported', 'Provider does not accept caller-supplied keys on this node.'),
        );
    } else if (!advert.providers.includes(a.provider))
      reasons.push(reason('provider_unavailable', 'Model provider is not available on this node.'));
    if (toolNames && toolNames.length !== a.tools.length && !advert.execution?.toolSelection)
      reasons.push(
        reason(
          'tool_selection_unreported',
          'Worker cannot confirm support for a restricted per-turn tool list.',
        ),
      );
  } else {
    if (!permits(node.credential.capabilities, `native/${a.engine}`))
      reasons.push(
        reason('capability_scope', 'Node credential does not grant this native executor.'),
      );
    if (!advert.natives.includes(a.engine))
      reasons.push(
        reason('native_disabled', 'Native adapter is not enabled or installed on this node.'),
      );
    if (request.sandbox && !advert.execution?.sandbox?.kinds.includes(`native/${a.engine}`))
      reasons.push(
        reason(
          'sandbox_unavailable',
          'This node has no verified OS sandbox for this native agent.',
        ),
      );
    if (advert.natives.includes(a.engine)) {
      const models = advert.execution?.nativeModels[a.engine];
      if (models?.mode === 'allowlist' && !models.models.includes(a.model))
        reasons.push(
          reason(
            'native_model_unsupported',
            'This node has no configured mapping for the selected native model.',
          ),
        );
      else if (!models && a.model !== 'default')
        reasons.push(
          reason(
            'native_model_unreported',
            'Legacy worker has not reported support for selecting a non-default native model.',
          ),
        );
    }
  }
  return reasons;
}
export function toolPlacement(
  request: PlacementRequest,
  node: PlacementNode,
  binding: ToolBinding,
): PlacementReason[] {
  if (
    binding.handler.kind === 'builtin' &&
    (binding.handler.name === 'memory_read' || binding.handler.name === 'memory_write')
  ) {
    return commonPlacement({ ...request, files: [], preferred: undefined }, node);
  }
  const reasons = commonPlacement({ ...request, preferred: undefined }, node);
  const cap = binding.capability;
  const advert = node.advertisement;
  if (!permits(node.credential.capabilities, cap.id))
    reasons.push(reason('capability_scope', 'Node credential does not grant this capability.'));
  if (cap.nodeId && cap.nodeId !== node.credential.nodeId)
    reasons.push(reason('host_binding', 'Capability belongs to a different host.'));
  if (!cap.resultExport)
    reasons.push(
      reason('result_export_denied', 'Capability does not permit results to leave its executor.'),
    );
  if (binding.handler.kind === 'builtin') {
    if (
      binding.handler.name !== 'memory_read' &&
      binding.handler.name !== 'memory_write' &&
      !advert.execution?.builtins.includes(binding.handler.name)
    )
      reasons.push(reason('builtin_unreported', 'Worker has not reported this built-in tool.'));
  } else if (binding.handler.kind === 'script') {
    if (!advert.execution?.scripts.includes(binding.handler.runtime))
      reasons.push(
        reason('script_runtime_disabled', 'The required portable script runtime is not enabled.'),
      );
    if (request.sandbox && !advert.execution?.sandbox?.kinds.includes('script'))
      reasons.push(
        reason('sandbox_unavailable', 'This node has no verified OS sandbox for scripts.'),
      );
  } else {
    const versions = advert.capabilities.filter((c) => c.id === cap.id);
    if (!versions.length)
      reasons.push(
        reason('capability_unavailable', 'The named host capability is not advertised.'),
      );
    else if (!versions.some((found) => canonical(found) === canonical(cap)))
      reasons.push(
        reason(
          'capability_mismatch',
          'Advertised capability metadata or version differs from the published binding.',
        ),
      );
  }
  return reasons;
}
export function workPlacement(
  work: Work,
  agent: AgentDefinition,
  node: PlacementNode,
  preferred?: string,
): PlacementReason[] {
  const request = {
    owner: work.context.owner,
    agent: work.kind === 'tool' ? agent : work.agent,
    files: work.context.files,
    preferred,
    byok: work.kind === 'model' && !!work.credential,
    providerState:
      work.kind === 'model' && work.messages.some((message) => !!message.providerState),
    sandbox: (work.kind === 'tool' || work.kind === 'native') && work.isolation === 'sandbox',
    // Kernel bridging appends synthetic caller bindings after the published tools.
    clientTools:
      (work.kind === 'native' && !!work.clientTools?.length) ||
      (work.kind === 'model' && work.agent.tools.length > agent.tools.length),
    images: workImageDemand(work),
  };
  return work.kind === 'tool'
    ? toolPlacement(request, node, work.binding)
    : modelPlacement(request, node, work.kind === 'model' ? work.toolNames : undefined);
}
function workImageDemand(work: Work): ImageMode | undefined {
  if (work.kind === 'native') return work.context.images?.length ? 'inline' : undefined;
  if (work.kind !== 'model') return undefined;
  const images = work.messages.flatMap((m) => m.images ?? []);
  if (!images.length) return undefined;
  return images.some((i) => i.kind === 'url') ? 'url' : 'inline';
}
export function workTarget(work: Work): string {
  if (work.kind === 'tool')
    return `tool:${work.binding.capability.id}@${work.binding.capability.version}`;
  return `${work.kind}:${work.agent.engine}:${work.agent.provider}:${work.agent.model}`;
}
