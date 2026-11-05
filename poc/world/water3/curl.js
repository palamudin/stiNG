// Water 3: the breaking wave's curl, a mesh of its own over the water. A heightfield cannot overhang, so the lip is a
// second surface: a fine grid of its own round the camera, each vertex mapped onto the lip of the surf crest it belongs
// to (the first train's crest: water3/swash.js), in the shape a table gives for the breaker's stage.
//
// The shape (the table, computed once): a fat body on the crest, the crest's top grown up and thrown forward over the
// face as an arch that lands on the face ahead, the tube under it. As a closed cross-section: from under the swell's
// back, up over the top, along the lip to its tip (rounded), back along the underside (the tube's ceiling) and down
// the inner wall into the face. Keyframes along a centreline with a width (the girth: the whole crest at the root,
// tapering to the tip), eased between: a swelling on the crest; the crest standing up past its own top; the lip
// thrown over; the lip landed. Units: up in the wave's face (crest to trough, 2a), forward the same, stretched to land
// where the face has fallen a third of its height.
//
// Per vertex: the main train's phase there gives the crest it belongs to (half a wave either side) and where round
// the cross-section it falls, from the back's foot (phase pi, half a wave behind) to the inner wall's foot (phase -pi,
// half a wave ahead); both feet lie under the water, and the triangles across the half-wave seam (one crest's feet to
// the next one's) are thrown away. Normals from the cross-section (smooth, not the triangles'); only its outward
// faces drawn, writing depth, so it reads as a body of water.
//
// The event (curlEvent: also the foam field's, so the splash lands where the lip does): local and brief, a little
// over a second at any point of the crest, on the stretches of a wave that plunge (the rest spill), running along the
// crest from where it starts (a peel): see curlEvent. The panel's 'Curl' scales it.
import * as THREE from 'three';
import { NOISE_GLSL } from '../noise.js';
import { SHORE } from '../shorefield.js';
import { SWASH_GLSL, SURF_GLSL } from './swash.js';
import { SKY_GLSL } from '../sky.js';

export const CURL = { stages: 32, samples: 128, grid: 448, reach: 240, ratio: 1.65 };

// the centreline (forward, up in face heights, from the crest's top) and its width at seven points, for each stage
const KEYS = [
  [0.0, [[0.0, -0.4], [0.05, -0.05], [0.15, 0.05], [0.25, 0.06], [0.35, 0.04], [0.42, 0.0], [0.46, -0.06]], [1.0, 0.5, 0.25, 0.18, 0.12, 0.08, 0.03]],
  [0.35, [[0.03, -0.4], [0.08, 0.05], [0.2, 0.4], [0.4, 0.58], [0.6, 0.6], [0.75, 0.52], [0.85, 0.4]], [1.0, 0.6, 0.38, 0.3, 0.2, 0.12, 0.04]],
  [0.7, [[0.05, -0.4], [0.12, 0.05], [0.4, 0.45], [0.8, 0.55], [1.2, 0.48], [1.45, 0.3], [1.6, 0.0]], [1.0, 0.6, 0.36, 0.32, 0.22, 0.1, 0.03]],
  [1.0, [[0.05, -0.4], [0.12, 0.05], [0.45, 0.45], [0.9, 0.52], [1.35, 0.42], [1.58, 0.12], [1.64, -0.42]], [1.0, 0.6, 0.36, 0.33, 0.22, 0.1, 0.03]],
];
const lerp = (a, b, f) => a + (b - a) * f;
function keyAt(s) {
  let k = 0; while (k < KEYS.length - 2 && s > KEYS[k + 1][0]) k++;
  let f = Math.min(Math.max((s - KEYS[k][0]) / (KEYS[k + 1][0] - KEYS[k][0]), 0), 1); f = f * f * (3 - 2 * f);
  const A = KEYS[k], B = KEYS[k + 1];
  return [A[1].map((p, i) => [lerp(p[0], B[1][i][0], f), lerp(p[1], B[1][i][1], f)]), A[2].map((w, i) => lerp(w, B[2][i], f))];
}
// the cross-section at stage s: a loop of points (x, y, width, along) resampled evenly by length; along is 0 at the root
// to 1 at the tip on the outer side, negative on the underside
function section(s, n) {
  const [C, Wd] = keyAt(s), M = 72, c = [], w = [], al = [];
  const P = i => C[Math.min(Math.max(i, 0), C.length - 1)];
  for (let i = 0; i < M; i++) { // Catmull-Rom through the centreline
    const g = i / (M - 1) * (C.length - 1), k = Math.min(Math.floor(g), C.length - 2), t = g - k;
    const p0 = P(k - 1), p1 = P(k), p2 = P(k + 1), p3 = P(k + 2), t2 = t * t, t3 = t2 * t;
    c.push([0, 1].map(e => 0.5 * (2 * p1[e] + (-p0[e] + p2[e]) * t + (2 * p0[e] - 5 * p1[e] + 4 * p2[e] - p3[e]) * t2 + (-p0[e] + 3 * p1[e] - 3 * p2[e] + p3[e]) * t3)));
    w.push(lerp(Wd[k], Wd[k + 1], t)); al.push(i / (M - 1));
  }
  const nrm = i => { const a = c[Math.max(i - 1, 0)], b = c[Math.min(i + 1, M - 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; }; // outward: the back, the top
  const outer = [], inner = [];
  for (let i = 0; i < M; i++) { const o = nrm(i), h = w[i] / 2; outer.push([c[i][0] + o[0] * h, c[i][1] + o[1] * h, w[i], al[i]]); inner.push([c[i][0] - o[0] * h, c[i][1] - o[1] * h, w[i], -al[i]]); }
  const L = [[outer[0][0] - 0.25, outer[0][1] - 0.35, w[0], 0], ...outer];
  // the tip, rounded: half a circle round the centreline's end, from the outer side to the inner
  const e = c[M - 1], o = nrm(M - 1), h = w[M - 1] / 2, tg = [o[1], -o[0]];
  for (let j = 1; j < 8; j++) { const a = Math.PI * j / 8; L.push([e[0] + (o[0] * Math.cos(a) + tg[0] * Math.sin(a)) * h, e[1] + (o[1] * Math.cos(a) + tg[1] * Math.sin(a)) * h, w[M - 1], 1]); }
  for (let i = M - 1; i >= 0; i--) L.push(inner[i]);
  L.push([inner[0][0] + 0.15, inner[0][1] - 0.35, w[0], 0]);
  // resample evenly by length
  const d = [0]; for (let i = 1; i < L.length; i++) d.push(d[i - 1] + Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]));
  const out = []; let k = 0;
  for (let j = 0; j < n; j++) {
    const t = j / (n - 1) * d[d.length - 1]; while (k < L.length - 2 && d[k + 1] < t) k++;
    const f = (t - d[k]) / Math.max(d[k + 1] - d[k], 1e-9), A = L[k], B = L[k + 1];
    out.push([lerp(A[0], B[0], f), lerp(A[1], B[1], f), lerp(A[2], B[2], f), Math.abs(A[3]) > Math.abs(B[3]) ? lerp(A[3], B[3], f) : lerp(A[3], B[3], f)]);
  }
  return out;
}
function curlTable() {
  const S = CURL.stages, U = CURL.samples, data = new Float32Array(S * U * 4);
  for (let j = 0; j < S; j++) { const sec = section(j / (S - 1), U); for (let i = 0; i < U; i++) data.set(sec[i], (j * U + i) * 4); }
  const t = new THREE.DataTexture(data, U, S, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; // read with its own bilinear (float filtering is not everywhere)
  return t;
}
// the grid: N x N round the camera, 0.15 m apart at the middle growing to 2.4 m at the edge (reach metres out)
function curlGrid() {
  const N = CURL.grid, R = CURL.reach, b = 2.8, g = t => R * (Math.exp(b * t) - 1) / (Math.exp(b) - 1);
  const co = new Float32Array(N); for (let i = 0; i < N; i++) { const q = -1 + 2 * i / (N - 1); co[i] = Math.sign(q) * g(Math.abs(q)); }
  const pos = new Float32Array(N * N * 3), idx = new Uint32Array((N - 1) * (N - 1) * 6);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const o = (j * N + i) * 3; pos[o] = co[i]; pos[o + 2] = co[j]; }
  let o = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i, b2 = a + 1, c = a + N, d = c + 1; idx.set([a, c, b2, b2, c, d], o); o += 6; }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

// the curl event of the main train's crest a point belongs to (sw3Ctx(xz) already called): the crest gcCx, the phase
// gcPsi (> 0 behind the crest), k at the point gcK; the event gcEv (0 starting .. 0.55 landed .. 1 gone), gcStage,
// gcFall (the lip dropping), gcShow; the face's height gcH0 (2a) and the forward stretch gcXs; the depth at the crest gcDC.
//
// A plunge is local and brief (field and lab: the lip's throw to its landing within about half a second, the tube
// closing within a second; a crest breaks first where it meets shallow water first and the curl runs along it, a
// peel): so the event is not the whole crest at once. Each wave picks, along its crest, stretches that plunge (the
// rest spill: whitewater only, the surf model's own) and, within them, where the break starts: the delay before a
// point of the crest breaks, after it reached its break line, grows away from those starting points, so the curl
// runs along the crest at a few metres a second and only the stretch it is passing has a tube; behind it the lip
// has landed and is gone into the bore, ahead of it the crest has yet to throw.
export const CURL_EVENT_GLSL = /* glsl */ `
vec2 gcCx = vec2(0.0); float gcPsi = 0.0, gcK = 1.0, gcEv = 0.0, gcStage = 0.0, gcFall = 0.0, gcShow = 0.0, gcH0 = 0.0, gcXs = 1.0, gcDC = 1.0, gcA0 = 0.0;
float curlCel(float d) { return sqrt(9.81 * clamp(d, ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)})); }
void curlEvent(vec2 xz, float level, float depth) {
  float w = sw3Omega(0); gcK = w / curlCel(depth);
  float ph = sw3Phase(0, uWTime, gTau, gPn); gcPsi = mod(ph + 3.14159265, 6.2831853) - 3.14159265;
  float cyc = floor((ph + 3.14159265) / 6.2831853);
  vec2 c0 = xz + gDir * (gcPsi / gcK);
  // one step more onto the crest itself (its own phase, its own depth there): every vertex of a cross-section lands on
  // the same crest point, so a lip is built from one event, not torn between neighbours that each guessed the crest
  // a little differently
  if (sw3Ctx(c0)) { float p0 = mod(sw3Phase(0, uWTime, gTau, gPn) + 3.14159265, 6.2831853) - 3.14159265; c0 += gDir * (p0 * curlCel(level - clipHeight(c0)) / w); sw3Ctx(c0); }
  gcCx = c0;
  float dC = max(level - clipHeight(gcCx), 0.02); gcDC = dC;
  float shoal = pow(clamp(max(dC, 0.6) / ${SHORE.dMax.toFixed(1)}, 0.04, 1.0), -0.25);
  float a0 = uSurf.x * gNear * gExpo * shoal * sw3Group(gcCx, uWTime), a = min(a0, 0.42 * dC + 0.02); gcA0 = a0;
  float early = 0.5 + 0.5 * w2noise(gcCx / 33.0 + vec2(cyc * 7.3, cyc * 3.1), 614);
  float rb = 0.3 + 0.09 * early, db = a0 / rb; // the breaking limit, early or late along the crest (water3/swash.js)
  vec3 cn = clipNormal(gcCx); float tb = max(sqrt(max(1.0 - cn.y * cn.y, 0.0)) / max(cn.y, 0.05), 0.004);
  float tSince = (db - dC) / tb / sqrt(9.81 * max(dC, 0.1)); // seconds since the crest reached its break line
  // along the crest (s): which stretches of this wave plunge (more of a bigger wave's), and the peel: the delay before
  // it breaks here, 0 at the stretch's starting points to 4 s between them (60 m apart or so: the curl runs at 5 to
  // 15 m/s), a new layout every wave
  float s = dot(gcCx, vec2(-gDir.y, gDir.x)), big = smoothstep(0.3, 1.2, a0);
  float plunge = smoothstep(0.62 - 0.2 * big, 0.78 - 0.2 * big, 0.5 + 0.5 * w2noise(vec2(s / 260.0, cyc * 2.71), 618));
  float delay = 4.0 * (0.5 + 0.5 * w2noise(vec2(s / 60.0, cyc * 1.37), 617));
  // the event itself: a little over a second (more for a bigger wave): thrown and landed by 0.55, the lip dropping
  // into the bore from 0.7, gone by 1
  float te = 1.0 + 0.4 * clamp(a0, 0.0, 1.5); gcEv = (tSince - delay) / te;
  gcStage = clamp(smoothstep(0.0, 0.55, gcEv), 0.0, 1.0); gcFall = smoothstep(0.7, 1.0, gcEv);
  gcShow = smoothstep(0.0, 0.1, gcEv) * (1.0 - smoothstep(0.88, 1.05, gcEv)) * smoothstep(0.05, 0.25, a0) * smoothstep(0.1, 0.35, dC) * plunge;
  gcH0 = 2.0 * a;
  // forward: it lands where the face has fallen a third of its height (about 1 rad of the wave ahead of the crest)
  gcXs = clamp(1.01 * curlCel(dC) / (w * max(gcH0, 0.05)) / ${CURL.ratio.toFixed(2)}, 0.75, 1.3);
}
`;

export class CurlMesh {
  constructor(world, surface) {
    const shore = world.shore, S = surface.U;
    this.table = curlTable();
    const U = {
      ...world.clip.uniforms, ...shore.uniforms,
      uSurf: world.uSurf, uSurfX: world.uSurfX, uWTime: world.uWTime, uSwDir: world.uSwDir, uLook3: world.uLook3,
      uCam: S.uCam, uSeaLevel: S.uSeaLevel, tCurl: { value: this.table },
      uSun: world.sky.uniforms.uSun, uSunColor: world.sky.uniforms.uSunColor, uSkyUp: S.uSkyUp, tFoam: S.tFoam,
      uDebug: world.post.U.uDebug, uSkyView: world.sky.uniforms.uSkyView, uMS: world.sky.uniforms.uMS, uHaze: world.sky.uniforms.uHaze, uAbs: world.uAbs, uSca: world.uSca, uLook: world.uLook, uLook2: world.uLook2,
    };
    this.U = U;
    const C = CURL;
    this.grid = curlGrid();
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: U, side: THREE.DoubleSide, transparent: true, depthWrite: true,
      vertexShader: /* glsl */ `precision highp float; precision highp int;
#include <common>
#include <logdepthbuf_pars_vertex>
${NOISE_GLSL}
${world.clip.glsl()}
${shore.glsl()}
${SWASH_GLSL}
${SURF_GLSL}
uniform vec3 uCam; uniform float uSeaLevel; uniform vec4 uLook3; uniform highp sampler2D tCurl;
${CURL_EVENT_GLSL}
out vec3 vW, vN; out vec4 vLip; out float vIn, vTh; out vec2 vPsi; // vN: the outward normal; vLip: (along the lip: 0 root .. 1 tip, < 0 underside; stage; shown; -); vTh: girth (m); vPsi: (phase, |phase|) for the seam
// the table, bilinear by hand
vec4 curlAt(float u, float s) {
  vec2 g = vec2(u * ${(C.samples - 1).toFixed(1)}, s * ${(C.stages - 1).toFixed(1)}); vec2 i0 = floor(g), f = g - i0; ivec2 i = ivec2(i0), j = min(i + 1, ivec2(${C.samples - 1}, ${C.stages - 1}));
  vec4 a = texelFetch(tCurl, i, 0), b = texelFetch(tCurl, ivec2(j.x, i.y), 0), c = texelFetch(tCurl, ivec2(i.x, j.y), 0), d = texelFetch(tCurl, j, 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vLip = vec4(0.0); vIn = 0.0; vTh = 0.0; vPsi = vec2(0.0); vN = vec3(0.0, 1.0, 0.0);
  vec2 xz = uCam.xz + position.xz;
  float level = clipWater(xz);
  vec3 P = vec3(xz.x, level - 0.4, xz.y); // under the water: no lip here
  if (level <= uSeaLevel + 0.5 && uSurf.x > 0.0 && uLook3.w > 0.0 && sw3Ctx(xz)) {
    curlEvent(xz, level, level - clipHeight(xz));
    float show = gcShow * (1.0 - smoothstep(${(C.reach - 70).toFixed(1)}, ${(C.reach - 10).toFixed(1)}, distance(gcCx, uCam.xz)));
    if (show > 0.002 && sw3Ctx(gcCx)) {
      float H = gcH0 * uLook3.w * smoothstep(0.0, 0.15, gcEv); // grown from nothing as it starts
      float v = (3.14159265 - gcPsi) / 6.2831853, dv = 1.0 / ${(C.samples - 1).toFixed(1)};
      vec4 T = curlAt(v, gcStage);
      vec2 sc = vec2(H * gcXs, H), o = T.xy * sc;
      vec2 t = (curlAt(min(v + dv, 1.0), gcStage).xy - curlAt(max(v - dv, 0.0), gcStage).xy) * sc; t /= max(length(t), 1e-6);
      o.y -= gcFall * H * 0.8; // the lip dropping into the bore
      vec3 d = w3Coast(gcCx, gcDC, 0.25); // the root on the water's own crest (both trains, its lean, its collapse)
      vec2 dir = gDir;
      P = vec3(gcCx.x + d.x, level + d.y, gcCx.y + d.z) + vec3(dir.x, 0.0, dir.y) * o.x + vec3(0.0, o.y, 0.0);
      vN = vec3(dir.x, 0.0, dir.y) * -t.y + vec3(0.0, t.x, 0.0);
      vIn = 1.0; vTh = T.z * H; vPsi = vec2(gcPsi, abs(gcPsi));
      vLip = vec4(T.w, gcStage, show * (1.0 - 0.75 * gcFall), 0.0);
    }
  }
  vW = P;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
  #include <logdepthbuf_vertex>
}`,
      fragmentShader: /* glsl */ `precision highp float; precision highp int;
#include <logdepthbuf_pars_fragment>
${SKY_GLSL}
uniform vec3 uSun, uSunColor, uSkyUp, uAbs, uSca; uniform vec4 uLook, uLook2; uniform sampler2D tFoam, uSkyView; uniform float uDebug;
in vec3 vW, vN; in vec4 vLip; in float vIn, vTh; in vec2 vPsi; out vec4 oColor;
const float W_N = 1.333;
float wFresnel(float ci) {
  ci = clamp(ci, 0.0, 1.0); float st2 = (1.0 - ci * ci) / (W_N * W_N); if (st2 >= 1.0) return 1.0;
  float ct = sqrt(1.0 - st2), rs = (ci - W_N * ct) / (ci + W_N * ct), rp = (W_N * ci - ct) / (W_N * ci + ct);
  return 0.5 * (rs * rs + rp * rp);
}
// the water's own material (water3/surface.js): its absorption and scattering (the colour preset and clarity), the sky
// by exact Fresnel, the sun's highlight, the light through it; what lies behind (the wave's face) shows through by how
// much water the view crosses (the girth there: the fat crest near opaque, the thin tip see-through), tinted as the
// water tints it
void main() {
  #include <logdepthbuf_fragment>
  // only triangles wholly of the lip are drawn: one joining it to a vertex left under the water would be a curtain, and
  // one across the half-wave seam (one crest's feet to the next one's: the phase jumping from pi to -pi, so the
  // interpolated |phase| and the interpolated phase disagree) would join two lips; thrown away, pixel by pixel
  if (vLip.z < 0.002 || vIn < 0.999 || vPsi.y - abs(vPsi.x) > 1.2) discard;
  vec3 V = normalize(cameraPosition - vW), n = normalize(vN);
  if (dot(n, V) < -0.08) discard; // its outward faces only: a body, not a shell seen from both sides
  n = normalize(n + V * max(0.0, -dot(n, V)) * 1.2); // the rim turned to the eye
  if (uDebug > 8.5 && uDebug < 9.5) { oColor = vec4(mix(vec3(1.0, 0.08, 0.06), vec3(0.5, 0.0, 0.12), step(vLip.x, -0.001)) * (0.45 + 0.55 * max(dot(n, normalize(vec3(0.3, 1.0, 0.2))), 0.0)) * (uSkyUp * 0.6 + uSunColor * max(uSun.y, 0.0) * 0.4) * 3.0, 1.0); return; } // debug 9: the curl red, its underside dark red
  float sunUp = max(uSun.y, 0.0);
  vec3 ext = uAbs / max(uLook.x, 0.05) + uSca;
  float thick = clamp(vTh * 0.8 / max(dot(n, V), 0.3), 0.02, 8.0); // metres of water the view crosses: the girth there
  vec3 Tw = exp(-ext * thick);
  vec3 amb = uSkyUp / 3.14159 * 0.8 + uSunColor * sunUp / 3.14159 * 0.6;
  vec3 body = uSca / ext * (1.0 - Tw) * amb * 1.6 + vec3(0.02, 0.12, 0.09) * amb; // the lip's green, stronger than the open water's
  // light through it from the sun's side (the crest glow, the panel's)
  float through = pow(max(dot(-V, uSun), 0.0), 2.0);
  body += vec3(0.04, 0.42, 0.3) * (uSunColor * sunUp * 0.5 + uSkyUp * 0.35) * (0.25 + 0.75 * through) * (uLook.w / 1.6) * (0.3 + 0.7 * abs(vLip.x)) * 0.6;
  vec3 R = reflect(-V, n); R.y = abs(R.y);
  float F = wFresnel(max(dot(n, V), 0.0));
  vec3 refl = texture(uSkyView, skyUV(R, uSun)).rgb;
  vec3 Hh = normalize(V + uSun); float rough = 0.04 + uLook.y;
  float spec = pow(max(dot(n, Hh), 0.0), 2.0 / (rough * rough) - 2.0) * (1.0 / (3.14159 * rough * rough)) * 0.25 * wFresnel(dot(V, Hh)) * step(0.0, uSun.y);
  vec3 c = body * (1.0 - F) + refl * F + uSunColor * spec;
  float pass_ = dot(Tw, vec3(0.2126, 0.7152, 0.0722)) * (1.0 - F); // what of the background still shows through
  // the tip tearing into white at a full curl
  float tear = smoothstep(0.75, 1.0, abs(vLip.x)) * smoothstep(0.4, 0.8, vLip.y); // the spray line along the lip as it comes down
  float lace = texture(tFoam, vW.xz / 1.3 + vec2(0.0, vW.y)).r;
  float white = smoothstep(1.0 - 0.8 * tear, 1.1 - 0.8 * tear, lace + 0.1) * tear;
  c = mix(c, (uSkyUp * 0.8 + uSunColor * sunUp * 0.5) * 0.95, white);
  float a = max(1.0 - pass_ * (1.0 - white), 0.35) * vLip.z; // never wholly see-through: it reads
  oColor = vec4(c * a, a);
}`,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(this.grid, this.mat); // its own fine grid
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
  }
  dispose() { this.mat.dispose(); this.table.dispose(); this.grid.dispose(); }
}
