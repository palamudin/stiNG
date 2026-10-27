// Colony economy and the yearly cycle (GDD 2.2, 5.2, 6.2-6.7, A.4).
// A compartment model stepped once per sim second. Counts are fractional internally; the UI rounds them.
// `bio` scales biological durations to the world's season length (GDD 4.8 modifier):
// bio = seasonDays / 200, so a 40-day season runs brood development five times faster than nature.
import { T } from './tuning.js';
import { clamp01 } from './rng.js';

// The colony's species (GDD 6.8): its row of the species table
export const spOf = (c) => T.species[(c && c.species) || 'wasp'] || T.species.wasp;

export function newColony(founding = false, species = 'wasp') {
  const s = T.colony.start, k = T.species[species].start; // a hornet colony starts small, a bee colony big
  const c = {
    queenAlive: true, nestAlive: true, sited: true, species,
    adults: founding ? 0 : s.adults * k, eggs: founding ? 0 : s.eggs * k, larvae: founding ? 0 : s.larvae * k, pupae: founding ? 0 : s.pupae * k,
    cells: founding ? 0 : s.cells * k, protein: founding ? 0 : s.protein, sugar: founding ? 0.5 : s.sugar, pulp: founding ? 0 : s.pulp,
    water: founding ? 0 : s.water, cool: 1, thirst: 0, // T2-1
    rEggs: 0, rLarvae: 0, rPupae: 0, gynes: 0, males: 0, mated: 0, young: 0,
    deficit: 0, fed: 1, alloc: 0, sugarlessDays: 0,
    stats: { emerged: 0, laid: 0, starvedLarvae: 0, died: 0, gynesRaised: 0, deposited: { sugar: 0, protein: 0, pulp: 0, water: 0 }, cooked: 0 },
  };
  return c;
}

export const proteinCap = (c) => T.colony.proteinCapBase + (c.larvae + c.rLarvae * T.season.reproProtein) * T.colony.larvaProtein * T.colony.proteinCapDays;
export const sugarCap = (c) => (T.colony.sugarCapBase + c.adults * T.colony.adultSugar * T.colony.sugarCapDays) * spOf(c).store; // bees keep honey
// The males a young queen can meet (T2-3): her colony's and the neighbourhood's, which peak with the breeding season
export const malesAbout = (c, frac) => clamp01((c.males + T.males.area * reproShare(frac)) / T.males.need);
export const waterCap = (c) => T.water.capBase + c.adults * T.water.capPerAdult; // T2-1
export const broodTotal = (c) => c.eggs + c.larvae + c.pupae + c.rEggs + c.rLarvae + c.rPupae;

// Season phase from the season fraction (GDD 5.2)
export const SEASON_PHASES = [
  { from: 0, name: 'Founding' }, { from: 0.15, name: 'Growth' }, { from: 0.55, name: 'Peak' },
  { from: 0.8, name: 'Collapse' },
];
export function seasonPhase(frac) { let p = SEASON_PHASES[0]; for (const x of SEASON_PHASES) if (frac >= x.from) p = x; return p.name; }

// Share of new eggs laid in queen cells (gynes and males) at a season fraction.
export function reproShare(frac) { const C = T.season; return clamp01((frac - C.reproStart) / (C.reproFull - C.reproStart)); }
// A honeybee colony raises queens and drones early in the season, and only when crowded (T2-11)
export function beeRepro(c, frac) { const H = T.hive; return frac >= H.swarmFrom && frac < H.swarmTo && c.adults >= H.swarmAdults ? H.reproShare : 0; }

// One step of `dtDay` in-game days. `physical` = adults outside as agents.
// `foraging` = abstract foragers can work now. `frac` = season fraction. `bio` = biological time scale.
// thermal: brood development speed from the nest's temperature (T1-14), 1 when comfortable
// avail: what the season offers foragers (T1-8), { sugar, protein } multipliers, 1 when absent
// hot: the nest's heat (T2-1), { heat: 0..1 through the site's insulation, cook: 0..1 past the brood's lethal temperature }
export function colonyStep(c, dtDay, physical, foraging, frac = 0.3, bio = 1, thermal = 1, avail = null, hot = null) {
  const C = T.colony, S = T.season, W = T.water, SP = spOf(c);
  if (!c.nestAlive) return;
  const inside = Math.max(0, c.adults - physical);
  if (c.water === undefined) { c.water = 0; c.cool = 1; c.thirst = 0; } // saves from before water (T2-1)
  const heat = hot ? hot.heat : 0, wcap = waterCap(c);
  // a hot nest with a low store sends some foragers for water instead of food
  c.thirst = heat * (1 - clamp01(c.water / wcap));
  const divert = W.divert * c.thirst;

  if (foraging) {
    const a = T.alloc[c.alloc], wsum = (a.sugar + a.protein + a.pulp) / 3;
    const f = Math.max(0, inside - c.young) * C.forageShare * a.traffic * dtDay; // 'Lie low' sends fewer out (T1-7); the young stay in (T1-13)
    const food = f * (1 - divert);
    c.sugar += food * C.income.sugar * a.sugar / wsum * (avail ? avail.sugar : 1) * SP.sugarIn;
    c.protein += food * C.income.protein * a.protein / wsum * (avail ? avail.protein : 1) * SP.proteinIn;
    if (SP.wood) c.pulp += food * C.income.pulp * a.pulp / wsum; // bees build wax from sugar instead (T2-11)
    else c.sugar += food * C.income.pulp * a.pulp / wsum * SP.sugarIn;
    c.water += f * divert * W.income;
  }
  if (c.water > wcap) c.water = wcap;
  // cooling: the heat uses water; how much of the need was met decides how much the heat still slows the brood
  const demand = heat * W.coolPerDay * dtDay;
  if (demand > 0) { const paid = Math.min(c.water, demand); c.water -= paid; c.cool += (paid / demand - c.cool) * W.smoothing; }
  else c.cool += (1 - c.cool) * W.smoothing;
  // past the lethal temperature the brood the water does not save cooks
  const cook = (hot ? hot.cook : 0) * (1 - c.cool) * W.broodCook * dtDay;
  if (cook > 0) {
    let lost = 0;
    for (const k of ['eggs', 'larvae', 'pupae', 'rEggs', 'rLarvae', 'rPupae']) { const x = c[k] * Math.min(1, cook); c[k] -= x; lost += x; }
    c.stats.cooked = (c.stats.cooked || 0) + lost;
  }

  // Wasps keep only a small sugar store: what does not fit is not collected
  const cap = sugarCap(c);
  if (c.sugar > cap) { c.stats.sugarSpilled = (c.stats.sugarSpilled || 0) + c.sugar - cap; c.sugar = cap; }
  const pcap = proteinCap(c);
  if (c.protein > pcap) { c.stats.proteinSpilled = (c.stats.proteinSpilled || 0) + c.protein - pcap; c.protein = pcap; }

  // Larvae eat protein first; queen larvae eat more. Fed larvae return sugar secretion (GDD 6.3)
  const need = (c.larvae + c.rLarvae * S.reproProtein) * C.larvaProtein * dtDay;
  const fed = need > 0 ? Math.min(1, c.protein / need) : 1;
  c.protein -= need * fed;
  c.fed = c.fed + (fed - c.fed) * 0.2;
  const secretion = (c.larvae + c.rLarvae) * fed * C.larvaSecretion * dtDay;

  const sugarNeed = c.adults * C.adultSugar * dtDay;
  const fromStore = Math.max(0, sugarNeed - secretion);
  const paid = Math.min(fromStore, c.sugar);
  c.sugar -= paid;
  const unpaid = fromStore - paid;
  const raw = sugarNeed > 0 ? clamp01((sugarNeed - secretion) / sugarNeed) : 0;
  c.deficit += (raw - c.deficit) * C.deficitSmoothing;
  if (unpaid > 0 && c.adults > 0) {
    const starve = Math.min(inside, unpaid / (C.adultSugar * dtDay) * 0.02);
    c.adults -= starve; c.stats.died += starve;
  }
  if (unpaid > 0 && c.sugar <= 0) {
    c.sugarlessDays += dtDay;
    if (c.sugarlessDays >= C.queenStarveDays) c.queenAlive = false;
  } else c.sugarlessDays = 0;

  // Brood pipeline (GDD 6.4); durations scale with the season length
  const eD = C.eggDays * bio, lD = C.larvaDays * bio, pD = C.pupaDays * bio;
  const step = (eggs, larvae, pupae) => {
    const e2l = c[eggs] / eD * dtDay * thermal, l2p = c[larvae] / lD * dtDay * fed * thermal, p2a = c[pupae] / pD * dtDay * thermal;
    const ls = c[larvae] * (1 - fed) * C.larvaStarve * dtDay;
    c[eggs] -= e2l; c[larvae] += e2l - l2p - ls; c[pupae] += l2p - p2a;
    c.stats.starvedLarvae += ls;
    return p2a;
  };
  const newWorkers = step('eggs', 'larvae', 'pupae');
  const newRepro = step('rEggs', 'rLarvae', 'rPupae');
  c.adults += newWorkers; c.stats.emerged += newWorkers;
  // new workers stay in a few days before they forage (T1-13)
  c.young += newWorkers - c.young / (C.youngDays * bio) * dtDay;
  c.gynes += newRepro * S.gyneShare; c.males += newRepro * (1 - S.gyneShare); c.stats.gynesRaised += newRepro * S.gyneShare;

  // Gynes fly out to mate on fair days (GDD 6.7); how many find a male depends on the males about (T2-3)
  if (foraging && c.gynes > 0 && !SP.perennial) { const m = c.gynes * S.matePerDay * dtDay; c.gynes -= m; c.mated += m * S.mateSuccess * malesAbout(c, frac); }

  // Adult mortality rises as the colony collapses in autumn
  const late = frac > S.collapseFrom && !SP.perennial ? 1 + S.collapseMul * (frac - S.collapseFrom) / (1 - S.collapseFrom) : 1; // a bee colony does not collapse
  const die = inside * C.adultMortality / bio * late * dtDay;
  c.adults -= die; c.stats.died += die;
  c.males -= c.males * 0.2 * dtDay / bio;
  if (frac >= S.queenDiesAt && !SP.perennial) c.queenAlive = false;

  let use;
  if (SP.wood) { use = Math.min(c.pulp, C.buildPerDay * dtDay * (1 + inside / 40)); c.pulp -= use; }
  else { // wax from the store above a reserve (T2-11)
    use = Math.min(Math.max(0, c.sugar - sugarCap(c) * T.hive.waxFrom) / T.hive.waxSugar, C.buildPerDay * dtDay * (1 + inside / 40));
    if (c.cells >= (c.maxCells || Infinity)) use = 0;
    c.sugar -= use * T.hive.waxSugar;
  }
  c.cells = Math.min(c.cells + use * C.cellsPerPulp, c.maxCells || Infinity); // the site caps nest size (GDD 6.6)

  if (c.queenAlive && c.protein > 0) {
    const free = Math.max(0, c.cells - broodTotal(c));
    const lay = Math.min(free, Math.min(C.layMax * SP.lay, (C.layBase + c.adults * C.layPerAdult) * SP.lay) * dtDay);
    const r = SP.perennial ? beeRepro(c, frac) : reproShare(frac);
    c.eggs += lay * (1 - r); c.rEggs += lay * r; c.stats.laid += lay;
  }
  if (c.adults < 0) c.adults = 0;
  if (c.young > c.adults) c.young = c.adults;
}

export function destroyNest(c) {
  c.nestAlive = false; c.queenAlive = false; c.young = 0;
  c.eggs = 0; c.larvae = 0; c.pupae = 0; c.rEggs = 0; c.rLarvae = 0; c.rPupae = 0; c.gynes = 0;
  c.protein = 0; c.sugar = 0; c.pulp = 0;
}

// The colony has no future this season: no queen laying, nothing growing, nobody home
export function colonyFinished(c, physical) {
  const brood = broodTotal(c) >= 1;
  return (!c.nestAlive || !c.queenAlive) && !brood && c.adults - physical < 1 && c.gynes < 0.5;
}
