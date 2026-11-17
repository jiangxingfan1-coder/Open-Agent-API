import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { canonical, sha, Fault } from '../core/util.js';
import type { SourceConfig, SourceReport } from '../core/model-sources.js';
type Database = { db: DatabaseSync; prepare(sql: string): StatementSync };
export type SourceRecord = {
  model?: string;
  owner: string;
  agent: string;
  route: string;
  settings: SourceConfig;
  reports: SourceReport[];
  lastAttempt: number;
};
export class ModelSources {
  constructor(private readonly store: Database) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS model_sources(owner TEXT NOT NULL,agent TEXT NOT NULL,route TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,agent,route))',
    );
  }
  get(owner: string, agent: string, route: string): SourceRecord {
    const row = this.store
      .prepare('SELECT payload FROM model_sources WHERE owner=? AND agent=? AND route=?')
      .get(owner, agent, route);
    return row
      ? (JSON.parse(String(row.payload)) as SourceRecord)
      : {
          owner,
          agent,
          route,
          settings: { enabled: false, sources: [] },
          reports: [],
          lastAttempt: 0,
        };
  }
  save(value: SourceRecord) {
    this.store
      .prepare(
        'INSERT INTO model_sources VALUES(?,?,?,?) ON CONFLICT(owner,agent,route) DO UPDATE SET payload=excluded.payload',
      )
      .run(value.owner, value.agent, value.route, JSON.stringify(value));
  }
  configure(
    owner: string,
    agent: string,
    route: string,
    settings: SourceConfig,
    revision: string,
    model?: string,
  ) {
    const previous = this.get(owner, agent, route);
    if (revision !== sha(canonical(previous.settings)))
      throw new Fault('version_conflict', 'Model source configuration changed.', 409);
    this.save({
      ...previous,
      settings,
      model,
      reports:
        previous.model === model &&
        canonical(previous.settings.sources) === canonical(settings.sources)
          ? previous.reports
          : [],
      lastAttempt: 0,
    });
  }
  enabled(): SourceRecord[] {
    return this.store
      .prepare('SELECT payload FROM model_sources')
      .all()
      .map((row) => JSON.parse(String(row.payload)) as SourceRecord)
      .filter((row) => row.settings.enabled);
  }
  knowledge(owner: string, agent: string, route: string, model?: string) {
    const value = this.get(owner, agent, route);
    return value.settings.enabled && (!value.model || value.model === model)
      ? value.reports
          .filter((r) => r.facts && r.fetchedAt && Date.now() - r.fetchedAt < 7 * 86400000)
          .sort((a, b) => b.fetchedAt! - a.fetchedAt!)
          .slice(0, 2)
          .map((r) => ({
            sourceId: sha(r.url),
            fetchedAt: r.fetchedAt!,
            facts: r.facts!,
            stale: !!r.error,
            provenance: 'public_report_not_measurement' as const,
          }))
      : [];
  }
}
