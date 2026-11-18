import { terminal, type RunStatus } from '../core/contracts.js';
import { withSavepoint } from '../store/savepoint.js';
import type { Store } from '../store/store.js';
import type { AccountKeyPolicy } from './key-types.js';
import type { KeyUsage } from './key-usage.js';

const pendingTerminal = `SELECT p.*,s.status,s.total_tokens FROM api_key_pending_runs p
  JOIN run_summaries s ON s.run_id=p.run_id AND s.owner=p.owner
  WHERE s.status IN ('completed','failed','cancelled','incomplete','interrupted')`;

export class KeyAccounting {
  private timer?: NodeJS.Timeout;
  private warned = false;
  constructor(
    private store: Store,
    private usage: KeyUsage,
    private accounts: ReadonlyMap<string, string>,
    private platform: () => AccountKeyPolicy | undefined,
  ) {}

  stage(keyId: string | undefined, owner: string, run: string, agent?: string) {
    if (!keyId) return;
    const account = this.accounts.get(keyId);
    if (account && agent !== undefined) this.platform()?.beginRun(account, run, agent);
    return this.usage.stageBegin(keyId, owner, run);
  }
  begin(...args: Parameters<KeyAccounting['stage']>): void {
    withSavepoint(this.store.db, () => this.stage(...args))?.();
  }
  rejoin(keyId: string | undefined, run: string): void {
    if (!keyId) return;
    withSavepoint(this.store.db, () => this.stageRejoin(keyId, run))?.();
  }
  stageRejoin(keyId: string | undefined, run: string) {
    if (!keyId) return;
    this.usage.markPending(keyId, run);
    if (this.accounts.has(keyId)) this.platform()?.reopenRun(run);
    return () => this.usage.rejoin(keyId, run);
  }
  finish(
    keyId: string | undefined,
    owner: string,
    run: string,
    total = 0,
    status?: RunStatus,
  ): void {
    if (!keyId) return;
    try {
      this.settle(keyId, owner, run, total, status);
    } catch (error) {
      if (
        !status ||
        !terminal(status) ||
        !this.store
          .prepare('SELECT 1 FROM api_key_pending_runs WHERE run_id=? AND owner=? AND key_id=?')
          .get(run, owner, keyId)
      )
        throw error;
      this.schedule(5000);
    }
  }
  private settle(keyId: string, owner: string, run: string, total: number, status?: RunStatus) {
    const done = !!status && terminal(status);
    const publish = withSavepoint(this.store.db, () => {
      if (done && this.accounts.has(keyId))
        this.platform()?.settleRun(run, status, Math.max(0, Math.floor(total)));
      const update = this.usage.stageFinish(keyId, owner, run, total);
      if (done)
        this.store
          .prepare('DELETE FROM api_key_pending_runs WHERE run_id=? AND owner=? AND key_id=?')
          .run(run, owner, keyId);
      return update;
    });
    publish();
  }
  recover(): void {
    let failed = false,
      full = false;
    try {
      // Only admissions in the journal are recoverable. Never estimate old, possibly reset usage.
      const rows = this.store.prepare(pendingTerminal + ' ORDER BY p.rowid LIMIT 64').all();
      full = rows.length === 64;
      for (const r of rows) {
        try {
          this.settle(
            String(r.key_id),
            String(r.owner),
            String(r.run_id),
            Number(r.total_tokens),
            r.status as RunStatus,
          );
        } catch {
          failed = true;
        }
      }
    } catch {
      failed = true;
    }
    if (failed || full) this.schedule(failed ? 5000 : 0);
    else this.warned = false;
  }
  beforeReset(owner: string, keyId: string): void {
    // A delayed pre-reset charge must not appear in the freshly reset totals.
    for (;;) {
      const rows = this.store
        .prepare(pendingTerminal + ' AND p.owner=? AND p.key_id=? ORDER BY p.rowid LIMIT 64')
        .all(owner, keyId);
      for (const r of rows)
        this.settle(keyId, owner, String(r.run_id), Number(r.total_tokens), r.status as RunStatus);
      if (rows.length < 64) return;
    }
  }
  private schedule(delay: number) {
    if (this.timer) return;
    if (delay && !this.warned) {
      this.warned = true;
      process.emitWarning(
        'Run accounting could not commit; pending settlements will be retried.',
        'OAASettlement',
      );
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.recover();
    }, delay).unref();
  }
  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
