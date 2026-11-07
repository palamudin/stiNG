// The water's bulk flow on WebGPU: shallow water over the ground round the eye (Chentanez and Mueller 2010's height
// field, here the virtual pipes of Mei et al. 2007: mass kept exactly, wet and dry cells by themselves, stable at a
// frame's step). Nothing but gravity over the floor, the moon's pull and the water's own flow:
//   - each cell holds its water's depth over the ground (exact, from the wild source's WGSL twin) and the flux through
//     each of its four sides; the flux grows with the difference of the water's surfaces (gravity), is held so no cell
//     gives more water than it has, loses a little to friction;
//   - the tide: the open sea's level at the window's sea edges rises and falls (M2, 12.42 h, sped up by the panel's
//     factor), damped into a band of cells there (absorbing what leaves, feeding what comes in): the flood fills the
//     channels and the low beaches, the ebb drains them, the flow runs where the ground lets it;
//   - lakes and rivers held to their own levels slowly (their sources, which the window does not hold).
// The surface reads the water's level offset (the tide's rise and the flow's slope) and its velocity (the currents).
// The window moves with the eye in whole cells, the water carried over.
import * as THREE from 'three/webgpu';
import { Fn, If, float, int, vec2, vec4, uniform, storage, instanceIndex, wgslFn, wgsl, max, min, sqrt, smoothstep, floor, mix, select, cos } from 'three/tsl';
import { WILD_WGSL } from './wild.wgsl.js';

export const SWE = { n: 512, h: 2, sponge: 20, sub: 3, friction: 0.996 };

const groundAt = wgslFn(`fn sweGround(p: vec2<f32>, seed: i32, sea: f32, relief: f32, blocky: f32, rivers: f32, forests: f32, trails: f32) -> vec4<f32> {
  let k = wildParams(seed, sea, relief, blocky, rivers, forests, trails);
  var S: vec4<f32>; var wl: f32; wildSampleW(p, &S, &wl);
  return vec4<f32>(S.x, wl, select(0.0, 1.0, S.x < wl && wl <= sea + 0.5), select(0.0, 1.0, S.x < wl)); // ground, still level, sea, water
}`, [wgsl(WILD_WGSL)]);

export class GpuSWE {
  constructor(renderer, source) {
    const C = SWE, n = C.n, dx = C.h, N2 = n * n, P = source.params;
    this.renderer = renderer; this.sea = source.sea ?? 0;
    const wp = { seed: int(P.seed | 0), sea: float(P.sea ?? source.sea ?? 0), relief: float(P.relief ?? 1), blocky: float(P.blocky ?? 0.6), rivers: float(P.rivers ?? 1), forests: float(P.forests ?? 1), trails: float(P.trails ?? 1) };
    const buf = () => { const a = new THREE.StorageBufferAttribute(new Float32Array(N2 * 4), 4); return [a, storage(a, 'vec4', N2)]; };
    const [, Gr] = buf(), [, Gt] = buf(), [, Hb] = buf(), [, Ht] = buf(), [, Fl] = buf(), [, Ft] = buf();
    [this.outAttr, this.OUT] = buf(); // (water surface offset over the still level, velocity x z, wet)
    this.uOrg = uniform(new THREE.Vector2()); this.uShift = uniform(new THREE.Vector2(), 'ivec2'); this.uTide = uniform(0); this.uDt = uniform(1 / 60);
    this.R = { org: uniform(new THREE.Vector2()), ready: uniform(0) };
    const at = (i, j) => j.clamp(0, n - 1).mul(n).add(i.clamp(0, n - 1));
    const ij = () => { const t = int(instanceIndex); return [t, t.mod(n), t.div(n)]; };
    // the ground of a (new) window, and its water as the still level gives it, at the tide's level on the sea
    this.kGround = Fn(() => { const [t, i, j] = ij(); Gr.element(t).assign(groundAt({ p: this.uOrg.add(vec2(float(i), float(j)).add(0.5).mul(dx)), ...wp })); })().compute(N2, [64]);
    // carry the water over when the window moves (shift in cells; new cells from the still level)
    this.kCarry = Fn(() => {
      const [t, i, j] = ij(), g = Gr.element(t), si = i.add(this.uShift.x), sj = j.add(this.uShift.y);
      const inside = si.greaterThanEqual(0).and(sj.greaterThanEqual(0)).and(si.lessThan(n)).and(sj.lessThan(n));
      const still = g.y.add(this.uTide.mul(g.z)).sub(g.x).max(0).mul(g.w);
      Ht.element(t).assign(select(inside, Hb.element(at(si, sj)), vec4(still, 0, 0, 0)));
      Ft.element(t).assign(select(inside, Fl.element(at(si, sj)), vec4(0)));
    })().compute(N2, [64]);
    this.kCopyT = Fn(() => { const [t] = ij(); Hb.element(t).assign(Ht.element(t)); Fl.element(t).assign(Ft.element(t)); Gt.element(t).assign(Gr.element(t)); })().compute(N2, [64]);
    // the fluxes (right, up, left, down): grown by the surfaces' difference, held to the water the cell has
    this.kFlux = Fn(() => {
      const [t, i, j] = ij(), g = Gt.element(t), d = Hb.element(t).x, eta = g.x.add(d);
      const nb = (di, dj) => { const k = at(i.add(di), j.add(dj)); return Gt.element(k).x.add(Hb.element(k).x); };
      const edge = (di, dj) => select(i.add(di).lessThan(0).or(i.add(di).greaterThanEqual(n)).or(j.add(dj).lessThan(0)).or(j.add(dj).greaterThanEqual(n)), float(0), float(1));
      const k = this.uDt.mul(9.81).mul(dx); // the pipe: area dx^2 over length dx
      const f0 = Fl.element(t);
      const f = vec4(
        max(f0.x.mul(SWE.friction).add(k.mul(eta.sub(nb(1, 0)))), 0).mul(edge(1, 0)),
        max(f0.y.mul(SWE.friction).add(k.mul(eta.sub(nb(0, 1)))), 0).mul(edge(0, 1)),
        max(f0.z.mul(SWE.friction).add(k.mul(eta.sub(nb(-1, 0)))), 0).mul(edge(-1, 0)),
        max(f0.w.mul(SWE.friction).add(k.mul(eta.sub(nb(0, -1)))), 0).mul(edge(0, -1))).toVar();
      const out = f.x.add(f.y).add(f.z).add(f.w), K = min(float(1), d.mul(dx * dx).div(max(out.mul(this.uDt), 1e-6)));
      Ft.element(t).assign(f.mul(K));
    })().compute(N2, [64]);
    // the depths from the fluxes in and out; the velocity from the flux through the cell; the sponge at the window's
    // edges (toward the still level and the tide, the flow toward rest: what leaves is absorbed, the tide comes in);
    // lakes and rivers held to their levels slowly
    this.kDepth = Fn(() => {
      const [t, i, j] = ij(), g = Gt.element(t), f = Ft.element(t);
      const fR = Ft.element(at(i.add(1), j)), fU = Ft.element(at(i, j.add(1))), fL = Ft.element(at(i.sub(1), j)), fD = Ft.element(at(i, j.sub(1)));
      const fin = select(i.greaterThan(0), fL.x, float(0)).add(select(i.lessThan(n - 1), fR.z, float(0))).add(select(j.greaterThan(0), fD.y, float(0))).add(select(j.lessThan(n - 1), fU.w, float(0)));
      const fout = f.x.add(f.y).add(f.z).add(f.w);
      const d0 = Hb.element(t).x, d = d0.add(this.uDt.mul(fin.sub(fout)).div(dx * dx)).max(0).toVar();
      const em = min(min(i, j), min(int(n - 1).sub(i), int(n - 1).sub(j)));
      const sp = smoothstep(float(SWE.sponge), float(0), float(em)).mul(this.uDt).mul(1.5).min(1);
      const target = g.y.add(this.uTide.mul(g.z)).sub(g.x).max(0).mul(g.w);
      const hold = select(g.z.greaterThan(0.5), float(0), float(0.05)).mul(this.uDt).mul(g.w); // lakes and rivers: their sources
      d.assign(mix(d, target, sp.add(hold).min(1)));
      const dm = d.add(d0).mul(0.5).max(0.05);
      const ux = fL.x.sub(f.z).add(f.x).sub(fR.z).mul(0.5).div(dm.mul(dx)), uz = fD.y.sub(f.w).add(f.y).sub(fU.w).mul(0.5).div(dm.mul(dx));
      Hb.element(t).assign(vec4(d, ux.clamp(-6, 6), uz.clamp(-6, 6), 0)); Fl.element(t).assign(f.mul(float(1).sub(sp)));
    })().compute(N2, [64]);
    this.kOut = Fn(() => {
      const [t] = ij(), g = Gt.element(t), H = Hb.element(t), wet = select(H.x.greaterThan(0.01), float(1), float(0));
      const vk = smoothstep(0.02, 0.3, H.x).mul(wet), v = vec2(H.y, H.z).mul(vk), vl = v.length(); // (a film's velocity is noise)
      this.OUT.element(t).assign(vec4(g.x.add(H.x).sub(g.y).mul(wet), v.mul(min(float(1), float(3).div(max(vl, 1e-4)))), wet));
    })().compute(N2, [64]);
    this.cx = null; this.cz = null; this.t = 0;
  }
  // once a frame: the eye, the water's dt, the tide's amplitude (m) and its speed-up (1: the real 12.42 h)
  update(eye, dt, tideAmp = 0.8, tideSpeed = 60) {
    const C = SWE, n = C.n, dx = C.h, half = n * dx / 2, step = 64 * dx, r = this.renderer;
    this.t += dt * tideSpeed; this.uTide.value = tideAmp * Math.cos(2 * Math.PI * this.t / (12.42 * 3600));
    const cx = Math.round(eye.x / step) * step, cz = Math.round(eye.z / step) * step;
    if (cx !== this.cx || cz !== this.cz) {
      const sx = this.cx === null ? n : Math.round((cx - this.cx) / dx), sz = this.cz === null ? n : Math.round((cz - this.cz) / dx);
      this.cx = cx; this.cz = cz;
      this.uOrg.value.set(cx - half, cz - half); this.uShift.value.set(sx, sz);
      r.compute(this.kGround); r.compute(this.kCarry); r.compute(this.kCopyT);
      this.R.org.value.copy(this.uOrg.value); this.R.ready.value = 1;
    }
    const h = Math.min(Math.max(dt, 0), 0.05) / C.sub; this.uDt.value = h;
    for (let s = 0; s < C.sub; s++) { r.compute(this.kFlux); r.compute(this.kDepth); }
    r.compute(this.kOut);
  }
  // the reader: at(p) -> (surface offset over the still level (m), velocity x z, wet), faded off the window
  reader() {
    const C = SWE, n = C.n, dx = C.h, O = storage(this.outAttr, 'vec4', n * n).toReadOnly(), R = this.R;
    return (p) => {
      const u = p.sub(R.org).div(dx).sub(0.5), u0 = floor(u), f = u.sub(u0), i = int(u0.x).clamp(0, n - 2), j = int(u0.y).clamp(0, n - 2);
      const e = (di, dj) => O.element(j.add(dj).mul(n).add(i.add(di)));
      const v = mix(mix(e(0, 0), e(1, 0), f.x), mix(e(0, 1), e(1, 1), f.x), f.y);
      const m = min(min(u.x, u.y), min(float(n - 1).sub(u.x), float(n - 1).sub(u.y)));
      return v.mul(smoothstep(SWE.sponge, SWE.sponge * 2, m)).mul(R.ready);
    };
  }
}
