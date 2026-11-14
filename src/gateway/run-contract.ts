import type { Store } from '../store/store.js';

/** The structured-output contract of a run and how many correction rounds it needed (run inspector), or undefined. */
export function outputContractOf(
  store: Store,
  runId: string,
): { kind: string; repairs: number } | undefined {
  const row = store.db
    .prepare(
      `SELECT json_extract(payload,'$.metadata."oaa.output_contract"') AS kind, json_extract(payload,'$.metadata."oaa.output_repairs"') AS repairs FROM runs WHERE id=?`,
    )
    .get(runId);
  return typeof row?.kind === 'string'
    ? { kind: row.kind, repairs: Number(row.repairs ?? 0) }
    : undefined;
}
