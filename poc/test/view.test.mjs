// Tests for the presentation helpers that need no browser (GDD 20). Run: node test/view.test.mjs
import { readFileSync } from 'node:fs';
import { T } from '../sim/tuning.js';
import { applyTuning } from '../sim/tunefile.js';
import { groundAt, generateChunk, pavingOf, chunkOf } from '../sim/world.js';
import { DEFAULT_SETTINGS, u64 } from '../sim/index.js';
import { Rings, RING, ringGrid } from '../view/rings.js';
import { stingSource } from '../world/sources/sting.js';
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

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
