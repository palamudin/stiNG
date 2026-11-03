// Caustics on the floor of the sea (W2): the sun refracted by the wave field and splatted where it lands, so the
// brightness on the floor is the light that arrives there, also past the focus where rays cross (Wallace 2011's
// pool, done over terrain). A grid over the water round the view is pushed through the surface: each vertex is a
// bundle of sunlight that enters at the displaced surface, bends by Snell's law at the wave's normal, and runs down to
// the floor as drawn (the clipmap). The grid is drawn where the light lands, into a square texture over the floor,
// and every pixel adds the ratio of the area that light had on flat water to the area it has now (from the
// derivatives of the flat-water landing point), times the surface's transmission against flat water's. Overlapping
// sheets add, so focusing is exact; a pixel the flat water would light evenly reads 1. The mean over the floor stays
// 1 (energy is kept), which caustics-test.html measures. Waves shorter than two grid cells are left out (their slopes
// are taken from a mip as wide as a cell, so they do not alias).
import * as THREE from 'three';
import { WATER } from './water.js';

export const CAUSTICS = { res: 512, grid: 384, margin: 0.3 };

export class Caustics {
  // field: the WaveField; heightGLSL: GLSL defining float clipHeight(vec2); heightUniforms: its uniforms
  constructor(renderer, field, heightGLSL, heightUniforms, opts = {}) {
    this.renderer = renderer; this.field = field;
    const res = this.res = opts.res || CAUSTICS.res, M = this.grid = opts.grid || CAUSTICS.grid;
    this.rt = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, depthBuffer: false, samples: opts.msaa ?? 4, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const C = field.C, cs = [...Array(C).keys()];
    this.U = {
      ...heightUniforms,
      uCenter: { value: new THREE.Vector2() }, uSize: { value: 32 }, uSrc: { value: 40 }, uSea: { value: 0 },
      uSun: { value: new THREE.Vector3(0, 1, 0) }, uWL: { value: field.U.uL.value }, uCell: { value: 0.1 },
    };
    cs.forEach((c) => { this.U['tWD' + c] = { value: field.disp[c].texture }; this.U['tWS' + c] = { value: field.slope[c].texture }; });
    const geo = new THREE.PlaneGeometry(1, 1, M, M);
    const n = WATER.n.toFixed(3);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.U, depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide, // past a focus the sheet of light turns over
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      vertexShader: /* glsl */ `precision highp float;
${heightGLSL}
uniform vec2 uCenter; uniform float uSize, uSrc, uSea, uCell; uniform vec3 uSun; uniform vec4 uWL;
${cs.map((c) => `uniform sampler2D tWD${c}, tWS${c};`).join(' ')}
out vec2 vOld; out vec2 vNew; out float vT;
float fres(float ci) { float st2 = (1.0 - ci * ci) / (${n} * ${n}); float ct = sqrt(max(1.0 - st2, 0.0)); float rs = (ci - ${n} * ct) / (ci + ${n} * ct), rp = (${n} * ci - ct) / (${n} * ci + ct); return 0.5 * (rs * rs + rp * rp); }
// where a ray from p along r meets the floor (two fixed-point steps on the drawn ground)
vec2 land(vec3 p, vec3 r) {
  float t = max(p.y - clipHeight(p.xz), 0.0) / max(-r.y, 0.05);
  for (int i = 0; i < 2; i++) { vec2 q = p.xz + r.xz * t; t = max(p.y - clipHeight(q), 0.0) / max(-r.y, 0.05); }
  return p.xz + r.xz * t;
}
void main() {
  vec2 x0 = uCenter + position.xy * uSrc;
  vec3 d = vec3(0.0); vec2 s = vec2(0.0);
  ${cs.map((c) => `{ float lod = max(0.0, log2(uCell / uWL[${c}] * ${field.N}.0)); d += textureLod(tWD${c}, x0 / uWL[${c}], lod).xyz; s += textureLod(tWS${c}, x0 / uWL[${c}], lod).xy; }`).join('\n  ')}
  vec3 L = -uSun;
  vec3 nrm = normalize(vec3(-s.x, 1.0, -s.y));
  vec3 r = refract(L, nrm, 1.0 / ${n}), r0 = refract(L, vec3(0.0, 1.0, 0.0), 1.0 / ${n});
  vNew = land(vec3(x0.x + d.x, uSea + d.y, x0.y + d.z), r);
  vOld = land(vec3(x0.x + d.x, uSea, x0.y + d.z), r0); // the sunlight this patch of surface intercepts: its own (displaced) footprint
  vT = (1.0 - fres(max(dot(-L, nrm), 0.0))) / (1.0 - fres(max(uSun.y, 0.0)));
  gl_Position = vec4((vNew - uCenter) / uSize * 2.0, 0.0, 1.0);
}`,
      fragmentShader: /* glsl */ `precision highp float;
in vec2 vOld; in vec2 vNew; in float vT; out vec4 oColor;
void main() {
  vec2 ox = dFdx(vOld), oy = dFdy(vOld), nx = dFdx(vNew), ny = dFdy(vNew);
  float a0 = abs(ox.x * oy.y - ox.y * oy.x), a1 = abs(nx.x * ny.y - nx.y * ny.x);
  float r = min(a0 / max(a1, 1e-12), 1024.0); // a focus can be bright, but half floats end at 65504
  oColor = vec4(r * vT, r, 0.0, 1.0); // with the surface's transmission, and the geometry alone (the test reads both)
}`,
    });
    this.mesh = new THREE.Mesh(geo, this.mat); this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.mesh); this.cam = new THREE.Camera();
    this.on = false;
  }
  // the square of floor round (x, z), size metres across
  update(x, z, size, sea, sunDir) {
    const U = this.U, texel = size / this.res;
    U.uCenter.value.set(Math.round(x / texel) * texel, Math.round(z / texel) * texel); // snapped: the pattern does not crawl
    U.uSize.value = size; U.uSrc.value = size * (1 + 2 * CAUSTICS.margin); U.uSea.value = sea; U.uSun.value.copy(sunDir);
    U.uCell.value = U.uSrc.value / this.grid;
    this.on = sunDir.y > 0.02;
    const r = this.renderer, prev = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    if (this.on) r.render(this.scene, this.cam);
    r.setClearColor(cc, ca); r.setRenderTarget(prev);
  }
  dispose() { this.rt.dispose(); this.mesh.geometry.dispose(); this.mat.dispose(); }
}
