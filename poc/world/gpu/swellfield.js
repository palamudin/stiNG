// The swell field on WebGPU: how the waves change over the ground, from the ground alone, cached round the eye.
// Nothing here looks at the coastline as such: every cell knows its depth and its river's current (the wild source's
// WGSL twin, exact), and the waves come in from the open water and are shaped by what is under them.
//
// Two marches over grids turned to the direction that matters, each one compute pass (one workgroup walks the rows in
// order, a barrier between rows):
//   - the swell and the wind sea's long waves (two trains, each on a grid whose rows run across its direction; the open
//     sea is their source). Each
//     cell takes its train's local wavenumber from the dispersion relation with the current's Doppler shift
//     (omega = sqrt(g k tanh(k d)) + k U; none where an opposing current runs faster than the waves can: blocked, the
//     river mouth's standing break), and its ray from the row before: the ray turns toward the slower water
//     (d theta/ds = (cos theta dk/dy - sin theta dk/dx) / k: refraction over every shoal, round every island), the
//     phase grows by k along it (crests bend and crowd as the water shoals), and the energy is kept along the ray's
//     tube (wave action: a^2 (cg + U) / sigma times the tube's width; shoaling, focusing over a shoal, spreading in a
//     bay), spread a little sideways (diffraction: no hard shadow behind a headland), and held to the breaking limit
//     (height 0.78 of the depth). The cell keeps the unheld ratio (how near breaking) and whether the wave has broken
//     on its way here (a bore past the break point, fading where the water deepens again).
//   - the fetch: the grid's rows along the wind, the distance the wind has blown over water to reach each cell (reset
//     on land): a lake's waves grow with it, a pond's barely start (the wind sea's height and its longest waves from
//     the fetch, JONSWAP's fetch laws).
// Re-baked when the eye has moved a sixth of a window or the swell or the wind has turned; the surface reads the last
// finished bake (bilinear, the phase unwrapped so it interpolates exactly).
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, float, int, vec2, vec4, uniform, storage, instanceIndex, wgslFn, wgsl, max, min, abs, sqrt, exp, tanh, cos, sin, atan, clamp, smoothstep, floor, mix, select, workgroupBarrier, storageBarrier } from 'three/tsl';
import { WILD_WGSL } from './wild.wgsl.js';

export const SWELLF = { n: 768, h: 4, fn: 512, fh: 8, gamma: 0.78, second: [0.61, 0.45], wg: 256 };
const G = 9.81;

const sampleAt = wgslFn(`fn swGround(p: vec2<f32>, cell: f32, seed: i32, sea: f32, relief: f32, blocky: f32, rivers: f32, forests: f32, trails: f32) -> vec4<f32> {
  let k = wildParams(seed, sea, relief, blocky, rivers, forests, trails);
  var S: vec4<f32>; var wl: f32; wildSampleW(p, &S, &wl);
  let fl = wildWaterFlow_1(p, cell);
  let e = S.x - wl;
  return vec4<f32>(max(-e, 0.0), select(0.0, 1.0, e < 0.0 && wl <= sea + 0.5), fl.z * fl.y, fl.w * fl.y); // depth, sea-connected water, current
}`, [wgsl(WILD_WGSL)]);

export class GpuSwellField {
  constructor(renderer, source) {
    this.renderer = renderer; this.source = source;
    const S = SWELLF, n = S.n, fn = S.fn, WG = S.wg, P = source.params;
    const wp = { seed: int(P.seed | 0), sea: float(P.sea ?? source.sea ?? 0), relief: float(P.relief ?? 1), blocky: float(P.blocky ?? 0.6), rivers: float(P.rivers ?? 1), forests: float(P.forests ?? 1), trails: float(P.trails ?? 1) };
    const buf = (len) => { const a = new THREE.StorageBufferAttribute(new Float32Array(len * 4), 4); return [a, storage(a, 'vec4', len)]; };
    // the work: the ground (depth, sea, current) of the swell grid; each train's march (phase, amplitude, ray angle, k)
    // and (unheld ratio, broken, -, -); the fetch grid's ground and fetch
    const [, GR] = buf(n * n), [, GR1] = buf(n * n), [, W0] = buf(n * n), [, W1] = buf(n * n), [, X0] = buf(n * n), [, X1] = buf(n * n);
    const [, FG] = buf(fn * fn);
    // what the surface reads (copied in when a bake is done)
    [this.rA0, this.RA0] = buf(n * n); [this.rA1, this.RA1] = buf(n * n); [this.rB0, this.RB0] = buf(n * n); [this.rB1, this.RB1] = buf(n * n); [this.rF, this.RF] = buf(fn * fn);
    // the bake's frame (origin corner, its row direction) and the read frame
    this.uOrg = uniform(new THREE.Vector2()); this.uDir = uniform(new THREE.Vector2(1, 0)); this.uOrg1 = uniform(new THREE.Vector2()); this.uDir1 = uniform(new THREE.Vector2(1, 0)); this.uFOrg = uniform(new THREE.Vector2()); this.uFDir = uniform(new THREE.Vector2(1, 0));
    this.uOmega = uniform(new THREE.Vector2(1, 1)); this.uWindU = uniform(5); this.uAmp = uniform(new THREE.Vector2(1, 0.45)); // each train's height on the open sea (m)
    this.R = { org: uniform(new THREE.Vector2()), dir: uniform(new THREE.Vector2(1, 0)), org1: uniform(new THREE.Vector2()), dir1: uniform(new THREE.Vector2(1, 0)), forg: uniform(new THREE.Vector2()), fdir: uniform(new THREE.Vector2(1, 0)), omega: uniform(new THREE.Vector2(1, 1)), ready: uniform(0) };
    const h = S.h, fh = S.fh;
    const ground = (org, dir, cell, i, j) => { const perp = vec2(dir.y.negate(), dir.x), p = org.add(dir.mul(float(i).add(0.5).mul(cell))).add(perp.mul(float(j).add(0.5).mul(cell))); return sampleAt({ p, cell: float(cell), ...wp }); };
    this.kGround1 = Fn(() => { const t = int(instanceIndex); GR1.element(t).assign(ground(this.uOrg1, this.uDir1, h, t.div(n), t.mod(n))); })().compute(n * n, [64]);
    this.kGround = Fn(() => { const t = int(instanceIndex); GR.element(t).assign(ground(this.uOrg, this.uDir, h, t.div(n), t.mod(n))); })().compute(n * n, [64]);
    this.kFGround = Fn(() => { const t = int(instanceIndex); FG.element(t).assign(ground(this.uFOrg, this.uFDir, fh, t.div(fn), t.mod(fn))); })().compute(fn * fn, [64]);
    // the local wavenumber for angular frequency w at depth d with the current Ua along the ray (Newton; -1: blocked)
    const kOf = (w, d, Ua) => {
      const dd = max(d, 0.05), k = w.mul(w).div(G).max(w.div(sqrt(dd.mul(G)))).toVar();
      Loop({ start: 0, end: 10, name: 'nt' }, () => {
        const th = tanh(k.mul(dd)), s = sqrt(k.mul(G).mul(th)), sig = w.sub(k.mul(Ua));
        const ds = float(G).mul(th.add(k.mul(dd).mul(float(1).sub(th.mul(th))))).div(s.mul(2).max(1e-4));
        const f = s.sub(sig), df = ds.add(Ua);
        k.assign(k.sub(f.div(select(abs(df).greaterThan(1e-4), df, float(1e-4)))).clamp(1e-4, 50));
      });
      const th = tanh(k.mul(dd)), sig = sqrt(k.mul(G).mul(th));
      return select(abs(sig.sub(w.sub(k.mul(Ua)))).lessThan(w.mul(0.05)).and(w.sub(k.mul(Ua)).greaterThan(0)), k, float(-1));
    };
    const cgOf = (k, d) => { const kd = k.mul(max(d, 0.05)), th = tanh(kd), c = sqrt(float(G).mul(th).div(k)); return c.mul(float(0.5).add(kd.div(sinhSafe(kd.mul(2))))); };
    const sinhSafe = (x) => { const e = exp(x.min(20)); return e.sub(float(1).div(e)).mul(0.5).max(1e-4); };
    // the swell's march for one train: one workgroup; thread t takes columns t, t + WG, ...; row 0 is the open sea
    const march = (W, X, w, amp, GR) => Fn(() => {
      const t = int(instanceIndex), per = Math.ceil(n / WG);
      for (let c = 0; c < per; c++) {
        const j = t.add(c * WG);
        If(j.lessThan(n), () => {
          const g = GR.element(j), k = kOf(w, g.x, g.z);
          W.element(j).assign(vec4(0, g.y, 0, select(g.y.lessThan(0.5), w.mul(w).div(G), max(k, w.mul(w).div(G))))); X.element(j).assign(vec4(0, 0, 0, 0));
        });
      }
      storageBarrier(); workgroupBarrier();
      Loop({ start: 1, end: n, name: 'row' }, ({ row: i }) => {
        for (let c = 0; c < per; c++) {
          const j = t.add(c * WG);
          If(j.lessThan(n), () => {
            const row = i.mul(n), prow = i.sub(1).mul(n);
            const at = (r, jj) => jj.clamp(0, n - 1).add(r);
            const pw = W.element(at(prow, j)), th0 = pw.z;
            // where the ray to this cell left the row before (in cells across), and that row there, linearly
            const ys = float(j).sub(th0.tan().clamp(-2.5, 2.5)), j0 = int(floor(ys)), f = ys.sub(floor(ys));
            const a0 = W.element(at(prow, j0)), a1 = W.element(at(prow, j0.add(1))), b0 = X.element(at(prow, j0)), b1 = X.element(at(prow, j0.add(1)));
            const q = mix(a0, a1, f), qx = mix(b0, b1, f);
            const g = GR.element(at(row, j)), gp = GR.element(at(prow, j));
            const kRaw = kOf(w, g.x, g.z.mul(cos(q.z)).add(g.w.mul(sin(q.z)))), blocked = kRaw.lessThan(0);
            // (over land the phase runs on at the open sea's wavenumber: the trains meeting again past an island or a spit
            // keep step with the open water's, no seam where they join)
            const k = select(g.y.lessThan(0.5), w.mul(w).div(G), select(blocked, q.w, kRaw)).toVar();
            // the ray turns toward the slower (shorter) water: across the row from the neighbours' k, along from the row
            // before
            const kl = W.element(at(prow, j.sub(1))).w, kr = W.element(at(prow, j.add(1))).w;
            const ky = kr.sub(kl).div(2 * h), kx = k.sub(q.w).div(h);
            const deep = smoothstep(1.5, 3, k.mul(g.x)).mul(g.y); // open water: the floor not felt
            const th = mix(q.z.add(cos(q.z).mul(ky).sub(sin(q.z).mul(kx)).div(max(k, 1e-4)).mul(h).div(max(cos(q.z), 0.3)).clamp(-0.08, 0.08)), float(0), deep.mul(0.04)).clamp(-1.2, 1.2);
            const ph = q.x.add(k.add(q.w).mul(0.5).mul(h).div(max(cos(th), 0.3)));
            // the energy along the ray's tube: how the rays from the row before spread across (their landing offsets'
            // slope), the group speed and the current (wave action), the diffraction's sideways share
            const tl = W.element(at(prow, j.sub(1))).z.tan().clamp(-2.5, 2.5), tr = W.element(at(prow, j.add(1))).z.tan().clamp(-2.5, 2.5);
            const spread = float(1).sub(tr.sub(tl).mul(0.5)).clamp(0.35, 2.5);
            const cg = cgOf(k, g.x), cgp = cgOf(q.w, gp.x), Ua = g.z.mul(cos(th)).add(g.w.mul(sin(th)));
            const sig = w.sub(k.mul(Ua)).max(0.05), sigp = w.sub(q.w.mul(gp.z.mul(cos(q.z)).add(gp.w.mul(sin(q.z))))).max(0.05);
            const act = cgp.div(sigp).div(max(cg.add(Ua), 0.05).div(sig)).mul(spread).max(0);
            const lam = float(6.2832).div(max(k, 1e-3)), D = lam.div(h * 6.2832).mul(0.25).clamp(0, 0.24);
            const al = W.element(at(prow, j0.sub(1))).y, ar = W.element(at(prow, j0.add(2))).y;
            const e2 = q.y.mul(q.y).mul(float(1).sub(D.mul(2))).add(al.mul(al).add(ar.mul(ar)).mul(D)).mul(act);
            // (the open sea is the swell's source: over deep water a lost or spread train recovers toward the far swell's
            // height within a few hundred metres, so a window whose upwind edge is land still has its sea's swell)
            const aFree = mix(sqrt(e2), float(1), deep.mul(0.025)).mul(g.y).mul(select(blocked, float(0), float(1)));
            const cap = g.x.mul(SWELLF.gamma * 0.5).div(max(amp, 0.01)), ratio = aFree.div(max(cap, 1e-3));
            const a = min(aFree, cap);
            const broke = max(qx.y.mul(select(ratio.greaterThan(0.8), float(1), exp(float(-h).div(max(lam, 4))))), select(ratio.greaterThan(1).or(blocked.and(g.y.greaterThan(0.5))), float(1), float(0))).mul(smoothstep(0, 0.15, g.x));
            // how far the wave has run since it broke (m along its ray): the breaker's stage (the lip rising, pitching, falling
            // into the trough, the collapse into a bore), as the travel parameter of Malan's breaking waves
            const since = select(qx.y.greaterThan(0.5), qx.z.add(float(h).div(max(cos(th), 0.3))), float(0)).mul(select(broke.greaterThan(0.5), float(1), float(0)));
            // the energy the wave loses here (its share per metre of travel): to breaking (what the depth limit took), and all
            // of it where a current blocks it; kept a wavelength's way on (the turbulence and the white it leaves). The
            // foam's cause, not a guess: where the floor, a shoal's focusing or a current makes the water give its energy up
            const lost = select(blocked.and(g.y.greaterThan(0.5)), float(1), max(aFree.mul(aFree).sub(a.mul(a)), 0).div(max(aFree.mul(aFree), 1e-4))).div(h);
            const diss = max(lost, qx.w.mul(exp(float(-h).div(max(lam, 4))))).mul(g.y);
            W.element(at(row, j)).assign(vec4(ph, a, th, k)); X.element(at(row, j)).assign(vec4(ratio.min(4), broke, since.min(500), diss.min(1)));
          });
        }
        storageBarrier(); workgroupBarrier();
      });
    })().compute(WG, [WG]);
    // the march's amplitudes are relative to the open sea's (1); the surface scales them by the surf's height
    this.kMarch0 = march(W0, X0, this.uOmega.x, this.uAmp.x, GR); this.kMarch1 = march(W1, X1, this.uOmega.y, this.uAmp.y, GR1);
    // the fetch's march: along the wind, over water; land resets it
    this.kFetch = Fn(() => {
      const t = int(instanceIndex), per = Math.ceil(fn / WG);
      for (let c = 0; c < per; c++) { const j = t.add(c * WG); If(j.lessThan(fn), () => { const g = FG.element(j); FG.element(j).assign(vec4(g.x, g.y, select(g.x.greaterThan(0.05), float(fh), float(0)), 0)); }); }
      storageBarrier(); workgroupBarrier();
      Loop({ start: 1, end: fn, name: 'row' }, ({ row: i }) => {
        for (let c = 0; c < per; c++) {
          const j = t.add(c * WG);
          If(j.lessThan(fn), () => {
            const r = i.mul(fn), g = FG.element(r.add(j)), pf = FG.element(r.sub(fn).add(j)).z;
            const pl = FG.element(r.sub(fn).add(j.sub(1).max(0))).z, pr = FG.element(r.sub(fn).add(j.add(1).min(fn - 1))).z;
            FG.element(r.add(j)).assign(vec4(g.x, g.y, select(g.x.greaterThan(0.05), pf.mul(0.5).add(pl.add(pr).mul(0.25)).add(fh), float(0)), 0));
          });
        }
        storageBarrier(); workgroupBarrier();
      });
    })().compute(WG, [WG]);
    this.kCopy = Fn(() => { const t = int(instanceIndex); this.RA0.element(t).assign(W0.element(t)); this.RA1.element(t).assign(W1.element(t)); this.RB0.element(t).assign(X0.element(t)); this.RB1.element(t).assign(X1.element(t)); })().compute(n * n, [64]);
    this.kCopyF = Fn(() => { const t = int(instanceIndex); this.RF.element(t).assign(FG.element(t)); })().compute(fn * fn, [64]);
    this.key = null; this.fkey = null;
  }
  // when to bake: the eye past a sixth of the window from the last bake's centre, the swell turned or its period
  // changed, the wind turned or the eye moved for the fetch; swDir: the far swell's direction (unit, toward where it
  // goes), T: its period (s), windDir (unit)
  // trains: the far swell (its direction, period, height on the open sea) and the wind sea's longest waves (the wind's
  // direction, the peak period of a sea the wind has built over a long fetch, its height): each on its own grid
  update(eye, swDir, T, windDir, amp = 1, windT = 4, windAmp = 0.3) {
    const S = SWELLF, n = S.n, h = S.h, half = n * h / 2, R = this.R, r = this.renderer, step = half / 3;
    const cx = Math.round(eye.x / step) * step, cz = Math.round(eye.z / step) * step;
    const frame = (dir, uO, uD) => { const d = new THREE.Vector2(dir.x, dir.y).normalize(), perp = new THREE.Vector2(-d.y, d.x); uD.value.copy(d); uO.value.set(cx - d.x * half - perp.x * half, cz - d.y * half - perp.y * half); return d; };
    const w0 = 2 * Math.PI / T, w1 = 2 * Math.PI / windT;
    const k0 = [cx, cz, Math.round(Math.atan2(swDir.y, swDir.x) * 20), Math.round(T * 4), Math.round(amp * 10)].join(',');
    if (k0 !== this.key) { this.key = k0; frame(swDir, this.uOrg, this.uDir); this.uOmega.value.x = w0; this.uAmp.value.x = amp; r.compute(this.kGround); r.compute(this.kMarch0); this._copy = true; R.org.value.copy(this.uOrg.value); R.dir.value.copy(this.uDir.value); R.omega.value.x = w0; }
    const k1 = [cx, cz, Math.round(Math.atan2(windDir.y, windDir.x) * 10), Math.round(windT * 4), Math.round(windAmp * 10)].join(',');
    if (k1 !== this.key1) { this.key1 = k1; frame(windDir, this.uOrg1, this.uDir1); this.uOmega.value.y = w1; this.uAmp.value.y = windAmp; r.compute(this.kGround1); r.compute(this.kMarch1); this._copy = true; R.org1.value.copy(this.uOrg1.value); R.dir1.value.copy(this.uDir1.value); R.omega.value.y = w1; }
    if (this._copy) { this._copy = false; r.compute(this.kCopy); R.ready.value = 1; }
    const fn = S.fn, fh = S.fh, fhalf = fn * fh / 2;
    const fkey = [Math.round(eye.x / (fhalf / 3)), Math.round(eye.z / (fhalf / 3)), Math.round(Math.atan2(windDir.y, windDir.x) * 10)].join(',');
    if (fkey !== this.fkey) {
      this.fkey = fkey;
      const d = new THREE.Vector2(windDir.x, windDir.y).normalize(), perp = new THREE.Vector2(-d.y, d.x);
      const cx = Math.round(eye.x / (fhalf / 3)) * (fhalf / 3), cz = Math.round(eye.z / (fhalf / 3)) * (fhalf / 3);
      this.uFDir.value.copy(d); this.uFOrg.value.set(cx - d.x * fhalf - perp.x * fhalf, cz - d.y * fhalf - perp.y * fhalf);
      const r = this.renderer; r.compute(this.kFGround); r.compute(this.kFetch); r.compute(this.kCopyF);
      R.forg.value.copy(this.uFOrg.value); R.fdir.value.copy(d);
    }
  }
  // the reader (TSL, one per stage: the storage reads bind where they are built): at world p,
  //   swell(p) -> { A0: (phase, amplitude, ray angle, k), A1, B0: (unheld ratio, broken), B1, inside: 0..1 }
  //   fetch(p) -> metres of water upwind (a large number off the window: open water)
  reader() {
    const S = SWELLF, n = S.n, h = S.h, fn = S.fn, fh = S.fh, R = this.R;
    const A0 = storage(this.rA0, 'vec4', n * n).toReadOnly(), A1 = storage(this.rA1, 'vec4', n * n).toReadOnly(), B0 = storage(this.rB0, 'vec4', n * n).toReadOnly(), B1 = storage(this.rB1, 'vec4', n * n).toReadOnly(), F = storage(this.rF, 'vec4', fn * fn).toReadOnly();
    const local = (p, org, dir, cell) => { const q = p.sub(org); return vec2(q.dot(dir), q.dot(vec2(dir.y.negate(), dir.x))).div(cell).sub(0.5); };
    const bil = (B, N, u) => {
      const u0 = floor(u), f = u.sub(u0), i = int(u0.x).clamp(0, N - 2), j = int(u0.y).clamp(0, N - 2);
      const e = (di, dj) => B.element(i.add(di).mul(N).add(j.add(dj)));
      return mix(mix(e(0, 0), e(0, 1), f.y), mix(e(1, 0), e(1, 1), f.y), f.x);
    };
    const edge = (u, N) => { const m = min(min(u.x, u.y), min(float(N - 1).sub(u.x), float(N - 1).sub(u.y))); return smoothstep(2, 24, m); };
    return {
      swell: (p) => { const u = local(p, R.org, R.dir, h), u1 = local(p, R.org1, R.dir1, h); return { A0: bil(A0, n, u), A1: bil(A1, n, u1), B0: bil(B0, n, u), B1: bil(B1, n, u1), inside: edge(u, n).mul(R.ready), inside1: edge(u1, n).mul(R.ready) }; },
      fetch: (p) => { const u = local(p, R.forg, R.fdir, fh); return mix(float(1e5), bil(F, fn, u).z, edge(u, fn)); },
      dir: R.dir, dir1: R.dir1, omega: R.omega, amp: this.uAmp,
    };
  }
}
