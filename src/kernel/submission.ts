/** 提交与预检：授权、续接与交接检查、执行级别检查、幂等、限额、建运行。 */
import type { AgentDefinition, Principal, Run, RunImage } from '../core/contracts.js';
import {
  allowedExecution,
  executionFor,
  executionPermits,
  principalSubject,
  requiredExecution,
  sandboxable,
  visibleSubject,
} from '../core/contracts.js';
import { permits } from '../fabric/network.js';
import { discoveredAgent } from '../fabric/model-pool.js';
import { checkAccessPolicy } from './access-policy.js';
import { localWorkerConfig, unavailableReason } from '../fabric/runnability.js';
import type { Invocation, PreviewRequest } from './invocation.js';
import { responseObject } from './response-object.js';
import { asRoutingStrategy } from './routing.js';
import { Fault, canonical, faultOf, id, scopeDenied, sha } from '../core/util.js';
import { LIMITS } from '../core/limits.js';
import { agentFallbackChain, routeInspector, toTopologyHint } from './fallback.js';
import { buildHandoffBrief, conversationOf, portableSessions } from './handoff.js';
import type { KernelRuntime } from './runtime.js';
import * as clientTools from './client-tools.js';
import { assertImagesPlaced, imageDemand, modelImages, runImages } from './images.js';
import { supportsReasoning } from '../fabric/model-pool.js';
import { projectSelection } from './project-memory.js';
import { durability } from './durability.js';
import { mediaPolicy, mediaInstruction } from '../core/media.js';
import { modelIdentity } from '../fabric/model-identity.js';

/** A caller-supplied provider key: 1-4096 visible ASCII characters (header-safe, no spaces). */
export function checkProviderKey(key: string): void {
  if (!/^[\x21-\x7e]{1,4096}$/.test(key))
    throw new Fault(
      'invalid_provider_key',
      'X-OAA-Provider-Key must be 1-4096 visible ASCII characters.',
      400,
    );
}
/** `model_unavailable` 换成说得出原因的版本（哪个引擎没装/没启用、缺哪个环境变量）；其余原样返回。 */
function explainUnavailable(rt: KernelRuntime, agent: AgentDefinition, error: unknown): unknown {
  if (!(error instanceof Fault) || error.code !== 'model_unavailable') return error;
  const reason = unavailableReason(localWorkerConfig(rt.hub), agent);
  return reason ? new Fault('model_unavailable', reason, error.status) : error;
}
export function authorize(principal: Principal, agentId: string, scope: string): void {
  if (
    (!principal.scopes.includes(scope) && !principal.scopes.includes('admin')) ||
    !permits(principal.agents, agentId)
  )
    throw scopeDenied();
}
export function prepare(
  rt: KernelRuntime,
  principal: Principal,
  invocation: PreviewRequest,
  scope: 'read' | 'invoke',
  byok = false,
  bridging = false,
  images: readonly RunImage[] = [],
) {
  authorize(principal, invocation.agent, scope);
  const previous = invocation.previous_response_id
    ? rt.store.run(invocation.previous_response_id, principal.owner, visibleSubject(principal))
    : undefined;
  // 智能体交接：显式要求时，允许续接到另一个智能体，或让同一个智能体换一条模型线路。
  let handoffRequested =
    invocation.handoff === true ||
    (invocation as { metadata?: Record<string, string> }).metadata?.['oaa.handoff'] === 'true';
  const crossAgent = !!previous && previous.agentId !== invocation.agent;
  const metadata = (invocation as { metadata?: Record<string, string> }).metadata ?? {};
  if (crossAgent && invocation.handoff === undefined && metadata['oaa.handoff'] === undefined) {
    const source = rt.store.bundle(principal.owner, previous.agentId, previous.digest).agent;
    const target = rt.store.bundle(
      principal.owner,
      invocation.agent,
      invocation.agent_version,
    ).agent;
    handoffRequested ||= portableSessions(source) && portableSessions(target);
  }
  if (previous && (previous.status !== 'completed' || (crossAgent && !handoffRequested)))
    throw new Fault(
      'invalid_continuation',
      'Continuation requires a completed response from the same agent.',
      409,
    );
  if (
    previous &&
    !crossAgent &&
    invocation.agent_version &&
    invocation.agent_version !== previous.digest
  )
    throw new Fault(
      'version_conflict',
      'A continuing session keeps its original agent version.',
      409,
    );
  let handoff = !!previous && handoffRequested;
  // 交接后的新一轮不再受上一轮的模型线路、原生会话句柄和 provider 轮次状态约束；
  // 会话 ID、输入文件和生成的文件照常继承。
  let pinned = handoff ? undefined : previous;
  const storedBundle = rt.store.bundle(
    principal.owner,
    invocation.agent,
    crossAgent ? invocation.agent_version : (previous?.digest ?? invocation.agent_version),
  );
  const bundle = {
    ...storedBundle,
    agent: discoveredAgent(rt.hub, principal.owner, storedBundle.agent),
  };
  if (previous && !handoff && portableSessions(bundle.agent)) {
    const metadata = (invocation as { metadata?: Record<string, string> }).metadata ?? {};
    const changesSelection =
      invocation.model === 'auto'
        ? previous.route.mode === 'explicit'
        : previous.route.mode !== 'explicit' ||
          (invocation.model !== previous.route.id && invocation.model !== previous.route.model);
    const changesBoundary =
      metadata['oaa.tool_boundary'] !== undefined &&
      metadata['oaa.tool_boundary'] !== previous.metadata['oaa.tool_boundary'];
    if (changesSelection || changesBoundary) {
      handoff = true;
      pinned = undefined;
    }
  }
  checkExecution(rt, principal, bundle.agent);
  // Native agents take a caller key only when they will run sandboxed (the key goes into the
  // sandbox's environment); on the host they keep using their own configuration.
  const sandboxedNative =
    bundle.agent.engine !== 'kernel' &&
    executionFor(principal, bundle.agent.id) === 'sandbox' &&
    sandboxable(bundle.agent);
  if (byok && bundle.agent.engine !== 'kernel' && !sandboxedNative)
    throw new Fault(
      'byok_not_supported',
      'Caller-supplied provider keys apply only to kernel agents; native agents use their own configuration.',
      400,
    );
  const fileIds = [...new Set([...(previous?.fileIds ?? []), ...invocation.file_ids])];
  // New input files must be visible to this caller; inherited ones come from the checked
  // previous run, whose files belong to that run's subject.
  const inherited = new Set(previous?.fileIds ?? []);
  const inputs = fileIds.map((f) =>
    rt.store.file(f, principal.owner, inherited.has(f) ? undefined : visibleSubject(principal)),
  );
  if (inputs.reduce((sum, f) => sum + f.bytes, 0) > LIMITS.inputFilesBytes)
    throw new Fault('files_too_large', 'Total input exceeds 8 MiB.', 413);
  const files = [
    ...inputs,
    ...(previous?.artifactIds ?? []).map((f) => rt.store.file(f, principal.owner)),
  ];
  const preferred =
    typeof pinned?.checkpoint.nativeState?.nodeId === 'string'
      ? pinned.checkpoint.nativeState.nodeId
      : undefined;
  const inspect = routeInspector(rt.hub, principal.owner, bundle, files, {
    preferred,
    byok,
    sandbox: executionFor(principal, bundle.agent.id) === 'sandbox',
    providerState: pinned?.checkpoint.messages.some((m) => !!m.providerState) ?? false,
    clientTools: bridging,
    // Kernel history images are sent again on every turn (by reference), so they count too.
    images: imageDemand([
      ...images,
      ...(bundle.agent.engine === 'kernel' && !handoff
        ? (previous?.checkpoint.messages.flatMap((m) => m.images ?? []) ?? [])
        : []),
    ]),
  });
  return { bundle, previous, pinned, handoff, fileIds, inspect };
}
/**
 * Refuse, before any model call, an agent that needs more host authority than the key allows.
 * Delegates are checked against their current publications (depth-bounded); the delegated
 * sub-run is checked again when it is submitted, against the version it actually runs.
 */
export function checkExecution(
  rt: KernelRuntime,
  principal: Principal,
  agent: AgentDefinition,
): void {
  const allowed = allowedExecution(principal);
  if (allowed === 'host') return;
  const seen = new Set<string>();
  const visit = (def: AgentDefinition, depth: number): void => {
    if (def.access?.trust === 'private' && (principal.accountId || principal.externalCaller))
      throw new Fault(
        'isolation_required',
        'A public caller cannot reach a private agent through delegation.',
        403,
      );
    if (seen.has(def.id) || depth > LIMITS.delegationCheckDepth) return;
    seen.add(def.id);
    const required = requiredExecution(def);
    // A sandbox-level key may run host-requiring agents whose host parts all fit the sandbox.
    const fits =
      executionPermits(allowed, required) ||
      (allowed === 'sandbox' && sandboxable(def)) ||
      // Explicit per-agent opt-in (platform listing); each delegate needs its own.
      !!principal.hostAgents?.includes(def.id);
    if (!fits)
      throw new Fault(
        'isolation_required',
        `Agent '${def.id}' runs with ${required} authority; this API key is limited to ${allowed} execution.`,
        403,
      );
    for (const d of def.delegates ?? []) {
      let child: AgentDefinition | undefined;
      try {
        child = rt.store.bundle(principal.owner, d.agent).agent;
      } catch {
        continue;
      }
      visit(child, depth + 1);
    }
  };
  visit(agent, 0);
}
export function preview(
  rt: KernelRuntime,
  principal: Principal,
  request: PreviewRequest,
  byok = false,
) {
  const { bundle, pinned, inspect } = prepare(rt, principal, request, 'read', byok);
  const topology = (p: string, m: string) => toTopologyHint(inspect(p, m));
  const candidates = rt.router
    .candidates(principal.owner, bundle.digest, bundle.agent, topology)
    .map((c) => ({ ...c, placement: inspect(c.provider, c.model) }));
  let selected: Run['route'] | null = null;
  let error: { code: string; message: string } | null = null;
  try {
    selected = rt.router.select(
      principal.owner,
      bundle.digest,
      bundle.agent,
      request.model,
      topology,
      pinned,
    );
    if (!inspect(selected.provider, selected.model).available)
      throw new Fault(
        'model_unavailable',
        'The session-pinned route has no eligible executor.',
        503,
      );
  } catch (e) {
    const f = faultOf(explainUnavailable(rt, bundle.agent, e));
    selected = null;
    error = { code: f.code, message: f.message };
  }
  return {
    protocol: 'oaa/1',
    agent: bundle.agent.id,
    version: bundle.digest,
    selection: request.model,
    selected,
    candidates,
    error,
    session_pinned: !!pinned,
    evidence: 'configuration_and_observed_runtime',
    executes_model: false,
    reserves_capacity: false,
  };
}
export function submit(
  rt: KernelRuntime,
  principal: Principal,
  invocation: Invocation,
  idem?: string,
  providerKey?: string,
): Run {
  if (rt.closing()) throw new Fault('shutting_down', 'Gateway is shutting down.', 503);
  authorize(principal, invocation.agent, 'invoke');
  if (idem && (idem.length > LIMITS.idempotencyKeyChars || !idem.trim()))
    throw new Fault('invalid_idempotency_key', 'Idempotency-Key must contain 1-200 characters.');
  // 幂等指纹也区分是否带了自带的提供方密钥（BYOK）及是哪一把：只并入
  // 密钥加域前缀的 sha256，指纹本身再整体取 sha256，密钥不落库。不带密钥时指纹与旧版一致。
  const fingerprint = sha(
    canonical(
      providerKey === undefined
        ? invocation
        : { invocation, byok: sha(`oaa.idempotency.byok\n${providerKey}`) },
    ),
  );
  const subject = principalSubject(principal);
  if (idem) {
    const row = rt.store.findIdempotent(principal.owner, subject, idem);
    if (row) {
      if (row.fingerprint !== fingerprint)
        throw new Fault('idempotency_conflict', 'The key was used for different input.', 409);
      return rt.store.run(row.id, principal.owner, subject);
    }
  }
  if (rt.store.activeCount(principal.owner) >= LIMITS.ownerActiveRuns)
    throw new Fault('concurrency_limit', 'Owner has too many active requests.', 429);
  const perSubject = rt.limits.maxActiveRunsPerSubject;
  if (perSubject !== undefined && rt.store.activeCount(principal.owner, subject) >= perSubject)
    throw new Fault(
      'subject_concurrency_limit',
      `This caller already has ${perSubject} unfinished requests.`,
      429,
    );
  rt.auth()?.checkQuotaForRun(principal, invocation.agent);
  if (providerKey !== undefined) checkProviderKey(providerKey);
  // 备选智能体必须在提交时就存在，而且调用方对每一个都有调用权限。
  for (const fallback of agentFallbackChain(invocation.metadata)) {
    authorize(principal, fallback, 'invoke');
    checkExecution(rt, principal, rt.store.bundle(principal.owner, fallback).agent);
  }
  const images = runImages(rt.store, principal.owner, visibleSubject(principal), invocation);
  const imageFiles = images.flatMap((i) => (i.kind === 'file' ? [i.fileId] : []));
  const { bundle, previous, pinned, handoff, fileIds, inspect } = prepare(
    rt,
    principal,
    imageFiles.length
      ? { ...invocation, file_ids: [...invocation.file_ids, ...imageFiles] }
      : invocation,
    'invoke',
    providerKey !== undefined,
    clientTools.bridgeRequested(invocation),
    images,
  );
  const bridge = clientTools.prepareBridge(bundle.agent, invocation);
  checkAccessPolicy(bundle.agent, principal, invocation.metadata);
  const topology = (p: string, m: string) => toTopologyHint(inspect(p, m));
  const select = () =>
    rt.router.select(
      principal.owner,
      bundle.digest,
      bundle.agent,
      invocation.model,
      topology,
      pinned,
      {
        input: invocation.input,
        metadata: invocation.metadata,
        strategy: asRoutingStrategy(invocation.metadata?.['oaa.routing_strategy']),
      },
    );
  let route: ReturnType<typeof select>;
  try {
    route = select();
  } catch (error) {
    // 桥接运行没有可用线路，而原因是执行机器没有声明 client-tools-v1：报 400 而不是 503。
    const primary = inspect(bundle.agent.provider, bundle.agent.model).reasons;
    if (bridge) clientTools.assertBridgePlaced(primary);
    assertImagesPlaced(bundle.agent, images, primary);
    throw explainUnavailable(rt, bundle.agent, error);
  }
  if (
    bundle.agent.engine !== 'kernel' &&
    executionFor(principal, bundle.agent.id) === 'sandbox' &&
    providerKey === undefined
  )
    throw new Fault(
      'provider_key_required',
      "A sandboxed native agent runs only on the caller's own provider key: send X-OAA-Provider-Key.",
      400,
    );
  const placed = inspect(route.provider, route.model);
  const action = invocation.metadata['oaa.orchestration_action'];
  if (action !== undefined && action !== 'recommend' && action !== 'execute')
    throw new Fault('invalid_request', 'oaa.orchestration_action must be recommend or execute.');
  if (action === 'recommend' && (route.mode !== 'auto' || !bundle.agent.orchestration?.enabled))
    throw new Fault(
      'invalid_request',
      'Recommendation mode requires an orchestrated automatic model selection.',
    );
  if (
    invocation.metadata['oaa.tools_disabled'] === 'true' &&
    !supportsReasoning(rt.hub, principal.owner, bundle.agent)
  )
    throw new Fault(
      'capability_unavailable',
      'This engine does not advertise enforced tool-free reasoning.',
      503,
    );
  if (
    bundle.agent.orchestration?.enabled &&
    bundle.agent.orchestration.scope === 'agent' &&
    route.mode === 'auto' &&
    invocation.metadata['oaa.orchestration_child'] !== 'true' &&
    !supportsReasoning(rt.hub, principal.owner, bundle.agent)
  )
    throw new Fault(
      'capability_unavailable',
      'This engine cannot yet plan safely. Use a fixed model or connect a verified reasoning adapter.',
      503,
    );
  if (!placed.available && bridge) clientTools.assertBridgePlaced(placed.reasons);
  if (!placed.available) assertImagesPlaced(bundle.agent, images, placed.reasons);
  if (!placed.available)
    throw explainUnavailable(
      rt,
      bundle.agent,
      new Fault(
        'model_unavailable',
        'The session-pinned route has no eligible executor. Inspect /v1/agents/preview for constraints.',
        503,
      ),
    );
  const newFiles =
    pinned?.checkpoint.modelInstructions !== undefined
      ? fileIds
          .filter((file) => !pinned.fileIds.includes(file))
          .map((file) => {
            const info = rt.store.file(file, principal.owner);
            return `inputs/${info.id}/${info.name}`;
          })
      : [];
  const media = mediaPolicy(invocation.metadata);
  const inputMessage =
    invocation.input +
    mediaInstruction(media) +
    (newFiles.length ? `\n\nAdditional input files:\n${newFiles.join('\n')}` : '');
  const project = projectSelection(rt.store, principal, invocation.metadata, previous);
  const durable = durability(bundle.agent, invocation.metadata);
  // 交接：内核智能体拿到整理过的对话历史；外部智能体自己管理会话，改用一段交接说明。
  const conversation = handoff && previous ? conversationOf(previous) : undefined;
  const continuationBrief =
    previous &&
    bundle.agent.engine !== 'kernel' &&
    (bundle.agent.modelPolicy || bundle.agent.access || bundle.agent.orchestration)
      ? buildHandoffBrief({
          fromAgent: previous.agentId,
          conversation: conversationOf(previous),
          inputFiles: previous.fileIds.map((f) => rt.store.file(f, principal.owner).name),
          artifacts: previous.artifactIds.map((f) => rt.store.file(f, principal.owner).name),
        })
      : undefined;
  const handoffBrief =
    conversation && previous && bundle.agent.engine !== 'kernel'
      ? buildHandoffBrief({
          fromAgent: previous.agentId,
          conversation,
          inputFiles: (previous.fileIds ?? []).map(
            (file) => rt.store.file(file, principal.owner).name,
          ),
          artifacts: (previous.artifactIds ?? []).map(
            (file) => rt.store.file(file, principal.owner).name,
          ),
        })
      : undefined;
  const run: Run = {
    id: id('resp'),
    owner: principal.owner,
    subject,
    agentId: invocation.agent,
    digest: bundle.digest,
    sessionId: previous?.sessionId ?? id('session'),
    previousId: previous?.id ?? null,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    input: invocation.input,
    fileIds,
    ...(images.length ? { images } : {}),
    output: [],
    usage: null,
    error: null,
    artifactIds: [...(previous?.artifactIds ?? [])],
    metadata:
      handoff && previous && previous.agentId !== invocation.agent
        ? { ...invocation.metadata, 'oaa.handoff_from': previous.agentId }
        : invocation.metadata,
    route,
    checkpoint: {
      modelIdentity: modelIdentity(rt.hub, principal.owner, bundle.agent),
      ...(media ? { media } : {}),
      ...(durable ? { durability: durable } : {}),
      ...(project ? { project } : {}),
      messages: [
        ...(conversation ?? previous?.checkpoint.messages ?? []),
        {
          role: 'user',
          content: inputMessage + (project?.context ?? ''),
          ...(bundle.agent.engine === 'kernel' && images.length
            ? { images: modelImages(images) }
            : {}),
        },
      ],
      ...(pinned?.checkpoint.modelInstructions !== undefined
        ? { modelInstructions: pinned.checkpoint.modelInstructions }
        : {}),
      turn: 0,
      phase: 'model',
      nativeState: pinned?.checkpoint.nativeState,
      ...(bundle.agent.orchestration?.enabled
        ? {
            modelPool: rt.router
              .candidates(principal.owner, bundle.digest, bundle.agent, topology)
              .filter((candidate) => candidate.automatic_eligible)
              .map(({ id, model, provider, priority, qualityTier, costTier, speedTier }) => ({
                id,
                model,
                provider,
                priority,
                qualityTier,
                costTier,
                speedTier,
              })),
          }
        : {}),
      ...(bundle.agent.access ? { approvalAuthority: bundle.agent.access.approval } : {}),
      ...(principal.connection?.allowedModes
        ? { toolGrants: [...principal.connection.allowedModes] }
        : {}),
      ...(principal.accountId || principal.externalCaller ? { externalCaller: true } : {}),
      ...(handoffBrief ? { handoffBrief } : {}),
      ...(continuationBrief ? { continuationBrief } : {}),
      grantedAgents: [...principal.agents],
      ...(principal.keyId ? { keyId: principal.keyId } : {}),
      execution: allowedExecution(principal),
      ...(principal.hostAgents?.length ? { hostAgents: [...principal.hostAgents] } : {}),
      ...(providerKey !== undefined ? { byok: true } : {}),
      ...(bridge ? { bridge } : {}),
      ...(invocation.output_contract
        ? {
            outputContract: {
              ...invocation.output_contract,
              repairs: rt.limits.structuredRepairs ?? 1,
            },
          }
        : {}),
    },
  };
  if (invocation.output_contract)
    run.metadata = { ...run.metadata, 'oaa.output_contract': invocation.output_contract.kind };
  const created = rt.store.createRun(run, idem, fingerprint, {
    type: 'response.created',
    data: { response: responseObject(run) },
  });
  if (created.created) {
    if (providerKey !== undefined) rt.byokKeys.set(run.id, providerKey);
    rt.auth()?.beginKeyRun(principal.keyId, principal.owner, run.id, run.agentId);
    rt.admission.queue.push(run.id);
    setImmediate(() => rt.admission.pump());
  }
  return created.run;
}
