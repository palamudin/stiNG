// Caustics on WebGPU (caustics.js, W3.1, ported): the sun refracted by the waves and splatted where it lands, over one
// tile of a wave cascade (Wallace 2011's area-ratio splat, as Ultra-Water and jeantimex/webgpu-water do it). The cascade
// is periodic, so the pattern computed over one tile repeats over the whole sea: nothing follows the camera. A grid
// over the tile (plus a margin past each edge for light that lands across it) is refracted through the cascade's
// slopes (a cubic B-spline of them: the brightness goes with the slope's derivative, which bilinear filtering makes
// piecewise constant: the blocks) onto flat floors at three depths, one per channel; every landed triangle adds the
// ratio of its area on flat water to its landed area, times the surface's transmission against flat water's. The mean
// over the tile is 1: the pattern only redistributes the direct sun. The target is mipmapped and repeats; a reader looks
// it up where its sunlight entered the surface, at the mip for its own footprint (far views blur to an even light), the
// depth picking and blending the slices. The result is a factor on the sun's light, for a lit material's received shadow.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, texture, attribute, positionWorld, cameraPosition, varyingProperty, dFdx, dFdy, length, max, min, abs, sqrt, floor, smoothstep, mix, refract, normalize, dot, log2, select, exp } from 'three/tsl';

export const CAUSTIC = { res: 512, near: 8, depths: [0.5, 1.5, 4.0], margin: 0.12, maxRatio: 16, n: 1.333 };

export class GpuCaustics {
  // clip: gpu/clip.js, waves: gpu/waves.js, sunDir: a vec3 uniform (toward the sun)
  constructor(clip, waves, sunDir, renderer) {
    this.clip = clip; this.waves = waves; this.uSun = sunDir; this.renderer = renderer;
    this.uOn = uniform(1); this.uStrength = uniform(1); this.uLit = uniform(1); this.uSig = uniform(new THREE.Vector3(0.45, 0.075, 0.035)); // the water's extinction per metre (demo.js keeps it the water's)
    const C = CAUSTIC, res = C.res, Ls = waves.cascades, N = waves.N, m = C.margin, n = C.n;
    let ci = 0; for (let c = 1; c < Ls.length; c++) if (Math.abs(Math.log(Ls[c] / C.near)) < Math.abs(Math.log(Ls[ci] / C.near))) ci = c;
    const L = this.L = Ls[ci], tS = waves.slope[ci];
    this.rt = new THREE.RenderTarget(res, res, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
    this.rt.texture.wrapS = this.rt.texture.wrapT = THREE.RepeatWrapping; this.rt.texture.generateMipmaps = true; this.rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
    const fres = (ci_) => { const st2 = float(1).sub(ci_.mul(ci_)).div(n * n), ct = sqrt(max(float(1).sub(st2), 0)); const rs = ci_.sub(ct.mul(n)).div(ci_.add(ct.mul(n))), rp = ci_.mul(n).sub(ct).div(ci_.mul(n).add(ct)); return rs.mul(rs).add(rp.mul(rp)).mul(0.5); };
    this.scene = new THREE.Scene(); this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); // (unused by the splat: its vertices are placed in clip space)
    C.depths.forEach((depth, k) => {
      const cells = Math.max(32, Math.round(N * (k === 0 ? 1 : k === 1 ? 0.75 : 0.5))), lod = Math.max(0, Math.log2(N / cells)), size = N / 2 ** Math.round(lod);
      // the slope by a cubic B-spline from four bilinear taps
      const slopeB = (uv) => {
        const st = uv.mul(size).sub(0.5), i = floor(st), f = st.sub(i), f2 = f.mul(f), f3 = f2.mul(f);
        const w0 = float(1).sub(f.mul(3)).add(f2.mul(3)).sub(f3).div(6), w1 = float(4).sub(f2.mul(6)).add(f3.mul(3)).div(6), w2 = float(1).add(f.mul(3)).add(f2.mul(3)).sub(f3.mul(3)).div(6), w3 = f3.div(6);
        const g0 = w0.add(w1), g1 = w2.add(w3), h0 = i.sub(0.5).add(w1.div(g0)).div(size), h1 = i.add(1.5).add(w3.div(g1)).div(size);
        const t = (u) => texture(tS, u).level(Math.round(lod)).xy;
        return t(h0).mul(g0.x).add(t(vec2(h1.x, h0.y)).mul(g1.x)).mul(g0.y).add(t(vec2(h0.x, h1.y)).mul(g0.x).add(t(h1).mul(g1.x)).mul(g1.y));
      };
      const vOld = varyingProperty('vec2', 'cOld' + k), vNew = varyingProperty('vec2', 'cNew' + k), vT = varyingProperty('float', 'cT' + k);
      const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      mat.blending = THREE.CustomBlending; mat.blendEquation = THREE.AddEquation; mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneFactor; mat.blendSrcAlpha = THREE.OneFactor; mat.blendDstAlpha = THREE.OneFactor;
      mat.vertexNode = Fn(() => {
        const u = attribute('position', 'vec3').xy.add(0.5).mul(1 + 2 * m).sub(m); // tile units, the margin past each edge
        const s = slopeB(u), Ld = this.uSun.negate(), nrm = normalize(vec3(s.x.negate(), 1, s.y.negate()));
        const r = refract(Ld, nrm, 1 / n), r0 = refract(Ld, vec3(0, 1, 0), 1 / n);
        const off = r.xz.div(r.y.negate()).sub(r0.xz.div(r0.y.negate())).mul(depth);
        const o = u.mul(L);
        vOld.assign(o); vNew.assign(o.add(off));
        vT.assign(float(1).sub(fres(max(dot(Ld.negate(), nrm), 0))).div(float(1).sub(fres(max(this.uSun.y, 0.01)))));
        const q = o.add(off).div(L).mul(2).sub(1);
        return vec4(q.x, q.y.negate(), 0, 1); // (clip y up is the texture's first row: read back at v = z / L)
      })();
      mat.colorNode = Fn(() => {
        const ox = dFdx(vOld), oy = dFdy(vOld), nx = dFdx(vNew), ny = dFdy(vNew);
        const a0 = abs(ox.x.mul(oy.y).sub(ox.y.mul(oy.x))), a1 = abs(nx.x.mul(ny.y).sub(nx.y.mul(ny.x)));
        const r = min(a0.div(max(a1, 1e-12)), C.maxRatio).mul(vT);
        return vec4(k === 0 ? r : 0, k === 1 ? r : 0, k === 2 ? r : 0, 1);
      })();
      const span = Math.round(cells * (1 + 2 * m));
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, span, span), mat); mesh.frustumCulled = false;
      this.scene.add(mesh);
    });
    this._cc = new THREE.Color();
  }
  // once a frame after the waves: the pattern for this sun (flat when it is down)
  update(sunDir, on = true) {
    const lit = on && sunDir.y > 0.02; this.uLit.value = lit ? 1 : 0;
    if (!lit) return;
    const r = this.renderer, prev = r.getRenderTarget(), ca = r.getClearAlpha(); r.getClearColor(this._cc);
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 1); r.clear(true, false, false);
    r.render(this.scene, this.cam);
    r.setClearColor(this._cc, ca); r.setRenderTarget(prev);
  }
  // the factor at a world point (a node, for a fragment stage): the floor point under depth D, looked up where its
  // sunlight entered the surface, at the mip for its footprint
  at(p = positionWorld) {
    const R = this._R || (this._R = this.clip.reads('CA')), C = CAUSTIC, L = this.L, res = C.res;
    return Fn(() => {
      // the water over the floor now: the still level and, on the sea, the tide's (gpu/tide.js): ground the ebb has bared
      // has no water over it and no caustics
      const lv = R.clipWater(p.xz), TR = this.tide ? (this._TR || (this._TR = this.tide.reader())) : null;
      const D = lv.add(TR ? TR(p.xz).x.mul(select(lv.lessThanEqual((this.clip.sea ?? 0) + 0.5), float(1), float(0))) : 0).sub(p.y).max(0).toVar();
      const rs = refract(this.uSun.negate(), vec3(0, 1, 0), 1 / C.n);
      const entry = p.xz.add(rs.xz.div(rs.y).mul(D));
      const fp = length(cameraPosition.sub(p)).mul(0.0018);
      const lod = log2(max(fp.mul(res / L), 1));
      const c = min(texture(this.rt.texture, entry.div(L)).level(lod).rgb, vec3(64));
      const [d0, d1, d2] = C.depths;
      const cd = select(D.lessThan(d0), mix(float(1), c.r, smoothstep(0, d0, D)),
        select(D.lessThan(d1), mix(c.r, c.g, D.sub(d0).div(d1 - d0)),
          select(D.lessThan(d2), mix(c.g, c.b, D.sub(d1).div(d2 - d1)), mix(c.b, float(1), smoothstep(d2, 3 * d2, D)))));
      const k = this.uOn.mul(this.uLit).mul(select(D.greaterThan(0.0005), float(1), float(0)));
      // and the sunlight's own way down through the water (it reaches the floor dimmer and bluer with the depth; the view's
      // way up is the water's and the fog's)
      return R.bind(vec3(mix(float(1), mix(float(1), max(cd, 0), this.uStrength), k)).mul(exp(this.uSig.mul(D).negate())));
    })();
  }
}
