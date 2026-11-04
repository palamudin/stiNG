// The frame after the scene: everything here reads the scene's colour and depth and is written by hand (no addons).
//
//   scene (HDR half float, MSAA, depth texture)
//   -> composite: sky where nothing was drawn, the water surface where the view ray meets it first (water.js: the
//      sea of the source and the water bodies the game has, from the wave field of wavegpu.js),
//      aerial perspective and low mist on everything by its distance, from the same atmosphere as the sky (sky.js).
//      Alpha carries the distance along the ray, for the depth of field.
//   -> god rays: the sun's light through gaps, a radial blur of the sky near the sun (quarter resolution)
//   -> depth of field: a thin lens (focal length, f-number, sensor), so a subject 20 cm away blurs the background the
//      way a macro lens does and a landscape stays sharp, with nothing faked per scale. Gather in one pass at half
//      resolution (Gustafsson 2018, golden-angle spiral, scatter-as-gather weights).
//   -> bloom: a six-level mip chain blended in at a small fraction, no threshold (energy kept)
//   -> final: exposure, AgX, a light grade, vignette, grain, sRGB out.
import * as THREE from 'three';
import { SKY_GLSL } from './sky.js';
import { waterGLSL, WATER_SHADE_GLSL, WATER } from './water.js';
import { SHORE_WAVE_GLSL } from './shorefield.js';
import { NOISE_GLSL } from './noise.js';
import { MAP_GLSL } from './map.js';

const VS = 'out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

function pass(frag, uniforms) {
  return new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms, vertexShader: VS, fragmentShader: 'precision highp float; precision highp int;\nin vec2 vUv; out vec4 oColor;\n' + frag, depthTest: false, depthWrite: false });
}
function target(w, h, o = {}) {
  return new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, ...o });
}

const NOTIMER = { begin() {}, end() {} };
export class Post {
  constructor(renderer, sky, opts = {}) {
    this.renderer = renderer; this.sky = sky;
    this.msaa = opts.msaa ?? 4;
    this.scaleRes = opts.scale ?? 1;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad); this.cam = new THREE.Camera();
    const U = this.U = {
      tColor: { value: null }, tDepth: { value: null }, tPrev: { value: null }, tBlur: { value: null }, tRays: { value: null }, tBloom: { value: null },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uViewProj: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uLogF: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
      uSea: { value: 0 }, uDebug: { value: 0 }, uMist: { value: 0.0025 }, uMistH: { value: 45 }, uWet: { value: 0 }, uRain: { value: 0 }, uWaterOn: { value: 1 }, uShoreWave: { value: new THREE.Vector4(0, 8, 0, 8) }, uShoreSea: { value: 0 }, uSwellDir: { value: new THREE.Vector2(0.8, 0.6) },
      uSkyUp: { value: new THREE.Color() }, uSkyHz: { value: new THREE.Color() },
      uSunUV: { value: new THREE.Vector2() }, uSunVis: { value: 0 }, uRays: { value: 0.6 },
      uFocus: { value: 10 }, uFocal: { value: 0.045 }, uFstop: { value: 2.8 }, uSensor: { value: 0.024 }, uMaxCoc: { value: 14 }, uBlurIn: { value: 0 },
      uExposure: { value: 1 }, uSat: { value: 1.3 }, uPower: { value: 1.25 }, uVignette: { value: 0.22 }, uGrain: { value: 0.025 }, uBloom: { value: 0.045 },
      uTexel: { value: new THREE.Vector2() }, uBloomMax: { value: 1e4 }, uWind: { value: new THREE.Vector2(0.8, 0.3) },
      uWL: { value: new THREE.Vector4(1, 1, 1, 1) }, uWLost: { value: 0 }, uWPeak: { value: 0.05 }, uGlint: { value: WATER.glint },
      uBody: { value: Array.from({ length: WATER.bodies }, () => new THREE.Vector4()) }, uBodyB: { value: Array.from({ length: WATER.bodies }, () => new THREE.Vector4()) }, uBodyC: { value: Array.from({ length: WATER.bodies }, () => new THREE.Vector4()) }, uBodies: { value: 0 },
      tCaus: { value: null }, uCaus: { value: new THREE.Vector4(0, 0, 1, 0) },
      tCloud: { value: null }, uCloudOn: { value: 0 }, uCloudBase: { value: 1000 }, uIce: { value: 0 }, uFlash: { value: 0 },
      uMap: { value: 0 }, uSnowLine: { value: 1e9 },
      ...sky.uniforms,
    };
    // ---- composite (rebuilt when the wave field's cascades change: setWater)
    this.C = 0; this.composite = this._composite(0);
    // ---- god rays (quarter): a mask of the sky near the sun, blurred toward the sun's place on screen
    this.raysMask = pass(`${SKY_GLSL}
uniform sampler2D tDepth; uniform mat4 uInvProj, uCamWorld; uniform vec3 uSun, uSunColor;
vec3 viewRay(vec2 uv) { vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0); p.xyz /= p.w; return normalize((uCamWorld * vec4(p.xyz, 0.0)).xyz); }
void main() {
  float d = texture(tDepth, vUv).r; vec3 v = viewRay(vUv);
  float c = max(dot(v, uSun), 0.0);
  float m = d >= 1.0 ? pow(c, 380.0) * 2.0 + pow(c, 24.0) * 0.12 : 0.0;
  oColor = vec4(uSunColor * m * 0.05, 1.0);
}`, U);
    this.raysBlur = pass(`uniform sampler2D tColor; uniform vec2 uSunUV; uniform float uSunVis;
void main() {
  vec2 d = (vUv - uSunUV) / 48.0 * 0.95; vec2 p = vUv; vec3 s = vec3(0.0); float w = 1.0;
  for (int i = 0; i < 48; i++) { s += texture(tColor, p).rgb * w; w *= 0.965; p -= d; }
  oColor = vec4(s / 20.0 * uSunVis, 1.0);
}`, U);
    // ---- depth of field
    this.cocPass = pass(`uniform sampler2D tColor; uniform float uFocus, uFocal, uFstop, uSensor, uMaxCoc, uBlurIn; uniform vec2 uRes;
// circle of confusion in half-res pixels from the thin lens: c = f^2 / (N (s - f)) * |d - s| / d
float coc(float d) {
  float s = max(uFocus, uFocal * 1.05); float c = uFocal * uFocal / (uFstop * (s - uFocal)) * (d - s) / max(d, 1e-4);
  return clamp(c / uSensor * uRes.y * 0.5, -uMaxCoc, uMaxCoc) + sign(d - s + 1e-6) * uBlurIn;
}
void main() { vec4 c = texture(tColor, vUv); oColor = vec4(c.rgb, coc(c.a)); }`, U);
    this.dofPass = pass(`uniform sampler2D tColor; uniform vec2 uTexel; uniform float uMaxCoc;
const float GA = 2.39996323;
void main() {
  vec4 c0 = texture(tColor, vUv); float cs = abs(c0.a);
  vec3 col = c0.rgb; float tot = 1.0; float rad = 0.6;
  for (float a = 0.0; rad < uMaxCoc; a += GA) {
    vec4 s = texture(tColor, vUv + vec2(cos(a), sin(a)) * uTexel * rad);
    float ss = abs(s.a);
    if (s.a > c0.a) ss = clamp(ss, 0.0, cs * 2.0); // farther than us: cannot spill over a sharper foreground
    float m = smoothstep(rad - 0.5, rad + 0.5, ss);
    col += mix(col / tot, s.rgb, m); tot += 1.0; rad += 0.9 / rad;
  }
  oColor = vec4(col / tot, c0.a);
}`, U);
    this.dofMix = pass(`uniform sampler2D tColor, tBlur;
void main() { vec4 a = texture(tColor, vUv); vec4 b = texture(tBlur, vUv); float k = smoothstep(0.4, 1.4, abs(b.a)); oColor = vec4(mix(a.rgb, b.rgb, k), a.a); }`, U);
    // ---- bloom: 13-tap downsample and tent upsample (Jimenez 2014)
    this.down = pass(`uniform sampler2D tColor; uniform vec2 uTexel; uniform float uBloomMax;
vec3 tc(vec2 p) { return min(texture(tColor, p).rgb, vec3(uBloomMax)); }
#define texture(s, p) vec4(tc(p), 1.0)
void main() { vec2 t = uTexel; vec3 a = texture(tColor, vUv + t * vec2(-2, 2)).rgb, b = texture(tColor, vUv + t * vec2(0, 2)).rgb, c = texture(tColor, vUv + t * vec2(2, 2)).rgb;
  vec3 d = texture(tColor, vUv + t * vec2(-2, 0)).rgb, e = texture(tColor, vUv).rgb, f = texture(tColor, vUv + t * vec2(2, 0)).rgb;
  vec3 g = texture(tColor, vUv + t * vec2(-2, -2)).rgb, h = texture(tColor, vUv + t * vec2(0, -2)).rgb, i = texture(tColor, vUv + t * vec2(2, -2)).rgb;
  vec3 j = texture(tColor, vUv + t * vec2(-1, 1)).rgb, k = texture(tColor, vUv + t * vec2(1, 1)).rgb, l = texture(tColor, vUv + t * vec2(-1, -1)).rgb, m = texture(tColor, vUv + t * vec2(1, -1)).rgb;
  vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  oColor = vec4(min(o, vec3(6e4)), 1.0); }`, U);
    this.up = pass(`uniform sampler2D tColor, tPrev; uniform vec2 uTexel;
void main() { vec2 t = uTexel; vec3 s = texture(tColor, vUv).rgb * 4.0;
  s += (texture(tColor, vUv + vec2(t.x, 0)).rgb + texture(tColor, vUv - vec2(t.x, 0)).rgb + texture(tColor, vUv + vec2(0, t.y)).rgb + texture(tColor, vUv - vec2(0, t.y)).rgb) * 2.0;
  s += texture(tColor, vUv + t).rgb + texture(tColor, vUv - t).rgb + texture(tColor, vUv + vec2(t.x, -t.y)).rgb + texture(tColor, vUv + vec2(-t.x, t.y)).rgb;
  oColor = vec4(s / 16.0 + texture(tPrev, vUv).rgb, 1.0); }`, U);
    // ---- final
    this.final = pass(`uniform sampler2D tColor, tRays, tBloom; uniform float uExposure, uSat, uPower, uVignette, uGrain, uBloom, uTime; uniform vec2 uRes;
vec3 agx(vec3 c) {
  const mat3 i = mat3(0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859);
  const mat3 o = mat3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
  c = i * c; c = clamp((log2(max(c, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
  vec3 x2 = c * c, x4 = x2 * x2; c = 15.5 * x4 * x2 - 40.14 * x4 * c + 31.96 * x4 - 6.868 * x2 * c + 0.4298 * x2 + 0.1191 * c - 0.00232;
  // the look (ASC CDL in AgX's log space, as Blender's looks do): power for contrast, then saturation
  c = pow(max(c, 0.0), vec3(uPower));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = l + uSat * (c - l);
  return pow(max(o * c, 0.0), vec3(2.2));
}
float h12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture(tColor, vUv).rgb;
  c = mix(c, texture(tBloom, vUv).rgb / 6.0, uBloom) + texture(tRays, vUv).rgb;
  c = agx(c * uExposure);
  c = max(c, 0.0);
  vec2 q = vUv - 0.5; c *= 1.0 - uVignette * dot(q, q) * 2.2;
  c = pow(c, vec3(1.0 / 2.2)); // sRGB out (gamma 2.2 to match AgX's own encoding)
  c += (h12(vUv * uRes + fract(uTime) * 91.7) - 0.5) * uGrain + (h12(vUv * uRes + 7.1) - 0.5) / 255.0;
  oColor = vec4(c, 1.0);
}`, U);
    this.size = new THREE.Vector2();
    this._alloc(1, 1);
  }
  // the map pass: the finished (sRGB) frame, blended into a map drawn from the clipmap (map.js)
  _mapPass() {
    return pass(`${NOISE_GLSL}\n${this.clipGLSL}\n${MAP_GLSL}
void main() {
  vec3 photo = texture(tColor, vUv).rgb;
  vec4 m = mapColor(vUv);
  // the map's colours are linear: to sRGB like the frame, then blended in by how far into the map we are
  vec3 ms = pow(max(m.rgb, 0.0), vec3(1.0 / 2.2));
  oColor = vec4(mix(photo, ms, uMap * m.a), 1.0);
}`, this.U);
  }
  _composite(C) {
    return pass(`${SKY_GLSL}\n${NOISE_GLSL}\n${this.clipGLSL ? this.clipGLSL + '\n#define W_CLIP' : ''}\n${C && this.shoreGLSL ? this.shoreGLSL + '\n#define W_SHORE' : ''}\n#define W_CASCADES ${C}\n${C ? waterGLSL(C) : ''}
uniform sampler2D tColor, tDepth, uSkyView; uniform mat4 uInvProj, uCamWorld, uViewProj; uniform vec3 uCamPos, uSun, uSunColor, uSkyUp, uSkyHz;
uniform float uLogF, uSea, uMist, uMistH, uTime, uWet, uRain, uWaterOn, uDebug, uCloudOn, uCloudBase, uFlash; uniform vec2 uRes; uniform sampler2D tCloud;
#if W_CASCADES == 0
uniform float uIce;
#endif
#define WATER_DEBUG
vec3 viewRay(vec2 uv) { vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0); p.xyz /= p.w; return normalize((uCamWorld * vec4(p.xyz, 0.0)).xyz); }
vec3 viewRayZ(vec2 uv) { vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0); p.xyz /= p.w; return p.xyz / -p.z; }
// the log depth buffer back to distance along the ray
float rayDist(vec2 uv, float d) { float w = exp2(d * uLogF) - 1.0; return w * length(viewRayZ(uv)); }
vec3 skyAt(vec3 v) { return texture(uSkyView, skyUV(v, uSun)).rgb; }
vec3 sunDisc(vec3 v) {
  float c = dot(v, uSun), r = ${(0.5 * 0.00935).toFixed(6)};
  float a = acos(clamp(c, -1.0, 1.0)); if (a > r * 1.6) return vec3(0.0);
  float mu = sqrt(max(0.0, 1.0 - (a / r) * (a / r))); float limb = 1.0 - 0.6 * (1.0 - pow(mu, 0.5)); // limb darkening
  return uSunColor * limb * smoothstep(r * 1.05, r * 0.95, a) / (3.14159 * r * r) * 0.6;
}
// aerial perspective: analytic optical depth of exponential air (Rayleigh, Mie) and the mist along the segment
vec3 airT(float d, vec3 v, out vec3 inscatter) {
  float h0 = max(uCamPos.y, 0.0), vy = v.y; vec3 ray = A_RAY; float mie = A_MIEX * uHaze;
  float k = abs(vy) < 1e-4 ? d : 0.0;
  float odR = abs(vy) < 1e-4 ? exp(-h0 / A_RAYH) * d : A_RAYH / vy * (exp(-h0 / A_RAYH) - exp(-(h0 + d * vy) / A_RAYH));
  float odM = abs(vy) < 1e-4 ? exp(-h0 / A_MIEH) * d : A_MIEH / vy * (exp(-h0 / A_MIEH) - exp(-(h0 + d * vy) / A_MIEH));
  float hm0 = max(uCamPos.y - uSea, 0.0);
  float odF = abs(vy) < 1e-4 ? exp(-hm0 / uMistH) * d : uMistH / vy * (exp(-hm0 / uMistH) - exp(-(hm0 + d * vy) / uMistH));
  vec3 od = ray * odR + vec3(mie * odM) + vec3(uMist * odF);
  vec3 T = exp(-od);
  vec3 vh = normalize(vec3(v.x, max(v.y, 0.035), v.z));
  float c = dot(v, uSun);
  vec3 mistLight = uSkyHz * 0.9 + uSunColor * aPhaseM(c) * 1.6;
  float fm = uMist * odF / max(od.g, 1e-6);
  inscatter = (1.0 - T) * mix(skyAt(vh), mistLight, clamp(fm, 0.0, 1.0));
  return T;
}
${C ? WATER_SHADE_GLSL : ''}
void main() {
  vec2 uv = vUv; vec3 v = viewRay(uv);
  float d0 = texture(tDepth, uv).r;
  vec3 col = texture(tColor, uv).rgb;
  float dist = d0 >= 1.0 ? 1e9 : rayDist(uv, d0);
  if (d0 >= 1.0) col = skyAt(v) + sunDisc(v) + uFlash * uSkyUp * 4.0; // lightning: the whole sky lights
  float outDist = dist; bool wet = false;
#if W_CASCADES > 0
  // the nearest water: the sea (iterated onto its waves), then the bodies (discs on the ground's plane)
  float tw = 1e10, kind = -1.0; vec2 x0 = vec2(0.0), gx = vec2(0.0), gy = vec2(0.0); vec4 bA = vec4(0.0), bB = vec4(0.0), bC = vec4(0.0);
  // the open water (W3): the level is the sea, or a lake's own, read at the point the ray reaches; the ray crossed a
  // surface at that level only if the point lies under it (a straight ray down cannot cross a flat lake and come back
  // out), and a ray that reaches the sky crosses the sea's plane
  float yb = -1e9;
  if (uWaterOn > 0.5) {
    if (d0 >= 1.0) yb = uSea;
#ifdef W_CLIP
    else { vec3 Pg = uCamPos + v * dist; float Wg = clipWater(Pg.xz); if (Pg.y < Wg - 0.002) yb = Wg; }
#else
    else yb = uSea;
#endif
  }
  if (yb > -1e8 && v.y < 0.0 && uCamPos.y > yb) { tw = wSeaHit(uv, v, yb, x0, gx, gy); kind = 0.0; }
  for (int i = 0; i < ${WATER.bodies}; i++) {
    if (i >= uBodies) break;
    vec4 b = uBody[i], c2 = uBodyB[i]; vec3 c = vec3(b.x, b.w, b.y); vec3 n = vec3(-c2.x, 1.0, -c2.y);
    float den = dot(v, n); if (den >= 0.0 || dot(uCamPos - c, n) <= 0.0) continue; // only from above
    float t = dot(c - uCamPos, n) / den; if (t <= 0.0 || t >= tw) continue;
    vec3 q = uCamPos + v * t; if (length(q.xz - c.xz) > wBodyR(b, uBodyC[i], q.xz - c.xz)) continue;
    tw = t; kind = c2.w; bA = b; bB = c2; bC = uBodyC[i];
  }
#if defined(W_SHORE) && SHORE_BEACH
  // the swash sheet (shorefield.js shoreSheet): a sand pixel the run-up stands over is water a few centimetres deep
  if (kind < 0.0 && d0 < 1.0 && uWaterOn > 0.5) {
    vec3 Pg = uCamPos + v * dist; float Wg = clipWater(Pg.xz);
    // the sand's height from the clipmap (exact and smooth), not from the depth buffer's reconstruction, whose steps
    // of a fraction of a millimetre would draw contour lines in a sheet a few centimetres thick
    float hgt = clipHeight(Pg.xz) - Wg;
    // only the ground itself takes a sheet: a pixel standing above the clipmap's ground is a rock, a tree, a person
    if (hgt >= -0.002 && hgt < 5.0 && abs(Pg.y - Wg - hgt) < 0.04) {
      vec4 shg = shoreAt(Pg.xz);
      if (shg.x < 40.0) {
        vec3 nG = clipNormal(Pg.xz);
        gSheet = shoreSheet(Pg.xz, shg, hgt, nG, uTime, shoreState(Wg));
        if (gSheet.x > 0.0005) {
          vec3 P = vec3(Pg.x, Wg + hgt + gSheet.x, Pg.z); vec2 gG = vec2(-nG.x, -nG.z) / max(nG.y, 0.2);
          gx = wPlaneHit(uv + vec2(1.0 / uRes.x, 0.0), P, gG).xz - P.xz; gy = wPlaneHit(uv + vec2(0.0, 1.0 / uRes.y), P, gG).xz - P.xz;
          wShallow(gSheet.x); gDampSea = wDamp;
          col = waterShade(uv, v, P, P.xz, gG, gx, gy, dist, col, 3.0, 0.0, vec3(0.0), 0.0);
          outDist = dist; wet = true;
        }
      }
    }
  }
#endif
  if (kind >= 0.0 && tw < dist) {
    vec3 P = uCamPos + v * tw;
    if (kind == 0.0) col = waterShade(uv, v, P, x0, vec2(0.0), gx, gy, dist, col, 0.0, 0.0, vec3(0.0), 1.0);
    else {
      vec3 c = vec3(bA.x, bA.w, bA.y);
      gx = wPlaneHit(uv + vec2(1.0 / uRes.x, 0.0), c, bB.xy).xz - P.xz; gy = wPlaneHit(uv + vec2(0.0, 1.0 / uRes.y), c, bB.xy).xz - P.xz;
      // a pond's edge at this bearing: its bowl runs out there, and the last 30 cm are shallow enough to show the bank
      float eR = wBodyR(bA, bC, P.xz - c.xz), eD = eR - length(P.xz - c.xz); vec3 bank = col;
      col = waterShade(uv, v, P, P.xz, bB.xy, gx, gy, dist, col, kind, bB.z, c, bC.z > 0.5 ? eR : bA.z);
      if (bC.z > 0.5) col = mix(bank, col, smoothstep(0.0, 0.3, eD));
    }
    outDist = tw; wet = true;
  }
#endif
  if (d0 < 1.0 || wet) { vec3 ins; vec3 T = airT(min(outDist, 2e5), v, ins); col = col * T + ins; }
  // the clouds (clouds.js, quarter resolution): behind anything nearer than where the ray enters their slab
  if (uCloudOn > 0.5) {
    float te = abs(v.y) < 1e-4 ? 1e9 : (uCloudBase - uCamPos.y) / v.y;
    if (uCamPos.y > uCloudBase) te = 0.0;
    if (te > 0.0 && te < outDist) {
      vec4 cl = texture(tCloud, uv);
      vec3 ins; vec3 T = airT(min(te, 2e5), v, ins); // the air between the eye and the clouds
      col = col * cl.a + (cl.rgb * T + ins * (1.0 - cl.a));
    }
  }
  if (uDebug > 0.5 && uDebug < 1.5) { vec3 Pg = uCamPos + v * dist; col = vec3(wet ? 1.0 : 0.0, Pg.y < 0.0 ? 1.0 : 0.0, d0 >= 1.0 ? 1.0 : 0.0) * 2.0; }
  // half floats end at 65504: the sun's disc is brighter than that, and an infinity here turns into NaN in the passes after;
  // and a NaN from any pixel's shading would spread over the whole frame through the depth of field's kernel (a close
  // focus blurs the far ground widely), so none leaves this pass
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  if (isnan(outDist)) outDist = dist;
  oColor = vec4(min(col, vec3(6.0e4)), min(outDist, 60000.0));
}`, this.U);
  }

  // the wave field (wavegpu.js) and the sea's caustics (caustics.js); null for none
  // clip: the clipmap (its GLSL and uniforms), so the composite can read the water level where a ray lands
  // shore: the shore table (shorefield.js: its GLSL, the shore waves' GLSL and uniforms), for breakers and shore foam
  setWater(field, caustics, clip, shore) {
    const C = field ? field.C : 0, U = this.U;
    let rebuild = false;
    if (clip && !this.clipGLSL) { this.clipGLSL = clip.glsl(); Object.assign(U, clip.uniforms); rebuild = true; }
    if (shore && !this.shoreGLSL) { this.shoreGLSL = shore.glsl() + '\n' + (shore.compositeGLSL || '') + '\n' + SHORE_WAVE_GLSL; Object.assign(U, shore.uniforms); rebuild = true; }
    if (rebuild) { this.composite.dispose(); this.composite = this._composite(C); this.C = C; this.mapPass = this._mapPass(); }
    else if (C !== this.C) { this.composite.dispose(); this.C = C; this.composite = this._composite(C); }
    if (field) {
      U.uWL.value = field.U.uL.value;
      for (let c = 0; c < C; c++) { U['tWD' + c] = { value: field.disp[c].texture }; U['tWS' + c] = { value: field.slope[c].texture }; }
      this.composite.uniforms = U;
    }
    U.tCaus.value = caustics ? caustics.rt.texture : null;
  }
  _alloc(w, h) {
    this.w = w; this.h = h;
    for (const t of [this.rtScene, this.rtA, this.rtB, this.rtHalf, this.rtHalf2, this.rtQ, this.rtQ2, ...(this.mips || [])]) t && t.dispose();
    const dt = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    this.rtScene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: this.msaa, depthTexture: dt, depthBuffer: true });
    this.rtA = target(w, h); this.rtB = target(w, h);
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1), qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.rtHalf = target(hw, hh); this.rtHalf2 = target(hw, hh);
    this.rtQ = target(qw, qh); this.rtQ2 = target(qw, qh);
    this.mips = []; let mw = hw, mh = hh;
    for (let i = 0; i < 6; i++) { this.mips.push(target(Math.max(1, mw), Math.max(1, mh))); mw >>= 1; mh >>= 1; }
    this.mipsUp = this.mips.map((m) => target(m.width, m.height));
  }
  setSize(w, h) { w = Math.max(1, Math.round(w * this.scaleRes)); h = Math.max(1, Math.round(h * this.scaleRes)); if (w !== this.w || h !== this.h) this._alloc(w, h); }
  _run(mat, out) { this.quad.material = mat; this.renderer.setRenderTarget(out); this.renderer.render(this.scene, this.cam); }

  // The samplers a pass's program actually uses, against the card's limit (16 in Chrome on Windows): counted from the
  // linked program, so a pass that silently fails on a real card for one sampler too many is caught and said. The
  // composite is the one at the limit (eight wave textures, the clipmap's two, the shore table, the sky, the clouds,
  // the caustics, colour and depth); anything new it reads must ride in a layer of a texture it already has.
  samplerCheck() {
    const r = this.renderer, gl = r.getContext(), out = {}, max = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    for (const [name, m] of [['composite', this.composite], ['dof', this.dofPass], ['final', this.final], ['map', this.mapPass]]) {
      const p = m && r.properties.get(m).currentProgram; if (!p || !p.program) continue;
      const prog = p.program, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); let count = 0;
      for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(prog, i); if (u && (u.type === gl.SAMPLER_2D || u.type === gl.SAMPLER_2D_ARRAY || u.type === gl.SAMPLER_3D || u.type === gl.SAMPLER_CUBE || u.type === gl.SAMPLER_2D_SHADOW)) count += u.size; }
      out[name] = count;
      if (count > max) console.error(`world: the ${name} pass uses ${count} samplers; this card allows ${max} per shader, so the pass fails`);
    }
    out.max = max; this.samplers = out; return out;
  }
  render(scene, camera, opts = {}) {
    const r = this.renderer, U = this.U, size = r.getDrawingBufferSize(this.size), T = opts.timer || NOTIMER;
    if (!this.samplers && this._frames > 1) this.samplerCheck(); this._frames = (this._frames || 0) + 1;
    this.setSize(size.x, size.y);
    camera.updateMatrixWorld();
    U.uInvProj.value.copy(camera.projectionMatrixInverse);
    U.uCamWorld.value.copy(camera.matrixWorld);
    U.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    U.uCamPos.value.copy(camera.position);
    U.uLogF.value = Math.log2(camera.far + 1);
    U.uRes.value.set(this.w, this.h);
    // the scene
    const prevTM = r.toneMapping; r.toneMapping = THREE.NoToneMapping;
    T.begin('scene'); r.setRenderTarget(this.rtScene); r.clear(); r.render(scene, camera); T.end();
    U.tDepth.value = this.rtScene.depthTexture;
    // the clouds at quarter resolution, before the composite blends them in
    T.begin('clouds'); if (opts.clouds) { opts.clouds.render(this.rtQ, this.rtScene.depthTexture, camera, U.uLogF.value, this.rtQ.width, this.rtQ.height, camera.position, opts.skyUp); U.tCloud.value = this.rtQ.texture; U.uCloudOn.value = 1; } else U.uCloudOn.value = 0; T.end();
    // composite
    T.begin('composite'); U.tColor.value = this.rtScene.texture; this._run(this.composite, this.rtA); T.end();
    let cur = this.rtA;
    // god rays, when the sun is in front of the camera
    const s = new THREE.Vector4(U.uSun.value.x, U.uSun.value.y, U.uSun.value.z, 0).applyMatrix4(U.uViewProj.value);
    const front = s.w > 0 && U.uSun.value.y > -0.05;
    T.begin('rays');
    if (front && opts.rays !== false) {
      U.uSunUV.value.set(s.x / s.w * 0.5 + 0.5, s.y / s.w * 0.5 + 0.5);
      const edge = Math.max(Math.abs(U.uSunUV.value.x - 0.5), Math.abs(U.uSunUV.value.y - 0.5));
      U.uSunVis.value = U.uRays.value * THREE.MathUtils.smoothstep(1.4 - edge, 0, 0.9);
      this._run(this.raysMask, this.rtQ);
      U.tColor.value = this.rtQ.texture; this._run(this.raysBlur, this.rtQ2);
      U.tRays.value = this.rtQ2.texture;
    } else { r.setRenderTarget(this.rtQ2); r.clear(); U.tRays.value = this.rtQ2.texture; }
    T.end();
    // depth of field
    T.begin('dof');
    if (opts.dof !== false) {
      U.tColor.value = cur.texture; this._run(this.cocPass, this.rtHalf);
      U.uTexel.value.set(1 / this.rtHalf.width, 1 / this.rtHalf.height);
      U.tColor.value = this.rtHalf.texture; this._run(this.dofPass, this.rtHalf2);
      U.tColor.value = cur.texture; U.tBlur.value = this.rtHalf2.texture; this._run(this.dofMix, this.rtB);
      cur = this.rtB;
    }
    T.end();
    // bloom
    T.begin('bloom');
    let src = cur;
    U.uBloomMax.value = 24 / Math.max(U.uExposure.value, 1e-3); // about 24x display white, in scene units
    for (let i = 0; i < this.mips.length; i++) { U.uTexel.value.set(1 / src.width, 1 / src.height); U.tColor.value = src.texture; this._run(this.down, this.mips[i]); src = this.mips[i]; }
    let up = this.mips[this.mips.length - 1];
    for (let i = this.mips.length - 2; i >= 0; i--) { U.uTexel.value.set(1 / up.width, 1 / up.height); U.tColor.value = up.texture; U.tPrev.value = this.mips[i].texture; this._run(this.up, this.mipsUp[i]); up = this.mipsUp[i]; }
    U.tBloom.value = up.texture;
    T.end();
    // out: to the screen, or through the map pass when the view is turning into a map (map.js)
    const toMap = this.mapPass && U.uMap.value > 0.001;
    U.tColor.value = cur.texture;
    T.begin('final'); this._run(this.final, toMap ? this.rtB : null);
    if (toMap) { U.tColor.value = this.rtB.texture; this._run(this.mapPass, null); }
    T.end();
    r.toneMapping = prevTM;
  }
}
