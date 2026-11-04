// The shore table (W3.1): everything the water and the beach need to know about the water line, computed once and
// read as a table. For a few clipmap levels (a fine one round the eye, coarser ones out to the horizon) the table
// holds, per texel:
//   x  the signed distance to the water line in metres: above the water positive, under it negative;
//   yz the unit direction to the nearest point of the water line (from the water: the way waves travel in);
//   w  the travel time of a shallow-water front from the line, in seconds, along the straight line to the nearest
//      shore point at speed sqrt(g depth) (depth clamped to 0.3..14 m): negative up the beach at the swash's speed, so
//      the same phase runs from the breakers to the run-up.
// Baked on the GPU from the clipmap's own texels (height and water level) by jump flooding (Rong and Tan 2006): a seed
// pass finds the water line between neighbouring texels (the crossing at sub-texel accuracy), log2(128) passes spread
// the nearest seed, a last pass writes the table. A level is baked again only when its window moves, which the
// clipmap does every few texels of travel, never per frame; nothing in a frame computes a shoreline.
// Precision is a matter of texels: the fine slot's 2 m texels put the line within a few decimetres where the swash
// is drawn, the coarse slots serve the foam lines on far coasts.
import * as THREE from 'three';

export const SHORE = { levels: [3, 6, 8], win: 128, march: 8, dMin: 0.3, dMax: 14 };

const VS = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
const G = 9.81;

export class ShoreField {
  constructor(renderer, clip, cfg = {}) {
    this.cfg = { ...SHORE, ...cfg };
    const C = this.cfg, W = C.win;
    this.renderer = renderer; this.clip = clip;
    this.slots = C.levels.map((l) => ({ l, wi: null, wj: null }));
    this.rt = new THREE.WebGLArrayRenderTarget(W, W, C.levels.length, { depthBuffer: false });
    Object.assign(this.rt.texture, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    const o = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.ping = new THREE.WebGLRenderTarget(W, W, o); this.pong = new THREE.WebGLRenderTarget(W, W, o);
    this.uniforms = {
      uShoreTab: { value: this.rt.texture },
      uShoreLv: { value: this.slots.map(() => new THREE.Vector4()) }, // centre x, centre z, cell, half extent (the clip level's)
      uShoreOn: { value: 0 },
    };
    const U = { ...clip.uniforms, uLv: { value: 0 }, uWin: { value: new THREE.Vector2() }, uCell: { value: 1 }, uStep: { value: 1 }, uSrc: { value: null } };
    const head = `precision highp float; precision highp int;\n${clip.glsl()}\nuniform int uLv; uniform vec2 uWin; uniform float uCell, uStep; uniform highp sampler2D uSrc; out vec4 o;
// height above the water of the level's texel at world index (i, j)
float shoreE(int i, int j) { return clipTexel(uLv, i, j).x - texelFetch(uClipW, ivec3(i & 127, j & 127, uLv), 0).x; }
// the same between texels: the interpolated height against the water level of the texel
float shoreEAt(vec2 q) { return clipLevel(uLv, q).x - texelFetch(uClipW, ivec3(int(floor(q.x / uCell)) & 127, int(floor(q.y / uCell)) & 127, uLv), 0).x; }`;
    const mat = (frag) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: U, vertexShader: VS, fragmentShader: head + '\n' + frag, depthTest: false, depthWrite: false });
    // the seed: the window-local texel u holds the nearest water-line crossing with its four neighbours, if any
    this._seed = mat(`
void main() {
  ivec2 u = ivec2(gl_FragCoord.xy); ivec2 w = ivec2(uWin); int i = w.x + u.x, j = w.y + u.y;
  float e0 = shoreE(i, j); vec2 best = vec2(0.0); float bd = 1e9; float has = 0.0;
  ivec2 N[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int n = 0; n < 4; n++) {
    ivec2 v = u + N[n]; if (any(lessThan(v, ivec2(0))) || any(greaterThan(v, ivec2(${W - 1})))) continue;
    float e1 = shoreE(i + N[n].x, j + N[n].y);
    if ((e0 < 0.0) == (e1 < 0.0)) continue;
    float f = e0 / (e0 - e1); vec2 c = (vec2(i, j) + vec2(N[n]) * f) * uCell; float d = f * uCell;
    if (d < bd) { bd = d; best = c; has = 1.0; }
  }
  o = vec4(best, has, e0);
}`);
    // one flood pass: the nearest seed among this texel's and its eight neighbours' at the step
    this._flood = mat(`
void main() {
  ivec2 u = ivec2(gl_FragCoord.xy); ivec2 w = ivec2(uWin); vec2 p = vec2(w + u) * uCell;
  vec4 me = texelFetch(uSrc, u, 0); float bd = me.z > 0.5 ? distance(me.xy, p) : 1e9; vec4 best = me;
  int s = int(uStep);
  for (int dj = -1; dj <= 1; dj++) for (int di = -1; di <= 1; di++) {
    if (di == 0 && dj == 0) continue;
    ivec2 v = u + ivec2(di, dj) * s; if (any(lessThan(v, ivec2(0))) || any(greaterThan(v, ivec2(${W - 1})))) continue;
    vec4 c = texelFetch(uSrc, v, 0); if (c.z < 0.5) continue;
    float d = distance(c.xy, p); if (d < bd) { bd = d; best = vec4(c.xy, 1.0, me.w); }
  }
  o = best;
}`);
    // the table: written at the clipmap's toroidal address, so a reader finds a world texel where the clipmap has it
    this._final = mat(`
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy); ivec2 w = ivec2(uWin); ivec2 u = (t - w) & 127; ivec2 ij = w + u; vec2 p = vec2(ij) * uCell;
  vec4 s = texelFetch(uSrc, u, 0); float e = s.w, sg = e < 0.0 ? -1.0 : 1.0;
  if (s.z < 0.5) { o = vec4(sg * 1.0e4, 0.0, 0.0, sg * 1.0e4); return; }
  vec2 d = s.xy - p; float dist = length(d); vec2 dir = dist > 1e-4 ? d / dist : vec2(0.0);
  // the travel time: the straight line to the shore point, marched in ${C.march} steps at the shallow-water speed
  float tau = 0.0, ds = dist / ${C.march.toFixed(1)};
  for (int k = 0; k < ${C.march}; k++) {
    vec2 q = p + d * ((float(k) + 0.5) / ${C.march.toFixed(1)});
    float dep = clamp(e < 0.0 ? -shoreEAt(q) : ${C.dMin.toFixed(2)}, ${C.dMin.toFixed(2)}, ${C.dMax.toFixed(1)});
    tau += ds / sqrt(${G.toFixed(2)} * dep);
  }
  o = vec4(sg * dist, dir, sg * tau);
}`);
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this._quad.frustumCulled = false;
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._scene = new THREE.Scene(); this._scene.add(this._quad);
    this.U = U;
    this.stats = { bakes: 0 };
  }
  // once a frame, after the clipmap's update: a slot whose level's window moved is baked again
  update() {
    const lv = this.clip.lv;
    this.slots.forEach((S, k) => {
      const L = lv[S.l]; if (!L || !L.ready || L.wi === null) return;
      this.uniforms.uShoreLv.value[k].set(L.ci * L.s, L.cj * L.s, L.s, L.H);
      if (L.wi !== S.wi || L.wj !== S.wj) { this._bake(k, L); S.wi = L.wi; S.wj = L.wj; }
    });
    this.uniforms.uShoreOn.value = this.slots.some((S) => S.wi !== null) ? 1 : 0;
  }
  rebake() { for (const S of this.slots) { S.wi = S.wj = null; } }
  _bake(k, L) {
    const r = this.renderer, prev = r.getRenderTarget(), U = this.U, W = this.cfg.win;
    U.uLv.value = this.slots[k].l; U.uWin.value.set(L.wi, L.wj); U.uCell.value = L.s;
    this._quad.material = this._seed; r.setRenderTarget(this.ping); r.render(this._scene, this._cam);
    let src = this.ping, dst = this.pong;
    for (let s = W / 2; s >= 1; s >>= 1) {
      U.uStep.value = s; U.uSrc.value = src.texture; this._quad.material = this._flood;
      r.setRenderTarget(dst); r.render(this._scene, this._cam);
      [src, dst] = [dst, src];
    }
    U.uSrc.value = src.texture; this._quad.material = this._final;
    r.setRenderTarget(this.rt, k); r.render(this._scene, this._cam);
    r.setRenderTarget(prev);
    this.stats.bakes++;
  }
  // GLSL for a reader: shoreAt(p) = (signed distance, direction to the line, travel time), from the finest slot that
  // holds p, bilinear; (1e4, 0, 0, 1e4) where no slot does (far from any table: no shore effects)
  glsl() {
    const n = this.cfg.levels.length;
    return /* glsl */ `
#define SHORE_SLOTS ${n}
uniform highp sampler2DArray uShoreTab; uniform vec4 uShoreLv[SHORE_SLOTS]; uniform float uShoreOn;
vec4 shoreTexel(int k, int i, int j) { return texelFetch(uShoreTab, ivec3(i & 127, j & 127, k), 0); }
vec4 shoreAt(vec2 p) {
  if (uShoreOn < 0.5) return vec4(1.0e4, 0.0, 0.0, 1.0e4);
  for (int k = 0; k < SHORE_SLOTS; k++) {
    vec4 L = uShoreLv[k]; vec2 q = abs(p - L.xy); if (max(q.x, q.y) >= L.w - 2.0 * L.z) continue;
    float s = L.z; vec2 g = p / s; vec2 g0 = floor(g); vec2 f = g - g0; int i = int(g0.x), j = int(g0.y);
    vec4 a = shoreTexel(k, i, j), b = shoreTexel(k, i + 1, j), c = shoreTexel(k, i, j + 1), d = shoreTexel(k, i + 1, j + 1);
    vec4 v = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    float dl = length(v.yz); v.yz = dl > 1e-3 ? v.yz / dl : vec2(0.0);
    return v;
  }
  return vec4(1.0e4, 0.0, 0.0, 1.0e4);
}
`;
  }
  dispose() { this.rt.dispose(); this.ping.dispose(); this.pong.dispose(); this._seed.dispose(); this._flood.dispose(); this._final.dispose(); }
}

// The shore waves, read from the table by the water (water.js) and the beach (terrain.js), so the breakers and the
// swash are one motion: a front's phase is w (t + tau) with tau from the table, so it arrives at the line, then runs
// up the sand, at the times the table says. Needs shoreAt (above), w2noise (noise.js) and uShoreWave.
//   uShoreWave: the sea's swell (significant height Hs in m, peak period T in s) and the local wind sea's (Hs, T): a
//   coast of the sea gets the swell, a lake only what its own wind raised; shoreState picks by the water's level
// Two trains (the peak and a shorter one) of narrow-crested waves in shallow water: wavenumber w / sqrt(g depth), so
// crests slow down and bunch up toward the line; Green's law raises them as the water shoals; a wave higher than
// 0.78 of the depth breaks (McCowan 1894), and what is left of it runs on as a bore with whitewater on its face and
// lace behind. Sets come and go by a slow noise; the phase wanders a little along the coast so crests are not rings.
export const SHORE_WAVE_GLSL = /* glsl */ `
uniform vec4 uShoreWave; uniform float uShoreSea; // uShoreSea: the sea's level, so a lake is told from the sea
const float SW_G = 9.81;
vec2 shoreState(float level) { return level > uShoreSea + 0.5 ? uShoreWave.zw : uShoreWave.xy; }
float shoreCelerity(float depth) { return sqrt(SW_G * clamp(depth, ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)})); }
float shorePhaseNoise(vec2 p) { return w2noise(p / 240.0, 611) * 5.0 + w2noise(p / 70.0, 612) * 1.6; }
float shoreGroup(vec2 p, float t) { return 0.45 + 0.55 * (0.5 + 0.5 * w2noise(p / 320.0 + vec2(t * 0.012, -t * 0.009), 613)); }
struct ShoreWave { float y; vec2 slope; float foam; float lace; float a; float ph; float breaking; };
// p: the point (xz); sh: shoreAt(p); depth: the water's depth there (<= 0 on land); t: time; cell: the sampling
// interval in metres (a train shorter than a few cells fades out instead of aliasing)
ShoreWave shoreWaves(vec2 p, vec4 sh, float depth, float t, float cell, vec2 st) {
  ShoreWave o = ShoreWave(0.0, vec2(0.0), 0.0, 0.0, 0.0, 0.0, 0.0);
  float sdf = sh.x; vec2 dir = sh.yz;
  float env = (1.0 - smoothstep(60.0, 220.0, -sdf)) * step(1e-3, dot(dir, dir)) * smoothstep(-0.3, 0.3, depth);
  if (env <= 0.0 || st.x <= 0.0) return o;
  float cel = shoreCelerity(depth);
  float shoal = clamp(pow(max(depth, 0.6) / ${SHORE.dMax.toFixed(1)}, -0.25), 1.0, 2.2);
  float group = shoreGroup(p, t), pn = shorePhaseNoise(p);
  for (int i = 0; i < 2; i++) {
    float T = st.y * (i == 0 ? 1.0 : 0.62), w = 6.2831853 / T, k = w / cel;
    float a0 = 0.5 * st.x * (i == 0 ? 1.0 : 0.45) * env * shoal * group;
    float a = min(a0, 0.39 * depth), rel = a0 / max(depth, 0.05);
    float ph = w * (t + sh.w) + pn * (i == 0 ? 1.0 : 1.37) + float(i) * 2.1;
    float c = max(0.5 + 0.5 * cos(ph), 0.0), cp = pow(c, 0.6), s = sin(ph); // max: a GPU's cos can overshoot 1 by a bit at large phases, and pow of a negative is NaN
    float bl = 1.0 - smoothstep(0.1, 0.3, k * cell / 6.2831853);
    o.y += bl * a * (2.0 * cp * c - 0.78);
    o.slope += bl * dir * (-1.6 * a * k * cp * s);
    // whitewater: on the face of a crest that has broken, trailing behind it; the crest breaks early or late along
    // its length, in a new pattern every wave
    float cycle = floor((ph + 3.14159) / 6.2831853);
    float early = w2noise(p / 30.0 + vec2(cycle * 7.3, cycle * 3.1 + float(i) * 31.0), 614);
    float breaking = smoothstep(0.3 + 0.1 * early, 0.5 + 0.15 * early, rel) * smoothstep(0.03, 0.15, a);
    float psi = mod(ph + 3.14159, 6.2831853) - 3.14159;
    o.foam += breaking * smoothstep(-0.8, 0.0, psi) * exp(-max(psi, 0.0) * 1.1) * (i == 0 ? 1.0 : 0.6);
    if (i == 0) { o.a = a; o.ph = ph; o.breaking = breaking; o.lace = smoothstep(0.25, 0.5, rel) * (0.25 + 0.4 * exp(-mod(ph, 6.2831853) * 0.35)) * smoothstep(0.03, 0.15, a); }
  }
  return o;
}
// the swash on the beach: at a point with height hgt above the line (sh: shoreAt there), the film's presence (0..1),
// its leading edge (0..1, a thin line) and how far up the run-up reaches this set (R2: the run-up limit for the beach)
// The front's phase up the beach comes from the table's travel time (negative on land, at the swash's own speed), so
// the tongue climbs the sand after the wave that sent it, sits, and drains back before the next
vec3 shoreSwash(vec2 p, vec4 sh, float hgt, float R2, float t, vec2 st) {
  if (st.x <= 0.0 || R2 <= 1e-4 || dot(sh.yz, sh.yz) < 1e-6) return vec3(0.0);
  float w = 6.2831853 / st.y;
  float ph = w * (t + sh.w) + shorePhaseNoise(p);
  float f = fract(ph / 6.2831853);              // 0 as the front passes, climbing to 1 before the next
  float reach = R2 * (0.55 + 0.45 * shoreGroup(p, t)); // this set's run-up
  float up = 1.0 - smoothstep(reach - 0.03, reach, hgt);
  float film = up * (1.0 - smoothstep(0.42, 0.6, f + 0.2 * hgt / max(reach, 1e-3)));   // the film sits, then drains from the top down
  float edge = up * (1.0 - smoothstep(0.0, 0.06, f)) * smoothstep(-0.02, 0.0, hgt);
  return vec3(film, edge, reach);
}
`;
