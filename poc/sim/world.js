// World generation, clock, weather and schedules (GDD 4, 5, 8.2). All pure functions of seed and time.
import { Domain, hash, unit, range, rangeInt, u64, dsin, dcos, TAU, rnd, datan2, clamp01, h32 } from './rng.js';
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
// Memo tables (presentation speed, not sim state): what the generator works out about a chunk or a region from the seed
// alone (its land use, region layout, ground roll, pond, paving and graded pads) is worked out once per world and kept,
// keyed by number, not recomputed for every height sample. Pure functions of their keys, so a table only saves time;
// each is emptied when it grows past its cap. One set of tables per seed and feature modifiers.
const TABLE_CAP = 65536, tableSets = new Map();
let lastTables = null;
function worldTables(seed, s) {
  const woods = s?.woods ?? 1, towns = s?.towns ?? 1, water = s?.water ?? 1, hives = s?.hives ?? 1, L = lastTables;
  if (L && L.seed === seed && L.woods === woods && L.towns === towns && L.water === water && L.hives === hives) return L.t;
  const tag = seed + ':' + woods + ',' + towns + ',' + water + ',' + hives;
  let t = tableSets.get(tag);
  if (!t) {
    if (tableSets.size >= 8) tableSets.clear();
    t = { use: new Map(), region: new Map(), roll: new Map(), ponds: new Map(), paving: new Map(), pads: new Map() };
    tableSets.set(tag, t);
  }
  lastTables = { seed, woods, towns, water, hives, t };
  return t;
}
function keep(map, key, v) { if (map.size >= TABLE_CAP) map.clear(); map.set(key, v); return v; }

// Terrain (GDD 4.8, T2-6, ground v2 in GDD 20 G1): the ground's height is a derivative-damped fractal value noise,
// rotated off its lattice and domain-warped (each octave is divided by one plus the squared gradient of the octaves
// before it, which reads like erosion: soft valleys, sharper crests). Flat when the terrain modifier is 0 and round the
// home tree, damped under built-up land. The sim works in height above the ground, so nothing collides with it: the
// ground's height is drawn, blocks sight lines, gathers puddles in hollows and catches the wind on rises.
// The lattice is 256 x 256 values from the world seed (a fast 32-bit hash keyed by one full hash of the seed).
const LAT = { seed: null, v: new Float64Array(65536) };
function lattice(seed, ix, iz) {
  if (LAT.seed !== seed) {
    LAT.seed = seed;
    const base = Number(hash(seed, Domain.WorldGen, 0x7E50n) >> 32n) | 0;
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) LAT.v[(j << 8) | i] = h32(base, i, j, 0x7E50) * 2 - 1;
  }
  return LAT.v[((iz & 255) << 8) | (ix & 255)];
}
// value noise with its derivatives (quintic fade): N = [value, d/dx, d/dy]
const N = [0, 0, 0];
function noised(seed, x, y) {
  const px = Math.floor(x), py = Math.floor(y), fx = x - px, fy = y - py;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = lattice(seed, px, py), b = lattice(seed, px + 1, py), c = lattice(seed, px, py + 1), d = lattice(seed, px + 1, py + 1);
  const k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  N[0] = a + k1 * ux + k2 * uy + k4 * ux * uy; N[1] = dux * (k1 + k4 * uy); N[2] = duy * (k2 + k4 * ux);
}
const smooth = (t) => t * t * (3 - 2 * t);
// The shape, before the modifier, the home ring and land use: about -1.5..1.4, sd 0.3; oct: how many octaves
function groundShape(seed, x, z, oct = T.terrain.octaves) {
  const G = T.terrain, bx = (0.6 * x - 0.8 * z) / G.cell, by = (0.8 * x + 0.6 * z) / G.cell;
  noised(seed, bx * 0.43 + 3.1, by * 0.43 + 7.7); const wx = N[0];
  noised(seed, bx * 0.43 - 5.3, by * 0.43 + 1.9); const wy = N[0];
  let px = bx + G.warp * wx, py = by + G.warp * wy, a = 0, b = 1, dx = 0, dy = 0, lo = 0;
  const L = Math.min(oct, 2);
  for (let i = 0; i < oct; i++) {
    noised(seed, px, py);
    dx += N[1]; dy += N[2];
    a += b * N[0] / (1 + dx * dx + dy * dy);
    if (i === L - 1) lo = a;
    b *= 0.5;
    const qx = 0.8 * px - 0.6 * py, qy = 0.6 * px + 0.8 * py; px = qx * 2; py = qy * 2;
  }
  if (G.ridge) { noised(seed, bx * 0.5 + 11.7, by * 0.5 - 4.2); const r = 1 - Math.abs(N[0]); a += G.ridge * (r * r - 0.4); }
  if (G.terrace) { // steps cut in the broad shape only, so they stay put; the treads kept flat
    const q = lo / G.terraceStep, fl = Math.floor(q), f = q - fl, s5 = f * f * f * (f * (f * 6 - 15) + 10);
    a += (fl + Math.min(1, Math.max(0, (s5 - 0.5) * 1.5 + 0.5))) * G.terraceStep * G.terrace - lo * G.terrace - (a - lo) * 0.6 * G.terrace;
  }
  return a;
}
// How much a chunk's land use lets the ground roll: a town square or a mall lot is near level, yards are graded
// gently, parks and woods roll freely. Blended smoothly between chunk centres.
const cellKey = (ix, iz) => (ix + 1048576) * 2097152 + (iz + 1048576); // exact in a double for |i| < 2^20
function chunkRoll(seed, cx, cz, settings) {
  const m = worldTables(seed, settings).roll, k = cellKey(cx, cz), v = m.get(k);
  return v !== undefined ? v : keep(m, k, T.terrain.roll[landUse(seed, cx, cz, settings)] ?? 1);
}
// The ground before grading: oct octaves, times the modifier, the home ring and land use
function naturalGround(seed, x, z, settings, terrain, oct) {
  const G = T.terrain, f = smooth(clamp01((Math.sqrt(x * x + z * z) - G.flatR) / G.rise));
  if (f === 0) return 0;
  const u = x / CS, v = z / CS, i = Math.floor(u), j = Math.floor(v), tu = smooth(u - i), tv = smooth(v - j);
  const a = chunkRoll(seed, i, j, settings), b = chunkRoll(seed, i + 1, j, settings), c = chunkRoll(seed, i, j + 1, settings), d = chunkRoll(seed, i + 1, j + 1, settings);
  const roll = a + (b - a) * tu + (c - a) * tv + (a - b - c + d) * tu * tv;
  return terrain * G.amp * f * roll * groundShape(seed, x, z, oct);
}
// Graded ground (GDD 20): roads, cul-de-sacs, parking lots, town squares and the pads of buildings are graded, the
// ground blending back to its own shape over a shoulder of `m` metres round each. A street with its sidewalks is level
// across and follows only the broad shape of the land (the first `oct` octaves) along its length; a town square is
// that broad shape; a cul-de-sac is graded as the street it ends; a lot and every building's pad are level, at the broad
// shape's height at their middle. Kinds: 0 street (along x, levelled across at hz), 1 level rect, 2 cul-de-sac (a disc
// graded as its street), 3 broad-shaped rect, 4 pond (a level disc at the broad shape's height at its middle).
function padsOf(seed, cx, cz, settings) {
  const pads = worldTables(seed, settings).pads, key = cellKey(cx, cz);
  let P = pads.get(key);
  if (P) return P;
  if (pads.size >= TABLE_CAP) pads.clear();
  const c = pavingOf(seed, cx, cz, settings), Gr = T.terrain.grade;
  P = [];
  const rect = (k, minx, maxx, minz, maxz, m, hx, hz) => P.push({ k, minx, maxx, minz, maxz, m, hx, hz, h: null });
  for (const r of c.roads) rect(0, r.minx, r.maxx, r.minz - Gr.walk, r.maxz + Gr.walk, Gr.road, 0, (r.minz + r.maxz) / 2);
  for (const l of c.loops) P.push({ k: 2, x: l.x, z: l.z, r: l.r, m: Gr.road, hx: 0, hz: l.z, h: null });
  for (const l of c.lots) rect(1, l.minx, l.maxx, l.minz, l.maxz, Gr.lot, (l.minx + l.maxx) / 2, (l.minz + l.maxz) / 2);
  for (const p of c.plazas) rect(3, p.minx, p.maxx, p.minz, p.maxz, Gr.lot, 0, 0);
  for (const b of c.malls) rect(1, b.x - b.hw, b.x + b.hw, b.z - b.hd, b.z + b.hd, Gr.house, b.x, b.z);
  for (const b of c.shops) rect(1, b.x - b.hw, b.x + b.hw, b.z - b.hd, b.z + b.hd, Gr.house, b.x, b.z);
  for (const b of c.houses) rect(1, b.x - b.hw, b.x + b.hw, b.z - b.hd, b.z + b.hd, Gr.house, b.x, b.z);
  for (const p of c.ponds) P.push({ k: 4, x: p.x, z: p.z, r: p.r, m: Gr.pond, hx: p.x, hz: p.z, h: null });
  pads.set(key, P);
  return P;
}
// A chunk's pond (GDD 6.2): some parks and woods have one, never the home park. It keeps clear of what the chunk puts in
// fixed places (a park's picnic table and its walk round the park, a wood's path), tries a few spots and takes the
// first that fits, so the same seed gives the same pond with or without the rest of the chunk generated. The ground
// under it and a shoulder round it are graded level (padsOf); its water is at the ground. A pure function.
export function pondsOf(seed, cx, cz, settings) {
  const m = worldTables(seed, settings).ponds, k = cellKey(cx, cz), v = m.get(k);
  return v !== undefined ? v : keep(m, k, makePonds(seed, cx, cz, settings));
}
function makePonds(seed, cx, cz, settings) {
  if (cx === 0 && cz === 0) return [];
  const use = landUse(seed, cx, cz, settings);
  if (use !== 'park' && use !== 'forest') return [];
  const H = (slot) => hash(seed, Domain.WorldGen, u64(cx), u64(cz), BigInt(slot)), F = features(settings), W = T.water, ox = cx * CS, oz = cz * CS;
  const park = use === 'park';
  if (unit(H(9100)) >= (park ? W.pondPark : W.pondForest) * F.water) return [];
  const r = park ? range(H(9101), W.pondMin, W.pondMax) : range(H(9101), W.pondForestMin, W.pondForestMax), m = 28 - r;
  const picnic = park && unit(H(1)) < 0.6 ? { x: ox + range(H(2), -20, 20), z: oz + range(H(3), -20, 20) } : null;
  const walk = park && unit(H(6000)) < 0.6 ? range(H(6001), 12, 22) : 0; // a square walk at this distance from the middle
  const path = !park && unit(H(6300)) < 0.3; // a straight path from corner to corner
  for (let k = 0; k < 6; k++) {
    const x = ox + range(H(9102 + 2 * k), -m, m), z = oz + range(H(9103 + 2 * k), -m, m);
    if (picnic && (x - picnic.x) * (x - picnic.x) + (z - picnic.z) * (z - picnic.z) < (r + 6) * (r + 6)) continue;
    if (walk) { const c = Math.max(Math.abs(x - ox), Math.abs(z - oz)); if (c - r * 1.42 < walk + 2 && c + r * 1.42 > walk - 2) continue; }
    if (path) { // the distance to the path from (ox-26, oz-20) to (ox+26, oz+20)
      const ax = x - (ox - 26), az = z - (oz - 20), t = Math.max(0, Math.min(1, (ax * 52 + az * 40) / (52 * 52 + 40 * 40))), dx = ax - 52 * t, dz = az - 40 * t;
      if (dx * dx + dz * dz < (r + 2) * (r + 2)) continue;
    }
    return [{ x, z, r }];
  }
  return [];
}
// A chunk's paving and buildings, as generateChunk places them, without generating the rest (the ground's grading
// reads this for chunks far out that nothing has generated; a test holds the two to the same numbers)
export function pavingOf(seed, cx, cz, settings) {
  const m = worldTables(seed, settings).paving, k = cellKey(cx, cz), v = m.get(k);
  return v !== undefined ? v : keep(m, k, makePaving(seed, cx, cz, settings));
}
function makePaving(seed, cx, cz, settings) {
  const H = (slot) => hash(seed, Domain.WorldGen, u64(cx), u64(cz), BigInt(slot)), ox = cx * CS, oz = cz * CS;
  const out = { roads: [], loops: [], lots: [], plazas: [], malls: [], shops: [], houses: [], ponds: [] };
  if (cx === 0 && cz === 0) return out;
  out.ponds = pondsOf(seed, cx, cz, settings);
  const use = landUse(seed, cx, cz, settings);
  if (use === 'yards') {
    const endW = landUse(seed, cx - 1, cz, settings) !== 'yards', endE = landUse(seed, cx + 1, cz, settings) !== 'yards';
    out.roads.push({ minx: ox + (endW ? -22 : -32), maxx: ox + (endE ? 22 : 32), minz: oz - 4, maxz: oz + 4 });
    if (endW) out.loops.push({ x: ox - 22, z: oz, r: 11 });
    if (endE) out.loops.push({ x: ox + 22, z: oz, r: 11 });
    for (let li = 0; li < 4; li++) {
      const s = li < 2 ? -1 : 1, lx = ox + (li % 2 ? 16 : -16), base = 3000 + li * 2000;
      if (unit(H(base)) < 0.9) out.houses.push({ x: lx + range(H(base + 1), -3, 3), z: oz + s * 15.5, hw: range(H(base + 2), 5, 6.5), hd: range(H(base + 3), 4, 5) });
    }
  } else if (use === 'mall') {
    const side = mallSide(seed, cx, cz, settings), o = [[0, -1], [1, 0], [0, 1], [-1, 0]][side], al = o[0] ? [0, 1] : [1, 0];
    const at = (u, v) => ({ x: ox + al[0] * u + o[0] * v, z: oz + al[1] * u + o[1] * v });
    const b = at(0, 21), hx = o[0] ? 8 : 27, hz = o[0] ? 27 : 8, l0 = at(-28, 11), l1 = at(28, -20);
    out.malls.push({ x: b.x, z: b.z, hw: hx, hd: hz });
    out.lots.push({ minx: Math.min(l0.x, l1.x), maxx: Math.max(l0.x, l1.x), minz: Math.min(l0.z, l1.z), maxz: Math.max(l0.z, l1.z) });
  } else if (use === 'town') {
    const q = townQuarter(seed, cx, cz, settings), ix = q.qx ? -1 : 1, iz = q.qz ? -1 : 1;
    out.plazas.push({ minx: ox - 32, maxx: ox + 32, minz: oz - 32, maxz: oz + 32 });
    out.shops.push({ x: ox - ix * 22, z: oz - iz * 22, hw: 9, hd: 9 }, { x: ox - ix * 25, z: oz + iz * 6, hw: 6, hd: 8 }, { x: ox + ix * 6, z: oz - iz * 25, hw: 8, hd: 6 });
  }
  return out;
}
export function groundAt(seed, x, z, settings) {
  const terrain = settings ? settings.terrain || 0 : 0;
  if (!terrain) return 0;
  let h = naturalGround(seed, x, z, settings, terrain, T.terrain.octaves);
  const Gr = T.terrain.grade, M = Gr.reach, c0x = chunkOf(x - M), c1x = chunkOf(x + M), c0z = chunkOf(z - M), c1z = chunkOf(z + M);
  for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
    for (const p of padsOf(seed, cx, cz, settings)) {
      let d;
      if (p.k === 2 || p.k === 4) d = Math.max(0, Math.sqrt((x - p.x) * (x - p.x) + (z - p.z) * (z - p.z)) - p.r);
      else { const dx = Math.max(p.minx - x, 0, x - p.maxx), dz = Math.max(p.minz - z, 0, z - p.maxz); d = Math.sqrt(dx * dx + dz * dz); }
      if (d >= p.m) continue;
      let hp;
      if (p.k === 0 || p.k === 2) hp = naturalGround(seed, x, p.hz, settings, terrain, Gr.oct); // a street and its cul-de-sac
      else if (p.k === 3) hp = naturalGround(seed, x, z, settings, terrain, Gr.oct);
      else { if (p.h === null) p.h = naturalGround(seed, p.hx, p.hz, settings, 1, Gr.oct); hp = p.h * terrain; } // kept per step of the modifier
      const w = 1 - smooth(d / p.m);
      h += (hp - h) * w;
    }
  }
  return h;
}
// The ground's slope (rise per metre along x and z), from the heights a quarter metre either side
export function groundSlope(seed, x, z, settings) {
  if (!(settings && settings.terrain)) return { x: 0, z: 0 };
  const e = 0.25;
  return { x: (groundAt(seed, x + e, z, settings) - groundAt(seed, x - e, z, settings)) / (2 * e), z: (groundAt(seed, x, z + e, settings) - groundAt(seed, x, z - e, settings)) / (2 * e) };
}
export function regionLayout(seed, rx, rz, settings) {
  const regions = worldTables(seed, settings).region, key = cellKey(rx, rz);
  let L = regions.get(key);
  if (L) return L;
  const F = features(settings);
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
  if (regions.size >= TABLE_CAP) regions.clear();
  regions.set(key, L);
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
  const m = worldTables(seed, settings).use, k = cellKey(cx, cz), v = m.get(k);
  return v !== undefined ? v : keep(m, k, makeLandUse(seed, cx, cz, settings));
}
function makeLandUse(seed, cx, cz, settings) {
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
    ponds: pondsOf(seed, cx, cz, settings), // ponds: { x, z, r }, the water at the ground
  };
  const occupied = c.ponds.map((p) => ({ x: p.x, z: p.z, r: p.r + 1 })); // nothing stands in a pond
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
      if (c.ponds.some((p) => (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z) < (p.r + 0.3) * (p.r + 0.3))) continue; // not in a pond
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
