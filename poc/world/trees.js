// Forests (W3). Three ranges, one set of trees:
//   near    the trees as card meshes (treecards.js): a trunk and branches of low-poly cylinders, a crown of leaf
//           clusters cut out of a pixel-art atlas by alpha; three levels of detail, dithered across the band edges.
//           Placed per 64 m tile on the CPU by scatter.js (deterministic), or the sim's own trees one for one in
//           the game's world; streamed nearest first within a budget.
//   far     the same trees as impostors: one quad per tree, placed entirely on the GPU from the clipmap (the same
//           grid, hash and rules as scatter.js, written again in GLSL), so where the meshes end the impostors begin
//           at the same spots. Each quad shows the view of its tree baked at start-up from the level-0 mesh, eight
//           ways round, with its normals, so it is lit by the sun and the sky like the mesh. Beyond 1.2 km one card
//           stands for the four trees of its cell. Culled in the vertex shader; nothing per tree in JS.
//   beyond  the canopy painted into the ground (terrain.js).
// Rocks stay signed-distance meshes (mesh.js).
import * as THREE from 'three';
import { treeDesign, meshTreeCards, leafAtlas, TREE_KINDS } from './treecards.js';
import { treeDesign as rockDesign, meshTree as meshRock } from './mesh.js';
import { placeTile } from './scatter.js';
import { NOISE_GLSL } from './noise.js';
import { CLOUD_SHADOW_GLSL } from './clouds.js';

export const FOREST = { tile: 64, variants: 3, bands: [0, 45, 160, 420], fade: 12, grid: 5.2, meadow: 0.012, budgetMs: 4, far: [1200, 6000], impostor: 128, views: 8 };

const TREE_VERT_HEAD = /* glsl */ `
attribute vec4 aI0; // x, z, turn, variety
attribute vec4 aI1; // horizontal scale, vertical scale
attribute float aSway, aLeaf; attribute vec3 aCtr;
uniform float uTime; uniform vec2 uWind; uniform vec3 uBand; // near, far, fade width
varying float vFade, vLeaf, vVar; varying vec3 vTW; varying vec2 vUvL;
`;
const TREE_VERT = /* glsl */ `
  vec3 transformed = position;
  float ph = aI0.w * 6.283 + aI0.x * 0.13 + aI0.y * 0.17;
  float ws = length(uWind); vec2 wd = ws > 0.001 ? uWind / ws : vec2(1.0, 0.0);
  // the whole tree leans and rocks with the wind, more toward the top; clusters flutter about their centres
  float sway = (0.45 + 0.35 * sin(uTime * 1.05 + ph) + 0.2 * sin(uTime * 2.6 + ph * 1.7)) * ws;
  transformed.xz += wd * sway * aSway * 0.32;
  if (aLeaf > 0.5) {
    float fl = (0.03 + 0.05 * ws) * sin(uTime * (5.0 + 3.0 * fract(aCtr.x * 7.1)) + aCtr.y * 3.0 + ph);
    vec3 off = transformed - aCtr; transformed = aCtr + off * (1.0 + fl) + vec3(0.0, fl * 0.5, 0.0);
  }
  float cs = cos(aI0.z), sn = sin(aI0.z);
  transformed = vec3(cs * transformed.x - sn * transformed.z, transformed.y, sn * transformed.x + cs * transformed.z) * vec3(aI1.x, aI1.y, aI1.x);
  if (aLeaf < 0.5 && aI1.z > 0.5) transformed = vec3(0.0, -1000.0, 0.0); // the game draws this tree's trunk itself
  vec2 base = aI0.xy;
  transformed += vec3(base.x, clipHeight(base) - 0.12 * aI1.y, base.y);
  vTW = transformed; vLeaf = aLeaf; vVar = aI0.w; vUvL = uv;
  float dI = length(vec3(base.x, transformed.y, base.y) - cameraPosition);
  vFade = smoothstep(uBand.x - uBand.z, uBand.x, dI) * (1.0 - smoothstep(uBand.y, uBand.y + uBand.z, dI));
`;
const TREE_NORMAL = /* glsl */ `
  vec3 objectNormal = vec3(cos(aI0.z) * normal.x - sin(aI0.z) * normal.z, normal.y, sin(aI0.z) * normal.x + cos(aI0.z) * normal.z);
`;
const DITHER = /* glsl */ `
float w2ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); } // interleaved gradient noise
`;
// the season's leaves (seasons.js sets these): uLeafTint multiplies the leaf colour (spring light, summer deep);
// uAutumn 0..1 turns each tree yellow, orange or red by its variety; uLeafGone 0..1 is the share of leaves fallen;
// uSnowOn whitens the upper leaves
export const SEASON_GLSL = /* glsl */ `
uniform vec3 uLeafTint; uniform float uAutumn, uLeafGone, uSnowOn;
vec3 seasonLeaf(vec3 c, float var) {
  vec3 aut = var < 0.33 ? vec3(0.78, 0.55, 0.08) : var < 0.66 ? vec3(0.75, 0.32, 0.06) : vec3(0.6, 0.12, 0.05);
  float lum = min(1.0, dot(c, vec3(0.3, 0.6, 0.1)) * 3.0);
  return mix(c * uLeafTint, pow(aut, vec3(2.2)) * lum, uAutumn);
}
`;

export class Forest {
  constructor(world, opts = {}) {
    this.world = world; this.source = world.source;
    this.cfg = { ...FOREST, ...opts, far: Array.isArray(opts.far) ? opts.far : FOREST.far };
    const scale = opts.range ?? 1;
    this.bands = this.cfg.bands.map((b) => b * scale);
    this.group = new THREE.Group(); this.group.name = 'world2-forest';
    this.tiles = new Map(); this.queue = [];
    const atlas = leafAtlas();
    this.atlas = new THREE.DataTexture(atlas.data, atlas.size, atlas.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.atlas.minFilter = THREE.LinearMipmapLinearFilter; this.atlas.magFilter = THREE.NearestFilter; this.atlas.generateMipmaps = true; this.atlas.needsUpdate = true;
    this.uniforms = {
      uTime: world.uniforms.uTime, uWind: { value: new THREE.Vector2(0.8, 0.3) }, uSunDir: world.uniforms.uSunDir, uSunColor: world.sky.uniforms.uSunColor, uSkyUp: { value: new THREE.Color() },
      tLeaf: { value: this.atlas }, uLeafTint: { value: new THREE.Vector3(1, 1, 1) }, uAutumn: { value: 0 }, uLeafGone: { value: 0 }, uSnowOn: { value: 0 },
      tCloudShadow: world.uniforms.tCloudShadow, uCloudRect: world.uniforms.uCloudRect,
      ...world.clip.uniforms,
    };
    this.clipGLSL = world.clip.glsl();
    this.trunks = true; // designs keep their trunks; an instance flag (scatter.js) hides the wood where the game draws it
    this.kinds = this.source.objects && !this.source.wildFrom ? ['oak', 'birch'] : TREE_KINDS;
    this.meshes = []; // [kind][variant][lod]
    this.designs = []; // [kind][variant]
    this.stats = { trees: 0, tiles: 0, tris: [0, 0, 0], buildMs: 0, far: 0 };
    const t0 = performance.now();
    for (const kind of this.kinds) {
      const perV = [], perD = [];
      for (let v = 0; v < this.cfg.variants; v++) {
        const perL = [];
        if (kind === 'rock') {
          const d = rockDesign('rock', v + 1); perD.push(d);
          for (let l = 0; l < 3; l++) { const m = meshRock(d, [0.12, 0.3, 0.7][l]); perL.push(this._makeMesh({ ...m, uv: null, ctr: null }, l, kind)); this.stats.tris[l] += m.tris; }
        } else {
          const d = treeDesign(kind, v + 1, { trunk: this.trunks }); perD.push(d);
          for (let l = 0; l < 3; l++) { const m = meshTreeCards(d, l); perL.push(this._makeMesh(m, l, kind)); this.stats.tris[l] += m.tris; }
        }
        perV.push(perL);
      }
      this.meshes.push(perV); this.designs.push(perD);
    }
    this.stats.buildMs = performance.now() - t0;
    this.design = { oak: this.designs[0][0], birch: this.designs[1][0] };
    this._lastBin = new THREE.Vector2(1e9, 1e9);
    this._dirty = true;
    // the far forest: impostors baked from the level-0 meshes, placed on the GPU (not for a source with fixed objects
    // and no wild land beyond them)
    this.farOn = (!this.source.objects || !!this.source.wildFrom) && opts.far !== false;
    if (this.farOn) this._makeFar();
  }
  _makeMesh(m, lod, kind) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(m.uv || new Float32Array(m.pos.length / 3 * 2), 2));
    g.setAttribute('aSway', new THREE.BufferAttribute(m.sway, 1));
    g.setAttribute('aLeaf', new THREE.BufferAttribute(m.leaf, 1));
    g.setAttribute('aCtr', new THREE.BufferAttribute(m.ctr || new Float32Array(m.pos.length), 3));
    g.setIndex(m.idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const cap = 256, buf = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * 8), 8);
    buf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aI0', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    g.setAttribute('aI1', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    g.instanceCount = 0;
    const band = new THREE.Vector3(this.bands[lod], this.bands[lod + 1], this.cfg.fade * (1 + lod));
    const U = { ...this.uniforms, uBand: { value: band } };
    const leafy = kind !== 'rock';
    // leaves are cards: both sides, cut by alpha (to coverage where the target has samples, so the edges are soft)
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: leafy ? THREE.DoubleSide : THREE.FrontSide, alphaToCoverage: leafy });
    const clip = this.clipGLSL;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = `${clip}\n${TREE_VERT_HEAD}\n` + sh.vertexShader.replace('#include <begin_vertex>', TREE_VERT).replace('#include <beginnormal_vertex>', TREE_NORMAL);
      sh.fragmentShader = `${DITHER}\n${SEASON_GLSL}\n${CLOUD_SHADOW_GLSL}\nuniform sampler2D tLeaf; uniform vec3 uSunDir, uSunColor; varying float vFade, vLeaf, vVar; varying vec3 vTW; varying vec2 vUvL;\n` + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (w2ign(gl_FragCoord.xy) > vFade) discard;')
        .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
  if (vLeaf > 0.5) {
    vec4 lf = texture(tLeaf, vUvL);
    if (lf.a < 0.5 || w2ign(gl_FragCoord.xy + 7.0) < uLeafGone) discard; // winter: the leaves go, leaf by leaf
    diffuseColor.rgb *= lf.r * lf.g * mix(vec3(1.07, 1.0, 0.82), vec3(0.86, 1.0, 1.1), vVar);
    diffuseColor.rgb = seasonLeaf(diffuseColor.rgb, vVar);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.88, 0.95), uSnowOn * smoothstep(0.2, 0.8, vNormal.y) * 0.8); // snow on the upper leaves
  }`)
        .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
  { float cs = cloudShadow(vTW.xz); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }
  if (vLeaf > 0.5) { // sunlight through the leaves: strongest looking toward the sun
    vec3 V = normalize(vTW - cameraPosition);
    float back = pow(clamp(dot(V, uSunDir), 0.0, 1.0), 4.0);
    reflectedLight.directDiffuse += uSunColor * diffuseColor.rgb * (0.9 * back + 0.08) * 0.35;
  }`);
    };
    mat.customProgramCacheKey = () => 'w3tree' + lod + (leafy ? 'L' : 'R') + '/' + this.world.clip.cfg.levels;
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = `${clip}\n${TREE_VERT_HEAD}\n` + sh.vertexShader.replace('#include <begin_vertex>', TREE_VERT);
      sh.fragmentShader = `${DITHER}\nuniform sampler2D tLeaf; uniform float uLeafGone; varying float vFade, vLeaf; varying vec2 vUvL;\n` + sh.fragmentShader.replace('void main() {', 'void main() {\n  if (w2ign(gl_FragCoord.xy) > vFade) discard;\n  if (vLeaf > 0.5 && (texture(tLeaf, vUvL).a < 0.5 || w2ign(gl_FragCoord.xy + 7.0) < uLeafGone)) discard;');
    };
    depth.customProgramCacheKey = () => 'w3treeD' + lod + (leafy ? 'L' : 'R') + '/' + this.world.clip.cfg.levels;
    const mesh = new THREE.Mesh(g, mat);
    mesh.customDepthMaterial = depth;
    mesh.frustumCulled = false; mesh.castShadow = lod < 2; mesh.receiveShadow = true;
    mesh.userData = { buf, cap, count: 0, U };
    this.group.add(mesh);
    return mesh;
  }

  // ---- impostors: every tree kind and variety, from eight sides, albedo and normal, into two atlases
  _makeFar() {
    const r = this.world.renderer, I = this.cfg.impostor, V = this.cfg.views, kinds = this.kinds.filter((k) => k !== 'rock'), nk = kinds.length, nv = this.cfg.variants;
    const cols = V, rows = nk * nv, W = cols * I, H = rows * I;
    const mk = () => new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true });
    this.impA = mk(); this.impN = mk();
    // a bake material: vertex colour times the leaf texture (albedo, alpha 1 for leaves and 0.6 for wood), or the normal
    const bake = (normalPass) => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, side: THREE.DoubleSide, uniforms: { tLeaf: { value: this.atlas } },
      vertexShader: `in vec3 color; in float aLeaf; out vec3 vC, vN; out vec2 vUv; out float vL; void main() { vC = color; vN = normalize((modelViewMatrix * vec4(normal, 0.0)).xyz); vUv = uv; vL = aLeaf; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `precision highp float; uniform sampler2D tLeaf; in vec3 vC, vN; in vec2 vUv; in float vL; out vec4 o; void main() {
  vec4 lf = vL > 0.5 ? texture(tLeaf, vUv) : vec4(1.0);
  if (lf.a < 0.5) discard;
  ${normalPass ? 'vec3 n = normalize(vN); if (vL > 0.5) n.z = abs(n.z); o = vec4(n * 0.5 + 0.5, 1.0);' : 'o = vec4(vC * (vL > 0.5 ? lf.r * lf.g : 1.0), vL > 0.5 ? 1.0 : 0.6);'}
}`,
    });
    const matA = bake(false), matN = bake(true);
    const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera();
    const prev = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    this.impMeta = []; // per kind and variety: the baked box (width, height)
    for (let k = 0; k < nk; k++) for (let v = 0; v < nv; v++) {
      const d = treeDesign(kinds[k], v + 1, { trunk: true }), m = meshTreeCards(d, 0);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3)); g.setAttribute('color', new THREE.BufferAttribute(m.col, 3)); g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2)); g.setAttribute('aLeaf', new THREE.BufferAttribute(m.leaf, 1)); g.setIndex(m.idx);
      const mesh = new THREE.Mesh(g, matA); scene.add(mesh);
      const hw = Math.max(d.crownR * 1.3, 0.6), hh = d.height * 0.5 + 0.4;
      this.impMeta.push([hw * 2, hh * 2]);
      for (let s = 0; s < V; s++) {
        const a = s / V * Math.PI * 2;
        cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh; cam.near = -100; cam.far = 100; cam.updateProjectionMatrix();
        cam.position.set(Math.sin(a) * 50, hh - 0.4, Math.cos(a) * 50); cam.lookAt(0, hh - 0.4, 0); cam.updateMatrixWorld();
        const x = s * I, y = (k * nv + v) * I;
        for (const [rt, mt] of [[this.impA, matA], [this.impN, matN]]) {
          // a render target draws into its own viewport and scissor (the renderer's apply to the canvas only)
          mesh.material = mt; rt.viewport.set(x, y, I, I); rt.scissor.set(x, y, I, I); rt.scissorTest = true;
          r.setRenderTarget(rt); r.clear(true, true, false); r.render(scene, cam);
        }
      }
      scene.remove(mesh); g.dispose();
    }
    for (const rt of [this.impA, this.impN]) { rt.viewport.set(0, 0, W, H); rt.scissor.set(0, 0, W, H); rt.scissorTest = false; }
    r.setRenderTarget(prev); r.setClearColor(cc, ca);
    matA.dispose(); matN.dispose();
    // the far rings: cells as instances; the vertex shader places, keeps or drops, culls and billboards each tree
    const G = this.cfg.grid, F = this.cfg.far, meta = [];
    this.impMeta.forEach((m) => meta.push(new THREE.Vector4(m[0], m[1], 0, 0)));
    this.farMeshes = [];
    const rings = [[G, this.bands[3] - this.cfg.fade * 2, F[0], 1], [G * 2, F[0], F[1], 2]];
    for (const [sp, rin, rout, mul] of rings) {
      const n = Math.ceil(rout / sp), cells = [];
      for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) { const d = Math.hypot(i, j) * sp; if (d <= rout + sp && d >= rin - sp * 3) cells.push(i, j); }
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cells), 2));
      geo.instanceCount = cells.length / 2; geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const U = {
        ...this.uniforms, tImpA: { value: this.impA.texture }, tImpN: { value: this.impN.texture }, uMeta: { value: meta },
        uSp: { value: sp }, uGrid: { value: G }, uRin: { value: rin }, uRout: { value: rout }, uMul: { value: mul }, uCam: { value: new THREE.Vector3() }, uVP: { value: new THREE.Matrix4() },
        uSea: { value: this.source.sea }, uWildFrom: { value: this.source.wildFrom || 0 }, uFade: { value: this.cfg.fade * 2 },
      };
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, uniforms: U, side: THREE.DoubleSide, transparent: false, alphaToCoverage: true,
        vertexShader: `${this.clipGLSL}\n${NOISE_GLSL}\n${FAR_VERT(nk, nv, V)}`,
        fragmentShader: `precision highp float; precision highp int;\n${DITHER}\n${SEASON_GLSL}\n${CLOUD_SHADOW_GLSL}\n${FAR_FRAG(nk, nv, V)}`,
      });
      mat.customProgramCacheKey = () => 'w3far' + mul + '/' + this.world.clip.cfg.levels;
      const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.userData = { U, instances: cells.length / 2, ring: true, world2: true };
      this.group.add(mesh); this.farMeshes.push(mesh);
    }
  }

  // ---- placement (scatter.js, pure, tested)
  _genTile(ti, tj) { return placeTile(this.source, ti, tj, this.kinds, this.cfg, this.design); }

  update(eye, dt) {
    const T = this.cfg.tile, R = this.bands[3] + this.cfg.fade * 3;
    const ci = Math.floor(eye.x / T), cj = Math.floor(eye.z / T), rt = Math.ceil(R / T) + 1;
    const t0 = performance.now();
    if (!this._q || this._qc !== ci + ',' + cj) {
      this._qc = ci + ',' + cj; this._q = [];
      for (let j = cj - rt; j <= cj + rt; j++) for (let i = ci - rt; i <= ci + rt; i++) {
        const d = Math.hypot((i + 0.5) * T - eye.x, (j + 0.5) * T - eye.z);
        if (d < R + T && !this.tiles.has(i + ',' + j)) this._q.push([d, i, j]);
      }
      this._q.sort((a, b) => a[0] - b[0]);
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
    this.uniforms.uSkyUp.value.copy(this.world.sky.skyUp);
    if (this.farMeshes) {
      const cam = this.world.camera;
      for (const m of this.farMeshes) { m.userData.U.uCam.value.copy(eye); m.userData.U.uVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); }
      this.stats.far = this.farMeshes.reduce((a, m) => a + m.userData.instances, 0);
    }
  }
  _bin(eye) {
    this._dirty = false; this._lastBin.set(eye.x, eye.z); this._lastY = eye.y;
    const T = this.cfg.tile, half = T * 0.71, B = this.bands, F = this.cfg.fade * 3;
    const alt = Math.max(0, eye.y - this.source.height(eye.x, eye.z));
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
      if (n > ud.cap) {
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

// The far ring's vertex shader: scatter.js's wild placement again in GLSL (the same grid, hashes and rules), then the
// impostor quad billboarded about its trunk, culled against the view, dithered in where the meshes end.
// scatter.js's wild rule, written again in GLSL on the clipmap: the same grid, hashes and thresholds. Returns false for
// an empty cell; k is the kind (0 oak, 1 birch, 2 pine, 3 bush), with the place, scales, turn and variety
export const PLACE_GLSL = /* glsl */ `
bool wildPlace(int ix, int iz, float G, float sea, float wildFrom, out vec2 base, out int k, out float sxz, out float sy, out float rot, out float var) {
  base = (vec2(float(ix), float(iz)) + 0.15 + 0.7 * vec2(w2hash01(ix, iz, 21), w2hash01(ix, iz, 22))) * G;
  k = 0; sxz = 1.0; sy = 1.0; rot = 0.0; var = 0.0;
  if (wildFrom > 0.0 && length(base) < wildFrom) return false; // inside the settled area the chunks' own trees stand
  vec4 gd = clipAt(base); float h = gd.x, f = gd.z, wet = gd.y, trail = gd.w, wl = clipWater(base);
  if (h < wl + 0.7 || trail > 0.25) return false;
  float p = f * 0.88 + ${FOREST.meadow.toFixed(3)};
  float r = w2hash01(ix, iz, 23);
  if (r > p) { // a bush where the forest thins, else nothing
    if (!(r < p + 0.22 * min(1.0, f * 3.0) * (1.0 - f) + 0.004)) return false;
    k = 3;
  } else {
    vec3 n = clipNormal(base); if (1.0 - n.y > 0.52) return false; // steep ground (scatter.js: slope > 0.9 over 1.5 m)
    float alt = h - sea;
    if (alt > 120.0 + 40.0 * w2noise(base / 300.0, 31) || (wet < 0.38 && f > 0.4)) k = 2;
    else if (wet > 0.62 && w2hash01(ix, iz, 28) < 0.45) k = 1;
  }
  float s = k == 3 ? 0.8 + 0.6 * w2hash01(ix, iz, 26) : 0.82 + 0.45 * w2hash01(ix, iz, 29);
  sy = k == 3 ? 0.8 + 0.5 * w2hash01(ix, iz, 27) : s; sxz = k == 3 ? s : s * (0.9 + 0.2 * w2hash01(ix, iz, 30));
  rot = w2hash01(ix, iz, 24) * 6.283; var = w2hash01(ix, iz, 25);
  return true;
}
`;
const FAR_VERT = (nk, nv, V) => PLACE_GLSL + /* glsl */ `
in vec2 aCell;
uniform vec4 uMeta[${nk * nv}];
uniform float uSp, uGrid, uRin, uRout, uMul, uSea, uWildFrom, uFade, uTime; uniform vec3 uCam; uniform mat4 uVP; uniform vec2 uWind;
out vec2 vUv; out float vKill, vVar, vFade; out vec3 vW; flat out int vSlice; flat out int vRow;
void main() {
  vec2 org = floor(uCam.xz / uSp) * uSp;
  vec2 cw = org + aCell * uSp;
  int ix = int(floor(cw.x / uGrid)), iz = int(floor(cw.y / uGrid));
  if (uMul > 1.5) { ix += int(w2hash01(ix, iz, 19) * 2.0); iz += int(w2hash01(ix, iz, 20) * 2.0); } // one of the four cells of a doubled cell
  vec2 base; int k; float sxz, sy, rot; vKill = 1.0; vFade = 0.0; vVar = 0.0; vW = vec3(0.0); vUv = uv; vSlice = 0; vRow = 0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  float dist = length((vec2(float(ix), float(iz)) + 0.5) * uGrid - uCam.xz);
  if (dist < uRin - uFade || dist > uRout) return;
  if (!wildPlace(ix, iz, uGrid, uSea, uWildFrom, base, k, sxz, sy, rot, vVar)) return;
  if (k >= ${nk}) return;
  float h = clipHeight(base);
  int v = int(w2hash01(int(floor(base.x * 7.0)), int(floor(base.y * 7.0)), 11) * ${nv}.0);
  // the quad: billboarded about the trunk, the size of the baked box, scaled; a doubled cell's card is wider
  int row = k * ${nv} + v; vRow = row; vec4 M = uMeta[row];
  float w = M.x * sxz * (uMul > 1.5 ? 1.5 : 1.0), hgt = M.y * sy;
  vec3 toC = uCam - vec3(base.x, h, base.y); float az = atan(toC.x, toC.z);
  vec3 right = vec3(cos(az), 0.0, -sin(az));
  // seen from above, a standing card is a sliver: it tilts toward a high camera (about its foot), so the crown
  // still shows as a mass; from the ground it stands straight
  float elev = atan(toC.y, length(toC.xz));
  vec3 upv = normalize(mix(vec3(0.0, 1.0, 0.0), normalize(toC), smoothstep(0.35, 1.2, elev) * 0.85));
  // the view: which of the ${V} bakes faces the camera, given the tree's own turn
  float rel = az - rot; vSlice = int(floor(fract(rel / 6.2831853 + 0.5 / ${V}.0) * ${V}.0));
  float sway = 0.15 * length(uWind) * sin(uTime * 1.05 + base.x * 0.13 + base.y * 0.17);
  vec3 P = vec3(base.x, h - 0.12 * sy, base.y) + right * position.x * w * 0.5 + upv * position.y * hgt + vec3(uWind.x, 0.0, uWind.y) * sway * position.y * position.y * sy;
  vec4 c = uVP * vec4(P, 1.0);
  if (c.w <= 0.0 || abs(c.x) > c.w * 1.25 || abs(c.y) > c.w * 1.25) return;
  vKill = 0.0; vW = P;
  vFade = smoothstep(uRin - uFade, uRin, dist) * (1.0 - smoothstep(uRout - uRout * 0.08, uRout, dist));
  gl_Position = c;
}`;
const FAR_FRAG = (nk, nv, V) => /* glsl */ `
uniform sampler2D tImpA, tImpN; uniform vec3 uSunDir, uSunColor, uSkyUp, uCam;
in vec2 vUv; in float vKill, vVar, vFade; in vec3 vW; flat in int vSlice; flat in int vRow;
layout(location = 0) out vec4 oColor;
void main() {
  if (vKill > 0.5 || w2ign(gl_FragCoord.xy) > vFade) discard;
  vec2 uv = (vec2(float(vSlice), float(vRow)) + vUv) / vec2(${V}.0, ${nk * nv}.0);
  vec4 a = texture(tImpA, uv);
  if (a.a < 0.5 || (a.a > 0.75 && w2ign(gl_FragCoord.xy + 7.0) < uLeafGone)) discard;
  vec3 n = texture(tImpN, uv).xyz * 2.0 - 1.0;
  // the baked normal is in the bake camera's frame (z toward it); turned into the world by the view azimuth
  vec3 toC = uCam - vW; float az = atan(toC.x, toC.z);
  vec3 N = normalize(vec3(cos(az) * n.x + sin(az) * n.z, n.y, -sin(az) * n.x + cos(az) * n.z));
  vec3 alb = a.rgb;
  if (a.a > 0.75) { alb = seasonLeaf(alb * mix(vec3(1.07, 1.0, 0.82), vec3(0.86, 1.0, 1.1), vVar), vVar); alb = mix(alb, vec3(0.85, 0.88, 0.95), uSnowOn * smoothstep(0.2, 0.8, N.y) * 0.8); }
  float ao = 0.55 + 0.45 * vUv.y; // cheap: darker toward the ground
  vec3 V = normalize(vW - uCam);
  float back = pow(clamp(dot(V, uSunDir), 0.0, 1.0), 4.0);
  vec3 col = alb * (uSunColor * max(dot(N, uSunDir), 0.0) * cloudShadow(vW.xz) + uSkyUp * (0.55 + 0.45 * N.y)) / 3.14159 * ao + uSunColor * alb * (0.9 * back + 0.08) * 0.1 * step(0.75, a.a);
  oColor = vec4(col, 1.0);
}`;
