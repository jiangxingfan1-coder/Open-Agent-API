import { z } from 'zod';
import type { AgentDefinition, WorkContext } from '../core/contracts.js';
import type { WorkerConfig } from '../config/config.js';
import { validateEndpoint } from '../config/config.js';
import {
  collectProcess,
  jsonLines,
  nativeEnvironment,
  ownedProcess,
  terminateOwned,
} from './process.js';
import { Fault, redact } from '../core/util.js';
import type { NativeResult } from './native.js';
import type { WorkEvent } from '../core/contracts.js';
import { readResponseText } from '../providers/http-stream.js';
import { AGENT_IO_LIMITS, bounded, safeEmit, type Emit } from './shared.js';

const MAX_STREAM_TEXT = AGENT_IO_LIMITS.textChars;
const MAX_APPROVAL_DETAIL = AGENT_IO_LIMITS.approvalDetailChars;

const resultSchema = z
  .object({
    protocol: z.literal('oaa/1'),
    type: z.literal('result'),
    status: z.enum(['completed', 'failed', 'incomplete']),
    output_text: z.string().max(AGENT_IO_LIMITS.textChars),
    state: z.record(z.string(), z.unknown()).default({}),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
      })
      .nullable()
      .default(null),
    error: z.string().optional(),
  })
  .strict();

/** Owner-installed adapters implement this protocol; no private runtime introspection is required. */
export async function runAdapter(
  agent: AgentDefinition,
  config: WorkerConfig,
  workspace: string,
  input: string,
  context: WorkContext,
  signal: AbortSignal,
  previousState?: Record<string, unknown>,
  emit?: Emit,
): Promise<NativeResult> {
  const name = agent.engine.slice('adapter/'.length);
  const adapter = config.adapters[name];
  if (!adapter?.enabled)
    throw new Fault('adapter_disabled', 'The named owner-installed adapter is not enabled.', 503);
  if (adapter.transport === 'acp')
    throw new Fault(
      'invalid_engine',
      'ACP adapters are executed by the ACP client, not the oaa/1 ABI.',
    );
  const request = {
    protocol: 'oaa/1',
    type: 'invoke',
    agent: agent.id,
    model: agent.model,
    input,
    instructions: agent.instructions,
    run_id: context.runId,
    session_id: context.sessionId,
    workspace,
    previous_state: previousState ?? null,
  };
  if (adapter.transport === 'stdio' && adapter.protocol === 'oaa/1-stream')
    return await runStreamingAdapter(
      name,
      adapter.command,
      adapter.args,
      workspace,
      request,
      signal,
      emit,
      {},
      nativeEnvironment(config.nativeEnv),
    );
  let text: string;
  if (adapter.transport === 'stdio')
    text = await collectProcess(
      adapter.command,
      adapter.args,
      workspace,
      JSON.stringify(request) + '\n',
      signal,
      nativeEnvironment(config.nativeEnv),
    );
  else {
    validateEndpoint(adapter.url);
    const token = adapter.tokenEnv ? process.env[adapter.tokenEnv] : undefined;
    if (adapter.tokenEnv && !token)
      throw new Fault('adapter_not_configured', `Set ${adapter.tokenEnv} on this worker.`, 503);
    const response = await fetch(adapter.url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Fault('adapter_failed', `Adapter returned HTTP ${response.status}.`, 502);
    }
    if (!response.body)
      throw new Fault('adapter_failed', 'Adapter returned an empty response.', 502);
    text = await readResponseText(response, signal, {
      maxBytes: AGENT_IO_LIMITS.adapterHttpBytes,
      limitCode: 'adapter_output_limit',
    });
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Fault('invalid_protocol', 'Adapter returned invalid JSON.', 502);
  }
  const parsed = resultSchema.safeParse(document);
  if (!parsed.success)
    throw new Fault('invalid_protocol', 'Adapter returned an invalid result.', 502);
  const result = parsed.data;
  if (result.status !== 'completed')
    throw new Fault(
      'adapter_incomplete',
      // Adapter-supplied text is untrusted: redact credentials like every other engine.
      result.error ? redact(result.error).slice(0, 1000) : `Adapter returned ${result.status}.`,
      502,
    );
  return { text: result.output_text, nativeState: result.state, usage: result.usage };
}

/**
 * `oaa/1-stream`: the request is the first NDJSON line on stdin, which stays open for
 * `approval_result` and `cancel` messages. The adapter writes NDJSON `delta`, `progress`,
 * `approval` and finally one `result` line (same schema as the final-result ABI).
 */
async function runStreamingAdapter(
  name: string,
  command: string,
  args: string[],
  workspace: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
  emit: Emit | undefined,
  timings: { cancelGraceMs?: number } = {},
  env?: NodeJS.ProcessEnv,
): Promise<NativeResult> {
  const life = new AbortController();
  const child = ownedProcess(command, args, workspace, life.signal, env);
  const send = (value: unknown) => {
    if (child.stdin.writable)
      try {
        child.stdin.write(JSON.stringify(value) + '\n');
      } catch {
        // The child may close stdin at any moment; the exit handler reports it.
      }
  };
  return await new Promise<NativeResult>((resolve, reject) => {
    let text = '';
    let denied = 0;
    let final: z.infer<typeof resultSchema> | undefined;
    let failure: Error | undefined;
    let stderr = '';
    const fail = (error: Error) => {
      failure ??= error;
      terminateOwned(child);
    };
    const report = (event: WorkEvent) => {
      if (emit) safeEmit(emit, event, (error) => fail(error as Error));
    };
    const onAbort = () => {
      send({ type: 'cancel' });
      const timer = setTimeout(() => terminateOwned(child), timings.cancelGraceMs ?? 3_000);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    jsonLines(
      child,
      (message) => {
        if (failure || final) return;
        switch (message.type) {
          case 'delta': {
            const delta = typeof message.text === 'string' ? message.text : '';
            if (text.length + delta.length > MAX_STREAM_TEXT) {
              fail(new Fault('output_too_large', 'Agent output exceeds limit.', 413));
              return;
            }
            text += delta;
            if (delta) report({ type: 'text', data: { delta } });
            return;
          }
          case 'progress':
            report({
              type: 'progress',
              data: {
                native: 'adapter',
                adapter: name,
                event: bounded(message.event, 40) ?? 'progress',
                ...(bounded(message.title, 240) ? { title: bounded(message.title, 240) } : {}),
                ...(bounded(message.status, 40) ? { status: bounded(message.status, 40) } : {}),
                ...(bounded(message.tool, 160) ? { tool: bounded(message.tool, 160) } : {}),
              },
            });
            return;
          case 'approval': {
            const id = bounded(message.id, 160);
            if (!id) {
              fail(new Fault('invalid_protocol', 'Adapter approval request needs an id.', 502));
              return;
            }
            const detail = {
              native: 'adapter',
              adapter: name,
              approval_id: id,
              title: bounded(message.title, 240) ?? 'Adapter requests permission',
              kind: bounded(message.kind, 40),
              input: message.input ?? null,
            };
            const answer = (decision: 'approve' | 'deny') => {
              if (decision === 'deny') denied++;
              send({ type: 'approval_result', id, decision });
            };
            // Never obtain an approval for content the owner cannot see in full.
            if (!emit || JSON.stringify(detail).length > MAX_APPROVAL_DETAIL) {
              answer('deny');
              return;
            }
            void emit({ type: 'approval', data: detail }).then(
              (result) => answer(result?.decision === 'approve' ? 'approve' : 'deny'),
              (error: unknown) => {
                answer('deny');
                if (!signal.aborted) fail(error as Error);
              },
            );
            return;
          }
          case 'result': {
            const parsed = resultSchema.safeParse(message);
            if (!parsed.success) {
              fail(new Fault('invalid_protocol', 'Adapter returned an invalid result.', 502));
              return;
            }
            final = parsed.data;
            try {
              child.stdin.end();
            } catch {
              // Stdin is already closed or broken; the result is already captured.
            }
            return;
          }
          default:
            fail(
              new Fault(
                'invalid_protocol',
                `Unknown oaa/1-stream message type: ${String(message.type).slice(0, 40)}.`,
                502,
              ),
            );
        }
      },
      fail,
    );
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      life.abort();
      if (signal.aborted) reject(new Fault('cancelled', 'Adapter task cancelled.', 409));
      else if (failure) reject(failure);
      else if (!final)
        reject(
          new Fault(
            'native_incomplete',
            `Adapter exited (${code ?? 'signal'}) without a result: ${redact(stderr).slice(0, 1000)}`,
            502,
          ),
        );
      else if (final.status !== 'completed')
        reject(
          new Fault(
            'adapter_incomplete',
            final.error ? redact(final.error).slice(0, 1000) : `Adapter returned ${final.status}.`,
            502,
          ),
        );
      else if (denied)
        reject(
          new Fault(
            'permission_denied',
            `The adapter reported ${denied} denied approval(s); a clean exit is not success evidence.`,
            403,
          ),
        );
      else
        resolve({ text: text || final.output_text, nativeState: final.state, usage: final.usage });
    });
    send({ ...request, stream: true });
  });
}
