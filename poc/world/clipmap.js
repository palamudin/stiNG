// Terrain clipmap: nested square levels round the focus, each twice as coarse as the one inside it, from a few
// centimetres under the wasp to kilometres at the horizon. A generalisation of view/rings.js (GDD 20, G2): the same
// cell snapping, the same 128 x 128 windows addressed by world texel (i & 127, j & 127), the same morph into the next
// level near a level's edge (CDLOD) and the same triangle split, so the surface never cracks or pops.
//
// What is new:
//   - every texel holds four channels from the source: height, moisture, forest, trail (or paving), so shading, grass
//     and water read the same data the mesh stands on; a second array (W3) holds the water level, the sea or a
//     lake's own, read by the shore, the grass, the water and the caustics;
//   - all levels live in one float array render target (one sampler, one draw call for the whole ground);
//   - a source with a GLSL twin is drawn into the levels on the GPU (a whole level costs microseconds), a source
//     without one (the sim's own ground) is filled on the CPU a strip at a time within a per-frame budget;
//   - blur-in: a level that has not got its data yet, or has just jumped, is drawn as its coarser parent and
//     sharpens over `fadeTime`, so zooming reads as a picture coming into focus rather than tiles popping.
import * as THREE from 'three';

export const CLIP = { levels: 12, cells: 64, base: 0.25, win: 128, band0: 10, band1: 2, margin: 6, fadeTime: 0.45 };

export class Clipmap {
  constructor(renderer, source, cfg = {}) {
    this.cfg = { ...CLIP, ...cfg };
    const C = this.cfg;
    this.renderer = renderer;
    this.source = source;
    this.gpu = !!source.glsl && renderer.capabilities.isWebGL2 && !!renderer.extensions.get('EXT_color_buffer_float');
    // r160's WebGLArrayRenderTarget hands its options to the parent and then replaces the texture with a default
    // 8-bit one, so the type is set on the replacement: an 8-bit target clamps every height to 0..1 m
    this.rt = new THREE.WebGLArrayRenderTarget(C.win, C.win, C.levels, { depthBuffer: false });
    Object.assign(this.rt.texture, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.rtW = new THREE.WebGLArrayRenderTarget(C.win, C.win, C.levels, { depthBuffer: false });
    Object.assign(this.rtW.texture, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.sea = source.sea; // a source with no water field: this everywhere
    this.lv = [];
    for (let l = 0; l < C.levels; l++) {
      const s = C.base * 2 ** l;
      this.lv.push({ s, H: (C.cells / 2) * s, ci: 0, cj: 0, wi: null, wj: null, fade: 0, ready: false, job: null, cpu: null, tex: null });
    }
    this.uniforms = {
      uClip: { value: this.rt.texture },
      uClipW: { value: this.rtW.texture },
      uClipLv: { value: this.lv.map(() => new THREE.Vector4()) },
      uClipFade: { value: new Float32Array(C.levels) },
    };
    this.stats = { filledTexels: 0, gpuLevels: 0, ms: 0 };
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this._quad.frustumCulled = false;
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._scene = new THREE.Scene(); this._scene.add(this._quad);
    if (this.gpu) {
      this._fill = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: { ...source.uniforms, uWin: { value: new THREE.Vector2() }, uCell: { value: 1 } },
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `precision highp float; precision highp int;\n${source.glsl}\nuniform vec2 uWin; uniform float uCell; out vec4 outColor;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy); ivec2 w = ivec2(uWin);
  ivec2 idx = w + ((t - w) & 127);
  outColor = wildSample(vec2(idx) * uCell);
}`,
        depthTest: false, depthWrite: false,
      });
      this._fillW = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: this._fill.uniforms,
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `precision highp float; precision highp int;\n${source.glsl}\nuniform vec2 uWin; uniform float uCell; out vec4 outColor;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy); ivec2 w = ivec2(uWin);
  ivec2 idx = w + ((t - w) & 127);
  outColor = vec4(wildWater(vec2(idx) * uCell), 0.0, 0.0, 1.0);
}`,
        depthTest: false, depthWrite: false,
      });
    } else {
      this._copy = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: { uSrc: { value: null } },
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'precision highp float; uniform highp sampler2D uSrc; out vec4 outColor; void main() { outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }',
        depthTest: false, depthWrite: false,
      });
      for (const L of this.lv) {
        L.cpu = new Float32Array(C.win * C.win * 4);
        L.tex = new THREE.DataTexture(L.cpu, C.win, C.win, THREE.RGBAFormat, THREE.FloatType);
        L.tex.minFilter = L.tex.magFilter = THREE.NearestFilter; L.tex.generateMipmaps = false;
      }
    }
    this._smp = [0, 0, 0, 0, 0];
    this._clearW();
  }
  // a source without a water field (CPU fill): the water layer is the sea everywhere
  _clearW() {
    if (this.gpu) return;
    const r = this.renderer, prev = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    for (let l = 0; l < this.cfg.levels; l++) { r.setRenderTarget(this.rtW, l); r.setClearColor(new THREE.Color(this.sea, 0, 0), 1); r.clear(true, false, false); }
    r.setClearColor(cc, ca); r.setRenderTarget(prev);
  }

  // Re-centre every level on (x, z) and bring data in. budgetMs bounds the CPU fill; the GPU fill always completes.
  update(x, z, dt, budgetMs = 3) {
    const C = this.cfg, half = C.win / 2, t0 = performance.now();
    this.stats.filledTexels = 0; this.stats.gpuLevels = 0;
    for (let l = C.levels - 1; l >= 0; l--) { // coarse first, so a finer level always has a parent to blur from
      const L = this.lv[l];
      L.ci = Math.round(x / L.s); L.cj = Math.round(z / L.s);
      const drift = L.wi === null ? Infinity : Math.max(Math.abs(L.ci - (L.wi + half)), Math.abs(L.cj - (L.wj + half)));
      if (drift > C.margin && !L.job) {
        const ni = L.ci - half, nj = L.cj - half;
        const overlap = L.wi === null ? 0 : Math.max(0, C.win - Math.abs(ni - L.wi)) * Math.max(0, C.win - Math.abs(nj - L.wj)) / (C.win * C.win);
        // a jump: on the GPU the new window is there at once and blurs in from its parent; on the CPU the level goes on
        // drawing the window it holds (true ground there) until the new one lands, so it never shows what it lacks
        if (overlap < 0.5 && this.gpu) { L.fade = 0; L.ready = false; }
        if (this.gpu) { this._gpuFill(l, ni, nj); L.wi = ni; L.wj = nj; L.ready = true; }
        else L.job = { ni, nj, oi: overlap < 0.5 ? null : L.wi, oj: overlap < 0.5 ? null : L.wj, j: nj, i: ni };
      }
    }
    if (!this.gpu) this._cpuWork(t0, budgetMs);
    const k = dt / C.fadeTime;
    for (let l = C.levels - 1; l >= 0; l--) {
      const L = this.lv[l], parentReady = l === C.levels - 1 || this.lv[l + 1].ready;
      if (L.ready && parentReady) L.fade = Math.min(1, L.fade + k); else if (!L.ready) L.fade = 0;
      // the window the texture holds, not the one being filled: while a CPU fill is under way the GPU still has the old
      // window, and read round the new centre its wrapped texels are ground from 128 texels off (walls and pits round
      // the eye until the fill lands); the level's ring of the mesh goes with it, so the rings still nest
      if (L.wi === null) this.uniforms.uClipLv.value[l].set(L.ci * L.s, L.cj * L.s, L.s, L.H);
      else this.uniforms.uClipLv.value[l].set((L.wi + half) * L.s, (L.wj + half) * L.s, L.s, L.H);
      this.uniforms.uClipFade.value[l] = L.fade;
    }
    this.stats.ms = performance.now() - t0;
  }
  // Another source into the same levels (a new world in the game): the uniforms and the target stay the same objects,
  // so materials compiled against them keep working; the fill path follows the new source.
  setSource(source) {
    if (!!source.glsl !== !!this.source.glsl) throw new Error('setSource: a source with a GLSL twin cannot replace one without (make a new Clipmap)');
    this.source = source; this.sea = source.sea;
    if (this.gpu) Object.assign(this._fill.uniforms, source.uniforms);
    this._clearW();
    for (const L of this.lv) { L.wi = L.wj = null; L.job = null; L.ready = false; L.fade = 0; }
  }
  // A full rebuild at (x, z), finishing the CPU fill whatever it costs (loading screens, teleports)
  build(x, z) {
    for (const L of this.lv) { L.wi = L.wj = null; L.job = null; L.ready = false; L.fade = 0; }
    this.update(x, z, 0, 1e9);
    for (const L of this.lv) L.fade = 1;
    this.update(x, z, 0, 1e9);
  }
  get busy() { return this.lv.some((L) => L.job); }
  sharpness() { return this.lv.reduce((a, L) => a + L.fade, 0) / this.lv.length; }

  _gpuFill(l, ni, nj) {
    const r = this.renderer, prev = r.getRenderTarget(), L = this.lv[l];
    this._fill.uniforms.uWin.value.set(ni, nj);
    this._fill.uniforms.uCell.value = L.s;
    this._quad.material = this._fill;
    r.setRenderTarget(this.rt, l);
    r.render(this._scene, this._cam);
    this._quad.material = this._fillW;
    r.setRenderTarget(this.rtW, l);
    r.render(this._scene, this._cam);
    r.setRenderTarget(prev);
    this.stats.gpuLevels++;
  }
  _cpuWork(t0, budgetMs) {
    const C = this.cfg, W = C.win, smp = this._smp;
    for (let l = C.levels - 1; l >= 0; l--) {
      const L = this.lv[l], J = L.job;
      if (!J) continue;
      let n = 0;
      for (; J.j < J.nj + W; J.j++) {
        for (; J.i < J.ni + W; J.i++) {
          if (J.oi !== null && J.i >= J.oi && J.i < J.oi + W && J.j >= J.oj && J.j < J.oj + W) continue; // already held
          this.source.sample(J.i * L.s, J.j * L.s, smp, L.s); // the texel's size: a source may leave small things to finer levels
          const o = (((J.j & 127) << 7) | (J.i & 127)) * 4;
          L.cpu[o] = smp[0]; L.cpu[o + 1] = smp[1]; L.cpu[o + 2] = smp[2]; L.cpu[o + 3] = smp[3];
          this.stats.filledTexels++;
          if ((++n & 63) === 0 && performance.now() - t0 > budgetMs) return;
        }
        J.i = J.ni;
      }
      // level done: upload and copy into its layer
      L.tex.needsUpdate = true;
      this._copy.uniforms.uSrc.value = L.tex;
      this._quad.material = this._copy;
      const r = this.renderer, prev = r.getRenderTarget();
      r.setRenderTarget(this.rt, l); r.render(this._scene, this._cam); r.setRenderTarget(prev);
      L.wi = J.ni; L.wj = J.nj; L.job = null; L.ready = true;
      if (performance.now() - t0 > budgetMs) return;
    }
  }

  // GLSL for anything that reads the ground as drawn: the terrain mesh, grass, trees, water, game objects.
  glsl() {
    const C = this.cfg, last = C.levels - 1;
    return /* glsl */ `
#define CLIP_LEVELS ${C.levels}
uniform highp sampler2DArray uClip, uClipW;
uniform vec4 uClipLv[CLIP_LEVELS]; // centre x, centre z, cell size, half extent
uniform float uClipFade[CLIP_LEVELS];
vec4 clipTexel(int l, int i, int j) { return texelFetch(uClip, ivec3(i & 127, j & 127, l), 0); }
vec4 clipLevel(int l, vec2 p) {
  float s = uClipLv[l].z; vec2 g = p / s; vec2 g0 = floor(g); vec2 f = g - g0; int i = int(g0.x), j = int(g0.y);
  vec4 a = clipTexel(l, i, j), b = clipTexel(l, i + 1, j), c = clipTexel(l, i, j + 1), d = clipTexel(l, i + 1, j + 1);
  return f.x > f.y ? a + (b - a) * f.x + (d - b) * f.y : a + (d - c) * f.x + (c - a) * f.y;
}
float clipMorph(int l, vec2 p) {
  vec2 q = abs(p - uClipLv[l].xy); float m = max(q.x, q.y), s = uClipLv[l].z;
  float e = clamp((m - (uClipLv[l].w - ${C.band0.toFixed(1)} * s)) / (${(C.band0 - C.band1).toFixed(1)} * s), 0.0, 1.0);
  return max(e, 1.0 - uClipFade[l]);
}
// the parent is read only where its window holds data (while a refill is under way a level and its parent need not nest)
bool clipHolds(int l, vec2 p) { vec2 q = abs(p - uClipLv[l].xy); return max(q.x, q.y) < 2.0 * uClipLv[l].w - uClipLv[l].z; }
vec4 clipSurface(int l, vec2 p) {
  vec4 v = clipLevel(l, p);
  if (l < ${last}) { float k = clipMorph(l, p); if (k > 0.0 && clipHolds(l + 1, p)) v = mix(v, clipLevel(l + 1, p), k); }
  return v;
}
int clipFinest(vec2 p) {
  for (int l = 0; l < ${last}; l++) { vec2 q = abs(p - uClipLv[l].xy); if (max(q.x, q.y) < uClipLv[l].w) return l; }
  return ${last};
}
vec4 clipAt(vec2 p) { return clipSurface(clipFinest(p), p); }
float clipHeight(vec2 p) { return clipAt(p).x; }
// the water level (the sea, or a lake's own level): the finest level's texels, interpolated the same way
float clipWater(vec2 p) {
  int l = clipFinest(p); float s = uClipLv[l].z; vec2 g = p / s; vec2 g0 = floor(g); vec2 f = g - g0; int i = int(g0.x), j = int(g0.y);
  float a = texelFetch(uClipW, ivec3(i & 127, j & 127, l), 0).x, b = texelFetch(uClipW, ivec3((i + 1) & 127, j & 127, l), 0).x;
  float c = texelFetch(uClipW, ivec3(i & 127, (j + 1) & 127, l), 0).x, d = texelFetch(uClipW, ivec3((i + 1) & 127, (j + 1) & 127, l), 0).x;
  return f.x > f.y ? a + (b - a) * f.x + (d - b) * f.y : a + (d - c) * f.x + (c - a) * f.y;
}
vec3 clipNormal(vec2 p) {
  int l = clipFinest(p); float e = uClipLv[l].z;
  float hx = clipSurface(l, p + vec2(e, 0.0)).x - clipSurface(l, p - vec2(e, 0.0)).x;
  float hz = clipSurface(l, p + vec2(0.0, e)).x - clipSurface(l, p - vec2(0.0, e)).x;
  return normalize(vec3(-hx, 2.0 * e, -hz));
}
`;
  }
}

// The lift the game's materials use (game.js calls ringHeightAt in every patched material, GDD 20 G2): the same
// GLSL with ringHeightAt answered by the clipmap, so game objects stand on the World v2 ground with no other change.
// Static, so it can be put into three.js's shader chunks before any world exists.
export function clipLiftGLSL(cfg = {}) {
  return Clipmap.prototype.glsl.call({ cfg: { ...CLIP, ...cfg } }) + '\nfloat ringHeightAt(vec2 p) { return clipHeight(p); }\n';
}

// The grid each level draws: (cells + 1)^2 vertices at whole local coordinates, split from (i, j) to (i + 1, j + 1)
export function clipGrid(cells = CLIP.cells) {
  const n = cells, pos = new Float32Array((n + 1) * (n + 1) * 3), idx = new Uint32Array(n * n * 6);
  let p = 0, q = 0;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { pos[p++] = i - n / 2; pos[p++] = 0; pos[p++] = j - n / 2; }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    idx[q++] = a; idx[q++] = d; idx[q++] = b;
    idx[q++] = a; idx[q++] = c; idx[q++] = d;
  }
  return { pos, idx };
}
