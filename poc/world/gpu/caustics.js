// Caustics on WebGPU: the sun's light on the bed under water, gathered and spread by the waves over it. The surface is
// a lens: a ray through a surface point of slope s bends by (1 - 1/n) s, so on a bed d under it the light lands moved by
// d (1 - 1/n) s and the patch it lights is stretched by det(I + d (1 - 1/n) H), H the surface's curvature; the light
// there is 1 / |det| (more under the crests that focus it, less under the troughs). The curvature is the divergence of
// the two finest cascades' slope tables (12 m and 2.1 m), each over a 32nd of its tile (cells a hand to a
// metre across, the finer ripples' grain left out) and faded where a pixel grows past that, read where the sun's ray
// to this point left the surface. Its contrast grows over the first metres of depth and fades again deeper (the many
// waves over a deep point blur it), with a touch of dispersion (red and blue focus a little apart). The result is a
// factor on the sun's light (1 where there is no water), for a lit material's received shadow.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, uniform, texture, positionWorld, cameraPosition, length, max, abs, sqrt, smoothstep, mix, exp, clamp } from 'three/tsl';

export const CAUSTIC = { k: 1 - 1 / 1.333, strength: 1, deep: 14 };

export class GpuCaustics {
  // clip: gpu/clip.js, waves: gpu/waves.js, sunDir: a vec3 uniform (toward the sun)
  constructor(clip, waves, sunDir) {
    this.clip = clip; this.waves = waves; this.uSun = sunDir;
    this.uOn = uniform(1); this.uStrength = uniform(CAUSTIC.strength); this.uDeep = uniform(CAUSTIC.deep);
  }
  // the factor at a world point (a node, for a fragment stage)
  at(p = positionWorld) {
    const R = this._R || (this._R = this.clip.reads('CA')), W = this.waves, N = W.N, C = W.cascades.length;
    return Fn(() => {
      const xz = p.xz, level = R.clipWater(xz), d = level.sub(p.y).max(0).toVar();
      const out = vec3(1).toVar();
      const S = this.uSun, sy = max(S.y, 0.05);
      // where the sun's refracted ray to this point crossed the surface
      const q = xz.add(S.xz.div(1.333).div(sqrt(float(1).sub(S.xz.dot(S.xz).div(1.777))).max(0.3)).mul(d)).toVar();
      const div = float(0).toVar();
      // each cascade's curvature over a span of a 32nd of its tile (the ripples finer than that only add grain), and
      // only while a pixel is finer than that span (past it, the curvature would alias into sparkle)
      const fp = length(cameraPosition.sub(p)).mul(0.0018).toVar(); // a pixel's footprint (m), about
      for (const c of [C - 2, C - 1]) {
        const L = W.cascades[c], e = L / 32;
        const t = (o) => texture(W.slope[c], q.add(o).div(L)).level(0);
        div.addAssign(t(vec2(e, 0)).x.sub(t(vec2(-e, 0)).x).add(t(vec2(0, e)).y.sub(t(vec2(0, -e)).y)).div(2 * e).mul(smoothstep(e * 1.5, e * 0.4, fp)));
      }
      // contrast: rising over the first metres, fading with depth; none at night or with the switch off
      const k = smoothstep(0.02, 0.6, d).mul(exp(d.div(this.uDeep).negate())).mul(smoothstep(0.02, 0.2, sy)).mul(this.uOn).mul(this.uStrength);
      const lens = d.mul(CAUSTIC.k);
      const I = (s) => float(1).div(max(abs(float(1).add(lens.mul(s).mul(div))), 0.15)).min(5);
      out.assign(mix(vec3(1), vec3(I(1.03), I(1), I(0.97)), k));
      return R.bind(out);
    })();
  }
}
