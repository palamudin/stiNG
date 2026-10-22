// Colony economy (GDD 6.2-6.5, A.4). A compartment model stepped once per sim second.
// Counts are fractional internally; the UI rounds them.
import { T } from './tuning.js';
import { clamp01 } from './rng.js';

export function newColony() {
  const s = T.colony.start;
  return {
    queenAlive: true, nestAlive: true,
    adults: s.adults, eggs: s.eggs, larvae: s.larvae, pupae: s.pupae, cells: s.cells,
    protein: s.protein, sugar: s.sugar, pulp: s.pulp,
    deficit: 0, fed: 1, alloc: 0, sugarlessDays: 0,
    stats: { emerged: 0, laid: 0, starvedLarvae: 0, died: 0, deposited: { sugar: 0, protein: 0, pulp: 0 } },
  };
}

export const broodTotal = (c) => c.eggs + c.larvae + c.pupae;

// One step of `dtDay` in-game days. `physical` = adults currently outside as agents.
// `foraging` = whether abstract foragers can work now (daylight, dry, warm).
export function colonyStep(c, dtDay, physical, foraging) {
  const C = T.colony;
  if (!c.nestAlive) return;
  const inside = Math.max(0, c.adults - physical);

  // Abstract foragers bring income in daylight (physical agents deposit on their own)
  if (foraging) {
    const a = T.alloc[c.alloc], wsum = (a.sugar + a.protein + a.pulp) / 3;
    const f = inside * C.forageShare * dtDay;
    c.sugar += f * C.income.sugar * a.sugar / wsum;
    c.protein += f * C.income.protein * a.protein / wsum;
    c.pulp += f * C.income.pulp * a.pulp / wsum;
  }

  // Larvae eat protein first; fed larvae return sugar secretion (GDD 6.3)
  const need = c.larvae * C.larvaProtein * dtDay;
  const fed = need > 0 ? Math.min(1, c.protein / need) : 1;
  c.protein -= need * fed;
  c.fed = c.fed + (fed - c.fed) * 0.2;
  const secretion = c.larvae * fed * C.larvaSecretion * dtDay;

  // Adults burn sugar; secretion covers part of it
  const sugarNeed = c.adults * C.adultSugar * dtDay;
  const fromStore = Math.max(0, sugarNeed - secretion);
  const paid = Math.min(fromStore, c.sugar);
  c.sugar -= paid;
  const unpaid = fromStore - paid;
  const raw = sugarNeed > 0 ? clamp01((sugarNeed - secretion) / sugarNeed) : 0;
  c.deficit += (raw - c.deficit) * C.deficitSmoothing;
  if (unpaid > 0) {
    const starve = Math.min(inside, unpaid / (C.adultSugar * dtDay) * 0.02);
    c.adults -= starve; c.stats.died += starve;
    c.sugarlessDays += dtDay;
    if (c.sugarlessDays >= C.queenStarveDays) c.queenAlive = false;
  } else c.sugarlessDays = 0;

  // Brood pipeline (GDD 6.4)
  const e2l = c.eggs / C.eggDays * dtDay;
  const l2p = c.larvae / C.larvaDays * dtDay * fed;
  const p2a = c.pupae / C.pupaDays * dtDay;
  const lStarve = c.larvae * (1 - fed) * C.larvaStarve * dtDay;
  c.eggs -= e2l; c.larvae += e2l - l2p - lStarve; c.pupae += l2p - p2a; c.adults += p2a;
  c.stats.emerged += p2a; c.stats.starvedLarvae += lStarve;

  // Mortality of adults inside (age)
  const die = inside * C.adultMortality * dtDay;
  c.adults -= die; c.stats.died += die;

  // Building: pulp into cells
  const use = Math.min(c.pulp, C.buildPerDay * dtDay * (1 + inside / 40));
  c.pulp -= use; c.cells += use * C.cellsPerPulp;

  // Laying
  if (c.queenAlive && c.protein > 0) {
    const free = Math.max(0, c.cells - broodTotal(c));
    const lay = Math.min(free, Math.min(C.layMax, C.layBase + c.adults * C.layPerAdult) * dtDay);
    c.eggs += lay; c.stats.laid += lay;
  }
  if (c.adults < 0) c.adults = 0;
}

export function destroyNest(c) {
  c.nestAlive = false; c.queenAlive = false;
  c.eggs = 0; c.larvae = 0; c.pupae = 0;
  c.protein = 0; c.sugar = 0; c.pulp = 0;
}
