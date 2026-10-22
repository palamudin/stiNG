// Humans as bodies: traits, clothing, capsule parts, zones, reach, sting resolution,
// and the space under clothing (GDD 8.1-8.8, A.5-A.7, A.10).
import { Domain, hash, unit, range, rangeInt, clamp01 } from './rng.js';
import { T } from './tuning.js';

export const Zone = {
  Scalp: 0, Face: 1, Ears: 2, NeckFront: 3, NeckBack: 4, Shoulders: 5, UpperBack: 6, Acnestis: 7,
  LowerBack: 8, Chest: 9, Belly: 10, Groin: 11, Buttocks: 12, UpperArms: 13, Forearms: 14, Shins: 15, Thighs: 16,
};
export const ZoneName = Object.keys(Zone);
export const Policy = { Slap: 0, BrushOrShake: 1, Brush: 2, Contort: 3, CoverSwipe: 4, SlapOppositeHand: 5 };
export const PolicyName = Object.keys(Policy);
export const SwatKind = { Slap: 0, Brush: 1, Cover: 2, Contort: 3, Compress: 4, Spray: 5 };
export const SwatKindName = Object.keys(SwatKind);
export const Style = { Precise: 0, Flailer: 1, Brusher: 2, Freezer: 3, Runner: 4 };
export const StyleName = Object.keys(Style);

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

// ---------------------------------------------------------------- traits (GDD 8.1, A.10)

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

// ---------------------------------------------------------------- clothing (GDD 8.8)

export const Top = { TShirt: 0, Tank: 1, Jacket: 2, Suit: 3 };
export const Bottom = { Jeans: 0, Shorts: 1, Skirt: 2, Suit: 3 };
export const TopName = ['T-shirt', 'Tank top', 'Jacket', 'Bee suit'];
export const BottomName = ['Jeans', 'Shorts', 'Skirt', 'Bee suit'];

export function humanClothing(seed, id, day = 0) {
  const a = rangeInt(hash(seed, Domain.Clothing, id, BigInt(day), 0n), 0, 100);
  const b = rangeInt(hash(seed, Domain.Clothing, id, BigInt(day), 1n), 0, 100);
  const top = a < 15 ? Top.Jacket : a < 45 ? Top.Tank : Top.TShirt;
  const bottom = b < 40 ? Bottom.Jeans : b < 75 ? Bottom.Shorts : Bottom.Skirt;
  return { top, bottom, stiffness: top === Top.Jacket ? 0.3 : 0, topOff: false, collarTaped: false };
}

export function suitClothing(taped) {
  return { top: Top.Suit, bottom: Bottom.Suit, stiffness: 0.35, topOff: false, collarTaped: taped };
}

const TORSO = [Zone.Chest, Zone.Belly, Zone.UpperBack, Zone.Acnestis, Zone.LowerBack];
const LOWER = [Zone.Groin, Zone.Buttocks, Zone.Thighs, Zone.Shins];
export const isLowerZone = (z) => LOWER.includes(z);

// Cover: 0 bare, 1 thin, 2 thick.
export function zoneCover(c, zone) {
  if (c.top === Top.Suit) return 2;
  const top = c.topOff ? -1 : c.top;
  if (TORSO.includes(zone)) return top < 0 ? 0 : top === Top.Jacket ? 2 : 1;
  if (zone === Zone.Shoulders || zone === Zone.UpperArms) return top === Top.Jacket ? 2 : top === Top.TShirt ? 1 : 0;
  if (zone === Zone.Forearms) return top === Top.Jacket ? 2 : 0;
  if (zone === Zone.Groin || zone === Zone.Buttocks) return c.bottom === Bottom.Jeans ? 2 : 1;
  if (zone === Zone.Thighs) return c.bottom === Bottom.Jeans ? 2 : 1;
  if (zone === Zone.Shins) return c.bottom === Bottom.Jeans ? 2 : 0;
  return 0;
}

// ---------------------------------------------------------------- body parts

function P(name, ax, ay, az, bx, by, bz, r, side = 0) {
  return { name, a: { x: ax, y: ay, z: az }, b: { x: bx, y: by, z: bz }, r, side };
}

export function bodyParts(h, posture) {
  const s = h.height / 1.75, g = h.girth, ar = h.armRatio;
  const tor = 0.14 + 0.08 * g, pel = 0.12 + 0.05 * g;
  const ax = tor + 0.065, lx = 0.085 + 0.025 * g;
  const L = [];
  const arm = (name, sd, a, b, r) => {
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

// Body frame: forward f = (fx, 0, fz), right r = (fz, 0, -fx), up = y.
export function toWorld(hm, p) {
  return { x: hm.x + hm.fz * p.x + hm.fx * p.z, y: p.y, z: hm.z - hm.fx * p.x + hm.fz * p.z };
}
export function toLocal(hm, w) {
  const dx = w.x - hm.x, dz = w.z - hm.z;
  return { x: dx * hm.fz - dz * hm.fx, y: w.y, z: dx * hm.fx + dz * hm.fz };
}
export function dirToWorld(hm, d) {
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
export function windowFor(k) {
  return k === SwatKind.Slap ? 4 : k === SwatKind.Brush ? 6 : k === SwatKind.Cover ? 8 : k === SwatKind.Compress ? 8 : 10;
}
function radiusFor(k, style, accuracy, reach) {
  const t = T.resolve;
  if (k === SwatKind.Brush) return t.brushRadius;
  if (k === SwatKind.Cover) return t.coverRadius;
  if (k === SwatKind.Contort) return t.contortRadius;
  const base = style === Style.Precise ? t.preciseRadius : t.flailerRadius;
  return base * (1 + (1 - accuracy) * 0.5) * (1 + (1 - reach) * 0.5);
}

export function predictedKind(zone, h, clothing) {
  if (zoneCover(clothing, zone) === 2) return -1;
  if (h.style === Style.Freezer) return -2;
  return kindFor(ZONES[zone].policy, selfReach(ZONES[zone], h, clothing.stiffness));
}

// Pure function. Same inputs -> same plan on every machine.
// e.under = true: the wasp is under clothing; the response is compression instead of a swat.
export function resolveSting(e, h, z, ctx) {
  const t = T.resolve;
  const plan = { swats: [], panicGain: 0, flee: false };
  const pain = (e.mode === 'full' ? t.fullPain : t.jabPain) * z.sens * (e.under ? T.under.panicMul : 1);
  plan.panicGain = pain * h.panicSusceptibility * (ctx.panicMul || 1);
  plan.flee = !e.under && (ctx.panic + plan.panicGain >= t.fleePanic || h.style === Style.Runner);

  if (e.under) {
    // Pressing the cloth against the body. Freezers press too: it is a reflex.
    let delay = h.reactionTicks;
    if (delay < t.minConsequenceTicks) delay = t.minConsequenceTicks;
    plan.swats.push({
      actorId: h.id, kind: SwatKind.Compress, start: e.contactTick + delay, window: windowFor(SwatKind.Compress),
      center: e.contactPointBody, radius: T.under.compressRadius, kills: true, reach: 1,
    });
    return plan;
  }
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

// ---------------------------------------------------------------- under clothing (GDD 8.8)
// A garment is a small graph of nodes on the skin. Openings connect it to the outside.

function partByName(parts, name) { for (const p of parts) if (p.name === name) return p; return null; }
function norm(x, y, z) { const m = Math.sqrt(x * x + y * y + z * z); return { x: x / m, y: y / m, z: z / m }; }

export function garmentGraph(h, clothing, posture, parts) {
  const nodes = [];
  const add = (key, partName, t, n, zone, opening) => {
    const p = partByName(parts, partName);
    const ax = p.a.x + (p.b.x - p.a.x) * t, ay = p.a.y + (p.b.y - p.a.y) * t, az = p.a.z + (p.b.z - p.a.z) * t;
    nodes.push({ key, zone, opening, n, pos: { x: ax + n.x * p.r, y: ay + n.y * p.r, z: az + n.z * p.r }, links: [] });
    return nodes.length - 1;
  };
  const link = (a, b) => { if (a < 0 || b < 0) return; nodes[a].links.push(b); nodes[b].links.push(a); };
  const sit = posture === 'sit';
  const top = clothing.topOff ? -1 : clothing.top;
  if (top >= 0) {
    const suit = top === Top.Suit;
    const collar = add('collar', 'Neck', 0.15, { x: 0, y: 0, z: -1 }, Zone.NeckBack, !suit || !clothing.collarTaped);
    const acn = add('acnestis', 'Torso', 0.8, { x: 0, y: 0, z: -1 }, Zone.Acnestis, false);
    const lb = add('lower back', 'Torso', 0.3, { x: 0, y: 0, z: -1 }, Zone.LowerBack, false);
    const hb = add('back hem', 'Torso', 0.02, { x: 0, y: 0, z: -1 }, Zone.LowerBack, !suit);
    const ch = add('chest', 'Torso', 0.78, { x: 0, y: 0, z: 1 }, Zone.Chest, false);
    const be = add('belly', 'Torso', 0.35, { x: 0, y: 0, z: 1 }, Zone.Belly, false);
    const hf = add('front hem', 'Torso', 0.02, { x: 0, y: 0, z: 1 }, Zone.Belly, !suit);
    link(collar, acn); link(collar, ch); link(acn, lb); link(lb, hb); link(ch, be); link(be, hf);
    for (const sd of [-1, 1]) {
      const S = sd < 0 ? 'L' : 'R';
      const ub = add('upper back ' + S, 'Torso', 0.65, norm(0.7 * sd, 0, -0.7), Zone.UpperBack, false);
      link(acn, ub);
      if (top === Top.Tank) {
        const hole = add('arm hole ' + S, 'Torso', 0.88, norm(sd, 0, 0), Zone.UpperBack, true);
        link(hole, ub); link(hole, ch);
      } else {
        const arm = add('upper arm ' + S, 'UpperArm' + S, 0.45, { x: sd, y: 0, z: 0 }, Zone.UpperArms, false);
        link(ub, arm);
        if (top === Top.TShirt) {
          link(arm, add('sleeve ' + S, 'UpperArm' + S, 0.95, { x: sd, y: 0, z: 0 }, Zone.UpperArms, true));
        } else {
          const fa = add('forearm ' + S, 'Forearm' + S, 0.5, { x: sd, y: 0, z: 0 }, Zone.Forearms, false);
          link(arm, fa);
          link(fa, add('cuff ' + S, 'Forearm' + S, 0.97, { x: sd, y: 0, z: 0 }, Zone.Forearms, top === Top.Jacket));
        }
      }
    }
  }
  const bottom = clothing.bottom;
  const thighN = sit ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  const groin = add('groin', 'Pelvis', 0.5, { x: 0, y: 0, z: 1 }, Zone.Groin, false);
  for (const sd of [-1, 1]) {
    const S = sd < 0 ? 'L' : 'R';
    const butt = add('buttock ' + S, 'Pelvis', sd < 0 ? 0.1 : 0.9, { x: 0, y: 0, z: -1 }, Zone.Buttocks, false);
    const thigh = add('thigh ' + S, 'Thigh' + S, 0.45, thighN, Zone.Thighs, false);
    link(thigh, groin); link(thigh, butt);
    if (bottom === Bottom.Shorts) link(thigh, add('leg opening ' + S, 'Thigh' + S, 0.92, thighN, Zone.Thighs, true));
    else if (bottom === Bottom.Skirt) link(thigh, add('hem ' + S, 'Thigh' + S, 0.75, thighN, Zone.Thighs, true));
    else {
      const knee = add('knee ' + S, 'Thigh' + S, 0.95, thighN, Zone.Thighs, false);
      const shin = add('shin ' + S, 'Shin' + S, 0.5, { x: 0, y: 0, z: 1 }, Zone.Shins, false);
      link(thigh, knee); link(knee, shin);
      link(shin, add('cuff ' + S, 'Shin' + S, 0.95, { x: 0, y: 0, z: 1 }, Zone.Shins, bottom === Bottom.Jeans));
    }
  }
  return nodes;
}
