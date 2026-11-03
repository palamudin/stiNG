// Sky and light from one atmosphere model (GDD 20, G7, built out): single scattering of sunlight by air (Rayleigh),
// haze (Mie) and ozone absorption over a spherical planet, integrated into a small sky-view table each frame the sun
// moves (Hillaire 2020's sky-view LUT, without the multiple-scattering LUT). The same model, at a few samples on the
// CPU, gives the sun's colour after the air it crosses and the sky's light on the ground, so the direct light, the
// ambient light, the sky and the haze on far hills all agree: a low sun reddens because the air took the blue.
//
// Units are real: metres, an Earth-sized planet, sea-level coefficients per metre. The haze control multiplies the
// Mie density only (more aerosol), and the mist control adds a thin low-lying fog layer for valleys and forests.
import * as THREE from 'three';

export const ATMO = {
  Rg: 6360e3, Rt: 6460e3,
  rayleigh: [5.802e-6, 13.558e-6, 33.1e-6], rayleighH: 8000,
  mie: 3.996e-6, mieExt: 4.40e-6, mieH: 1200, mieG: 0.8,
  ozone: [0.650e-6, 1.881e-6, 0.085e-6], ozoneC: 25000, ozoneW: 15000,
  sunE: 20,          // the sun's light before the air, in the renderer's units
  sunAngle: 0.00935, // the sun's angular diameter, radians (0.535 degrees)
};

export const SKY_GLSL = /* glsl */ `
const float A_RG = ${ATMO.Rg.toFixed(1)}, A_RT = ${ATMO.Rt.toFixed(1)};
const vec3 A_RAY = vec3(${ATMO.rayleigh.map((v) => v.toExponential(4)).join(', ')});
const vec3 A_OZO = vec3(${ATMO.ozone.map((v) => v.toExponential(4)).join(', ')});
const float A_RAYH = ${ATMO.rayleighH.toFixed(1)}, A_MIE = ${ATMO.mie.toExponential(4)}, A_MIEX = ${ATMO.mieExt.toExponential(4)}, A_MIEH = ${ATMO.mieH.toFixed(1)};
uniform float uHaze; // multiplies the Mie density
uniform sampler2D uMS; // multiple scattering (Hillaire 2020, section 5.5)
vec3 aExt(float h, out vec3 scR, out float scM) {
  float dr = exp(-h / A_RAYH), dm = exp(-h / A_MIEH) * uHaze, dozo = max(0.0, 1.0 - abs(h - ${ATMO.ozoneC.toFixed(1)}) / ${ATMO.ozoneW.toFixed(1)});
  scR = A_RAY * dr; scM = A_MIE * dm;
  return A_RAY * dr + vec3(A_MIEX * dm) + A_OZO * dozo;
}
// distance along a ray from radius-r, cos-zenith mu to the top of the atmosphere (or -1 if it hits the ground)
float aTop(float r, float mu) { float d = r * r * (mu * mu - 1.0) + A_RT * A_RT; return -r * mu + sqrt(max(d, 0.0)); }
float aGround(float r, float mu) { float d = r * r * (mu * mu - 1.0) + A_RG * A_RG; return (mu < 0.0 && d >= 0.0) ? -r * mu - sqrt(d) : -1.0; }
vec3 aTransmittance(float r, float mu) { // optical depth to the top, 12 steps
  if (aGround(r, mu) > 0.0) return vec3(0.0);
  float L = aTop(r, mu), dt = L / 12.0; vec3 od = vec3(0.0); vec3 sR; float sM;
  for (int i = 0; i < 12; i++) { float t = (float(i) + 0.5) * dt; float rr = sqrt(r * r + t * t + 2.0 * r * mu * t); od += aExt(rr - A_RG, sR, sM) * dt; }
  return exp(-od);
}
float aPhaseR(float c) { return 3.0 / (16.0 * 3.14159265) * (1.0 + c * c); }
float aPhaseM(float c) { float g = ${ATMO.mieG.toFixed(2)}; float k = 1.0 + g * g - 2.0 * g * c; return 3.0 / (8.0 * 3.14159265) * (1.0 - g * g) * (1.0 + c * c) / ((2.0 + g * g) * pow(k, 1.5)); }
// in-scattered light along a view ray from altitude h in direction v (unit), sun direction s, up to distance tMax
vec3 aScatter(float h, vec3 v, vec3 s, float tMax, out vec3 trans) {
  float r = A_RG + max(h, 1.0), mu = v.y;
  float tg = aGround(r, mu); float L = tg > 0.0 ? tg : aTop(r, mu); L = min(L, tMax);
  const int STEPS = 24; vec3 sum = vec3(0.0), od = vec3(0.0); float c = dot(v, s);
  float pr = aPhaseR(c), pm = aPhaseM(c);
  float t0 = 0.0;
  for (int i = 0; i < STEPS; i++) {
    float t1 = L * pow((float(i) + 1.0) / float(STEPS), 2.0); float t = 0.5 * (t0 + t1), dt = t1 - t0; t0 = t1;
    vec3 p = vec3(0.0, r, 0.0) + v * t; float rr = length(p);
    vec3 sR; float sM; vec3 ex = aExt(rr - A_RG, sR, sM);
    od += ex * dt;
    vec3 up = p / rr; float mus = dot(up, s); vec3 Ts = aTransmittance(rr, mus);
    vec3 ms = texture(uMS, vec2(mus * 0.5 + 0.5, clamp((rr - A_RG) / (A_RT - A_RG), 0.0, 1.0))).rgb;
    sum += exp(-od) * (Ts * (sR * pr + sM * pm) + ms * (sR + vec3(sM))) * dt;
  }
  trans = exp(-od);
  return sum * ${ATMO.sunE.toFixed(1)};
}
// the sky-view table: latitude packed toward the horizon (Hillaire), longitude relative to the sun's azimuth
vec2 skyUV(vec3 v, vec3 s) {
  float el = asin(clamp(v.y, -1.0, 1.0));
  float vv = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963);
  float az = atan(v.z, v.x) - atan(s.z, s.x);
  return vec2(fract(az / 6.2831853 + 1.0), vv);
}
vec3 skyDir(vec2 uv, vec3 s) {
  float x = uv.y * 2.0 - 1.0; float el = sign(x) * x * x * 1.5707963;
  float az = uv.x * 6.2831853 + atan(s.z, s.x);
  return vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
}
`;

// ---------------------------------------------------------------- CPU twin (sun colour, sky light on the ground)
const A = ATMO;
function extJS(h, haze) {
  const dr = Math.exp(-h / A.rayleighH), dm = Math.exp(-h / A.mieH) * haze, dz = Math.max(0, 1 - Math.abs(h - A.ozoneC) / A.ozoneW);
  return [0, 1, 2].map((c) => A.rayleigh[c] * dr + A.mieExt * dm + A.ozone[c] * dz);
}
function topJS(r, mu) { return -r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + A.Rt * A.Rt, 0)); }
function groundJS(r, mu) { const d = r * r * (mu * mu - 1) + A.Rg * A.Rg; return mu < 0 && d >= 0 ? -r * mu - Math.sqrt(d) : -1; }
export function transmittanceJS(h, mu, haze = 1, steps = 24) {
  const r = A.Rg + Math.max(h, 1);
  if (groundJS(r, mu) > 0) return [0, 0, 0];
  const L = topJS(r, mu), dt = L / steps, od = [0, 0, 0];
  for (let i = 0; i < steps; i++) { const t = (i + 0.5) * dt, rr = Math.sqrt(r * r + t * t + 2 * r * mu * t), e = extJS(rr - A.Rg, haze); for (let c = 0; c < 3; c++) od[c] += e[c] * dt; }
  return od.map((v) => Math.exp(-v));
}

// ---------------------------------------------------------------- the GPU side: the sky-view table
export class Sky {
  constructor(renderer) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(192, 108, { type: THREE.FloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping });
    this._px = new Float32Array(192 * 108 * 4);
    this.uniforms = {
      uSkyView: { value: this.rt.texture },
      uSun: { value: new THREE.Vector3(0.4, 0.6, 0.3).normalize() },
      uHaze: { value: 1 },
      uCamH: { value: 2 },
      uSunColor: { value: new THREE.Color() }, // the sun's light at the ground, after the air
      uMoon: { value: 0 },
    };
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: 'out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float;\n${SKY_GLSL}\nuniform vec3 uSun; uniform float uCamH; in vec2 vUv; out vec4 o;
void main() { vec3 v = skyDir(vUv, uSun); vec3 tr; vec3 c = aScatter(uCamH, v, uSun, 1e9, tr); o = vec4(c, 1.0); }`,
      depthTest: false, depthWrite: false,
    });
    // Multiple scattering: for each altitude and sun angle, the light scattered twice or more, as an isotropic source
    // (Hillaire 2020, 5.5): integrate second-order light and the transfer fraction over 64 directions, sum the
    // geometric series L2 / (1 - f). Ground albedo 0.3. Rebuilt when the haze changes.
    this.msRT = new THREE.WebGLRenderTarget(32, 32, { type: THREE.FloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    this.uniforms.uMS = { value: this.msRT.texture };
    this.msMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.uniforms,
      vertexShader: 'out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float;\n${SKY_GLSL}\nin vec2 vUv; out vec4 o;
void main() {
  float mus = vUv.x * 2.0 - 1.0, r = A_RG + vUv.y * (A_RT - A_RG) + 1.0;
  vec3 s = vec3(sqrt(max(0.0, 1.0 - mus * mus)), mus, 0.0);
  vec3 L2 = vec3(0.0), fms = vec3(0.0);
  for (int a = 0; a < 8; a++) for (int b = 0; b < 8; b++) {
    float u = (float(a) + 0.5) / 8.0, v = (float(b) + 0.5) / 8.0;
    float cz = 1.0 - 2.0 * v, sz = sqrt(max(0.0, 1.0 - cz * cz)), ph = 6.2831853 * u;
    vec3 w = vec3(sz * cos(ph), cz, sz * sin(ph));
    float tg = aGround(r, w.y), L = tg > 0.0 ? tg : aTop(r, w.y);
    vec3 od = vec3(0.0), Li = vec3(0.0), Fi = vec3(0.0); float dt = L / 20.0;
    for (int i = 0; i < 20; i++) {
      float t = (float(i) + 0.5) * dt; vec3 p = vec3(0.0, r, 0.0) + w * t; float rr = length(p);
      vec3 sR; float sM; vec3 ex = aExt(rr - A_RG, sR, sM); vec3 S = sR + vec3(sM);
      vec3 T = exp(-(od + ex * dt * 0.5));
      Li += T * S * aTransmittance(rr, dot(p / rr, s)) * dt / (4.0 * 3.14159265); // second order, isotropic phase
      Fi += T * S * dt;                                                          // transfer fraction
      od += ex * dt;
    }
    if (tg > 0.0) { vec3 pg = vec3(0.0, r, 0.0) + w * tg; vec3 ng = normalize(pg); Li += exp(-od) * aTransmittance(A_RG + 1.0, dot(ng, s)) * max(dot(ng, s), 0.0) * 0.3 / 3.14159265; }
    L2 += Li / 64.0; fms += Fi / 64.0; // uniform over the sphere: (4 pi / N) * (1 / 4 pi)
  }
  o = vec4(L2 / (1.0 - min(fms, vec3(0.99))), 1.0); // Psi_ms = L2 / (1 - f_ms)
}`,
      depthTest: false, depthWrite: false,
    });
    this._msHaze = -1;
    this.scene = new THREE.Scene();
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat); q.frustumCulled = false; this.scene.add(q);
    this._q = q;
    this.cam = new THREE.Camera();
    this._key = '';
    this._day = new Map(); // the day table: per sun height, haze and altitude step, what _cpu reads out
    this.sunColor = new THREE.Color(); this.skyUp = new THREE.Color(); this.skyHorizon = new THREE.Color(); this.ground = new THREE.Color();
  }
  // Rebuild the table when the sun's height, the haze or the camera's altitude changed enough to see. The table is laid
  // out round the sun's azimuth (skyDir), so it depends on the sun's height alone. What the CPU reads out of it (the
  // sun's colour, the sky's light on the ground and on walls) is kept per key in a day table: the first time through a
  // day costs one read-back per step of the sun, every later time none (a read-back stalls the GPU).
  update(sunDir, camH, haze) {
    this.uniforms.uSun.value.copy(sunDir);
    this.uniforms.uHaze.value = haze;
    this.uniforms.uCamH.value = Math.max(1, camH);
    const key = `${sunDir.y.toFixed(3)},${haze.toFixed(2)},${Math.round(Math.log2(Math.max(1, camH)) * 4)}`;
    if (key !== this._key) {
      this._key = key;
      const r = this.renderer, prev = r.getRenderTarget();
      if (this._msHaze !== haze) { this._msHaze = haze; this._q.material = this.msMat; r.setRenderTarget(this.msRT); r.render(this.scene, this.cam); this._q.material = this.mat; }
      r.setRenderTarget(this.rt); r.render(this.scene, this.cam); r.setRenderTarget(prev);
      const got = this._day.get(key);
      if (got) { this.sunColor.copy(got.sun); this.skyUp.copy(got.up); this.skyHorizon.copy(got.hz); this.irradiance = got.irr; this.uniforms.uSunColor.value.copy(this.sunColor); }
      else {
        this._cpu(sunDir, camH, haze);
        if (this._day.size > 8192) this._day.clear();
        this._day.set(key, { sun: this.sunColor.clone(), up: this.skyUp.clone(), hz: this.skyHorizon.clone(), irr: this.irradiance });
      }
    }
  }
  // Sun colour from the transmittance toward it (CPU twin of the same air). Sky light: the table read back and
  // integrated over the upper hemisphere with the cosine (irradiance on level ground), and again weighted toward the
  // horizon for walls and trunks. Read back only when the table was rebuilt.
  _cpu(s, camH, haze) {
    const T = transmittanceJS(camH, s.y, haze);
    const k = THREE.MathUtils.smoothstep(s.y, -0.012, 0.012); // the disc sinking below the horizon
    this.sunColor.setRGB(T[0] * A.sunE * k, T[1] * A.sunE * k, T[2] * A.sunE * k);
    this.uniforms.uSunColor.value.copy(this.sunColor);
    const W = 192, H = 108, px = this._px;
    this.renderer.readRenderTargetPixels(this.rt, 0, 0, W, H, px);
    const up = [0, 0, 0], hz = [0, 0, 0]; let wu = 0, wh = 0;
    for (let j = H / 2; j < H; j++) {
      const x = (j + 0.5) / H * 2 - 1, el = x * x * 1.5707963, del = 2 * Math.abs(x) * 1.5707963 * (2 / H);
      const dOmega = Math.cos(el) * del * (6.2831853 / W), cu = Math.sin(el) * dOmega, ch = Math.cos(el) * dOmega;
      for (let i = 0; i < W; i++) { const o = (j * W + i) * 4; for (let c = 0; c < 3; c++) { up[c] += px[o + c] * cu; hz[c] += px[o + c] * ch; } }
      wu += cu * W; wh += ch * W;
    }
    // irradiance on level ground, E = sum of L cos dOmega. three.js lights are irradiance (a directional light's colour
    // is E at normal incidence, a hemisphere light's colour is E on a surface facing it), so this is the sky colour.
    this.skyUp.setRGB(up[0], up[1], up[2]);
    this.skyHorizon.setRGB(hz[0] / wh, hz[1] / wh, hz[2] / wh);
    this.irradiance = up.slice();
  }
}

// ---------------------------------------------------------------- blocky clouds
// A layer of chunky, rounded-box clouds like a game's, drifting with the wind: cells of a coarse grid become cloud
// where a slow noise is high, merged into slabs. Lit from the sun with a soft top and a darker belly; the haze
// (post.js) puts distance on them like on anything else.
import { hash01, vnoise } from './noise.js';
export function makeClouds(opts = {}) {
  const cell = opts.cell ?? 36, H = opts.height ?? 1150, thick = opts.thick ?? 22, R = opts.radius ?? 64;
  const box = roundedBox(1, 1, 1, 0.22, 3);
  const geo = new THREE.InstancedBufferGeometry().copy(box);
  const n = (2 * R + 1) ** 2;
  const offs = new Float32Array(n * 4);
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(offs, 4));
  geo.instanceCount = 0;
  const U = { uCloudOrigin: { value: new THREE.Vector2() }, uCloudCell: { value: cell }, uCloudH: { value: H }, uCloudThick: { value: thick }, uSun: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() }, uSkyUp: { value: new THREE.Color() } };
  const mat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */ `
attribute vec4 aCell; uniform vec2 uCloudOrigin; uniform float uCloudCell, uCloudH, uCloudThick; varying vec3 vN; varying float vY; varying vec3 vW;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec3 p = position * vec3(aCell.z * uCloudCell, uCloudThick * aCell.w, uCloudCell) + vec3(uCloudOrigin.x + aCell.x * uCloudCell, uCloudH, uCloudOrigin.y + aCell.y * uCloudCell);
  vN = normal; vY = position.y + 0.5; vW = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uSun, uSunColor, uSkyUp; varying vec3 vN; varying float vY; varying vec3 vW;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float d = max(dot(normalize(vN), uSun), 0.0);
  vec3 c = uSunColor * (0.18 + 0.32 * d) * mix(0.55, 1.0, vY) + uSkyUp * (0.9 + 0.35 * vY);
  gl_FragColor = vec4(c, 1.0);
}`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.name = 'world2-clouds';
  let lastKey = '';
  return {
    mesh, uniforms: U,
    update(camX, camZ, time, wind = [3, 1.2], seed = 1) {
      const ox = wind[0] * time, oz = wind[1] * time; // the layer drifts; cells are fixed in the moving frame
      const ci = Math.round((camX - ox) / cell), cj = Math.round((camZ - oz) / cell), key = ci + ',' + cj;
      U.uCloudOrigin.value.set(ox, oz);
      if (key === lastKey) return;
      lastKey = key;
      let k = 0;
      for (let j = cj - R; j <= cj + R; j++) for (let i = ci - R; i <= ci + R; i++) {
        const v = vnoise(i * 0.09, j * 0.09, seed * 31 + 5) * 0.75 + vnoise(i * 0.31, j * 0.31, seed * 31 + 6) * 0.35;
        if (v < 0.32) continue;
        const r = Math.hypot(i - ci, j - cj); if (r > R) continue;
        offs[k * 4] = i; offs[k * 4 + 1] = j; offs[k * 4 + 2] = 1; offs[k * 4 + 3] = v > 0.55 ? 1.6 : 1; k++;
      }
      geo.attributes.aCell.needsUpdate = true;
      geo.instanceCount = k;
    },
  };
}

// a unit box centred at the origin with rounded edges (radius r of the unit), normals smooth over the rounding
export function roundedBox(w, h, d, r, seg = 3) {
  const g = new THREE.BoxGeometry(1, 1, 1, seg * 2 + 2, seg * 2 + 2, seg * 2 + 2), p = g.attributes.position, n = g.attributes.normal, v = new THREE.Vector3(), c = new THREE.Vector3();
  const hx = 0.5 - r, hy = 0.5 - r, hz = 0.5 - r;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    c.set(THREE.MathUtils.clamp(v.x, -hx, hx), THREE.MathUtils.clamp(v.y, -hy, hy), THREE.MathUtils.clamp(v.z, -hz, hz));
    const dv = v.clone().sub(c); if (dv.lengthSq() > 0) dv.normalize(); else dv.set(0, 1, 0);
    const q = c.clone().addScaledVector(dv, r);
    p.setXYZ(i, q.x * w, q.y * h, q.z * d); n.setXYZ(i, dv.x, dv.y, dv.z);
  }
  g.computeBoundingSphere();
  return g;
}
