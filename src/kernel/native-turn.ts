/** 外部智能体回合：把一整轮交给执行机器并落盘它的回复与产物。 */
import { runSandboxed } from '../core/contracts.js';
import type {
  AgentBundle,
  AgentDefinition,
  ExecutionStep,
  Run,
  WorkEvent,
  ArtifactPayload,
} from '../core/contracts.js';
import { Fault, checkAbort, faultOf } from '../core/util.js';
import { RunTextSink } from './text-sink.js';
import { addUsage } from './run-state.js';
import { storeNativeArtifacts } from './agent-events.js';
import type { KernelRuntime } from './runtime.js';
import { projectBrief } from './project-memory.js';
import { mediaInstruction } from '../core/media.js';

/**
 * 运行一个外部智能体（Claude Code、Codex、Antigravity、ACP、A2A、适配器）的一整轮：
 * 记录步骤、派发给执行机器、落盘它的回复和生成的文件，最后提交检查点。
 * 外部智能体是不透明的执行单元：这里不拆它内部的工具调用，也不假设它的副作用可以重放。
 */
export async function runNativeAgent(
  rt: KernelRuntime,
  run: Run,
  bundle: AgentBundle,
  agent: AgentDefinition,
  signal: AbortSignal,
  session: {
    emit: (event: WorkEvent) => Promise<Record<string, unknown> | void>;
    writer: RunTextSink;
    /** 已经花在等待审批上的时间，不计入这个智能体的执行耗时。 */
    approvalElapsed: () => number;
    /** 标记「模型调用进行中」，失败时据此判断用量是否完整。 */
    pending: (value: boolean) => void;
    /** 事件处理过程中记录下来的错误（落盘失败、输出超限）。 */
    failure: () => Fault | undefined;
    /** 桥接调用把流式文本分成了多条输出消息：结束时不再整段补发 `text`。 */
    split?: () => boolean;
    /** A correction prompt for the resumed session (structured output); the run's own input otherwise. */
    input?: string;
  },
): Promise<string> {
  const prior = rt.store.getStep(nativeStepId(run));
  if (run.metadata['oaa.tools_disabled'] === 'true' && prior?.status === 'completed') {
    const value = prior.result?.value as { text?: unknown } | undefined;
    if (typeof value?.text === 'string') return value.text;
  }
  const nativeKey = run.checkpoint.byok ? rt.byokKeys.get(run.id) : undefined;
  if (run.checkpoint.byok && nativeKey === undefined)
    throw new Fault(
      'byok_key_required',
      'This run uses a caller-supplied provider key that the gateway no longer holds. Resume it with the X-OAA-Provider-Key header.',
      409,
    );
  const nativeStep: ExecutionStep = {
    id: nativeStepId(run),
    runId: run.id,
    callId: 'native',
    name: agent.engine,
    effect: run.metadata['oaa.tools_disabled'] === 'true' ? 'read' : 'unknown',
    status: 'pending',
    arguments: { model: agent.model },
  };
  rt.store.step(nativeStep);
  const nativeStarted = Date.now();
  session.pending(true);
  const result = await rt.hub
    .execute(
      {
        kind: 'native',
        ...(run.metadata['oaa.tools_disabled'] === 'true' ? { toolsDisabled: true } : {}),
        agent,
        input:
          (session.input ??
            (run.checkpoint.handoffBrief
              ? `${run.checkpoint.handoffBrief}\n\n新要求：\n${run.input}`
              : run.input)) +
          projectBrief(rt.store, run) +
          mediaInstruction(run.checkpoint.media),
        nativeState: run.checkpoint.nativeState,
        context: await rt.context(run),
        ...(runSandboxed(run) ? { isolation: 'sandbox' as const } : {}),
        ...(nativeKey !== undefined ? { credential: { apiKey: nativeKey } } : {}),
        ...(run.checkpoint.bridge?.tools.length
          ? { clientTools: run.checkpoint.bridge.tools.map((t) => ({ ...t })) }
          : {}),
      },
      bundle,
      signal,
      session.emit,
      {
        preferred:
          typeof run.checkpoint.nativeState?.nodeId === 'string'
            ? run.checkpoint.nativeState.nodeId
            : undefined,
        onStart: (node) => {
          nativeStep.status = 'running';
          nativeStep.nodeId = node;
          nativeStep.startedAt = Date.now();
          rt.store.step(nativeStep);
        },
      },
    )
    .catch((error) => {
      rt.router.record(
        run,
        Math.max(0, Date.now() - nativeStarted - session.approvalElapsed()),
        faultOf(error).code,
      );
      throw error;
    });
  rt.router.record(run, Math.max(0, result.executionMs - session.approvalElapsed()));
  const native = result.result as {
    text: string;
    nativeState: Record<string, unknown>;
    usage: Run['usage'];
    artifacts?: ArtifactPayload[];
  };
  checkAbort(signal);
  // 流式路径攒下的增量按流式的错误语义落盘；整段补发的文本保持原有的直接报错语义。
  if (!session.writer.open && native.text && !session.split?.()) {
    session.writer.emit(native.text);
    session.writer.flush(true);
  } else session.writer.flush();
  const failure = session.failure();
  if (failure) throw failure;
  run.checkpoint.nativeState = { ...native.nativeState, nodeId: result.nodeId };
  // A correction round adds to the usage of the rounds before it.
  if (session.input !== undefined) addUsage(run, native.usage);
  else run.usage = native.usage;
  session.pending(false);
  if (!native.usage) run.metadata['oaa.usage_complete'] = 'false';
  // 产物全部校验并落盘之后，步骤完成、产物 ID 与检查点才在同一次提交里落盘。
  const artifactIds = await storeNativeArtifacts(
    rt.store,
    run,
    bundle.agent.allowedNodes,
    native.artifacts,
  );
  checkAbort(signal);
  nativeStep.status = 'completed';
  if (run.checkpoint.orchestration || run.metadata['oaa.tools_disabled'] === 'true')
    nativeStep.result = { value: { text: native.text } };
  rt.store.checkpointNativeStep(run, nativeStep, session.writer.finish('completed'), artifactIds);
  session.writer.close();
  return native.text;
}

/** The step of the external agent's turn: the first round `native_<run>`, each correction round its own. */
export const nativeStepId = (run: Run): string =>
  `native_${run.id}${run.checkpoint.orchestration?.activeStage ? `_o${run.checkpoint.orchestration.activeStage}` : ''}${run.checkpoint.outputContract?.used ? `_r${run.checkpoint.outputContract.used}` : ''}`;
