// Lock-on and assisted flight (GDD 7.9): the player directs the wasp, the wasp flies. A lock picks something to fly
// relative to (the spot on a person the wasp was aimed at, or the thing under the aim, or the nearest prey or hazard);
// the pilot flies the wasp to it and settles there, or catches it. Pure functions of the sim that only build the
// driven wasp's commands, so an assisted flight is recorded and replayed like any other input.
import { T } from './tuning.js';
import { chunkKey, flyPos, beePos, birdPos, dragonPos } from './world.js';
import { toWorld, toLocal, segClosest } from './body.js';
import { datan2, clamp } from './rng.js';
import { Act } from './sim.js';

const sq = (v) => v * v;
const d2 = (a, b) => sq(a.x - b.x) + sq(a.y - b.y) + sq(a.z - b.z);
export const LOCK = { humanRange: 8, coneCos: 0.99, range: 10, nearRange: 8, lostRange: 15, partSlack: 0.12 };

// What each kind of target is: a label, whether the pilot can take the wasp there, and what it does on arrival
export const TARGET_KIND = {
  human: { label: 'person', go: 'land on it' },
  fly: { label: 'fly', go: 'catch it', prey: true },
  caterpillar: { label: 'caterpillar', go: 'catch it', prey: true },
  bee: { label: 'bee', go: 'catch it', prey: true, hazard: true },
  flower: { label: 'flower', go: 'land on it' },
  cup: { label: 'drink', go: 'drink from it' },
  bath: { label: 'water', go: 'land at the water' },
  nest: { label: 'your nest', go: 'fly home' },
  bird: { label: 'bird', hazard: true },
  dragonfly: { label: 'dragonfly', hazard: true },
  web: { label: 'spider web', hazard: true },
  wasp: { label: 'rival wasp', hazard: true },
};

// a body point as a part, a place along it, and a direction off it, so it follows the person when they move or sit
function partOf(hm, name) { return (hm.parts[hm.posture] || hm.parts.stand).find((p) => p.name === name) || null; }
function humanPoint(hm, t) {
  const part = partOf(hm, t.part);
  if (!part) return null;
  const a = part.a, b = part.b, q = { x: a.x + (b.x - a.x) * t.t, y: a.y + (b.y - a.y) * t.t, z: a.z + (b.z - a.z) * t.t };
  return { p: toWorld(hm, { x: q.x + t.n.x * part.r, y: q.y + t.n.y * part.r, z: q.z + t.n.z * part.r }), n: dirWorld(hm, t.n) };
}
function dirWorld(hm, n) { const o = toWorld(hm, { x: 0, y: 0, z: 0 }), p = toWorld(hm, n); return { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z }; }

// Where a target is now, or null when it is gone (caught, out of bloom, left, dead)
export function targetPos(sim, t) {
  if (!t) return null;
  if (t.kind === 'human') { const hm = sim.humanByHex(t.hex); if (!hm || hm.state === 'away') return null; const hp = humanPoint(hm, t); return hp && hp.p; }
  if (t.kind === 'nest') return sim.nest.entrance;
  if (t.kind === 'wasp') { const x = sim.waspById(t.id) || sim.remote.get(t.id); return x && (x.state === 'fly' || x.state === 'landed') ? { x: x.x, y: x.y, z: x.z } : null; }
  const rec = sim.records.get(t.key);
  if (!rec) return null;
  const c = rec.content, st = sim.cs(t.key);
  switch (t.kind) {
    case 'fly': return (st.caughtFly[t.i] || 0) > sim.tick || !sim.flyActive(rec, t.i) ? null : flyPos(c.flies[t.i], sim.tick);
    case 'caterpillar': return st.caughtCat[t.i] || !sim.catActive(rec, t.i) ? null : c.caterpillars[t.i];
    case 'bee': { const hv = sim.hivesIn(rec)[t.h]; return hv && !((st.beeLost[t.h] || {})[t.i]) ? beePos(hv, t.i, sim.tick) : null; }
    case 'flower': return sim.inBloom(rec, t.i) ? c.flowers[t.i] : null;
    case 'cup': { const cp = sim.cupsIn(rec).find((x) => x.i === t.i); return cp && !sim.canSpilled(t.key, cp.i) ? { x: cp.x, y: cp.level, z: cp.z } : null; }
    case 'bath': { const b = c.baths[t.i]; return b ? { x: b.x, y: b.h, z: b.z } : null; }
    case 'bird': case 'dragonfly': {
      const list = t.kind === 'bird' ? c.birds : c.dragonflies, s = (t.kind === 'bird' ? sim.birdState : sim.dragonState).get(t.key + '#' + t.i);
      return s ? { x: s.x, y: s.y, z: s.z } : list[t.i] ? (t.kind === 'bird' ? birdPos : dragonPos)(list[t.i], sim.tick) : null;
    }
    case 'web': return c.webs[t.i] || null;
  }
  return null;
}

// How fast a target is moving, m/s (zero for anything that stays put). Prey positions are functions of the tick, so this
// is exact: where it will be next tick, less where it is now. Chasing it, the pilots lead it and keep closing speed on top
// of its own instead of slowing to its pace.
export function targetVel(sim, t) {
  const Z = { x: 0, y: 0, z: 0 };
  if (!t) return Z;
  if (t.kind === 'wasp') { const x = sim.waspById(t.id) || sim.remote.get(t.id); return x ? { x: x.vx || 0, y: x.vy || 0, z: x.vz || 0 } : Z; }
  if (t.kind !== 'fly' && t.kind !== 'bee' && t.kind !== 'bird' && t.kind !== 'dragonfly') return Z;
  const rec = sim.records.get(t.key);
  if (!rec) return Z;
  const c = rec.content, k = sim.tick;
  let a = null, b = null;
  if (t.kind === 'fly') { const f = c.flies[t.i]; if (f) { a = flyPos(f, k); b = flyPos(f, k + 1); } }
  else if (t.kind === 'bee') { const hv = sim.hivesIn(rec)[t.h]; if (hv) { a = beePos(hv, t.i, k); b = beePos(hv, t.i, k + 1); } }
  else {
    const list = t.kind === 'bird' ? c.birds : c.dragonflies, s = (t.kind === 'bird' ? sim.birdState : sim.dragonState).get(t.key + '#' + t.i);
    if (s) return { x: s.vx || 0, y: s.vy || 0, z: s.vz || 0 };
    const f = t.kind === 'bird' ? birdPos : dragonPos;
    if (list[t.i]) { a = f(list[t.i], k); b = f(list[t.i], k + 1); }
  }
  return a && b ? { x: (b.x - a.x) * 60, y: (b.y - a.y) * 60, z: (b.z - a.z) * 60 } : Z;
}
export const CHASE = { moving: 0.05, lead: 0.5, close: 0.35, closeMin: 1 }; // m/s that counts as moving; the most lead, s; extra throttle share over its pace (manual); the least closing speed, m/s (pilot)

// Everything the wasp could lock on to round it, with where it is
function candidates(sim, w) {
  const out = [], R = LOCK.range * sim._mul(w, 'landR'); // the landing reach skill reaches further (GDD 6.8)
  const add = (t, p) => { if (p && d2(w, p) <= R * R) out.push({ t, p }); };
  for (const rec of sim.activeChunks) {
    if (Math.abs(rec.cx * T.chunk.size - w.x) > T.chunk.size / 2 + R || Math.abs(rec.cz * T.chunk.size - w.z) > T.chunk.size / 2 + R) continue;
    const key = chunkKey(rec.cx, rec.cz), c = rec.content;
    const one = (kind, i, extra = {}) => { const t = { kind, key, i, ...extra }; add(t, targetPos(sim, t)); };
    c.flies.forEach((_, i) => one('fly', i));
    c.caterpillars.forEach((_, i) => one('caterpillar', i));
    sim.hivesIn(rec).forEach((hv, h) => { for (let k = T.bees.guards; k < hv.bees.length; k++) one('bee', k, { h }); });
    c.flowers.forEach((_, i) => one('flower', i));
    sim.cupsIn(rec).forEach((cp) => one('cup', cp.i));
    c.baths.forEach((_, i) => one('bath', i));
    c.birds.forEach((_, i) => one('bird', i));
    c.dragonflies.forEach((_, i) => one('dragonfly', i));
    c.webs.forEach((_, i) => one('web', i));
  }
  for (const x of sim.wasps) if (x !== w && sim.isRival(x)) add({ kind: 'wasp', id: x.id }, targetPos(sim, { kind: 'wasp', id: x.id }));
  add({ kind: 'nest' }, sim.nest.entrance);
  return out;
}

// The spot on a person the aim passes nearest: a body part, a place along it and the side of it facing the wasp
function aimAtHuman(sim, w, aim) {
  let best = null, bestMiss = Infinity;
  for (const hm of sim.active) {
    if (hm.state === 'away' || hm.special || sq(hm.x - w.x) + sq(hm.z - w.z) > sq(LOCK.humanRange * sim._mul(w, 'landR'))) continue;
    const o = toLocal(hm, w), e = toLocal(hm, { x: w.x + aim.x, y: w.y + aim.y, z: w.z + aim.z }), dv = { x: e.x - o.x, y: e.y - o.y, z: e.z - o.z };
    for (const part of hm.parts[hm.posture] || hm.parts.stand) {
      // the point along the part nearest the aim line, by a few refinements from the middle
      let t = 0.5;
      for (let k = 0; k < 6; k++) {
        const q = { x: part.a.x + (part.b.x - part.a.x) * t, y: part.a.y + (part.b.y - part.a.y) * t, z: part.a.z + (part.b.z - part.a.z) * t };
        const s = Math.max(0, (q.x - o.x) * dv.x + (q.y - o.y) * dv.y + (q.z - o.z) * dv.z);
        t = segClosest(part.a, part.b, { x: o.x + dv.x * s, y: o.y + dv.y * s, z: o.z + dv.z * s }).t;
      }
      const q = { x: part.a.x + (part.b.x - part.a.x) * t, y: part.a.y + (part.b.y - part.a.y) * t, z: part.a.z + (part.b.z - part.a.z) * t };
      const s = Math.max(0, (q.x - o.x) * dv.x + (q.y - o.y) * dv.y + (q.z - o.z) * dv.z), r = { x: o.x + dv.x * s, y: o.y + dv.y * s, z: o.z + dv.z * s };
      const miss = Math.sqrt(d2(q, r)) - part.r;
      if (miss > LOCK.partSlack || miss >= bestMiss) continue;
      // the side of the part toward the wasp
      let nx = r.x - q.x, ny = r.y - q.y, nz = r.z - q.z;
      if (nx * nx + ny * ny + nz * nz < 1e-12) { nx = o.x - q.x; ny = o.y - q.y; nz = o.z - q.z; }
      const along = { x: part.b.x - part.a.x, y: part.b.y - part.a.y, z: part.b.z - part.a.z }, al = Math.max(1e-9, d2(along, { x: 0, y: 0, z: 0 }));
      const k = (nx * along.x + ny * along.y + nz * along.z) / al;
      nx -= along.x * k; ny -= along.y * k; nz -= along.z * k;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      bestMiss = miss; best = { kind: 'human', hex: hm.hex, part: part.name, t, n: { x: nx / nl, y: ny / nl, z: nz / nl } };
    }
  }
  return best;
}

// Lock on: the spot on a person under the aim; else whatever is closest to the aim within a narrow cone; else the
// nearest prey or hazard. aim is a unit direction from the wasp (where the camera looks).
export function pickTarget(sim, w, aim) {
  const h = aimAtHuman(sim, w, aim);
  if (h) return h;
  let best = null, bc = LOCK.coneCos;
  const cands = candidates(sim, w);
  for (const c of cands) {
    const dx = c.p.x - w.x, dy = c.p.y - w.y, dz = c.p.z - w.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-6) continue;
    const cos = (dx * aim.x + dy * aim.y + dz * aim.z) / d;
    if (cos > bc) { bc = cos; best = c.t; }
  }
  if (best) return best;
  let nd = sq(LOCK.nearRange * sim._mul(w, 'landR'));
  for (const c of cands) {
    const K = TARGET_KIND[c.t.kind];
    if (!K.prey && !K.hazard) continue;
    const q = d2(w, c.p);
    if (q < nd) { nd = q; best = c.t; }
  }
  return best;
}

// Where the pilot settles the wasp at a target, and from which side it comes in
function goalOf(sim, t, p) {
  const R = T.wasp.radius;
  if (t.kind === 'flower') return { x: p.x, y: p.y + T.land.headR + R + 0.001, z: p.z, above: true };
  if (t.kind === 'cup') return { x: p.x, y: p.y + 0.025, z: p.z, above: true };
  if (t.kind === 'bath') return { x: p.x, y: p.y + R + 0.004, z: p.z, above: true };
  if (t.kind === 'human') { const hm = sim.humanByHex(t.hex), hp = hm && humanPoint(hm, t); if (!hp) return null; return { x: hp.p.x + hp.n.x * (R + 0.006), y: hp.p.y + hp.n.y * (R + 0.006), z: hp.p.z + hp.n.z * (R + 0.006), n: hp.n }; }
  return { x: p.x, y: p.y, z: p.z };
}

// One tick of the pilot: the command that takes the wasp to the target and settles it there (or catches it).
// Returns { cmd, done } where done says why the flight is over ('arrived', 'gone', 'caught', 'landed', 'perched').
export function assistPilot(sim, w, t, cmd) {
  const K = TARGET_KIND[t.kind] || {};
  if (!K.go) return { cmd, done: 'no' };
  if (w.state === 'landed') {
    // settled next to its prey (a caterpillar on a stalk): grab it from there
    const pp = K.prey && !w.carry ? targetPos(sim, t) : null;
    if (pp && d2(w, pp) < sq(T.prey.catchDist * 1.4)) return { cmd: { ...cmd, mx: 0, my: 0, mz: 0, burst: 0, sting: 0, act: (sim.tick & 1) ? 1 : 0 }, done: null };
    // standing somewhere else: take off and go
    const tp = targetPos(sim, t), g = tp && goalOf(sim, t, tp);
    if (g && !(K.prey && w.carry) && d2(w, g) > sq(0.05)) return { cmd: { ...cmd, mx: 0, my: 100, mz: 0, burst: 0, sting: 0, act: 0 }, done: null };
    return { cmd, done: K.prey && w.carry ? 'caught' : 'landed' };
  }
  if (w.state === 'perched' || w.state === 'under') return { cmd, done: 'perched' };
  if (w.state !== 'fly') return { cmd, done: 'gone' };
  const p = targetPos(sim, t);
  if (!p) return { cmd, done: K.prey && w.carry ? 'caught' : 'gone' };
  if (K.prey && w.carry) return { cmd, done: 'caught' };
  const g0 = goalOf(sim, t, p);
  if (!g0) return { cmd, done: 'gone' };
  const top = T.wasp.cruise * (w.carry ? T.wasp.carrySpeedMul : 1);
  // a moving target: aim where it will be, and fly at its pace plus closing speed (with burst when it is quick)
  const v = targetVel(sim, t), vs = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z), moving = vs > CHASE.moving;
  let g = g0;
  if (moving) { const lead = Math.min(CHASE.lead, Math.sqrt(d2(w, g0)) / top); g = { ...g0, x: g0.x + v.x * lead, y: g0.y + v.y * lead, z: g0.z + v.z * lead }; }
  // come in from above for anything to land on, along the outward side for a person
  const hd = Math.sqrt(sq(g.x - w.x) + sq(g.z - w.z));
  let wp = g;
  if (g.above && hd > 0.06) wp = { x: g.x, y: g.y + Math.min(0.4, 0.3 * hd + 0.04), z: g.z };
  else if (g.n && Math.sqrt(d2(w, g)) > 0.2) wp = { x: g.x + g.n.x * 0.15, y: g.y + g.n.y * 0.15, z: g.z + g.n.z * 0.15 };
  const dx = wp.x - w.x, dy = wp.y - w.y, dz = wp.z - w.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz), dg = Math.sqrt(d2(w, g0)); // how near it really is
  const out = { ...cmd, mx: 0, my: 0, burst: 0, sting: 0 };
  if (K.prey && dg < T.prey.catchDist * 0.9) { out.mz = 0; out.act = (sim.tick & 1) ? 1 : 0; return { cmd: out, done: null }; } // grab it
  if (dg < 0.004 && !K.prey) { out.mz = 0; return { cmd: out, done: null }; } // hold still: it settles on its own
  const want = clamp(Math.min(d, dg) * 2.2, K.prey ? 0.3 : 0.06, top) * (dg < 0.15 && !K.prey ? 0.6 : 1);
  if (moving) { // its pace plus closing speed; burst when that is past cruising
    const close = Math.max(want, CHASE.closeMin), fast = vs + close > top, cap = fast ? T.wasp.burst * (w.carry ? T.wasp.carrySpeedMul : 1) : top;
    out.burst = fast ? 1 : 0;
    out.mz = Math.round(clamp((vs + close) / cap, 0, 1) * 100);
  } else out.mz = Math.round(clamp(want / top, 0, 1) * 100);
  out.yawQ = Math.round(datan2(dx, dz) * 1e4);
  out.pitchQ = Math.round(clamp(datan2(dy, Math.sqrt(dx * dx + dz * dz)), -1.45, 1.45) * 1e4);
  out.act = 0;
  return { cmd: out, done: null };
}

// The swoop with a lock (GDD 7.9): the dash homes on the target and the slam does what the target calls for (grab the
// prey, land on the flower, slam down on the person, dive home); locked on a danger, it dashes away from it instead.
// Tick 0 presses the swoop; after that it steers until the dash is spent or something was hit.
export function swoopPilot(sim, w, t, cmd, first) {
  const K = TARGET_KIND[t.kind] || {};
  if (w.state !== 'fly') return { cmd, done: w.state === 'landed' ? 'landed' : w.state === 'perched' ? 'perched' : 'gone' };
  if (!first && !(w.swoopUntil > sim.tick)) return { cmd, done: K.prey && w.carry ? 'caught' : 'spent' };
  const p = targetPos(sim, t);
  if (!p) return { cmd, done: 'gone' };
  const out = { ...cmd, mx: 0, my: 0, mz: 100, burst: 1, sting: 0, act: first ? Act.Swoop : 0 };
  let dx, dy, dz;
  if (K.hazard && !K.prey) { // away from it, a little down, toward cover
    dx = w.x - p.x; dz = w.z - p.z; const l = Math.sqrt(dx * dx + dz * dz) || 1; dx /= l; dz /= l; dy = -0.3;
  } else {
    const g = goalOf(sim, t, p) || p;
    dx = g.x - w.x; dy = g.y - w.y; dz = g.z - w.z;
    // full speed in, braking over the last half metre so it can turn onto the spot; a moving target is led, and the
    // braking keeps its pace on top
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz), v = targetVel(sim, t), vs = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (vs > CHASE.moving) { const lead = Math.min(CHASE.lead, d / T.swoop.speed); dx += v.x * lead; dy += v.y * lead; dz += v.z * lead; }
    out.mz = Math.round(clamp(d * 12 + (vs > CHASE.moving ? vs : 0), 1.5, T.swoop.speed) / T.swoop.speed * 100);
  }
  out.yawQ = Math.round(datan2(dx, dz) * 1e4);
  out.pitchQ = Math.round(clamp(datan2(dy, Math.sqrt(dx * dx + dz * dz)), -1.45, 1.45) * 1e4);
  return { cmd: out, done: null };
}

export const targetLabel = (sim, t) => {
  if (!t) return '';
  if (t.kind === 'human') return t.part.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/ ?L$/, ' (left)').replace(/ ?R$/, ' (right)').toLowerCase();
  return TARGET_KIND[t.kind] ? TARGET_KIND[t.kind].label : t.kind;
};
