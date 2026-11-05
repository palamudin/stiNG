// Water 3: the breaking wave's tube. A heightfield cannot overhang, so the plunge is a mesh of its own: a tube laid
// along the crest, of which only an arc of the wall is shown; that arc grows from the crest's top in time with the
// wave: forward over the top and down (the lip, whitening at its edge) and back down the front (the face hollowing),
// until the lip reaches the trough and the tube closes; then it crashes, its foam left in the foam field where the
// lip came down, and that stretch of tube is gone for that wave (a big one may throw a second, smaller tube).
//
// The tube's cross-section: a circle tangent to the crest's top from behind (its centre ahead of and below the top),
// its radius two thirds of the face (crest to trough) times the panel's 'Curl size', so a full arc reaches the
// trough; the arc shown runs from -60 degrees (the crest's top, measured from straight up, forward positive) out to
// 170 degrees (the lip down at the trough) and back to -180 (the hollowed face down at the trough), as a band with a
// girth (two fifths of the radius at the face and root, a fifth at the lip's edge): a closed loop of wall, smooth normals.
//
// Placement: the tube is cut into world cells (4 m) round the camera, one instance each. A pass once a frame finds the
// cells a breaking crest runs through (cheap: one texel per cell); in those, each slice of the instance is a point of
// the crest (swept along the crest through the cell, snapped onto it), so the tube follows the crest's own curve and
// the neighbouring cells' pieces meet on it; each cell draws only the part of the tube whose spine lies inside it.
//
// The event (curlEvent: also the foam field's and the water surface's, which draws its face down to the tube's floor
// so the tube is open): a plunge is local and brief (field and lab: the lip's throw to its landing within about half a
// second, the tube closing within a second); a crest breaks first where it meets its break depth and the curl runs
// along it (a peel). Each wave picks, along its crest, stretches that plunge (the rest spill: the surf model's
// whitewater only); a big wave's tubes are big and rarer, a small wave's small and quick.
import * as THREE from 'three';
import { NOISE_GLSL } from '../noise.js';
import { SHORE } from '../shorefield.js';
import { SWASH_GLSL, SURF_GLSL } from './swash.js';
import { SKY_GLSL } from '../sky.js';

export const CURL = { cell: 4, cells: 80, along: 14, around: 48, sweep: 12 };

// the curl event of the main train's crest a point belongs to (sw3Ctx(xz) already called; the caller's coast context
// is restored on return). Out: the crest gcCx, the phase gcPsi (> 0 behind the crest), k at the point gcK, the depth
// at the crest gcDC, the wave's own height gcA0, the face (2a) gcH0, gcBig how much of a tube-making wave it is; the
// raw clock gcEv; the tube being drawn: its own clock gcE (0 .. 0.8 grown and closed .. 1 crashed and gone), its size
// gcSc (1, or the second tube's), its growth gcS, gcGate0 (whether this stretch plunges at all) and gcVis (shown now)
export const CURL_EVENT_GLSL = /* glsl */ `
vec2 gcCx = vec2(0.0); float gcPsi = 0.0, gcK = 1.0, gcDC = 1.0, gcA0 = 0.0, gcH0 = 0.0, gcBig = 0.0, gcEv = 0.0, gcE = 0.0, gcSc = 1.0, gcS = 0.0, gcGate0 = 0.0, gcVis = 0.0;
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
  float dC = max(level - clipHeight(gcCx), 0.02); gcDC = dC;
  float shoal = pow(clamp(max(dC, 0.6) / ${SHORE.dMax.toFixed(1)}, 0.04, 1.0), -0.25);
  float a0 = uSurf.x * gNear * gExpo * shoal * sw3Group(gcCx, uWTime), a = min(a0, 0.42 * dC + 0.02); gcA0 = a0; gcH0 = 2.0 * a;
  float early = 0.5 + 0.5 * w2noise(gcCx / 33.0 + vec2(cyc * 7.3, cyc * 3.1), 614);
  float rb = 0.3 + 0.09 * early, db = a0 / rb; // the breaking limit, early or late along the crest (water3/swash.js)
  vec3 cn = clipNormal(gcCx); float tb = max(sqrt(max(1.0 - cn.y * cn.y, 0.0)) / max(cn.y, 0.05), 0.004);
  float tSince = (db - dC) / tb / sqrt(9.81 * max(dC, 0.1)); // seconds since the crest reached its break line
  // along the crest (s): which stretches of this wave plunge, and the peel (the delay before it breaks here after its
  // break line, 0 at the stretch's starting points); a big wave's stretches long and fewer, a small one's short
  float s = dot(gcCx, vec2(-gDir.y, gDir.x)); gcBig = smoothstep(0.7, 1.5, a0);
  float plunge = smoothstep(0.5 + 0.12 * gcBig, 0.66 + 0.12 * gcBig, 0.5 + 0.5 * w2noise(vec2(s / mix(90.0, 260.0, gcBig), cyc * 2.71), 618));
  float delay = mix(1.0, 2.0, gcBig) * (0.5 + 0.5 * w2noise(vec2(s / mix(22.0, 60.0, gcBig), cyc * 1.37), 617));
  float te = mix(0.7, 1.2, gcBig) + 0.3 * clamp(a0, 0.0, 1.5); gcEv = (tSince - delay) / te;
  // the tube: grown and closed by 0.8 of its time, crashed and gone by 1; after it, on some stretches of a big wave,
  // a second one at about half the size
  float e = gcEv, g2 = 1.0; gcSc = 1.0;
  if (e > 1.05) { e = (gcEv - 1.1) / 0.75; gcSc = 0.55; g2 = smoothstep(0.3, 0.7, gcBig) * smoothstep(0.45, 0.55, 0.5 + 0.5 * w2noise(vec2(s / 80.0, cyc * 4.1), 619)); }
  gcE = e; gcS = smoothstep(0.0, 0.8, e);
  gcGate0 = smoothstep(0.05, 0.25, a0) * smoothstep(0.1, 0.35, dC) * plunge * g2;
  gcVis = gcGate0 * smoothstep(0.0, 0.06, e) * (1.0 - smoothstep(0.82, 1.0, e));
  gNear = sN; gExpo = sE; gPn = sP; gTau = sT; gShoreD = sD; gShoreKnow = sK; gDir = sG;
}
// the tube's circle (in the crest's plane: forward, up from the crest's top): (centre, radius); and the arc shown (its
// ends, radians from straight up, forward positive)
vec3 curlCircle(float scale, vec2 nudge) { float r = 0.667 * gcH0 * scale * gcSc; return vec3(vec2(0.866, -0.5) * r + nudge * gcH0, r); }
vec2 curlArc() { return vec2(-1.0472 - gcS * 2.0944, -1.0472 + gcS * 4.0143); }
// the water under a tube (water3/surface.js): its front face drawn down to the tube's floor between the crest and
// the lip's landing, so the tube is open. Returns (weight, the height to draw it down to, from the still water);
// sw3Ctx(xz) already called
vec2 curlScoop(vec2 xz, float level, float depth, float scale, vec2 nudge) {
  curlEvent(xz, level, depth);
  if (gcPsi >= 0.0 || gcVis <= 0.0) return vec2(0.0);
  vec3 C = curlCircle(scale, nudge);
  float xa = -gcPsi / gcK - (C.x - 0.866 * C.z); // ahead of the crest's top (the nudge's share taken off)
  return vec2(smoothstep(0.0, 0.35 * C.z, xa) * smoothstep(0.25, 0.6, gcS) * gcVis, max(-0.39 * gcH0, 0.61 * gcH0 + C.y - C.z));
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
        vec3 Cr = curlCircle(uLook3.w, uCurl.xy); vec2 arc = curlArc();
        float r = Cr.z;
        // round the wall's loop: the outer face from the arc's back end to the lip, the lip's edge, the inner face
        // back, the foot
        float q = tube.y, th, rad, ang; vec2 n2;
        float thk = r * 0.42; // the wall's girth at the face and root (a body of water, not a sheet), thinning to half along the lip
        if (q < 0.45) { ang = mix(arc.x, arc.y, q / 0.45); rad = r; n2 = vec2(sin(ang), cos(ang)); }
        else if (q < 0.5) { ang = arc.y; th = thk * mix(1.0, 0.5, smoothstep(-1.0, 3.0, ang)); rad = r - th * (q - 0.45) / 0.05; n2 = vec2(cos(ang), -sin(ang)); }
        else if (q < 0.95) { ang = mix(arc.y, arc.x, (q - 0.5) / 0.45); th = thk * mix(1.0, 0.5, smoothstep(-1.0, 3.0, ang)); rad = r - th; n2 = -vec2(sin(ang), cos(ang)); }
        else { ang = arc.x; rad = r - thk * (1.0 - (q - 0.95) / 0.05); n2 = -vec2(cos(ang), -sin(ang)); }
        vec2 o = Cr.xy + rad * vec2(sin(ang), cos(ang));
        P = top + vec3(dir.x, 0.0, dir.y) * o.x + vec3(0.0, o.y, 0.0);
        vN = vec3(dir.x, 0.0, dir.y) * n2.x + vec3(0.0, n2.y, 0.0);
        vTh = thk * mix(1.0, 0.5, smoothstep(-1.0, 3.0, ang));
        vInfo = vec4(arc.y - ang, gcS, gcVis, gcVis > 0.002 && r > 0.02 ? 1.0 : 0.0);
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
