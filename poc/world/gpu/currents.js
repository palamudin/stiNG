// The surface currents on WebGPU: what moves the water's surface (and the foam on it), from the ground, the waves and
// the wind, baked round the eye when the waves' field is baked (gpu/swellfield.js) and read by the foam:
//   - the rivers' own flow (the wild source: their velocity and share);
//   - the surf's longshore current (Longuet-Higgins 1970): where waves break at an angle to the shore, the momentum
//     they give up drives the water along it, about 1.17 sqrt(g H) sin(a) cos(a) through the breaking zone (a the
//     angle between the waves' rays and the shore's normal, the floor's slope telling where the shore is);
//   - the waves' mass carried shoreward at the surface (Stokes drift, a^2 omega k along the rays);
//   - and the water has to go somewhere: the forced flux (depth times velocity) is made divergence-free over the water
//     (a pressure solve, the land a wall), so the shoreward push returns seaward where the longshore currents meet:
//     rip currents, narrow and fast through the channels, from the shape of the ground and the waves alone.
// The wind's drift (about 3% of the wind at the surface) is added by the reader's user (it is balanced at depth).
import * as THREE from 'three/webgpu';
import { Fn, If, float, int, vec2, vec4, uniform, storage, instanceIndex, wgslFn, wgsl, max, min, sqrt, smoothstep, floor, mix, select, abs } from 'three/tsl';
import { WILD_WGSL } from './wild.wgsl.js';

export const CURRENTS = { n: 384, h: 8, iters: 120 };

const groundAt = wgslFn(`fn cuGround(p: vec2<f32>, cell: f32, seed: i32, sea: f32, relief: f32, blocky: f32, rivers: f32, forests: f32, trails: f32) -> vec4<f32> {
  let k = wildParams(seed, sea, relief, blocky, rivers, forests, trails);
  var S: vec4<f32>; var wl: f32; wildSampleW(p, &S, &wl);
  let fl = wildWaterFlow_1(p, cell);
  return vec4<f32>(max(wl - S.x, 0.0), fl.z * fl.y, fl.w * fl.y, select(0.0, 1.0, S.x < wl)); // depth, river velocity x z, water
}`, [wgsl(WILD_WGSL)]);

export class GpuCurrents {
  // swell: gpu/swellfield.js (its reader, for the waves at each cell)
  constructor(renderer, source, swell) {
    const C = CURRENTS, n = C.n, h = C.h, N2 = n * n, P = source.params;
    this.renderer = renderer;
    const wp = { seed: int(P.seed | 0), sea: float(P.sea ?? source.sea ?? 0), relief: float(P.relief ?? 1), blocky: float(P.blocky ?? 0.6), rivers: float(P.rivers ?? 1), forests: float(P.forests ?? 1), trails: float(P.trails ?? 1) };
    const buf = () => { const a = new THREE.StorageBufferAttribute(new Float32Array(N2 * 4), 4); return [a, storage(a, 'vec4', N2)]; };
    const [, G] = buf(), [, F] = buf(), [, P0] = buf(), [, P1] = buf();
    [this.outAttr, this.OUT] = buf();
    this.uOrg = uniform(new THREE.Vector2()); this.uAmp = uniform(new THREE.Vector2(1, 0.3));
    this.R = { org: uniform(new THREE.Vector2()), ready: uniform(0) };
    const SW = swell.reader(), at = (i, j) => j.clamp(0, n - 1).mul(n).add(i.clamp(0, n - 1));
    const pos = (i, j) => this.uOrg.add(vec2(float(i), float(j)).add(0.5).mul(h));
    this.kGround = Fn(() => { const t = int(instanceIndex); G.element(t).assign(groundAt({ p: pos(t.mod(n), t.div(n)), cell: float(h), ...wp })); })().compute(N2, [64]);
    // the forcing, as a flux (depth times velocity): the surf's longshore push and the waves' surface drift
    this.kForce = Fn(() => {
      const t = int(instanceIndex), i = t.mod(n), j = t.div(n), g = G.element(t), d = g.x;
      const q = vec2(0).toVar();
      If(g.w.greaterThan(0.5), () => {
        const sw = SW.swell(pos(i, j)), A = sw.A0, B = sw.B0, inside = sw.inside;
        const th = A.z, d0 = SW.dir, dirW = d0.mul(th.cos()).add(vec2(d0.y.negate(), d0.x).mul(th.sin()));
        const a = A.y.mul(this.uAmp.x), k = A.w, w = SW.omega.x;
        // the shore's normal from the floor's slope (toward the shallows)
        const gx = G.element(at(i.add(1), j)).x.sub(G.element(at(i.sub(1), j)).x), gz = G.element(at(i, j.add(1))).x.sub(G.element(at(i, j.sub(1))).x);
        const gl = sqrt(gx.mul(gx).add(gz.mul(gz))).max(1e-4), nrm = vec2(gx, gz).div(gl).negate();
        const ca = dirW.dot(nrm), sa = dirW.x.mul(nrm.y).sub(dirW.y.mul(nrm.x)), along = vec2(nrm.y.negate(), nrm.x).mul(select(sa.greaterThan(0), float(-1), float(1)));
        const surf = max(smoothstep(0.0, 0.03, B.w), B.y.mul(0.6)).mul(smoothstep(0.02, 0.2, gl.div(2 * h)).add(0.3).min(1));
        const vL = sqrt(float(9.81).mul(a.mul(2).max(0.01))).mul(1.17).mul(abs(sa.mul(ca))).mul(surf);
        const stokes = a.mul(a).mul(w).mul(k).mul(1.5);
        q.assign(along.mul(vL).add(dirW.mul(stokes)).mul(d.max(0.2)).mul(inside));
      });
      F.element(t).assign(vec4(q, g.w, 0)); P0.element(t).assign(vec4(0)); P1.element(t).assign(vec4(0));
    })().compute(N2, [64]);
    // the pressure solve (Jacobi): lap(p) = div(q) over the water, no flux through the land
    const jac = (A, B) => Fn(() => {
      const t = int(instanceIndex), i = t.mod(n), j = t.div(n), f = F.element(t);
      If(f.z.lessThan(0.5), () => { B.element(t).assign(vec4(0)); });
      If(f.z.greaterThan(0.5), () => {
        const fe = F.element(at(i.add(1), j)), fw = F.element(at(i.sub(1), j)), fn = F.element(at(i, j.add(1))), fs = F.element(at(i, j.sub(1)));
        const div = fe.x.mul(fe.z).sub(fw.x.mul(fw.z)).add(fn.y.mul(fn.z)).sub(fs.y.mul(fs.z)).mul(0.5);
        const p = A.element(t).x;
        // a land neighbour mirrors this cell (no flux through it)
        const pe = select(fe.z.greaterThan(0.5), A.element(at(i.add(1), j)).x, p), pw = select(fw.z.greaterThan(0.5), A.element(at(i.sub(1), j)).x, p);
        const pn = select(fn.z.greaterThan(0.5), A.element(at(i, j.add(1))).x, p), ps = select(fs.z.greaterThan(0.5), A.element(at(i, j.sub(1))).x, p);
        B.element(t).assign(vec4(pe.add(pw).add(pn).add(ps).sub(div).mul(0.25), 0, 0, 0));
      });
    })().compute(N2, [64]);
    this.kJ01 = jac(P0, P1); this.kJ10 = jac(P1, P0);
    // the flow: the forced flux less the pressure's gradient, over the depth; the rivers' own flow on top
    this.kOut = Fn(() => {
      const t = int(instanceIndex), i = t.mod(n), j = t.div(n), f = F.element(t), g = G.element(t), p = P0.element(t).x;
      const pe = select(F.element(at(i.add(1), j)).z.greaterThan(0.5), P0.element(at(i.add(1), j)).x, p), pw = select(F.element(at(i.sub(1), j)).z.greaterThan(0.5), P0.element(at(i.sub(1), j)).x, p);
      const pn = select(F.element(at(i, j.add(1))).z.greaterThan(0.5), P0.element(at(i, j.add(1))).x, p), ps = select(F.element(at(i, j.sub(1))).z.greaterThan(0.5), P0.element(at(i, j.sub(1))).x, p);
      const q = f.xy.sub(vec2(pe.sub(pw), pn.sub(ps)).mul(0.5));
      const u = q.div(g.x.max(0.3)).clamp(-2.5, 2.5).add(g.yz).mul(g.w);
      this.OUT.element(t).assign(vec4(u, g.w, 0));
    })().compute(N2, [64]);
    this.key = null;
  }
  // bake when the eye has moved a sixth of the window or the waves' field has been re-baked (its key changed)
  update(eye, swellKey, amp) {
    const C = CURRENTS, half = C.n * C.h / 2, step = half / 3, cx = Math.round(eye.x / step) * step, cz = Math.round(eye.z / step) * step;
    const key = `${cx},${cz},${swellKey}`;
    if (key === this.key) return;
    this.key = key;
    this.uOrg.value.set(cx - half, cz - half); this.uAmp.value.set(amp, 0);
    const r = this.renderer;
    r.compute(this.kGround); r.compute(this.kForce);
    for (let k = 0; k < C.iters; k++) r.compute(k % 2 ? this.kJ10 : this.kJ01);
    r.compute(this.kOut);
    this.R.org.value.copy(this.uOrg.value); this.R.ready.value = 1;
  }
  // the reader: current(p) -> the surface velocity (m/s, x z), 0 off the window
  reader() {
    const C = CURRENTS, n = C.n, h = C.h, O = storage(this.outAttr, 'vec4', n * n).toReadOnly(), R = this.R;
    return (p) => {
      const u = p.sub(R.org).div(h).sub(0.5), u0 = floor(u), f = u.sub(u0), i = int(u0.x).clamp(0, n - 2), j = int(u0.y).clamp(0, n - 2);
      const e = (di, dj) => O.element(j.add(dj).mul(n).add(i.add(di)));
      const v = mix(mix(e(0, 0), e(1, 0), f.x), mix(e(0, 1), e(1, 1), f.x), f.y);
      const m = min(min(u.x, u.y), min(float(n - 1).sub(u.x), float(n - 1).sub(u.y)));
      return v.xy.mul(smoothstep(1, 12, m)).mul(R.ready);
    };
  }
}
