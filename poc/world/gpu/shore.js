// The shore table on WebGPU (WEBGPU.md, water step 3): shorefield.js's bake as compute passes over storage buffers,
// and its reader as TSL. The same table and the same answers: per world chunk at three levels (128 m at 0.5 m texels,
// 1 km at 4 m, 4 km at 16 m), each 256 x 256 texels of (signed distance to the water line, direction to it times the
// front's coherence, the shallow-water travel time from it), baked once when the chunk first comes near:
//   heights above the water over the chunk and a margin, from the wild source's WGSL twin (exact, no view in it);
//   seeds at the water-line crossings; jump flooding (Rong and Tan 2006) for the nearest crossing; the eikonal
//   |grad tau| = 1 / sqrt(g depth) by Jacobi sweeps of the Godunov update (Zhao 2005) from the seeds; the signed
//   distance and travel time; the direction and coherence from tau's gradient over a wide stencil; into the slot.
// Every pass a kernel over the bake window; the flood and the sweeps alternate between fixed buffer pairs, so each
// direction is its own kernel and only the flood's step changes between dispatches.
import * as THREE from 'three/webgpu';
import { Fn, If, Return, Loop, float, int, uint, vec2, vec4, ivec2, uniform, uniformArray, storage, instanceIndex, wgslFn, wgsl, abs, min, max, sqrt, clamp, smoothstep, distance, length, floor, select, mix } from 'three/tsl';
import { SHORE } from '../shorefield.js';
import { WILD_WGSL } from './wild.wgsl.js';

const G = 9.81, FAR = [1.0e4, 0, 0, 1.0e4];

export class GpuShore {
  constructor(renderer, source, cfg = {}) {
    this.cfg = { ...SHORE, ...cfg };
    const C = this.cfg, T = C.tex, M = C.levels.reduce((a, L) => Math.max(a, Math.ceil(L.margin / L.s)), 0), W = T + 2 * M;
    this.renderer = renderer; this.source = source; this.W = W; this.M = M; this.T = T;
    this.levels = C.levels.map((L, k) => ({ ...L, k, chunk: L.s * T, slotBase: C.levels.slice(0, k).reduce((a, l) => a + l.slots, 0), slots: Array.from({ length: L.slots }, () => ({ cx: null, cz: null, used: 0 })) }));
    const nSlots = this.nSlots = C.levels.reduce((a, L) => a + L.slots, 0);
    this.tabAttr = new THREE.StorageBufferAttribute(new Float32Array(nSlots * T * T * 4), 4);
    this.tab = storage(this.tabAttr, 'vec4', nSlots * T * T);
    const buf = () => { const a = new THREE.StorageBufferAttribute(new Float32Array(W * W * 4), 4); return [a, storage(a, 'vec4', W * W)]; };
    const [, H] = buf(), [, S] = buf(), [, A] = buf(), [, B] = buf(), [, Tb] = buf(), [, E] = buf();
    this.uOrg = uniform(new THREE.Vector2()); this.uCell = uniform(1); this.uStep = uniform(1, 'int'); this.uMarginM = uniform(0); this.uSlot = uniform(0, 'int');
    const P = source.params, wp = { seed: int(P.seed | 0), sea: float(P.sea ?? source.sea ?? 0), relief: float(P.relief ?? 1), blocky: float(P.blocky ?? 0), rivers: float(P.rivers ?? 1), forests: float(P.forests ?? 1), trails: float(P.trails ?? 1) };
    const eAt = wgslFn(`fn shoreEAt(p: vec2<f32>, seed: i32, sea: f32, relief: f32, blocky: f32, rivers: f32, forests: f32, trails: f32) -> f32 {
  let k = wildParams(seed, sea, relief, blocky, rivers, forests, trails);
  var S: vec4<f32>; var wl: f32; wildSampleW(p, &S, &wl); return S.x - wl;
}`, [wgsl(WILD_WGSL)]);
    const Wm = W - 1, dMin = C.dMin, dMax = C.dMax;
    const uv = () => { const t = int(instanceIndex); return [t, t.mod(W), t.div(W)]; };
    const at = (x, y) => y.mul(W).add(x);
    const inside = (x, y) => x.greaterThanEqual(0).and(y.greaterThanEqual(0)).and(x.lessThanEqual(Wm)).and(y.lessThanEqual(Wm));
    const cl = (v) => v.clamp(0, Wm);
    const pAt = (x, y) => this.uOrg.add(vec2(float(x), float(y)).add(0.5).mul(this.uCell));
    // the window's heights above the water
    this.kHeight = Fn(() => { const [t, x, y] = uv(); H.element(t).assign(vec4(eAt({ p: pAt(x, y), ...wp }), 0, 0, 1)); })().compute(W * W, [64]);
    // the seed: the nearest water-line crossing with the four neighbours
    this.kSeed = Fn(() => {
      const [t, x, y] = uv(), p = pAt(x, y), e0 = H.element(t).x.toVar();
      const best = vec2(0).toVar(), bd = float(1e9).toVar(), has = float(0).toVar();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const vx = x.add(dx), vy = y.add(dy);
        If(inside(vx, vy), () => {
          const e1 = H.element(at(vx, vy)).x;
          If(e0.lessThan(0).notEqual(e1.lessThan(0)), () => {
            const f = e0.div(e0.sub(e1)), d = f.mul(this.uCell);
            If(d.lessThan(bd), () => { bd.assign(d); best.assign(p.add(vec2(dx, dy).mul(f).mul(this.uCell))); has.assign(1); });
          });
        });
      }
      S.element(t).assign(vec4(best, has, e0));
    })().compute(W * W, [64]);
    // one flood pass at uStep
    const flood = (src, dst) => Fn(() => {
      const [t, x, y] = uv(), p = pAt(x, y), me = src.element(t).toVar();
      const bd = select(me.z.greaterThan(0.5), distance(me.xy, p), float(1e9)).toVar(), best = me.toVar();
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const vx = x.add(this.uStep.mul(di)), vy = y.add(this.uStep.mul(dj));
        If(inside(vx, vy), () => {
          const c = src.element(at(vx, vy));
          If(c.z.greaterThan(0.5), () => { const d = distance(c.xy, p); If(d.lessThan(bd), () => { bd.assign(d); best.assign(vec4(c.xy, 1, me.w)); }); });
        });
      }
      dst.element(t).assign(best);
    })().compute(W * W, [64]);
    this.kFloodSA = flood(S, A); this.kFloodAB = flood(A, B); this.kFloodBA = flood(B, A);
    const slowAt = (x, y) => { const e = H.element(at(cl(x), cl(y))).x; const dep = select(e.lessThan(0), e.negate(), float(dMin)).clamp(dMin, dMax); return this.uCell.div(sqrt(dep.mul(G))); };
    this.kEikInit = Fn(() => {
      const [t, x, y] = uv(), sd = S.element(t);
      Tb.element(t).assign(vec4(select(sd.z.greaterThan(0.5), distance(sd.xy, pAt(x, y)).div(this.uCell).mul(slowAt(x, y)), float(1e9)), 0, 0, 1));
    })().compute(W * W, [64]);
    const eik = (src, dst) => Fn(() => {
      const [t, x, y] = uv(), tAt = (vx, vy) => src.element(at(cl(vx), cl(vy))).x;
      const t0 = tAt(x, y).toVar(), f = slowAt(x, y).toVar();
      const a = min(tAt(x.sub(1), y), tAt(x.add(1), y)).toVar(), b = min(tAt(x, y.sub(1)), tAt(x, y.add(1))).toVar();
      const lo = min(a, b), hi = max(a, b), r = t0.toVar();
      If(lo.lessThanEqual(1e8), () => {
        const d = hi.sub(lo);
        const tn = select(d.greaterThanEqual(f), lo.add(f), a.add(b).add(sqrt(max(f.mul(f).mul(2).sub(d.mul(d)), 0))).mul(0.5));
        r.assign(min(t0, tn));
      });
      dst.element(t).assign(vec4(r, 0, 0, 1));
    })().compute(W * W, [64]);
    this.kEikTE = eik(Tb, E); this.kEikET = eik(E, Tb);
    // distance (the flood's, A) and travel time (the sweeps', Tb), signed, into B
    this.kFinal = Fn(() => {
      const [t, x, y] = uv(), p = pAt(x, y), s = A.element(t).toVar(), e = s.w, water = e.lessThan(0), Tt = Tb.element(t).x;
      const dist = distance(s.xy, p);
      If(s.z.lessThan(0.5).or(dist.greaterThan(this.uMarginM)).or(Tt.greaterThan(1e8)), () => {
        B.element(t).assign(select(water, vec4(-1e4, 0, 0, 1e4), vec4(1e4, 0, 0, -1e4))); Return();
      });
      const dep0 = select(water, e.negate(), float(dMin)).clamp(dMin, dMax);
      B.element(t).assign(vec4(select(water, dist.negate(), dist), dep0, 0, select(water, Tt, Tt.negate())));
    })().compute(W * W, [64]);
    // the direction and coherence from tau's gradient over a wide stencil, the chunk's texels into the slot
    this.uR = uniform(2, 'int');
    this.kPack = Fn(() => {
      const t = int(instanceIndex), x = t.mod(T).add(M), y = t.div(T).add(M), v = B.element(at(x, y)).toVar();
      const o = this.uSlot.mul(T * T).add(t);
      If(abs(v.x).greaterThan(9e3), () => { this.tab.element(o).assign(v); Return(); });
      const e = v.w, R = this.uR;
      const tauAt = (vx, vy) => { const q = B.element(at(cl(vx), cl(vy))); return select(abs(q.x).greaterThan(9e3), e, q.w); };
      const g = vec2(tauAt(x.add(R), y).sub(tauAt(x.sub(R), y)), tauAt(x, y.add(R)).sub(tauAt(x, y.sub(R)))).div(float(R).mul(2).mul(this.uCell)).toVar();
      If(v.x.greaterThanEqual(0), () => { g.assign(g.negate()); }); // up the beach tau falls away from the line
      const gl = length(g), dir = select(gl.greaterThan(1e-7), g.negate().div(gl), vec2(0));
      const coh = smoothstep(0.45, 0.85, gl.mul(sqrt(v.y.mul(G))));
      this.tab.element(o).assign(vec4(v.x, dir.mul(coh), v.w));
    })().compute(T * T, [64]);
    // the reader's uniforms: per level (texel, chunk size, directory origin x, z); the directory, 4 slots a vec4
    const D = C.dirN, nD = this.levels.length * D * D / 4;
    this.lvVals = this.levels.map(() => new THREE.Vector4()); this.dirVals = Array.from({ length: nD }, () => new THREE.Vector4(-1, -1, -1, -1));
    this.uOn = uniform(0);
    this.frame = 0; this.stats = { bakes: 0, held: 0 };
  }

  _bake(L, slotIdx, cx, cz) {
    const r = this.renderer, M = this.M, mt = Math.ceil(L.margin / L.s);
    this.uOrg.value.set(cx * L.chunk - M * L.s, cz * L.chunk - M * L.s); this.uCell.value = L.s; this.uMarginM.value = mt * L.s;
    this.uR.value = Math.max(2, Math.round(this.cfg.gradM / L.s)); this.uSlot.value = L.slotBase + slotIdx;
    r.compute(this.kHeight); r.compute(this.kSeed);
    let first = true, inA = true;
    for (let s = 1 << (Math.ceil(Math.log2(this.W)) - 1); s >= 1; s >>= 1) {
      this.uStep.value = s;
      if (first) { r.compute(this.kFloodSA); first = false; inA = true; } else { r.compute(inA ? this.kFloodAB : this.kFloodBA); inA = !inA; }
    }
    if (!inA) r.compute(this.kFloodBA); // the flood's result in A (one more pass at step 1 changes nothing)
    r.compute(this.kEikInit);
    for (let i = 0; i < this.cfg.sweeps; i += 2) { r.compute(this.kEikTE); r.compute(this.kEikET); }
    r.compute(this.kFinal); r.compute(this.kPack);
    this.stats.bakes++;
  }

  // once a frame: the 3 x 3 chunks round the eye at each level baked if not held (perFrame at most; all for a build),
  // the directory pointed at the eye's neighbourhood
  update(eye, all = false) {
    const C = this.cfg, D = C.dirN; this.frame++;
    let budget = all ? 1e9 : C.perFrame;
    for (const L of this.levels) {
      const ex = Math.floor(eye.x / L.chunk), ez = Math.floor(eye.z / L.chunk), want = [];
      for (let dz = -C.near; dz <= C.near; dz++) for (let dx = -C.near; dx <= C.near; dx++) want.push([ex + dx, ez + dz, dx * dx + dz * dz]);
      want.sort((a, b) => a[2] - b[2]);
      for (const [cx, cz] of want) {
        let slot = L.slots.find((S) => S.cx === cx && S.cz === cz);
        if (slot) { slot.used = this.frame; continue; }
        if (budget <= 0) continue;
        slot = L.slots.find((S) => S.cx === null) || L.slots.reduce((a, S) => (S.used < a.used ? S : a), L.slots[0]);
        this._bake(L, L.slots.indexOf(slot), cx, cz); slot.cx = cx; slot.cz = cz; slot.used = this.frame; budget--;
      }
      const ox = ex - D / 2, oz = ez - D / 2, base = L.k * (D * D / 4);
      this.lvVals[L.k].set(L.s, L.chunk, ox, oz);
      for (let i = 0; i < D * D / 4; i++) this.dirVals[base + i].set(-1, -1, -1, -1);
      L.slots.forEach((S, i) => {
        if (S.cx === null) return;
        const dx = S.cx - ox, dz = S.cz - oz; if (dx < 0 || dz < 0 || dx >= D || dz >= D) return;
        const idx = dz * D + dx; this.dirVals[base + (idx >> 2)].setComponent(idx & 3, L.slotBase + i);
      });
    }
    this.uOn.value = 1;
    this.stats.held = this.levels.reduce((a, L) => a + L.slots.filter((S) => S.cx !== null).length, 0);
  }

  // a reader for one shader stage (its own nodes over the same values, as gpu/clip.js reads): read(p) returns
  // { v: (signed distance, direction times coherence, travel time), know }, inline (shorefield.js shoreAt)
  reader() {
    const C = this.cfg, D = C.dirN, T = this.T, nL = this.levels.length;
    const Lv = uniformArray(this.lvVals, 'vec4'), Dir = uniformArray(this.dirVals, 'vec4'), tab = storage(this.tabAttr, 'vec4', this.nSlots * T * T).toReadOnly(), on = this.uOn;
    const slotC = (l, c) => { // the slot holding chunk c of level l, -1 for none
      const L = Lv.element(l), q = c.sub(ivec2(L.zw)), r = int(-1).toVar();
      If(q.x.greaterThanEqual(0).and(q.y.greaterThanEqual(0)).and(q.x.lessThan(D)).and(q.y.lessThan(D)), () => {
        const i = q.y.mul(D).add(q.x), v = Dir.element(int(l * (D * D / 4)).add(i.shiftRight(2))), k = i.bitAnd(3);
        r.assign(int(select(k.equal(0), v.x, select(k.equal(1), v.y, select(k.equal(2), v.z, v.w)))));
      });
      return r;
    };
    const tap = (l, slot, cc, i) => {
      const st = ivec2(select(i.x.lessThan(0), int(-1), select(i.x.greaterThanEqual(T), int(1), int(0))), select(i.y.lessThan(0), int(-1), select(i.y.greaterThanEqual(T), int(1), int(0))));
      const s = slot.toVar(), ii = i.toVar(), out = vec4(...FAR).toVar();
      If(st.x.notEqual(0).or(st.y.notEqual(0)), () => { s.assign(slotC(l, cc.add(st))); ii.assign(i.sub(st.mul(T))); });
      If(s.greaterThanEqual(0), () => { out.assign(tab.element(s.mul(T * T).add(ii.y.mul(T)).add(ii.x))); });
      return out;
    };
    const readL = (l, slot, p) => {
      const L = Lv.element(l), cc = ivec2(floor(p.div(L.y))), o = vec2(cc).mul(L.y), g = p.sub(o).div(L.x).sub(0.5), g0 = floor(g), f = g.sub(g0), i = ivec2(g0);
      const a = tap(l, slot, cc, i), b = tap(l, slot, cc, i.add(ivec2(1, 0))), c = tap(l, slot, cc, i.add(ivec2(0, 1))), d = tap(l, slot, cc, i.add(ivec2(1, 1)));
      const s = vec4(0).toVar(), w = float(0).toVar();
      for (const [t, wt] of [[a, float(1).sub(f.x).mul(float(1).sub(f.y))], [b, f.x.mul(float(1).sub(f.y))], [c, float(1).sub(f.x).mul(f.y)], [d, f.x.mul(f.y)]]) If(abs(t.x).lessThan(9e3), () => { s.addAssign(t.mul(wt)); w.addAssign(wt); });
      return select(w.greaterThan(1e-4), s.div(w), vec4(...FAR));
    };
    return (p) => {
      const v = vec4(...FAR).toVar(), wv = float(0).toVar(), know = float(0).toVar(), done = float(0).toVar();
      If(on.greaterThan(0.5), () => {
        for (let l = 0; l < nL; l++) {
          If(done.lessThan(0.5), () => {
            const L = Lv.element(l), slot = slotC(l, ivec2(floor(p.div(L.y))));
            If(slot.greaterThanEqual(0), () => {
              const u = readL(l, slot, p).toVar();
              If(abs(u.x).lessThanEqual(9e3), () => {
                If(wv.lessThanEqual(0), () => {
                  v.assign(u); wv.assign(float(1).sub(smoothstep(0.75 * C.levels[l].margin, C.levels[l].margin, abs(u.x))));
                  know.assign(l === nL - 1 ? wv : float(1));
                  If(wv.greaterThanEqual(1), () => { done.assign(1); });
                }).Else(() => { know.assign(1); v.assign(mix(u, v, wv)); done.assign(1); }); // the coarser level takes over past the finer one's margin
              });
            });
          });
        }
      });
      return { v, know };
    };
  }
}
