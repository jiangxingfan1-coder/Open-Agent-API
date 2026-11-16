/**
 * 委托步骤：把一次工具调用交给子智能体，作为一个后台子运行执行，父运行等它结束。
 *
 * 一致性规则（docs/architecture.md「委托步骤的副作用等级」）：
 * - 子运行提交成功后、开始等待前，子运行 ID 登记在步骤记录的 `childRunId` 上。
 * - 恢复重放到这一步时先找已登记的子运行：已完成直接取结果；仍活跃继续等；已中断或结果未知
 *   （等级不是 read）则步骤为 uncertain，等人工确认；失败、取消或未完成时，等级为 read /
 *   idempotent-write 才重新委托，unknown 也要人工确认。
 * - 等待被父运行取消或网关关闭打断时，等级不是 read 的步骤记 uncertain（子运行可能已经做了事）。
 * - 子运行的产物不并入父运行，只在委托结果里给出引用（`artifacts`）。
 */
import type {
  AgentDefinition,
  DelegateBinding,
  Effect,
  ExecutionStep,
  Principal,
  Run,
  ToolCall,
  OutputContract,
} from '../core/contracts.js';
import { LEGACY_SUBJECT, sandboxable } from '../core/contracts.js';
import { Fault, checkAbort, faultOf } from '../core/util.js';
import { LIMITS } from '../core/limits.js';
import { permits } from '../fabric/network.js';
import type { Store } from '../store/store.js';
import type { Invocation } from './invocation.js';
import { addUsage, stepIdFor } from './run-state.js';
import { contractInstruction } from './output-contract.js';

/** 委托需要的内核能力。由 Kernel 显式提供，不暴露它的私有字段。 */
export interface DelegateRuntime {
  readonly store: Store;
  submit(principal: Principal, invocation: Invocation, idem?: string, providerKey?: string): Run;
  wait(runId: string, includeActions: boolean, signal: AbortSignal): Promise<Run>;
  cancel(principal: Principal, runId: string): Promise<Run>;
  /** 父运行的调用方密钥（BYOK），只在内存里。 */
  providerKey(runId: string): string | undefined;
  closing(): boolean;
  /** 子运行排到准入队列最前面。 */
  prioritize(runId: string): void;
  /** 父运行开始等待一个子运行：同一父运行的第一个委托借出它的运行槽。 */
  lendSlot(parentRunId: string): void;
  /** 父运行等完一个子运行：最后一个委托归还时重新占用运行槽（没有空位时等到有空位）。 */
  reclaimSlot(parentRunId: string, signal: AbortSignal): Promise<void>;
}

/** 本轮被打断的委托所属的执行切片（与 types.ts 的 ExecutionSlice 同形）。 */
export type DelegateSlice = { progressed: boolean };

/**
 * 委托步骤的副作用等级，按子智能体的实际情况登记，而不是一律当作只读。
 * 这个等级决定后台服务意外重启后怎么办：只读的步骤会自动重跑；可能改过东西的步骤会停下来
 * 等人工确认，避免让子智能体把同一件事再做一遍。
 * 外部智能体（Claude Code、Codex、ACP 等）内部做了什么看不见，一律按「影响未知」处理。
 */
export function delegateEffect(store: Store, owner: string, agentId: string): Effect {
  let child: AgentDefinition;
  try {
    child = store.bundle(owner, agentId).agent;
  } catch {
    return 'unknown';
  }
  if (child.engine !== 'kernel' || child.delegates?.length) return 'unknown';
  const effects = child.tools.map((tool) => tool.capability.effect);
  if (effects.every((effect) => effect === 'read')) return 'read';
  if (effects.every((effect) => effect === 'read' || effect === 'idempotent-write'))
    return 'idempotent-write';
  return 'unknown';
}

const ACTIVE: readonly Run['status'][] = ['queued', 'in_progress', 'requires_action'];

/** 子运行以「结果未知」结束：被中断，或错误码就是 effect_outcome_unknown。 */
const outcomeUnknown = (child: Run) =>
  child.status === 'interrupted' || child.error?.code === 'effect_outcome_unknown';

/** 恢复重放时已登记的子运行怎么处理。 */
function replayDecision(effect: Effect, child: Run): 'reuse' | 'wait' | 'redelegate' | 'uncertain' {
  if (child.status === 'completed') return 'reuse';
  if (ACTIVE.includes(child.status)) return 'wait';
  if (outcomeUnknown(child)) return effect === 'read' ? 'redelegate' : 'uncertain';
  return effect === 'read' || effect === 'idempotent-write' ? 'redelegate' : 'uncertain';
}

export async function callDelegate(
  rt: DelegateRuntime,
  run: Run,
  delegate: DelegateBinding,
  call: ToolCall,
  signal: AbortSignal,
  slice: DelegateSlice,
  options: {
    metadata?: Record<string, string>;
    outputContract?: OutputContract;
    fileIds?: string[];
  } = {},
): Promise<unknown> {
  const store = rt.store;
  checkAbort(signal);
  const stepId = stepIdFor(run.id, run.checkpoint.turn, call.id);
  const existing = store.getStep(stepId);
  if (existing?.status === 'completed') return existing.result?.value;

  const taskInput = call.arguments.task ?? call.arguments.input;
  if (typeof taskInput !== 'string' || !taskInput.trim()) {
    throw new Fault(
      'invalid_tool_arguments',
      `Delegate '${delegate.name}' requires a non-empty string 'task' argument.`,
    );
  }
  const modelOverride =
    typeof call.arguments.model === 'string' && call.arguments.model.trim()
      ? call.arguments.model.trim()
      : (delegate.model ?? 'auto');

  const depth = (run.checkpoint.delegationDepth ?? 0) + 1;
  if (depth > LIMITS.delegationDepth) {
    throw new Fault(
      'delegation_depth_exceeded',
      'Sub-agent delegation depth exceeds the maximum limit (3).',
      409,
    );
  }

  const grantedAgents = run.checkpoint.grantedAgents ?? ['*'];
  if (!permits(grantedAgents, delegate.agent)) {
    throw new Fault(
      'scope_denied',
      `Caller principal is not authorized to delegate to agent '${delegate.agent}'.`,
      403,
    );
  }

  const step: ExecutionStep = existing ?? {
    id: stepId,
    runId: run.id,
    callId: call.id,
    name: delegate.name,
    effect: delegateEffect(store, run.owner, delegate.agent),
    status: 'running',
    arguments: call.arguments,
  };
  const childPrincipal: Principal = {
    owner: run.owner,
    name: `delegate:${run.agentId}`,
    agents: grantedAgents,
    scopes: ['read', 'invoke', 'files'],
    // A delegate's run, artifacts and memories stay in the calling subject's partition.
    subject: run.subject ?? LEGACY_SUBJECT,
    // ...and can never exceed the execution level of the key that started the parent.
    execution: run.checkpoint.execution ?? 'host',
    ...(run.checkpoint.externalCaller ? { externalCaller: true } : {}),
    ...(run.checkpoint.toolGrants
      ? { connection: { allowedModes: [...run.checkpoint.toolGrants] } }
      : {}),
    ...(run.checkpoint.hostAgents ? { hostAgents: run.checkpoint.hostAgents } : {}),
  };
  const fail = (status: 'failed' | 'uncertain', code: string, childRunId?: string): void => {
    step.status = status;
    step.error = code;
    store.step(step, {
      type: 'subagent.failed',
      data: { step_id: stepId, ...(childRunId ? { child_run_id: childRunId } : {}), code },
    });
  };
  const unconfirmed = (code: string, childRunId: string): never => {
    fail('uncertain', code, childRunId);
    throw new Fault(
      'effect_outcome_unknown',
      `Delegated sub-agent '${delegate.agent}' (${childRunId}) has no confirmed outcome (${code}). Reconcile its step before resuming.`,
      409,
      true,
    );
  };

  // 恢复重放：重新挂上已登记的子运行，而不是再委托一次。
  let childRun: Run | undefined;
  if (existing?.childRunId) {
    let prior: Run | undefined;
    try {
      prior = store.run(existing.childRunId);
    } catch {
      // A missing prior child run means the delegate starts fresh.
    }
    if (prior) {
      const decision = replayDecision(step.effect, prior);
      if (decision === 'reuse') return finish(store, run, delegate, step, prior, slice);
      if (decision === 'uncertain')
        unconfirmed(prior.error?.code ?? `subagent_${prior.status}`, prior.id);
      if (decision === 'wait') childRun = prior;
    }
  }

  step.status = 'running';
  store.step(step, {
    type: 'subagent.started',
    data: {
      step_id: stepId,
      delegate: delegate.name,
      target_agent: delegate.agent,
      depth,
    },
  });

  if (!childRun) {
    try {
      // A BYOK parent funds its kernel delegates (and, at sandbox level, its sandboxed native
      // delegates) with the same caller key; host native delegates use their own configuration.
      let childKey: string | undefined;
      try {
        const child = store.bundle(run.owner, delegate.agent).agent;
        if (
          child.engine === 'kernel' ||
          (run.checkpoint.execution === 'sandbox' &&
            sandboxable(child) &&
            !run.checkpoint.hostAgents?.includes(child.id))
        )
          childKey = rt.providerKey(run.id);
      } catch {
        // Unknown child agent: submit reports it below, so no key is forwarded.
      }
      childRun = rt.submit(
        childPrincipal,
        {
          protocol: 'oaa/1',
          agent: delegate.agent,
          input: options.outputContract
            ? `${taskInput}\n\n${contractInstruction(options.outputContract)}`
            : taskInput,
          model: modelOverride,
          stream: false,
          background: true,
          file_ids: options.fileIds ?? (delegate.forwardFiles ? [...run.fileIds] : []),
          ...(options.outputContract ? { output_contract: options.outputContract } : {}),
          metadata: {
            ...options.metadata,
            'oaa.parent_run_id': run.id,
            'oaa.delegate_name': delegate.name,
          },
        },
        undefined,
        childKey,
      );
    } catch (err) {
      const f = faultOf(err);
      fail('failed', f.code);
      throw f;
    }
    childRun.checkpoint.delegationDepth = depth;
    childRun.checkpoint.grantedAgents = [...grantedAgents];
    store.save(childRun);
    // 登记子运行：之后无论怎样中断，恢复时都能重新挂上它。
    step.childRunId = childRun.id;
    store.step(step);
  }
  const child = childRun;
  rt.prioritize(child.id);

  // 委托自己的超时：中止原因就是 delegate_timeout，wait() 原样抛出。
  const timeout = new AbortController();
  const timer = setTimeout(
    () =>
      timeout.abort(
        new Fault(
          'delegate_timeout',
          `Delegated sub-agent '${delegate.agent}' did not finish within ${delegate.timeoutMs} ms; it was cancelled.`,
          504,
        ),
      ),
    delegate.timeoutMs,
  );
  const combined = AbortSignal.any([signal, timeout.signal]);
  const cancelChild = () => void rt.cancel(childPrincipal, child.id).catch(() => {});
  combined.addEventListener('abort', cancelChild, { once: true });

  let finished: Run;
  rt.lendSlot(run.id);
  try {
    finished = await rt.wait(child.id, false, combined);
  } catch (err) {
    cancelChild();
    let f: Fault;
    if (timeout.signal.aborted && !signal.aborted) {
      f = faultOf(timeout.signal.reason);
      fail('failed', f.code, child.id);
    } else {
      const interrupted = signal.aborted || rt.closing();
      // 子运行可能已经做了事：等级不是 read 的步骤不能当成失败重放。
      const uncertain = interrupted && step.effect !== 'read';
      f = !interrupted
        ? faultOf(err)
        : rt.closing()
          ? new Fault(
              'shutting_down',
              'The gateway shut down while waiting for a delegated sub-agent.',
              503,
              uncertain,
            )
          : new Fault(
              'cancelled',
              'Execution was cancelled while waiting for a delegated sub-agent; the sub-agent run was cancelled too.',
              409,
            );
      fail(uncertain ? 'uncertain' : 'failed', f.code, child.id);
    }
    throw f;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', cancelChild);
    await rt.reclaimSlot(run.id, signal);
  }

  if (finished.status !== 'completed') {
    const code = finished.error?.code ?? `subagent_${finished.status}`;
    if (outcomeUnknown(finished) && step.effect !== 'read') unconfirmed(code, finished.id);
    const msg =
      finished.error?.message ??
      `Delegated sub-agent '${delegate.agent}' terminated with status '${finished.status}'.`;
    fail('failed', code, finished.id);
    throw new Fault(code, msg, 502);
  }
  return finish(store, run, delegate, step, finished, slice);
}

/**
 * 用已完成的子运行完成委托步骤：用量与步骤在同一个检查点里提交，所以同一个子运行的用量
 * 只会累加一次（提交失败时撤回内存里的累加；已完成的步骤重放时直接返回结果，不再累加）。
 */
function finish(
  store: Store,
  run: Run,
  delegate: DelegateBinding,
  step: ExecutionStep,
  child: Run,
  slice: DelegateSlice,
): unknown {
  // 子运行的产物不并入父运行，只在委托结果里给出引用。
  const artifactRefs = child.artifactIds.map((fid) => {
    const f = store.file(fid, run.owner);
    return { id: f.id, name: f.name, sha256: f.sha256, url: `/v1/files/${f.id}/content` };
  });
  const value = {
    run_id: child.id,
    agent: delegate.agent,
    model: child.route.model,
    route: child.route.id,
    output: child.output.map((m) => m.text).join('\n\n'),
    ...(artifactRefs.length ? { artifacts: artifactRefs } : {}),
  };
  step.status = 'completed';
  step.result = { value };
  step.childRunId = child.id;
  delete step.error;
  const usage = run.usage ? { ...run.usage } : null;
  addUsage(run, child.usage);
  try {
    store.checkpointStep(
      run,
      step,
      {
        type: 'subagent.completed',
        data: {
          step_id: step.id,
          child_run_id: child.id,
          target_agent: delegate.agent,
          selected_model: child.route.model,
          artifacts: artifactRefs,
        },
      },
      [],
    );
  } catch (error) {
    run.usage = usage;
    throw error;
  }
  slice.progressed = true;
  return value;
}
