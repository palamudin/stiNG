// The woods on WebGPU (WEBGPU.md): GPU-driven. Each frame one compute pass walks every cell of the 5.2 m grid
// within the trees' reach round the eye and, for each:
//   - places its tree by the same rules, hashes and grid as scatter.js (and trees.js PLACE_GLSL), reading the GPU
//     clipmap for the ground, the water, the forest and the slope: nothing is placed or held per tree in JS;
//   - culls it against the view (a sphere round the tree against the six planes of the frame widened 5%); a tree
//     out of view is kept only within the sun's shadow reach, so it still shades what is seen;
//   - picks its level of detail by its distance from the eye (FOREST.bands, scaled by the range), with the bands'
//     dithered overlap: a tree in an overlap goes in both levels, each with its share;
//   - appends it to its list (kind, variant, level) with an atomic counter.
// A second pass writes each list's count into its indirect draw and clears the counters. Every list is one indirect
// draw of the card mesh (treecards.js), reading its trees from the instance buffer by its own offset. No tiles, no
// thinning, no CPU work per tree: what is drawn is what is in view, out to the range.
import * as THREE from 'three/webgpu';
import { Fn, If, Return, float, int, uint, vec2, vec3, vec4, uniform, uniformArray, storage, instanceIndex, attribute, texture, screenCoordinate, positionLocal, positionWorld, cameraPosition, cameraViewMatrix, wgslFn, wgsl, sin, cos, length, min, max, mix, smoothstep, clamp, select, floor, fract, atomicAdd, atomicLoad, atomicStore, normalize, dot, uv } from 'three/tsl';
import { treeDesign, meshTreeCards, leafAtlas } from '../treecards.js';
import { FOREST } from '../trees.js';
import { WILD_WGSL } from './wild.wgsl.js';

const KINDS = ['oak', 'birch', 'pine', 'bush'];
const CAPS = [4096, 16384, 32768]; // instances per list, by level
const MAX_CELLS = 440 * 440; // the grid at the longest reach (ultra, 200%)
const PER_KV = CAPS[0] + CAPS[1] + CAPS[2], OFF = [0, CAPS[0], CAPS[0] + CAPS[1]];
const wildCode = wgsl(WILD_WGSL);
const h01 = wgslFn('fn fH01(x: i32, y: i32, s: i32) -> f32 { return w2hash01_(x, y, s); }', [wildCode]);
const n2 = wgslFn('fn fNoise(p: vec2<f32>, s: i32) -> f32 { return w2noise(p, s); }', [wildCode]);
const ign = wgslFn('fn fIgn(p: vec2<f32>) -> f32 { return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))); }');

export class GpuForest {
  constructor(renderer, clip, source, opts = {}) {
    this.renderer = renderer; this.clip = clip; this.source = source;
    this.cfg = { ...FOREST, ...opts };
    this.nk = KINDS.length; this.nv = this.cfg.variants;
    this.lists = this.nk * this.nv * 3;
    this.range = opts.range ?? 1; this.rangeK = 1;
    this.group = new THREE.Group(); this.group.name = 'gpu-forest';
    // the instance data: two vec4 per tree (x, y, z, turn), (horizontal scale, vertical scale, variety, fade)
    const nInst = this.nk * this.nv * PER_KV;
    this.instAttr = new THREE.StorageBufferAttribute(new Float32Array(nInst * 8), 4);
    this.inst = storage(this.instAttr, 'vec4', nInst * 2);
    this.instR = storage(this.instAttr, 'vec4', nInst * 2).toReadOnly();
    this.cntAttr = new THREE.StorageBufferAttribute(new Uint32Array(this.lists), 1);
    this.cnt = storage(this.cntAttr, 'uint', this.lists).toAtomic();
    this.args = new THREE.IndirectStorageBufferAttribute(new Uint32Array(this.lists * 5), 5);
    this.argsS = storage(this.args, 'uint', this.lists * 5);
    // the view: six planes, the eye, the bands, the grid's origin
    this.uPlanes = uniformArray([0, 1, 2, 3, 4, 5].map(() => new THREE.Vector4()), 'vec4');
    this.uEye = uniform(new THREE.Vector3()); this.uOrg = uniform(new THREE.Vector2()); this.uN = uniform(1, 'int');
    this.uBands = uniform(new THREE.Vector4()); this.uFade = uniform(this.cfg.fade); this.uShadowR = uniform(opts.shadowR ?? 60);
    this.uTime = uniform(0); this.uWind = uniform(new THREE.Vector2(3, 1));
    this.stats = { cells: 0, lists: this.lists, ms: 0 };
    this._meshes();
    this._kernels();
    this.setRange(1);
  }

  setRange(k) { this.rangeK = k; const B = this.cfg.bands.map((b) => b * this.range * k); this.uBands.value.set(B[1], B[2], B[3], 0); this.R = B[3] + this.cfg.fade * 3; }

  _meshes() {
    const atlas = leafAtlas(), tex = new THREE.DataTexture(atlas.data, atlas.size, atlas.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = true; tex.needsUpdate = true;
    this.atlas = tex;
    // one material per level, shared by every list of that level: the list's place in the instance buffer comes from
    // the object drawn (uBase)
    this.mats = [0, 1, 2].map((l) => this._material(l));
    this.meshes = [];
    for (let k = 0; k < this.nk; k++) for (let v = 0; v < this.nv; v++) {
      const d = treeDesign(KINDS[k], v + 1, { trunk: true });
      for (let l = 0; l < 3; l++) {
        const m = meshTreeCards(d, l), g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
        g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
        g.setAttribute('aSway', new THREE.BufferAttribute(m.sway, 1));
        g.setAttribute('aLeaf', new THREE.BufferAttribute(m.leaf, 1));
        g.setAttribute('aCtr', new THREE.BufferAttribute(m.ctr, 3));
        g.setIndex(m.idx);
        const id = (k * this.nv + v) * 3 + l;
        this.args.array.set([m.idx.length, 0, 0, 0, 0], id * 5);
        g.setIndirect(this.args, id * 20);
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
        const mesh = new THREE.Mesh(g, this.mats[l]);
        mesh.frustumCulled = false; mesh.castShadow = l < 2; mesh.receiveShadow = true;
        mesh.userData.base = (k * this.nv + v) * PER_KV + OFF[l];
        mesh.name = `tree ${KINDS[k]} ${v} L${l}`;
        this.group.add(mesh); this.meshes.push(mesh);
      }
    }
    this.args.needsUpdate = true;
  }

  _material(lod) {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    const uBase = uniform(0, 'int').onObjectUpdate(({ object }) => object.userData.base);
    const I = this.instR, slot = uBase.add(int(instanceIndex)).mul(2);
    const d0 = I.element(slot), d1 = I.element(slot.add(1));
    const aSway = attribute('aSway', 'float'), aLeaf = attribute('aLeaf', 'float'), aCtr = attribute('aCtr', 'vec3');
    mat.positionNode = Fn(() => {
      const t = positionLocal.toVar();
      const ph = d1.z.mul(6.283).add(d0.x.mod(4096).mul(0.13)).add(d0.z.mod(4096).mul(0.17));
      const ws = length(this.uWind), wd = select(ws.greaterThan(0.001), this.uWind.div(ws), vec2(1, 0));
      // the whole tree leans and rocks with the wind, more toward the top; leaf clusters shift with the gusts
      const sway = float(0.45).add(sin(this.uTime.mul(1.05).add(ph)).mul(0.35)).add(sin(this.uTime.mul(2.6).add(ph.mul(1.7))).mul(0.2)).mul(ws);
      t.xz.addAssign(wd.mul(sway).mul(aSway).mul(0.32));
      If(aLeaf.greaterThan(0.5), () => {
        const fq = float(5).add(fract(aCtr.x.mul(7.1)).mul(3)), fp = aCtr.y.mul(3).add(ph);
        const fl = float(0.04).add(ws.mul(0.06)).mul(sin(this.uTime.mul(fq).add(fp))), fs = float(0.03).add(ws.mul(0.04)).mul(sin(this.uTime.mul(fq).mul(0.8).add(fp).add(1.7)));
        t.addAssign(vec3(wd.x.mul(fl).sub(wd.y.mul(fs)), fs.mul(0.3), wd.y.mul(fl).add(wd.x.mul(fs))).mul(min(1, length(aCtr))));
      });
      const cs = cos(d0.w), sn = sin(d0.w);
      const r = vec3(cs.mul(t.x).sub(sn.mul(t.z)), t.y, sn.mul(t.x).add(cs.mul(t.z))).mul(vec3(d1.x, d1.y, d1.x));
      return r.add(vec3(d0.x, d0.y.sub(d1.y.mul(0.12)), d0.z));
    })();
    // the normal turned with the tree, in view space as the node material wants it (the meshes have no transform)
    const nrm = attribute('normal', 'vec3');
    const nW = Fn(() => { const cs = cos(d0.w), sn = sin(d0.w); return vec3(cs.mul(nrm.x).sub(sn.mul(nrm.z)), nrm.y, sn.mul(nrm.x).add(cs.mul(nrm.z))); })().toVarying('vTreeN');
    mat.normalNode = cameraViewMatrix.mul(vec4(nW, 0)).xyz.normalize();
    const fade = d1.w.toVarying('vTreeFade'), leaf = aLeaf.toVarying('vTreeLeaf'), vr = d1.z.toVarying('vTreeVar');
    const lf = texture(this.atlas, uv());
    mat.maskNode = Fn(() => {
      const keep = ign({ p: screenCoordinate.xy }).lessThanEqual(fade).toVar();
      // the leaves' cut by their alpha, lowered with the distance: the atlas's mips average the pixel leaves toward
      // half cover, so a fixed cut at 0.5 thinned the far crowns to specks over the forest floor
      const thr = mix(float(0.5), float(0.12), smoothstep(25, 220, length(positionWorld.sub(cameraPosition))));
      If(leaf.greaterThan(0.5).and(lf.a.lessThan(thr)), () => { keep.assign(false); });
      return keep;
    })();
    mat.colorNode = Fn(() => {
      const c = attribute('color', 'vec3').toVar();
      If(leaf.greaterThan(0.5), () => { c.mulAssign(lf.r.mul(lf.g).mul(mix(vec3(1.07, 1.0, 0.82), vec3(0.86, 1.0, 1.1), vr))); });
      return vec4(c, 1);
    })();
    return mat;
  }

  _kernels() {
    const G = this.cfg.grid, nv = this.nv, clip = this.clip, sea = this.source.sea ?? 0, wildFrom = this.source.wildFrom || 0;
    const P = this.uPlanes;
    this.kCull = Fn(() => {
      const N = this.uN, idx = int(instanceIndex);
      If(idx.greaterThanEqual(N.mul(N)), () => { Return(); });
      const ix = int(this.uOrg.x).add(idx.mod(N)), iz = int(this.uOrg.y).add(idx.div(N));
      const base = vec2(float(ix).add(0.15).add(h01({ x: ix, y: iz, s: int(21) }).mul(0.7)), float(iz).add(0.15).add(h01({ x: ix, y: iz, s: int(22) }).mul(0.7))).mul(G);
      const dxz = length(base.sub(this.uEye.xz));
      If(dxz.greaterThan(this.uBands.z.add(this.uFade.mul(3))), () => { Return(); });
      if (wildFrom > 0) If(length(base).lessThan(wildFrom), () => { Return(); });
      const gd = clip.clipAt(base), h = gd.x, f = gd.z, wet = gd.y, trail = gd.w, wl = clip.clipWater(base);
      If(h.lessThan(wl.add(0.7)).or(trail.greaterThan(0.25)), () => { Return(); });
      const p = f.mul(0.88).add(this.cfg.meadow), r = h01({ x: ix, y: iz, s: int(23) });
      const k = int(0).toVar();
      If(r.greaterThan(p), () => {
        If(r.greaterThanEqual(p.add(min(1, f.mul(3)).mul(float(1).sub(f)).mul(0.22)).add(0.004)), () => { Return(); });
        k.assign(3);
      }).Else(() => {
        const n = clip.clipNormal(base);
        If(float(1).sub(n.y).greaterThan(0.52), () => { Return(); });
        const alt = h.sub(sea);
        If(alt.greaterThan(float(120).add(n2({ p: base.div(300), s: int(31) }).mul(40))).or(wet.lessThan(0.38).and(f.greaterThan(0.4))), () => { k.assign(2); })
          .ElseIf(wet.greaterThan(0.62).and(h01({ x: ix, y: iz, s: int(28) }).lessThan(0.45)), () => { k.assign(1); });
      });
      // every value the appends share is made a variable here, outside their branches (TSL emits a shared node where
      // it is first used, so one first used inside the near level's branch was unset for a tree only in the far one)
      const bush = k.equal(3).toVar();
      const s = select(bush, float(0.8).add(h01({ x: ix, y: iz, s: int(26) }).mul(0.6)), float(0.82).add(h01({ x: ix, y: iz, s: int(29) }).mul(0.45))).toVar();
      const sy = select(bush, float(0.8).add(h01({ x: ix, y: iz, s: int(27) }).mul(0.5)), s).toVar();
      const sxz = select(bush, s, s.mul(float(0.9).add(h01({ x: ix, y: iz, s: int(30) }).mul(0.2)))).toVar();
      const rot = h01({ x: ix, y: iz, s: int(24) }).mul(6.283).toVar(), vari = h01({ x: ix, y: iz, s: int(25) }).toVar();
      const v = int(h01({ x: int(floor(base.x.mul(7))), y: int(floor(base.y.mul(7))), s: int(11) }).mul(nv)).toVar();
      const hh = h.toVar(), bx = base.x.toVar(), bz = base.y.toVar();
      // in view, or near enough to shade what is: a sphere round the crown against the six planes
      const c = vec3(base.x, h.add(sy.mul(7)), base.y), rad = sy.mul(10).add(2);
      const inside = P.element(0).xyz.dot(c).add(P.element(0).w).greaterThan(rad.negate())
        .and(P.element(1).xyz.dot(c).add(P.element(1).w).greaterThan(rad.negate()))
        .and(P.element(2).xyz.dot(c).add(P.element(2).w).greaterThan(rad.negate()))
        .and(P.element(3).xyz.dot(c).add(P.element(3).w).greaterThan(rad.negate()))
        .and(P.element(4).xyz.dot(c).add(P.element(4).w).greaterThan(rad.negate()))
        .and(P.element(5).xyz.dot(c).add(P.element(5).w).greaterThan(rad.negate()));
      If(inside.not().and(dxz.greaterThan(this.uShadowR)), () => { Return(); });
      const d = length(vec3(bx, hh, bz).sub(this.uEye)).toVar(), B = this.uBands, F = this.uFade;
      // the levels' shares (trees.js vFade): level l from B[l] to B[l+1], each edge dithered over its fade
      const f0 = float(1).sub(smoothstep(B.x, B.x.add(F), d)).toVar();
      const f1 = smoothstep(B.x.sub(F.mul(2)), B.x, d).mul(float(1).sub(smoothstep(B.y, B.y.add(F.mul(2)), d))).toVar();
      const f2 = smoothstep(B.y.sub(F.mul(3)), B.y, d).mul(float(1).sub(smoothstep(B.z, B.z.add(F.mul(3)), d))).toVar();
      const kv = k.mul(nv).add(v).toVar();
      const put = (l, fl) => If(fl.greaterThan(0.001), () => {
        const id = kv.mul(3).add(l);
        const n = atomicAdd(this.cnt.element(id), uint(1)).toVar();
        If(n.lessThan(uint(CAPS[l])), () => {
          const o = kv.mul(PER_KV).add(OFF[l]).add(int(n)).mul(2);
          this.inst.element(o).assign(vec4(bx, hh, bz, rot));
          this.inst.element(o.add(1)).assign(vec4(sxz, sy, vari, fl));
        });
      });
      put(0, f0); put(1, f1); put(2, f2);
    })().compute(MAX_CELLS, [64]);
    this.kFinish = Fn(() => {
      const id = int(instanceIndex), l = id.mod(3);
      const cap = select(l.equal(0), uint(CAPS[0]), select(l.equal(1), uint(CAPS[1]), uint(CAPS[2])));
      this.argsS.element(id.mul(5).add(1)).assign(min(atomicLoad(this.cnt.element(id)), cap));
      atomicStore(this.cnt.element(id), uint(0));
    })().compute(this.lists, [64]);
  }

  // once a frame, before the draw: the view's planes, the grid round the eye, the cull, the counts
  update(camera, dt, wind) {
    const G = this.cfg.grid, R = this.R, n = Math.min(440, Math.ceil(2 * R / G) + 2);
    this.uN.value = n; this.uOrg.value.set(Math.floor(camera.position.x / G) - (n >> 1), Math.floor(camera.position.z / G) - (n >> 1));
    this.uEye.value.copy(camera.position);
    camera.updateMatrixWorld();
    _m.copy(camera.projectionMatrix); _m.elements[0] /= 1.05; _m.elements[5] /= 1.05; _m.multiply(camera.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_m, camera.coordinateSystem);
    _fr.planes.forEach((pl, i) => this.uPlanes.array[i].set(pl.normal.x, pl.normal.y, pl.normal.z, pl.constant));
    this.uTime.value += dt; if (wind) this.uWind.value.set(wind[0], wind[1]);
    this.renderer.compute(this.kCull, Math.min(n * n, MAX_CELLS));
    this.renderer.compute(this.kFinish);
    this.stats.cells = n * n;
  }
  // the counts drawn last frame (a readback, for the overlay and the tests; async)
  async counts() { const a = new Uint32Array(await this.renderer.getArrayBufferAsync(this.args)); const out = []; for (let i = 0; i < this.lists; i++) out.push(a[i * 5 + 1]); return out; }
}
const _m = new THREE.Matrix4(), _fr = new THREE.Frustum();
