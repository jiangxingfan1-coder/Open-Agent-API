import type { Store } from '../store/store.js';
import type { GatewayConfig } from '../config/config.js';
import { principalSubject, type Principal } from '../core/contracts.js';
import { Fault } from '../core/util.js';

/**
 * Optional per-caller cap on stored file bytes (`maxStoredBytesPerSubject`), checked before an
 * upload is written. Artifacts that agents write are counted but never refused, so a run cannot
 * fail on its own output. Unset limit: no check (the default).
 */
export function assertUploadRoom(
  store: Store,
  config: Pick<GatewayConfig, 'maxStoredBytesPerSubject'>,
  p: Principal,
  incoming: number,
): void {
  const limit = config.maxStoredBytesPerSubject;
  if (limit === undefined) return;
  const row = store.db
    .prepare(
      "SELECT coalesce(sum(json_extract(payload,'$.bytes')),0) AS used FROM files WHERE owner=? AND subject=?",
    )
    .get(p.owner, principalSubject(p));
  if (Number(row?.used ?? 0) + incoming > limit)
    throw new Fault(
      'storage_quota_exceeded',
      `This caller may store at most ${limit} bytes of files.`,
      413,
    );
}
