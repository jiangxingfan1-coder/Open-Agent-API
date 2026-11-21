import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import {
  chargeCursor,
  readUsagePage,
  type UsageResume,
  type UsagePrefix,
} from './upload-usage-page.js';
import { withSavepoint } from './savepoint.js';
import { FileScopeLayoutChanged } from './file-scope-index.js';
export { readUsagePage } from './upload-usage-page.js';
import {
  acceptColdTotal,
  changingUploadTotal,
  currentColdTotal,
  discardColdTotal,
  needsColdTotal,
  startColdTotal,
  type UploadUsageStore,
} from './upload-usage.js';

/** One bounded slice per event-loop turn across all jobs. No cursor, read transaction or
 * writer lock is kept on the shared connection while another request can run. */
export class UploadRecounts {
  private lane: Promise<void> = Promise.resolve();
  private slice<T>(step: () => T): Promise<T> {
    const next = this.lane.then(async () => {
      await yieldTurn();
      return step();
    });
    this.lane = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  async fill(
    store: UploadUsageStore,
    owner: string,
    subject: string,
    guard: () => void,
    handoff?: { scan: string; prefix: UsagePrefix },
  ) {
    const scope = { owner, subject };
    for (let attempt = 0; attempt < (handoff ? 4 : 3); attempt++) {
      const inherited = attempt === 0 ? handoff : undefined,
        id = inherited?.scan ?? randomUUID();
      let cursor: UsageResume | undefined = inherited?.prefix.next,
        grand = inherited?.prefix.bytes ?? 0,
        width = 256,
        registered = !!inherited,
        accepted = false;
      try {
        for (;;) {
          const result = await this.slice(() => {
            guard();
            if (store.db.isTransaction) return 'changed';
            if (!registered) {
              if (!needsColdTotal(store, owner, subject)) return 'done';
              startColdTotal(store, owner, subject, id);
              registered = true;
            } else if (!currentColdTotal(store, owner, subject, id)) return 'changed';
            const at = performance.now();
            // Keep the schema check and index seek in one snapshot, never across a yield.
            let page: ReturnType<typeof readUsagePage>;
            try {
              page = withSavepoint(store.db, () => readUsagePage(store, scope, width, cursor));
            } catch (error) {
              if (error instanceof FileScopeLayoutChanged) return 'changed';
              throw error;
            }
            const ms = performance.now() - at;
            // Spend part of the narrower index's throughput on more frequent yields
            // when a degraded recount has to share the gateway's event loop.
            const budget = page.next && chargeCursor(page.next) ? 1 : 2;
            width =
              ms > budget
                ? Math.max(32, width / 2)
                : ms < budget / 2
                  ? Math.min(4096, width * 2)
                  : width;
            const total = page.bytes === null ? null : grand + page.bytes;
            if (total === null || !Number.isSafeInteger(total) || !page.next) {
              accepted = acceptColdTotal(
                store,
                owner,
                subject,
                id,
                Number.isSafeInteger(total) ? total : null,
              );
              return accepted ? 'done' : 'changed';
            }
            grand = total;
            cursor = page.next;
            return 'more';
          });
          if (result === 'done') return;
          if (result === 'changed') break;
        }
      } finally {
        if (registered && !accepted) discardColdTotal(store, owner, subject, id);
      }
    }
    // Never replace a repeatedly invalidated partial sum with a guess or a blocking
    // whole-account scan. No upload has been reserved; the caller may retry.
    throw changingUploadTotal();
  }
}
