// The wave field on WebGPU (WEBGPU.md, water step 1): wavegpu.js's spectrum, inverse FFT and assembly as compute
// passes over storage buffers instead of draws into render targets. The physics is waves.js (Elfouhaily's unified
// spectrum, capillary-gravity dispersion, the swell peak, the loop-quantised frequencies); the layout is the same atlas
// (the cascades side by side, two complex pairs per texel: rows 0..N-1 (h, Dx), (Dz, sx); rows N..2N-1 (sz, Jxx),
// (Jzz, Jxz)), and the same radix-2 Stockham passes, each its own kernel with its stride and direction built in, so
// no uniform changes between the 14 dispatches. Out, per cascade, two storage textures tiling with repeat:
//   disp:  (Dx, h, Dz, J)            J the horizontal Jacobian's determinant (< 0 where the surface folds)
//   slope: (sx, sz, sx^2, sz^2)
import * as THREE from 'three/webgpu';
import { Fn, If, Return, float, int, uint, vec2, vec4, ivec2, uniform, uniformArray, storage, instanceIndex, textureStore, cos, sin, sqrt, exp, pow, tanh, max, min, clamp, smoothstep, dot, length, floor, fract, mix, select } from 'three/tsl';
import { WAVES, swellNorm, bands, seaState, fieldStats, gauss2 } from '../waves.js';

export class GpuWaves {
  // opts: cascades [L...] (m), fetch (m), N, salt (the cosmetic salt)
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    const N = this.N = opts.N || WAVES.N, C = this.C = opts.cascades.length, W = N * C, H = 2 * N;
    this.cascades = opts.cascades.slice(); this.fetch = opts.fetch; this.salt = opts.salt | 0;
    this.band = bands(this.cascades, N);
    // xi(k) and xi(-k) per texel, as wavegpu.js
    const nz = new Float32Array(W * N * 4);
    for (let c = 0; c < C; c++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const a = gauss2(j, i, 4001 + c * 16 + this.salt), b = gauss2((N - j) % N, (N - i) % N, 4001 + c * 16 + this.salt);
      const o = (i * W + c * N + j) * 4; nz[o] = a[0]; nz[o + 1] = a[1]; nz[o + 2] = b[0]; nz[o + 3] = b[1];
    }
    const noise = storage(new THREE.StorageBufferAttribute(nz, 4), 'vec4', W * N).toReadOnly();
    const mk = () => new THREE.StorageBufferAttribute(new Float32Array(W * H * 4), 4);
    this.bufA = mk(); this.bufB = mk();
    const A = storage(this.bufA, 'vec4', W * H), B = storage(this.bufB, 'vec4', W * H);
    const tex = () => { const t = new THREE.StorageTexture(N, N); t.type = THREE.HalfFloatType; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; return t; };
    this.disp = this.cascades.map(tex); this.slope = this.cascades.map(tex);
    const u = (v, t) => uniform(v, t);
    this.U = {
      L: uniformArray(this.cascades.map((x) => x), 'float'), kmin: uniformArray(this.band.map((b) => b[0]), 'float'), kmax: uniformArray(this.band.map((b) => b[1]), 'float'),
      windDir: u(new THREE.Vector2(1, 0)), t: u(0), chop: u(WAVES.chop), omegaMax: u(1e9),
      kp: u(1), cp: u(1), om: u(1), gamma: u(1), sigma: u(0.1), ap: u(0), am: u(0), onset: u(0), amS: u(0),
      swK: u(0.05), swVar: u(0), swDir: u(new THREE.Vector2(1, 0)), swN: u(1), swS: u(WAVES.swellS), spread: u(WAVES.spread), upwind: u(WAVES.upwind),
    };
    const U = this.U, G = WAVES.g, TS = WAVES.T, KM = WAVES.km, CM = WAVES.cm, LOOP = WAVES.loop, TAU = 6.28318531;
    const cmul = (a, b) => vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));
    const cOf = (k) => sqrt(float(G).div(k).mul(float(1).add(k.div(KM).mul(k.div(KM)))));
    // the spectrum, evolved to time t (wavegpu.js SPECTRUM_GLSL and its pass)
    this.kSpectrum = Fn(() => {
      const t = int(instanceIndex), x = t.mod(W), y = t.div(W);
      const c = x.div(N), j = x.mod(N), hf = y.div(N), i = y.mod(N);
      const L = U.L.element(c), k = vec2(float(j.sub(N / 2)), float(i.sub(N / 2))).mul(TAU).div(L).toVar(), kl = length(k).toVar();
      If(kl.lessThanEqual(0).or(kl.lessThan(U.kmin.element(c))).or(kl.greaterThanEqual(U.kmax.element(c))), () => { A.element(t).assign(vec4(0)); Return(); });
      const xi = noise.element(i.mul(W).add(x)).toVar();
      const dk = float(TAU).div(L), cphi = dot(k, U.windDir).div(kl);
      const cc = cOf(kl), sk = sqrt(kl.div(U.kp));
      const Lpm = exp(float(-1.25).mul(U.kp.div(kl)).mul(U.kp.div(kl)));
      const Jp = pow(U.gamma, exp(sk.sub(1).mul(sk.sub(1)).negate().div(U.sigma.mul(U.sigma).mul(2))));
      const Fp = Lpm.mul(Jp).mul(exp(U.om.negate().div(Math.sqrt(10)).mul(sk.sub(1))));
      const Fm = Lpm.mul(Jp).mul(exp(float(-0.25).mul(kl.div(KM).sub(1)).mul(kl.div(KM).sub(1))));
      const curv = U.ap.mul(0.5).mul(U.cp.div(cc)).mul(Fp).add(U.am.mul(0.5).mul(float(CM).div(cc)).mul(Fm)).mul(U.onset);
      const spr = tanh(float(0.1732868).add(pow(cc.div(U.cp), 2.5).mul(4)).add(U.amS.mul(pow(float(CM).div(cc), 2.5))));
      const psi = curv.div(kl.mul(kl).mul(kl).mul(kl)).mul(float(1).add(U.spread.mul(spr).mul(cphi.mul(cphi).mul(2).sub(1)))).div(TAU).toVar();
      const fw = mix(float(1).add(cphi).mul(float(1).add(cphi)).div(float(2).add(cphi.mul(cphi).mul(2))), float(0.5), U.upwind).toVar();
      const sw = float(0).toVar();
      If(U.swVar.greaterThan(0), () => {
        const cs = clamp(dot(k, U.swDir).div(kl), -1, 1), sg = max(U.swK.mul(WAVES.swellWidth), dk), d2 = kl.sub(U.swK).div(sg);
        sw.assign(U.swVar.mul(exp(d2.mul(d2).mul(-0.5))).div(sg.mul(2.50662827)).mul(U.swN).mul(pow(max(cs.mul(0.5).add(0.5), 0), U.swS)).div(kl));
      });
      const ap = dk.mul(sqrt(max(psi.mul(fw).add(sw), 0))), am = dk.mul(sqrt(max(psi.mul(float(1).sub(fw)), 0)));
      const w = sqrt(kl.mul(G).add(kl.mul(kl).mul(kl).mul(TS))), m = floor(w.div(TAU / LOOP).add(0.5));
      const ph = fract(m.mul(U.t).div(LOOP)).mul(TAU);
      const fd = float(1).sub(smoothstep(U.omegaMax.mul(0.7), U.omegaMax, w));
      const e = vec2(cos(ph), sin(ph));
      const h = cmul(xi.xy.mul(ap), vec2(e.x, e.y.negate())).add(cmul(vec2(xi.z, xi.w.negate()).mul(am), e)).mul(fd).toVar();
      const gk = kl.mul(G), tk = kl.mul(kl).mul(kl).mul(TS), lam = U.chop.mul(gk.sub(tk)).div(gk.add(tk));
      const kh = k.div(kl), ih = vec2(h.y.negate(), h.x);
      const Dx = ih.mul(lam.mul(kh.x)), Dz = ih.mul(lam.mul(kh.y)), sx = ih.mul(k.x), sz = ih.mul(k.y);
      const Jxx = h.mul(lam.negate().mul(k.x).mul(kh.x)), Jzz = h.mul(lam.negate().mul(k.y).mul(kh.y)), Jxz = h.mul(lam.negate().mul(k.x).mul(kh.y));
      const iz = (v) => vec2(v.y.negate(), v.x);
      const C0 = h.add(iz(Dx)), C1 = Dz.add(iz(sx)), C2 = sz.add(iz(Jxx)), C3 = Jzz.add(iz(Jxz));
      A.element(t).assign(select(hf.equal(0), vec4(C0, C1), vec4(C2, C3)));
    })().compute(W * H, [64]);
    // the Stockham passes: each with its stride and direction built in, ping-ponging A and B
    this.kStages = []; let src = A, dst = B, flips = 0;
    for (const dirY of [0, 1]) for (let Ns = 2; Ns <= N; Ns *= 2) {
      const s = src, d = dst;
      this.kStages.push(Fn(() => {
        const t = int(instanceIndex), px = t.mod(W), py = t.div(W);
        const a = dirY ? py : px, base = a.div(N).mul(N), idx = a.sub(base), hs = Ns / 2;
        const ev = idx.div(Ns).mul(hs).add(idx.mod(hs)), od = ev.add(N / 2);
        const pe = dirY ? py.sub(idx).add(ev).mul(W).add(px) : py.mul(W).add(base).add(ev);
        const po = dirY ? py.sub(idx).add(od).mul(W).add(px) : py.mul(W).add(base).add(od);
        const e = s.element(pe), o = s.element(po);
        const an = float(idx.mod(Ns)).mul(TAU / Ns), w = vec2(cos(an), sin(an));
        d.element(t).assign(vec4(e.xy.add(cmul(w, o.xy)), e.zw.add(cmul(w, o.zw))));
      })().compute(W * H, [64]));
      [src, dst] = [dst, src]; flips++;
    }
    const R = src; // the transformed atlas
    this.result = flips % 2 ? this.bufB : this.bufA;
    this.kAssemble = this.cascades.map((_, c) => Fn(() => {
      const t = int(instanceIndex), x = t.mod(N), y = t.div(N), q = y.mul(W).add(c * N).add(x);
      const sg = select(x.add(y).bitAnd(1).equal(1), float(-1), float(1)); // the grid's wave numbers start at -N/2
      const a = R.element(q).mul(sg), b = R.element(q.add(N * W)).mul(sg);
      // a = (h, Dx, Dz, sx), b = (sz, Jxx, Jzz, Jxz)
      const J = float(1).add(b.y).mul(float(1).add(b.z)).sub(b.w.mul(b.w));
      textureStore(this.disp[c], ivec2(x, y), vec4(a.y, a.x, a.z, J));
      textureStore(this.slope[c], ivec2(x, y), vec4(a.w, b.x, a.w.mul(a.w), b.x.mul(b.x)));
    })().compute(N * N, [64]));
    this.state = null; this.lostSlope = 0; this._statsKey = '';
  }
  // wind: [x, z] at 10 m in m/s; omegaMax: pi * the frame rate (waves faster than that are faded); swell: { Hs, T, turn }
  update(time, wind, omegaMax = Math.PI * 60, swell = null) {
    const U10 = Math.hypot(wind[0], wind[1]), U = this.U, P = this.state = seaState(U10, this.fetch);
    if (U10 > 1e-3) U.windDir.value.set(wind[0] / U10, wind[1] / U10);
    if (swell && swell.Hs > 0) {
      const w = 2 * Math.PI / swell.T, a = swell.turn ?? WAVES.swellTurn, d = U.windDir.value;
      U.swK.value = w * w / WAVES.g; U.swVar.value = (swell.Hs / 4) ** 2; U.swS.value = WAVES.swellS; U.swN.value = swellNorm(WAVES.swellS);
      U.swDir.value.set(d.x * Math.cos(a) - d.y * Math.sin(a), d.x * Math.sin(a) + d.y * Math.cos(a));
    } else U.swVar.value = 0;
    U.kp.value = P.kp; U.cp.value = P.cp; U.om.value = P.Om; U.gamma.value = P.gamma; U.sigma.value = P.sigma;
    U.ap.value = P.ap; U.am.value = P.am; U.onset.value = P.onset; U.amS.value = P.a_m;
    U.t.value = time % WAVES.loop; U.omegaMax.value = omegaMax;
    const key = [Math.round(Math.log(Math.max(U10, 0.05)) * 30), Math.round(Math.log(omegaMax) * 8)].join();
    if (key !== this._statsKey) { this._statsKey = key; const s = fieldStats(P, this.cascades, [U.windDir.value.x, U.windDir.value.y], omegaMax, this.N); this.lostSlope = s.lostS; this.stats = s; }
    const r = this.renderer;
    r.compute(this.kSpectrum);
    for (const k of this.kStages) r.compute(k);
    for (const k of this.kAssemble) r.compute(k);
  }
}
