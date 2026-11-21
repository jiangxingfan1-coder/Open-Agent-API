import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Fault } from '../core/util.js';
import { exactTotal, fileBytes, fileDigest as digest } from './upload-facts.js';
import {
  acceptColdTotal,
  changingUploadTotal,
  currentColdTotal,
  discardColdTotal,
  needsColdTotal,
  startColdTotal,
  type UploadUsageStore,
} from './upload-usage.js';

const size = fileBytes('payload'),
  order = `${digest},${size},rowid`;
type Edge = [digestHex: string | null, bytes: number, rowid: string];
type Scope = { owner: string; subject: string };
type Resume = { key: Edge; from: 'ties' | 'sizes' | 'hashes' };
type Page = { bytes: number | null; next?: Resume };

function pageQuery(filter: string, sort: string) {
  const from = `FROM main.files INDEXED BY file_upload_facts WHERE owner=:owner AND subject=:subject ${filter} ORDER BY ${sort}`;
  // Both branches use the same snapshot. OFFSET only looks within the current bounded
  // page, never through the history already counted. Keep the signed 64-bit rowid exact.
  return `SELECT count(*) AS rows,${exactTotal('n')} AS bytes,
    CASE WHEN count(*)=:take THEN (SELECT json_group_array(
      json_array(nullif(hex(d),''),n,CAST(rid AS TEXT)) ORDER BY d COLLATE BINARY,n,rid) FROM
      (SELECT ${digest} AS d,${size} AS n,rowid AS rid ${from} LIMIT 2 OFFSET (:take-1))) END AS edge
    FROM (SELECT ${size} AS n ${from} LIMIT :take)`;
}
// Bind the exact stored bytes as TEXT. Unary + preserves the value but removes the
// CAST's affinity; otherwise SQLite cannot seek this expression index.
const boundHash = '+CAST(:hash AS TEXT)';
const first = pageQuery('', order),
  ties = pageQuery(
    `AND ${digest} IS ${boundHash} AND ${size}=:size AND rowid>CAST(:rid AS INTEGER)`,
    'rowid',
  ),
  sizes = pageQuery(`AND ${digest} IS ${boundHash} AND ${size}>:size`, `${size},rowid`),
  hashes = pageQuery(`AND ${digest}>${boundHash}`, order);

// Scalar seeks keep all three continuation ranges indexable, including NULL digests,
// restricted artifacts, and arbitrarily many equal digest/size pairs.
export function readUsagePage(
  store: Pick<UploadUsageStore, 'prepare'>,
  scope: Scope,
  take: number,
  after?: Resume,
): Page {
  if (!Number.isInteger(take) || take < 1 || take > 4096)
    throw new RangeError('Invalid file usage page size.');
  const hash = after?.key[0] ? Buffer.from(after.key[0], 'hex') : null;
  const ranges: [string, Record<string, string | number | Uint8Array | null>][] = [];
  if (!after) ranges.push([first, {}]);
  else {
    if (after.from === 'ties') ranges.push([ties, { hash, size: after.key[1], rid: after.key[2] }]);
    if (after.from !== 'hashes') ranges.push([sizes, { hash, size: after.key[1] }]);
    ranges.push([hashes, { hash: hash ?? '' }]);
  }
  let bytes = 0;
  for (const [sql, args] of ranges) {
    const r = store.prepare(sql).get({ ...scope, ...args, take })!;
    if (typeof r.bytes !== 'number' || !Number.isSafeInteger(bytes + r.bytes))
      return { bytes: null };
    bytes += r.bytes;
    take -= Number(r.rows);
    if (!take) {
      if (typeof r.edge !== 'string')
        throw new Fault('persistence_failed', 'Cannot resume the file usage query.', 500);
      const [key, peek] = JSON.parse(r.edge) as [Edge, Edge?];
      // A lookahead avoids seeking both exhausted prefixes for every page of unique hashes.
      // Recompute from the last counted row, never count the lookahead itself.
      if (!peek && (sql === first || sql === hashes)) return { bytes };
      const from = peek
        ? key[0] !== peek[0]
          ? 'hashes'
          : key[1] !== peek[1]
            ? 'sizes'
            : 'ties'
        : sql === ties
          ? 'sizes'
          : 'hashes';
      return { bytes, next: { key, from } };
    }
  }
  return { bytes };
}

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
  async fill(store: UploadUsageStore, owner: string, subject: string, guard: () => void) {
    const scope = { owner, subject };
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = randomUUID();
      let cursor: Resume | undefined,
        grand = 0,
        width = 256,
        registered = false,
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
            const at = performance.now(),
              page = readUsagePage(store, scope, width, cursor);
            const ms = performance.now() - at;
            width = ms > 2 ? Math.max(32, width / 2) : ms < 1 ? Math.min(4096, width * 2) : width;
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
