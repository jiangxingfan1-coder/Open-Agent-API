/**
 * 开发者平台的门面：账号与会话、账号密钥、上架与定价、兑换码、计费与用量。
 *
 * - 只做领域逻辑，不碰 HTTP；入参出参是内部类型（camelCase），蛇形字段由路由转换。
 * - 金额在门面边界上是「点」（number，最多 6 位小数），内部一律是整数微点数（platform-db.ts）。
 * - 只在网关配置了 `platform` 时构造；构造时建 `platform_` 表并把账号密钥的策略交给 Auth。
 */
import type { WorkerConfig } from '../config/config.js';
import { isOwnerWide, type Principal, type RunStatus } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { conversionProfile } from '../engines/conformance.js';
import type { Store } from '../store/store.js';
import type { AccountKeyPolicy, Auth } from './auth.js';
import {
  PlatformAccounts,
  checkPassword,
  hashPassword,
  normalizeEmail,
  type AccountRecord,
  type AccountStatus,
} from './platform-accounts.js';
import { PlatformBilling, type LedgerRecord, type UsageBucket } from './platform-billing.js';
import { PlatformCodes, type CodeRecord } from './platform-codes.js';
import {
  RateLimiter,
  ensurePlatformTables,
  requireOwnerAdmin,
  toMicro,
  toPoints,
  transaction,
  type PlatformConfig,
} from './platform-db.js';
import { PlatformListings, type ListingRecord } from './platform-listings.js';
import { PlatformResets } from './platform-resets.js';
import { PlatformRuns } from './platform-runs.js';
import type {
  AccountView,
  AdminAccountView,
  AdminUsageView,
  CodeInput,
  CodeView,
  LedgerEntryView,
  ListedAgentView,
  ListingInput,
  ListingView,
  Page,
  PlatformSummary,
  PortalKeyView,
  Price,
  ReconcileResult,
  ResetCodeView,
  RunDetailView,
  RunItemView,
  SessionView,
  UsageView,
} from './platform-types.js';

/** Public endpoints: signups per IP per hour; logins per IP and per email per 10 minutes. */
const SIGNUP_PER_IP = 10;
const LOGIN_PER_IP = 30;
const LOGIN_PER_EMAIL = 10;
const pointsOf = (bucket: UsageBucket): UsageBucket => ({
  ...bucket,
  spent: toPoints(bucket.spent),
});
function displayName(name: unknown, email: string): string {
  if (name === undefined || name === null || name === '') return email.split('@')[0]!;
  if (typeof name !== 'string' || name.trim().length > 100)
    throw new Fault('invalid_request', 'name must be at most 100 characters.', 400);
  return name.trim() || email.split('@')[0]!;
}
function pageSize(limit: number | undefined, fallback: number): number {
  const value = limit ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > 200)
    throw new Fault('invalid_request', 'limit must be between 1 and 200.', 400);
  return value;
}

export class Platform {
  readonly owner: string;
  private readonly accounts: PlatformAccounts;
  private readonly listings: PlatformListings;
  private readonly codes: PlatformCodes;
  private readonly billing: PlatformBilling;
  private readonly signupLimit = new RateLimiter(SIGNUP_PER_IP, 3_600_000);
  private readonly loginIpLimit = new RateLimiter(LOGIN_PER_IP, 600_000);
  private readonly loginEmailLimit = new RateLimiter(LOGIN_PER_EMAIL, 600_000);
  private readonly resetIpLimit = new RateLimiter(LOGIN_PER_IP, 600_000);
  private readonly resetEmailLimit = new RateLimiter(LOGIN_PER_EMAIL, 600_000);
  private readonly resets: PlatformResets;
  private readonly runs: PlatformRuns;
  private reconcileTimer?: NodeJS.Immediate;
  constructor(
    private readonly store: Store,
    private readonly auth: Auth,
    readonly config: PlatformConfig,
    private readonly localWorker?: WorkerConfig,
  ) {
    this.owner = config.owner;
    ensurePlatformTables(store.db);
    this.accounts = new PlatformAccounts(store.db, this.owner, config.sessionTtlHours * 3_600_000);
    this.listings = new PlatformListings(store.db, this.owner, () =>
      store.authorizationChanged(this.owner),
    );
    this.codes = new PlatformCodes(store.db, this.owner);
    this.billing = new PlatformBilling(store.db, this.owner);
    this.resets = new PlatformResets(store.db, this.owner);
    this.runs = new PlatformRuns(store, this.billing, this.owner);
    auth.attachPlatform(this.keyPolicy());
    // The kernel has already recovered interrupted runs (its constructor runs first); settle what
    // is left on the next turn of the event loop so startup is not held up. See reconcile().
    this.reconcileTimer = setImmediate(() => {
      this.reconcileTimer = undefined;
      try {
        this.reconcile();
      } catch {
        // Closed before it ran, or a corrupt row: the next startup tries again.
      }
    });
  }
  /** Cancels a pending startup reconciliation (the gateway is closing). */
  close(): void {
    if (this.reconcileTimer) clearImmediate(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }
  /** Settles run rows left `in_progress` (startup reconciliation; see PlatformRuns.reconcile). */
  reconcile(): ReconcileResult {
    return this.runs.reconcile();
  }
  private keyPolicy(): AccountKeyPolicy {
    return {
      agents: () => this.listings.enabledIds(),
      execution: this.config.keyExecution,
      quota: this.config.keyQuota,
      assertActive: (accountId) => {
        const account = this.accounts.find(accountId);
        if (!account) throw new Fault('unauthorized', 'Invalid or revoked API key.', 401);
        if (account.status !== 'active')
          throw new Fault('account_disabled', 'This account has been disabled.', 403);
      },
      checkRun: (accountId, agent) => this.billing.checkRun(accountId, this.priceMicro(agent)),
      beginRun: (accountId, runId, agent) => {
        this.billing.beginRun(accountId, runId, agent, this.priceMicro(agent));
        this.accounts.touch(accountId);
      },
      settleRun: (runId: string, status: RunStatus, tokens: number) =>
        this.billing.settleRun(runId, status, tokens),
      reopenRun: (runId: string) => this.billing.reopenRun(runId),
    };
  }
  /** Current listing price (an unlisted agent is free: it cannot be called by account keys). */
  private priceMicro(agentId: string): { perRun: number; per1kTokens: number } {
    const listing = this.listings.find(agentId);
    return { perRun: listing?.perRun ?? 0, per1kTokens: listing?.per1kTokens ?? 0 };
  }

  // ---- views -------------------------------------------------------------------------------
  private accountView(a: AccountRecord): AccountView {
    return {
      id: a.id,
      email: a.email,
      name: a.name,
      status: a.status,
      balance: toPoints(a.balance),
      createdAt: a.createdAt,
    };
  }
  private price(l: ListingRecord): Price {
    return { perRun: toPoints(l.perRun), per1kTokens: toPoints(l.per1kTokens) };
  }
  private entryView(e: LedgerRecord): LedgerEntryView {
    return { ...e, amount: toPoints(e.amount), balanceAfter: toPoints(e.balanceAfter) };
  }
  private codeView(c: CodeRecord): CodeView {
    return { ...c, credits: toPoints(c.credits) };
  }
  private agentExists(agentId: string): boolean {
    try {
      this.store.bundle(this.owner, agentId);
      return true;
    } catch {
      return false;
    }
  }
  private listingView(l: ListingRecord): ListingView {
    return {
      agentId: l.agentId,
      title: l.title,
      summary: l.summary,
      tags: l.tags,
      price: this.price(l),
      enabled: l.enabled,
      updatedAt: l.updatedAt,
      agentExists: this.agentExists(l.agentId),
    };
  }
  private listedView(l: ListingRecord): ListedAgentView | undefined {
    let agent;
    try {
      agent = this.store.bundle(this.owner, l.agentId).agent;
    } catch {
      return undefined;
    }
    return {
      id: l.agentId,
      title: l.title,
      summary: l.summary,
      tags: l.tags,
      description: agent.description,
      kind: agent.engine === 'kernel' ? 'kernel' : 'external',
      models: ['auto', ...agent.routes.map((r) => r.id)],
      price: this.price(l),
      updatedAt: l.updatedAt,
      conversion: conversionProfile(agent.engine, this.localWorker),
    };
  }

  // ---- public ------------------------------------------------------------------------------
  site(): { siteName: string; registration: PlatformConfig['registration'] } {
    return { siteName: this.config.siteName, registration: this.config.registration };
  }
  /** Enabled listings whose agent is published. */
  listedAgents(): ListedAgentView[] {
    return this.listings
      .list()
      .filter((l) => l.enabled)
      .map((l) => this.listedView(l))
      .filter((v): v is ListedAgentView => v !== undefined);
  }
  listedAgent(agentId: string): ListedAgentView {
    const listing = this.listings.find(agentId);
    const view = listing?.enabled ? this.listedView(listing) : undefined;
    if (!view) throw new Fault('agent_not_found', 'Agent or version not found.', 404);
    return view;
  }
  async signup(
    input: { email: unknown; password: unknown; name?: unknown; inviteCode?: unknown },
    ip: string,
  ): Promise<{ account: AccountView; session: SessionView }> {
    const mode = this.config.registration;
    if (mode === 'closed')
      throw new Fault('registration_closed', 'Self-service signup is closed on this site.', 403);
    this.signupLimit.hit(ip);
    const email = normalizeEmail(input.email);
    const password = checkPassword(input.password);
    const name = displayName(input.name, email);
    const hasInvite = typeof input.inviteCode === 'string' && input.inviteCode.trim() !== '';
    if (mode === 'invite' && !hasInvite)
      throw new Fault('invite_required', 'Signup on this site needs an invite code.', 403);
    if (hasInvite) this.codes.check(input.inviteCode, 'invite');
    if (this.accounts.byEmail(email))
      throw new Fault('email_taken', 'This email is already registered.', 409);
    const hash = await hashPassword(password);
    const account = transaction(this.store.db, () => {
      const invite = hasInvite ? this.codes.check(input.inviteCode, 'invite') : undefined;
      const created = this.accounts.insert(email, hash, name);
      if (invite) this.codes.consume(invite, created.id);
      const signup = toMicro(this.config.signupCredits, 'signupCredits');
      if (signup > 0) this.billing.post(created.id, 'grant', signup, 'signup');
      if (invite && invite.credits > 0)
        this.billing.post(created.id, 'redeem', invite.credits, `invite ${invite.id}`);
      this.accounts.touch(created.id);
      return this.accounts.get(created.id);
    });
    return { account: this.accountView(account), session: this.accounts.createSession(account.id) };
  }
  async login(
    input: { email: unknown; password: unknown },
    ip: string,
  ): Promise<{ account: AccountView; session: SessionView }> {
    this.loginIpLimit.hit(ip);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    this.loginEmailLimit.hit(email);
    const password = typeof input.password === 'string' ? input.password.slice(0, 200) : '';
    const account = await this.accounts.verify(email, password);
    if (account.status !== 'active')
      throw new Fault('account_disabled', 'This account has been disabled.', 403);
    this.accounts.touch(account.id);
    return { account: this.accountView(account), session: this.accounts.createSession(account.id) };
  }

  // ---- portal session ----------------------------------------------------------------------
  /** Resolves an `oas_…` token: `session_invalid` (401) or `account_disabled` (403). */
  session(token: unknown): AccountView {
    return this.accountView(this.accounts.session(token));
  }
  logout(token: string): void {
    this.accounts.dropSession(token);
  }
  account(accountId: string): AccountView {
    return this.accountView(this.accounts.get(accountId));
  }
  /** Every session of the account ends, including the caller's. */
  async changePassword(accountId: string, current: unknown, next: unknown): Promise<void> {
    const account = this.accounts.get(accountId);
    const password = checkPassword(next, 'new_password');
    await this.accounts.verify(account.email, typeof current === 'string' ? current : '');
    this.accounts.setPasswordHash(accountId, await hashPassword(password));
  }
  keys(accountId: string): PortalKeyView[] {
    this.accounts.get(accountId);
    return this.auth
      .accountKeys(this.owner, accountId)
      .map((k) => ({ ...k, quota: this.config.keyQuota }));
  }
  createKey(accountId: string, name: unknown): PortalKeyView & { token: string } {
    this.accounts.get(accountId);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100)
      throw new Fault('invalid_request', 'name must contain 1-100 characters.', 400);
    const key = this.auth.createAccountKey(
      this.owner,
      accountId,
      name.trim(),
      this.config.maxKeysPerAccount,
    );
    return { ...key, quota: this.config.keyQuota };
  }
  revokeKey(accountId: string, keyId: string): void {
    this.auth.revokeAccountKey(this.owner, accountId, keyId);
  }
  redeem(accountId: string, code: unknown): { account: AccountView; credited: number } {
    return transaction(this.store.db, () => {
      const record = this.codes.check(code, 'credit', accountId);
      this.codes.consume(record, accountId);
      this.billing.post(accountId, 'redeem', record.credits, `code ${record.id}`);
      return {
        account: this.accountView(this.accounts.get(accountId)),
        credited: toPoints(record.credits),
      };
    });
  }
  usage(accountId: string, days = 30): UsageView {
    const window = this.days(days);
    const usage = this.billing.usage(window, accountId);
    return {
      balance: toPoints(this.billing.balance(accountId)),
      totals: pointsOf(usage.totals),
      daily: usage.daily.map((d) => ({ ...d, spent: toPoints(d.spent) })),
      byAgent: usage.byAgent.map((a) => ({ ...a, spent: toPoints(a.spent) })),
    };
  }
  ledger(accountId: string, page: { limit?: number; cursor?: number } = {}): Page<LedgerEntryView> {
    this.accounts.get(accountId);
    const { data, next } = this.billing.ledger(accountId, pageSize(page.limit, 50), page.cursor);
    return { data: data.map((e) => this.entryView(e)), nextCursor: next };
  }
  runList(
    accountId: string,
    page: { limit?: number; cursor?: number; agent?: string } = {},
  ): Page<RunItemView> {
    return this.runs.list(accountId, {
      limit: pageSize(page.limit, 20),
      ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      ...(page.agent !== undefined ? { agent: page.agent } : {}),
    });
  }
  /** One of the account's runs; any other run is `run_not_found`. */
  runDetail(accountId: string, runId: string): RunDetailView {
    return this.runs.detail(accountId, runId);
  }
  /** Public: sets a new password with an operator's reset code; every session ends. */
  async resetWithCode(
    input: { email: unknown; code: unknown; newPassword: unknown },
    ip: string,
  ): Promise<void> {
    this.resetIpLimit.hit(ip);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    this.resetEmailLimit.hit(email);
    const password = checkPassword(input.newPassword, 'new_password');
    const code = typeof input.code === 'string' ? input.code.slice(0, 200) : '';
    const account = this.accounts.byEmail(email);
    const valid = this.resets.matches(account?.id ?? '', code);
    // Hashed whatever the outcome, so an unknown email costs the same as a wrong code.
    const hash = await hashPassword(password);
    const invalid = () =>
      new Fault('invalid_code', 'The reset code is invalid or has expired.', 400);
    if (!account || !valid) throw invalid();
    transaction(this.store.db, () => {
      if (!this.resets.consume(account.id, code)) throw invalid();
      this.accounts.setPasswordHash(account.id, hash);
    });
  }
  /** `account` field of GET /v1/me for account keys; undefined for every other key. */
  meAccount(p: Principal): { id: string; balance: number } | undefined {
    if (!p.accountId) return undefined;
    const account = this.accounts.find(p.accountId);
    return account ? { id: account.id, balance: toPoints(account.balance) } : undefined;
  }
  private days(days: number): number {
    if (!Number.isInteger(days) || days < 1 || days > 90)
      throw new Fault('invalid_request', 'days must be between 1 and 90.', 400);
    return days;
  }

  // ---- operator (routes require admin scope; see requireOperator) --------------------------
  /** Operator calls need an owner-wide admin key (every agent) of the platform owner. */
  requireOperator(p: Principal): void {
    requireOwnerAdmin(p);
    if (p.owner !== this.owner)
      throw new Fault('scope_denied', 'This key does not belong to the platform owner.', 403);
  }
  summary(): PlatformSummary {
    const counts = this.accounts.counts();
    const totals = this.billing.totals();
    return {
      siteName: this.config.siteName,
      registration: this.config.registration,
      accounts: { total: counts.total, active: counts.active, disabled: counts.disabled },
      balanceTotal: toPoints(counts.balance),
      spentTotal: toPoints(totals.spent),
      runsTotal: totals.runs,
      tokensTotal: totals.tokens,
      listings: this.listings.list().length,
    };
  }
  adminAccounts(
    page: { query?: string; limit?: number; cursor?: number } = {},
  ): Page<AdminAccountView> {
    const { rows, next } = this.accounts.list(
      (page.query ?? '').slice(0, 254),
      pageSize(page.limit, 50),
      page.cursor,
    );
    return { data: rows.map((a) => this.adminView(a)), nextCursor: next };
  }
  private adminView(a: AccountRecord): AdminAccountView {
    const totals = this.billing.totals(a.id);
    const last = Math.max(a.lastActiveAt ?? 0, totals.lastRunAt ?? 0);
    return {
      ...this.accountView(a),
      keys: this.auth.accountKeys(this.owner, a.id).length,
      runs: totals.runs,
      spent: toPoints(totals.spent),
      lastActiveAt: last || null,
    };
  }
  /** Not limited by `registration`. */
  async createAccount(input: {
    email: unknown;
    password: unknown;
    name?: unknown;
    credits?: number;
  }): Promise<AccountView> {
    const email = normalizeEmail(input.email);
    const password = checkPassword(input.password);
    const name = displayName(input.name, email);
    const credits = toMicro(input.credits ?? 0, 'credits');
    if (credits < 0) throw new Fault('invalid_request', 'credits must not be negative.', 400);
    if (this.accounts.byEmail(email))
      throw new Fault('email_taken', 'This email is already registered.', 409);
    const hash = await hashPassword(password);
    return transaction(this.store.db, () => {
      const created = this.accounts.insert(email, hash, name);
      if (credits > 0) this.billing.post(created.id, 'grant', credits, 'operator');
      return this.accountView(this.accounts.get(created.id));
    });
  }
  /** Disabling ends every session; the account's keys are refused at authentication. */
  setAccountStatus(accountId: string, status: AccountStatus): AccountView {
    if (status !== 'active' && status !== 'disabled')
      throw new Fault('invalid_request', 'status must be active or disabled.', 400);
    const account = this.accounts.setStatus(accountId, status);
    this.store.authorizationChanged(this.owner);
    return this.accountView(account);
  }
  /**
   * Who may credit and look accounts up: `operator` (owner-wide admin of the platform owner) or
   * `billing` (a `billing`-scoped key of the platform owner: credits only, see creditAccount).
   */
  requireCreditor(p: Principal): 'operator' | 'billing' {
    if (isOwnerWide(p) && p.owner === this.owner) return 'operator';
    if (p.scopes.includes('billing') && p.owner === this.owner) return 'billing';
    this.requireOperator(p);
    throw new Fault('scope_denied', 'Platform operations require an owner-wide admin key.', 403);
  }
  /**
   * Signed adjustment in points; the resulting balance may not be below 0. `positiveOnly` (billing
   * keys) refuses debits. A `reference` seen before returns the first result with `duplicate`.
   */
  creditAccount(
    accountId: string,
    amount: number,
    note: string,
    options: { reference?: string; positiveOnly?: boolean } = {},
  ): { account: AccountView; entry: LedgerEntryView; duplicate: boolean } {
    this.accounts.get(accountId);
    const micro = toMicro(amount);
    if (micro === 0) throw new Fault('invalid_request', 'amount must not be 0.', 400);
    if (options.positiveOnly && micro < 0)
      throw new Fault('scope_denied', 'A billing key can only add credits.', 403);
    if (typeof note !== 'string' || note.length > 200)
      throw new Fault('invalid_request', 'note must be at most 200 characters.', 400);
    const reference = options.reference;
    if (reference !== undefined && (reference.length < 1 || reference.length > 200))
      throw new Fault('invalid_request', 'reference must contain 1-200 characters.', 400);
    const { entry, duplicate } = this.billing.credit(accountId, micro, note, reference);
    return { account: this.account(accountId), entry: this.entryView(entry), duplicate };
  }
  /** A one-time reset code for the account (24 hours); replaces any earlier one. */
  issueResetCode(accountId: string): ResetCodeView {
    this.accounts.get(accountId);
    return this.resets.issue(accountId);
  }
  async resetPassword(accountId: string, next: unknown): Promise<void> {
    this.accounts.get(accountId);
    const password = checkPassword(next, 'new_password');
    this.accounts.setPasswordHash(accountId, await hashPassword(password));
  }
  accountLedger(
    accountId: string,
    page: { limit?: number; cursor?: number } = {},
  ): Page<LedgerEntryView> {
    return this.ledger(accountId, page);
  }
  /** For tests and checks: sum of the account's ledger in points. */
  ledgerSum(accountId: string): number {
    return toPoints(this.billing.ledgerSum(accountId));
  }
  allListings(): ListingView[] {
    return this.listings.list().map((l) => this.listingView(l));
  }
  /** Create or update; the agent must be published by the platform owner. */
  putListing(input: ListingInput): ListingView {
    if (typeof input.agentId !== 'string' || !this.agentExists(input.agentId))
      throw new Fault('agent_not_found', 'Agent or version not found.', 404);
    const listing = this.listings.upsert(input.agentId, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.price?.perRun !== undefined
        ? { perRun: toMicro(input.price.perRun, 'price.per_run') }
        : {}),
      ...(input.price?.per1kTokens !== undefined
        ? { per1kTokens: toMicro(input.price.per1kTokens, 'price.per_1k_tokens') }
        : {}),
    });
    return this.listingView(listing);
  }
  deleteListing(agentId: string): void {
    this.listings.remove(agentId);
  }
  allCodes(): CodeView[] {
    return this.codes.list().map((c) => this.codeView(c));
  }
  createCodes(input: CodeInput): (CodeView & { code: string })[] {
    if (input.kind !== 'credit' && input.kind !== 'invite')
      throw new Fault('invalid_request', 'kind must be credit or invite.', 400);
    return this.codes
      .generate({
        kind: input.kind,
        credits: toMicro(input.credits ?? 0, 'credits'),
        maxUses: input.maxUses ?? 1,
        count: input.count ?? 1,
        expiresAt: input.expiresAt ?? null,
        note: input.note ?? '',
      })
      .map((c) => ({ ...this.codeView(c), code: c.code }));
  }
  revokeCode(codeId: string): void {
    this.codes.revoke(codeId);
  }
  adminUsage(days = 30): AdminUsageView {
    const usage = this.billing.usage(this.days(days));
    return {
      balance: toPoints(this.accounts.counts().balance),
      totals: pointsOf(usage.totals),
      daily: usage.daily.map((d) => ({ ...d, spent: toPoints(d.spent) })),
      byAgent: usage.byAgent.map((a) => ({ ...a, spent: toPoints(a.spent) })),
      byAccount: usage.byAccount.map((a) => ({ ...a, spent: toPoints(a.spent) })),
    };
  }
}
