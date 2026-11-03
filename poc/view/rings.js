// Ground rings (GDD 20, G2): the ground drawn as nested square grids round the camera, each twice as coarse as the one
// inside it. Presentation only: the sim never reads this. Plain JS with no three.js, so it runs in the tests, and the
// game's shaders do exactly what heightAt and ringY do here (the GLSL is written from RING below).
//
// Level l has cells of s = base * 2^l metres and is a grid of `cells` by `cells` cells round its centre, which snaps to
// whole cells so the vertices never swim. Its heights are exact samples of the ground, kept in a 128 by 128 window
// addressed by world texel (i & 127, j & 127), so moving the window only fills the texels it has not got.
// Near its outer edge a level morphs into the next one's surface (from `band0` cells in to `band1` cells in, fully the
// coarser surface past that), so where two levels meet they are the same surface and nothing cracks or pops. Under a
// finer level, a coarser level's vertices more than two of its own cells inside are pushed far down, out of sight.
// Each cell is split along the same diagonal as the mesh: from (i, j) to (i + 1, j + 1).
export const RING = { levels: 5, cells: 64, base: 0.5, win: 128, band0: 8, band1: 2, margin: 4, push: 200 };

export class Rings {
  constructor(height) {
    this.height = height; // (x, z) -> metres, the ground as the sim has it
    const R = RING;
    this.lv = [];
    for (let l = 0; l < R.levels; l++) {
      const s = R.base * 2 ** l;
      this.lv.push({ s, H: (R.cells / 2) * s, ci: 0, cj: 0, cx: 0, cz: 0, wi: null, wj: null, data: new Float32Array(R.win * R.win), dirty: false });
    }
    this.filled = 0; // texels filled in the last update, for the cost check
  }
  reset() { for (const L of this.lv) { L.wi = L.wj = null; } }
  // Centre every level on (x, z); fill the texels a level's window has gained once its centre has drifted `margin`
  // texels from the window's middle: one level a frame, unless a centre is near the window's edge (a mesh needs 33
  // texels each side). Returns the levels that changed.
  update(x, z) {
    const R = RING, out = [], half = R.win / 2;
    this.filled = 0;
    for (let l = 0; l < R.levels; l++) {
      const L = this.lv[l];
      L.ci = Math.round(x / L.s); L.cj = Math.round(z / L.s); L.cx = L.ci * L.s; L.cz = L.cj * L.s;
      if (L.wi === null) continue;
      const drift = Math.max(Math.abs(L.ci - (L.wi + half)), Math.abs(L.cj - (L.wj + half)));
      if (drift <= R.margin || (out.length && drift < half - 36)) continue;
      const ni = L.ci - half, nj = L.cj - half, oi = L.wi, oj = L.wj;
      for (let j = nj; j < nj + R.win; j++) for (let i = ni; i < ni + R.win; i++) {
        if (oi !== null && i >= oi && i < oi + R.win && j >= oj && j < oj + R.win) continue; // already there
        L.data[((j & 127) << 7) | (i & 127)] = this.height(i * L.s, j * L.s);
        this.filled++;
      }
      L.wi = ni; L.wj = nj; L.dirty = true; out.push(l);
    }
    for (let l = 0; l < R.levels; l++) { // a new world or a jump: every level at once
      const L = this.lv[l];
      if (L.wi !== null) continue;
      L.wi = L.ci - half; L.wj = L.cj - half;
      for (let j = L.wj; j < L.wj + R.win; j++) for (let i = L.wi; i < L.wi + R.win; i++) { L.data[((j & 127) << 7) | (i & 127)] = this.height(i * L.s, j * L.s); this.filled++; }
      L.dirty = true; out.push(l);
    }
    return out;
  }
  texel(l, i, j) { return this.lv[l].data[((j & 127) << 7) | (i & 127)]; }
  // Level l's own surface at (x, z): the cell's two triangles, as the mesh draws them
  levelH(l, x, z) {
    const s = this.lv[l].s, gx = x / s, gz = z / s, i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const a = this.texel(l, i, j), b = this.texel(l, i + 1, j), c = this.texel(l, i, j + 1), d = this.texel(l, i + 1, j + 1);
    return fx > fz ? a + (b - a) * fx + (d - b) * fz : a + (d - c) * fx + (c - a) * fz;
  }
  // How far level l has morphed into the next at (x, z): 0 inside, 1 near its edge
  morph(l, x, z) {
    const R = RING, L = this.lv[l], m = Math.max(Math.abs(x - L.cx), Math.abs(z - L.cz));
    return Math.min(1, Math.max(0, (m - (L.H - R.band0 * L.s)) / ((R.band0 - R.band1) * L.s)));
  }
  // Level l's drawn surface: its own, morphed into the next near its edge
  surfaceH(l, x, z) {
    const h = this.levelH(l, x, z);
    if (l === RING.levels - 1) return h;
    const k = this.morph(l, x, z);
    return k > 0 ? h + (this.levelH(l + 1, x, z) - h) * k : h;
  }
  // The ground as drawn at (x, z): the finest level that covers it. Everything standing on the ground is lifted by this.
  heightAt(x, z) {
    for (let l = 0; l < RING.levels - 1; l++) {
      const L = this.lv[l];
      if (Math.max(Math.abs(x - L.cx), Math.abs(z - L.cz)) < L.H) return this.surfaceH(l, x, z);
    }
    return this.surfaceH(RING.levels - 1, x, z);
  }
  // A vertex of level l's mesh, at local grid (u, v) in -cells/2..cells/2: where it is drawn, or pushed under the finer level
  ringY(l, u, v) {
    const L = this.lv[l], x = L.cx + u * L.s, z = L.cz + v * L.s;
    if (l > 0) {
      const F = this.lv[l - 1];
      if (Math.max(Math.abs(x - F.cx), Math.abs(z - F.cz)) <= F.H - 2 * L.s) return { x, z, y: this.surfaceH(l, x, z) - RING.push, pushed: true };
    }
    return { x, z, y: this.surfaceH(l, x, z), pushed: false };
  }
}

// The grid every level draws: (cells + 1)^2 vertices at whole local coordinates, each cell two triangles split from
// (i, j) to (i + 1, j + 1), facing up
export function ringGrid() {
  const n = RING.cells, pos = new Float32Array((n + 1) * (n + 1) * 3), idx = new Uint32Array(n * n * 6);
  let p = 0, q = 0;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { pos[p++] = i - n / 2; pos[p++] = 0; pos[p++] = j - n / 2; }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    idx[q++] = a; idx[q++] = d; idx[q++] = b; // (0,0) (1,1) (1,0)
    idx[q++] = a; idx[q++] = c; idx[q++] = d; // (0,0) (0,1) (1,1)
  }
  return { pos, idx };
}

// The GLSL twin of Rings.heightAt / surfaceH / ringY, for the ground's own shader and for lifting everything else
export function ringGLSL() {
  const R = RING, last = R.levels - 1;
  const fetch = Array.from({ length: R.levels }, (_, l) => `${l ? 'else ' : ''}if (l == ${l}) return texelFetch(ringMap${l}, t, 0).r;`).join('\n  ');
  return `
uniform sampler2D ${Array.from({ length: R.levels }, (_, l) => 'ringMap' + l).join(', ')};
uniform vec4 ringLv[${R.levels}]; // centre x, centre z, cell size, half extent
float ringTexel(int l, int i, int j) {
  ivec2 t = ivec2(i & 127, j & 127);
  ${fetch}
  return 0.0;
}
float ringLevelH(int l, vec2 p) {
  float s = ringLv[l].z; vec2 g = p / s; vec2 f0 = floor(g); vec2 f = g - f0; int i = int(f0.x), j = int(f0.y);
  float a = ringTexel(l, i, j), b = ringTexel(l, i + 1, j), c = ringTexel(l, i, j + 1), d = ringTexel(l, i + 1, j + 1);
  return f.x > f.y ? a + (b - a) * f.x + (d - b) * f.y : a + (d - c) * f.x + (c - a) * f.y;
}
float ringMorph(int l, vec2 p) {
  vec2 q = abs(p - ringLv[l].xy); float m = max(q.x, q.y), s = ringLv[l].z;
  return clamp((m - (ringLv[l].w - ${R.band0.toFixed(1)} * s)) / (${(R.band0 - R.band1).toFixed(1)} * s), 0.0, 1.0);
}
float ringSurfaceH(int l, vec2 p) {
  float h = ringLevelH(l, p);
  if (l < ${last}) { float k = ringMorph(l, p); if (k > 0.0) h += (ringLevelH(l + 1, p) - h) * k; }
  return h;
}
float ringHeightAt(vec2 p) {
  for (int l = 0; l < ${last}; l++) { vec2 q = abs(p - ringLv[l].xy); if (max(q.x, q.y) < ringLv[l].w) return ringSurfaceH(l, p); }
  return ringSurfaceH(${last}, p);
}
`;
}
