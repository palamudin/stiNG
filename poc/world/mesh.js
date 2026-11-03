// Meshing without three.js (so it runs in the tests): surface nets over a signed distance field, and the field's
// building blocks for trees and rocks.

// ---------------------------------------------------------------- surface nets
// sdf(x, y, z) -> signed distance (negative inside); returns positions, normals and the field value sampler
export function surfaceNets(sdf, min, max, cell) {
  const nx = Math.ceil((max[0] - min[0]) / cell), ny = Math.ceil((max[1] - min[1]) / cell), nz = Math.ceil((max[2] - min[2]) / cell);
  const sx = nx + 1, sy = ny + 1, sz = nz + 1;
  const F = new Float32Array(sx * sy * sz);
  for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) F[(k * sy + j) * sx + i] = sdf(min[0] + i * cell, min[1] + j * cell, min[2] + k * cell);
  const vid = new Int32Array(nx * ny * nz).fill(-1), pos = [], idx = [];
  const C = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float32Array(8);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { v[c] = F[((k + C[c][2]) * sy + j + C[c][1]) * sx + i + C[c][0]]; if (v[c] < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let px = 0, py = 0, pz = 0, n = 0;
    for (const [a, b] of E) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      px += C[a][0] + (C[b][0] - C[a][0]) * t; py += C[a][1] + (C[b][1] - C[a][1]) * t; pz += C[a][2] + (C[b][2] - C[a][2]) * t; n++;
    }
    vid[(k * ny + j) * nx + i] = pos.length / 3;
    pos.push(min[0] + (i + px / n) * cell, min[1] + (j + py / n) * cell, min[2] + (k + pz / n) * cell);
  }
  const V = (i, j, k) => vid[(k * ny + j) * nx + i];
  // One quad per grid edge that crosses the surface, joining the four cells round it. The orders below wind
  // counter-clockwise about +x, +y and +z; when the edge's low corner is inside, the outward normal points along the
  // axis, so the order stands, otherwise it is reversed.
  const quad = (a, b, c, d, rev) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (rev) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d); };
  const inside = (i, j, k) => F[(k * sy + j) * sx + i] < 0;
  for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
    const f0 = inside(i, j, k);
    if (i < nx && j > 0 && k > 0 && j < ny && k < nz && inside(i + 1, j, k) !== f0) quad(V(i, j - 1, k - 1), V(i, j, k - 1), V(i, j, k), V(i, j - 1, k), !f0);
    if (j < ny && i > 0 && k > 0 && i < nx && k < nz && inside(i, j + 1, k) !== f0) quad(V(i - 1, j, k - 1), V(i - 1, j, k), V(i, j, k), V(i, j, k - 1), !f0);
    if (k < nz && i > 0 && j > 0 && i < nx && j < ny && inside(i, j, k + 1) !== f0) quad(V(i - 1, j - 1, k), V(i, j - 1, k), V(i, j, k), V(i - 1, j, k), !f0);
  }
  return { pos: new Float32Array(pos), idx };
}

// ---------------------------------------------------------------- field building blocks
import { hash01, vnoise, smoothstep } from './noise.js';
export function sdRoundBox(x, y, z, bx, by, bz, r) {
  const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r, qz = Math.abs(z) - bz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
}
export function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }

// ---------------------------------------------------------------- tree designs
// A design is a list of wood blocks and leaf blocks (rounded boxes, each turned about y), a smoothing for the leaves,
// a lumpiness, and its colours. kind: oak, birch, pine, bush. v: the variant's seed.
export const TREE_KINDS = ['oak', 'birch', 'pine', 'bush', 'rock'];
// opts.trunk false: no trunk block (the game's world draws its trunks itself: they are the sim's solid cylinders)
export function treeDesign(kind, v, opts = {}) {
  const trunk = opts.trunk !== false;
  const R = (k) => hash01(v, k, 0x7ee5 + TREE_KINDS.indexOf(kind) * 977);
  const wood = [], leaf = [];
  const B = (list, x, y, z, hx, hy, hz, r, rot = 0) => list.push({ x, y, z, hx, hy, hz, r, rot, c: Math.cos(rot), s: Math.sin(rot) });
  let k = 0.5, lump = 0.1, leafCol, barkCol, bands = false;
  if (kind === 'oak') {
    const ht = 2.8 + 1.2 * R(1), cy = ht + 1.25, tt = ht + 1.1; // the trunk runs on into the crown
    if (trunk) B(wood, 0, tt / 2 - 0.3, 0, 0.24, tt / 2 + 0.3, 0.24, 0.07);
    for (let i = 0; i < 5; i++) { const a = R(10 + i) * 6.283, l = 0.9 + 0.7 * R(20 + i); B(wood, Math.cos(a) * l * 0.5, ht - 0.2 + 0.35 * i, Math.sin(a) * l * 0.5, l * 0.5, 0.1 - 0.01 * i, 0.1 - 0.01 * i, 0.04, -a); }
    // clumps: a few big blocks for the mass, smaller ones round them for a broken outline
    const n = 11 + Math.floor(R(2) * 5);
    for (let i = 0; i < n; i++) {
      const big = i < 4, a = R(30 + i) * 6.283, rr = (big ? 0.6 : 1.2 + 0.9 * R(40 + i)), y = cy + (R(50 + i) - (big ? 0.3 : 0.45)) * (big ? 1.0 : 2.1);
      const h = big ? 0.95 + 0.3 * R(60 + i) : 0.45 + 0.4 * R(60 + i);
      B(leaf, Math.cos(a) * rr, y, Math.sin(a) * rr, h, h * (0.7 + 0.25 * R(70 + i)), h, 0.3 * h + 0.06, R(80 + i) * 1.57);
    }
    k = 0.34; lump = 0.15; leafCol = [0.25, 0.47, 0.12]; barkCol = [0.33, 0.24, 0.16];
  } else if (kind === 'birch') {
    const ht = 4.6 + 1.4 * R(1), tt = ht * 1.12;
    if (trunk) B(wood, 0, tt / 2 - 0.3, 0, 0.13, tt / 2 + 0.3, 0.13, 0.05);
    const n = 5 + Math.floor(R(2) * 3);
    for (let i = 0; i < n + 4; i++) {
      const t = Math.min(1, i / (n - 1)), y = ht * 0.45 + t * ht * 0.62 + (i >= n ? (R(90 + i) - 0.5) * ht * 0.5 : 0), a = R(30 + i) * 6.283, rr = (i >= n ? 0.7 : 0.3) + 0.35 * R(40 + i) * (1 - t * 0.6);
      const h = (i >= n ? 0.35 : 0.5) + 0.3 * R(60 + i) * (1 - 0.5 * t);
      B(leaf, Math.cos(a) * rr, y, Math.sin(a) * rr, h, h * 1.3, h, 0.3 * h + 0.05, R(80 + i) * 1.57);
    }
    k = 0.3; lump = 0.12; leafCol = [0.42, 0.58, 0.16]; barkCol = [0.86, 0.85, 0.80]; bands = true;
  } else if (kind === 'pine') {
    const ht = 6.5 + 2.5 * R(1);
    B(wood, 0, ht / 2 - 0.3, 0, 0.17, ht / 2 + 0.3, 0.17, 0.05);
    const n = 5 + Math.floor(R(2) * 2);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), y = 1.6 + t * (ht - 1.4), w = 1.9 * (1 - t) + 0.45;
      B(leaf, 0, y, 0, w, 0.42, w, 0.22, (i % 2) * 0.785 + R(30 + i) * 0.2);
    }
    B(leaf, 0, ht + 0.35, 0, 0.32, 0.55, 0.32, 0.2);
    k = 0.26; lump = 0.1; leafCol = [0.14, 0.30, 0.13]; barkCol = [0.36, 0.23, 0.15];
  } else if (kind === 'rock') { // a boulder: two or three chunky stone blocks, settled into the ground
    const n = 2 + Math.floor(R(2) * 2);
    for (let i = 0; i < n; i++) { const a = R(30 + i) * 6.283, rr = 0.35 * R(40 + i) * (i ? 1 : 0); const h = (i ? 0.45 : 0.7) + 0.25 * R(60 + i); B(wood, Math.cos(a) * rr, h * 0.55 - 0.15, Math.sin(a) * rr, h * (1 + 0.3 * R(70 + i)), h * 0.75, h * (0.9 + 0.3 * R(75 + i)), 0.18 * h + 0.04, R(80 + i) * 1.57); }
    k = 0.3; lump = 0.0; leafCol = [0.4, 0.4, 0.4]; barkCol = [0.50, 0.49, 0.46];
  } else { // bush
    const n = 3 + Math.floor(R(2) * 3);
    for (let i = 0; i < n; i++) { const a = R(30 + i) * 6.283, rr = 0.45 * R(40 + i); const h = 0.35 + 0.3 * R(60 + i); B(leaf, Math.cos(a) * rr, h * 0.8, Math.sin(a) * rr, h * 1.1, h * 0.85, h * 1.1, 0.25, R(80 + i) * 1.57); }
    k = 0.4; lump = 0.07; leafCol = [0.24, 0.44, 0.13]; barkCol = [0.3, 0.22, 0.15];
  }
  // bounds
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const b of [...wood, ...leaf]) { const e = Math.max(b.hx, b.hz) * 1.42 + 0.4; mn[0] = Math.min(mn[0], b.x - e); mx[0] = Math.max(mx[0], b.x + e); mn[1] = Math.min(mn[1], b.y - b.hy - 0.4); mx[1] = Math.max(mx[1], b.y + b.hy + 0.4); mn[2] = Math.min(mn[2], b.z - e); mx[2] = Math.max(mx[2], b.z + e); }
  const one = (b, x, y, z) => { const dx = x - b.x, dz = z - b.z; return sdRoundBox(b.c * dx - b.s * dz, y - b.y, b.s * dx + b.c * dz, b.hx, b.hy, b.hz, b.r); };
  const seed = v * 13 + 7, stone = kind === 'rock';
  const woodD = stone
    ? (x, y, z) => { let d = 1e9; for (const b of wood) d = smin(d, one(b, x, y, z), k); return d + 0.06 * vnoise(x * 2.3, z * 2.3 + y, seed + 5) + 0.03 * vnoise(x * 5.1 - y, z * 5.1, seed + 6); }
    : (x, y, z) => { let d = 1e9; for (const b of wood) { // the trunk tapers: thicker at the foot
      const t = b.hy > 1 ? 1 + 0.25 * Math.max(0, 1 - (y + 0.3) / (b.hy * 2)) : 1; d = Math.min(d, one({ ...b, hx: b.hx * t, hz: b.hz * t }, x, y, z)); } return d; };
  const leafD = (x, y, z) => { if (!leaf.length) return 1e9; let d = 1e9; for (const b of leaf) d = smin(d, one(b, x, y, z), k); return d + lump * vnoise(x * 1.7 + y * 0.3, z * 1.7 - y * 0.4, seed) + lump * 0.5 * vnoise(x * 3.9 - y, z * 3.9 + y * 0.7, seed + 1); };
  const top = Math.max(...leaf.map((b) => b.y + b.hy), 0.5), bot = Math.min(...leaf.map((b) => b.y - b.hy), top - 0.5);
  return { kind, stone, leafCount: leaf.length, woodCount: wood.length, wood: woodD, leaf: leafD, sdf: (x, y, z) => Math.min(woodD(x, y, z), leafD(x, y, z)), min: mn, max: mx, leafCol, barkCol, bands, height: mx[1] - 0.4, top, bot };
}

// Mesh a design at a cell size: positions, normals (field gradient), colours (with baked occlusion), sway weight
// (0 at the foot, 1 at the top, squared) and a leaf flag.
export function meshTree(design, cell) {
  // coarse levels swell by a fraction of the cell, so parts thinner than a cell (pine tiers, birch twigs) survive and
  // the far silhouette keeps its mass instead of thinning out
  const grow = cell > 0.5 ? 0.22 * cell : 0, field = grow ? (x, y, z) => design.sdf(x, y, z) - grow : design.sdf;
  const D = { ...design, sdf: field };
  // Near levels mesh the wood and the leaves as two surfaces, so the trunk and branches go on inside the crown (a wasp
  // inside a crown sees the trunk it may nest on); far levels mesh the union, which is cheaper and looks the same.
  let pos, idx, nWood = 0;
  const lo = design.min.map((v) => v - grow), hi = design.max.map((v) => v + grow);
  const separate = cell <= 0.5 && !design.stone && design.leafCount > 0 && design.woodCount > 0;
  if (separate) {
    const w = surfaceNets(design.wood, lo, hi, cell), l = surfaceNets(design.leaf, lo, hi, cell), nw = w.pos.length / 3; nWood = nw;
    pos = new Float32Array(w.pos.length + l.pos.length); pos.set(w.pos); pos.set(l.pos, w.pos.length);
    idx = w.idx.concat(l.idx.map((i) => i + nw));
  } else ({ pos, idx } = surfaceNets(field, lo, hi, cell));
  const n = pos.length / 3, nor = new Float32Array(n * 3), col = new Float32Array(n * 3), sway = new Float32Array(n), leaf = new Float32Array(n);
  const e = cell * 0.25;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const F = separate ? (i < nWood ? design.wood : design.leaf) : D.sdf;
    let gx = F(x + e, y, z) - F(x - e, y, z), gy = F(x, y + e, z) - F(x, y - e, z), gz = F(x, y, z + e) - F(x, y, z - e);
    const gl = Math.hypot(gx, gy, gz) || 1; gx /= gl; gy /= gl; gz /= gl;
    nor[i * 3] = gx; nor[i * 3 + 1] = gy; nor[i * 3 + 2] = gz;
    const isLeaf = separate ? i >= nWood : design.leaf(x, y, z) < design.wood(x, y, z);
    leaf[i] = isLeaf ? 1 : 0;
    // occlusion from the field: how far the field falls short of the step along the normal (Quilez)
    let occ = 0, sca = 1;
    for (let s = 1; s <= 5; s++) { const h = 0.05 + 0.13 * s; occ += (h - D.sdf(x + gx * h, y + gy * h, z + gz * h)) * sca; sca *= 0.8; }
    let ao = Math.min(1, Math.max(0.15, 1 - 1.2 * occ));
    if (isLeaf) ao *= 0.5 + 0.5 * smoothstep(D.bot, D.top, y); // the underside of a canopy sees less sky
    const base = isLeaf ? D.leafCol : D.barkCol;
    let m = 1;
    if (!isLeaf && D.bands) m = hash01(Math.floor(y * 3.2), 1, 51) < 0.22 ? 0.18 : 1; // birch bark marks
    if (isLeaf) m = 0.9 + 0.2 * vnoise(x * 2.1, z * 2.1 + y, 77);
    if (D.stone) m = (0.8 + 0.3 * vnoise(x * 3.1, z * 3.1 + y * 2, 78)) * (y < 0.08 ? 0.75 : 1) * (gy > 0.7 ? 0.92 : 1); // weathered, darker at the foot
    for (let c = 0; c < 3; c++) col[i * 3 + c] = Math.pow(base[c], 2.2) * m * ao; // linear, occlusion baked
    const t = Math.max(0, y) / Math.max(1, D.height);
    sway[i] = D.stone ? 0 : t * t;
  }
  return { pos, idx, nor, col, sway, leaf, verts: n, tris: idx.length / 3 };
}
