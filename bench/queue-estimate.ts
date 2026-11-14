// Queue wait estimate accuracy: slot simulation vs the earlier global-median formula.
// Deterministic discrete-event simulation (seeded); no kernel, sockets or models.
// Usage: node dist/bench/queue-estimate.js
import { estimateStart, median } from '../src/kernel/queue-estimate.js';

let seed = 0x5eed;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
// Log-normal durations around each agent's median, with realistic spread.
const agents = [
  { name: 'fast', median: 2_000, share: 0.6 },
  { name: 'medium', median: 8_000, share: 0.3 },
  { name: 'slow', median: 30_000, share: 0.1 },
];
const draw = (median: number) => Math.round(median * Math.exp(0.45 * gauss()));
const pick = () => {
  let r = rand();
  for (const a of agents) if ((r -= a.share) <= 0) return a;
  return agents[0]!;
};

function simulate(load: number) {
  seed = 0x5eed;
  type Job = { id: number; agent: string; duration: number; arrival: number; start?: number };
  const SLOTS = 4;
  const JOBS = 4000;
  // Mean service ≈ 0.6·2 + 0.3·8 + 0.1·30 ≈ 6.6 s; arrivals slightly above capacity in bursts.
  const meanGap = 6_600 / SLOTS / load;

  const history = new Map<string, number[]>();
  const allHistory: number[] = [];
  const remember = (job: Job) => {
    const h = history.get(job.agent) ?? [];
    h.push(job.duration);
    if (h.length > 50) h.shift();
    history.set(job.agent, h);
    allHistory.push(job.duration);
    if (allHistory.length > 50) allHistory.shift();
  };

  const queue: Job[] = [];
  const running: Job[] = [];
  const predictions: { job: Job; old: number | null; next: number | null }[] = [];
  let clock = 0;
  let nextArrival = 0;
  let created = 0;
  const finishes = () => running.map((j) => j.start! + j.duration);

  while (created < JOBS || queue.length || running.length) {
    const nextFinish = running.length ? Math.min(...finishes()) : Infinity;
    if (created < JOBS && nextArrival <= nextFinish) {
      clock = nextArrival;
      const a = pick();
      const job: Job = { id: created++, agent: a.name, duration: draw(a.median), arrival: clock };
      queue.push(job);
      const index = queue.length - 1;
      const free = SLOTS - running.length;
      if (index >= free) {
        // Earlier formula: (rank − free + 1) × median(recent runs, all agents) ÷ slots.
        const typical = median(allHistory);
        const old = typical === null ? null : ((index - free + 1) * typical) / SLOTS;
        const next = estimateStart({
          slots: SLOTS,
          active: running.map((r) => ({
            sample: history.get(r.agent) ?? [],
            elapsed: clock - r.start!,
          })),
          ahead: queue.slice(0, index).map((q) => history.get(q.agent) ?? []),
        });
        if (job.id > 200) predictions.push({ job, old, next });
      }
      nextArrival = clock - meanGap * Math.log(rand() || 1e-9);
    } else {
      clock = nextFinish;
      const i = running.findIndex((j) => j.start! + j.duration === nextFinish);
      remember(running.splice(i, 1)[0]!);
    }
    while (running.length < SLOTS && queue.length) {
      const job = queue.shift()!;
      job.start = clock;
      running.push(job);
    }
  }

  const errors = (key: 'old' | 'next') => {
    const abs: number[] = [];
    const rel: number[] = [];
    for (const p of predictions) {
      const value = p[key];
      if (value === null) continue;
      const actual = p.job.start! - p.job.arrival;
      abs.push(Math.abs(value - actual));
      if (actual > 1_000) rel.push(Math.abs(value - actual) / actual);
    }
    const sorted = (v: number[]) => [...v].sort((a, b) => a - b);
    const q = (v: number[], f: number) => sorted(v)[Math.floor((v.length - 1) * f)]!;
    return {
      samples: abs.length,
      mae_ms: Math.round(abs.reduce((s, x) => s + x, 0) / abs.length),
      median_abs_error_ms: Math.round(q(abs, 0.5)),
      p90_abs_error_ms: Math.round(q(abs, 0.9)),
      median_relative_error: Number(q(rel, 0.5).toFixed(3)),
    };
  };
  const old = errors('old');
  const next = errors('next');
  return {
    arrival_load: load,
    global_median_formula: old,
    slot_simulation: next,
    mae_reduction_percent: Number((((old.mae_ms - next.mae_ms) / old.mae_ms) * 100).toFixed(1)),
  };
}
console.log(
  JSON.stringify(
    {
      workload: { slots: 4, jobs: 4000, agents, seed: '0x5eed' },
      evidence: 'deterministic discrete-event simulation; no kernel, sockets or models',
      runs: [0.7, 0.85, 1.05].map(simulate),
    },
    null,
    2,
  ),
);
