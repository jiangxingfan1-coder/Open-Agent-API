/** 提交与预检：授权、续接与交接检查、执行级别检查、幂等、限额、建运行。 */
import type { AgentDefinition, Principal, Run } from '../core/contracts.js';
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
import { localWorkerConfig, unavailableReason } from '../fabric/runnability.js';
import type { Invocation, PreviewRequest } from './invocation.js';
import { responseObject } from './response-object.js';
import { asRoutingStrategy } from './routing.js';
import { Fault, canonical, faultOf, id, scopeDenied, sha } from '../core/util.js';
import { LIMITS } from '../core/limits.js';
import { agentFallbackChain, routeInspector, toTopologyHint } from './fallback.js';
import { buildHandoffBrief, conversationOf } from './handoff.js';
import type { KernelRuntime } from './runtime.js';
import * as clientTools from './client-tools.js';

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
) {
  authorize(principal, invocation.agent, scope);
  const previous = invocation.previous_response_id
    ? rt.store.run(invocation.previous_response_id, principal.owner, visibleSubject(principal))
    : undefined;
  // 智能体交接：显式要求时，允许续接到另一个智能体，或让同一个智能体换一条模型线路。
  const handoffRequested =
    invocation.handoff === true ||
    (invocation as { metadata?: Record<string, string> }).metadata?.['oaa.handoff'] === 'true';
  const crossAgent = !!previous && previous.agentId !== invocation.agent;
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
  const handoff = !!previous && handoffRequested;
  // 交接后的新一轮不再受上一轮的模型线路、原生会话句柄和 provider 轮次状态约束；
  // 会话 ID、输入文件和生成的文件照常继承。
  const pinned = handoff ? undefined : previous;
  const bundle = rt.store.bundle(
    principal.owner,
    invocation.agent,
    crossAgent ? invocation.agent_version : (previous?.digest ?? invocation.agent_version),
  );
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
  const { bundle, previous, pinned, handoff, fileIds, inspect } = prepare(
    rt,
    principal,
    invocation,
    'invoke',
    providerKey !== undefined,
    clientTools.bridgeRequested(invocation),
  );
  const bridge = clientTools.prepareBridge(bundle.agent, invocation);
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
    if (bridge)
      clientTools.assertBridgePlaced(inspect(bundle.agent.provider, bundle.agent.model).reasons);
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
  if (!placed.available && bridge) clientTools.assertBridgePlaced(placed.reasons);
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
  const inputMessage =
    invocation.input +
    (newFiles.length ? `\n\nAdditional input files:\n${newFiles.join('\n')}` : '');
  // 交接：内核智能体拿到整理过的对话历史；外部智能体自己管理会话，改用一段交接说明。
  const conversation = handoff && previous ? conversationOf(previous) : undefined;
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
      messages: [
        ...(conversation ?? previous?.checkpoint.messages ?? []),
        { role: 'user', content: inputMessage },
      ],
      ...(pinned?.checkpoint.modelInstructions !== undefined
        ? { modelInstructions: pinned.checkpoint.modelInstructions }
        : {}),
      turn: 0,
      phase: 'model',
      nativeState: pinned?.checkpoint.nativeState,
      ...(handoffBrief ? { handoffBrief } : {}),
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
