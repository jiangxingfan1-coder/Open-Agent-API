import type { Store } from '../store/store.js';
import type { GatewayConfig } from '../config/config.js';
import { principalSubject, type Principal } from '../core/contracts.js';
import { checkUploadRoom } from '../store/upload-budget.js';

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
  checkUploadRoom(store, p.owner, principalSubject(p), incoming, config.maxStoredBytesPerSubject);
}
