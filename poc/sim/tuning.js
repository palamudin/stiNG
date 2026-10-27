// Tuning tables (GDD 13). Every number here is a starting value for tuning.
// Biology-derived values are noted; see GDD Appendix C.

import { TUNE } from './tunefile.js';

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const GEN_VERSION = 5; // 3: sheds and dragonflies; 4: regions (T1-12); 5: strollers, sunbathers, gardeners (T1-11)

export const T = {
  population: 8200000000,
  chunk: { size: 64, activeRadius: 1, discoverRadius: 2 },

  time: { startMinute: 11 * 60, dawn: 7 * 60, dusk: 20 * 60 + 30 },
  weather: {
    rainChance: 0.2, baseMin: 17, baseMax: 29, diurnalAmp: 6, flyMinTemp: 11,
    rainSpeedMul: 0.35, rainDrainMul: 3,
    // the season's own swing on top of the daily weather: cold springs for founding queens, cooling autumns
    springChill: 6, autumnChill: 7,
  },
  // Wind (GDD 5.3, T1-1): one direction and strength per day, calm at dawn, strongest mid-afternoon, gusting.
  // A wasp flies in the moving air: airspeed capped at its top speed, plus the wind, which falls off toward the ground
  // below refHeight. felt scales the day's wind to the air a wasp's size flies in.
  wind: { min: 0, max: 3, rainMul: 1.4, felt: 0.7, refHeight: 3, gust: 0.4 },
  // Body temperature (GDD 7.1, 10.2, T1-2). bio: Vespula warm their flight muscles before take-off and fly from
  // about 18-20 °C thorax temperature; on human skin they sit near 31 °C; cold torpor below about 8 °C.
  cold: { flightHeat: 12, shiverHeat: 8, shiverMinAir: 8, skinTemp: 31, nestTemp: 30, flyBody: 18, torpor: 8, rate: 1 / 300, lethalTicks: 5400, shiverCost: 0.5 },
  // Drowning in a drink (GDD 7.5, T1-3): feeding at an open can, a wasp may slip in and has a few seconds to climb out
  drown: { chancePerSec: 0.03, ticks: 240, escapePerPress: 0.3, aiEscape: 0.006 },
  // Cups are hollow (GDD 7.5): an open top, a thin wall, a drink a third to nearly full. A wasp goes in to reach the
  // drink, falls in if it touches it, and drowns if the cup is covered (a hand, or a lid at level 2) while it is inside.
  cup: { r: 0.033, wall: 0.003, base: 0.75, rim: 0.87, fillMin: 0.3, fillSpan: 0.6, coverTicks: 600, drownTicks: 300, noticeMul: 2, noticeDist: 1 },

  wasp: {
    radius: 0.007, cruise: 3.0, burst: 6.0, accel: 14, burstAccel: 24,
    climb: 1.6, contactGap: 0.02, pushOff: 0.9, gravity: 9.81, maxFall: 4.5,
    substeps: 3, ceiling: 40, carrySpeedMul: 0.8, starveTicks: 900,
  },
  venom: { jab: 0.12, deepen: 0.2, regenPerSec: 1 / 90 },
  energy: { cruisePerSec: 1 / 240, hoverShare: 0.45, burstMul: 2.6, refuelPerSec: 0.35, feedDist: 0.045, nestRefill: 0.6 },
  sting: { jabTicks: 6, fullTicks: 30 },
  stunTicks: 70,
  respawnTicks: 150,

  reach: { arm: 0.5, flex: 0.3, girth: 0.2, age: 0.1, minReachToSwat: 0.25 },
  resolve: {
    jabPain: 0.3, fullPain: 1.0,
    preciseRadius: 0.04, flailerRadius: 0.10, brushRadius: 0.08, coverRadius: 0.12, contortRadius: 0.15,
    contortExtraTicks: 12, helperNoticeTicks: 8, minConsequenceTicks: 11,
    shakeRadius: 0.16, flailRadius: 0.2, flailDelay: 8, // GDD 8.5 (T1-5): head shakes dislodge; runners flail as they go
    helperRange: 2.0, fleePanic: 0.8,
  },
  panic: {
    decayPerStep: 0.993, contagionRadius: 5, contagionRate: 0.03, contagionMin: 0.3,
    spillChance: 0.6, spillReach: 0.75, spillRate: 1.6, spillMinutes: 240, // GDD 8.9: a panicked sitter jolts the table and knocks a drink over
    calm: 0.2, fleeSpeed: 3.2, walkSpeed: 1.3,
    sightHeight: 1.3, fleeStepsMin: 60, fleeStepsMax: 120, approachDist: 26, // panic spreads by sight (T1-17): sheds and anything taller than this, and tree trunks, block it
  },

  // Colony economy (GDD 6). Rates are per in-game day.
  colony: {
    start: { adults: 30, eggs: 30, larvae: 45, pupae: 30, cells: 160, protein: 6, sugar: 8, pulp: 2 },
    adultSugar: 0.10, larvaProtein: 0.12, larvaSecretion: 0.06,
    eggDays: 5, larvaDays: 13, pupaDays: 12,                      // bio: ~30 days egg to adult
    larvaStarve: 0.25, adultMortality: 1 / 22,                     // bio: worker life ~14 days when foraging
    layBase: 20, layPerAdult: 0.8, layMax: 250,                    // bio: peak 200-300 eggs/day
    cellsPerPulp: 8, buildPerDay: 1.5,
    forageShare: 0.55, income: { sugar: 0.3, protein: 0.35, pulp: 0.15 },
    deficitSmoothing: 0.1, queenStarveDays: 1,
    youngDays: 4, // bio: a new worker nurses and builds inside for her first days before she forages (T1-13)
    sugarCapBase: 6, sugarCapDays: 2.5, proteinCapBase: 6, proteinCapDays: 2, // bio: prey goes straight to larvae; little is held                            // bio: Vespula keep little sugar; a store of a few days of adult need
  },
  alloc: [
    // traffic: how many foragers fly, which is also what an exterminator watches for (T1-7)
    { name: 'Balanced', sugar: 1, protein: 1, pulp: 1, traffic: 1 },
    { name: 'Protein', sugar: 0.6, protein: 1.8, pulp: 0.6, traffic: 1 },
    { name: 'Sugar', sugar: 1.8, protein: 0.6, pulp: 0.6, traffic: 1 },
    { name: 'Build', sugar: 0.7, protein: 0.7, pulp: 1.6, traffic: 1 },
    { name: 'Lie low', sugar: 1, protein: 1, pulp: 1, traffic: 0.35 },
  ],

  // the oldest workers guard the entrance against other colonies' wasps and the exterminator (T1-13)
  guard: { minAdults: 25, count: 2, radius: 0.6, chase: 2.5, huntTicks: 300, ring: 0.09, humanRadius: 1.5 },

  ai: { maxPhysical: 12, launchEvery: 90, arrive: 0.05, collectTicks: 150, attackTicks: 600, evadeTicks: 50, canDeficit: 0.35 },
  // Senses for AI wasps (GDD 7.3, T1-16). Food is found by scent, prey by sight, and good finds are remembered.
  // A scent of strength 1 is caught this far in still air, further downwind and less far upwind; a moving thing is
  // seen inside the forward cone, or anywhere close. A forager that senses nothing searches in a widening spiral
  // round the nest (rings ringStep apart), sniffing as it goes, and goes home after searchTicks.
  // bio: Vespula forage by odour and by sight of movement, return to profitable sites, and learn the odour of food
  // that nestmates bring home (Jandt & Jeanne 2005).
  sense: {
    smell: 8, downwind: 0.6, windRef: 2, sight: 5, cone: 0.5, near: 0.5, minSpeed: 0.3, jitter: 0.5,
    every: 15, searchTicks: 1800, searchR0: 3, ringStep: 5, searchSpeed: 2.2, searchRange: 45, searchY: 1.2, homeScentTicks: 3600,
    // how strongly each kind of source smells
    can: 1.6, flower: 1, spill: 2, fruit: 1.2, trap: 2, hive: 1.2, cat: 0.5, carrion: 1.5, carrionPerDay: 0.5, bait: 4, meat: 3,
  },

  prey: {
    fliesPerTable: 3, flyOrbit: 0.32, catchDist: 0.03, flyRespawnTicks: 2400,
    caterpillarChance: 0.25, flyProtein: 1, caterpillarProtein: 2, beeProtein: 1.5,
  },
  // perMeter, minLoads (T1-12): a wooden fence section, table, bench or shed holds this much pulp; then it is stripped
  // (a chunk delta). Trees are not used up.
  pulp: { chewTicks: 120, amount: 1, reach: 0.018, perMeter: 1.5, minLoads: 2 },

  // Escalation ladder (GDD 8.10)
  esc: {
    levels: [0, 3, 8, 15, 25, 40], decayPerDay: 0.25,
    sting: 1, full: 1, death: 0.3, nuisance: 0.15,
    headRadius: 0.4, foodRadius: 0.35, faceRadius: 0.2, noticeMul: 1, cooldownTicks: 80,
    sprayTrait: 0.55, sprayRange: 1.5, sprayTicks: 40, trapsPerTable: 1, citronellaDrain: 1.5,
    sprayCharges: 6, fetchTicks: 900, // T1-6: a stung person at level 3 goes for a can, gone 15 s
  },

  under: { moveTicks: 18, noticeMul: 2, compressRadius: 0.06, compressEvery: 25, ripPanic: 0.92, panicMul: 1.5, openingRadius: 0.035 },

  // Nest sites (GDD 6.6). bio: Vespula nest in old rodent burrows, wall and tree cavities, and sometimes in the open.
  // maxCells caps nest size; flood is brood lost per rainy day; exposure scales adult deaths in rain;
  // discovery scales the alert points people add in the nest's chunk (they notice traffic at their feet).
  sites: {
    // insulation (T1-14): how much of the outside cold and heat reaches the brood; heat: extra °C under a sunny roof
    trunk: { name: 'against a trunk', maxCells: 3500, flood: 0, exposure: 1, discovery: 1, insulation: 0.4, heat: 0 },
    ground: { name: 'in an old burrow', maxCells: 5000, flood: 0.25, exposure: 0.4, discovery: 1.6, insulation: 0.8, heat: 0 },
    branch: { name: 'hanging from a branch', maxCells: 1800, flood: 0, exposure: 2, discovery: 0.5, insulation: 0.15, heat: 0 },
    wall: { name: 'in a shed wall', maxCells: 4000, flood: 0, exposure: 0.3, discovery: 1.2, insulation: 0.6, heat: 0 },
    attic: { name: 'under a shed roof', maxCells: 6000, flood: 0, exposure: 0.2, discovery: 0.8, insulation: 0.55, heat: 7 },
    hollow: { name: 'in a hollow tree', maxCells: 4500, flood: 0, exposure: 0.25, discovery: 0.7, insulation: 0.85, heat: 0 },
    rainMortality: 0.06, holesPerChunk: 2,
    hollowShare: 0.3, hollowMinR: 0.22, // trees thick enough, and the share of them with a hollow
  },
  // Nest thermals (GDD 6.6, T1-14): brood develops at full speed between these temperatures; outside them it slows,
  // as much as the site lets the weather in
  thermal: {
    coldFrom: 18, coldSpan: 12, hotFrom: 31, hotSpan: 8, hotWeight: 0.7, minSpeed: 0.15,
  },
  // Switching wasps (GDD 7.7, Q-03): free within 30 m, otherwise the colony relays you after a delay
  possess: { freeRange: 30, relayTicks: 240 },
  // Fallen fruit (GDD 9.4). bio: windfall apples and plums are a major late-summer sugar source for Vespula.
  // Feral hives and robbing (GDD 9.1, T1-9): some hollow trees and shed-wall cracks hold a wild bee colony. A wasp
  // that gets inside any hive (E at the entrance) grabs honey and brood while the bees inside go for it; the hive
  // gives a few loads a day and comes out alarmed.
  feral: { hollowShare: 0.2, wallShare: 0.25, guards: 6, foragers: 10, robReach: 0.06, robSecs: 3, pressGain: 0.05, insideKill: 0.15, loadsPerDay: 3, broodProtein: 2, honeyCargo: 1 },
  // Seasonal ecology (GDD 9.4, T1-8). Each flower kind (by colour) blooms in its own part of the season; nectar
  // runs down as wasps sip and as the local bees forage, and regrows over the day. Caterpillars are about early to
  // mid summer, flies grow commoner through it, carrion turns up now and then. The abstract colony forages on the
  // same calendar: sugar from blooms (and fruit late), protein from caterpillars and flies.
  eco: {
    bloom: [[0.0, 0.45], [0.15, 0.6], [0.3, 0.75], [0.45, 0.88], [0.6, 0.95]], bloomJitter: 0.06,
    flowerRate: 0.35, sipPerSec: 0.25, regenPerDay: 3, beeDrawPerDay: 1.5,
    catFrom: 0.15, catTo: 0.7, catJitter: 0.08, flyBase: 0.35, flySlope: 0.65,
    carrionChance: 0.2, carrionDays: 3, carrionLoads: 4, carrionProtein: 1.5, carrionReach: 0.05,
    sugarBase: 0.5, sugarBloom: 0.9, sugarFruit: 0.35, protBase: 0.5, protCat: 0.35, protFly: 0.4,
  },
  // Human days (GDD 8.2, 8.3, T1-11): strollers, sunbathers and gardeners, out by the weather. A lying body is the
  // standing one turned onto its back, its back lieLift below the body's middle line; sunbathers come on warm dry days
  // between sunFrom and sunTo (minutes of the day), gardeners on dry days from gardenTemp, working a spot for
  // gardenMin to gardenMax game minutes; strollers walk their loop at strollSpeed, slower when stiff with age.
  days: { lieLift: 0.18, sunTemp: 23, sunFrom: 600, sunTo: 1050, minStay: 60, gardenTemp: 12, gardenMin: 20, gardenMax: 45, strollSpeed: 1.0 },
  // Barbecues (GDD 4.3, 6.2, T1-10). Some picnic tables have a kettle grill at one end. On a warm dry day the first
  // person at the table may cook a lunchtime barbecue: they stand at the grill while it is lit, meat sits on the grate
  // and later on a plate on the table. Meat is protein; people guard it and slap at wasps near it from the start; the
  // grate burns and the air above it cooks a wasp that hangs about.
  bbq: {
    share: 0.35, gap: 1.1, station: 0.55, r: 0.27, grateY: 0.82, along: -0.5,
    dayChance: 0.5, minTemp: 19, from: 750, to: 930, jitter: 40, serve: 40, plateEnd: 60, settle: 20, minLength: 60,
    grillLoads: 4, plateLoads: 6, meatProtein: 1.5, reach: 0.04,
    burnH: 0.012, plumeR: 0.35, plumeH: 0.6, plumeTemp: 70, heatRate: 1 / 150, lethal: 46, guardR: 0.3, noticeMul: 0.8,
  },
  fruit: { treeShare: 0.3, startFrac: 0.55, perTree: 6, rate: 0.8, spread: 1.6, rotDays: 6 },
  // Level 5: municipal pest control (GDD 8.10). Poisoned protein bait stations across the area for a few days.
  // bio: real programs use protein baits laced with insecticide; foragers carry them home and poison the brood.
  muni: { level: 5, radius: 1, days: 3, cooldownDays: 4, aftermath: 0.5, baitsPerChunk: 3, baitHeight: 1.2, baitDist: 0.04, baitProtein: 2,
    poisonAdults: 0.03, poisonLarvae: 0.08, abstractKillPerDay: 0.18 },
  ext: {
    speed: 1.1, treatTicks: 600, arriveMinute: 9 * 60, level: 4, minPanicAbort: 0.8,
    // the search (T1-7): he watches for flight lines and walks along each one he sees toward the nest
    sightR: 8, linesPerSec: 0.6, physPerSec: 1.2, trafficFull: 60, stepLen: 7, errFrac: 0.35, findDist: 4,
    minWatchTicks: 120, parkDist: 10, // he parks this far from where he starts and works until dusk
  },

  bees: {
    guards: 6, foragers: 14, pursueSpeed: 4.2, accel: 30, contact: 0.016, ballMin: 3,
    heatPerBeeSec: 0.13, startTemp: 35, lethal: 46, entranceAlarm: 0.5, alarmTicks: 1200,
    catchAlarmRadius: 3, hiveAlarmRadius: 8, escapePerPress: 0.35, returnTicks: 90,
  },

  alarm: { radius: 6, ticks: 600, nestRadius: 3 },

  // The yearly cycle (GDD 5.2, 6.7). Fractions of the season.
  season: {
    startFrac: 0.3, reproStart: 0.55, reproFull: 0.72, reproProtein: 3, gyneShare: 0.6,
    matePerDay: 0.5, mateSuccess: 0.7, collapseFrom: 0.82, collapseMul: 5, queenDiesAt: 0.95,
    winterSurvival: 0.03, lineageSurvival: 0.3, winterShare: 0.5,
  },
  queen: { speedMul: 0.8, venomMul: 1.5 },
  // Winter with choices (T1-15): mated gynes winter at sites near the nest; site quality sets survival. A worker can
  // scout one site in late season (E) and most gynes go there; in spring the player picks which queen to wake as.
  hiber: {
    range: 40, spread: 5, pickShare: 0.6, survival: 0.06, chooseTicks: 1800, reach: 0.15, barkMinR: 0.15,
    q: { shed: 0.85, hollow: 0.75, bark: 0.5, litter: 0.3, sister: 0.5 },
    name: { shed: 'in a shed wall', hollow: 'in a hollow tree', bark: 'under loose bark', litter: 'in the leaf litter', sister: 'in a sister nest' },
  },

  // Predators and rivals (GDD 9.3)
  web: { spiderSpeed: 0.06, spiderDelay: 60, escapePerPress: 0.22, aiEscape: 0.004 },
  // Dragonflies hunt low over open ground (GDD 9.3): faster than a wasp's burst, worse at turning
  dragon: { sight: 2.5, maxY: 2.5, speed: 7.5, accel: 14, catch: 0.04, diveTicks: 90, coolTicks: 420 },
  bird: { sight: 7, minY: 1.5, abortY: 0.8, speed: 9, accel: 26, catch: 0.06, diveTicks: 150, coolTicks: 600 },
  // bio: Vespula walk a few cm/s and hold on at any angle. A slow wasp with no input settles on the nearest surface
  // within reach (any face, trunk, stalk, underside); walking follows the surface round edges; only Space or Shift
  // take off. A sting lands on a person within stingReach.
  land: { maxSpeed: 0.25, walkSpeed: 0.05, afterTakeoff: 30, reach: 0.012, stick: 0.03, stingReach: 0.04, stalkR: 0.0035, headR: 0.022 },
  // Perching and crawling on people (GDD 7.2, 8.3): how long until they feel you
  perch: { crawlSpeed: 0.06, tickleBase: 4, bareMul: 1, thinMul: 2, backMul: 1.5, faceMul: 0.4, movingMul: 2, cooldown: 90, panic: 0.05 },
  // People remember stings by recency and place (GDD 8.10, T1-18): wary for a couple of days, most where it happened
  memory: { fasterPerSting: 0.08, minFactor: 0.6, panicPerSting: 0.15, maxStings: 4, keep: 8, forgetMinutes: 2880, nearDist: 4, farShare: 0.35 },
  rival: { maxPhysical: 3, fightRange: 0.025, remoteFightRange: 0.06, remoteFightTimeout: 240, fightTicks: 40, guardRadius: 1.5, raidProtein: 2, huntTicks: 600, mash: 0.15 },

  // Networking (GDD 11): human-side effects of events commit at the end of the consequence window
  // claimTicks (T1-19): how long a pickup waits for the chunk authority's word before it is taken as granted
  net: { commitTicks: 30, stateEvery: 3, remoteTimeout: 45, claimTicks: 120 },
  // Relevance tiers (GDD 11.12, T1-21), judged per receiving peer from where its own wasp is: my driven wasp every
  // stateEvery ticks; AI wasps within nearDist of its wasp every nearEvery ticks, full state; within interestChunks
  // chunks every midEvery ticks in swarm packets (position and state only); beyond that a count per chunk every farEvery.
  relevance: { nearDist: 50, interestChunks: 3, nearEvery: 6, midEvery: 20, farEvery: 60, midTtl: 75 },
  // Plausibility checks on what peers send (GDD 11.8). Margins are generous: honest traffic must always pass,
  // only gross violations fail, so honest peers reach the same verdict.
  // T1-20: a pickup or a sip must be within pickupReach of the thing taken, and no wasp position may lie more than
  // solidDepth inside a house, shed, table, trunk or grill, or under the ground; a sip is at most sipMax
  plaus: { futureTicks: 120, stingReach: 1.6, humanDrift: 3, maxSwatDelay: 240, maxSwats: 4, rateWindow: 120, rateMax: 6,
    maxSpeed: 12, strikes: 3, pickupReach: 0.3, solidDepth: 0.08, sipMax: 0.12 },
};

export const DEFAULT_SETTINGS = {
  dayMinutes: 2, humanDensity: 1, beeAggression: 1, seasonDays: 40,
  // World modifiers (GDD 4.8): data, not code
  reaction: 1, escalation: 1, exterminator: true, birds: true, rivals: true, pestControl: true,
};

// The settings that change the rules, in a fixed order. Their hash is the world's rules hash: peers compare it.
const RULE_KEYS = ['dayMinutes', 'humanDensity', 'beeAggression', 'seasonDays', 'reaction', 'escalation', 'exterminator', 'birds', 'rivals', 'pestControl'];
export function rulesHash(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  let h = 0x811c9dc5;
  const str = 'gen' + GEN_VERSION + '|' + RULE_KEYS.map((k) => k + '=' + s[k]).join('|') + '|tune=' + TUNE.hash; // peers must share the tuning file too (T1-22)
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// A short tag that tells this world apart at a glance (GDD 4.8). Empty means the standard rules.
export function worldTag(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings }, d = DEFAULT_SETTINGS, t = [];
  const x = (v) => '×' + (+v.toFixed(2));
  if (s.dayMinutes !== d.dayMinutes) t.push(`${s.dayMinutes}-min days`);
  if (s.seasonDays !== d.seasonDays) t.push(s.seasonDays > d.seasonDays ? `long seasons (${s.seasonDays} d)` : `short seasons (${s.seasonDays} d)`);
  if (s.humanDensity !== d.humanDensity) t.push(`people ${x(s.humanDensity)}`);
  if (s.reaction !== d.reaction) t.push(s.reaction > 1 ? 'slow humans' : 'fast humans');
  if (s.escalation !== d.escalation) t.push(s.escalation > 1 ? 'touchy neighborhoods' : 'easygoing neighborhoods');
  if (s.beeAggression !== d.beeAggression) t.push(`bees ${x(s.beeAggression)}`);
  if (!s.exterminator) t.push('no exterminators');
  if (!s.pestControl) t.push('no pest control');
  if (!s.birds) t.push('no birds');
  if (!s.rivals) t.push('no rival colonies');
  return t.join(' · ');
}
