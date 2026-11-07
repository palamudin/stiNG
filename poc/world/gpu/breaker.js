// The breaker, as an event replayed: one breaking wave's cross-section through its life, computed once into a small
// table and replayed wherever and whenever a wave breaks, scaled to that wave's height and nudged a little per wave
// (Malan's breaking waves, SIGGRAPH 2022: a baked cross-section driven by an animation parameter; here the parameter is
// physical: how far the wave has run since it broke, from the swell field). The same event at any scale: a swell's
// plunging tube on a bar, a wind sea's crest spilling over.
// The table: across the wave (u = the phase from the crest over 2 pi, ahead of the crest < 0) by its stage (s: 0 the
// break, 0.45 the lip pitched out, 0.75 the lip landed in the trough, 1 the collapse into a bore), each texel
//   (forward: how far the water is thrown along the wave's way, up: how far it rises or falls (both in wave heights),
//    white: how torn into foam and spray it is, slide: how far its surface patterns slide along the wave's way to keep
//    their size where the fold stretches the surface (the arc length of the deformed section less its rest length))
import * as THREE from 'three/webgpu';

export const BREAKER = { nu: 96, ns: 64, steep: 0.08 }; // steep: the breaker's height over its length (the section's aspect)

const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function breakerSection(u, s) {
  const c = Math.cos(2 * Math.PI * u), h = Math.pow(Math.max(c, 0), 1.5); // the crest's share of the height
  const near = Math.exp(-(((u - 0.03) / 0.13) ** 2)); // the crest and just behind it: the water the lip is made of
  const pitch = ss(0, 0.45, s), fall = ss(0.3, 0.75, s), gone = ss(0.75, 1, s);
  const live = 1 - gone;
  const forward = (1.6 * pitch + 1.3 * fall) * h * h * near * live;
  const up = (0.25 * pitch * h * h - 2.1 * fall * h * h * h) * near * live - 0.45 * gone * h; // the bore: lower, its front steep
  const front = ss(-0.3, -0.02, u) * (1 - ss(0.02, 0.25, u)); // the crest's front
  const white = Math.min(1, fall * h * h * near * 1.6 + pitch * h * h * h * near * 0.5 + gone * front * (1 - 0.6 * ss(0.9, 1, s)));
  return [forward, up, white];
}
export function bakeBreaker() {
  const { nu, ns, steep } = BREAKER, d = new Float32Array(nu * ns * 4);
  for (let j = 0; j < ns; j++) {
    const s = j / (ns - 1);
    // the arc length along the deformed section (in wave heights; the rest length runs 1 / steep a wavelength)
    let arc = 0, prev = null; const arcs = [];
    for (let i = 0; i < nu; i++) {
      const u = i / (nu - 1) - 0.5, [f, up] = breakerSection(u, s), base = Math.pow(Math.max(Math.cos(2 * Math.PI * u), 0), 1.5);
      const x = -u / steep + f, y = base + up; // along the wave's way (ahead of the crest is u < 0: forward)
      if (prev) arc += Math.hypot(x - prev[0], y - prev[1]); prev = [x, y]; arcs.push(arc);
    }
    for (let i = 0; i < nu; i++) {
      const u = i / (nu - 1) - 0.5, [f, up, white] = breakerSection(u, s), rest = (u + 0.5) / steep;
      const o = (j * nu + i) * 4; d[o] = f; d[o + 1] = up; d[o + 2] = white; d[o + 3] = -(arcs[i] - rest - (arcs[nu >> 1] - 0.5 / steep)); // slide, 0 at the crest
    }
  }
  const hd = new Uint16Array(d.length); for (let i = 0; i < d.length; i++) hd[i] = THREE.DataUtils.toHalfFloat(d[i]); // (half floats: filterable everywhere)
  const t = new THREE.DataTexture(hd, nu, ns, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  return t;
}
