/**
 * 开发者平台的线上形状：门面返回 camelCase，这里逐项映射成 docs/platform.md「Endpoint overview」里的蛇形字段。
 * 刻意不用通用的驼峰转蛇形：`quota`、`conversion` 这类对象要原样带出。
 */
import type { FastifyRequest } from 'fastify';
import type { AuditLog } from '../store/audit.js';
import type {
  AccountView,
  AdminAccountView,
  AdminUsageView,
  CodeView,
  LedgerEntryView,
  ListedAgentView,
  ListingView,
  PlatformSummary,
  PortalKeyView,
  Price,
  RunDetailView,
  RunItemView,
  SessionView,
  UsageView,
} from './platform-types.js';
import type { Platform } from './platform.js';

/** What the platform routes need from the gateway (closures over `server.ts` state). */
export type PlatformRouteDeps = {
  platform: Platform;
  audit: AuditLog;
  clientIp: (req: FastifyRequest) => string | undefined;
  publicBaseUrl: (req: FastifyRequest) => string;
};

export const wireAccount = (a: AccountView) => ({
  id: a.id,
  email: a.email,
  name: a.name,
  status: a.status,
  balance: a.balance,
  created_at: a.createdAt,
});
export const wireSession = (s: SessionView) => ({ token: s.token, expires_at: s.expiresAt });
export const wirePrice = (p: Price) => ({ per_run: p.perRun, per_1k_tokens: p.per1kTokens });
export const wirePortalKey = (k: PortalKeyView) => ({
  id: k.id,
  name: k.name,
  created_at: k.createdAt,
  revoked: k.revoked,
  quota: k.quota,
  usage: {
    used_tokens: k.usage.usedTokens,
    used_runs: k.usage.usedRuns,
    active_runs: k.usage.activeRuns,
  },
});
export const wireListedAgent = (a: ListedAgentView) => ({
  id: a.id,
  title: a.title,
  summary: a.summary,
  tags: a.tags,
  description: a.description,
  kind: a.kind,
  models: a.models,
  price: wirePrice(a.price),
  updated_at: a.updatedAt,
  ...(a.conversion ? { conversion: a.conversion } : {}),
});
export const wireListing = (l: ListingView) => ({
  agent_id: l.agentId,
  title: l.title,
  summary: l.summary,
  tags: l.tags,
  price: wirePrice(l.price),
  enabled: l.enabled,
  updated_at: l.updatedAt,
  agent_exists: l.agentExists,
});
export const wireEntry = (e: LedgerEntryView) => ({
  id: e.id,
  kind: e.kind,
  amount: e.amount,
  balance_after: e.balanceAfter,
  agent: e.agent,
  run_id: e.runId,
  tokens: e.tokens,
  status: e.status,
  note: e.note,
  created_at: e.createdAt,
  // Only credits posted with a reference carry it, so 0.4.0 entries keep their exact shape.
  ...(e.reference !== null ? { reference: e.reference } : {}),
});
export const wireRunItem = (r: RunItemView) => ({
  id: r.id,
  agent: r.agent,
  status: r.status,
  tokens: r.tokens,
  charge: r.charge,
  created_at: r.createdAt,
});
/** `usage`, `error` and `timeline` travel as stored / computed (no renaming). */
export const wireRunDetail = (r: RunDetailView) => ({
  id: r.id,
  agent: r.agent,
  status: r.status,
  created_at: r.createdAt,
  completed_at: r.completedAt,
  usage: r.usage,
  error: r.error,
  charge: r.charge,
  price: wirePrice(r.price),
  output_text: r.outputText,
  timeline: r.timeline,
});
export const wireCode = (c: CodeView) => ({
  id: c.id,
  kind: c.kind,
  credits: c.credits,
  max_uses: c.maxUses,
  used: c.used,
  expires_at: c.expiresAt,
  note: c.note,
  revoked: c.revoked,
  created_at: c.createdAt,
});
export const wireAdminAccount = (a: AdminAccountView) => ({
  ...wireAccount(a),
  keys: a.keys,
  runs: a.runs,
  spent: a.spent,
  last_active_at: a.lastActiveAt,
});
const bucket = (b: { runs: number; tokens: number; spent: number }) => ({
  runs: b.runs,
  tokens: b.tokens,
  spent: b.spent,
});
export const wireUsage = (u: UsageView) => ({
  balance: u.balance,
  totals: bucket(u.totals),
  daily: u.daily.map((d) => ({ date: d.date, ...bucket(d) })),
  by_agent: u.byAgent.map((a) => ({ agent: a.agent, ...bucket(a) })),
});
export const wireAdminUsage = (u: AdminUsageView) => ({
  ...wireUsage(u),
  by_account: u.byAccount.map((a) => ({
    account_id: a.accountId,
    email: a.email,
    ...bucket(a),
  })),
});
export const wireSummary = (s: PlatformSummary) => ({
  site_name: s.siteName,
  registration: s.registration,
  accounts: s.accounts,
  balance_total: s.balanceTotal,
  spent_total: s.spentTotal,
  runs_total: s.runsTotal,
  tokens_total: s.tokensTotal,
  listings: s.listings,
});
/** `{ data, next_cursor }` for every paged list. */
export const wirePage = <T, U>(
  page: { data: T[]; nextCursor: number | null },
  map: (v: T) => U,
) => ({
  data: page.data.map(map),
  next_cursor: page.nextCursor,
});
