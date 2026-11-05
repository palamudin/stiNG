// Lock-on and assisted flight (GDD 7.9): the player directs the wasp, the wasp flies. A lock picks something to fly
// relative to (the spot on a person the wasp was aimed at, or the thing under the aim, or the nearest prey or hazard);
// the pilot flies the wasp to it and settles there, or catches it. Pure functions of the sim that only build the
// driven wasp's commands, so an assisted flight is recorded and replayed like any other input.
import { T } from './tuning.js';
import { chunkKey, flyPos, beePos, birdPos, dragonPos } from './world.js';
import { toWorld, toLocal, segClosest, dirToWorld } from './body.js';
import { datan2, clamp, dsin, dcos } from './rng.js';
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
  moth: { label: 'moth', go: 'catch it', prey: true }, // at a porch light at night (T2-10)
  firefly: { label: 'firefly', go: 'catch it', prey: true }, // on summer evenings; spat out, it tastes foul
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
// The spot to fly to, off the locked spot by `off`, pushed out of any other part of the body that covers it (an arm
// swung over the side, the head over a shoulder): the nearest place there the wasp can be (GDD 19.6 T3-1)
function exposedSpot(hm, t, off) {
  const part = partOf(hm, t.part);
  if (!part) return null;
  const a = part.a, b = part.b, q = { x: a.x + (b.x - a.x) * t.t, y: a.y + (b.y - a.y) * t.t, z: a.z + (b.z - a.z) * t.t };
  let lp = { x: q.x + t.n.x * (part.r + off), y: q.y + t.n.y * (part.r + off), z: q.z + t.n.z * (part.r + off) };
  const parts = hm.parts[hm.posture] || hm.parts.stand;
  for (let it = 0; it < 3; it++) for (const o of parts) {
    const c = segClosest(o.a, o.b, lp), ex = lp.x - c.x, ey = lp.y - c.y, ez = lp.z - c.z, d = Math.sqrt(ex * ex + ey * ey + ez * ez), need = o.r + off;
    if (d < need && d > 1e-9) lp = { x: c.x + ex / d * need, y: c.y + ey / d * need, z: c.z + ez / d * need };
  }
  return toWorld(hm, lp);
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
    case 'firefly': { const f = sim.fireflySpots(rec)[t.i]; return f && sim.fireflyTime() ? sim.fireflyPos(f, sim.tick) : null; }
    case 'moth': { // circling its porch light while it is lit and not taken
      if (!sim.lit() || sim.raining || (st.caughtMoth && st.caughtMoth[t.i] > sim.tick)) return null;
      const L = sim.lightsIn(rec), li = Math.floor(t.i / T.moths.perLight);
      return li < L.length ? sim.mothPos(L[li], t.i % T.moths.perLight, sim.tick) : null;
    }
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
  if (t.kind === 'human') { const hm = sim.humanByHex(t.hex); return hm && hm.state !== 'away' ? { x: hm.vx || 0, y: 0, z: hm.vz || 0 } : Z; } // a person's pace over their last step
  if (t.kind !== 'fly' && t.kind !== 'bee' && t.kind !== 'bird' && t.kind !== 'dragonfly' && t.kind !== 'moth' && t.kind !== 'firefly') return Z;
  const rec = sim.records.get(t.key);
  if (!rec) return Z;
  const c = rec.content, k = sim.tick;
  let a = null, b = null;
  if (t.kind === 'fly') { const f = c.flies[t.i]; if (f) { a = flyPos(f, k); b = flyPos(f, k + 1); } }
  else if (t.kind === 'firefly') { const f = sim.fireflySpots(rec)[t.i]; if (f) { a = sim.fireflyPos(f, k); b = sim.fireflyPos(f, k + 1); } }
  else if (t.kind === 'moth') { const L = sim.lightsIn(rec), li = Math.floor(t.i / T.moths.perLight); if (li < L.length) { a = sim.mothPos(L[li], t.i % T.moths.perLight, k); b = sim.mothPos(L[li], t.i % T.moths.perLight, k + 1); } }
  else if (t.kind === 'bee') { const hv = sim.hivesIn(rec)[t.h]; if (hv) { a = beePos(hv, t.i, k); b = beePos(hv, t.i, k + 1); } }
  else {
    const list = t.kind === 'bird' ? c.birds : c.dragonflies, s = (t.kind === 'bird' ? sim.birdState : sim.dragonState).get(t.key + '#' + t.i);
    if (s) return { x: s.vx || 0, y: s.vy || 0, z: s.vz || 0 };
    const f = t.kind === 'bird' ? birdPos : dragonPos;
    if (list[t.i]) { a = f(list[t.i], k); b = f(list[t.i], k + 1); }
  }
  return a && b ? { x: (b.x - a.x) * 60, y: (b.y - a.y) * 60, z: (b.z - a.z) * 60 } : Z;
}
export const CHASE = { moving: 0.05, lead: 0.5, closeMin: 2 }; // m/s that counts as moving; the most lead, s; the least closing speed, m/s (pilot)

// Obstacle avoidance for the assisted flight: a short look ahead along the line it means to fly, against what a wasp
// collides with (boxes: fences, tables, walls; cylinders: trunks, poles, birdbaths; pitched roofs), each grown by a
// clearance. Sampled every step m from step on (so a surface it is just leaving does not count), up to look m, which
// grows with speed (lookT s) between lookMin and lookMax; never closer than stopShort to where it is going, so the
// spot it lands on is not an obstacle. Blocked, it tries headings turned and climbing (turns: [yaw, pitch] off the
// line, radians), scores each by how far it strays plus keep times how far it leaves its present course (so it does not
// flip between sides), and flies the best clear one. With none clear (pinned against a fence, say) it takes the one
// that stays clear longest: straight up, or back and up, to get round. The ground is not an obstacle.
export const AVOID = { clear: 0.03, step: 0.05, lookMin: 0.3, lookMax: 1, lookT: 0.35, stopShort: 0.12, keep: 0.6, maxPitch: 1.45, seeMax: 2, blind: 2,
  turns: [[0, 0.5], [0.5, 0], [-0.5, 0], [0.5, 0.5], [-0.5, 0.5], [0, 1], [1, 0], [-1, 0], [1, 0.5], [-1, 0.5], [1.5, 0], [-1.5, 0], [0, 1.3], [0, 3], [3.14159, 1.6]] };
// Is there anything solid near point (x, y, z), within c? recs: the chunks to look in
function solidAt(sim, recs, x, y, z, c) {
  for (const rec of recs) {
    for (const b of rec.content.boxes) if (x > b.minx - c && x < b.maxx + c && y > b.miny - c && y < b.maxy + c && z > b.minz - c && z < b.maxz + c) return true;
    const cyls = sim._cylsOf(rec);
    for (const k of sim._cylGrid(rec).near(x, z, c)) { const cy = cyls[k]; if (y < cy.h + c && sq(x - cy.x) + sq(z - cy.z) < sq(cy.r + c)) return true; } // (S7: the trunks near)
    for (const f of sim._roofsOf(rec)) {
      const r = sim._roofLocal(f, { x, y, z }), au = Math.abs(r.u), av = Math.abs(r.v);
      if (av > f.half + c || au > f.S + c || r.y < -c || r.y > f.rise + c) continue;
      if ((f.rise * (au - f.S) + f.S * r.y) / f.L < c && av - f.half < c) return true;
    }
  }
  return false;
}
// How far the way from (x, y, z) along unit d is clear, up to len m (len when it all is)
export function clearLen(sim, x, y, z, d, len) {
  const A = AVOID, c = T.wasp.radius + A.clear, ex = x + d.x * len, ez = z + d.z * len, CS = T.chunk.size;
  const lox = Math.min(x, ex) - c, hix = Math.max(x, ex) + c, loz = Math.min(z, ez) - c, hiz = Math.max(z, ez) + c;
  const recs = sim.activeChunks.filter((r) => r.cx * CS + CS / 2 >= lox - 2 && r.cx * CS - CS / 2 <= hix + 2 && r.cz * CS + CS / 2 >= loz - 2 && r.cz * CS - CS / 2 <= hiz + 2);
  const n = Math.floor(len / A.step);
  for (let k = 1; k <= n; k++) {
    const s = k * A.step, py = y + d.y * s;
    if (py < c) continue; // the ground is not in the way
    if (solidAt(sim, recs, x + d.x * s, py, z + d.z * s, c)) return (k - 1) * A.step;
  }
  return len;
}
// The heading to fly toward (dx, dy, dz) from the wasp, round whatever is in the way: { yaw, pitch, turned }
export function avoidHeading(sim, w, dx, dy, dz, dist) {
  const A = AVOID, hd = Math.sqrt(dx * dx + dz * dz), yaw0 = datan2(dx, dz), pitch0 = datan2(dy, hd);
  const sp = Math.sqrt(w.vx * w.vx + w.vy * w.vy + w.vz * w.vz), len = Math.min(clamp(sp * A.lookT + A.lookMin, A.lookMin, A.lookMax), dist - A.stopShort);
  const dir = (yaw, pitch) => ({ x: dsin(yaw) * dcos(pitch), y: dsin(pitch), z: dcos(yaw) * dcos(pitch) });
  if (len < A.step || clearLen(sim, w.x, w.y, w.z, dir(yaw0, pitch0), len) >= len) return { yaw: yaw0, pitch: pitch0, turned: false };
  let best = null, bs = Infinity, far = null, fl = A.step;
  for (const [yo, po] of A.turns) {
    const yaw = yaw0 + yo, pitch = clamp(pitch0 + po, -A.maxPitch, A.maxPitch), d = dir(yaw, pitch);
    let sc = Math.abs(yo) + Math.abs(po);
    if (sp > 0.3) sc += A.keep * (1 - (d.x * w.vx + d.y * w.vy + d.z * w.vz) / sp);
    if (sc >= bs && best) continue;
    const cl = clearLen(sim, w.x, w.y, w.z, d, len);
    if (cl >= len) {
      // a way that only runs along the obstacle (a long fence) gets nowhere: rather one from whose end the goal shows
      const ex = dx - d.x * len, ey = dy - d.y * len, ez = dz - d.z * len, el = Math.sqrt(ex * ex + ey * ey + ez * ez), m = Math.min(el - A.stopShort, A.seeMax);
      if (m >= A.step && clearLen(sim, w.x + d.x * len, w.y + d.y * len, w.z + d.z * len, { x: ex / el, y: ey / el, z: ez / el }, m) < m) sc += A.blind;
      if (sc < bs) { bs = sc; best = { yaw, pitch, turned: true }; }
    }
    else if (cl > fl) { fl = cl; far = { yaw, pitch, turned: true }; } // none clear yet: the one that gets furthest
  }
  return best || far || { yaw: yaw0, pitch: pitch0, turned: false }; // boxed in: straight on, and slide as before
}

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
    for (const mo of sim.mothsIn(rec)) one('moth', mo.i);
    for (const ff of sim.firefliesIn(rec)) one('firefly', ff.i);
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
  if (t.kind === 'human') { const hm = sim.humanByHex(t.hex), hp = hm && humanPoint(hm, t), e = hp && exposedSpot(hm, t, R + 0.006); if (!e) return null; return { x: e.x, y: e.y, z: e.z, n: hp.n }; }
  return { x: p.x, y: p.y, z: p.z };
}

// Landing: the share of its acceleration it counts on to brake with, the step of the look along a straight way in
// past a person's body, and how near the goal that look stops (GDD 7.9)
export const LAND = { brake: 0.5, bodyStep: 0.02, bodyStop: 0.03, spot: 0.04, stall: 90, gap: 60 }; // spot: how near the locked spot on a walker it lets go; stall: ticks touching them before it settles where it is
// Can it fly straight to the goal? Not into a drink or water (over the rim), nor through anything solid, nor through
// the person it is going to land on
function straightIn(sim, w, t, g) {
  if (t.kind === 'cup' || t.kind === 'bath') return false;
  const dx = g.x - w.x, dy = g.y - w.y, dz = g.z - w.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz), len = d - LAND.bodyStop;
  if (len <= 0) return true;
  const u = { x: dx / d, y: dy / d, z: dz / d };
  if (clearLen(sim, w.x, w.y, w.z, u, len) < len) return false;
  if (t.kind !== 'human') return true;
  const hm = sim.humanByHex(t.hex), R = T.wasp.radius;
  if (!hm) return false;
  const parts = hm.parts[hm.posture] || hm.parts.stand, n = Math.floor(len / LAND.bodyStep);
  for (let k = 0; k <= n; k++) {
    const s = k * LAND.bodyStep, lp = toLocal(hm, { x: w.x + u.x * s, y: w.y + u.y * s, z: w.z + u.z * s });
    for (const part of parts) { const q = segClosest(part.a, part.b, lp); if (sq(lp.x - q.x) + sq(lp.y - q.y) + sq(lp.z - q.z) < sq(part.r + R)) return false; }
  }
  return true;
}

// Routes past long walls (GDD 19.6 T3-1). The look-ahead above sees a metre; a house front, a mall or a run of fence
// is longer than that, and turning along it never shows the goal. When the straight way to a goal further than `far`
// is blocked by a box (a wall, a fence, a house, a shed, a table), the pilot picks a waypoint: over the box (its top,
// and the roof on a shed or house, plus `clearTop`) or round one of its corners, `margin` out, whichever is shortest
// with a clear way there (climbing counts half as much again; a waypoint still behind the same wall, the box and every
// box joined to it, costs `blocked`).
// The waypoint is planned again every `every` ticks, when it is reached, or when the goal moves `moved`. Planning is
// the pilot's own: client-side, kept per sim and wasp, never in the sim's state.
export const ROUTE = { far: 1.2, margin: 0.45, clearTop: 0.35, skin: 0.05, every: 12, moved: 0.3, reached: 0.3, climb: 1.5, blocked: 5 };
const routeMemo = new WeakMap();
function boxesAlong(sim, a, b) {
  const CS = T.chunk.size, lox = Math.min(a.x, b.x) - 2, hix = Math.max(a.x, b.x) + 2, loz = Math.min(a.z, b.z) - 2, hiz = Math.max(a.z, b.z) + 2, out = [];
  for (const r of sim.activeChunks) if (r.cx * CS + CS / 2 >= lox && r.cx * CS - CS / 2 <= hix && r.cz * CS + CS / 2 >= loz && r.cz * CS - CS / 2 <= hiz) for (const b of r.content.boxes) out.push(b);
  return out;
}
// Where the straight way from a to b first enters box bx grown by m, as a share of the way (0..1), or -1 if it misses
function boxEntry(a, b, bx, m) {
  let t0 = 0, t1 = 1;
  const A = [a.x, a.y, a.z], B = [b.x, b.y, b.z], LO = [bx.minx - m, bx.miny - m, bx.minz - m], HI = [bx.maxx + m, bx.maxy + m, bx.maxz + m];
  for (let i = 0; i < 3; i++) {
    const d = B[i] - A[i];
    if (Math.abs(d) < 1e-9) { if (A[i] < LO[i] || A[i] > HI[i]) return -1; continue; }
    let u = (LO[i] - A[i]) / d, v = (HI[i] - A[i]) / d;
    if (u > v) { const q = u; u = v; v = q; }
    if (u > t0) t0 = u;
    if (v < t1) t1 = v;
    if (t0 > t1) return -1;
  }
  return t0;
}
const inBox = (p, bx, m) => p.x > bx.minx - m && p.x < bx.maxx + m && p.y > bx.miny - m && p.y < bx.maxy + m && p.z > bx.minz - m && p.z < bx.maxz + m;
function firstBox(boxes, a, b, g) {
  let hit = null, ht = 2;
  for (const bx of boxes) {
    if (inBox(g, bx, 2 * ROUTE.skin)) continue; // the goal's own surface
    const t = boxEntry(a, b, bx, ROUTE.skin);
    if (t >= 0 && t < ht) { ht = t; hit = bx; }
  }
  return hit ? { bx: hit, t: ht } : null;
}
// The boxes joined to b, end to end or touching (a run of fence sections, a shop against its neighbour): one wall
function wallOf(boxes, b) {
  const set = [b], m = ROUTE.skin * 2;
  for (let i = 0; i < set.length && set.length < 64; i++) {
    const q = set[i];
    for (const o of boxes) if (!set.includes(o) && o.minx < q.maxx + m && o.maxx > q.minx - m && o.minz < q.maxz + m && o.maxz > q.minz - m && o.miny < q.maxy + m && o.maxy > q.miny - m) set.push(o);
  }
  return set;
}
export function routeWaypoint(sim, w, g) {
  const R = ROUTE, a = { x: w.x, y: w.y, z: w.z }, boxes = boxesAlong(sim, a, g), f = firstBox(boxes, a, g, g);
  if (!f) return null;
  const b = f.bx, wall = wallOf(boxes, b), M = R.margin, top = b.maxy + (b.shed ? (b.wood ? 0.55 : 1.9) : 0) + R.clearTop, y = Math.max(a.y, 0.4);
  const cands = [{ x: a.x + (g.x - a.x) * f.t, y: top, z: a.z + (g.z - a.z) * f.t, up: true },
    { x: b.minx - M, y, z: b.minz - M }, { x: b.maxx + M, y, z: b.minz - M }, { x: b.minx - M, y, z: b.maxz + M }, { x: b.maxx + M, y, z: b.maxz + M }];
  let best = null, bc = Infinity;
  for (const c of cands) {
    if (firstBox(boxes, a, c, g)) continue; // no clear way there
    const l1 = Math.sqrt(sq(c.x - a.x) + sq(c.y - a.y) + sq(c.z - a.z)), l2 = Math.sqrt(sq(g.x - c.x) + sq(g.y - c.y) + sq(g.z - c.z));
    const on = firstBox(boxes, c, g, g); // still behind the same wall from there: that way gets nowhere
    const cost = l1 + l2 + (c.up ? (R.climb - 1) * Math.max(0, c.y - a.y) : 0) + (on && wall.includes(on.bx) ? R.blocked : 0);
    if (cost < bc) { bc = cost; best = { x: c.x, y: c.y, z: c.z }; }
  }
  return best;
}
function routeOf(sim, w, g) {
  let m = routeMemo.get(sim);
  if (!m) { m = new Map(); routeMemo.set(sim, m); }
  const R = ROUTE, c = m.get(w.id);
  if (c && sim.tick >= c.tick && sim.tick - c.tick < R.every && sq(c.g.x - g.x) + sq(c.g.y - g.y) + sq(c.g.z - g.z) < sq(R.moved) && !(c.wp && d2(w, c.wp) < sq(R.reached))) return c.wp;
  const wp = routeWaypoint(sim, w, g);
  m.set(w.id, { tick: sim.tick, g: { x: g.x, y: g.y, z: g.z }, wp });
  return wp;
}

// A spot on a walker the wasp has been touching them for `stall` ticks without reaching (under a swinging arm, say):
// it settles where it is, as near as it got. Touching them again after `gap` ticks off them starts the count again.
const spotMemo = new WeakMap();
function spotStalled(sim, w) {
  let m = spotMemo.get(sim);
  if (!m) { m = new Map(); spotMemo.set(sim, m); }
  const c = m.get(w.id);
  if (!c || sim.tick < c.seen || sim.tick - c.seen > LAND.gap) { m.set(w.id, { first: sim.tick, seen: sim.tick }); return false; }
  c.seen = sim.tick;
  return sim.tick - c.first > LAND.stall;
}

// One tick of the pilot: the command that takes the wasp to the target and settles it there (or catches it).
// Returns { cmd, done } where done says why the flight is over ('arrived', 'gone', 'caught', 'landed', 'perched').
export function assistPilot(sim, w, t, cmd) {
  const K = TARGET_KIND[t.kind] || {};
  if (!K.go) return { cmd, done: 'no' };
  if (t.kind === 'firefly' && w.spat >= sim.tick - 2) return { cmd, done: 'spat' }; // taken and spat out
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
  const hurry = !!cmd.burst; // Shift held on an assisted flight: it flies there at burst speed (and still slows to settle)
  const top = (hurry ? T.wasp.burst : T.wasp.cruise) * (w.carry ? T.wasp.carrySpeedMul : 1);
  // a moving target: fly its velocity plus closing speed toward it (with burst when that is quick), so the gap shrinks
  // whichever way it goes
  const v = targetVel(sim, t), vs = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z), moving = vs > CHASE.moving;
  const g = g0;
  // straight in when the way is open; else from above for anything to land on, along the outward side for a person
  const hd = Math.sqrt(sq(g.x - w.x) + sq(g.z - w.z));
  let wp = g, routed = false;
  if (!moving && straightIn(sim, w, t, g)) wp = g;
  else if (!moving && hd > ROUTE.far && (wp = routeOf(sim, w, g) || g) !== g) routed = true; // past a long wall
  else if (g.above && hd > 0.06) wp = { x: g.x, y: g.y + Math.min(0.4, 0.3 * hd + 0.04), z: g.z };
  else if (g.n && Math.sqrt(d2(w, g)) > 0.2) wp = { x: g.x + g.n.x * 0.15, y: g.y + g.n.y * 0.15, z: g.z + g.n.z * 0.15 };
  const dx = wp.x - w.x, dy = wp.y - w.y, dz = wp.z - w.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz), dg = Math.sqrt(d2(w, g0)); // how near it really is
  const out = { ...cmd, mx: 0, my: 0, burst: hurry ? 1 : 0, sting: 0 };
  if (K.prey && dg < T.prey.catchDist * 0.9) { out.mz = 0; out.act = (sim.tick & 1) ? 1 : 0; return { cmd: out, done: null }; } // grab it
  if (dg < 0.004 && !K.prey) { out.mz = 0; out.burst = 0; return { cmd: out, done: null }; } // hold still: it settles on its own
  // touching the person at their pace on the spot locked: let go of the controls and it settles there (a walker too;
  // touching them anywhere else, it keeps flying on along them to the spot, GDD 19.6 T3-1)
  const onThem = moving && t.kind === 'human' && w.contact && w.contact.humanHex === t.hex ? sim.humanByHex(t.hex) : null;
  const stalled = onThem ? spotStalled(sim, w) : false; // kept up every tick it touches them
  if (onThem && sq(w.vx - v.x) + sq(w.vy) + sq(w.vz - v.z) < sq(T.land.maxSpeed) && (dg < LAND.spot || stalled)) { out.mz = 0; out.burst = 0; return { cmd: out, done: null }; }
  // as fast as it can still stop in: cruising until the braking distance, then down to a crawl at the spot
  const want = moving ? clamp(Math.min(d, dg) * 2.2, K.prey ? 0.3 : 0.06, top) * (dg < 0.15 && !K.prey ? 0.6 : 1)
    : clamp(Math.sqrt(2 * T.wasp.accel * LAND.brake * (routed ? dg : Math.min(d, dg))), K.prey ? 0.3 : 0.06, top); // a waypoint is flown through
  let fx = dx, fy = dy, fz = dz; // the way to fly
  if (moving) { // its velocity plus closing speed (prey is run down; a person is come up to gently); burst when that is past cruising
    const close = (K.prey ? Math.max(want, CHASE.closeMin) : want) / Math.max(d, 1e-6);
    fx = v.x + dx * close; fy = v.y + dy * close; fz = v.z + dz * close;
    if (onThem) { // touching them: slide along the body toward the spot rather than press into it
      const nW = dirToWorld(onThem, w.contact.n);
      let rx = fx - v.x, ry = fy - v.y, rz = fz - v.z;
      const dn = rx * nW.x + ry * nW.y + rz * nW.z;
      if (dn < 0) { rx -= dn * nW.x; ry -= dn * nW.y; rz -= dn * nW.z; fx = v.x + rx; fy = v.y + ry; fz = v.z + rz; }
    }
    { // the air moves it too: ask for the velocity less the wind's share, so it closes on the spot even downwind (T3-1)
      const wd = sim._drift(w), k = Math.min(1, Math.sqrt(fx * fx + fy * fy + fz * fz) / top);
      fx -= wd.x * k; fz -= wd.z * k;
    }
    const sp = Math.sqrt(fx * fx + fy * fy + fz * fz), fast = sp > top, cap = fast ? T.wasp.burst * (w.carry ? T.wasp.carrySpeedMul : 1) : top;
    out.burst = fast || hurry ? 1 : 0;
    out.mz = Math.round(clamp(sp / cap, 0, 1) * 100);
  } else out.mz = Math.round(clamp(want / top, 0, 1) * 100);
  const h = avoidHeading(sim, w, dx, dy, dz, d); // round what is in the way
  if (!h.turned) {
    out.yawQ = Math.round(datan2(fx, fz) * 1e4);
    out.pitchQ = Math.round(clamp(datan2(fy, Math.sqrt(fx * fx + fz * fz)), -1.45, 1.45) * 1e4);
  } else {
    out.yawQ = Math.round(h.yaw * 1e4);
    out.pitchQ = Math.round(clamp(h.pitch, -1.45, 1.45) * 1e4);
    if (!moving) out.mz = Math.max(out.mz, 50); // keep moving round it
  }
  out.act = 0;
  return { cmd: out, done: null };
}

// Hovering round a lock (GDD 7.9): H holds the wasp a short way off the target, facing it, and lets it drift slowly round
// it at its own unhurried speed, matching its pace if it moves; from there E lands at once. Any move key takes over.
// r, m off it; up, m above it; speed, m/s at most on top of the target's; orbit, rad/s round it; gain, 1/s back to station
export const HOVER = { r: 0.35, up: 0.1, speed: 1.2, orbit: 0.5, gain: 3, rMin: 0.15, rMax: 1.2, orbitMax: 1.5 };
// The player's own hover (GDD 19.6 T3-1): how far off and how fast round, set with the mouse wheel while hovering
export function hoverSetting(r = HOVER.r, orbit = HOVER.orbit) { return { r: clamp(r, HOVER.rMin, HOVER.rMax), orbit: clamp(orbit, -HOVER.orbitMax, HOVER.orbitMax) }; }
export function hoverPilot(sim, w, t, cmd, set = HOVER) {
  if (w.state === 'landed' || w.state === 'perched') return { cmd: { ...cmd, mx: 0, my: 100, mz: 0, burst: 0, sting: 0, act: 0 }, done: null }; // up first
  if (w.state !== 'fly') return { cmd, done: 'gone' };
  const p = targetPos(sim, t);
  if (!p) return { cmd, done: 'gone' };
  const H = HOVER, v = targetVel(sim, t);
  // the station: on the wasp's side of the target, a little further round each tick
  let ux = w.x - p.x, uz = w.z - p.z;
  const ul = Math.sqrt(ux * ux + uz * uz);
  if (ul < 1e-6) { ux = 1; uz = 0; } else { ux /= ul; uz /= ul; }
  const a = datan2(ux, uz) + set.orbit / H.gain, sx = p.x + dsin(a) * set.r, sy = p.y + H.up, sz = p.z + dcos(a) * set.r;
  // the velocity that takes it there and keeps it there: the target's own, plus the way back to station
  let fx = (sx - w.x) * H.gain, fy = (sy - w.y) * H.gain, fz = (sz - w.z) * H.gain;
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (fl > H.speed) { fx *= H.speed / fl; fy *= H.speed / fl; fz *= H.speed / fl; }
  fx += v.x; fy += v.y; fz += v.z;
  // facing the target, level: forward and sideways on the move keys, up and down on climb
  const yaw = datan2(p.x - w.x, p.z - w.z), sy0 = dsin(yaw), cy0 = dcos(yaw), top = T.wasp.cruise * (w.carry ? T.wasp.carrySpeedMul : 1);
  let mz = (fx * sy0 + fz * cy0) / top, mx = (-fx * cy0 + fz * sy0) / top, my = fy / T.wasp.climb;
  const m = Math.sqrt(mz * mz + mx * mx + my * my);
  if (m > 1) { mz /= m; mx /= m; my /= m; }
  return { cmd: { ...cmd, mx: Math.round(mx * 100), my: Math.round(my * 100), mz: Math.round(mz * 100), burst: 0, sting: 0, act: 0, yawQ: Math.round(yaw * 1e4), pitchQ: 0 }, done: null };
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
