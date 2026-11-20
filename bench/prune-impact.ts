import { setTimeout as delay } from 'node:timers/promises';

export function pruneLoopIntervals(lines: string, start?: number, end?: number) {
  if (start === undefined || end === undefined) return [];
  const last = new Map<number, number>();
  const intervals: { from: number; to: number; p99_ms: number; max_ms: number }[] = [];
  for (const line of lines.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as {
      pid: number;
      t: number;
      boot?: boolean;
      loop_p99_ms?: number | null;
      loop_max_ms?: number | null;
    };
    const from = last.get(row.pid);
    last.set(row.pid, row.t);
    if (
      !row.boot &&
      from !== undefined &&
      from <= end &&
      row.t >= start &&
      row.loop_p99_ms != null &&
      row.loop_max_ms != null
    )
      intervals.push({ from, to: row.t, p99_ms: row.loop_p99_ms, max_ms: row.loop_max_ms });
  }
  return intervals;
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (n: number) => (sorted.length ? sorted[Math.ceil(sorted.length * n) - 1]! : null);
  return { samples: sorted.length, p50_ms: p(0.5), p95_ms: p(0.95), p99_ms: p(0.99), max_ms: p(1) };
}

/** Windows count operations by completion time, not by start time. */
export class PruneImpact {
  private before: { t: number; ms: number }[] = [];
  private during: number[] = [];
  private after: number[] = [];
  private health: number[] = [];
  private misses = 0;
  private start?: number;
  private end?: number;
  constructor(private scheduled: number) {}
  record(ms: number, now = Date.now()) {
    if (this.start === undefined) {
      if (now >= this.scheduled - 30_000) this.before.push({ t: now, ms });
    } else if (this.end === undefined) this.during.push(ms);
    else if (now <= this.end + 30_000) this.after.push(ms);
  }
  async around(base: string, command: () => Promise<void>) {
    this.start = Date.now();
    this.before = this.before.filter((v) => v.t >= this.start! - 30_000);
    const monitor = (async () => {
      while (this.end === undefined) {
        const t = performance.now();
        try {
          const response = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) });
          await response.arrayBuffer();
          if (response.ok) this.health.push(performance.now() - t);
          else this.misses++;
        } catch {
          this.misses++;
        }
        if (this.end === undefined) await delay(50);
      }
    })();
    try {
      await command();
    } finally {
      this.end = Date.now();
      await monitor;
    }
  }
  report() {
    return {
      started_at: this.start,
      finished_at: this.end,
      cli_ms: this.end === undefined || this.start === undefined ? null : this.end - this.start,
      before_30s: distribution(this.before.map((v) => v.ms)),
      during: distribution(this.during),
      after_30s: distribution(this.after),
      health_during: { ...distribution(this.health), failures: this.misses, timeout_ms: 3000 },
    };
  }
}
