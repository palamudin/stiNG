// The GPU side of waves.js: the spectrum evolved per frame, the inverse FFT as Stockham passes, and the per-cascade
// displacement and slope-moment textures. See waves.js for the physics and the choices.
import * as THREE from 'three';
import { WAVES, bands, seaState, fieldStats, gauss2 } from './waves.js';

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const VS = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
const HEAD = 'precision highp float; precision highp int;\nout vec4 oColor;\n';
function pass(frag, uniforms) {
  return new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms, vertexShader: VS, fragmentShader: HEAD + frag, depthTest: false, depthWrite: false });
}

// GLSL twin of curvature() and spreading() (checked against the JS in the GPU test)
const SPECTRUM_GLSL = /* glsl */ `
uniform float uKp, uCp, uOm, uGamma, uSigma, uAp, uAm, uOnset, uAmS;
const float G = ${f(WAVES.g)}, TS = ${WAVES.T.toExponential()}, KM = ${f(WAVES.km)}, CM = ${f(WAVES.cm)};
float cOf(float k) { return sqrt(G / k * (1.0 + (k / KM) * (k / KM))); }
float curvature(float k) {
  float c = cOf(k), sk = sqrt(k / uKp);
  float Lpm = exp(-1.25 * (uKp / k) * (uKp / k));
  float Jp = pow(uGamma, exp(-(sk - 1.0) * (sk - 1.0) / (2.0 * uSigma * uSigma)));
  float Fp = Lpm * Jp * exp(-uOm / sqrt(10.0) * (sk - 1.0));
  float Fm = Lpm * Jp * exp(-0.25 * (k / KM - 1.0) * (k / KM - 1.0));
  return (0.5 * uAp * (uCp / c) * Fp + 0.5 * uAm * (CM / c) * Fm) * uOnset;
}
float spreading(float k) { float c = cOf(k); return tanh(0.17328680 + 4.0 * pow(c / uCp, 2.5) + uAmS * pow(CM / c, 2.5)); }
`;

export class WaveField {
  // opts: cascades [L...] (m), fetch (m), N, salt (int, the cosmetic salt), float (bool: 32-bit FFT targets)
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    const N = this.N = opts.N || WAVES.N, C = this.C = opts.cascades.length;
    this.cascades = opts.cascades.slice(); this.fetch = opts.fetch; this.salt = opts.salt | 0;
    this.band = bands(this.cascades, N);
    const ft = opts.float === false ? THREE.HalfFloatType : THREE.FloatType;
    const rt = (w, h) => new THREE.WebGLRenderTarget(w, h, { type: ft, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    this.ping = rt(N * C, 2 * N); this.pong = rt(N * C, 2 * N);
    // noise: xi(k) and xi(-k) per texel
    const nz = new Float32Array(N * C * N * 4);
    for (let c = 0; c < C; c++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const a = gauss2(j, i, 4001 + c * 16 + this.salt), jm = (N - j) % N, im = (N - i) % N, b = gauss2(jm, im, 4001 + c * 16 + this.salt);
      const o = ((i * N * C) + c * N + j) * 4; nz[o] = a[0]; nz[o + 1] = a[1]; nz[o + 2] = b[0]; nz[o + 3] = b[1];
    }
    this.noise = new THREE.DataTexture(nz, N * C, N, THREE.RGBAFormat, THREE.FloatType); this.noise.needsUpdate = true;
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const out = () => { const t = new THREE.WebGLRenderTarget(N, N, { type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, generateMipmaps: true, anisotropy: aniso }); return t; };
    this.disp = this.cascades.map(out); this.slope = this.cascades.map(out);
    const pad4 = (a, v) => { const r = a.slice(0, 4); while (r.length < 4) r.push(v); return new THREE.Vector4(...r); };
    this.U = {
      tNoise: { value: this.noise }, tIn: { value: null },
      uL: { value: pad4(this.cascades, 1) }, uKmin: { value: pad4(this.band.map((b) => b[0]), 0) }, uKmax: { value: pad4(this.band.map((b) => b[1]), 0) },
      uWindDir: { value: new THREE.Vector2(1, 0) }, uT: { value: 0 }, uChop: { value: WAVES.chop }, uOmegaMax: { value: 1e9 },
      uKp: { value: 1 }, uCp: { value: 1 }, uOm: { value: 1 }, uGamma: { value: 1 }, uSigma: { value: 0.1 }, uAp: { value: 0 }, uAm: { value: 0 }, uOnset: { value: 0 }, uAmS: { value: 0 },
      uNs: { value: 2 }, uDirY: { value: 0 }, uCas: { value: 0 },
    };
    this.spectrum = pass(`${SPECTRUM_GLSL}
uniform sampler2D tNoise; uniform vec4 uL, uKmin, uKmax; uniform vec2 uWindDir; uniform float uT, uChop, uOmegaMax;
const int N = ${N}; const float LOOP = ${f(WAVES.loop)};
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); int c = p.x / N, j = p.x - c * N, hf = p.y / N, i = p.y - hf * N;
  float L = uL[c]; vec2 k = 6.28318531 * vec2(float(j - N / 2), float(i - N / 2)) / L; float kl = length(k);
  if (kl <= 0.0 || kl < uKmin[c] || kl >= uKmax[c]) { oColor = vec4(0.0); return; }
  vec4 xi = texelFetch(tNoise, ivec2(p.x, i), 0);
  float dk = 6.28318531 / L, cphi = dot(k, uWindDir) / kl;
  float psi = curvature(kl) / (kl * kl * kl * kl) * (1.0 + spreading(kl) * (2.0 * cphi * cphi - 1.0)) / 6.28318531;
  float fw = (1.0 + cphi) * (1.0 + cphi) / (2.0 + 2.0 * cphi * cphi);
  float ap = dk * sqrt(max(psi * fw, 0.0)), am = dk * sqrt(max(psi * (1.0 - fw), 0.0));
  float w = sqrt(G * kl + TS * kl * kl * kl), w0 = 6.28318531 / LOOP, m = floor(w / w0 + 0.5);
  float ph = 6.28318531 * fract(m * uT / LOOP);
  float fd = 1.0 - smoothstep(0.7 * uOmegaMax, uOmegaMax, w);
  vec2 e = vec2(cos(ph), sin(ph));
  // runs along +k: A+ xi(k) e^{-i w t} + conj(A- xi(-k)) e^{+i w t}
  vec2 h = (cmul(ap * xi.xy, vec2(e.x, -e.y)) + cmul(am * vec2(xi.z, -xi.w), e)) * fd;
  float gk = G * kl, tk = TS * kl * kl * kl, lam = uChop * (gk - tk) / (gk + tk);
  vec2 kh = k / kl;
  vec2 ih = vec2(-h.y, h.x); // i h
  vec2 Dx = lam * kh.x * ih, Dz = lam * kh.y * ih, sx = k.x * ih, sz = k.y * ih;
  vec2 Jxx = -lam * k.x * kh.x * h, Jzz = -lam * k.y * kh.y * h, Jxz = -lam * k.x * kh.y * h;
  vec2 C0 = h + vec2(-Dx.y, Dx.x), C1 = Dz + vec2(-sx.y, sx.x), C2 = sz + vec2(-Jxx.y, Jxx.x), C3 = Jzz + vec2(-Jxz.y, Jxz.x);
  oColor = hf == 0 ? vec4(C0, C1) : vec4(C2, C3);
}`, this.U);
    this.stage = pass(`uniform sampler2D tIn; uniform int uNs, uDirY;
const int N = ${N};
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int a = uDirY == 1 ? p.y : p.x, base = (a / N) * N, idx = a - base, hs = uNs / 2;
  int ev = (idx / uNs) * hs + idx % hs, od = ev + N / 2;
  ivec2 pe = p, po = p;
  if (uDirY == 1) { pe.y = base + ev; po.y = base + od; } else { pe.x = base + ev; po.x = base + od; }
  vec4 e = texelFetch(tIn, pe, 0), o = texelFetch(tIn, po, 0);
  float an = 6.28318531 * float(idx % uNs) / float(uNs); vec2 w = vec2(cos(an), sin(an));
  oColor = vec4(e.xy + cmul(w, o.xy), e.zw + cmul(w, o.zw));
}`, this.U);
    const assemble = (which) => pass(`uniform sampler2D tIn; uniform int uCas;
const int N = ${N};
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); ivec2 q = ivec2(uCas * N + p.x, p.y);
  float sg = ((p.x + p.y) & 1) == 1 ? -1.0 : 1.0; // the grid's wave numbers start at -N/2
  vec4 A = texelFetch(tIn, q, 0) * sg, B = texelFetch(tIn, q + ivec2(0, N), 0) * sg;
  // A = (h, Dx, Dz, sx), B = (sz, Jxx, Jzz, Jxz)
  ${which === 'disp'
    ? 'float J = (1.0 + B.y) * (1.0 + B.z) - B.w * B.w; oColor = vec4(A.y, A.x, A.z, J);'
    : 'oColor = vec4(A.w, B.x, A.w * A.w, B.x * B.x);'}
}`, this.U);
    this.assembleDisp = assemble('disp'); this.assembleSlope = assemble('slope');
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad); this.cam = new THREE.Camera();
    this.state = null; this.lostSlope = 0; this._statsKey = '';
  }
  _run(mat, out) { this.quad.material = mat; this.renderer.setRenderTarget(out); this.renderer.render(this.scene, this.cam); }
  // wind: [x, z] at 10 m in m/s; omegaMax: pi * the frame rate (waves faster than that are faded)
  update(time, wind, omegaMax = Math.PI * 60) {
    const U10 = Math.hypot(wind[0], wind[1]), U = this.U, P = this.state = seaState(U10, this.fetch);
    if (U10 > 1e-3) U.uWindDir.value.set(wind[0] / U10, wind[1] / U10);
    U.uKp.value = P.kp; U.uCp.value = P.cp; U.uOm.value = P.Om; U.uGamma.value = P.gamma; U.uSigma.value = P.sigma;
    U.uAp.value = P.ap; U.uAm.value = P.am; U.uOnset.value = P.onset; U.uAmS.value = P.a_m;
    U.uT.value = time % WAVES.loop; U.uOmegaMax.value = omegaMax;
    // the slope variance the fade takes away, recounted when the sea state or the frame rate has moved enough
    const key = [Math.round(Math.log(Math.max(U10, 0.05)) * 30), Math.round(Math.log(omegaMax) * 8)].join();
    if (key !== this._statsKey) { this._statsKey = key; const s = fieldStats(P, this.cascades, [U.uWindDir.value.x, U.uWindDir.value.y], omegaMax, this.N); this.lostSlope = s.lostS; this.stats = s; }
    const r = this.renderer, prev = r.getRenderTarget();
    this._run(this.spectrum, this.ping);
    let a = this.ping, b = this.pong;
    for (const dir of [0, 1]) for (let Ns = 2; Ns <= this.N; Ns *= 2) {
      U.uNs.value = Ns; U.uDirY.value = dir; U.tIn.value = a.texture; this._run(this.stage, b); [a, b] = [b, a];
    }
    U.tIn.value = a.texture;
    for (let c = 0; c < this.C; c++) { U.uCas.value = c; this._run(this.assembleDisp, this.disp[c]); this._run(this.assembleSlope, this.slope[c]); }
    r.setRenderTarget(prev);
    this.result = a; // the transformed atlas (tests read it back)
  }
  dispose() { for (const t of [this.ping, this.pong, ...this.disp, ...this.slope]) t.dispose(); this.noise.dispose(); }
}
