// STING tier-0 simulation core.
// Mirrors Sting.Core from the GDD: no three.js, no DOM, no wall clock.
// Determinism rules for this JS port:
//   - only + - * / and Math.sqrt / Math.floor / Math.abs / min / max in sim math
//     (all exactly specified by IEEE 754, so bit-identical across browsers)
//   - trig is our own polynomial (dsin/dcos), never Math.sin/cos
//   - randomness is the counter-based SplitMix64 hash, bit-identical to GDD Appendix A.2
//   - iteration in ascending entity id order
// The Unity port replaces Number with Fix64; structure and order stay the same.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const GEN_VERSION = 1;

// ---------------------------------------------------------------- RNG (GDD 3.5, A.2)

const M64 = (1n << 64n) - 1n;
export const Domain = {
  WorldGen: 1n, HumanTraits: 2n, HumanSchedule: 3n, Clothing: 4n,
  Flight: 5n, Colony: 6n, Ecology: 7n, Weather: 8n, Bees: 9n, Cosmetic: 10n,
};

function mix(z) {
  z = (z + 0x9E3779B97F4A7C15n) & M64;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
  return z ^ (z >> 31n);
}

export function hash(seed, domain, a, b = 0n, c = 0n) {
  let h = mix(seed);
  h = mix(h ^ domain);
  h = mix(h ^ a);
  h = mix(h ^ b);
  h = mix(h ^ c);
  return h;
}

export const unit = (h) => Number(h >> 32n) / 4294967296;
export const range = (h, lo, hi) => lo + (hi - lo) * unit(h);
export const rangeInt = (h, lo, hi) => lo + Number(((h >> 32n) * BigInt(hi - lo)) >> 32n);
export const u64 = (n) => BigInt.asUintN(64, BigInt(n));

// ---------------------------------------------------------------- deterministic trig

const PI = 3.141592653589793, TAU = 2 * PI, HALF_PI = PI / 2;

export function dsin(x) {
  x = x - TAU * Math.floor((x + PI) / TAU);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110 * (1 - x2 / 156))))));
}
export const dcos = (x) => dsin(x + HALF_PI);

// ---------------------------------------------------------------- tuning (GDD 13)

export const T = {
  population: 8200000000,
  chunk: { size: 64, activeRadius: 1, discoverRadius: 2 },
  wasp: {
    radius: 0.007, cruise: 3.0, burst: 6.0, accel: 14, burstAccel: 24,
    climb: 1.6, contactGap: 0.02, pushOff: 0.9, gravity: 9.81, maxFall: 4.5,
    substeps: 3, ceiling: 40,
  },
  venom: { jab: 0.12, deepen: 0.2, regenPerSec: 1 / 90 },
  energy: { cruisePerSec: 1 / 240, hoverShare: 0.45, burstMul: 2.6, refuelPerSec: 0.35, feedDist: 0.045 },
  sting: { jabTicks: 6, fullTicks: 30 },
  stunTicks: 70,
  respawnTicks: 150,
  startWorkers: 30,
  reach: { arm: 0.5, flex: 0.3, girth: 0.2, age: 0.1, minReachToSwat: 0.25 },
  resolve: {
    jabPain: 0.3, fullPain: 1.0,
    preciseRadius: 0.04, flailerRadius: 0.10, brushRadius: 0.08, coverRadius: 0.12, contortRadius: 0.15,
    contortExtraTicks: 12, helperNoticeTicks: 8, minConsequenceTicks: 11,
    helperRange: 2.0, fleePanic: 0.8,
  },
  panic: {
    decayPerStep: 0.993, contagionRadius: 5, contagionRate: 0.03, contagionMin: 0.3,
    calm: 0.2, fleeSpeed: 3.2, walkSpeed: 1.3, fleeStepsMin: 60, fleeStepsMax: 120,
  },
};

// ---------------------------------------------------------------- zones (GDD 8.3, A.5)

export const Zone = {
  Scalp: 0, Face: 1, Ears: 2, NeckFront: 3, NeckBack: 4, Shoulders: 5, UpperBack: 6, Acnestis: 7,
  LowerBack: 8, Chest: 9, Belly: 10, Groin: 11, Buttocks: 12, UpperArms: 13, Forearms: 14, Shins: 15, Thighs: 16,
};
export const ZoneName = Object.keys(Zone);
export const Policy = { Slap: 0, BrushOrShake: 1, Brush: 2, Contort: 3, CoverSwipe: 4, SlapOppositeHand: 5 };
export const PolicyName = Object.keys(Policy);
export const SwatKind = { Slap: 0, Brush: 1, Cover: 2, Contort: 3 };
export const SwatKindName = Object.keys(SwatKind);
export const Style = { Precise: 0, Flailer: 1, Brusher: 2, Freezer: 3, Runner: 4 };
export const StyleName = Object.keys(Style);

// base reach, back sensitivity, girth sensitivity, stiffness sensitivity, pain sensitivity, policy, helper may swat, extra delay ticks
function Z(base, back, girth, stiff, sens, policy, helper, extra = 0) {
  return { base, back, girth, stiff, sens, policy, helper, extra };
}
export const ZONES = [
  Z(0.90, 0.2, 0.0, 0.3, 0.9, Policy.Slap, true),             // Scalp
  Z(1.00, 0.0, 0.0, 0.0, 1.6, Policy.BrushOrShake, false),    // Face
  Z(0.95, 0.1, 0.0, 0.2, 1.2, Policy.Brush, true),            // Ears
  Z(0.95, 0.1, 0.2, 0.3, 1.2, Policy.Slap, true),             // NeckFront
  Z(0.85, 0.5, 0.3, 0.6, 1.1, Policy.Slap, true),             // NeckBack
  Z(0.85, 0.5, 0.4, 0.8, 0.9, Policy.Slap, true),             // Shoulders
  Z(0.35, 1.0, 1.0, 1.0, 1.0, Policy.Contort, true),          // UpperBack
  Z(0.10, 1.0, 1.0, 1.0, 1.0, Policy.Contort, true),          // Acnestis
  Z(0.55, 1.0, 1.0, 1.0, 1.0, Policy.Slap, true),             // LowerBack: reach decides slap vs contort
  Z(0.95, 0.1, 0.3, 0.3, 1.3, Policy.CoverSwipe, false),      // Chest
  Z(0.95, 0.1, 0.5, 0.3, 1.0, Policy.Slap, true),             // Belly
  Z(0.95, 0.1, 0.6, 0.2, 2.0, Policy.CoverSwipe, false),      // Groin
  Z(0.70, 0.6, 0.6, 0.3, 1.0, Policy.Slap, false, 4),         // Buttocks
  Z(0.85, 0.3, 0.3, 0.8, 0.9, Policy.SlapOppositeHand, true), // UpperArms
  Z(0.95, 0.1, 0.1, 0.5, 0.8, Policy.SlapOppositeHand, true), // Forearms
  Z(0.85, 0.5, 0.6, 0.2, 0.9, Policy.Slap, true, 6),          // Shins
  Z(0.95, 0.3, 0.5, 0.2, 0.9, Policy.Slap, true),             // Thighs
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function selfReach(z, h, clothingStiffness) {
  const t = T.reach;
  const r = z.base
    + t.arm * (h.armRatio - 1)
    + t.flex * (h.flexibility - 0.5) * z.back
    - t.girth * h.girth * z.girth
    - clothingStiffness * z.stiff
    - t.age * h.ageStiffness * z.back;
  return clamp01(r);
}

// ---------------------------------------------------------------- humans (GDD 8.1, A.10)

export function humanTraits(seed, id) {
  const H = (i) => hash(seed, Domain.HumanTraits, id, BigInt(i));
  return {
    id,
    height: range(H(0), 1.5, 1.95),
    armRatio: range(H(1), 0.92, 1.08),
    flexibility: unit(H(2)),
    girth: unit(H(3)),
    ageStiffness: unit(H(4)),
    reactionTicks: rangeInt(H(5), 11, 43),
    style: rangeInt(H(6), 0, 5),
    accuracy: unit(H(7)),
    panicSusceptibility: unit(H(8)),
    sociability: unit(H(9)),
    escalation: unit(H(10)),
  };
}

// Clothing (GDD 8.8). Cover: 0 none, 1 thin, 2 thick.
export const Top = { TShirt: 0, Tank: 1, Jacket: 2 };
export const Bottom = { Jeans: 0, Shorts: 1, Skirt: 2 };
export const TopName = ['T-shirt', 'Tank top', 'Jacket'];
export const BottomName = ['Jeans', 'Shorts', 'Skirt'];

export function humanClothing(seed, id, day = 0) {
  const a = rangeInt(hash(seed, Domain.Clothing, id, BigInt(day), 0n), 0, 100);
  const b = rangeInt(hash(seed, Domain.Clothing, id, BigInt(day), 1n), 0, 100);
  const top = a < 15 ? Top.Jacket : a < 45 ? Top.Tank : Top.TShirt;
  const bottom = b < 40 ? Bottom.Jeans : b < 75 ? Bottom.Shorts : Bottom.Skirt;
  return { top, bottom, stiffness: top === Top.Jacket ? 0.3 : 0 };
}

export function zoneCover(clothing, zone) {
  const Zn = Zone;
  const torso = [Zn.Chest, Zn.Belly, Zn.UpperBack, Zn.Acnestis, Zn.LowerBack];
  if (torso.includes(zone)) return clothing.top === Top.Jacket ? 2 : 1;
  if (zone === Zn.Shoulders || zone === Zn.UpperArms) return clothing.top === Top.Jacket ? 2 : clothing.top === Top.TShirt ? 1 : 0;
  if (zone === Zn.Forearms) return clothing.top === Top.Jacket ? 2 : 0;
  if (zone === Zn.Groin || zone === Zn.Buttocks) return clothing.bottom === Bottom.Jeans ? 2 : 1;
  if (zone === Zn.Thighs) return clothing.bottom === Bottom.Jeans ? 2 : 1;
  if (zone === Zn.Shins) return clothing.bottom === Bottom.Jeans ? 2 : 0;
  return 0;
}

// Body parts in the body frame: +y up, +z forward, +x right. Capsules a-b with radius r.
// These capsules ARE the sim body (GDD 12): the renderer draws exactly these.
function P(name, ax, ay, az, bx, by, bz, r, side = 0) {
  return { name, a: { x: ax, y: ay, z: az }, b: { x: bx, y: by, z: bz }, r, side };
}

export function bodyParts(h, posture) {
  const s = h.height / 1.75, g = h.girth, ar = h.armRatio;
  const tor = 0.14 + 0.08 * g, pel = 0.12 + 0.05 * g;
  const ax = tor + 0.065, lx = 0.085 + 0.025 * g;
  const L = [];
  const arm = (name, sd, a, b, r) => {
    // arm segments scale with arm ratio around their root
    L.push(P(name, a[0] * sd, a[1], a[2], (a[0] + (b[0] - a[0]) * ar) * sd, a[1] + (b[1] - a[1]) * ar, a[2] + (b[2] - a[2]) * ar, r, sd));
  };
  if (posture === 'stand') {
    L.push(P('Head', 0, 1.62, 0.01, 0, 1.62, 0.01, 0.105));
    L.push(P('Neck', 0, 1.44, 0, 0, 1.53, 0, 0.055));
    L.push(P('Shoulders', -(ax - 0.03), 1.385, -0.01, ax - 0.03, 1.385, -0.01, 0.062));
    L.push(P('Torso', 0, 1.0, 0, 0, 1.29, 0, tor));
    L.push(P('Pelvis', -0.07, 0.9, 0, 0.07, 0.9, 0, pel));
    for (const sd of [-1, 1]) {
      const n = sd < 0 ? 'L' : 'R';
      arm('UpperArm' + n, sd, [ax, 1.37, 0], [ax + 0.03, 1.08, 0], 0.045);
      const e = [ax + 0.03 * ar, 1.37 - 0.29 * ar, 0];
      arm('Forearm' + n, sd, e, [e[0] + 0.02, e[1] - 0.26, 0.04], 0.04);
      L.push(P('Thigh' + n, lx * sd, 0.86, 0, (lx + 0.01) * sd, 0.48, 0.01, 0.075, sd));
      L.push(P('Shin' + n, (lx + 0.01) * sd, 0.48, 0.01, (lx + 0.01) * sd, 0.07, 0, 0.052, sd));
    }
  } else {
    L.push(P('Head', 0, 1.22, 0.03, 0, 1.22, 0.03, 0.105));
    L.push(P('Neck', 0, 1.04, 0.01, 0, 1.13, 0.01, 0.055));
    L.push(P('Shoulders', -(ax - 0.03), 0.985, -0.01, ax - 0.03, 0.985, -0.01, 0.062));
    L.push(P('Torso', 0, 0.6, 0, 0, 0.89, 0.01, tor));
    L.push(P('Pelvis', -0.07, 0.5, 0, 0.07, 0.5, 0, pel));
    for (const sd of [-1, 1]) {
      const n = sd < 0 ? 'L' : 'R';
      arm('UpperArm' + n, sd, [ax, 0.97, 0], [ax + 0.02, 0.74, 0.12], 0.045);
      const e = [ax + 0.02 * ar, 0.97 - 0.23 * ar, 0.12 * ar];
      arm('Forearm' + n, sd, e, [e[0] - 0.08, e[1] + 0.03, e[2] + 0.28], 0.04);
      L.push(P('Thigh' + n, lx * sd, 0.48, 0.04, (lx + 0.01) * sd, 0.49, 0.44, 0.075, sd));
      L.push(P('Shin' + n, (lx + 0.01) * sd, 0.47, 0.44, (lx + 0.01) * sd, 0.06, 0.48, 0.052, sd));
    }
  }
  for (const p of L) {
    p.a.x *= s; p.a.y *= s; p.a.z *= s; p.b.x *= s; p.b.y *= s; p.b.z *= s; p.r *= s;
  }
  return L;
}

export function segClosest(a, b, p) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const L2 = abx * abx + aby * aby + abz * abz;
  let t = L2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { t, x: a.x + abx * t, y: a.y + aby * t, z: a.z + abz * t };
}

// Which zone a surface point belongs to (GDD 8.3).
export function classify(part, q, n, p, s) {
  switch (part.name) {
    case 'Head':
      if (n.z > 0.35 && n.y < 0.6) return Zone.Face;
      if (Math.abs(n.x) > 0.7) return Zone.Ears;
      return Zone.Scalp;
    case 'Neck': return n.z >= 0 ? Zone.NeckFront : Zone.NeckBack;
    case 'Shoulders': return Zone.Shoulders;
    case 'Torso':
      if (n.z > -0.15) return q.t > 0.55 ? Zone.Chest : Zone.Belly;
      if (q.t > 0.42) return Math.abs(p.x) < 0.4 * part.r ? Zone.Acnestis : Zone.UpperBack;
      return Zone.LowerBack;
    case 'Pelvis':
      if (n.z > 0.3 && Math.abs(p.x) < 0.08 * s) return Zone.Groin;
      if (n.z < -0.2 || n.y < -0.6) return Zone.Buttocks;
      return Zone.Thighs;
    default:
      if (part.name.startsWith('UpperArm')) return Zone.UpperArms;
      if (part.name.startsWith('Forearm')) return Zone.Forearms;
      if (part.name.startsWith('Thigh')) return Zone.Thighs;
      return Zone.Shins;
  }
}

// Body frame (GDD A.7). Forward f = (fx, 0, fz), right r = (fz, 0, -fx), up = y.
export function toWorld(hm, p) {
  return { x: hm.x + hm.fz * p.x + hm.fx * p.z, y: p.y, z: hm.z - hm.fx * p.x + hm.fz * p.z };
}
export function toLocal(hm, w) {
  const dx = w.x - hm.x, dz = w.z - hm.z;
  return { x: dx * hm.fz - dz * hm.fx, y: w.y, z: dx * hm.fx + dz * hm.fz };
}
function dirToWorld(hm, d) {
  return { x: hm.fz * d.x + hm.fx * d.z, y: d.y, z: -hm.fx * d.x + hm.fz * d.z };
}

// ---------------------------------------------------------------- sting resolution (GDD 8.6, A.6)

function kindFor(policy, reach) {
  if (reach < T.reach.minReachToSwat) return SwatKind.Contort;
  switch (policy) {
    case Policy.BrushOrShake:
    case Policy.Brush: return SwatKind.Brush;
    case Policy.CoverSwipe: return SwatKind.Cover;
    case Policy.Contort: return SwatKind.Contort;
    default: return SwatKind.Slap;
  }
}
function windowFor(k) { return k === SwatKind.Slap ? 4 : k === SwatKind.Brush ? 6 : k === SwatKind.Cover ? 8 : 10; }
function radiusFor(k, style, accuracy, reach) {
  const t = T.resolve;
  if (k === SwatKind.Brush) return t.brushRadius;
  if (k === SwatKind.Cover) return t.coverRadius;
  if (k === SwatKind.Contort) return t.contortRadius;
  const base = style === Style.Precise ? t.preciseRadius : t.flailerRadius;
  return base * (1 + (1 - accuracy) * 0.5) * (1 + (1 - reach) * 0.5);
}

// What a human will do if stung on this zone, ignoring helpers (for the lab overlay).
export function predictedKind(zone, h, clothing) {
  if (zoneCover(clothing, zone) === 2) return -1; // blocked
  if (h.style === Style.Freezer) return -2;       // freezes, no swat
  return kindFor(ZONES[zone].policy, selfReach(ZONES[zone], h, clothing.stiffness));
}

// Pure function. Same inputs -> same plan on every machine.
export function resolveSting(e, h, z, ctx) {
  const t = T.resolve;
  const plan = { swats: [], panicGain: 0, flee: false };
  const pain = (e.mode === 'full' ? t.fullPain : t.jabPain) * z.sens;
  plan.panicGain = pain * h.panicSusceptibility;
  plan.flee = ctx.panic + plan.panicGain >= t.fleePanic || h.style === Style.Runner;

  if (h.style !== Style.Freezer) {
    const reach = selfReach(z, h, ctx.clothingStiffness);
    const kind = kindFor(z.policy, reach);
    let delay = h.reactionTicks + z.extra + (kind === SwatKind.Contort ? t.contortExtraTicks : 0);
    if (delay < t.minConsequenceTicks) delay = t.minConsequenceTicks;
    plan.swats.push({
      actorId: h.id, kind, start: e.contactTick + delay, window: windowFor(kind),
      center: e.contactPointBody, radius: radiusFor(kind, h.style, h.accuracy, reach),
      kills: kind === SwatKind.Slap || kind === SwatKind.Cover, reach,
    });
  }
  if (z.helper && ctx.companions) {
    for (const c of ctx.companions) {
      if (plan.swats.length >= 3) break;
      if (c.distance > t.helperRange || c.style === Style.Freezer) continue;
      plan.swats.push({
        actorId: c.id, kind: SwatKind.Slap,
        start: e.contactTick + h.reactionTicks + t.helperNoticeTicks + c.reactionTicks,
        window: windowFor(SwatKind.Slap), center: e.contactPointBody,
        radius: c.style === Style.Precise ? t.preciseRadius : t.flailerRadius,
        kills: true, reach: 1,
      });
    }
  }
  return plan;
}

// ---------------------------------------------------------------- world generation (GDD 4.3)

const CS = T.chunk.size;
export const chunkOf = (v) => Math.floor(v / CS + 0.5);
export const chunkKey = (cx, cz) => cx + ',' + cz;

export const NEST = { x: -3, y: 2.3, z: -1.55, r: 0.14, treeX: -3, treeZ: -2 };
export const SPAWN = { x: -3, y: 2.05, z: -1.25, yaw: 0.98 };

export function generateChunk(seed, cx, cz) {
  const H = (slot) => hash(seed, Domain.WorldGen, u64(cx), u64(cz), BigInt(slot));
  const ox = cx * CS, oz = cz * CS;
  const c = {
    cx, cz, tint: unit(H(0)), trees: [], tables: [], benches: [], cans: [], flowers: [],
    humans: [], boxes: [], cylinders: [], sugar: [], nest: null,
  };
  const occupied = [];
  const isOrigin = cx === 0 && cz === 0;

  const addPicnic = (px, pz, axisX, seatMask, slotBase) => {
    occupied.push({ x: px, z: pz, r: 5 });
    const hw = 0.95, hd = 0.4;
    const tbl = { x: px, z: pz, axisX };
    c.tables.push(tbl);
    const box = (minx, maxx, miny, maxy, minz, maxz) => c.boxes.push({ minx, maxx, miny, maxy, minz, maxz });
    if (axisX) {
      box(px - hw, px + hw, 0.71, 0.75, pz - hd, pz + hd);
      for (const s of [-1, 1]) { box(px - hw, px + hw, 0.40, 0.45, pz + s * 0.67 - 0.14, pz + s * 0.67 + 0.14); c.benches.push({ x: px, z: pz + s * 0.67, axisX }); }
    } else {
      box(px - hd, px + hd, 0.71, 0.75, pz - hw, pz + hw);
      for (const s of [-1, 1]) { box(px + s * 0.67 - 0.14, px + s * 0.67 + 0.14, 0.40, 0.45, pz - hw, pz + hw); c.benches.push({ x: px + s * 0.67, z: pz, axisX }); }
    }
    let k = 0;
    for (const side of [-1, 1]) {
      for (const along of [-0.6, 0, 0.6]) {
        if (seatMask & (1 << k)) {
          const hx = axisX ? px + along : px + side * 0.67;
          const hz = axisX ? pz + side * 0.67 : pz + along;
          const fx = axisX ? 0 : -side, fz = axisX ? -side : 0;
          c.humans.push({ slot: slotBase + k, x: hx, z: hz, fx, fz, posture: 'sit' });
        }
        k++;
      }
    }
    const nCans = rangeInt(H(slotBase + 50), 1, 4);
    for (let i = 0; i < nCans; i++) {
      const u = range(H(slotBase + 60 + i), -0.8, 0.8), v = range(H(slotBase + 70 + i), -0.22, 0.22);
      const x = axisX ? px + u : px + v, z = axisX ? pz + v : pz + u;
      const can = { x, z, color: rangeInt(H(slotBase + 80 + i), 0, 4) };
      c.cans.push(can);
      c.sugar.push({ x, y: 0.87, z, rate: 1.0, kind: 'can' });
    }
  };

  const addGroup = (gx, gz, count, slotBase) => {
    occupied.push({ x: gx, z: gz, r: 3 });
    const offs = [[0, 0.75], [0.75, 0], [0, -0.75], [-0.75, 0]];
    for (let k = 0; k < count; k++) {
      const [dx, dz] = offs[k];
      c.humans.push({ slot: slotBase + k, x: gx + dx, z: gz + dz, fx: -dx / 0.75, fz: -dz / 0.75, posture: 'stand' });
    }
  };

  const addTree = (x, z, slot) => {
    const r = range(H(slot), 0.15, 0.35), h = range(H(slot + 1), 3.2, 6.0), cr = range(H(slot + 2), 1.4, 2.8);
    c.trees.push({ x, z, r, h, cr, shade: unit(H(slot + 3)) });
    c.cylinders.push({ x, z, r, h });
  };

  const addFlowers = (px, pz, slot) => {
    const n = rangeInt(H(slot), 4, 11), color = rangeInt(H(slot + 1), 0, 5);
    for (let i = 0; i < n; i++) {
      const x = px + range(H(slot + 10 + i), -1.2, 1.2), z = pz + range(H(slot + 30 + i), -1.2, 1.2);
      const y = range(H(slot + 50 + i), 0.2, 0.55);
      c.flowers.push({ x, y, z, color });
      c.sugar.push({ x, y: y + 0.02, z, rate: 0.35, kind: 'flower' });
    }
  };

  const free = (x, z, r) => occupied.every((o) => { const dx = x - o.x, dz = z - o.z; return dx * dx + dz * dz > (r + o.r) * (r + o.r); });

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
    const np = rangeInt(H(10), 3, 9);
    for (let i = 0; i < np; i++) addFlowers(ox + range(H(20 + i), -28, 28), oz + range(H(40 + i), -28, 28), 400 + i * 80);
  }
  const nt = rangeInt(H(11), isOrigin ? 3 : 2, isOrigin ? 6 : 8);
  for (let i = 0; i < nt; i++) {
    const x = ox + range(H(150 + i * 4), -30, 30), z = oz + range(H(151 + i * 4), -30, 30);
    if (free(x, z, 3)) { addTree(x, z, 200 + i * 4); occupied.push({ x, z, r: 2 }); }
  }
  return c;
}

function fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// ---------------------------------------------------------------- the sim

const CMD_FIELDS = 7; // mx, my, mz (-100..100), burst, sting, yawQ, pitchQ (1e-4 rad)

export class Sim {
  constructor(seed) {
    this.seed = u64(seed);
    this.tick = 0;
    this.events = [];
    this.records = new Map();     // discovered chunks, frozen (GDD 4.4)
    this.chunkOrder = [];
    this.humans = new Map();      // id hex -> human state (persists across activation)
    this.active = [];             // active humans sorted by id
    this.activeChunks = [];
    this.activeKey = '';
    this.swats = [];
    this.stung = new Set();
    this.workers = T.startWorkers;
    this.workerSerial = 1;
    this.stats = { stings: 0, full: 0, deaths: 0, causes: {} };
    this.contact = null;
    this.feeding = false;
    this.pressUsed = false;
    this.log = new Int32Array(CMD_FIELDS * 4096);
    this.logLen = 0;
    this.wasp = this._newWasp();
    this._updateChunks();
  }

  _newWasp() {
    return {
      x: SPAWN.x, y: SPAWN.y, z: SPAWN.z, vx: 0, vy: 0, vz: 0, yaw: SPAWN.yaw, pitch: 0,
      energy: 1, venom: 1, state: 'fly', stateTicks: 0, attach: null, serial: this.workerSerial,
    };
  }

  emit(type, data = {}) { this.events.push({ t: this.tick, type, ...data }); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  // ---------------- chunks

  _updateChunks() {
    const w = this.wasp;
    const wx = w.state === 'dead' || w.state === 'extinct' ? SPAWN.x : w.x;
    const wz = w.state === 'dead' || w.state === 'extinct' ? SPAWN.z : w.z;
    const ccx = chunkOf(wx), ccz = chunkOf(wz);
    const key = chunkKey(ccx, ccz);
    if (key === this.activeKey) return;
    this.activeKey = key;
    const D = T.chunk.discoverRadius, A = T.chunk.activeRadius;
    for (let dz = -D; dz <= D; dz++) for (let dx = -D; dx <= D; dx++) this._discover(ccx + dx, ccz + dz);
    const act = [];
    for (let dz = -A; dz <= A; dz++) for (let dx = -A; dx <= A; dx++) act.push(this.records.get(chunkKey(ccx + dx, ccz + dz)));
    this.activeChunks = act;
    const list = [];
    for (const rec of act) {
      for (const hs of rec.content.humans) {
        const id = hash(this.seed, Domain.WorldGen, u64(rec.cx), u64(rec.cz), BigInt(hs.slot));
        const hex = id.toString(16).padStart(16, '0');
        let hm = this.humans.get(hex);
        if (!hm) {
          const tr = humanTraits(this.seed, id);
          hm = {
            id, hex, short: hex.slice(0, 4), tr, clothing: humanClothing(this.seed, id),
            home: { x: hs.x, z: hs.z, fx: hs.fx, fz: hs.fz, posture: hs.posture },
            x: hs.x, z: hs.z, fx: hs.fx, fz: hs.fz, posture: hs.posture,
            state: 'idle', panic: 0, fleeSteps: 0, dirX: 0, dirZ: 0, stungCount: 0,
            parts: { sit: bodyParts(tr, 'sit'), stand: bodyParts(tr, 'stand') },
          };
          this.humans.set(hex, hm);
        }
        list.push(hm);
      }
    }
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.active = list;
    this.emit('chunksActive', { key });
  }

  _discover(cx, cz) {
    const key = chunkKey(cx, cz);
    if (this.records.has(key)) return;
    const content = generateChunk(this.seed, cx, cz);
    const rec = { cx, cz, genVersion: GEN_VERSION, discoveredTick: this.tick, contentHash: fnv32(JSON.stringify(content)), content };
    this.records.set(key, rec);
    this.chunkOrder.push(key);
    this.emit('chunkDiscovered', { cx, cz });
  }

  humanByHex(hex) { return this.humans.get(hex); }

  // ---------------- step

  step(cmd) {
    this._record(cmd);
    this.tick++;
    const w = this.wasp;
    // Hold to sting: the press arms the stinger, first contact while held stings,
    // releasing pulls out. One sting per press.
    if (!cmd.sting) this.pressUsed = false;
    const armed = cmd.sting && !this.pressUsed;

    // 1. wasp
    if (w.state === 'fly' || w.state === 'stunned') this._flight(cmd);
    if (w.state === 'stunned' && --w.stateTicks <= 0) { w.state = 'fly'; this.emit('recovered'); }
    if (w.state === 'fly') {
      this._contactQuery();
      this._feed();
      if (armed && this.contact) { this.pressUsed = true; this._beginSting(); }
    } else this.contact = null;
    if (w.state === 'attached') this._attached(cmd);
    if (w.state === 'dead' && --w.stateTicks <= 0) this._respawn();
    if (w.state !== 'dead' && w.state !== 'extinct') w.venom = Math.min(1, w.venom + T.venom.regenPerSec * DT);

    // 2. swats (every tick, GDD 3.3)
    this._swats();

    // 3. humans at 20 Hz
    if (this.tick % 3 === 0) this._humans();

    // 4. chunks
    this._updateChunks();
  }

  _record(cmd) {
    if (this.logLen + CMD_FIELDS > this.log.length) {
      const n = new Int32Array(this.log.length * 2); n.set(this.log); this.log = n;
    }
    const L = this.log, i = this.logLen;
    L[i] = cmd.mx | 0; L[i + 1] = cmd.my | 0; L[i + 2] = cmd.mz | 0; L[i + 3] = cmd.burst ? 1 : 0;
    L[i + 4] = cmd.sting ? 1 : 0; L[i + 5] = cmd.yawQ | 0; L[i + 6] = cmd.pitchQ | 0;
    this.logLen += CMD_FIELDS;
  }

  static cmdAt(log, tickIndex) {
    const i = tickIndex * CMD_FIELDS;
    return { mx: log[i], my: log[i + 1], mz: log[i + 2], burst: log[i + 3], sting: log[i + 4], yawQ: log[i + 5], pitchQ: log[i + 6] };
  }

  // ---------------- flight (GDD 7.2)

  _flight(cmd) {
    const w = this.wasp, W = T.wasp;
    w.yaw = cmd.yawQ * 1e-4;
    w.pitch = Math.max(-1.45, Math.min(1.45, cmd.pitchQ * 1e-4));
    const sy = dsin(w.yaw), cy = dcos(w.yaw), sp = dsin(w.pitch), cp = dcos(w.pitch);
    const powered = w.state === 'fly' && w.energy > 0;
    const burst = powered && cmd.burst;
    if (powered) {
      const mz = cmd.mz / 100, mx = cmd.mx / 100, my = cmd.my / 100;
      // forward along view, strafe horizontal, climb vertical
      let dx = sy * cp * mz - cy * mx, dy = sp * mz + my * (W.climb / W.cruise), dz = cy * cp * mz + sy * mx;
      const m = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (m > 1) { dx /= m; dy /= m; dz /= m; }
      const sp0 = burst ? W.burst : W.cruise;
      dx *= sp0; dy *= sp0; dz *= sp0;
      let ex = dx - w.vx, ey = dy - w.vy, ez = dz - w.vz;
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez), amax = (burst ? W.burstAccel : W.accel) * DT;
      if (el > amax) { ex *= amax / el; ey *= amax / el; ez *= amax / el; }
      w.vx += ex; w.vy += ey; w.vz += ez;
      const speed = Math.sqrt(w.vx * w.vx + w.vy * w.vy + w.vz * w.vz);
      const E = T.energy;
      w.energy -= E.cruisePerSec * DT * (E.hoverShare + (1 - E.hoverShare) * Math.min(speed / W.cruise, 2)) * (burst ? E.burstMul : 1);
      if (w.energy < 0) { w.energy = 0; this.emit('exhausted'); }
    } else {
      w.vy -= W.gravity * DT;
      if (w.vy < -W.maxFall) w.vy = -W.maxFall;
      w.vx *= 0.97; w.vz *= 0.97;
    }
    const n = W.substeps, h = DT / n;
    for (let i = 0; i < n; i++) {
      w.x += w.vx * h; w.y += w.vy * h; w.z += w.vz * h;
      this._collide();
    }
  }

  _collide() {
    const w = this.wasp, R = T.wasp.radius;
    if (w.y < R) { w.y = R; if (w.vy < 0) w.vy = 0; w.vx *= 0.9; w.vz *= 0.9; }
    if (w.y > T.wasp.ceiling) { w.y = T.wasp.ceiling; if (w.vy > 0) w.vy = 0; }
    for (const rec of this.activeChunks) {
      const c = rec.content;
      for (const b of c.boxes) {
        if (w.x < b.minx - R || w.x > b.maxx + R || w.y < b.miny - R || w.y > b.maxy + R || w.z < b.minz - R || w.z > b.maxz + R) continue;
        const pen = [w.x - (b.minx - R), (b.maxx + R) - w.x, w.y - (b.miny - R), (b.maxy + R) - w.y, w.z - (b.minz - R), (b.maxz + R) - w.z];
        let k = 0;
        for (let i = 1; i < 6; i++) if (pen[i] < pen[k]) k = i;
        if (k === 0) { w.x = b.minx - R; if (w.vx > 0) w.vx = 0; }
        else if (k === 1) { w.x = b.maxx + R; if (w.vx < 0) w.vx = 0; }
        else if (k === 2) { w.y = b.miny - R; if (w.vy > 0) w.vy = 0; }
        else if (k === 3) { w.y = b.maxy + R; if (w.vy < 0) w.vy = 0; }
        else if (k === 4) { w.z = b.minz - R; if (w.vz > 0) w.vz = 0; }
        else { w.z = b.maxz + R; if (w.vz < 0) w.vz = 0; }
      }
      for (const cy of c.cylinders) {
        if (w.y > cy.h) continue;
        const dx = w.x - cy.x, dz = w.z - cy.z, rr = cy.r + R, d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
        w.x = cy.x + nx * rr; w.z = cy.z + nz * rr;
        const vn = w.vx * nx + w.vz * nz;
        if (vn < 0) { w.vx -= vn * nx; w.vz -= vn * nz; }
      }
    }
    for (const hm of this.active) {
      const dx = w.x - hm.x, dz = w.z - hm.z;
      if (dx * dx + dz * dz > 4) continue;
      const lp = toLocal(hm, w);
      let pushed = false;
      for (const part of hm.parts[hm.posture]) {
        const q = segClosest(part.a, part.b, lp);
        const ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z, rr = part.r + R;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 >= rr * rr || d2 === 0) continue;
        pushed = true;
        const d = Math.sqrt(d2);
        lp.x = q.x + ex / d * rr; lp.y = q.y + ey / d * rr; lp.z = q.z + ez / d * rr;
        const nw = dirToWorld(hm, { x: ex / d, y: ey / d, z: ez / d });
        const vn = w.vx * nw.x + w.vy * nw.y + w.vz * nw.z;
        if (vn < 0) { w.vx -= vn * nw.x; w.vy -= vn * nw.y; w.vz -= vn * nw.z; }
      }
      if (!pushed) continue;
      const p = toWorld(hm, lp);
      w.x = p.x; w.y = p.y; w.z = p.z;
    }
  }

  // ---------------- contact and stinging (GDD 7.4)

  _contactQuery() {
    const w = this.wasp, R = T.wasp.radius;
    let best = null, bestGap = T.wasp.contactGap;
    for (const hm of this.active) {
      const dx = w.x - hm.x, dz = w.z - hm.z;
      if (dx * dx + dz * dz > 4) continue;
      const lp = toLocal(hm, w);
      for (const part of hm.parts[hm.posture]) {
        const q = segClosest(part.a, part.b, lp);
        const ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z;
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (d === 0) continue;
        const gap = d - part.r - R;
        if (gap <= bestGap) {
          bestGap = gap;
          const n = { x: ex / d, y: ey / d, z: ez / d };
          const surf = { x: q.x + n.x * part.r, y: q.y + n.y * part.r, z: q.z + n.z * part.r };
          const s = hm.tr.height / 1.75;
          const zone = classify(part, q, n, surf, s);
          best = { hm, part, n, surf, zone, cover: zoneCover(hm.clothing, zone) };
        }
      }
    }
    if (!best) { this.contact = null; return; }
    const z = ZONES[best.zone];
    this.contact = {
      humanHex: best.hm.hex, zone: best.zone, blocked: best.cover === 2,
      reach: selfReach(z, best.hm.tr, best.hm.clothing.stiffness), n: best.n, surf: best.surf, part: best.part.name,
    };
  }

  _companions(hm) {
    const out = [];
    for (const o of this.active) {
      if (o === hm || o.state !== 'idle') continue;
      const dx = o.x - hm.x, dz = o.z - hm.z, d2 = dx * dx + dz * dz;
      if (d2 > T.resolve.helperRange * T.resolve.helperRange) continue;
      out.push({ id: o.id, hex: o.hex, distance: Math.sqrt(d2), reactionTicks: o.tr.reactionTicks, style: o.tr.style });
    }
    return out; // already in id order
  }

  _beginSting() {
    const w = this.wasp, c = this.contact;
    const hm = this.humans.get(c.humanHex);
    if (c.blocked) { this.emit('blocked', { humanHex: hm.hex, zone: c.zone }); return; }
    if (w.venom < T.venom.jab) { this.emit('noVenom'); return; }
    w.venom -= T.venom.jab;
    const R = T.wasp.radius;
    const local = { x: c.surf.x + c.n.x * R, y: c.surf.y + c.n.y * R, z: c.surf.z + c.n.z * R };
    const ev = { contactTick: this.tick, humanHex: hm.hex, zone: c.zone, contactPointBody: { ...c.surf }, mode: 'jab' };
    const comps = this._companions(hm);
    const plan = resolveSting(ev, hm.tr, ZONES[c.zone], { clothingStiffness: hm.clothing.stiffness, panic: hm.panic, companions: comps });
    const actorHex = (id) => (id === hm.id ? hm.hex : comps.find((x) => x.id === id).hex);
    for (const s of plan.swats) this.swats.push({ ...s, actorHex: actorHex(s.actorId), stungHex: hm.hex, contactTick: this.tick, hit: false });
    hm.panic = Math.min(1, hm.panic + plan.panicGain);
    hm.stungCount++;
    const first = !this.stung.has(hm.hex);
    this.stung.add(hm.hex);
    this.stats.stings++;
    w.state = 'attached';
    w.vx = w.vy = w.vz = 0;
    w.attach = { hex: hm.hex, posture: hm.posture, local, n: c.n, start: this.tick, deepened: false, zone: c.zone };
    this.emit('sting', {
      humanHex: hm.hex, zone: c.zone, contactPointBody: c.surf, first, panicGain: plan.panicGain,
      swats: plan.swats.map((s) => ({ actorHex: actorHex(s.actorId), kind: s.kind, start: s.start, window: s.window, radius: s.radius, kills: s.kills, reach: s.reach, center: s.center })),
    });
    if (plan.flee) this._startFlee(hm);
  }

  _attached(cmd) {
    const w = this.wasp, a = w.attach, hm = this.humans.get(a.hex);
    const held = this.tick - a.start;
    if (!hm || hm.posture !== a.posture) { this._detach(hm, 'knocked off'); return; }
    const p = toWorld(hm, a.local);
    w.x = p.x; w.y = p.y; w.z = p.z;
    if (cmd.sting && held >= T.sting.fullTicks && !a.deepened) {
      a.deepened = true;
      const z = ZONES[a.zone];
      const extra = (T.resolve.fullPain - T.resolve.jabPain) * z.sens * hm.tr.panicSusceptibility;
      w.venom = Math.max(0, w.venom - T.venom.deepen);
      hm.panic = Math.min(1, hm.panic + extra);
      this.stats.full++;
      this.emit('deepen', { humanHex: hm.hex, zone: a.zone, panicGain: extra });
      if (hm.panic >= T.resolve.fleePanic && hm.state === 'idle') this._startFlee(hm);
    }
    if ((!cmd.sting && held >= T.sting.jabTicks) || a.deepened) this._detach(hm, null);
  }

  _detach(hm, why) {
    const w = this.wasp, a = w.attach;
    if (hm) {
      const n = dirToWorld(hm, a.n);
      w.vx = n.x * T.wasp.pushOff; w.vy = n.y * T.wasp.pushOff + 0.2; w.vz = n.z * T.wasp.pushOff;
    }
    w.attach = null;
    w.state = 'fly';
    this.emit('detach', { why });
  }

  // ---------------- swats (GDD 8.7)

  _swats() {
    const w = this.wasp, live = [];
    for (const s of this.swats) {
      if (this.tick >= s.start + s.window) { this.emit('swatEnd', { actorHex: s.actorHex }); continue; }
      live.push(s);
      if (this.tick === s.start) this.emit('swatStrike', { actorHex: s.actorHex, stungHex: s.stungHex, kind: s.kind });
      if (this.tick < s.start || s.hit || (w.state !== 'fly' && w.state !== 'attached' && w.state !== 'stunned')) continue;
      const hm = this.humans.get(s.stungHex);
      const c = toWorld(hm, s.center);
      const dx = w.x - c.x, dy = w.y - c.y, dz = w.z - c.z, r = s.radius + T.wasp.radius;
      if (dx * dx + dy * dy + dz * dz <= r * r) {
        s.hit = true;
        const cause = SwatKindName[s.kind].toLowerCase() + (s.actorHex === s.stungHex ? '' : ' (helper)');
        this.emit('swatHit', { actorHex: s.actorHex, stungHex: s.stungHex, kind: s.kind, kills: s.kills, delayTicks: s.start - s.contactTick });
        if (s.kills) this._die(cause, s.actorHex);
        else this._stun();
      }
    }
    this.swats = live;
  }

  _stun() {
    const w = this.wasp;
    if (w.state === 'attached') { const hm = this.humans.get(w.attach.hex); this._detach(hm, 'stunned'); }
    w.state = 'stunned'; w.stateTicks = T.stunTicks;
    this.emit('stunned');
  }

  _die(cause, byHex) {
    const w = this.wasp;
    w.attach = null;
    w.state = 'dead'; w.stateTicks = T.respawnTicks;
    this.workers--;
    this.stats.deaths++;
    this.stats.causes[cause] = (this.stats.causes[cause] || 0) + 1;
    this.emit('waspDied', { cause, byHex, x: w.x, y: w.y, z: w.z, workersLeft: this.workers });
  }

  _respawn() {
    if (this.workers <= 0) { this.wasp.state = 'extinct'; this.emit('lineExtinct'); return; }
    this.workerSerial++;
    this.wasp = this._newWasp();
    this.emit('respawn', { serial: this.workerSerial, yaw: SPAWN.yaw });
  }

  // ---------------- feeding (GDD 6.2, personal crop only at tier 0)

  _feed() {
    const w = this.wasp, d2max = T.energy.feedDist * T.energy.feedDist;
    this.feeding = false;
    if (w.energy >= 1) return;
    for (const rec of this.activeChunks) {
      for (const s of rec.content.sugar) {
        const dx = w.x - s.x, dy = w.y - s.y, dz = w.z - s.z;
        if (dx * dx + dy * dy + dz * dz <= d2max) {
          w.energy = Math.min(1, w.energy + T.energy.refuelPerSec * s.rate * DT);
          this.feeding = true;
          return;
        }
      }
    }
  }

  // ---------------- humans (GDD 8.9)

  _startFlee(hm) {
    const w = this.wasp;
    let dx = hm.x - w.x, dz = hm.z - w.z;
    let d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-6) { dx = -hm.fx; dz = -hm.fz; d = 1; }
    hm.dirX = dx / d; hm.dirZ = dz / d;
    hm.state = 'flee';
    hm.posture = 'stand';
    hm.fx = hm.dirX; hm.fz = hm.dirZ;
    const P = T.panic;
    hm.fleeSteps = rangeInt(hash(this.seed, Domain.HumanSchedule, hm.id, BigInt(this.tick)), P.fleeStepsMin, P.fleeStepsMax);
    this.emit('flee', { humanHex: hm.hex });
  }

  _humans() {
    const P = T.panic, step = 3 * DT;
    const old = this.active.map((h) => h.panic);
    const r2 = P.contagionRadius * P.contagionRadius;
    for (let i = 0; i < this.active.length; i++) {
      const hm = this.active[i];
      let gain = 0;
      for (let j = 0; j < this.active.length; j++) {
        if (i === j || old[j] < P.contagionMin) continue;
        const o = this.active[j], dx = o.x - hm.x, dz = o.z - hm.z;
        if (dx * dx + dz * dz <= r2) gain += P.contagionRate * old[j] * hm.tr.sociability * hm.tr.panicSusceptibility;
      }
      hm.panic = Math.min(1, old[i] * P.decayPerStep + gain);
      if (hm.state === 'idle' && hm.panic >= T.resolve.fleePanic) this._startFlee(hm);
      if (hm.state === 'flee') {
        hm.x += hm.dirX * P.fleeSpeed * step; hm.z += hm.dirZ * P.fleeSpeed * step;
        if (--hm.fleeSteps <= 0) hm.state = 'return';
      } else if (hm.state === 'return') {
        if (hm.panic >= T.resolve.fleePanic) { this._startFlee(hm); continue; }
        const dx = hm.home.x - hm.x, dz = hm.home.z - hm.z, d = Math.sqrt(dx * dx + dz * dz);
        const mv = P.walkSpeed * step;
        if (d <= mv) {
          hm.x = hm.home.x; hm.z = hm.home.z; hm.fx = hm.home.fx; hm.fz = hm.home.fz;
          hm.posture = hm.home.posture; hm.state = 'idle';
          this.emit('settled', { humanHex: hm.hex });
        } else {
          hm.fx = dx / d; hm.fz = dz / d;
          hm.x += hm.fx * mv; hm.z += hm.fz * mv;
        }
      }
    }
  }

  // ---------------- state hash (GDD 3.8)

  stateHash() {
    const buf = new Float64Array(1), bytes = new Uint8Array(buf.buffer);
    let h = 0x811c9dc5;
    const f = (v) => { buf[0] = v; for (let i = 0; i < 8; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } };
    const w = this.wasp;
    f(this.tick); f(w.x); f(w.y); f(w.z); f(w.vx); f(w.vy); f(w.vz); f(w.energy); f(w.venom);
    f(this.workers); f(this.stung.size); f(this.stats.stings); f(this.records.size);
    for (const hm of this.active) { f(hm.x); f(hm.z); f(hm.panic); f(hm.posture === 'sit' ? 1 : 0); }
    for (const s of this.swats) { f(s.start); f(s.radius); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // Re-run the recorded input from a fresh sim (GDD 14). Returns the hash at the same tick.
  static replay(seed, log, ticks) {
    const s = new Sim(seed);
    for (let t = 0; t < ticks; t++) { s.step(Sim.cmdAt(log, t)); s.events.length = 0; }
    return s.stateHash();
  }
}
