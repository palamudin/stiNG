// Headless tests for the STING sim core. Run: node test/sim.test.mjs
import { readFileSync } from 'node:fs';
import {
  Sim, Act, hash, Domain, humanTraits, resolveSting, ZONES, Zone, ZoneName, toWorld, T, dsin, dcos, newColony, colonyStep,
  garmentGraph, Top, NEST_ENTRANCE, isRaining, dayWeather, windAt, humanClothing, Style, SwatKind, NEST, chunkKey, beePos, flyPos, snapshot, restore, replayFrom, stingBot, worldTag, rulesHash, shedSites, dragonPos, CMD_FIELDS,
} from '../sim/index.js';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const idle = (o = {}) => ({ mx: 0, my: 0, mz: 0, burst: 0, sting: 0, yawQ: 9800, pitchQ: 0, act: 0, alloc: 0, ...o });
const run = (sim, n, f = () => idle()) => { const ev = []; for (let i = 0; i < n; i++) { sim.step(f(sim, i)); ev.push(...sim.drainEvents()); } return ev; };
const count = (ev, type) => ev.filter((e) => e.type === type).length;
const place = (w, p) => { w.x = p.x; w.y = p.y; w.z = p.z; w.vx = w.vy = w.vz = 0; };

// 1. RNG and trait parity with the compiled C# protocode
{
  const ref = readFileSync(new URL('./cs_parity.txt', import.meta.url), 'utf8').trim().split('\n');
  const ids = [1n, 2n, 3n, 0xDEADBEEFCAFEBABEn, 12345678901234567n];
  let match = true;
  ids.forEach((id, i) => {
    const [, rt, st, hgt, arm, flex, girth] = ref[i].split(' ');
    const h = humanTraits(42n, id);
    const near = (a, b) => Math.abs(a - Number(b)) < 1e-6;
    if (h.reactionTicks !== +rt || h.style !== +st || !near(h.height, hgt) || !near(h.armRatio, arm) || !near(h.flexibility, flex) || !near(h.girth, girth)) match = false;
  });
  ok(match, 'human traits match C# HumanFactory for 5 ids');
  ok(hash(42n, Domain.WorldGen, 7n, 8n, 9n).toString(16).padStart(16, '0') === ref[5].trim(), 'Rng.Hash bit-identical to C#');
  let maxErr = 0;
  for (let x = -20; x <= 20; x += 0.001) maxErr = Math.max(maxErr, Math.abs(dsin(x) - Math.sin(x)), Math.abs(dcos(x) - Math.cos(x)));
  ok(maxErr < 1e-6, `dsin/dcos max error ${maxErr.toExponential(2)}`);
}

// 2. Consequence window holds for swats and for compression under clothing
{
  let minGap = Infinity;
  for (let i = 1n; i <= 2000n; i++) {
    const h = humanTraits(7n, i);
    for (let z = 0; z < ZONES.length; z++) for (const under of [false, true]) {
      const p = resolveSting({ contactTick: 0, zone: z, contactPointBody: { x: 0, y: 1, z: 0 }, mode: 'full', under }, h, ZONES[z],
        { clothingStiffness: 0, panic: 0, companions: [{ id: i + 99999n, distance: 1, reactionTicks: 11, style: 0 }] });
      for (const s of p.swats) minGap = Math.min(minGap, s.start);
    }
  }
  ok(minGap >= T.resolve.minConsequenceTicks, `no swat or press lands before ${T.resolve.minConsequenceTicks} ticks (min ${minGap})`);
}

// 3. Colony economy (GDD 6, A.4)
{
  const fed = newColony(), starved = newColony();
  // stores are capped (a few days of need), so "fed" means topped up every step
  for (let i = 0; i < 120 * 10; i++) {
    fed.protein = 1e6; fed.sugar = 1e6; starved.protein = 0; starved.sugar = 1e6;
    colonyStep(fed, 1 / 120, 0, false); colonyStep(starved, 1 / 120, 0, false);
  }
  ok(fed.adults > 30 && fed.stats.emerged > 10, `fed colony grows over 10 days (${fed.adults.toFixed(1)} adults)`);
  ok(starved.stats.starvedLarvae > 10 && starved.larvae < fed.larvae, `protein-starved larvae die (${starved.stats.starvedLarvae.toFixed(1)} lost)`);
  ok(starved.deficit > fed.deficit, `sugar deficit rises when larvae go hungry (${starved.deficit.toFixed(2)} vs ${fed.deficit.toFixed(2)})`);
  const broke = newColony(); broke.sugar = 0; broke.protein = 0;
  for (let i = 0; i < 120 * 3; i++) colonyStep(broke, 1 / 120, 0, false);
  ok(!broke.queenAlive, 'queen dies after a day without sugar');
}

// 4. Determinism with AI wasps, humans, colony: two runs and a replay
function bot(plan) {
  let phase = 'approach', target = null, k = 0, idx = 0;
  return (sim) => {
    const w = sim.wasp, cmd = idle({ yawQ: Math.round((w.yaw || 0) * 1e4) });
    if (!w || w.state === 'dead') { phase = 'approach'; target = null; return cmd; }
    if (!target) {
      const seated = sim.active.filter((h) => h.posture === 'sit' && h.state === 'idle' && !h.special);
      if (!seated.length) return cmd;
      const hm = seated[idx++ % seated.length];
      const part = hm.parts.sit.find((p) => p.name === 'ForearmR');
      target = { hm, mid: { x: (part.a.x + part.b.x) / 2, y: (part.a.y + part.b.y) / 2 + part.r + 0.012, z: (part.a.z + part.b.z) / 2 } };
    }
    const tp = toWorld(target.hm, target.mid);
    const dx = tp.x - w.x, dy = tp.y - w.y, dz = tp.z - w.z, d = Math.hypot(dx, dy, dz);
    const yaw = Math.atan2(dx, dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    if (phase === 'approach') {
      cmd.yawQ = Math.round(yaw * 1e4); cmd.pitchQ = Math.round(pitch * 1e4);
      cmd.mz = Math.max(6, Math.min(100, Math.round(Math.sqrt(2 * T.wasp.accel * d) * 0.7 / T.wasp.cruise * 100)));
      if (d < 0.1) cmd.sting = 1;
      if (w.state === 'attached') { phase = 'sting'; k = 0; }
    }
    if (phase === 'sting') { cmd.sting = 1; k++; if (w.state === 'fly' && k > 2) { phase = plan === 'full' ? 'linger' : 'escape'; k = 0; } if (plan === 'jab' && k >= 7) cmd.sting = 0; }
    if (phase === 'linger') { if (++k > 25) { phase = 'escape'; k = 0; } }
    if (phase === 'escape') { cmd.yawQ = Math.round((yaw + Math.PI) * 1e4); cmd.pitchQ = 3000; cmd.mz = 100; cmd.burst = 1; if (++k > 120) { phase = 'approach'; target = null; } }
    return cmd;
  };
}
{
  const go = (plan, seed = 1234) => { const s = new Sim({ seed }); const ev = run(s, 15000, bot(plan)); return { s, ev, hash: s.stateHash() }; };
  const a = go('full'), b = go('full');
  ok(a.hash === b.hash, `two runs, same seed -> same state hash (${a.hash})`);
  ok(Sim.replay({ seed: 1234 }, a.s.log, 15000) === a.hash, 'replay of recorded input reproduces the hash');
  console.log('  full bot:', JSON.stringify(a.s.stats));
  ok(a.s.stats.stings > 0 && count(a.ev, 'swatHit') > 0, 'player stings land and swats hit lingering wasps');
  ok(count(a.ev, 'waspSpawn') > 3, `colony launches AI workers (${count(a.ev, 'waspSpawn')} spawns)`);
  ok(count(a.ev, 'deposit') > 0, `AI workers deposit at the nest (${count(a.ev, 'deposit')} deposits)`);
  const j = go('jab');
  console.log('  jab bot:', JSON.stringify(j.s.stats));
  const playerDeaths = (ev) => ev.filter((e) => e.type === 'waspDied' && e.driven).length;
  ok(playerDeaths(j.ev) / Math.max(1, j.s.stats.stings) < playerDeaths(a.ev) / Math.max(1, a.s.stats.stings), 'jab-and-run dies less per sting than full-and-linger');
  ok(go('full', 99).hash !== a.hash, 'different seed -> different world');
}

// helper: a seated human in the origin chunk wearing a given top
function seated(sim, pred) { return sim.active.find((h) => !h.special && h.posture === 'sit' && h.state === 'idle' && pred(h)); }

// 5. Escalation ladder: covered food, traps (GDD 8.10)
{
  const s = new Sim({ seed: 1234 });
  const k0 = chunkKey(0, 0);
  ok(s.escLevel(k0) === 0, 'neighborhood starts calm');
  s.cs(k0).esc = 9;
  ok(s.escLevel(k0) === 2, 'level 2 at 9 points');
  const can = s.records.get(k0).content.sugar.find((x) => x.kind === 'can');
  const w = s.wasp; w.energy = 0.5; place(w, { x: can.x, y: can.y + 0.01, z: can.z });
  run(s, 30, () => idle());
  ok(w.energy < 0.5, 'covered cans give no sugar at level 2');
  s.cs(k0).esc = 16;
  const trap = s.records.get(k0).content.traps[0];
  place(w, { x: trap.x, y: trap.y, z: trap.z });
  const ev = run(s, 120, () => idle());
  const died = ev.find((e) => e.type === 'waspDied' && e.driven);
  ok(died && died.cause === 'drowned in a trap', `level 3 trap drowns a feeding wasp (${died && died.cause})`);
}

// 6. Swatting at a hovering wasp: level 1 kills, level 0 only at the face
{
  const s = new Sim({ seed: 1234 });
  s.cs(chunkKey(0, 0)).esc = 4;
  const hm = seated(s, (h) => h.tr.style !== 3);
  const head = toWorld(hm, hm.parts.sit[0].a);
  const ev = run(s, 600, (sim) => { const w = sim.wasp; if (w.state === 'fly') place(w, { x: head.x, y: head.y + 0.25, z: head.z }); return idle(); });
  const pre = ev.find((e) => e.type === 'preSwat');
  const died = ev.find((e) => e.type === 'waspDied');
  ok(pre && died && died.cause === 'slap', `a wasp hovering over a head at level 1 gets slapped (${died && died.cause})`);
}

// 7. Under clothing: compression kills a wasp that sits still; moving dodges and reaches the acnestis
{
  const s = new Sim({ seed: 1234 });
  const hm = seated(s, (h) => h.clothing.top === Top.TShirt && h.tr.style !== 3);
  ok(!!hm, 'found a seated human in a T-shirt');
  const nodes = garmentGraph(hm.tr, hm.clothing, 'sit', hm.parts.sit);
  const sleeve = nodes.find((n) => n.key === 'sleeve R');
  const out = toWorld(hm, { x: sleeve.pos.x + sleeve.n.x * 0.015, y: sleeve.pos.y + 0.004, z: sleeve.pos.z });
  place(s.wasp, out);
  let ev = run(s, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
  ok(s.wasp.state === 'under', `E at the sleeve crawls under the shirt (${s.wasp.state})`);
  ev = run(s, 600, () => idle());
  const died = ev.find((e) => e.type === 'waspDied');
  ok(died && died.cause === 'crushed under clothing', `staying still under the shirt gets you crushed (${died && died.cause})`);

  const s2 = new Sim({ seed: 1234 });
  const hm2 = s2.humanByHex(hm.hex);
  place(s2.wasp, out);
  run(s2, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
  // path: sleeve -> upper arm -> upper back -> acnestis, keep moving, sting at the acnestis
  const path = ['upper arm R', 'upper back R', 'acnestis'];
  let stungAcn = null, step = 0;
  ev = run(s2, 260, (sim, i) => {
    const w = sim.wasp;
    if (!w || w.state !== 'under') return idle();
    const g = garmentGraph(hm2.tr, hm2.clothing, hm2.posture, hm2.parts[hm2.posture]);
    const here = g[w.under.node];
    if (w.under.move) return idle();
    if (step < path.length) {
      const want = g.findIndex((n) => n.key === path[step]);
      const li = here.links.indexOf(want);
      if (li < 0) return idle();
      if (w.under.sel !== li) return idle({ mx: i % 2 ? 100 : 0 });
      if (i % 2) return idle();
      step++;
      return idle({ mz: 100 });
    }
    return idle({ sting: i % 20 < 8 ? 1 : 0 });
  });
  stungAcn = ev.find((e) => e.type === 'sting' && e.under);
  ok(stungAcn && ZoneName[stungAcn.zone] === 'Acnestis', `crawled from the sleeve to the acnestis and stung under the shirt (${stungAcn && ZoneName[stungAcn.zone]})`);
}

// 8. Bees: hovering at a hive entrance gets you balled and cooked; mashing burst breaks out
{
  const s = new Sim({ seed: 1234 });
  const rec = s.records.get('1,0');
  const hv = rec.content.hives[0];
  ok(!!hv, 'chunk (1,0) has a beehive');
  const w = s.wasp;
  place(w, { x: hv.ex + hv.fx * 0.3, y: hv.ey + 0.05, z: hv.ez + hv.fz * 0.3 });
  let ev = run(s, 1, () => idle());
  place(w, { x: hv.ex + hv.fx * 0.3, y: hv.ey + 0.05, z: hv.ez + hv.fz * 0.3 });
  ev = ev.concat(run(s, 1500, () => idle()));
  const died = ev.find((e) => e.type === 'waspDied');
  ok(count(ev, 'beeAlarm') > 0 && count(ev, 'balled') > 0, 'guards alarm and ball the wasp');
  ok(died && died.cause === 'cooked by bees', `the ball cooks the wasp (${died && died.cause})`);

  const s2 = new Sim({ seed: 1234 });
  const w2 = s2.wasp;
  run(s2, 1, () => idle());
  place(w2, { x: hv.ex + hv.fx * 0.3, y: hv.ey + 0.05, z: hv.ez + hv.fz * 0.3 });
  ev = run(s2, 900, (sim, i) => idle({ burst: sim.wasp && sim.wasp.state === 'balled' ? i % 2 : 0, mz: sim.wasp && sim.wasp.state === 'fly' && sim.wasp.ball === null ? 0 : 0 }));
  ok(count(ev, 'ballEscape') > 0, 'mashing burst breaks out of the ball');
}

// 9. Exterminator: level 4 near the nest brings him; he searches by flight lines (T1-7) and destroys the nest unless
// stopped. A colony lying low gives him fewer lines and is not found in the same time.
{
  const go = (alloc) => {
    const s = new Sim({ seed: 1234 });
    s.colony.adults = 120;
    s.cs(chunkKey(0, 0)).esc = 30;
    const first = run(s, 60, () => idle({ alloc }));
    return { s, first, ev: run(s, 18000, () => idle({ alloc })) };
  };
  const a = go(1);
  ok(count(a.first, 'extScheduled') === 1, 'level 4 near the nest schedules the exterminator');
  ok(count(a.ev, 'extLine') >= 2 && count(a.ev, 'extFound') === 1 && count(a.ev, 'extTreat') === 1,
    `he follows flight lines to the nest (${count(a.ev, 'extLine')} lines over ${count(a.ev, 'extArrive')} visits) and starts treating it`);
  ok(count(a.ev, 'nestDestroyed') === 1 && !a.s.colony.nestAlive, 'an unopposed exterminator destroys the nest');
  const b = go(5);
  ok(b.s.colony.nestAlive && count(b.ev, 'extFound') === 0 && count(b.ev, 'extGiveUp') >= 1,
    `a colony lying low is not found in the same time (${count(b.ev, 'extLine')} lines, gave up ${count(b.ev, 'extGiveUp')} times)`);
}

// 10. Exterminator abort: crawl under his collar, sting, keep moving between stings
{
  const s = new Sim({ seed: 1234 });
  s.cs(chunkKey(0, 0)).esc = 30;
  s.ext.lead = { x: s.nest.x, z: s.nest.z, nx: s.nest.x, nz: s.nest.z }; // found it on an earlier visit
  let ev = [];
  for (let i = 0; i < 4000 && !s.ext.hm; i++) ev.push(...run(s, 1, () => idle()));
  const ext = s.ext.hm;
  ok(!!ext && s.ext.state === 'active' && ev.find((e) => e.type === 'extArrive').known && ext.state === 'arrive', 'exterminator on site, and he knows where the nest is from last time');
  const g = () => garmentGraph(ext.tr, ext.clothing, ext.posture, ext.parts[ext.posture]);
  let entered = false, stungAt = -1;
  ev = run(s, 2500, (sim, i) => {
    const w = sim.wasp;
    if (!w || w.state === 'dead') return idle();
    if (w.state !== 'under') {
      if (ext.state !== 'arrive' && ext.state !== 'treat') return idle();
      const collar = g().find((n) => n.key === 'collar');
      place(w, toWorld(ext, { x: collar.pos.x, y: collar.pos.y + 0.003, z: collar.pos.z - 0.012 }));
      return idle({ act: i % 2 ? Act.Interact : 0 });
    }
    entered = true;
    if (w.under.move) return idle();
    // at a node: sting once, then hop to the first neighbour
    if (stungAt !== w.under.node) { stungAt = w.under.node; return idle({ sting: 1 }); }
    stungAt = -1;
    return idle({ mz: 100 });
  });
  ok(entered, 'got under the exterminator\'s collar');
  ok(count(ev, 'extAbort') === 1, `stings under his collar make him abort (${count(ev, 'sting')} stings, ${count(ev, 'waspDied')} deaths)`);
  ok(s.colony.nestAlive, 'the nest survives this visit');
}

// 11. Day cycle: people leave in the evening, the colony rests, people come back next day
{
  const s = new Sim({ seed: 1234, dayMinutes: 2 });
  const w = s.wasp; place(w, NEST_ENTRANCE);
  const ev = run(s, s.tpm * 60 * 10.5, (sim) => { if (sim.wasp && sim.wasp.state === 'fly') place(sim.wasp, NEST_ENTRANCE); return idle(); });
  ok(count(ev, 'leave') > 0, `people leave in the evening (${count(ev, 'leave')} left)`);
  const day0 = s.day;
  const ev2 = run(s, 2, (sim, i) => idle({ act: i === 1 ? Act.Rest : 0 }));
  ok(count(ev2, 'rested') === 1 && s.day === day0 + 1, 'resting at night skips to the next morning');
  const ev3 = run(s, s.tpm * 60 * 6, (sim) => { if (sim.wasp && sim.wasp.state === 'fly') place(sim.wasp, NEST_ENTRANCE); return idle(); });
  ok(count(ev3, 'arrive') > 0, `people arrive the next day (${count(ev3, 'arrive')} arrived)`);
}

// 12. Possession: switch to the nearest AI worker
{
  const s = new Sim({ seed: 1234 });
  run(s, 900, (sim) => { if (sim.wasp.state === 'fly') place(sim.wasp, { x: NEST_ENTRANCE.x + 0.5, y: 2, z: NEST_ENTRANCE.z }); return idle(); });
  const before = s.drivenId;
  const ev = run(s, 2, (sim, i) => idle({ act: i === 1 ? Act.Switch : 0 }));
  ok(count(ev, 'possess') === 1 && s.drivenId !== before, `Q possesses a nearby worker (${before} -> ${s.drivenId})`);
}

// 13. The yearly cycle: queen cells, collapse, winter, founding (GDD 5.2, 6.7)
{
  const c = newColony();
  c.protein = 1e5; c.sugar = 1e5;
  const days = 40, perDay = 120;
  let peakAdults = 0, adultsAt95 = 0;
  for (let i = 0; i < days * perDay; i++) {
    const frac = 0.3 + 0.7 * i / (days * perDay * 0.7) * 0.7;
    const f = Math.min(1, 0.3 + i / (days * perDay) * 0.7);
    colonyStep(c, 1 / perDay, 0, true, f, 0.2);
    peakAdults = Math.max(peakAdults, c.adults);
    if (f >= 0.95 && !adultsAt95) adultsAt95 = c.adults;
  }
  ok(c.stats.gynesRaised > 5 && c.mated > 1, `late season raises young queens that leave to mate (${c.stats.gynesRaised.toFixed(0)} raised, ${c.mated.toFixed(0)} mated)`);
  ok(!c.queenAlive && c.adults < peakAdults * 0.5, `the old queen dies and the colony collapses in autumn (${peakAdults.toFixed(0)} -> ${c.adults.toFixed(0)} adults)`);

  const s = new Sim({ seed: 1234 });
  s.colony.mated = 200;
  s.season.startMinute -= 0.71 * s.settings.seasonDays * 1440;
  const ev = run(s, 120, () => idle());
  const wi = ev.find((e) => e.type === 'winter'), sp = ev.find((e) => e.type === 'spring');
  ok(wi && sp, `the season ends: winter, then spring (${wi && wi.survivors} queens survived)`);
  ok(s.wasp.caste === 'queen' && s.colony.adults === 0 && s.colony.cells === 0 && s.season.n === 2, 'spring: you are the founding queen of a new colony');
  // founding: pick a tree (E at the trunk), then bring pulp and prey; the queen lays
  const q = s.wasp;
  ok(!s.colony.sited, 'spring: the queen has no nest yet');
  const tree = s.activeChunks.flatMap((r) => r.content.trees).find((t) => Math.hypot(t.x - NEST.treeX, t.z - NEST.treeZ) > 3 && t.h > 3);
  place(q, { x: tree.x + tree.r + 0.03, y: 2, z: tree.z });
  const fev = run(s, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
  ok(count(fev, 'nestFounded') === 1 && Math.hypot(s.nest.treeX - tree.x, s.nest.treeZ - tree.z) < 1e-9, 'E at a trunk founds the nest in that tree');
  const E = s.nest.entrance;
  q.carry = { kind: 'pulp', amount: 3, what: 'pulp' };
  place(q, E); run(s, 2, () => idle());
  q.carry = { kind: 'protein', amount: 3, what: 'fly' };
  place(q, E); run(s, 2, () => idle());
  run(s, s.dayTicks / 2, (sim) => { if (sim.wasp.state === 'fly') place(sim.wasp, { x: E.x + 0.3, y: E.y, z: E.z }); return idle(); });
  ok(s.colony.cells > 10 && s.colony.eggs + s.colony.larvae > 1, `founding: pulp builds cells and the queen lays (${s.colony.cells.toFixed(0)} cells, ${(s.colony.eggs + s.colony.larvae).toFixed(1)} brood)`);
}

// 14. Predators, landing, rivals (GDD 7.2, 9.3)
{
  // spider web: fly into it, hang still, get eaten; mash burst, tear free
  const findWeb = (s) => { for (const r of s.activeChunks) if (r.content.webs.length) return { w: r.content.webs[0], key: `${r.cx},${r.cz}` }; return null; };
  const s = new Sim({ seed: 1234 });
  const { w: wb } = findWeb(s);
  const into = (sim) => { const w = sim.wasp; place(w, { x: wb.x - wb.nx * 0.1, y: wb.y, z: wb.z - wb.nz * 0.1 }); w.vx = wb.nx * 2; w.vz = wb.nz * 2; };
  into(s);
  let ev = run(s, 5, () => idle());
  ok(s.wasp.state === 'webbed', `flying through a web sticks the wasp (${s.wasp.state})`);
  ev = run(s, 900, () => idle());
  const eaten = ev.find((e) => e.type === 'waspDied');
  ok(eaten && eaten.cause === 'eaten by a spider', `a stuck wasp that does nothing is eaten (${eaten && eaten.cause})`);
  const s2 = new Sim({ seed: 1234 });
  into(s2); run(s2, 5, () => idle());
  ev = run(s2, 60, (sim, i) => idle({ burst: i % 2 }));
  ok(count(ev, 'webEscape') === 1, 'mashing burst tears free');

  // bird: hover in the open at 3 m and get taken; stay low and live
  const s3 = new Sim({ seed: 1234 });
  let bird = null, bkey = null;
  for (const r of s3.activeChunks) if (r.content.birds.length) { bird = r.content.birds[0]; bkey = r; break; }
  ok(!!bird, 'a bird patrols near the nest');
  const open = (sim) => { const w = sim._driven(); if (!w || w.state !== 'fly') return; const p = { x: bird.x + bird.r, y: 3, z: bird.z }; place(w, p); };
  ev = run(s3, 2400, (sim) => { open(sim); return idle(); });
  const taken = ev.find((e) => e.type === 'waspDied');
  ok(count(ev, 'birdDive') > 0 && taken && taken.cause === 'taken by a bird', `a wasp hanging in open air is taken by a bird (${taken && taken.cause})`);

  // landing: hover still over a bench, land, stop burning sugar
  const s4 = new Sim({ seed: 1234 });
  const bench = s4.records.get('0,0').content.boxes[1];
  const w4 = s4.wasp; place(w4, { x: (bench.minx + bench.maxx) / 2 + 0.3, y: bench.maxy + 0.0071, z: (bench.minz + bench.maxz) / 2 });
  w4.energy = 0.5;
  ev = run(s4, 300, () => idle());
  ok(w4.state === 'landed' && Math.abs(w4.energy - 0.5) < 0.01, `a still wasp lands on the bench and rests (${w4.state}, crop ${w4.energy.toFixed(3)})`);
  // walking: the move keys walk camera-relative on the surface; off the edge the wasp drops into flight.
  // The middle of the table top, walking along it, is clear of arms.
  const table = s4.records.get('0,0').content.boxes[0];
  place(w4, { x: (table.minx + table.maxx) / 2, y: table.maxy + 0.0071, z: (table.minz + table.maxz) / 2 });
  run(s4, 120, () => idle());
  const x0 = w4.x;
  run(s4, 30, () => idle({ yawQ: 0, mx: -100 }));
  ok(w4.state === 'landed' && w4.x > x0 + 0.02 && Math.abs(w4.y - (table.maxy + T.wasp.radius)) < 0.01, `a landed wasp walks across the table (${((w4.x - x0) * 100).toFixed(1)} cm)`);
  ev = run(s4, 1500, () => idle({ yawQ: 0, mx: -100 }));
  ok(count(ev, 'walkOff') === 1 && w4.state === 'fly' && w4.x >= table.maxx, `walking off the edge drops it into flight (${w4.state})`);
  // walking into a seated person climbs onto them
  // land on the bench 30 cm beside someone sitting on it (fresh world, so nobody has left yet), then walk toward them
  {
    const s5 = new Sim({ seed: 1234 }), b5 = s5.records.get('0,0').content.boxes[1], w5 = s5.wasp;
    const sitter = s5.active.find((h) => h.posture === 'sit' && h.z > b5.minz - 0.2 && h.z < b5.maxz + 0.2 && h.x - 0.3 > b5.minx);
    place(w5, { x: sitter.x - 0.3, y: b5.maxy + 0.0071, z: (b5.minz + b5.maxz) / 2 });
    run(s5, 120, () => idle());
    ok(w5.state === 'landed', `lands on the bench beside a seated person (${w5.state})`);
    ev = run(s5, 600, () => idle({ yawQ: 0, mx: w5.state === 'landed' ? -100 : 0 }));
    ok(count(ev, 'perch') >= 1, `walking along the bench into them climbs onto them (${w5.state})`);
  }
  // on the ground, a tree trunk stops it
  const tree = s4.records.get('0,0').content.trees[0];
  place(w4, { x: tree.x - tree.r - 0.05, y: T.wasp.radius + 0.001, z: tree.z });
  run(s4, 120, () => idle());
  const gx = w4.x;
  run(s4, 600, () => idle({ yawQ: 0, mx: -100 }));
  ok(w4.state === 'landed' && w4.x > gx && w4.x < tree.x - tree.r, `a tree trunk blocks a walking wasp (stopped ${((tree.x - tree.r - w4.x) * 1000).toFixed(1)} mm short)`);
  run(s4, 2, () => idle({ my: 100 }));
  ok(w4.state === 'fly', 'climbing takes off again');

  // rivals: a rival nest near the origin spawns workers; touching one starts a fight with a winner
  let rs = null, rkey = null;
  for (let seed = 1; seed < 60 && !rs; seed++) {
    const t = new Sim({ seed });
    for (const r of t.activeChunks) if (r.content.rival) { rs = t; rkey = r; break; }
  }
  ok(!!rs, 'found a world with a rival nest next to the home chunk');
  const rv = rkey.content.rival;
  place(rs.wasp, { x: rv.ex + 3, y: rv.ey, z: rv.ez });
  ev = run(rs, 1200, (sim) => { const w = sim._driven(); if (w && w.state === 'fly') place(w, { x: rv.ex + 3, y: rv.ey, z: rv.ez }); return idle(); });
  const rivals = rs.wasps.filter((w) => w.colony !== 'own');
  ok(rivals.length > 0, `rival workers fly from their nest (${rivals.length})`);
  // raid: E at their entrance steals a larva and sends the guard after you
  place(rs.wasp, { x: rv.ex, y: rv.ey - 0.02, z: rv.ez });
  ev = run(rs, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
  ok(count(ev, 'raid') === 1 && rs.wasp.carry && rs.wasp.carry.what === 'larva', 'E at a rival entrance steals a larva');
  ev = run(rs, 600, () => idle());
  const fought = ev.find((e) => e.type === 'fightOver');
  ok(count(ev, 'fight') > 0 && fought, 'rival workers hunt the raider and the fight ends with one dead');
}

// 15. Perching and crawling on people; jumpy humans (GDD 7.2, 8.3, 8.10)
{
  const s = new Sim({ seed: 1234 });
  const hm = seated(s, (h) => h.tr.style !== 3 && h.clothing.top !== Top.Jacket);
  const torso = hm.parts.sit.find((p) => p.name === 'Torso');
  // hover still just behind the lower back
  const lb = { x: 0.03, y: torso.a.y + (torso.b.y - torso.a.y) * 0.25, z: -(torso.r + 0.012) };
  place(s.wasp, toWorld(hm, lb));
  let ev = run(s, 3, () => idle());
  ok(s.wasp.state === 'perched', `hovering still against a back perches the wasp (${s.wasp.state}, ${s.wasp.perch && ZoneName[s.wasp.perch.zone]})`);
  // crawl up the back toward the acnestis: hold W while looking up, facing the same way as the human
  const face = Math.round(Math.atan2(hm.fx, hm.fz) * 1e4);
  let reached = false;
  ev = run(s, 400, (sim) => {
    const w = sim.wasp;
    if (w.state !== 'perched') return idle();
    if (ZoneName[w.perch.zone] === 'Acnestis') { reached = true; return idle({ yawQ: face }); }
    return idle({ mz: 100, yawQ: face, pitchQ: 14000 });
  });
  ok(reached, 'crawling up the back reaches the acnestis without stinging');
  ok(count(ev, 'notice') > 0, `sooner or later they feel the feet and swat (${count(ev, 'notice')} notices)`);

  // jumpy: the same human reacts faster after being stung
  const h = humanTraits(1234n, 77n), z = ZONES[Zone.Forearms];
  const plan = (n) => resolveSting({ contactTick: 0, zone: Zone.Forearms, contactPointBody: { x: 0, y: 1, z: 0 }, mode: 'jab' }, h, z, { clothingStiffness: 0, panic: 0, companions: [], stung: n });
  const d0 = plan(0).swats[0]?.start, d3 = plan(3).swats[0]?.start;
  ok(h.style === 3 || (d3 < d0 && d3 >= T.resolve.minConsequenceTicks), `after three stings the swat comes sooner (${d0} -> ${d3} ticks)`);
  ok(plan(3).panicGain > plan(0).panicGain, 'and each sting hurts more');
}

// 16. Save and restore: a restored world continues bit for bit (GDD 4.6, 11.10)
{
  const a = new Sim({ seed: 1234 });
  const bot = stingBot({ plan: 'full', rest: 150 });
  run(a, 9000, (sim) => bot(sim));
  a.cs('0,0').esc = 9.5; // something to carry over
  const snap = snapshot(a);
  const b = restore(snap);
  ok(b.stateHash() === a.stateHash() && b.humanHash() === a.humanHash(), `restored world hashes match the original (${a.stateHash()})`);
  const cmds = [];
  run(a, 6000, (sim) => { const c = bot(sim); cmds.push(c); return c; });
  run(b, 6000, (sim, i) => cmds[i]);
  ok(b.stateHash() === a.stateHash(), `after 6000 more ticks of the same input the restored world is identical (${b.stateHash()})`);
  ok(replayFrom(snap, a.log.slice(CMD_FIELDS * 9000), 6000) === a.stateHash(), 'replaying the input recorded after a snapshot reproduces the world');
  console.log(`  snapshot size ${(snap.length / 1024).toFixed(0)} KB for ${a.records.size} chunks, ${a.humans.size} humans, ${a.wasps.length} wasps`);
}

// 17. Frozen chunks
{
  const s = new Sim({ seed: 5 });
  const rec = s.records.get('0,0'), before = rec.contentHash;
  run(s, 600, () => idle({ mz: 100, burst: 1, yawQ: 0 }));
  ok(s.records.get('0,0') === rec && rec.contentHash === before, 'discovered chunk record stays frozen');
}

// 19b. Panic spills a drink: a new sugar source (GDD 8.9)
{
  const s = new Sim({ seed: 1234 });
  const cans = s.records.get('0,0').content.cans;
  let ev = [];
  for (const hm of s.active.filter((h) => h.posture === 'sit' && h.chunk === '0,0')) {
    if (count(ev, 'spill')) break;
    s._startFlee(hm, null);
    ev.push(...s.drainEvents());
  }
  const sp = ev.find((e) => e.type === 'spill');
  ok(!!sp && s.canSpilled('0,0', sp.i) && s.spillsIn('0,0').length === 1, 'a sitter who jumps up knocks a drink over');
  const pud = s.spillsIn('0,0')[0], w = s.wasp;
  w.energy = 0.3;
  // land in the puddle (hovering this close to people would end up perched on an arm)
  place(w, { x: pud.x, y: 0.75 + T.wasp.radius, z: pud.z }); w.state = 'landed';
  run(s, 120);
  ok(w.energy > 0.6, `the puddle feeds a wasp (crop ${w.energy.toFixed(2)})`);
  const c = cans[sp.i];
  w.energy = 0.3;
  run(s, 240, () => { place(w, { x: c.x, y: 0.87, z: c.z }); return idle(); });
  ok(w.energy < 0.35, `the knocked-over can itself is empty (crop ${w.energy.toFixed(2)})`);
  const t = new Sim({ seed: 1234 }); t.cs('0,0').esc = 9; // lids on
  let e2 = [];
  for (const hm of t.active.filter((h) => h.posture === 'sit' && h.chunk === '0,0')) { t._startFlee(hm, null); e2.push(...t.drainEvents()); }
  ok(count(e2, 'spill') === 0, 'lidded drinks at alert level 2 do not spill');
}

// 20. Level 5: municipal pest control (GDD 8.10)
{
  const s = new Sim({ seed: 1234 });
  s.cs('0,0').esc = 45;
  let ev = run(s, 120);
  const m = s.muni && s.muni.active;
  ok(count(ev, 'muniStart') === 1 && m && m.keys.length === 9 && m.keys.includes('0,0'), `a chunk at level 5 starts a campaign over the 3×3 area around it (${m ? m.keys.length : 0} chunks)`);
  const baits = s.muniBaits();
  ok(baits.length >= 6 && baits.every((b) => Math.abs(b.y - T.muni.baitHeight) < 1e-9), `bait stations hang on trees in every discovered chunk of the area (${baits.length})`);
  // the player takes meat from a station and brings it home
  const w = s.wasp, b = baits[0];
  place(w, { x: b.x + 0.01, y: b.y, z: b.z });
  run(s, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
  ok(w.carry && w.carry.poison && w.carry.what === 'bait', 'E at a station takes the bait');
  const L0 = s.colony.larvae, A0 = s.colony.adults;
  place(w, s.nest.entrance);
  ev = run(s, 3);
  const po = ev.find((e) => e.type === 'poisoned');
  ok(po && s.colony.larvae < L0 * 0.9 && s.colony.adults < A0, `bait carried home poisons the brood and the workers (larvae ${L0.toFixed(0)} → ${s.colony.larvae.toFixed(0)}, adults ${A0.toFixed(1)} → ${s.colony.adults.toFixed(1)})`);
  // the same save, continued, has the same baits
  const r = restore(snapshot(s));
  ok(r.muni.active && r.muni.active.n === s.muni.active.n && JSON.stringify(r.muniBaits()) === JSON.stringify(s.muniBaits()), 'a campaign survives save and restore');
  // abstract foragers: hunting protein brings more poison home than gathering sugar
  const loss = (alloc) => {
    const t = new Sim({ seed: 1234 });
    t.cs('0,0').esc = 45;
    run(t, 120 * 60, (sim) => { const d = sim._driven(); if (d) place(d, { x: sim.nest.entrance.x, y: sim.nest.entrance.y + 0.3, z: sim.nest.entrance.z }); return idle({ alloc }); });
    return t.colony.stats.poisoned || 0;
  };
  const lp = loss(2), ls = loss(3); // alloc commands are 1-based: 2 = Protein, 3 = Sugar
  ok(lp > ls * 1.5 && ls > 0, `foraging for protein in a baited area poisons more of the colony than foraging for sugar (${lp.toFixed(1)} vs ${ls.toFixed(1)} lost in 2 h)`);
  // the campaign ends after its days, and the area calms
  ev = run(s, (m.until - s.minute) * s.tpm + 120);
  ok(count(ev, 'muniEnd') === 1 && !s.muni.active && s.cs('0,0').esc < 25 && s.muniBaits().length === 0, `after ${T.muni.days} days the stations come down and the area calms (escalation ${s.cs('0,0').esc.toFixed(1)})`);
}

// 21. World modifiers (GDD 4.8)
{
  ok(worldTag({}) === '' && worldTag({ beeAggression: 1.5, exterminator: false, reaction: 1.4 }) === 'slow humans · bees ×1.5 · no exterminators', `a world's modifiers read as a short tag ("${worldTag({ beeAggression: 1.5, exterminator: false, reaction: 1.4 })}")`);
  ok(rulesHash({ seed: 1 }) === rulesHash({ seed: 2 }) && rulesHash({}) !== rulesHash({ birds: false }) && rulesHash({}) !== rulesHash({ escalation: 1.6 }), 'the rules hash changes with every modifier and not with the seed');
  const base = new Sim({ seed: 1234 }), slow = new Sim({ seed: 1234, reaction: 1.4 }), fast = new Sim({ seed: 1234, reaction: 0.3 });
  const hb = base.active[0], hs = slow.humanByHex(hb.hex), hf = fast.humanByHex(hb.hex);
  ok(hs.tr.reactionTicks === Math.round(hb.tr.reactionTicks * 1.4) && hf.tr.reactionTicks >= T.resolve.minConsequenceTicks, `slow humans react later (${hb.tr.reactionTicks} → ${hs.tr.reactionTicks} ticks); fast ones never inside the consequence window (${hf.tr.reactionTicks})`);
  const r = restore(snapshot(slow));
  ok(r.humanHash() === slow.humanHash() && r.humanByHex(hb.hex).tr.reactionTicks === hs.tr.reactionTicks, 'modifiers survive save and restore');
  const touchy = new Sim({ seed: 1234, escalation: 2 });
  touchy.addEsc(0, 0, 3); base.addEsc(0, 0, 3);
  ok(touchy.cs('0,0').esc === 2 * base.cs('0,0').esc, 'touchy neighborhoods escalate twice as fast');
  const quiet = new Sim({ seed: 1234, pestControl: false, exterminator: false, birds: false });
  quiet.cs('0,0').esc = 45;
  const ev = run(quiet, 3000);
  ok(!count(ev, 'muniStart') && !count(ev, 'extScheduled') && !quiet.birdState.size, 'systems switched off stay off: no pest control, no exterminator, no birds');
}

// 22. Nest sites (GDD 6.6): a trunk, an old burrow, or a branch, each with its own trade-offs
{
  const spring = () => {
    const t = new Sim({ seed: 1234 });
    t.colony.mated = 200;
    t.season.startMinute -= 0.71 * t.settings.seasonDays * 1440;
    run(t, 120);
    return t;
  };
  const found = (t, p) => { place(t.wasp, p); return run(t, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 })); };
  const g = spring();
  const hole = g.activeChunks.flatMap((r) => g.sitesIn(r).holes).find((h) => Math.hypot(h.x - g.wasp.x, h.z - g.wasp.z) < 40);
  let ev = found(g, { x: hole.x + 0.03, y: 0.12, z: hole.z });
  ok(count(ev, 'nestFounded') === 1 && g.nest.site === 'ground' && g.nest.entrance.y < 0.05 && g.colony.maxCells === T.sites.ground.maxCells, 'E at a burrow in the grass founds an underground nest');
  const b = spring();
  const br = b.activeChunks.flatMap((r) => b.sitesIn(r).branches).find((x) => Math.hypot(x.t.x - NEST.treeX, x.t.z - NEST.treeZ) > 3);
  ev = found(b, { x: br.x, y: br.y - 0.05, z: br.z });
  ok(count(ev, 'nestFounded') === 1 && b.nest.site === 'branch' && b.nest.y > 1.5, `E under a branch founds a hanging nest (${b.nest.y.toFixed(1)} m up)`);
  // size: a branch nest stops growing at its cap
  b.colony.pulp = 1e4; b.colony.adults = 2000; b.colony.sugar = 1e3;
  for (let i = 0; i < 400; i++) colonyStep(b.colony, 0.05, 0, false, 0.3, 0.2);
  ok(b.colony.cells === T.sites.branch.maxCells, `a branch nest stops at ${T.sites.branch.maxCells} cells`);
  // rain: the burrow floods, the open nest chills
  const tr = spring(); const t0 = tr.activeChunks.flatMap((r) => r.content.trees).find((t) => Math.hypot(t.x - NEST.treeX, t.z - NEST.treeZ) > 3 && t.h > 3);
  found(tr, { x: t0.x + t0.r + 0.03, y: 2, z: t0.z });
  const rainy = (t) => {
    Object.defineProperty(t, 'raining', { get: () => true });
    Object.assign(t.colony, { adults: 100, eggs: 50, larvae: 50, pupae: 50, protein: 50, sugar: 50 });
    run(t, t.dayTicks / 4);
    return { brood: t.colony.eggs + t.colony.larvae + t.colony.pupae, adults: t.colony.adults };
  };
  const rg = rainy(g), rt = rainy(tr), rb = rainy(b);
  ok(rg.brood < rt.brood * 0.97, `rain floods a burrow's brood (${rg.brood.toFixed(0)} vs ${rt.brood.toFixed(0)} in a trunk nest)`);
  ok(rb.adults < rt.adults && rt.adults < rg.adults, `rain chills an open nest most and a burrow least (adults: branch ${rb.adults.toFixed(1)}, trunk ${rt.adults.toFixed(1)}, burrow ${rg.adults.toFixed(1)})`);
  // discovery: traffic at people's feet is noticed
  const before = g.cs(g.nest.key).esc; g.addEsc(g.nest.x, g.nest.z, 1);
  ok(Math.abs(g.cs(g.nest.key).esc - before - T.sites.ground.discovery) < 1e-9, 'stings near a burrow nest raise the alert faster');
}

// 23. Windfall fruit late in the season (GDD 9.4)
{
  const s = new Sim({ seed: 1234 });
  const early = s.activeChunks.flatMap((r) => s.fruitIn(r)).length;
  s.season.startMinute -= 0.45 * s.settings.seasonDays * 1440; // to 75% of the season
  run(s, 2);
  const fruit = s.activeChunks.flatMap((r) => s.fruitIn(r));
  ok(early === 0 && fruit.length > 3, `no fruit in early summer; windfalls lie under fruit trees late in the season (${fruit.length} nearby)`);
  const f = fruit[0], w = s.wasp;
  place(w, { x: f.x, y: T.wasp.radius + 0.001, z: f.z }); w.state = 'landed'; w.energy = 0.3;
  run(s, 120);
  ok(w.energy > 0.6, `a wasp feeds on fallen fruit (crop ${w.energy.toFixed(2)})`);
  const r = restore(snapshot(s));
  ok(JSON.stringify(r.activeChunks.flatMap((c) => r.fruitIn(c))) === JSON.stringify(s.activeChunks.flatMap((c) => s.fruitIn(c))), 'the same fruit lies in the same places after a restore');
}

// 24. Switching limits (GDD 7.7, Q-03)
{
  const s = new Sim({ seed: 1234 });
  run(s, 600);
  const d = s.wasp;
  place(d, { x: s.nest.x + 80, y: 2, z: s.nest.z });
  let ev = run(s, 2, (sim, i) => idle({ act: i === 1 ? Act.Switch : 0 }));
  const pend = ev.find((e) => e.type === 'switchPending');
  ok(pend && s.drivenId === d.id, `far from every worker, switching is relayed with a delay (${pend && pend.seconds} s)`);
  ev = run(s, T.possess.relayTicks + 5, () => { place(d, { x: s.nest.x + 80, y: 2, z: s.nest.z }); return idle(); });
  ok(count(ev, 'possess') === 1 && s.drivenId !== d.id, 'after the delay you drive another worker');
  // the colony view picks a specific worker: near ones at once, far ones through the relay
  const me = s._driven();
  const near = s.wasps.find((x) => x !== me && x.colony === 'own');
  place(me, { x: near.x + 2, y: near.y, z: near.z });
  ev = run(s, 1, () => idle({ pick: near.id }));
  ok(count(ev, 'possess') === 1 && s.drivenId === near.id, `picking a worker in the colony view drives it (worker ${near.id})`);
  const far = s.wasps.find((x) => x !== near && x.colony === 'own');
  place(near, { x: far.x + 60, y: 2, z: far.z });
  ev = run(s, 1, () => idle({ pick: far.id }));
  // wait on the ground: hovering in the open, a bird or dragonfly would take it before the relay comes
  ev.push(...run(s, T.possess.relayTicks + 2, () => { if (s.drivenId === near.id) { place(near, { x: far.x + 60, y: T.wasp.radius + 0.001, z: far.z }); near.state = 'landed'; } return idle(); }));
  ok(count(ev, 'switchPending') === 1 && count(ev, 'possess') === 1 && s.drivenId !== near.id, `a far worker picked in the colony view is reached through the relay (now driving ${s.drivenId === far.id ? 'that worker' : 'a sister from the nest: it had gone home'})`);
}

// 25. Dragonflies hunt low; sheds give wall and attic nest sites (GDD 9.3, 6.6)
{
  let ds = null, df = null;
  for (let seed = 1; seed < 40 && !ds; seed++) { const t = new Sim({ seed }); for (const r of t.activeChunks) if (r.content.dragonflies.length) { ds = t; df = r.content.dragonflies[0]; break; } }
  const w = ds.wasp;
  const p0 = dragonPos(df, ds.tick);
  let ev = run(ds, 600, (sim) => { const d = sim._driven(); if (d && d.state === 'fly') place(d, { x: p0.x + 1, y: 1, z: p0.z }); return idle(); });
  ok(count(ev, 'dragonDive') >= 1 && ev.some((e) => e.type === 'waspDied' && e.cause === 'taken by a dragonfly'), 'a dragonfly darts at a wasp hovering low in the open and takes it');
  const t2 = new Sim({ seed: ds.seed });
  const w2 = t2.wasp;
  place(w2, { x: p0.x + 1, y: T.wasp.radius + 0.001, z: p0.z }); w2.state = 'landed';
  ev = run(t2, 600);
  ok(!ev.some((e) => e.type === 'waspDied' && e.cause === 'taken by a dragonfly'), 'a landed wasp is left alone');
  // sheds
  let ss = null;
  for (let seed = 1; seed < 60 && !ss; seed++) {
    const t = new Sim({ seed });
    t.colony.mated = 200; t.season.startMinute -= 0.71 * t.settings.seasonDays * 1440; run(t, 120);
    const rec = t.activeChunks.find((r) => r.content.sheds.length);
    if (rec) ss = { t, sh: rec.content.sheds[0] };
  }
  ok(!!ss && ss.t.records.size > 0, 'some chunks near home have a garden shed');
  const sites = shedSites(ss.sh);
  for (const type of ['wall', 'attic']) {
    const t = new Sim({ seed: ss.t.seed });
    t.colony.mated = 200; t.season.startMinute -= 0.71 * t.settings.seasonDays * 1440; run(t, 120);
    const p = sites[type];
    place(t.wasp, { x: p.x + p.nx * 0.05, y: p.y, z: p.z + p.nz * 0.05 });
    ev = run(t, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
    ok(count(ev, 'nestFounded') === 1 && t.nest.site === type && t.colony.maxCells === T.sites[type].maxCells, `E at the ${type === 'wall' ? 'crack in the wall' : 'gap under the eaves'} founds a nest ${T.sites[type].name}`);
  }
}

// 26. Tier 1, batch 1: wind, cold, drowning, clothes by the weather, shaking and flailing
{
  // wind: a pure function of the day, calm at dawn, stronger in the afternoon; it carries a hovering wasp off
  let seed = 1, day0 = null;
  for (; seed < 200; seed++) { const w = dayWeather(BigInt(seed), 0); if (!w.rain && w.wind > 2.2) { day0 = w; break; } }
  const at = (m) => { const v = windAt(BigInt(seed), m); return Math.hypot(v.x, v.z); };
  ok(day0 && at(15 * 60) > at(7 * 60) * 1.5 && at(15 * 60) === at(15 * 60), `wind is calm at dawn and stronger mid-afternoon (${at(7 * 60).toFixed(2)} -> ${at(15 * 60).toFixed(2)} m/s)`);
  const drift = (y) => {
    const s = new Sim({ seed, birds: false });
    const p0 = { x: 40, y, z: 40 }; // open grass in chunk (1,1)? place far from the nest
    const w = s.wasp; place(w, p0);
    run(s, 180, () => idle());
    const v = s.wind, n = Math.hypot(v.x, v.z);
    return ((w.x - p0.x) * v.x + (w.z - p0.z) * v.z) / n;
  };
  const high = drift(3), low = drift(0.3);
  ok(high > 0.3 && low < high * 0.3, `a hovering wasp drifts downwind, less near the ground (${high.toFixed(2)} m at 3 m, ${low.toFixed(2)} m at 30 cm in 3 s)`);

  // cold: a resting wasp shivers to stay ready; in the cold it cannot fly, and in torpor it dies unless it finds warmth
  const s = new Sim({ seed: 1234, birds: false });
  ok(s.wasp.bodyT >= T.cold.flyBody, `a wasp leaves the nest warm (${s.wasp.bodyT.toFixed(1)} °C)`);
  const spring = new Sim({ seed: 1234 }); spring.season.startMinute = spring.minute;
  ok(Math.abs((s.temperature - spring.temperature) - T.weather.springChill) < 1e-9, `spring is colder than summer by ${T.weather.springChill} °C`);
  const chilly = (f) => { const t = new Sim({ seed: 1234, birds: false }); Object.defineProperty(t, 'temperature', { get: () => 4 }); f(t); return t; };
  let ev;
  const c1 = chilly((t) => place(t.wasp, { x: 4, y: 1.5, z: 4 }));
  ev = run(c1, 900);
  ok(c1.wasp.bodyT < T.cold.flyBody && c1.wasp.y < 0.05, `at 4 °C a flying wasp cools, loses power and drops (${c1.wasp.bodyT.toFixed(1)} °C)`);
  ev = run(c1, 9000);
  const frozen = ev.find((e) => e.type === 'waspDied' && e.driven);
  ok(frozen && frozen.cause === 'cold', `left on the cold ground it dies of cold (${frozen && frozen.cause})`);
  const c2 = chilly((t) => {
    const hm = seated(t, (h) => h.tr.style !== 3);
    const fa = hm.parts.sit.find((p) => p.name === 'ForearmR');
    place(t.wasp, toWorld(hm, { x: (fa.a.x + fa.b.x) / 2, y: (fa.a.y + fa.b.y) / 2 + fa.r + 0.008, z: (fa.a.z + fa.b.z) / 2 }));
  });
  run(c2, 3);
  const perched = c2.wasp.state === 'perched';
  run(c2, 900, (sim) => { const w = sim._driven(); if (w && w.state === 'perched') w.perch.quietUntil = sim.tick + 10; return idle(); });
  ok(perched && c2._driven() && c2.wasp.bodyT > 25, `perched on a person it stays warm in the cold (${c2.wasp.bodyT.toFixed(1)} °C)`);

  // drowning in a drink: feed long enough at an open can and you may slip in; mash to climb out
  const intoCan = (mash) => {
    const t = new Sim({ seed: 1234, birds: false });
    const can = t.records.get('0,0').content.sugar.find((x) => x.kind === 'can');
    let fell = false;
    const ev2 = run(t, 9000, (sim, i) => {
      const w = sim._driven();
      if (!w) return idle();
      if (w.state === 'drowning') { fell = true; return idle({ burst: mash ? i % 2 : 0 }); }
      if (!fell && (w.state === 'fly' || w.state === 'landed')) { place(w, { x: can.x, y: can.y + 0.01, z: can.z }); w.energy = 0.3; }
      return idle();
    });
    return { fell, ev: ev2 };
  };
  const a = intoCan(false), b = intoCan(true);
  const drowned = a.ev.find((e) => e.type === 'waspDied' && e.driven);
  ok(a.fell && drowned && drowned.cause === 'drowned in a drink', `a wasp feeding at an open can slips in and drowns (${drowned && drowned.cause})`);
  ok(b.fell && count(b.ev, 'climbedOut') >= 1, 'mashing burst climbs out of the drink');

  // clothes follow the weather: more jackets on cool days, more tank tops on hot ones
  const share = (pred) => {
    const days = []; for (let d = 1; d < 200 && days.length < 6; d++) if (pred(dayWeather(1234n, d).base)) days.push(d);
    let jacket = 0, tank = 0, n = 0;
    for (const d of days) for (let i = 1n; i <= 300n; i++) { const c = humanClothing(1234n, i, d); n++; if (c.top === Top.Jacket) jacket++; if (c.top === Top.Tank) tank++; }
    return { jacket: jacket / n, tank: tank / n };
  };
  const cool = share((b) => b < 20), hot = share((b) => b >= 25);
  ok(cool.jacket > hot.jacket * 3 && hot.tank > cool.tank * 2, `clothes follow the weather (jackets ${(cool.jacket * 100).toFixed(0)}% cool vs ${(hot.jacket * 100).toFixed(0)}% hot; tank tops ${(cool.tank * 100).toFixed(0)}% vs ${(hot.tank * 100).toFixed(0)}%)`);

  // head shakes and the runner's flail
  const base = humanTraits(1234n, 5n), as = (style) => ({ ...base, style, reactionTicks: 20 });
  const plan = (style, zone) => resolveSting({ contactTick: 0, zone, contactPointBody: { x: 0, y: 1.6, z: 0 }, mode: 'jab' }, as(style), ZONES[zone], { clothingStiffness: 0, panic: 0, companions: [] });
  const sc = plan(Style.Flailer, Zone.Scalp).swats[0], sp = plan(Style.Precise, Zone.Scalp).swats[0];
  ok(sc.kind === SwatKind.Shake && !sc.kills && sp.kind === SwatKind.Slap, 'stung on the scalp a flailer shakes the head (dislodges) where a precise person slaps');
  const fc = plan(Style.Runner, Zone.Face).swats[0], fb = plan(Style.Brusher, Zone.Face).swats[0];
  ok(fc.kind === SwatKind.Shake && fb.kind === SwatKind.Brush, 'stung on the face a runner shakes, a brusher brushes');
  const run1 = plan(Style.Runner, Zone.Forearms);
  const flail = run1.swats[1];
  ok(run1.flee && flail && flail.kind === SwatKind.Brush && !flail.kills && flail.radius >= 0.2 && flail.start > run1.swats[0].start, 'a runner flails on the way out: a wide, late sweep that stuns');
}

// 27. Panic spreads by sight (GDD 8.9, T1-17)
{
  let s = null, sh = null;
  for (let seed = 1; seed < 60 && !sh; seed++) { const t = new Sim({ seed }); const rec = t.activeChunks.find((r) => r.content.sheds.length); if (rec) { s = t; sh = rec.content.sheds[0]; } }
  const P = (x, z) => ({ x, z });
  const L = P(sh.x - sh.hw - 1.2, sh.z), Rr = P(sh.x + sh.hw + 1.2, sh.z), L2 = P(sh.x - sh.hw - 1.2, sh.z + 2.5);
  ok(!s.canSee(L, Rr) && s.canSee(L, L2), 'a shed blocks the line of sight between two people; open ground does not');
  const tree = s.activeChunks.flatMap((r) => r.content.trees)[0];
  ok(!s.canSee(P(tree.x - 1, tree.z), P(tree.x + 1, tree.z)), 'so does a tree trunk');
  // contagion: a panicking person spreads it to one who can see them, not to one behind the shed
  const spread = (b) => {
    const t = new Sim({ seed: s.seed });
    const [A, B] = t.active.filter((h) => !h.special && h.state === 'idle').slice(0, 2);
    for (const h of t.active) if (h !== A && h !== B) { h.x += 500; h.z += 500; } // everyone else out of the way
    Object.assign(A, L, { panic: 1 }); Object.assign(B, b, { panic: 0 });
    for (let i = 0; i < 3; i++) t.step(idle());
    return B.panic;
  };
  const seen = spread(L2), hidden = spread(Rr);
  ok(seen > 0.001 && hidden === 0, `panic spreads to someone in sight (${seen.toFixed(4)}) and not behind a shed (${hidden})`);
}

// 28. People remember stings by recency and place (GDD 8.10, T1-18)
{
  const s = new Sim({ seed: 1234 });
  const bot = stingBot({ plan: 'jab' });
  let ev = [];
  for (let i = 0; i < 6000 && !ev.some((e) => e.type === 'sting'); i++) { s.step(bot(s)); ev.push(...s.drainEvents()); }
  const st = ev.find((e) => e.type === 'sting'), hm = s.humanByHex(st.humanHex);
  ok(hm.mem && hm.mem.length === 1 && Math.abs(s.wary(hm) - 1) < 0.01, `a sting is remembered with its time and place (wary ${s.wary(hm).toFixed(2)})`);
  const plan = (n) => resolveSting({ contactTick: 0, zone: Zone.Forearms, contactPointBody: { x: 0, y: 1, z: 0 }, mode: 'jab' }, hm.tr, ZONES[Zone.Forearms], { clothingStiffness: 0, panic: 0, companions: [], stung: n });
  const here = s.wary(hm);
  const x0 = hm.x; hm.x += 10; const away = s.wary(hm); hm.x = x0;
  hm.mem[0].m -= T.memory.forgetMinutes * 0.75; const later = s.wary(hm);
  ok(away < here * 0.5 && later < here * 0.3, `wary where it happened (${here.toFixed(2)}), calmer 10 m away (${away.toFixed(2)}) and after a day and a half (${later.toFixed(2)})`);
  ok(hm.tr.style === 3 || plan(here).swats[0].start <= plan(away).swats[0].start, 'and the hand comes sooner where they were stung');
}

// 29. Hollow trees and nest thermals (GDD 6.6, T1-14)
{
  const spring = () => { const t = new Sim({ seed: 1234 }); t.colony.mated = 200; t.season.startMinute -= 0.71 * t.settings.seasonDays * 1440; run(t, 120); return t; };
  const t = spring();
  const hol = t.activeChunks.flatMap((r) => t.sitesIn(r).hollows);
  ok(hol.length > 3 && hol.every((h) => h.t.r >= T.sites.hollowMinR && h.y > 0.6 && h.y < h.t.h), `some thick trees have a hollow in the trunk (${hol.length} near home)`);
  const h = hol[0];
  const out = Math.hypot(h.x - h.t.x, h.z - h.t.z);
  place(t.wasp, { x: h.x + (h.x - h.t.x) / out * 0.05, y: h.y, z: h.z + (h.z - h.t.z) / out * 0.05 });
  const ev = run(t, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
  ok(count(ev, 'nestFounded') === 1 && t.nest.site === 'hollow' && t.colony.maxCells === T.sites.hollow.maxCells && Math.hypot(t.nest.entrance.x - h.x, t.nest.entrance.z - h.z) < 1e-9,
    'E at a hollow founds a nest inside the tree');
  // the same cold morning in different sites
  const s = new Sim({ seed: 1234 });
  let cold = -1, hot = -1;
  for (let m = s.minute; m < s.minute + 1440 * 30 && (cold < 0 || hot < 0); m += 10) {
    const a = s.airAt(m);
    if (cold < 0 && a < 11) cold = m;
    if (hot < 0 && a > 29 && !isRaining(s.seed, m)) hot = m;
  }
  const at = (site, m) => { s.nest.site = site; return s.broodSpeed(m); };
  const sp = Object.fromEntries(['branch', 'trunk', 'ground', 'hollow'].map((k) => [k, at(k, cold)]));
  ok(cold > 0 && sp.branch < sp.trunk && sp.trunk < sp.ground && sp.ground < sp.hollow && sp.hollow < 1,
    `on a cold morning (${s.airAt(cold).toFixed(1)} °C) the brood slows most in an open nest and least in a hollow tree (branch ${sp.branch.toFixed(2)}, trunk ${sp.trunk.toFixed(2)}, burrow ${sp.ground.toFixed(2)}, hollow ${sp.hollow.toFixed(2)})`);
  ok(hot > 0 && at('attic', hot) < at('wall', hot), `a sunny afternoon (${s.airAt(hot).toFixed(1)} °C) bakes an attic nest (${at('attic', hot).toFixed(2)} vs ${at('wall', hot).toFixed(2)} in a wall)`);
  const grow = (k) => { const c = newColony(); for (let i = 0; i < 120 * 6; i++) { c.protein = 1e3; c.sugar = 1e3; colonyStep(c, 1 / 120, 0, false, 0.3, 1, k); } return c.stats.emerged; };
  ok(grow(0.5) < grow(1) * 0.8, `a slowed brood brings fewer workers out (${grow(0.5).toFixed(0)} vs ${grow(1).toFixed(0)} in six days)`);
}

// 30. Fetching spray (T1-6): at level 3 nobody has a can on them; a stung person with it in them goes for one,
// is out of sight a while, and comes back armed
{
  const s = new Sim({ seed: 1234, dayMinutes: 20 }, { noAI: true });
  run(s, 3);
  const hm = seated(s, (h) => h.tr.escalation >= T.esc.sprayTrait && h.tr.style !== Style.Freezer);
  ok(!!hm, 'someone at a table who would spray');
  s.cs(hm.chunk).esc = 16;
  const front = () => { if (s.wasp) place(s.wasp, toWorld(hm, { x: 0, y: 0.3, z: 1.0 })); return idle(); };
  let ev = run(s, 300, front);
  ok(s.escAt(hm.x, hm.z) === 3 && count(ev, 'spray') === 0, 'at level 3 a wasp in front of him is not sprayed: no can yet');
  if (s.wasp) place(s.wasp, { x: hm.x + 15, y: 2, z: hm.z });
  s._applyCommit({ type: 'sting', peer: s.peer, humanHex: hm.hex, panicGain: 0, driven: false, sx: hm.x, sz: hm.z, zone: 0, flee: false, waspId: 0 });
  let away = false;
  ev = run(s, 4500, () => { if (hm.state === 'fetch' && hm.fetchT > 0) away = true; if (s.wasp) place(s.wasp, { x: hm.x + 15, y: 2, z: hm.z }); return idle(); });
  ok(count(ev, 'fetchSpray') === 1 && away && count(ev, 'armed') === 1, 'stung, he goes off for a can and is out of sight a while');
  ok(hm.state === 'idle' && hm.sprayCount === T.esc.sprayCharges, `and comes back to his seat with ${hm.sprayCount} sprays`);
  ev = run(s, 300, front);
  ok(count(ev, 'spray') >= 1 && hm.sprayCount < T.esc.sprayCharges, `now a wasp in front of him gets sprayed (${T.esc.sprayCharges - hm.sprayCount} used)`);
}

// 31. What the exterminator sees (T1-7): more flight lines near the nest, fewer when the colony lies low or the
// site is well hidden, and one of ours flying in sight is a line of its own
{
  const s = new Sim({ seed: 1234 });
  s.colony.adults = 120;
  const n = s.nest, ws = s.wasps;
  s.wasps = [];
  const at = (d) => s.extSightings({ x: n.x + d, z: n.z });
  const r20 = at(20), r6 = at(6);
  s.colony.alloc = 4; const low = at(20); s.colony.alloc = 0;
  const site = n.site; n.site = 'hollow'; const hid = at(20); n.site = site;
  ok(r6 > r20 * 2 && low < r20 * 0.5 && hid < r20, `lines per second: ${r6.toFixed(3)} at 6 m, ${r20.toFixed(3)} at 20 m, ${low.toFixed(3)} lying low, ${hid.toFixed(3)} in a hollow`);
  s.wasps = ws;
  const probe = { x: n.x + 20, z: n.z };
  const w = s.wasp; place(w, { x: probe.x, y: 1.5, z: probe.z + 2 }); w.state = 'fly';
  const seen = s.extSightings(probe);
  ok(seen >= r20 + T.ext.physPerSec * 0.999, `and our wasp flying in sight adds a line (${seen.toFixed(3)})`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
