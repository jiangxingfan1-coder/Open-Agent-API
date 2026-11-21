import { terminal, type Run } from '../core/contracts.js';
import { sleep } from '../core/util.js';
import { isWriteContended, isWriteUnavailable } from '../store/checkpoint.js';
import type { KernelRuntime } from './runtime.js';

/** Retry local persistence, never the model, tool or scheduler that produced the outcome. */
export async function commitTerminal(
  rt: KernelRuntime,
  run: Run,
  signal: AbortSignal,
  write: (sawStorageOutage: boolean) => void,
  unavailable: (e: unknown) => boolean,
): Promise<boolean> {
  let retry = false;
  let sawStorageOutage = false;
  let lockDelay = 20;
  for (;;) {
    try {
      if (retry) {
        // A storage error may have been reported after the commit became durable.
        const saved = rt.store.run(run.id);
        if (terminal(saved.status)) {
          Object.assign(run, saved);
          return true;
        }
      }
      write(sawStorageOutage);
      return true;
    } catch (error) {
      if (!unavailable(error)) throw error;
      sawStorageOutage ||= isWriteUnavailable(error);
      if (rt.closing()) return false;
      if (!retry)
        process.emitWarning(
          'Run terminal checkpoint delayed; only the local write will be retried.',
          { code: 'OAA_CHECKPOINT_RETRY' },
        );
      retry = true;
      const delay = isWriteContended(error) ? lockDelay : 1000;
      lockDelay = Math.min(1000, lockDelay * 2);
      await sleep(delay, signal.aborted ? undefined : signal).catch(() => {});
    }
  }
}
