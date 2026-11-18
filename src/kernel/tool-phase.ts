/** 工具阶段：执行模型要求的工具调用（含图、工作流、委托与内置记忆工具），结果写回对话。 */
import { runSandboxed } from '../core/contracts.js';
import type {
  AgentBundle,
  ExecutionStep,
  Run,
  ToolBinding,
  ToolCall,
  ToolResult,
} from '../core/contracts.js';
import {
  executeGraph,
  graphToolEffects,
  parseGraph,
  parsePublishedGraph,
  projectGraphOutput,
} from '../lang/graph.js';
import { Fault, canonical, checkAbort, faultOf, sha } from '../core/util.js';
import type { EventInput } from '../store/output.js';
import {
  ApprovalSuspension,
  SchedulingSuspension,
  collectSuspensions,
} from '../core/suspension.js';
import { stepIdFor } from './run-state.js';
import { runMemoryTool } from './memory-tools.js';
import { persistWorkerArtifact } from '../store/large-artifacts.js';
import { callDelegate } from './delegate.js';
import type { KernelRuntime } from './runtime.js';
import type { ExecutionSlice } from './types.js';
import { awaitApproval, autoApprove } from './approvals.js';
import * as clientTools from './client-tools.js';

/**
 * 执行模型这一轮要求的全部工具调用，把结果按调用顺序写回对话，然后回到模型阶段。
 * 抛出 ApprovalSuspension / SchedulingSuspension 表示需要挂起；其它异常表示本轮失败。
 */
export async function runToolPhase(
  rt: KernelRuntime,
  run: Run,
  bundle: AgentBundle,
  toolConcurrency: number,
  signal: AbortSignal,
  slice: ExecutionSlice,
): Promise<void> {
  const calls = run.checkpoint.pending ?? [];
  // 就绪即补位：最多同时执行 toolConcurrency 个调用，任何一个结束就立刻启动下一个，
  // 不再等同一分块里最慢的那个。语义与分块调度保持一致：
  //   · 硬失败（含结果未知的副作用）出现后不再启动新调用，等已启动的全部收尾再抛出；
  //   · 等待审批的调用不阻塞其它调用；
  //   · 第一窗口之后的每次补位都是让出点：有其它运行在排队且本片已有进展时停止补位，
  //     等已启动的收尾后让出运行槽；
  //   · 结果按模型给出的调用顺序回填。
  const limit = toolConcurrency;
  const outcomes: PromiseSettledResult<{ call: ToolCall; value: unknown }>[] = [];
  let cursor = 0;
  let queuedUpTo = 0;
  let halted = false;
  let yielding = false;
  // 与原先的分块对齐，把一个窗口里可直接执行的调用的「已排队」记录合并成一次提交。
  const queueWindow = (from: number) => {
    const batch = calls.slice(from, from + limit);
    if (batch.length < 2) return;
    const batchItems: { step: ExecutionStep; event?: EventInput }[] = [];
    for (const call of batch) {
      const binding = bundle.agent.tools.find((t) => t.name === call.name);
      if (!binding || binding.capability.requiresApproval || call.name === 'execute_graph')
        continue;
      const stepId = stepIdFor(run.id, run.checkpoint.turn, call.id);
      if (rt.store.getStep(stepId)) continue;
      batchItems.push({
        step: {
          id: stepId,
          runId: run.id,
          callId: call.id,
          name: call.name,
          effect: binding.capability.effect,
          status: 'pending',
          arguments: call.arguments,
        },
        event: {
          type: 'tool.queued',
          data: { step_id: stepId, tool: call.name, effect: binding.capability.effect },
        },
      });
    }
    if (batchItems.length > 1) rt.store.batchSteps(batchItems);
  };
  const drive = async () => {
    for (;;) {
      if (halted || signal.aborted) return;
      const index = cursor;
      if (index >= calls.length) return;
      if (index >= limit && slice.progressed && rt.admission.queue.length) {
        halted = true;
        yielding = true;
        return;
      }
      cursor++;
      const call = calls[index]!;
      try {
        if (index >= queuedUpTo) {
          queuedUpTo = index + limit;
          queueWindow(index);
        }
        outcomes[index] = {
          status: 'fulfilled',
          value: {
            call,
            value: await callStep(rt, run, bundle, call, signal, slice),
          },
        };
      } catch (reason) {
        outcomes[index] = { status: 'rejected', reason };
        if (!(reason instanceof ApprovalSuspension)) halted = true;
      }
    }
  };
  checkAbort(signal);
  await Promise.all(Array.from({ length: Math.min(limit, calls.length) }, drive));
  const settled = outcomes.filter((outcome) => outcome !== undefined);
  const approvals = collectSuspensions(settled);
  const results = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  checkAbort(signal);
  if (yielding) throw new SchedulingSuspension(approvals);
  if (approvals.length) throw new ApprovalSuspension(approvals);
  for (const r of results)
    run.checkpoint.messages.push({
      role: 'tool',
      tool_call_id: r.call.id,
      content: clientTools.toolMessageContent(r.value),
    });
  run.checkpoint.pending = [];
  run.checkpoint.phase = 'model';
  rt.store.save(run);
  slice.boundary();
}
export async function callStep(
  rt: KernelRuntime,
  run: Run,
  bundle: AgentBundle,
  call: ToolCall,
  signal: AbortSignal,
  slice: ExecutionSlice,
): Promise<unknown> {
  const client = clientTools.clientToolCall(rt.store, run, call, rt.limits.approvalTimeoutMs);
  if (client) return client.value;
  if (
    run.metadata['oaa.tool_boundary'] === 'client' ||
    run.metadata['oaa.tools_disabled'] === 'true'
  )
    throw new Fault(
      'tool_denied',
      'Client-only execution cannot invoke a server tool, workflow or delegate.',
      403,
    );
  if (call.name === 'execute_graph') {
    if (!bundle.agent.allowGraph)
      throw new Fault('tool_denied', 'Graph execution is disabled.', 403);
    const effectMap = graphToolEffects(bundle.agent);
    const allowedInGraph = new Set<string>([
      ...(run.checkpoint.offeredTools ?? bundle.agent.tools.map((t) => t.name)),
      ...(bundle.agent.workflows ?? []).map((w) => w.name),
      ...(bundle.agent.delegates ?? []).map((d) => d.name),
    ]);
    const steps = parseGraph(call.arguments, allowedInGraph, effectMap);
    const out = await executeGraph(
      steps,
      bundle.agent.limits.toolConcurrency,
      signal,
      async (s, args, stepSignal) =>
        callStep(
          rt,
          run,
          bundle,
          { id: `${call.id}:${s.id}`, name: s.tool, arguments: args },
          stepSignal,
          slice,
        ),
      slice.boundary,
    );
    return projectGraphOutput(call.arguments.output, out);
  }

  const workflow = bundle.agent.workflows?.find((w) => w.name === call.name);
  if (workflow) {
    if (!rt.ajv.validate(workflow.inputSchema, call.arguments))
      throw new Fault('invalid_tool_arguments', rt.ajv.errorsText());
    const effectMap = graphToolEffects(bundle.agent);
    const allowedInFlow = new Set<string>([
      ...(run.checkpoint.offeredTools ?? bundle.agent.tools.map((t) => t.name)),
      ...(bundle.agent.workflows ?? []).map((w) => w.name),
      ...(bundle.agent.delegates ?? []).map((d) => d.name),
    ]);
    const bindings = { $input: call.arguments, input: call.arguments };
    const steps = parsePublishedGraph(
      { steps: workflow.steps, output: workflow.output },
      allowedInFlow,
      effectMap,
    );
    if (workflow.outputSchema) rt.ajv.compile(workflow.outputSchema);
    rt.store.emit(run.id, 'workflow.started', {
      workflow: workflow.name,
      call_id: call.id,
      step_count: steps.length,
    });
    const out = await executeGraph(
      steps,
      bundle.agent.limits.toolConcurrency,
      signal,
      async (s, args, stepSignal) =>
        callStep(
          rt,
          run,
          bundle,
          { id: `${call.id}:${s.id}`, name: s.tool, arguments: args },
          stepSignal,
          slice,
        ),
      slice.boundary,
      bindings,
    );
    const value = projectGraphOutput(workflow.output, out, bindings);
    if (workflow.outputSchema && !rt.ajv.validate(workflow.outputSchema, value))
      throw new Fault(
        'workflow_output_contract',
        `Workflow '${workflow.name}' output does not satisfy its published schema.`,
        422,
      );
    rt.store.emit(run.id, 'workflow.completed', {
      workflow: workflow.name,
      call_id: call.id,
    });
    return value;
  }

  const delegate = bundle.agent.delegates?.find((d) => d.name === call.name);
  if (delegate) {
    return await slice.tools.run(signal, () =>
      callDelegate(rt.delegation, run, delegate, call, signal, slice),
    );
  }
  const binding = bundle.agent.tools.find((t) => t.name === call.name);
  if (!binding) throw new Fault('tool_denied', `Tool is not published: ${call.name}`, 403);
  return await slice.tools.run(signal, () =>
    callTool(rt, run, bundle, binding, call, signal, slice),
  );
}
export async function callTool(
  rt: KernelRuntime,
  run: Run,
  bundle: AgentBundle,
  binding: ToolBinding,
  call: ToolCall,
  signal: AbortSignal,
  slice: ExecutionSlice,
): Promise<unknown> {
  if (run.checkpoint.offeredTools && !run.checkpoint.offeredTools.includes(call.name))
    throw new Fault(
      'capability_unavailable',
      'The model selected a tool unavailable for this turn.',
      503,
    );
  if (!rt.ajv.validate(binding.capability.inputSchema, call.arguments))
    throw new Fault('invalid_tool_arguments', rt.ajv.errorsText());
  const stepId = stepIdFor(run.id, run.checkpoint.turn, call.id);
  let step = rt.store.getStep(stepId);
  if (step?.status === 'completed') return step.result?.value;
  if (step?.status === 'uncertain')
    throw new Fault(
      'effect_outcome_unknown',
      'This step requires operator reconciliation.',
      409,
      true,
    );
  const existingPending = step?.status === 'pending';
  step ??= {
    id: stepId,
    runId: run.id,
    callId: call.id,
    name: call.name,
    effect: binding.capability.effect,
    status: 'pending',
    arguments: call.arguments,
  };
  if (binding.capability.requiresApproval) {
    rt.store.step(step);
    const decision =
      bundle.agent.access?.approval === 'auto'
        ? autoApprove(
            rt,
            run,
            {
              tool: call.name,
              arguments: call.arguments,
              capability: binding.capability.id,
              version: binding.capability.version,
            },
            { stepId, kind: 'tool' },
          )
        : await awaitApproval(
            rt,
            run,
            stepId,
            'tool',
            {
              tool: call.name,
              arguments: call.arguments,
              capability: binding.capability.id,
              version: binding.capability.version,
            },
            signal,
          );
    if (decision.decision !== 'approve')
      throw new Fault('permission_denied', 'The API owner denied the tool call.', 403);
  }
  const key =
    binding.capability.effect === 'read' && binding.capability.cacheTtlMs > 0
      ? sha(
          canonical({
            owner: run.owner,
            session: run.sessionId,
            digest: run.digest,
            tool: binding,
            args: call.arguments,
            files: [...run.fileIds, ...run.artifactIds].map(
              (f) => rt.store.file(f, run.owner).sha256,
            ),
          }),
        )
      : undefined;
  const cached = key ? rt.cache.get(key) : undefined;
  if (binding.capability.effect === 'read' && cached) {
    step.status = 'completed';
    step.result = cached;
    delete step.error;
    rt.store.step(step, { type: 'tool.cached', data: { step_id: stepId } });
    slice.progressed = true;
    return step.result.value;
  }
  if (!existingPending) {
    rt.store.step(step, {
      type: 'tool.queued',
      data: { step_id: stepId, tool: call.name, effect: step.effect },
    });
  }
  if (
    binding.handler.kind === 'builtin' &&
    (binding.handler.name === 'memory_read' ||
      binding.handler.name === 'memory_write' ||
      binding.handler.name === 'memory_search')
  ) {
    if (binding.capability.effect !== 'read') rt.cache.invalidate();
    step.status = 'running';
    step.nodeId = 'kernel';
    delete step.error;
    rt.store.step(step, {
      type: 'tool.started',
      data: { step_id: stepId, node_id: 'kernel', attempt: 0 },
    });
    const value = await runMemoryTool(rt.store, run, binding.handler.name, call.arguments);
    step.status = 'completed';
    step.result = { value };
    delete step.error;
    rt.store.checkpointStep(
      run,
      step,
      {
        type: 'tool.completed',
        data: { step_id: stepId, node_id: 'kernel', artifacts: [] },
      },
      [],
    );
    slice.progressed = true;
    return value;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let received = false;
    let committed = false;
    let cacheGeneration: number | undefined;
    let finishWrite: (() => void) | undefined;
    try {
      const result = await rt.hub.execute(
        {
          kind: 'tool',
          binding,
          arguments: call.arguments,
          context: await rt.context(run),
          ...(runSandboxed(run) && binding.handler.kind === 'script'
            ? { isolation: 'sandbox' as const }
            : {}),
        },
        bundle,
        signal,
        async (e) => {
          rt.store.emit(run.id, 'tool.progress', e.data);
        },
        {
          onStart: (node) => {
            if (binding.capability.effect !== 'read') finishWrite = rt.cache.beginWrite();
            else cacheGeneration = rt.cache.beginRead();
            step!.status = 'running';
            step!.nodeId = node;
            delete step!.error;
            rt.store.step(step!, {
              type: 'tool.started',
              data: { step_id: stepId, node_id: node, attempt },
            });
          },
        },
      );
      received = true;
      const answer = result.result as ToolResult;
      if (!answer || !Object.hasOwn(answer, 'value'))
        throw new Fault('invalid_tool_result', 'Worker returned an invalid tool result.', 502);
      const refs = [];
      for (const artifact of answer.artifacts ?? []) {
        const allowed = bundle.agent.allowedNodes;
        const file = await persistWorkerArtifact(rt.store, run.owner, run.id, artifact, allowed);
        refs.push({
          id: file.id,
          name: file.name,
          sha256: file.sha256,
          url: `/v1/files/${file.id}/content`,
        });
      }
      const value = refs.length ? { result: answer.value, artifacts: refs } : answer.value;
      step.status = 'completed';
      step.result = { value };
      delete step.error;
      if (refs.length) rt.cache.invalidate();
      try {
        rt.store.checkpointStep(
          run,
          step,
          {
            type: 'tool.completed',
            data: { step_id: stepId, node_id: result.nodeId, artifacts: refs },
          },
          refs.map((ref) => ref.id),
        );
      } catch {
        throw new Fault(
          'step_checkpoint_failed',
          'Tool output could not be committed. Execution was stopped.',
          500,
        );
      }
      committed = true;
      if (key && !refs.length)
        rt.cache.set(key, step.result, binding.capability.cacheTtlMs, cacheGeneration);
      slice.progressed = true;
      return value;
    } catch (error) {
      const fault = faultOf(error);
      if (committed) throw fault;
      if (received) {
        if (['write', 'unknown'].includes(binding.capability.effect)) fault.uncertain = true;
        delete step.result;
      }
      if (
        attempt === 0 &&
        binding.capability.effect === 'read' &&
        !signal.aborted &&
        ['node_disconnected', 'work_timeout'].includes(fault.code)
      ) {
        step.status = 'pending';
        rt.store.step(step);
        continue;
      }
      step.status = fault.uncertain ? 'uncertain' : 'failed';
      step.error = fault.code;
      rt.store.step(step, {
        type: 'tool.failed',
        data: { step_id: stepId, code: fault.code, uncertain: fault.uncertain },
      });
      throw fault;
    } finally {
      finishWrite?.();
    }
  }
  throw new Fault('execution_failed', 'Tool retry exhausted.', 502);
}
