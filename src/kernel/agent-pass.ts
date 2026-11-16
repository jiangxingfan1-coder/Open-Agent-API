import type { AgentBundle, Run } from '../core/contracts.js';
import { checkAbort } from '../core/util.js';
import { runNativeAgent } from './native-turn.js';
import { runModelTurn } from './model-turn.js';
import { runToolPhase } from './tool-phase.js';
import type { KernelRuntime } from './runtime.js';
import type { ExecutionSlice } from './types.js';

export async function runAgentPass(
  rt: KernelRuntime,
  run: Run,
  bundle: AgentBundle,
  signal: AbortSignal,
  slice: ExecutionSlice,
  session: Parameters<typeof runNativeAgent>[5] & { timedOut: () => boolean },
): Promise<string> {
  const agent = { ...bundle.agent, model: run.route.model, provider: run.route.provider };
  if (agent.engine !== 'kernel') return runNativeAgent(rt, run, bundle, agent, signal, session);
  while (run.checkpoint.phase !== 'done') {
    checkAbort(signal);
    if (run.checkpoint.phase === 'model')
      await runModelTurn(rt, run, bundle, agent, signal, slice, session);
    if (run.checkpoint.phase === 'tools')
      await runToolPhase(rt, run, bundle, agent.limits.toolConcurrency, signal, slice);
  }
  return run.checkpoint.messages.findLast((m) => m.role === 'assistant')?.content ?? '';
}
