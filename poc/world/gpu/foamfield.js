// The foam field on WebGPU (water3/foamfield.js as a compute pass): foam that lasts and travels. A grid of foam
// amounts round the camera, world-anchored (read and written by world position, so it stays put as the camera moves),
// updated once a frame:
//   - carried from upstream (semi-Lagrangian): shoreward in the surf zone along the shore table's direction, drifting
//     with the wind elsewhere;
//   - lingering: fading over the linger time;
//   - made where the open sea folds (whitecaps: the 85 m and 12 m cascades' Jacobian), where the surf breaks (its
//     crest's whitewater: water3/swash.js w3Coast, converted) and by the shoreline's own foam over the water and the
//     sand the swash covers.
// Two buffers: the pass reads the field and writes the next, a copy puts it back, so the surface always reads one.
import * as THREE from 'three/webgpu';
import { Fn, If, Return, float, int, vec2, vec3, vec4, uniform, storage, instanceIndex, texture, wgslFn, wgsl, max, min, exp, clamp, smoothstep, floor, mix, select, log2 } from 'three/tsl';
import { COAST_WGSL } from './coast.wgsl.js';
import { SWASH } from '../water3/swash.js';
const SWASH_UP = SWASH.up;

export const GFOAM = { near: { n: 256, texel: 0.5 }, far: { n: 256, texel: 8.0 } }; // 128 m and 2 km round the camera
const coastCode = wgsl(COAST_WGSL);
const cField = wgslFn('fn fCoastField(p: vec2<f32>, sh: vec4<f32>, know: f32, depth: f32, cell: f32, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> mat4x4<f32> { return coastFieldAt(p, sh, know, depth, cell, surf, surfX, t, swDir); }', [coastCode]);
const cFoam = wgslFn('fn fCoastFoam(xz: vec2<f32>, depth: f32, grad: vec2<f32>, wave: f32, fl: f32, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> vec4<f32> { return coastShoreFoam(xz, depth, grad, wave, fl, surf, surfX, t, swDir); }', [coastCode]);

export class GpuFoamField {
  // opts: clip, waves, shore (or null), surfU (gpu/water.js surfUniforms), level (GFOAM.near / .far)
  constructor(renderer, opts) {
    const L = this.L = opts.level || GFOAM.near, n = L.n, TX = L.texel, W = this.W = n * TX;
    this.renderer = renderer;
    this.aAttr = new THREE.StorageBufferAttribute(new Float32Array(n * n), 1); this.bAttr = new THREE.StorageBufferAttribute(new Float32Array(n * n), 1);
    const A = storage(this.aAttr, 'float', n * n), B = storage(this.bAttr, 'float', n * n);
    this.uOrigin = uniform(new THREE.Vector2()); this.uPrev = uniform(new THREE.Vector2()); this.uDt = uniform(0); this.uLinger = uniform(4); this.uDrift = uniform(new THREE.Vector2());
    this.uBias = uniform(0.05); this.uScale = uniform(1.3);
    const SWr = opts.swell ? opts.swell.reader() : null; this.uWindU = uniform(5);
    const RC = opts.clip.reads(TX < 1 ? 'FFN' : 'FFF'), shR = opts.shore ? opts.shore.reader() : null, S = opts.surfU, waves = opts.waves;
    const surf = { surf: S.uSurf, surfX: S.uSurfX, t: S.uWTime, swDir: S.uSwDir };
    const L1 = waves.cascades[1], L2 = waves.cascades[2], N = waves.N;
    const lod1 = Math.max(0, Math.log2(TX * N / L1)), lod2 = Math.max(0, Math.log2(TX * N / L2));
    // the previous field at p, bilinear over its window (0 outside)
    const prevAt = (p) => {
      const g = p.sub(this.uPrev).div(TX).sub(0.5), g0 = floor(g), f = g.sub(g0), i = int(g0.x), j = int(g0.y);
      const tap = (di, dj) => { const x = i.add(di), y = j.add(dj); return select(x.greaterThanEqual(0).and(y.greaterThanEqual(0)).and(x.lessThan(n)).and(y.lessThan(n)), A.element(y.mul(n).add(x)), float(0)); };
      return mix(mix(tap(0, 0), tap(1, 0), f.x), mix(tap(0, 1), tap(1, 1), f.x), f.y);
    };
    this.kStep = Fn(() => {
      const t = int(instanceIndex), x = t.mod(n), y = t.div(n);
      const p = this.uOrigin.add(vec2(float(x), float(y)).add(0.5).mul(TX)).toVar();
      const level = RC.clipWater(p).toVar(), bed = RC.clipAt(p).x.toVar(), depth = level.sub(bed).toVar();
      If(depth.lessThanEqual(-2), () => { B.element(t).assign(0); Return(); }); // the sand past the swash's reach
      const v = vec2(this.uDrift).toVar(), make = float(0).toVar(), wet = depth.greaterThan(0).toVar(), wave = float(0).toVar();
      // whitecaps: the open water folding (the 85 m and 12 m cascades' Jacobian), at the folds the texel can hold
      const J = float(1).add(texture(waves.disp[1], p.div(L1)).level(lod1).w.sub(1).mul(smoothstep(0.6, 5, depth))).add(texture(waves.disp[2], p.div(L2)).level(lod2).w.sub(1).mul(smoothstep(0.2, 2, depth)));
      // (on a lake or a pond, as much as its fetch lets the wind build the folding waves: gpu/swellfield.js)
      const wc = float(1).toVar();
      if (SWr) { const F = SWr.fetch(p), U = max(this.uWindU, 1), wp = float(22).mul(float(96.24).div(U.mul(max(F, 1))).pow(1 / 3)); wc.assign(F.div(U.mul(U).mul(2243)).clamp(0, 1).sqrt().mul(smoothstep(0.1, 0.5, float(61.6).div(wp.mul(wp)).div(L2)))); }
      make.assign(float(0.6).add(this.uBias).sub(J).mul(this.uScale).clamp(0, 1).mul(0.5).mul(wc));
      if (shR) {
        const sea = level.lessThanEqual(S.uSea.add(0.5));
        // the surf: its crest's whitewater, made in proportion to the wave that broke; the foam behind carried shoreward
        If(depth.greaterThan(0).and(sea), () => {
          if (SWr) { // the swell field's breakers (gpu/swellfield.js): broken waves' crests make white, carried along their rays
            const sw = SWr.swell(p), ph = sw.A0.x.sub(SWr.omega.x.mul(S.uWTime)), psi = ph.add(Math.PI).mod(2 * Math.PI).sub(Math.PI).negate();
            const a = sw.A0.y.mul(S.uSurf.x), inF = sw.inside.mul(float(1).sub(smoothstep(0.7, 2.2, sw.A0.w.mul(depth))));
            // made where the wave gives up its energy (the field's loss: breaking on the floor, a shoal's focus, a current's
            // block), on the crest's front and its tail; the open water's whitecaps weighted by the wave energy the field has
            // brought here (more over a focusing shoal, less in a headland's shadow)
            const loss = smoothstep(0.0, 0.04, sw.B0.w);
            const ww = max(loss, sw.B0.y.mul(0.3)).mul(inF).mul(smoothstep(-0.9, -0.1, psi)).mul(exp(psi.max(0).mul(-0.9))).mul(smoothstep(0.05, 0.3, a));
            make.mulAssign(mix(float(1), sw.A0.y.mul(sw.A0.y).clamp(0.2, 2.5), sw.inside));
            wave.assign(ww); make.assign(max(make, ww.mul(0.8)));
            const th = sw.A0.z, d0 = SWr.dir, dirW = d0.mul(th.cos()).add(vec2(d0.y.negate(), d0.x).mul(th.sin()));
            v.addAssign(dirW.mul(depth.max(0.1).mul(9.81).sqrt()).mul(0.25).mul(inF));
          }
          if (!SWr) {
            const sh = shR(p), m = cField({ p, sh: sh.v, know: sh.know, depth, cell: float(TX), ...surf }).toVar();
            If(m.element(0).w.greaterThan(0.5), () => {
              const big = smoothstep(0.1, 0.9, S.uSurf.x.mul(m.element(0).y).mul(m.element(0).z));
              wave.assign(m.element(0).x);
              make.assign(max(make, m.element(0).x.mul(mix(0.55, 1, big))));
              v.addAssign(m.element(1).xy.mul(m.element(0).y).mul(0.25));
            });
          }
        });
        // the shoreline's own foam over the water by the line and the sand the swash covers
        If(depth.lessThan(0.8).and(sea).and(S.uSurf.x.greaterThan(0)), () => {
          const e = max(float(0.35), float(TX));
          const grad = vec2(RC.clipAtSmooth(p.add(vec2(e, 0))).x.sub(RC.clipAtSmooth(p.sub(vec2(e, 0))).x), RC.clipAtSmooth(p.add(vec2(0, e))).x.sub(RC.clipAtSmooth(p.sub(vec2(0, e))).x)).div(e.mul(2));
          const sf = cFoam({ xz: p, depth, grad, wave, fl: float(0), ...surf }).toVar();
          If(sf.y.greaterThan(0), () => { wet.assign(true); make.assign(max(make, sf.x.mul(0.9))); });
          // the foam rides the swash: up the slope with the climb, back down with the backwash, so it leaves the sand the
          // way it came (seaward), never sideways; its fading is the same linger as the water's foam
          const gl = grad.length(), down = select(gl.greaterThan(1e-4), grad.div(gl).negate(), vec2(0));
          const climb = sf.z.lessThan(SWASH_UP), spd = S.uSurf.x.mul(9.81).mul(2).sqrt().mul(0.6);
          v.addAssign(down.mul(select(climb, spd.negate(), spd.mul(0.7))).mul(smoothstep(-0.05, 0.05, sf.y)));
        });
      }
      If(wet.not(), () => { B.element(t).assign(0); Return(); });
      const prev = prevAt(p.sub(v.mul(this.uDt)));
      // fresh foam is as thick as the breaking that makes it (not piled up past it: a band of solid white), a little more
      // where breaking goes on, and fades over the linger time where it stops, eroding into lace as it thins
      const kept = prev.mul(exp(this.uDt.negate().div(max(this.uLinger, 0.05))));
      B.element(t).assign(RC.bind(vec4(min(max(kept, make).add(make.mul(this.uDt).mul(0.3)), 1))).x);
    })().compute(n * n, [64]);
    this.kCopy = Fn(() => { const t = int(instanceIndex); A.element(t).assign(B.element(t)); })().compute(n * n, [64]);
    this._init = false;
    // what the surface reads: amount(p) bilinear over the window, and inside(p) its edge's fade
    this.read = () => {
      const R = storage(this.aAttr, 'float', n * n).toReadOnly(), O = this.uOrigin;
      return (p) => {
        const u = p.sub(O).div(W), e = min(min(u.x, u.y), min(float(1).sub(u.x), float(1).sub(u.y)));
        const g = p.sub(O).div(TX).sub(0.5), g0 = floor(g), f = g.sub(g0), i = int(g0.x).clamp(0, n - 2), j = int(g0.y).clamp(0, n - 2);
        const at = (di, dj) => R.element(j.add(dj).mul(n).add(i.add(di)));
        const v = mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y);
        const k = smoothstep(0, 0.08, e);
        return { v, k };
      };
    };
  }
  // once a frame: dt of the water's clock, the camera, the wind (m/s), linger (s)
  update(dt, camera, wind, linger = 4) {
    const L = this.L, half = this.W / 2;
    this.uPrev.value.copy(this.uOrigin.value);
    this.uOrigin.value.set(Math.floor((camera.position.x - half) / L.texel) * L.texel, Math.floor((camera.position.z - half) / L.texel) * L.texel);
    if (!this._init) { this.uPrev.value.copy(this.uOrigin.value); this._init = true; }
    this.uDt.value = Math.min(Math.max(dt, 0), 0.1); this.uLinger.value = linger; this.uDrift.value.set(wind[0] * 0.03, wind[1] * 0.03); this.uWindU.value = Math.hypot(wind[0], wind[1]);
    this.renderer.compute(this.kStep); this.renderer.compute(this.kCopy);
  }
}
