// The wild source: a standalone, seed-driven landscape for the world template, at every scale from a wasp's
// centimetres to kilometres of hills. One function, twice: JS (placement, ground clamp, tests) and GLSL (terrain
// tiles on the GPU), built from the same constants so they agree to float precision.
//
// sample(x, z) -> [height m, moisture 0..1, forest 0..1, trail 0..1, water level m]. Water fills everything below the
// water level: the sea (P.sea) over most of the world, a lake's own level inside its basin (W3).
//   ocean   the continental noise lowers the land toward its low side, so there is a coast with bays and headlands;
//   lakes   one basin at most per 2.2 km cell (about half the cells): a bowl carved into the broad shape, its level a
//           few metres under the land round it, with a rim held above the level for a third of the radius outside, so
//           the water stays in. The water level field is that level inside the basin and its rim band, the sea
//           elsewhere; it jumps only where the ground is above both, so no water shows at the jump.
//   height  derivative-damped fbm (each octave divided by 1 + |sum of gradients so far|^2, which reads like
//           erosion: soft valleys, sharp crests), rotated off the lattice and domain-warped; ridged mountains on
//           a continental mask, cut into soft ledges when P.blocky > 0 (the Minecraft-ish stone steps);
//           rivers carved along the zero line of a warped noise, by true distance in metres (|n| / |grad n|),
//           only in the lowlands; a little roughness at wasp scale.
//   forest  big warped patches, nudged by moisture, thinned with height, none at the shore.
//   trail   a winding footpath network (zero lines of another noise), in meadows only.
import { vnoised, smoothstep, clamp, NOISE_GLSL, hash3, hash01 } from '../noise.js';

export const WILD = {
  cell: 1800,      // metres per lattice cell of the broad shape
  octaves: 10,     // down to about 3.5 m
  warp: 0.55,
  hills: 80,       // metres per unit of the broad shape
  lift: 14,        // metres added, so most land is above the water
  mountains: 780,  // metres at the top of a full ridge (W3: a fjord coast, the ridges rise from the sea)
  ridgeCell: 3400,
  roll: 22, rollCell: 520, // rolling hills: metres, cell
  beach: 0.3,      // the shore's slope at the water line, as a share of the land's own: the sand runs out under the water
  beachBand: 2.5,  // metres above and below the line over which the slope comes back to the land's
  shelf: 2.4,      // metres a lake's floor drops past its shallows
  shelfAt: 1.5,    // metres of depth where that drop begins (over 2 m more)
  // the sea's surf platform (W3.1): a dissipative nearshore — the floor shelves at surfK of the land's slope for the
  // first surfD metres of depth, then rejoins it smoothly, so a coast of 1:30 has a platform of about 1:100 some 180 m
  // wide where the waves spill and stay broken all the way in; a sandbar on it at barAt metres, up to bar metres high,
  // with gaps along the shore (rip channels) where it fades
  surfK: 0.3, surfD: 6, bar: 0.5, barAt: 1.1, barW: 0.35, barCell: 110,
  contCell: 9000,
  step: 5,         // metres between ledges on mountains
  riverCell: 2600,
  riverW: 7, riverBank: 15, riverDepth: 2.6,
  trailCell: 420, trailW: 0.75,
  moistCell: 1300, forestCell: 760,
  ocean: 70,       // metres the land drops toward the low side of the continental noise
  lakeCell: 2200, lakeShare: 0.75, lakeR: [160, 560], lakeDrop: [2, 6], lakeDepth: [4, 14], lakeRim: 0.35, lakeBlend: 0.15,
};

export function wildParams(o = {}) {
  return { seed: o.seed ?? 1234, sea: o.sea ?? 0, relief: o.relief ?? 1, blocky: o.blocky ?? 0.6, rivers: o.rivers ?? 1, forests: o.forests ?? 1, trails: o.trails ?? 1 };
}

const N = [0, 0, 0];
const ss = (s, k) => (s * 7919 + k * 104729) | 0; // octave and layer seeds

// the broad shape (the damped fbm, the rolling hills and the lift), with the low-octave version alongside; writes
// [h, hlo, w1, w2] into out
function broad(P, x, z, out) {
  const W = WILD, S = P.seed | 0;
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
  // rolling hills between the big shapes: a second damped fbm at a few hundred metres
  let rh = 0, rbb = 1, rdx = 0, rdy = 0, hx = (0.8 * x + 0.6 * z) / W.rollCell + 1.7 * w2, hz = (-0.6 * x + 0.8 * z) / W.rollCell - 1.3 * w1;
  for (let i = 0; i < 4; i++) {
    vnoised(hx, hz, ss(S, 50 + i), N);
    rdx += N[1]; rdy += N[2];
    rh += rbb * N[0] / (1 + rdx * rdx + rdy * rdy);
    rbb *= 0.45; const qx = 0.8 * hx - 0.6 * hz, qz = 0.6 * hx + 0.8 * hz; hx = qx * 2.1; hz = qz * 2.1;
  }
  // the ocean: the land drops toward the low side of the continental noise
  vnoised(x / W.contCell + 0.37, z / W.contCell - 0.61, ss(S, 3), N);
  const cn = N[0], ocean = W.ocean * smoothstep(0.0, -0.45, cn);
  out[0] = (W.hills * a + W.roll * rh + W.lift) * P.relief - ocean;
  out[1] = (W.hills * alo + W.roll * rh + W.lift) * P.relief - ocean;
  out[2] = w1; out[3] = w2; out[4] = cn;
  return out;
}
// the lake of the cell that (x, z) is in, if the cell has one: centre, radius, level, depth; null otherwise
const LK = { cx: 0, cz: 0, R: 0, level: 0, depth: 0, d: 0 };
export function lakeAt(P, x, z) {
  const W = WILD, S = P.seed | 0, ci = Math.floor(x / W.lakeCell), cj = Math.floor(z / W.lakeCell);
  if (hash01(ci, cj, ss(S, 70)) > W.lakeShare) return null;
  let R = W.lakeR[0] + (W.lakeR[1] - W.lakeR[0]) * hash01(ci, cj, ss(S, 71));
  const jit = Math.max(0, W.lakeCell / 2 - R * 1.32 * (1 + W.lakeRim) - 10); // the basin, its wandering shore and its rim stay inside the cell
  const cx = (ci + 0.5) * W.lakeCell + (hash01(ci, cj, ss(S, 72)) * 2 - 1) * jit, cz = (cj + 0.5) * W.lakeCell + (hash01(ci, cj, ss(S, 73)) * 2 - 1) * jit;
  // the shore wanders: the radius varies round the basin by a noise read round a circle (continuous at the seam)
  const a = Math.atan2(z - cz, x - cx), R0 = R;
  vnoised(1.6 + 1.9 * Math.cos(a), 2.3 + 1.9 * Math.sin(a), ss(S, 77) + ci * 31 + cj * 17, N);
  R *= 1 + 0.32 * N[0];
  const d = Math.hypot(x - cx, z - cz);
  if (d > R0 * 1.32 * (1 + W.lakeRim)) return null;
  // the level: a few metres under the lowest of the broad shape at the centre and at four points on the rim, so the
  // land round the basin is mostly above it by itself (the rim band holds the rest)
  broad(P, cx, cz, B2); let lo = B2[1];
  const rr = R0 * (1 + 0.4 * W.lakeRim);
  for (let k = 0; k < 4; k++) { broad(P, cx + rr * RIM[k][0], cz + rr * RIM[k][1], B2); lo = Math.min(lo, B2[1]); }
  const level = lo - (W.lakeDrop[0] + (W.lakeDrop[1] - W.lakeDrop[0]) * hash01(ci, cj, ss(S, 74)));
  if (level < P.sea + 4 || level > 120) return null; // in the sea, or up a mountain: no lake
  LK.cx = cx; LK.cz = cz; LK.R = R; LK.level = level; LK.d = d;
  LK.depth = W.lakeDepth[0] + (W.lakeDepth[1] - W.lakeDepth[0]) * hash01(ci, cj, ss(S, 75));
  return LK;
}
const B1 = [0, 0, 0, 0, 0], B2 = [0, 0, 0, 0, 0], RIM = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export function wildSample(P, x, z, out = [0, 0, 0, 0, 0]) {
  const W = WILD, S = P.seed | 0;
  broad(P, x, z, B1);
  let h = B1[0]; const hlo = B1[1], w1 = B1[2], w2 = B1[3];
  // the lake here, if any: its level is the water line for the beach and the shelf, and its bowl replaces the ground
  const lake = lakeAt(P, x, z);
  let wl = P.sea, inLake = 0, band = 0;
  if (lake) {
    const R = lake.R, d = lake.d;
    inLake = 1 - smoothstep(R * (1 - W.lakeBlend), R, d);
    // the rim: from the basin's edge out to 0.6 of the rim width the land is held above the level (at the end, after
    // every other term), then it blends back to itself; the water level is the lake's only to 0.4 of the rim, where
    // the land is held, so where the level field jumps to the sea the ground is above both
    band = 1 - smoothstep(R * (1 + 0.6 * W.lakeRim), R * (1 + W.lakeRim), d);
    if (d < R * (1 + 0.4 * W.lakeRim)) wl = lake.level;
  }
  // beaches: waves smooth the ground near the water, so the fine octaves give way to the broad shape there; and the
  // shore crosses the water line at a fraction of the land's slope (the height above the line is scaled by a factor
  // that grows back to 1 over the band), so the sand slopes gently into the shallows, where the floor shows through,
  // and the floor drops away only past them. The scaling keeps the sign of the height, so the water line itself is
  // where it was and no puddles appear
  h += (hlo - h) * (1 - smoothstep(1.5, 5, Math.abs(hlo - wl)));
  {
    const e = h - wl;
    if (wl === P.sea && e < 0) { // the sea's floor: the surf platform and its bar
      const d = -e, K = W.surfK, sm = (q) => 0.5 * (q + Math.sqrt(q * q + 4));
      let d2 = K * d + (1 - K) * (sm(d - W.surfD) - sm(-W.surfD));
      vnoised(x / W.barCell, z / W.barCell, ss(S, 81), N); const bar = W.bar * smoothstep(-0.25, 0.35, N[0]);
      const d3 = d2 - bar * Math.exp(-(((d2 - W.barAt) / W.barW) ** 2));
      h = wl - Math.max(d3, Math.min(d2, 0.3)); // the bar's crest stays under water
    } else { const k = W.beach + (1 - W.beach) * smoothstep(0, W.beachBand, Math.abs(e)); h = wl + e * k; if (e < 0) h -= W.shelf * smoothstep(W.shelfAt, W.shelfAt + 2, -e * k); }
  }
  // mountains: ridged noise on a continental mask
  const cont = smoothstep(-0.2, 0.45, B1[4]) * (1 - inLake);
  let r = 0, rb = 0.55, rx = (0.6 * x + 0.8 * z + 611 * w1) / W.ridgeCell, rz = (-0.8 * x + 0.6 * z - 577 * w2) / W.ridgeCell, prev = 1;
  for (let i = 0; i < 6; i++) {
    vnoised(rx, rz, ss(S, 30 + i), N);
    const k = 1 - Math.abs(N[0]), kk = k * k * k * prev;
    r += rb * kk; prev = clamp(kk * 2.2, 0, 1); rb *= 0.48;
    const qx = 0.8 * rx - 0.6 * rz, qz = 0.6 * rx + 0.8 * rz; rx = qx * 2.07; rz = qz * 2.07;
  }
  let m = W.mountains * cont * Math.sqrt(cont) * r * P.relief;
  if (P.blocky > 0 && m > 0) { // soft ledges: the riser takes (1 - blocky) of each step, the tread is level
    const q = m / W.step, fl = Math.floor(q), f = q - fl, k = 0.5 * (1 - P.blocky) + 0.02;
    m = (fl + smoothstep(0.5 - k, 0.5 + k, f)) * W.step;
  }
  h += m;
  // rivers: true distance from the zero line, in metres, lowlands only
  vnoised((x + 520 * w2) / W.riverCell, (z - 480 * w1) / W.riverCell, ss(S, 4), N);
  const rd = Math.abs(N[0]) / Math.max(Math.hypot(N[1], N[2]), 0.08) * W.riverCell;
  const low = 1 - smoothstep(18, 55, h);
  const river = (1 - smoothstep(W.riverW, W.riverW + W.riverBank, rd)) * low * P.rivers * (1 - inLake) * (1 - band);
  h += (Math.min(h, P.sea - W.riverDepth * (1 - smoothstep(0, W.riverW, rd) * 0.4)) - h) * river;
  // the lake's bowl: a basin under its level, shallow over its outer third, blended into the land over the outer part of the radius
  if (inLake > 0) { const q = lake.d / lake.R; vnoised(x / 90, z / 90, ss(S, 76), N); const bowl = lake.level - lake.depth * (1 - q * q) * (1 - q * q) * (0.85 + 0.15 * N[0]); h += (bowl - h) * inLake; } // (1 - q^2)^2: shallow for the outer third
  // moisture
  vnoised(x / W.moistCell + 9.1, z / W.moistCell - 2.3, ss(S, 5), N);
  const moist = clamp(0.5 + 0.45 * N[0] + 0.4 * (1 - smoothstep(wl, wl + 14, h)) - 0.3 * smoothstep(300, 600, h - P.sea), 0, 1);
  // forest
  vnoised((0.8 * x - 0.6 * z + 340 * w1) / W.forestCell, (0.6 * x + 0.8 * z + 360 * w2) / W.forestCell, ss(S, 6), N); let fo = N[0];
  vnoised((0.6 * x + 0.8 * z) / (W.forestCell * 0.31) + 2.2 * w2, (-0.8 * x + 0.6 * z) / (W.forestCell * 0.31) - 1.7 * w1, ss(S, 60), N); fo += 0.45 * N[0];
  vnoised(x / (W.forestCell * 0.09), z / (W.forestCell * 0.09), ss(S, 61), N); fo += 0.18 * N[0];
  const forest = smoothstep(0.02, 0.3, fo + 0.3 * (moist - 0.5)) * (1 - smoothstep(420, 560, h - P.sea)) * smoothstep(wl + 1.2, wl + 3.5, h) * (1 - river) * P.forests;
  // trails, in meadows
  vnoised((x - 90 * w2) / W.trailCell, (z + 70 * w1) / W.trailCell, ss(S, 7), N);
  const td = Math.abs(N[0]) / Math.max(Math.hypot(N[1], N[2]), 0.1) * W.trailCell;
  const trail = (1 - smoothstep(W.trailW * 0.6, W.trailW * 1.5, td)) * (1 - smoothstep(0.35, 0.6, forest)) * smoothstep(wl + 1.5, wl + 3, h) * (1 - smoothstep(60, 90, h - P.sea)) * P.trails;
  // wasp-scale roughness, flattened on trails and at the shore
  vnoised(x / 2.3 + 0.5, z / 2.3 - 0.5, ss(S, 8), N); let micro = 0.12 * N[0];
  vnoised(x / 0.83, z / 0.83, ss(S, 9), N); micro += 0.035 * N[0];
  h += micro * (1 - trail) * smoothstep(wl + 0.3, wl + 2, h) - 0.07 * trail;
  if (lake && band > 0 && inLake < 1) h += (Math.max(h, lake.level + 1.2) - h) * band * (1 - inLake); // the rim, held last
  out[0] = h; out[1] = moist; out[2] = forest; out[3] = trail; out[4] = wl;
  return out;
}

// GLSL twin: vec4 wildSample(vec2 xz), float wildWater(vec2 xz), with uniforms wSeed, wSea, wRelief, wBlocky, wRivers,
// wForests, wTrails
const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
export function wildGLSL() {
  const W = WILD;
  return NOISE_GLSL + /* glsl */ `
uniform int wSeed;
uniform float wSea, wRelief, wBlocky, wRivers, wForests, wTrails;
int wss(int k) { return wSeed * 7919 + k * 104729; }
float wsmooth(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// the broad shape: (h, hlo, w1, w2) and the continental noise in c
vec4 wBroad(vec2 xz, out float c) {
  float x = xz.x, z = xz.y;
  float bx = (0.6 * x - 0.8 * z) / ${f(W.cell)}, by = (0.8 * x + 0.6 * z) / ${f(W.cell)};
  float w1 = w2noise(vec2(bx * 0.5 + 3.1, by * 0.5 + 7.7), wss(1));
  float w2 = w2noise(vec2(bx * 0.5 - 5.3, by * 0.5 + 1.9), wss(2));
  vec2 p = vec2(bx + ${f(W.warp)} * w1, by + ${f(W.warp)} * w2);
  float a = 0.0, b = 1.0, alo = 0.0; vec2 d = vec2(0.0);
  for (int i = 0; i < ${W.octaves}; i++) {
    vec3 n = w2noised(p, wss(10 + i));
    d += n.yz;
    a += b * n.x / (1.0 + dot(d, d));
    if (i == 5) alo = a;
    b *= 0.5;
    p = vec2(0.8 * p.x - 0.6 * p.y, 0.6 * p.x + 0.8 * p.y) * 2.03;
  }
  float rh = 0.0, rbb = 1.0; vec2 rd2 = vec2(0.0);
  vec2 hp = vec2((0.8 * x + 0.6 * z) / ${f(W.rollCell)} + 1.7 * w2, (-0.6 * x + 0.8 * z) / ${f(W.rollCell)} - 1.3 * w1);
  for (int i = 0; i < 4; i++) {
    vec3 n = w2noised(hp, wss(50 + i));
    rd2 += n.yz;
    rh += rbb * n.x / (1.0 + dot(rd2, rd2));
    rbb *= 0.45; hp = vec2(0.8 * hp.x - 0.6 * hp.y, 0.6 * hp.x + 0.8 * hp.y) * 2.1;
  }
  c = w2noise(vec2(x / ${f(W.contCell)} + 0.37, z / ${f(W.contCell)} - 0.61), wss(3));
  float ocean = ${f(W.ocean)} * wsmooth(0.0, -0.45, c);
  return vec4((${f(W.hills)} * a + ${f(W.roll)} * rh + ${f(W.lift)}) * wRelief - ocean, (${f(W.hills)} * alo + ${f(W.roll)} * rh + ${f(W.lift)}) * wRelief - ocean, w1, w2);
}
// the lake of this cell, if any: (centre x, centre z, radius here, level) and the depth; false when none
bool wLake(vec2 xz, out vec4 L, out float depth, out float d) {
  int ci = int(floor(xz.x / ${f(W.lakeCell)})), cj = int(floor(xz.y / ${f(W.lakeCell)}));
  if (w2hash01(ci, cj, wss(70)) > ${f(W.lakeShare)}) return false;
  float R0 = ${f(W.lakeR[0])} + ${f(W.lakeR[1] - W.lakeR[0])} * w2hash01(ci, cj, wss(71));
  float jit = max(0.0, ${f(W.lakeCell / 2)} - R0 * ${f(1.32 * (1 + W.lakeRim))} - 10.0);
  vec2 c = (vec2(float(ci), float(cj)) + 0.5) * ${f(W.lakeCell)} + (vec2(w2hash01(ci, cj, wss(72)), w2hash01(ci, cj, wss(73))) * 2.0 - 1.0) * jit;
  float a = atan(xz.y - c.y, xz.x - c.x);
  float R = R0 * (1.0 + 0.32 * w2noise(vec2(1.6 + 1.9 * cos(a), 2.3 + 1.9 * sin(a)), wss(77) + ci * 31 + cj * 17));
  d = length(xz - c);
  if (d > R0 * ${f(1.32 * (1 + W.lakeRim))}) return false;
  float cc; float lo = wBroad(c, cc).y, rr = R0 * ${f(1 + 0.4 * W.lakeRim)};
  lo = min(lo, wBroad(c + vec2(rr, 0.0), cc).y); lo = min(lo, wBroad(c + vec2(0.0, rr), cc).y);
  lo = min(lo, wBroad(c - vec2(rr, 0.0), cc).y); lo = min(lo, wBroad(c - vec2(0.0, rr), cc).y);
  float level = lo - (${f(W.lakeDrop[0])} + ${f(W.lakeDrop[1] - W.lakeDrop[0])} * w2hash01(ci, cj, wss(74)));
  if (level < wSea + 4.0 || level > 120.0) return false;
  depth = ${f(W.lakeDepth[0])} + ${f(W.lakeDepth[1] - W.lakeDepth[0])} * w2hash01(ci, cj, wss(75));
  L = vec4(c, R, level);
  return true;
}
// the water's kind and flow (W3, the clipmap's water layer): (the river's share of the water here, its velocity x, z),
// worked out only when asked (wildWaterFlow), as it reads the broad shape twice more
bool wWantFlow = false; vec3 wFlow = vec3(0.0);
void wildSampleW(vec2 xz, out vec4 S, out float wlOut) {
  float x = xz.x, z = xz.y;
  float cn; vec4 B = wBroad(xz, cn);
  float h = B.x, hlo = B.y, w1 = B.z, w2 = B.w;
  vec4 L; float depth, d; bool lake = wLake(xz, L, depth, d);
  float wl = wSea, inLake = 0.0, band = 0.0;
  if (lake) {
    float R = L.z;
    inLake = 1.0 - wsmooth(R * ${f(1 - W.lakeBlend)}, R, d);
    band = 1.0 - wsmooth(R * ${f(1 + 0.6 * W.lakeRim)}, R * ${f(1 + W.lakeRim)}, d);
    if (d < R * ${f(1 + 0.4 * W.lakeRim)}) wl = L.w;
  }
  h += (hlo - h) * (1.0 - wsmooth(1.5, 5.0, abs(hlo - wl)));
  {
    float e = h - wl;
    if (wl == wSea && e < 0.0) {
      float d = -e, K = ${f(W.surfK)};
      float q1 = d - ${f(W.surfD)}, q0 = -${f(W.surfD)};
      float d2 = K * d + (1.0 - K) * (0.5 * (q1 + sqrt(q1 * q1 + 4.0)) - 0.5 * (q0 + sqrt(q0 * q0 + 4.0)));
      float bar = ${f(W.bar)} * wsmooth(-0.25, 0.35, w2noised(vec2(x, z) / ${f(W.barCell)}, wss(81)).x);
      float br = (d2 - ${f(W.barAt)}) / ${f(W.barW)};
      float d3 = d2 - bar * exp(-br * br);
      h = wl - max(d3, min(d2, 0.3));
    } else { float k = ${f(W.beach)} + ${f(1 - WILD.beach)} * wsmooth(0.0, ${f(W.beachBand)}, abs(e)); h = wl + e * k; if (e < 0.0) h -= ${f(W.shelf)} * wsmooth(${f(W.shelfAt)}, ${f(W.shelfAt + 2)}, -e * k); }
  }
  float cont = wsmooth(-0.2, 0.45, cn) * (1.0 - inLake);
  float r = 0.0, rb = 0.55, prev = 1.0;
  vec2 rp = vec2((0.6 * x + 0.8 * z + 611.0 * w1) / ${f(W.ridgeCell)}, (-0.8 * x + 0.6 * z - 577.0 * w2) / ${f(W.ridgeCell)});
  for (int i = 0; i < 6; i++) {
    float k = 1.0 - abs(w2noise(rp, wss(30 + i))); float kk = k * k * k * prev;
    r += rb * kk; prev = clamp(kk * 2.2, 0.0, 1.0); rb *= 0.48;
    rp = vec2(0.8 * rp.x - 0.6 * rp.y, 0.6 * rp.x + 0.8 * rp.y) * 2.07;
  }
  float m = ${f(W.mountains)} * cont * sqrt(cont) * r * wRelief;
  if (wBlocky > 0.0 && m > 0.0) {
    float q = m / ${f(W.step)}; float fl = floor(q); float fr = q - fl; float k = 0.5 * (1.0 - wBlocky) + 0.02;
    m = (fl + wsmooth(0.5 - k, 0.5 + k, fr)) * ${f(W.step)};
  }
  h += m;
  vec3 rn = w2noised(vec2((x + 520.0 * w2) / ${f(W.riverCell)}, (z - 480.0 * w1) / ${f(W.riverCell)}), wss(4));
  float rd = abs(rn.x) / max(length(rn.yz), 0.08) * ${f(W.riverCell)};
  float low = 1.0 - wsmooth(18.0, 55.0, h);
  float river = (1.0 - wsmooth(${f(W.riverW)}, ${f(W.riverW + W.riverBank)}, rd)) * low * wRivers * (1.0 - inLake) * (1.0 - band);
  wFlow = vec3(0.0);
  if (wWantFlow && river > 0.0) {
    // flowing water: the channel's share (fading where the land round it drops into the sea), its direction along the
    // channel (the noise's zero line), downhill on the broad land over 80 m, faster for a steeper fall, fastest
    // mid-channel and slow at the banks; where the land is level along it the flow slows to nothing (no flip)
    float share = river * wsmooth(-0.5, 1.5, h - wl);
    vec2 g = rn.yz; float gl = length(g);
    if (share > 0.0 && gl > 1e-6) {
      vec2 t = vec2(-g.y, g.x) / gl; float cc2;
      float dh = wBroad(xz + t * 40.0, cc2).y - wBroad(xz - t * 40.0, cc2).y; // the rise along t over 80 m
      float v = (0.3 * clamp(dh / 0.4, -1.0, 1.0) + clamp(dh * 0.75, -1.5, 1.5)) * (0.3 + 0.7 * (1.0 - wsmooth(0.0, ${f(W.riverW + W.riverBank * 0.5)}, rd)));
      wFlow = vec3(share, -t * v * share); // the jet slows as it spreads into the sea
    }
  }
  h += (min(h, wSea - ${f(W.riverDepth)} * (1.0 - wsmooth(0.0, ${f(W.riverW)}, rd) * 0.4)) - h) * river;
  if (inLake > 0.0) { float q = d / L.z; float bowl = L.w - depth * (1.0 - q * q) * (1.0 - q * q) * (0.85 + 0.15 * w2noise(xz / 90.0, wss(76))); h += (bowl - h) * inLake; }
  float moist = clamp(0.5 + 0.45 * w2noise(vec2(x / ${f(W.moistCell)} + 9.1, z / ${f(W.moistCell)} - 2.3), wss(5)) + 0.4 * (1.0 - wsmooth(wl, wl + 14.0, h)) - 0.3 * wsmooth(300.0, 600.0, h - wSea), 0.0, 1.0);
  float fo = w2noise(vec2((0.8 * x - 0.6 * z + 340.0 * w1) / ${f(W.forestCell)}, (0.6 * x + 0.8 * z + 360.0 * w2) / ${f(W.forestCell)}), wss(6));
  fo += 0.45 * w2noise(vec2((0.6 * x + 0.8 * z) / ${f(W.forestCell * 0.31)} + 2.2 * w2, (-0.8 * x + 0.6 * z) / ${f(W.forestCell * 0.31)} - 1.7 * w1), wss(60));
  fo += 0.18 * w2noise(vec2(x / ${f(W.forestCell * 0.09)}, z / ${f(W.forestCell * 0.09)}), wss(61));
  float forest = wsmooth(0.02, 0.3, fo + 0.3 * (moist - 0.5)) * (1.0 - wsmooth(420.0, 560.0, h - wSea)) * wsmooth(wl + 1.2, wl + 3.5, h) * (1.0 - river) * wForests;
  vec3 tn = w2noised(vec2((x - 90.0 * w2) / ${f(W.trailCell)}, (z + 70.0 * w1) / ${f(W.trailCell)}), wss(7));
  float td = abs(tn.x) / max(length(tn.yz), 0.1) * ${f(W.trailCell)};
  float trail = (1.0 - wsmooth(${f(W.trailW * 0.6)}, ${f(W.trailW * 1.5)}, td)) * (1.0 - wsmooth(0.35, 0.6, forest)) * wsmooth(wl + 1.5, wl + 3.0, h) * (1.0 - wsmooth(60.0, 90.0, h - wSea)) * wTrails;
  float micro = 0.12 * w2noise(vec2(x / 2.3 + 0.5, z / 2.3 - 0.5), wss(8)) + 0.035 * w2noise(vec2(x / 0.83, z / 0.83), wss(9));
  h += micro * (1.0 - trail) * wsmooth(wl + 0.3, wl + 2.0, h) - 0.07 * trail;
  if (lake && band > 0.0 && inLake < 1.0) h += (max(h, L.w + 1.2) - h) * band * (1.0 - inLake);
  S = vec4(h, moist, forest, trail); wlOut = wl;
}
vec4 wildSample(vec2 xz) { vec4 S; float wl; wildSampleW(xz, S, wl); return S; }
float wildWater(vec2 xz) { vec4 S; float wl; wildSampleW(xz, S, wl); return wl; }
vec4 wildWaterFlow(vec2 xz) { wWantFlow = true; vec4 S; float wl; wildSampleW(xz, S, wl); wWantFlow = false; return vec4(wl, wFlow); }
`;
}

export function wildUniforms(P) {
  return {
    wSeed: { value: P.seed | 0 }, wSea: { value: P.sea }, wRelief: { value: P.relief }, wBlocky: { value: P.blocky },
    wRivers: { value: P.rivers }, wForests: { value: P.forests }, wTrails: { value: P.trails },
  };
}

// The source object the world reads (see ../WORLD.md, "Sources")
export function wildSource(opts = {}) {
  const P = wildParams(opts);
  return {
    kind: 'wild',
    params: P,
    sea: P.sea,
    sample: (x, z, out) => wildSample(P, x, z, out),
    height: (x, z) => wildSample(P, x, z, TMP)[0],
    waterAt: (x, z) => wildSample(P, x, z, TMP)[4], // the water level there: the sea, or a lake's own
    lakeAt: (x, z) => lakeAt(P, x, z),
    glsl: wildGLSL(),            // present: the terrain tiles are drawn on the GPU
    uniforms: wildUniforms(P),
    // trees come from the scatter system (forest density); the wild source has no fixed objects
    objects: null,
    grassHeight: [0.1, 0.42], // a wild meadow: ankle-high where dry, knee-high where wet
    cosmetic: hash3(P.seed | 0, 0xc05, 77) & 0xfffff, // decoration's salt, from the world's seed
    // lakes and the sea: wind over 600 m of open water; tiles of 48 m down to 14 cm, from metre chop to millimetre ripples
    water: { swellFetch: 40000, fetch: 600, cascades: [600, 12, 1.0, 0.14] }, // as Ultra-Water: the first tile holds the swell (to ~10 s, 170 m: three to four wavelengths a tile)
  };
}
const TMP = [0, 0, 0, 0, 0];
