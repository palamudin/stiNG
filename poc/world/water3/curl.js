// Water 3: the breaking wave's tube. A heightfield cannot overhang, so the plunge is a mesh of its own: a tube laid
// along the crest, of which only an arc of the wall is shown; that arc grows from the crest's top in time with the
// wave: forward over the top and down (the lip, whitening at its edge) and back down the front (the face hollowing),
// until the lip reaches the trough and the tube closes; then it crashes, its foam left in the foam field where the
// lip came down, and that stretch of tube is gone for that wave (a big one may throw a second, smaller tube).
//
// The tube's cross-section: a body of water, a swell on the swell pushed forward: as wide at its base as half the wave,
// up its back just over the swell's own, to a fat head (a third of the face thick) that leans out over the face; the
// head is then thrown, its tip going on forward and falling under gravity to the trough, the tube under it, the face
// hollowed. Sized by the face (crest to trough) times the panel's 'Curl size'; a closed loop, smooth normals.
//
// Placement: the tube is cut into world cells (4 m) round the camera, one instance each. A pass once a frame finds the
// cells a breaking crest runs through (cheap: one texel per cell); in those, each slice of the instance is a point of
// the crest (swept along the crest through the cell, snapped onto it), so the tube follows the crest's own curve and
// the neighbouring cells' pieces meet on it; each cell draws only the part of the tube whose spine lies inside it.
//
// The event (curlEvent: also the foam field's and the water surface's, which draws its face down to the tube's floor
// so the tube is open): it rides with the wave for about three seconds: the lip rising out of the crest slowly, then
// falling at gravity's pace to the trough, then crashing into foam. Each wave picks, along its crest, stretches that
// plunge (the rest spill: the surf model's whitewater only); a big wave's tubes are big and rarer, a small wave's small.
import * as THREE from 'three';
import { NOISE_GLSL } from '../noise.js';
import { SHORE } from '../shorefield.js';
import { SWASH_GLSL, SURF_GLSL } from './swash.js';
import { SKY_GLSL } from '../sky.js';

export const CURL = { cell: 4, cells: 80, along: 14, around: 48, sweep: 12 };

// the curl event of the main train's crest a point belongs to (sw3Ctx(xz) already called; the caller's coast context
// is restored on return). Out: the crest gcCx, the phase gcPsi (> 0 behind the crest), k at the point gcK, the depth
// at the crest gcDC, the wave's own height gcA0, the face (2a) gcH0, gcBig how much of a tube-making wave it is; the
// raw clock gcEv (s since it broke here); the tube being drawn: its own clock gcE (0 .. 0.8 landed .. 1 crashed and
// gone), its size gcSc (1, or the second tube's), its rise gcRise and fall gcFall (0..1 each), the lip's flight gcP (0..1, the tip's share of its flight to the trough), its growth gcS, gcGate0 (whether this stretch plunges at all) and gcVis (shown now)
export const CURL_EVENT_GLSL = /* glsl */ `
vec2 gcCx = vec2(0.0); float gcPsi = 0.0, gcK = 1.0, gcDC = 1.0, gcA0 = 0.0, gcH0 = 0.0, gcBig = 0.0, gcEv = 0.0, gcE = 0.0, gcSc = 1.0, gcS = 0.0, gcRise = 0.0, gcFall = 0.0, gcUnf = 0.0, gcP = 0.0, gcGate0 = 0.0, gcVis = 0.0;
const float CG = 9.81;
// the lip's throw for a face of height H (m), in the crest's frame (forward, up from the crest's top): launched up and
// forward so it tops out 0.35 H above the crest and comes down 1.3 H ahead at the trough (H below the top): (vx, vy)
vec2 curlLaunch(float H) { float vy = sqrt(2.0 * CG * 0.35 * H), tl = (vy + sqrt(vy * vy + 2.0 * CG * H)) / CG; return vec2(1.3 * H / tl, vy); }
float curlLand(float H) { float vy = sqrt(2.0 * CG * 0.35 * H); return (vy + sqrt(vy * vy + 2.0 * CG * H)) / CG; } // its flight time to the trough
float curlCel(float d) { return sqrt(9.81 * clamp(d, ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)})); }
void curlEvent(vec2 xz, float level, float depth) {
  float sN = gNear, sE = gExpo, sP = gPn, sT = gTau, sD = gShoreD, sK = gShoreKnow; vec2 sG = gDir;
  float w = sw3Omega(0); gcK = w / curlCel(depth);
  float ph = sw3Phase(0, uWTime, gTau, gPn); gcPsi = mod(ph + 3.14159265, 6.2831853) - 3.14159265;
  float cyc = floor((ph + 3.14159265) / 6.2831853);
  vec2 c0 = xz + gDir * (gcPsi / gcK);
  // one step more onto the crest itself (its own phase, its own depth there)
  if (sw3Ctx(c0)) { float p0 = mod(sw3Phase(0, uWTime, gTau, gPn) + 3.14159265, 6.2831853) - 3.14159265; c0 += gDir * (p0 * curlCel(level - clipHeight(c0)) / w); sw3Ctx(c0); }
  gcCx = c0;
  float tauC = gTau; // the crest's travel time to the line (s): it falls at one second a second as the crest comes in
  float dC = max(level - clipHeight(gcCx), 0.02); gcDC = dC;
  vec2 pp = vec2(-gDir.y, gDir.x);
  // the depth there over the bed's small bumps (12 m across), for when it breaks
  float dS = max(level - 0.2 * (clipHeight(gcCx) + clipHeight(gcCx + gDir * 6.0) + clipHeight(gcCx - gDir * 6.0) + clipHeight(gcCx + pp * 6.0) + clipHeight(gcCx - pp * 6.0)), 0.05);
  float shoal = pow(clamp(max(dC, 0.6) / ${SHORE.dMax.toFixed(1)}, 0.04, 1.0), -0.25);
  float a0 = uSurf.x * gNear * gExpo * shoal * sw3Group(gcCx, uWTime), a = min(a0, 0.42 * dC + 0.02); gcA0 = a0; gcH0 = 2.0 * a;
  float s = dot(gcCx, pp);
  float early = 0.5 + 0.5 * w2noise(vec2(s / 33.0, cyc * 3.1), 614); // along the crest only: it does not change as the crest comes in
  float rb = 0.3 + 0.09 * early, db = a0 / rb; // the breaking limit, early or late along the crest (water3/swash.js)
  // the time since the crest passed its break line, on the water's own clock: on a plane beach tau = 2 sqrt(d) /
  // (slope sqrt g), so the line where the depth is db lies at tau sqrt(db / d); tau is the table's smooth travel time,
  // which the crest follows exactly, so this runs at one second a second with no jumps from the bed's bumps
  float tSince = tauC * (sqrt(db / dS) - 1.0);
  // along the crest (s): which stretches of this wave plunge, and the peel (the delay before it breaks here after its
  // break line, 0 at the stretch's starting points); a big wave's stretches long and fewer, a small one's short
  gcBig = smoothstep(0.7, 1.5, a0);
  float plunge = smoothstep(0.5 + 0.12 * gcBig, 0.66 + 0.12 * gcBig, 0.5 + 0.5 * w2noise(vec2(s / mix(90.0, 260.0, gcBig), cyc * 2.71), 618));
  // the stretch breaks nearly together (it rides with the wave as one), its ends a little later
  float delay = 0.5 * (0.5 + 0.5 * w2noise(vec2(s / 70.0, cyc * 1.37), 617));
  float t = tSince - delay; gcEv = t;
  // the tube, in seconds: the lip rises out of the crest slowly, riding with the wave (2.2 s, more for a big one), up to
  // the top of its throw; then it is a thrown sheet: its tip flies on forward and falls under gravity to the trough
  // (the throw's own flight time: about half a second for a metre's face); then it crashes into foam and is gone
  // (0.4 s). On some stretches of a big wave a second tube follows, about half the size, quicker
  float tl = curlLand(max(gcH0, 0.05)), ta = curlLaunch(max(gcH0, 0.05)).y / CG;
  float tr = mix(2.2, 2.8, gcBig), tf = tl - ta, tc = 0.9, g2 = 1.0; gcSc = 1.0;
  if (t > tr + tf + tc + 0.1) {
    t -= tr + tf + tc + 0.2; gcSc = 0.55; tr *= 0.6; tf *= 0.75; tc *= 0.8;
    g2 = smoothstep(0.3, 0.7, gcBig) * smoothstep(0.45, 0.55, 0.5 + 0.5 * w2noise(vec2(s / 80.0, cyc * 4.1), 619));
  }
  gcRise = smoothstep(0.0, tr, t); gcFall = clamp((t - tr) / tf, 0.0, 1.0); gcUnf = clamp((t - tr - tf) / tc, 0.0, 1.0);
  gcP = (ta / tl) * gcRise + (1.0 - ta / tl) * gcFall; // the tip's flight: rising to the throw's top, then on at the water's pace
  gcE = t < tr + tf ? 0.8 * max(t, -1.0) / (tr + tf) : 0.8 + 0.2 * (t - tr - tf) / tc; // 0.8 landed, 1 gone
  gcS = 0.5 * gcRise + 0.5 * gcFall;
  // room to fall: only where the water under the crest is deep for the wave (more than its face), where the trough the
  // lip falls into is still water half a wave ahead, and the shoreline is well beyond that; inshore of it the crest
  // only foams and the foam rides up the beach (the surf model's)
  float Lh = 3.14159265 * curlCel(dC) / w, dAhead = level - clipHeight(gcCx + gDir * 0.6 * Lh);
  float room = smoothstep(1.0, 1.5, dS / max(gcH0, 0.1)) * smoothstep(0.4, 1.0, dAhead / max(gcH0, 0.1)) * smoothstep(0.7 * Lh + 4.0, 0.7 * Lh + 20.0, -gShoreD);
  gcGate0 = smoothstep(0.05, 0.25, a0) * smoothstep(0.1, 0.35, dC) * plunge * g2 * room;
  gcVis = gcGate0 * smoothstep(0.0, 0.3, t) * (1.0 - smoothstep(tr + tf + 0.05, tr + tf + tc, t));
  gNear = sN; gExpo = sE; gPn = sP; gTau = sT; gShoreD = sD; gShoreKnow = sK; gDir = sG;
}
// the wall's centreline for a tube of face H (m), at c: 0 the hollowed face's foot, 0.4 the crest's top, 1 the lip's tip;
// (forward, up) from the crest's top and its direction of travel along c (not normalised). The face: hollowed, down
// and a little back under the top, then out to its foot, shown down to uf (0..1); the lip: the throw's path, the
// sheet's tip at flight time lt (s), so it goes on forward as it falls
vec4 curlLine(float c, float H, float uf, float lt) {
  if (c < 0.4) {
    float u = uf * (1.0 - c / 0.4);
    vec2 P1 = vec2(-0.25, -0.5) * H, P2 = vec2(0.3, -1.0) * H;
    vec2 dF = 2.0 * (1.0 - u) * P1 + 2.0 * u * (P2 - P1);
    return vec4(2.0 * u * (1.0 - u) * P1 + u * u * P2, -dF * max(uf, 0.02));
  }
  vec2 v = curlLaunch(H); float l = (c - 0.4) / 0.6 * lt;
  return vec4(v.x * l, v.y * l - 0.5 * CG * l * l, v.x, v.y - CG * l);
}
// the water under a tube (water3/surface.js): its front face drawn down to the tube's floor between the crest and
// the lip's landing, so the tube is open. Returns (weight, the height to draw it down to, from the still water);
// sw3Ctx(xz) already called
vec2 curlScoop(vec2 xz, float level, float depth, float scale, vec2 nudge) {
  curlEvent(xz, level, depth);
  if (gcPsi >= 0.0 || gcVis <= 0.0) return vec2(0.0);
  float H = gcH0 * scale * gcSc, xa = -gcPsi / gcK - nudge.x * gcH0; // ahead of the crest's top
  return vec2(smoothstep(0.15 * H, 0.5 * H, xa) * smoothstep(0.3, 0.7, gcRise) * gcVis, max(-0.39 * gcH0, 0.61 * gcH0 - H + nudge.y * gcH0));
}
`;

// the tube's piece: along (0..1 across the sweep) x around (0..1 round the wall's loop), closed round
function tubeGeometry() {
  const A = CURL.along, R = CURL.around, n = CURL.cells * CURL.cells;
  const tube = new Float32Array(A * R * 2), idx = [];
  for (let j = 0; j < A; j++) for (let i = 0; i < R; i++) { const o = (j * R + i) * 2; tube[o] = j / (A - 1); tube[o + 1] = i / R; }
  for (let j = 0; j < A - 1; j++) for (let i = 0; i < R; i++) { const a = j * R + i, b = j * R + (i + 1) % R, c = a + R, d = b + R; idx.push(a, c, b, b, c, d); }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(A * R * 3), 3)); // unused (three wants one)
  g.setAttribute('tube', new THREE.BufferAttribute(tube, 2));
  const id = new Float32Array(n); for (let k = 0; k < n; k++) id[k] = k;
  g.setAttribute('cellId', new THREE.InstancedBufferAttribute(id, 1));
  g.setIndex(idx); g.instanceCount = n;
  return g;
}

export class CurlMesh {
  constructor(world, surface) {
    const shore = world.shore, S = surface.U, C = CURL, NC = C.cells;
    const common = {
      ...world.clip.uniforms, ...shore.uniforms,
      uSurf: world.uSurf, uSurfX: world.uSurfX, uWTime: world.uWTime, uSwDir: world.uSwDir, uLook3: world.uLook3, uCurl: world.uCurl,
      uSeaLevel: S.uSeaLevel, uCellO: { value: new THREE.Vector2() },
    };
    const lib = `${NOISE_GLSL}
${world.clip.glsl()}
${shore.glsl()}
${SWASH_GLSL}
${SURF_GLSL}
uniform float uSeaLevel; uniform vec4 uLook3, uCurl; uniform vec2 uCellO;
${CURL_EVENT_GLSL}
const float CS = ${C.cell.toFixed(1)}, NC = ${NC.toFixed(1)};`;

    // ---- the cells' pass: which cells a tube runs through now, and where its crest is (from the cell's centre)
    this.cells = new THREE.WebGLRenderTarget(NC, NC, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    this.cellMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: common, depthTest: false, depthWrite: false,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `precision highp float; precision highp int;
${lib}
out vec4 oColor;
void main() {
  vec2 c = uCellO + (floor(gl_FragCoord.xy) + 0.5) * CS;
  oColor = vec4(0.0);
  float level = clipWater(c), depth = level - clipHeight(c);
  if (level > uSeaLevel + 0.5 || depth <= 0.0 || uSurf.x <= 0.0 || uLook3.w <= 0.0 || !sw3Ctx(c)) return;
  curlEvent(c, level, depth);
  // a tube here: the crest within the cell's reach (its half diagonal and a little), with a tube on it now or soon
  if (distance(gcCx, c) < 0.75 * CS * 1.4143 + 0.5 && gcGate0 > 0.002 && gcE > -0.25 && gcE < 1.05) oColor = vec4(gcCx - c, 1.0, 0.0);
}`,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.cellMat); this.quad.frustumCulled = false;
    this.cellScene = new THREE.Scene(); this.cellScene.add(this.quad); this.cam = new THREE.Camera();

    // ---- the tube
    const U = {
      ...common, tCells: { value: this.cells.texture },
      uSun: world.sky.uniforms.uSun, uSunColor: world.sky.uniforms.uSunColor, uSkyUp: S.uSkyUp, tFoam: S.tFoam,
      uDebug: world.post.U.uDebug, uSkyView: world.sky.uniforms.uSkyView, uMS: world.sky.uniforms.uMS, uHaze: world.sky.uniforms.uHaze, uAbs: world.uAbs, uSca: world.uSca, uLook: world.uLook, uLook2: world.uLook2,
    };
    this.U = U;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: U, side: THREE.DoubleSide, transparent: true, depthWrite: true,
      vertexShader: /* glsl */ `precision highp float; precision highp int;
#include <common>
#include <logdepthbuf_pars_vertex>
${lib}
uniform sampler2D tCells;
in vec2 tube; in float cellId;
out vec3 vW, vN; out vec4 vInfo; out float vTh; out vec2 vSpine; flat out vec2 vCell;
// vInfo: (how far back from the lip's edge, radians; growth; shown; 1 where this vertex is good)
void main() {
  vInfo = vec4(0.0); vTh = 0.0; vN = vec3(0.0, 1.0, 0.0);
  vec2 ij = vec2(mod(cellId, NC), floor(cellId / NC)); vCell = uCellO + ij * CS;
  vec4 st = texelFetch(tCells, ivec2(ij), 0);
  gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vW = vec3(0.0); vSpine = vec2(1e9); // nothing here: outside the view
  if (st.z < 0.5) return;
  vec2 cx0 = vCell + 0.5 * CS + st.xy;
  float level = clipWater(cx0);
  vec3 P = vec3(cx0.x, level - 2.0, cx0.y);
  if (sw3Ctx(cx0)) {
    // this slice: a point swept along the crest through the cell, snapped onto the crest (curlEvent)
    vec2 p = cx0 + vec2(-gDir.y, gDir.x) * (tube.x - 0.5) * ${C.sweep.toFixed(1)};
    float lp = clipWater(p);
    if (sw3Ctx(p)) {
      curlEvent(p, lp, lp - clipHeight(p));
      vSpine = gcCx;
      if (sw3Ctx(gcCx)) {
        vec2 dir = gDir;
        vec3 d = w3Coast(gcCx, gcDC, 0.25); // the crest's top: the water's own (both trains, its lean, its collapse)
        vec3 top = vec3(gcCx.x + d.x, clipWater(gcCx) + d.y, gcCx.y + d.z);
        // the body: a swell on the swell, pushed forward. Its cross-section, (forward, up) from the crest's top, round
        // eleven points: the back's foot (half a half-wave behind, under the water), up the back (just over the swell's
        // own), the head (fat: a third of the face from its top to the tube's ceiling), the lip and its tip, under the
        // lip (the tube's ceiling), down the hollowed face, its foot ahead (under the water drawn down), and back along
        // the bottom under the water. It rises from a cap on the crest (2-3 s), then the head is thrown: the tip goes on
        // forward and falls under gravity to the trough. H the face (crest to trough) times the panel's size; Lh half
        // the wave's length there
        float H = gcH0 * uLook3.w * gcSc, Lh = 3.14159265 * curlCel(gcDC) / sw3Omega(0) * gcSc;
        float r = gcRise, f = gcFall, f2 = f * f;
        vec2 K[11];
        K[0] = vec2(-0.6 * Lh, -1.0 * H);
        K[1] = vec2(-0.35 * Lh, (-0.35 + 0.1 * r) * H);
        K[2] = vec2(-0.12 * Lh, (-0.05 + 0.35 * r) * H);
        K[3] = vec2(0.1 + 0.5 * r + 0.15 * f, 0.15 + 0.45 * r - 0.2 * f2) * H;                                   // the head's top
        K[4] = vec2(mix(0.3, 0.9, r) + 0.35 * f, mix(0.05, 0.55, r) - 0.35 * f2) * H;                          // the lip
        K[5] = vec2(mix(0.4, 1.15, r) + 0.3 * f, mix(-0.1, 0.3, r) - 1.25 * f2) * H;                           // its tip
        K[6] = vec2(mix(0.3, 0.85, r) + 0.25 * f, mix(-0.15, 0.2, r) - 0.7 * f2) * H;                          // under the lip
        K[7] = vec2(mix(0.2, 0.4, r) + 0.15 * f, mix(-0.15, 0.15, r) - 0.05 * f) * H;                          // the tube's ceiling
        K[8] = vec2(0.2, -0.25) * H;                                                                            // the hollowed face
        K[9] = vec2(0.35, -0.75) * H;
        K[10] = vec2(0.6, -1.2) * H;                                                                            // its foot
        // the loop: closed Catmull-Rom through them
        float g = tube.y * 11.0; int k = int(floor(g)); float u = g - float(k);
        vec2 p0 = K[(k + 10) % 11], p1 = K[k % 11], p2 = K[(k + 1) % 11], p3 = K[(k + 2) % 11];
        float u2 = u * u, u3 = u2 * u;
        vec2 o = 0.5 * (2.0 * p1 + (-p0 + p2) * u + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * u2 + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * u3);
        vec2 t = 0.5 * ((-p0 + p2) + 2.0 * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * u + 3.0 * (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * u2);
        t = length(t) > 1e-6 ? normalize(t) : vec2(1.0, 0.0);
        vec2 n2 = vec2(-t.y, t.x); // outward: the loop runs clockwise (over the top forward, along the bottom back)
        o += uCurl.xy * gcH0; // the panel's nudge, forward and up, in face heights
        P = top + vec3(dir.x, 0.0, dir.y) * o.x + vec3(0.0, o.y, 0.0);
        vN = vec3(dir.x, 0.0, dir.y) * n2.x + vec3(0.0, n2.y, 0.0);
        float fromTip = abs(g - 5.0);
        vTh = H * (0.3 + 0.6 * smoothstep(1.0, 3.5, fromTip)); // the water the view crosses: the head's and the body's, thin at the lip
        vInfo = vec4(fromTip * 0.45, gcS, gcVis, gcVis > 0.002 && H > 0.03 ? 1.0 : 0.0);
      }
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
const float CS = ${C.cell.toFixed(1)};
in vec3 vW, vN; in vec4 vInfo; in float vTh; in vec2 vSpine; flat in vec2 vCell; out vec4 oColor;
const float W_N = 1.333;
float wFresnel(float ci) {
  ci = clamp(ci, 0.0, 1.0); float st2 = (1.0 - ci * ci) / (W_N * W_N); if (st2 >= 1.0) return 1.0;
  float ct = sqrt(1.0 - st2), rs = (ci - W_N * ct) / (ci + W_N * ct), rp = (W_N * ci - ct) / (W_N * ci + ct);
  return 0.5 * (rs * rs + rp * rp);
}
// the water's own material (water3/surface.js): absorption and scattering (the colour preset and clarity), the sky by
// exact Fresnel, the sun's highlight, light through the wall (thick at the face, thin at the lip); the lip's edge
// whitening into foam as it is thrown, more as the tube closes
void main() {
  #include <logdepthbuf_fragment>
  // this cell's share of the tube only (its spine inside the cell; the neighbours draw theirs), and none where a
  // vertex had no tube
  if (vInfo.w < 0.999 || vInfo.z < 0.002 || any(lessThan(vSpine, vCell)) || any(greaterThanEqual(vSpine, vCell + CS))) discard;
  vec3 V = normalize(cameraPosition - vW), n = normalize(vN);
  if (dot(n, V) < -0.1) discard; // its outward faces: a wall of water, not a shell seen from both sides
  n = normalize(n + V * max(0.0, -dot(n, V)) * 1.2);
  float foamy = (1.0 - smoothstep(0.0, 0.7, vInfo.x)) * smoothstep(0.2, 0.7, vInfo.y);
  if (uDebug > 8.5 && uDebug < 9.5) { oColor = vec4(mix(vec3(1.0, 0.08, 0.06), vec3(1.0, 0.95, 0.9), foamy) * (0.45 + 0.55 * max(dot(n, normalize(vec3(0.3, 1.0, 0.2))), 0.0)) * (uSkyUp * 0.6 + uSunColor * max(uSun.y, 0.0) * 0.4) * 3.0, 1.0); return; } // debug 9: the tube red, its lip's foam white
  float sunUp = max(uSun.y, 0.0);
  vec3 ext = uAbs / max(uLook.x, 0.05) + uSca;
  float thick = clamp(vTh / max(dot(n, V), 0.3), 0.02, 6.0); // metres of water the view crosses
  vec3 Tw = exp(-ext * thick);
  vec3 amb = uSkyUp / 3.14159 * 0.8 + uSunColor * sunUp / 3.14159 * 0.6;
  vec3 body = uSca / ext * (1.0 - Tw) * amb * 1.6 + vec3(0.02, 0.12, 0.09) * amb;
  float through = pow(max(dot(-V, uSun), 0.0), 2.0); // light through it from the sun's side (the crest glow, the panel's)
  body += vec3(0.04, 0.42, 0.3) * (uSunColor * sunUp * 0.5 + uSkyUp * 0.35) * (0.25 + 0.75 * through) * (uLook.w / 1.6) * 0.5;
  vec3 R = reflect(-V, n); R.y = abs(R.y);
  float F = wFresnel(max(dot(n, V), 0.0));
  vec3 refl = texture(uSkyView, skyUV(R, uSun)).rgb;
  vec3 Hh = normalize(V + uSun); float rough = 0.04 + uLook.y;
  float spec = pow(max(dot(n, Hh), 0.0), 2.0 / (rough * rough) - 2.0) * (1.0 / (3.14159 * rough * rough)) * 0.25 * wFresnel(dot(V, Hh)) * step(0.0, uSun.y);
  vec3 c = body * (1.0 - F) + refl * F + uSunColor * spec;
  float pass_ = dot(Tw, vec3(0.2126, 0.7152, 0.0722)) * (1.0 - F);
  // the lip's edge into foam, laced
  float lace = texture(tFoam, vW.xz / 1.3 + vec2(0.0, vW.y * 0.7)).r;
  float white = clamp(foamy * 1.4 - (1.0 - lace) * 0.6, 0.0, 1.0);
  c = mix(c, (uSkyUp * 0.8 + uSunColor * sunUp * 0.5) * 0.95, white);
  float a = max(1.0 - pass_ * (1.0 - white), 0.4) * vInfo.z;
  oColor = vec4(c * a, a);
}`,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(tubeGeometry(), this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
  }
  // once a frame, before the water is drawn: the cells round the camera, and which carry a tube
  update(renderer, camera) {
    const C = CURL, half = C.cell * C.cells / 2;
    this.U.uCellO.value.set(Math.floor((camera.position.x - half) / C.cell) * C.cell, Math.floor((camera.position.z - half) / C.cell) * C.cell);
    const prev = renderer.getRenderTarget(); renderer.setRenderTarget(this.cells); renderer.render(this.cellScene, this.cam); renderer.setRenderTarget(prev);
  }
  dispose() { this.mat.dispose(); this.cellMat.dispose(); this.cells.dispose(); this.mesh.geometry.dispose(); this.quad.geometry.dispose(); }
}
