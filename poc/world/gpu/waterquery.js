// The water's height at points, back on the CPU (the pack's water/WaterQuery.js on WebGPU): the caller submits world
// xz points; a compute pass finds the surface over each exactly as the water's mesh draws it from the cascades (the
// choppy sideways displacement inverted by a few fixed-point steps: the vertex that lands on the point), on the water's
// level from the clipmap, and the result is read back asynchronously (1 to 3 frames late, fine for buoyancy).
// result per point: (height, displacement x, displacement z, depth)
import * as THREE from 'three/webgpu';
import { Fn, If, float, int, vec2, vec3, vec4, uniform, storage, instanceIndex, texture, smoothstep } from 'three/tsl';

export class GpuWaterQuery {
  // clip: gpu/clip.js, waves: gpu/waves.js, chop: the water's uChop uniform
  constructor(renderer, clip, waves, chop, capacity = 256) {
    this.renderer = renderer; this.capacity = capacity;
    this.inAttr = new THREE.StorageBufferAttribute(new Float32Array(capacity * 2), 2);
    this.outAttr = new THREE.StorageBufferAttribute(new Float32Array(capacity * 4), 4);
    const IN = storage(this.inAttr, 'vec2', capacity).toReadOnly(), OUT = storage(this.outAttr, 'vec4', capacity);
    const R = clip.reads('WQ'), Ls = waves.cascades, C = Ls.length;
    this.uCount = uniform(0, 'int');
    const disp = (x) => { let D = vec3(0); for (let c = 0; c < C; c++) { const d = texture(waves.disp[c], x.div(Ls[c])).level(0); D = D.add(vec3(d.x, d.y, d.z)); } return D; };
    this.kernel = Fn(() => {
      const i = int(instanceIndex);
      If(i.lessThan(this.uCount), () => {
        const q = IN.element(i), level = R.clipWater(q), depth = level.sub(R.clipAt(q).x).toVar();
        const k = smoothstep(0, 4, depth.max(0)).mul(chop);
        const x = q.toVar();
        for (let it = 0; it < 3; it++) { const D = disp(x).mul(k); x.assign(q.sub(D.xz)); }
        const D = disp(x).mul(k);
        OUT.element(i).assign(R.bind(vec4(level.add(D.y), D.x, D.z, depth)));
      });
    })().compute(capacity, [64]);
    this.inFlight = 0;
    this.result = new Float32Array(capacity * 4); this.resultCount = 0; this.resultTag = -1; this.resultTime = 0;
  }
  // xz: x, z pairs; tag: the points' layout (the caller drops results of an old one); time: the water's clock
  submit(xz, count, tag, time) {
    if (this.inFlight >= 2 || count === 0) return;
    count = Math.min(count, this.capacity);
    this.inAttr.array.set(xz.subarray(0, count * 2)); this.inAttr.needsUpdate = true;
    this.uCount.value = count;
    this.renderer.compute(this.kernel);
    this.inFlight++;
    this.renderer.getArrayBufferAsync(this.outAttr).then((b) => {
      this.result.set(new Float32Array(b).subarray(0, count * 4)); this.resultCount = count; this.resultTag = tag; this.resultTime = time;
    }).catch(() => {}).finally(() => { this.inFlight--; });
  }
}
