// The clipmap on WebGPU (World v3, WEBGPU.md): the same nested levels as clipmap.js (12 levels of 128 x 128 texels,
// each twice as coarse as the one inside it, snapped to its own cells, morphing into its parent near its edge), held
// in two storage buffers instead of array render targets and filled by a compute pass instead of a draw:
//   ground: (height, moisture, forest, trail), from the wild source's WGSL twin (gpu/wild.wgsl.js wildSample);
//   water:  (level, the river's share, its velocity x, z), parted round the river rocks (wildWaterFlow with a cell).
// A texel of world index (i, j) at level l sits at l * 16384 + (j & 127) * 128 + (i & 127), as in clipmap.js, so a
// level that moves refills only the window it moved to and the reads never change.
// The reads (clipAt, clipHeight, clipWater, clipFlow, clipNormal) are TSL functions any node material or kernel uses.
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, Break, float, int, uint, vec2, vec3, vec4, ivec2, uniform, uniformArray, storage, instanceIndex, wgslFn, wgsl, abs, max, floor, clamp, mix, normalize } from 'three/tsl';
import { CLIP } from '../clipmap.js';
import { WILD_WGSL } from './wild.wgsl.js';
import { wildUniforms } from '../sources/wild.js';

const W = 128, PER = W * W;

export class GpuClip {
  constructor(renderer, source, cfg = {}) {
    this.cfg = { ...CLIP, ...cfg };
    const C = this.cfg, n = C.levels * PER;
    this.renderer = renderer; this.source = source; this.sea = source.sea;
    this.groundBuf = new THREE.StorageBufferAttribute(new Float32Array(n * 4), 4);
    this.waterBuf = new THREE.StorageBufferAttribute(new Float32Array(n * 4), 4);
    this.ground = storage(this.groundBuf, 'vec4', n).setName('clipGround');
    this.water = storage(this.waterBuf, 'vec4', n).setName('clipWater');
    this.lv = [];
    for (let l = 0; l < C.levels; l++) { const s = C.base * 2 ** l; this.lv.push({ s, H: (C.cells / 2) * s, ci: 0, cj: 0, wi: null, wj: null, fade: 0, ready: false }); }
    this.uLv = uniformArray(this.lv.map(() => new THREE.Vector4()), 'vec4'); // centre x, z, cell size, half extent
    this.uFade = uniformArray(this.lv.map(() => 0), 'float');
    this.stats = { gpuLevels: 0 };
    this._kernels();
    Object.assign(this, this.reads('')); // clipAt, clipSurface, clipFinest, clipWater, clipFlow, clipNormal...
  }

  // one kernel per level fill: 128 x 128 threads, each a texel of the window (ni, nj)
  _kernels() {
    const U = wildUniforms(this.source.params);
    this.uWin = uniform(new THREE.Vector2()); this.uCell = uniform(1); this.uLevel = uniform(0, 'int');
    this.uParams = [uniform(U.wSeed.value, 'int'), uniform(U.wSea.value), uniform(U.wRelief.value), uniform(U.wBlocky.value), uniform(U.wRivers.value), uniform(U.wForests.value), uniform(U.wTrails.value)];
    const fill = wgslFn(`fn clipFillAt(p: vec2<f32>, cell: f32, seed: i32, sea: f32, relief: f32, blocky: f32, rivers: f32, forests: f32, trails: f32, which: i32) -> vec4<f32> {
  let k = wildParams(seed, sea, relief, blocky, rivers, forests, trails);
  if (which == 0) { return wildSample(p); }
  return wildWaterFlow_1(p, cell);
}`, [wgsl(WILD_WGSL)]);
    const P = this.uParams, args = (p, which) => ({ p, cell: this.uCell, seed: P[0], sea: P[1], relief: P[2], blocky: P[3], rivers: P[4], forests: P[5], trails: P[6], which: int(which) });
    const body = (which, buf) => Fn(() => {
      const a = int(instanceIndex.mod(W)), b = int(instanceIndex.div(W));
      const i = int(this.uWin.x).add(a), j = int(this.uWin.y).add(b);
      const p = vec2(float(i), float(j)).mul(this.uCell);
      const slot = this.uLevel.mul(PER).add(j.bitAnd(127).mul(W)).add(i.bitAnd(127));
      buf.element(slot).assign(fill(args(p, which)));
    })().compute(PER, [64]);
    this.kGround = body(0, this.ground); this.kWater = body(1, this.water);
  }

  // the reads, as clipmap.js glsl(): texel, level (split triangles), morph, surface, finest, and the rest
  // A set of them per use (tag): a storage buffer read inside a shared function is bound only in the stage that
  // built it first, so the vertex and the fragment stages of a material each take their own set
  reads(tag) {
    const C = this.cfg, last = C.levels - 1, n = C.levels * PER, Lv = uniformArray(this.uLv.array, 'vec4'), Fd = uniformArray(this.uFade.array, 'float'); // own nodes over the same values: a uniform read only inside shared functions is bound only in the stage that built it first
    const G = storage(this.groundBuf, 'vec4', n).toReadOnly(), Wt = storage(this.waterBuf, 'vec4', n).toReadOnly();
    const o = {};
    const slot = (l, i, j) => l.mul(PER).add(j.bitAnd(127).mul(W)).add(i.bitAnd(127));
    const tri = (buf) => Fn(([l, p]) => {
      const s = Lv.element(l).z, g = p.div(s), g0 = floor(g), f = g.sub(g0).toVar(), i = int(g0.x), j = int(g0.y);
      const a = buf.element(slot(l, i, j)), b = buf.element(slot(l, i.add(1), j)), c = buf.element(slot(l, i, j.add(1))), d = buf.element(slot(l, i.add(1), j.add(1)));
      const r = vec4(0).toVar();
      If(f.x.greaterThan(f.y), () => { r.assign(a.add(b.sub(a).mul(f.x)).add(d.sub(b).mul(f.y))); }).Else(() => { r.assign(a.add(d.sub(c).mul(f.x)).add(c.sub(a).mul(f.y))); });
      return r;
    });
    const level = tri(G).setLayout({ name: 'clipLevel' + tag, type: 'vec4', inputs: [{ name: 'l', type: 'int' }, { name: 'p', type: 'vec2' }] });
    const levelW = tri(Wt).setLayout({ name: 'clipLevelW' + tag, type: 'vec4', inputs: [{ name: 'l', type: 'int' }, { name: 'p', type: 'vec2' }] });
    // bilinear instead of the mesh's split triangles: for tests along a contour (the swash's line), where the triangles'
    // flat facets draw a contour as a sawtooth
    const bil = Fn(([l, p]) => {
      const s = Lv.element(l).z, g = p.div(s), g0 = floor(g), f = g.sub(g0), i = int(g0.x), j = int(g0.y);
      const a = G.element(slot(l, i, j)), b = G.element(slot(l, i.add(1), j)), c = G.element(slot(l, i, j.add(1))), d = G.element(slot(l, i.add(1), j.add(1)));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }).setLayout({ name: 'clipLevelB' + tag, type: 'vec4', inputs: [{ name: 'l', type: 'int' }, { name: 'p', type: 'vec2' }] });
    const morph = Fn(([l, p]) => {
      const q = abs(p.sub(Lv.element(l).xy)), m = max(q.x, q.y), s = Lv.element(l).z;
      const e = clamp(m.sub(Lv.element(l).w.sub(s.mul(C.band0))).div(s.mul(C.band0 - C.band1)), 0, 1);
      return max(e, float(1).sub(Fd.element(l)));
    }).setLayout({ name: 'clipMorph' + tag, type: 'float', inputs: [{ name: 'l', type: 'int' }, { name: 'p', type: 'vec2' }] });
    const finest = Fn(([p]) => {
      const r = int(last).toVar();
      Loop({ start: int(0), end: int(last), type: 'int', condition: '<' }, ({ i }) => {
        const q = abs(p.sub(Lv.element(i).xy));
        If(max(q.x, q.y).lessThan(Lv.element(i).w), () => { r.assign(i); Break(); });
      });
      return r;
    }).setLayout({ name: 'clipFinest' + tag, type: 'int', inputs: [{ name: 'p', type: 'vec2' }] });
    const surface = Fn(([l, p]) => {
      const v = level(l, p).toVar();
      If(l.lessThan(last), () => { const k = morph(l, p); If(k.greaterThan(0), () => { v.assign(mix(v, level(l.add(1), p), k)); }); });
      return v;
    }).setLayout({ name: 'clipSurface' + tag, type: 'vec4', inputs: [{ name: 'l', type: 'int' }, { name: 'p', type: 'vec2' }] });
    o.clipFinest = finest; o.clipSurface = surface; o.clipLevel = level;
    o.clipAt = Fn(([p]) => surface(finest(p), p)).setLayout({ name: 'clipAt' + tag, type: 'vec4', inputs: [{ name: 'p', type: 'vec2' }] });
    o.clipHeight = (p) => o.clipAt(p).x;
    // the water layer: the finest level's texels, no morph (as clipmap.js clipWater / clipFlow)
    o.clipWaterAll = Fn(([p]) => levelW(finest(p), p)).setLayout({ name: 'clipWaterAll' + tag, type: 'vec4', inputs: [{ name: 'p', type: 'vec2' }] });
    o.clipWater = (p) => o.clipWaterAll(p).x;
    o.clipFlow = (p) => o.clipWaterAll(p).yzw;
    o.clipNormal = Fn(([p]) => {
      const l = finest(p), e = Lv.element(l).z;
      const hx = surface(l, p.add(vec2(e, 0))).x.sub(surface(l, p.sub(vec2(e, 0))).x);
      const hz = surface(l, p.add(vec2(0, e))).x.sub(surface(l, p.sub(vec2(0, e))).x);
      return normalize(vec3(hx.negate(), e.mul(2), hz.negate()));
    }).setLayout({ name: 'clipNormal' + tag, type: 'vec3', inputs: [{ name: 'p', type: 'vec2' }] });
    // a value with a zero-weighted read of this set's uniforms and buffers added: a node read only inside shared
    // functions may not be declared in a stage's module (three.js 0.186), so a material's stage body passes its
    // result through this once
    o.clipAtSmooth = Fn(([p]) => {
      const l = finest(p), v = bil(l, p).toVar();
      If(l.lessThan(last), () => { const k = morph(l, p); If(k.greaterThan(0), () => { v.assign(mix(v, bil(l.add(1), p), k)); }); });
      return v;
    }).setLayout({ name: 'clipAtSmooth' + tag, type: 'vec4', inputs: [{ name: 'p', type: 'vec2' }] });
    o.cellAt = (p) => Lv.element(finest(p)).z; // the finest level's texel at p (its triangles are flat: a slope over less is a step)
    o.bind = (v) => v.add(Lv.element(0).x.add(Fd.element(0)).add(G.element(0).x).add(Wt.element(0).x).mul(0));
    return o;
  }

  // re-centre every level on (x, z); a level whose window drifted past the margin is refilled on the GPU
  update(x, z, dt) {
    const C = this.cfg, half = W / 2;
    this.stats.gpuLevels = 0;
    for (let l = C.levels - 1; l >= 0; l--) {
      const L = this.lv[l];
      L.ci = Math.round(x / L.s); L.cj = Math.round(z / L.s);
      const drift = L.wi === null ? Infinity : Math.max(Math.abs(L.ci - (L.wi + half)), Math.abs(L.cj - (L.wj + half)));
      if (drift > C.margin) {
        const ni = L.ci - half, nj = L.cj - half;
        const overlap = L.wi === null ? 0 : Math.max(0, W - Math.abs(ni - L.wi)) * Math.max(0, W - Math.abs(nj - L.wj)) / PER;
        if (overlap < 0.5) { L.fade = 0; L.ready = false; }
        this._fill(l, ni, nj); L.wi = ni; L.wj = nj; L.ready = true;
      }
    }
    const k = dt / C.fadeTime;
    for (let l = C.levels - 1; l >= 0; l--) {
      const L = this.lv[l], parentReady = l === C.levels - 1 || this.lv[l + 1].ready;
      if (L.ready && parentReady) L.fade = Math.min(1, L.fade + k); else if (!L.ready) L.fade = 0;
      this.uLv.array[l].set(L.ci * L.s, L.cj * L.s, L.s, L.H);
      this.uFade.array[l] = L.fade;
    }
  }
  build(x, z) {
    for (const L of this.lv) { L.wi = L.wj = null; L.ready = false; L.fade = 0; }
    this.update(x, z, 0); for (const L of this.lv) L.fade = 1; this.update(x, z, 0);
  }
  _fill(l, ni, nj) {
    this.uWin.value.set(ni, nj); this.uCell.value = this.lv[l].s; this.uLevel.value = l;
    this.renderer.compute(this.kGround); this.renderer.compute(this.kWater);
    this.stats.gpuLevels++;
  }
}
