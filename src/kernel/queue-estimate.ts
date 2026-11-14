/**
 * Queue wait estimation by slot simulation.
 *
 * The earlier estimate was `(rank - free + 1) × median(all recent runs) ÷ slots`: it ignored how
 * long running work has already run and treated every agent alike. Here each execution slot gets
 * a "free at" time: running work frees its slot after its expected *residual* time (empirical mean
 * residual life: given it has run `elapsed`, how much longer did comparable runs take?), and every
 * run queued ahead takes the earliest free slot for its own agent's typical occupancy. The target
 * starts when it pops the earliest slot. O(k log m) for k runs ahead and m slots.
 *
 * Pure and deterministic: callers pass duration samples; nothing here reads clocks or storage.
 */

/** Recent slot-occupancy durations (ms) of one agent, any order. */
export type Sample = readonly number[];

export type EstimateInput = {
  slots: number;
  /** Work currently holding a slot: its agent's sample and how long it has held the slot. */
  active: readonly { sample: Sample; elapsed: number }[];
  /** Runs queued ahead of the target, in queue order: each one's agent sample. */
  ahead: readonly Sample[];
};

/** Lower bound for an overdue run's residual: it is late, so expect it soon but not instantly. */
const OVERDUE_FLOOR_MS = 250;
/** Beyond this many runs ahead the remainder is extrapolated instead of simulated one by one. */
const SIMULATE_LIMIT = 1024;

const sorted = (sample: Sample) =>
  [...sample].filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);

export function median(sample: Sample): number | null {
  const s = sorted(sample);
  return s.length ? s[(s.length - 1) >> 1]! : null;
}

/** Expected remaining time of a run that has already held its slot for `elapsed` ms. */
export function residual(sample: Sample, elapsed: number): number | null {
  const s = sorted(sample);
  if (!s.length) return null;
  let sum = 0;
  let longer = 0;
  for (const d of s)
    if (d > elapsed) {
      sum += d - elapsed;
      longer++;
    }
  if (longer) return sum / longer;
  return Math.max(OVERDUE_FLOOR_MS, s[(s.length - 1) >> 1]! * 0.25);
}

/** Binary min-heap of slot "free at" times. */
class Slots {
  private readonly heap: number[] = [];
  push(value: number): void {
    const h = this.heap;
    h.push(value);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h[parent]! <= h[i]!) break;
      [h[parent], h[i]] = [h[i]!, h[parent]!];
      i = parent;
    }
  }
  pop(): number {
    const h = this.heap;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l]! < h[m]!) m = l;
        if (r < h.length && h[r]! < h[m]!) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Milliseconds until the target run gets a slot, or null without any duration evidence.
 * A run whose agent has no sample borrows the median of all known samples.
 */
export function estimateStart(input: EstimateInput): number | null {
  const slots = Math.max(1, Math.floor(input.slots));
  // A free slot nobody ahead will take: the target starts now, whatever the evidence.
  if (input.ahead.length < slots - Math.min(slots, input.active.length)) return 0;
  const known = [...input.active.map((a) => a.sample), ...input.ahead].flat();
  const fallback = median(known);
  const typical = (sample: Sample) => median(sample) ?? fallback;
  const free = new Slots();
  const holding = input.active.slice(0, slots);
  for (const run of holding) {
    const left =
      residual(run.sample, run.elapsed) ??
      (fallback === null ? null : residual([fallback], run.elapsed));
    if (left === null) return null;
    free.push(left);
  }
  for (let i = holding.length; i < slots; i++) free.push(0);
  const simulated = input.ahead.slice(0, SIMULATE_LIMIT);
  for (const sample of simulated) {
    const duration = typical(sample);
    if (duration === null) return null;
    free.push(free.pop() + duration);
  }
  let start = free.pop();
  const rest = input.ahead.length - simulated.length;
  if (rest > 0) {
    if (fallback === null) return null;
    start += (rest * fallback) / slots;
  }
  return Math.max(0, Math.round(start));
}
