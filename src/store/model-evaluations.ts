import type { Store } from './store.js';
import {
  evaluationSettingsSchema,
  EVALUATION_SUITE,
  type EvaluationSettings,
  type ModelPerformance,
  type EvaluationDimension,
} from '../core/model-evaluation.js';

export type EvaluationSample = {
  owner: string;
  agent: string;
  revision: string;
  route: string;
  epoch: number;
  caseId: string;
  dimension: EvaluationDimension;
  runId: string;
  startedAt: number;
  finishedAt?: number;
  passed?: boolean;
  elapsedMs?: number;
  error?: string;
};

export class ModelEvaluations {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS model_evaluation_settings (owner TEXT NOT NULL, agent TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,agent));
      CREATE TABLE IF NOT EXISTS model_evaluation_samples (owner TEXT NOT NULL, agent TEXT NOT NULL, revision TEXT NOT NULL, route TEXT NOT NULL, epoch INTEGER NOT NULL, case_id TEXT NOT NULL, run_id TEXT NOT NULL, started_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,agent,revision,route,epoch,case_id));
      CREATE INDEX IF NOT EXISTS evaluation_daily ON model_evaluation_samples(owner,agent,started_at);
      CREATE TABLE IF NOT EXISTS model_feedback(owner TEXT NOT NULL,agent TEXT NOT NULL,revision TEXT NOT NULL,route TEXT NOT NULL,run_id TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,run_id));
    `);
  }
  settings(owner: string, agent: string): EvaluationSettings {
    const row = this.store
      .prepare('SELECT payload FROM model_evaluation_settings WHERE owner=? AND agent=?')
      .get(owner, agent);
    return row
      ? evaluationSettingsSchema.parse(JSON.parse(String(row.payload)))
      : evaluationSettingsSchema.parse({ enabled: false });
  }
  configure(owner: string, agent: string, value: EvaluationSettings): void {
    this.store
      .prepare(
        'INSERT INTO model_evaluation_settings VALUES(?,?,?) ON CONFLICT(owner,agent) DO UPDATE SET payload=excluded.payload',
      )
      .run(owner, agent, JSON.stringify(evaluationSettingsSchema.parse(value)));
  }
  enabled(): { owner: string; agent: string }[] {
    return this.store
      .prepare('SELECT owner,agent,payload FROM model_evaluation_settings')
      .all()
      .filter((row) => JSON.parse(String(row.payload)).enabled === true)
      .map((row) => ({ owner: String(row.owner), agent: String(row.agent) }));
  }
  samples(
    owner: string,
    agent: string,
    revision: string,
    route: string,
    epoch?: number,
  ): EvaluationSample[] {
    return this.store
      .prepare(
        `SELECT payload FROM model_evaluation_samples WHERE owner=? AND agent=? AND revision=? AND route=?${epoch === undefined ? '' : ' AND epoch=?'} ORDER BY started_at DESC LIMIT 256`,
      )
      .all(owner, agent, revision, route, ...(epoch === undefined ? [] : [epoch]))
      .map((row) => JSON.parse(String(row.payload)) as EvaluationSample);
  }
  save(sample: EvaluationSample): void {
    this.store
      .prepare(
        'INSERT INTO model_evaluation_samples VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,agent,revision,route,epoch,case_id) DO UPDATE SET payload=excluded.payload',
      )
      .run(
        sample.owner,
        sample.agent,
        sample.revision,
        sample.route,
        sample.epoch,
        sample.caseId,
        sample.runId,
        sample.startedAt,
        JSON.stringify(sample),
      );
  }
  callsToday(owner: string, agent: string, now = Date.now()): number {
    return Number(
      this.store
        .prepare(
          'SELECT count(*) AS n FROM model_evaluation_samples WHERE owner=? AND agent=? AND started_at>=?',
        )
        .get(owner, agent, Math.floor(now / 86_400_000) * 86_400_000)!.n,
    );
  }
  feedback(sample: EvaluationSample) {
    this.store
      .prepare(
        'INSERT INTO model_feedback VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,run_id) DO UPDATE SET agent=excluded.agent,revision=excluded.revision,route=excluded.route,payload=excluded.payload,updated_at=excluded.updated_at',
      )
      .run(
        sample.owner,
        sample.agent,
        sample.revision,
        sample.route,
        sample.runId,
        JSON.stringify(sample),
        Date.now(),
      );
  }
  performance(
    owner: string,
    agent: string,
    revision: string,
    route: string,
  ): ModelPerformance | undefined {
    const feedback = this.store
      .prepare(
        'SELECT payload FROM model_feedback WHERE owner=? AND agent=? AND revision=? AND route=? ORDER BY updated_at DESC LIMIT 32',
      )
      .all(owner, agent, revision, route)
      .map((row) => JSON.parse(String(row.payload)) as EvaluationSample);
    const rows = [...this.samples(owner, agent, revision, route), ...feedback]
      .filter(
        (s) => s.finishedAt !== undefined && !s.error && s.finishedAt > Date.now() - 7 * 86_400_000,
      )
      .sort((a, b) => b.finishedAt! - a.finishedAt!)
      .slice(0, 32);
    if (!rows.length) return undefined;
    const dimensions: ModelPerformance['dimensions'] = {};
    for (const row of rows) {
      const d = (dimensions[row.dimension] ??= { samples: 0, passed: 0, score: 0 });
      d.samples++;
      d.passed += row.passed ? 1 : 0;
      d.score = d.passed / d.samples;
    }
    const passed = rows.filter((s) => s.passed).length;
    const timed = rows.filter((s) => s.elapsedMs && s.elapsedMs > 0);
    return {
      suite: EVALUATION_SUITE,
      revision,
      samples: rows.length,
      passed,
      score: passed / rows.length,
      averageMs: timed.length ? timed.reduce((n, r) => n + r.elapsedMs!, 0) / timed.length : 1000,
      sources: {
        benchmark: rows.filter((s) => !s.caseId.startsWith('human:')).length,
        feedback: rows.filter((s) => s.caseId.startsWith('human:')).length,
      },
      observedAt: Math.max(...rows.map((r) => r.finishedAt!)),
      dimensions,
    };
  }
}
