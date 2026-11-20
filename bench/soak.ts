// Long-running soak test against a real gateway process (not part of `npm test`).
//
//   npm run soak -- --minutes 30 --concurrency 8 [--retention-minutes 5] [--dir DIR]
//
// It starts `node dist/src/cli.js serve` out of process on 127.0.0.1 with a temporary HOME and
// data directory, a local fake OpenAI-compatible model server (deterministic, no network) and the
// offline ACP sample agent, then drives a mixed load over HTTP: the three protocols, streaming with
// client disconnects, background runs with polling, continuations, cancellations, approvals
// (approve / deny / let expire), idempotent replays, invalid requests, event streams and console
// endpoints. It samples the gateway process, restarts it with SIGTERM twice and SIGKILL once, checks
// recovery, and writes report.json plus a readable summary. Exit code 1 when a criterion fails.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { agentSchema } from '../src/core/contracts.js';
import { workerSchema } from '../src/config/config.js';
import { makeBundle } from '../src/lang/bundle.js';
import { sampleDefinition } from '../src/client/quickstart.js';

const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '5' },
    concurrency: { type: 'string', default: '8' },
    'worker-slots': { type: 'string' },
    'retention-minutes': { type: 'string', default: '5' },
    'sample-seconds': { type: 'string', default: '10' },
    dir: { type: 'string' },
    keep: { type: 'boolean', default: false },
    /** Skip the SIGTERM/SIGKILL restarts (one long segment, for leak hunting). */
    'no-restarts': { type: 'boolean', default: false },
  },
});
const MINUTES = Number(values.minutes);
const CONCURRENCY = Number(values.concurrency);
const WORKER_SLOTS = workerSchema.shape.concurrency.parse(
  values['worker-slots'] === undefined ? undefined : Number(values['worker-slots']),
);
const RETENTION_MINUTES = Number(values['retention-minutes']);
const SAMPLE_MS = Number(values['sample-seconds']) * 1000;
const APPROVAL_TIMEOUT_MS = 10_000;
const MAX_DATA_BYTES = 2 * 1024 ** 3;
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const cli = path.join(repo, 'dist', 'src', 'cli.js');
const probe = path.join(repo, 'dist', 'bench', 'soak-probe.js');

// ---------- fake model provider (OpenAI chat completions, always streamed) ----------
function fakeProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      let last = '';
      let toolResult = false;
      let repairAsked = false;
      let hasTools = false;
      try {
        const body = JSON.parse(raw) as {
          messages?: { role: string; content?: unknown }[];
          tools?: unknown[];
        };
        last = JSON.stringify(body.messages?.filter((m) => m.role === 'user').at(-1)?.content);
        toolResult = !!body.messages?.some((m) => m.role === 'tool');
        repairAsked = JSON.stringify(body.messages ?? []).includes('[Structured output repair]');
        hasTools = !!body.tools?.length;
      } catch {
        res.writeHead(400).end();
        return;
      }
      const frame = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
      // A caller tool: ask for it once, then answer from its result.
      if (hasTools && !toolResult && last.includes('use the tool')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_soak',
                    function: { name: 'lookup', arguments: '{"q":"x"}' },
                  },
                ],
              },
            },
          ],
        });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        frame({ choices: [], usage });
        res.end('data: [DONE]\n\n');
        return;
      }
      // Structured output: valid JSON, except a first wrong answer when a repair is wanted.
      // The correction round's user message is the repair prompt, so look at the whole history.
      if (last.includes('give json') || repairAsked) {
        const text =
          last.includes('repair-me') && !repairAsked ? 'Sure! Here it is: not json' : '{"ok":true}';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        frame({ choices: [{ index: 0, delta: { content: text } }] });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        frame({ choices: [], usage });
        res.end('data: [DONE]\n\n');
        return;
      }
      const slow = last.includes('slow');
      const words = `Deterministic soak reply to ${last.length} characters of input.`.split(' ');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const send = () => {
        if (res.destroyed) return;
        if (i < words.length) {
          const delta = { content: (i ? ' ' : '') + words[i++] };
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
          setTimeout(send, slow ? 400 : 5 + Math.random() * 20);
          return;
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: words.length, total_tokens: 20 + words.length } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      };
      send();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}/v1` });
    }),
  );
}
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

// ---------- webhook receiver (one healthy endpoint, one flaky) ----------
const webhookStats = { ok: 0, failed: 0, slow: 0 };
function webhookReceiver(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const flaky = req.url?.startsWith('/flaky');
      const roll = Math.random();
      if (flaky && roll < 0.1) {
        // Longer than the gateway's 10 s per-attempt timeout.
        webhookStats.slow++;
        setTimeout(() => res.writeHead(200).end(), 12_000);
        return;
      }
      if (flaky && roll < 0.4) {
        webhookStats.failed++;
        res.writeHead(500).end();
        return;
      }
      webhookStats.ok++;
      res.writeHead(204).end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    }),
  );
}

// ---------- statistics ----------
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};
/** Least-squares slope of y over x (x in minutes). */
function slope(points: [number, number][]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  const sxx = points.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return sxx ? points.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx : null;
}

const FIX = 'agent/fixture';
const SAMPLE = 'agent/sample';
// ---------- state ----------
type Failure = { t: number; op: string; detail: string };
const started = Date.now();
const failures: Failure[] = [];
const failureCounts = new Map<string, number>();
const checks: { t: number; name: string; ok: boolean; detail: string }[] = [];
const latencies = new Map<string, number[]>();
let windowLatencies: number[] = [];
let ok = 0;
let unexpected = 0;
let restartWindow = 0;
let throttled = 0;
let gatewayDown = false;
let downUntil = 0;
const completed: { id: string; t: number; agent: string }[] = [];
const recentIds: string[] = [];

/** Start time of the operation running in this async context. */
const opContext = new AsyncLocalStorage<number>();
let lastRestartAt = 0;
function fail(op: string, detail: string) {
  // Failures caused by a deliberate restart (refused connections, interrupted runs) are counted
  // separately: they are what the recovery checks examine.
  const opStart = opContext.getStore() ?? Date.now();
  if (gatewayDown || Date.now() < downUntil || lastRestartAt >= opStart) {
    restartWindow++;
    return;
  }
  unexpected++;
  const key = `${op}: ${detail.slice(0, 120)}`;
  failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
  if (failures.length < 300) failures.push({ t: Date.now() - started, op, detail });
}
function check(name: string, pass: boolean, detail = '') {
  checks.push({ t: Date.now() - started, name, ok: pass, detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}\n`);
}
function remember(id: string, status: string, agent = FIX) {
  recentIds.push(id);
  if (recentIds.length > 200) recentIds.shift();
  if (status === 'completed') completed.push({ id, t: Date.now(), agent });
}
const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(Math.random() * xs.length)];
const lastCompleted = () =>
  completed.at(-1 - Math.floor(Math.random() * Math.min(20, completed.length)));

// ---------- gateway process ----------
const root = values.dir
  ? path.resolve(values.dir)
  : await mkdtemp(path.join(os.tmpdir(), 'oaa-soak-'));
const run = path.join(root, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const home = path.join(run, 'home');
const data = path.join(run, 'data');
const probeFile = path.join(run, 'probe.jsonl');
await mkdir(home, { recursive: true });
await mkdir(data, { recursive: true, mode: 0o700 });
// A private copy of the sample agent so leftover processes are attributable to this run.
const sampleScript = path.join(run, 'soak-sample-agent.mjs');
await copyFile(path.join(repo, 'examples', 'sample-agent.mjs'), sampleScript);
const token = randomBytes(32).toString('base64url');
await writeFile(path.join(data, 'admin.token'), token, { mode: 0o600 });
const provider = await fakeProvider();
const receiver = await webhookReceiver();
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const config = {
  host: '127.0.0.1',
  port,
  dataDir: data,
  keys: [
    {
      name: 'soak',
      owner: 'owner',
      tokenFile: path.join(data, 'admin.token'),
      scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
      quota: { rpm: 100_000, maxConcurrentRuns: 64 },
    },
  ],
  localWorker: {
    nodeId: 'local',
    concurrency: WORKER_SLOTS,
    owner: 'owner',
    dataDir: path.join(data, 'worker'),
    providers: {
      fake: {
        kind: 'openai-chat',
        baseUrl: provider.url,
        apiKeyEnv: 'SOAK_FAKE_KEY',
        imageInput: 'inline',
      },
    },
    adapters: {
      'oaa-sample': {
        transport: 'acp',
        command: process.execPath,
        args: [sampleScript],
        enabled: true,
      },
    },
  },
  approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
  platform: { owner: 'owner', registration: 'open', signupCredits: 1_000_000_000 },
  ...(RETENTION_MINUTES > 0
    ? { retention: { runsDays: RETENTION_MINUTES / 1440, intervalMinutes: 1 } }
    : {}),
};
const configFile = path.join(data, 'config.json');
await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });

let gateway: ChildProcess | undefined;
const pids: number[] = [];
async function startGateway(): Promise<void> {
  const log = openSync(path.join(run, 'gateway.log'), 'a');
  gateway = spawn(
    process.execPath,
    ['--expose-gc', '--import', probe, cli, 'serve', '--config', configFile],
    {
      cwd: run,
      env: {
        HOME: home,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'en_US.UTF-8',
        SOAK_FAKE_KEY: 'fake-local-key',
        SOAK_PROBE_FILE: probeFile,
        ...(process.env.SOAK_SNAPSHOT_DIR
          ? { SOAK_SNAPSHOT_DIR: process.env.SOAK_SNAPSHOT_DIR }
          : {}),
        SOAK_PROBE_MS: String(Math.min(SAMPLE_MS, 5000)),
      },
      stdio: ['ignore', log, log],
    },
  );
  closeSync(log);
  pids.push(gateway.pid!);
  // Up to 3 minutes: a slow start is reported by the restart check instead of aborting the run.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('gateway did not become healthy within 3 minutes');
}
async function stopGateway(signal: 'SIGTERM' | 'SIGKILL'): Promise<number> {
  const child = gateway!;
  const t0 = Date.now();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill(signal);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 30_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    check(`${signal} exits within 30 s`, false);
    child.kill('SIGKILL');
    await exited;
  }
  return Date.now() - t0;
}

// ---------- HTTP helpers ----------
type Res = { status: number; body: Record<string, unknown>; ms: number };
async function call(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  bearer = token,
): Promise<Res> {
  const t0 = performance.now();
  const r = await fetch(base + url, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  const ms = performance.now() - t0;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: r.status, body: parsed, ms };
}
const errCode = (r: Res) =>
  String((r.body.error as { code?: string; type?: string } | undefined)?.code ?? r.status);
const TERMINAL = ['completed', 'failed', 'cancelled', 'incomplete', 'interrupted'];
async function poll(id: string, until: (s: string) => boolean, ms = 30_000): Promise<string> {
  const end = Date.now() + ms;
  let status = 'unknown';
  while (Date.now() < end) {
    // The native run view: Responses objects show requires_action as in_progress.
    const r = await call('GET', `/v1/runs/${id}`);
    status = r.status === 200 ? String(r.body.status) : `http_${r.status}`;
    if (until(status)) return status;
    await new Promise((res) => setTimeout(res, 150));
  }
  return status;
}

// ---------- operations ----------
type Op = { name: string; weight: number; run: () => Promise<void> };
const expectStatus = (op: string, r: Res, statuses: number[]) => {
  if (r.status === 429) {
    throttled++;
    return false;
  }
  if (!statuses.includes(r.status)) {
    fail(op, `HTTP ${r.status} ${errCode(r)}`);
    return false;
  }
  return true;
};
async function streamOp(op: string, url: string, body: unknown, abort: boolean) {
  const controller = new AbortController();
  const t0 = performance.now();
  const r = await fetch(base + url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (r.status === 429) {
    throttled++;
    await r.body?.cancel();
    return;
  }
  if (r.status !== 200) {
    fail(op, `HTTP ${r.status}`);
    await r.body?.cancel();
    return;
  }
  const reader = r.body!.getReader();
  let text = '';
  let chunks = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      if (abort && ++chunks >= 2) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!abort) throw error;
  }
  record(op, performance.now() - t0);
  if (!abort && !/completed|\[DONE\]|message_stop/.test(text))
    fail(op, `stream ended without a terminal frame (${text.length} bytes)`);
}
function record(op: string, ms: number) {
  ok++;
  windowLatencies.push(ms);
  const xs = latencies.get(op) ?? [];
  xs.push(ms);
  if (xs.length > 20_000) xs.splice(0, xs.length - 20_000);
  latencies.set(op, xs);
}
const ops: Op[] = [
  {
    name: 'responses',
    weight: 12,
    run: async () => {
      const r = await call('POST', '/v1/responses', { model: FIX, input: 'hello soak' });
      if (!expectStatus('responses', r, [200])) return;
      if (r.body.status !== 'completed')
        return fail('responses', `status ${String(r.body.status)}`);
      remember(String(r.body.id), 'completed');
      record('responses', r.ms);
    },
  },
  {
    name: 'chat',
    weight: 8,
    run: async () => {
      const r = await call('POST', '/v1/chat/completions', {
        model: FIX,
        messages: [{ role: 'user', content: 'hello chat' }],
      });
      if (expectStatus('chat', r, [200])) record('chat', r.ms);
    },
  },
  {
    name: 'claude',
    weight: 8,
    run: async () => {
      const r = await call(
        'POST',
        '/v1/messages',
        { model: FIX, max_tokens: 256, messages: [{ role: 'user', content: 'hello claude' }] },
        { 'anthropic-version': '2023-06-01' },
      );
      if (expectStatus('claude', r, [200])) record('claude', r.ms);
    },
  },
  {
    name: 'gemini',
    weight: 6,
    run: async () => {
      const r = await call('POST', `/v1beta/models/${FIX}:generateContent`, {
        contents: [{ role: 'user', parts: [{ text: 'hello gemini' }] }],
      });
      if (expectStatus('gemini', r, [200])) record('gemini', r.ms);
    },
  },
  {
    name: 'stream',
    weight: 10,
    run: () =>
      streamOp(
        'stream',
        '/v1/responses',
        { model: FIX, input: 'stream me', stream: true },
        Math.random() < 0.3,
      ),
  },
  {
    name: 'stream_claude',
    weight: 4,
    run: () =>
      streamOp(
        'stream_claude',
        '/v1/messages',
        {
          model: FIX,
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: 'stream claude' }],
        },
        Math.random() < 0.3,
      ),
  },
  {
    name: 'background',
    weight: 8,
    run: async () => {
      const r = await call('POST', '/v1/responses', {
        model: FIX,
        input: 'background job',
        background: true,
      });
      if (!expectStatus('background', r, [200])) return;
      const id = String(r.body.id);
      const status = await poll(id, (s) => TERMINAL.includes(s) || s.startsWith('http_'));
      if (status !== 'completed') return fail('background', `final ${status}`);
      remember(id, status);
      record('background', r.ms);
    },
  },
  {
    name: 'continue',
    weight: 6,
    run: async () => {
      const previous = lastCompleted();
      if (!previous) return;
      const r = await call('POST', '/v1/responses', {
        model: previous.agent,
        input: 'and then?',
        previous_response_id: previous.id,
      });
      // 404: the previous run was pruned by retention; 409: its session is busy.
      if (r.status === 404 || errCode(r) === 'session_busy') return record('continue', r.ms);
      if (!expectStatus('continue', r, [200])) return;
      remember(String(r.body.id), String(r.body.status));
      record('continue', r.ms);
    },
  },
  {
    name: 'cancel',
    weight: 6,
    run: async () => {
      const r = await call('POST', '/v1/responses', {
        model: FIX,
        input: 'slow job to cancel',
        background: true,
      });
      if (!expectStatus('cancel', r, [200])) return;
      const id = String(r.body.id);
      await new Promise((res) => setTimeout(res, pick([0, 20, 300, 1500])));
      const c = await call('POST', `/v1/responses/${id}/cancel`);
      if (!expectStatus('cancel', c, [200, 409])) return;
      const status = await poll(id, (s) => TERMINAL.includes(s));
      if (!['cancelled', 'completed'].includes(status)) return fail('cancel', `final ${status}`);
      record('cancel', c.ms);
    },
  },
  {
    name: 'approval',
    weight: 6,
    run: async () => {
      const r = await call('POST', '/v1/responses', {
        model: SAMPLE,
        input: 'please approve a file write',
        background: true,
      });
      if (!expectStatus('approval', r, [200])) return;
      const id = String(r.body.id);
      const waiting = await poll(id, (s) => s === 'requires_action' || TERMINAL.includes(s));
      if (waiting !== 'requires_action') return fail('approval', `never waited: ${waiting}`);
      const actions = await call('GET', `/v1/runs/${id}/actions`);
      const action = (actions.body.data as { id: string }[] | undefined)?.[0];
      if (!action) return fail('approval', 'no pending action listed');
      const choice = Math.random();
      if (choice < 0.8) {
        const decision = choice < 0.4 ? 'approve' : 'deny';
        const d = await call('POST', `/v1/runs/${id}/actions/${action.id}`, { decision });
        if (!expectStatus('approval', d, [200])) return;
      }
      const final = await poll(id, (s) => TERMINAL.includes(s), APPROVAL_TIMEOUT_MS + 20_000);
      if (!TERMINAL.includes(final) || final === 'interrupted')
        return fail('approval', `final ${final}`);
      record('approval', r.ms);
    },
  },
  {
    name: 'sample',
    weight: 5,
    run: async () => {
      const r = await call('POST', '/v1/responses', { model: SAMPLE, input: 'hello sample' });
      if (!expectStatus('sample', r, [200])) return;
      if (r.body.status !== 'completed') return fail('sample', `status ${String(r.body.status)}`);
      remember(String(r.body.id), 'completed', SAMPLE);
      record('sample', r.ms);
    },
  },
  {
    name: 'idempotent',
    weight: 4,
    run: async () => {
      const key = `soak-${randomBytes(8).toString('hex')}`;
      const body = { model: FIX, input: 'once only' };
      const a = await call('POST', '/v1/responses', body, { 'idempotency-key': key });
      if (!expectStatus('idempotent', a, [200])) return;
      const b = await call('POST', '/v1/responses', body, { 'idempotency-key': key });
      if (!expectStatus('idempotent', b, [200])) return;
      if (a.body.id !== b.body.id) return fail('idempotent', 'replay created a second run');
      record('idempotent', b.ms);
    },
  },
  {
    name: 'invalid',
    weight: 4,
    run: async () => {
      const kind = Math.random();
      if (kind < 0.4) {
        const r = await call('POST', '/v1/responses', { model: FIX, input: 'x' }, {}, 'bad-key');
        if (expectStatus('invalid', r, [401])) record('invalid', r.ms);
      } else if (kind < 0.9) {
        const r = await call('POST', '/v1/responses', { model: FIX, nonsense: true });
        if (expectStatus('invalid', r, [400])) record('invalid', r.ms);
      } else {
        // Above the 24 MiB body limit: the gateway answers 413 and may close the socket before
        // the client finishes sending, which fetch reports as a network error. Both are fine.
        const big = JSON.stringify({ model: FIX, input: 'x'.repeat(25 * 1024 * 1024) });
        const r = await call('POST', '/v1/responses', big).catch(() => undefined);
        if (!r) return record('invalid', 0);
        if (expectStatus('invalid', r, [413])) record('invalid', r.ms);
      }
    },
  },
  {
    name: 'events',
    weight: 4,
    run: async () => {
      const id = pick(recentIds);
      if (!id) return;
      const controller = new AbortController();
      const t0 = performance.now();
      const r = await fetch(`${base}/v1/runs/${id}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (r.status === 404) return void (await r.body?.cancel());
      if (r.status !== 200) {
        await r.body?.cancel();
        return fail('events', `HTTP ${r.status}`);
      }
      const reader = r.body!.getReader();
      await Promise.race([reader.read(), new Promise((res) => setTimeout(res, 500))]);
      controller.abort();
      record('events', performance.now() - t0);
    },
  },
  {
    name: 'console',
    weight: 6,
    run: async () => {
      const id = pick(recentIds);
      const url = pick([
        '/v1/overview',
        '/v1/overview/activity',
        '/v1/runs?limit=20',
        ...(id ? [`/v1/runs/${id}/timeline`, `/v1/runs/${id}/state`] : []),
      ])!;
      const r = await call('GET', url);
      if (r.status === 404 && url.startsWith('/v1/runs/')) return record('console', r.ms);
      if (expectStatus('console', r, [200])) record('console', r.ms);
    },
  },
];
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const lookupTool = {
  type: 'function',
  function: {
    name: 'lookup',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
};
let accountKey = '';
ops.push(
  {
    name: 'tool_bridge',
    weight: 4,
    run: async () => {
      const user = { role: 'user', content: 'please use the tool' };
      const a = await call('POST', '/v1/chat/completions', {
        model: FIX,
        messages: [user],
        tools: [lookupTool],
      });
      if (!expectStatus('tool_bridge', a, [200])) return;
      const choice = (
        a.body.choices as { finish_reason: string; message: Record<string, unknown> }[]
      )[0]!;
      if (choice.finish_reason !== 'tool_calls')
        return fail('tool_bridge', `finish ${choice.finish_reason}`);
      const calls = choice.message.tool_calls as { id: string }[];
      const b = await call('POST', '/v1/chat/completions', {
        model: FIX,
        messages: [
          user,
          choice.message,
          { role: 'tool', tool_call_id: calls[0]!.id, content: '{"answer":42}' },
        ],
        tools: [lookupTool],
      });
      if (!expectStatus('tool_bridge', b, [200])) return;
      record('tool_bridge', a.ms + b.ms);
    },
  },
  {
    name: 'structured',
    weight: 4,
    run: async () => {
      const r = await call('POST', '/v1/chat/completions', {
        model: FIX,
        messages: [
          { role: 'user', content: Math.random() < 0.3 ? 'give json repair-me' : 'give json' },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'soak',
            strict: true,
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        },
      });
      if (!expectStatus('structured', r, [200])) return;
      const text = (r.body.choices as { message: { content: string } }[])[0]!.message.content;
      if (JSON.parse(text).ok !== true) return fail('structured', `content ${text.slice(0, 60)}`);
      record('structured', r.ms);
    },
  },
  {
    name: 'image',
    weight: 3,
    run: async () => {
      const r = await call('POST', '/v1/chat/completions', {
        model: FIX,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe the image' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1PX}` } },
            ],
          },
        ],
      });
      if (expectStatus('image', r, [200])) record('image', r.ms);
    },
  },
  {
    name: 'billed',
    weight: 3,
    run: async () => {
      if (!accountKey) return;
      // A billed call; one in five is cancelled early, which refunds the per-run price.
      const cancel = Math.random() < 0.2;
      const r = await call(
        'POST',
        '/v1/responses',
        { model: FIX, input: cancel ? 'slow billed job' : 'billed job', background: cancel },
        {},
        accountKey,
      );
      if (!expectStatus('billed', r, [200])) return;
      if (cancel) {
        const c = await call(
          'POST',
          `/v1/responses/${String(r.body.id)}/cancel`,
          undefined,
          {},
          accountKey,
        );
        if (!expectStatus('billed', c, [200, 409])) return;
      }
      record('billed', r.ms);
    },
  },
);
const totalWeight = ops.reduce((n, o) => n + o.weight, 0);
function chooseOp(): Op {
  let x = Math.random() * totalWeight;
  for (const op of ops) if ((x -= op.weight) < 0) return op;
  return ops[0]!;
}

// ---------- sampling ----------
type Sample = {
  t_min: number;
  segment: number;
  rss_mb: number | null;
  heap_mb: number | null;
  /** Off-heap memory V8 knows of (Buffers, ArrayBuffers) and the heap's committed size. */
  external_mb: number | null;
  heap_total_mb: number | null;
  handles: number | null;
  fds: number | null;
  children: number | null;
  local_worker?: { capacity: number; active: number } | null;
  db_mb: number;
  wal_mb: number;
  data_mb: number;
  runs: number;
  unfinished: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  requests: number;
  unexpected: number;
};
const samples: Sample[] = [];
async function workerSample() {
  try {
    const response = await fetch(base + '/v1/nodes', {
      headers: { authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const { data } = (await response.json()) as {
      data: { nodeId: string; concurrency: number; active: number }[];
    };
    const node = data.find((n) => n.nodeId === 'local');
    return node && Number.isSafeInteger(node.concurrency) && Number.isSafeInteger(node.active)
      ? { capacity: node.concurrency, active: node.active }
      : null;
  } catch {
    return null;
  }
}
let segment = 0;
let lastOk = 0;
let lastUnexpected = 0;
function dbQuery<T>(fn: (db: DatabaseSync) => T): T | undefined {
  try {
    const db = new DatabaseSync(path.join(data, 'state.sqlite'), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=2000');
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
const sh = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' });
  } catch {
    return '';
  }
};
async function dirBytes(dir: string): Promise<number> {
  const out = sh('du', ['-sk', dir]);
  return Number(out.split('\t')[0] || 0) * 1024;
}
async function takeSample(): Promise<void> {
  const pid = gateway?.pid;
  const lines = (await readFile(probeFile, 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter((line) => line && !line.includes('"boot":true'));
  const last =
    lines.length && lines.at(-1)
      ? (JSON.parse(lines.at(-1)!) as Record<string, number>)
      : undefined;
  const fresh = last && last.pid === pid && Date.now() - last.t! < SAMPLE_MS * 2 ? last : undefined;
  const fds = pid
    ? sh('lsof', ['-n', '-P', '-p', String(pid)])
        .trim()
        .split('\n').length - 1
    : null;
  const children = pid
    ? sh('pgrep', ['-P', String(pid)])
        .trim()
        .split('\n')
        .filter(Boolean).length
    : null;
  const size = (f: string) =>
    stat(path.join(data, f)).then(
      (s) => s.size / 1024 ** 2,
      () => 0,
    );
  const counts = dbQuery((db) => ({
    runs: Number(db.prepare('SELECT count(*) AS n FROM runs').get()!.n),
    unfinished: Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM runs WHERE status IN ('queued','in_progress','requires_action')",
        )
        .get()!.n,
    ),
  }));
  const dataBytes = await dirBytes(run);
  samples.push({
    t_min: (Date.now() - started) / 60_000,
    segment,
    rss_mb: fresh ? fresh.rss! / 1024 ** 2 : null,
    heap_mb: fresh ? fresh.heap_used! / 1024 ** 2 : null,
    external_mb: fresh ? fresh.external! / 1024 ** 2 : null,
    heap_total_mb: fresh ? fresh.heap_total! / 1024 ** 2 : null,
    handles: fresh ? fresh.handles! : null,
    fds,
    children,
    ...(values['worker-slots'] !== undefined ? { local_worker: await workerSample() } : {}),
    db_mb: await size('state.sqlite'),
    wal_mb: await size('state.sqlite-wal'),
    data_mb: dataBytes / 1024 ** 2,
    runs: counts?.runs ?? -1,
    unfinished: counts?.unfinished ?? -1,
    p50_ms: quantile(windowLatencies, 0.5),
    p95_ms: quantile(windowLatencies, 0.95),
    p99_ms: quantile(windowLatencies, 0.99),
    requests: ok - lastOk,
    unexpected: unexpected - lastUnexpected,
  });
  const s = samples.at(-1)!;
  process.stdout.write(
    `[${s.t_min.toFixed(1)}m seg${segment}] rss=${s.rss_mb?.toFixed(0)}MB heap=${s.heap_mb?.toFixed(0)}MB fds=${s.fds} children=${s.children} db=${s.db_mb.toFixed(1)}MB wal=${s.wal_mb.toFixed(1)}MB runs=${s.runs} unfinished=${s.unfinished} p95=${s.p95_ms?.toFixed(0)}ms ok=${s.requests} err=${s.unexpected}\n`,
  );
  windowLatencies = [];
  lastOk = ok;
  lastUnexpected = unexpected;
  if (dataBytes > MAX_DATA_BYTES) {
    check('data directory stays below 2 GB', false, `${(dataBytes / 1024 ** 3).toFixed(2)} GB`);
    stopping = true;
  }
}

// ---------- restarts and recovery checks ----------
function leftoverSampleAgents(): number[] {
  return sh('pgrep', ['-f', sampleScript])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .filter((pid) => pid !== process.pid);
}
async function restart(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const label = `${signal} restart #${segment + 1}`;
  const doneBefore = completed.filter((c) => Date.now() - c.t < 60_000).map((c) => c.id);
  gatewayDown = true;
  lastRestartAt = Date.now();
  const stopMs = await stopGateway(signal);
  // Children exit when their stdin closes; give them a moment, then count leftovers.
  await new Promise((r) => setTimeout(r, 1500));
  const orphans = leftoverSampleAgents();
  check(`${label}: no orphan agent processes`, orphans.length === 0, `pids=${orphans.join(',')}`);
  if (orphans.length) for (const pid of orphans) sh('kill', ['-9', String(pid)]);
  const before =
    dbQuery((db) =>
      db
        .prepare(
          "SELECT id,status FROM runs WHERE status IN ('queued','in_progress','requires_action')",
        )
        .all()
        .map((r) => ({ id: String(r.id), status: String(r.status) })),
    ) ?? [];
  const t0 = Date.now();
  await startGateway();
  const startMs = Date.now() - t0;
  segment++;
  gatewayDown = false;
  downUntil = Date.now() + 2000;
  check(
    `${label}: gateway healthy again within 30 s`,
    startMs < 30_000,
    `stop=${stopMs}ms start=${startMs}ms`,
  );
  const after = dbQuery((db) => {
    const get = db.prepare('SELECT status FROM runs WHERE id=?');
    return {
      missing: doneBefore.filter((id) => get.get(id)?.status !== 'completed'),
      states: before.map((r) => ({ ...r, now: String(get.get(r.id)?.status ?? 'missing') })),
    };
  });
  check(
    `${label}: runs completed in the last minute are still completed`,
    !!after && after.missing.length === 0,
    `${doneBefore.length} checked, ${after?.missing.length ?? '?'} missing`,
  );
  const bad = (after?.states ?? []).filter(
    (r) => r.status === 'in_progress' && r.now === 'in_progress',
  );
  check(
    `${label}: no run left in_progress by the old process`,
    bad.length === 0,
    `${before.length} unfinished at stop: ${JSON.stringify(
      (after?.states ?? []).reduce<Record<string, number>>((m, r) => {
        const k = `${r.status}->${r.now}`;
        m[k] = (m[k] ?? 0) + 1;
        return m;
      }, {}),
    )}`,
  );
  // Resume up to five interrupted runs explicitly, as an operator would.
  const interrupted = (after?.states ?? []).filter((r) => r.now === 'interrupted').slice(0, 5);
  for (const r of interrupted) {
    const res = await call('POST', `/v1/runs/${r.id}/resume`);
    if (![200, 409].includes(res.status)) fail('resume', `HTTP ${res.status} ${errCode(res)}`);
  }
}

// ---------- main loop ----------
let stopping = false;
const end = started + MINUTES * 60_000;
// Never leave the gateway behind if the harness itself fails.
process.on('exit', () => {
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) gateway.kill('SIGKILL');
});
await startGateway();
for (const [definition] of [
  [
    agentSchema.parse({
      id: FIX,
      description: 'Soak fixture agent backed by a local deterministic model server.',
      instructions: 'Reply briefly.',
      provider: 'fake',
      model: 'fake-model',
    }),
  ],
  [sampleDefinition()],
] as const) {
  const r = await call('POST', '/v1/agents/publish', makeBundle(definition));
  if (r.status !== 200)
    throw new Error(`publish ${definition.id}: ${r.status} ${JSON.stringify(r.body)}`);
}
for (const [path_, description] of [
  ['/ok', 'soak healthy receiver'],
  ['/flaky', 'soak flaky receiver'],
]) {
  const r = await call('POST', '/v1/webhooks', {
    url: receiver.url + path_,
    description,
    allow_insecure_http: true,
    allow_private_network: true,
  });
  if (r.status !== 201) throw new Error(`webhook: ${r.status} ${JSON.stringify(r.body)}`);
}
{
  const listing = await call('PUT', '/v1/platform/listings', {
    agent_id: FIX,
    price: { per_run: 1 },
    enabled: true,
  });
  if (listing.status !== 200)
    throw new Error(`listing: ${listing.status} ${JSON.stringify(listing.body)}`);
  const signup = await call('POST', '/v1/portal/signup', {
    email: `soak-${Date.now()}@example.test`,
    password: `soak-test-only-${randomBytes(6).toString('hex')}`,
  });
  const session = String((signup.body.session as { token?: string } | undefined)?.token ?? '');
  const key = await call('POST', '/v1/portal/keys', { name: 'soak' }, {}, session);
  accountKey = String(key.body.token ?? '');
  if (!accountKey)
    throw new Error(`portal key: ${signup.status} ${key.status} ${JSON.stringify(key.body)}`);
}
const schedule: { at: number; signal: 'SIGTERM' | 'SIGKILL' }[] = [
  { at: 0.2, signal: 'SIGTERM' },
  { at: 0.4, signal: 'SIGKILL' },
  { at: 0.6, signal: 'SIGTERM' },
].map((s) => ({
  at: started + s.at * MINUTES * 60_000,
  signal: s.signal as 'SIGTERM' | 'SIGKILL',
}));
if (values['no-restarts']) schedule.length = 0;
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (!stopping && Date.now() < end) {
    if (gatewayDown) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const op = chooseOp();
    try {
      await opContext.run(Date.now(), op.run);
    } catch (error) {
      fail(op.name, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  }
});
/** SOAK_SNAPSHOT_MINUTES=10,30,55 (with SOAK_SNAPSHOT_DIR): heap snapshots of the gateway. */
const snapshotAt = (process.env.SOAK_SNAPSHOT_MINUTES ?? '')
  .split(',')
  .filter(Boolean)
  .map((m) => started + Number(m) * 60_000);
let snapshotsTaken = 0;
async function snapshotIfDue(): Promise<void> {
  if (!snapshotAt.length || Date.now() < snapshotAt[0]! || !gateway?.pid) return;
  snapshotAt.shift();
  snapshotsTaken++;
  gateway.kill('SIGUSR2');
  check('heap snapshot requested', true, `at ${((Date.now() - started) / 60_000).toFixed(1)} min`);
}
let pruneAt = started + MINUTES * 60_000 * 0.5;
async function runPrune(): Promise<void> {
  const t0 = Date.now();
  const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [cli, 'prune', '--config', configFile, '--older-than', '2m'],
      {
        env: {
          HOME: home,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          LANG: 'en_US.UTF-8',
        },
      },
    );
    let text = '';
    child.stdout.on('data', (c: Buffer) => (text += c.toString()));
    child.stderr.on('data', (c: Buffer) => (text += c.toString()));
    child.on('exit', (code) => resolve({ code, text }));
  });
  check(
    'oaa prune during the load succeeds',
    out.code === 0,
    `${Date.now() - t0}ms ${out.text.replace(/\s+/g, ' ').slice(0, 200)}`,
  );
}
const sampler = (async () => {
  while (!stopping && Date.now() < end) {
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
    if (Date.now() >= pruneAt && !gatewayDown) {
      pruneAt = Infinity;
      await runPrune();
    }
    await snapshotIfDue();
    const next = schedule[0];
    if (next && Date.now() >= next.at) {
      schedule.shift();
      await restart(next.signal);
    }
    await takeSample();
  }
})();
await Promise.all([...workers, sampler]);

// ---------- drain and final checks ----------
process.stdout.write('load stopped; draining\n');
const drainDeadline = Date.now() + APPROVAL_TIMEOUT_MS + 30_000;
let stuck: { id: string; status: string }[] = [];
while (Date.now() < drainDeadline) {
  stuck =
    dbQuery((db) =>
      db
        .prepare(
          "SELECT id,status FROM runs WHERE status IN ('queued','in_progress','requires_action')",
        )
        .all()
        .map((r) => ({ id: String(r.id), status: String(r.status) })),
    ) ?? [];
  if (!stuck.length) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check(
  'no run is left queued/in_progress/requires_action after draining',
  stuck.length === 0,
  JSON.stringify(stuck.slice(0, 10)),
);
await takeSample();
if (values['worker-slots'] !== undefined) {
  const observed = samples.flatMap((s) => (s.local_worker ? [s.local_worker] : []));
  check(
    'local worker advertises the requested slots and stays within capacity',
    observed.length > 0 &&
      observed.every(
        (n) => n.capacity === WORKER_SLOTS && n.active >= 0 && n.active <= WORKER_SLOTS,
      ),
    `${observed.length}/${samples.length} samples, peak active ${Math.max(0, ...observed.map((n) => n.active))}/${WORKER_SLOTS}`,
  );
}
const interruptedLeft = dbQuery((db) =>
  Number(db.prepare("SELECT count(*) AS n FROM runs WHERE status='interrupted'").get()!.n),
);
const stopMs = await stopGateway('SIGTERM');
check('final SIGTERM shutdown within 30 s', stopMs < 30_000, `${stopMs}ms`);
await new Promise((r) => setTimeout(r, 1500));
const orphans = leftoverSampleAgents();
check('no orphan agent processes after the final stop', orphans.length === 0, orphans.join(','));
for (const pid of orphans) sh('kill', ['-9', String(pid)]);
provider.server.close();
provider.server.closeAllConnections();
receiver.server.close();
receiver.server.closeAllConnections();
const integrity = dbQuery((db) =>
  String(db.prepare('PRAGMA integrity_check').get()!.integrity_check),
);
check('database integrity_check is ok', integrity === 'ok', String(integrity));

// ---------- report ----------
const finalSeg = samples.filter((s) => s.segment === segment && s.rss_mb !== null);
const trend = (key: keyof Sample, xs = finalSeg) => {
  const pts = xs
    .filter((s) => typeof s[key] === 'number')
    .map((s) => [s.t_min, s[key] as number] as [number, number]);
  return {
    start: pts[0]?.[1] ?? null,
    end: pts.at(-1)?.[1] ?? null,
    min: pts.length ? Math.min(...pts.map((p) => p[1])) : null,
    max: pts.length ? Math.max(...pts.map((p) => p[1])) : null,
    slope_per_min: slope(pts),
  };
};
// Discard the first two minutes of the final segment (warm-up) for growth judgements.
const settled = finalSeg.filter((s) => s.t_min - (finalSeg[0]?.t_min ?? 0) >= 2);
const settledMinutes = settled.length ? settled.at(-1)!.t_min - settled[0]!.t_min : 0;
const peak = (xs: Sample[]) => Math.max(...xs.map((s) => s.rss_mb ?? 0));
const firstSeg = samples.filter((s) => s.segment === 0 && s.rss_mb !== null);
const rssPeakRatio =
  segment > 0 && settled.length && firstSeg.length ? peak(settled) / peak(firstSeg) : null;
const half = samples.filter((s) => s.t_min >= MINUTES / 2);
const total = ok + unexpected;
const errorRate = total ? unexpected / total : 0;
const all = [...latencies.values()].flat();
const criteria = [
  { name: 'unexpected error rate < 0.5%', ok: errorRate < 0.005, value: errorRate },
  // RSS moves by ±25 MB within minutes (allocator and V8 space sizing), so a slope fitted over a
  // short segment mostly measures that noise. A final segment of at least 20 settled minutes is
  // judged by slope; a shorter one (the last segment of a run with restarts) by its peak against
  // the first segment's peak. Writing a heap snapshot makes the process allocate about its heap
  // size again and the allocator keeps much of it for tens of minutes, so runs that take
  // snapshots are not judged on RSS at all.
  ...(snapshotsTaken > 0
    ? [{ name: 'RSS (not judged: heap snapshots taken)', ok: true, value: null }]
    : settledMinutes >= 20
      ? [
          {
            name: 'RSS slope (final segment, >= 20 settled minutes) < 1 MB/min',
            ok: (trend('rss_mb', settled).slope_per_min ?? 0) < 1,
            value: trend('rss_mb', settled).slope_per_min,
          },
        ]
      : [
          {
            name: 'RSS peak of the final segment <= 1.25 x the first segment peak',
            ok: rssPeakRatio === null || rssPeakRatio <= 1.25,
            value: rssPeakRatio,
          },
        ]),
  {
    name: 'heap slope (final segment, settled) < 0.5 MB/min',
    ok: (trend('heap_mb', settled).slope_per_min ?? 0) < 0.5,
    value: trend('heap_mb', settled).slope_per_min,
  },
  {
    name: 'open FD slope (final segment, settled) < 1 per min',
    ok: (trend('fds', settled).slope_per_min ?? 0) < 1,
    value: trend('fds', settled).slope_per_min,
  },
  {
    name: 'child processes never exceed concurrency + 4',
    ok: samples.every((s) => (s.children ?? 0) <= CONCURRENCY + 4),
    value: Math.max(...samples.map((s) => s.children ?? 0)),
  },
  ...(RETENTION_MINUTES > 0 && MINUTES >= RETENTION_MINUTES * 3
    ? [
        {
          name: 'with retention: database+WAL size in the second half grows < 1% of its mean per minute',
          ok: (() => {
            const pts = half.map((s) => [s.t_min, s.db_mb + s.wal_mb] as [number, number]);
            const mean = pts.reduce((n, p) => n + p[1], 0) / Math.max(1, pts.length);
            return (slope(pts) ?? 0) < mean * 0.01;
          })(),
          value: slope(half.map((s) => [s.t_min, s.db_mb + s.wal_mb])),
        },
      ]
    : []),
  {
    name: 'all restart and recovery checks pass',
    ok: checks.every((c) => c.ok),
    value: checks.filter((c) => !c.ok).length,
  },
];
const report = {
  format: 'oaa.soak.v1',
  started: new Date(started).toISOString(),
  minutes: MINUTES,
  concurrency: CONCURRENCY,
  worker_slots: WORKER_SLOTS,
  restarts_enabled: !values['no-restarts'],
  retention_minutes: RETENTION_MINUTES,
  node: process.version,
  platform: `${process.platform} ${os.release()} ${os.arch()}`,
  requests: { ok, unexpected, restart_window: restartWindow, throttled, error_rate: errorRate },
  webhook_receiver: webhookStats,
  latency_ms: {
    all: { p50: quantile(all, 0.5), p95: quantile(all, 0.95), p99: quantile(all, 0.99) },
    ...Object.fromEntries(
      [...latencies].map(([op, xs]) => [
        op,
        { n: xs.length, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), p99: quantile(xs, 0.99) },
      ]),
    ),
  },
  trends_final_segment: Object.fromEntries(
    (
      [
        'rss_mb',
        'heap_mb',
        'heap_total_mb',
        'external_mb',
        'handles',
        'fds',
        'children',
        'db_mb',
        'wal_mb',
        'data_mb',
        'runs',
        'unfinished',
      ] as const
    ).map((k) => [k, trend(k)]),
  ),
  trends_whole_run: Object.fromEntries(
    (['db_mb', 'wal_mb', 'data_mb', 'runs'] as const).map((k) => [k, trend(k, samples)]),
  ),
  interrupted_runs_left: interruptedLeft,
  checks,
  criteria,
  pass: criteria.every((c) => c.ok),
  failures_by_kind: Object.fromEntries([...failureCounts].sort((a, b) => b[1] - a[1])),
  failures,
  samples,
  data_dir: run,
};
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
const lines = [
  `Soak ${report.pass ? 'PASSED' : 'FAILED'}: ${MINUTES} min, concurrency ${CONCURRENCY}, retention ${RETENTION_MINUTES || 'off'} min`,
  `requests ok=${ok} unexpected=${unexpected} (${(errorRate * 100).toFixed(3)}%) restart-window=${restartWindow} throttled=${throttled}`,
  `latency all p50/p95/p99 = ${report.latency_ms.all.p50?.toFixed(0)}/${report.latency_ms.all.p95?.toFixed(0)}/${report.latency_ms.all.p99?.toFixed(0)} ms`,
  ...Object.entries(report.trends_final_segment).map(
    ([k, v]) =>
      `${k}: ${v.start?.toFixed(1)} -> ${v.end?.toFixed(1)} (min ${v.min?.toFixed(1)}, max ${v.max?.toFixed(1)}, slope ${v.slope_per_min?.toFixed(3)}/min)`,
  ),
  `interrupted runs left (need explicit resume): ${interruptedLeft}`,
  ...criteria.map(
    (c) =>
      `${c.ok ? 'PASS' : 'FAIL'} ${c.name} (${typeof c.value === 'number' ? c.value.toFixed(4) : c.value === null ? 'not judged: final segment too short or heap snapshots taken' : String(c.value)})`,
  ),
  ...checks.filter((c) => !c.ok).map((c) => `FAILED CHECK ${c.name} ${c.detail}`),
  ...[...failureCounts].slice(0, 15).map(([k, n]) => `  ${n} x ${k}`),
];
await writeFile(path.join(root, 'summary.txt'), lines.join('\n') + '\n');
process.stdout.write('\n' + lines.join('\n') + '\n');
if (!values.keep) await rm(run, { recursive: true, force: true });
process.exitCode = report.pass ? 0 : 1;
