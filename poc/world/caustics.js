// Caustics on the floor of the water (W3.1): the sun refracted by the waves and splatted where it lands, over one
// tile of a wave cascade (Wallace 2011's area-ratio splat, as Ultra-Water does it). The cascade is periodic, so the
// pattern computed over one tile repeats over the whole sea: no window round the view, no edge, nothing that follows
// the camera. A grid over the tile (plus a margin of cells past each edge that covers the largest landing offset, so
// light that leaves the tile on one side is caught coming in on the other) is refracted through the cascade's slopes
// by Snell's law onto flat floors at three depths, one per channel; every landed triangle adds the ratio of its area
// on flat water to its landed area, times the surface's transmission against flat water's. Overlapping sheets add, so
// a focus is exact; the mean over the tile is 1 (the energy is kept), so the pattern only redistributes the direct sun.
// The target is mipmapped and repeats: a reader looks it up at the point where its sunlight entered the surface, at
// the mip level for its own footprint, so far or high views see the pattern blur to an even light instead of aliasing,
// and the depth picks and blends the slices.
import * as THREE from 'three';
import { WATER, CAUSTIC_DEPTHS } from './water.js';

export const CAUSTICS = {
  res: 512,                         // texels a tile side
  near: 8,                          // metres: the cascade whose tile is nearest this carries the pattern
  depths: CAUSTIC_DEPTHS,           // metres: the floors of the three slices (r, g, b), water.js
  margin: 0.12,                     // tile units of cells past each edge
  maxRatio: 16,                     // a focus's brightness is held to this (energy above it is dropped)
};

export class Caustics {
  // field: the WaveField
  constructor(renderer, field, opts = {}) {
    this.renderer = renderer; this.field = field;
    const C = CAUSTICS, res = this.res = opts.res || C.res;
    // the cascade nearest the wanted tile size
    const Ls = field.cascades; let ci = 0; for (let c = 1; c < Ls.length; c++) if (Math.abs(Math.log(Ls[c] / C.near)) < Math.abs(Math.log(Ls[ci] / C.near))) ci = c;
    this.cascade = ci; this.L = Ls[ci];
    this.rt = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: opts.msaa ?? 4,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: true });
    const N = field.N, n = WATER.n.toFixed(3), m = C.margin;
    this.sun = { value: new THREE.Vector3(0, 1, 0) };
    const slope = { value: field.slope[ci].texture };
    this.scene = new THREE.Scene(); this.cam = new THREE.Camera();
    C.depths.forEach((depth, k) => {
      const cells = Math.max(32, Math.round(N * (k === 0 ? 1 : k === 1 ? 0.75 : 0.5))); // deeper floors are focused by longer waves: coarser grids do
      const lod = Math.max(0, Math.log2(N / cells));
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide, // past a focus the sheet of light turns over
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        uniforms: { tS: slope, uSun: this.sun },
        vertexShader: /* glsl */ `precision highp float;
uniform highp sampler2D tS; uniform vec3 uSun;
out vec2 vOld; out vec2 vNew; out float vT;
float fres(float ci) { float st2 = (1.0 - ci * ci) / (${n} * ${n}); float ct = sqrt(max(1.0 - st2, 0.0)); float rs = (ci - ${n} * ct) / (ci + ${n} * ct), rp = (${n} * ci - ct) / (${n} * ci + ct); return 0.5 * (rs * rs + rp * rp); }
// the slope by a cubic B-spline from four bilinear taps: the landed brightness goes with the slope's derivative, which
// bilinear filtering makes piecewise constant (every texel would land as its own bead along the lines)
vec2 slopeB(vec2 uv) {
  vec2 size = vec2(textureSize(tS, ${Math.round(lod)})); vec2 st = uv * size - 0.5, i = floor(st), f = st - i, f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0, w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3, h0 = (i - 0.5 + w1 / g0) / size, h1 = (i + 1.5 + w3 / g1) / size; float l = ${lod.toFixed(2)};
  return g0.y * (g0.x * textureLod(tS, h0, l).xy + g1.x * textureLod(tS, vec2(h1.x, h0.y), l).xy) + g1.y * (g0.x * textureLod(tS, vec2(h0.x, h1.y), l).xy + g1.x * textureLod(tS, h1, l).xy);
}
void main() {
  vec2 u = (position.xy + 0.5) * ${(1 + 2 * m).toFixed(3)} - ${m.toFixed(3)}; // tile units, the margin past each edge
  vec2 s = slopeB(u);
  vec3 L = -uSun, nrm = normalize(vec3(-s.x, 1.0, -s.y));
  vec3 r = refract(L, nrm, 1.0 / ${n}), r0 = refract(L, vec3(0.0, 1.0, 0.0), 1.0 / ${n});
  // where the light lands on the floor, less where flat water's would: the pattern registered to the entry point
  vec2 off = (r.xz / -r.y - r0.xz / -r0.y) * ${depth.toFixed(2)};
  vOld = u * ${this.L.toFixed(4)}; vNew = vOld + off;
  vT = (1.0 - fres(max(dot(-L, nrm), 0.0))) / (1.0 - fres(max(uSun.y, 0.0)));
  gl_Position = vec4(vNew / ${this.L.toFixed(4)} * 2.0 - 1.0, 0.0, 1.0);
}`,
        fragmentShader: /* glsl */ `precision highp float;
in vec2 vOld; in vec2 vNew; in float vT; out vec4 oColor;
void main() {
  vec2 ox = dFdx(vOld), oy = dFdy(vOld), nx = dFdx(vNew), ny = dFdy(vNew);
  float a0 = abs(ox.x * oy.y - ox.y * oy.x), a1 = abs(nx.x * ny.y - nx.y * ny.x);
  float r = min(a0 / max(a1, 1e-12), ${C.maxRatio.toFixed(1)});
  oColor = vec4(0.0); oColor[${k}] = r * vT;
}`,
      });
      const span = Math.round(cells * (1 + 2 * m));
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, span, span), mat); mesh.frustumCulled = false;
      this.scene.add(mesh);
    });
    this.on = false;
  }
  // once a frame, after the wave field's update: the pattern for this sun (flat 1 when it is down)
  update(sunDir) {
    this.sun.value.copy(sunDir).normalize();
    this.on = sunDir.y > 0.02;
    const r = this.renderer, prev = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.rt); r.setClearColor(this.on ? 0x000000 : 0xffffff, 1); r.clear(true, false, false);
    if (this.on) r.render(this.scene, this.cam);
    r.setClearColor(cc, ca); r.setRenderTarget(prev);
  }
  // the reader is in water.js (wCaustic); uCaus = (tile size, on, texels a side, 0)
  dispose() { this.rt.dispose(); this.scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); }
}
