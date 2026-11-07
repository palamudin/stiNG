// The run-up on WebGPU: the water's edge driven by the waves that actually arrive (the swell field's crests) on the
// tide's level (gpu/tide.js), replacing the old shoreline's own clock (water3/swash.js). At a point of the beach:
//   - where its waterline is: down the slope from the point by its height over the water now (tide included);
//   - the waves there: the swell field's train at the line (the crest's arrival: when its phase passes 0) and its
//     height a little offshore; each crest a little bigger or smaller (a seed from the crest's number: the sets);
//   - each wave's run-up from the beach's slope, the wave's height and its deep-water length (Stockdon et al. 2006,
//     held under 0.6 of the height), climbing and draining along a ballistic arc whose time is the beach's own
//     (sqrt(2 R / g) / slope: quick on a steep beach, slow on a flat one, held between 0.35 s and half a period); the
//     last three waves' arcs overlap (a bore runs up over the last one's backwash);
//   - the sheet over the point: the highest arc less the point's height; wet from when an arc rose past it to when it
//     fell back past it, draining from then (sand holds the water some seconds); white at the bore's tip climbing and
//     lace in its backwash.
// makeRunup(SW, TR, RC, uT, uSea) -> (p) -> vec4(the sheet's thickness over the ground (m, < 0 not covered), wetness
// 0..1, foam 0..1, the wave's clock 0..1 (under the climb's share: climbing))
import { Fn, float, vec2, vec4, max, min, sqrt, exp, smoothstep, floor, fract, select, mix, sin, dot } from 'three/tsl';

export const RUNUP = { drain: 7, set: 0.35 };

export function makeRunup(SW, TR, RC, uT, uSea) {
  const hash = (c) => fract(sin(c.mul(127.1).add(311.7)).mul(43758.5453));
  return (p) => {
    const g = RC.clipAtSmooth(p).x, lvS = RC.clipWater(p), isSea = select(lvS.lessThanEqual(uSea.add(0.5)), float(1), float(0));
    const lv = lvS.add(TR ? TR(p).x.mul(isSea) : 0), hp = g.sub(lv);
    const e = float(0.6);
    const grad = vec2(RC.clipAtSmooth(p.add(vec2(e, 0))).x.sub(RC.clipAtSmooth(p.sub(vec2(e, 0))).x), RC.clipAtSmooth(p.add(vec2(0, e))).x.sub(RC.clipAtSmooth(p.sub(vec2(0, e))).x)).div(e.mul(2));
    const gl = grad.length(), tb = gl.clamp(0.012, 0.6), down = select(gl.greaterThan(1e-4), grad.div(gl).negate(), vec2(0));
    // the waterline below this point, and a point a little offshore for the wave's height
    const q = p.add(down.mul(hp.max(0).div(tb).min(60))), qo = q.add(down.mul(14));
    const sq = SW.swell(q), so = SW.swell(qo), w = SW.omega.x, T = float(6.2832).div(w);
    const H0 = so.A0.y.mul(SW.amp.x).mul(2).mul(so.inside).max(0.02), L0 = T.mul(T).mul(9.81 / 6.2832);
    // the time since the last crest reached the line (the field's phase there passing 0), the crest's number
    const ph = sq.A0.x.sub(w.mul(uT)), u = ph.negate().div(6.2832), tc = fract(u).mul(T), cyc = floor(u);
    const HL = sqrt(H0.mul(L0));
    const R0 = min(HL.mul(tb).mul(0.35).add(sqrt(H0.mul(L0).mul(tb.mul(tb).mul(0.563).add(0.004))).mul(0.5)).mul(1.1), H0.mul(0.6)).mul(isSea).mul(sq.inside);
    const z = float(0).toVar(), wet = float(0).toVar(), foam = float(0).toVar();
    for (let j = 0; j < 3; j++) {
      const Rj = R0.mul(hash(cyc.sub(j)).sub(0.5).mul(2 * RUNUP.set).add(1)), tu = sqrt(Rj.mul(2 / 9.81)).div(tb).clamp(0.35, T.mul(0.5));
      const t = tc.add(T.mul(j)), x = t.div(tu).sub(1), arc = select(t.lessThan(tu.mul(2)), Rj.mul(float(1).sub(x.mul(x))), float(0));
      z.assign(max(z, arc));
      // wet from when this wave's arc rose past the point to when it fell back past it, draining from then
      const reach = Rj.greaterThan(hp), tOff = tu.mul(sqrt(float(1).sub(hp.max(0).div(max(Rj, 1e-3)).min(1))).add(1));
      wet.assign(max(wet, select(reach, select(t.lessThan(tOff), float(1), exp(t.sub(tOff).negate().div(RUNUP.drain))), float(0))));
      // the bore's tip white as it climbs, its lace draining back
      const tip = smoothstep(0.12, 0, arc.sub(hp)).mul(select(t.lessThan(tu), float(1), float(0.35))).mul(select(arc.greaterThan(hp), float(1), float(0)));
      foam.assign(max(foam, tip.mul(smoothstep(0.05, 0.3, Rj)).mul(j === 0 ? 1 : 0.6)));
    }
    wet.assign(select(hp.lessThan(0), float(1), wet));
    return vec4(z.sub(hp), wet, foam, fract(u));
  };
}
