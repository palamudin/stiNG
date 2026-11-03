// The STING source: the world v2 renderer drawing the game's own world. Heights are the sim's groundAt, land use and
// paving are the sim's, and trees are the sim's own trees (the ones wasps collide with, land on and nest in), so what
// is drawn is what is played. Nothing here writes to the sim. No GLSL twin: the sim's height (with its grading under
// streets and buildings) is the authority, so terrain tiles are filled on the CPU, a strip at a time (clipmap.js).
//
// sample(x, z) -> [height, moisture, forest, paving]:
//   - paving is 1 on streets, lots and squares (no grass, asphalt or stone), 0.9 on squares, 0.5 on sidewalks, building
//     pads and the walk from a house's door to its street; below 0.3 it is wear (0.2 for fully trodden, grass.js w2wear):
//     the ground people use, where a lawn is short and the earth shows through in patches;
//   - forest is the land use's, raised under each tree's crown (shade: thinner grass, a floor of earth and leaves).
// Where people are comes from the chunk itself: picnic tables and their seats, the spots where people stand about,
// door steps, flower beds (bare earth round each plant), the foot of every trunk, and hives. Each land use also has a
// little wear of its own (a park is walked all over, a yard much less, a wood not at all).
import { groundAt, landUse, pavingOf, chunkOf, chunkKey, generateChunk, T, hash, Domain } from '../../sim/index.js';

const MOIST = { park: 0.62, yards: 0.72, forest: 0.8, mall: 0.3, town: 0.42 };
const FOREST = { park: 0.12, yards: 0.08, forest: 1, mall: 0, town: 0 };
const WEAR = { park: 0.14, yards: 0.05, forest: 0, mall: 0.35, town: 0.3 };
// wear round things people use: radius in metres, strength at the centre (falls off smoothly to the edge)
const W = { table: [2.4, 0.9], tableAcross: 3.1, // a table's worn ground: its length, and across it its benches and the feet under them
   stand: [1.5, 0.6], door: [1.6, 0.55], flower: [0.38, 1], trunk: [0.4, 0.75], hive: [1.3, 0.5] };
export const WEAR_FULL = 0.2; // the paving channel's value for fully worn ground

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
    // a walk from each house's door (the long side facing its street, as game.js puts the door) to the sidewalk
    if (!v && p.roads.length) for (const h of p.houses) {
      const ds = Math.sign(chunkOf(h.z) * CS - h.z) || 1, z0 = h.z + ds * h.hd, z1 = chunkOf(h.z) * CS - ds * 4;
      if (Math.abs(x - h.x) <= 0.6 && (z - z0) * ds >= 0 && (z1 - z) * ds >= 0) return 0.5;
    }
    return v;
  }
  // what wears the ground, per chunk: its own things and its neighbours' within reach of its edge
  const wearCache = new Map();
  function wearOf(cx, cz) {
    const k = chunkKey(cx, cz);
    let list = wearCache.get(k);
    if (list) return list;
    if (wearCache.size > 1024) wearCache.clear();
    list = [];
    const x0 = cx * CS - CS / 2 - 3, x1 = cx * CS + CS / 2 + 3, z0 = cz * CS - CS / 2 - 3, z1 = cz * CS + CS / 2 + 3;
    const add = (x, z, [r, s], rz = r) => { if (x + r > x0 && x - r < x1 && z + rz > z0 && z - rz < z1) list.push({ x, z, ix: 1 / r, iz: 1 / rz, s }); };
    for (let j = cz - 1; j <= cz + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
      const c = objects(i, j);
      for (const t of c.tables || []) if (t.axisX) add(t.x, t.z, W.table, W.tableAcross); else add(t.x, t.z, [W.tableAcross, W.table[1]], W.table[0]);
      for (const h of c.humans || []) if (h.posture === 'stand') add(h.x, h.z, W.stand);
      for (const f of c.flowers || []) add(f.x, f.z, W.flower);
      for (const t of c.trees || []) add(t.x, t.z, [t.r + W.trunk[0], W.trunk[1]]);
      for (const h of c.hives || []) add(h.x, h.z, W.hive);
      for (const b of c.sheds || []) if (b.house) { const ds = Math.sign(chunkOf(b.z) * CS - b.z) || 1; add(b.x, b.z + ds * (b.hd + 0.8), W.door); }
    }
    wearCache.set(k, list);
    return list;
  }
  // 0 (untouched) .. 1 (trodden bare in patches)
  function wear(x, z) {
    let w = landBlend(x, z, WEAR);
    for (const f of wearOf(chunkOf(x), chunkOf(z))) {
      const d2 = ((x - f.x) * f.ix) ** 2 + ((z - f.z) * f.iz) ** 2; // an ellipse, in units of its radii
      if (d2 >= 1) continue;
      const t = 1 - Math.sqrt(d2);
      w = Math.max(w, f.s * t * t * (3 - 2 * t));
    }
    return Math.min(1, w);
  }
  // shade: the land use's forest, raised to 0.75 under the middle of each tree's crown
  function shade(x, z) {
    let f = landBlend(x, z, FOREST);
    for (const t of objects(chunkOf(x), chunkOf(z)).trees || []) {
      const d = Math.hypot(x - t.x, z - t.z);
      if (d < t.cr) { const u = Math.min(1, (t.cr - d) / (0.6 * t.cr)); f = Math.max(f, 0.75 * u * u * (3 - 2 * u)); }
    }
    return f;
  }
  // blend moisture and forest between chunk centres, as the sim blends its ground roll
  function landBlend(x, z, table) {
    const u = x / CS, v = z / CS, i = Math.floor(u), j = Math.floor(v), tu = u - i, tv = v - j;
    const s = (t) => t * t * (3 - 2 * t), a = table[useOf(i, j)] ?? 0.5, b = table[useOf(i + 1, j)] ?? 0.5, c = table[useOf(i, j + 1)] ?? 0.5, d = table[useOf(i + 1, j + 1)] ?? 0.5;
    const su = s(tu), sv = s(tv);
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  }
  // cell: the size of the clipmap texel being filled. Things smaller than a few texels are left to the finer levels
  // (a coarse level shows the land use's own shade and wear), so a far level never generates chunks for their trees.
  function sample(x, z, out = [0, 0, 0, 0], cell = 0) {
    const fine = cell <= 1;
    out[0] = groundAt(seed, x, z, settings);
    out[1] = landBlend(x, z, MOIST);
    out[2] = fine ? shade(x, z) : landBlend(x, z, FOREST);
    const pv = paving(x, z);
    out[3] = pv > 0 ? pv : WEAR_FULL * (fine ? wear(x, z) : landBlend(x, z, WEAR));
    return out;
  }
  // The sim's own chunk content: a discovered record if the sim has one, else generated here (same seed, same content)
  function objects(cx, cz) { // hoisted: wearOf and shade call it
    const k = chunkKey(cx, cz);
    const rec = sim.records && sim.records.get(k);
    if (rec) return rec.content;
    let c = objCache.get(k);
    if (!c) { if (objCache.size > 256) objCache.clear(); c = generateChunk(seed, cx, cz, settings); objCache.set(k, c); }
    return c;
  }
  // The water the sim has (GDD 20.4: drawn where the sim has it): birdbaths and fountains, their water at the top the
  // sim gives them; and the puddles a rainy day leaves, while the ground is wet (the sim's own list, read, not changed).
  // top: the water's height above the ground; depth and kind: the basin under it (1 a bowl, 2 flat, 3 the ground)
  function waters(cx, cz) {
    const c = objects(cx, cz), out = [];
    for (const b of c.baths || []) out.push(b.fountain ? { x: b.x, z: b.z, r: b.r, top: b.h + 0.002, depth: 0.35, kind: 2 } : { x: b.x, z: b.z, r: b.r, top: b.h + 0.002, depth: 0.04, kind: 1 });
    const rec = sim.records && sim.records.get(chunkKey(cx, cz));
    if (rec && typeof sim.puddleDay === 'function') {
      const d = sim.puddleDay();
      if (d >= 0) for (const p of sim.puddlesIn(rec, d)) out.push({ x: p.x, z: p.z, r: p.r, top: p.y + 0.001, depth: 0, kind: 3 });
    }
    return out;
  }
  // decoration's variation (GDD 20.4 point 3): salted with hash(seed, Domain.Cosmetic, 0), kept under 2^20 so the GLSL
  // hashes can add it to their own salts without overflow
  const cosmetic = Number(hash(seed, Domain.Cosmetic, 0n) & 0xfffffn);
  return {
    kind: 'sting',
    params: { seed: Number(seed & 0xffffn), settings },
    cosmetic,
    sea: -1e6,                   // no open water in the sim's world: its water is the bodies below
    water: { fetch: 0.8, cascades: [0.6, 0.085] }, // birdbath and puddle ripples: centimetres, from a breeze over 0.8 m
    waters,
    sample,
    height: (x, z) => groundAt(seed, x, z, settings),
    glsl: null,                  // CPU fill
    uniforms: {},
    chunkSize: CS,
    objects,                     // trees come from here, not from the scatter's density
    trunks: false,               // the game draws the trunks: they are the sim's solid cylinders, which wasps land and nest on
    trailIsPaving: true,
    grassHeight: [0.045, 0.11],  // mown lawns: 4 to 11 cm, dry to watered (grass.js lets it grow long in woods)
    grassWood: 3,                // in the woods nobody mows: three times as long
  };
}
