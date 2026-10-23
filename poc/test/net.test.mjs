// Two peers over a simulated link must agree on every shared human (GDD 11.5). Run: node test/net.test.mjs
import { readFileSync } from 'node:fs';
import { NetLab, MeshLab, Sim, stingBot, idleCmd, encodeState, decodeState, BYTES_PER_WASP, T, applyTuning } from '../sim/index.js';
applyTuning(T, readFileSync(new URL('../../tuning/sting.tune', import.meta.url), 'utf8')); // T1-22: the shipped tuning

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

function run(linkName, ticks) {
  const lab = new NetLab({ seed: 1234 }, linkName);
  const botA = stingBot({ plan: 'jab', rest: 200 });
  let errSum = 0, errN = 0, errMax = 0;
  for (let i = 0; i < ticks; i++) {
    lab.step(botA(lab.a));
    lab.a.drainEvents();
    if (i % 60 === 0) lab.check();
    const e = lab.remoteError();
    if (e !== null) { errSum += e; errN++; errMax = Math.max(errMax, e); }
  }
  const c = lab.checks;
  const stings = lab.a.stats.stings + lab.a.stats.remoteStings;
  console.log(`  ${linkName}: ${c.agreed}/${c.compared} checks agree (skipped ${c.skipped}), stings A ${lab.a.stats.stings} B ${lab.b.stats.stings}, late events A ${lab.a.netStats.late} B ${lab.b.netStats.late} (max ${Math.max(lab.a.netStats.lateMax, lab.b.netStats.lateMax)} ticks), remote error mean ${(errSum / Math.max(1, errN) * 100).toFixed(1)} cm max ${(errMax * 100).toFixed(0)} cm`);
  return { lab, c, stings, errMean: errSum / Math.max(1, errN) };
}

for (const name of ['lan', 'good', 'bad', 'awful']) {
  const r = run(name, 18000);
  ok(r.lab.a.stats.stings > 3 && r.lab.b.stats.stings > 3, `${name}: both peers sting the shared humans`);
  ok(Math.abs(r.lab.a.stats.remoteStings - r.lab.b.stats.stings) <= 1 && Math.abs(r.lab.b.stats.remoteStings - r.lab.a.stats.stings - r.lab.a.stats.aiStings) <= 1, `${name}: every sting reaches the other peer (A saw ${r.lab.a.stats.remoteStings} of B's ${r.lab.b.stats.stings}; B saw ${r.lab.b.stats.remoteStings} of A's ${r.lab.a.stats.stings} + AI ${r.lab.a.stats.aiStings})`);
  ok(r.c.compared > 100 && r.c.agreed === r.c.compared, `${name}: human state identical on both peers at every check (${r.c.agreed}/${r.c.compared})`);
  ok(r.lab.a.netStats.late === 0 && r.lab.b.netStats.late === 0, `${name}: no event arrived after its commit tick`);
  ok(r.lab.a.netStats.rejected === 0 && r.lab.b.netStats.rejected === 0, `${name}: plausibility checks never reject honest traffic`);
}

// Peers far apart: B works a picnic two chunks east while A stays home. Humans still agree everywhere (Q-16).
{
  const lab = new NetLab({ seed: 1234 }, 'good', { pick: (h) => h.chunk === '2,0' });
  const botA = stingBot({ plan: 'jab', rest: 200 });
  // B flies east first
  for (let i = 0; i < 18000; i++) {
    const bw = lab.b._driven();
    const cmdB = bw && bw.x < 100 && !lab.b.active.some((h) => h.chunk === '2,0' && h.state === 'idle' && h.posture === 'sit' && Math.hypot(h.x - bw.x, h.z - bw.z) < 40)
      ? { mx: 0, my: 0, mz: 100, burst: 1, sting: 0, yawQ: Math.round(Math.PI / 2 * 1e4), pitchQ: bw.y < 2 ? 2000 : 0, act: 0, alloc: 0 } : undefined;
    lab.step(botA(lab.a), cmdB);
    lab.a.drainEvents();
    if (i % 60 === 0) lab.check();
  }
  const c = lab.checks;
  console.log(`  apart: A at ${lab.a.activeKey}, B at ${lab.b.activeKey}; ${c.agreed}/${c.compared} agree; A simulates ${lab.a.active.length} humans, B ${lab.b.active.length}; B stings ${lab.b.stats.stings}`);
  ok(lab.a.activeKey !== lab.b.activeKey && lab.b.stats.stings > 0, 'apart: the peers work different chunks');
  ok(c.agreed === c.compared, `apart: human state identical on both peers (${c.agreed}/${c.compared})`);
}

// Late join: B arrives after 50 s and builds its world from A's snapshot (GDD 11.10)
{
  const lab = new NetLab({ seed: 1234 }, 'good', {}, 3000);
  const botA = stingBot({ plan: 'jab', rest: 200 });
  for (let i = 0; i < 15000; i++) { lab.step(botA(lab.a)); lab.a.drainEvents(); if (i % 60 === 0) lab.check(); }
  const c = lab.checks;
  console.log(`  late join at tick ${lab.joined}: ${c.agreed}/${c.compared} checks agree after joining; A stung ${lab.a.stats.stings + lab.a.stats.aiStings} before and after, B ${lab.b.stats.stings}`);
  ok(lab.joined === 3000 && c.compared > 150 && c.agreed === c.compared, `a peer joining mid-game agrees on every human from its first tick (${c.agreed}/${c.compared})`);
}

// Rival fights across peers: A owns the rivals; B's wasp grapples one. Each peer decides only its own wasp,
// and both must agree on who died (GDD 9.3, 11.6)
{
  let seed = 0, rv = null;
  for (let sd = 1; sd < 80 && !rv; sd++) { const t = new Sim({ seed: sd }); for (const r of t.activeChunks) if (r.content.rival) { seed = sd; rv = r.content.rival; break; } }
  const fights = { a: 0, b: 0, overA: [], overB: [] };
  let agree = 0, total = 0;
  for (const link of ['good', 'bad']) {
    const lab = new NetLab({ seed }, link);
    const hold = (w, p) => Object.assign(w, { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0 });
    for (let i = 0; i < 9000; i++) {
      const aw = lab.a._driven(), bw = lab.b._driven();
      if (aw && aw.state === 'fly') hold(aw, { x: rv.ex + 2.5, y: rv.ey + 1, z: rv.ez });
      if (bw && (bw.state === 'fly' || bw.state === 'landed')) {
        bw.state = 'fly';
        // B flies onto the nearest rival it can see
        let best = null, bd = 1e9;
        for (const r of lab.b.remote.values()) if (r.rival && r.state === 'fly') { const d = (r.x - bw.x) ** 2 + (r.z - bw.z) ** 2; if (d < bd) { bd = d; best = r; } }
        hold(bw, best && bd < 25 ? { x: best.x + 0.01, y: best.y, z: best.z } : { x: rv.ex + 0.5, y: rv.ey, z: rv.ez });
      }
      lab.step(idleCmd(), idleCmd({ sting: i % 6 < 3 ? 1 : 0 }));
      for (const e of lab.a.drainEvents()) { if (e.type === 'fightOver' && (e.winner > 1000000 || e.loser > 1000000)) fights.overA.push([e.winner, e.loser]); }
      for (const e of lab.bEvents || []) { if (e.type === 'fight' && e.remote) fights.b++; if (e.type === 'fightOver') fights.overB.push([e.winner, e.loser]); }
    }
  }
  const key = (x) => x.join('>');
  const setA = new Set(fights.overA.map(key));
  for (const f of fights.overB) { total++; if (setA.has(key(f))) agree++; }
  console.log(`  rival fights across peers (seed ${seed}): B grappled ${fights.b} times, ${total} resolved, ${agree} with the same winner on A`);
  ok(fights.b >= 2 && total >= 2 && agree === total, `a remote player's wasp fights A's rivals and both peers agree on every winner (${agree}/${total})`);
}

// A remote raid: B steals a larva from a rival nest whose guards live on A; A's guards hunt B's wasp down
{
  let seed = 0, rv = null;
  for (let sd = 1; sd < 80 && !rv; sd++) { const t = new Sim({ seed: sd }); for (const r of t.activeChunks) if (r.content.rival) { seed = sd; rv = r.content.rival; break; } }
  const lab = new NetLab({ seed }, 'good');
  const hold = (w, p) => Object.assign(w, { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0 });
  let raided = false, hunted = 0, grappled = 0;
  for (let i = 0; i < 6000; i++) {
    const aw = lab.a._driven(), bw = lab.b._driven();
    if (aw && aw.state === 'fly') hold(aw, { x: rv.ex + 4, y: rv.ey + 1, z: rv.ez });
    let act = 0;
    if (bw && bw.state === 'fly' && !raided) {
      // wait until A's rivals are out, then rob the nest and hover 1 m away
      if (i > 1200) { hold(bw, { x: rv.ex, y: rv.ey - 0.02, z: rv.ez }); act = 1; }
      else hold(bw, { x: rv.ex + 3, y: rv.ey, z: rv.ez });
    } else if (bw && bw.state === 'fly') hold(bw, { x: rv.ex + 1, y: rv.ey, z: rv.ez });
    lab.step(idleCmd(), idleCmd({ act }));
    for (const e of lab.bEvents || []) { if (e.type === 'raid') raided = true; if (e.type === 'fight' && e.remote) grappled++; }
    lab.a.drainEvents();
    if (raided) hunted = Math.max(hunted, lab.a.wasps.filter((w) => w.colony !== 'own' && w.ai.mode === 'hunt' && w.ai.huntId > 1000000).length);
  }
  console.log(`  remote raid (seed ${seed}): raided ${raided}, up to ${hunted} of A's rival guards hunted B, B grappled ${grappled} times`);
  ok(raided && hunted >= 1 && grappled >= 1, 'a raid by another player sends the rival guards after that player, and they catch it');
}

// Guards against another player (T1-13, Q-07 rivals by default): B's wasp hovering at A's entrance is chased by A's
// guards and grappled across the link; both peers resolve the fight the same way
{
  const lab = new NetLab({ seed: 1234 }, 'good');
  lab.a.colony.adults = 120;
  const hold = (w, p) => Object.assign(w, { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0 });
  const e = lab.a.nest.entrance, n = lab.a.nest, od = Math.hypot(e.x - n.x, e.z - n.z) || 1;
  const spot = { x: e.x + (e.x - n.x) / od * 0.35, y: e.y, z: e.z + (e.z - n.z) / od * 0.35 };
  let hunts = 0, fightsB = 0;
  const over = { a: [], b: [] };
  for (let i = 0; i < 3000; i++) {
    const bw = lab.b._driven();
    if (i > 900 && bw && bw.state === 'fly') hold(bw, spot);
    lab.step(idleCmd(), idleCmd());
    for (const ev of lab.a.drainEvents()) { if (ev.type === 'guardHunt' && ev.player) hunts++; if (ev.type === 'fightOver') over.a.push(ev.winner + '>' + ev.loser); }
    for (const ev of lab.bEvents || []) { if (ev.type === 'fight' && ev.remote) fightsB++; if (ev.type === 'fightOver') over.b.push(ev.winner + '>' + ev.loser); }
  }
  const agree = over.b.filter((f) => over.a.includes(f)).length;
  console.log(`  guards vs a player: A's guards went after B ${hunts} times, B grappled ${fightsB} times, ${over.b.length} resolved on B, ${agree} the same on A`);
  ok(hunts >= 1 && fightsB >= 1 && over.b.length >= 1 && agree === over.b.length, "another player's wasp at the entrance is chased and grappled by the guards, and both peers agree on the winner");
}

// Level 5 across peers: the campaign reads only shared state, so both peers start and end it on the same tick
{
  const lab = new NetLab({ seed: 1234 }, 'bad');
  const botA = stingBot({ plan: 'jab', rest: 200 });
  const starts = { a: 0, b: 0 }, ends = { a: 0, b: 0 };
  for (let i = 0; i < 26000; i++) {
    if (i === 600) { lab.a.cs('0,0').esc = 45; lab.b.cs('0,0').esc = 45; } // as if the same committed stings landed on both
    lab.step(botA(lab.a));
    for (const e of lab.a.drainEvents()) { if (e.type === 'muniStart') starts.a = lab.a.tick; if (e.type === 'muniEnd') ends.a = lab.a.tick; }
    for (const e of lab.bEvents || []) { if (e.type === 'muniStart') starts.b = lab.b.tick; if (e.type === 'muniEnd') ends.b = lab.b.tick; }
    if (i % 60 === 0) lab.check();
  }
  const c = lab.checks;
  console.log(`  municipal campaign: started A ${starts.a} B ${starts.b}, ended A ${ends.a} B ${ends.b}; humans ${c.agreed}/${c.compared}`);
  ok(starts.a && starts.a === starts.b && ends.a && ends.a === ends.b && c.agreed === c.compared, 'both peers run the municipal campaign on the same ticks and still agree on every human');
}

// A cheating peer (GDD 11.8): B pushes every slap aimed at its wasps 1000 ticks into the future.
// A rejects those stings, and after three strikes stops listening to B.
{
  const lab = new NetLab({ seed: 1234 }, 'good');
  const out = lab._out.bind(lab);
  lab._out = (sim, link, dir) => {
    if (dir === 'ba' && sim.tick > 1200) for (const m of sim.outbox) if (m.type === 'sting') for (const sw of m.swats) sw.start += 1000;
    out(sim, link, dir);
  };
  const botA = stingBot({ plan: 'jab', rest: 200 });
  const whys = new Set();
  let quarantinedAt = 0;
  for (let i = 0; i < 18000; i++) {
    lab.step(botA(lab.a));
    for (const e of lab.a.drainEvents()) { if (e.type === 'implausible') whys.add(e.why); if (e.type === 'quarantine') quarantinedAt = lab.a.tick; }
  }
  const st = lab.a.netStats;
  console.log(`  cheater: A rejected ${st.rejected} events (${[...whys].join(', ')}), quarantined B at tick ${quarantinedAt}, then dropped ${st.dropped} messages`);
  ok(whys.has('swat timing') && quarantinedAt > 1200 && lab.a.plaus.quarantined.includes(1) && lab.a.remote.size === 0, 'a peer that delays the slaps aimed at its wasps is rejected and quarantined');
}

// Three peers (GDD 11.8, 11.11): host A, honest B, cheater C. Only the host rules; both honest peers cut C off on the
// same tick, purge the same pending events, and keep agreeing on every human.
{
  const lab = new MeshLab({ seed: 1234 }, 3, 'bad');
  lab.tamper = (from, m, sim) => { if (from === 2 && sim.tick > 1500 && m.type === 'sting') for (const sw of m.swats) sw.start += 1000; };
  const botA = stingBot({ plan: 'jab', rest: 200 });
  const cut = [0, 0, 0];
  let disagreeAfter = 0;
  for (let i = 0; i < 20000; i++) {
    lab.step(botA(lab.sims[0]));
    lab.sims.forEach((s, p) => { for (const e of s.drainEvents()) if (e.type === 'quarantine' && e.peer === 2 && !cut[p]) cut[p] = s.tick; });
    if (i % 60 === 0 && !lab.agree([0, 1]) && cut[0]) disagreeAfter++;
  }
  const [A, B] = lab.sims, c = lab.checks;
  console.log(`  three peers: host cut C off at tick ${cut[0]}, B at ${cut[1]}; A and B agree ${c.agreed}/${c.compared}; B's own strike count ${B.plaus.strikes[2] || 0}`);
  ok(cut[0] > 1500 && cut[0] === cut[1] && A.plaus.quarantined.includes(2) && B.plaus.quarantined.includes(2), 'the host rules on the cheater and both honest peers cut it off on the same tick');
  ok(c.agreed === c.compared, `the honest peers agree on every human before and after the cut (${c.agreed}/${c.compared})`);
}

// Wire format: quantization error and bandwidth (GDD 11.12)
{
  const m = { mk: 'state', peer: 1, tick: 123456, wasps: [
    { id: 1000001, caste: 'worker', x: -3.1234, y: 2.0456, z: -1.2789, vx: 2.9, vy: -0.4, vz: 1.1, state: 'fly', carry: 'fly', under: null },
    { id: 1000002, caste: 'queen', x: 70.5, y: 0.0071, z: -95.25, vx: 0, vy: 0, vz: 0, state: 'landed', carry: null, under: null },
  ] };
  const d = decodeState(encodeState(m));
  let maxErr = 0;
  d.wasps.forEach((w, i) => { const o = m.wasps[i]; maxErr = Math.max(maxErr, Math.abs(w.x - o.x), Math.abs(w.y - o.y), Math.abs(w.z - o.z)); });
  ok(maxErr < 0.001 && d.wasps[1].caste === 'queen' && d.wasps[0].carry === 'fly' && d.wasps[1].state === 'landed', `state packet round-trips within 1 mm (${(maxErr * 1000).toFixed(2)} mm), ${BYTES_PER_WASP} bytes per wasp`);
  const lab = new NetLab({ seed: 1234 }, 'good');
  const botA = stingBot({ plan: 'jab', rest: 200 });
  for (let i = 0; i < 7200; i++) { lab.step(botA(lab.a)); lab.a.drainEvents(); }
  const bw = lab.bandwidth();
  console.log(`  peer A upstream: ${(bw.total / 1024).toFixed(1)} KB/s total, ${(bw.state / 1024).toFixed(1)} KB/s state at 20 Hz for ${lab.a.wasps.length} wasps, ${(bw.events / 1024).toFixed(2)} KB/s events`);
  ok(bw.total < 16 * 1024, `a colony's upstream stays small (${(bw.total / 1024).toFixed(1)} KB/s)`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
