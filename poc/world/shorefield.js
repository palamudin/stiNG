// The shore table (W3.1): the water line is world data (the ground does not move), so everything the water and the
// beach need to know about it is baked once per world chunk and kept, like a chunk of the map: three levels of fixed
// chunks (128 m at 0.5 m texels, 1 km at 4 m, 4 km at 16 m), each chunk 256 texels a side holding, per texel:
//   x  the signed distance to the water line in metres: above the water positive, under it negative;
//   yz the direction to the nearest point of the water line (from the water: the way waves travel in), scaled by the
//      front's coherence: 1 where the travel time runs cleanly from one shore, falling to 0 along the spine of a body
//      where fronts from two shores meet (so the trains fade there instead of folding);
//   w  the travel time of a shallow-water front from the line, in seconds: the eikonal |grad tau| = 1 / sqrt(g depth)
//      (depth clamped to 0.3..14 m) solved from the line outward, so fronts slow in the shallows and bend round
//      headlands and the field is continuous everywhere (a straight line to the nearest shore point is not: its time
//      jumps where the nearest point jumps, and that drew lines on the water); positive on the water, negative up the
//      beach at the swash's speed, so one phase runs from the breakers to the run-up.
// Baked on the GPU from the source's own GLSL twin where it has one (exact at any point, no view in it; the clipmap
// otherwise) by jump flooding (Rong and Tan 2006) over the chunk plus a margin, so a point by a chunk's edge finds the
// same nearest shore point its neighbour across the edge finds: no seams between chunks. A chunk is baked when it
// first comes near and stays in its slot until the slots run out and the farthest is let go; nothing per frame
// computes a shoreline. A level answers where the line is within its margin; past that the next level does. Floats,
// not halves: the travel time is a phase, and a half's step across a 5 s wave is a visible terrace. The precision is
// the row count: the reader addresses a texel; finer texels cost memory and bake time, nothing per pixel.
// Two more layers ride in the same array texture, read through the one sampler the composite can spare (it is at the
// fragment sampler limit of Chrome on Windows, 16): the glints' Poisson table (water.js), and a copy of the clouds'
// shadow map each frame (clouds.js), so the sea darkens under a cloud like the ground does.
import * as THREE from 'three';
import { POISSON, poissonTableData } from './water.js';

export const SHORE = {
  beach: true,                    // the beach layer (the swash sheet, the wet sand, the sea's edge lifted by the tongue); off: the water ends at the still-water line with the breakers alone
  tex: 256,                       // texels a chunk side
  levels: [{ s: 0.5, slots: 32, margin: 32 }, { s: 4, slots: 12, margin: 256 }, { s: 16, slots: 6, margin: 1024 }], // texel size, slots kept, metres the bake looks past the chunk
  near: 1,                        // chunks round the eye's wanted at each level (1: the 3 x 3)
  dirN: 16,                       // the directory: chunks a side the reader can address at each level, round the eye
  sweeps: 110,                    // Jacobi passes of the eikonal solve: the travel time reaches that many texels from the line
  gradM: 8,                       // metres of the stencil the direction and coherence are taken over
  dMin: 0.3, dMax: 14,
  perFrame: 2,                    // bakes a frame at most once running
};

const VS = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
const G = 9.81;

export class ShoreField {
  // source: a source with a GLSL twin bakes exactly from it; without one the clipmap is read
  constructor(renderer, clip, source, cfg = {}) {
    this.cfg = { ...SHORE, ...cfg };
    const C = this.cfg, T = C.tex, M = C.levels.reduce((a, L) => Math.max(a, Math.ceil(L.margin / L.s)), 0), W = T + 2 * M; // the bake window
    this.renderer = renderer; this.clip = clip; this.source = source; this.W = W; this.M = M;
    this.levels = C.levels.map((L, k) => ({ ...L, k, chunk: L.s * T, slotBase: C.levels.slice(0, k).reduce((a, l) => a + l.slots, 0), slots: Array.from({ length: L.slots }, () => ({ cx: null, cz: null, used: 0 })) }));
    const nSlots = C.levels.reduce((a, L) => a + L.slots, 0);
    this.tables = nSlots; this.cloud = nSlots + 1;
    this.rt = new THREE.WebGLArrayRenderTarget(T, T, nSlots + 2, { depthBuffer: false });
    Object.assign(this.rt.texture, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    const o = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.rtH = new THREE.WebGLRenderTarget(W, W, o); this.rtS = new THREE.WebGLRenderTarget(W, W, o); this.ping = new THREE.WebGLRenderTarget(W, W, o); this.pong = new THREE.WebGLRenderTarget(W, W, o); this.rtT = new THREE.WebGLRenderTarget(W, W, o);
    const D = C.dirN * C.dirN / 4;
    this.uniforms = {
      uShoreTab: { value: this.rt.texture },
      uShoreLv: { value: this.levels.map(() => new THREE.Vector4()) },        // texel, chunk size, directory origin chunk x, z
      uShoreDir: { value: Array.from({ length: this.levels.length * D }, () => new THREE.Vector4(-1, -1, -1, -1)) }, // slot per chunk of the directory, 4 a vec4, -1 none
      uShoreOn: { value: 0 },
      uShoreCloudRect: { value: new THREE.Vector4(0, 0, 1, 0) }, // index.js points this at the clouds' own
    };
    const exact = !!source.glsl;
    const U = { ...clip.uniforms, ...(exact ? source.uniforms : {}), uOrg: { value: new THREE.Vector2() }, uCell: { value: 1 }, uStep: { value: 1 }, uSrc: { value: null }, uSrc2: { value: null }, uMargin: { value: 0 } };
    const head = `precision highp float; precision highp int;\n${clip.glsl()}\n${exact ? source.glsl : ''}\nuniform vec2 uOrg; uniform float uCell, uStep, uMargin; uniform highp sampler2D uSrc, uSrc2; out vec4 o;
vec2 shoreP(ivec2 u) { return uOrg + (vec2(u) + 0.5) * uCell; }
float shoreEAt(ivec2 u) { return texelFetch(uSrc, u, 0).x; }`;
    const mat = (frag) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: U, vertexShader: VS, fragmentShader: head + '\n' + frag, depthTest: false, depthWrite: false });
    // the window's heights above the water, once per texel (the source itself, or the clipmap)
    this._height = mat(exact
      ? `void main() { vec2 p = shoreP(ivec2(gl_FragCoord.xy)); vec4 S; float wl; wildSampleW(p, S, wl); o = vec4(S.x - wl, 0.0, 0.0, 1.0); }`
      : `void main() { vec2 p = shoreP(ivec2(gl_FragCoord.xy)); o = vec4(clipAt(p).x - clipWater(p), 0.0, 0.0, 1.0); }`);
    // the seed: texel u holds the nearest water-line crossing with its four neighbours, if any
    this._seed = mat(`
void main() {
  ivec2 u = ivec2(gl_FragCoord.xy); vec2 p = shoreP(u);
  float e0 = shoreEAt(u); vec2 best = vec2(0.0); float bd = 1e9, has = 0.0;
  ivec2 N[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int n = 0; n < 4; n++) {
    ivec2 v = u + N[n]; if (any(lessThan(v, ivec2(0))) || any(greaterThan(v, ivec2(${W - 1})))) continue;
    float e1 = shoreEAt(v);
    if ((e0 < 0.0) == (e1 < 0.0)) continue;
    float f = e0 / (e0 - e1); vec2 c = p + vec2(N[n]) * f * uCell; float d = f * uCell;
    if (d < bd) { bd = d; best = c; has = 1.0; }
  }
  o = vec4(best, has, e0);
}`);
    // one flood pass: the nearest seed among this texel's and its eight neighbours' at the step
    this._flood = mat(`
void main() {
  ivec2 u = ivec2(gl_FragCoord.xy); vec2 p = shoreP(u);
  vec4 me = texelFetch(uSrc, u, 0); float bd = me.z > 0.5 ? distance(me.xy, p) : 1e9; vec4 best = me;
  int s = int(uStep);
  for (int dj = -1; dj <= 1; dj++) for (int di = -1; di <= 1; di++) {
    if (di == 0 && dj == 0) continue;
    ivec2 v = u + ivec2(di, dj) * s; if (any(lessThan(v, ivec2(0))) || any(greaterThan(v, ivec2(${W - 1})))) continue;
    vec4 c = texelFetch(uSrc, v, 0); if (c.z < 0.5) continue;
    float d = distance(c.xy, p); if (d < bd) { bd = d; best = vec4(c.xy, 1.0, me.w); }
  }
  o = best;
}`);
    // the eikonal: seeds at the crossings (uSrc: the seed pass; uSrc2: the heights) start the time at their distance
    // to the line over the local speed, everything else at infinity
    const slow = `float slowAt(ivec2 v) { float e = texelFetch(uSrc2, clamp(v, ivec2(0), ivec2(${W - 1})), 0).x; float dep = clamp(e < 0.0 ? -e : ${C.dMin.toFixed(2)}, ${C.dMin.toFixed(2)}, ${C.dMax.toFixed(1)}); return uCell / sqrt(${G.toFixed(2)} * dep); }`;
    this._eikInit = mat(`${slow}
void main() { ivec2 u = ivec2(gl_FragCoord.xy); vec4 sd = texelFetch(uSrc, u, 0);
  o = vec4(sd.z > 0.5 ? distance(sd.xy, shoreP(u)) / uCell * slowAt(u) : 1.0e9, 0.0, 0.0, 1.0); }`);
    // one Jacobi pass of the Godunov update (Zhao 2005): a texel's time is the least its four neighbours offer at the
    // local slowness; the seeds only ever keep their own
    this._eik = mat(`${slow}
float tAt(ivec2 v) { return texelFetch(uSrc, clamp(v, ivec2(0), ivec2(${W - 1})), 0).x; }
void main() { ivec2 u = ivec2(gl_FragCoord.xy); float t0 = tAt(u), f = slowAt(u);
  float a = min(tAt(u - ivec2(1, 0)), tAt(u + ivec2(1, 0))), b = min(tAt(u - ivec2(0, 1)), tAt(u + ivec2(0, 1)));
  float lo = min(a, b), hi = max(a, b), t;
  if (lo > 1.0e8) { o = vec4(t0, 0.0, 0.0, 1.0); return; }
  if (hi - lo >= f) t = lo + f; else { float d = hi - lo; t = 0.5 * (a + b + sqrt(max(2.0 * f * f - d * d, 0.0))); }
  o = vec4(min(t0, t), 0.0, 0.0, 1.0); }`);
    // distance (uSrc: the flood's result) and travel time (uSrc2: the eikonal), signed
    this._final = mat(`
void main() {
  ivec2 u = ivec2(gl_FragCoord.xy); vec2 p = shoreP(u);
  vec4 s = texelFetch(uSrc, u, 0); float e = s.w; bool water = e < 0.0;
  float T = texelFetch(uSrc2, u, 0).x;
  if (s.z < 0.5 || distance(s.xy, p) > uMargin || T > 1.0e8) { o = vec4(water ? -1.0e4 : 1.0e4, 0.0, 0.0, water ? 1.0e4 : -1.0e4); return; } // the line is past the margin: this level does not know
  float dist = distance(s.xy, p);
  float dep0 = clamp(water ? -e : ${C.dMin.toFixed(2)}, ${C.dMin.toFixed(2)}, ${C.dMax.toFixed(1)});
  o = vec4(water ? -dist : dist, dep0, 0.0, water ? T : -T);
}`);
    // the direction and coherence from the travel time's gradient over a wide stencil (uSrc: the final), and the
    // chunk's texels (the window less the margin) into the slot. A clean front has |grad tau| = 1 / c; along the spine
    // of a body, where fronts from two shores meet, tau has a ridge, the wide difference across it comes out small,
    // and the coherence falls to 0 over the stencil's width: the trains fade there instead of folding into each other
    this._pack = mat(`
float tauAt(ivec2 v, float e) { vec4 t = texelFetch(uSrc, clamp(v, ivec2(0), ivec2(${W - 1})), 0); return abs(t.x) > 9.0e3 ? e : t.w; }
void main() {
  ivec2 u = ivec2(gl_FragCoord.xy) + ivec2(int(uMargin)); vec4 v = texelFetch(uSrc, u, 0);
  if (abs(v.x) > 9.0e3) { o = v; return; }
  float e = v.w; bool water = v.x < 0.0; int R = max(2, int(${C.gradM.toFixed(1)} / uCell + 0.5));
  vec2 g = vec2(tauAt(u + ivec2(R, 0), e) - tauAt(u - ivec2(R, 0), e), tauAt(u + ivec2(0, R), e) - tauAt(u - ivec2(0, R), e)) / (2.0 * float(R) * uCell);
  if (!water) g = -g; // up the beach tau falls away from the line
  float gl = length(g); vec2 dir = gl > 1e-7 ? -g / gl : vec2(0.0);
  float cel = sqrt(${G.toFixed(2)} * v.y);
  float coh = smoothstep(0.45, 0.85, gl * cel);
  o = vec4(v.x, dir * coh, v.w);
}`);
    this._copy = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { uSrc: { value: null }, uScale: { value: 1 } }, vertexShader: VS,
      fragmentShader: `precision highp float; uniform highp sampler2D uSrc; uniform float uScale; out vec4 o; void main() { o = texture(uSrc, gl_FragCoord.xy / ${T.toFixed(1)}); }`, depthTest: false, depthWrite: false });
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this._quad.frustumCulled = false;
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._scene = new THREE.Scene(); this._scene.add(this._quad);
    this.U = U; this.frame = 0;
    this.stats = { bakes: 0, ms: 0, held: 0 };
    this._writeTables();
    { const r = renderer, prev = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha(); // no clouds yet: the open
      r.setRenderTarget(this.rt, this.cloud); r.setClearColor(0xffffff, 1); r.clear(true, false, false); r.setClearColor(cc, ca); r.setRenderTarget(prev); }
  }
  // a texture into a layer, sampled over the layer's texels (the clouds' shadow map each frame; a table once)
  copyInto(tex, layer) {
    const r = this.renderer, prev = r.getRenderTarget();
    this._copy.uniforms.uSrc.value = tex; this._quad.material = this._copy;
    r.setRenderTarget(this.rt, layer); r.render(this._scene, this._cam); r.setRenderTarget(prev);
  }
  _writeTables() {
    const T = this.cfg.tex, data = poissonTableData(), packed = new Float32Array(T * T * 4);
    if (POISSON.rows > T || POISSON.cols > 4 * T) throw new Error('shorefield: the Poisson table must fit the layer (rows x 4 columns a texel)');
    for (let r = 0; r < POISSON.rows; r++) for (let c = 0; c < POISSON.cols; c++) packed[(r * T + (c >> 2)) * 4 + (c & 3)] = data[r * POISSON.cols + c];
    const tex = new THREE.DataTexture(packed, T, T, THREE.RGBAFormat, THREE.FloatType); tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
    this.copyInto(tex, this.tables); tex.dispose();
  }
  // once a frame: the chunks round the eye that are not held yet are baked (a couple a frame; all of them when all is
  // true, for a build), the directory is pointed at the eye's neighbourhood
  update(eye, all = false) {
    const C = this.cfg, t0 = performance.now(), D = C.dirN; this.frame++;
    let budget = all ? 1e9 : C.perFrame;
    for (const L of this.levels) {
      const ex = Math.floor(eye.x / L.chunk), ez = Math.floor(eye.z / L.chunk);
      // wanted: the 3 x 3 round the eye, nearest first
      const want = [];
      for (let dz = -C.near; dz <= C.near; dz++) for (let dx = -C.near; dx <= C.near; dx++) want.push([ex + dx, ez + dz, dx * dx + dz * dz]);
      want.sort((a, b) => a[2] - b[2]);
      for (const [cx, cz] of want) {
        let slot = L.slots.find((S) => S.cx === cx && S.cz === cz);
        if (slot) { slot.used = this.frame; continue; }
        if (budget <= 0) continue;
        // a free slot, else the one used longest ago
        slot = L.slots.find((S) => S.cx === null) || L.slots.reduce((a, S) => (S.used < a.used ? S : a), L.slots[0]);
        this._bake(L, slot, cx, cz); slot.cx = cx; slot.cz = cz; slot.used = this.frame; budget--;
      }
      // the directory: a D x D window of chunks round the eye
      const ox = ex - D / 2, oz = ez - D / 2;
      this.uniforms.uShoreLv.value[L.k].set(L.s, L.chunk, ox, oz);
      const dir = this.uniforms.uShoreDir.value, base = L.k * (D * D / 4);
      for (let i = 0; i < D * D / 4; i++) dir[base + i].set(-1, -1, -1, -1);
      for (let i = 0; i < L.slots.length; i++) {
        const S = L.slots[i]; if (S.cx === null) continue;
        const dx = S.cx - ox, dz = S.cz - oz; if (dx < 0 || dz < 0 || dx >= D || dz >= D) continue;
        const idx = dz * D + dx, v = dir[base + (idx >> 2)]; v.setComponent(idx & 3, L.slotBase + i);
      }
    }
    this.uniforms.uShoreOn.value = 1;
    this.stats.ms = performance.now() - t0; this.stats.held = this.levels.reduce((a, L) => a + L.slots.filter((S) => S.cx !== null).length, 0);
  }
  rebake() { for (const L of this.levels) for (const S of L.slots) { S.cx = S.cz = null; S.used = 0; } }
  // another source of the same kind (a new seed): its uniforms, and every chunk baked again
  setSource(source) { this.source = source; if (source.glsl) Object.assign(this.U, source.uniforms); this.rebake(); }
  _bake(L, slot, cx, cz) {
    const r = this.renderer, prev = r.getRenderTarget(), U = this.U, W = this.W, M = this.M, mt = Math.ceil(L.margin / L.s);
    // the window: the chunk plus the level's margin, inside the common window size (the rest unused)
    U.uOrg.value.set(cx * L.chunk - M * L.s, cz * L.chunk - M * L.s); U.uCell.value = L.s; U.uMargin.value = M;
    const draw = (mat, rt, layer) => { this._quad.material = mat; if (layer === undefined) r.setRenderTarget(rt); else r.setRenderTarget(rt, layer); r.render(this._scene, this._cam); };
    draw(this._height, this.rtH);
    U.uSrc.value = this.rtH.texture; draw(this._seed, this.rtS); this.seedTex = this.rtS.texture;
    // the flood, from the seeds, between ping and pong
    let src = this.rtS, dst = this.ping;
    for (let s = 1 << Math.ceil(Math.log2(W)) - 1; s >= 1; s >>= 1) { U.uStep.value = s; U.uSrc.value = src.texture; draw(this._flood, dst); src = dst; dst = src === this.ping ? this.pong : this.ping; }
    const flood = src, free = dst; // the flood's result, kept for the final; the other of the pair is free
    // the eikonal on rtT and the free one: init from the seeds, then the sweeps
    U.uSrc.value = this.seedTex; U.uSrc2.value = this.rtH.texture; draw(this._eikInit, this.rtT);
    let ea = this.rtT, eb = free;
    for (let i = 0; i < this.cfg.sweeps; i++) { U.uSrc.value = ea.texture; draw(this._eik, eb); [ea, eb] = [eb, ea]; }
    U.uSrc.value = flood.texture; U.uSrc2.value = ea.texture; U.uMargin.value = mt * L.s; draw(this._final, eb);
    const fin = eb;
    U.uSrc.value = fin.texture; U.uMargin.value = M; draw(this._pack, this.rt, L.slotBase + L.slots.indexOf(slot));
    r.setRenderTarget(prev);
    this.stats.bakes++;
  }
  // GLSL for a reader: shoreAt(p) = (signed distance, direction to the line times the front's coherence, travel time)
  // from the finest level that holds p and knows its line, bilinear in the chunk's texels, handed to the next level
  // over the last quarter of its margin; (1e4, 0, 0, 1e4) where no level knows (no shore effects there).
  // shoreCloud(xz): the clouds' shadow over a point (1 in the open), from the copy.
  glsl() {
    const C = this.cfg, n = this.levels.length, D = C.dirN, T = C.tex;
    return /* glsl */ `
#define SHORE_LEVELS ${n}
#define SHORE_TABLES ${this.tables}
#define SHORE_CLOUD ${this.cloud}
uniform highp sampler2DArray uShoreTab; uniform vec4 uShoreLv[SHORE_LEVELS]; uniform vec4 uShoreDir[${n * D * D / 4}]; uniform float uShoreOn;
const vec4 SHORE_FAR = vec4(1.0e4, 0.0, 0.0, 1.0e4);
const float SHORE_HAND[SHORE_LEVELS] = float[SHORE_LEVELS](${C.levels.map((L) => L.margin.toFixed(1)).join(', ')});
int shoreSlotC(int l, ivec2 c) { // the slot holding chunk c of level l, -1 for none
  vec4 L = uShoreLv[l]; c -= ivec2(L.zw);
  if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, ivec2(${D})))) return -1;
  int i = c.y * ${D} + c.x; vec4 v = uShoreDir[l * ${D * D / 4} + (i >> 2)]; int q = i & 3;
  return int(q == 0 ? v.x : q == 1 ? v.y : q == 2 ? v.z : v.w);
}
int shoreSlot(int l, vec2 p) { return shoreSlotC(l, ivec2(floor(p / uShoreLv[l].y))); }
// a texel of chunk c, index i which may step over the chunk's edge into the neighbour's slot (so a read across a
// chunk border interpolates the same texels from either side)
vec4 shoreTap(int l, int slot, ivec2 c, ivec2 i) {
  ivec2 step = ivec2(i.x < 0 ? -1 : i.x >= ${T} ? 1 : 0, i.y < 0 ? -1 : i.y >= ${T} ? 1 : 0);
  if (step != ivec2(0)) { slot = shoreSlotC(l, c + step); if (slot < 0) return SHORE_FAR; i -= step * ${T}; }
  return texelFetch(uShoreTab, ivec3(i, slot), 0);
}
vec4 shoreRead(int l, int slot, vec2 p) {
  vec4 L = uShoreLv[l]; ivec2 cc = ivec2(floor(p / L.y)); vec2 o = vec2(cc) * L.y; vec2 g = (p - o) / L.x - 0.5; vec2 g0 = floor(g); vec2 f = g - g0; ivec2 i = ivec2(g0);
  vec4 a = shoreTap(l, slot, cc, i), b = shoreTap(l, slot, cc, i + ivec2(1, 0)), c = shoreTap(l, slot, cc, i + ivec2(0, 1)), d = shoreTap(l, slot, cc, i + ivec2(1, 1));
  // a texel the level does not know is left out of the blend
  vec4 s = vec4(0.0); float w = 0.0;
  if (abs(a.x) < 9.0e3) { s += a * (1.0 - f.x) * (1.0 - f.y); w += (1.0 - f.x) * (1.0 - f.y); }
  if (abs(b.x) < 9.0e3) { s += b * f.x * (1.0 - f.y); w += f.x * (1.0 - f.y); }
  if (abs(c.x) < 9.0e3) { s += c * (1.0 - f.x) * f.y; w += (1.0 - f.x) * f.y; }
  if (abs(d.x) < 9.0e3) { s += d * f.x * f.y; w += f.x * f.y; }
  return w > 1e-4 ? s / w : SHORE_FAR;
}
float gShoreKnow = 1.0; // after a shoreAt: 1 where a level knows the point, falling to 0 over the last level's outer margin, 0 beyond
vec4 shoreAt(vec2 p) {
  gShoreKnow = 0.0;
  if (uShoreOn < 0.5) return SHORE_FAR;
  vec4 v = SHORE_FAR; float wv = 0.0;
  for (int l = 0; l < SHORE_LEVELS; l++) {
    int slot = shoreSlot(l, p); if (slot < 0) continue;
    vec4 u = shoreRead(l, slot, p); if (abs(u.x) > 9.0e3) continue;
    if (wv <= 0.0) { v = u; wv = 1.0 - smoothstep(0.75 * SHORE_HAND[l], SHORE_HAND[l], abs(u.x)); gShoreKnow = l == SHORE_LEVELS - 1 ? wv : 1.0; if (wv >= 1.0) return v; }
    else { gShoreKnow = 1.0; return mix(u, v, wv); } // the coarser level takes over past the finer one's margin
  }
  return v;
}
// the glints' Poisson table (water.js wPoisson): row r, column c
float shorePoisson(int r, int c) { vec4 t = texelFetch(uShoreTab, ivec3(c >> 2, r, SHORE_TABLES), 0); int q = c & 3; return q == 0 ? t.x : q == 1 ? t.y : q == 2 ? t.z : t.w; }
uniform vec4 uShoreCloudRect; // the clouds' shadow map's centre x, z and half span (clouds.js uShadowRect)
float shoreCloud(vec2 xz) {
  vec2 uv = (xz - uShoreCloudRect.xy) / (2.0 * uShoreCloudRect.z) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  return texelFetch(uShoreTab, ivec3(ivec2(uv * ${T.toFixed(1)}), SHORE_CLOUD), 0).r;
}
`;
  }
  dispose() { for (const t of [this.rt, this.rtH, this.rtS, this.rtT, this.ping, this.pong]) t.dispose(); for (const m of [this._height, this._seed, this._flood, this._eikInit, this._eik, this._final, this._pack, this._copy]) m.dispose(); }
}

// The same four readers by live calculation (W3.1, for the comparison in the template: ?shore=live): no table, every
// pixel searches the clipmap for the water line itself. shoreAt: 16 directions, 6 radii from 0.5 m to 128 m, the
// crossing refined linearly (192 clipmap reads a pixel against one texel read); the travel time is the distance at the
// speed of the depth under the pixel (no march); shorePoisson sums the series; shoreCloud reads the clouds' own map.
// Same function names, same answers in the limit, so the water and the beach run unchanged either way.
export const SHORE_LIVE_GLSL = /* glsl */ `
uniform float uShoreOn;
const vec4 SHORE_FAR = vec4(1.0e4, 0.0, 0.0, 1.0e4);
float shoreLiveE(vec2 q) { return clipAt(q).x - clipWater(q); }
float gShoreKnow = 1.0;
vec4 shoreAt(vec2 p) {
  gShoreKnow = 0.0;
  if (uShoreOn < 0.5) return SHORE_FAR;
  float e0 = shoreLiveE(p); bool water = e0 < 0.0; float best = 1e4; vec2 bdir = vec2(0.0);
  for (int d = 0; d < 16; d++) {
    float a = 6.2831853 * (float(d) + 0.5 * float(d & 1)) / 16.0; vec2 v = vec2(cos(a), sin(a)); float r0 = 0.0, ep = e0;
    for (int t = 0; t < 6; t++) {
      float r = 0.5 * pow(3.03, float(t)); float et = shoreLiveE(p + v * r);
      if ((et < 0.0) != (ep < 0.0)) { float f = ep / (ep - et); float dd = r0 + (r - r0) * f; if (dd < best) { best = dd; bdir = v; } break; }
      r0 = r; ep = et;
    }
  }
  if (best >= 1e4) return vec4(water ? -1.0e4 : 1.0e4, 0.0, 0.0, water ? 1.0e4 : -1.0e4);
  gShoreKnow = 1.0 - smoothstep(90.0, 128.0, best);
  float dep = clamp(water ? -e0 : ${SHORE.dMin.toFixed(2)}, ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)});
  float tau = best / sqrt(9.81 * dep);
  return vec4(water ? -best : best, bdir, water ? tau : -tau);
}
float shorePoisson(int r, int c) {
  float lam = 12.0 * pow(float(r) / ${(POISSON.rows - 1).toFixed(1)}, 2.0), u = (float(c) + 0.5) / ${POISSON.cols.toFixed(1)};
  float p = exp(-lam), cc = p, n = 0.0; for (int i = 0; i < 40; i++) { if (u <= cc) break; n += 1.0; p *= lam / n; cc += p; } return n;
}
`;
export const SHORE_LIVE_CLOUD_GLSL = /* glsl */ `
uniform sampler2D tCloudShadow; uniform vec4 uShoreCloudRect;
float shoreCloud(vec2 xz) {
  vec2 uv = (xz - uShoreCloudRect.xy) / (2.0 * uShoreCloudRect.z) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  return texture(tCloudShadow, uv).r;
}
`;
// what World hands the terrain and the composite in place of a ShoreField when the shore is computed live
export function shoreLive(clouds) {
  return { live: true, uniforms: { uShoreOn: { value: 1 }, tCloudShadow: { value: clouds.rtShadow.texture }, uShoreCloudRect: clouds.U.uShadowRect }, glsl: () => SHORE_LIVE_GLSL, compositeGLSL: SHORE_LIVE_CLOUD_GLSL, update() {}, rebake() {}, stats: { bakes: 0, ms: 0 } };
}

// The shore waves, read from the table by the water (water.js) and the beach (terrain.js), so the breakers and the
// swash are one motion: a front's phase is w (t + tau) with tau from the table, so it arrives at the line, then runs
// up the sand, at the times the table says. Needs shoreAt (above), w2noise (noise.js) and uShoreWave.
//   uShoreWave: the sea's swell (significant height Hs in m, peak period T in s) and the local wind sea's (Hs, T): a
//   coast of the sea gets the swell, a lake only what its own wind raised; shoreState picks by the water's level
// Two trains (the peak and a shorter one) of narrow-crested waves in shallow water: wavenumber w / sqrt(g depth), so
// crests slow down and bunch up toward the line; Green's law raises them as the water shoals; a wave higher than
// 0.78 of the depth breaks (McCowan 1894), and what is left of it runs on as a bore with whitewater on its face and
// lace behind. Sets come and go by a slow noise; the phase wanders a little along the coast so crests are not rings.
export const SHORE_WAVE_GLSL = /* glsl */ `
#define SHORE_BEACH ${SHORE.beach ? 1 : 0}
uniform vec4 uShoreWave; uniform float uShoreSea; // uShoreSea: the sea's level, so a lake is told from the sea
const float SW_G = 9.81;
vec2 shoreState(float level) { return level > uShoreSea + 0.5 ? uShoreWave.zw : uShoreWave.xy; }
float shoreCelerity(float depth) { return sqrt(SW_G * clamp(depth, ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)})); }
float shorePhaseNoise(vec2 p) { return w2noise(p / 240.0, 611) * 5.0 + w2noise(p / 70.0, 612) * 1.6; }
float shoreGroup(vec2 p, float t) { return 0.45 + 0.55 * (0.5 + 0.5 * w2noise(p / 320.0 + vec2(t * 0.012, -t * 0.009), 613)); }
struct ShoreWave { float y; vec2 slope; float foam; float lace; float a; float ph; float breaking; };
// p: the point (xz); sh: shoreAt(p); depth: the water's depth there (<= 0 on land); t: time; cell: the sampling
// interval in metres (a train shorter than a few cells fades out instead of aliasing)
// the swell's direction where no shore is within the table's reach: from the wind's side
uniform vec2 uSwellDir;
ShoreWave shoreWaves(vec2 p, vec4 sh, float depth, float t, float cell, vec2 st) {
  ShoreWave o = ShoreWave(0.0, vec2(0.0), 0.0, 0.0, 0.0, 0.0, 0.0);
  if (st.x <= 0.0 || depth <= -0.3) return o;
  float know = gShoreKnow, coh = know > 0.0 ? length(sh.yz) : 0.0;
  vec2 dirT = coh > 1e-4 ? sh.yz / coh : vec2(0.0);
  // the swell is one train everywhere on the water: on the table's travel time where it knows the point, as a plane
  // wave from the wind's side where it does not, blended over the last level's outer margin; near a body's spine
  // (coherence low) the table's train gives way to the plane wave
  float wt = know * smoothstep(0.05, 0.6, coh);
  vec2 dir = normalize(mix(uSwellDir, dirT, wt) + vec2(1e-5, 0.0));
  float env = smoothstep(-0.3, 0.3, depth);
  float cel = shoreCelerity(depth);
  float shoal = clamp(pow(max(depth, 0.6) / ${SHORE.dMax.toFixed(1)}, -0.25), 1.0, 2.2);
  float group = shoreGroup(p, t), pn = shorePhaseNoise(p);
  for (int i = 0; i < 2; i++) {
    float T = st.y * (i == 0 ? 1.0 : 0.62), w = 6.2831853 / T, k = w / cel, k0 = w * w / SW_G;
    float a0 = 0.5 * st.x * (i == 0 ? 1.0 : 0.3) * env * shoal * group;
    float a = min(a0, 0.39 * depth + 0.06), rel = a0 / max(depth, 0.05); // a bore keeps a few centimetres at the line
    float phT = w * (t + sh.w), phP = w * t - k0 * dot(p, uSwellDir);
    float ph = mix(phP, phT, wt) + pn * (i == 0 ? 1.0 : 1.37) + float(i) * 2.1;
    float c = max(0.5 + 0.5 * cos(ph), 0.0), cp = pow(c, 0.6), s = sin(ph); // max: a GPU's cos can overshoot 1 by a bit at large phases, and pow of a negative is NaN
    float bl = 1.0 - smoothstep(0.1, 0.3, k * cell / 6.2831853);
    o.y += bl * a * (2.0 * cp * c - 0.78);
    o.slope += bl * dir * (-1.6 * a * k * cp * s);
    // whitewater: on the face of a crest that has broken, trailing behind it; the crest breaks early or late along
    // its length, in a new pattern every wave
    float cycle = floor((ph + 3.14159) / 6.2831853);
    float early = w2noise(p / 30.0 + vec2(cycle * 7.3, cycle * 3.1 + float(i) * 31.0), 614);
    // a wave breaks when its height passes 0.78 of the depth (a0 past 0.39 depth), early or late along the crest; the
    // short train never does: the crest of the swell is the one that crashes
    float breaking = i == 0 ? smoothstep(0.33 + 0.08 * early, 0.45 + 0.1 * early, rel) * smoothstep(0.03, 0.15, a0) : 0.0;
    float psi = mod(ph + 3.14159, 6.2831853) - 3.14159;
    // whitewater on the broken crest's face, trailing off behind it: a line that rides the crest to the sand
    o.foam += breaking * smoothstep(-0.7, 0.0, psi) * exp(-max(psi, 0.0) * 1.3);
    if (i == 0) { o.a = a; o.ph = ph; o.breaking = breaking; o.lace = breaking * 0.3 * exp(-mod(ph, 6.2831853) * 0.45); } // lace in patches behind each crest, a third of its white, gone before the next
  }
  return o;
}
// the run-up limit on a beach of slope tb (rise over run) for the sea state st (Stockdon et al. 2006, the height the
// top 2% of run-ups reach), H0 the significant height and L0 the deep-water wavelength of the peak period
float shoreRunup(float tb, vec2 st) { float L0 = SW_G * st.y * st.y / 6.2831853, HL = st.x * L0; return 1.1 * (0.35 * tb * sqrt(HL) + 0.5 * sqrt(HL * (0.563 * tb * tb + 0.004))); }
// The swash sheet (W3.1): the water itself on the sand. At a point of the beach hgt above the still water (nG: the
// ground's normal), the bore that broke out there arrives at the table's travel time and sends a tongue up the sand:
// its level climbs fast to this set's reach (the run-up limit, varied along the shore by a slow noise, its tip broken
// into fingers by a fine one) and drains back from the top; wherever that level stands above the sand there is a sheet
// of water a few centimetres thick. Returns (thickness m, lace foam at the leading edge 0..1, whitewater and bubbles
// behind it 0..1); zero where the sand is dry
// The tongue (W3.1): one object for the sheet and the sand's memory. Its clock is the water line's: the phase of the
// wave arriving at the nearest shore point (the along-shore noise is read at that point), so every height of the
// beach sees the same tongue. The level climbs over 0.35 of the period to this set's reach, holds a moment, and falls
// back over 0.35: the backwash of a big set is as fast as its uprush, the water that came is the water that goes. The
// reach is the run-up limit for the beach's slope and the sea state, varied along the shore by a slow noise, the tip
// broken into fingers by a fine one.
float shoreReach(vec2 pl, float tk, float R2) { return R2 * (0.55 + 0.45 * shoreGroup(pl, tk)) * (0.78 + 0.32 * w2noise(pl / 2.6, 620)); }
// the run-up limit, held to the crest's own height above the still water: the water goes no higher than the wave
// that threw it (Stockdon's limit grows with the slope and would climb a steep bank by a metre)
float shoreRunupCapped(float tb, vec2 st) { return min(shoreRunup(tb, st), 0.5 * st.x * 1.15); }
// the tongue's fingers: its reach varies along the shore in tongues a metre or four long in the water's direction and
// half a metre wide across it (the noise read in the frame of the direction to the line), by up to a quarter of the
// reach; a new pattern each wave
float shoreFingers(vec2 p, vec2 dir, float reach, float tk) {
  vec2 ac = vec2(-dir.y, dir.x); vec2 q = vec2(dot(p, ac) / 0.55, dot(p, dir) / 2.8) + vec2(tk * 0.37, tk * 0.11);
  return reach * 0.25 * (w2noise(q, 621) * 0.7 + w2noise(q * 2.7, 625) * 0.3);
}
// the tongue's level above the still water, tau seconds after the bore reached the line, on a beach of slope tb: the
// water runs up at the bore's speed and decelerates at g sin(beta), so the level is a parabola in time to its reach
// and back (Shen and Meyer 1963), the uprush taking sqrt(2 reach / (g tb^2)) — 6 s for 0.4 m on a 1:20 beach — and
// the backwash as long, so the water is still draining when the next crest comes; held under half the period so a
// tongue is done as the next arrives and the foot of the swash zone always carries its film (a bigger set
// compresses the motion a little)
float shoreTongueUp(float reach, float tb, float T) { return min(sqrt(2.0 * reach / (SW_G * tb * tb + 1e-6)), 0.5 * T); }
float shoreTongueLevel(float tau, float reach, float tup) { float x = tau / tup; return x >= 2.0 ? 0.0 : reach * (1.0 - (1.0 - x) * (1.0 - x)); }
// the line's clock at p (land, sh = shoreAt(p)): the nearest shore point pl and (f, t0): the fraction of the period
// since the last front arrived at the line, and that arrival's time
vec2 shoreLineClock(vec2 p, vec4 sh, float t, vec2 st, out vec2 pl) {
  float coh = length(sh.yz); vec2 dir = coh > 1e-4 ? sh.yz / coh : vec2(0.0);
  pl = p + dir * max(sh.x, 0.0);
  float T = st.y, w = 6.2831853 / T, ph = w * t + shorePhaseNoise(pl), f = fract(ph / 6.2831853);
  return vec2(f, t - f * T);
}
// the free surface of the tongue at the line: the sea's edge takes this over its last decimetres of depth, so the
// water is one surface across the line
float shoreEdgeLift(vec2 p, vec4 sh, float t, vec2 st, float tb) {
  if (st.x <= 0.0 || dot(sh.yz, sh.yz) < 1e-6) return 0.0;
  float R2 = shoreRunupCapped(tb, st); vec2 pl; vec2 ck = shoreLineClock(p, sh, t, st, pl);
  float reach = shoreReach(pl, ck.y, R2), tup = shoreTongueUp(reach, tb, st.y);
  return 0.18 * shoreTongueLevel(ck.x * st.y, reach, tup);
}
vec3 shoreSheet(vec2 p, vec4 sh, float hgt, vec3 nG, float t, vec2 st) {
  if (st.x <= 0.0 || dot(sh.yz, sh.yz) < 1e-6 || sh.x > 40.0) return vec3(0.0);
  float tb = sqrt(max(1.0 - nG.y * nG.y, 0.0)) / max(nG.y, 0.05), R2 = shoreRunupCapped(tb, st);
  vec2 pl; vec2 ck = shoreLineClock(p, sh, t, st, pl); float f = ck.x, t0 = ck.y;
  float reach = shoreReach(pl, t0, R2), tup = shoreTongueUp(reach, tb, st.y), tau = f * st.y;
  vec2 dirL = normalize(sh.yz + vec2(1e-6, 0.0));
  float R = shoreTongueLevel(tau, reach, tup); R += (R / max(reach, 1e-3)) * shoreFingers(p, dirL, reach, t0); // fingers at the tip
  float over = R - hgt; if (over <= 0.0) return vec3(0.0);
  float film = min(over * 0.18, 0.05);
  // the foam at the water's scale: the lip's white travels with the tip and fades over a second and a half behind
  // it, leaving lace in patches of a metre or two and clusters of bubbles a hand wide
  float q = sqrt(max(1.0 - hgt / max(reach, 1e-3), 0.0)), sinceTip = tau - tup * (1.0 - q); // seconds since the tip passed this height
  float lace = smoothstep(0.42, 0.62, 0.5 + 0.5 * (w2noise(p / 1.6 + vec2(t * 0.05, 0.0), 622) * 0.6 + w2noise(p / 0.5, 623) * 0.4));
  float edge = smoothstep(0.0, 0.006, over) * (1.0 - smoothstep(0.03, 0.09, over)) * (0.3 + 0.7 * lace);
  float bubbles = smoothstep(0.08, 0.2, over) * (1.0 - smoothstep(0.4, 0.9, over)) * smoothstep(0.62, 0.75, lace + 0.3 * w2noise(p / 0.2, 624)) * 0.5;
  float back = clamp(shoreReach(pl, t0 - st.y, R2) / max(R2, 1e-3), 0.0, 1.5);
  float white = exp(-max(sinceTip, 0.0) / 1.5) * smoothstep(0.3, 0.7, lace + 0.2) * (0.5 + 0.6 * back); // the crash's white, where the tip has just passed
  return vec3(film, edge, max(bubbles, white));
}
// The sand's memory of the water (W3.1): the last four tongues are asked when each reached this height and when it
// left (the parabola's rising and falling branches: tup (1 -+ sqrt(1 - hgt / reach))); a tongue that has not arrived
// leaves no mark, so the wet line is drawn by the tip itself as it climbs, and the wetness
// is the freshest one's age: the dark of wet sand dries over 45 s, its mirror gloss in a second or two behind the
// retreating water. So the wet sand is the shape of the last tongue, fingers and all, and dries from the top edge
// down toward the water at the water's own pace, until the next tongue writes over it. Returns (dark, gloss); 1 under
// water
vec2 shoreWet(vec2 p, vec4 sh, float hgt, vec3 nG, float t, vec2 st) {
  if (hgt < 0.0) return vec2(1.0);
  if (st.x <= 0.0 || dot(sh.yz, sh.yz) < 1e-6 || sh.x > 40.0) return vec2(0.0);
  float tb = sqrt(max(1.0 - nG.y * nG.y, 0.0)) / max(nG.y, 0.05), R2 = shoreRunupCapped(tb, st), T = st.y;
  vec2 pl; vec2 ck = shoreLineClock(p, sh, t, st, pl); float t0 = ck.y;
  float dark = 0.0, gloss = 0.0;
  for (int k = 0; k < 4; k++) {
    float tk = t0 - float(k) * T;
    float reach = shoreReach(pl, tk, R2); reach += shoreFingers(p, normalize(sh.yz + vec2(1e-6, 0.0)), reach, tk);
    if (reach <= hgt) continue;
    float tup = shoreTongueUp(reach, tb, T), q = sqrt(max(1.0 - hgt / reach, 0.0)), since = t - tk;
    float tArrive = tup * (1.0 - q), tLeave = tup * (1.0 + q); // the parabola's rising and falling branches reach hgt then
    if (since < tArrive) continue;              // this tongue has not reached here yet: it leaves no mark
    if (since < tLeave) return vec2(1.0);        // under it now (the sheet is drawn over it)
    float age = since - tLeave;
    dark = max(dark, exp(-age / 45.0)); gloss = max(gloss, exp(-age / 1.5));
  }
  return vec2(dark, gloss);
}
`;
