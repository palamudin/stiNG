// The wild source: a standalone, seed-driven landscape for the world template, at every scale from a wasp's
// centimetres to kilometres of hills. One function, twice: JS (placement, ground clamp, tests) and GLSL (terrain
// tiles on the GPU), built from the same constants so they agree to float precision.
//
// sample(x, z) -> [height m, moisture 0..1, forest 0..1, trail 0..1]. Water fills everything below P.sea.
//   height  derivative-damped fbm (each octave divided by 1 + |sum of gradients so far|^2, which reads like
//           erosion: soft valleys, sharp crests), rotated off the lattice and domain-warped; ridged mountains on
//           a continental mask, cut into soft ledges when P.blocky > 0 (the Minecraft-ish stone steps);
//           rivers carved along the zero line of a warped noise, by true distance in metres (|n| / |grad n|),
//           only in the lowlands; a little roughness at wasp scale.
//   forest  big warped patches, nudged by moisture, thinned with height, none at the shore.
//   trail   a winding footpath network (zero lines of another noise), in meadows only.
import { vnoised, smoothstep, clamp, NOISE_GLSL, hash3 } from '../noise.js';

export const WILD = {
  cell: 1800,      // metres per lattice cell of the broad shape
  octaves: 10,     // down to about 3.5 m
  warp: 0.55,
  hills: 64,       // metres per unit of the broad shape
  lift: 14,        // metres added, so most land is above the water
  mountains: 520,  // metres at the top of a full ridge
  ridgeCell: 3400,
  roll: 22, rollCell: 520, // rolling hills: metres, cell
  beach: 0.8,      // metres the shore is pushed away from the water line either side
  shelf: 2.4,      // metres a lake drops past its shallow shelf
  contCell: 9000,
  step: 5,         // metres between ledges on mountains
  riverCell: 2600,
  riverW: 7, riverBank: 15, riverDepth: 2.6,
  trailCell: 420, trailW: 0.75,
  moistCell: 1300, forestCell: 760,
};

export function wildParams(o = {}) {
  return { seed: o.seed ?? 1234, sea: o.sea ?? 0, relief: o.relief ?? 1, blocky: o.blocky ?? 0.6, rivers: o.rivers ?? 1, forests: o.forests ?? 1, trails: o.trails ?? 1 };
}

const N = [0, 0, 0];
const ss = (s, k) => (s * 7919 + k * 104729) | 0; // octave and layer seeds

export function wildSample(P, x, z, out = [0, 0, 0, 0]) {
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
  let h = (W.hills * a + W.roll * rh + W.lift) * P.relief;
  // beaches: waves smooth the ground near the water, so the fine octaves give way to the broad shape there, and the
  // shore crosses the water line with a definite slope instead of a plain of puddles
  const hlo = (W.hills * alo + W.roll * rh + W.lift) * P.relief;
  h += (hlo - h) * (1 - smoothstep(1.5, 5, Math.abs(hlo - P.sea)));
  { const e = h - P.sea; h += W.beach * e / Math.sqrt(e * e + 0.36); if (e < 0) h -= W.shelf * smoothstep(0.2, 1.8, -e); }
  // mountains: ridged noise on a continental mask
  vnoised(x / W.contCell + 0.37, z / W.contCell - 0.61, ss(S, 3), N);
  const cont = smoothstep(-0.25, 0.6, N[0]);
  let r = 0, rb = 0.55, rx = (0.6 * x + 0.8 * z + 611 * w1) / W.ridgeCell, rz = (-0.8 * x + 0.6 * z - 577 * w2) / W.ridgeCell, prev = 1;
  for (let i = 0; i < 6; i++) {
    vnoised(rx, rz, ss(S, 30 + i), N);
    const k = 1 - Math.abs(N[0]), kk = k * k * k * prev;
    r += rb * kk; prev = clamp(kk * 2.2, 0, 1); rb *= 0.48;
    const qx = 0.8 * rx - 0.6 * rz, qz = 0.6 * rx + 0.8 * rz; rx = qx * 2.07; rz = qz * 2.07;
  }
  let m = W.mountains * cont * cont * cont * r * P.relief;
  if (P.blocky > 0 && m > 0) { // soft ledges: the riser takes (1 - blocky) of each step, the tread is level
    const q = m / W.step, fl = Math.floor(q), f = q - fl, k = 0.5 * (1 - P.blocky) + 0.02;
    m = (fl + smoothstep(0.5 - k, 0.5 + k, f)) * W.step;
  }
  h += m;
  // rivers: true distance from the zero line, in metres, lowlands only
  vnoised((x + 520 * w2) / W.riverCell, (z - 480 * w1) / W.riverCell, ss(S, 4), N);
  const rd = Math.abs(N[0]) / Math.max(Math.hypot(N[1], N[2]), 0.08) * W.riverCell;
  const low = 1 - smoothstep(18, 55, h);
  const river = (1 - smoothstep(W.riverW, W.riverW + W.riverBank, rd)) * low * P.rivers;
  h += (Math.min(h, P.sea - W.riverDepth * (1 - smoothstep(0, W.riverW, rd) * 0.4)) - h) * river;
  // moisture
  vnoised(x / W.moistCell + 9.1, z / W.moistCell - 2.3, ss(S, 5), N);
  const moist = clamp(0.5 + 0.45 * N[0] + 0.4 * (1 - smoothstep(P.sea, P.sea + 14, h)) - 0.3 * smoothstep(90, 220, h), 0, 1);
  // forest
  vnoised((0.8 * x - 0.6 * z + 340 * w1) / W.forestCell, (0.6 * x + 0.8 * z + 360 * w2) / W.forestCell, ss(S, 6), N); let fo = N[0];
  vnoised((0.6 * x + 0.8 * z) / (W.forestCell * 0.31) + 2.2 * w2, (-0.8 * x + 0.6 * z) / (W.forestCell * 0.31) - 1.7 * w1, ss(S, 60), N); fo += 0.45 * N[0];
  vnoised(x / (W.forestCell * 0.09), z / (W.forestCell * 0.09), ss(S, 61), N); fo += 0.18 * N[0];
  const forest = smoothstep(0.02, 0.3, fo + 0.3 * (moist - 0.5)) * (1 - smoothstep(130, 200, h)) * smoothstep(P.sea + 1.2, P.sea + 3.5, h) * (1 - river) * P.forests;
  // trails, in meadows
  vnoised((x - 90 * w2) / W.trailCell, (z + 70 * w1) / W.trailCell, ss(S, 7), N);
  const td = Math.abs(N[0]) / Math.max(Math.hypot(N[1], N[2]), 0.1) * W.trailCell;
  const trail = (1 - smoothstep(W.trailW * 0.6, W.trailW * 1.5, td)) * (1 - smoothstep(0.35, 0.6, forest)) * smoothstep(P.sea + 1.5, P.sea + 3, h) * (1 - smoothstep(60, 90, h)) * P.trails;
  // wasp-scale roughness, flattened on trails and at the shore
  vnoised(x / 2.3 + 0.5, z / 2.3 - 0.5, ss(S, 8), N); let micro = 0.12 * N[0];
  vnoised(x / 0.83, z / 0.83, ss(S, 9), N); micro += 0.035 * N[0];
  h += micro * (1 - trail) * smoothstep(P.sea + 0.3, P.sea + 2, h) - 0.07 * trail;
  out[0] = h; out[1] = moist; out[2] = forest; out[3] = trail;
  return out;
}

// GLSL twin: vec4 wildSample(vec2 xz) with uniforms wSeed, wSea, wRelief, wBlocky, wRivers, wForests, wTrails
const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
export function wildGLSL() {
  const W = WILD;
  return NOISE_GLSL + /* glsl */ `
uniform int wSeed;
uniform float wSea, wRelief, wBlocky, wRivers, wForests, wTrails;
int wss(int k) { return wSeed * 7919 + k * 104729; }
float wsmooth(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec4 wildSample(vec2 xz) {
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
  float h = (${f(W.hills)} * a + ${f(W.roll)} * rh + ${f(W.lift)}) * wRelief;
  float hlo = (${f(W.hills)} * alo + ${f(W.roll)} * rh + ${f(W.lift)}) * wRelief;
  h += (hlo - h) * (1.0 - wsmooth(1.5, 5.0, abs(hlo - wSea)));
  { float e = h - wSea; h += ${f(W.beach)} * e / sqrt(e * e + 0.36); if (e < 0.0) h -= ${f(W.shelf)} * wsmooth(0.2, 1.8, -e); }
  float cont = wsmooth(-0.25, 0.6, w2noise(vec2(x / ${f(W.contCell)} + 0.37, z / ${f(W.contCell)} - 0.61), wss(3)));
  float r = 0.0, rb = 0.55, prev = 1.0;
  vec2 rp = vec2((0.6 * x + 0.8 * z + 611.0 * w1) / ${f(W.ridgeCell)}, (-0.8 * x + 0.6 * z - 577.0 * w2) / ${f(W.ridgeCell)});
  for (int i = 0; i < 6; i++) {
    float k = 1.0 - abs(w2noise(rp, wss(30 + i))); float kk = k * k * k * prev;
    r += rb * kk; prev = clamp(kk * 2.2, 0.0, 1.0); rb *= 0.48;
    rp = vec2(0.8 * rp.x - 0.6 * rp.y, 0.6 * rp.x + 0.8 * rp.y) * 2.07;
  }
  float m = ${f(W.mountains)} * cont * cont * cont * r * wRelief;
  if (wBlocky > 0.0 && m > 0.0) {
    float q = m / ${f(W.step)}; float fl = floor(q); float fr = q - fl; float k = 0.5 * (1.0 - wBlocky) + 0.02;
    m = (fl + wsmooth(0.5 - k, 0.5 + k, fr)) * ${f(W.step)};
  }
  h += m;
  vec3 rn = w2noised(vec2((x + 520.0 * w2) / ${f(W.riverCell)}, (z - 480.0 * w1) / ${f(W.riverCell)}), wss(4));
  float rd = abs(rn.x) / max(length(rn.yz), 0.08) * ${f(W.riverCell)};
  float low = 1.0 - wsmooth(18.0, 55.0, h);
  float river = (1.0 - wsmooth(${f(W.riverW)}, ${f(W.riverW + W.riverBank)}, rd)) * low * wRivers;
  h += (min(h, wSea - ${f(W.riverDepth)} * (1.0 - wsmooth(0.0, ${f(W.riverW)}, rd) * 0.4)) - h) * river;
  float moist = clamp(0.5 + 0.45 * w2noise(vec2(x / ${f(W.moistCell)} + 9.1, z / ${f(W.moistCell)} - 2.3), wss(5)) + 0.4 * (1.0 - wsmooth(wSea, wSea + 14.0, h)) - 0.3 * wsmooth(90.0, 220.0, h), 0.0, 1.0);
  float fo = w2noise(vec2((0.8 * x - 0.6 * z + 340.0 * w1) / ${f(W.forestCell)}, (0.6 * x + 0.8 * z + 360.0 * w2) / ${f(W.forestCell)}), wss(6));
  fo += 0.45 * w2noise(vec2((0.6 * x + 0.8 * z) / ${f(W.forestCell * 0.31)} + 2.2 * w2, (-0.8 * x + 0.6 * z) / ${f(W.forestCell * 0.31)} - 1.7 * w1), wss(60));
  fo += 0.18 * w2noise(vec2(x / ${f(W.forestCell * 0.09)}, z / ${f(W.forestCell * 0.09)}), wss(61));
  float forest = wsmooth(0.02, 0.3, fo + 0.3 * (moist - 0.5)) * (1.0 - wsmooth(130.0, 200.0, h)) * wsmooth(wSea + 1.2, wSea + 3.5, h) * (1.0 - river) * wForests;
  vec3 tn = w2noised(vec2((x - 90.0 * w2) / ${f(W.trailCell)}, (z + 70.0 * w1) / ${f(W.trailCell)}), wss(7));
  float td = abs(tn.x) / max(length(tn.yz), 0.1) * ${f(W.trailCell)};
  float trail = (1.0 - wsmooth(${f(W.trailW * 0.6)}, ${f(W.trailW * 1.5)}, td)) * (1.0 - wsmooth(0.35, 0.6, forest)) * wsmooth(wSea + 1.5, wSea + 3.0, h) * (1.0 - wsmooth(60.0, 90.0, h)) * wTrails;
  float micro = 0.12 * w2noise(vec2(x / 2.3 + 0.5, z / 2.3 - 0.5), wss(8)) + 0.035 * w2noise(vec2(x / 0.83, z / 0.83), wss(9));
  h += micro * (1.0 - trail) * wsmooth(wSea + 0.3, wSea + 2.0, h) - 0.07 * trail;
  return vec4(h, moist, forest, trail);
}
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
    glsl: wildGLSL(),            // present: the terrain tiles are drawn on the GPU
    uniforms: wildUniforms(P),
    // trees come from the scatter system (forest density); the wild source has no fixed objects
    objects: null,
    grassHeight: [0.1, 0.42], // a wild meadow: ankle-high where dry, knee-high where wet
    cosmetic: hash3(P.seed | 0, 0xc05, 77) & 0xfffff, // decoration's salt, from the world's seed
    // lakes and the sea: wind over 600 m of open water; tiles of 48 m down to 14 cm, from metre chop to millimetre ripples
    water: { fetch: 600, cascades: [48, 6.9, 1.0, 0.14] },
  };
}
const TMP = [0, 0, 0, 0];
