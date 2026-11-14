// Open Agent API brand mark — the single source of geometry for every logo asset.
//
// "A2 interlock": the letters O and A drawn as one thin line and linked like two
// chain rings. The O is Open (one open protocol entry), the A is Agent / API.
// The A's left leg passes over the O at the top and under it at the bottom, the
// same open crossing as the Möbius line of the Possibility mark, so the two
// products read as one family: thin black line, round caps, white rounded tile.
//
// Coordinates use the 256 tile grid of the Possibility app icon. Pure Node
// (zlib only), no image dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const r2 = (n) => Math.round(n * 100) / 100;

export const STROKE = 8; // Possibility icon stroke on the 256 grid
export const TILE = { inset: 4, size: 248, radius: 56, grid: 256 };

/** Mark construction on the 256 grid; `gap` is the clear path length each side of an under-crossing. */
export function markGeometry({ gap = 19 } = {}) {
  const O = { cx: 100, cy: 132, r: 50 };
  const apex = [154, 58];
  const footY = 216;
  const footL = [apex[0] + (-58 / 148) * (footY - apex[1]), footY];
  const footR = [apex[0] + (56 / 148) * (footY - apex[1]), footY];
  // Where the left leg crosses the O.
  const d = [footL[0] - apex[0], footL[1] - apex[1]];
  const m = [apex[0] - O.cx, apex[1] - O.cy];
  const qa = d[0] ** 2 + d[1] ** 2;
  const qb = 2 * (m[0] * d[0] + m[1] * d[1]);
  const qc = m[0] ** 2 + m[1] ** 2 - O.r ** 2;
  const root = Math.sqrt(qb * qb - 4 * qa * qc);
  const t1 = (-qb - root) / (2 * qa);
  const t2 = (-qb + root) / (2 * qa);
  const L = Math.sqrt(qa);
  const u = [d[0] / L, d[1] / L];
  const at = (t) => [apex[0] + d[0] * t, apex[1] + d[1] * t];
  const upper = at(t1);
  const lower = at(t2);
  // Weave: the leg passes under the O at the lower crossing, over it at the upper one.
  const legStop = [lower[0] - u[0] * gap, lower[1] - u[1] * gap];
  const legResume = [lower[0] + u[0] * gap, lower[1] + u[1] * gap];
  const cut = Math.atan2(upper[1] - O.cy, upper[0] - O.cx);
  const arcFrom = cut + gap / O.r;
  const arcTo = cut - gap / O.r + 2 * Math.PI;
  // Centre the whole mark in the tile.
  const xs = [footL[0], footR[0], O.cx - O.r, O.cx + O.r];
  const ys = [apex[1], footY, O.cy - O.r, O.cy + O.r];
  const dx = TILE.grid / 2 - (Math.min(...xs) + Math.max(...xs)) / 2;
  const dy = TILE.grid / 2 - (Math.min(...ys) + Math.max(...ys)) / 2;
  const mv = (p) => [p[0] + dx, p[1] + dy];
  return {
    // Polylines and one arc, already centred.
    lines: [
      [mv(footR), mv(apex), mv(legStop)],
      [mv(legResume), mv(footL)],
    ],
    arc: { cx: O.cx + dx, cy: O.cy + dy, r: O.r, from: arcFrom, to: arcTo },
    bounds: {
      left: Math.min(...xs) + dx,
      right: Math.max(...xs) + dx,
      top: Math.min(...ys) + dy,
      bottom: Math.max(...ys) + dy,
    },
  };
}

/** SVG path data strings (256 grid) for the mark. */
export function markPaths(options) {
  const g = markGeometry(options);
  const lines = g.lines.map((pts) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${r2(p[0])} ${r2(p[1])}`).join(''),
  );
  const { cx, cy, r, from, to } = g.arc;
  const p = [cx + r * Math.cos(from), cy + r * Math.sin(from)];
  const q = [cx + r * Math.cos(to), cy + r * Math.sin(to)];
  const large = to - from > Math.PI ? 1 : 0;
  return [...lines, `M${r2(p[0])} ${r2(p[1])}A${r} ${r} 0 ${large} 1 ${r2(q[0])} ${r2(q[1])}`];
}

const strokeAttrs = (color, width) =>
  `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;

/** Standalone mark (transparent), cropped to the line with its stroke. */
export function markSvg({ color = '#000000', stroke = STROKE } = {}) {
  const { bounds } = markGeometry();
  const pad = stroke / 2 + 2;
  const vb = [
    bounds.left - pad,
    bounds.top - pad,
    bounds.right - bounds.left + 2 * pad,
    bounds.bottom - bounds.top + 2 * pad,
  ].map(r2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" role="img" aria-label="Open Agent API">` +
    `<g ${strokeAttrs(color, stroke)}>${markPaths()
      .map((d) => `<path d="${d}"/>`)
      .join('')}</g></svg>\n`
  );
}

/** App icon / favicon: Possibility-family white tile with the black line. */
export function tileSvg({ tile = '#FFFFFF', color = '#000000', stroke = STROKE } = {}) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Open Agent API">` +
    `<rect x="${TILE.inset}" y="${TILE.inset}" width="${TILE.size}" height="${TILE.size}" rx="${TILE.radius}" fill="${tile}"/>` +
    `<g ${strokeAttrs(color, stroke)}>${markPaths()
      .map((d) => `<path d="${d}"/>`)
      .join('')}</g></svg>\n`
  );
}

/** Flatten the mark into straight segments (256 grid). */
function segments() {
  const g = markGeometry();
  const segs = [];
  for (const pts of g.lines) for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
  const { cx, cy, r, from, to } = g.arc;
  const steps = 160;
  let prev = [cx + r * Math.cos(from), cy + r * Math.sin(from)];
  for (let i = 1; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    const next = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    segs.push([prev, next]);
    prev = next;
  }
  return segs;
}

/** Raster icon: white rounded tile, black round-capped line, transparent outside the tile. */
function renderRows(size, stroke = STROKE) {
  const SS = 4;
  const k = size / TILE.grid;
  const half = (stroke / 2) * k;
  const W = size * SS;
  const ink = new Uint8Array(W * W);
  for (const [a, b] of segments()) {
    const ax = a[0] * k * SS,
      ay = a[1] * k * SS,
      bx = b[0] * k * SS,
      by = b[1] * k * SS;
    const rad = half * SS;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - rad - 1));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + rad + 1));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - rad - 1));
    const y1 = Math.min(W - 1, Math.ceil(Math.max(ay, by) + rad + 1));
    const vx = bx - ax,
      vy = by - ay,
      vv = vx * vx + vy * vy || 1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax,
          py = y + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (px * vx + py * vy) / vv));
        const ex = px - t * vx,
          ey = py - t * vy;
        if (ex * ex + ey * ey <= rad * rad) ink[y * W + x] = 1;
      }
    }
  }
  const lo = TILE.inset * k,
    span = TILE.size * k,
    radius = TILE.radius * k;
  const inTile = (x, y) => {
    const qx = Math.abs(x - (lo + span / 2)) - span / 2 + radius;
    const qy = Math.abs(y - (lo + span / 2)) - span / 2 + radius;
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius <= 0
    );
  };
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    rows[row] = 0;
    for (let x = 0; x < size; x++) {
      let tileHits = 0,
        inkHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS,
            fy = y + (sy + 0.5) / SS;
          if (!inTile(fx, fy)) continue;
          tileHits++;
          if (ink[(y * SS + sy) * W + (x * SS + sx)]) inkHits++;
        }
      }
      const idx = row + 1 + x * 4;
      const v = tileHits ? Math.round(255 * (1 - inkHits / tileHits)) : 0;
      rows[idx] = v;
      rows[idx + 1] = v;
      rows[idx + 2] = v;
      rows[idx + 3] = Math.round((tileHits / (SS * SS)) * 255);
    }
  }
  return rows;
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function brandIconPng(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(renderRows(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Menu bar template image: the mark alone on transparent, black with alpha coverage. */
export function statusTemplatePng(size, stroke = 20) {
  const SS = 4;
  const g = markGeometry();
  const pad = stroke / 2 + 4;
  const span = Math.max(g.bounds.right - g.bounds.left, g.bounds.bottom - g.bounds.top) + 2 * pad;
  const k = size / span;
  const ox = (g.bounds.left + g.bounds.right) / 2 - span / 2;
  const oy = (g.bounds.top + g.bounds.bottom) / 2 - span / 2;
  const W = size * SS;
  const ink = new Uint8Array(W * W);
  const rad = (stroke / 2) * k * SS;
  for (const [a, b] of segments()) {
    const ax = (a[0] - ox) * k * SS,
      ay = (a[1] - oy) * k * SS,
      bx = (b[0] - ox) * k * SS,
      by = (b[1] - oy) * k * SS;
    const vx = bx - ax,
      vy = by - ay,
      vv = vx * vx + vy * vy || 1;
    for (
      let y = Math.max(0, Math.floor(Math.min(ay, by) - rad - 1));
      y <= Math.min(W - 1, Math.ceil(Math.max(ay, by) + rad + 1));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(Math.min(ax, bx) - rad - 1));
        x <= Math.min(W - 1, Math.ceil(Math.max(ax, bx) + rad + 1));
        x++
      ) {
        const px = x + 0.5 - ax,
          py = y + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (px * vx + py * vy) / vv));
        const ex = px - t * vx,
          ey = py - t * vy;
        if (ex * ex + ey * ey <= rad * rad) ink[y * W + x] = 1;
      }
  }
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) hits += ink[(y * SS + sy) * W + x * SS + sx];
      rows[row + 1 + x * 4 + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function writeBrandIconPng(outputPath, size) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, brandIconPng(size));
}
