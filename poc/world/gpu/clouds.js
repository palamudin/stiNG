// The clouds on WebGPU (clouds.js): the slab between 1000 and 1650 m, its coverage drifting with the wind, eroded by
// blocky 3D noise (soft blocks, not wisps), lit by Beer-Lambert toward the sun, a two-lobe phase, the powder term and
// the sky's light; marched per pixel at a quarter of the screen's size (clouds.js CLOUD_GLSL, converted), and laid
// over the sky behind everything by the background (gpu/sky.js): the sky through what the clouds let past, plus
// their light. The ground's cloud shadow is not ported yet.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, screenUV, screenCoordinate, wgslFn, wgsl, normalize, fract, dot } from 'three/tsl';
import { CLOUDS_WGSL } from './clouds.wgsl.js';

const code = wgsl(CLOUDS_WGSL);
const fMarch = wgslFn('fn cMarch(ro: vec3<f32>, rd: vec3<f32>, tmax: f32, jit: f32, sunCol: vec3<f32>, sunDir: vec3<f32>, amb: vec3<f32>, cover: f32, dens: f32, drift: vec2<f32>) -> vec4<f32> { return cloudMarch(ro, rd, tmax, jit, sunCol, sunDir, amb, cover, dens, drift); }', [code]);
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
  }
  // the weather: cover 0..1, density, the wind (m/s) that drifts them
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
