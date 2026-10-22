// Headless tests for the STING sim core. Run: node test/sim.test.mjs
import { readFileSync } from 'node:fs';
import {
  Sim, Act, hash, Domain, humanTraits, resolveSting, ZONES, Zone, ZoneName, toWorld, T, dsin, dcos, newColony, colonyStep,
  garmentGraph, Top, NEST_ENTRANCE, NEST, chunkKey, beePos, flyPos, snapshot, restore, replayFrom, stingBot,
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
  fed.protein = 1e6; fed.sugar = 1e6;
  starved.protein = 0; starved.sugar = 1e6;
  for (let i = 0; i < 120 * 10; i++) { colonyStep(fed, 1 / 120, 0, false); colonyStep(starved, 1 / 120, 0, false); }
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

// 9. Exterminator: level 4 near the nest brings him; he destroys the nest unless stopped
{
  const s = new Sim({ seed: 1234 });
  s.cs(chunkKey(0, 0)).esc = 30;
  let ev = run(s, 60, () => idle());
  ok(count(ev, 'extScheduled') === 1, 'level 4 near the nest schedules the exterminator');
  ev = run(s, 9000, () => idle());
  ok(count(ev, 'extArrive') === 1 && count(ev, 'extTreat') === 1, 'he arrives and starts treating the nest');
  ok(count(ev, 'nestDestroyed') === 1 && !s.colony.nestAlive, 'an unopposed exterminator destroys the nest');
}

// 10. Exterminator abort: crawl under his collar, sting, keep moving between stings
{
  const s = new Sim({ seed: 1234 });
  s.cs(chunkKey(0, 0)).esc = 30;
  let ev = [];
  for (let i = 0; i < 4000 && !s.ext.hm; i++) ev.push(...run(s, 1, () => idle()));
  const ext = s.ext.hm;
  ok(!!ext && s.ext.state === 'active', 'exterminator on site');
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
  ok(replayFrom(snap, a.log.slice(9 * 9000), 6000) === a.stateHash(), 'replaying the input recorded after a snapshot reproduces the world');
  console.log(`  snapshot size ${(snap.length / 1024).toFixed(0)} KB for ${a.records.size} chunks, ${a.humans.size} humans, ${a.wasps.length} wasps`);
}

// 17. Frozen chunks
{
  const s = new Sim({ seed: 5 });
  const rec = s.records.get('0,0'), before = rec.contentHash;
  run(s, 600, () => idle({ mz: 100, burst: 1, yawQ: 0 }));
  ok(s.records.get('0,0') === rec && rec.contentHash === before, 'discovered chunk record stays frozen');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
