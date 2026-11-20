import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { Fault } from '../core/util.js';

export function installArtifactOrigins(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS retained_artifact_origins(
    file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,run_id TEXT NOT NULL,agent_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS file_artifact_run ON files(json_extract(payload,'$.runId'),owner)
    WHERE json_valid(payload) AND json_type(payload,'$.runId')='text';`);
}

/** Preserve the producer grant in the same transaction that removes its run. */
export function rememberArtifactOrigins(db: DatabaseSync, ids: string[]) {
  db.prepare(
    `INSERT INTO retained_artifact_origins(file_id,owner,run_id,agent_id)
    SELECT f.id,r.owner,r.id,r.agent_id FROM json_each(?) i CROSS JOIN runs r ON r.id=i.value
    CROSS JOIN files f ON json_valid(f.payload) AND json_type(f.payload,'$.runId')='text'
      AND json_extract(f.payload,'$.runId')=r.id AND f.owner=r.owner
    ON CONFLICT(file_id) DO NOTHING`,
  ).run(JSON.stringify(ids));
}

export function artifactOriginAgent(
  store: { prepare(sql: string): StatementSync },
  owner: string,
  fileId: string,
  runId: string,
): string {
  const row = store
    .prepare(
      `SELECT agent_id FROM runs WHERE id=? AND owner=? UNION ALL
    SELECT agent_id FROM retained_artifact_origins WHERE file_id=? AND run_id=? AND owner=? LIMIT 1`,
    )
    .get(runId, owner, fileId, runId, owner);
  if (!row) throw new Fault('run_not_found', 'Response not found.', 404);
  return String(row.agent_id);
}
