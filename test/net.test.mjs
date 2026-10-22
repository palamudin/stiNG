// Two peers over a simulated link must agree on every shared human (GDD 11.5). Run: node test/net.test.mjs
import { NetLab, stingBot, idleCmd } from '../sim/index.js';

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

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
