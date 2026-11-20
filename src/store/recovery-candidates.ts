import type { DatabaseSync, StatementSync } from 'node:sqlite';

const reasons = new Set(['gateway_restarted', 'shutting_down', 'cancelled']);
export const isRecoveryCause = (code?: string) => !!code && reasons.has(code);
const recoverable = `status='interrupted' AND json_valid(payload)
  AND json_type(payload,'$.checkpoint.durability')='object'
  AND json_extract(payload,'$.error.code') IN (${[...reasons].map((s) => `'${s}'`).join(',')})`;

export function indexRecoveryCandidates(db: DatabaseSync) {
  db.exec(`CREATE INDEX IF NOT EXISTS run_auto_recovery ON runs(status) WHERE ${recoverable}`);
}

/** No live SQLite iterator spans a resume write. Requeued rows disappear from this index. */
export function* recoveryCandidates(store: {
  prepare(sql: string): StatementSync;
}): Generator<string> {
  let after: number | undefined;
  for (;;) {
    const rows = store
      .prepare(
        `SELECT rowid AS position,id FROM runs WHERE ${recoverable}
      ${after === undefined ? '' : 'AND rowid>?'} ORDER BY rowid LIMIT 64`,
      )
      .all(...(after === undefined ? [] : [after]));
    if (!rows.length) return;
    after = Number(rows.at(-1)!.position);
    for (const row of rows) yield String(row.id);
    if (rows.length < 64) return;
  }
}
