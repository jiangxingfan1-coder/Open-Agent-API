import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { bi, type LocalText } from '../core/locale.js';

// Shared parts of the end-to-end agent verification (`oaa verify`, examples/live-agents-acceptance.ts):
// HTTP calls, run waiting and cancelling, child-process PID tracking, secret scanning and the scenario
// runner (each scenario has its own try/catch, a hard timeout, and is cancelled on timeout or Ctrl+C).
// Nothing here calls an agent by itself.

/** `acp` is any other ACP/adapter agent; `fixture` is the repository's offline ACP stand-in. */
export type AgentKind = 'claude' | 'codex' | 'antigravity' | 'acp' | 'fixture';
export type Status = 'pass' | 'fail' | 'unsupported' | 'skipped';
export type Text = string | LocalText;
/** A plain string reads the same in both languages (identifiers, error codes). */
export const both = (text: Text): LocalText => (typeof text === 'string' ? bi(text, text) : text);
export type ScenarioResult = {
  /** Legacy id (`S1`..`S13`) kept for examples/live-agents-acceptance.ts and issue reports. */
  id: string;
  /** Stable short name (`chat`, `approvals`, ...) used by `oaa verify --scenarios`. */
  key: string;
  title: LocalText;
  status: Status;
  elapsed_ms: number;
  /** Agent invocations this scenario triggered (with the fixture: the offline stand-in). */
  agent_invocations: number;
  observations: Record<string, unknown>;
  checks: { name: LocalText; ok: boolean; detail?: unknown }[];
  run_ids: string[];
  error?: { code: string; message: LocalText };
  doc_mismatches: LocalText[];
};

export const nonce = (prefix: string) =>
  `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const clip = (text: unknown, n = 300) =>
  typeof text === 'string' ? text.slice(0, n) : text === undefined ? undefined : text;

/** Every secret value this process holds: searched for in reports before they are written and in the cleanup scan. */
export class Secrets {
  private readonly values = new Set<string>();
  add(value: string | undefined) {
    if (value && value.length >= 8) this.values.add(value);
  }
  list() {
    return [...this.values];
  }
  redact(text: string) {
    let out = text;
    for (const v of this.values) out = out.split(v).join('[REDACTED]');
    return out.replace(/sk-oaa-[A-Za-z0-9_-]{8,}/g, 'sk-oaa-[REDACTED]');
  }
  redactText(text: LocalText): LocalText {
    return bi(this.redact(text.zh), this.redact(text.en));
  }
}

export type Http = {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
};
export async function http(
  base: string,
  method: string,
  url: string,
  token: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Http> {
  const response = await fetch(base + url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: response.status, headers: response.headers, body: parsed, text };
}
export const get = (value: unknown, ...keys: (string | number)[]): unknown =>
  keys.reduce<unknown>(
    (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
    value,
  );
export const errorCode = (body: unknown): string | undefined => {
  const e = get(body, 'error');
  const code = get(e, 'code');
  if (typeof code === 'string') return code;
  const reason = get(e, 'details', 0, 'reason');
  return typeof reason === 'string' ? reason : undefined;
};

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'expired']);
export type RunView = { status: string; error: { code?: string; message?: string } | null };
export class Gateway {
  /** Aborted on Ctrl+C: waiting loops stop at once instead of polling a gateway that is closing. */
  signal: AbortSignal | undefined;
  constructor(
    readonly base: string,
    readonly admin: string,
  ) {}
  run(id: string): Promise<RunView & { raw: unknown }> {
    return http(this.base, 'GET', `/v1/runs/${encodeURIComponent(id)}`, this.admin).then((r) => ({
      status: String(get(r.body, 'status') ?? `http_${r.status}`),
      error: (get(r.body, 'error') as RunView['error']) ?? null,
      raw: r.body,
    }));
  }
  /** Waits for a terminal status (or a pending approval with `stopAtAction`); throws after `ms`. */
  async wait(id: string, ms: number, stopAtAction = false): Promise<RunView> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (this.signal?.aborted)
        throw Object.assign(new Error('interrupted'), { code: 'interrupted' });
      const run = await this.run(id);
      if (TERMINAL.has(run.status) || (stopAtAction && run.status === 'requires_action'))
        return run;
      const left = deadline - Date.now();
      if (left <= 0)
        throw Object.assign(new Error(`run ${id} still ${run.status}`), { code: 'wait_timeout' });
      await http(
        this.base,
        'GET',
        `/v1/runs/${encodeURIComponent(id)}/wait?timeout_ms=${Math.min(left, stopAtAction ? 1000 : 20_000)}`,
        this.admin,
      );
    }
  }
  async cancel(id: string) {
    return http(
      this.base,
      'POST',
      `/v1/responses/${encodeURIComponent(id)}/cancel`,
      this.admin,
      {},
    );
  }
  async pendingActions(id: string): Promise<{ id: string; kind: string; detail: unknown }[]> {
    const r = await http(
      this.base,
      'GET',
      `/v1/runs/${encodeURIComponent(id)}/actions`,
      this.admin,
    );
    return (get(r.body, 'data') as { id: string; kind: string; detail: unknown }[]) ?? [];
  }
  async decide(id: string, action: string, decision: 'approve' | 'deny') {
    return http(
      this.base,
      'POST',
      `/v1/runs/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
      this.admin,
      { decision },
    );
  }
  isTerminal(status: string) {
    return TERMINAL.has(status);
  }
}

/** All descendants of this process (read-only `ps`): PID and executable name only, no arguments or environment. */
export async function descendants(): Promise<Map<number, string>> {
  // Windows: no POSIX `ps` (see canTrackProcesses); agent trees are ended by taskkill instead.
  if (process.platform === 'win32') return new Map();
  const out = await new Promise<string>((resolve) =>
    execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], { maxBuffer: 16 << 20 }, (_e, stdout) =>
      resolve(String(stdout ?? '')),
    ),
  );
  const rows = out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), comm: path.basename(m[3]!.trim()) }));
  const result = new Map<number, string>();
  const frontier = [process.pid];
  while (frontier.length) {
    const parent = frontier.pop()!;
    for (const r of rows)
      if (r.ppid === parent && !result.has(r.pid) && r.comm !== 'ps') {
        result.set(r.pid, r.comm);
        frontier.push(r.pid);
      }
  }
  return result;
}
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Samples the descendants every 250 ms and remembers every PID seen (with the scenario it first appeared in). */
export class PidTracker {
  readonly seen = new Map<number, { comm: string; scenario: string }>();
  scenario = '-';
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  start() {
    this.timer = setInterval(() => void this.sample(), 250);
  }
  async sample() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const [pid, comm] of await descendants())
        if (!this.seen.has(pid)) this.seen.set(pid, { comm, scenario: this.scenario });
    } finally {
      this.busy = false;
    }
  }
  of(scenario: string) {
    return [...this.seen]
      .filter(([, v]) => v.scenario === scenario)
      .map(([pid, v]) => ({ pid, ...v }));
  }
  stop() {
    clearInterval(this.timer);
  }
}
export async function waitGone(pids: number[], ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && pids.some(alive)) await sleep(200);
  return pids.filter(alive);
}
/** `ps` is how descendants are listed; without it (Windows) process checks are skipped and noted. */
export const canTrackProcesses = process.platform !== 'win32';

/**
 * Last resort after a run or an interrupt: stop agent processes that are still our descendants
 * (SIGTERM, then SIGKILL). Only PIDs that `ps` still lists below this process are touched.
 */
export async function terminateLeftovers(pids: number[]): Promise<number[]> {
  const current = await descendants();
  const targets = pids.filter((pid) => alive(pid) && current.has(pid));
  for (const pid of targets)
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  const stubborn = await waitGone(targets, 2000);
  for (const pid of stubborn)
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  return targets;
}

/** Reads every file under the roots (SQLite and WAL included) and searches the raw bytes for each secret. */
export async function scanForSecrets(roots: string[], secrets: string[]) {
  const hits: { file: string; secret_index: number }[] = [];
  let files = 0;
  const visit = async (p: string): Promise<void> => {
    let s;
    try {
      s = await stat(p);
    } catch {
      return;
    }
    if (s.isDirectory()) {
      for (const name of await readdir(p)) await visit(path.join(p, name));
      return;
    }
    if (!s.isFile() || s.size > 256 << 20) return;
    files++;
    const bytes = await readFile(p);
    secrets.forEach((secret, i) => {
      if (bytes.includes(Buffer.from(secret))) hits.push({ file: p, secret_index: i });
    });
  };
  for (const r of roots) await visit(r);
  return { files, hits };
}

export type Ctx = {
  result: ScenarioResult;
  signal: AbortSignal;
  /** Remember a run this scenario created; unfinished ones are cancelled when the scenario ends. */
  track: (runId: string | null | undefined) => void;
  check: (name: Text, ok: boolean, detail?: unknown) => boolean;
  observe: (key: string, value: unknown) => void;
  unsupported: (code: string, message: Text) => void;
  mismatch: (text: Text) => void;
  invoked: (n?: number) => void;
};

export type ScenarioHead = { id: string; key: string; title: LocalText };

export async function runScenario(
  head: ScenarioHead,
  timeoutMs: number,
  gateway: Gateway,
  secrets: Secrets,
  pids: PidTracker,
  body: (ctx: Ctx) => Promise<void>,
  interrupt?: AbortSignal,
): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    ...head,
    status: 'pass',
    elapsed_ms: 0,
    agent_invocations: 0,
    observations: {},
    checks: [],
    run_ids: [],
    doc_mismatches: [],
  };
  const controller = new AbortController();
  const stopOnInterrupt = () => controller.abort();
  interrupt?.addEventListener('abort', stopOnInterrupt, { once: true });
  let unsupported = false;
  const clipText = (text: LocalText) =>
    bi(clip(secrets.redact(text.zh), 500) as string, clip(secrets.redact(text.en), 500) as string);
  const ctx: Ctx = {
    result,
    signal: controller.signal,
    track: (runId) => {
      if (runId && !result.run_ids.includes(runId)) result.run_ids.push(runId);
    },
    check: (name, ok, detail) => {
      result.checks.push({ name: both(name), ok, ...(detail !== undefined ? { detail } : {}) });
      return ok;
    },
    observe: (key, value) => {
      result.observations[key] = typeof value === 'string' ? clip(value) : value;
    },
    unsupported: (code, message) => {
      unsupported = true;
      result.error = { code, message: clipText(both(message)) };
    },
    mismatch: (text) => result.doc_mismatches.push(both(text)),
    invoked: (n = 1) => {
      result.agent_invocations += n;
    },
  };
  pids.scenario = head.id;
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      body(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            Object.assign(new Error(`scenario exceeded its hard timeout of ${timeoutMs} ms`), {
              code: 'scenario_timeout',
            }),
          );
        }, timeoutMs);
      }),
      new Promise<never>((_, reject) => {
        const stop = () => reject(Object.assign(new Error('interrupted'), { code: 'interrupted' }));
        if (interrupt?.aborted) stop();
        else interrupt?.addEventListener('abort', stop, { once: true });
      }),
    ]);
    if (result.checks.some((c) => !c.ok)) result.status = 'fail';
    else if (unsupported) result.status = 'unsupported';
  } catch (error) {
    const e = error as { code?: unknown; status?: unknown; message?: unknown };
    if (interrupt?.aborted) {
      result.status = 'skipped';
      result.error = {
        code: 'interrupted',
        message: bi('收到 Ctrl+C，场景被中断。', 'Interrupted by Ctrl+C.'),
      };
    } else {
      result.status = 'fail';
      result.error = {
        code: typeof e.code === 'string' ? e.code : e.status ? `http_${e.status}` : 'exception',
        message: clipText(both(String(e.message ?? error))),
      };
    }
  } finally {
    clearTimeout(timer);
    interrupt?.removeEventListener('abort', stopOnInterrupt);
    controller.abort();
    // Cleanup: every run this scenario left unfinished is cancelled so it stops consuming.
    for (const runId of result.run_ids) {
      try {
        const run = await gateway.run(runId);
        if (!gateway.isTerminal(run.status)) {
          await gateway.cancel(runId);
          result.checks.push({
            name: bi(
              `收尾取消未结束的运行 ${runId}`,
              `Cancelled the unfinished run ${runId} at the end`,
            ),
            ok: true,
            detail: run.status,
          });
        }
      } catch {}
    }
    await pids.sample();
    result.elapsed_ms = Math.round(performance.now() - start);
  }
  return result;
}
