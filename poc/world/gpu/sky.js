// The sky on WebGPU (sky.js, Hillaire 2020's sky-view table): single scattering by air, haze and ozone over a spherical
// planet plus the multiple-scattering table, the same model and units. The air's helpers are sky.js's GLSL converted
// (gen-wgsl.mjs); the march along a view ray is TSL here, since it reads the multiple-scattering table in its loop.
//   - the multiple-scattering table (32 x 32), rebuilt when the haze changes;
//   - the sky-view table (192 x 108), rebuilt when the sun's height, the haze or the eye's altitude has moved enough;
//   - the CPU twin: the sun's colour after the air (sky.js transmittanceJS) and the sky's light on level ground and on
//     walls, read back from the table once per key and kept in a day table (sky.js Sky._cpu);
//   - the background (the table by direction, the sun's disc with its limb darkening) and the aerial perspective (the
//     air's transmittance and in-scattering along the segment to each pixel, post.js airT) as the scene's fog node.
import * as THREE from 'three/webgpu';
import { Fn, Loop, float, int, vec2, vec3, vec4, uniform, texture, screenUV, positionWorld, positionWorldDirection, cameraPosition, wgslFn, wgsl, output, exp, pow, max, min, clamp, smoothstep, acos, sqrt, length, normalize, dot, mix, select, abs } from 'three/tsl';
import { ATMO, transmittanceJS } from '../sky.js';
import { SKY_WGSL } from './sky.wgsl.js';

const code = wgsl(SKY_WGSL);
const fMS = wgslFn('fn sMS(uv: vec2<f32>, haze: f32) -> vec4<f32> { return skyMS(uv, haze); }', [code]);
const fAir = wgslFn('fn sAir(h: f32, haze: f32) -> mat3x3<f32> { return skyAir(h, haze); }', [code]);
const fTr = wgslFn('fn sTr(r: f32, mu: f32, haze: f32) -> vec3<f32> { return skyTrans(r, mu, haze); }', [code]);
const fTop = wgslFn('fn sTop(r: f32, mu: f32) -> f32 { return aTop(r, mu); }', [code]);
const fGround = wgslFn('fn sGround(r: f32, mu: f32) -> f32 { return aGround(r, mu); }', [code]);
const fPR = wgslFn('fn sPR(c: f32) -> f32 { return aPhaseR(c); }', [code]);
const fPM = wgslFn('fn sPM(c: f32) -> f32 { return aPhaseM(c); }', [code]);
const fUV = wgslFn('fn sUV(v: vec3<f32>, s: vec3<f32>) -> vec2<f32> { return skyUV(v, s); }', [code]);
const fDir = wgslFn('fn sDir(uv: vec2<f32>, s: vec3<f32>) -> vec3<f32> { return skyDir(uv, s); }', [code]);
const A = ATMO;

export class GpuSky {
  constructor(renderer) {
    this.renderer = renderer;
    const rt = (w, h) => { const t = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false }); t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter; return t; };
    this.msRT = rt(32, 32); this.rt = rt(192, 108); this.rt.texture.wrapS = THREE.RepeatWrapping;
    this.uSun = uniform(new THREE.Vector3(0.4, 0.6, 0.3).normalize()); this.uHaze = uniform(1); this.uCamH = uniform(2);
    this.uSunColor = uniform(new THREE.Color()); this.uSkyUp = uniform(new THREE.Color()); this.uSkyHz = uniform(new THREE.Color());
    this.uMist = uniform(0); this.uMistH = uniform(40); this.uSea = uniform(0);
    const msMat = new THREE.MeshBasicNodeMaterial(); msMat.outputNode = fMS({ uv: screenUV, haze: this.uHaze });
    this.msQuad = new THREE.QuadMesh(msMat);
    // the sky-view table: each texel's direction marched to the top of the air (sky.js aScatter)
    const viewMat = new THREE.MeshBasicNodeMaterial();
    viewMat.outputNode = Fn(() => {
      const s = this.uSun, v = fDir({ uv: screenUV, s }).toVar(), haze = this.uHaze;
      const r = float(A.Rg).add(max(this.uCamH, 1)), mu = v.y;
      const tg = fGround({ r, mu }), L = select(tg.greaterThan(0), tg, fTop({ r, mu })).toVar();
      const c = dot(v, s), pr = fPR({ c }), pm = fPM({ c });
      const sum = vec3(0).toVar(), od = vec3(0).toVar(), t0 = float(0).toVar();
      Loop(24, ({ i }) => {
        const t1 = L.mul(pow(float(i).add(1).div(24), 2)).toVar(), t = t0.add(t1).mul(0.5).toVar(), dt = t1.sub(t0).toVar(); t0.assign(t1); // (variables before t0 moves on: TSL emits an expression where it is used)
        const p = vec3(0, r, 0).add(v.mul(t)), rr = length(p);
        const air = fAir({ h: rr.sub(A.Rg), haze }).toVar(), ex = air.element(0), sR = air.element(1), sM = air.element(2).x;
        od.addAssign(ex.mul(dt));
        const mus = dot(p.div(rr), s), Ts = fTr({ r: rr, mu: mus, haze });
        const ms = texture(this.msRT.texture, vec2(mus.mul(0.5).add(0.5), clamp(rr.sub(A.Rg).div(A.Rt - A.Rg), 0, 1))).level(0).rgb;
        sum.addAssign(exp(od.negate()).mul(Ts.mul(sR.mul(pr).add(vec3(sM.mul(pm)))).add(ms.mul(sR.add(vec3(sM))))).mul(dt));
      });
      return vec4(sum.mul(A.sunE), 1);
    })();
    this.viewQuad = new THREE.QuadMesh(viewMat);
    this.skyAt = (v) => texture(this.rt.texture, fUV({ v, s: this.uSun })).rgb;
    this._key = ''; this._msHaze = -1; this._day = new Map();
    this.sunColor = new THREE.Color(); this.skyUp = new THREE.Color(); this.skyHorizon = new THREE.Color();
  }
  // the background: the table by direction and the sun's disc (post.js sunDisc)
  background() {
    return Fn(() => {
      const v = positionWorldDirection, cs = dot(v, this.uSun), r = 0.5 * A.sunAngle, a = acos(clamp(cs, -1, 1));
      const mu2 = sqrt(max(float(1).sub(a.div(r).mul(a.div(r))), 0)), limb = float(1).sub(float(1).sub(pow(mu2, 0.5)).mul(0.6));
      const disc = this.uSunColor.mul(limb).mul(smoothstep(r * 1.05, r * 0.95, a)).div(Math.PI * r * r).mul(0.6);
      return this.skyAt(v).add(disc);
    })();
  }
  // the aerial perspective (post.js airT): the analytic optical depth of exponential air and the mist along the segment
  fog() {
    return Fn(() => {
      const d = length(positionWorld.sub(cameraPosition)), v = normalize(positionWorld.sub(cameraPosition)), vy = v.y;
      const h0 = max(cameraPosition.y, 0), flat = abs(vy).lessThan(1e-4);
      const odOf = (H, hb) => select(flat, exp(hb.div(H).negate()).mul(d), float(H).div(vy).mul(exp(hb.div(H).negate()).sub(exp(hb.add(d.mul(vy)).div(H).negate()))));
      const odR = odOf(A.rayleighH, h0), odM = odOf(A.mieH, h0);
      const hm0 = max(cameraPosition.y.sub(this.uSea), 0);
      const odF = select(flat, exp(hm0.div(this.uMistH).negate()).mul(d), this.uMistH.div(vy).mul(exp(hm0.div(this.uMistH).negate()).sub(exp(hm0.add(d.mul(vy)).div(this.uMistH).negate()))));
      const od = vec3(...A.rayleigh).mul(odR).add(vec3(odM.mul(A.mieExt).mul(this.uHaze))).add(vec3(this.uMist.mul(odF)));
      const T = exp(od.negate());
      const vh = normalize(vec3(v.x, max(vy, 0.035), v.z)), c = dot(v, this.uSun);
      const mistLight = this.uSkyHz.mul(0.9).add(this.uSunColor.mul(fPM({ c })).mul(1.6));
      const fm = this.uMist.mul(odF).div(max(od.g, 1e-6));
      const ins = float(1).sub(T).mul(mix(this.skyAt(vh), mistLight, clamp(fm, 0, 1)));
      return vec4(output.rgb.mul(T).add(ins), output.a);
    })();
  }
  // the tables, rebuilt when the sun's height, the haze or the eye's altitude has moved enough; the light eases from
  // step to step
  update(sunDir, camH, haze) {
    this.uSun.value.copy(sunDir); this.uHaze.value = haze; this.uCamH.value = Math.max(1, camH);
    const key = `${sunDir.y.toFixed(3)},${haze.toFixed(2)},${Math.round(Math.log2(Math.max(1, camH)) * 4)}`, r = this.renderer;
    if (key !== this._key) {
      this._key = key;
      const prev = r.getRenderTarget();
      if (this._msHaze !== haze) { this._msHaze = haze; r.setRenderTarget(this.msRT); this.msQuad.render(r); }
      r.setRenderTarget(this.rt); this.viewQuad.render(r); r.setRenderTarget(prev);
      const got = this._day.get(key);
      if (got) this._to = got; else if (!this._busy) this._read(key, sunDir.clone(), camH, haze);
    }
    if (this._to) {
      if (!this._cur) this._cur = { sun: this._to.sun.clone(), up: this._to.up.clone(), hz: this._to.hz.clone() };
      const C = this._cur, T = this._to, k = 0.12;
      C.sun.lerp(T.sun, k); C.up.lerp(T.up, k); C.hz.lerp(T.hz, k);
      this.sunColor.copy(C.sun); this.skyUp.copy(C.up); this.skyHorizon.copy(C.hz);
      this.uSunColor.value.copy(this.sunColor); this.uSkyUp.value.copy(this.skyUp); this.uSkyHz.value.copy(this.skyHorizon);
    }
  }
  // the sun's colour from the transmittance toward it; the sky's light on level ground and on walls from the table
  async _read(key, s, camH, haze) {
    this._busy = true;
    const T = transmittanceJS(camH, s.y, haze), k = THREE.MathUtils.smoothstep(s.y, -0.012, 0.012);
    const sun = new THREE.Color(T[0] * A.sunE * k, T[1] * A.sunE * k, T[2] * A.sunE * k);
    const W = 192, H = 108, raw = await this.renderer.readRenderTargetPixelsAsync(this.rt, 0, 0, W, H), f = THREE.DataUtils.fromHalfFloat;
    const up = [0, 0, 0], hz = [0, 0, 0]; let wh = 0;
    // the table was drawn by screen position (row j from the top holds v = (j + 0.5) / H, 1 the zenith) and reads back
    // top row first: the upper half is the sky over level ground
    for (let j = 0; j < H; j++) {
      const vv = (j + 0.5) / H; if (vv < 0.5) continue;
      const x = vv * 2 - 1, el = x * x * 1.5707963, del = 2 * Math.abs(x) * 1.5707963 * (2 / H);
      const dOmega = Math.cos(el) * del * (6.2831853 / W), cu = Math.sin(el) * dOmega, ch = Math.cos(el) * dOmega;
      for (let i = 0; i < W; i++) { const o = (j * W + i) * 4; for (let c = 0; c < 3; c++) { const L = f(raw[o + c]); up[c] += L * cu; hz[c] += L * ch; } }
      wh += ch * W;
    }
    const got = { sun, up: new THREE.Color(up[0], up[1], up[2]), hz: new THREE.Color(hz[0] / wh, hz[1] / wh, hz[2] / wh) };
    if (this._day.size > 8192) this._day.clear();
    this._day.set(key, got); this._to = got; this._busy = false;
  }
}
