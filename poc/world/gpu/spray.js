// The breakers' spray on WebGPU: water thrown off a breaking crest, as particles. A pool of them, all on the GPU:
//   - each frame a few thousand candidate points are drawn round the eye (a fixed hash of the frame and the thread:
//     the same on every machine); one over the surf zone where a crest is breaking (the coast's whitewater, from the
//     shore table, gpu/coast.wgsl.js coastFieldAt) throws a particle in proportion to it, from the crest's height (its
//     displacement, coastVert), forward with the wave's speed and up, the wind taking some;
//   - every particle flies under gravity with drag toward the wind's speed, grows as it spreads into mist, and dies
//     where it falls back into the water or when it has lived its time;
//   - drawn as soft round billboards facing the eye, lit by the sun through the clouds' shadow (brighter looking into
//     it: forward scattering) and the sky, faded where they meet the scene so they never cut a line into it.
import * as THREE from 'three/webgpu';
import { Fn, If, Return, float, int, uint, vec2, vec3, vec4, uniform, storage, instanceIndex, wgslFn, wgsl, atomicAdd, max, min, exp, clamp, smoothstep, mix, fract, sin, dot, length, normalize, pow, select, positionLocal, cameraViewMatrix, cameraProjectionMatrix, varyingProperty, uv, screenUV, viewportDepthTexture, perspectiveDepthToViewZ, cameraNear, cameraFar } from 'three/tsl';
import { COAST_WGSL } from './coast.wgsl.js';

export const SPRAY = { n: 32768, spawn: 16384, radius: 160, life: 2.6, rate: 1 };
const coastCode = wgsl(COAST_WGSL);
const cField = wgslFn('fn sCoastField(p: vec2<f32>, sh: vec4<f32>, know: f32, depth: f32, cell: f32, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> mat4x4<f32> { return coastFieldAt(p, sh, know, depth, cell, surf, surfX, t, swDir); }', [coastCode]);
const cVert = wgslFn('fn sCoastVert(xz: vec2<f32>, sh: vec4<f32>, know: f32, depth: f32, cell: f32, fl: f32, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> mat4x4<f32> { return coastVert(xz, sh, know, depth, cell, fl, surf, surfX, t, swDir); }', [coastCode]);
const hash = wgslFn('fn sHash(a: u32, b: u32) -> f32 { var x = a * 747796405u + b * 2891336453u + 12345u; x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u; x = (x >> 22u) ^ x; return f32(x) / 4294967295.0; }');

export class GpuSpray {
  // opts: clip, shore (gpu/shore.js), surfU (gpu/water.js surfUniforms), sunDir, sunColor, skyUp (uniforms), clouds
  constructor(renderer, opts) {
    const N = SPRAY.n, M = SPRAY.spawn;
    this.renderer = renderer;
    this.posAttr = new THREE.StorageBufferAttribute(new Float32Array(N * 4), 4); // xyz, life left (s)
    this.velAttr = new THREE.StorageBufferAttribute(new Float32Array(N * 4), 4); // velocity, size (m)
    this.ringAttr = new THREE.StorageBufferAttribute(new Uint32Array(4), 1);
    const P = storage(this.posAttr, 'vec4', N), V = storage(this.velAttr, 'vec4', N), RING = storage(this.ringAttr, 'uint', 4).toAtomic();
    this.uEye = uniform(new THREE.Vector3()); this.uFrame = uniform(0, 'uint'); this.uDt = uniform(0); this.uWind = uniform(new THREE.Vector2()); this.uOn = uniform(1); this.uRate = uniform(SPRAY.rate);
    const RC = opts.clip.reads('SP'), RU = opts.clip.reads('SU'), shR = opts.shore.reader(), S = opts.surfU;
    const surf = { surf: S.uSurf, surfX: S.uSurfX, t: S.uWTime, swDir: S.uSwDir };
    // spawning: a candidate point per thread, uniformly over a disc round the eye
    this.kSpawn = Fn(() => {
      const id = uint(instanceIndex);
      If(this.uOn.lessThan(0.5).or(S.uSurf.x.lessThanEqual(0)), () => { Return(); });
      const r1 = hash({ a: id, b: this.uFrame }), r2 = hash({ a: id.add(77777), b: this.uFrame }), r3 = hash({ a: id.add(15485863), b: this.uFrame });
      const ang = r1.mul(6.2831853), rad = r2.sqrt().mul(SPRAY.radius);
      const p = this.uEye.xz.add(vec2(ang.cos(), ang.sin()).mul(rad)).toVar();
      const level = RC.clipWater(p).toVar(), depth = level.sub(RC.clipAt(p).x).toVar();
      If(depth.lessThan(0.15).or(depth.greaterThan(7)).or(level.greaterThan(S.uSea.add(0.5))), () => { Return(); });
      const sh = shR(p), m = cField({ p, sh: sh.v, know: sh.know, depth, cell: float(0.5), ...surf }).toVar();
      const white = m.element(0).x.mul(m.element(0).w);
      // the share of candidates that throw: the whitewater here, the wave's size, the rate; the area each stands for
      // grows with the disc, so the rate is per square metre
      If(r3.greaterThanEqual(white.mul(this.uRate).mul(smoothstep(0.1, 0.6, S.uSurf.x)).mul(this.uDt.mul(60))), () => { Return(); });
      const cv = cVert({ xz: p, sh: sh.v, know: sh.know, depth, cell: float(0.5), fl: float(0), ...surf });
      const dir = m.element(1).xy, cel = depth.max(0.3).mul(9.81).sqrt();
      const r4 = hash({ a: id.add(3), b: this.uFrame.add(1) }), r5 = hash({ a: id.add(5), b: this.uFrame.add(2) }), r6 = hash({ a: id.add(9), b: this.uFrame.add(3) });
      const slot = atomicAdd(RING.element(0), uint(1)).mod(uint(N));
      const up = mix(float(1.2), float(4.5), r4.mul(r4)).mul(smoothstep(0.1, 0.9, S.uSurf.x).mul(0.7).add(0.3));
      const fwd = cel.mul(mix(float(0.35), float(0.9), r5));
      const side = vec2(dir.y.negate(), dir.x).mul(r6.sub(0.5).mul(1.2));
      const v = vec3(dir.x.mul(fwd).add(side.x), up, dir.y.mul(fwd).add(side.y)).add(vec3(this.uWind.x, 0, this.uWind.y).mul(0.25));
      P.element(slot).assign(RC.bind(vec4(p.x.add(cv.element(0).x), level.add(cv.element(0).y).add(0.05), p.y.add(cv.element(0).z), mix(float(SPRAY.life * 0.4), float(SPRAY.life), r6))));
      V.element(slot).assign(vec4(v, mix(float(0.08), float(0.22), r5)));
    })().compute(M, [64]);
    // flight: gravity, drag toward the wind, the size growing into mist; dead under the water
    this.kStep = Fn(() => {
      const i = int(instanceIndex), p = P.element(i).toVar();
      If(p.w.lessThanEqual(0), () => { Return(); });
      const v = V.element(i).toVar(), dt = this.uDt;
      const air = vec3(this.uWind.x, 0, this.uWind.y);
      v.xyz.assign(air.add(v.xyz.sub(air).mul(exp(dt.mul(-1.6)))).add(vec3(0, -9.81, 0).mul(dt).mul(0.55)));
      p.xyz.addAssign(v.xyz.mul(dt));
      p.w.subAssign(dt);
      v.w.assign(v.w.add(dt.mul(0.35)));
      const level = RU.clipWater(p.xz);
      If(p.y.lessThan(level.sub(0.15)).and(v.y.lessThan(0)), () => { p.w.assign(0); });
      P.element(i).assign(RU.bind(p)); V.element(i).assign(v);
    })().compute(N, [64]);
    // the billboards: one quad per particle (dead ones folded away), soft round dots
    const PR = storage(this.posAttr, 'vec4', N).toReadOnly(), VR = storage(this.velAttr, 'vec4', N).toReadOnly();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]); g.instanceCount = N; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const vLife = varyingProperty('float', 'spLife'), vAge = varyingProperty('float', 'spAge'), vZ = varyingProperty('float', 'spZ');
    mat.vertexNode = Fn(() => {
      const p = PR.element(instanceIndex), v = VR.element(instanceIndex);
      const alive = p.w.greaterThan(0);
      vLife.assign(p.w); vAge.assign(v.w);
      const c = cameraViewMatrix.mul(vec4(p.xyz, 1)); vZ.assign(c.z);
      const s = select(alive, v.w, float(0));
      return cameraProjectionMatrix.mul(vec4(c.xy.add(positionLocal.xy.mul(s)), c.z, 1));
    })();
    const sunDir = opts.sunDir, sunColor = opts.sunColor, skyUp = opts.skyUp;
    mat.colorNode = Fn(() => {
      const d = length(uv().sub(0.5)).mul(2);
      const a = smoothstep(1, 0.2, d).mul(smoothstep(0, 0.4, vLife)).mul(smoothstep(0.9, 0.12, vAge)).mul(0.55);
      // soft against the scene: faded as the dot's depth nears what is behind it
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(screenUV).x, cameraNear, cameraFar);
      const soft = clamp(vZ.sub(sceneZ).mul(2.5), 0, 1);
      const fwd = pow(max(dot(cameraViewMatrix.mul(vec4(sunDir, 0)).xyz.normalize(), vec3(0, 0, -1)), 0), float(6)).mul(2.5).add(0.6);
      const cs = opts.clouds ? opts.clouds.shadowAt() : float(1);
      const col = sunColor.mul(cs).mul(max(sunDir.y, 0.05)).mul(fwd).mul(0.35).add(skyUp.mul(0.45)).mul(0.9);
      return vec4(col, a.mul(soft));
    })();
    this.mesh = new THREE.Mesh(g, mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 12; this.mesh.name = 'spray';
    this.frame = 0;
  }
  // once a frame: the eye, the water's dt, the wind (m/s)
  update(camera, dt, wind, on = true) {
    this.uOn.value = on ? 1 : 0; this.mesh.visible = on;
    this.uEye.value.copy(camera.position); this.uDt.value = Math.min(Math.max(dt, 0), 0.05); this.uWind.value.set(wind[0], wind[1]);
    this.uFrame.value = this.frame++ >>> 0;
    if (on) this.renderer.compute(this.kSpawn);
    this.renderer.compute(this.kStep);
  }
}
