// The wild land round a settled area (GDD 21.6, 20.6): the world thread's wild generator (poc/world/sources/wild.js)
// brought into the sim, so the ground a wasp flies over beyond the town is the ground the sim works above. The same
// numbers as the drawing's, with the sim's own trig and square roots so the C# twin (Wild.cs) agrees bit for bit: a
// fjord coast, lakes at their own levels, ridged mountains to 780 m, rivers, forests and footpaths.
//
// A world with `settled` > 0 is settled within that many metres of the home tree: the sim's own ground there, lifted
// onto a flat, dry site of the wild land above the sea (findSite), blended over `band` m into the wild land beyond.
import { dsin, dcos, datan2 } from './rng.js';

export const WILD = {
  cell: 1800, octaves: 10, warp: 0.55, hills: 80, lift: 14, mountains: 780, ridgeCell: 3400, roll: 22, rollCell: 520,
  beach: 0.8, shelf: 2.4, contCell: 9000, step: 5, riverCell: 2600, riverW: 7, riverBank: 15, riverDepth: 2.6,
  trailCell: 420, trailW: 0.75, moistCell: 1300, forestCell: 760, ocean: 70,
  lakeCell: 2200, lakeShare: 0.75, lakeR: [160, 560], lakeDrop: [2, 6], lakeDepth: [4, 14], lakeRim: 0.35, lakeBlend: 0.15,
  sea: 0, relief: 1, blocky: 0.6,
  edge: 46,   // metres past the settled radius the blend starts: a settled chunk's corner
  band: 160,  // metres the sim's ground takes to blend into the wild land
};

// lowbias32 (as world/noise.js) and value noise with derivatives
function hash3(x, y, s) {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(s | 0, 0xcb1ab31f)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
const hash01 = (x, y, s) => hash3(x, y, s) / 4294967296;
function vnoised(x, y, s, out) {
  const px = Math.floor(x), py = Math.floor(y), fx = x - px, fy = y - py;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = hash01(px, py, s) * 2 - 1, b = hash01(px + 1, py, s) * 2 - 1, c = hash01(px, py + 1, s) * 2 - 1, d = hash01(px + 1, py + 1, s) * 2 - 1;
  const k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  out[0] = a + k1 * ux + k2 * uy + k4 * ux * uy; out[1] = dux * (k1 + k4 * uy); out[2] = duy * (k2 + k4 * ux);
  return out;
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ss = (s, k) => (s * 7919 + k * 104729) | 0;
const N = [0, 0, 0], B1 = [0, 0, 0, 0, 0], B2 = [0, 0, 0, 0, 0];
// the wild seed from the world's: its low 31 bits
export const wildSeed = (seed) => Number(BigInt(seed) & 0x7fffffffn);

function broad(S, x, z, out) {
  const W = WILD;
  const bx = (0.6 * x - 0.8 * z) / W.cell, by = (0.8 * x + 0.6 * z) / W.cell;
  vnoised(bx * 0.5 + 3.1, by * 0.5 + 7.7, ss(S, 1), N); const w1 = N[0];
  vnoised(bx * 0.5 - 5.3, by * 0.5 + 1.9, ss(S, 2), N); const w2 = N[0];
  let px = bx + W.warp * w1, py = by + W.warp * w2, a = 0, b = 1, dx = 0, dy = 0, alo = 0;
  for (let i = 0; i < W.octaves; i++) {
    vnoised(px, py, ss(S, 10 + i), N);
    dx += N[1]; dy += N[2];
    a += b * N[0] / (1 + dx * dx + dy * dy);
    if (i === 5) alo = a;
    b *= 0.5;
    const qx = 0.8 * px - 0.6 * py, qy = 0.6 * px + 0.8 * py; px = qx * 2.03; py = qy * 2.03;
  }
  let rh = 0, rbb = 1, rdx = 0, rdy = 0, hx = (0.8 * x + 0.6 * z) / W.rollCell + 1.7 * w2, hz = (-0.6 * x + 0.8 * z) / W.rollCell - 1.3 * w1;
  for (let i = 0; i < 4; i++) {
    vnoised(hx, hz, ss(S, 50 + i), N);
    rdx += N[1]; rdy += N[2];
    rh += rbb * N[0] / (1 + rdx * rdx + rdy * rdy);
    rbb *= 0.45; const qx = 0.8 * hx - 0.6 * hz, qz = 0.6 * hx + 0.8 * hz; hx = qx * 2.1; hz = qz * 2.1;
  }
  vnoised(x / W.contCell + 0.37, z / W.contCell - 0.61, ss(S, 3), N);
  const cn = N[0], ocean = W.ocean * sstep(0.0, -0.45, cn);
  out[0] = (W.hills * a + W.roll * rh + W.lift) * W.relief - ocean;
  out[1] = (W.hills * alo + W.roll * rh + W.lift) * W.relief - ocean;
  out[2] = w1; out[3] = w2; out[4] = cn;
  return out;
}
const RIM = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const LK = { cx: 0, cz: 0, R: 0, level: 0, depth: 0, d: 0 };
function lakeAt(S, x, z) {
  const W = WILD, ci = Math.floor(x / W.lakeCell), cj = Math.floor(z / W.lakeCell);
  if (hash01(ci, cj, ss(S, 70)) > W.lakeShare) return null;
  let R = W.lakeR[0] + (W.lakeR[1] - W.lakeR[0]) * hash01(ci, cj, ss(S, 71));
  const jit = Math.max(0, W.lakeCell / 2 - R * 1.32 * (1 + W.lakeRim) - 10);
  const cx = (ci + 0.5) * W.lakeCell + (hash01(ci, cj, ss(S, 72)) * 2 - 1) * jit, cz = (cj + 0.5) * W.lakeCell + (hash01(ci, cj, ss(S, 73)) * 2 - 1) * jit;
  const a = datan2(z - cz, x - cx), R0 = R;
  vnoised(1.6 + 1.9 * dcos(a), 2.3 + 1.9 * dsin(a), ss(S, 77) + ci * 31 + cj * 17, N);
  R *= 1 + 0.32 * N[0];
  const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
  if (d > R0 * 1.32 * (1 + W.lakeRim)) return null;
  broad(S, cx, cz, B2); let lo = B2[1];
  const rr = R0 * (1 + 0.4 * W.lakeRim);
  for (let k = 0; k < 4; k++) { broad(S, cx + rr * RIM[k][0], cz + rr * RIM[k][1], B2); lo = Math.min(lo, B2[1]); }
  const level = lo - (W.lakeDrop[0] + (W.lakeDrop[1] - W.lakeDrop[0]) * hash01(ci, cj, ss(S, 74)));
  if (level < W.sea + 4 || level > 120) return null;
  LK.cx = cx; LK.cz = cz; LK.R = R; LK.level = level; LK.d = d;
  LK.depth = W.lakeDepth[0] + (W.lakeDepth[1] - W.lakeDepth[0]) * hash01(ci, cj, ss(S, 75));
  return LK;
}
// the wild land at (x, z) on its own map: [height, moisture, forest, trail, water level]
export function wildAt(S, x, z, out = [0, 0, 0, 0, 0]) {
  const W = WILD;
  broad(S, x, z, B1);
  let h = B1[0]; const hlo = B1[1], w1 = B1[2], w2 = B1[3];
  const lake = lakeAt(S, x, z);
  let wl = W.sea, inLake = 0, band = 0;
  if (lake) {
    const R = lake.R, d = lake.d;
    inLake = 1 - sstep(R * (1 - W.lakeBlend), R, d);
    band = 1 - sstep(R * (1 + 0.6 * W.lakeRim), R * (1 + W.lakeRim), d);
    if (d < R * (1 + 0.4 * W.lakeRim)) wl = lake.level;
  }
  h += (hlo - h) * (1 - sstep(1.5, 5, Math.abs(hlo - wl)));
  { const e = h - wl; h += W.beach * e / Math.sqrt(e * e + 0.36); if (e < 0) h -= W.shelf * sstep(0.2, 1.8, -e); }
  const cont = sstep(-0.2, 0.45, B1[4]) * (1 - inLake);
  let r = 0, rb = 0.55, rx = (0.6 * x + 0.8 * z + 611 * w1) / W.ridgeCell, rz = (-0.8 * x + 0.6 * z - 577 * w2) / W.ridgeCell, prev = 1;
  for (let i = 0; i < 6; i++) {
    vnoised(rx, rz, ss(S, 30 + i), N);
    const k = 1 - Math.abs(N[0]), kk = k * k * k * prev;
    r += rb * kk; prev = clamp(kk * 2.2, 0, 1); rb *= 0.48;
    const qx = 0.8 * rx - 0.6 * rz, qz = 0.6 * rx + 0.8 * rz; rx = qx * 2.07; rz = qz * 2.07;
  }
  let m = W.mountains * cont * Math.sqrt(cont) * r * W.relief;
  if (W.blocky > 0 && m > 0) { const q = m / W.step, fl = Math.floor(q), f = q - fl, k = 0.5 * (1 - W.blocky) + 0.02; m = (fl + sstep(0.5 - k, 0.5 + k, f)) * W.step; }
  h += m;
  vnoised((x + 520 * w2) / W.riverCell, (z - 480 * w1) / W.riverCell, ss(S, 4), N);
  const rd = Math.abs(N[0]) / Math.max(Math.sqrt(N[1] * N[1] + N[2] * N[2]), 0.08) * W.riverCell;
  const low = 1 - sstep(18, 55, h);
  const river = (1 - sstep(W.riverW, W.riverW + W.riverBank, rd)) * low * (1 - inLake) * (1 - band);
  h += (Math.min(h, W.sea - W.riverDepth * (1 - sstep(0, W.riverW, rd) * 0.4)) - h) * river;
  if (inLake > 0) { const q = lake.d / lake.R; vnoised(x / 90, z / 90, ss(S, 76), N); const bowl = lake.level - lake.depth * (1 - q * q) * (0.85 + 0.15 * N[0]); h += (bowl - h) * inLake; }
  vnoised(x / W.moistCell + 9.1, z / W.moistCell - 2.3, ss(S, 5), N);
  const moist = clamp(0.5 + 0.45 * N[0] + 0.4 * (1 - sstep(wl, wl + 14, h)) - 0.3 * sstep(300, 600, h - W.sea), 0, 1);
  vnoised((0.8 * x - 0.6 * z + 340 * w1) / W.forestCell, (0.6 * x + 0.8 * z + 360 * w2) / W.forestCell, ss(S, 6), N); let fo = N[0];
  vnoised((0.6 * x + 0.8 * z) / (W.forestCell * 0.31) + 2.2 * w2, (-0.8 * x + 0.6 * z) / (W.forestCell * 0.31) - 1.7 * w1, ss(S, 60), N); fo += 0.45 * N[0];
  vnoised(x / (W.forestCell * 0.09), z / (W.forestCell * 0.09), ss(S, 61), N); fo += 0.18 * N[0];
  const forest = sstep(0.02, 0.3, fo + 0.3 * (moist - 0.5)) * (1 - sstep(420, 560, h - W.sea)) * sstep(wl + 1.2, wl + 3.5, h) * (1 - river);
  vnoised((x - 90 * w2) / W.trailCell, (z + 70 * w1) / W.trailCell, ss(S, 7), N);
  const td = Math.abs(N[0]) / Math.max(Math.sqrt(N[1] * N[1] + N[2] * N[2]), 0.1) * W.trailCell;
  const trail = (1 - sstep(W.trailW * 0.6, W.trailW * 1.5, td)) * (1 - sstep(0.35, 0.6, forest)) * sstep(wl + 1.5, wl + 3, h) * (1 - sstep(60, 90, h - W.sea));
  vnoised(x / 2.3 + 0.5, z / 2.3 - 0.5, ss(S, 8), N); let micro = 0.12 * N[0];
  vnoised(x / 0.83, z / 0.83, ss(S, 9), N); micro += 0.035 * N[0];
  h += micro * (1 - trail) * sstep(wl + 0.3, wl + 2, h) - 0.07 * trail;
  if (lake && band > 0 && inLake < 1) h += (Math.max(h, lake.level + 1.2) - h) * band * (1 - inLake);
  out[0] = h; out[1] = moist; out[2] = forest; out[3] = trail; out[4] = wl;
  return out;
}
// the site for the settled area: the first flat, dry lowland found searching outward from the wild origin, nine samples
// over the area all land between 10 and 90 m above the sea and within 18 m of their mean (world thread's findSite)
const sites = new Map();
export function wildSite(S, radius) {
  const key = S * 65536 + radius, v = sites.get(key);
  if (v) return v;
  const o = [0, 0, 0, 0, 0], minH = 10 + WILD.sea;
  let best = null;
  for (let r = 0; r < 20000 && !best; r += 150) for (let k = 0; k < 26 && !best; k++) {
    const a = k * 0.25, x = dcos(a) * r, z = dsin(a) * r;
    let ok = true, hs = 0;
    const H = [];
    for (let q = 0; q < 9 && ok; q++) {
      wildAt(S, x + (q % 3 - 1) * radius * 0.7, z + (Math.floor(q / 3) - 1) * radius * 0.7, o);
      if (o[0] < minH || o[0] > WILD.sea + 90) ok = false; hs += o[0]; H.push(o[0]);
    }
    if (!ok) continue;
    const hm = hs / 9; let spread = 0;
    for (const h of H) spread = Math.max(spread, Math.abs(h - hm));
    if (spread < 18) best = { x, z, h: hm };
  }
  if (!best) best = { x: 0, z: 0, h: Math.max(minH, wildAt(S, 0, 0, o)[0]) };
  if (sites.size > 64) sites.clear();
  sites.set(key, best);
  return best;
}
