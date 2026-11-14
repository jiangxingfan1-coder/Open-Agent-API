import type { ToolResult } from '../core/contracts.js';
import { LIMITS } from '../core/limits.js';

type Entry = { until: number; value: ToolResult; bytes: number };

/** Process-local read cache. A write fences both existing entries and in-flight fills. */
export class ToolCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private generation = 0;
  private writes = 0;

  constructor(
    private readonly maxEntries: number = LIMITS.toolCacheEntries,
    private readonly maxBytes: number = LIMITS.toolCacheBytes,
    private readonly now = Date.now,
  ) {}

  invalidate(): void {
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
  }

  beginWrite(): () => void {
    this.writes++;
    this.invalidate();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.writes--;
      this.invalidate();
    };
  }

  beginRead(): number | undefined {
    return this.writes ? undefined : this.generation;
  }

  get(key: string): ToolResult | undefined {
    if (this.writes) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.remove(key);
    if (entry.until <= this.now()) return undefined;
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    return structuredClone(entry.value);
  }

  set(key: string, value: ToolResult, ttl: number, generation: number | undefined): void {
    if (generation === undefined || generation !== this.generation || this.writes || ttl <= 0)
      return;
    let bytes: number;
    let copy: ToolResult;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key);
      if (bytes > this.maxBytes || this.maxEntries < 1) return;
      copy = structuredClone(value);
    } catch {
      // Caching is optional and must not turn a committed tool result into a failed step.
      return;
    }
    this.remove(key);
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.until <= now) this.remove(id);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes)
      this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { until: now + ttl, value: copy, bytes });
    this.bytes += bytes;
  }

  private remove(key: string): void {
    const previous = this.entries.get(key);
    if (!previous) return;
    this.entries.delete(key);
    this.bytes -= previous.bytes;
  }
}
