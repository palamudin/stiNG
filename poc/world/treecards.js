// Trees as cards (W3): a trunk and branches of low-poly cylinders, and a crown of leaf clusters, each cluster a
// few crossed quads with a pixel-art leaf texture cut out by alpha. Up close it is plainly cards of chunky leaves
// (the Minecraft idea: texture over geometry); from a few metres it is a tree. No image files: the leaf atlas is
// drawn here from the hash, one 64 x 64 cell per kind and variety, leaves as blobs of 2 x 2 pixel "blocks".
//
// Pure JS (no three.js) so the tests can mesh every design: a design is meshed at a detail level into flat arrays:
//   pos, nor (the crown's sphere normal for leaves, so clusters shade as one soft mass; the cylinder's for wood),
//   uv (the atlas cell, 0 for wood), col (linear, with cheap occlusion from height and depth into the crown),
//   sway (0 at the foot, 1 at the top, squared), leaf (0 wood, 1 leaf), ctr (the cluster's centre, for the flutter)
// Levels: 0 full (every branch, 30-60 clusters), 1 the main branches and 12-20 bigger clusters, 2 the trunk and 5-8
// big clusters. Beyond that an impostor (trees.js bakes one from level 0).
import { hash01, vnoise, smoothstep } from './noise.js';

export const TREE_KINDS = ['oak', 'birch', 'pine', 'bush', 'rock'];
export const CARD = { atlas: 512, cell: 64 };

// ---------------------------------------------------------------- the leaf atlas
// RGBA bytes, atlas x atlas. Cell (kx, v) holds kind kx's variety v. Alpha is 0 or 255 (pixel leaves); colour
// carries a per-leaf shade in r (0.6..1, multiplies the leaf colour) and the rim darkening in g.
export function leafAtlas() {
  const A = CARD.atlas, C = CARD.cell, n = A / C, px = new Uint8Array(A * A * 4);
  const put = (x, y, a, s) => { const o = (y * A + x) * 4; px[o] = Math.round(255 * s); px[o + 1] = 255; px[o + 2] = 255; px[o + 3] = a; };
  for (let k = 0; k < TREE_KINDS.length; k++) for (let v = 0; v < n; v++) {
    const x0 = (v % n) * C, y0 = k * C, kind = TREE_KINDS[k];
    if (kind === 'rock') continue;
    const R = (i, j, s) => hash01(i + v * 97, j + k * 131, s);
    // leaves: blobs scattered over a disc, each blob a few 2 x 2 blocks; pines: needle sprays (short lines)
    const blobs = kind === 'pine' ? 46 : kind === 'birch' ? 80 : kind === 'bush' ? 30 : 34;
    for (let b = 0; b < blobs; b++) {
      const a = R(b, 1, 3) * 6.283, r = Math.sqrt(R(b, 2, 3)) * 0.42 * C, cx = C / 2 + Math.cos(a) * r, cy = C / 2 + Math.sin(a) * r;
      const sh = 0.6 + 0.4 * R(b, 3, 3);
      if (kind === 'pine') { // a spray: a short line of blocks from a stem, with a few side needles
        const dir = R(b, 4, 3) * 6.283, len = 6 + 8 * R(b, 5, 3);
        for (let t = 0; t < len; t += 1.5) {
          const x = cx + Math.cos(dir) * t, y = cy + Math.sin(dir) * t;
          for (let s = -1; s <= 1; s++) { const nx = x - Math.sin(dir) * s * 1.6, ny = y + Math.cos(dir) * s * 1.6; const X = Math.floor(nx / 2) * 2, Y = Math.floor(ny / 2) * 2; if (X >= 0 && Y >= 0 && X < C - 1 && Y < C - 1 && (s === 0 || (t % 3) < 1.5)) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) put(x0 + X + i, y0 + Y + j, 255, sh); }
        }
      } else {
        const lobes = kind === 'oak' ? 5 : kind === 'birch' ? 2 : 3, size = kind === 'birch' ? 2.4 : kind === 'bush' ? 2.8 : 3.4;
        for (let l = 0; l < lobes; l++) {
          const la = R(b, 10 + l, 3) * 6.283, lr = l ? size * 0.9 * R(b, 20 + l, 3) : 0, lx = cx + Math.cos(la) * lr, ly = cy + Math.sin(la) * lr, rad = size * (0.6 + 0.5 * R(b, 30 + l, 3));
          for (let y = -rad; y <= rad; y += 2) for (let x = -rad; x <= rad; x += 2) {
            if (x * x + y * y > rad * rad) continue;
            const X = Math.floor((lx + x) / 2) * 2, Y = Math.floor((ly + y) / 2) * 2;
            if (X < 0 || Y < 0 || X >= C - 1 || Y >= C - 1) continue;
            for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) put(x0 + X + i, y0 + Y + j, 255, sh);
          }
        }
      }
    }
    // the rim: leaves at the cell's edge fade (the cluster reads as a soft mass from a distance)
    for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
      const o = ((y0 + y) * A + x0 + x) * 4, d = Math.hypot(x - C / 2, y - C / 2) / (C / 2);
      if (px[o + 3] && d > 0.78) px[o + 3] = 0;
      px[o + 1] = Math.round(255 * (1 - 0.35 * smoothstep(0.3, 0.8, d)));
    }
  }
  return { data: px, size: A, cells: n };
}

// ---------------------------------------------------------------- designs
// kind, v (variety seed) -> { kind, height, crownR, crownY, trunkR, branches: [{a, b, r0, r1, level}], clusters: [{p, r, level}] }
export function treeDesign(kind, v, opts = {}) {
  const R = (a, b) => hash01(a, b, 0x7ee5 + TREE_KINDS.indexOf(kind) * 977 + v * 31);
  const branches = [], clusters = [];
  const trunk = opts.trunk !== false;
  let height, crownR, crownY, trunkR;
  if (kind === 'oak') { height = 6 + 2.5 * R(1, 1); crownR = 2.4 + 0.9 * R(1, 2); crownY = height - crownR * 0.55; trunkR = 0.24 + 0.08 * R(1, 3); }
  else if (kind === 'birch') { height = 8 + 3 * R(1, 1); crownR = 1.5 + 0.5 * R(1, 2); crownY = height - crownR * 0.9; trunkR = 0.13 + 0.04 * R(1, 3); }
  else if (kind === 'pine') { height = 11 + 6 * R(1, 1); crownR = 1.6 + 0.6 * R(1, 2); crownY = height * 0.55; trunkR = 0.18 + 0.06 * R(1, 3); }
  else if (kind === 'bush') { height = 1.0 + 0.6 * R(1, 1); crownR = 0.7 + 0.4 * R(1, 2); crownY = height * 0.55; trunkR = 0.04; }
  else { height = 1.2; crownR = 0.8; crownY = 0.5; trunkR = 0; }
  const seg = (a, b, r0, r1, level) => branches.push({ a, b, r0, r1, level });
  const clus = (p, r, level) => clusters.push({ p, r, level });
  if (kind === 'oak' || kind === 'birch') {
    const top = kind === 'oak' ? crownY + crownR * 0.3 : height * 0.92;
    if (trunk) seg([0, -0.2, 0], [0, top, 0], trunkR * 1.25, trunkR * 0.45, 0);
    const nb = kind === 'oak' ? 6 + Math.floor(R(2, 1) * 3) : 5 + Math.floor(R(2, 1) * 3);
    for (let i = 0; i < nb; i++) {
      const t = kind === 'oak' ? 0.55 + 0.4 * (i / nb) : 0.45 + 0.5 * (i / nb), y = top * t, a = R(3, i) * 6.283, up = kind === 'oak' ? 0.35 + 0.4 * R(4, i) : 0.6 + 0.3 * R(4, i);
      const len = crownR * (kind === 'oak' ? 1.1 + 0.4 * R(5, i) : 0.9 + 0.3 * R(5, i)) * (1 - 0.3 * Math.abs(t - 0.75));
      const d = [Math.cos(a) * Math.sqrt(1 - up * up), up, Math.sin(a) * Math.sqrt(1 - up * up)];
      const b = [d[0] * len, y + d[1] * len, d[2] * len];
      seg([0, y, 0], b, trunkR * 0.55, trunkR * 0.18, 1);
      clus(b, crownR * (0.42 + 0.18 * R(6, i)), 1);
      // twigs from the branch, each with a cluster
      for (let j = 0; j < 3; j++) {
        const s = 0.4 + 0.5 * R(7, i * 7 + j), p0 = [b[0] * s, y + (b[1] - y) * s, b[2] * s], ta = a + (R(8, i * 7 + j) - 0.5) * 2.4, tu = 0.3 + 0.5 * R(9, i * 7 + j), tl = crownR * (0.35 + 0.35 * R(10, i * 7 + j));
        const p1 = [p0[0] + Math.cos(ta) * Math.sqrt(1 - tu * tu) * tl, p0[1] + tu * tl, p0[2] + Math.sin(ta) * Math.sqrt(1 - tu * tu) * tl];
        seg(p0, p1, trunkR * 0.18, trunkR * 0.06, 0);
        clus(p1, crownR * (0.3 + 0.16 * R(11, i * 7 + j)), 0);
      }
    }
    // the crown's top
    clus([0, top + crownR * 0.1, 0], crownR * 0.5, 2);
    for (let i = 0; i < 5; i++) { const a = R(12, i) * 6.283, r = crownR * 0.6; clus([Math.cos(a) * r, crownY + (R(13, i) - 0.4) * crownR * 0.8, Math.sin(a) * r], crownR * 0.55, 2); }
  } else if (kind === 'pine') {
    if (trunk) seg([0, -0.2, 0], [0, height, 0], trunkR * 1.2, trunkR * 0.15, 0);
    const tiers = 7 + Math.floor(R(2, 1) * 3);
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1), y = height * (0.25 + 0.7 * t), w = crownR * (1.15 - 0.95 * t) + 0.35;
      const nb = 5 + Math.floor(R(3, i) * 3);
      for (let j = 0; j < nb; j++) {
        const a = R(4, i * 9 + j) * 6.283 + i * 0.4, d = [Math.cos(a) * w, y - w * 0.22, Math.sin(a) * w];
        seg([0, y, 0], d, trunkR * 0.35 * (1 - 0.5 * t), trunkR * 0.08, i % 2 === 0 ? 1 : 0);
        clus([d[0] * 0.8, d[1] + 0.1, d[2] * 0.8], Math.max(0.45, w * 0.55), i % 2 === 0 ? 1 : 0);
        clus([d[0] * 0.45, y + 0.05 - w * 0.08, d[2] * 0.45], Math.max(0.4, w * 0.42), 0);
      }
      if (i % 3 === 0) clus([0, y + 0.2, 0], w * 0.75, 2);
    }
    clus([0, height + 0.1, 0], 0.55, 2);
  } else if (kind === 'bush') {
    const n = 6 + Math.floor(R(2, 1) * 4);
    for (let i = 0; i < n; i++) { const a = R(3, i) * 6.283, r = crownR * 0.6 * R(4, i); clus([Math.cos(a) * r, crownY + (R(5, i) - 0.5) * height * 0.5, Math.sin(a) * r], crownR * (0.5 + 0.3 * R(6, i)), i < 3 ? 2 : i < 6 ? 1 : 0); }
  }
  return { kind, v, height, crownR, crownY, trunkR, branches, clusters, trunk };
}

// ---------------------------------------------------------------- meshing
const LEAF = { oak: [0.25, 0.47, 0.12], birch: [0.42, 0.58, 0.16], pine: [0.14, 0.30, 0.13], bush: [0.24, 0.44, 0.13] };
const BARK = { oak: [0.33, 0.24, 0.16], birch: [0.86, 0.85, 0.80], pine: [0.36, 0.23, 0.15], bush: [0.3, 0.22, 0.15] };
const lin = (c) => c.map((v) => Math.pow(v, 2.2));

export function meshTreeCards(design, level, atlasCells = CARD.atlas / CARD.cell) {
  const pos = [], nor = [], uv = [], col = [], sway = [], leaf = [], ctr = [], idx = [];
  const D = design, kind = D.kind, bark = lin(BARK[kind] || [0.4, 0.4, 0.4]), lc = lin(LEAF[kind] || [0.3, 0.4, 0.2]);
  const H = Math.max(1, D.height);
  const V = (p, n, u, c, sw, lf, cc) => { pos.push(...p); nor.push(...n); uv.push(...u); col.push(...c); sway.push(sw); leaf.push(lf); ctr.push(...cc); return pos.length / 3 - 1; };
  // wood: cylinders of 6 (level 0), 5, 4 sides
  const sides = level === 0 ? 6 : level === 1 ? 5 : 4;
  for (const b of D.branches) {
    if (b.level < level) continue;
    const ax = [b.b[0] - b.a[0], b.b[1] - b.a[1], b.b[2] - b.a[2]], L = Math.hypot(...ax) || 1, d = ax.map((v) => v / L);
    const u0 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let e1 = [d[1] * u0[2] - d[2] * u0[1], d[2] * u0[0] - d[0] * u0[2], d[0] * u0[1] - d[1] * u0[0]]; const l1 = Math.hypot(...e1); e1 = e1.map((v) => v / l1);
    const e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    const ring = (p, r, t) => { const base = pos.length / 3; for (let s = 0; s < sides; s++) { const a = s / sides * 6.283, n = [Math.cos(a) * e1[0] + Math.sin(a) * e2[0], Math.cos(a) * e1[1] + Math.sin(a) * e2[1], Math.cos(a) * e1[2] + Math.sin(a) * e2[2]]; const q = [p[0] + n[0] * r, p[1] + n[1] * r, p[2] + n[2] * r]; const ao = 0.55 + 0.45 * smoothstep(0, H * 0.35, q[1]); let m = 1; if (kind === 'birch') m = hash01(Math.floor(q[1] * 3.2), s + b.level * 7, 51) < 0.22 ? 0.18 : 1; V(q, n, [0, 0], bark.map((c) => c * ao * m), Math.pow(Math.max(0, q[1]) / H, 2) * (b.level === 0 ? 1 : 0.6), 0, [0, 0, 0]); } return base; };
    const r0 = ring(b.a, b.r0), r1 = ring(b.b, b.r1);
    for (let s = 0; s < sides; s++) { const s2 = (s + 1) % sides; idx.push(r0 + s, r1 + s, r1 + s2, r0 + s, r1 + s2, r0 + s2); }
  }
  // leaves: clusters as 3 crossed quads (level 0, 1) or 2 (level 2), each quad facing its own way
  const cx = [0, D.crownY, 0], cr = Math.max(0.5, D.crownR);
  for (let ci = 0; ci < D.clusters.length; ci++) {
    const c = D.clusters[ci];
    if (c.level < level) continue;
    const r = c.r * (level === 2 ? 1.35 : level === 1 ? 1.15 : 1), p = c.p;
    const quads = level === 2 ? 2 : 3, cell = Math.floor(hash01(ci, D.v, 61) * atlasCells);
    const kx = TREE_KINDS.indexOf(kind), u0 = cell / atlasCells, v0 = kx / atlasCells, du = 1 / atlasCells;
    // occlusion: deeper into the crown and lower down is darker (cheap, from height and depth)
    const depth = Math.min(1, Math.hypot(p[0] - cx[0], (p[1] - cx[1]) * 0.8, p[2] - cx[2]) / cr);
    const ao = (0.45 + 0.55 * depth) * (0.6 + 0.4 * smoothstep(D.crownY - cr, D.crownY + cr * 0.6, p[1]));
    const tint = 0.85 + 0.3 * vnoise(p[0] * 1.3, p[2] * 1.3 + p[1], 77 + D.v);
    const colr = lc.map((v) => v * ao * tint);
    // the sphere normal of the crown at the cluster (shades the crown as one mass)
    let sn = [p[0] - cx[0], (p[1] - cx[1]) + cr * 0.35, p[2] - cx[2]]; const sl = Math.hypot(...sn) || 1; sn = sn.map((v) => v / sl);
    for (let q = 0; q < quads; q++) {
      const a = hash01(ci, q, 62 + D.v) * 3.14159, tilt = (hash01(ci, q, 63) - 0.5) * 1.2;
      const ex = [Math.cos(a), 0, Math.sin(a)], ey = [-Math.sin(a) * Math.sin(tilt), Math.cos(tilt), Math.cos(a) * Math.sin(tilt)];
      const base = pos.length / 3;
      const sw = Math.pow(Math.max(0, p[1]) / H, 2);
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const P = [p[0] + (ex[0] * sx + ey[0] * sy) * r, p[1] + (ex[1] * sx + ey[1] * sy) * r, p[2] + (ex[2] * sx + ey[2] * sy) * r];
        V(P, sn, [u0 + du * (sx + 1) / 2, v0 + du * (sy + 1) / 2], colr, sw, 1, p);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const f = (a) => new Float32Array(a);
  return { pos: f(pos), nor: f(nor), uv: f(uv), col: f(col), sway: f(sway), leaf: f(leaf), ctr: f(ctr), idx, verts: pos.length / 3, tris: idx.length / 3 };
}
