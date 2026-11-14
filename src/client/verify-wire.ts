import { performance } from 'node:perf_hooks';
import type { Env } from './verify-env.js';
import { get, http } from './verify-harness.js';

// The four public wire formats as plain HTTP (no SDK, so a published install needs no extra packages):
// OpenAI Chat Completions, OpenAI Responses, Claude Messages and Gemini generateContent.
// Nothing retries; callers pass the scenario's AbortSignal.

export type SseEvent = { event?: string; data: string };

/** Parses a Server-Sent Events body into events. */
export async function* sseEvents(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (block: string): SseEvent | undefined => {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event, data: data.join('\n') } : undefined;
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const event = parse(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (event) yield event;
    }
  }
  const rest = parse(buffer);
  if (rest) yield rest;
}

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export type ChatResult = {
  status: number;
  runId: string | null;
  text: string;
  finish: string | null | undefined;
  usage: unknown;
  body: unknown;
};

/** `POST /v1/chat/completions`, non-streaming. */
export async function chat(env: Env, content: string, signal: AbortSignal): Promise<ChatResult> {
  const r = await http(
    env.base,
    'POST',
    '/v1/chat/completions',
    env.key,
    { model: env.agentId, messages: [{ role: 'user', content }] },
    {},
    signal,
  );
  return {
    status: r.status,
    runId: r.headers.get('x-run-id'),
    text: String(get(r.body, 'choices', 0, 'message', 'content') ?? ''),
    finish: get(r.body, 'choices', 0, 'finish_reason') as string | null | undefined,
    usage: get(r.body, 'usage'),
    body: r.body,
  };
}

export type StreamResult = {
  status: number;
  runId: string | null;
  text: string;
  finish: string | null | undefined;
  usage: unknown;
  /** Milliseconds from the request to each text delta. */
  times: number[];
  totalMs: number;
  /** Whether the stream ended with its terminator (`[DONE]` / `message_stop`). */
  ended: boolean;
  body: unknown;
};

/** `POST /v1/chat/completions` with `stream: true` and usage requested. */
export async function chatStream(
  env: Env,
  content: string,
  signal: AbortSignal,
): Promise<StreamResult> {
  const start = performance.now();
  const response = await fetch(`${env.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.agentId,
      messages: [{ role: 'user', content }],
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });
  const out: StreamResult = {
    status: response.status,
    runId: response.headers.get('x-run-id'),
    text: '',
    finish: undefined,
    usage: undefined,
    times: [],
    totalMs: 0,
    ended: false,
    body: undefined,
  };
  if (!response.ok) {
    out.body = json(await response.text());
    return out;
  }
  for await (const event of sseEvents(response)) {
    if (event.data === '[DONE]') {
      out.ended = true;
      continue;
    }
    const chunk = json(event.data);
    const delta = get(chunk, 'choices', 0, 'delta', 'content');
    if (typeof delta === 'string' && delta) {
      out.times.push(performance.now() - start);
      out.text += delta;
    }
    const finish = get(chunk, 'choices', 0, 'finish_reason');
    if (typeof finish === 'string') out.finish = finish;
    const usage = get(chunk, 'usage');
    if (usage) out.usage = usage;
  }
  out.totalMs = performance.now() - start;
  return out;
}

/** The text of a Responses API object (what SDKs call `output_text`). */
export const responseText = (body: unknown): string =>
  ((get(body, 'output') as { content?: { type?: string; text?: string }[] }[] | undefined) ?? [])
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');

/** `POST /v1/responses`, optionally continuing `previous` (a response ID). */
export async function responses(
  env: Env,
  input: string,
  previous: string | undefined,
  signal: AbortSignal,
) {
  const r = await http(
    env.base,
    'POST',
    '/v1/responses',
    env.key,
    { model: env.agentId, input, ...(previous ? { previous_response_id: previous } : {}) },
    {},
    signal,
  );
  return {
    status: r.status,
    id: get(r.body, 'id') as string | undefined,
    runStatus: get(r.body, 'status') as string | undefined,
    text: responseText(r.body),
    usage: get(r.body, 'usage'),
    body: r.body,
  };
}

const claudeHeaders = (env: Env) => ({
  'x-api-key': env.key,
  'anthropic-version': '2023-06-01',
});

/** `POST /v1/messages`, non-streaming. */
export async function claudeMessage(env: Env, content: string, signal: AbortSignal) {
  const r = await http(
    env.base,
    'POST',
    '/v1/messages',
    undefined,
    { model: env.agentId, max_tokens: 256, messages: [{ role: 'user', content }] },
    claudeHeaders(env),
    signal,
  );
  return {
    status: r.status,
    runId: r.headers.get('x-run-id'),
    text: ((get(r.body, 'content') as { type?: string; text?: string }[] | undefined) ?? [])
      .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
      .join(''),
    stopReason: get(r.body, 'stop_reason') as string | null | undefined,
    usage: get(r.body, 'usage'),
    body: r.body,
  };
}

/** `POST /v1/messages` with `stream: true`. */
export async function claudeStream(env: Env, content: string, signal: AbortSignal) {
  const response = await fetch(`${env.base}/v1/messages`, {
    method: 'POST',
    headers: { ...claudeHeaders(env), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.agentId,
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content }],
    }),
    signal,
  });
  const out = {
    status: response.status,
    runId: response.headers.get('x-run-id'),
    text: '',
    deltas: 0,
    stopped: false,
    stopReason: undefined as string | null | undefined,
    body: undefined as unknown,
  };
  if (!response.ok) {
    out.body = json(await response.text());
    return out;
  }
  for await (const event of sseEvents(response)) {
    const data = json(event.data);
    const type = get(data, 'type');
    if (type === 'content_block_delta' && get(data, 'delta', 'type') === 'text_delta') {
      out.text += String(get(data, 'delta', 'text') ?? '');
      out.deltas++;
    }
    if (type === 'message_delta') out.stopReason = get(data, 'delta', 'stop_reason') as string;
    if (type === 'message_stop') out.stopped = true;
  }
  return out;
}

/** `POST /v1/models/{agent}:generateContent`. */
export async function gemini(env: Env, content: string, signal: AbortSignal) {
  const r = await http(
    env.base,
    'POST',
    `/v1/models/${env.agentId}:generateContent`,
    undefined,
    { contents: [{ role: 'user', parts: [{ text: content }] }] },
    { 'x-goog-api-key': env.key },
    signal,
  );
  return {
    status: r.status,
    runId: r.headers.get('x-run-id'),
    text: ((get(r.body, 'candidates', 0, 'content', 'parts') as { text?: string }[]) ?? [])
      .map((p) => p.text ?? '')
      .join(''),
    finish: get(r.body, 'candidates', 0, 'finishReason'),
    usage: get(r.body, 'usageMetadata'),
    raw: r,
  };
}
