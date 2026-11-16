/**
 * Settling a run that asked for structured output (docs/structured-output.md). Called by execute()
 * when an agent turn sequence has produced its final answer:
 *
 * - the answer is held back while the agent works (RunTextSink.hold), so nothing that might turn out
 *   wrong is ever written to the event log or sent to a stream;
 * - a good answer is normalized (no fence, no prose, compact JSON) and written out in one piece;
 * - a bad one goes back to the agent for a correction round (kernel agents: one more model turn;
 *   external agents: a prompt on the resumed session, only when the engine can resume), up to
 *   `contract.repairs` times, counted in turns and usage;
 * - otherwise the run fails with `structured_output_invalid`, and the message names the problem
 *   without quoting the answer.
 */
import type { AgentDefinition, Run } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { checkAnswer, repairPrompt } from './output-contract.js';
import type { KernelRuntime } from './runtime.js';
import type { RunTextSink } from './text-sink.js';

/** Can the external agent's session be continued with another prompt? Anything else would redo the work. */
function resumable(state: Record<string, unknown> | undefined): boolean {
  if (!state || state.oneShot === true) return false;
  if (state.transport === 'acp') return state.resumable === true;
  if (state.transport === 'a2a') return false;
  return ['sessionId', 'threadId', 'conversationId'].some((key) => typeof state[key] === 'string');
}

/** The follow-up for an external agent when the previous answer was rejected; `undefined` for everything else. */
export type Settled = { again: false } | { again: true; nativeInput?: string };

export function settleStructuredOutput(
  rt: KernelRuntime,
  run: Run,
  agent: AgentDefinition,
  writer: RunTextSink,
  /** The text of the final answer: the last model message, or the external agent's reply. */
  answer: string,
): Settled {
  const contract = run.checkpoint.outputContract;
  if (!contract) return { again: false };
  const verdict = checkAnswer(contract, answer, rt.outputSchemas);
  if (verdict.ok) {
    if (run.checkpoint.orchestration) {
      run.checkpoint.orchestration.finalText = verdict.text;
      rt.store.checkpoint(run, writer.publishFinalOnce(verdict.text));
      writer.close();
      return { again: false };
    }
    const last = run.checkpoint.messages.findLast((m) => m.role === 'assistant');
    if (last) last.content = verdict.text;
    writer.hold(false);
    writer.emit(verdict.text);
    writer.flush(true);
    rt.store.checkpoint(run, writer.finish('completed'));
    writer.close();
    return { again: false };
  }
  const used = contract.used ?? 0;
  const external = agent.engine !== 'kernel';
  const repairable =
    used < contract.repairs && (!external || resumable(run.checkpoint.nativeState));
  if (!repairable)
    throw new Fault(
      'structured_output_invalid',
      `The agent's answer is not valid structured output: ${verdict.problem}.` +
        (used > 0 ? ` It was sent back for correction ${used} time${used === 1 ? '' : 's'}.` : '') +
        (external && !resumable(run.checkpoint.nativeState) && contract.repairs > 0
          ? ' This agent cannot continue its session, so it was not asked again.'
          : ''),
      422,
    );
  const prompt = repairPrompt(contract, verdict.problem, answer);
  contract.used = used + 1;
  run.metadata['oaa.output_repairs'] = String(contract.used);
  // Visible as stream progress (docs/progress.md); no answer text, only the round.
  rt.store.emit(run.id, 'tool.progress', {
    source: 'gateway',
    event: 'output_repair',
    round: contract.used,
  });
  if (external) return { again: true, nativeInput: prompt };
  run.checkpoint.messages.push({ role: 'user', content: prompt });
  run.checkpoint.phase = 'model';
  rt.store.save(run);
  return { again: true };
}
