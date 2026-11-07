// The breakers' spray on WebGPU: drops thrown off a breaking crest. A pool of them on the GPU, launched and then replayed:
//   - each frame a few thousand candidate points are drawn round the eye (a fixed hash of the frame and the thread:
//     the same on every machine); one over the surf zone where a crest is breaking (the coast's whitewater, from the
//     shore table, gpu/coast.wgsl.js coastFieldAt) throws a particle in proportion to it, from the crest's height (its
//     displacement, coastVert), forward with the wave's speed and up, the wind taking some;
//   - nothing steps them after: a drop's place at any age is the closed form of its flight (below), so a pool of any
//     size costs only its draw; drawn as thin streaks along their screen velocity, faded where they meet the scene.
import * as THREE from 'three/webgpu';
import { Fn, If, Return, float, int, uint, vec2, vec3, vec4, uniform, storage, instanceIndex, wgslFn, wgsl, atomicAdd, max, min, exp, abs, clamp, smoothstep, mix, fract, sin, dot, length, normalize, pow, select, positionLocal, cameraViewMatrix, cameraProjectionMatrix, varyingProperty, uv, screenUV, viewportDepthTexture, perspectiveDepthToViewZ, cameraNear, cameraFar } from 'three/tsl';
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
    this.uEye = uniform(new THREE.Vector3()); this.uFrame = uniform(0, 'uint'); this.uDt = uniform(0); this.uWind = uniform(new THREE.Vector2()); this.uTime = uniform(0); this.uOn = uniform(1); this.uRate = uniform(SPRAY.rate);
    const RC = opts.clip.reads('SP'), shR = opts.shore.reader(), S = opts.surfU;
    const surf = { surf: S.uSurf, surfX: S.uSurfX, t: S.uWTime, swDir: S.uSwDir };
    // spawning: a candidate point per thread, uniformly over a disc round the eye
    this.kSpawn = Fn(() => {
      const id = uint(instanceIndex);
      If(this.uOn.lessThan(0.5).or(S.uSurf.x.lessThanEqual(0)), () => { Return(); });
      const r1 = hash({ a: id, b: this.uFrame }), r2 = hash({ a: id.add(77777), b: this.uFrame }), r3 = hash({ a: id.add(15485863), b: this.uFrame });
      const ang = r1.mul(6.2831853), rad = r2.pow(0.75).mul(SPRAY.radius); // denser toward the eye
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
      // a burst of four: three drops of spray and a puff of mist (bigger, slower, longer)
      const base = atomicAdd(RING.element(0), uint(4));
      const o = vec3(p.x.add(cv.element(0).x), level.add(cv.element(0).y).add(0.05), p.y.add(cv.element(0).z));
      const big = smoothstep(0.1, 0.9, S.uSurf.x).mul(0.7).add(0.3);
      for (let j = 0; j < 4; j++) {
        const a = hash({ a: id.add(101 + j * 13), b: this.uFrame }), b = hash({ a: id.add(203 + j * 17), b: this.uFrame }), c = hash({ a: id.add(307 + j * 19), b: this.uFrame });
        const mist = false; // (mist: crest ribbons later, not puffs)
        const up = (mist ? mix(float(0.6), float(1.6), a) : mix(float(1.2), float(4.8), a.mul(a))).mul(big);
        const fwd = cel.mul(mist ? mix(float(0.15), float(0.4), b) : mix(float(0.35), float(0.95), b));
        const side = vec2(dir.y.negate(), dir.x).mul(c.sub(0.5).mul(1.4)).add(vec2(r4.sub(0.5), r5.sub(0.5)).mul(0.3));
        const v = vec3(dir.x.mul(fwd).add(side.x), up, dir.y.mul(fwd).add(side.y)).add(vec3(this.uWind.x, 0, this.uWind.y).mul(0.25));
        const slot = base.add(uint(j)).mod(uint(N));
        P.element(slot).assign(RC.bind(vec4(o.add(vec3(c.sub(0.5), a.mul(0.2), b.sub(0.5)).mul(0.6)), this.uTime)));
        V.element(slot).assign(vec4(v, mix(float(SPRAY.life * 0.3), float(SPRAY.life * 0.8), c))); // the launch: velocity, life
      }
    })().compute(M, [64]);
    // flight, replayed: nothing steps the particles; each holds its launch (place, time, velocity, life) and its place
    // at any age is the closed form of gravity with drag toward the wind's speed (dv/dt = -k (v - air) + g):
    //   x(t) = x0 + (air + g/k) t + (v0 - air - g/k) (1 - e^-kt) / k
    // drawn as a thin streak along its screen velocity (a drop's motion over a frame), not a disc
    const PR = storage(this.posAttr, 'vec4', N).toReadOnly(), VR = storage(this.velAttr, 'vec4', N).toReadOnly();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]); g.instanceCount = N; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const vAge = varyingProperty('float', 'spAge'), vZ = varyingProperty('float', 'spZ'), vFade = varyingProperty('float', 'spFade');
    const K = 1.6, G = vec3(0, -9.81 * 0.55, 0);
    mat.vertexNode = Fn(() => {
      const p = PR.element(instanceIndex), v = VR.element(instanceIndex);
      const t = this.uTime.sub(p.w).toVar(), life = v.w;
      const alive = t.greaterThan(0).and(t.lessThan(life));
      const air = vec3(this.uWind.x, 0, this.uWind.y), drift = air.add(G.div(K)), e = exp(t.mul(-K));
      const x = p.xyz.add(drift.mul(t)).add(v.xyz.sub(drift).mul(float(1).sub(e).div(K)));
      const vel = drift.add(v.xyz.sub(drift).mul(e));
      vAge.assign(t.div(max(life, 0.01))); vFade.assign(select(alive, float(1), float(0)));
      const c = cameraViewMatrix.mul(vec4(x, 1)), cv = cameraViewMatrix.mul(vec4(vel, 0)).xy; vZ.assign(c.z);
      const sp = length(cv), dir = select(sp.greaterThan(1e-3), cv.div(sp), vec2(0, 1)), side = vec2(dir.y.negate(), dir.x);
      const w = float(0.012).add(t.mul(0.01)), len = sp.mul(0.035).add(w); // a frame's travel at 30 fps
      const off = dir.mul(positionLocal.y.mul(len)).add(side.mul(positionLocal.x.mul(w))).mul(select(alive, float(1), float(0)));
      return cameraProjectionMatrix.mul(vec4(c.xy.add(off), c.z, 1));
    })();
    const sunDir = opts.sunDir, sunColor = opts.sunColor, skyUp = opts.skyUp;
    mat.colorNode = Fn(() => {
      const d = abs(uv().x.sub(0.5)).mul(2), e = abs(uv().y.sub(0.5)).mul(2);
      const a = smoothstep(1, 0.2, d).mul(smoothstep(1, 0.5, e)).mul(float(1).sub(smoothstep(0.5, 1, vAge))).mul(vFade).mul(0.65).mul(smoothstep(1, 3, vZ.negate()));
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
    this.time = (this.time || 0) + this.uDt.value; this.uTime.value = this.time;
    if (on) this.renderer.compute(this.kSpawn);
  }
}
