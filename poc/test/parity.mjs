// Writes core/fixtures/parity.txt: digests of the JS reference that the C# port (core/) must reproduce bit for bit.
// Each digest is FNV-1a over the IEEE-754 bytes of numbers in a fixed order. Run: node test/parity.mjs
import { writeFileSync } from 'node:fs';
import { generateChunk, dayWeather, humanWindow, flyPos, beePos, birdPos, dragonPos, makeNest, shedSites } from '../sim/world.js';
import { hash, Domain, u64, datan2, dsin, h32 } from '../sim/rng.js';

export function Digest() {
  const buf = new Float64Array(1), bytes = new Uint8Array(buf.buffer);
  let h = 0x811c9dc5;
  const f = (v) => { buf[0] = typeof v === 'boolean' ? (v ? 1 : 0) : v ?? 0; for (let i = 0; i < 8; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } };
  const s = (str) => { f(str.length); for (let i = 0; i < str.length; i++) f(str.charCodeAt(i)); };
  return { f, s, hex: () => (h >>> 0).toString(16).padStart(8, '0') };
}

const KIND = { can: 1, flower: 2, spill: 3, fruit: 4 };
export function digestChunk(c, d) {
  const { f } = d;
  f(c.cx); f(c.cz); f(c.tint);
  f(c.trees.length); for (const t of c.trees) { f(t.x); f(t.z); f(t.r); f(t.h); f(t.cr); f(t.shade); }
  f(c.tables.length); for (const t of c.tables) { f(t.x); f(t.z); f(t.axisX); }
  f(c.benches.length); for (const t of c.benches) { f(t.x); f(t.z); f(t.axisX); }
  f(c.cans.length); for (const t of c.cans) { f(t.x); f(t.z); f(t.color); f(t.table); }
  f(c.flowers.length); for (const t of c.flowers) { f(t.x); f(t.y); f(t.z); f(t.color); }
  f(c.caterpillars.length); for (const t of c.caterpillars) { f(t.x); f(t.y); f(t.z); }
  f(c.flies.length); for (const t of c.flies) { for (const k of ['x', 'y', 'z', 'r', 'w1', 'w2', 'w3', 'p1', 'p2', 'p3']) f(t[k]); }
  f(c.humans.length); for (const t of c.humans) { f(t.slot); f(t.x); f(t.z); f(t.fx); f(t.fz); f(t.posture === 'sit'); f(t.exit); }
  f(c.boxes.length); for (const t of c.boxes) { for (const k of ['minx', 'maxx', 'miny', 'maxy', 'minz', 'maxz']) f(t[k]); f(!!t.wood); f(!!t.hive); f(!!t.shed); }
  f(c.cylinders.length); for (const t of c.cylinders) { f(t.x); f(t.z); f(t.r); f(t.h); }
  f(c.sugar.length); for (const t of c.sugar) { f(t.x); f(t.y); f(t.z); f(t.rate); f(KIND[t.kind]); f(t.table ?? -1); }
  f(c.hives.length); for (const t of c.hives) {
    for (const k of ['x', 'z', 'fx', 'fz', 'ex', 'ey', 'ez', 'slot']) f(t[k]);
    for (const b of t.bees) { f(b.guard); for (const k of ['p', 'w', 'tx', 'ty', 'tz', 'period', 'phase']) f(b[k]); }
  }
  f(c.traps.length); for (const t of c.traps) { f(t.x); f(t.y); f(t.z); f(t.table); }
  f(c.webs.length); for (const t of c.webs) { for (const k of ['x', 'y', 'z', 'nx', 'nz', 'r', 'tree']) f(t[k]); }
  for (const list of [c.birds, c.dragonflies]) { f(list.length); for (const t of list) for (const k of ['x', 'y', 'z', 'r', 'period', 'phase', 'dir']) f(t[k]); }
  f(c.rival ? 1 : 0); if (c.rival) for (const k of ['x', 'y', 'z', 'r', 'ex', 'ey', 'ez', 'workers']) f(c.rival[k]);
  f(c.sheds.length); for (const t of c.sheds) { for (const k of ['x', 'z', 'hw', 'hd', 'h', 'crack', 'eave']) f(t[k]); }
  f(!!c.nest);
}

const lines = [];
const out = (name, hex) => lines.push(`${name} ${hex}`);
const seeds = [1234n, 7n, 0xDEADBEEFCAFEBABEn];

// world generation: a 9x9 block per seed
for (const seed of seeds) {
  const d = Digest();
  for (let cz = -4; cz <= 4; cz++) for (let cx = -4; cx <= 4; cx++) digestChunk(generateChunk(seed, cx, cz), d);
  out(`chunks.${seed}`, d.hex());
}
// weather and schedules
for (const seed of seeds) {
  const d = Digest();
  for (let day = 0; day < 60; day++) { const w = dayWeather(seed, day); d.f(w.rain); d.f(w.rainStart); d.f(w.rainEnd); d.f(w.base); }
  for (let i = 0; i < 40; i++) {
    const id = hash(seed, Domain.WorldGen, u64(i), 3n, 1000n);
    for (let day = 0; day < 20; day++) { const w = humanWindow(seed, id, day, 1 - (i % 3) * 0.15); d.f(w ? 1 : 0); if (w) { d.f(w.arrive); d.f(w.leave); } }
  }
  out(`weather.${seed}`, d.hex());
}
// pure motion and helpers
{
  const d = Digest();
  const c = generateChunk(1234n, 1, 0), c2 = generateChunk(1234n, 2, -1);
  for (let t = 0; t < 4000; t += 37) {
    for (const fl of c.flies) { const p = flyPos(fl, t + 0.25); d.f(p.x); d.f(p.y); d.f(p.z); }
    for (const hv of c.hives) for (let k = 0; k < hv.bees.length; k++) { const p = beePos(hv, k, t); d.f(p.x); d.f(p.y); d.f(p.z); }
    for (const b of [...c.birds, ...c2.birds]) { const p = birdPos(b, t); d.f(p.x); d.f(p.y); d.f(p.z); }
    for (const b of [...c.dragonflies, ...c2.dragonflies]) { const p = dragonPos(b, t); d.f(p.x); d.f(p.y); d.f(p.z); }
  }
  for (let i = 0; i < 2000; i++) { const y = dsin(i * 0.37) * (i % 9 - 4), x = dsin(i * 0.91 + 1) * (i % 5 - 2); d.f(datan2(y, x)); d.f(dsin(i * 0.013 - 7)); d.f(h32(i, -i * 3, i * 7 + 0.5, 1e9 + i)); }
  for (const site of ['trunk', 'ground', 'branch', 'wall', 'attic']) { const n = makeNest(-3, -2, 4.5, 2.1, 7.25, 0.14, site); for (const v of [n.x, n.y, n.z, n.entrance.x, n.entrance.y, n.entrance.z, n.spawn.x, n.spawn.y, n.spawn.z, n.spawn.yaw]) d.f(v); d.s(n.key); }
  for (const sh of [...generateChunk(1234n, 2, 0).sheds, ...generateChunk(1234n, -3, 1).sheds, ...generateChunk(7n, 1, 1).sheds]) { const ss = shedSites(sh); for (const p of [ss.wall, ss.attic]) for (const k of ['x', 'y', 'z', 'ix', 'iz', 'nx', 'nz']) d.f(p[k]); }
  out('motion', d.hex());
}

writeFileSync(new URL('../../core/fixtures/parity.txt', import.meta.url), lines.join('\n') + '\n');
console.log(lines.join('\n'));
