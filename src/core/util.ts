import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveWindowsCommand } from './which.js';
import { restrictToOwner } from './win-acl.js';
import { windowsUnsafeSegment } from './win-path.js';
import { constants, accessSync, statSync } from 'node:fs';
import { mkdir, lstat, realpath, readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { bi, pick, type LocalText } from './locale.js';

/**
 * `message` 可以是普通字符串，也可以是 `bi(zh, en)` 双语文案：`Error.message` 取进程默认语言那边，
 * `text` 保留两边，HTTP 错误响应按请求的语言再选（gateway/compat-errors.ts `localizedMessage`）。
 */
export class Fault extends Error {
  public readonly text?: LocalText;
  constructor(
    public code: string,
    message: string | LocalText,
    public status = 400,
    public uncertain = false,
  ) {
    super(pick(message));
    if (typeof message !== 'string') this.text = message;
  }
}

/**
 * 新人最常碰到的几个错误：文案直接说出下一步。四种入口的错误体形状不变，只换 message。
 * 不透露调用方无权访问的智能体是否存在：受限密钥一律走 `scopeDenied`。
 */
export const KEY_HELP = bi(
  '密钥由网关管理员在控制台「API 密钥」页或用 `oaa key create` 生成；在本机试用可以运行 `oaa quickstart`。',
  'The gateway admin creates keys on the console "API keys" page or with `oaa key create`; to try it on this machine, run `oaa quickstart`.',
);
export const missingKey = () =>
  new Fault(
    'unauthorized',
    bi(
      `缺少 API 密钥：放在 Authorization: Bearer（OpenAI）、x-api-key（Claude）或 x-goog-api-key（Gemini）请求头里。${KEY_HELP.zh}`,
      `An API key is required: send it as Authorization: Bearer (OpenAI), x-api-key (Claude), or x-goog-api-key (Gemini). ${KEY_HELP.en}`,
    ),
    401,
  );
export const invalidKey = () =>
  new Fault(
    'unauthorized',
    bi(`API 密钥无效或已吊销。${KEY_HELP.zh}`, `Invalid or revoked API key. ${KEY_HELP.en}`),
    401,
  );
export const scopeDenied = () =>
  new Fault(
    'scope_denied',
    bi(
      '这把 API 密钥无权调用该智能体或执行这项操作。model 要填智能体的调用名：用同一把密钥请求 GET /v1/models 查看它能调用哪些。',
      'API key does not grant this agent or operation. `model` takes an agent name: request GET /v1/models with the same key to list the agents it can call.',
    ),
    403,
  );
export const noAgent = () =>
  new Fault(
    'agent_not_found',
    bi(
      '智能体或版本不存在。用 GET /v1/models 查看可调用的智能体名称。',
      'Agent or version not found. List callable agent names with GET /v1/models.',
    ),
    404,
  );
/**
 * 只终结运行、不决定 HTTP 状态的错误（轮次上限、token 预算、输出截断）：run-state 把它记成运行的
 * 错误码（状态 incomplete），各入口按运行的终态作答。错误目录里这类码的 `status` 是 `null`；
 * 构造时不写状态，`status` 固定为 500，只在它意外漏到 HTTP 错误处理时生效（那是缺陷）。
 */
export class RunErrorFault extends Fault {
  constructor(code: string, message: string | LocalText) {
    super(code, message, 500);
  }
}
/** 可重试的拒绝，带服务端算出的建议等待秒数（`Retry-After`）。 */
export class RetryLaterFault extends Fault {
  constructor(
    code: string,
    message: string | LocalText,
    status: number,
    public retryAfterSeconds: number,
  ) {
    super(code, message, status);
  }
}
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/**
 * Executable checks are hot: every placement decision re-reads each enabled backend's
 * advertisement. Results are memoized briefly (file metadata only); explicit owner actions such
 * as enabling a backend pass `fresh` to observe an install or removal immediately.
 */
export const EXECUTABLE_CHECK_TTL_MS = 2_000;
const executableChecks = new Map<string, { at: number; ok: boolean }>();
export function forgetExecutableChecks(): void {
  executableChecks.clear();
}
export function executableExists(command: string, options: { fresh?: boolean } = {}): boolean {
  const pathLike = path.isAbsolute(command) || command.includes('/') || command.includes('\\');
  const key = pathLike
    ? command
    : `${command}\0${process.env.PATH ?? ''}\0${process.env.PATHEXT ?? ''}`;
  const now = Date.now();
  const cached = executableChecks.get(key);
  if (!options.fresh && cached && now - cached.at < EXECUTABLE_CHECK_TTL_MS) return cached.ok;
  const ok = probeExecutable(command, pathLike);
  executableChecks.delete(key);
  executableChecks.set(key, { at: now, ok });
  if (executableChecks.size > 512) executableChecks.delete(executableChecks.keys().next().value!);
  return ok;
}
function probeExecutable(command: string, pathLike: boolean): boolean {
  // Windows: PATHEXT applies to bare names and extension-less paths alike (`codex` -> `codex.cmd`).
  if (process.platform === 'win32') return resolveWindowsCommand(command) !== undefined;
  const candidates = pathLike
    ? [command]
    : (process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
}
export const abortError = () => new Fault('cancelled', 'The operation was cancelled.', 409);
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export function boundedJson(value: unknown, limit = 1_048_576): string {
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > limit)
    throw new Fault('payload_too_large', 'Payload exceeds the configured byte limit.', 413);
  return result;
}
export function relativeName(name: string): string {
  if (
    !name ||
    name.length > 240 ||
    name.includes('\\') ||
    /[\x00-\x1f]/.test(name) ||
    path.posix.isAbsolute(name) ||
    name.split('/').some((p) => !p || p === '.' || p === '..') ||
    (process.platform === 'win32' && name.split('/').some(windowsUnsafeSegment))
  ) {
    throw new Fault('invalid_path', 'Expected a bounded relative path without traversal.');
  }
  return name;
}
export async function safePath(root: string, name: string, createParents = false): Promise<string> {
  relativeName(name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const base = await realpath(root);
  const pieces = name.split('/');
  let current = base;
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (i < pieces.length - 1 && !stat.isDirectory()))
        throw new Fault('invalid_path', 'Symlinks and non-directory parents are not allowed.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (i < pieces.length - 1 && createParents) await mkdir(current, { mode: 0o700 });
    }
  }
  return current;
}
export async function writePrivate(
  root: string,
  name: string,
  data: Buffer | string,
  exclusive = false,
): Promise<void> {
  const target = await safePath(root, name, true);
  const handle = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (exclusive ? constants.O_EXCL : constants.O_TRUNC),
    0o600,
  );
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  // Mode bits mean nothing on Windows; narrow the ACL to the current user (best effort).
  if (process.platform === 'win32') await restrictToOwner(target);
}
export async function readBounded(
  root: string,
  name: string,
  max = 8 * 1024 * 1024,
): Promise<Buffer> {
  const target = await safePath(root, name);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.size > max)
      throw new Fault('invalid_file', 'Not a regular file, or file exceeds size limit.', 413);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function secret(ref: {
  token?: string;
  tokenEnv?: string;
  tokenFile?: string;
}): Promise<string> {
  const value =
    ref.token ??
    (ref.tokenEnv ? process.env[ref.tokenEnv] : undefined) ??
    (ref.tokenFile ? (await readFile(ref.tokenFile, 'utf8')).trim() : undefined);
  if (!value || value.length < 24)
    throw new Fault(
      'invalid_credential',
      'Service and node tokens must contain at least 24 characters.',
      500,
    );
  return value;
}
export const redact = (message: string) =>
  message
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.\-]{8,}|\boaa_[A-Za-z0-9_-]{32,}/gi, '[REDACTED]')
    // Node and portal-session tokens, and common upstream formats (Google, GitHub, Slack, AWS).
    .replace(
      /\b(?:oa[nsw]_[A-Za-z0-9_-]{32,}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})/g,
      '[REDACTED]',
    )
    .replace(/(api[_-]?key|token|password|secret)(["'\s:=]+)[^\s,;}]+/gi, '$1$2[REDACTED]');
export function faultOf(error: unknown): Fault {
  if (error instanceof Fault) return error;
  return new Fault(
    'execution_failed',
    redact(error instanceof Error ? error.message : 'Execution failed.'),
    500,
  );
}
/**
 * Like `AbortSignal.timeout(ms)`, but `clear()` cancels the timer. A pending `AbortSignal.timeout`
 * stays referenced (with every `AbortSignal.any` built on it) until it fires, so a long deadline
 * on short work would otherwise hold memory for the whole deadline.
 */
export function deadlineTimer(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    ms,
  );
  timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
/**
 * Delay for an unref'd timer that is often cleared and re-armed, rounded up to two significant
 * digits (at most about 10% late). Node keeps one internal timer list per distinct duration, and
 * clearing an unref'd timer leaves its emptied list behind until that duration has elapsed, so
 * arbitrary long durations (`deadline - Date.now()`) piled up one list per re-arm under load;
 * rounded durations reuse a small set of lists.
 */
export function coarseDelay(ms: number): number {
  if (!(ms > 1)) return 1;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(ms)) - 1);
  return Math.ceil(ms / step) * step;
}
