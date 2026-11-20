import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';

export const pruneChannel = channel('oaa.retention.prune');
type Phase =
  | 'candidate'
  | 'begin'
  | 'delete'
  | 'commit'
  | 'yield'
  | 'files'
  | 'unlink'
  | 'sweep'
  | 'checkpoint';
/** Aggregate timings only; no task IDs, paths, credentials or content on this channel. */
export class PruneProfile {
  readonly ms: Record<Phase, number> = {
    candidate: 0,
    begin: 0,
    delete: 0,
    commit: 0,
    yield: 0,
    files: 0,
    unlink: 0,
    sweep: 0,
    checkpoint: 0,
  };
  readonly start = performance.now();
  readonly startedAt = Date.now();
  batches = 0;
  maxRunBatchMs = 0;
  lockRetries = 0;
  sqlite?: { page_size: number; pages: number; free_pages: number; cache_setting: number };
  checkpoint?: { mode: string; busy: number; log: number; checkpointed: number };
  add(phase: Phase, since: number) {
    this.ms[phase] += performance.now() - since;
  }
  sampleDatabase(db: DatabaseSync) {
    try {
      const row = db
        .prepare(
          'SELECT page_size,page_count,freelist_count,cache_size FROM pragma_page_size,pragma_page_count,pragma_freelist_count,pragma_cache_size',
        )
        .get()!;
      this.sqlite = {
        page_size: Number(row.page_size),
        pages: Number(row.page_count),
        free_pages: Number(row.freelist_count),
        cache_setting: Number(row.cache_size),
      };
    } catch {
      /* Optional accounting must not change maintenance results. */
    }
  }
  finish(scope: string, queueMs: number, ok: boolean) {
    pruneChannel.publish({
      scope,
      started_at: this.startedAt,
      elapsed_ms: performance.now() - this.start,
      queue_ms: queueMs,
      phase_ms: this.ms,
      run_batches: this.batches,
      max_run_batch_ms: this.maxRunBatchMs,
      lock_retries: this.lockRetries,
      checkpoint: this.checkpoint,
      sqlite: this.sqlite,
      ok,
    });
  }
}
