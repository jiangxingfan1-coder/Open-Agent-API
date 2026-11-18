import type { DatabaseSync } from 'node:sqlite';

const terminal = "('completed','failed','cancelled','incomplete','interrupted')";

/** Install within the store's startup transaction. Deleting history never subtracts an outcome. */
export function installRunOutcomes(db: DatabaseSync) {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='run_outcomes'").get())
    return;
  const increment = `INSERT INTO run_outcomes(owner,subject,agent_id,status,n)
    VALUES(NEW.owner,coalesce(NEW.subject,'legacy'),NEW.agent_id,NEW.status,1)
    ON CONFLICT(owner,subject,agent_id,status) DO UPDATE SET n=n+1;`;
  db.exec(`CREATE TABLE run_outcomes(owner TEXT NOT NULL,subject TEXT NOT NULL,agent_id TEXT NOT NULL,status TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(owner,subject,agent_id,status));
    INSERT INTO run_outcomes SELECT owner,coalesce(subject,'legacy'),agent_id,status,count(*)
      FROM run_summaries WHERE status IN ${terminal} GROUP BY owner,coalesce(subject,'legacy'),agent_id,status;
    CREATE TRIGGER run_outcome_insert AFTER INSERT ON run_summaries WHEN NEW.status IN ${terminal}
      BEGIN ${increment} END;
    CREATE TRIGGER run_outcome_transition AFTER UPDATE OF status ON run_summaries WHEN NEW.status<>OLD.status AND NEW.status IN ${terminal}
      BEGIN ${increment} END;`);
}
