// Tuning tables (GDD 13). Every number here is a starting value for tuning.
// Biology-derived values are noted; see GDD Appendix C.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const GEN_VERSION = 2;

export const T = {
  population: 8200000000,
  chunk: { size: 64, activeRadius: 1, discoverRadius: 2 },

  time: { startMinute: 11 * 60, dawn: 7 * 60, dusk: 20 * 60 + 30 },
  weather: {
    rainChance: 0.2, baseMin: 17, baseMax: 29, diurnalAmp: 6, flyMinTemp: 11,
    rainSpeedMul: 0.35, rainDrainMul: 3,
  },

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
    helperRange: 2.0, fleePanic: 0.8,
  },
  panic: {
    decayPerStep: 0.993, contagionRadius: 5, contagionRate: 0.03, contagionMin: 0.3,
    calm: 0.2, fleeSpeed: 3.2, walkSpeed: 1.3, fleeStepsMin: 60, fleeStepsMax: 120, approachDist: 26,
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
    sugarCapBase: 6, sugarCapDays: 2.5,                            // bio: Vespula keep little sugar; a store of a few days of adult need
  },
  alloc: [
    { name: 'Balanced', sugar: 1, protein: 1, pulp: 1 },
    { name: 'Protein', sugar: 0.6, protein: 1.8, pulp: 0.6 },
    { name: 'Sugar', sugar: 1.8, protein: 0.6, pulp: 0.6 },
    { name: 'Build', sugar: 0.7, protein: 0.7, pulp: 1.6 },
  ],

  ai: { maxPhysical: 12, launchEvery: 90, arrive: 0.05, collectTicks: 150, attackTicks: 600, evadeTicks: 50, canDeficit: 0.35 },

  prey: {
    fliesPerTable: 3, flyOrbit: 0.32, catchDist: 0.03, flyRespawnTicks: 2400,
    caterpillarChance: 0.25, flyProtein: 1, caterpillarProtein: 2, beeProtein: 1.5,
  },
  pulp: { chewTicks: 120, amount: 1, reach: 0.018 },

  // Escalation ladder (GDD 8.10)
  esc: {
    levels: [0, 3, 8, 15, 25], decayPerDay: 0.25,
    sting: 1, full: 1, death: 0.3, nuisance: 0.15,
    headRadius: 0.4, foodRadius: 0.35, faceRadius: 0.2, noticeMul: 1, cooldownTicks: 80,
    sprayTrait: 0.55, sprayRange: 1.5, sprayTicks: 40, trapsPerTable: 1, citronellaDrain: 1.5,
  },

  under: { moveTicks: 18, noticeMul: 2, compressRadius: 0.06, compressEvery: 25, ripPanic: 0.92, panicMul: 1.5, openingRadius: 0.035 },

  ext: { speed: 1.1, treatTicks: 600, arriveMinute: 9 * 60, level: 4, minPanicAbort: 0.8 },

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

  // Predators and rivals (GDD 9.3)
  web: { spiderSpeed: 0.06, spiderDelay: 60, escapePerPress: 0.22, aiEscape: 0.004 },
  bird: { sight: 7, minY: 1.5, abortY: 0.8, speed: 9, accel: 26, catch: 0.06, diveTicks: 150, coolTicks: 600 },
  land: { maxSpeed: 0.25, gap: 0.004, walkSpeed: 0.05 }, // bio: Vespula walk a few cm/s
  // Perching and crawling on people (GDD 7.2, 8.3): how long until they feel you
  perch: { crawlSpeed: 0.06, tickleBase: 4, bareMul: 1, thinMul: 2, backMul: 1.5, faceMul: 0.4, movingMul: 2, cooldown: 90, panic: 0.05 },
  memory: { fasterPerSting: 0.08, minFactor: 0.6, panicPerSting: 0.15, maxStings: 4 },
  rival: { maxPhysical: 3, fightRange: 0.025, remoteFightRange: 0.06, remoteFightTimeout: 240, fightTicks: 40, guardRadius: 1.5, raidProtein: 2, huntTicks: 600, mash: 0.15 },

  // Networking (GDD 11): human-side effects of events commit at the end of the consequence window
  net: { commitTicks: 30, stateEvery: 3, remoteTimeout: 45 },
};

export const DEFAULT_SETTINGS = { dayMinutes: 2, humanDensity: 1, beeAggression: 1, seasonDays: 40 };
