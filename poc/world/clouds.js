// Clouds (W3): a slab of cloud between two heights, marched per pixel at quarter resolution. The density is a 2D
// coverage field (the weather's cover, in patches that drift with the wind) eroded by 3D noise, and the noise is read
// at points snapped to 24 m cells, so the clouds come out as soft blocks (the Minecraft idea in the sky: flat-faced
// masses, not wisps). Light: Beer-Lambert extinction toward the sun over two samples, a two-lobe Henyey-Greenstein
// phase so the sun's side glows and the far side rims, a "powder" term so the thick middle is darker than the edges,
// and the sky's light from above. A second pass draws the clouds' shadow on the ground: the sun's transmittance
// through the column over each point, into a 512 x 512 map round the camera that the ground, grass, trees and water
// read (uCloudShadow, uCloudRect). Both passes are plain full-screen shaders; the composite blends the clouds behind
// anything nearer than the slab (post.js).
import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

export const CLOUDS = { base: 1000, top: 1650, cell: 24, steps: 28, shadowRes: 512, shadowSpan: 14000 };

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
export const CLOUD_GLSL = /* glsl */ `
uniform float uCover, uCloudDens, uCloudT; uniform vec2 uCloudDrift; // cover 0..1, density, time, drift (m)
const float C_BASE = ${f(CLOUDS.base)}, C_TOP = ${f(CLOUDS.top)}, C_CELL = ${f(CLOUDS.cell)};
// 3D value noise from the 2D hash (the z slice mixes two seeds), read at snapped points for the blocky look
float cNoise3(vec3 p, int s) {
  vec3 i = floor(p); vec3 fr = p - i; fr = fr * fr * (3.0 - 2.0 * fr);
  int z0 = int(i.z), z1 = z0 + 1;
  float a = w2noise(i.xy + fr.xy, s + z0 * 7), b = w2noise(i.xy + fr.xy, s + z1 * 7);
  return mix(a, b, fr.z);
}
// coverage at a place: patches 3 km across, with the weather's cover; 1 is solid
float cloudCov(vec2 xz) {
  vec2 p = xz + uCloudDrift;
  float c = 0.55 * w2noise(p / 3000.0, 301) + 0.3 * w2noise(p / 1100.0 + 3.1, 302) + 0.15 * w2noise(p / 400.0 - 1.7, 303);
  return c * 0.5 + 0.5 + (uCover - 0.5) * 1.25;
}
// density at a point of the slab: the coverage less a height profile, eroded by blocky 3D noise
float cloudDens(vec3 p, bool detail) {
  float hN = clamp((p.y - C_BASE) / (C_TOP - C_BASE), 0.0, 1.0);
  float prof = smoothstep(0.0, 0.12, hN) * (1.0 - smoothstep(0.45, 1.0, hN));
  vec3 q = floor((p + vec3(uCloudDrift.x, 0.0, uCloudDrift.y)) / C_CELL) * C_CELL; // the block this point is in
  float e = cNoise3(q / 180.0, 310) * 0.6 + (detail ? cNoise3(q / 62.0 + 7.0, 311) * 0.3 : 0.15);
  float d = cloudCov(p.xz) * prof - 0.42 + e * 0.28;
  return clamp(d * 4.0, 0.0, 1.0) * uCloudDens;
}
// the sun's transmittance through the slab over a point on the ground
float cloudShadowAt(vec2 xz, vec3 sun) {
  if (uCover <= 0.02 || sun.y < 0.03) return 1.0;
  float od = 0.0;
  for (int i = 0; i < 4; i++) {
    float y = mix(C_BASE, C_TOP, (float(i) + 0.5) / 4.0);
    vec2 q = xz + sun.xz * ((y - 0.0) / sun.y); // from the ground up along the sun
    od += cloudDens(vec3(q.x, y, q.y), false) * (C_TOP - C_BASE) / 4.0;
  }
  return exp(-od * 0.012);
}
float hgPhase(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }
// march the slab along the ray from ro; returns (light, transmittance); tmax: the scene's distance (clouds behind it only)
vec4 marchClouds(vec3 ro, vec3 rd, float tmax, float jit, vec3 sunCol, vec3 sunDir, vec3 amb) {
  if (uCover <= 0.02) return vec4(0.0, 0.0, 0.0, 1.0);
  float ry = abs(rd.y) < 1e-4 ? 1e-4 : rd.y;
  float t0 = (C_BASE - ro.y) / ry, t1 = (C_TOP - ro.y) / ry;
  if (t0 > t1) { float s = t0; t0 = t1; t1 = s; }
  if (ro.y > C_BASE && ro.y < C_TOP) t0 = 0.0;
  t0 = max(t0, 0.0); t1 = min(t1, min(tmax, 60000.0));
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
  float n = float(${CLOUDS.steps}), dt = (t1 - t0) / n, t = t0 + dt * jit;
  vec3 acc = vec3(0.0); float T = 1.0;
  float mu = dot(rd, sunDir), ph = mix(hgPhase(mu, 0.75), hgPhase(mu, -0.25), 0.4);
  for (int i = 0; i < ${CLOUDS.steps}; i++) {
    vec3 p = ro + rd * t;
    float d = cloudDens(p, t < 9000.0);
    if (d > 0.001) {
      float od = cloudDens(p + sunDir * 60.0, false) * 60.0 + cloudDens(p + sunDir * 220.0, false) * 160.0;
      float beer = exp(-od * 0.014), powder = 1.0 - exp(-d * 2.5);
      float hN = clamp((p.y - C_BASE) / (C_TOP - C_BASE), 0.0, 1.0);
      vec3 S = sunCol * beer * ph * (0.5 + 0.5 * powder) * 1.6 + amb * (0.25 + 0.6 * hN);
      float a = 1.0 - exp(-d * dt * 0.02);
      acc += S * a * T; T *= 1.0 - a;
      if (T < 0.02) break;
    }
    t += dt;
  }
  return vec4(acc, T);
}
`;

export class Clouds {
  constructor(renderer, sky) {
    this.renderer = renderer;
    this.U = {
      uCover: { value: 0.35 }, uCloudDens: { value: 1 }, uCloudT: { value: 0 }, uCloudDrift: { value: new THREE.Vector2() },
      uSun: sky.uniforms.uSun, uSunColor: sky.uniforms.uSunColor, uSkyUp: { value: new THREE.Color() },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      tDepth: { value: null }, uLogF: { value: 1 }, uRes: { value: new THREE.Vector2() }, uFrame: { value: 0 },
      uShadowRect: { value: new THREE.Vector4(0, 0, 1, 1) }, // centre x, z, half span, 0
    };
    const VS = 'out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    const pass = (frag) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: this.U, vertexShader: VS, fragmentShader: 'precision highp float; precision highp int;\nin vec2 vUv; out vec4 oColor;\n' + frag, depthTest: false, depthWrite: false });
    this.march = pass(`${NOISE_GLSL}\n${CLOUD_GLSL}
uniform sampler2D tDepth; uniform mat4 uInvProj, uCamWorld; uniform vec3 uCamPos, uSkyUp, uSun, uSunColor; uniform float uLogF, uFrame; uniform vec2 uRes;
vec3 viewRayZ(vec2 uv) { vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0); p.xyz /= p.w; return p.xyz / -p.z; }
float w2ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec3 vz = viewRayZ(vUv); vec3 v = normalize((uCamWorld * vec4(vz, 0.0)).xyz);
  // the nearest scene distance over the 4 x 4 full-resolution pixels this one stands for
  float dmin = 1e9;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) { float d = texture(tDepth, vUv + (vec2(i, j) - 0.5) * 2.0 / (uRes * 4.0)).r; dmin = min(dmin, d >= 1.0 ? 1e9 : (exp2(d * uLogF) - 1.0) * length(vz)); }
  float jit = w2ign(gl_FragCoord.xy + 17.0 * fract(uFrame * 0.618));
  oColor = marchClouds(uCamPos, v, dmin, jit, uSunColor, uSun, uSkyUp);
}`);
    this.shadow = pass(`${NOISE_GLSL}\n${CLOUD_GLSL}
uniform vec4 uShadowRect; uniform vec3 uSun;
void main() {
  vec2 xz = uShadowRect.xy + (vUv - 0.5) * 2.0 * uShadowRect.z;
  oColor = vec4(cloudShadowAt(xz, uSun), 0.0, 0.0, 1.0);
}`);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad); this.cam = new THREE.Camera();
    this.rtShadow = new THREE.WebGLRenderTarget(CLOUDS.shadowRes, CLOUDS.shadowRes, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rt = null; this.frame = 0;
  }
  // the cloud layer at quarter resolution, into rt (allocated to the post chain's size); depth: the scene's depth texture
  render(rt, depthTex, camera, logF, w, h, eye, skyUp) {
    const U = this.U, r = this.renderer;
    U.tDepth.value = depthTex; U.uLogF.value = logF; U.uRes.value.set(w, h);
    U.uInvProj.value.copy(camera.projectionMatrixInverse); U.uCamWorld.value.copy(camera.matrixWorld); U.uCamPos.value.copy(eye);
    U.uSkyUp.value.copy(skyUp); U.uFrame.value = this.frame++;
    const prev = r.getRenderTarget();
    this.quad.material = this.march; r.setRenderTarget(rt); r.render(this.scene, this.cam);
    // the shadow map round the camera, snapped to its texels
    const texel = CLOUDS.shadowSpan / CLOUDS.shadowRes;
    U.uShadowRect.value.set(Math.round(eye.x / texel) * texel, Math.round(eye.z / texel) * texel, CLOUDS.shadowSpan / 2, 0);
    this.quad.material = this.shadow; r.setRenderTarget(this.rtShadow); r.render(this.scene, this.cam);
    r.setRenderTarget(prev);
  }
  // the weather sets these each frame
  set(cover, dens, time, wind) { const U = this.U; U.uCover.value = cover; U.uCloudDens.value = dens; U.uCloudT.value = time; U.uCloudDrift.value.set(wind[0] * time * 2.5, wind[1] * time * 2.5); }
}
// GLSL for anything lit by the sun on the ground: the cloud shadow over a point (1 in the open)
export const CLOUD_SHADOW_GLSL = /* glsl */ `
uniform sampler2D tCloudShadow; uniform vec4 uCloudRect;
float cloudShadow(vec2 xz) {
  vec2 uv = (xz - uCloudRect.xy) / (2.0 * uCloudRect.z) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  return texture(tCloudShadow, uv).r;
}
`;
