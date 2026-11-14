import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// 「真实智能体端到端验证」的公共部件：HTTP 调用、运行等待与取消、子进程 PID 记录、秘密扫描、
// 场景执行器（每个场景独立 try/catch、硬超时、超时即取消）。不发起任何智能体调用。

export type AgentKind = 'claude' | 'codex' | 'antigravity' | 'fixture';
export type Status = 'pass' | 'fail' | 'unsupported' | 'skipped';
export type ScenarioResult = {
  id: string;
  title: string;
  status: Status;
  elapsed_ms: number;
  /** 本场景预计/实际触发的智能体调用次数（fixture 下是假智能体）。 */
  agent_invocations: number;
  observations: Record<string, unknown>;
  checks: { name: string; ok: boolean; detail?: unknown }[];
  run_ids: string[];
  error?: { code: string; message: string };
  doc_mismatches: string[];
};

export const nonce = (prefix: string) =>
  `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const clip = (text: unknown, n = 300) =>
  typeof text === 'string' ? text.slice(0, n) : text === undefined ? undefined : text;

/** 进程里持有的全部秘密值：报告写盘前与 S12 扫描时逐个做字符串搜索。 */
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
  /** 等运行进入终止状态（或待审批，若 `stopAtAction`）；超过 `ms` 抛错。 */
  async wait(id: string, ms: number, stopAtAction = false): Promise<RunView> {
    const deadline = Date.now() + ms;
    for (;;) {
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

/** 本进程的全部后代进程（只读 `ps`）。只记 PID 与可执行文件名，不记参数与环境。 */
export async function descendants(): Promise<Map<number, string>> {
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

/** 后台每 250 毫秒取一次后代进程快照，记下所有出现过的 PID（附带首次出现时所属场景）。 */
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

/** 递归读目录下全部文件（含 SQLite 与 WAL），按原始字节查找每个秘密值。 */
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
  /** 记下本场景产生的运行；超时或出错时脚本会取消其中未结束的运行。 */
  track: (runId: string | null | undefined) => void;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  observe: (key: string, value: unknown) => void;
  unsupported: (code: string, message: string) => void;
  mismatch: (text: string) => void;
  invoked: (n?: number) => void;
};

export async function runScenario(
  id: string,
  title: string,
  timeoutMs: number,
  gateway: Gateway,
  secrets: Secrets,
  pids: PidTracker,
  body: (ctx: Ctx) => Promise<void>,
): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    id,
    title,
    status: 'pass',
    elapsed_ms: 0,
    agent_invocations: 0,
    observations: {},
    checks: [],
    run_ids: [],
    doc_mismatches: [],
  };
  const controller = new AbortController();
  let unsupported = false;
  const ctx: Ctx = {
    result,
    signal: controller.signal,
    track: (runId) => {
      if (runId && !result.run_ids.includes(runId)) result.run_ids.push(runId);
    },
    check: (name, ok, detail) => {
      result.checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
      return ok;
    },
    observe: (key, value) => {
      result.observations[key] = typeof value === 'string' ? clip(value) : value;
    },
    unsupported: (code, message) => {
      unsupported = true;
      result.error = { code, message: clip(secrets.redact(message), 500) as string };
    },
    mismatch: (text) => result.doc_mismatches.push(text),
    invoked: (n = 1) => {
      result.agent_invocations += n;
    },
  };
  pids.scenario = id;
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      body(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            Object.assign(new Error(`场景超过 ${timeoutMs} 毫秒的硬超时`), {
              code: 'scenario_timeout',
            }),
          );
        }, timeoutMs);
      }),
    ]);
    if (result.checks.some((c) => !c.ok)) result.status = 'fail';
    else if (unsupported) result.status = 'unsupported';
  } catch (error) {
    result.status = 'fail';
    const e = error as { code?: unknown; status?: unknown; message?: unknown };
    result.error = {
      code: typeof e.code === 'string' ? e.code : e.status ? `http_${e.status}` : 'exception',
      message: clip(secrets.redact(String(e.message ?? error)), 500) as string,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    // 收尾：本场景留下的未结束运行一律取消，不让它继续消耗。
    for (const runId of result.run_ids) {
      try {
        const run = await gateway.run(runId);
        if (!gateway.isTerminal(run.status)) {
          await gateway.cancel(runId);
          result.checks.push({
            name: `收尾取消未结束的运行 ${runId}`,
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
