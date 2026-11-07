// The clouds on WebGPU (clouds.js): the slab between 1000 and 1650 m, its coverage drifting with the wind, eroded by
// blocky 3D noise (soft blocks, not wisps), lit by Beer-Lambert toward the sun, a two-lobe phase, the powder term and
// the sky's light; marched per pixel at a quarter of the screen's size (clouds.js CLOUD_GLSL, converted), and laid
// over the sky behind everything by the background (gpu/sky.js): the sky through what the clouds let past, plus
// their light. Their shadow (clouds.js, the second pass): the sun's transmittance through the slab over each point of a
// map round the camera, filled by a compute pass every few frames; shadowAt(p) reads it for a point at any height (the
// column toward the sun from there), receive(material) puts it on a lit material's sun (its received shadow), and the
// water and the grass's translucency multiply it into their own sun.
import * as THREE from 'three/webgpu';
import { Fn, float, int, vec2, vec3, vec4, ivec2, uniform, screenUV, screenCoordinate, wgslFn, wgsl, normalize, fract, dot, texture, textureStore, instanceIndex, storage, positionWorld, max, smoothstep, mix } from 'three/tsl';
import { CLOUDS_WGSL } from './clouds.wgsl.js';

const code = wgsl(CLOUDS_WGSL);
const fMarch = wgslFn('fn cMarch(ro: vec3<f32>, rd: vec3<f32>, tmax: f32, jit: f32, sunCol: vec3<f32>, sunDir: vec3<f32>, amb: vec3<f32>, cover: f32, dens: f32, drift: vec2<f32>) -> vec4<f32> { return cloudMarch(ro, rd, tmax, jit, sunCol, sunDir, amb, cover, dens, drift); }', [code]);
const fShade = wgslFn('fn cShade(xz: vec2<f32>, sun: vec3<f32>, cover: f32, dens: f32, drift: vec2<f32>) -> f32 { return cloudShade(xz, sun, cover, dens, drift); }', [code]);
// the shadow's map: texels, span (m), refreshed every few frames
export const CSHADOW = { n: 512, span: 10000, every: 3 };
const ign = wgslFn('fn cIgn(p: vec2<f32>) -> f32 { return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))); }');

export class GpuClouds {
  // sky: gpu/sky.js GpuSky (the sun, its colour, the sky's light)
  constructor(renderer, sky) {
    this.renderer = renderer; this.sky = sky;
    this.uCover = uniform(0.35); this.uDens = uniform(1); this.uDrift = uniform(new THREE.Vector2()); this.uFrame = uniform(0);
    this.uInvProj = uniform(new THREE.Matrix4()); this.uCamWorld = uniform(new THREE.Matrix4()); this.uCamPos = uniform(new THREE.Vector3());
    this.rt = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }); this.rt.texture.minFilter = this.rt.texture.magFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.outputNode = Fn(() => {
      // the view ray through this pixel of the scene's camera (the quad's own camera is not it)
      const ndc = vec4(screenUV.x.mul(2).sub(1), float(1).sub(screenUV.y.mul(2)), 1, 1), p = this.uInvProj.mul(ndc);
      const v = normalize(this.uCamWorld.mul(vec4(p.xyz.div(p.w), 0)).xyz);
      const jit = fract(ign({ p: screenCoordinate.xy }).add(fract(this.uFrame.mul(0.618)).mul(17)));
      return fMarch({ ro: this.uCamPos, rd: v, tmax: float(1e9), jit, sunCol: sky.uSunColor, sunDir: sky.uSun, amb: sky.uSkyUp, cover: this.uCover, dens: this.uDens, drift: this.uDrift });
    })();
    this.quad = new THREE.QuadMesh(mat);
    this.time = 0;
    // the shadow's map: texel (i, j) holds the transmittance over the ground point origin + (i + 0.5, j + 0.5) * texel
    const n = CSHADOW.n, TX = CSHADOW.span / n;
    const t = this.shadowTex = new THREE.StorageTexture(n, n); t.type = THREE.HalfFloatType; t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    this.uShOrigin = uniform(new THREE.Vector2()); this.uShSun = uniform(new THREE.Vector3(0, 1, 0)); this.uShOn = uniform(1);
    const uNext = this.uShNext = uniform(new THREE.Vector2());
    this.kShadow = Fn(() => {
      const id = int(instanceIndex), x = id.mod(n), y = id.div(n);
      const xz = uNext.add(vec2(float(x), float(y)).add(0.5).mul(TX));
      const s = fShade({ xz, sun: this.uShSun, cover: this.uCover, dens: this.uDens, drift: this.uDrift });
      textureStore(t, ivec2(x, y), vec4(s, 0, 0, 1));
    })().compute(n * n, [64]);
    this._shF = 0;
    // the probe: the sun's light through the clouds at one point (the eye's adaptation reads it back)
    this.probeAttr = new THREE.StorageBufferAttribute(new Float32Array(4), 1); const PB = storage(this.probeAttr, 'float', 4);
    this.uProbe = uniform(new THREE.Vector2());
    this.kProbe = Fn(() => { PB.element(0).assign(fShade({ xz: this.uProbe, sun: this.uShSun, cover: this.uCover, dens: this.uDens, drift: this.uDrift })); })().compute(1);
    this._busy = false; this.light = 1;
  }
  // the light at a world point, read back a frame or so later into this.light (0..1)
  probe(p) {
    if (this._busy) return; this._busy = true;
    const S = this.uShSun.value, k = p.y / Math.max(S.y, 0.03);
    this.uProbe.value.set(p.x - S.x * k, p.z - S.z * k);
    this.renderer.compute(this.kProbe);
    this.renderer.getArrayBufferAsync(this.probeAttr).then((b) => { this.light = this.uShOn.value ? new Float32Array(b)[0] : 1; this._busy = false; }, () => { this._busy = false; });
  }
  // the sun's light through the clouds at a world point (a node); 1 off the map and when the shadow is off
  shadowAt(p = positionWorld) {
    const S = this.uShSun, q = p.xz.sub(S.xz.mul(p.y.div(max(S.y, 0.03)))); // the ground point under the same column
    const uv = q.sub(this.uShOrigin).div(CSHADOW.span), e = uv.min(vec2(1).sub(uv)), k = smoothstep(0, 0.06, e.x.min(e.y));
    return mix(float(1), texture(this.shadowTex, uv).level(0).x, k.mul(this.uShOn));
  }
  // (extra: another factor on the same light, e.g. gpu/caustics.js)
  receive(mat, extra = null) { if (mat && mat.isNodeMaterial) { const sh = extra ? this.shadowAt().mul(extra) : this.shadowAt(); mat.receivedShadowNode = Fn(([s]) => s.mul(sh)); } }
  // the weather: cover 0..1, density, the wind (m/s) that drifts them
  // the shadow's map, before the scene (every few frames, moved with the camera in whole texels): the camera's
  // position, the key light's direction, whether it is on
  shadow(camera, sunDir, on = true) {
    this.uShOn.value = on ? 1 : 0; if (!on) return;
    if (this._shF++ % CSHADOW.every) return;
    const TX = CSHADOW.span / CSHADOW.n, h = CSHADOW.span / 2;
    this.uShNext.value.set(Math.floor((camera.position.x - h) / TX) * TX, Math.floor((camera.position.z - h) / TX) * TX);
    this.uShSun.value.copy(sunDir);
    this.renderer.compute(this.kShadow);
    this.uShOrigin.value.copy(this.uShNext.value);
  }
  set(cover, dens, dt, wind) { this.time += dt; this.uCover.value = cover; this.uDens.value = dens; this.uDrift.value.set(wind[0] * this.time * 2.5, wind[1] * this.time * 2.5); }
  // once a frame, before the scene: the layer at a quarter of the screen's size
  render(camera, w, h) {
    const W = Math.max(1, Math.round(w / 4)), H = Math.max(1, Math.round(h / 4));
    if (this.rt.width !== W || this.rt.height !== H) this.rt.setSize(W, H);
    camera.updateMatrixWorld();
    this.uInvProj.value.copy(camera.projectionMatrixInverse); this.uCamWorld.value.copy(camera.matrixWorld); this.uCamPos.value.copy(camera.position); this.uFrame.value++;
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.rt); this.quad.render(r); r.setRenderTarget(prev);
  }
}
