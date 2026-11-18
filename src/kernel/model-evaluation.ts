import type { Kernel } from './kernel.js';
import type { Principal } from '../core/contracts.js';
import type { NodeHub } from '../fabric/network.js';
import { ModelEvaluations, type EvaluationSample } from '../store/model-evaluations.js';
import type { Store } from '../store/store.js';
import { discoveredAgent, refreshAgentModels, supportsReasoning } from '../fabric/model-pool.js';
import {
  EVALUATION_DIMENSIONS,
  EVALUATION_SUITE,
  evaluationCases,
  scoreEvaluation,
  type EvaluationSettings,
} from '../core/model-evaluation.js';
import { sha, faultOf, Fault } from '../core/util.js';
import { invocationSchema } from './invocation.js';
import { modelIdentity } from '../fabric/model-identity.js';

/** Includes executable/catalog identity, but never stores credentials or task text in results. */
export const evaluationRevision = modelIdentity;

/** One bounded background lane; user tasks always retain priority over evaluation work. */
export class ModelEvaluator {
  readonly records: ModelEvaluations;
  private pending = new Map<string, Promise<void>>();
  private closed = false;
  private timer: NodeJS.Timeout;
  private active?: { principal: Principal; runId: string };
  private changed = () => {
    void this.tick().catch(() => {});
  };
  constructor(
    private readonly store: Store,
    private readonly hub: NodeHub,
    private readonly kernel: Kernel,
    private readonly backgroundEnabled = true,
    private readonly backgroundOwner?: string,
  ) {
    this.records = new ModelEvaluations(store);
    kernel.router.evidence = (owner, agent, digest) => {
      const stored = this.store.bundle(owner, agent.id, digest).agent;
      const revision = evaluationRevision(hub, owner, discoveredAgent(hub, owner, stored));
      return new Map(
        kernel.router.choices(agent).flatMap((route) => {
          const result = this.records.performance(owner, agent.id, revision, route.id);
          return result ? [[route.id, result] as const] : [];
        }),
      );
    };
    this.timer = setInterval(() => void this.tick().catch(() => {}), 60_000).unref();
    store.events.on('catalog', this.changed);
    hub.events.on('change', this.changed);
  }
  definition(owner: string, id: string) {
    const bundle = this.store.bundle(owner, id);
    const agent = discoveredAgent(this.hub, owner, bundle.agent);
    return { agent, revision: evaluationRevision(this.hub, owner, agent) };
  }
  view(owner: string, id: string) {
    const { agent, revision } = this.definition(owner, id);
    return {
      agent: id,
      revision,
      suite: EVALUATION_SUITE,
      dimensions: [...EVALUATION_DIMENSIONS],
      settings: this.records.settings(owner, id),
      running: this.pending.has(`${owner}\n${id}`),
      supported: supportsReasoning(this.hub, owner, agent),
      routes: this.kernel.router.choices(agent).map((route) => ({
        id: route.id,
        model: route.model,
        performance: this.records.performance(owner, id, revision, route.id) ?? null,
        last_error: this.records.samples(owner, id, revision, route.id)[0]?.error ?? null,
      })),
    };
  }
  configure(owner: string, id: string, settings: EvaluationSettings) {
    const { agent } = this.definition(owner, id);
    if (settings.enabled && !supportsReasoning(this.hub, owner, agent))
      throw new Fault(
        'capability_unavailable',
        'This engine cannot safely run tool-free evaluations yet.',
        503,
      );
    this.records.configure(owner, id, settings);
    if (settings.enabled) void this.run(owner, id).catch(() => {});
    else if (this.active?.principal.owner === owner && this.active.principal.agents.includes(id))
      void this.kernel.cancel(this.active.principal, this.active.runId).catch(() => {});
    return this.view(owner, id);
  }
  private async tick() {
    if (
      !this.backgroundEnabled ||
      this.closed ||
      this.pending.size ||
      this.kernel.stats().active > 0 ||
      this.kernel.stats().queued > 0
    )
      return;
    for (const entry of this.records.enabled()) {
      if (this.backgroundOwner && entry.owner !== this.backgroundOwner) continue;
      if (this.closed) break;
      await this.run(entry.owner, entry.agent).catch(() => {});
    }
  }
  run(owner: string, id: string): Promise<void> {
    if (this.backgroundOwner && owner !== this.backgroundOwner)
      return Promise.reject(
        new Fault('scope_denied', 'Evaluation does not belong to this local owner.', 403),
      );
    const key = `${owner}\n${id}`;
    const prior = this.pending.get(key);
    if (prior) return prior;
    if (this.closed)
      return Promise.reject(new Fault('shutting_down', 'Evaluation is closed.', 503));
    if (!this.backgroundEnabled)
      return Promise.reject(
        new Fault('scope_denied', 'Background evaluations are disabled in this gateway.', 403),
      );
    if (this.pending.size)
      return Promise.reject(
        new Fault('concurrency_limit', 'Another model evaluation is running.', 429),
      );
    const work = this.evaluate(owner, id).finally(() => {
      this.pending.delete(key);
      this.kernel.router.observer?.(owner);
    });
    this.pending.set(key, work);
    return work;
  }
  private async evaluate(owner: string, id: string) {
    const settings = this.records.settings(owner, id);
    if (!settings.enabled)
      throw new Fault('scope_denied', 'Enable model evaluation before starting model calls.', 403);
    await refreshAgentModels(this.hub, owner, this.store.bundle(owner, id).agent.engine);
    const { agent, revision } = this.definition(owner, id);
    if (!supportsReasoning(this.hub, owner, agent))
      throw new Fault(
        'capability_unavailable',
        'This engine has not verified tool-free evaluation support.',
        503,
      );
    const epoch = Math.floor(Date.now() / (settings.intervalHours * 3_600_000));
    const cases = evaluationCases(`${id}:${revision}:${epoch}`);
    const principal: Principal = {
      name: 'model-evaluator',
      owner,
      subject: `evaluation:${id}`,
      agents: [id],
      scopes: ['invoke', 'read', 'files'],
      execution: 'host',
    };
    const routes = [...this.kernel.router.choices(agent)].sort((a, b) => {
      const left = this.records.performance(owner, id, revision, a.id)?.observedAt ?? 0;
      const right = this.records.performance(owner, id, revision, b.id)?.observedAt ?? 0;
      return left - right || a.priority - b.priority || a.id.localeCompare(b.id);
    });
    for (const route of routes) {
      const existing = new Map(
        this.records
          .samples(owner, id, revision, route.id, epoch)
          .map((sample) => [sample.caseId, sample]),
      );
      for (const sample of cases) {
        if (this.closed || !this.records.settings(owner, id).enabled) return;
        const before = existing.get(sample.id);
        if (before?.finishedAt) continue;
        if (
          !before &&
          this.records.callsToday(owner, id) >= this.records.settings(owner, id).maxCallsPerDay
        )
          return;
        if (!before && (this.kernel.stats().active > 0 || this.kernel.stats().queued > 0)) return;
        let row: EvaluationSample | undefined = before;
        try {
          // Reattach after a gateway restart; never replay an uncertain external call.
          const run = before
            ? this.store.run(before.runId, owner)
            : this.kernel.submit(
                principal,
                invocationSchema.parse({
                  agent: id,
                  model: route.id,
                  input: sample.prompt,
                  background: true,
                  metadata: {
                    'oaa.tools_disabled': 'true',
                    'oaa.evaluation': EVALUATION_SUITE,
                    'oaa.orchestration_child': 'true',
                  },
                }),
                `${EVALUATION_SUITE}:${sha(`${id}:${revision}:${route.id}:${epoch}:${sample.id}`)}`,
              );
          row = before ?? {
            owner,
            agent: id,
            revision,
            route: route.id,
            epoch,
            caseId: sample.id,
            dimension: sample.dimension,
            runId: run.id,
            startedAt: Date.now(),
          };
          this.records.save(row);
          this.active = { principal, runId: run.id };
          const timeout = AbortSignal.timeout(120_000);
          const result = await this.kernel.wait(run.id, true, timeout).catch(async (error) => {
            await this.kernel.cancel(principal, run.id).catch(() => {});
            throw error;
          });
          if (result.status === 'requires_action') await this.kernel.cancel(principal, run.id);
          row.finishedAt = Date.now();
          row.elapsedMs = row.finishedAt - row.startedAt;
          row.passed =
            result.status === 'completed' &&
            scoreEvaluation(sample, result.output.map((m) => m.text).join(''));
          if (result.status !== 'completed') row.error = result.error?.code ?? result.status;
          this.records.save(row);
        } catch (error) {
          const failed = row ?? {
            owner,
            agent: id,
            revision,
            route: route.id,
            epoch,
            caseId: sample.id,
            dimension: sample.dimension,
            runId: '',
            startedAt: Date.now(),
          };
          this.records.save({
            ...failed,
            finishedAt: Date.now(),
            elapsedMs: Date.now() - failed.startedAt,
            passed: false,
            error: faultOf(error).code,
          });
          break;
        } finally {
          this.active = undefined;
        }
      }
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.store.events.off('catalog', this.changed);
    this.hub.events.off('change', this.changed);
    if (this.active)
      await this.kernel.cancel(this.active.principal, this.active.runId).catch(() => {});
    await Promise.allSettled(this.pending.values());
    this.kernel.router.evidence = undefined;
  }
}
