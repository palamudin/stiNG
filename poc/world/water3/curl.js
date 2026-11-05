// Water 3: the breaking wave's curl, a mesh of its own over the water. A heightfield cannot overhang, so the lip is a
// second surface: the same camera-centred grid as the water, each vertex mapped onto the lip of the surf crest nearest
// it (the first train's crest: water3/swash.js), in the shape a table gives for the breaker's stage.
//
// The table (computed once): for each stage of a breaker the lip's cross-section from its root (inside the crest's top)
// to its tip, as (forward, up): forward in units of where it lands, up in units of the wave's face (crest to trough).
// Keyframes, eased between: a bump on the crest; the crest standing up past its own top and leaning forward; the lip
// thrown over the face; the lip landed at the foot of the face, a tube between it and the face under it.
//
// Per vertex: the main train's phase there gives the crest it belongs to (half a wave either side) and where along the
// lip it falls: behind the crest (phase 0 to pi) the lip's outer surface root to tip, ahead of it (0 to -pi) its inner
// surface (the tube's ceiling), a sheet's thickness in from the outer, the two meeting at the tip. The triangles across
// the half-wave seam (one crest's tip to the next one's) are thrown away. The event is the breaker's own: the time
// since the crest crossed its break line (the depth falling to the height over the breaking ratio) runs it, about three
// seconds (more for a bigger wave): half building, then thrown and landed, held as a tube, then the lip drops into the
// bore. The break line varies along the crest, so the tube travels along it (a peel). The panel's 'Curl' scales it.
import * as THREE from 'three';
import { NOISE_GLSL } from '../noise.js';
import { SHORE } from '../shorefield.js';
import { SWASH_GLSL, SURF_GLSL } from './swash.js';
import { SKY_GLSL } from '../sky.js';

export const CURL = { stages: 32, samples: 48 };

// the lip's keyframes: [stage, Bezier control points (forward in landing units, up in face heights)]
const KEYS = [
  [0.0, [[-0.06, -0.12], [0.0, 0.04], [0.03, 0.1], [0.06, 0.12]]],    // a bump on the crest
  [0.4, [[-0.06, -0.12], [0.0, 0.38], [0.12, 0.6], [0.3, 0.55]]],     // standing up past the crest, leaning forward
  [0.7, [[-0.06, -0.12], [0.02, 0.52], [0.6, 0.78], [0.9, 0.0]]],     // thrown over the face
  [1.0, [[-0.06, -0.12], [0.03, 0.52], [0.85, 0.72], [1.0, -1.05]]],  // landed at the foot of the face: the tube
];
function profile(s, u) {
  let k = 0; while (k < KEYS.length - 2 && s > KEYS[k + 1][0]) k++;
  let f = (s - KEYS[k][0]) / (KEYS[k + 1][0] - KEYS[k][0]); f = Math.min(Math.max(f, 0), 1); f = f * f * (3 - 2 * f);
  const P = KEYS[k][1].map((a, i) => [a[0] + (KEYS[k + 1][1][i][0] - a[0]) * f, a[1] + (KEYS[k + 1][1][i][1] - a[1]) * f]);
  const v = 1 - u, b = [v * v * v, 3 * v * v * u, 3 * v * u * u, u * u * u];
  return [0, 1].map(c => b[0] * P[0][c] + b[1] * P[1][c] + b[2] * P[2][c] + b[3] * P[3][c]);
}
function curlTable() {
  const S = CURL.stages, U = CURL.samples, data = new Float32Array(S * U * 4);
  for (let j = 0; j < S; j++) for (let i = 0; i < U; i++) { const p = profile(j / (S - 1), i / (U - 1)), o = (j * U + i) * 4; data[o] = p[0]; data[o + 1] = p[1]; }
  const t = new THREE.DataTexture(data, U, S, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; // read with its own bilinear (float filtering is not everywhere)
  return t;
}

export class CurlMesh {
  constructor(world, surface) {
    const shore = world.shore, S = surface.U;
    this.table = curlTable();
    const U = {
      ...world.clip.uniforms, ...shore.uniforms,
      uSurf: world.uSurf, uSurfX: world.uSurfX, uWTime: world.uWTime, uSwDir: world.uSwDir, uLook3: world.uLook3,
      uCam: S.uCam, uGridScale: S.uGridScale, uSeaLevel: S.uSeaLevel, tCurl: { value: this.table },
      uSun: world.sky.uniforms.uSun, uSunColor: world.sky.uniforms.uSunColor, uSkyUp: S.uSkyUp, tFoam: S.tFoam,
      uDebug: world.post.U.uDebug, uSkyView: world.sky.uniforms.uSkyView, uMS: world.sky.uniforms.uMS, uHaze: world.sky.uniforms.uHaze, uAbs: world.uAbs, uSca: world.uSca, uLook: world.uLook, uLook2: world.uLook2,
    };
    this.U = U;
    const C = CURL;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: U, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      vertexShader: /* glsl */ `precision highp float; precision highp int;
#include <common>
#include <logdepthbuf_pars_vertex>
${NOISE_GLSL}
${world.clip.glsl()}
${shore.glsl()}
${SWASH_GLSL}
${SURF_GLSL}
uniform vec3 uCam; uniform float uGridScale, uSeaLevel; uniform vec4 uLook3; uniform highp sampler2D tCurl;
out vec3 vW; out vec4 vLip; out float vIn, vTh; out vec2 vPsi; // vLip: (u root..tip, stage, shown, 1 inner surface); vTh: the sheet's thickness (m); vPsi: (phase, |phase|) for the seam
// the table, bilinear by hand
vec2 curlAt(float u, float s) {
  vec2 g = vec2(u * ${(C.samples - 1).toFixed(1)}, s * ${(C.stages - 1).toFixed(1)}); vec2 i0 = floor(g), f = g - i0; ivec2 i = ivec2(i0), j = min(i + 1, ivec2(${C.samples - 1}, ${C.stages - 1}));
  vec2 a = texelFetch(tCurl, i, 0).xy, b = texelFetch(tCurl, ivec2(j.x, i.y), 0).xy, c = texelFetch(tCurl, ivec2(i.x, j.y), 0).xy, d = texelFetch(tCurl, j, 0).xy;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vLip = vec4(0.0); vIn = 0.0; vTh = 0.0; vPsi = vec2(0.0);
  vec2 xz = uCam.xz + position.xz * uGridScale;
  float level = clipWater(xz);
  vec3 P = vec3(xz.x, level - 0.4, xz.y); // under the water: no lip here
  if (position.y < 0.5 && distance(xz, uCam.xz) < 240.0 && level <= uSeaLevel + 0.5 && uSurf.x > 0.0 && uLook3.w > 0.0 && sw3Ctx(xz)) {
    float depth = level - clipHeight(xz);
    float w = sw3Omega(0), k = w / sqrt(9.81 * clamp(depth, ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)}));
    float ph = sw3Phase(0, uWTime, gTau, gPn), psi = mod(ph + 3.14159265, 6.2831853) - 3.14159265;
    // the crest this vertex belongs to: psi / k metres shoreward (psi > 0 is behind it, psi < 0 ahead of it)
    vec2 cx = xz + gDir * (psi / k);
    float dC = max(level - clipHeight(cx), 0.02);
    float shoal = pow(clamp(max(dC, 0.6) / ${SHORE.dMax.toFixed(1)}, 0.04, 1.0), -0.25);
    float a0 = uSurf.x * gNear * gExpo * shoal * sw3Group(cx, uWTime), a = min(a0, 0.42 * dC + 0.02);
    float cyc = floor((ph + 3.14159265) / 6.2831853), early = 0.5 + 0.5 * w2noise(cx / 33.0 + vec2(cyc * 7.3, cyc * 3.1), 614);
    // the break line varies along the crest over a hundred metres or so, a new layout every wave: the tube runs along it
    float peel = 0.5 + 0.5 * w2noise(cx / 120.0 + vec2(cyc * 3.7, -cyc * 2.3), 616);
    float rb = 0.3 + 0.12 * mix(early, peel, 0.7), db = a0 / rb; // about the breaking limit (water3/swash.js)
    vec3 cn = clipNormal(cx); float tb = max(sqrt(max(1.0 - cn.y * cn.y, 0.0)) / max(cn.y, 0.05), 0.004);
    float tSince = (db - dC) / tb / sqrt(9.81 * max(dC, 0.1)); // seconds since the crest crossed its break line
    // the event: about 3 s for a metre's wave; built over its first 0.7, the tube held, the lip dropping into the bore
    // from 0.8, gone by 1.2
    float te = 2.2 + 1.0 * clamp(a0, 0.0, 1.5), ev = tSince / te;
    float stage = clamp(smoothstep(0.0, 0.7, ev), 0.0, 1.0), fall = smoothstep(0.8, 1.15, ev);
    float show = smoothstep(0.0, 0.08, ev) * (1.0 - smoothstep(1.0, 1.2, ev)) * smoothstep(0.03, 0.2, a0) * smoothstep(0.1, 0.35, dC)
               * (1.0 - smoothstep(170.0, 230.0, distance(cx, uCam.xz)));
    if (show > 0.002 && sw3Ctx(cx)) {
      // its size: the wave's face (crest to trough, 2a), the panel's Curl times that; it lands where the face reaches
      // its foot (1.7 rad of the wave ahead of the crest), so the face under it and the lip make a tube
      float kc = w / sqrt(9.81 * clamp(dC, ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)}));
      float H = 2.0 * a * uLook3.w * (0.3 + 0.7 * smoothstep(0.0, 0.12, ev));
      float L = clamp(1.7 / (kc * max(H, 0.05)), 0.8, 3.5) * H;
      float u = abs(psi) / 3.14159265;
      vec2 sc = vec2(L, H), o = curlAt(u, stage) * sc;
      vec2 t = (curlAt(min(u + 0.03, 1.0), stage) - curlAt(max(u - 0.03, 0.0), stage)) * sc; t /= max(length(t), 1e-5);
      float th = H * mix(0.14, 0.012, u) * (0.5 + 0.5 * stage); // the sheet: thick at the root, thin at the tip
      if (psi < 0.0) o += vec2(t.y, -t.x) * th; // the inner surface: in from the outer, toward the tube
      o.y -= fall * H * 1.1; // the lip dropping into the bore
      vec3 d = w3Coast(cx, dC, 0.25); // the root on the water's own crest (both trains, its lean, its collapse)
      vec2 dir = gDir;
      P = vec3(cx.x + d.x, level + d.y, cx.y + d.z) + vec3(dir.x, 0.0, dir.y) * o.x + vec3(0.0, o.y, 0.0);
      vIn = 1.0; vTh = th; vPsi = vec2(psi, abs(psi));
      vLip = vec4(u, stage, show * (1.0 - 0.75 * fall), psi < 0.0 ? 1.0 : 0.0);
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
in vec3 vW; in vec4 vLip; in float vIn, vTh; in vec2 vPsi; out vec4 oColor;
const float W_N = 1.333;
float wFresnel(float ci) {
  ci = clamp(ci, 0.0, 1.0); float st2 = (1.0 - ci * ci) / (W_N * W_N); if (st2 >= 1.0) return 1.0;
  float ct = sqrt(1.0 - st2), rs = (ci - W_N * ct) / (ci + W_N * ct), rp = (W_N * ci - ct) / (W_N * ci + ct);
  return 0.5 * (rs * rs + rp * rp);
}
// the water's own material (water3/surface.js): its absorption and scattering (the colour preset and clarity), the sky
// by exact Fresnel, the sun's highlight, the light through a thin sheet; what lies behind the lip (the wave's face, the
// water drawn before it) shows through it by how much the sheet lets through (its thickness: thick at the root, thin
// at the tip), tinted as the water tints it
void main() {
  #include <logdepthbuf_fragment>
  // only triangles wholly of the lip are drawn: one joining it to a vertex left under the water would be a curtain, and
  // one across the half-wave seam (one crest's tip to the next one's: the phase jumping from pi to -pi, so the
  // interpolated |phase| and the interpolated phase disagree) would join two lips; thrown away, pixel by pixel
  if (vLip.z < 0.002 || vIn < 0.999 || vPsi.y - abs(vPsi.x) > 1.0) discard;
  if (uDebug > 8.5 && uDebug < 9.5) { vec3 nn = normalize(cross(dFdx(vW), dFdy(vW))); oColor = vec4(mix(vec3(1.0, 0.08, 0.06), vec3(0.55, 0.0, 0.1), vLip.w) * (0.5 + 0.5 * abs(nn.y)) * (uSkyUp * 0.6 + uSunColor * max(uSun.y, 0.0) * 0.4) * 3.0, 1.0); return; } // debug 9: the curl, solid red
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW))); vec3 V = normalize(cameraPosition - vW); if (dot(n, V) < 0.0) n = -n;
  float sunUp = max(uSun.y, 0.0);
  vec3 ext = uAbs / max(uLook.x, 0.05) + uSca;
  float thick = max(vTh, 0.02) / max(abs(dot(n, V)), 0.25);  // metres of water the view crosses (each of the two surfaces carries the sheet's)
  vec3 Tw = exp(-ext * thick);
  vec3 amb = uSkyUp / 3.14159 * 0.8 + uSunColor * sunUp / 3.14159 * 0.6;
  vec3 body = uSca / ext * (1.0 - Tw) * amb * 1.6 + vec3(0.02, 0.12, 0.09) * amb; // the lip's green, stronger than the open water's
  // light through it from the sun's side (the crest glow, the panel's)
  float through = pow(max(dot(-V, uSun), 0.0), 2.0);
  body += vec3(0.04, 0.42, 0.3) * (uSunColor * sunUp * 0.5 + uSkyUp * 0.35) * (0.25 + 0.75 * through) * (uLook.w / 1.6) * (0.3 + 0.7 * vLip.x) * 0.6;
  vec3 R = reflect(-V, n); R.y = abs(R.y);
  float F = wFresnel(max(dot(n, V), 0.0));
  vec3 refl = texture(uSkyView, skyUV(R, uSun)).rgb;
  vec3 Hh = normalize(V + uSun); float rough = 0.04 + uLook.y;
  float spec = pow(max(dot(n, Hh), 0.0), 2.0 / (rough * rough) - 2.0) * (1.0 / (3.14159 * rough * rough)) * 0.25 * wFresnel(dot(V, Hh)) * step(0.0, uSun.y);
  vec3 c = body * (1.0 - F) + refl * F + uSunColor * spec;
  float pass_ = dot(Tw, vec3(0.2126, 0.7152, 0.0722)) * (1.0 - F); // what of the background still shows through
  // the tip tearing into white at a full curl
  float tear = smoothstep(0.7, 1.0, vLip.x) * smoothstep(0.2, 0.7, vLip.y); // the spray line along the lip as it comes down
  float lace = texture(tFoam, vW.xz / 1.3 + vec2(0.0, vW.y)).r;
  float white = smoothstep(1.0 - 0.8 * tear, 1.1 - 0.8 * tear, lace + 0.1) * tear;
  c = mix(c, (uSkyUp * 0.8 + uSunColor * sunUp * 0.5) * 0.95, white);
  float a = max(1.0 - pass_ * (1.0 - white), 0.4) * vLip.z; // never wholly see-through: it reads
  oColor = vec4(c * a, a);
}`,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(surface.mesh.geometry, this.mat); // the water's own grid
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
  }
  dispose() { this.mat.dispose(); this.table.dispose(); }
}
