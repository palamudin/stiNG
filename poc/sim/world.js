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
    kind: 'normal', pour: 1, gust: T.wind.gust, spellDay: 0, spellLen: 0,
  };
  // extreme weather (T2-2): the latest spell that started on or before this day and still runs, else a storm roll
  const X = T.extreme, sp = weatherSpell(seed, day);
  if (sp) { w.kind = sp.kind; w.spellDay = day - sp.start + 1; w.spellLen = sp.len; }
  if (w.kind === 'heat') { w.base += X.heatBoost; w.rain = false; w.wind *= X.heatWind; }
  else if (w.kind === 'cold') w.base -= X.coldDrop;
  else if (day > 0 && unit(H(24)) < X.stormChance) {
    w.kind = 'storm'; w.rain = true; w.pour = X.pour; w.gust = X.stormGust;
    w.rainStart = 13 * 60 + rangeInt(H(25), 0, 240); w.rainEnd = w.rainStart + 45 + rangeInt(H(26), 0, 90);
    w.wind = range(H(27), X.stormWind[0], X.stormWind[1]);
  }
  weatherCache.set(key, w);
  return w;
}
// A heatwave or a cold snap running on a day (T2-2). A spell runs its length; a new one can only start on a day no
// spell covers. Day by day from the first, memoized per seed; spells start on day 1 at the earliest, so a world always
// opens on ordinary weather.
const spellMemo = new Map();
export function weatherSpell(seed, day) {
  if (day < 1) return null;
  const key = String(seed);
  let memo = spellMemo.get(key);
  if (!memo) { memo = [null]; spellMemo.set(key, memo); }
  const X = T.extreme;
  for (let d = memo.length; d <= day; d++) {
    const prev = memo[d - 1];
    if (prev && d < prev.start + prev.len) { memo.push(prev); continue; }
    const H = (i) => hash(seed, Domain.Weather, BigInt(d), BigInt(i));
    let sp = null;
    if (unit(H(20)) < X.heatChance) sp = { kind: 'heat', start: d, len: rangeInt(H(21), X.heatLen[0], X.heatLen[1] + 1) };
    else if (unit(H(22)) < X.coldChance) sp = { kind: 'cold', start: d, len: rangeInt(H(23), X.coldLen[0], X.coldLen[1] + 1) };
    memo.push(sp);
  }
  return memo[day];
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
export function humanWindow(seed, id, day, density = 1, evening = false) {
  const H = (i) => hash(seed, Domain.HumanSchedule, id, BigInt(day), BigInt(i)), D = T.days;
  if (day > 0 && unit(H(0)) > 0.85 * density) return null;
  // a beer garden's drinkers come in the afternoon and stay into the night (T2-5)
  let arrive = day === 0 ? 0 : evening ? D.eveningFrom + rangeInt(H(1), 0, D.eveningSpread) : 600 + rangeInt(H(1), 0, 150);
  let leave = evening ? D.lateFrom + rangeInt(H(2), 0, D.lateSpread) : 1020 + rangeInt(H(2), 0, 180);
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
// The pitched roof on a shed or a house, drawn and solid: the ridge runs along the long side, rise above the eaves at
// the top of the walls; it overhangs the walls by 0.12 m on the long sides and 0.1 m at the gable ends. u is across
// the ridge, v along it; wall and wallHalf are the walls' half sizes across and along, S the eaves' half span, L the
// slope's length (for its normal).
export function shedRoof(sh) {
  const alongX = sh.hw >= sh.hd, wall = alongX ? sh.hd : sh.hw, wallHalf = alongX ? sh.hw : sh.hd, S = wall + 0.12, rise = sh.house ? 1.9 : 0.55;
  return { x: sh.x, z: sh.z, alongX, wall, wallHalf, half: wallHalf + 0.1, S, y0: sh.h, rise, L: Math.sqrt(rise * rise + S * S) };
}
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

// ---------------------------------------------------------------- regions (GDD 4.2, 4.3, T1-12)
// A region is 8x8 chunks, laid out before any chunk in it: a park strip along one row (through the home chunk in the
// home region), a strip mall three chunks long on one edge, a 2x2 corner of forest edge, and suburban yards everywhere
// else (Q-06: American suburbia). A pure function of the seed, so every chunk knows its land use and its neighbours'.
export const REGION = 8;
// Feature modifiers (GDD 4.8, T2-6): world settings that act at generation. woods: forest corners per region (0, 1, or 2
// bigger ones); towns: town centres per region (0-2); water: birdbaths and puddles (x0.5-2); hives: beehives (x0-2).
// The defaults generate exactly the standard world.
export function features(s) {
  return { woods: s?.woods ?? 1, towns: s?.towns ?? 1, water: s?.water ?? 1, hives: s?.hives ?? 1 };
}
const regionCache = new Map();
export function regionLayout(seed, rx, rz, settings) {
  const F = features(settings), key = seed + ':' + rx + ',' + rz + ':' + F.woods + ',' + F.towns;
  let L = regionCache.get(key);
  if (L) return L;
  const H = (slot) => hash(seed, Domain.WorldGen, u64(rx), u64(rz), BigInt(90000 + slot));
  L = { strip: rx === 0 && rz === 0 ? REGION / 2 : 2 + rangeInt(H(1), 0, 4), mallSide: rangeInt(H(2), 0, 4), mallFrom: rangeInt(H(3), 0, REGION - 2), forest: rangeInt(H(4), 0, 4) };
  // forest corners (2x2; a wooded world has two of 3x3, the second diagonally across)
  const fs = F.woods >= 2 ? 3 : 2;
  L.forests = [];
  for (let k = 0; k < Math.min(F.woods, 2); k++) { const f = k ? L.forest ^ 3 : L.forest; L.forests.push({ x: f & 1 ? REGION - fs : 0, z: f & 2 ? REGION - fs : 0, n: fs }); }
  // town centres (T2-5): a 2x2 block of yards, scanned for from a hashed start; never beside the home chunk, and a second
  // town never touching the first
  L.towns = [];
  for (let t = 0; t < F.towns; t++) {
    const sx = rangeInt(H(t ? 8 : 5), 0, REGION - 1), sz = rangeInt(H(t ? 9 : 6), 0, REGION - 1), home = rx === 0 && rz === 0;
    for (let i = 0; i < (REGION - 1) * (REGION - 1); i++) {
      const tx = (sx + i) % (REGION - 1), tz = (sz + Math.floor(i / (REGION - 1))) % (REGION - 1);
      let ok = L.towns.every((o) => tx > o.tx + 2 || tx + 1 < o.tx - 1 || tz > o.tz + 2 || tz + 1 < o.tz - 1);
      for (let dz = 0; dz < 2 && ok; dz++) for (let dx = 0; dx < 2 && ok; dx++) {
        const lx = tx + dx, lz = tz + dz;
        if (baseUse(L, lx, lz) !== 'yards' || (home && Math.abs(lx - REGION / 2) <= 1 && Math.abs(lz - REGION / 2) <= 1)) ok = false;
      }
      if (ok) { L.towns.push({ tx, tz, garden: rangeInt(H(t ? 10 : 7), 0, 4) }); break; }
    }
  }
  if (regionCache.size > 256) regionCache.clear();
  regionCache.set(key, L);
  return L;
}
// land use before the town centres are laid over it
function baseUse(L, lx, lz) {
  if (lz === L.strip) return 'park';
  const edge = [lz === 0, lx === REGION - 1, lz === REGION - 1, lx === 0][L.mallSide], along = L.mallSide % 2 ? lz : lx;
  if (edge && along >= L.mallFrom && along < L.mallFrom + 3) return 'mall';
  for (const f of L.forests) if (lx >= f.x && lx < f.x + f.n && lz >= f.z && lz < f.z + f.n) return 'forest';
  return 'yards';
}
const regionOf = (cx, cz) => { const h = REGION / 2, rx = Math.floor((cx + h) / REGION), rz = Math.floor((cz + h) / REGION); return { rx, rz, lx: cx + h - rx * REGION, lz: cz + h - rz * REGION }; };
// which quarter of a town centre a chunk is (0 or 1 each way), whether it is the beer garden or has the fountain, or null
export function townQuarter(seed, cx, cz, settings) {
  const R = regionOf(cx, cz), L = regionLayout(seed, R.rx, R.rz, settings);
  for (const t of L.towns) {
    const qx = R.lx - t.tx, qz = R.lz - t.tz, k = qx + 2 * qz;
    if (qx >= 0 && qx < 2 && qz >= 0 && qz < 2) return { qx, qz, garden: k === t.garden, fountain: k === (t.garden + 2) % 4 };
  }
  return null;
}
export function landUse(seed, cx, cz, settings) {
  if (cx === 0 && cz === 0) return 'park';
  const R = regionOf(cx, cz);
  if (townQuarter(seed, cx, cz, settings)) return 'town';
  return baseUse(regionLayout(seed, R.rx, R.rz, settings), R.lx, R.lz);
}
// which way a strip mall faces out of its region: 0 -z, 1 +x, 2 +z, 3 -x
export function mallSide(seed, cx, cz, settings) {
  const R = regionOf(cx, cz);
  return regionLayout(seed, R.rx, R.rz, settings).mallSide;
}

export function generateChunk(seed, cx, cz, settings) {
  const H = (slot) => hash(seed, Domain.WorldGen, u64(cx), u64(cz), BigInt(slot)), F = features(settings);
  const ox = cx * CS, oz = cz * CS;
  const c = {
    cx, cz, tint: unit(H(0)), trees: [], tables: [], benches: [], cans: [], flowers: [], caterpillars: [], flies: [],
    humans: [], boxes: [], cylinders: [], sugar: [], hives: [], traps: [], nest: null,
    webs: [], birds: [], rival: null, sheds: [], dragonflies: [],
    use: 'park', roads: [], loops: [], lots: [], malls: [], // T1-12: land use, streets, cul-de-sacs, parking lots, mall buildings
    baths: [], // T2-1: birdbaths
    plazas: [], shops: [], gardens: [], // T2-5: a town centre's paving, its shop buildings, its beer garden
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
          c.humans.push({ slot: slotBase + k, x: hx, z: hz, fx, fz, posture: 'sit', exit: range(H(slotBase + 200 + k), 0, 6.28), act: null, path: null });
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
      c.humans.push({ slot: slotBase + k, x: gx + dx, z: gz + dz, fx: -dx / 0.75, fz: -dz / 0.75, posture: 'stand', exit: range(H(slotBase + 200 + k), 0, 6.28), act: null, path: null });
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
  // Someone with something to do (GDD 8.2, T1-11): a stroller walks a loop (path: x, z pairs), a gardener works the
  // spots on its path in turn, a sunbather lies at the spot
  const addActor = (slot, x, z, fx, fz, posture, act, path) => {
    c.humans.push({ slot, x, z, fx, fz, posture, exit: range(H(slot + 200), 0, 6.28), act, path });
  };
  // A garden shed (GDD 6.6: wall and attic nest sites); a house is a big one that is not wood
  const addShed = (sx, sz, axisX, slot, house) => {
    const hw = house ? range(H(slot), 5, 6.5) : axisX ? 1.2 : 0.9, hd = house ? range(H(slot + 1), 4, 5) : axisX ? 0.9 : 1.2, h = house ? range(H(slot + 2), 5, 6.5) : 2.1;
    occupied.push({ x: sx, z: sz, r: house ? 8 : 4 });
    c.sheds.push({ x: sx, z: sz, hw, hd, h, crack: rangeInt(H(slot + 3), 0, 4), eave: rangeInt(H(slot + 4), 0, 4), house: !!house });
    c.boxes.push({ minx: sx - hw, maxx: sx + hw, miny: 0, maxy: h, minz: sz - hd, maxz: sz + hd, wood: !house, shed: true });
  };
  // A wooden fence from a to b (along x or z), in sections of up to 4 m: each section is its own store of pulp (T1-12)
  const addFence = (ax, az, bx, bz) => {
    const L = Math.abs(bx - ax) + Math.abs(bz - az), n = Math.max(1, Math.ceil(L / 4)), t = 0.03, h = 1.5;
    for (let k = 0; k < n; k++) {
      const x0 = ax + (bx - ax) * k / n, z0 = az + (bz - az) * k / n, x1 = ax + (bx - ax) * (k + 1) / n, z1 = az + (bz - az) * (k + 1) / n;
      c.boxes.push({ minx: Math.min(x0, x1) - t, maxx: Math.max(x0, x1) + t, miny: 0, maxy: h, minz: Math.min(z0, z1) - t, maxz: Math.max(z0, z1) + t, wood: true, fence: true });
    }
  };
  // Suburban yards (Q-06): a street along the chunk, ending in a cul-de-sac where the next chunk is not yards; two
  // lots each side, a house set back from the sidewalk, a fenced backyard with maybe a patio table, a flower bed, a
  // shed, a tree, a bee box
  const addYards = () => {
    const endW = landUse(seed, cx - 1, cz, settings) !== 'yards', endE = landUse(seed, cx + 1, cz, settings) !== 'yards';
    c.roads.push({ minx: ox + (endW ? -22 : -32), maxx: ox + (endE ? 22 : 32), minz: oz - 4, maxz: oz + 4 });
    if (endW) c.loops.push({ x: ox - 22, z: oz, r: 11 });
    if (endE) c.loops.push({ x: ox + 22, z: oz, r: 11 });
    occupied.push({ x: ox, z: oz, r: 4 });
    for (let li = 0; li < 4; li++) {
      // each lot draws from its own run of hash slots: house 0-6, patio 10-246, flowers 300-400, shed 500-506,
      // bee box 510-740, people on the front lawn 800-1300
      const s = li < 2 ? -1 : 1, lx = ox + (li % 2 ? 16 : -16), base = 3000 + li * 2000;
      if (unit(H(base)) < 0.9) addShed(lx + range(H(base + 1), -3, 3), oz + s * 15.5, true, base + 2, true);
      // the backyard fence: across the back, and the sides between lots and at the chunk edge
      addFence(lx - 15.6, oz + s * 20.5, lx - 15.6, oz + s * 31.6);
      addFence(lx - 15.6, oz + s * 31.6, lx + 15.6, oz + s * 31.6);
      if (li % 2) addFence(lx + 15.6, oz + s * 20.5, lx + 15.6, oz + s * 31.6);
      if (unit(H(base + 10)) < 0.55) addPicnic(lx + range(H(base + 11), -6, 6), oz + s * 24.5, true, rangeInt(H(base + 12), 1, 64) | 1, base + 20);
      if (unit(H(base + 300)) < 0.75) addFlowers(lx + range(H(base + 301), -11, 11), oz + s * 29.5, base + 310);
      if (unit(H(base + 500)) < 0.3) { const sx = lx + (unit(H(base + 501)) < 0.5 ? -12.5 : 12.5), sz = oz + s * 28.7; if (free(sx, sz, 2)) addShed(sx, sz, true, base + 502, false); }
      if (unit(H(base + 510)) < 0.08 * F.hives) { const hx = lx + range(H(base + 511), -10, 10), hz = oz + s * 22; if (free(hx, hz, 2)) addHive(hx, hz, base + 600); }
      if (unit(H(base + 800)) < 0.2) { const gx = lx + range(H(base + 801), -8, 8), gz = oz + s * 7; if (free(gx, gz, 2)) addGroup(gx, gz, rangeInt(H(base + 802), 2, 4), base + 1000); }
      // a gardener working the beds along the back fence and the lawn; someone sunbathing in the backyard (T1-11)
      if (unit(H(base + 1400)) < 0.3) {
        const p = [lx + range(H(base + 1401), -10, 10), oz + s * 28.8, lx + range(H(base + 1402), -12, 12), oz + s * 26, lx + range(H(base + 1403), -12, 12), oz + s * 22.5];
        addActor(base + 1410, p[0], p[1], 0, s, 'stand', 'garden', p);
      }
      if (unit(H(base + 1450)) < 0.25) {
        const x = lx + range(H(base + 1451), -11, 11), z = oz + s * 22.5;
        if (free(x, z, 1.2)) { occupied.push({ x, z, r: 1.2 }); addActor(base + 1460, x, z, unit(H(base + 1452)) < 0.5 ? 1 : -1, 0, 'lie', 'sun', null); }
      }
    }
    // people out for a walk round the block, along one sidewalk and back along the other
    const x0 = ox + (endW ? -18 : -30), x1 = ox + (endE ? 18 : 30);
    if (unit(H(2500)) < 0.6) addActor(2510, x0, oz - 5.2, 1, 0, 'stand', 'stroll', [x0, oz - 5.2, x1, oz - 5.2, x1, oz + 5.2, x0, oz + 5.2]);
    if (unit(H(2600)) < 0.3) addActor(2610, x1, oz + 5.2, -1, 0, 'stand', 'stroll', [x1, oz + 5.2, x0, oz + 5.2, x0, oz - 5.2, x1, oz - 5.2]);
  };
  // A strip mall on the region's edge: a long low building facing in, its parking lot, outdoor seating by the doors
  const addMall = () => {
    const side = mallSide(seed, cx, cz, settings), out = [[0, -1], [1, 0], [0, 1], [-1, 0]][side], along = out[0] ? [0, 1] : [1, 0];
    const at = (u, v) => ({ x: ox + along[0] * u + out[0] * v, z: oz + along[1] * u + out[1] * v });
    const b = at(0, 21), hu = 27, hv = 8, hx = out[0] ? hv : hu, hz = out[0] ? hu : hv;
    c.malls.push({ x: b.x, z: b.z, hw: hx, hd: hz, h: 6 });
    c.boxes.push({ minx: b.x - hx, maxx: b.x + hx, miny: 0, maxy: 6, minz: b.z - hz, maxz: b.z + hz, wood: false, mall: true });
    occupied.push({ x: b.x, z: b.z, r: 28 });
    const l0 = at(-28, 11), l1 = at(28, -20);
    c.lots.push({ minx: Math.min(l0.x, l1.x), maxx: Math.max(l0.x, l1.x), minz: Math.min(l0.z, l1.z), maxz: Math.max(l0.z, l1.z) });
    for (let k = 0; k < 2; k++) { const p = at(k ? 9 : -9, 9.5); addPicnic(p.x, p.z, !out[0], rangeInt(H(4000 + k * 400), 7, 64) | 1, 4010 + k * 400); }
    if (unit(H(4900)) < 0.5) { const p = at(range(H(4901), -20, 20), 6); if (free(p.x, p.z, 2)) addGroup(p.x, p.z, rangeInt(H(4902), 2, 5), 4910); }
    const nf = rangeInt(H(4950), 0, 3);
    for (let i = 0; i < nf; i++) { const p = at(range(H(4951 + i), -24, 24), 13); addFlowers(p.x, p.z, 4960 + i * 80); }
    // a shopper crossing the lot to the doors and back (T1-11)
    if (unit(H(5200)) < 0.7) {
      const a = at(-14, -12), b = at(-14, 11), d = at(14, 11), e = at(14, -12);
      addActor(5210, a.x, a.z, out[0], out[1], 'stand', 'stroll', [a.x, a.z, b.x, b.z, d.x, d.z, e.x, e.z]);
    }
  };

  // A town centre (GDD 4.3, T2-5): one quarter of a 2x2 block, paved, with shops on its two outer edges and a fountain,
  // benches and planters on the square; one quarter of each block is a beer garden, tables packed in under string lights
  const addTown = () => {
    const q = townQuarter(seed, cx, cz, settings), ix = q.qx ? -1 : 1, iz = q.qz ? -1 : 1; // toward the middle of the block
    c.plazas.push({ minx: ox - 32, maxx: ox + 32, minz: oz - 32, maxz: oz + 32 });
    const shop = (x, z, hw, hd, slot) => {
      const h = range(H(slot), 7, 11);
      c.shops.push({ x, z, hw, hd, h, color: rangeInt(H(slot + 1), 0, 6) });
      c.boxes.push({ minx: x - hw, maxx: x + hw, miny: 0, maxy: h, minz: z - hd, maxz: z + hd, wood: false, shop: true });
      occupied.push({ x, z, r: Math.max(hw, hd) + 1.5 });
    };
    shop(ox - ix * 22, oz - iz * 22, 9, 9, 7000);
    shop(ox - ix * 25, oz + iz * 6, 6, 8, 7010);
    shop(ox + ix * 6, oz - iz * 25, 8, 6, 7020);
    if (q.garden) {
      const gx = ox + ix * 12, gz = oz + iz * 12;
      c.gardens.push({ x: gx, z: gz, hw: 9, hd: 7 });
      for (let k = 0; k < 6; k++) {
        const px = gx + ((k % 3) - 1) * 5.5, pz = gz + (Math.floor(k / 3) - 0.5) * 5, base = 7100 + k * 400, ti = c.tables.length;
        addPicnic(px, pz, true, 0b111111, base);
        for (const h of c.humans.slice(-6)) h.evening = true; // they stay into the night
        for (let i = 0; i < 3; i++) { // a round of drinks on every table
          const x = px + range(H(base + 90 + i), -0.8, 0.8), z = pz + range(H(base + 95 + i), -0.22, 0.22);
          c.cans.push({ x, z, color: 4, table: ti }); c.sugar.push({ x, y: 0.87, z, rate: 1.0, kind: 'can', table: ti });
        }
      }
    } else {
      const ng = rangeInt(H(7050), 1, 3);
      for (let k = 0; k < ng; k++) { const gx = ox + ix * range(H(7051 + k * 3), 4, 22), gz = oz + iz * range(H(7052 + k * 3), 4, 22); if (free(gx, gz, 2)) addGroup(gx, gz, rangeInt(H(7053 + k * 3), 2, 4), 7060 + k * 400); }
      for (let k = 0; k < 2; k++) { const fx = ox + ix * range(H(7070 + k * 2), 2, 24), fz = oz + iz * range(H(7071 + k * 2), 2, 24); if (free(fx, fz, 1.5)) addFlowers(fx, fz, 7080 + k * 80); }
      if (q.fountain) {
        // a fountain at the middle of the block: water (T2-1)
        const fx = ox + ix * 27, fz = oz + iz * 27;
        c.baths.push({ x: fx, z: fz, r: 1.1, h: 0.55, fountain: true });
        c.cylinders.push({ x: fx, z: fz, r: 1.1, h: 0.55, wood: false, bath: true });
        occupied.push({ x: fx, z: fz, r: 2.5 });
      }
    }
    // someone crossing the square
    if (unit(H(7600)) < 0.7) { const a = { x: ox + ix * 2, z: oz + iz * 26 }, b = { x: ox + ix * 26, z: oz + iz * 2 }; addActor(7610, a.x, a.z, 0, -iz, 'stand', 'stroll', [a.x, a.z, b.x, b.z]); }
  };

  if (isOrigin) {
    addTree(NEST.treeX, NEST.treeZ, 100);
    occupied.push({ x: NEST.treeX, z: NEST.treeZ, r: 3 });
    c.nest = { ...NEST };
    addPicnic(6, 4, true, 0b111111, 1000);
    addGroup(1, 10, 3, 1100);
    addFlowers(-6, 2, 400);
    addFlowers(3, -5, 480);
  } else if ((c.use = landUse(seed, cx, cz, settings)) === 'yards') addYards();
  else if (c.use === 'mall') addMall();
  else if (c.use === 'town') addTown();
  else if (c.use === 'forest') {
    const np = rangeInt(H(2010), 1, 3);
    for (let i = 0; i < np; i++) addFlowers(ox + range(H(2020 + i), -26, 26), oz + range(H(2030 + i), -26, 26), 2100 + i * 80);
  } else {
    if (unit(H(1)) < 0.6) {
      const px = ox + range(H(2), -20, 20), pz = oz + range(H(3), -20, 20);
      addPicnic(px, pz, unit(H(4)) < 0.5, rangeInt(H(5), 1, 64) | 1, 1000);
    }
    if (unit(H(6)) < 0.5) {
      const gx = ox + range(H(7), -24, 24), gz = oz + range(H(8), -24, 24);
      if (free(gx, gz, 2)) addGroup(gx, gz, rangeInt(H(9), 2, 5), 1100);
    }
    const forcedHive = cx === 1 && cz === 0 && F.hives > 0;
    if (forcedHive || unit(H(12)) < 0.3 * F.hives) {
      const hx = forcedHive ? ox - 18 : ox + range(H(13), -22, 22), hz = forcedHive ? oz + 6 : oz + range(H(14), -22, 22);
      if (free(hx, hz, 3)) addHive(hx, hz, 1500);
    }
    // A garden shed (GDD 6.6: wall and attic nest sites). Solid wood: wasps chew it, land on its roof.
    if (unit(H(15)) < 0.35) {
      const sx = ox + range(H(16), -22, 22), sz = oz + range(H(17), -22, 22);
      if (free(sx, sz, 3)) {
        occupied.push({ x: sx, z: sz, r: 4 });
        const axisX = unit(H(18)) < 0.5, hw = axisX ? 1.2 : 0.9, hd = axisX ? 0.9 : 1.2, h = 2.1;
        c.sheds.push({ x: sx, z: sz, hw, hd, h, crack: rangeInt(H(19), 0, 4), eave: rangeInt(H(21), 0, 4), house: false });
        c.boxes.push({ minx: sx - hw, maxx: sx + hw, miny: 0, maxy: h, minz: sz - hd, maxz: sz + hd, wood: true, shed: true });
      }
    }
    const np = rangeInt(H(10), 3, 9);
    for (let i = 0; i < np; i++) addFlowers(ox + range(H(20 + i), -28, 28), oz + range(H(40 + i), -28, 28), 400 + i * 80);
  }
  // trees: a few in a park, yard trees, dense at the forest edge, hardly any by a mall
  const nt = c.use === 'forest' ? rangeInt(H(2000), 16, 26) : c.use === 'yards' ? rangeInt(H(2001), 1, 4) : c.use === 'mall' ? rangeInt(H(2002), 0, 3) : c.use === 'town' ? rangeInt(H(2003), 0, 3) : rangeInt(H(11), isOrigin ? 3 : 2, isOrigin ? 6 : 8);
  for (let i = 0; i < nt; i++) {
    const x = ox + range(H(150 + i * 4), -30, 30), z = oz + range(H(151 + i * 4), -30, 30);
    if (free(x, z, c.use === 'forest' ? 1.5 : 3)) { addTree(x, z, 200 + i * 4); occupied.push({ x, z, r: c.use === 'forest' ? 1 : 2 }); }
  }
  // people out for the day in the open (T1-11): a walk round the park or through the woods, sunbathers on the grass
  if (!isOrigin && c.use === 'park') {
    if (unit(H(6000)) < 0.6) { const r = range(H(6001), 12, 22); addActor(6010, ox - r, oz - r, 1, 0, 'stand', 'stroll', [ox - r, oz - r, ox + r, oz - r, ox + r, oz + r, ox - r, oz + r]); }
    const ns = rangeInt(H(6100), 0, 3);
    for (let k = 0; k < ns; k++) {
      const x = ox + range(H(6101 + k * 10), -26, 26), z = oz + range(H(6102 + k * 10), -26, 26), a = range(H(6103 + k * 10), 0, 6.28);
      if (free(x, z, 1.5)) { occupied.push({ x, z, r: 1.5 }); addActor(6110 + k * 10, x, z, dsin(a), dcos(a), 'lie', 'sun', null); }
    }
  }
  if (c.use === 'forest' && unit(H(6300)) < 0.3) addActor(6310, ox - 26, oz - 20, 1, 0, 'stand', 'stroll', [ox - 26, oz - 20, ox + 26, oz + 20]);
  // Birdbaths (GDD 6.2, T2-1): a basin on a pedestal in some backyards, now and then in a park, and one in the home
  // park. A solid drum for collision; its top is the water.
  const Wt = T.water;
  const addBath = (x, z) => {
    c.baths.push({ x, z, r: Wt.bathR, h: Wt.bathY });
    c.cylinders.push({ x, z, r: Wt.bathR, h: Wt.bathY, wood: false, bath: true });
    occupied.push({ x, z, r: 0.6 });
  };
  if (c.use === 'yards') {
    for (let li = 0; li < 4; li++) {
      const s = li < 2 ? -1 : 1, lx = ox + (li % 2 ? 16 : -16), base = 3000 + li * 2000;
      if (unit(H(base + 1500)) >= Wt.bathShare * F.water) continue;
      const x = lx + range(H(base + 1501), -9, 9), z = oz + s * 24.5;
      if (free(x, z, 0.6)) addBath(x, z);
    }
  } else if (c.use === 'park') {
    const n = isOrigin ? 6 : unit(H(6500)) < Wt.bathPark * F.water ? 4 : 0; // tries
    for (let k = 0; k < n; k++) {
      const x = ox + range(H(6501 + k * 2), -18, 18), z = oz + range(H(6502 + k * 2), -18, 18);
      if (free(x, z, 1)) { addBath(x, z); break; }
    }
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
