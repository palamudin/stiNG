// Forests. Every tree kind is a signed distance field: a trunk and branches of rounded boxes, and a canopy made of
// rounded leaf blocks smoothly joined (the game-like block idea, made soft), with lumps of noise on top. The field is
// meshed by surface nets (own code, no tables) at three cell sizes, so one design gives three levels of detail that
// agree in shape. Normals come from the field's gradient, so the canopy shades as one soft mass; ambient occlusion is
// baked per vertex from the field itself (how much of the space just outside a point is inside the tree).
//
// Placement is deterministic per 64 m tile from the source (forest density, moisture, height, slope), or, in the
// game's world, the sim's own trees one for one. Tiles stream in nearest first within a per-frame budget; each frame
// the tiles are binned into the three detail levels by distance, and the shader dithers across each band edge on the
// exact distance of each tree, so nothing pops. Every tree stands on the ground as drawn (clipmap), sways in the
// wind (the whole tree, more toward the top, and the leaves flutter), and lets the sun through its leaves.
import * as THREE from 'three';
import { hash01, vnoise, smoothstep } from './noise.js';

import { treeDesign, meshTree, TREE_KINDS } from './mesh.js';
import { placeTile } from './scatter.js';

// cell sizes per level of detail, per kind (pine tiers are flat and need less)
const CELLS = { oak: [0.24, 0.6, 1.4], birch: [0.22, 0.55, 1.3], pine: [0.3, 0.7, 1.6], bush: [0.16, 0.4, 1.0], rock: [0.12, 0.3, 0.7] };
export const FOREST = { tile: 64, variants: 3, bands: [0, 70, 300, 750], fade: 14, grid: 5.2, meadow: 0.012, budgetMs: 4 };

const TREE_VERT_HEAD = /* glsl */ `
attribute vec4 aI0; // x, z, turn, variety
attribute vec4 aI1; // horizontal scale, vertical scale
attribute float aSway, aLeaf;
uniform float uTime; uniform vec2 uWind; uniform vec3 uBand; // near, far, fade width
varying float vFade, vLeaf, vVar; varying vec3 vTW;
`;
const TREE_VERT = /* glsl */ `
  vec3 transformed = position;
  float ph = aI0.w * 6.283 + aI0.x * 0.13 + aI0.y * 0.17;
  float ws = length(uWind); vec2 wd = ws > 0.001 ? uWind / ws : vec2(1.0, 0.0);
  // the whole tree leans and rocks with the wind, more toward the top; leaves flutter
  float sway = (0.45 + 0.35 * sin(uTime * 1.05 + ph) + 0.2 * sin(uTime * 2.6 + ph * 1.7)) * ws;
  transformed.xz += wd * sway * aSway * 0.32;
  if (aLeaf > 0.5) transformed += (0.02 + 0.03 * ws) * vec3(sin(uTime * 7.3 + position.y * 5.0 + ph), 0.5 * sin(uTime * 6.1 + position.x * 4.0), cos(uTime * 6.7 + position.z * 5.0 + ph));
  float cs = cos(aI0.z), sn = sin(aI0.z);
  transformed = vec3(cs * transformed.x - sn * transformed.z, transformed.y, sn * transformed.x + cs * transformed.z) * vec3(aI1.x, aI1.y, aI1.x);
  vec2 base = aI0.xy;
  transformed += vec3(base.x, clipHeight(base) - 0.12 * aI1.y, base.y);
  vTW = transformed; vLeaf = aLeaf; vVar = aI0.w;
  float dI = length(vec3(base.x, transformed.y, base.y) - cameraPosition);
  vFade = smoothstep(uBand.x - uBand.z, uBand.x, dI) * (1.0 - smoothstep(uBand.y, uBand.y + uBand.z, dI));
`;
const TREE_NORMAL = /* glsl */ `
  vec3 objectNormal = vec3(cos(aI0.z) * normal.x - sin(aI0.z) * normal.z, normal.y, sin(aI0.z) * normal.x + cos(aI0.z) * normal.z);
`;
const DITHER = /* glsl */ `
float w2ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); } // interleaved gradient noise
`;

export class Forest {
  constructor(world, opts = {}) {
    this.world = world; this.source = world.source;
    this.cfg = { ...FOREST, ...opts };
    const scale = opts.range ?? 1;
    this.bands = this.cfg.bands.map((b) => b * scale);
    this.group = new THREE.Group(); this.group.name = 'world2-forest';
    this.tiles = new Map(); this.queue = [];
    this.uniforms = { uTime: world.uniforms.uTime, uWind: { value: new THREE.Vector2(0.8, 0.3) }, uSunDir: world.uniforms.uSunDir, uSunColor: world.sky.uniforms.uSunColor, ...world.clip.uniforms };
    this.clipGLSL = world.clip.glsl();
    this.kinds = this.source.objects ? ['oak', 'birch'] : TREE_KINDS;
    this.meshes = []; // [kind][variant][lod]
    this.stats = { trees: 0, tiles: 0, tris: [0, 0, 0], buildMs: 0 };
    const t0 = performance.now();
    for (const kind of this.kinds) {
      const perV = [];
      for (let v = 0; v < this.cfg.variants; v++) {
        const d = treeDesign(kind, v + 1, { trunk: this.source.trunks !== false }), perL = [];
        for (let l = 0; l < 3; l++) {
          const m = meshTree(d, CELLS[kind][l]);
          perL.push(this._makeMesh(m, l, kind));
          this.stats.tris[l] += m.tris;
        }
        perV.push(perL);
      }
      this.meshes.push(perV);
    }
    this.stats.buildMs = performance.now() - t0;
    this.design = { oak: treeDesign('oak', 1, { trunk: this.source.trunks !== false }), birch: treeDesign('birch', 1, { trunk: this.source.trunks !== false }) };
    this._lastBin = new THREE.Vector2(1e9, 1e9);
    this._dirty = true;
  }
  _makeMesh(m, lod, kind) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
    g.setAttribute('aSway', new THREE.BufferAttribute(m.sway, 1));
    g.setAttribute('aLeaf', new THREE.BufferAttribute(m.leaf, 1));
    g.setIndex(m.idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const cap = 256, buf = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * 8), 8);
    buf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aI0', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    g.setAttribute('aI1', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    g.instanceCount = 0;
    const band = new THREE.Vector3(this.bands[lod], this.bands[lod + 1], this.cfg.fade * (1 + lod));
    const U = { ...this.uniforms, uBand: { value: band } };
    // near trees are two-sided: from inside a crown (where a wasp often is) the leaves still show, shaded as the inside
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: lod === 0 && kind !== 'rock' ? THREE.DoubleSide : THREE.FrontSide });
    const clip = this.clipGLSL;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = `${clip}\n${TREE_VERT_HEAD}\n` + sh.vertexShader.replace('#include <begin_vertex>', TREE_VERT).replace('#include <beginnormal_vertex>', TREE_NORMAL);
      sh.fragmentShader = `${DITHER}\nuniform vec3 uSunDir, uSunColor; varying float vFade, vLeaf, vVar; varying vec3 vTW;\n` + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (w2ign(gl_FragCoord.xy) > vFade) discard;')
        .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
  diffuseColor.rgb *= mix(vec3(1.07, 1.0, 0.82), vec3(0.86, 1.0, 1.1), vVar);
  float camD0 = length(cameraPosition - vTW);
  diffuseColor.rgb = mix(diffuseColor.rgb, max(diffuseColor.rgb, vec3(0.04, 0.09, 0.025)) * 1.25, smoothstep(150.0, 600.0, camD0) * vLeaf); // distance: the baked shade of the inside of a canopy no longer reads
  float camD = length(cameraPosition - vTW);
  if (vLeaf > 0.5 && camD < 40.0) { // leaf "pixels": 1/16 m cells on the canopy, a nod to block textures, fading out
    vec3 cc = floor(vTW * 16.0); float hh = fract(sin(dot(cc, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    diffuseColor.rgb *= mix(1.0, 0.78 + 0.4 * hh, 1.0 - smoothstep(8.0, 40.0, camD));
  }`)
        .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
  if (vLeaf > 0.5) { // sunlight through the leaves: strongest looking toward the sun, carried by the baked occlusion
    vec3 V = normalize(vTW - cameraPosition);
    float back = pow(clamp(dot(V, uSunDir), 0.0, 1.0), 4.0);
    reflectedLight.directDiffuse += uSunColor * diffuseColor.rgb * (0.9 * back + 0.08) * 0.35;
  }`);
    };
    mat.customProgramCacheKey = () => 'w2tree' + lod + '/' + this.world.clip.cfg.levels; // the clipmap's level count is in the code
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = `${clip}\n${TREE_VERT_HEAD}\n` + sh.vertexShader.replace('#include <begin_vertex>', TREE_VERT);
      sh.fragmentShader = `${DITHER}\nvarying float vFade;\n` + sh.fragmentShader.replace('void main() {', 'void main() {\n  if (w2ign(gl_FragCoord.xy) > vFade) discard;');
    };
    depth.customProgramCacheKey = () => 'w2treeD' + lod + '/' + this.world.clip.cfg.levels;
    const mesh = new THREE.Mesh(g, mat);
    mesh.customDepthMaterial = depth;
    mesh.frustumCulled = false; mesh.castShadow = lod < 2; mesh.receiveShadow = true;
    mesh.userData = { buf, cap, count: 0, U };
    this.group.add(mesh);
    return mesh;
  }

  // ---- placement (scatter.js, pure, tested)
  _genTile(ti, tj) { return placeTile(this.source, ti, tj, this.kinds, this.cfg, this.design); }

  update(eye, dt) {
    const T = this.cfg.tile, R = this.bands[3] + this.cfg.fade * 3;
    const ci = Math.floor(eye.x / T), cj = Math.floor(eye.z / T), rt = Math.ceil(R / T) + 1;
    // queue missing tiles nearest first; generate within the budget
    const t0 = performance.now();
    if (!this._q || this._qc !== ci + ',' + cj) {
      this._qc = ci + ',' + cj; this._q = [];
      for (let j = cj - rt; j <= cj + rt; j++) for (let i = ci - rt; i <= ci + rt; i++) {
        const d = Math.hypot((i + 0.5) * T - eye.x, (j + 0.5) * T - eye.z);
        if (d < R + T && !this.tiles.has(i + ',' + j)) this._q.push([d, i, j]);
      }
      this._q.sort((a, b) => a[0] - b[0]);
      // drop tiles far behind
      for (const [k, t] of this.tiles) if (Math.hypot((t.i + 0.5) * T - eye.x, (t.j + 0.5) * T - eye.z) > R + 3 * T) { this.tiles.delete(k); this._dirty = true; }
    }
    while (this._q.length && performance.now() - t0 < this.cfg.budgetMs) {
      const [, i, j] = this._q.shift();
      if (this.tiles.has(i + ',' + j)) continue;
      this.tiles.set(i + ',' + j, { i, j, items: this._genTile(i, j) });
      this._dirty = true;
    }
    if (this._dirty || this._lastBin.distanceTo(TMP2.set(eye.x, eye.z)) > 8 || Math.abs(eye.y - (this._lastY ?? 0)) > Math.max(4, Math.abs(eye.y) * 0.1)) this._bin(eye);
    this.uniforms.uWind.value.set(...this.world.env.wind);
  }
  _bin(eye) {
    this._dirty = false; this._lastBin.set(eye.x, eye.z); this._lastY = eye.y;
    const T = this.cfg.tile, half = T * 0.71, B = this.bands, F = this.cfg.fade * 3;
    const alt = Math.max(0, eye.y - this.source.height(eye.x, eye.z)); // LOD by the distance in 3D, not on the map
    const counts = this.meshes.map((pv) => pv.map((pl) => pl.map(() => 0)));
    const lists = this.meshes.map((pv) => pv.map((pl) => pl.map(() => [])));
    let trees = 0;
    for (const t of this.tiles.values()) {
      const d = Math.hypot((t.i + 0.5) * T - eye.x, (t.j + 0.5) * T - eye.z, alt);
      for (let l = 0; l < 3; l++) {
        if (d + half < B[l] - F || d - half > B[l + 1] + F) continue;
        for (let k = 0; k < this.kinds.length; k++) for (let v = 0; v < this.cfg.variants; v++) { const a = t.items[k][v]; if (a.length) { lists[k][v][l].push(a); counts[k][v][l] += a.length / 8; if (l === 0) trees += a.length / 8; } }
      }
    }
    for (let k = 0; k < this.kinds.length; k++) for (let v = 0; v < this.cfg.variants; v++) for (let l = 0; l < 3; l++) {
      const mesh = this.meshes[k][v][l], ud = mesh.userData, n = counts[k][v][l];
      if (n > ud.cap) { // grow
        let cap = ud.cap; while (cap < n) cap *= 2;
        const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * 8), 8); buf.setUsage(THREE.DynamicDrawUsage);
        mesh.geometry.setAttribute('aI0', new THREE.InterleavedBufferAttribute(buf, 4, 0));
        mesh.geometry.setAttribute('aI1', new THREE.InterleavedBufferAttribute(buf, 4, 4));
        ud.buf = buf; ud.cap = cap;
      }
      const arr = ud.buf.array; let o = 0;
      for (const a of lists[k][v][l]) { arr.set(a, o); o += a.length; }
      ud.buf.needsUpdate = true;
      mesh.geometry.instanceCount = n; ud.count = n;
      mesh.visible = n > 0;
    }
    this.stats.trees = trees; this.stats.tiles = this.tiles.size;
  }
}
const TMP2 = new THREE.Vector2();
