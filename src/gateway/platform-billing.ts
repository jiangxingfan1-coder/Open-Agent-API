/**
 * 开发者平台：余额、流水与用量聚合。
 *
 * 不变量：任一账号的 balance 恒等于它全部流水 amount 之和——余额只在 post / settleRun 里、
 * 与写流水同一事务改动。一个运行只有一行 `kind: run` 流水（run_id 唯一），重复结算只补差额。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { RunStatus } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { prepared, transaction } from './platform-db.js';

export type LedgerKind = 'run' | 'redeem' | 'grant' | 'adjust';
export type LedgerRecord = {
  id: number;
  kind: LedgerKind;
  /** Signed micro-points. */
  amount: number;
  balanceAfter: number;
  agent: string | null;
  runId: string | null;
  tokens: number;
  status: string | null;
  note: string;
  /** Operator's external order number of a credit (`platform_references`), if any. */
  reference: string | null;
  createdAt: number;
};
/** A `kind: run` row with the account and the prices recorded when the run started. */
export type RunRecord = LedgerRecord & { accountId: string; price: PriceMicro };
/** Micro-point prices recorded on a run row when the run starts. */
export type PriceMicro = { perRun: number; per1kTokens: number };
export type UsageBucket = { runs: number; tokens: number; spent: number };
export type UsageRecord = {
  totals: UsageBucket;
  daily: ({ date: string } & UsageBucket)[];
  byAgent: ({ agent: string } & UsageBucket)[];
  byAccount: ({ accountId: string; email: string } & UsageBucket)[];
};

/** Accounts listed in the operator's `by_account` (highest spend first). */
export const BY_ACCOUNT_LIMIT = 50;
/** Every ledger column plus the credit reference, for `parse`. */
const ENTRY_SELECT =
  'SELECT l.*,r.reference AS reference FROM platform_ledger l LEFT JOIN platform_references r ON r.entry_id=l.id';
/** Aggregate columns of a usage bucket; spend counts only charges (never a negative amount). */
const BUCKET =
  'count(*) AS runs,coalesce(sum(tokens),0) AS tokens,coalesce(sum(max(0,-amount)),0) AS spent';
const bucketOf = (row: Record<string, unknown>): UsageBucket => ({
  runs: Number(row.runs),
  tokens: Number(row.tokens),
  spent: Number(row.spent),
});

const DAY = 86_400_000;
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Amount owed for a run in micro-points, rounded up to a whole micro-point. */
export function runCharge(price: PriceMicro, status: RunStatus, tokens: number): number {
  const due =
    BigInt(status === 'completed' ? price.perRun : 0) +
    (BigInt(price.per1kTokens) * BigInt(Math.max(0, Math.floor(tokens))) + 999n) / 1000n;
  // Capped so the stored value stays an exact integer (unreachable with listing price limits).
  const cap = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(due > cap ? cap : due);
}

export class PlatformBilling {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: string,
  ) {}
  balance(accountId: string): number {
    const row = prepared(
      this.db,
      'SELECT balance FROM platform_accounts WHERE id=? AND owner=?',
    ).get(accountId, this.owner);
    if (!row) throw new Fault('account_not_found', 'Account was not found.', 404);
    return Number(row.balance);
  }
  private parse(row: Record<string, unknown>): LedgerRecord {
    return {
      id: Number(row.id),
      kind: String(row.kind) as LedgerKind,
      amount: Number(row.amount),
      balanceAfter: Number(row.balance_after),
      agent: row.agent === null ? null : String(row.agent),
      runId: row.run_id === null ? null : String(row.run_id),
      tokens: Number(row.tokens),
      status: row.status === null ? null : String(row.status),
      note: row.note === null ? '' : String(row.note),
      reference:
        row.reference === null || row.reference === undefined ? null : String(row.reference),
      createdAt: Number(row.created_at),
    };
  }
  private addBalance(accountId: string, delta: number): number {
    prepared(this.db, 'UPDATE platform_accounts SET balance=balance+? WHERE id=? AND owner=?').run(
      delta,
      accountId,
      this.owner,
    );
    return this.balance(accountId);
  }
  /** Posts a non-run entry and moves the balance by `amount` (one transaction). */
  post(
    accountId: string,
    kind: Exclude<LedgerKind, 'run'>,
    amount: number,
    note: string,
    options: { floor?: boolean } = {},
  ): LedgerRecord {
    if (!Number.isSafeInteger(amount))
      throw new Fault('invalid_request', 'amount must be a whole number of micro-points.', 400);
    return transaction(this.db, () => {
      const current = this.balance(accountId);
      if (options.floor && current + amount < 0)
        throw new Fault('insufficient_balance', 'The balance may not drop below 0.', 402);
      const after = this.addBalance(accountId, amount);
      const result = prepared(
        this.db,
        'INSERT INTO platform_ledger(owner,account_id,kind,amount,balance_after,note,payload,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(this.owner, accountId, kind, amount, after, note, '{}', Date.now());
      return this.entry(Number(result.lastInsertRowid));
    });
  }
  entry(entryId: number): LedgerRecord {
    const row = prepared(this.db, `${ENTRY_SELECT} WHERE l.id=? AND l.owner=?`).get(
      entryId,
      this.owner,
    );
    if (!row) throw new Fault('account_not_found', 'Ledger entry was not found.', 404);
    return this.parse(row);
  }
  /** Rejects a paid run before it is created when the balance cannot cover it. */
  checkRun(accountId: string, price: PriceMicro): void {
    if (price.perRun === 0 && price.per1kTokens === 0) return;
    const balance = this.balance(accountId);
    if (balance < price.perRun || balance <= 0)
      throw new Fault(
        'insufficient_balance',
        'The account balance is too low for this agent.',
        402,
      );
  }
  /**
   * Registers the run's single ledger row with the prices in force now (idempotent) and holds the
   * per-run price at once, so a run admitted next sees the reduced balance in checkRun: runs
   * admitted concurrently cannot overdraw the balance. Settlement releases the hold when the run
   * does not complete.
   */
  beginRun(accountId: string, runId: string, agent: string, price: PriceMicro): void {
    transaction(this.db, () => {
      const balance = this.balance(accountId);
      const hold = Math.min(price.perRun, Math.max(0, balance));
      const inserted = prepared(
        this.db,
        'INSERT OR IGNORE INTO platform_ledger(owner,account_id,kind,amount,balance_after,run_id,agent,tokens,status,note,payload,created_at) VALUES(?,?,?,?,?,?,?,0,?,?,?,?)',
      ).run(
        this.owner,
        accountId,
        'run',
        -hold,
        balance - hold,
        runId,
        agent,
        'in_progress',
        '',
        JSON.stringify(price),
        Date.now(),
      );
      if (inserted.changes && hold) this.addBalance(accountId, -hold);
    });
  }
  /**
   * Settles a run: charges the difference between what is owed now and what was charged. Token
   * charges never take the balance below 0 (what the balance cannot cover is not charged), and a
   * balance already below 0 (rows written before holds existed) is never pushed further down.
   */
  settleRun(runId: string, status: RunStatus, tokens: number): void {
    transaction(this.db, () => {
      const row = prepared(this.db, 'SELECT * FROM platform_ledger WHERE run_id=? AND owner=?').get(
        runId,
        this.owner,
      );
      if (!row) return;
      const prior = this.parse(row);
      const price = JSON.parse(String(row.payload)) as PriceMicro;
      const accountId = String(row.account_id);
      const charged = -prior.amount;
      const ceiling = Math.max(charged, charged + this.balance(accountId));
      const amount = -Math.min(runCharge(price, status, tokens), ceiling);
      const delta = amount - prior.amount;
      const after = delta ? this.addBalance(accountId, delta) : prior.balanceAfter;
      prepared(
        this.db,
        'UPDATE platform_ledger SET amount=?,balance_after=?,tokens=?,status=? WHERE id=?',
      ).run(amount, after, Math.max(0, Math.floor(tokens)), status, prior.id);
    });
  }
  /**
   * A run settled as `interrupted` is running again (resumed): its row shows `in_progress` and the
   * per-run hold is taken again (up to the balance); the next settlement charges the difference.
   */
  reopenRun(runId: string): void {
    transaction(this.db, () => {
      const row = prepared(
        this.db,
        "SELECT * FROM platform_ledger WHERE run_id=? AND owner=? AND kind='run' AND status='interrupted'",
      ).get(runId, this.owner);
      if (!row) return;
      const prior = this.parse(row);
      const accountId = String(row.account_id);
      const price = JSON.parse(String(row.payload)) as PriceMicro;
      const extra = Math.min(
        Math.max(0, price.perRun + prior.amount),
        Math.max(0, this.balance(accountId)),
      );
      const after = extra ? this.addBalance(accountId, -extra) : prior.balanceAfter;
      prepared(
        this.db,
        "UPDATE platform_ledger SET status='in_progress',amount=?,balance_after=? WHERE id=?",
      ).run(prior.amount - extra, after, prior.id);
    });
  }
  /** Newest first; `cursor` is the last entry ID of the previous page. */
  ledger(
    accountId: string,
    limit: number,
    cursor?: number,
  ): { data: LedgerRecord[]; next: number | null } {
    const rows = prepared(
      this.db,
      `${ENTRY_SELECT} WHERE l.owner=? AND l.account_id=? AND l.id<? ORDER BY l.id DESC LIMIT ?`,
    ).all(this.owner, accountId, cursor ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const data = rows.slice(0, limit).map((row) => this.parse(row));
    return { data, next: rows.length > limit ? data.at(-1)!.id : null };
  }
  /** Sum of every entry of an account (equals its balance; used by tests and checks). */
  ledgerSum(accountId: string): number {
    return Number(
      prepared(
        this.db,
        'SELECT coalesce(sum(amount),0) AS s FROM platform_ledger WHERE owner=? AND account_id=?',
      ).get(this.owner, accountId)!.s,
    );
  }
  /**
   * Run statistics of one account, or of every account: `days` UTC days ending today. Aggregated
   * in SQL; ties keep the order in which the groups first appear in the ledger (as in 0.4.0).
   * `byAccount` is filled only for every account, and holds at most BY_ACCOUNT_LIMIT rows.
   */
  usage(days: number, accountId?: string, now = Date.now()): UsageRecord {
    const today = Date.parse(`${utcDate(now)}T00:00:00.000Z`);
    const since = today - (days - 1) * DAY;
    const where = `owner=? AND kind='run' AND created_at>=?${accountId ? ' AND account_id=?' : ''}`;
    const args = [this.owner, since, ...(accountId ? [accountId] : [])];
    const totals = bucketOf(
      prepared(this.db, `SELECT ${BUCKET} FROM platform_ledger WHERE ${where}`).get(...args)!,
    );
    const daily = new Map<string, UsageBucket>();
    for (let i = 0; i < days; i++)
      daily.set(utcDate(since + i * DAY), { runs: 0, tokens: 0, spent: 0 });
    for (const row of prepared(
      this.db,
      `SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch') AS day,${BUCKET}
         FROM platform_ledger WHERE ${where} GROUP BY day`,
    ).all(...args))
      if (daily.has(String(row.day))) daily.set(String(row.day), bucketOf(row));
    const order = 'ORDER BY spent DESC,runs DESC,first ASC';
    const byAgent = prepared(
      this.db,
      `SELECT agent,${BUCKET},min(id) AS first FROM platform_ledger WHERE ${where} GROUP BY agent ${order}`,
    )
      .all(...args)
      .map((row) => ({ agent: String(row.agent), ...bucketOf(row) }));
    const byAccount = accountId
      ? []
      : prepared(
          this.db,
          `SELECT g.*,a.email AS email FROM (
               SELECT account_id,${BUCKET},min(id) AS first FROM platform_ledger WHERE ${where}
               GROUP BY account_id ${order} LIMIT ?) g
             LEFT JOIN platform_accounts a ON a.id=g.account_id AND a.owner=? ${order}`,
        )
          .all(...args, BY_ACCOUNT_LIMIT, this.owner)
          .map((row) => ({
            accountId: String(row.account_id),
            email: row.email === null ? '' : String(row.email),
            ...bucketOf(row),
          }));
    return {
      totals,
      daily: [...daily].map(([date, bucket]) => ({ date, ...bucket })),
      byAgent,
      byAccount,
    };
  }
  /** All-time totals of one account (or every account when omitted). */
  totals(accountId?: string): UsageBucket & { lastRunAt: number | null } {
    const row = prepared(
      this.db,
      `SELECT count(*) AS runs,coalesce(sum(tokens),0) AS tokens,coalesce(sum(-amount),0) AS spent,max(created_at) AS last
         FROM platform_ledger WHERE owner=? AND kind='run'${accountId ? ' AND account_id=?' : ''}`,
    ).get(...[this.owner, ...(accountId ? [accountId] : [])])!;
    return {
      runs: Number(row.runs),
      tokens: Number(row.tokens),
      spent: Math.max(0, Number(row.spent)),
      lastRunAt: row.last === null ? null : Number(row.last),
    };
  }
  /**
   * A credit or debit with an optional operator reference (one transaction). A reference seen
   * before returns its entry with `duplicate`; a different amount or account is a conflict.
   */
  credit(
    accountId: string,
    amount: number,
    note: string,
    reference?: string,
  ): { entry: LedgerRecord; duplicate: boolean } {
    return transaction(this.db, () => {
      if (reference !== undefined) {
        const seen = prepared(
          this.db,
          `SELECT l.id AS id,l.account_id AS account_id,l.amount AS amount FROM platform_references r
             JOIN platform_ledger l ON l.id=r.entry_id WHERE r.owner=? AND r.reference=?`,
        ).get(this.owner, reference);
        if (seen) {
          if (String(seen.account_id) !== accountId || Number(seen.amount) !== amount)
            throw new Fault(
              'reference_conflict',
              'This reference was already used for a different credit.',
              409,
            );
          return { entry: this.entry(Number(seen.id)), duplicate: true };
        }
      }
      const posted = this.post(accountId, 'adjust', amount, note, { floor: true });
      if (reference === undefined) return { entry: posted, duplicate: false };
      prepared(
        this.db,
        'INSERT INTO platform_references(owner,reference,entry_id,created_at) VALUES(?,?,?,?)',
      ).run(this.owner, reference, posted.id, Date.now());
      return { entry: this.entry(posted.id), duplicate: false };
    });
  }
  private runRecord(row: Record<string, unknown>): RunRecord {
    return {
      ...this.parse(row),
      accountId: String(row.account_id),
      price: JSON.parse(String(row.payload)) as PriceMicro,
    };
  }
  /** An account's run rows, newest first; `cursor` is the last row ID of the previous page. */
  runs(
    accountId: string,
    limit: number,
    cursor?: number,
    agent?: string,
  ): { data: RunRecord[]; next: number | null } {
    const rows = prepared(
      this.db,
      `SELECT * FROM platform_ledger WHERE owner=? AND account_id=? AND kind='run' AND id<?${agent !== undefined ? ' AND agent=?' : ''} ORDER BY id DESC LIMIT ?`,
    ).all(
      this.owner,
      accountId,
      cursor ?? Number.MAX_SAFE_INTEGER,
      ...(agent !== undefined ? [agent] : []),
      limit + 1,
    );
    const data = rows.slice(0, limit).map((row) => this.runRecord(row));
    return { data, next: rows.length > limit ? data.at(-1)!.id : null };
  }
  /** The run row of one of the account's runs. */
  run(accountId: string, runId: string): RunRecord | undefined {
    const row = prepared(
      this.db,
      "SELECT * FROM platform_ledger WHERE owner=? AND account_id=? AND run_id=? AND kind='run'",
    ).get(this.owner, accountId, runId);
    return row ? this.runRecord(row) : undefined;
  }
  /** Run IDs whose row has not been settled yet (startup reconciliation). */
  unsettledRuns(): string[] {
    return prepared(
      this.db,
      "SELECT run_id FROM platform_ledger WHERE owner=? AND kind='run' AND status='in_progress' ORDER BY id",
    )
      .all(this.owner)
      .map((row) => String(row.run_id));
  }
}
