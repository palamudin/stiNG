// The shore table (W3.1): everything the water and the beach need to know about the water line, computed once and
// read as a table. Three square windows round the eye (fine, middle, far: 0.5 m, 4 m and 16 m texels, 512 of them a
// side) hold, per texel:
//   x  the signed distance to the water line in metres: above the water positive, under it negative;
//   yz the unit direction to the nearest point of the water line (from the water: the way waves travel in);
//   w  the travel time of a shallow-water front from the line, in seconds, along the straight line to the nearest
//      shore point at speed sqrt(g depth) (depth clamped to 0.3..14 m): positive on the water, negative up the beach
//      at the swash's speed, so one phase runs from the breakers to the run-up.
// Baked on the GPU from the clipmap (height and water level at the texel's point, read from the finest level there)
// by jump flooding (Rong and Tan 2006): a seed pass finds the water line between neighbouring texels (the crossing at
// sub-texel accuracy), log2(512) passes spread the nearest seed, a last pass writes the table. A window is baked
// again only when the eye has moved an eighth of its span, never per frame; nothing in a frame computes a shoreline.
// Precision is the row count: the reader addresses a texel, so finer texels cost memory (a few MB) and bake time,
// nothing per pixel. Readers blend the windows at their edges, so no seam shows where one hands over to the next.
// The array texture carries two more layers the composite reads through this one sampler (it is at the fragment
// sampler limit of Chrome on Windows, 16): the glints' Poisson table (water.js), and a copy of the clouds' shadow map
// each frame (clouds.js), so the sea darkens under a cloud like the ground does.
import * as THREE from 'three';
import { POISSON, poissonTableData } from './water.js';

export const SHORE = { N: 512, texels: [0.5, 4, 16], march: 32, dMin: 0.3, dMax: 14, rebake: 0.125 };

const VS = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
const G = 9.81;

export class ShoreField {
  constructor(renderer, clip, cfg = {}) {
    this.cfg = { ...SHORE, ...cfg };
    const C = this.cfg, N = C.N;
    this.renderer = renderer; this.clip = clip;
    this.slots = C.texels.map((s) => ({ s, ox: 0, oz: 0, baked: false }));
    this.tables = this.slots.length; this.cloud = this.slots.length + 1; // the extra layers
    this.rt = new THREE.WebGLArrayRenderTarget(N, N, this.slots.length + 2, { depthBuffer: false });
    Object.assign(this.rt.texture, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    const o = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.ping = new THREE.WebGLRenderTarget(N, N, o); this.pong = new THREE.WebGLRenderTarget(N, N, o);
    this.uniforms = {
      uShoreTab: { value: this.rt.texture },
      uShoreLv: { value: this.slots.map(() => new THREE.Vector4()) }, // origin x, origin z, texel, span
      uShoreOn: { value: 0 },
      uShoreCloudRect: { value: new THREE.Vector4(0, 0, 1, 0) }, // index.js points this at the clouds' own
    };
    const U = { ...clip.uniforms, uOrg: { value: new THREE.Vector2() }, uCell: { value: 1 }, uStep: { value: 1 }, uSrc: { value: null } };
    const head = `precision highp float; precision highp int;\n${clip.glsl()}\nuniform vec2 uOrg; uniform float uCell, uStep; uniform highp sampler2D uSrc; out vec4 o;
// the height above the water at a point, from the clipmap's finest level there
float shoreE(vec2 p) { return clipAt(p).x - clipWater(p); }
vec2 shoreP(ivec2 u) { return uOrg + (vec2(u) + 0.5) * uCell; }`;
    const mat = (frag) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: U, vertexShader: VS, fragmentShader: head + '\n' + frag, depthTest: false, depthWrite: false });
    // the seed: texel u holds the nearest water-line crossing with its four neighbours, if any
    this._seed = mat(`
void main() {
  ivec2 u = ivec2(gl_FragCoord.xy); vec2 p = shoreP(u);
  float e0 = shoreE(p); vec2 best = vec2(0.0); float bd = 1e9, has = 0.0;
  ivec2 N[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int n = 0; n < 4; n++) {
    ivec2 v = u + N[n]; if (any(lessThan(v, ivec2(0))) || any(greaterThan(v, ivec2(${N - 1})))) continue;
    float e1 = shoreE(shoreP(v));
    if ((e0 < 0.0) == (e1 < 0.0)) continue;
    float f = e0 / (e0 - e1); vec2 c = p + vec2(N[n]) * f * uCell; float d = f * uCell;
    if (d < bd) { bd = d; best = c; has = 1.0; }
  }
  o = vec4(best, has, e0);
}`);
    // one flood pass: the nearest seed among this texel's and its eight neighbours' at the step
    this._flood = mat(`
void main() {
  ivec2 u = ivec2(gl_FragCoord.xy); vec2 p = shoreP(u);
  vec4 me = texelFetch(uSrc, u, 0); float bd = me.z > 0.5 ? distance(me.xy, p) : 1e9; vec4 best = me;
  int s = int(uStep);
  for (int dj = -1; dj <= 1; dj++) for (int di = -1; di <= 1; di++) {
    if (di == 0 && dj == 0) continue;
    ivec2 v = u + ivec2(di, dj) * s; if (any(lessThan(v, ivec2(0))) || any(greaterThan(v, ivec2(${N - 1})))) continue;
    vec4 c = texelFetch(uSrc, v, 0); if (c.z < 0.5) continue;
    float d = distance(c.xy, p); if (d < bd) { bd = d; best = vec4(c.xy, 1.0, me.w); }
  }
  o = best;
}`);
    // the table: signed distance, direction, travel time
    this._final = mat(`
void main() {
  ivec2 u = ivec2(gl_FragCoord.xy); vec2 p = shoreP(u);
  vec4 s = texelFetch(uSrc, u, 0); float e = s.w; bool water = e < 0.0;
  if (s.z < 0.5) { o = vec4(water ? -1.0e4 : 1.0e4, 0.0, 0.0, water ? 1.0e4 : -1.0e4); return; }
  vec2 d = s.xy - p; float dist = length(d); vec2 dir = dist > 1e-4 ? d / dist : vec2(0.0);
  // the travel time: the straight line to the shore point, marched in ${C.march} steps at the shallow-water speed;
  // up the beach at the speed of the shallowest water
  float tau = 0.0, ds = dist / ${C.march.toFixed(1)};
  for (int k = 0; k < ${C.march}; k++) {
    vec2 q = p + d * ((float(k) + 0.5) / ${C.march.toFixed(1)});
    float dep = clamp(water ? -shoreE(q) : ${C.dMin.toFixed(2)}, ${C.dMin.toFixed(2)}, ${C.dMax.toFixed(1)});
    tau += ds / sqrt(${G.toFixed(2)} * dep);
  }
  o = vec4(water ? -dist : dist, dir, water ? tau : -tau);
}`);
    this._copy = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { uSrc: { value: null } }, vertexShader: VS,
      fragmentShader: 'precision highp float; uniform highp sampler2D uSrc; out vec4 o; void main() { o = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }', depthTest: false, depthWrite: false });
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this._quad.frustumCulled = false;
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._scene = new THREE.Scene(); this._scene.add(this._quad);
    this.U = U;
    this.stats = { bakes: 0, ms: 0 };
    this._writeTables();
    { const r = renderer, prev = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha(); // no clouds yet: the open
      r.setRenderTarget(this.rt, this.cloud); r.setClearColor(0xffffff, 1); r.clear(true, false, false); r.setClearColor(cc, ca); r.setRenderTarget(prev); }
  }
  // a texture into a layer, texel for texel (the Poisson table once; the clouds' shadow map each frame)
  copyInto(tex, layer) {
    const r = this.renderer, prev = r.getRenderTarget();
    this._copy.uniforms.uSrc.value = tex; this._quad.material = this._copy;
    r.setRenderTarget(this.rt, layer); r.render(this._scene, this._cam); r.setRenderTarget(prev);
  }
  _writeTables() {
    const N = this.cfg.N, data = poissonTableData(), packed = new Float32Array(N * N * 4);
    if (POISSON.rows > N || POISSON.cols > N) throw new Error('shorefield: the Poisson table must fit the layer');
    for (let r = 0; r < POISSON.rows; r++) for (let c = 0; c < POISSON.cols; c++) packed[(r * N + c) * 4] = data[r * POISSON.cols + c];
    const tex = new THREE.DataTexture(packed, N, N, THREE.RGBAFormat, THREE.FloatType); tex.needsUpdate = true;
    this.copyInto(tex, this.tables); tex.dispose();
  }
  // once a frame, after the clipmap's update: a window the eye has left by an eighth of its span is baked again
  update(eye) {
    const C = this.cfg, t0 = performance.now();
    this.slots.forEach((S, k) => {
      const span = C.N * S.s, cx = S.ox + span / 2, cz = S.oz + span / 2;
      if (!S.baked || Math.max(Math.abs(eye.x - cx), Math.abs(eye.z - cz)) > span * C.rebake) {
        S.ox = Math.round((eye.x - span / 2) / S.s) * S.s; S.oz = Math.round((eye.z - span / 2) / S.s) * S.s;
        this._bake(k, S); S.baked = true;
      }
      this.uniforms.uShoreLv.value[k].set(S.ox, S.oz, S.s, span);
    });
    this.uniforms.uShoreOn.value = 1;
    this.stats.ms = performance.now() - t0;
  }
  rebake() { for (const S of this.slots) S.baked = false; }
  _bake(k, S) {
    const r = this.renderer, prev = r.getRenderTarget(), U = this.U, N = this.cfg.N;
    U.uOrg.value.set(S.ox, S.oz); U.uCell.value = S.s;
    this._quad.material = this._seed; r.setRenderTarget(this.ping); r.render(this._scene, this._cam);
    let src = this.ping, dst = this.pong;
    for (let s = N / 2; s >= 1; s >>= 1) {
      U.uStep.value = s; U.uSrc.value = src.texture; this._quad.material = this._flood;
      r.setRenderTarget(dst); r.render(this._scene, this._cam);
      [src, dst] = [dst, src];
    }
    U.uSrc.value = src.texture; this._quad.material = this._final;
    r.setRenderTarget(this.rt, k); r.render(this._scene, this._cam);
    r.setRenderTarget(prev);
    this.stats.bakes++;
  }
  // GLSL for a reader: shoreAt(p) = (signed distance, direction to the line, travel time) from the finest window that
  // holds p, bilinear, blended into the next window over the outer tenth of its span; (1e4, 0, 0, 1e4) beyond every
  // window (no shore effects there). shoreCloud(xz): the clouds' shadow over a point (1 in the open), from the copy.
  glsl() {
    const n = this.slots.length;
    return /* glsl */ `
#define SHORE_SLOTS ${n}
#define SHORE_TABLES ${this.tables}
#define SHORE_CLOUD ${this.cloud}
uniform highp sampler2DArray uShoreTab; uniform vec4 uShoreLv[SHORE_SLOTS]; uniform float uShoreOn;
const vec4 SHORE_FAR = vec4(1.0e4, 0.0, 0.0, 1.0e4);
vec4 shoreRead(int k, vec2 p) { vec4 L = uShoreLv[k]; return texture(uShoreTab, vec3((p - L.xy) / L.w, float(k))); }
float shoreHold(int k, vec2 p) { vec4 L = uShoreLv[k]; vec2 uv = (p - L.xy) / L.w; float m = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)); return smoothstep(0.01, 0.1, m); }
vec4 shoreAt(vec2 p) {
  if (uShoreOn < 0.5) return SHORE_FAR;
  for (int k = 0; k < SHORE_SLOTS; k++) {
    float w = shoreHold(k, p); if (w <= 0.0) continue;
    vec4 v = shoreRead(k, p);
    if (w < 1.0) { vec4 nx = SHORE_FAR; if (k + 1 < SHORE_SLOTS && shoreHold(k + 1, p) > 0.0) nx = shoreRead(k + 1, p); v = mix(nx, v, w); }
    float dl = length(v.yz); v.yz = dl > 1e-3 ? v.yz / dl : vec2(0.0);
    return v;
  }
  return SHORE_FAR;
}
// the glints' Poisson table (water.js wPoisson): row r, column c
float shorePoisson(int r, int c) { return texelFetch(uShoreTab, ivec3(c, r, SHORE_TABLES), 0).x; }
uniform vec4 uShoreCloudRect; // the clouds' shadow map's centre x, z and half span (clouds.js uShadowRect)
float shoreCloud(vec2 xz) {
  vec2 uv = (xz - uShoreCloudRect.xy) / (2.0 * uShoreCloudRect.z) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  return texture(uShoreTab, vec3(uv, float(SHORE_CLOUD))).r;
}
`;
  }
  dispose() { this.rt.dispose(); this.ping.dispose(); this.pong.dispose(); this._seed.dispose(); this._flood.dispose(); this._final.dispose(); this._copy.dispose(); }
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
