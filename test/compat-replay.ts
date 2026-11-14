/**
 * Replay engine for the compatibility lab (integrations/compat/replays/*.json).
 *
 * Each replay file describes what one client sends to a custom OpenAI-compatible endpoint and what
 * its code relies on in the response (`consumes`). The engine sends the request through a
 * transport (app.inject in the offline test, a real socket in `npm run compat`) and checks the
 * response against those requirements. It is shared by test/compat-replays.test.ts and the lab
 * launcher (integrations/compat/run.mjs, via dist/test/compat-replay.js).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type Evidence = {
  status: 'verified' | 'inferred' | 'unverified';
  source: string;
  note: string;
};
export type ReplayRequest = {
  method: 'GET' | 'POST' | 'OPTIONS';
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};
export type ReplayCase = {
  id: string;
  title: string;
  evidence: Evidence;
  request: ReplayRequest;
  expect: { status: number; code?: string };
  consumes: string[];
  notes?: string;
};
export type ReplayFile = {
  client: string;
  label: string;
  version: string;
  retrieved: string;
  overall: 'verified' | 'partial' | 'unverified';
  sources: { url: string; note: string }[];
  setup: { baseUrl: string; model: string; apiKey: string; notes: string };
  cases: ReplayCase[];
};
export type TransportResponse = { status: number; headers: Record<string, string>; text: string };
export type Transport = (request: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<TransportResponse>;
export type CaseResult = { ok: boolean; problems: string[]; status: number; ignored?: string };

export const REPLAY_DIR = path.resolve('integrations', 'compat', 'replays');

export async function loadReplayFiles(dir = REPLAY_DIR): Promise<ReplayFile[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (n) => JSON.parse(await readFile(path.join(dir, n), 'utf8')) as ReplayFile),
  );
}

/** The `Origin` values browser-direct cases send: the lab gateway must allow them. */
export function replayOrigins(files: ReplayFile[]): string[] {
  const origins = new Set<string>();
  for (const f of files)
    for (const c of f.cases) {
      const origin = Object.entries(c.request.headers).find(([k]) => k.toLowerCase() === 'origin');
      if (origin) origins.add(origin[1]);
    }
  return [...origins].sort();
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string')
    return value.replace(/\{\{(\w+)\}\}/g, (m, name: string) => vars[name] ?? m);
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (isObject(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

type Chunk = Json;
/** Splits an SSE body into frames; keeps raw text so frame-format rules can be checked. */
function sseFrames(text: string): { raw: string; data: string[] }[] {
  return text
    .split(/\n\n/)
    .filter((f) => f.trim().length > 0)
    .map((raw) => ({
      raw,
      data: raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, '')),
    }));
}

function streamChunks(text: string): {
  chunks: Chunk[];
  done: boolean;
  frames: { raw: string; data: string[] }[];
} {
  const frames = sseFrames(text);
  const chunks: Chunk[] = [];
  let done = false;
  for (const f of frames)
    for (const d of f.data) {
      if (d.trim() === '[DONE]') done = true;
      else
        try {
          const parsed: unknown = JSON.parse(d);
          if (isObject(parsed)) chunks.push(parsed);
        } catch {
          // a non-JSON data line is reported by stream.chunk_object
        }
    }
  return { chunks, done, frames };
}

const firstChoice = (chunk: Chunk): Json | undefined => {
  const c = list(chunk.choices)[0];
  return isObject(c) ? c : undefined;
};
const deltaOf = (chunk: Chunk): Json => {
  const d = firstChoice(chunk)?.delta;
  return isObject(d) ? d : {};
};

type Ctx = {
  request: ReplayRequest;
  response: TransportResponse;
  json: Json | undefined;
  stream: ReturnType<typeof streamChunks>;
};

const wantsUsage = (ctx: Ctx) => {
  const so = ctx.request.body?.stream_options;
  return isObject(so) && so.include_usage === true;
};

/** One check per vocabulary token; returns an error text or undefined when the client would accept it. */
const CHECKS: Record<string, (ctx: Ctx) => string | undefined> = {
  'models.object_list': ({ json }) =>
    json?.object === 'list' && Array.isArray(json.data)
      ? undefined
      : 'models: object is not "list" with a data array',
  'models.nonempty': ({ json }) =>
    list(json?.data).length > 0 ? undefined : 'models: data is empty',
  'models.id_string': ({ json }) =>
    list(json?.data).every((m) => isObject(m) && str(m.id))
      ? undefined
      : 'models: an item has no string id',
  'models.object_model': ({ json }) =>
    list(json?.data).every((m) => isObject(m) && m.object === 'model')
      ? undefined
      : 'models: an item object is not "model"',
  'models.created_number': ({ json }) =>
    list(json?.data).every((m) => isObject(m) && num(m.created))
      ? undefined
      : 'models: an item has no numeric created',
  'models.owned_by_string': ({ json }) =>
    list(json?.data).every((m) => isObject(m) && str(m.owned_by))
      ? undefined
      : 'models: an item has no string owned_by',
  'chat.id_string': ({ json }) => (str(json?.id) ? undefined : 'chat: id is not a string'),
  'chat.object_chat_completion': ({ json }) =>
    json?.object === 'chat.completion' ? undefined : 'chat: object is not "chat.completion"',
  'chat.created_number': ({ json }) =>
    num(json?.created) ? undefined : 'chat: created is not a number',
  'chat.model_string': ({ json }) => (str(json?.model) ? undefined : 'chat: model is not a string'),
  'chat.choices_nonempty': ({ json }) =>
    list(json?.choices).length > 0 ? undefined : 'chat: choices is empty',
  'chat.message_role_assistant': ({ json }) => {
    const c = list(json?.choices)[0];
    const m = isObject(c) ? c.message : undefined;
    return isObject(m) && m.role === 'assistant'
      ? undefined
      : 'chat: message.role is not "assistant"';
  },
  'chat.message_content_string': ({ json }) => {
    const c = list(json?.choices)[0];
    const m = isObject(c) ? c.message : undefined;
    return isObject(m) && str(m.content) ? undefined : 'chat: message.content is not a string';
  },
  'chat.finish_reason_string': ({ json }) => {
    const c = list(json?.choices)[0];
    return isObject(c) && str(c.finish_reason) ? undefined : 'chat: finish_reason is not a string';
  },
  'chat.usage_numbers': ({ json }) => {
    const u = json?.usage;
    return isObject(u) && num(u.prompt_tokens) && num(u.completion_tokens) && num(u.total_tokens)
      ? undefined
      : 'chat: usage lacks numeric prompt/completion/total tokens';
  },
  'stream.content_type_sse': ({ response }) =>
    (response.headers['content-type'] ?? '').startsWith('text/event-stream')
      ? undefined
      : `stream: content-type is "${response.headers['content-type'] ?? ''}"`,
  'stream.first_delta_role_assistant': ({ stream }) => {
    const first = stream.chunks.find((c) => firstChoice(c));
    return first && deltaOf(first).role === 'assistant'
      ? undefined
      : 'stream: first chunk with choices has no delta.role "assistant"';
  },
  'stream.content_deltas_present': ({ stream }) =>
    stream.chunks.some((c) => str(deltaOf(c).content) && (deltaOf(c).content as string).length > 0)
      ? undefined
      : 'stream: no chunk carries delta.content',
  'stream.finish_reason_chunk': ({ stream }) =>
    stream.chunks.some((c) => str(firstChoice(c)?.finish_reason))
      ? undefined
      : 'stream: no chunk has a non-null finish_reason',
  'stream.done_sentinel': ({ stream }) =>
    stream.done ? undefined : 'stream: no data: [DONE] sentinel',
  'stream.usage_chunk': (ctx) => {
    if (!wantsUsage(ctx)) return undefined;
    const usage = ctx.stream.chunks.find((c) => isObject(c.usage));
    if (!usage) return 'stream: include_usage requested but no chunk carries usage';
    return list(usage.choices).length === 0
      ? undefined
      : 'stream: the usage chunk must have an empty choices array';
  },
  'stream.chunk_object': ({ stream }) =>
    stream.chunks.length > 0 && stream.chunks.every((c) => c.object === 'chat.completion.chunk')
      ? undefined
      : 'stream: a chunk object is not "chat.completion.chunk" (or a data line is not JSON)',
  'stream.chunk_id_consistent': ({ stream }) =>
    new Set(stream.chunks.map((c) => c.id)).size === 1 ? undefined : 'stream: chunk ids differ',
  'stream.every_chunk_has_choices_array': ({ stream }) =>
    stream.chunks.every((c) => Array.isArray(c.choices))
      ? undefined
      : 'stream: a chunk has no choices array',
  'stream.data_only_lf_frames': ({ stream, response }) =>
    !response.text.includes('\r\n') &&
    stream.frames.every((f) => f.raw.split('\n').every((l) => l.startsWith('data:')))
      ? undefined
      : 'stream: frames use CRLF or lines other than "data:"',
  'cors.allow_origin_echo': ({ request, response }) => {
    const origin = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'origin')?.[1];
    return response.headers['access-control-allow-origin'] === origin
      ? undefined
      : `cors: access-control-allow-origin is "${response.headers['access-control-allow-origin'] ?? ''}"`;
  },
  'cors.allow_headers_cover_request': ({ request, response }) => {
    const asked =
      Object.entries(request.headers).find(
        ([k]) => k.toLowerCase() === 'access-control-request-headers',
      )?.[1] ?? '';
    const allowed = new Set(
      (response.headers['access-control-allow-headers'] ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase()),
    );
    const missing = asked
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h && !allowed.has(h) && !allowed.has('*'));
    return missing.length ? `cors: request headers not allowed: ${missing.join(', ')}` : undefined;
  },
};

export const KNOWN_TOKENS = Object.keys(CHECKS);

/** The gateway has no legacy completions endpoint (FIM / edit prediction); those cases are not run. */
export const outOfScope = (c: ReplayCase): boolean => c.request.path === '/v1/completions';

const isErrorShape = (json: Json | undefined) => {
  const e = json?.error;
  return isObject(e) && str(e.message) && str(e.code);
};

/**
 * Why a request cannot be served on the default (strict) endpoints by design. Such requests change
 * what the gateway has to do (caller-defined tools need a mode, JSON formats are best-effort), so the
 * default endpoints answer a clear 400 `unsupported_parameter` and the compat endpoints serve them.
 */
export function needsCompat(body: Record<string, unknown> | null): string[] {
  if (!body) return [];
  const reasons: string[] = [];
  const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
  if (nonEmpty(body.tools) || nonEmpty(body.functions)) reasons.push('tools');
  const format = body.response_format ?? (isObject(body.text) ? body.text.format : undefined);
  if (isObject(format) && format.type !== 'text') reasons.push('response_format');
  if (body.format !== undefined) reasons.push('format');
  if (
    list(body.messages).some(
      (m) =>
        isObject(m) &&
        (m.role === 'tool' || m.tool_calls !== undefined || m.function_call !== undefined),
    )
  )
    reasons.push('tool messages');
  return reasons;
}

/**
 * Runs one case. Never throws: a failed expectation is a problem entry. A request that needs the
 * compat endpoints is run twice: the default endpoint must refuse it clearly, the compat path must serve it.
 */
export async function runReplayCase(
  c: ReplayCase,
  transport: Transport,
  vars: { AGENT: string; KEY: string },
): Promise<CaseResult> {
  const reasons =
    c.expect.status === 200 && c.request.method === 'POST' ? needsCompat(c.request.body) : [];
  if (reasons.length === 0) return runOnce(c, transport, vars);
  const refused = await runOnce(
    { ...c, expect: { status: 400, code: 'unsupported_parameter' }, consumes: [] },
    transport,
    vars,
  );
  const served = await runOnce(
    { ...c, request: { ...c.request, path: c.request.path.replace(/^\/v1\//, '/v1/compat/') } },
    transport,
    vars,
  );
  const problems = [
    ...refused.problems.map(
      (p) => `default endpoint (${reasons.join(', ')} must be refused clearly): ${p}`,
    ),
    ...served.problems.map((p) => `compat endpoint: ${p}`),
  ];
  return {
    ok: problems.length === 0,
    problems,
    status: served.status,
    ...(served.ignored ? { ignored: served.ignored } : {}),
  };
}

async function runOnce(
  c: ReplayCase,
  transport: Transport,
  vars: { AGENT: string; KEY: string },
): Promise<CaseResult> {
  const request = substitute(c.request, vars) as ReplayRequest;
  const headers = { ...request.headers };
  const payload =
    request.body === null || request.body === undefined ? undefined : JSON.stringify(request.body);
  const response = await transport({
    method: request.method,
    path: request.path,
    headers,
    body: payload,
  });
  const problems: string[] = [];
  const expected = c.expect.status;
  const statusOk =
    response.status === expected ||
    (request.method === 'OPTIONS' && expected === 200 && response.status === 204);
  if (!statusOk) problems.push(`status ${response.status}, expected ${expected}`);
  let json: Json | undefined;
  try {
    const parsed: unknown = JSON.parse(response.text);
    if (isObject(parsed)) json = parsed;
  } catch {
    // streams and empty bodies are not JSON
  }
  if (expected >= 400 || response.status >= 400) {
    if (response.status >= 400) {
      if (!isErrorShape(json)) problems.push('error body is not {error:{message,code}}');
      const code = isObject(json?.error) ? (json.error as Json).code : undefined;
      if (c.expect.code && code !== c.expect.code)
        problems.push(`error code "${String(code)}", expected "${c.expect.code}"`);
      else if (!c.expect.code && expected < 400) {
        const e = isObject(json?.error) ? (json.error as Json) : {};
        problems.push(`gateway error ${String(e.code)}: ${String(e.message ?? '').slice(0, 300)}`);
      }
    }
    return { ok: problems.length === 0, problems, status: response.status };
  }
  if (statusOk && request.method !== 'OPTIONS') {
    const ctx: Ctx = { request, response, json, stream: streamChunks(response.text) };
    for (const token of c.consumes) {
      const check = CHECKS[token];
      if (!check) problems.push(`unknown consumes token ${token}`);
      else {
        const problem = check(ctx);
        if (problem) problems.push(problem);
      }
    }
  } else if (statusOk) {
    const ctx: Ctx = { request, response, json, stream: streamChunks('') };
    for (const token of c.consumes) {
      const problem = CHECKS[token]?.(ctx);
      if (problem) problems.push(problem);
    }
  }
  const ignored = response.headers['x-oaa-ignored-params'];
  return {
    ok: problems.length === 0,
    problems,
    status: response.status,
    ...(ignored ? { ignored } : {}),
  };
}
