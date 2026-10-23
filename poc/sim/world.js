// World generation, clock, weather and schedules (GDD 4, 5, 8.2). All pure functions of seed and time.
import { Domain, hash, unit, range, rangeInt, u64, dsin, dcos, TAU, rnd, datan2 } from './rng.js';
import { T } from './tuning.js';

const CS = T.chunk.size;
export const chunkOf = (v) => Math.floor(v / CS + 0.5);
export const chunkKey = (cx, cz) => cx + ',' + cz;

export const NEST = { x: -3, y: 2.3, z: -1.55, r: 0.14, treeX: -3, treeZ: -2 };
export const NEST_ENTRANCE = { x: NEST.x, y: NEST.y - NEST.r * 1.25, z: NEST.z };
export const SPAWN = { x: -3, y: 2.05, z: -1.25, yaw: 0.98 };

// A nest hanging from a tree (GDD 6.6). The first one is in the home tree; founding queens pick their own.
// site: 'trunk' (paper nest against a trunk), 'ground' (old burrow, entrance in the grass), 'branch' (hanging in the canopy)
// 'wall' and 'attic' are inside a shed: (x, y, z) is the entrance on the outside face, (treeX, treeZ) a point inside.
export function makeNest(treeX, treeZ, x, y, z, r = NEST.r, site = 'trunk') {
  const inside = site === 'wall' || site === 'attic' || site === 'hollow';
  const entrance = site === 'ground' ? { x, y: 0.02, z } : inside ? { x, y, z } : { x, y: y - r * 1.25, z };
  let spawn = site === 'ground' ? { x, y: 0.3, z: z + 0.3, yaw: 0.98 } : { x, y: entrance.y - 0.1, z: z + 0.3, yaw: 0.98 };
  if (inside) { const dx = x - treeX, dz = z - treeZ, d = Math.sqrt(dx * dx + dz * dz) || 1; spawn = { x: x + dx / d * 0.3, y, z: z + dz / d * 0.3, yaw: datan2(dx, dz) }; }
  return { x, y, z, r, treeX, treeZ, entrance, spawn, site, key: chunkKey(chunkOf(x), chunkOf(z)) };
}

// ---------------------------------------------------------------- clock and weather (GDD 5)

export const ticksPerMinute = (settings) => rnd(settings.dayMinutes * 2.5);
export function clockMinutes(tickEff, settings) { return T.time.startMinute + Math.floor(tickEff / ticksPerMinute(settings)); }
export const dayOf = (m) => Math.floor(m / 1440);
export const minuteOfDay = (m) => m - dayOf(m) * 1440;
export const fmtClock = (m) => { const d = minuteOfDay(m); return String(Math.floor(d / 60)).padStart(2, '0') + ':' + String(d % 60).padStart(2, '0'); };

const weatherCache = new Map();
export function dayWeather(seed, day) {
  const key = seed + ':' + day;
  let w = weatherCache.get(key);
  if (w) return w;
  const H = (i) => hash(seed, Domain.Weather, BigInt(day), BigInt(i));
  const rain = day > 0 && unit(H(0)) < T.weather.rainChance;
  const rainStart = 11 * 60 + rangeInt(H(1), 0, 6 * 60);
  w = {
    day, rain, rainStart, rainEnd: rainStart + 60 + rangeInt(H(2), 0, 120), base: range(H(3), T.weather.baseMin, T.weather.baseMax),
    wind: range(H(4), T.wind.min, T.wind.max) * (rain ? T.wind.rainMul : 1), windDir: range(H(5), 0, TAU),
  };
  weatherCache.set(key, w);
  return w;
}
export function isRaining(seed, m) {
  const w = dayWeather(seed, dayOf(m)), d = minuteOfDay(m);
  return w.rain && d >= w.rainStart && d < w.rainEnd;
}
export function tempAt(seed, m) {
  const w = dayWeather(seed, dayOf(m)), d = minuteOfDay(m);
  return w.base + T.weather.diurnalAmp * dsin(TAU * (d - 540) / 1440) - (isRaining(seed, m) ? 4 : 0);
}
// The wind at a minute, as a velocity (m/s) in the open at reference height: calm at night and dawn,
// strongest mid-afternoon. Gusts and the drop near the ground are applied where the wind meets a wasp.
export function windAt(seed, m) {
  const w = dayWeather(seed, dayOf(m)), d = minuteOfDay(m);
  const s = w.wind * (0.35 + 0.65 * Math.max(0, dsin(TAU * (d - 540) / 1440)));
  return { x: s * dsin(w.windDir), z: s * dcos(w.windDir) };
}
export function isDaylight(m) { const d = minuteOfDay(m); return d >= T.time.dawn && d < T.time.dusk; }

// When a human is in the park on a given day (GDD 8.2). Returns null when absent.
export function humanWindow(seed, id, day, density = 1) {
  const H = (i) => hash(seed, Domain.HumanSchedule, id, BigInt(day), BigInt(i));
  if (day > 0 && unit(H(0)) > 0.85 * density) return null;
  let arrive = day === 0 ? 0 : 600 + rangeInt(H(1), 0, 150);
  let leave = 1020 + rangeInt(H(2), 0, 180);
  const w = dayWeather(seed, day);
  if (w.rain) {
    if (arrive < w.rainStart) leave = Math.min(leave, w.rainStart);
    else if (w.rainEnd + 30 < leave) arrive = w.rainEnd + 30;
    else return null;
  }
  return { arrive, leave };
}

// ---------------------------------------------------------------- prey and bees (pure motion)

export function flyPos(f, tick) {
  const t = tick / 60;
  return {
    x: f.x + f.r * dsin(f.w1 * t + f.p1),
    y: f.y + 0.1 * dsin(f.w2 * t + f.p2),
    z: f.z + f.r * dcos(f.w3 * t + f.p3),
  };
}

// A bird on its patrol circle (pure function of time).
export function birdPos(b, tick) {
  const a = ((tick + b.phase) / b.period) * 6.283185307179586 * b.dir;
  return { x: b.x + b.r * dcos(a), y: b.y + 0.6 * dsin(a * 3), z: b.z + b.r * dsin(a) };
}

// A dragonfly on patrol: quick loops with darting height changes
export function dragonPos(b, tick) {
  const a = ((tick + b.phase) / b.period) * 6.283185307179586 * b.dir;
  return { x: b.x + b.r * dcos(a) * (1 + 0.3 * dsin(a * 2)), y: b.y + 0.25 * dsin(a * 5), z: b.z + b.r * dsin(a) };
}

// Shed nest sites: a crack in one wall at chest height, and the gap under the eaves on one side.
// (x, z) is just outside the face; (ix, iz) is inside the shed.
export function shedSites(sh) {
  const faces = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const at = (f, y) => {
    const [fx, fz] = faces[f], ex = fx ? fx * (sh.hw + 0.01) : 0.3, ez = fz ? fz * (sh.hd + 0.01) : -0.2;
    return { x: sh.x + ex, y, z: sh.z + ez, ix: sh.x + ex - fx * 0.3, iz: sh.z + ez - fz * 0.3, nx: fx, nz: fz };
  };
  return { wall: at(sh.crack, 1.0), attic: at(sh.eave, sh.h - 0.08) };
}

// Bee k of a hive. Guards circle the entrance; foragers commute to a flower and back.
export function beePos(hive, k, tick) {
  const b = hive.bees[k];
  const t = tick / 60;
  if (b.guard) {
    const a = b.p + t * b.w;
    return { x: hive.ex + 0.13 * dcos(a), y: hive.ey + 0.05 + 0.04 * dsin(a * 1.7), z: hive.ez + 0.13 * dsin(a) };
  }
  const P = b.period, u = ((tick + b.phase) % P) / P;
  const fx = b.tx, fy = b.ty + 0.04, fz = b.tz;
  if (u < 0.4 || u >= 0.6) {
    const s = u < 0.4 ? u / 0.4 : 1 - (u - 0.6) / 0.4;
    const arc = 1.4 * dsin(3.141592653589793 * s);
    return { x: hive.ex + (fx - hive.ex) * s, y: hive.ey + (fy - hive.ey) * s + arc, z: hive.ez + (fz - hive.ez) * s };
  }
  const a = (u - 0.4) * 60 + b.p;
  return { x: fx + 0.05 * dcos(a), y: fy + 0.02 * dsin(a * 1.3), z: fz + 0.05 * dsin(a) };
}

// ---------------------------------------------------------------- chunk generation (GDD 4.3)

export function generateChunk(seed, cx, cz) {
  const H = (slot) => hash(seed, Domain.WorldGen, u64(cx), u64(cz), BigInt(slot));
  const ox = cx * CS, oz = cz * CS;
  const c = {
    cx, cz, tint: unit(H(0)), trees: [], tables: [], benches: [], cans: [], flowers: [], caterpillars: [], flies: [],
    humans: [], boxes: [], cylinders: [], sugar: [], hives: [], traps: [], nest: null,
    webs: [], birds: [], rival: null, sheds: [], dragonflies: [],
  };
  const occupied = [];
  const isOrigin = cx === 0 && cz === 0;
  const free = (x, z, r) => occupied.every((o) => { const dx = x - o.x, dz = z - o.z; return dx * dx + dz * dz > (r + o.r) * (r + o.r); });
  const addFly = (x, y, z, slot) => {
    c.flies.push({
      x, y, z, r: T.prey.flyOrbit * range(H(slot), 0.6, 1.2),
      w1: range(H(slot + 1), 1.2, 2.6), w2: range(H(slot + 2), 2, 4), w3: range(H(slot + 3), 1.2, 2.6),
      p1: range(H(slot + 4), 0, 6.28), p2: range(H(slot + 5), 0, 6.28), p3: range(H(slot + 6), 0, 6.28),
    });
  };

  const addPicnic = (px, pz, axisX, seatMask, slotBase) => {
    occupied.push({ x: px, z: pz, r: 5 });
    const hw = 0.95, hd = 0.4;
    const ti = c.tables.length;
    c.tables.push({ x: px, z: pz, axisX });
    const box = (minx, maxx, miny, maxy, minz, maxz, wood) => c.boxes.push({ minx, maxx, miny, maxy, minz, maxz, wood });
    if (axisX) {
      box(px - hw, px + hw, 0.71, 0.75, pz - hd, pz + hd, true);
      for (const s of [-1, 1]) { box(px - hw, px + hw, 0.40, 0.45, pz + s * 0.67 - 0.14, pz + s * 0.67 + 0.14, true); c.benches.push({ x: px, z: pz + s * 0.67, axisX }); }
    } else {
      box(px - hd, px + hd, 0.71, 0.75, pz - hw, pz + hw, true);
      for (const s of [-1, 1]) { box(px + s * 0.67 - 0.14, px + s * 0.67 + 0.14, 0.40, 0.45, pz - hw, pz + hw, true); c.benches.push({ x: px + s * 0.67, z: pz, axisX }); }
    }
    let k = 0;
    for (const side of [-1, 1]) {
      for (const along of [-0.6, 0, 0.6]) {
        if (seatMask & (1 << k)) {
          const hx = axisX ? px + along : px + side * 0.67;
          const hz = axisX ? pz + side * 0.67 : pz + along;
          const fx = axisX ? 0 : -side, fz = axisX ? -side : 0;
          c.humans.push({ slot: slotBase + k, x: hx, z: hz, fx, fz, posture: 'sit', exit: range(H(slotBase + 200 + k), 0, 6.28) });
        }
        k++;
      }
    }
    const nCans = rangeInt(H(slotBase + 50), 1, 4);
    for (let i = 0; i < nCans; i++) {
      const u = range(H(slotBase + 60 + i), -0.8, 0.8), v = range(H(slotBase + 70 + i), -0.22, 0.22);
      const x = axisX ? px + u : px + v, z = axisX ? pz + v : pz + u;
      c.cans.push({ x, z, color: rangeInt(H(slotBase + 80 + i), 0, 4), table: ti });
      c.sugar.push({ x, y: 0.87, z, rate: 1.0, kind: 'can', table: ti });
    }
    // Sugar-bottle trap hung from the table end; only deployed at escalation level 3 (GDD 8.10)
    const tx = axisX ? px + hw + 0.05 : px, tz = axisX ? pz : pz + hw + 0.05;
    c.traps.push({ x: tx, y: 0.6, z: tz, table: ti });
    for (let i = 0; i < T.prey.fliesPerTable; i++) addFly(px + range(H(slotBase + 90 + i * 8), -0.6, 0.6), 0.95, pz + range(H(slotBase + 91 + i * 8), -0.3, 0.3), slotBase + 92 + i * 8);
  };

  const addGroup = (gx, gz, count, slotBase) => {
    occupied.push({ x: gx, z: gz, r: 3 });
    const offs = [[0, 0.75], [0.75, 0], [0, -0.75], [-0.75, 0]];
    for (let k = 0; k < count; k++) {
      const [dx, dz] = offs[k];
      c.humans.push({ slot: slotBase + k, x: gx + dx, z: gz + dz, fx: -dx / 0.75, fz: -dz / 0.75, posture: 'stand', exit: range(H(slotBase + 200 + k), 0, 6.28) });
    }
    addFly(gx, 1.7, gz, slotBase + 300);
  };

  const addTree = (x, z, slot) => {
    const r = range(H(slot), 0.15, 0.35), h = range(H(slot + 1), 3.2, 6.0), cr = range(H(slot + 2), 1.4, 2.8);
    c.trees.push({ x, z, r, h, cr, shade: unit(H(slot + 3)) });
    c.cylinders.push({ x, z, r, h, wood: true });
  };

  const addFlowers = (px, pz, slot) => {
    const n = rangeInt(H(slot), 4, 11), color = rangeInt(H(slot + 1), 0, 5);
    for (let i = 0; i < n; i++) {
      const x = px + range(H(slot + 10 + i), -1.2, 1.2), z = pz + range(H(slot + 30 + i), -1.2, 1.2);
      const y = range(H(slot + 50 + i), 0.2, 0.55);
      c.flowers.push({ x, y, z, color });
      c.sugar.push({ x, y: y + 0.02, z, rate: 0.35, kind: 'flower' });
      if (unit(H(slot + 70 + i)) < T.prey.caterpillarChance) c.caterpillars.push({ x: x + 0.006, y: y * 0.6, z });
    }
    addFly(px, 0.7, pz, slot + 5);
  };

  const addHive = (x, z, slot) => {
    occupied.push({ x, z, r: 4 });
    const dir = rangeInt(H(slot), 0, 4), fx = [0, 1, 0, -1][dir], fz = [1, 0, -1, 0][dir];
    const hive = { x, z, fx, fz, ex: x + fx * 0.24, ey: 0.47, ez: z + fz * 0.24, bees: [], slot };
    c.boxes.push({ minx: x - 0.225, maxx: x + 0.225, miny: 0, maxy: 0.98, minz: z - 0.225, maxz: z + 0.225, wood: true, hive: true });
    c.hives.push(hive);
  };

  if (isOrigin) {
    addTree(NEST.treeX, NEST.treeZ, 100);
    occupied.push({ x: NEST.treeX, z: NEST.treeZ, r: 3 });
    c.nest = { ...NEST };
    addPicnic(6, 4, true, 0b111111, 1000);
    addGroup(1, 10, 3, 1100);
    addFlowers(-6, 2, 400);
    addFlowers(3, -5, 480);
  } else {
    if (unit(H(1)) < 0.6) {
      const px = ox + range(H(2), -20, 20), pz = oz + range(H(3), -20, 20);
      addPicnic(px, pz, unit(H(4)) < 0.5, rangeInt(H(5), 1, 64) | 1, 1000);
    }
    if (unit(H(6)) < 0.5) {
      const gx = ox + range(H(7), -24, 24), gz = oz + range(H(8), -24, 24);
      if (free(gx, gz, 2)) addGroup(gx, gz, rangeInt(H(9), 2, 5), 1100);
    }
    const forcedHive = cx === 1 && cz === 0;
    if (forcedHive || unit(H(12)) < 0.3) {
      const hx = forcedHive ? ox - 18 : ox + range(H(13), -22, 22), hz = forcedHive ? oz + 6 : oz + range(H(14), -22, 22);
      if (free(hx, hz, 3)) addHive(hx, hz, 1500);
    }
    // A garden shed (GDD 6.6: wall and attic nest sites). Solid wood: wasps chew it, land on its roof.
    if (unit(H(15)) < 0.35) {
      const sx = ox + range(H(16), -22, 22), sz = oz + range(H(17), -22, 22);
      if (free(sx, sz, 3)) {
        occupied.push({ x: sx, z: sz, r: 4 });
        const axisX = unit(H(18)) < 0.5, hw = axisX ? 1.2 : 0.9, hd = axisX ? 0.9 : 1.2, h = 2.1;
        c.sheds.push({ x: sx, z: sz, hw, hd, h, crack: rangeInt(H(19), 0, 4), eave: rangeInt(H(21), 0, 4) });
        c.boxes.push({ minx: sx - hw, maxx: sx + hw, miny: 0, maxy: h, minz: sz - hd, maxz: sz + hd, wood: true, shed: true });
      }
    }
    const np = rangeInt(H(10), 3, 9);
    for (let i = 0; i < np; i++) addFlowers(ox + range(H(20 + i), -28, 28), oz + range(H(40 + i), -28, 28), 400 + i * 80);
  }
  const nt = rangeInt(H(11), isOrigin ? 3 : 2, isOrigin ? 6 : 8);
  for (let i = 0; i < nt; i++) {
    const x = ox + range(H(150 + i * 4), -30, 30), z = oz + range(H(151 + i * 4), -30, 30);
    if (free(x, z, 3)) { addTree(x, z, 200 + i * 4); occupied.push({ x, z, r: 2 }); }
  }
  // Spider webs: vertical discs beside tree trunks (GDD 9.3)
  c.trees.forEach((t, i) => {
    if (unit(H(700 + i)) > 0.45) return;
    const a = range(H(710 + i), 0, 6.28), d = t.r + range(H(720 + i), 0.15, 0.35);
    const x = t.x + d * dcos(a), z = t.z + d * dsin(a);
    // the web hangs between the trunk and a twig, facing across the line to the trunk
    c.webs.push({ x, y: range(H(730 + i), 0.45, 1.6), z, nx: -dsin(a), nz: dcos(a), r: range(H(740 + i), 0.12, 0.26), tree: i });
  });
  // Birds: one patrol circle per chunk at most (GDD 9.3)
  if (unit(H(800)) < 0.55) {
    c.birds.push({ x: ox + range(H(801), -15, 15), z: oz + range(H(802), -15, 15), y: range(H(803), 4, 8), r: range(H(804), 7, 14), period: rangeInt(H(805), 1200, 2400), phase: rangeInt(H(806), 0, 2400), dir: unit(H(807)) < 0.5 ? 1 : -1 });
  }
  // Dragonflies: a low patrol loop over open ground (GDD 9.3)
  if (unit(H(820)) < 0.45) {
    c.dragonflies.push({ x: ox + range(H(821), -20, 20), z: oz + range(H(822), -20, 20), y: range(H(823), 0.6, 1.4), r: range(H(824), 2, 5), period: rangeInt(H(825), 500, 1100), phase: rangeInt(H(826), 0, 1100), dir: unit(H(827)) < 0.5 ? 1 : -1 });
  }
  // A rival wasp colony hangs in one of the trees (GDD 9.3)
  if (!isOrigin && !(cx === 1 && cz === 0) && c.trees.length && unit(H(900)) < 0.12) {
    const t = c.trees[rangeInt(H(901), 0, c.trees.length)];
    const y = Math.min(t.h - 0.6, range(H(902), 1.8, 2.6));
    c.rival = { x: t.x + t.r + 0.25, y, z: t.z, r: 0.12, ex: t.x + t.r + 0.25, ey: y - 0.15, ez: t.z, workers: rangeInt(H(903), 3, 6) };
  }
  // Bees: guards at the entrance, foragers commute to this chunk's flowers
  for (const hv of c.hives) {
    for (let k = 0; k < T.bees.guards + T.bees.foragers; k++) {
      const s = hv.slot + 10 + k * 6;
      if (k < T.bees.guards) { hv.bees.push({ guard: true, p: range(H(s), 0, 6.28), w: range(H(s + 1), 1.5, 3) * (k % 2 ? 1 : -1) }); continue; }
      const f = c.flowers.length ? c.flowers[rangeInt(H(s + 2), 0, c.flowers.length)] : { x: hv.x + 8, y: 0.4, z: hv.z + 8 };
      hv.bees.push({ guard: false, tx: f.x, ty: f.y, tz: f.z, period: rangeInt(H(s + 3), 1500, 3000), phase: rangeInt(H(s + 4), 0, 3000), p: range(H(s + 5), 0, 6.28) });
    }
  }
  return c;
}
