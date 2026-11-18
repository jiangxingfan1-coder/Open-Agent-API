/**
 * 开发者平台门面的出入参类型（camelCase）；蛇形字段由 platform-wire.ts 映射。
 */
import type { Usage } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import type { AccountRecord, AccountStatus } from './platform-accounts.js';
import type { LedgerRecord, UsageBucket } from './platform-billing.js';
import type { CodeKind, CodeRecord } from './platform-codes.js';
import { toPoints, type PlatformConfig } from './platform-db.js';
import type { ListingAccess } from './platform-access.js';
import type { Timeline } from './timeline.js';

export type Price = { perRun: number; per1kTokens: number };
export type AccountView = {
  id: string;
  email: string;
  name: string;
  status: AccountStatus;
  balance: number;
  createdAt: number;
};
export type SessionView = { token: string; expiresAt: number };
export type PortalKeyView = {
  id: string;
  name: string;
  createdAt: number;
  revoked: boolean;
  quota: PlatformConfig['keyQuota'];
  usage: { usedTokens: number; usedRuns: number; activeRuns: number };
};
export type ListedAgentView = {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  description: string;
  kind: 'kernel' | 'external';
  models: string[];
  price: Price;
  updatedAt: number;
  conversion?: Record<string, unknown>;
};
export type ListingView = {
  agentId: string;
  title: string;
  summary: string;
  tags: string[];
  price: Price;
  enabled: boolean;
  /** The owner's per-listing switch: account keys may run this agent with host authority. */
  hostExecution: boolean;
  updatedAt: number;
  agentExists: boolean;
} & ListingAccess;
export type LedgerEntryView = Omit<LedgerRecord, 'amount' | 'balanceAfter'> & {
  amount: number;
  balanceAfter: number;
};
export type UsageView = {
  balance: number;
  totals: UsageBucket;
  daily: ({ date: string } & UsageBucket)[];
  byAgent: ({ agent: string } & UsageBucket)[];
};
export type AdminUsageView = Omit<UsageView, 'balance'> & {
  balance: number;
  byAccount: ({ accountId: string; email: string } & UsageBucket)[];
};
export type CodeView = Omit<CodeRecord, 'credits'> & { credits: number };
export type AdminAccountView = AccountView & {
  keys: number;
  runs: number;
  spent: number;
  lastActiveAt: number | null;
};
export type PlatformSummary = {
  siteName: string;
  registration: PlatformConfig['registration'];
  accounts: { total: number; active: number; disabled: number };
  balanceTotal: number;
  spentTotal: number;
  runsTotal: number;
  tokensTotal: number;
  listings: number;
};
export type ListingInput = {
  agentId: string;
  title?: string;
  summary?: string;
  tags?: string[];
  price?: Partial<Price>;
  enabled?: boolean;
  hostExecution?: boolean;
};
export type CodeInput = {
  kind: CodeKind;
  credits?: number;
  maxUses?: number;
  count?: number;
  expiresAt?: number | null;
  note?: string;
};
export type Page<T> = { data: T[]; nextCursor: number | null };
export type RunItemView = {
  id: string;
  agent: string;
  /** The ledger row's status: `in_progress` until settled, then the run's terminal status. */
  status: string;
  tokens: number;
  charge: number;
  createdAt: number;
};
export type RunDetailView = RunItemView & {
  completedAt: number | null;
  usage: Usage | null;
  error: { code: string; message: string } | null;
  price: Price;
  outputText: string;
  timeline: Timeline | null;
};
export type ResetCodeView = { code: string; expiresAt: number };
export type ReconcileResult = { settled: number; interrupted: number; pending: number };

export const pointsOf = (bucket: UsageBucket): UsageBucket => ({
  ...bucket,
  spent: toPoints(bucket.spent),
});
export const toAccountView = (a: AccountRecord): AccountView => ({
  id: a.id,
  email: a.email,
  name: a.name,
  status: a.status,
  balance: toPoints(a.balance),
  createdAt: a.createdAt,
});
export const toEntryView = (e: LedgerRecord): LedgerEntryView => ({
  ...e,
  amount: toPoints(e.amount),
  balanceAfter: toPoints(e.balanceAfter),
});
export const toCodeView = (c: CodeRecord): CodeView => ({ ...c, credits: toPoints(c.credits) });
export function checkWindowDays(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new Fault('invalid_request', 'days must be between 1 and 90.', 400);
  return days;
}
