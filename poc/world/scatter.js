// Where trees, bushes and boulders stand, per 64 m tile, as plain numbers (no three.js, so it runs in the tests).
// Deterministic: the same source and tile give the same list on every machine. items[kind][variant] is a flat list of
// 8 floats per object: x, z, turn, variety, horizontal scale, vertical scale, 0, 0.
//   wild world: candidates on a jittered 5.2 m grid, kept by the forest density (and a few in meadows), never in the
//     water, on trails or on cliffs; pines high up and on dry ground, birches on wet ground, oaks elsewhere; bushes
//     where the forest thins; boulders on a 6.5 m grid, most on steep ground and at the shore.
//   game's world: the sim's own trees, one for one, at their own sizes.
import { hash01, vnoise, smoothstep } from './noise.js';

export function placeTile(src, ti, tj, kinds, cfg, design) {
  const T = cfg.tile, items = kinds.map(() => Array.from({ length: cfg.variants }, () => []));
  // the 7th float: 1 when the game draws the trunk itself (the sim's solid cylinder), so the mesh leaves it out
  const push = (k, x, z, rot, vr, sxz, sy, noTrunk = 0) => { const v = Math.floor(hash01(Math.floor(x * 7), Math.floor(z * 7), 11) * cfg.variants); items[k][v].push(x, z, rot, vr, sxz, sy, noTrunk, 0); };
  // the game's world: the sim's own trees, one for one, in the tiles the settled area covers (all of them, or those
  // within wildFrom in a composite source); the wild rule plants the rest
  const T0 = cfg.tile, settled = src.objects && (!src.wildFrom || Math.hypot((ti + 0.5) * T0, (tj + 0.5) * T0) < src.wildFrom + T0);
  if (settled) {
    const cx = ti, cz = tj; // tiles are chunks here
    const c = src.objects(cx, cz);
    for (const t of c.trees) {
      const k = t.shade < 0.28 ? 1 : 0, d = k ? design.birch : design.oak;
      const rot = hash01(Math.floor(t.x * 10), Math.floor(t.z * 10), 3) * 6.283;
      // the sim's trunk height h is the design's crown height, its crown radius cr the design's (GDD 20.4 point 2)
      push(k, t.x, t.z, rot, t.shade, t.cr / Math.max(0.5, d.crownR), t.h / Math.max(1, d.crownY), src.trunks === false ? 1 : 0);
    }
    if (!src.wildFrom) return items;
  }
  const G = cfg.grid, o = [0, 0, 0, 0, 0], x0 = ti * T, z0 = tj * T;
  for (let gz = 0; gz < T / G; gz++) for (let gx = 0; gx < T / G; gx++) {
    const ix = Math.floor(x0 / G) + gx, iz = Math.floor(z0 / G) + gz;
    const x = (ix + 0.15 + 0.7 * hash01(ix, iz, 21)) * G, z = (iz + 0.15 + 0.7 * hash01(ix, iz, 22)) * G;
    if (src.wildFrom && Math.hypot(x, z) < src.wildFrom) continue; // the settled area has its own trees
    src.sample(x, z, o);
    const h = o[0], f = o[2], wet = o[1], trail = o[3];
    if (h < (o[4] ?? src.sea) + 0.7 || trail > 0.25) continue; // o[4]: the water level here (W3)
    const p = f * 0.88 + cfg.meadow;
    const r = hash01(ix, iz, 23);
    if (r > p) {
      // understory and edges: bushes where the forest thins out
      if (r < p + 0.22 * Math.min(1, f * 3) * (1 - f) + 0.004) push(3, x, z, hash01(ix, iz, 24) * 6.283, hash01(ix, iz, 25), 0.8 + 0.6 * hash01(ix, iz, 26), 0.8 + 0.5 * hash01(ix, iz, 27));
      continue;
    }
    const slope = Math.abs(src.height(x + 1.5, z) - h) / 1.5 + Math.abs(src.height(x, z + 1.5) - h) / 1.5;
    if (slope > 0.9) continue;
    const alt = h - src.sea;
    let k = 0;
    if (alt > 120 + 40 * vnoise(x / 300, z / 300, 31) || (wet < 0.38 && f > 0.4)) k = 2;
    else if (wet > 0.62 && hash01(ix, iz, 28) < 0.45) k = 1;
    const s = 0.82 + 0.45 * hash01(ix, iz, 29);
    push(k, x, z, hash01(ix, iz, 24) * 6.283, hash01(ix, iz, 25), s * (0.9 + 0.2 * hash01(ix, iz, 30)), s);
  }
  // boulders: on steep ground, at the shore, a few on the forest floor and in meadows
  const RG = 6.5, rk = kinds.indexOf('rock');
  if (rk >= 0) for (let gz = 0; gz < T / RG; gz++) for (let gx = 0; gx < T / RG; gx++) {
    const ix = Math.floor(x0 / RG) + gx, iz = Math.floor(z0 / RG) + gz;
    const x = (ix + 0.1 + 0.8 * hash01(ix, iz, 41)) * RG, z = (iz + 0.1 + 0.8 * hash01(ix, iz, 42)) * RG;
    const r = hash01(ix, iz, 43);
    if (r > 0.3) continue; // most cells are skipped before sampling
    src.sample(x, z, o);
    const h = o[0], alt = h - (o[4] ?? src.sea);
    if (alt < -0.3 || o[3] > 0.3) continue;
    const slope = Math.abs(src.height(x + 1, z) - h) + Math.abs(src.height(x, z + 1) - h);
    const p = 0.3 * smoothstep(0.25, 0.7, slope) + 0.08 * (1 - smoothstep(0.3, 2.5, Math.abs(alt - 0.8))) + 0.025 * o[2] + 0.006;
    if (r > p) continue;
    const s = (0.5 + 1.6 * Math.pow(hash01(ix, iz, 44), 2)) * (1 + smoothstep(0.3, 0.8, slope));
    push(rk, x, z, hash01(ix, iz, 45) * 6.283, hash01(ix, iz, 46), s, s * (0.8 + 0.4 * hash01(ix, iz, 47)));
  }
  return items;
}
