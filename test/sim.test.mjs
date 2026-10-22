// Headless tests for the STING tier-0 sim. Run: node test/sim.test.mjs
import { readFileSync } from 'node:fs';
import { Sim, hash, Domain, humanTraits, resolveSting, ZONES, Zone, ZoneName, toWorld, T, dsin, dcos } from '../sim.js';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

// 1. RNG and trait parity with the compile-checked C# protocode (GDD Appendix A.2, A.10)
{
  const ref = readFileSync(new URL('./cs_parity.txt', import.meta.url), 'utf8').trim().split('\n');
  const ids = [1n, 2n, 3n, 0xDEADBEEFCAFEBABEn, 12345678901234567n];
  let match = true;
  ids.forEach((id, i) => {
    const [, rt, st, hgt, arm, flex, girth] = ref[i].split(' ');
    const h = humanTraits(42n, id);
    const near = (a, b) => Math.abs(a - Number(b)) < 1e-6;
    if (h.reactionTicks !== +rt || h.style !== +st || !near(h.height, hgt) || !near(h.armRatio, arm) || !near(h.flexibility, flex) || !near(h.girth, girth)) {
      match = false; console.log('  mismatch', id, h, ref[i]);
    }
  });
  ok(match, 'human traits match C# HumanFactory for 5 ids');
  ok(hash(42n, Domain.WorldGen, 7n, 8n, 9n).toString(16).padStart(16, '0') === ref[5].trim(), 'Rng.Hash bit-identical to C#');
}

// 2. Deterministic trig accuracy
{
  let maxErr = 0;
  for (let x = -20; x <= 20; x += 0.001) maxErr = Math.max(maxErr, Math.abs(dsin(x) - Math.sin(x)), Math.abs(dcos(x) - Math.cos(x)));
  ok(maxErr < 1e-6, `dsin/dcos max error ${maxErr.toExponential(2)}`);
}

// 3. Consequence-window invariant over many humans and every zone (GDD 11.5)
{
  let minGap = Infinity;
  for (let i = 1n; i <= 3000n; i++) {
    const h = humanTraits(7n, i);
    for (let z = 0; z < ZONES.length; z++) {
      const p = resolveSting({ contactTick: 0, zone: z, contactPointBody: { x: 0, y: 1, z: 0 }, mode: 'full' }, h, ZONES[z],
        { clothingStiffness: 0, panic: 0, companions: [{ id: i + 99999n, distance: 1, reactionTicks: 11, style: 0 }] });
      for (const s of p.swats) minGap = Math.min(minGap, s.start);
    }
  }
  ok(minGap >= T.resolve.minConsequenceTicks, `no swat lands before ${T.resolve.minConsequenceTicks} ticks (min seen ${minGap})`);
}

// 4. Scripted bot: fly to a seated human's forearm and sting. Exercises flight, collision,
//    contact, sting, swats, death/respawn, panic, flee, chunk discovery.
function bot(sim, plan) {
  const w = sim.wasp;
  let phase = 'approach', target = null, holdTicks = 0, awayTicks = 0, idx = 0;
  return () => {
    const cmd = { mx: 0, my: 0, mz: 0, burst: 0, sting: 0, yawQ: Math.round(w.yaw * 1e4), pitchQ: 0 };
    const ww = sim.wasp;
    if (ww.state === 'dead' || ww.state === 'extinct') { phase = 'approach'; target = null; return cmd; }
    if (!target) {
      const seated = sim.active.filter((h) => h.posture === 'sit' && h.state === 'idle');
      if (!seated.length) return cmd;
      const hm = seated[idx++ % seated.length];
      const part = hm.parts.sit.find((p) => p.name === 'ForearmR');
      const mid = { x: (part.a.x + part.b.x) / 2, y: (part.a.y + part.b.y) / 2 + part.r + 0.012, z: (part.a.z + part.b.z) / 2 };
      target = { hm, mid };
    }
    const tp = toWorld(target.hm, target.mid);
    const dx = tp.x - ww.x, dy = tp.y - ww.y, dz = tp.z - ww.z, d = Math.hypot(dx, dy, dz);
    const yaw = Math.atan2(dx, dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    if (phase === 'approach') {
      cmd.yawQ = Math.round(yaw * 1e4); cmd.pitchQ = Math.round(pitch * 1e4);
      // decel-aware approach speed, sting armed in the last 10 cm
      cmd.mz = Math.max(6, Math.min(100, Math.round(Math.sqrt(2 * T.wasp.accel * d) * 0.7 / T.wasp.cruise * 100)));
      if (d < 0.1) cmd.sting = 1;
      if (ww.state === 'attached') { phase = 'sting'; holdTicks = 0; }
    }
    if (phase === 'sting') {
      cmd.sting = 1; holdTicks++;
      if (ww.state === 'fly' && holdTicks > 2) { phase = plan === 'full' ? 'linger' : 'escape'; awayTicks = 0; }
      if (plan === 'jab' && holdTicks >= T.sting.jabTicks + 1) cmd.sting = 0;
    }
    if (phase === 'linger') { cmd.sting = 0; if (++awayTicks > 25) { phase = 'escape'; awayTicks = 0; } }
    if (phase === 'escape') {
      cmd.yawQ = Math.round((yaw + Math.PI) * 1e4); cmd.pitchQ = 3000; cmd.mz = 100; cmd.burst = 1;
      if (++awayTicks > 120) { phase = 'approach'; target = null; }
    }
    return cmd;
  };
}

function run(seed, ticks, plan) {
  const sim = new Sim(seed);
  const next = bot(sim, plan);
  const counts = {};
  for (let t = 0; t < ticks; t++) {
    sim.step(next());
    for (const e of sim.drainEvents()) counts[e.type] = (counts[e.type] || 0) + 1;
  }
  return { sim, counts, hash: sim.stateHash() };
}

{
  const a = run(1234n, 18000, 'full');
  const b = run(1234n, 18000, 'full');
  console.log('  full-sting bot events:', JSON.stringify(a.counts));
  console.log('  stats:', JSON.stringify(a.sim.stats), 'stung unique', a.sim.stung.size, 'workers', a.sim.workers);
  ok(a.hash === b.hash, `two runs, same seed -> same state hash (${a.hash})`);
  ok(Sim.replay(1234n, a.sim.log, 18000) === a.hash, 'replay of recorded input reproduces the hash');
  ok((a.counts.sting || 0) > 0, 'bot landed stings');
  ok((a.counts.swatHit || 0) > 0, 'swats hit the wasp when it lingered');
  ok((a.counts.waspDied || 0) > 0 && (a.counts.respawn || 0) > 0, 'death and respawn cycle works');
  ok((a.counts.chunkDiscovered || 0) >= 25, 'chunks discovered around the nest');

  const j = run(1234n, 18000, 'jab');
  console.log('  jab bot events:', JSON.stringify(j.counts));
  console.log('  stats:', JSON.stringify(j.sim.stats), 'stung unique', j.sim.stung.size);
  ok(j.sim.stats.deaths / Math.max(1, j.sim.stats.stings) < a.sim.stats.deaths / Math.max(1, a.sim.stats.stings), 'jab-and-run dies less per sting than full-sting-and-linger');
  ok(a.hash !== run(99n, 6000, 'full').hash, 'different seed -> different world');
}

// 5. Frozen chunks: a discovered record never changes
{
  const s = new Sim(5n);
  const rec = s.records.get('0,0');
  const before = rec.contentHash;
  for (let t = 0; t < 600; t++) s.step({ mx: 0, my: 0, mz: 100, burst: 1, sting: 0, yawQ: 0, pitchQ: 0 });
  ok(s.records.get('0,0') === rec && rec.contentHash === before, 'discovered chunk record stays frozen');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
