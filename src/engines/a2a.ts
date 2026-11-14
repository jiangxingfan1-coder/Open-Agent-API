/**
 * Minimal A2A (Agent2Agent) client that turns a remote A2A agent into an OAA engine
 * (`adapter/<name>` with `transport: "a2a"`), using the JSON-RPC 2.0 binding over HTTPS.
 *
 * Requests follow A2A 1.0 by default (`SendStreamingMessage` / `SendMessage` / `CancelTask`,
 * `A2A-Version: 1.0`, `ROLE_USER`, parts without `kind`); `protocolVersion: "0.3"` selects the
 * 0.3 forms (`message/stream` / `message/send` / `tasks/cancel`, `kind` discriminators). Responses
 * of either version are accepted, as the 1.0 migration notes recommend during the transition.
 *
 * Text parts of agent messages and artifacts become output; status updates become progress;
 * `contextId` keeps the conversation across turns. Only owner-configured endpoints are contacted,
 * only when a task runs or the owner requests a check; credentials stay in the worker environment.
 */
import { randomUUID } from 'node:crypto';
import type { AgentDefinition } from '../core/contracts.js';
import type { WorkerConfig } from '../config/config.js';
import { validateEndpoint } from '../config/config.js';
import type { NativeResult } from './native.js';
import { Fault, checkAbort, redact } from '../core/util.js';
import { readResponseText, readSseStream } from '../providers/http-stream.js';
import { AGENT_IO_LIMITS, bounded, record, type Emit } from './shared.js';

type Json = Record<string, unknown>;
export type A2AAdapterConfig = Extract<WorkerConfig['adapters'][string], { transport: 'a2a' }>;
export type FetchLike = typeof fetch;
const MAX_TEXT = AGENT_IO_LIMITS.textChars;
const MAX_STREAM_BYTES = AGENT_IO_LIMITS.frameBytes;
/** Terminal and interrupted states: the turn ends (and a 1.0 stream closes) on any of them. */
const TERMINAL = new Set([
  'completed',
  'failed',
  'rejected',
  'canceled',
  'input-required',
  'auth-required',
]);

/** `TASK_STATE_INPUT_REQUIRED` (1.0) and `input-required` (0.3) both become `input-required`. */
export const stateName = (value: unknown): string | null => {
  const raw = bounded(value, 60);
  if (!raw) return null;
  return raw.startsWith('TASK_STATE_')
    ? raw.slice('TASK_STATE_'.length).toLowerCase().replaceAll('_', '-')
    : raw.toLowerCase();
};
/**
 * Text of A2A parts: 1.0 parts carry exactly one of `text`/`raw`/`url`/`data` (no `kind`); 0.3
 * parts are tagged `kind: "text"` (an older `type: "text"` shape is accepted too).
 */
export function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      const p = record(part);
      const tag = p.kind ?? p.type;
      return (tag === undefined || tag === 'text') && typeof p.text === 'string' ? p.text : '';
    })
    .join('');
}
type A2AEvent =
  | { type: 'message'; value: Json }
  | { type: 'task'; value: Json }
  | { type: 'status'; value: Json; final: boolean }
  | { type: 'artifact'; value: Json };
/** One JSON-RPC `result`: 1.0 names the member (`statusUpdate`, ...); 0.3 uses `kind`. */
function eventOf(result: Json): A2AEvent | undefined {
  if (result.statusUpdate)
    return { type: 'status', value: record(result.statusUpdate), final: false };
  if (result.artifactUpdate) return { type: 'artifact', value: record(result.artifactUpdate) };
  if (result.task) return { type: 'task', value: record(result.task) };
  if (result.message) return { type: 'message', value: record(result.message) };
  if (result.kind === 'status-update')
    return { type: 'status', value: result, final: result.final === true };
  if (result.kind === 'artifact-update') return { type: 'artifact', value: result };
  if (result.kind === 'task') return { type: 'task', value: result };
  if (result.kind === 'message') return { type: 'message', value: result };
  // A bare 1.0 Task snapshot (e.g. a CancelTask result) has an id and a status.
  if (typeof result.id === 'string' && result.status) return { type: 'task', value: result };
  return undefined;
}

function headers(
  adapter: A2AAdapterConfig,
  accept: string,
  version: '1.0' | '0.3',
): Record<string, string> {
  const token = adapter.tokenEnv ? process.env[adapter.tokenEnv] : undefined;
  if (adapter.tokenEnv && !token)
    throw new Fault('adapter_not_configured', `Set ${adapter.tokenEnv} on this worker.`, 503);
  return {
    'content-type': 'application/json',
    accept,
    // An absent header means 0.3 to a 1.0 server, so it is only sent for 1.0.
    ...(version === '1.0' ? { 'a2a-version': '1.0' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function runA2A(
  agent: AgentDefinition,
  config: WorkerConfig,
  input: string,
  signal: AbortSignal,
  emit: Emit,
  state?: Record<string, unknown>,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<NativeResult> {
  const name = agent.engine.startsWith('adapter/') ? agent.engine.slice('adapter/'.length) : '';
  const adapter = config.adapters[name];
  if (!adapter?.enabled)
    throw new Fault('adapter_disabled', 'The named owner-installed adapter is not enabled.', 503);
  if (adapter.transport !== 'a2a')
    throw new Fault('invalid_engine', 'This adapter does not use the A2A transport.');
  checkAbort(signal);
  validateEndpoint(adapter.url);
  const version = adapter.protocolVersion ?? '1.0';
  const v1 = version === '1.0';
  const streaming = adapter.streaming !== false;
  let contextId = typeof state?.contextId === 'string' ? state.contextId : undefined;
  // Only an unfinished task (the agent asked for input) is continued; otherwise a new task
  // starts in the same context.
  let taskId =
    state?.state === 'input-required' && typeof state.taskId === 'string'
      ? state.taskId
      : undefined;
  const prompt = agent.instructions ? `${agent.instructions}\n\n${input}` : input;
  const controller = new AbortController();
  const rpc = (method: string, params: Json, accept: string, abort: AbortSignal) =>
    fetchImpl(adapter.url, {
      method: 'POST',
      redirect: 'error',
      signal: abort,
      headers: headers(adapter, accept, version),
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    });
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let text = '';
  let finalState: string | undefined;
  let question = '';
  const progress = (data: Json) =>
    emit({ type: 'progress', data: { native: 'a2a', adapter: name, ...data } });
  const append = async (delta: string) => {
    if (!delta) return;
    if (text.length + delta.length > MAX_TEXT)
      throw new Fault('output_too_large', 'Agent output exceeds limit.', 413);
    text += delta;
    await emit({ type: 'text', data: { delta } });
  };
  const status = async (raw: unknown, final: boolean) => {
    const value = record(raw);
    const current = stateName(value.state) ?? 'unknown';
    const said = partsText(record(value.message).parts);
    if (TERMINAL.has(current)) {
      finalState = current;
      question = said;
    } else {
      await progress({
        event: 'status',
        state: current,
        ...(said ? { title: said.slice(0, 240) } : {}),
      });
      if (final) finalState ??= current;
    }
  };
  const handle = async (raw: unknown) => {
    const message = record(raw);
    if (message.error) {
      const error = record(message.error);
      throw new Fault(
        'adapter_failed',
        `A2A agent returned an error (${String(error.code ?? 'unknown')}): ${redact(String(error.message ?? '')).slice(0, 500)}`,
        502,
      );
    }
    const event = eventOf(record(message.result));
    if (!event) throw new Fault('invalid_protocol', 'A2A agent returned an unknown result.', 502);
    const value = event.value;
    contextId = bounded(value.contextId, 256) ?? contextId;
    if (event.type === 'message') {
      const role = String(value.role ?? '').toLowerCase();
      if (role === 'agent' || role === 'role_agent') await append(partsText(value.parts));
      finalState ??= 'completed';
    } else if (event.type === 'task') {
      taskId = bounded(value.id, 256) ?? taskId;
      if (!text)
        for (const artifact of Array.isArray(value.artifacts) ? value.artifacts : [])
          await append(partsText(record(artifact).parts));
      await status(value.status, false);
    } else if (event.type === 'artifact') {
      taskId = bounded(value.taskId, 256) ?? taskId;
      await append(partsText(record(value.artifact).parts));
    } else {
      taskId = bounded(value.taskId, 256) ?? taskId;
      await status(value.status, event.final);
    }
  };
  try {
    const message = {
      ...(v1 ? {} : { kind: 'message' }),
      role: v1 ? 'ROLE_USER' : 'user',
      messageId: randomUUID(),
      parts: [v1 ? { text: prompt } : { kind: 'text', text: prompt }],
      ...(contextId ? { contextId } : {}),
      ...(taskId ? { taskId } : {}),
    };
    const outputModes = ['text/plain', 'text/markdown'];
    const params = {
      message,
      // 1.0 waits for a terminal or interrupted state unless `returnImmediately` is set.
      configuration: v1
        ? { acceptedOutputModes: outputModes }
        : { acceptedOutputModes: outputModes, blocking: true },
    };
    const method = streaming
      ? v1
        ? 'SendStreamingMessage'
        : 'message/stream'
      : v1
        ? 'SendMessage'
        : 'message/send';
    const response = await rpc(
      method,
      params,
      streaming ? 'text/event-stream' : 'application/json',
      controller.signal,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Fault(
        response.status === 401 || response.status === 403
          ? 'adapter_auth_required'
          : 'adapter_failed',
        `A2A agent returned HTTP ${response.status}.`,
        response.status === 401 || response.status === 403 ? 503 : 502,
      );
    }
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && response.body) {
      for await (const { data } of readSseStream(response, controller.signal, {
        maxBytes: MAX_STREAM_BYTES,
        limitCode: 'adapter_output_limit',
      })) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new Fault('invalid_protocol', 'A2A stream contained invalid JSON.', 502);
        }
        await handle(parsed);
        if (finalState) break;
      }
    } else {
      const raw = await readResponseText(response, controller.signal, {
        maxBytes: MAX_STREAM_BYTES,
        limitCode: 'adapter_output_limit',
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Fault('invalid_protocol', 'A2A agent returned invalid JSON.', 502);
      }
      await handle(parsed);
    }
    checkAbort(signal);
    // A stream marked final in a non-terminal state (or `unknown`) is not a completed turn.
    if (!finalState || !TERMINAL.has(finalState))
      throw new Fault('native_incomplete', 'A2A agent ended without a final task state.', 502);
    if (finalState === 'failed' || finalState === 'rejected')
      throw new Fault(
        'adapter_incomplete',
        `A2A task ${finalState}${question ? `: ${redact(question).slice(0, 500)}` : '.'}`,
        502,
      );
    if (finalState === 'canceled')
      throw new Fault('native_incomplete', 'A2A agent canceled the task.', 502);
    // input-required / auth-required end this turn with the agent's question as the answer;
    // replying with previous_response_id continues the same task.
    if ((finalState === 'input-required' || finalState === 'auth-required') && !text)
      await append(question);
    return {
      text,
      nativeState: {
        transport: 'a2a',
        adapter: name,
        protocolVersion: version,
        ...(contextId ? { contextId } : {}),
        ...(taskId ? { taskId } : {}),
        state: finalState,
      },
      usage: null,
    };
  } catch (error) {
    if (signal.aborted) {
      if (taskId)
        await rpc(
          v1 ? 'CancelTask' : 'tasks/cancel',
          { id: taskId },
          'application/json',
          AbortSignal.timeout(5_000),
        ).catch(() => {});
      throw new Fault('cancelled', 'A2A task cancelled.', 409);
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/**
 * Owner-requested discovery of the remote agent card. Tries the well-known path (the same in
 * 0.3 and 1.0) and the older one. No message is sent and no task is created.
 */
export async function probeA2A(adapter: A2AAdapterConfig, fetchImpl: FetchLike = globalThis.fetch) {
  validateEndpoint(adapter.url);
  for (const wellKnown of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
    const signal = AbortSignal.timeout(10_000);
    const response = await fetchImpl(new URL(wellKnown, adapter.url), {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: headers(adapter, 'application/json', adapter.protocolVersion ?? '1.0'),
    }).catch(() => undefined);
    if (!response?.ok) {
      await response?.body?.cancel().catch(() => {});
      continue;
    }
    const raw = await readResponseText(response, signal, {
      maxBytes: MAX_STREAM_BYTES,
      limitCode: 'adapter_output_limit',
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Fault('invalid_protocol', 'A2A agent card contains invalid JSON.', 502);
    }
    const card = record(parsed);
    if (typeof card.name !== 'string' || !card.name.trim())
      throw new Fault('invalid_protocol', 'A2A agent card requires an agent name.', 502);
    const capabilities = record(card.capabilities);
    // 1.0 lists interfaces with their binding and version; 0.3 has one top-level version.
    const interfaces = (Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [])
      .slice(0, 20)
      .map(record);
    const versions = [
      ...new Set(
        [card.protocolVersion, ...interfaces.map((i) => i.protocolVersion)]
          .map((v) => bounded(v, 20))
          .filter((v): v is string => !!v),
      ),
    ];
    return {
      status: 'passed' as const,
      card_path: wellKnown,
      agent:
        typeof card.name === 'string'
          ? { name: card.name.slice(0, 120), version: bounded(card.version, 80) }
          : null,
      protocol_version: versions[0] ?? null,
      protocol_versions: versions,
      bindings: [
        ...new Set(
          interfaces.map((i) => bounded(i.protocolBinding, 40)).filter((v): v is string => !!v),
        ),
      ],
      streaming: capabilities.streaming === true,
      skills: Array.isArray(card.skills) ? card.skills.length : 0,
      model_called: false,
    };
  }
  throw new Fault('adapter_failed', 'No A2A agent card was found at the well-known paths.', 502);
}
