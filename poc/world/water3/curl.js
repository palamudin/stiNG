// Water 3: the breaking wave's curl, a mesh of its own over the water. A heightfield cannot overhang, so the lip is a
// second surface: the same camera-centred grid as the water, each vertex mapped onto the lip of the surf crest nearest
// it (the first train's crest: water3/swash.js), in the shape a table gives for the breaker's stage.
//
// The table (computed once): for each stage of a breaker, from a lean (the crest just pitching forward) through the
// thrown lip to the full curl coming back under itself, the lip's cross-section from its root (the crest's top) to its
// tip, as (forward, up) in units of the wave's height.
//
// Per vertex: the main train's phase there gives the crest nearest it (a quarter-wave ahead or behind) and where along
// the lip it falls: the vertices just behind a crest (on its back, phase 0 to 0.9 rad) are drawn up into that crest's
// lip, root to tip; those ahead of it gather at the root (no area); the rest of the cycle sits under the water. The
// stage is the breaker's own: the wave's height against the depth under its crest, so a stretch of crest over
// shallower sand curls first and the curl runs along it (a peel), and the lip shrinks back into the bore as the wave
// runs out of depth. A bigger wave: a bigger lip. The panel's 'Curl' scales it.
import * as THREE from 'three';
import { NOISE_GLSL } from '../noise.js';
import { SHORE } from '../shorefield.js';
import { SWASH_GLSL, SURF_GLSL } from './swash.js';
import { SKY_GLSL } from '../sky.js';

export const CURL = { stages: 32, samples: 32, lipWidth: 0.9 };

// the lip's cross-section at stage s (0..1), at u (0 root .. 1 tip): an arc whose length grows with the stage and
// whose turn grows to a little past half a circle, thrown forward as it goes
function profile(s, u) {
  const len = 0.35 + 1.0 * s, turn = 0.15 + 3.15 * s * s;   // arc length (heights) and the angle it turns through
  const R = len / turn, th = u * turn;
  let x = R * Math.sin(th), y = -R * (1 - Math.cos(th));
  x += 0.35 * s * u; y -= 0.12 * s * u;                     // thrown forward, drooping
  return [x, y];
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
      uSkyView: world.sky.uniforms.uSkyView, uMS: world.sky.uniforms.uMS, uHaze: world.sky.uniforms.uHaze, uAbs: world.uAbs, uSca: world.uSca, uLook: world.uLook, uLook2: world.uLook2,
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
out vec3 vW; out vec3 vLip; // (u along the lip, stage, how much of it is shown)
// the table, bilinear by hand
vec2 curlAt(float u, float s) {
  vec2 g = vec2(u * ${(C.samples - 1).toFixed(1)}, s * ${(C.stages - 1).toFixed(1)}); vec2 i0 = floor(g), f = g - i0; ivec2 i = ivec2(i0), j = min(i + 1, ivec2(${C.samples - 1}, ${C.stages - 1}));
  vec2 a = texelFetch(tCurl, i, 0).xy, b = texelFetch(tCurl, ivec2(j.x, i.y), 0).xy, c = texelFetch(tCurl, ivec2(i.x, j.y), 0).xy, d = texelFetch(tCurl, j, 0).xy;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vLip = vec3(0.0);
  vec2 xz = uCam.xz + position.xz * uGridScale;
  float level = clipWater(xz);
  vec3 P = vec3(xz.x, level - 0.4, xz.y); // under the water: no lip here
  if (position.y < 0.5 && distance(xz, uCam.xz) < 220.0 && level <= uSeaLevel + 0.5 && uSurf.x > 0.0 && uLook3.w > 0.0 && sw3Ctx(xz)) {
    float depth = level - clipHeight(xz);
    float cel = sqrt(9.81 * clamp(depth, ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)})), w = sw3Omega(0), k = w / cel;
    float ph = sw3Phase(0, uWTime, gTau, gPn), psi = mod(ph + 3.14159265, 6.2831853) - 3.14159265;
    if (psi > -1.2 && psi < ${(C.lipWidth + 0.7).toFixed(2)}) {
      // the crest nearest: psi / k metres shoreward (psi > 0 is behind the crest); its breaker there
      vec2 cx = xz + gDir * (psi / k);
      float dC = max(level - clipHeight(cx), 0.02);
      float shoal = pow(clamp(max(dC, 0.6) / ${SHORE.dMax.toFixed(1)}, 0.04, 1.0), -0.25);
      float a0 = uSurf.x * gNear * gExpo * shoal * sw3Group(cx, uWTime), a = min(a0, 0.42 * dC + 0.02), rel = a0 / dC;
      float cyc = floor((ph + 3.14159265) / 6.2831853), early = 0.5 + 0.5 * w2noise(cx / 33.0 + vec2(cyc * 7.3, cyc * 3.1), 614);
      float lo = 0.12 + 0.14 * early, hi = 0.3 + 0.2 * early;
      float stage = clamp(smoothstep(lo, hi + 0.15, rel) * uLook3.w, 0.0, 1.0);
      float show = smoothstep(lo, lo + 0.08, rel) * (1.0 - smoothstep(hi + 0.2, hi + 0.45, rel)) * smoothstep(0.03, 0.2, a0) * smoothstep(0.1, 0.35, dC);
      if (show > 0.002 && psi < ${(C.lipWidth + 0.3).toFixed(2)}) {
        float u = clamp(psi / ${C.lipWidth.toFixed(2)}, 0.0, 1.0);
        float H = 1.2 * a * show;
        vec2 o = curlAt(u, stage) * H, dir = gDir;
        // the root on the water's own crest: the surface's displacement there (both trains, the lean forward before
        // the collapse, the Gerstner shift: water3/swash.js w3Coast), so the lip grows out of the wave the water draws
        vec3 top = vec3(cx.x, level + 1.1 * a, cx.y);
        if (sw3Ctx(cx)) { vec3 d = w3Coast(cx, dC, 0.25); top = vec3(cx.x + d.x, level + d.y, cx.y + d.z); }
        P = top + vec3(dir.x, 0.0, dir.y) * o.x + vec3(0.0, o.y, 0.0);
        vLip = vec3(u, stage, show);
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
uniform vec3 uSun, uSunColor, uSkyUp, uAbs, uSca; uniform vec4 uLook, uLook2; uniform sampler2D tFoam, uSkyView;
in vec3 vW; in vec3 vLip; out vec4 oColor;
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
  if (vLip.z < 0.002) discard;
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW))); vec3 V = normalize(cameraPosition - vW); if (dot(n, V) < 0.0) n = -n;
  float sunUp = max(uSun.y, 0.0);
  vec3 ext = uAbs / max(uLook.x, 0.05) + uSca;
  float thick = mix(0.35, 0.04, vLip.x) / max(abs(dot(n, V)), 0.25);  // metres of water the view crosses
  vec3 Tw = exp(-ext * thick);
  vec3 amb = uSkyUp / 3.14159 * 0.8 + uSunColor * sunUp / 3.14159 * 0.6;
  vec3 body = uSca / ext * (1.0 - Tw) * amb;
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
  float tear = smoothstep(0.55, 1.0, vLip.x) * smoothstep(0.35, 0.9, vLip.y);
  float lace = texture(tFoam, vW.xz / 1.3 + vec2(0.0, vW.y)).r;
  float white = smoothstep(1.0 - 0.8 * tear, 1.1 - 0.8 * tear, lace + 0.1) * tear;
  c = mix(c, (uSkyUp * 0.8 + uSunColor * sunUp * 0.5) * 0.95, white);
  float a = (1.0 - pass_ * (1.0 - white)) * vLip.z * smoothstep(0.0, 0.08, vLip.x);
  oColor = vec4(c * a, a);
}`,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(surface.mesh.geometry, this.mat); // the water's own grid
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
  }
  dispose() { this.mat.dispose(); this.table.dispose(); }
}
