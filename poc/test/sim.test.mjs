// Headless tests for the STING sim core. Run: node test/sim.test.mjs
import { readFileSync } from 'node:fs';
import {
  Sim, Act, hash, Domain, humanTraits, humanParts, malesAbout, chunkOf, toLocal, dirToWorld, resolveSting, ZONES, Zone, ZoneName, toWorld, T, dsin, dcos, newColony, colonyStep,
  garmentGraph, Top, NEST_ENTRANCE, isRaining, dayWeather, windAt, humanClothing, Style, SwatKind, NEST, chunkKey, clockMinutes, landUse, generateChunk, beePos, flyPos, snapshot, restore, replayFrom, stingBot, worldTag, rulesHash, shedSites, dragonPos, CMD_FIELDS,
} from '../sim/index.js';
import { applyTuning, parseTuning, tuningHash, tuningLeaves, TUNE } from '../sim/tunefile.js';

// Tuning as data (T1-22): the tests run the shipped file, not the built-in defaults
const TUNE_TEXT = readFileSync(new URL('../../tuning/sting.tune', import.meta.url), 'utf8');
const TUNE_RESULT = applyTuning(T, TUNE_TEXT);

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
// someone sitting at a table, in the home park if there is one (the chunks around it are yards since T1-12)
function seated(sim, pred) {
  const ok = (h) => !h.special && h.posture === 'sit' && h.state === 'idle' && pred(h);
  return sim.active.find((h) => h.chunk === '0,0' && ok(h)) || sim.active.find(ok);
}

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
  const wi = ev.find((e) => e.type === 'winter');
  ok(wi && !ev.find((e) => e.type === 'spring') && s.winter && s.winter.sites.length >= 2 && !s.wasps.length,
    `the season ends and the queens sleep until one is chosen (${wi && wi.survivors} survived at ${s.winter && s.winter.sites.length} sites: ${s.winter && s.winter.sites.map((x) => `${x.n} ${x.kind}`).join(', ')})`);
  const pickSite = s.winter.sites[1];
  const ev2 = run(s, 2, (sim, i) => idle({ pick: i === 0 ? 2 : 0 }));
  ok(count(ev2, 'spring') === 1 && !s.winter && Math.hypot(s.wasp.x - pickSite.x, s.wasp.z - pickSite.z) < 0.2, `picking the second wakes that queen where she wintered (${pickSite.kind})`);
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

// 33. Winter with choices (T1-15): a worker scouts a winter site in late season and most gynes winter there; a good
// site wakes more queens than a poor one; with no choice made, the strongest site wakes on its own
{
  // a world with a free hollow tree near home to winter in (some hold wild bees, T1-9)
  let hseed = 1234;
  for (let sd = 1234; sd < 1300; sd++) { const t = new Sim({ seed: sd }); if (t.hiberSites().some((x) => x.kind === 'hollow')) { hseed = sd; break; } }
  const late = (scout) => {
    const s = new Sim({ seed: hseed });
    s.colony.mated = 300;
    s.season.startMinute -= 0.66 * s.settings.seasonDays * 1440;
    run(s, 2);
    const site = s.hiberSites().find((x) => x.kind === scout);
    let ev = [];
    if (site) { place(s.wasp, { x: site.x, y: site.y, z: site.z }); ev = run(s, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 })); }
    s.season.startMinute -= 0.05 * s.settings.seasonDays * 1440;
    const ev2 = run(s, 120);
    return { s, site, scouted: count(ev, 'hiberScouted'), win: ev2.find((e) => e.type === 'winter') };
  };
  const shed = late('hollow'), lit = late('litter');
  const at = (r) => r.win && r.win.sites.find((x) => x.scouted);
  ok(shed.site && lit.site && shed.scouted === 1 && lit.scouted === 1, `kinds of winter site near the nest: ${[...new Set(shed.s.hiberSites().map((x) => x.kind))].join(', ')}; E scouts one in late season`);
  ok(at(shed) && at(lit) && at(shed).n > at(lit).n * 2, `most gynes winter where the worker scouted, and a hollow tree wakes more queens than the leaf litter (${at(shed) && at(shed).n} vs ${at(lit) && at(lit).n})`);
  const sleeping = restore(snapshot(shed.s));
  const ev3 = run(shed.s, T.hiber.chooseTicks + 2);
  run(sleeping, T.hiber.chooseTicks + 2);
  ok(sleeping.stateHash() === shed.s.stateHash() && !sleeping.winter, 'a world saved in winter restores asleep and wakes the same queen');
  ok(count(ev3, 'spring') === 1 && ev3.find((e) => e.type === 'spring').kind === shed.win.sites[0].kind, `left alone, the queen from the site with most survivors wakes (${shed.win.sites[0].kind})`);
  const sugar = shed.s.colony.sugar;
  ok(sugar > newColony(true).sugar, `a well wintered queen wakes with more in reserve (${sugar.toFixed(2)} sugar)`);
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
  // walking: the move keys walk camera-relative on the surface; over the edge it crawls round, never falls off.
  // The middle of the table top, walking along it, is clear of arms.
  const table = s4.records.get('0,0').content.boxes[0];
  place(w4, { x: (table.minx + table.maxx) / 2, y: table.maxy + 0.0071, z: (table.minz + table.maxz) / 2 });
  run(s4, 120, () => idle());
  const x0 = w4.x;
  run(s4, 30, () => idle({ yawQ: 0, mx: -100 }));
  ok(w4.state === 'landed' && w4.x > x0 + 0.02 && Math.abs(w4.y - (table.maxy + T.wasp.radius)) < 0.01, `a landed wasp walks across the table (${((w4.x - x0) * 100).toFixed(1)} cm)`);
  ev = run(s4, 1500, () => idle({ yawQ: 0, mx: -100 }));
  ok(count(ev, 'takeoff') === 0 && w4.state === 'landed' && w4.land.ny < -0.99 && w4.y < table.miny,
    `walking over the edge of the table it crawls round, down the side and onto the underside (${w4.state}, normal y ${w4.land.ny.toFixed(2)})`);
  // on the underside the mouse turns it about the surface as on the ground: a quarter turn of yaw is a quarter turn
  {
    const h0 = { x: w4.land.hx, y: w4.land.hy, z: w4.land.hz };
    run(s4, 2, (sim, i) => idle({ yawQ: Math.round(Math.PI / 2 * 1e4) }));
    const L = w4.land, dot = h0.x * L.hx + h0.y * L.hy + h0.z * L.hz;
    ok(Math.abs(dot) < 1e-4 && Math.abs(L.hy) < 1e-6, `upside down, a quarter turn of the mouse turns the heading a quarter turn about the surface (dot ${dot.toFixed(6)})`);
    run(s4, 2, (sim, i) => idle({ yawQ: 0 }));
  }
  // only Space or Shift take off: down, sting with nobody near, and E do not
  ev = run(s4, 30, (sim, i) => idle({ my: -100, sting: i === 3 ? 1 : 0 }));
  ok(w4.state === 'landed' && count(ev, 'takeoff') === 0, 'holding down or stinging the air keeps it on the surface');
  ev = run(s4, 2, (sim, i) => idle({ my: i === 0 ? 100 : 0 }));
  ok(count(ev, 'takeoff') === 1 && w4.state === 'fly', 'Space takes off');
  // upside down: hover still under the table top and it settles on the underside
  place(w4, { x: (table.minx + table.maxx) / 2, y: table.miny - T.wasp.radius - 0.005, z: (table.minz + table.maxz) / 2 + 0.1 });
  run(s4, 120, () => idle());
  ok(w4.state === 'landed' && Math.abs(w4.land.ny + 1) < 1e-6 && Math.abs(w4.y - (table.miny - T.wasp.radius)) < 1e-6, `hovering under the table it lands upside down on the underside (${w4.state}, normal y ${w4.land && w4.land.ny})`);
  ev = run(s4, 2, (sim, i) => idle({ burst: i === 0 ? 1 : 0 }));
  ok(count(ev, 'takeoff') === 1 && w4.state === 'fly' && w4.y < table.miny - T.wasp.radius, 'Shift takes off, pushing away from the underside');
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
  // on the ground, walking into a tree trunk climbs it
  const tree = s4.records.get('0,0').content.trees[0];
  place(w4, { x: tree.x - tree.r - 0.05, y: T.wasp.radius + 0.001, z: tree.z });
  run(s4, 120, () => idle());
  const east = Math.round(Math.PI / 2 * 1e4);
  run(s4, 900, () => idle({ yawQ: east, mz: 100 }));
  ok(w4.state === 'landed' && w4.land.kind === 'bark' && w4.y > 0.1 && Math.abs(Math.hypot(w4.x - tree.x, w4.z - tree.z) - tree.r - T.wasp.radius) < 1e-6,
    `walking into a trunk climbs it (${w4.land && w4.land.kind}, ${(w4.y * 100).toFixed(1)} cm up)`);
  // hovering beside a trunk lands on its side; a flower stalk too
  place(w4, { x: tree.x - tree.r - T.wasp.radius - 0.006, y: 1.2, z: tree.z });
  run(s4, 2, (sim, i) => idle({ my: i === 0 ? 100 : 0 }));
  const hold = (p) => (sim) => { if (w4.state === 'fly') place(w4, p); return idle(); }; // the player holds still there (the wind pushes)
  run(s4, 60, hold({ x: tree.x - tree.r - T.wasp.radius - 0.006, y: 1.2, z: tree.z }));
  ok(w4.state === 'landed' && w4.land.kind === 'bark' && Math.abs(w4.land.ny) < 1e-9, `hovering beside a trunk it lands on the bark (${w4.state} ${w4.land && w4.land.kind} ${w4.land && w4.land.ny})`);
  const fl = s4.activeChunks.flatMap((r) => r.content.flowers).find((f) => f.y > 0.35);
  run(s4, 2, (sim, i) => idle({ my: i === 0 ? 100 : 0 }));
  run(s4, 60, hold({ x: fl.x + T.land.stalkR + T.wasp.radius + 0.004, y: fl.y * 0.5, z: fl.z }));
  ok(w4.state === 'landed' && w4.land.kind === 'stalk', `beside a flower stalk it grips the stalk (${w4.land && w4.land.kind})`);
  // a sting from the bench reaches a leg close by
  {
    const s6 = new Sim({ seed: 1234 }), b6 = s6.records.get('0,0').content.boxes[1], w6 = s6.wasp;
    let spot = null;
    for (const hm of s6.active) {
      if (hm.posture !== 'sit' || spot) continue;
      for (let dx = -0.6; dx <= 0.6 && !spot; dx += 0.004) {
        const p = { x: hm.x + dx, y: b6.maxy + T.wasp.radius, z: (b6.minz + b6.maxz) / 2 };
        if (p.x < b6.minx || p.x > b6.maxx) continue;
        place(w6, p);
        s6._contactQuery(w6); const near = !!w6.contact;
        s6._contactQuery(w6, T.land.stingReach); const reach = !!w6.contact;
        w6.contact = null;
        if (!near && reach) spot = p;
      }
    }
    ok(!!spot, 'a spot on the bench a few centimetres from someone\'s leg');
    place(w6, spot);
    run(s6, 60, () => idle());
    const landed = w6.state;
    const ev6 = run(s6, 3, (sim, i) => idle({ sting: i === 1 ? 1 : 0 }));
    ok(landed === 'landed' && (w6.state === 'attached' || count(ev6, 'blocked') === 1), `landed on the bench, a sting reaches them (${landed} -> ${w6.state})`);
  }
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
    run(t, 1, () => idle({ pick: 1 })); // wake the first queen (T1-15)
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
    t.colony.mated = 200; t.season.startMinute -= 0.71 * t.settings.seasonDays * 1440; run(t, 120); run(t, 1, () => idle({ pick: 1 }));
    // a shed whose wall crack is free (some hold wild bees, T1-9)
    for (const rec of t.activeChunks) { const si = rec.content.sheds.findIndex((sh, i) => !t.feralWall(rec, i)); if (si >= 0 && !ss) ss = { t, sh: rec.content.sheds[si] }; }
  }
  ok(!!ss && ss.t.records.size > 0, 'some chunks near home have a garden shed');
  const sites = shedSites(ss.sh);
  for (const type of ['wall', 'attic']) {
    const t = new Sim({ seed: ss.t.seed });
    t.colony.mated = 200; t.season.startMinute -= 0.71 * t.settings.seasonDays * 1440; run(t, 120); run(t, 1, () => idle({ pick: 1 }));
    const p = sites[type];
    place(t.wasp, { x: p.x + p.nx * 0.05, y: p.y, z: p.z + p.nz * 0.05 });
    ev = run(t, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
    ok(count(ev, 'nestFounded') === 1 && t.nest.site === type && t.colony.maxCells === T.sites[type].maxCells, `E at the ${type === 'wall' ? 'crack in the wall' : 'gap under the eaves'} founds a nest ${T.sites[type].name}`);
  }
}

// 26. Tier 1, batch 1: wind, cold, drowning, clothes by the weather, shaking and flailing
{
  // wind: a pure function of the day, calm at dawn, stronger in the afternoon
  let seed = 1, day0 = null;
  for (; seed < 200; seed++) { const w = dayWeather(BigInt(seed), 0); if (!w.rain && w.wind > 2.2) { day0 = w; break; } }
  const at = (m) => { const v = windAt(BigInt(seed), m); return Math.hypot(v.x, v.z); };
  ok(day0 && at(15 * 60) > at(7 * 60) * 1.5 && at(15 * 60) === at(15 * 60), `wind is calm at dawn and stronger mid-afternoon (${at(7 * 60).toFixed(2)} -> ${at(15 * 60).toFixed(2)} m/s)`);
  // the wasp flies in the moving air: with no input it leans into the wind and holds its place, paying for it like
  // flying; with input it is faster downwind than upwind (GDD 5.3)
  const fly = (y, mz, sign, calm) => {
    const s = new Sim({ seed, birds: false });
    run(s, 1, () => idle());
    if (calm) Object.defineProperty(s, 'wind', { value: { x: 0, z: 0 }, configurable: true });
    const p0 = { x: 40, y, z: 40 }, w = s.wasp; place(w, p0); w.energy = 1;
    const v = windAt(BigInt(seed), s.minute), n = Math.hypot(v.x, v.z), yaw = Math.atan2(sign * v.x, sign * v.z);
    let low = Infinity;
    for (let i = 0; i < 180; i++) { run(s, 1, () => idle({ mz, yawQ: Math.round(yaw * 1e4), pitchQ: 0 })); low = Math.min(low, w.y); }
    return { along: ((w.x - p0.x) * v.x + (w.z - p0.z) * v.z) / n, off: Math.hypot(w.x - p0.x, w.z - p0.z), used: 1 - w.energy, low, wind: n };
  };
  const hold = fly(3, 0, 1, false), calm = fly(3, 0, 1, true), down = fly(3, 100, 1, false), up = fly(3, 100, -1, false);
  ok(hold.off < 0.1, `hovering in a ${hold.wind.toFixed(1)} m/s wind the wasp holds its place (${(hold.off * 100).toFixed(1)} cm off in 3 s)`);
  ok(hold.used > calm.used * 1.2, `holding against the wind costs like flying (${(hold.used * 1000).toFixed(2)} vs ${(calm.used * 1000).toFixed(2)} of the crop in still air)`);
  ok(down.along > up.along * -1 + 1 && down.along / 3 > T.wasp.cruise * 0.9 && -up.along / 3 < T.wasp.cruise * 0.9,
    `flat out it covers ${(down.along / 3).toFixed(2)} m/s downwind and ${(-up.along / 3).toFixed(2)} m/s upwind (cruise ${T.wasp.cruise})`);

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
  const intoCan = (mash, space = false) => {
    const t = new Sim({ seed: 1234, birds: false });
    for (const h of t.active) h.tr = { ...h.tr, style: Style.Freezer }; // nobody at the table swats or covers the cup
    const cup = t.cupsIn(t.records.get('0,0'))[0];
    let fell = false;
    const ev2 = run(t, 9000, (sim, i) => {
      const w = sim._driven();
      if (!w) return idle();
      if (w.state === 'drowning') { fell = true; return idle(space ? { my: mash ? (i % 2) * 100 : 0 } : { burst: mash ? i % 2 : 0 }); }
      if (!fell && (w.state === 'fly' || w.state === 'landed')) { place(w, { x: cup.x, y: cup.level + 0.015, z: cup.z }); w.energy = 0.3; }
      return idle();
    });
    return { fell, ev: ev2 };
  };
  const a = intoCan(false), b = intoCan(true);
  const drowned = a.ev.find((e) => e.type === 'waspDied' && e.driven);
  ok(a.fell && drowned && drowned.cause === 'drowned in a drink', `a wasp feeding at an open can slips in and drowns (${drowned && drowned.cause})`);
  const outAt = b.ev.findIndex((e) => e.type === 'climbedOut'), back = b.ev.slice(outAt).filter((e) => e.type === 'fellIn').length;
  const spc = intoCan(true, true);
  ok(spc.fell && count(spc.ev, 'climbedOut') >= 1, 'mashing Space climbs out too');
  ok(b.fell && outAt >= 0 && back === 0, `mashing burst climbs out of the drink, over the side, and it does not fall back in (${back} times)`);

  // cups are hollow (GDD 7.5): in through the top, feed at the drink, fall in if you touch it; a hand or a lid over
  // the cup shuts you in to drown
  {
    const calm = (x) => { for (const h of x.active) h.tr = { ...h.tr, style: Style.Freezer }; return x; }; // nobody swats or covers
    const t = calm(new Sim({ seed: 1234, birds: false }));
    const rec = t.records.get('0,0'), cup = t.cupsIn(rec)[0], w = t.wasp, C = T.cup;
    ok(cup.level > C.base && cup.level < C.rim, `a cup holds its drink below the rim (level ${((cup.level - C.base) * 100).toFixed(1)} cm of ${((C.rim - C.base) * 100).toFixed(0)})`);
    // from the side the wall stops it
    place(w, { x: cup.x - 0.08, y: (C.base + C.rim) / 2, z: cup.z }); w.vx = 1;
    run(t, 20, () => idle());
    ok(w.x < cup.x - C.r, 'from the side the wall keeps it out');
    // from above it goes in, and feeds hovering just over the drink
    w.energy = 0.3;
    run(t, 40, (sim) => { if (w.state === 'fly') place(w, { x: cup.x, y: cup.level + 0.015, z: cup.z }); return idle(); });
    ok(w.energy > 0.3 && t._inCup(w), `inside the cup it feeds at the drink (crop ${w.energy.toFixed(2)})`);
    // land on the inner wall above the drink, then walk down into it
    place(w, { x: cup.x - (C.r - C.wall - T.wasp.radius - 0.004), y: cup.level + 0.03, z: cup.z });
    run(t, 40, (sim) => { if (w.state === 'fly') place(w, { x: cup.x - (C.r - C.wall - T.wasp.radius - 0.004), y: cup.level + 0.03, z: cup.z }); return idle({ yawQ: 0 }); });
    ok(w.state === 'landed' && w.land.kind === 'cup' && w.land.nx > 0.99, `it grips the inside of the cup (${w.state}, ${w.land && w.land.kind})`);
    const ev = run(t, 120, (sim) => idle({ yawQ: Math.round(Math.PI / 2 * 1e4), mz: w.state === 'landed' ? 100 : 0 })); // a quarter turn on the wall faces down
    ok(count(ev, 'fellIn') === 1 && (w.state === 'drowning' || w.state === 'dead'), `walking down into the drink it falls in (${w.state})`);
    // a lid (level 2): nothing gets in from above
    const t2 = calm(new Sim({ seed: 1234, birds: false })), w2 = t2.wasp, cup2 = t2.cupsIn(t2.records.get('0,0'))[0];
    t2.cs('0,0').esc = 10;
    place(w2, { x: cup2.x, y: C.rim + 0.05, z: cup2.z }); w2.vy = -1;
    run(t2, 30, () => { w2.x = cup2.x; w2.z = cup2.z; return idle({ my: -100 }); }); // pressing down over the middle (the wind would drift it off)
    ok(w2.y >= C.rim && !t2._inCup(w2), `a lidded cup keeps it out (${(w2.y - C.rim) * 1000 | 0} mm above the rim)`);
  }
  {
    // with people at the table: a wasp seen going into a drink gets a hand over the cup, and drowns under it
    const t = new Sim({ seed: 1234, birds: false }), rec = t.records.get('0,0'), w = t.wasp;
    run(t, 3);
    const cup = t.cupsIn(rec).find((cp) => t.active.some((h) => h.state === 'idle' && h.tr.style !== Style.Freezer && Math.hypot(h.x - cp.x, h.z - cp.z) < T.cup.noticeDist * 0.8));
    ok(!!cup, 'a cup within reach of someone at the table');
    const ev = run(t, 900, () => { if (w.state === 'fly') place(w, { x: cup.x, y: cup.level + 0.015, z: cup.z }); return idle(); });
    const died = ev.find((e) => e.type === 'waspDied' && e.driven);
    ok(count(ev, 'cover') >= 1 && count(ev, 'coveredIn') === 1 && died && died.cause === 'drowned under a lid', `someone covers the cup and the wasp inside drowns (${died && died.cause})`);
  }

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
  const spring = () => { const t = new Sim({ seed: 1234 }); t.colony.mated = 200; t.season.startMinute -= 0.71 * t.settings.seasonDays * 1440; run(t, 120); run(t, 1, () => idle({ pick: 1 })); return t; };
  const t = spring();
  // hollows the bees hold are not nest sites (T1-9); the test takes a free one
  const beesIn = (h) => t.activeChunks.some((r) => t.hivesIn(r).some((hv) => hv.feral && Math.hypot(hv.ex - h.x, hv.ez - h.z) < 0.1));
  const hol = t.activeChunks.flatMap((r) => t.sitesIn(r).hollows).filter((h) => !beesIn(h));
  ok(hol.length >= 2 && hol.every((h) => h.t.r >= T.sites.hollowMinR && h.y > 0.6 && h.y < h.t.h), `some thick trees have a hollow in the trunk (${hol.length} near home)`);
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
  s.colony.cool = 0; // a nest with no water to cool it (T2-1)
  ok(hot > 0 && at('attic', hot) < at('wall', hot), `a sunny afternoon (${s.airAt(hot).toFixed(1)} °C) bakes a dry attic nest (${at('attic', hot).toFixed(2)} vs ${at('wall', hot).toFixed(2)} in a wall)`);
  s.colony.cool = 1;
  ok(at('attic', hot) === 1, 'with water fanned over the comb the same attic keeps the brood at full speed');
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

// 32. Worker ages and guards (T1-13): new workers stay in a few days before they forage; the oldest guard the
// entrance, chase off other colonies' wasps and sting the exterminator at the nest
{
  const forage = (young) => { const c = newColony(); c.adults = 100; c.young = young; c.eggs = c.larvae = c.pupae = 0; const s0 = c.sugar; colonyStep(c, 0.01, 0, true, 0.3, 1); return c.sugar - s0; };
  ok(forage(100) < forage(0), `young workers do not forage (sugar ${forage(100).toFixed(3)} with all young, ${forage(0).toFixed(3)} with none)`);
  const c = newColony(); c.adults = 100; c.young = 0; c.eggs = 0; c.larvae = 0; c.pupae = 50; c.sugar = 50;
  for (let i = 0; i < 20; i++) colonyStep(c, 0.05, 0, false, 0.3, 1);
  const em = c.stats.emerged, y1 = c.young;
  c.pupae = 0; c.young = 50;
  for (let i = 0; i < 80; i++) colonyStep(c, 0.05, 0, false, 0.3, 1);
  ok(y1 > em * 0.8 && c.young > 50 * 0.3 && c.young < 50 * 0.45, `emerging workers count as young (${y1.toFixed(1)} of ${em.toFixed(1)} after a day) and grow out of it (50 young, ${c.young.toFixed(1)} after ${T.colony.youngDays} days)`);

  const s = new Sim({ seed: 1234 });
  s.colony.adults = 120;
  const ev = run(s, 900);
  const guards = s._own().filter((w) => w.role === 'guard');
  const e = s.nest.entrance;
  ok(count(ev, 'guardOut') === T.guard.count && guards.length === T.guard.count && guards.every((g) => Math.hypot(g.x - e.x, g.y - e.y, g.z - e.z) < 0.3),
    `${guards.length} guards circle the entrance (${guards.map((g) => Math.hypot(g.x - e.x, g.y - e.y, g.z - e.z).toFixed(2)).join(', ')} m)`);
  const rec = s.activeChunks.find((r) => r.content.rival);
  const rv = s._spawnWasp(false); rv.colony = chunkKey(rec.cx, rec.cz); rv.role = 'sugar'; rv.ai.mode = 'pick';
  place(rv, { x: e.x + 0.3, y: e.y, z: e.z + 0.2 });
  const ev2 = run(s, 600);
  ok(count(ev2, 'guardHunt') >= 1 && count(ev2, 'fight') >= 1 && ev2.some((x) => x.type === 'fightOver'), `a rival wasp at the entrance is chased and grappled (${count(ev2, 'fight')} fights)`);

  const x = new Sim({ seed: 1234 });
  x.colony.adults = 120;
  x.cs(chunkKey(0, 0)).esc = 30;
  x.ext.lead = { x: x.nest.x, z: x.nest.z, nx: x.nest.x, nz: x.nest.z };
  const ev3 = run(x, 9000);
  const hex = (x.ext.hm || {}).hex || ev3.filter((q) => q.type === 'aiAttack').map((q) => q.humanHex)[0];
  ok(ev3.some((q) => q.type === 'aiAttack' && q.humanHex && q.humanHex === hex) && count(ev3, 'extTreat') === 1, 'guards go for the exterminator at the nest');
}

// 34. Seasonal ecology (T1-8): flowers bloom by kind through the season, nectar runs down as wasps sip and as bees
// forage, and regrows; caterpillars early, flies late, carrion now and then; the abstract colony forages the same
{
  const s = new Sim({ seed: 1234, birds: false });
  const at = (frac) => { s.season.startMinute = s.minute - frac * s.settings.seasonDays * 1440; };
  const recs = s.activeChunks.filter((r) => r.content.flowers.length);
  const blooming = (frac) => { at(frac); const k = [0, 0, 0, 0, 0]; for (const r of recs) r.content.flowers.forEach((f, i) => { if (s.inBloom(r, i)) k[f.color]++; }); return k; };
  const early = blooming(0.1), late = blooming(0.85);
  ok(early[0] > 0 && early[4] === 0 && late[0] === 0 && late[4] > 0, `each kind of flower blooms in its own part of the season (early ${early.join('/')}, late ${late.join('/')})`);
  // sip a flower in bloom down to nothing; it regrows
  at(0.5);
  let rec = null, fi = -1;
  for (const r of recs) { const b = s._beeLoad(r); r.content.flowers.forEach((f, i) => { if (fi < 0 && s.inBloom(r, i) && b[i] === 0) { rec = r; fi = i; } }); if (fi >= 0) break; }
  const f = rec.content.flowers[fi], key = chunkKey(rec.cx, rec.cz), w = s.wasp;
  for (const h of s.active) h.tr = { ...h.tr, style: Style.Freezer };
  w.energy = 0.2;
  const n0 = s.nectarAt(rec, fi);
  run(s, 600, () => { if (w.state === 'fly' || w.state === 'landed') place(w, { x: f.x, y: f.y + 0.03, z: f.z }); w.energy = Math.min(w.energy, 0.5); return idle(); });
  const n1 = s.nectarAt(rec, fi), e1 = w.energy;
  run(s, 30, () => { place(w, { x: f.x, y: f.y + 0.03, z: f.z }); return idle(); });
  ok(n0 === 1 && n1 === 0 && w.energy <= e1 + 0.02, `a wasp drinks a flower dry and gets only the trickle that regrows (nectar ${n0} -> ${n1}, crop ${e1.toFixed(3)} -> ${w.energy.toFixed(3)})`);
  s.cs(key).nectar[fi][1] -= 360; // six hours later
  ok(s.nectarAt(rec, fi) > 0.5, `the flower refills over the day (${s.nectarAt(rec, fi).toFixed(2)} after six hours)`);
  // a flower the local bees work stays low
  let bee = null;
  for (const r of s.activeChunks) { const b = s._beeLoad(r); b.forEach((n, i) => { if (!bee && n * T.eco.beeDrawPerDay > T.eco.regenPerDay && s.inBloom(r, i)) bee = { r, i, n }; }); }
  ok(!bee || s.nectarAt(bee.r, bee.i) < 0.2, `flowers the bees work stay drained (${bee ? `${bee.n} bees, nectar ${s.nectarAt(bee.r, bee.i).toFixed(2)}` : 'no such flower here'})`);
  // prey by season
  const prey = (frac) => { at(frac); let cats = 0, flies = 0; for (const r of s.activeChunks) { r.content.caterpillars.forEach((c, i) => { if (s.catActive(r, i)) cats++; }); r.content.flies.forEach((c, i) => { if (s.flyActive(r, i)) flies++; }); } return { cats, flies }; };
  const p1 = prey(0.4), p2 = prey(0.95);
  ok(p1.cats > 0 && p2.cats === 0 && p2.flies > p1.flies, `caterpillars in early summer, more flies late (caterpillars ${p1.cats} -> ${p2.cats}, flies ${p1.flies} -> ${p2.flies})`);
  const a1 = (at(0.5), s.ecoAvail()), a2 = (at(0.97), s.ecoAvail());
  ok(a2.sugar < a1.sugar && a2.protein < a1.protein, `the abstract foragers find less late in the season (sugar ${a1.sugar.toFixed(2)} -> ${a2.sugar.toFixed(2)}, protein ${a1.protein.toFixed(2)} -> ${a2.protein.toFixed(2)})`);
  // carrion
  let cr = null, crRec = null;
  for (let d = 0; d < 30 && !cr; d++) { s.day = d; for (const r of s.activeChunks) { const l = s.carrionIn(r); if (l.length) { cr = l[0]; crRec = r; break; } } }
  ok(!!cr, `carrion turns up now and then (day ${s.day})`);
  const w2 = s.wasp; w2.carry = null; w2.state = 'fly';
  place(w2, { x: cr.x, y: cr.y + 0.02, z: cr.z });
  const ev = run(s, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
  const left = s.carrionIn(crRec).find((x) => x.d === cr.d);
  ok(w2.carry && w2.carry.what === 'carrion' && (left ? left.left : 0) === cr.left - 1, `E at the carcass takes a load of meat (${w2.carry && w2.carry.what}, ${left ? left.left : 0} left)`);
}

// 35. Feral hives and robbing (T1-9): wild colonies in hollow trees and shed walls; E at any hive entrance goes in,
// a few seconds (faster mashing sting) grab honey and brood while the bees inside may kill you; a hive gives a few
// loads a day and comes out alarmed; short of sugar, AI foragers rob too
{
  const s = new Sim({ seed: 1234, birds: false });
  const wild = []; for (const r of s.activeChunks) s.hivesIn(r).forEach((hv, h) => { if (hv.feral) wild.push({ r, hv, h, key: chunkKey(r.cx, r.cz) }); });
  ok(wild.length >= 2 && wild.every((x) => x.hv.bees.length === T.feral.guards + T.feral.foragers), `wild bee colonies live in hollow trees and shed walls near home (${wild.length})`);
  ok(!s.hiberSites().some((x) => wild.some((y) => Math.hypot(x.x - y.hv.x, x.z - y.hv.z) < 0.05)), 'a hollow or a wall crack that bees hold is not a winter site');
  const kill = T.feral.insideKill;
  T.feral.insideKill = 0;
  const { hv, h, key } = wild[0], w = s.wasp;
  const rob = (mash) => { // until it comes out
    w.carry = null; w.energy = 0.3; w.state = 'fly'; place(w, { x: hv.ex, y: hv.ey, z: hv.ez });
    const ev = [];
    for (let i = 0; i < 400; i++) { ev.push(...run(s, 1, () => idle({ act: i === 1 ? Act.Interact : 0, sting: mash && i % 2 }))); if (i > 2 && w.state !== 'robbing') break; }
    return ev;
  };
  let ev = rob(true);
  const done = ev.find((e) => e.type === 'robbed'), start = ev.find((e) => e.type === 'robStart');
  ok(start && done && done.t - start.t < T.feral.robSecs * 60, `E at the entrance goes in, and mashing sting grabs faster (${done && start ? ((done.t - start.t) / 60).toFixed(1) : '-'} s)`);
  ok(w.carry && w.carry.what === 'bee brood' && w.energy === 1 && s.hiveAlarms.has(key + '#' + h), 'out with honey in the crop and a larva, into an alarmed hive');
  for (let k = 1; k < T.feral.loadsPerDay; k++) rob(true);
  ev = rob(true);
  ok(count(ev, 'hiveEmpty') === 1 && !w.carry, `a hive gives ${T.feral.loadsPerDay} loads a day, then nothing`);
  w.carry = null; w.state = 'fly'; place(w, { x: hv.ex, y: hv.ey, z: hv.ez });
  ev = run(s, 30, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0, burst: i === 20 ? 1 : 0 }));
  ok(count(ev, 'robAbort') === 1 && w.state !== 'robbing' && !w.carry, 'Shift bails out empty-handed');
  T.feral.insideKill = 1000;
  const s2 = new Sim({ seed: 1234, birds: false }), w2 = s2.wasp;
  place(w2, { x: hv.ex, y: hv.ey, z: hv.ez });
  ev = run(s2, 10, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
  const died = ev.find((e) => e.type === 'waspDied');
  ok(died && died.cause === 'stung inside a hive', `the bees inside can kill a robber (${died && died.cause})`);
  T.feral.insideKill = kill;
  // AI foragers rob when the colony is short of sugar
  const s3 = new Sim({ seed: 1234, birds: false });
  s3.colony.deficit = 0.9;
  let picks = 0;
  for (let k = 0; k < 40; k++) { const a = s3._spawnWasp(false); a.role = 'sugar'; place(a, { x: hv.ex + 0.5, y: hv.ey, z: hv.ez }); s3._aiPick(a); if (a.ai.target && a.ai.target.kind === 'hive') picks++; }
  ok(picks > 0, `short of sugar, AI foragers go for hives (${picks} of 40 near one)`);
}

// Senses for AI wasps (GDD 7.3, T1-16): food by scent, prey by sight, finds remembered and shared at the nest
{
  const s = new Sim({ seed: 1234, birds: false });
  run(s, 1, () => idle());
  const still = { x: 0, z: 0 };
  Object.defineProperty(s, 'wind', { value: still, writable: true, configurable: true });
  const S = T.sense, jit = S.jitter;
  S.jitter = 0;
  s.colony.deficit = 0; // no cans, traps or hives: sugar is flowers only, early in the season no fruit
  const rec = s.activeChunks[4], key = chunkKey(rec.cx, rec.cz), fi = s._flowerIdx(rec);
  const fl = rec.content.sugar.map((x, i) => ({ x, i })).filter(({ x, i }) => x.kind === 'flower' && s.inBloom(rec, fi[i]))[0];
  s.nectarAt = (r, j) => (r === rec && j === fi[fl.i] ? 1 : 0); // this flower alone has nectar
  const a = s._spawnWasp(false); a.role = 'sugar';
  const R = S.smell * S.flower;
  place(a, { x: fl.x.x, y: fl.x.y + 0.9 * R, z: fl.x.z });
  const t1 = s._sense(a);
  place(a, { x: fl.x.x, y: fl.x.y + 1.1 * R, z: fl.x.z });
  const t2 = s._sense(a);
  ok(t1 && t1.kind === 'sugar' && t1.key === key && t1.i === fl.i && !t2, `a flower is smelled within its reach (${R.toFixed(1)} m in still air) and not beyond`);
  s.wind = { x: S.windRef, z: 0 };
  const dn = s._scentRange({ x: fl.x.x + 5, z: fl.x.z }, fl.x, 1), up = s._scentRange({ x: fl.x.x - 5, z: fl.x.z }, fl.x, 1);
  ok(Math.abs(dn - S.smell * (1 + S.downwind)) < 1e-9 && Math.abs(up - S.smell * (1 - S.downwind)) < 1e-9, `scent carries downwind (${dn.toFixed(1)} m) and hardly upwind (${up.toFixed(1)} m)`);
  s.wind = still;
  // sight: a fly ahead is seen, one behind is not
  const p = s._spawnWasp(false); p.role = 'protein';
  const fly = rec.content.flies.map((f, i) => ({ f, i })).find(({ i }) => s.flyActive(rec, i));
  const fp = flyPos(fly.f, s.tick);
  place(p, { x: fp.x + 3, y: fp.y, z: fp.z }); p.vx = -2;
  const seen = s._sense(p);
  p.vx = 2;
  const unseen = s._sense(p);
  ok(seen && seen.sub === 'fly' && !(unseen && unseen.sub === 'fly'), `a fly 3 m ahead is seen; flying away, it is not (${unseen ? unseen.sub || unseen.kind : 'nothing'} instead)`);
  // site fidelity and the scent of food brought home
  const n = s.nest.entrance, tgt = { kind: 'sugar', key, i: fl.i, c: 4 };
  place(a, n); a.ai.from = tgt; a.ai.cargo = 0.9; a.energy = 1;
  s._nestTouch(a);
  ok(a.ai.known && a.ai.known.t === tgt && s.homeScent && s.homeScent.t === tgt, 'a forager home with food remembers its source, and the colony smells it on her');
  const b = s._spawnWasp(false); b.role = 'sugar'; place(b, n);
  s._aiPick(b);
  ok(b.ai.mode === 'outbound' && b.ai.target.i === fl.i && b.ai.target.key === key, 'a nestmate leaving next goes for that source');
  s.homeScent = null;
  delete s.nectarAt;
  // nothing in reach: a spiral search round the nest that ends at home
  const smell = S.smell; S.smell = 0.01;
  const c = s._spawnWasp(false); c.role = 'sugar'; place(c, n); c.state = 'fly';
  s._aiPick(c);
  const searching = c.ai.mode === 'search';
  let far = 0, inner = Infinity;
  for (let i = 0; i < 900 && c.ai.mode === 'search'; i++) {
    run(s, 1, () => idle());
    const d = Math.hypot(c.x - n.x, c.z - n.z);
    far = Math.max(far, d); if (i > 300) inner = Math.min(inner, d);
  }
  ok(searching && far > S.searchR0 + 0.5 * S.ringStep && far < S.searchRange && inner > S.searchR0, `with nothing in reach a forager searches in a widening spiral round the nest (out to ${far.toFixed(1)} m in 15 s)`);
  S.smell = smell;
  const ev = run(s, 900, () => idle());
  ok(ev.some((e) => e.type === 'aiFound' && e.id === c.id) || c.ai.mode !== 'search', `with its nose back it finds food on the way round (${c.ai.mode})`);
  // alarm pheromone fades
  const al = { x: n.x, y: n.y, z: n.z, until: s.tick + T.alarm.ticks, killerHex: '' };
  const fresh = s._alarmReach(a, al); al.until = s.tick + 1; const old = s._alarmReach(a, al);
  ok(Math.abs(fresh - T.alarm.radius) < 1e-9 && old < 0.51 * T.alarm.radius, `alarm pheromone reaches ${fresh} m fresh and half that as it fades`);
  S.jitter = jit;
}

// Barbecues (GDD 4.3, 6.2, T1-10): grills at some tables, a cook, meat on the grate and the plate, heat, guarding
{
  const s = new Sim({ seed: 7, birds: false });
  run(s, 1, () => idle());
  const jump = (m) => { s.clockOffset += (m - s.minute) * s.tpm; s._minute(clockMinutes(s.tick + s.clockOffset, s.settings)); };
  let rec = null, g = null;
  for (const r of s.activeChunks) if (!g && s.grillsIn(r).length) { rec = r; g = s.grillsIn(r)[0]; }
  const tb = rec && rec.content.tables[g.ti];
  ok(g && Math.hypot(g.x - tb.x, g.z - tb.z) > 1.5 && Math.hypot(g.x - tb.x, g.z - tb.z) < 2.5 && rec.content.humans.some((h) => h.posture === 'sit' && Math.hypot(h.x - tb.x, h.z - tb.z) < 1.3),
    `some picnic tables have a grill at one end (${s.activeChunks.reduce((n, r) => n + s.grillsIn(r).length, 0)} of ${s.activeChunks.reduce((n, r) => n + r.content.tables.length, 0)} tables)`);
  // the next barbecue day
  let day = -1;
  const d0 = s.day;
  for (let d = d0 + 1; d < d0 + 40 && day < 0; d++) { s.day = d; g._d = null; if (s._bbqDay(rec, g)) day = d; }
  s.day = d0; g._d = null;
  ok(day > 0, `a warm dry day with the cook about brings a barbecue (day ${day})`);
  jump(day * 1440 + g._from - 240);
  const cook = s.humanByHex(g.cook);
  let atGrill = false, grillMeat = false, plate = false, lit = false;
  const ev = [];
  for (let i = 0; i < 4000 && !(plate && atGrill); i++) {
    ev.push(...run(s, 1, () => idle()));
    lit = lit || s.bbqLit(rec, g);
    if (cook.state === 'cook' && Math.hypot(cook.x - g.sx, cook.z - g.sz) < 0.01) atGrill = true;
    const m = s.meatIn(rec);
    if (m.some((x) => x.hot)) grillMeat = true;
    if (m.some((x) => !x.hot)) plate = true;
  }
  ok(lit && atGrill && cook.posture === 'stand' && count(ev, 'cookStart') >= 1, 'the cook leaves the table and stands at the lit grill');
  ok(grillMeat && plate, 'meat sits on the grate, and later on a plate on the table');
  // E at the plate takes a load of meat
  const w = s.wasp, pm = s.meatIn(rec).find((x) => !x.hot);
  place(w, { x: pm.x, y: pm.y + 0.01, z: pm.z }); w.state = 'fly'; w.carry = null;
  run(s, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 }));
  ok(w.carry && w.carry.what === 'meat' && w.carry.kind === 'protein' && s.meatIn(rec).find((x) => x.i === pm.i).left === pm.left - 1, `E at the plate takes meat (${w.carry && w.carry.what}, ${pm.left - 1} left)`);
  // people at the table slap at a wasp by the meat, at any alert level
  const pm2 = s.meatIn(rec).find((x) => !x.hot);
  let guard = [];
  for (let i = 0; i < 600 && pm2 && !guard.some((e) => e.type === 'preSwat' && e.why === 'meat'); i++) {
    const wd = s._driven(); if (!wd) break;
    place(wd, { x: pm2.x + 0.1, y: pm2.y + 0.05, z: pm2.z }); wd.state = 'fly';
    guard.push(...run(s, 1, () => idle()));
  }
  ok(guard.some((e) => e.type === 'preSwat' && e.why === 'meat'), `a wasp hanging over the plate gets slapped at (level ${s.escLevel(chunkKey(rec.cx, rec.cz))})`);
  // the grate burns, the air over it cooks
  const s2 = new Sim({ seed: 7, birds: false }); run(s2, 1, () => idle());
  const r2 = s2.records.get(chunkKey(rec.cx, rec.cz)), g2 = s2.grillsIn(r2)[0];
  const jump2 = (m) => { s2.clockOffset += (m - s2.minute) * s2.tpm; s2._minute(clockMinutes(s2.tick + s2.clockOffset, s2.settings)); };
  jump2(day * 1440 + 600); s2._bbqDay(r2, g2);
  jump2(day * 1440 + g2._from + 10);
  const w2 = s2.wasp;
  place(w2, { x: g2.x, y: T.bbq.grateY + T.wasp.radius + 0.004, z: g2.z }); w2.state = 'fly';
  let e2 = run(s2, 3, () => idle());
  const burned = e2.find((e) => e.type === 'waspDied');
  ok(s2.bbqLit(r2, g2) && burned && burned.cause === 'burned on a grill', `touching a lit grate burns (${burned && burned.cause})`);
  run(s2, 200, () => idle());
  const w3 = s2._driven() || s2.wasp;
  place(w3, { x: g2.x + 0.05, y: T.bbq.grateY + 0.12, z: g2.z }); w3.state = 'fly'; w3.bodyT = 30;
  for (const hm of s2.active) hm.cooldown = Infinity; // nobody swats: the heat alone
  e2 = [];
  for (let i = 0; i < 600 && !e2.some((e) => e.type === 'waspDied'); i++) { w3.x = g2.x + 0.05; w3.y = T.bbq.grateY + 0.12; w3.z = g2.z; w3.vx = w3.vy = w3.vz = 0; e2.push(...run(s2, 1, () => idle())); }
  const cooked = e2.find((e) => e.type === 'waspDied');
  ok(cooked && cooked.cause === 'cooked over a grill', `hanging in the hot air over it cooks a wasp (${cooked && cooked.cause} in ${(e2.length && cooked ? (cooked.t - e2[0].t) / 60 : 0).toFixed(1)} s)`);
  // AI hunters smell the meat from far off
  const a = s._spawnWasp(false); a.role = 'protein';
  place(a, { x: g.x + 12, y: 1.5, z: g.z });
  const T0 = T.sense.jitter; T.sense.jitter = 0;
  const t = s._sense(a); T.sense.jitter = T0;
  ok(t && t.sub === 'meat', `barbecue meat draws a hunter from 12 m (${t ? t.sub || t.kind : 'nothing'})`);
}

// Regions (GDD 4.2, 4.3, T1-12): an 8x8 chunk layout under the chunk pass; suburban yards; pulp that runs out
{
  const uses = {};
  for (let z = -4; z < 4; z++) for (let x = -4; x < 4; x++) { const u = landUse(1234n, x, z); uses[u] = (uses[u] || 0) + 1; }
  ok(landUse(1234n, 0, 0) === 'park' && [-4, -1, 1, 3].every((x) => landUse(1234n, x, 0) === 'park') && uses.yards >= 40 && uses.mall === 3 && uses.forest >= 3,
    `the home region: a park strip through home, a strip mall, a forest corner, yards everywhere else (${Object.entries(uses).map(([k, n]) => k + ' ' + n).join(', ')})`);
  let yx = 0, yz = 1;
  const c = generateChunk(1234n, yx, yz);
  const houses = c.sheds.filter((h) => h.house), fences = c.boxes.filter((b) => b.fence);
  ok(c.use === 'yards' && houses.length >= 2 && fences.length >= 30 && c.roads.length === 1 && houses.every((h) => c.boxes.some((b) => b.shed && !b.wood && b.minx === h.x - h.hw)),
    `a yards chunk: a street, ${houses.length} houses, backyard fences in ${fences.length} sections, ${c.tables.length} patio tables`);
  // a street ends in a cul-de-sac where the next chunk is not yards
  let loop = null;
  for (let x = -4; x < 4 && !loop; x++) for (let z = -4; z < 4 && !loop; z++) {
    if (landUse(1234n, x, z) !== 'yards') continue;
    const k = generateChunk(1234n, x, z);
    if (landUse(1234n, x + 1, z) !== 'yards') loop = { k, x, z };
  }
  ok(loop && loop.k.loops.length >= 1 && loop.k.roads[0].maxx < loop.x * 64 + 32, 'a street that meets a park, a mall or the woods ends in a cul-de-sac');
  // houses block the view between people on either side (GDD 8.9)
  const s = new Sim({ seed: 1234, birds: false });
  run(s, 1, () => idle());
  const rec = s.records.get(chunkKey(yx, yz)), h = rec.content.sheds.find((q) => q.house);
  ok(!s.canSee({ x: h.x, z: h.z - h.hd - 2 }, { x: h.x, z: h.z + h.hd + 2 }) && s.canSee({ x: h.x + h.hw + 3, z: h.z - h.hd - 2 }, { x: h.x + h.hw + 3, z: h.z + h.hd + 2 }), 'a house blocks the view across it; the gap beside it does not');
  // a fence section holds so much pulp, then it is stripped
  const key = chunkKey(yx, yz), fi = rec.content.boxes.findIndex((b) => b.fence), fb = rec.content.boxes[fi], loads = s.pulpLoads(fb);
  const w = s.wasp;
  let got = 0;
  for (let k = 0; k < loads + 2; k++) {
    place(w, { x: fb.maxx + T.wasp.radius + 0.005, y: 0.8, z: (fb.minz + fb.maxz) / 2 }); w.state = 'fly'; w.carry = null; w.energy = 1;
    const ev = run(s, T.pulp.chewTicks + 4, (sim, i) => idle({ act: Act.Interact }));
    if (ev.some((e) => e.type === 'chewed' && e.id === w.id)) got++;
    run(s, 2, () => idle());
  }
  ok(got === loads && s.pulpLeft(key, fi) === 0 && !s._woodNear({ x: fb.maxx + T.wasp.radius + 0.005, y: 0.8, z: (fb.minz + fb.maxz) / 2 }), `a ${(Math.max(fb.maxx - fb.minx, fb.maxz - fb.minz)).toFixed(1)} m fence section gives ${got} loads of pulp, then it is stripped bare`);
  const r2 = restore(snapshot(s));
  ok(r2.pulpLeft(key, fi) === 0, 'a stripped fence stays stripped after save and restore (a chunk delta)');
  const a = s._spawnWasp(false); a.role = 'pulp';
  place(a, { x: fb.maxx + 0.3, y: 1, z: (fb.minz + fb.maxz) / 2 });
  s._aiPick(a);
  ok(a.ai.target && a.ai.target.kind === 'wood' && !(a.ai.target.key === key && a.ai.target.i === fi), 'pulp foragers go past a stripped section to wood that has some left');
}

// Human days (GDD 8.2, 8.3, T1-11): people stroll the streets and the park, sunbathe on lawns and work their beds,
// and the weather decides who comes out
{
  const acts = {};
  let pathsOk = true;
  for (let z = -4; z < 4; z++) for (let x = -4; x < 4; x++) for (const h of generateChunk(1234n, x, z).humans) {
    if (!h.act) continue;
    acts[h.act] = (acts[h.act] || 0) + 1;
    if (h.act === 'sun' ? h.posture !== 'lie' || h.path : h.posture !== 'stand' || !h.path || h.path.length < 4 || h.path.length % 2) pathsOk = false;
  }
  ok(acts.stroll >= 10 && acts.garden >= 10 && acts.sun >= 10 && pathsOk, `the home region has strollers, gardeners and sunbathers (${Object.entries(acts).map(([k, n]) => k + ' ' + n).join(', ')})`);
  // lying down: the standing body turned onto its back, head toward the facing, just above the grass
  const lie = { x: 3, z: -2, fx: 0.6, fz: 0.8, posture: 'lie', parts: humanParts(humanTraits(7n, 77n)) };
  const p = { x: 0.13, y: 1.2, z: -0.05 }, back = toLocal(lie, toWorld(lie, p));
  const head = toWorld(lie, lie.parts.lie[0].a), foot = toWorld(lie, lie.parts.lie.find((q) => q.name === 'ShinL').b);
  const n = dirToWorld(lie, { x: 0, y: 0, z: 1 });
  ok(Math.abs(back.x - p.x) + Math.abs(back.y - p.y) + Math.abs(back.z - p.z) < 1e-12 && Math.abs(n.y - 1) < 1e-12, 'the lying frame goes to the world and back, and the body front faces the sky');
  ok(head.y < 0.5 && foot.y < 0.5 && (head.x - foot.x) * lie.fx + (head.z - foot.z) * lie.fz > 1.2, `a sunbather lies full length along the facing (head ${head.y.toFixed(2)} m up)`);
  // the weather
  const s = new Sim({ seed: 1234, dayMinutes: 20 }, { noAI: true });
  const win = { arrive: 480, leave: 1200 }, at = (d, a) => { s.day = d; return s._actWindow(a, win); };
  ok(['stroll', 'garden', 'sun'].every((a) => at(8, a) === null), 'nobody strolls, gardens or sunbathes on a rainy day');
  let mild = 1;
  while (dayWeather(s.seed, mild).rain || s.airAt(mild * 1440 + 780) < T.days.gardenTemp || s.airAt(mild * 1440 + 780) >= T.days.sunTemp) mild++;
  ok(at(mild, 'sun') === null && at(mild, 'garden') !== null, `a dry, mild day (${s.airAt(mild * 1440 + 780).toFixed(1)} °C) brings out gardeners but no sunbathers`);
  const w2 = at(2, 'sun');
  ok(w2 && w2.arrive === T.days.sunFrom && w2.leave === T.days.sunTo, `on a hot day sunbathers lie out through the warm hours (${w2 && w2.arrive}-${w2 && w2.leave})`);
  s.day = 0;
  // out and about
  const track = new Map();
  run(s, 3);
  for (let t = 0; t < 6000; t++) {
    s.step(idle()); s.drainEvents();
    if (t % 30) continue;
    for (const hm of s.active) {
      if (!hm.home.act) continue;
      const r = track.get(hm.hex) || { hm, moved: 0, wps: new Set(), dwell: 0, lie: 0, x: hm.x, z: hm.z };
      r.moved += Math.hypot(hm.x - r.x, hm.z - r.z); r.x = hm.x; r.z = hm.z;
      if (hm.state === hm.home.act) r.wps.add(hm.wp);
      if (hm.state === 'garden' && !hm.walking) r.dwell++;
      if (hm.state === 'idle' && hm.posture === 'lie') r.lie++;
      track.set(hm.hex, r);
    }
  }
  const all = [...track.values()], of = (a) => all.filter((r) => r.hm.home.act === a);
  ok(of('stroll').some((r) => r.moved > 60 && r.wps.size >= 3), `strollers walk their loops (${of('stroll').map((r) => r.moved.toFixed(0) + ' m').join(', ')})`);
  ok(of('garden').some((r) => r.dwell > 0 && r.wps.size >= 2), 'gardeners stop and work a spot, then move to the next');
  const sun = of('sun').find((r) => r.lie > 0);
  ok(!!sun && sun.moved < 1e-9, `sunbathers lie still on their towels (${of('sun').length} out)`);
  // a stung stroller runs, comes back and walks on
  const st = of('stroll').map((r) => r.hm).find((h) => h.state === 'stroll');
  s._applyCommit({ type: 'sting', peer: s.peer, humanHex: st.hex, panicGain: 0, driven: false, sx: st.x - st.fx, sz: st.z - st.fz, zone: 0, flee: true, waspId: 0 });
  ok(st.state === 'flee', 'a stroller who is stung runs');
  let back2 = false;
  for (let t = 0; t < 3000 && !back2; t++) { s.step(idle()); s.drainEvents(); back2 = st.state === 'stroll'; }
  ok(back2, 'and once calm, walks on');
  // a wasp can reach a sunbather
  if (sun) {
    const hm = sun.hm, w = s.wasp; place(w, toWorld(hm, { x: 0.3, y: 1.0, z: 0.6 }));
    const pt = s._aiStingPoint(w, hm), wp = pt && toWorld(hm, pt.p);
    ok(wp && wp.y < 0.6 && Math.hypot(wp.x - hm.x, wp.z - hm.z) < 2, 'there is skin to sting on a sunbather, low on the lawn');
  }
}

// Water (GDD 6.2, T2-1): birdbaths and puddles, loads of water carried home, a hot nest cooled by water
{
  let baths = 0, yb = 0;
  for (let z = -4; z < 4; z++) for (let x = -4; x < 4; x++) { const c = generateChunk(1234n, x, z); baths += c.baths.length; if (c.use === 'yards') yb += c.baths.length; }
  const home = generateChunk(1234n, 0, 0);
  ok(home.baths.length === 1 && baths >= 30 && yb >= 20 && home.cylinders.some((q) => q.bath && !q.wood), `birdbaths in backyards and parks (${baths} in the home region, ${yb} in yards, one in the home park), solid but not wood`);
  // puddles from a little after rain starts until hours after it stops
  const s = new Sim({ seed: 1234, birds: false, dayMinutes: 20 }, { noAI: true });
  run(s, 2);
  let rd = 1; while (!dayWeather(s.seed, rd).rain) rd++;
  const w0 = dayWeather(s.seed, rd), t0 = rd * 1440;
  const rec = s.records.get('0,1');
  const ps = s.puddlesIn(rec, rd);
  ok(s.puddleDay(t0 + w0.rainStart - 1) < 0 && s.puddleDay(t0 + w0.rainStart + T.water.wetAfter) === rd && s.puddleDay(t0 + w0.rainEnd + T.water.dryMinutes - 1) === rd && s.puddleDay(t0 + w0.rainEnd + T.water.dryMinutes) < 0,
    `puddles lie from ${T.water.wetAfter} min after the rain starts until ${T.water.dryMinutes / 60} h after it stops (day ${rd})`);
  ok(ps.length > 0 && ps.every((p) => rec.content.roads.concat(rec.content.lots).some((r) => p.x >= r.minx && p.x <= r.maxx && p.z >= r.minz && p.z <= r.maxz)) && ps.every((p) => !rec.content.boxes.some((b) => p.x > b.minx && p.x < b.maxx && p.z > b.minz && p.z < b.maxz)),
    `in a yards chunk they lie on the street (${ps.length} puddles), never under anything`);
  // the player takes a load from the home park's bath and delivers it
  const b = home.baths[0], w = s.wasp;
  const hint = () => { place(w, { x: b.x + 0.05, y: b.h + T.wasp.radius + 0.004, z: b.z }); w.state = 'fly'; w.carry = null; };
  hint(); run(s, 1, () => idle());
  ok(s.hint.water && !s.hint.wood, 'over a birdbath the wasp can take water, and it is not wood');
  let ev = run(s, T.water.fillTicks + 2, () => { if (w.state === 'fly') place(w, { x: b.x + 0.05, y: b.h + T.wasp.radius + 0.004, z: b.z }); return idle({ act: Act.Interact }); });
  ok(w.carry && w.carry.kind === 'water' && count(ev, 'watered') === 1, `holding E for ${T.water.fillTicks / 60} s at the water takes a load`);
  const before = s.colony.water;
  place(w, s.nest.entrance); ev = run(s, 2, () => idle());
  ok(!w.carry && s.colony.stats.deposited.water === 1 && ev.some((e) => e.type === 'deposit' && e.what === 'water'), `delivered at the nest it goes into the store (${before.toFixed(2)} -> ${s.colony.water.toFixed(2)})`);
  // the colony: a hot nest drinks its store; without water the heat slows the brood and past the lethal heat cooks it
  const hotRun = (water) => {
    const c = newColony(); c.water = water;
    const brood0 = c.eggs + c.larvae + c.pupae;
    for (let i = 0; i < 120; i++) { if (water) c.water = 50; colonyStep(c, 1 / 120, 0, false, 0.3, 0.2, 1, null, { heat: 1, cook: 1 }); }
    return { c, lost: c.stats.cooked, brood0 };
  };
  const wet = hotRun(50), dry = hotRun(0);
  ok(wet.c.cool > 0.99 && wet.lost === 0 && dry.c.cool < 0.05 && dry.lost > dry.brood0 * 0.2, `a day of lethal heat: with water the comb stays cool and no brood is lost; dry, ${dry.lost.toFixed(0)} of ${dry.brood0} brood cook`);
  const fed = (heat, water) => { const c = newColony(); c.water = water; c.sugar = 0; c.protein = 0; colonyStep(c, 0.01, 0, true, 0.3, 0.2, 1, null, { heat, cook: 0 }); return c; };
  const cool = fed(0, 0), thirsty = fed(1, 0);
  ok(thirsty.cool > 0.8 && thirsty.sugar < cool.sugar && thirsty.thirst > 0.9, // it drank what they brought: cool would fall to 0.8 with none
     `a hot nest with an empty store sends foragers for water at the cost of food (sugar ${thirsty.sugar.toFixed(3)} vs ${cool.sugar.toFixed(3)})`);
  // an AI water carrier
  const a = new Sim({ seed: 1234, birds: false }, { noAI: true });
  run(a, 2);
  const c = a._spawnWasp(false); c.role = 'water';
  let got = null;
  for (let i = 0; i < 4000 && !got; i++) { a.step(idle()); for (const e of a.drainEvents()) if (e.type === 'deposit' && e.id === c.id && e.what === 'water') got = e; if (!a.wasps.includes(c)) break; }
  ok(!!got, 'a water carrier flies to the water, drinks a load and brings it home');
}

// Extreme weather (GDD 5.3, T2-2): heatwaves, cold snaps, storms
{
  const X = T.extreme, days = [...Array(600).keys()].map((d) => dayWeather(1234n, d));
  const kinds = {}; for (const w of days) kinds[w.kind] = (kinds[w.kind] || 0) + 1;
  const runs = (k) => { const out = []; let n = 0; for (const w of days) { if (w.kind === k) n++; else if (n) { out.push(n); n = 0; } } return out; };
  const hr = runs('heat'), cr = runs('cold'), heat = days.filter((w) => w.kind === 'heat'), storms = days.filter((w) => w.kind === 'storm');
  ok(days[0].kind === 'normal' && hr.length >= 3 && cr.length >= 3 && storms.length >= 10 && hr.every((n) => n >= X.heatLen[0]) && cr.every((n) => n >= X.coldLen[0]),
    `spells run for days: ${hr.length} heatwaves (${hr.join(', ')} days), ${cr.length} cold snaps (${cr.join(', ')}), ${storms.length} storms in ${days.length} days; the first day is always ordinary`);
  ok(heat.every((w) => !w.rain && w.base >= T.weather.baseMin + X.heatBoost - 1e-9) && storms.every((w) => w.rain && w.pour === X.pour && w.wind >= X.stormWind[0] && w.rainStart >= 13 * 60),
    'a heatwave is dry and hot from the start; a storm is an afternoon downpour in a gale');
  // in a storm's downpour a wasp in the open is knocked down; under a table it is not
  const sd = storms[0], s = new Sim({ seed: 1234, birds: false, dayMinutes: 20 }, { noAI: true }); // long days: the downpour lasts the test
  run(s, 2);
  const into = (m) => { const d = s._driven(); if (d) d.born = m; s.clockOffset += (m - s.minute) * s.tpm; run(s, 1); }; // jumped there young
  into(sd.day * 1440 + sd.rainStart + 10);
  const tb = s.records.get('0,0').content.tables[0], w = s.wasp;
  const knocks = (p, n) => {
    let k = 0;
    run(s, n, () => { if (!s.wasp) return idle(); if (s.wasp.state !== 'stunned') { place(s.wasp, p); s.wasp.state = 'fly'; s.wasp.energy = 1; s.wasp.bodyT = 30; s.wasp.born = s.minute; } return idle({ mz: 0 }); })
      .forEach((e) => { if (e.type === 'knockedDown') k++; });
    return k;
  };
  const open = knocks({ x: tb.x + 6, y: 1.5, z: tb.z + 6 }, 1200), under = knocks({ x: tb.x, y: 0.35, z: tb.z }, 1200);
  ok(s.raining && s.weatherToday.kind === 'storm' && open >= 3 && under === 0, `a downpour knocks a wasp in the open out of the air (${open} times in 20 s); under a table it is sheltered`);
  // the storm's gale carries off a wasp that would hold its place in a breeze
  const kp = X.knockPerSec; X.knockPerSec = 0;
  if (s.wasp) { place(s.wasp, { x: tb.x + 8, y: 3, z: tb.z + 8 }); s.wasp.state = 'fly'; }
  const p0 = { x: s.wasp.x, z: s.wasp.z };
  run(s, 180, () => idle({ mz: 0 }));
  X.knockPerSec = kp;
  const moved = Math.hypot(s.wasp.x - p0.x, s.wasp.z - p0.z);
  ok(moved > 2, `the gale carries a hovering wasp off (${moved.toFixed(1)} m in 3 s)`);
  // flying in a heatwave costs more
  // a world whose first summer has a hot heatwave
  let hs = 1n, hd = null;
  for (; hs < 200n && !hd; hs++) for (let d = 2; d < 30 && !hd; d++) { const w = dayWeather(hs, d); if (w.kind === 'heat' && w.base > 31) hd = w; }
  const h = new Sim({ seed: hs - 1n, birds: false }, { noAI: true });
  run(h, 2);
  const burn = (m) => {
    const d0 = h._driven(); if (d0) d0.born = m;
    h.clockOffset += (m - h.minute) * h.tpm; run(h, 1);
    const wv = h.wasp; place(wv, { x: 20, y: 3, z: 20 }); wv.state = 'fly'; wv.energy = 1; wv.born = h.minute; wv.bodyT = 30;
    run(h, 120, () => idle({ mz: 100 }));
    return { used: 1 - h.wasp.energy, air: h.temperature };
  };
  const cool = burn(1440 + 9 * 60), hot = burn(hd.day * 1440 + 15 * 60);
  ok(hot.air > X.heatFrom + 4 && hot.used > cool.used * 1.15, `flying at ${hot.air.toFixed(0)} °C in a heatwave burns more sugar than at ${cool.air.toFixed(0)} °C (${(hot.used * 1000).toFixed(1)} vs ${(cool.used * 1000).toFixed(1)})`);
  // a heatwave afternoon is where water decides things: an attic comb goes past the lethal heat, a hollow tree does not
  const m = hd.day * 1440 + 15 * 60;
  h.nest.site = 'attic'; const att = h.nestHeat(m); h.nest.site = 'hollow'; const hol = h.nestHeat(m); h.nest.site = 'trunk';
  ok(att.cook > 0 && hol.cook === 0, `on a heatwave afternoon an attic comb reaches ${att.nestT.toFixed(1)} °C and its brood cooks without water; in a hollow tree ${hol.nestT.toFixed(1)} °C`);
}

// Males and mating flights (GDD 6.5, 6.7, T2-3)
{
  const M = T.males, S2 = T.season;
  const c0 = newColony(); c0.males = 0;
  const early = malesAbout(c0, S2.reproStart + 0.01), full = malesAbout(c0, S2.reproFull);
  c0.males = M.need; const own = malesAbout(c0, S2.reproStart + 0.01);
  ok(early < 0.2 && full === 1 && own === 1, `a young queen's chance to find a male: ${early.toFixed(2)} early in the breeding season with none of her own, ${full.toFixed(2)} at its height, ${own.toFixed(2)} early with ${M.need} brothers`);
  const mate = (males) => { const c = newColony(); c.gynes = 20; c.males = males; colonyStep(c, 0.5, 0, true, S2.reproStart + 0.02, 1); return c.mated; };
  ok(mate(0) < mate(M.need) * 0.3, `with no males about few young queens mate (${mate(0).toFixed(2)} vs ${mate(M.need).toFixed(2)} with ${M.need} males)`);
  // physical: the breeding season, near the nest, on a fair day
  const s = new Sim({ seed: 1234, birds: false, dayMinutes: 20 });
  run(s, 2);
  s.season.startMinute -= 0.45 * s.settings.seasonDays * 1440;
  s.colony.males = 12; s.colony.gynes = 4;
  const lek = s.lekSpot(), trees = [-1, 0, 1].flatMap((dz) => [-1, 0, 1].flatMap((dx) => generateChunk(s.seed, chunkOf(s.nest.x) + dx, chunkOf(s.nest.z) + dz).trees));
  const tree = trees.find((t) => t.x === lek.x && t.z === lek.z);
  ok(tree && lek.y > tree.h && Math.hypot(lek.x - s.nest.x, lek.z - s.nest.z) <= M.lekRange, `the mating spot is over the crown of a tall tree near the nest (${tree && tree.h.toFixed(1)} m tree, ${Math.hypot(lek.x - s.nest.x, lek.z - s.nest.z).toFixed(0)} m away)`);
  const males0 = s.colony.males + s.colony.gynes;
  let ev = [], outM = 0, near = 0, w = s.wasp;
  for (let i = 0; i < 9000; i++) {
    if (s.wasp) { place(s.wasp, { x: s.nest.x + 2, y: 2, z: s.nest.z + 2 }); s.wasp.born = s.minute; }
    s.step(idle()); ev.push(...s.drainEvents());
    const ms = s.wasps.filter((x) => x.caste === 'male');
    outM = Math.max(outM, ms.length);
    if (i % 60 === 0) near += ms.filter((x) => Math.hypot(x.x - lek.x, x.z - lek.z) < M.patrolR + 2 && Math.abs(x.y - lek.y) < 1.5).length;
  }
  const mated = ev.filter((e) => e.type === 'mated'), spent = ev.filter((e) => e.type === 'waspDied' && e.cause === 'mated');
  ok(outM >= 2 && near > 20, `males fly out (up to ${outM} at once) and patrol the crown`);
  ok(mated.length >= 2 && spent.length >= 1 && spent.length <= mated.length, `young queens fly out and mate (${mated.length} matings, ${spent.length} with males of the line, who die after)`);
  // a male: no sting, no work, and the player can fly one
  const t = new Sim({ seed: 1234, birds: false }, { noAI: true });
  run(t, 2);
  const m = t.wasp; m.caste = 'male'; m.venom = 0;
  const hm = seated(t, () => true), arm = hm.parts.sit.find((p) => p.name === 'ForearmR');
  const spot = toWorld(hm, { x: (arm.a.x + arm.b.x) / 2, y: (arm.a.y + arm.b.y) / 2 + arm.r + 0.006, z: (arm.a.z + arm.b.z) / 2 });
  ev = run(t, 30, () => { place(m, spot); return idle({ sting: 1 }); });
  ok(count(ev, 'sting') === 0 && m.state !== 'attached', 'a male pressed against an arm cannot sting');
  const rec = t.records.get('0,0'), ci = rec.content.caterpillars.findIndex((q, i) => t.catActive(rec, i));
  if (ci >= 0) { const cp = rec.content.caterpillars[ci]; place(m, { x: cp.x, y: cp.y + 0.01, z: cp.z }); m.state = 'fly'; ev = run(t, 2, (sim, i) => idle({ act: i === 1 ? Act.Interact : 0 })); }
  ok(ci < 0 || (!m.carry && count(ev, 'caught') === 0), 'nor catch prey');
  // flying a male into a young queen at the spot
  const u = new Sim({ seed: 1234, birds: false, dayMinutes: 20 }, { noAI: true });
  run(u, 2);
  u.season.startMinute -= 0.45 * u.settings.seasonDays * 1440; u.colony.gynes = 1;
  const me = u.wasp; me.caste = 'male'; me.venom = 0;
  u._launchRepro = Sim.prototype._launchRepro; // noAI keeps the launch off: start one by hand
  const g = u._spawnWasp(false, 'gyne'); g.role = 'gyne'; g.ai.mode = 'mate'; g.ai.timer = u.tick + M.gyneTicks; u.colony.gynes -= 1;
  const mated0 = u.colony.mated;
  ev = [];
  for (let i = 0; i < 3000 && u.wasps.includes(g); i++) { u.step(idle()); ev.push(...u.drainEvents()); if (u.wasp === me) { place(me, g); me.born = u.minute; } }
  const mine = ev.find((e) => e.type === 'mated');
  ok(mine && mine.driven && ev.some((e) => e.type === 'waspDied' && e.driven && e.cause === 'mated') && u.colony.mated === mated0 + 1, 'a player flying a male into a young queen mates with her, and his life ends there');
}

// Lineage colonies (GDD 6.7, T2-4): the line's other queens found real colonies run by the AI
{
  const L = T.line, s = new Sim({ seed: 1234, birds: false, dayMinutes: 20 });
  run(s, 2);
  // spring: three sites with queens; you take one at the first site
  const sites = [{ kind: 'bark', x: s.nest.x + 3, y: 1, z: s.nest.z + 3, q: 0.5, n: 3 }, { kind: 'litter', x: s.nest.x - 25, y: 0.1, z: s.nest.z + 10, q: 0.3, n: 2 }];
  s.line = [];
  const left = s._foundLine(sites, 0, 4);
  const gaps = s.line.flatMap((a, i) => s.line.slice(i + 1).map((b) => Math.hypot(a.nest.treeX - b.nest.treeX, a.nest.treeZ - b.nest.treeZ)));
  ok(s.line.length >= 2 && s.line.length <= L.max && left === 4 - s.line.length && gaps.every((g) => g >= L.minGap) && s.line.every((x) => x.colony.sited && x.colony.queenAlive && x.colony.adults === 0),
    `four queens besides yours: ${s.line.length} found colonies on trunks near where they wintered, at least ${L.minGap} m apart; ${left} stay a count`);
  ok(s.isRival({ colony: 'line:1' }) === false && s.isRival({ colony: '3,4' }) === true && s.isRival({ colony: 'own' }) === false, 'a sister colony is not a rival');
  // a founding sister queen brings in food alone and her colony grows
  const sc = s.line[0];
  for (let i = 0; i < 20 * 60 * 50 * 6 && sc.colony.adults < 1; i += 60) { s.step(idle()); s.drainEvents(); if (s.wasp) s.wasp.born = s.minute; for (let k = 0; k < 59; k++) { s.step(idle()); s.drainEvents(); } }
  ok(sc.colony.adults >= 1 && sc.colony.cells > 0 && s.line.includes(sc), `a sister queen founds alone and raises her first workers (${sc.colony.adults.toFixed(1)} adults, ${sc.colony.cells.toFixed(0)} cells by day ${s.day})`);
  // near you, its workers fly; they never fight yours, and your guards leave them be
  sc.colony.adults = 40;
  { const m = (s.day + 1) * 1440 + 11 * 60, d = s._driven(); if (d) d.born = m; s.clockOffset += (m - s.minute) * s.tpm; run(s, 1); } // a fair morning
  while (dayWeather(s.seed, s.day).rain) { const m = (s.day + 1) * 1440 + 11 * 60; s.clockOffset += (m - s.minute) * s.tpm; run(s, 1); }
  if (s.wasp) place(s.wasp, sc.nest.spawn);
  let out = null;
  for (let i = 0; i < 1200 && !out; i++) { s.step(idle()); s.drainEvents(); if (s.wasp) { place(s.wasp, { x: sc.nest.x + 1, y: sc.nest.y, z: sc.nest.z + 1 }); s.wasp.born = s.minute; } out = s.wasps.find((w) => w.colony === 'line:' + sc.id); }
  ok(!!out && out.colony === 'line:' + sc.id, `a sister colony near the player sends workers out (${s.wasps.filter((w) => w.colony === 'line:' + sc.id).length} out)`);
  if (out && s.wasp) {
    place(s.wasp, out); out.state = 'fly'; s.wasp.state = 'fly';
    const ev = run(s, 3, () => { if (s.wasp && out) place(s.wasp, out); return idle(); });
    ok(count(ev, 'fight') === 0 && out.state !== 'fighting', 'your wasp touching a sister colony\'s worker does not fight it');
  }
  // its mated queens winter by its nest and are offered in spring
  for (const x of s.line) x.colony.mated = 200;
  s._endSeason('autumn');
  const sis = s.winter && s.winter.sites.filter((x) => x.kind === 'sister');
  ok(sis && sis.length >= 1 && s.line.length === 0, `at the end of the season the sister colonies' mated queens winter by their nests and are offered with yours (${sis && sis.map((x) => x.n).join(', ')} queens)`);
  // losing your colony mid-season: you go on in the strongest sister
  const u = new Sim({ seed: 1234, birds: false }, { noAI: true });
  run(u, 2);
  u._foundLine([{ kind: 'bark', x: u.nest.x + 3, y: 1, z: u.nest.z + 3, q: 0.5, n: 3 }], 0, 2);
  u.line[0].colony.adults = 12; u.line[1] && (u.line[1].colony.adults = 30);
  const strong = u.line.reduce((a, b) => (b.colony.adults > a.colony.adults ? b : a));
  const snap = restore(snapshot(u));
  ok(snap.line.length === u.line.length && snap.line[0].nest.x === u.line[0].nest.x && snap.line[0].colony.adults === u.line[0].colony.adults, 'sister colonies survive save and restore');
  u.colony.queenAlive = false; u.colony.adults = 0; u.colony.eggs = u.colony.larvae = u.colony.pupae = 0;
  const ev2 = run(u, 120);
  ok(count(ev2, 'sisterTakeover') === 1 && u.nest === strong.nest && u.colony === strong.colony && !u.line.includes(strong) && !u.extinct, `your colony gone, you go on in the strongest sister colony (${Math.floor(u.colony.adults)} adults)`);
}

// Tuning as data (GDD 13, T1-22): one plain-text file feeds both sims
{
  const { unknown, missing } = TUNE_RESULT;
  ok(unknown.length === 0 && missing.length === 0, `tuning/sting.tune sets every key of T and nothing else (${unknown.length} unknown, ${missing.length} missing)`);
  ok(TUNE.hash === tuningHash(TUNE_TEXT) && TUNE.hash !== 'built-in' && tuningHash(TUNE_TEXT.replace(/\n/g, '\r\n')) === TUNE.hash, `the tuning hash is the file's (${TUNE.hash}), line endings aside`);
  const vals = new Map(parseTuning(TUNE_TEXT));
  ok(tuningLeaves(T).every(([p, v]) => JSON.stringify(vals.get(p)) === JSON.stringify(v)), 'every value in T is the one the file holds');
  let threw = 0;
  for (const bad of ['[wasp]\nradius = ', '[wasp]\nradius 3', '[wasp]\nradius = "x', '[wasp]\nradius = [1, 2', '[chunk]\nsize = 99']) { try { applyTuning(structuredClone(T), bad); } catch { threw++; } }
  ok(threw === 5, `a malformed file or a change to a world-format key is refused (${threw}/5)`);
  const r = applyTuning(structuredClone(T), '[wasp]\nradius = "big"\nnope = 1');
  ok(r.unknown.join() === 'wasp.radius,wasp.nope', 'a value of the wrong kind or an unknown key is reported, not applied');
  applyTuning(T, TUNE_TEXT); // put the shipped hash back
  const s = new Sim({ seed: 1234, birds: false }), snap = snapshot(s), d = JSON.parse(snap);
  ok(d.tune === TUNE.hash && restore(snap), 'a save records the tuning it was made with, and loads under it');
  let refused = ''; try { restore(JSON.stringify({ ...d, tune: 'deadbeef' })); } catch (e) { refused = e.message; }
  ok(/tuning deadbeef/.test(refused), `a save made with other tuning will not load (${refused})`);
  const h0 = rulesHash({}); const keep = TUNE.hash; TUNE.hash = 'deadbeef'; const h1 = rulesHash({}); TUNE.hash = keep;
  ok(h0 !== h1, 'peers with different tuning files do not match rules');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
