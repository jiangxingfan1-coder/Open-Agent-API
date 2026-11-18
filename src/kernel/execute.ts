/** 一次执行的主流程：把模型轮次、工具阶段、外部智能体回合串起来，并处理挂起、失败与换用备选智能体。 */
import type { AgentBundle, AgentDefinition, Principal, Run, WorkEvent } from '../core/contracts.js';
import { executionFor } from '../core/contracts.js';
import type { Store } from '../store/store.js';
import { permits } from '../fabric/network.js';
import { responseObject } from './response-object.js';
import { Fault, checkAbort, faultOf, id } from '../core/util.js';
import { ApprovalSuspension, SchedulingSuspension } from '../core/suspension.js';
import { ExecutionPool } from './execution-pool.js';
import { classifyFailure, terminalEventType } from './run-state.js';
import { isFallbackExempt } from '../core/errors.js';
import { agentFallbackChain, routeInspector, toTopologyHint } from './fallback.js';
import { RunTextSink } from './text-sink.js';
import { validateMediaOutput } from './media-output.js';
import { boundApprovalDetail, recordProgress } from './agent-events.js';
import type { KernelRuntime } from './runtime.js';
import type { ExecutionSlice } from './types.js';
import { checkExecution } from './submission.js';
import { autoApprove, awaitApproval, expireApprovals } from './approvals.js';
import { abandonCallerTool, awaitCallerTool } from './client-tools.js';
import { nativeStepId } from './native-turn.js';
import { runAgentPass } from './agent-pass.js';
import { orchestrationMode, runOrchestration } from './orchestration.js';
import { ORCHESTRATION_PROFILES } from '../core/orchestration.js';
import { resumableSession, settleStructuredOutput } from './structured-output.js';
import {
  callerToolChoiceRepairPrompt,
  isForcedToolChoice,
  satisfiesToolChoice,
} from '../core/tool-choice.js';
import { imageDemand } from './images.js';
import { releaseRun } from './lifecycle.js';

export async function execute(rt: KernelRuntime, runId: string, preloaded?: Run): Promise<void> {
  const run = preloaded ?? rt.store.run(runId);
  delete run.checkpoint.suspension;
  const bundle = rt.store.bundle(run.owner, run.agentId, run.digest);
  const agent: AgentDefinition = {
    ...bundle.agent,
    model: run.route.model,
    provider: run.route.provider,
  };
  const controller = new AbortController();
  rt.controllers.set(runId, controller);
  const slice: ExecutionSlice = {
    progressed: false,
    tools: new ExecutionPool(agent.limits.toolConcurrency),
    boundary: (approvals = []) => {
      checkAbort(controller.signal);
      // Replaying confirmed steps is not progress; it must not trigger a yield loop.
      if (slice.progressed && rt.admission.queue.length) throw new SchedulingSuspension(approvals);
    },
  };
  const orchestration = orchestrationMode(run, agent);
  run.checkpoint.deadlineAt ??=
    run.checkpoint.durability?.deadlineAt ??
    Date.now() +
      Math.min(
        agent.limits.timeoutMs,
        orchestration
          ? (agent.orchestration?.timeoutMs ?? ORCHESTRATION_PROFILES[orchestration].timeoutMs)
          : Infinity,
      );
  let timedOut = Date.now() >= run.checkpoint.deadlineAt;
  if (timedOut) controller.abort();
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.max(0, run.checkpoint.deadlineAt - Date.now()),
  );
  let nativeApprovalMs = 0;
  let activeApprovals = 0;
  let approvalStart = 0;
  const approvalElapsed = () =>
    nativeApprovalMs + (activeApprovals ? Date.now() - approvalStart : 0);
  let eventError: Fault | undefined;
  let modelPending = false;
  const writer = new RunTextSink(
    rt.store,
    run,
    () => controller.signal.aborted,
    (fault) => {
      // 输出超限直接成为本次运行的错误；落盘失败不覆盖已经记录的更早的错误。
      if (fault.code === 'output_too_large') eventError = fault;
      else eventError ??= fault;
      controller.abort();
    },
  );
  // Structured output: the answer is checked before any of it is written (structured-output.ts).
  if (run.checkpoint.outputContract) writer.hold(true);
  const external = agent.engine !== 'kernel';
  const forcedExternalChoice =
    external &&
    !!run.checkpoint.bridge?.tools.length &&
    isForcedToolChoice(run.checkpoint.toolChoice);
  let forcedChoiceMet = false;
  let forcedChoiceRetried = false;
  let pendingPreToolText = '';
  if (forcedExternalChoice) writer.hold(true);
  // 外部智能体调用了调用方工具：之前的文本已作为一条输出消息结束，结束时不再整段补发。
  let callerSplit = false;
  const emit = async (event: WorkEvent): Promise<Record<string, unknown> | void> => {
    if (event.type === 'text') {
      try {
        const delta = String(event.data.delta ?? '');
        if (
          forcedExternalChoice &&
          !forcedChoiceMet &&
          !run.checkpoint.outputContract &&
          !orchestration
        ) {
          pendingPreToolText += delta;
        } else {
          writer.emit(delta);
        }
      } catch {
        eventError = new Fault(
          'persistence_failed',
          'Output could not be persisted. Execution was stopped.',
          500,
        );
        controller.abort();
      }
    } else if (event.type === 'approval') {
      const tooLarge = external ? boundApprovalDetail(event.data) : undefined;
      if (tooLarge) {
        await emit({ type: 'progress', data: tooLarge.progress });
        return { decision: tooLarge.decision };
      }
      writer.flush();
      if (
        external &&
        (agent.access?.approval === 'auto' || (!agent.access && agent.approvals === 'auto'))
      )
        return autoApprove(rt, run, event.data);
      if (activeApprovals++ === 0) approvalStart = Date.now();
      try {
        return await awaitApproval(
          rt,
          run,
          `native:${id('action')}`,
          'native',
          event.data,
          controller.signal,
        );
      } finally {
        if (--activeApprovals === 0) nativeApprovalMs += Date.now() - approvalStart;
      }
    } else if (event.type === 'client_tool') {
      if (!external || !run.checkpoint.bridge) return { error: 'Caller tools are not bridged.' };
      // 中继报告智能体放弃了仍在等待的调用：结束那次等待，不登记新调用。
      if (event.data.abandoned === true) {
        abandonCallerTool(rt.store, run, event.data.relay_call_id);
        return {};
      }
      if (forcedExternalChoice && !forcedChoiceMet) {
        const calledName = typeof event.data.name === 'string' ? event.data.name : '';
        const known = run.checkpoint.bridge!.tools.some((t) => t.name === calledName);
        if (known && satisfiesToolChoice(run.checkpoint.toolChoice, [calledName])) {
          forcedChoiceMet = true;
          if (!run.checkpoint.outputContract && !orchestration) {
            writer.hold(false);
            if (pendingPreToolText) {
              writer.emit(pendingPreToolText);
              pendingPreToolText = '';
            }
          }
        }
      }
      // 调用前的文本结束成一条输出消息：续接后的新文本开出新消息，`delivered` 按条推进。
      const finished = writer.finish('completed');
      if (finished.length) rt.store.checkpoint(run, finished);
      writer.close();
      callerSplit ||= run.output.length > 0;
      if (activeApprovals++ === 0) approvalStart = Date.now();
      try {
        return await awaitCallerTool(rt, run, event.data, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          eventError ??= faultOf(error);
          controller.abort();
        }
        throw error;
      } finally {
        if (--activeApprovals === 0) nativeApprovalMs += Date.now() - approvalStart;
      }
    } else {
      writer.flush();
      const fault = recordProgress(rt.store, run.id, event.data, external);
      if (fault) {
        eventError ??= fault;
        controller.abort();
      }
    }
  };
  try {
    run.status = 'in_progress';
    run.error = null;
    rt.store.checkpoint(run, [], (view) => ({
      type: 'response.in_progress',
      data: { response: responseObject(view) },
    }));
    checkAbort(controller.signal);
    // Structured output: each pass is one try at the final answer; a rejected answer goes back to the
    // agent for a correction round (structured-output.ts) and the pass repeats.
    let nativeInput: string | undefined;
    for (;;) {
      let answer: string;
      const pass = (input?: string) =>
        runAgentPass(rt, run, bundle, controller.signal, slice, {
          emit,
          writer,
          approvalElapsed,
          pending: (value) => {
            modelPending = value;
          },
          failure: () => eventError,
          split: () => callerSplit,
          input,
          timedOut: () => timedOut,
        });
      if (orchestration && nativeInput === undefined) {
        writer.hold(true);
        answer = await runOrchestration(rt, run, bundle, controller.signal, slice, (input) =>
          pass(input),
        );
        if (!run.checkpoint.outputContract) {
          const finished = writer.publishFinalOnce(answer);
          if (finished.length) rt.store.checkpoint(run, finished);
          writer.close();
        }
      } else answer = await pass(nativeInput);
      checkAbort(controller.signal);
      if (forcedExternalChoice) {
        const calledNames = rt.store
          .approvals(run.id)
          .filter((a) => a.kind === 'client_tool')
          .map((a) => String(a.detail.tool ?? ''));
        if (!satisfiesToolChoice(run.checkpoint.toolChoice, calledNames)) {
          pendingPreToolText = '';
          forcedChoiceMet = false;
          writer.hold(true);
          if (!forcedChoiceRetried) {
            forcedChoiceRetried = true;
            run.metadata['oaa.tool_choice_retries'] = '1';
            rt.store.emit(run.id, 'tool.progress', {
              source: 'gateway',
              event: 'tool_choice_repair',
              round: 1,
            });
            if (!resumableSession(run.checkpoint.nativeState)) {
              delete run.checkpoint.nativeState;
            }
            nativeInput = callerToolChoiceRepairPrompt(
              run.checkpoint.toolChoice!,
              run.checkpoint.bridge!.tools.map((t) => t.name),
            );
            continue;
          }
          throw new Fault(
            'tool_choice_unmet',
            run.checkpoint.toolChoice?.mode === 'tool'
              ? `The agent did not invoke the required caller tool '${run.checkpoint.toolChoice.name}' even after a correction round.`
              : 'The agent did not invoke any required caller tool even after a correction round.',
            422,
          );
        }
      }
      const settled = settleStructuredOutput(rt, run, agent, writer, answer);
      if (!settled.again) break;
      nativeInput = settled.nativeInput;
    }
    checkAbort(controller.signal);
    if (agent.outputSchema) {
      const last = run.output.at(-1)?.text ?? '';
      let value: unknown;
      try {
        value = JSON.parse(last);
      } catch {
        throw new Fault('output_contract', 'Final answer is not valid JSON.', 422);
      }
      if (!rt.ajv.validate(agent.outputSchema, value))
        throw new Fault(
          'output_contract',
          'Final answer does not satisfy the published output schema.',
          422,
        );
    }
    await validateMediaOutput(rt.store, run);
    run.status = 'completed';
    run.checkpoint.phase = 'done';
    rt.store.checkpoint(run, [], (view) => ({
      type: 'response.completed',
      data: { response: responseObject(view) },
    }));
  } catch (error) {
    const suspended = error instanceof ApprovalSuspension || error instanceof SchedulingSuspension;
    if (suspended && !controller.signal.aborted && !rt.closing()) {
      const scheduling = error instanceof SchedulingSuspension;
      run.status = scheduling ? 'queued' : 'requires_action';
      run.checkpoint.suspension = {
        kind: scheduling ? 'scheduling' : 'approval',
        approvalIds: error.approvalIds,
      };
      rt.admission.parked.set(runId, undefined);
      try {
        rt.store.checkpoint(run, [
          scheduling
            ? { type: 'run.queued', data: { reason: 'fairness', phase: run.checkpoint.phase } }
            : {
                type: 'run.parked',
                data: { reason: 'approval', approval_ids: error.approvalIds },
              },
        ]);
        if (!controller.signal.aborted && !rt.closing()) {
          if (scheduling && rt.admission.parked.has(runId)) rt.admission.enqueue(runId);
          return;
        }
      } catch {
        eventError = new Fault(
          'persistence_failed',
          'The scheduling checkpoint could not be committed. Execution was stopped.',
          500,
        );
      }
    }
    rt.admission.clearParked(runId);
    const fault =
      eventError ??
      (suspended
        ? new Fault('shutting_down', 'The gateway shut down at a scheduling boundary.', 503)
        : faultOf(error));
    if (
      !suspended &&
      !eventError &&
      !timedOut &&
      !controller.signal.aborted &&
      !rt.closing() &&
      !writer.open &&
      fallBackToNextAgent(rt, run, fault)
    )
      return;
    if (modelPending) run.metadata['oaa.usage_complete'] = 'false';
    if (agent.engine !== 'kernel') {
      const step = rt.store.getStep(nativeStepId(run));
      if (step?.status === 'running') {
        step.status = fault.uncertain ? 'uncertain' : 'failed';
        step.error = fault.code;
        rt.store.step(step);
      }
    }
    const classification = classifyFailure({
      fault,
      closing: rt.closing(),
      timedOut,
      aborted: controller.signal.aborted,
      hadEventError: Boolean(eventError),
    });
    run.status = classification.status;
    run.error = classification.error;
    delete run.checkpoint.suspension;
    expireApprovals(rt, run.id);
    rt.store.checkpoint(run, writer.finish('incomplete'), (view) => ({
      type: terminalEventType(run.status),
      data: { response: responseObject(view) },
    }));
    writer.close();
  } finally {
    clearTimeout(timer);
    controller.abort();
    rt.controllers.delete(runId);
    if (!run.checkpoint.suspension) {
      releaseRun(rt, run);
    }
  }
}
/**
 * 失败后换用备选智能体（`metadata["oaa.agent_fallback"]`，逗号分隔）。
 *
 * 只在「什么都还没发生」时才换：没有任何输出，没有任何工具步骤，外部智能体也还没被启动。
 * 这样换人重做不会重复任何副作用。满足条件时，把这次运行改挂到下一个备选智能体名下，
 * 重新排队，调用方看到的仍是同一个请求。返回 true 表示已经重新排队。
 */
export function fallBackToNextAgent(rt: KernelRuntime, run: Run, fault: Fault): boolean {
  const chain = agentFallbackChain(run.metadata);
  if (!chain.length || fault.uncertain || run.checkpoint.byok) return false;
  if (isFallbackExempt(fault.code)) return false;
  if (run.output.length || run.checkpoint.turn !== 0) return false;
  // 外部智能体的步骤一旦进入 running，就可能已经动过手；工具步骤同理。
  if (rt.store.steps(run.id).some((step) => step.status !== 'pending')) return false;
  const granted = run.checkpoint.grantedAgents ?? [];
  // 与提交时等价的调用方：同样的智能体授权、执行级别与密钥。
  const principal: Principal = {
    name: 'agent_fallback',
    owner: run.owner,
    agents: granted,
    scopes: [],
    execution: run.checkpoint.execution ?? 'host',
    ...(run.checkpoint.hostAgents ? { hostAgents: run.checkpoint.hostAgents } : {}),
    ...(run.checkpoint.keyId ? { keyId: run.checkpoint.keyId } : {}),
  };
  let files: ReturnType<Store['file']>[];
  try {
    files = [...run.fileIds, ...run.artifactIds].map((f) => rt.store.file(f, run.owner));
  } catch {
    return false;
  }
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i]!;
    let bundle: AgentBundle;
    try {
      if (candidate === run.agentId || !permits(granted, candidate)) continue;
      bundle = rt.store.bundle(run.owner, candidate);
      // 完整的执行级别检查（含委托链）；不通过就试链上的下一个。
      checkExecution(rt, principal, bundle.agent);
      const inspect = routeInspector(rt.hub, run.owner, bundle, files, {
        byok: false,
        sandbox: executionFor(principal, candidate) === 'sandbox',
        providerState: false,
        clientTools: !!run.checkpoint.bridge,
        images: imageDemand(run.images),
      });
      const route = rt.router.select(run.owner, bundle.digest, bundle.agent, 'auto', (p, m) =>
        toTopologyHint(inspect(p, m)),
      );
      if (!inspect(route.provider, route.model).available) continue;
      const from = run.agentId;
      run.agentId = candidate;
      run.digest = bundle.digest;
      run.route = route;
      run.error = null;
      run.status = 'queued';
      run.metadata = {
        ...run.metadata,
        'oaa.agent_fallback': chain.slice(i + 1).join(','),
        'oaa.fallback_from': [run.metadata['oaa.fallback_from'], from].filter(Boolean).join(','),
      };
      // 新智能体从干净的对话开始：不带上一个智能体的 provider 状态、系统指令和会话句柄。
      run.checkpoint.messages = run.checkpoint.messages.map(({ role, content }) => ({
        role,
        content,
      }));
      delete run.checkpoint.modelInstructions;
      delete run.checkpoint.nativeState;
      delete run.checkpoint.offeredTools;
      delete run.checkpoint.pending;
      run.checkpoint.phase = 'model';
      run.checkpoint.suspension = { kind: 'scheduling', approvalIds: [] };
      rt.admission.parked.set(run.id, undefined);
      rt.store.checkpointReassigned(run, [
        {
          type: 'run.queued',
          data: { reason: 'agent_fallback', from, to: candidate, error: fault.code },
        },
      ]);
      rt.hub.releaseRun(run.id);
      if (rt.admission.parked.has(run.id)) rt.admission.enqueue(run.id);
      return true;
    } catch {
      // 这个备选不可用（已下架、没有可用线路等）：试下一个。
      continue;
    }
  }
  return false;
}
