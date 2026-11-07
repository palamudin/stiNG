// Grass and wild flowers on WebGPU (grass.js, GPU-driven). The same nested rings of clumps round the camera (GRASS:
// 5, 10, 20, 40, 80 m; a clump named by its index on the finest grid, so a coarser ring's clump is a finer one's at
// the same place with the same blades), the same rules for what grows (stone, sand, water, trails, paving, a dense
// canopy, snow, wear) and the same wind (the log law to a blade's top, gusts running downwind, eddies carried in
// them, eight ways of swaying from the tabulated sway). What changes: each frame one compute pass a ring walks its grid
// cells and keeps only the clumps that are in its band, in view and growing, appending each (its ground, height,
// moisture, gust and eddy, its fade) to the ring's list with an atomic counter; a second writes the counts into the
// indirect draws. The blades are drawn only for those: no vertex works out a clump that is bare or out of view.
import * as THREE from 'three/webgpu';
import { Fn, If, Return, float, int, uint, vec2, vec3, vec4, ivec2, uniform, uniformArray, storage, instanceIndex, attribute, texture, screenCoordinate, positionWorld, cameraPosition, cameraViewMatrix, wgslFn, wgsl, sin, cos, log, exp2, length, normalize, cross, dot, min, max, mix, clamp, smoothstep, floor, fract, select, sqrt, pow, atomicAdd, atomicLoad, atomicStore, varyingProperty } from 'three/tsl';
import { GRASS, SWAY, swayTable, clumpGeometry } from '../grass.js';
import { COAST_WGSL } from './coast.wgsl.js';

const code = wgsl(COAST_WGSL); // its hash and noise (noise.js's twins)
const h01 = wgslFn('fn gH01(x: i32, y: i32, s: i32) -> f32 { return w2hash01_(x, y, s); }', [code]);
const nz = wgslFn('fn gNoise(p: vec2<f32>, s: i32) -> f32 { return w2noise(p, s); }', [code]);
const ign = wgslFn('fn gIgn(p: vec2<f32>) -> f32 { return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))); }');

export class GpuGrass {
  // opts: clip, source, density, flowers
  constructor(renderer, opts) {
    this.renderer = renderer; this.clip = opts.clip; this.source = opts.source;
    this.density = opts.density ?? 1;
    this.group = new THREE.Group(); this.group.name = 'gpu-grass';
    const d = Math.sqrt(this.density), s0 = GRASS.s0 / d, src = this.source;
    const GH = src.grassHeight || [0.1, 0.42];
    // shared: the wind, the eye, the sway's phases (integrated here in doubles, bounded), the view
    this.uWind = uniform(new THREE.Vector2(0.8, 0.3)); this.uCam = uniform(new THREE.Vector3()); this.uAlt = uniform(0);
    this.uPh = uniformArray(Array.from({ length: 8 }, () => new THREE.Vector2()), 'vec2'); this.uGustPh = uniform(0); this.uSwayRow = uniform(0.5 / SWAY.levels); this.uEddy = uniform(new THREE.Vector2());
    this.uVP = uniform(new THREE.Matrix4()); this.uPS = uniform(new THREE.Vector2(1, 1)); /* the view-projection; the projection's x and y scales */ this.uBloom = uniform(1); this.uSnowCover = uniform(0); this.uTint = uniform(new THREE.Vector3(1, 1, 1));
    this.clouds = opts.clouds || null; // gpu/clouds.js: their shadow on the light through the blades
    this.uSunDir = opts.sunDir || uniform(new THREE.Vector3(0.45, 0.62, 0.3).normalize()); this.uSunColor = opts.sunColor || uniform(new THREE.Color(1, 0.95, 0.86).multiplyScalar(3));
    this.tSway = swayTable();
    this.uZ0 = 0.1 * (GH[0] + GH[1]) / 2;
    this.sway = { wind: null, gust: 0, eddy: [0, 0], ph: Array.from({ length: 8 }, (_, m) => [m * 0.618 % 1, m * 0.382 % 1]) };
    this.rings = [];
    GRASS.rings.forEach((R, k) => { const next = GRASS.rings[k + 1]; this._ring(k, s0, k ? GRASS.r0 * 2 ** (k - 1) : 0, GRASS.r0 * 2 ** k, false, R.blades, R.segs, next ? next.blades : 0); });
    if (opts.flowers !== false) this._ring(0, GRASS.flowers.spacing / d, 0, GRASS.flowers.radius, true, 3, 3, 0);
    this.far = GRASS.r0 * 2 ** (GRASS.rings.length - 1);
    const NR = this.rings.length;
    this.cntAttr = new THREE.StorageBufferAttribute(new Uint32Array(NR), 1); this.cnt = storage(this.cntAttr, 'uint', NR).toAtomic();
    this.argsS = storage(this.args, 'uint', NR * 5);
    this.kFinish = Fn(() => {
      const r = int(instanceIndex);
      const cap = uint(0).toVar(); this.rings.forEach((R, i) => If(r.equal(i), () => { cap.assign(R.cap); }));
      this.argsS.element(r.mul(5).add(1)).assign(min(atomicLoad(this.cnt.element(r)), cap));
      atomicStore(this.cnt.element(r), uint(0));
    })().compute(NR, [64]);
    for (const R of this.rings) R.kernel = this._kernel(R);
    this.stats = { clumps: 0 };
  }

  _ring(k, S0, rin, rout, flower, blades, segs, nextBlades) {
    const sp = S0 * 2 ** k, slack = 0.5 * S0 * 2 ** GRASS.jitterLv + sp, n = Math.ceil((rout + slack) / sp), N = 2 * n + 1, cap = N * N;
    const i = this.rings.length;
    if (!this.args) this.args = new THREE.IndirectStorageBufferAttribute(new Uint32Array(6 * 5), 5);
    // the clumps kept this frame: three vec4 each: (base x, z, ground, height), (moisture, gust, eddy, rnd),
    // (the ring's fade, its own dissolve threshold, dither, 1 where a coarser ring also has it)
    const attr = new THREE.StorageBufferAttribute(new Float32Array(cap * 12), 4);
    const R = { i, k, S0, rin, rout, flower, blades, segs, nextBlades, sp, n, N, cap, attr, inst: storage(attr, 'vec4', cap * 3) };
    // the blades: grass.js's clump, as a plain geometry drawn indirectly
    const cg = clumpGeometry(blades, segs), g = new THREE.BufferGeometry();
    for (const name of Object.keys(cg.attributes)) g.setAttribute(name, cg.attributes[name]);
    g.setIndex(cg.index); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.args.array.set([cg.index.count, 0, 0, 0, 0], i * 5); g.setIndirect(this.args, i * 20);
    const mesh = new THREE.Mesh(g, this._material(R)); mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
    mesh.name = `grass ring ${k}${flower ? ' flowers' : ''}`;
    this.group.add(mesh); R.mesh = mesh;
    this.rings.push(R);
  }

  // the ring's pass: every grid cell, kept or not (grass.js GRASS_BUILD's clump part and the clump cache's)
  _kernel(R) {
    const RC = this.clip.reads('G' + R.i), src = this.source, GH = src.grassHeight || [0.1, 0.42], wild = src.wildGrass || GH;
    const shore = src.sea > -1e5 ? 1 : 0, wildFrom = src.wildFrom || 0, wood = src.grassWood ?? 1, sea = src.sea ?? 0, snowLine = shore ? 215 : 1e9;
    return Fn(() => {
      const t = int(instanceIndex), ax = t.mod(R.N).sub(R.n), az = t.div(R.N).sub(R.n);
      const org = floor(this.uCam.xz.div(R.sp)).mul(R.sp), cw = org.add(vec2(float(ax), float(az)).mul(R.sp));
      const cx = int(floor(cw.x.div(R.S0).add(0.5))).toVar(), cz = int(floor(cw.y.div(R.S0).add(0.5))).toVar();
      // its level: the coarsest grid it still sits on (the trailing zero bits of its index)
      const bits = cx.bitOr(cz), lvl = int(7).toVar();
      for (let b = 6; b >= 0; b--) If(bits.shiftRight(b).bitAnd(1).notEqual(0), () => { lvl.assign(b); });
      const jit = float(R.S0).mul(exp2(float(min(lvl, GRASS.jitterLv))));
      const base = vec2(float(cx), float(cz)).mul(R.S0).add(vec2(h01({ x: cx, y: cz, s: int(201) }), h01({ x: cx, y: cz, s: int(202) })).sub(0.5).mul(jit)).toVar();
      const dist = length(base.sub(this.uCam.xz)), de = sqrt(dist.mul(dist).add(this.uAlt.mul(GRASS.altK).mul(this.uAlt.mul(GRASS.altK)))).toVar();
      If(de.lessThan(R.rin).or(de.greaterThanEqual(R.rout)), () => { Return(); });
      const gd = RC.clipAt(base).toVar();
      // in view (5% wider than the frame, plus a clump's reach)
      const cc = this.uVP.mul(vec4(base.x, gd.x, base.y, 1));
      const mx = cc.w.mul(1.05).add(this.uPS.x.mul(1.6)), my = cc.w.mul(1.05).add(this.uPS.y.mul(1.6));
      If(cc.x.abs().greaterThan(mx).or(cc.y.abs().greaterThan(my)).or(cc.w.lessThan(-2)), () => { Return(); });
      const gn = RC.clipNormal(base), hgt = gd.x.sub(RC.clipWater(base)), slope = float(1).sub(gn.y);
      const dens = float(1).sub(smoothstep(0.32, 0.45, slope)).mul(mix(float(1), smoothstep(1.3, 2.2, hgt), shore)).mul(float(1).sub(smoothstep(0.3, 0.45, gd.w))).mul(mix(float(1), float(0.35), smoothstep(0.4, 0.8, gd.z))).toVar();
      dens.mulAssign(float(this.density).mul(float(1).sub(smoothstep(snowLine - 10, snowLine + 10, gd.x.sub(sea)))));
      dens.mulAssign(float(1).sub(smoothstep(0.97, 1.03, gd.y)));
      const wr = select(gd.w.lessThan(0.3), gd.w.div(0.2).clamp(0, 1), float(0)); // grass.js w2wear
      const bn = float(0.5).add(nz({ p: base.div(1.1), s: int(207) }).mul(0.28)).add(nz({ p: base.div(0.3), s: int(208) }).mul(0.16)).add(nz({ p: base.div(0.09), s: int(209) }).mul(0.12));
      dens.mulAssign(float(1).sub(smoothstep(bn.sub(0.05), bn.add(0.05), wr.mul(0.92)))); // trodden: bare in patches (w2bare)
      if (R.flower) dens.mulAssign(smoothstep(0.1, 0.6, nz({ p: base.div(9), s: int(211) }).add(gd.y.sub(0.5).mul(0.35))).mul(float(1).sub(smoothstep(0.3, 0.6, gd.z))).mul(this.uBloom));
      dens.mulAssign(float(1).sub(this.uSnowCover.mul(0.92)));
      If(h01({ x: cx, y: cz, s: int(203) }).greaterThan(dens), () => { Return(); });
      const fade = float(1).sub(smoothstep(R.rout * GRASS.band, R.rout, de)).mul(float(1).sub(smoothstep(8, 30, this.uAlt))).toVar();
      const th = h01({ x: cx, y: cz, s: int(213) }).toVar();
      const persist = lvl.greaterThan(R.k);
      If(persist.not().and(fade.sub(th.mul(0.85)).lessThanEqual(0)), () => { Return(); }); // dissolved
      const rnd = h01({ x: cx, y: cz, s: int(204) }).toVar();
      const Gh = wildFrom > 0 ? mix(vec2(...GH), vec2(...wild), smoothstep(wildFrom * 0.85, wildFrom * 1.05, length(base))) : vec2(...GH);
      const Hc = mix(Gh.x, Gh.y, gd.y).mul(rnd.mul(0.5).add(0.75)).mul(R.flower ? 1.3 : 1).mul(mix(float(1), float(wood), smoothstep(0.85, 1, gd.z))).mul(mix(float(1), float(0.45), wr)).toVar();
      const U10 = length(this.uWind), wd = select(U10.greaterThan(0.01), this.uWind.div(U10), vec2(0.83, 0.55));
      const bL = base.sub(floor(this.uCam.xz.div(4096)).mul(4096));
      const gust = sin(dot(bL, wd).mul(1.571).sub(this.uGustPh).add(nz({ p: bL.div(7), s: int(205) }).mul(3))).mul(0.4).add(0.6).toVar();
      const eddy = nz({ p: bL.sub(this.uEddy).div(1.6), s: int(206) }).mul(0.5).add(0.5).toVar();
      const n = atomicAdd(this.cnt.element(R.i), uint(1)).toVar();
      If(n.lessThan(uint(R.cap)), () => {
        const o = int(n).mul(3);
        R.inst.element(o).assign(vec4(base, gd.x, Hc));
        R.inst.element(o.add(1)).assign(vec4(gd.y, gust, eddy, rnd));
        R.inst.element(o.add(2)).assign(vec4(fade, th, h01({ x: cx, y: cz, s: int(214) }), select(persist, float(1), float(0))));
      });
    })().compute(R.cap, [64]);
  }

  // a ring's blades (grass.js GRASS_BUILD's blade part), from its kept clumps
  _material(R) {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
    const I = storage(R.attr, 'vec4', R.cap * 3).toReadOnly(), o = int(instanceIndex).mul(3);
    const c0 = I.element(o), c1 = I.element(o.add(1)), c2 = I.element(o.add(2));
    const aT = attribute('aT', 'float'), aSide = attribute('aSide', 'float'), aB = attribute('aB', 'vec4'), aBi = attribute('aBi', 'float');
    const vT = varyingProperty('float', 'gvT'), vTint = varyingProperty('vec3', 'gvTint'), vFade = varyingProperty('float', 'gvFade'), vDith = varyingProperty('float', 'gvDith');
    const vRootK = varyingProperty('float', 'gvRootK'), vNor = varyingProperty('vec3', 'gvNor'), vPetal = varyingProperty('vec3', 'gvPetal');
    const GW = GRASS.bladeW;
    mat.positionNode = Fn(() => {
      const base = c0.xy, ground = c0.z, rnd = c1.w;
      const dist = length(base.sub(this.uCam.xz)), de = sqrt(dist.mul(dist).add(this.uAlt.mul(GRASS.altK).mul(this.uAlt.mul(GRASS.altK))));
      // a blade the next ring also has carries on unchanged; the rest dissolve with their clump
      const persistB = c2.w.greaterThan(0.5).and(aBi.lessThan(R.nextBlades));
      vFade.assign(select(persistB, float(1), c2.x.sub(c2.y.mul(0.85)).div(0.15).clamp(0, 1))); vDith.assign(c2.z);
      const H = c0.w.mul(aB.w.mul(0.9).add(0.55));
      const W = (R.flower ? float(0.006) : float(GW.root).mul(pow(max(float(1), de.div(GW.from)), GW.power))).mul(aB.w.mul(0.5).add(0.8));
      const ang = aB.x.add(rnd.mul(6.283)), fdir = vec2(cos(ang), sin(ang)), side = vec2(fdir.y.negate(), fdir.x);
      const off = aB.yz.mul(R.S0 * (R.flower ? 0.4 : 0.9)), t = aT;
      const lean = aB.w.mul(0.35).add(0.25).mul(H);
      // the wind at the blade's top (log law), gusts and eddies from the pass, one of eight ways of swaying
      const U10 = length(this.uWind), wd = select(U10.greaterThan(0.01), this.uWind.div(U10), vec2(0.83, 0.55)), wp = vec2(wd.y.negate(), wd.x);
      const z0 = this.uZ0, Uh = max(U10.mul(log(max(H, 1.5 * z0).div(z0))).div(Math.log(10 / z0)), 0.25);
      const wk = smoothstep(0.25, 2, Uh), gust = c1.y, eddy = c1.z;
      const mv = floor(fract(aB.w.mul(7.31).add(rnd.mul(3.7))).mul(8)), bph = mv.mul(2.39996), bk = mv.add(0.5).div(8);
      const stiff = bk.mul(0.7).add(0.65);
      const ug = Uh.mul(gust).mul(eddy.mul(0.4).add(0.8)).mul(stiff).div(1.5);
      const lay = min(0.85, ug.mul(ug).mul(0.35).add(0.05));
      const amp = mix(float(0.16), float(0.1), wk).mul(eddy.mul(0.5).add(0.75));
      const ph = this.uPh.element(int(mv));
      const sx = texture(this.tSway, vec2(ph.x.add(bph.div(6.2831853)), this.uSwayRow)).level(0).r.mul(2).sub(1);
      const sy = texture(this.tSway, vec2(ph.y.add(bph.mul(1.7).div(6.2831853)), this.uSwayRow)).level(0).g.mul(2).sub(1);
      const flutter = wp.mul(sx).add(wd.mul(sy).mul(0.5)).mul(amp);
      const bend = fdir.mul(lean).mul(t).mul(t).add(wd.mul(lay).add(flutter).mul(H).mul(t).mul(t)).toVar();
      const drop = dot(bend, bend).div(max(H, 1e-3)).mul(0.45);
      const bw = off.add(side.mul(aSide).mul(W).mul(float(1).sub(t.mul(0.85)))).add(bend);
      const xz = base.add(bw);
      const tangent = normalize(vec3(bend.x.mul(t).mul(2).add(1e-4), H, bend.y.mul(t).mul(2).add(1e-4)));
      const nor0 = normalize(cross(vec3(side.x, 0, side.y), tangent));
      const roundK = mix(float(0.45), float(0.92), smoothstep(2, 18, max(dist, this.uAlt.mul(2))));
      vNor.assign(normalize(mix(nor0.mul(dot(nor0, vec3(fdir.x, 0, fdir.y)).add(1e-3).sign()), vec3(0, 1, 0), roundK)));
      vT.assign(t);
      // colour: dark at the root, light and drier at the tip, by moisture; the roots darken up close only
      const root = vec3(0.08, 0.17, 0.03), tip = mix(vec3(0.44, 0.42, 0.13), vec3(0.2, 0.45, 0.06), smoothstep(0.25, 0.7, c1.x));
      vRootK.assign(float(1).sub(smoothstep(3, 16, max(dist, this.uAlt.mul(2)))));
      vTint.assign(mix(root, tip, mix(float(1), smoothstep(0, 0.8, t), vRootK)).mul(rnd.mul(0.4).add(0.8)).mul(this.uTint));
      if (R.flower) {
        const kf = floor(h01({ x: int(floor(base.x.div(9))), y: int(floor(base.y.div(9))), s: int(212) }).mul(5));
        vPetal.assign(select(kf.lessThan(1), vec3(0.9, 0.7, 0.05), select(kf.lessThan(2), vec3(0.85, 0.85, 0.8), select(kf.lessThan(3), vec3(0.45, 0.15, 0.6), select(kf.lessThan(4), vec3(0.8, 0.12, 0.08), vec3(0.18, 0.3, 0.8))))));
      } else vPetal.assign(vec3(-1));
      return vec3(xz.x, ground.add(t.mul(H)).sub(drop.mul(t)), xz.y);
    })();
    mat.normalNode = cameraViewMatrix.mul(vec4(vNor, 0)).xyz.normalize();
    // dissolving, never shrinking
    mat.maskNode = vFade.greaterThanEqual(1).or(fract(ign({ p: screenCoordinate.xy }).add(vDith)).lessThanEqual(vFade));
    mat.colorNode = Fn(() => {
      const c = select(vPetal.x.greaterThanEqual(0).and(vT.greaterThan(0.9)), vPetal, vTint);
      return vec4(c.mul(mix(float(1), vT.mul(0.3).add(0.7), vRootK)), 1); // the root sits in its neighbours' shade
    })();
    // matte and translucent: the sun on a blade's far side shines through, greener and warmer, more toward the tip
    mat.emissiveNode = Fn(() => {
      const V = normalize(positionWorld.sub(cameraPosition)), back = pow(clamp(dot(V, this.uSunDir), 0, 1), 3);
      const through = clamp(dot(vNor, this.uSunDir).negate(), 0, 1).mul(0.6).add(back);
      return this.uSunColor.mul(vTint).mul(vec3(0.85, 1.15, 0.5)).mul(through).mul(this.clouds ? this.clouds.shadowAt() : 1).mul(0.55 / Math.PI).mul(vT.mul(0.6).add(0.4)).mul(0.35);
    })();
    mat.roughnessNode = float(0.95); mat.metalnessNode = float(0);
    return mat;
  }

  // once a frame: the eye, the wind (m/s at 10 m), the sway's phases, the passes
  update(camera, ground, wind10, dt = 1 / 60) {
    const alt = Math.max(0.05, camera.position.y - ground);
    this.uCam.value.copy(camera.position); this.uAlt.value = alt;
    camera.updateMatrixWorld(); this.uVP.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); this.uPS.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
    const W = this.sway; dt = Math.min(Math.max(dt, 0), 0.25);
    if (!W.wind) W.wind = [wind10[0], wind10[1]];
    const k = 1 - Math.exp(-dt / 1.5); W.wind[0] += (wind10[0] - W.wind[0]) * k; W.wind[1] += (wind10[1] - W.wind[1]) * k;
    this.uWind.value.set(W.wind[0], W.wind[1]);
    const U10 = Math.hypot(W.wind[0], W.wind[1]), wd = U10 > 0.01 ? [W.wind[0] / U10, W.wind[1] / U10] : [0.83, 0.55];
    const GH = this.source.grassHeight || [0.1, 0.42], z0 = this.uZ0, Hm = Math.max(1.5 * z0, 0.75 * (GH[0] + GH[1]) / 2);
    const Uh = Math.max(U10 * Math.log(Hm / z0) / Math.log(10 / z0), 0.25), tt = Math.min(1, Math.max(0, (Uh - 0.25) / 1.75)), wk = tt * tt * (3 - 2 * tt);
    for (let m = 0; m < 8; m++) { const bk = (m + 0.5) / 8, rate = (1.7 + 1.4 * bk) * (1 + 0.5 * wk) / (Math.PI * 2); W.ph[m][0] = (W.ph[m][0] + dt * rate) % 1; W.ph[m][1] = (W.ph[m][1] + dt * rate * 0.71) % 1; this.uPh.array[m].set(W.ph[m][0], W.ph[m][1]); }
    W.gust = (W.gust + dt * 1.571 * (0.5 + 1.2 * Uh)) % (Math.PI * 2); this.uGustPh.value = W.gust;
    const de = dt * (0.3 + 0.9 * Uh); W.eddy[0] = (W.eddy[0] + wd[0] * de) % 4096; W.eddy[1] = (W.eddy[1] + wd[1] * de) % 4096; this.uEddy.value.set(W.eddy[0], W.eddy[1]);
    this.uSwayRow.value = (wk * (SWAY.levels - 1) + 0.5) / SWAY.levels;
    this.group.visible = alt < 30;
    if (this.group.visible) { for (const R of this.rings) this.renderer.compute(R.kernel); this.renderer.compute(this.kFinish); }
    const h = GRASS.altK * alt, far = this.far;
    this.reach = this.group.visible ? Math.sqrt(Math.max(0, far * far - h * h)) * (1 - Math.min(1, Math.max(0, (alt - 8) / 22))) : 0;
  }
  async counts() { const a = new Uint32Array(await this.renderer.getArrayBufferAsync(this.args)); return this.rings.map((R) => a[R.i * 5 + 1]); }
}
