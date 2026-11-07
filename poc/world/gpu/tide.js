// The tide on WebGPU, as an observed cycle replayed, not simulated: the planet's tide arrives from the open sea as a
// wave hundreds of kilometres long, so over our few kilometres the open water just rises and falls together
// (eta = A cos(omega t), M2: 12.42 h); what the ground does to it is the local part, and it is the same every cycle, so
// it is solved once and kept as a complex amplitude per cell (the harmonic constants a tide table gives for a harbour):
//   eta(x, t) = A Re(Z(x) e^{i omega t}),  u(x, t) = A Re(U(x) e^{i omega t})
// Z: into shallow, narrow, frictional water (a lagoon behind its inlet, a marsh, a river's mouth) the tide travels as a
// damped diffusive wave (the linear shallow water equations with bed friction r: D = g h^2 / r, skin depth
// delta = sqrt(2 D / omega)), so it arrives later and smaller: Z = exp(-(1 + i) tau), tau = the integral of ds / delta
// along the cheapest path from the open sea (a min-path relaxation over the window's cells, baked when the eye has
// moved a sixth of the window). Low ground the tide can reach floods and drains with it (its tau through it).
// U: the flow that carries the water in and out, from the momentum equation in the frequency domain,
// U = -g grad(Z) / (i omega + r / h): fast through the inlets and the channels, slack at high and low water.
// At run time a cell's tide is a few multiplications.
import * as THREE from 'three/webgpu';
import { Fn, If, float, int, vec2, vec4, uniform, storage, instanceIndex, wgslFn, wgsl, max, min, sqrt, exp, cos, sin, smoothstep, floor, mix, select } from 'three/tsl';
import { WILD_WGSL } from './wild.wgsl.js';

export const TIDE = { n: 256, h: 16, iters: 260, period: 12.42 * 3600, r: 0.0025, maxAmp: 3 };

const groundAt = wgslFn(`fn tdGround(p: vec2<f32>, seed: i32, sea: f32, relief: f32, blocky: f32, rivers: f32, forests: f32, trails: f32) -> vec4<f32> {
  let k = wildParams(seed, sea, relief, blocky, rivers, forests, trails);
  var S: vec4<f32>; var wl: f32; wildSampleW(p, &S, &wl);
  return vec4<f32>(S.x, sea - S.x, select(0.0, 1.0, S.x < wl && wl <= sea + 0.5), 0.0); // ground, depth under the still sea, sea water
}`, [wgsl(WILD_WGSL)]);

export class GpuTide {
  constructor(renderer, source) {
    const C = TIDE, n = C.n, dx = C.h, N2 = n * n, P = source.params, w = 2 * Math.PI / C.period;
    this.renderer = renderer; this.w = w;
    const wp = { seed: int(P.seed | 0), sea: float(P.sea ?? source.sea ?? 0), relief: float(P.relief ?? 1), blocky: float(P.blocky ?? 0.6), rivers: float(P.rivers ?? 1), forests: float(P.forests ?? 1), trails: float(P.trails ?? 1) };
    const buf = () => { const a = new THREE.StorageBufferAttribute(new Float32Array(N2 * 4), 4); return [a, storage(a, 'vec4', N2)]; };
    const [, G] = buf(), [, T0] = buf(), [, T1] = buf();
    [this.zAttr, this.Z] = buf(); // (Z re, im, the flow's depth h, reach): U is taken from Z's gradient where it is read
    this.uOrg = uniform(new THREE.Vector2());
    this.R = { org: uniform(new THREE.Vector2()), phase: uniform(0), amp: uniform(0.8), ready: uniform(0) };
    const at = (i, j) => j.clamp(0, n - 1).mul(n).add(i.clamp(0, n - 1));
    const ij = () => { const t = int(instanceIndex); return [t, t.mod(n), t.div(n)]; };
    // the depth the tide's flow works through: the still water's, and over low ground half the tide's reach
    const hOf = (g) => max(g.y.add(C.maxAmp * 0.25), 0.05);
    const passable = (g) => g.z.greaterThan(0.5).or(g.y.greaterThan(-C.maxAmp));
    this.kGround = Fn(() => { const [t, i, j] = ij(); G.element(t).assign(groundAt({ p: this.uOrg.add(vec2(float(i), float(j)).add(0.5).mul(dx)), ...wp })); })().compute(N2, [64]);
    // tau: 0 on the open sea (deep water, or the sea at the window's edge), the cheapest path's sum of ds / delta inward
    this.kInit = Fn(() => {
      const [t, i, j] = ij(), g = G.element(t), edge = min(min(i, j), min(int(n - 1).sub(i), int(n - 1).sub(j))).lessThan(2);
      const open = g.z.greaterThan(0.5).and(g.y.greaterThan(25).or(edge));
      T0.element(t).assign(vec4(select(open, float(0), float(1e9)), 0, 0, 0));
    })().compute(N2, [64]);
    const delta = (h) => h.mul(h).mul(9.81 / C.r).mul(2 / w).sqrt(); // sqrt(2 D / omega), D = g h^2 / r
    const sweep = (A, B) => Fn(() => {
      const [t, i, j] = ij(), g = G.element(t), tau = A.element(t).x.toVar();
      If(passable(g), () => {
        const dl = delta(hOf(g));
        for (const [di, dj, s] of [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]]) {
          const k = at(i.add(di), j.add(dj)), gn = G.element(k);
          const step = float(dx * s).div(dl.add(delta(hOf(gn))).mul(0.5));
          tau.assign(min(tau, A.element(k).x.add(select(passable(gn), step, float(1e9)))));
        }
      });
      B.element(t).assign(vec4(tau, 0, 0, 0));
    })().compute(N2, [64]);
    this.kAB = sweep(T0, T1); this.kBA = sweep(T1, T0);
    // Z: the damped, lagged tide (and the depth its flow works through)
    this.kOut = Fn(() => {
      const [t] = ij(), g = G.element(t), ta = T0.element(t).x.min(30), e = exp(ta.negate());
      const reach = select(passable(g).and(T0.element(t).x.lessThan(1e8)), float(1), float(0));
      this.Z.element(t).assign(vec4(e.mul(cos(ta)).mul(reach), e.mul(sin(ta)).negate().mul(reach), hOf(g), reach));
    })().compute(N2, [64]);
    this.cx = null; this.cz = null; this.t = 0;
  }
  // once a frame: the eye, dt, the tide's amplitude (m) and its speed-up (1: real time)
  update(eye, dt, amp = 0.8, speed = 60) {
    const C = TIDE, n = C.n, dx = C.h, half = n * dx / 2, step = half / 3, r = this.renderer;
    this.t += dt * speed; this.R.phase.value = (this.w * this.t) % (2 * Math.PI); this.R.amp.value = Math.min(amp, C.maxAmp);
    const cx = Math.round(eye.x / step) * step, cz = Math.round(eye.z / step) * step;
    if (cx === this.cx && cz === this.cz) return;
    this.cx = cx; this.cz = cz; this.uOrg.value.set(cx - half, cz - half);
    r.compute(this.kGround); r.compute(this.kInit);
    for (let k = 0; k < C.iters; k++) r.compute(k % 2 ? this.kBA : this.kAB);
    r.compute(this.kOut);
    this.R.org.value.copy(this.uOrg.value); this.R.ready.value = 1;
  }
  // the reader: at(p) -> (the tide's height over the still level (m), its current x z (m/s), reached 0/1)
  reader() {
    const C = TIDE, n = C.n, dx = C.h, R = this.R, Z = storage(this.zAttr, 'vec4', n * n).toReadOnly(), w = this.w;
    const bil = (p) => {
      const u = p.sub(R.org).div(dx).sub(0.5), u0 = floor(u), f = u.sub(u0), i = int(u0.x).clamp(0, n - 2), j = int(u0.y).clamp(0, n - 2);
      const e = (di, dj) => Z.element(j.add(dj).mul(n).add(i.add(di)));
      const m = min(min(u.x, u.y), min(float(n - 1).sub(u.x), float(n - 1).sub(u.y)));
      return { z: mix(mix(e(0, 0), e(1, 0), f.x), mix(e(0, 1), e(1, 1), f.x), f.y), e: smoothstep(2, 10, m) };
    };
    // off the window: the open sea's tide (Z = 1)
    const zAt = (p) => { const b = bil(p); return vec4(mix(float(1), b.z.x, b.e), b.z.y.mul(b.e), b.z.z, mix(float(1), b.z.w, b.e)); };
    return (p) => {
      const z = zAt(p), c = cos(R.phase), s = sin(R.phase), k = z.w.mul(R.ready);
      const eta = z.x.mul(c).sub(z.y.mul(s)).mul(R.amp).mul(k);
      // its flow: U = -g grad Z / (i omega + r / h), from Z a cell either side
      const gx = zAt(p.add(vec2(dx, 0))).xy.sub(zAt(p.sub(vec2(dx, 0))).xy).div(2 * dx), gz = zAt(p.add(vec2(0, dx))).xy.sub(zAt(p.sub(vec2(0, dx))).xy).div(2 * dx);
      const a = float(C.r).div(max(z.z, 0.05)), den = a.mul(a).add(w * w);
      const cdiv = (q) => vec2(q.x.mul(a).add(q.y.mul(w)), q.y.mul(a).sub(q.x.mul(w))).div(den).mul(-9.81);
      const ux = cdiv(gx), uz = cdiv(gz);
      const vel = vec2(ux.x.mul(c).sub(ux.y.mul(s)), uz.x.mul(c).sub(uz.y.mul(s))).mul(R.amp).mul(k).mul(smoothstep(0, 0.3, z.z)).clamp(-3, 3);
      return vec4(eta, vel, k);
    };
  }
}
