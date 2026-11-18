import { clip, errorCode, type AgentKind, type Ctx, type Gateway } from './verify-harness.js';

/** What every scenario needs: where the isolated gateway listens, the caller key, and run internals. */
export type Env = {
  kind: AgentKind;
  agentId: string;
  base: string;
  key: string;
  gateway: Gateway;
  /** The session working directory of a run (under the verification work directory). */
  workspaceOf: (runId: string) => string | undefined;
  sessionOf: (runId: string) => string | undefined;
  /** What docs/adapters.md says for this kind of agent; undefined when the docs say nothing. */
  expect: Expectations | undefined;
};

/** The capability matrix in docs/adapters.md; observations that differ are listed as mismatches. */
export type Expectations = {
  streaming: 'token' | 'message';
  usage: boolean;
  bridge: boolean;
  resume: boolean;
  approvals: boolean;
};
export const EXPECT: Partial<Record<AgentKind, Expectations>> = {
  claude: { streaming: 'token', usage: true, bridge: true, resume: true, approvals: true },
  codex: { streaming: 'token', usage: true, bridge: true, resume: true, approvals: true },
  // Antigravity: approvals are not bridged (the agent itself refuses: permission_denied); usage is first-turn only; caller tool bridge is enabled.
  antigravity: { streaming: 'token', usage: true, bridge: true, resume: true, approvals: false },
  fixture: { streaming: 'token', usage: true, bridge: true, resume: true, approvals: true },
};

/** The prompt every echo scenario sends: the agent must answer with exactly this token. */
export const ask = (token: string) => `只回复这一串字符：${token}，不要加任何其他内容。`;

/** Records an HTTP error answer (status, code, message) as an observation and returns status and code. */
export function recordError(ctx: Ctx, status: number, body: unknown) {
  const code = errorCode(body);
  ctx.observe('http_error', {
    status,
    code,
    message: clip(
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error?: { message?: unknown } }).error?.message ?? '')
        : String(body),
      300,
    ),
  });
  return { status, code };
}

/** Numeric fields of a usage object (any provider shape), or null. */
export const usageOf = (u: unknown) =>
  u && typeof u === 'object'
    ? Object.fromEntries(
        Object.entries(u as Record<string, unknown>).filter(([, v]) => typeof v === 'number'),
      )
    : null;

/** True when a usage object reports at least one non-zero token count. */
export const reportsUsage = (u: unknown): boolean => {
  const numbers = usageOf(u);
  return !!numbers && Object.values(numbers).some((n) => (n as number) > 0);
};

/** The agent under test. `adapter` is a raw adapter entry (ACP command and arguments, usually). */
export type VerifyTarget = {
  kind: AgentKind;
  /** Display name: `codex`, `claude`, `antigravity`, or `adapter/NAME`. */
  label: string;
  /** Engine for publish-native: `codex`, `claude`, `antigravity` or `adapter/NAME`. */
  engine: string;
  native?: { engine: 'codex' | 'claude' | 'antigravity'; executable: string };
  adapter?: { name: string; config: Record<string, unknown> };
};
