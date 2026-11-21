import type { StatementSync } from 'node:sqlite';
import { exactTotal, fileBytes, fileDigest as digest } from './upload-facts.js';

const size = fileBytes('payload'),
  order = `${digest},${size},rowid`;
type Edge = [digestHex: string | null, bytes: number, rowid: string];
type Scope = { owner: string; subject: string };
export type UsageResume = { key: Edge; from: 'ties' | 'sizes' | 'hashes' };
export type UsagePrefix = { rows: number; bytes: number; next: UsageResume };
/** A handoff is optional. Unusually large historical keys stay inside the reader. */
export function transferablePrefix(p: UsagePrefix | undefined): p is UsagePrefix {
  if (
    !p ||
    !Number.isSafeInteger(p.rows) ||
    p.rows <= 0 ||
    !Number.isSafeInteger(p.bytes) ||
    p.bytes < 0
  )
    return false;
  const cursor = p.next,
    key = cursor?.key;
  return (
    !!cursor &&
    ['ties', 'sizes', 'hashes'].includes(cursor.from) &&
    Array.isArray(key) &&
    key.length === 3 &&
    (key[0] === null ||
      (typeof key[0] === 'string' && key[0].length <= 512 && /^(?:[0-9A-F]{2})+$/.test(key[0]))) &&
    Number.isSafeInteger(key[1]) &&
    key[1] >= 0 &&
    typeof key[2] === 'string' &&
    /^-?\d{1,19}$/.test(key[2]) &&
    BigInt(key[2]) >= -(1n << 63n) &&
    BigInt(key[2]) < 1n << 63n
  );
}
type Page = { bytes: number | null; next?: UsageResume };

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
  store: { prepare(sql: string): StatementSync },
  scope: Scope,
  take: number,
  after?: UsageResume,
  lane: 'gateway' | 'reader' = 'gateway',
): Page {
  if (!Number.isInteger(take) || take < 1 || take > (lane === 'reader' ? 131072 : 4096))
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
      if (typeof r.edge !== 'string') return { bytes: null };
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
