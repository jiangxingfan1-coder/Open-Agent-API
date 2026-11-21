import type { Store } from '../store/store.js';
import { Fault } from '../core/util.js';
import { UploadWaitBudget, type UploadPolicy } from '../store/upload-budget.js';

type Flight = { guards: Set<() => void>; file: Promise<string> };
const staging = new WeakMap<Store, Map<string, Flight>>();
const joiners = new WeakMap<Store, UploadWaitBudget>();
const key = (owner: string, subject: string, digest: string) =>
  JSON.stringify([owner, subject, digest]);
export function stagingCopy(store: Store, owner: string, subject: string, digest: string) {
  return staging.get(store)?.has(key(owner, subject, digest)) ?? false;
}
/** Share only the private materialization, not a run, its grants or its acceptance. */
export async function stageImage(
  store: Store,
  owner: string,
  subject: string,
  digest: string,
  name: string,
  bytes: Buffer,
  policy: UploadPolicy,
  held: string[],
) {
  let pool = staging.get(store);
  if (!pool) staging.set(store, (pool = new Map()));
  const id = key(owner, subject, digest),
    check = () => policy.guard?.();
  check();
  let flight = pool.get(id);
  let leave: (() => void) | undefined;
  if (!flight) {
    const guards = new Set([check]);
    const guard = () => {
      let failure: unknown;
      for (const check of guards) {
        try {
          check();
          return;
        } catch (e) {
          failure = e;
        }
      }
      throw failure ?? new Fault('request_cancelled', 'No caller is waiting for this image.', 499);
    };
    const file = store
      .addFile(owner, name, bytes, undefined, undefined, subject, { ...policy, guard })
      .then((f) => f.id)
      .finally(() => pool.delete(id));
    flight = { guards, file };
    pool.set(id, flight);
  } else {
    let budget = joiners.get(store);
    if (!budget) joiners.set(store, (budget = new UploadWaitBudget()));
    leave = budget.take(owner, bytes.length);
    flight.guards.add(check);
  }
  try {
    const file = await flight.file;
    held.push(...store.provisionalInputs.hold(owner, [file]));
    check();
    return file;
  } finally {
    flight.guards.delete(check);
    leave?.();
  }
}
