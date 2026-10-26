// Writes core/fixtures/parity.txt: digests of the JS reference that the C# port (core/) must reproduce bit for bit.
// Each digest is FNV-1a over the IEEE-754 bytes of numbers in a fixed order. Run: node test/parity.mjs
import { writeFileSync, readFileSync } from 'node:fs';
import { T } from '../sim/tuning.js';
import { applyTuning } from '../sim/tunefile.js';
applyTuning(T, readFileSync(new URL('../../tuning/sting.tune', import.meta.url), 'utf8')); // T1-22: the shipped tuning
import { generateChunk, dayWeather, windAt, humanWindow, flyPos, beePos, birdPos, dragonPos, makeNest, shedSites } from '../sim/world.js';
import { hash, Domain, u64, datan2, dsin, h32 } from '../sim/rng.js';
import { newColony, colonyStep, destroyNest, colonyFinished, seasonPhase, sugarCap, proteinCap } from '../sim/colony.js';
import { Sim } from '../sim/sim.js';
import { NetLab, MeshLab } from '../sim/net.js';
import { snapshot, restore } from '../sim/persist.js';
import { stingBot, idleCmd } from '../sim/bots.js';
import { humanTraits, humanClothing, suitClothing, bodyParts, segClosest, classify, toWorld, toLocal, resolveSting, ZONES, selfReach, zoneCover, predictedKind, garmentGraph } from '../sim/body.js';

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
  f(c.boxes.length); for (const t of c.boxes) { for (const k of ['minx', 'maxx', 'miny', 'maxy', 'minz', 'maxz']) f(t[k]); f(!!t.wood); f(!!t.hive); f(!!t.shed); f(!!t.fence); f(!!t.mall); }
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
  f(c.sheds.length); for (const t of c.sheds) { for (const k of ['x', 'z', 'hw', 'hd', 'h', 'crack', 'eave']) f(t[k]); f(!!t.house); }
  f(!!c.nest);
  // regions (T1-12)
  f(['park', 'yards', 'mall', 'forest'].indexOf(c.use));
  for (const list of [c.roads, c.lots]) { f(list.length); for (const t of list) for (const k of ['minx', 'maxx', 'minz', 'maxz']) f(t[k]); }
  f(c.loops.length); for (const t of c.loops) { f(t.x); f(t.z); f(t.r); }
  f(c.malls.length); for (const t of c.malls) for (const k of ['x', 'z', 'hw', 'hd', 'h']) f(t[k]);
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
  for (let day = 0; day < 60; day++) { const w = dayWeather(seed, day); d.f(w.rain); d.f(w.rainStart); d.f(w.rainEnd); d.f(w.base); d.f(w.wind); d.f(w.windDir); }
  for (let m = 0; m < 1440 * 4; m += 37) { const v = windAt(seed, m); d.f(v.x); d.f(v.z); }
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

// bodies: traits, clothing, parts, zones, reach, resolution, garment graphs
for (const seed of seeds) {
  const d = Digest();
  for (let i = 0; i < 120; i++) {
    const id = hash(seed, Domain.WorldGen, u64(i - 60), 7n, 1000n + BigInt(i));
    const tr = humanTraits(seed, id);
    for (const k of ['height', 'armRatio', 'flexibility', 'girth', 'ageStiffness', 'reactionTicks', 'style', 'accuracy', 'panicSusceptibility', 'sociability', 'escalation']) d.f(tr[k]);
    const cls = [humanClothing(seed, id, 0), humanClothing(seed, id, 3), suitClothing(i % 2 === 0), { ...humanClothing(seed, id, 1), topOff: true }];
    for (const c of cls) { d.f(c.top); d.f(c.bottom); d.f(c.stiffness); for (let z = 0; z < 17; z++) { d.f(zoneCover(c, z)); d.f(selfReach(ZONES[z], tr, c.stiffness)); d.f(predictedKind(z, tr, c)); } }
    for (const posture of ['stand', 'sit']) {
      const parts = bodyParts(tr, posture);
      for (const p of parts) { d.s(p.name); d.f(p.a.x); d.f(p.a.y); d.f(p.a.z); d.f(p.b.x); d.f(p.b.y); d.f(p.b.z); d.f(p.r); d.f(p.side); }
      const hm = { x: 3 + i * 0.1, z: -2 + i * 0.05, fx: dsin(i), fz: dsin(i + 1.5707963267948966) };
      for (let k = 0; k < 24; k++) {
        const wp = { x: hm.x + dsin(k * 1.7) * 0.4, y: 0.2 + (k % 8) * 0.22, z: hm.z + dsin(k * 2.3 + 1) * 0.4 };
        const lp = toLocal(hm, wp), back = toWorld(hm, lp); d.f(lp.x); d.f(lp.y); d.f(lp.z); d.f(back.x); d.f(back.z);
        for (const part of parts) {
          const q = segClosest(part.a, part.b, lp);
          const nx = lp.x - q.x, ny = lp.y - q.y, nz = lp.z - q.z, nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          d.f(q.t); d.f(q.x); d.f(q.y); d.f(q.z);
          d.f(classify(part, q, { x: nx / nl, y: ny / nl, z: nz / nl }, lp, tr.height / 1.75));
        }
      }
      for (const c of cls) {
        const g = garmentGraph(tr, c, posture, parts);
        d.f(g.length); for (const n of g) { d.s(n.key); d.f(n.zone); d.f(n.opening); d.f(n.n.x); d.f(n.n.y); d.f(n.n.z); d.f(n.pos.x); d.f(n.pos.y); d.f(n.pos.z); d.f(n.links.length); for (const l of n.links) d.f(l); }
      }
    }
    const comp = [{ id: id ^ 5n, distance: 0.5 + (i % 4), style: i % 5, reactionTicks: 11 + (i % 30) }, { id: id ^ 9n, distance: 1.2, style: (i + 2) % 5, reactionTicks: 20 }];
    for (let z = 0; z < 17; z++) for (const mode of ['jab', 'full', 'touch']) for (const under of [false, true]) {
      const plan = resolveSting({ contactTick: 1000 + i, mode, under, contactPointBody: { x: 0.01 * z, y: 1.1, z: -0.1 } }, tr, ZONES[z],
        { clothingStiffness: (i % 3) * 0.15, panic: (i % 7) * 0.1, stung: i % 6, panicMul: i % 4 === 0 ? 0 : 1.3, companions: i % 2 ? comp : null });
      d.f(plan.panicGain); d.f(plan.flee); d.f(plan.swats.length);
      for (const sw of plan.swats) { d.f(sw.kind); d.f(sw.start); d.f(sw.window); d.f(sw.radius); d.f(sw.kills); d.f(sw.reach); d.f(sw.center.x); }
    }
  }
  out(`bodies.${seed}`, d.hex());
}

// colony economy over long runs with changing inputs
{
  const d = Digest();
  const dc = (c) => { for (const k of ['adults', 'eggs', 'larvae', 'pupae', 'cells', 'protein', 'sugar', 'pulp', 'rEggs', 'rLarvae', 'rPupae', 'gynes', 'males', 'mated', 'deficit', 'fed', 'sugarlessDays']) d.f(c[k]); d.f(c.queenAlive); d.f(c.nestAlive); for (const k of ['emerged', 'laid', 'starvedLarvae', 'died', 'gynesRaised', 'sugarSpilled', 'proteinSpilled']) d.f(c.stats[k]); };
  for (const variant of [0, 1, 2, 3]) {
    const c = newColony(variant === 1);
    if (variant === 1) { c.pulp = 3; c.protein = 2; c.sugar = 4; c.adults = 1; }
    if (variant === 2) c.maxCells = 1800;
    for (let i = 0; i < 24000; i++) {
      c.alloc = Math.floor(i / 3000) % 4;
      if (variant === 3 && i === 9000) { c.protein = 0; c.sugar = 0; }
      if (variant === 2 && i % 500 === 0) c.pulp += 20;
      const frac = Math.min(1, 0.3 + i / 24000 * 0.75);
      colonyStep(c, 1 / 120, i % 7, (i % 1440) < 900, frac, variant === 0 ? 0.2 : 1);
      if (i % 200 === 0) { dc(c); d.f(sugarCap(c)); d.f(proteinCap(c)); d.f(colonyFinished(c, i % 3)); d.s(seasonPhase(frac)); }
    }
    destroyNest(c); dc(c);
  }
  out('colony', d.hex());
}

// whole simulations: input from scripted pilots, digests of the state and human hashes and every event type.
// The C# runner (core/Sting.Core.Tests/SimParity.cs) builds the same scenarios.
export const SIM_SCENARIOS = [
  { name: 'jab', settings: { seed: 1234 }, ticks: 7200, bot: () => stingBot({ plan: 'jab' }) },
  { name: 'full', settings: { seed: 1234 }, ticks: 7200, bot: () => stingBot({ plan: 'full', rest: 60 }) },
  { name: 'idle7', settings: { seed: 7 }, ticks: 12000, bot: () => (sim) => idleCmd({ alloc: sim.tick < 4000 ? 0 : sim.tick < 8000 ? 2 : 4 }) },
  { name: 'season', settings: { seed: 99, dayMinutes: 0.4, seasonDays: 10 }, ticks: 30000, bot: () => () => idleCmd() },
  { name: 'hot', settings: { seed: 1234, escalation: 6, reaction: 1.5 }, ticks: 20000, bot: () => stingBot({ plan: 'full', pick: () => true, rest: 40 }) },
];
for (const sc of SIM_SCENARIOS) {
  const d = Digest(), sim = new Sim(sc.settings), bot = sc.bot();
  for (let t = 0; t < sc.ticks; t++) {
    sim.step(bot(sim));
    for (const e of sim.drainEvents()) { d.s(e.type); d.f(e.t); }
    if (sim.tick % 60 === 0) { d.s(sim.stateHash()); d.s(sim.humanHash()); }
  }
  d.s(sim.stateHash()); d.s(sim.humanHash());
  out(`sim.${sc.name}`, d.hex());
}

// a world saved and restored mid-run carries on exactly (the C# save format is its own; the state must match)
{
  const d = Digest();
  let sim = new Sim({ seed: 1234, escalation: 3 }), bot = stingBot({ plan: 'full', rest: 50 });
  for (let t = 0; t < 6000; t++) {
    if (t === 3000) { sim = restore(snapshot(sim)); bot = stingBot({ plan: 'full', rest: 50 }); }
    sim.step(bot(sim));
    for (const e of sim.drainEvents()) { d.s(e.type); d.f(e.t); }
    if (sim.tick % 60 === 0) { d.s(sim.stateHash()); d.s(sim.humanHash()); }
  }
  out('sim.restored', d.hex());
}

// networked labs: two peers over simulated links, a late joiner, a cheater, and a three-peer mesh with a host ruling
export const NET_SCENARIOS = [
  { name: 'good', link: 'good', ticks: 9000 },
  { name: 'awful', link: 'awful', ticks: 6000 },
  { name: 'join', link: 'good', ticks: 9000, joinAt: 3000 },
  { name: 'cheat', link: 'good', ticks: 14000, cheat: true },
];
for (const sc of NET_SCENARIOS) {
  const d = Digest(), lab = new NetLab({ seed: 1234 }, sc.link, {}, sc.joinAt || 0), botA = stingBot({ plan: 'jab', rest: 200 });
  if (sc.cheat) {
    const o = lab._out.bind(lab);
    lab._out = (sim, link, dir) => { if (dir === 'ba' && sim.tick > 1200) for (const m of sim.outbox) if (m.type === 'sting') for (const sw of m.swats) sw.start += 1000; o(sim, link, dir); };
  }
  for (let i = 0; i < sc.ticks; i++) {
    lab.step(botA(lab.a));
    for (const e of lab.a.drainEvents()) { d.s(e.type); d.f(e.t); }
    for (const e of lab.bEvents || []) { d.s(e.type); d.f(e.t); }
    if (i % 60 === 0) {
      d.f(lab.check() ? 1 : 0);
      d.s(lab.a.stateHash()); if (lab.b) d.s(lab.b.stateHash());
      d.f(lab.a.remote.size); const e = lab.remoteError(); d.f(e === null ? -1 : e);
    }
  }
  out(`net.${sc.name}`, d.hex());
}
{
  const d = Digest(), lab = new MeshLab({ seed: 1234 }, 3, 'bad'), botA = stingBot({ plan: 'jab', rest: 200 });
  lab.tamper = (from, m, sim) => { if (from === 2 && sim.tick > 1500 && m.type === 'sting') for (const sw of m.swats) sw.start += 1000; };
  for (let i = 0; i < 17400; i++) { // the host cuts the cheater off near tick 16656
    lab.step(botA(lab.sims[0]));
    for (const s of lab.sims) for (const e of s.drainEvents()) { d.s(e.type); d.f(e.t); }
    if (i % 60 === 0) { d.f(lab.agree([0, 1]) ? 1 : 0); for (const s of lab.sims) { d.s(s.stateHash()); d.s(s.humanHash()); } }
  }
  out('net.mesh', d.hex());
}

writeFileSync(new URL('../../core/fixtures/parity.txt', import.meta.url), lines.join('\n') + '\n');
console.log(lines.join('\n'));
