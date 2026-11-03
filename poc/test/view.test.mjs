// Tests for the presentation helpers that need no browser (GDD 20). Run: node test/view.test.mjs
import { readFileSync } from 'node:fs';
import { T } from '../sim/tuning.js';
import { applyTuning } from '../sim/tunefile.js';
import { groundAt, generateChunk, pavingOf, chunkOf } from '../sim/world.js';
import { DEFAULT_SETTINGS, u64 } from '../sim/index.js';
import { Rings, RING, ringGrid } from '../view/rings.js';
import { stingSource, WEAR_FULL } from '../world/sources/sting.js';
import { placeTile } from '../world/scatter.js';
import { treeDesign } from '../world/mesh.js';
applyTuning(T, readFileSync(new URL('../../tuning/sting.tune', import.meta.url), 'utf8'));

let failures = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) failures++; };

// G2. Ground rings round the camera: where two levels meet they are one surface; a coarse level hides only under a
// finer one; the window fills a few rows at a time
{
  const S = { terrain: 2 }, h = (x, z) => groundAt(1234n, x, z, S), rg = new Rings(h);
  let t0 = performance.now(); rg.update(40.3, 71.9); const first = performance.now() - t0, firstN = rg.filled;
  // 1. at a level's edge it has become the next level's surface
  let worst = 0, n = 0;
  for (let l = 0; l < RING.levels - 1; l++) {
    const L = rg.lv[l];
    for (let k = 0; k < 400; k++) {
      const a = (k / 400) * Math.PI * 2, r = L.H - (k % 7) / 7 * RING.band1 * L.s; // between band1 cells in and the edge
      const x = L.cx + Math.max(-1, Math.min(1, Math.cos(a) * 1.5)) * r, z = L.cz + Math.max(-1, Math.min(1, Math.sin(a) * 1.5)) * r;
      worst = Math.max(worst, Math.abs(rg.surfaceH(l, x, z) - rg.levelH(l + 1, x, z))); n++;
    }
  }
  // 2. a pushed vertex and every triangle round it lie under the finer level, inside its edge
  let leak = 0, pushed = 0;
  for (let l = 1; l < RING.levels; l++) {
    const L = rg.lv[l], F = rg.lv[l - 1];
    for (let v = -RING.cells / 2; v <= RING.cells / 2; v++) for (let u = -RING.cells / 2; u <= RING.cells / 2; u++) {
      const p = rg.ringY(l, u, v);
      if (!p.pushed) continue;
      pushed++;
      for (const [du, dv] of [[-1, -1], [-1, 0], [0, -1], [1, 0], [0, 1], [1, 1], [-1, 1], [1, -1]]) {
        const x = p.x + du * L.s, z = p.z + dv * L.s;
        if (Math.max(Math.abs(x - F.cx), Math.abs(z - F.cz)) > F.H - L.s + 1e-9) leak++;
      }
    }
  }
  // 3. every spot is drawn by an unpushed triangle of the finest level that covers it
  let holes = 0;
  for (let k = 0; k < 4000; k++) {
    const x = 40 + (k * 37.7 % 500) - 250, z = 72 + (k * 53.3 % 500) - 250;
    let f = RING.levels - 1;
    for (let l = 0; l < RING.levels - 1; l++) { const L = rg.lv[l]; if (Math.max(Math.abs(x - L.cx), Math.abs(z - L.cz)) < L.H) { f = l; break; } }
    const L = rg.lv[f], u = Math.floor((x - L.cx) / L.s), v = Math.floor((z - L.cz) / L.s);
    if (Math.abs(u) > RING.cells / 2 || Math.abs(v) > RING.cells / 2) continue; // past the outermost edge
    for (const [du, dv] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (rg.ringY(f, u + du, v + dv).pushed) holes++;
  }
  ok(worst < 1e-9 && n > 0 && pushed > 0 && leak === 0 && holes === 0,
    `where two levels meet they are one surface (worst ${worst.toExponential(1)} m over ${n} spots); ${pushed} coarse vertices hide under finer levels, none at their edge; no spot is left undrawn`);
  // 4. the drawn ground is the ground: within a few cm of the sim's at the camera, the levels' own cells further out
  let near = 0, far = 0;
  for (let k = 0; k < 500; k++) {
    const a = k * 2.399, r = 0.3 + (k % 50) * 0.3, x = 40.3 + Math.cos(a) * r, z = 71.9 + Math.sin(a) * r, e = Math.abs(rg.heightAt(x, z) - h(x, z));
    if (r < 12) near = Math.max(near, e); else far = Math.max(far, e);
  }
  ok(near < 0.05, `the drawn ground is within ${(near * 100).toFixed(1)} cm of the sim's within 12 m of the camera (${(far * 100).toFixed(1)} cm out to 15 m)`);
  // 5. flying at 12 m/s, each frame fills a few rows at most
  let most = 0, frames = 0, tf = 0;
  for (let f = 0; f < 600; f++) { const t1 = performance.now(); rg.update(40.3 + f * 0.2, 71.9 + f * 0.05); if (f >= 120) tf = Math.max(tf, performance.now() - t1); most = Math.max(most, rg.filled); frames++; }
  const g = ringGrid();
  ok(most <= 2 * RING.win * (RING.margin + 2) && g.idx.length / 3 * RING.levels <= 100000,
    `flying at 12 m/s, a frame fills at most ${most} heights (at most ${tf.toFixed(1)} ms once warm; the first fill ${firstN} in ${first.toFixed(0)} ms); the ground is ${g.idx.length / 3 * RING.levels} triangles`);
}

// World v2 (GDD 20.4): drawing the sim's own world. The ground it samples is the sim's; its forest is the sim's trees one
// for one; the game draws the trunks (the sim's solid cylinders), so the forest's trees have none
{
  const settings = { ...DEFAULT_SETTINGS, terrain: 2 }, sim = { seed: u64(7), settings, records: new Map() }, src = stingSource(sim);
  let worst = 0, paved = 0, roads = 0;
  for (let k = 0; k < 2000; k++) {
    const x = (k * 37.7 % 700) - 350, z = (k * 53.3 % 700) - 350, o = src.sample(x, z);
    worst = Math.max(worst, Math.abs(o[0] - groundAt(sim.seed, x, z, settings)));
    for (const r of pavingOf(sim.seed, chunkOf(x), chunkOf(z), settings).roads) if (x > r.minx && x < r.maxx && z > r.minz && z < r.maxz) { roads++; if (o[3] === 1) paved++; }
  }
  ok(worst === 0 && roads > 0 && paved === roads, `World v2's ground is the sim's at 2000 spots (worst ${worst} m); all ${roads} spots on a street are paved`);
  let n = 0, same = 0;
  for (let cz = -3; cz <= 3; cz++) for (let cx = -3; cx <= 3; cx++) {
    const trees = generateChunk(sim.seed, cx, cz, settings).trees, items = placeTile(src, cx, cz, ['oak', 'birch'], { tile: 64, variants: 3 }, { oak: treeDesign('oak', 1, { trunk: false }), birch: treeDesign('birch', 1, { trunk: false }) });
    const drawn = items.flat().flatMap((a) => Array.from({ length: a.length / 8 }, (_, i) => [a[i * 8], a[i * 8 + 1]]));
    n += trees.length;
    for (const t of trees) if (drawn.some(([x, z]) => x === t.x && z === t.z)) same++;
    if (drawn.length !== trees.length) same = -1e9;
  }
  const oak = treeDesign('oak', 1), bare = treeDesign('oak', 1, { trunk: false }), birch = treeDesign('birch', 1, { trunk: false });
  ok(n > 20 && same === n && oak.wood(0, 0.5, 0) < 0 && bare.wood(0, 0.5, 0) > 0.5 && birch.wood(0, 0.5, 0) > 0.5 && src.trunks === false,
    `World v2 draws the sim's ${n} trees over 49 chunks one for one, crowns only: the game draws their trunks`);
}

// World v2's lawn (GDD 20.5): worn where people sit, stand and walk, shaded under crowns, a walk from each door to the
// street; far clipmap levels leave those small things to the fine ones
{
  const settings = { ...DEFAULT_SETTINGS, terrain: 2 }, sim = { seed: u64(7), settings, records: new Map() }, src = stingSource(sim);
  const wearAt = (x, z, cell = 0) => { const w = src.sample(x, z, undefined, cell)[3]; return w < 0.3 ? w / WEAR_FULL : NaN; };
  let tables = 0, worn = 0, flowers = 0, bare = 0, open = 0, quiet = 0, doors = 0, walks = 0, shade = 0, trees = 0;
  for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) {
    const c = generateChunk(sim.seed, cx, cz, settings);
    for (const t of c.tables) { if (src.sample(t.x, t.z)[3] >= 0.3) continue; tables++; if (wearAt(t.x, t.z) > 0.8) worn++; } // tables on a square stand on paving
    for (const f of c.flowers) { if (src.sample(f.x, f.z)[3] >= 0.3) continue; flowers++; if (wearAt(f.x, f.z) > 0.95) bare++; }
    for (const t of c.trees) { trees++; const o = src.sample(t.x + t.cr * 0.3, t.z); if (o[2] > 0.6) shade++; }
    for (const b of c.sheds) if (b.house) {
      doors++;
      const ds = Math.sign(cz * 64 - b.z) || 1;
      if (src.sample(b.x, b.z + ds * (b.hd + 2.5))[3] >= 0.5) walks++; // the walk, or a cul-de-sac right at the door
    }
    // open lawn: away from everything, the land use's own wear only
    for (let k = 0; k < 40; k++) {
      const x = cx * 64 + (k * 13.7 % 60) - 30, z = cz * 64 + (k * 29.3 % 60) - 30, w = wearAt(x, z);
      const far = [...c.tables.map((t) => [t.x, t.z, 4]), ...c.flowers.map((f) => [f.x, f.z, 1]), ...c.trees.map((t) => [t.x, t.z, t.cr + 1]), ...c.humans.map((h) => [h.x, h.z, 2.5])].every(([px, pz, r]) => Math.hypot(x - px, z - pz) > r);
      if (!far || Number.isNaN(w) || c.use !== 'yards' && c.use !== 'park') continue;
      open++; if (w < 0.2) quiet++;
    }
  }
  const t = generateChunk(sim.seed, 0, 0, settings).tables[0];
  ok(tables > 0 && worn === tables && flowers > 10 && bare === flowers && open > 50 && quiet >= open * 0.99 && trees > 5 && shade === trees && doors > 4 && walks === doors && wearAt(t.x, t.z, 4) < 0.2,
    `the lawn is worn at all ${tables} tables and bare round all ${flowers} flowers, untouched on ${quiet} of ${open} open spots, shaded under all ${trees} crowns; all ${doors} houses have a walk to the street; a 4 m texel leaves the table to finer levels`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
