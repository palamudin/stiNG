// The STING source: the world v2 renderer drawing the game's own world. Heights are the sim's groundAt, land use and
// paving are the sim's, and trees are the sim's own trees (the ones wasps collide with, land on and nest in), so what
// is drawn is what is played. Nothing here writes to the sim. No GLSL twin: the sim's height (with its grading under
// streets and buildings) is the authority, so terrain tiles are filled on the CPU, a strip at a time (clipmap.js).
//
// sample(x, z) -> [height, moisture, forest, paving]: paving is 1 on streets, lots and squares (no grass, asphalt or
// stone), 0.5 on sidewalks and building pads.
import { groundAt, landUse, pavingOf, chunkOf, chunkKey, generateChunk, T } from '../../sim/index.js';

const MOIST = { park: 0.62, yards: 0.72, forest: 0.8, mall: 0.3, town: 0.42 };
const FOREST = { park: 0.12, yards: 0.08, forest: 1, mall: 0, town: 0 };

export function stingSource(sim) {
  const seed = sim.seed, settings = sim.settings, CS = T.chunk.size;
  const useCache = new Map(), paveCache = new Map(), objCache = new Map();
  const useOf = (cx, cz) => {
    const k = chunkKey(cx, cz);
    let u = useCache.get(k);
    if (u === undefined) { if (useCache.size > 8192) useCache.clear(); u = landUse(seed, cx, cz, settings); useCache.set(k, u); }
    return u;
  };
  const paveOf = (cx, cz) => {
    const k = chunkKey(cx, cz);
    let p = paveCache.get(k);
    if (!p) { if (paveCache.size > 4096) paveCache.clear(); p = pavingOf(seed, cx, cz, settings); paveCache.set(k, p); }
    return p;
  };
  const walk = T.terrain.grade.walk;
  function paving(x, z) {
    const p = paveOf(chunkOf(x), chunkOf(z));
    let v = 0;
    for (const r of p.roads) {
      if (x >= r.minx && x <= r.maxx && z >= r.minz && z <= r.maxz) return 1;
      if (x >= r.minx && x <= r.maxx && z >= r.minz - walk && z <= r.maxz + walk) v = 0.5;
    }
    for (const l of p.loops) { const d = Math.hypot(x - l.x, z - l.z); if (d <= l.r) return 1; if (d <= l.r + walk) v = 0.5; }
    for (const l of p.lots) if (x >= l.minx && x <= l.maxx && z >= l.minz && z <= l.maxz) return 1;
    for (const l of p.plazas) if (x >= l.minx && x <= l.maxx && z >= l.minz && z <= l.maxz) return 0.9;
    for (const b of [...p.houses, ...p.shops, ...p.malls]) if (Math.abs(x - b.x) <= b.hw + 0.3 && Math.abs(z - b.z) <= b.hd + 0.3) v = Math.max(v, 0.5);
    return v;
  }
  // blend moisture and forest between chunk centres, as the sim blends its ground roll
  function landBlend(x, z, table) {
    const u = x / CS, v = z / CS, i = Math.floor(u), j = Math.floor(v), tu = u - i, tv = v - j;
    const s = (t) => t * t * (3 - 2 * t), a = table[useOf(i, j)] ?? 0.5, b = table[useOf(i + 1, j)] ?? 0.5, c = table[useOf(i, j + 1)] ?? 0.5, d = table[useOf(i + 1, j + 1)] ?? 0.5;
    const su = s(tu), sv = s(tv);
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  }
  function sample(x, z, out = [0, 0, 0, 0]) {
    out[0] = groundAt(seed, x, z, settings);
    out[1] = landBlend(x, z, MOIST);
    out[2] = landBlend(x, z, FOREST);
    out[3] = paving(x, z);
    return out;
  }
  // The sim's own chunk content: a discovered record if the sim has one, else generated here (same seed, same content)
  function objects(cx, cz) {
    const k = chunkKey(cx, cz);
    const rec = sim.records && sim.records.get(k);
    if (rec) return rec.content;
    let c = objCache.get(k);
    if (!c) { if (objCache.size > 256) objCache.clear(); c = generateChunk(seed, cx, cz, settings); objCache.set(k, c); }
    return c;
  }
  return {
    kind: 'sting',
    params: { seed: Number(seed & 0xffffn), settings },
    sea: -1e6,                   // no open water in the sim's world; birdbaths and puddles stay the game's
    sample,
    height: (x, z) => groundAt(seed, x, z, settings),
    glsl: null,                  // CPU fill
    uniforms: {},
    chunkSize: CS,
    objects,                     // trees come from here, not from the scatter's density
    trunks: false,               // the game draws the trunks: they are the sim's solid cylinders, which wasps land and nest on
    trailIsPaving: true,
    grassHeight: [0.035, 0.075], // mown park lawns and yards: a few centimetres, dry to watered
  };
}
