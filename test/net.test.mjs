// Two peers over a simulated link must agree on every shared human (GDD 11.5). Run: node test/net.test.mjs
import { NetLab, stingBot, idleCmd, encodeState, decodeState, BYTES_PER_WASP } from '../sim/index.js';

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
