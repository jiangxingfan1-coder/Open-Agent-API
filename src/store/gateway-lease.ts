import type { DatabaseSync } from 'node:sqlite';
import { Fault, id } from '../core/util.js';
import { isWriteUnavailable } from './checkpoint.js';

// A PID alone cannot distinguish two connections or worker threads in the same process.
// Only this module instance can attest that one of its own connections has actually closed.
const namespace = id('gateway') + ':';
const open = new Set<string>();
export class GatewayLease {
  readonly id = namespace + id('lease');
  claim(db: DatabaseSync) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS gateway_owner (slot INTEGER PRIMARY KEY CHECK(slot=1),pid INTEGER NOT NULL,lease_id TEXT NOT NULL)',
    );
    if (hasLiveLease(db))
      throw new Fault(
        'gateway_already_running',
        'Another gateway owns this data directory. Use its API or a different data directory.',
        409,
      );
    db.prepare(
      'INSERT INTO gateway_owner VALUES(1,?,?) ON CONFLICT(slot) DO UPDATE SET pid=excluded.pid,lease_id=excluded.lease_id',
    ).run(process.pid, this.id);
  }
  acquired() {
    open.add(this.id);
  }
  close(db: DatabaseSync) {
    try {
      db.prepare('DELETE FROM gateway_owner WHERE slot=1 AND lease_id=?').run(this.id);
    } catch (error) {
      if (!isWriteUnavailable(error)) throw error;
      process.emitWarning('The database closed without clearing its gateway lease.', {
        code: 'OAA_STORE_LEASE',
      });
    } finally {
      db.close();
      open.delete(this.id);
    }
  }
}
export function hasLiveLease(db: DatabaseSync): boolean {
  const previous = db.prepare('SELECT pid,lease_id FROM gateway_owner WHERE slot=1').get();
  if (!previous) return false;
  const pid = Number(previous.pid),
    lease = String(previous.lease_id);
  if (pid === process.pid && lease.startsWith(namespace)) return open.has(lease);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  return true;
}
