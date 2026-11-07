// The woods on WebGPU (WEBGPU.md): GPU-driven, computed once and drawn from a table.
//   placement, once per 64 m tile as it comes into reach: a compute pass places the tree of every 5.2 m cell by
//     scatter.js's own rules, from the wild source's WGSL twin (exact ground, forest, water, slope: the same trees the
//     CPU places), into the tile's 13 x 13 slots of a pool on the GPU. JS only says which tiles are wanted;
//   each frame, one pass over the cached trees of the resident tiles: each is stood on the ground as drawn (the
//     clipmap), culled against the view (a sphere round the crown against the frame's six planes widened 5%, or kept
//     within the sun's shadow reach), given its level of detail by its distance (bands with dithered overlaps: a tree
//     in an overlap goes in both levels, each with its share), and appended to its list (kind, variant, level) with an
//     atomic counter; a second pass writes each list's count into its indirect draw and clears the counters.
// Every list is one indirect draw of the card mesh (treecards.js), reading its trees by its own offset. No thinning:
// what is drawn is what is in view, out to the reach.
import * as THREE from 'three/webgpu';
import { Fn, If, Return,  float, int, uint, vec2, vec3, vec4, uniform, uniformArray, storage, instanceIndex, attribute, texture, screenCoordinate, positionLocal, positionWorld, cameraPosition, cameraViewMatrix, wgslFn, wgsl, sin, cos, length, min, max, mix, smoothstep, clamp, select, floor, fract, atomicAdd, atomicLoad, atomicStore, normalize, dot, uv } from 'three/tsl';
import { treeDesign, meshTreeCards, leafAtlas } from '../treecards.js';
import { FOREST } from '../trees.js';
import { WILD_WGSL } from './wild.wgsl.js';
import { bakeImpostors } from './impostor.js';

const KINDS = ['oak', 'birch', 'pine', 'bush'];
const CAPS = [4096, 16384, 32768]; // instances per list, by level
const TILE = 64, SLOTS = 169, POOL = 8192, JOBS = 128, CARD_CAP = 49152; // a tile's 13 x 13 cells; tiles held; tiles placed per frame at most
const PER_KV = CAPS[0] + CAPS[1] + CAPS[2], OFF = [0, CAPS[0], CAPS[0] + CAPS[1]];
const wildCode = wgsl(WILD_WGSL);
const h01 = wgslFn('fn fH01(x: i32, y: i32, s: i32) -> f32 { return w2hash01_(x, y, s); }', [wildCode]);
const n2 = wgslFn('fn fNoise(p: vec2<f32>, s: i32) -> f32 { return w2noise(p, s); }', [wildCode]);
const ign = wgslFn('fn fIgn(p: vec2<f32>) -> f32 { return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))); }');

export class GpuForest {
  constructor(renderer, clip, source, opts = {}) {
    this.renderer = renderer; this.clip = clip; this.source = source;
    // the bands twice the WebGL build's: full detail to 90 m, the middle level to 320 m, the far one to 900 m
    // beyond, cards (one baked picture per tree, eight ways round) to 3 km
    this.cfg = { ...FOREST, bands: [0, 90, 320, 900], cards: 3000, ...opts };
    this.nk = KINDS.length; this.nv = this.cfg.variants;
    this.lists = this.nk * this.nv * 3; this.cardLists = this.nk * this.nv; this.allLists = this.lists + this.cardLists;
    this.range = opts.range ?? 1; this.rangeK = 1;
    this.group = new THREE.Group(); this.group.name = 'gpu-forest';
    // the instance data: two vec4 per tree (x, y, z, turn), (horizontal scale, vertical scale, variety, fade)
    const nInst = this.nk * this.nv * PER_KV;
    this.instAttr = new THREE.StorageBufferAttribute(new Float32Array(nInst * 8), 4);
    this.inst = storage(this.instAttr, 'vec4', nInst * 2);
    this.instR = storage(this.instAttr, 'vec4', nInst * 2).toReadOnly();
    const nCard = this.cardLists * CARD_CAP;
    this.cardAttr = new THREE.StorageBufferAttribute(new Float32Array(nCard * 8), 4);
    this.cardInst = storage(this.cardAttr, 'vec4', nCard * 2); this.cardR = storage(this.cardAttr, 'vec4', nCard * 2).toReadOnly();
    const NL = this.allLists;
    this.cntAttr = new THREE.StorageBufferAttribute(new Uint32Array(NL), 1);
    this.cnt = storage(this.cntAttr, 'uint', NL).toAtomic();
    this.args = new THREE.IndirectStorageBufferAttribute(new Uint32Array(NL * 5), 5);
    this.argsS = storage(this.args, 'uint', NL * 5);
    // the tiles in view this frame (a pass over the tiles before the one over their trees, dispatched indirectly)
    this.visAttr = new THREE.StorageBufferAttribute(new Uint32Array(POOL), 1); this.vis = storage(this.visAttr, 'uint', POOL); this.visR = storage(this.visAttr, 'uint', POOL).toReadOnly();
    this.visCntAttr = new THREE.StorageBufferAttribute(new Uint32Array(2), 1); this.visCnt = storage(this.visCntAttr, 'uint', 2).toAtomic();
    this.visNAttr = new THREE.StorageBufferAttribute(new Uint32Array(1), 1); this.visN = storage(this.visNAttr, 'uint', 1); this.visNR = storage(this.visNAttr, 'uint', 1).toReadOnly();
    this.dispatch = new THREE.IndirectStorageBufferAttribute(new Uint32Array([1, 1, 1]), 1); this.dispatchS = storage(this.dispatch, 'uint', 3);
    this.tileAttr = new THREE.StorageBufferAttribute(new Float32Array(POOL * 4), 4); this.tileInfo = storage(this.tileAttr, 'vec4', POOL); this.tileInfoR = storage(this.tileAttr, 'vec4', POOL).toReadOnly();
    // the view: six planes, the eye, the bands, the grid's origin
    this.uPlanes = uniformArray([0, 1, 2, 3, 4, 5].map(() => new THREE.Vector4()), 'vec4');
    this.uEye = uniform(new THREE.Vector3()); this.uOrg = uniform(new THREE.Vector2()); this.uN = uniform(1, 'int');
    this.uBands = uniform(new THREE.Vector4()); this.uNActive = uniform(0, 'int'); this.uFade = uniform(this.cfg.fade); this.uShadowR = uniform(opts.shadowR ?? 60);
    this.uTime = uniform(0); this.uWind = uniform(new THREE.Vector2(3, 1));
    // the season's leaves (seasons.js, as trees.js): uLeafTint on the leaves' colour (spring light, summer deep),
    // uAutumn turning each tree yellow, orange or red by its variety, uLeafGone the share fallen, uSnowOn on the tops
    this.uLeafTint = uniform(new THREE.Vector3(1, 1, 1)); this.uAutumn = uniform(0); this.uLeafGone = uniform(0); this.uSnowOn = uniform(0);
    // the placed trees: per pool tile 169 slots of two vec4: (x, z, kind * variants + variant or -1, turn), (horizontal
    // scale, vertical scale, variety, 0); the resident tiles' pool indices; the placement jobs (tile i, j, pool)
    this.cacheAttr = new THREE.StorageBufferAttribute(new Float32Array(POOL * SLOTS * 8), 4);
    this.cache = storage(this.cacheAttr, 'vec4', POOL * SLOTS * 2);
    this.activeAttr = new THREE.StorageBufferAttribute(new Uint32Array(POOL), 1);
    this.active = storage(this.activeAttr, 'uint', POOL).toReadOnly();
    this.uJobs = uniformArray(Array.from({ length: JOBS }, () => new THREE.Vector4()), 'vec4');
    this.tiles = new Map(); this.free = Array.from({ length: POOL }, (_, i) => POOL - 1 - i); this._activeDirty = true; this._want = [];
    this.stats = { cells: 0, tiles: 0, placed: 0, lists: this.allLists, ms: 0 };
    this._meshes();
    this._cards(renderer);
    this._kernels();
    this.setRange(1);
  }

  setRange(k) { this.rangeK = k; const B = this.cfg.bands.map((b) => b * this.range * k), C = this.cfg.cards * this.range * k; this.uBands.value.set(B[1], B[2], B[3], C); this.Rmesh = B[3] + this.cfg.fade * 3; this.R = Math.max(this.Rmesh, C); }

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

  // the far cards: the baked pictures, one quad per tree turned to the eye (tilted toward a high eye, about its foot,
  // so from above the crown still shows as a mass), the view facing the eye picked from the eight, lit from the
  // baked normal; one indirect draw per kind and variety
  _cards(renderer) {
    const imp = this.imp = bakeImpostors(renderer, KINDS, this.nv, this.atlas);
    const meta = uniformArray(imp.meta, 'vec4'), V = imp.V, rows = imp.rows;
    const geo = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3)); g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)); g.setIndex([0, 1, 2, 0, 2, 3]); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9); return g; };
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    const uBase = uniform(0, 'int').onObjectUpdate(({ object }) => object.userData.base), uRow = uniform(0, 'int').onObjectUpdate(({ object }) => object.userData.row);
    const I = this.cardR, slot = uBase.add(int(instanceIndex)).mul(2), d0 = I.element(slot), d1 = I.element(slot.add(1));
    const M = meta.element(uRow);
    const toC = cameraPosition.sub(d0.xyz), az = toC.x.atan(toC.z);
    mat.positionNode = Fn(() => {
      const w = M.x.mul(d1.x), hgt = M.y.mul(d1.y), right = vec3(cos(az), 0, sin(az).negate());
      const elev = toC.y.atan(length(toC.xz));
      const upv = normalize(mix(vec3(0, 1, 0), normalize(toC), smoothstep(0.35, 1.2, elev).mul(0.85)));
      return vec3(d0.x, d0.y.sub(d1.y.mul(0.12)), d0.z).add(right.mul(positionLocal.x.mul(w).mul(0.5))).add(upv.mul(positionLocal.y.mul(hgt)));
    })();
    const rel = az.sub(d0.w), slice = floor(fract(rel.div(6.2831853).add(0.5 / V)).mul(V)).toVarying('vCardSlice');
    const azV = az.toVarying('vCardAz'), fade = d1.w.toVarying('vCardFade'), vr = d1.z.toVarying('vCardVar');
    const auv = vec2(slice.add(uv().x).div(V), float(uRow).add(float(1).sub(uv().y)).div(rows));
    const A = texture(imp.A.texture, auv), Nn = texture(imp.N.texture, auv).xyz.mul(2).sub(1);
    mat.maskNode = Fn(() => A.a.greaterThanEqual(0.5).and(float(1).sub(ign({ p: screenCoordinate.xy })).lessThanEqual(fade)).and(A.a.lessThanEqual(0.75).or(ign({ p: screenCoordinate.xy.add(7) }).greaterThanEqual(this.uLeafGone))))();
    const NW = vec3(cos(azV).mul(Nn.x).add(sin(azV).mul(Nn.z)), Nn.y, sin(azV).negate().mul(Nn.x).add(cos(azV).mul(Nn.z)));
    mat.normalNode = cameraViewMatrix.mul(vec4(NW.normalize(), 0)).xyz.normalize();
    mat.colorNode = Fn(() => {
      const c = A.rgb.toVar();
      If(A.a.greaterThan(0.75), () => { c.assign(this._season(c.mul(mix(vec3(1.07, 1.0, 0.82), vec3(0.86, 1.0, 1.1), vr)), vr, NW.y)); });
      return vec4(c.mul(float(0.55).add(uv().y.mul(0.45))), 1); // darker toward the ground
    })();
    this.cardMeshes = [];
    for (let kv = 0; kv < this.cardLists; kv++) {
      const g = geo(), id = this.lists + kv;
      this.args.array.set([6, 0, 0, 0, 0], id * 5);
      g.setIndirect(this.args, id * 20);
      const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true;
      m.userData.base = kv * CARD_CAP; m.userData.row = kv; m.name = 'card ' + kv;
      this.group.add(m); this.cardMeshes.push(m);
    }
    this.args.needsUpdate = true;
  }

  // a leaf's colour in the season (trees.js seasonLeaf), and its snow by the normal's rise
  _season(c, v, ny) {
    const g = (a) => vec3(...a.map((x) => x ** 2.2));
    const aut = select(v.lessThan(0.33), g([0.78, 0.55, 0.08]), select(v.lessThan(0.66), g([0.75, 0.32, 0.06]), g([0.6, 0.12, 0.05])));
    const lum = min(float(1), c.dot(vec3(0.3, 0.6, 0.1)).mul(3));
    return mix(mix(c.mul(this.uLeafTint), aut.mul(lum), this.uAutumn), vec3(0.85, 0.88, 0.95), this.uSnowOn.mul(smoothstep(0.2, 0.8, ny)).mul(0.8));
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
      If(leaf.greaterThan(0.5).and(lf.a.lessThan(thr).or(ign({ p: screenCoordinate.xy.add(7) }).lessThan(this.uLeafGone))), () => { keep.assign(false); }); // winter: the leaves go, leaf by leaf
      return keep;
    })();
    mat.colorNode = Fn(() => {
      const c = attribute('color', 'vec3').toVar();
      If(leaf.greaterThan(0.5), () => { c.assign(this._season(c.mul(lf.r.mul(lf.g).mul(mix(vec3(1.07, 1.0, 0.82), vec3(0.86, 1.0, 1.1), vr))), vr, nW.y)); });
      return vec4(c, 1);
    })();
    return mat;
  }

  _kernels() {
    const G = this.cfg.grid, nv = this.nv, P = this.uPlanes, src = this.source;
    const U = src.params ? src.params : { seed: 0, sea: 0, relief: 1, blocky: 0, rivers: 1, forests: 1, trails: 1 };
    // placement (scatter.js, the wild part): the cell's tree or none, from the exact wild source
    const place = wgslFn(`fn fPlace(ix: i32, iz: i32, g: f32, meadow: f32, wildFrom: f32, seed: i32, sea: f32, relief: f32, blocky: f32, rivers: f32, forests: f32, trails: f32) -> vec4<f32> {
  let k0 = wildParams(seed, sea, relief, blocky, rivers, forests, trails);
  let x = (f32(ix) + 0.15 + 0.7 * w2hash01_(ix, iz, 21)) * g;
  let z = (f32(iz) + 0.15 + 0.7 * w2hash01_(ix, iz, 22)) * g;
  let none = vec4<f32>(x, z, -1.0, 0.0);
  if (wildFrom > 0.0 && length(vec2<f32>(x, z)) < wildFrom) { return none; }
  var S: vec4<f32>; var wl: f32;
  wildSampleW(vec2<f32>(x, z), &S, &wl);
  let h = S.x; let f = S.z; let wet = S.y; let trail = S.w;
  if (h < wl + 0.7 || trail > 0.25) { return none; }
  let p = f * 0.88 + meadow; let r = w2hash01_(ix, iz, 23);
  if (r > p) {
    if (r < p + 0.22 * min(1.0, f * 3.0) * (1.0 - f) + 0.004) { return vec4<f32>(x, z, 3.0, 0.0); }
    return none;
  }
  let slope = abs(wildSample(vec2<f32>(x + 1.5, z)).x - h) / 1.5 + abs(wildSample(vec2<f32>(x, z + 1.5)).x - h) / 1.5;
  if (slope > 0.9) { return none; }
  var k = 0.0;
  if (h - sea > 120.0 + 40.0 * w2noise(vec2<f32>(x, z) / 300.0, 31) || (wet < 0.38 && f > 0.4)) { k = 2.0; }
  else if (wet > 0.62 && w2hash01_(ix, iz, 28) < 0.45) { k = 1.0; }
  return vec4<f32>(x, z, k, 0.0);
}`, [wildCode]);
    const W = wildUniformsOf(src);
    this.kPlace = Fn(() => {
      const t = int(instanceIndex), job = this.uJobs.element(t.div(SLOTS)), c = t.mod(SLOTS);
      const ti = int(job.x), tj = int(job.y), pool = int(job.z);
      const ix0 = int(floor(float(ti).mul(TILE / G))), ix1 = int(floor(float(ti.add(1)).mul(TILE / G)));
      const iz0 = int(floor(float(tj).mul(TILE / G))), iz1 = int(floor(float(tj.add(1)).mul(TILE / G)));
      const ix = ix0.add(c.mod(13)).toVar(), iz = iz0.add(c.div(13)).toVar();
      const o = pool.mul(SLOTS).add(c).mul(2).toVar(); // a variable: it is used inside and after branches
      If(c.equal(0), () => { this.tileInfo.element(pool).assign(vec4(float(ti).add(0.5).mul(TILE), float(tj).add(0.5).mul(TILE), 0, 0)); });
      If(ix.greaterThanEqual(ix1).or(iz.greaterThanEqual(iz1)), () => { this.cache.element(o).assign(vec4(0, 0, -1, 0)); Return(); });
      const q = place({ ix, iz, g: float(G), meadow: float(this.cfg.meadow), wildFrom: float(src.wildFrom || 0), seed: int(W.seed), sea: float(W.sea), relief: float(W.relief), blocky: float(W.blocky), rivers: float(W.rivers), forests: float(W.forests), trails: float(W.trails) }).toVar();
      If(q.z.lessThan(0), () => { this.cache.element(o).assign(vec4(q.x, q.y, -1, 0)); Return(); });
      const bush = q.z.equal(3).toVar();
      const s = select(bush, float(0.8).add(h01({ x: ix, y: iz, s: int(26) }).mul(0.6)), float(0.82).add(h01({ x: ix, y: iz, s: int(29) }).mul(0.45))).toVar();
      const sy = select(bush, float(0.8).add(h01({ x: ix, y: iz, s: int(27) }).mul(0.5)), s).toVar();
      const sxz = select(bush, s, s.mul(float(0.9).add(h01({ x: ix, y: iz, s: int(30) }).mul(0.2)))).toVar();
      const v = int(h01({ x: int(floor(q.x.mul(7))), y: int(floor(q.y.mul(7))), s: int(11) }).mul(nv));
      this.cache.element(o).assign(vec4(q.x, q.y, float(int(q.z).mul(nv).add(v)), h01({ x: ix, y: iz, s: int(24) }).mul(6.283)));
      this.cache.element(o.add(1)).assign(vec4(sxz, sy, h01({ x: ix, y: iz, s: int(25) }), 0));
    })().compute(JOBS * SLOTS, [64]);
    // each frame, first the tiles: those in reach and in view (a box round the tile against the six planes) or within
    // the sun's shadow reach go on the list of tiles to cull, and the second pass is dispatched over their trees
    const RC = this.clip.reads('C'), RT = this.clip.reads('T');
    this.kTiles = Fn(() => {
      const t = int(instanceIndex);
      If(t.greaterThanEqual(this.uNActive), () => { Return(); });
      const pool = this.active.element(t), ti = this.tileInfoR.element(int(pool));
      const dxz = length(ti.xy.sub(this.uEye.xz)).toVar();
      If(dxz.greaterThan(this.uBands.w.max(this.uBands.z).add(this.uFade.mul(3)).add(46)), () => { Return(); });
      const c = vec3(ti.x, RT.clipAt(ti.xy).x.add(20), ti.y);
      const inBox = (k) => { const pl = P.element(k); return pl.xyz.dot(c).add(pl.w).greaterThan(pl.x.abs().mul(32).add(pl.y.abs().mul(60)).add(pl.z.abs().mul(32)).negate()); };
      const inside = inBox(0).and(inBox(1)).and(inBox(2)).and(inBox(3)).and(inBox(4)).and(inBox(5));
      If(inside.not().and(dxz.greaterThan(this.uShadowR.add(46))), () => { Return(); });
      const n = atomicAdd(this.visCnt.element(0), uint(1));
      this.vis.element(int(n)).assign(pool);
    })().compute(POOL, [64]);
    this.kTileArgs = Fn(() => {
      const n = atomicLoad(this.visCnt.element(0)).toVar();
      this.dispatchS.element(0).assign(n.mul(SLOTS).add(63).div(64).max(uint(1)));
      this.dispatchS.element(1).assign(uint(1)); this.dispatchS.element(2).assign(uint(1));
      this.visN.element(0).assign(n);
      atomicStore(this.visCnt.element(0), uint(0));
    })().compute(1, [1]);
    // then the trees of those tiles: stood on the ground, culled, sorted into the levels and the cards
    this.kCull = Fn(() => {
      const t = int(instanceIndex), v = t.div(SLOTS);
      If(uint(v).greaterThanEqual(this.visNR.element(0)), () => { Return(); });
      const pool = int(this.visR.element(v)), o = pool.mul(SLOTS).add(t.mod(SLOTS)).mul(2).toVar();
      const c0 = this.cache.element(o).toVar();
      If(c0.z.lessThan(0), () => { Return(); });
      const c1 = this.cache.element(o.add(1)).toVar();
      const bx = c0.x, bz = c0.y, sy = c1.y;
      const dxz = length(vec2(bx, bz).sub(this.uEye.xz));
      If(dxz.greaterThan(this.uBands.w.max(this.uBands.z.add(this.uFade.mul(3)))), () => { Return(); });
      const hh = RC.clipAt(vec2(bx, bz)).x.toVar();
      const c = vec3(bx, hh.add(sy.mul(7)), bz), rad = sy.mul(10).add(2);
      const inside = P.element(0).xyz.dot(c).add(P.element(0).w).greaterThan(rad.negate())
        .and(P.element(1).xyz.dot(c).add(P.element(1).w).greaterThan(rad.negate()))
        .and(P.element(2).xyz.dot(c).add(P.element(2).w).greaterThan(rad.negate()))
        .and(P.element(3).xyz.dot(c).add(P.element(3).w).greaterThan(rad.negate()))
        .and(P.element(4).xyz.dot(c).add(P.element(4).w).greaterThan(rad.negate()))
        .and(P.element(5).xyz.dot(c).add(P.element(5).w).greaterThan(rad.negate()));
      If(inside.not().and(dxz.greaterThan(this.uShadowR)), () => { Return(); });
      const d = length(vec3(bx, hh, bz).sub(this.uEye)).toVar(), B = this.uBands, F = this.uFade;
      const f0 = float(1).sub(smoothstep(B.x, B.x.add(F), d)).toVar();
      const f1 = smoothstep(B.x.sub(F.mul(2)), B.x, d).mul(float(1).sub(smoothstep(B.y, B.y.add(F.mul(2)), d))).toVar();
      const f2 = smoothstep(B.y.sub(F.mul(3)), B.y, d).mul(float(1).sub(smoothstep(B.z, B.z.add(F.mul(3)), d))).toVar(); // (the cards take 1 - this past B.z)
      const kv = int(c0.z).toVar(), d0 = vec4(bx, hh, bz, c0.w).toVar();
      const put = (l, fl) => If(fl.greaterThan(0.001), () => {
        const id = kv.mul(3).add(l);
        const n = atomicAdd(this.cnt.element(id), uint(1)).toVar();
        If(n.lessThan(uint(CAPS[l])), () => {
          const oi = kv.mul(PER_KV).add(OFF[l]).add(int(n)).mul(2);
          this.inst.element(oi).assign(d0);
          this.inst.element(oi.add(1)).assign(vec4(c1.x, c1.y, c1.z, fl));
        });
      });
      put(0, f0); put(1, f1); put(2, f2);
      // the cards: in as the far meshes go out (their dithers complementary), out by the cards' reach
      const f3 = smoothstep(B.z, B.z.add(F.mul(3)), d).mul(float(1).sub(smoothstep(B.w.sub(150), B.w, d))).toVar();
      If(f3.greaterThan(0.001), () => {
        const id = int(this.lists).add(kv);
        const n = atomicAdd(this.cnt.element(id), uint(1)).toVar();
        If(n.lessThan(uint(CARD_CAP)), () => {
          const oi = kv.mul(CARD_CAP).add(int(n)).mul(2);
          this.cardInst.element(oi).assign(d0);
          this.cardInst.element(oi.add(1)).assign(vec4(c1.x, c1.y, c1.z, f3));
        });
      });
    })().compute(POOL * SLOTS, [64]);
    this.kFinish = Fn(() => {
      const id = int(instanceIndex), l = id.mod(3);
      const cap = select(id.greaterThanEqual(this.lists), uint(CARD_CAP), select(l.equal(0), uint(CAPS[0]), select(l.equal(1), uint(CAPS[1]), uint(CAPS[2]))));
      this.argsS.element(id.mul(5).add(1)).assign(min(atomicLoad(this.cnt.element(id)), cap));
      atomicStore(this.cnt.element(id), uint(0));
    })().compute(this.allLists, [64]);
  }

  // which tiles are wanted: those within the reach (and a tile's slack), nearest first, those in view before the
  // rest; new ones placed up to JOBS a frame, far ones given back to the pool
  _tiles(camera) {
    const T = TILE, R = this.R + T, ex = camera.position.x, ez = camera.position.z, ci = Math.floor(ex / T), cj = Math.floor(ez / T), rt = Math.ceil(R / T);
    const key = ci + ',' + cj + ',' + this.R.toFixed(0);
    if (this._key !== key) {
      this._key = key; this._want = [];
      for (const [k, t] of this.tiles) if (Math.hypot((t.i + 0.5) * T - ex, (t.j + 0.5) * T - ez) > R + 2 * T) { this.free.push(t.pool); this.tiles.delete(k); this._activeDirty = true; }
      for (let j = cj - rt; j <= cj + rt; j++) for (let i = ci - rt; i <= ci + rt; i++) {
        const d = Math.hypot((i + 0.5) * T - ex, (j + 0.5) * T - ez);
        if (d < R && !this.tiles.has(i + ',' + j)) this._want.push([d, i, j]);
      }
      this._sorted = false;
    }
    if (!this._want.length) return 0;
    if (!this._sorted || this._turned) { // in view first (a tile's box against the frame), nearest first
      for (const w of this._want) { _b.min.set(w[1] * T, camera.position.y - 400, w[2] * T); _b.max.set((w[1] + 1) * T, camera.position.y + 200, (w[2] + 1) * T); w[3] = w[0] * (_fr.intersectsBox(_b) ? 1 : 4); }
      this._want.sort((a, b) => a[3] - b[3]); this._sorted = true;
    }
    let n = 0;
    while (n < JOBS && this._want.length && this.free.length) {
      const [, i, j] = this._want.shift(), pool = this.free.pop();
      this.tiles.set(i + ',' + j, { i, j, pool }); this.uJobs.array[n].set(i, j, pool, 0); n++;
    }
    if (n) { this.renderer.compute(this.kPlace, n * SLOTS); this._activeDirty = true; this.stats.placed += n; }
    return n;
  }

  // once a frame, before the draw: the view's planes, new tiles placed, the cached trees culled, the counts
  update(camera, dt, wind) {
    this.uEye.value.copy(camera.position);
    camera.updateMatrixWorld();
    _m.copy(camera.projectionMatrix); _m.elements[0] /= 1.05; _m.elements[5] /= 1.05; _m.multiply(camera.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_m, camera.coordinateSystem);
    _fr.planes.forEach((pl, i) => this.uPlanes.array[i].set(pl.normal.x, pl.normal.y, pl.normal.z, pl.constant));
    camera.getWorldDirection(_v); this._turned = _v.dot(this._dir || _v) < Math.cos(0.1); this._dir = (this._dir || new THREE.Vector3()).copy(_v);
    this._tiles(camera);
    if (this._activeDirty) {
      const a = this.activeAttr.array; let n = 0; for (const t of this.tiles.values()) a[n++] = t.pool;
      this.activeAttr.needsUpdate = true; this._activeDirty = false; this.nActive = n;
    }
    this.uTime.value += dt; if (wind) this.uWind.value.set(wind[0], wind[1]);
    const cells = (this.nActive || 0) * SLOTS; this.uNActive.value = this.nActive || 0;
    if (cells) { this.renderer.compute(this.kTiles, this.nActive); this.renderer.compute(this.kTileArgs, 1); this.renderer.compute(this.kCull, this.dispatch); }
    this.renderer.compute(this.kFinish);
    this.stats.cells = cells; this.stats.tiles = this.tiles.size;
  }
  // the counts drawn last frame (a readback, for the overlay and the tests; async)
  async counts() { const a = new Uint32Array(await this.renderer.getArrayBufferAsync(this.args)); const out = []; for (let i = 0; i < this.allLists; i++) out.push(a[i * 5 + 1]); return out; }
}
// the wild source's parameters as the WGSL twin takes them
function wildUniformsOf(src) { const P = src.params || {}; return { seed: P.seed | 0, sea: P.sea ?? src.sea ?? 0, relief: P.relief ?? 1, blocky: P.blocky ?? 0, rivers: P.rivers ?? 1, forests: P.forests ?? 1, trails: P.trails ?? 1 }; }
const _m = new THREE.Matrix4(), _fr = new THREE.Frustum(), _b = new THREE.Box3(), _v = new THREE.Vector3();
