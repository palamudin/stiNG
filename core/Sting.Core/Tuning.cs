// Tuning tables (GDD 13). Port of poc/sim/tuning.js; names kept as in the JS so the two read side by side.
// Every fraction is written as a Num expression (1.0 / 90, never 1 / 90).
#pragma warning disable IDE1006 // lower-case names on purpose: they mirror the JS reference
namespace Sting.Core
{
    public sealed class AllocPreset { public string name; public Num sugar, protein, pulp, traffic = 1; }
    public sealed class SiteType { public string name; public Num maxCells, flood, exposure, discovery, insulation, heat; }

    public static class T
    {
        public const int TICK_RATE = 60;
        public static readonly Num DT = 1.0 / TICK_RATE;
        public const int GEN_VERSION = 3;

        public static readonly Num population = 8200000000;
        public static class chunk { public static readonly Num size = 64; public const int activeRadius = 1, discoverRadius = 2; }
        public static class time { public static readonly Num startMinute = 11 * 60, dawn = 7 * 60, dusk = 20 * 60 + 30; }
        public static class weather { public static readonly Num rainChance = 0.2, baseMin = 17, baseMax = 29, diurnalAmp = 6, flyMinTemp = 11, rainSpeedMul = 0.35, rainDrainMul = 3, springChill = 6, autumnChill = 7; }
        /// Wind (GDD 5.3, T1-1)
        public static class wind { public static readonly Num min = 0, max = 3, rainMul = 1.4, drift = 0.35, refHeight = 3, gust = 0.4; }
        /// Body temperature (GDD 7.1, 10.2, T1-2)
        public static class cold
        {
            public static readonly Num flightHeat = 12, shiverHeat = 8, shiverMinAir = 8, skinTemp = 31, nestTemp = 30, flyBody = 18, torpor = 8, rate = 1.0 / 300, shiverCost = 0.5;
            public const int lethalTicks = 5400;
        }
        /// Drowning in a drink (GDD 7.5, T1-3)
        public static class drown { public static readonly Num chancePerSec = 0.03, escapePerPress = 0.3, aiEscape = 0.006; public const int ticks = 240; }
        /// hollow cups (GDD 7.5): an open top, a thin wall, a drink a third to nearly full
        public static class cup { public static readonly Num r = 0.033, wall = 0.003, @base = 0.75, rim = 0.87, fillMin = 0.3, fillSpan = 0.6, noticeMul = 2, noticeDist = 1; public const int coverTicks = 600, drownTicks = 300; }
        public static class wasp
        {
            public static readonly Num radius = 0.007, cruise = 3.0, burst = 6.0, accel = 14, burstAccel = 24, climb = 1.6, contactGap = 0.02,
                pushOff = 0.9, gravity = 9.81, maxFall = 4.5, ceiling = 40, carrySpeedMul = 0.8;
            public const int substeps = 3, starveTicks = 900;
        }
        public static class venom { public static readonly Num jab = 0.12, deepen = 0.2, regenPerSec = 1.0 / 90; }
        public static class energy { public static readonly Num cruisePerSec = 1.0 / 240, hoverShare = 0.45, burstMul = 2.6, refuelPerSec = 0.35, feedDist = 0.045, nestRefill = 0.6; }
        public static class sting { public const int jabTicks = 6, fullTicks = 30; }
        public const int stunTicks = 70, respawnTicks = 150;
        public static class reach { public static readonly Num arm = 0.5, flex = 0.3, girth = 0.2, age = 0.1, minReachToSwat = 0.25; }
        public static class resolve
        {
            public static readonly Num jabPain = 0.3, fullPain = 1.0, preciseRadius = 0.04, flailerRadius = 0.10, brushRadius = 0.08, coverRadius = 0.12,
                contortRadius = 0.15, helperRange = 2.0, fleePanic = 0.8, shakeRadius = 0.16, flailRadius = 0.2;
            public const int flailDelay = 8;
            public const int contortExtraTicks = 12, helperNoticeTicks = 8, minConsequenceTicks = 11;
        }
        public static class panic
        {
            public static readonly Num decayPerStep = 0.993, contagionRadius = 5, contagionRate = 0.03, contagionMin = 0.3,
                spillChance = 0.6, spillReach = 0.75, spillRate = 1.6, spillMinutes = 240,
                calm = 0.2, fleeSpeed = 3.2, walkSpeed = 1.3, approachDist = 26,
                sightHeight = 1.3; // panic spreads by sight (T1-17): sheds and anything taller, and tree trunks, block it
            public const int fleeStepsMin = 60, fleeStepsMax = 120;
        }
        public static class colony
        {
            public static class start { public static readonly Num adults = 30, eggs = 30, larvae = 45, pupae = 30, cells = 160, protein = 6, sugar = 8, pulp = 2; }
            public static readonly Num adultSugar = 0.10, larvaProtein = 0.12, larvaSecretion = 0.06, eggDays = 5, larvaDays = 13, pupaDays = 12,
                larvaStarve = 0.25, adultMortality = 1.0 / 22, layBase = 20, layPerAdult = 0.8, layMax = 250, cellsPerPulp = 8, buildPerDay = 1.5,
                forageShare = 0.55, deficitSmoothing = 0.1, queenStarveDays = 1, youngDays = 4,
                sugarCapBase = 6, sugarCapDays = 2.5, proteinCapBase = 6, proteinCapDays = 2;
            public static class income { public static readonly Num sugar = 0.3, protein = 0.35, pulp = 0.15; }
        }
        public static readonly AllocPreset[] alloc = {
            new AllocPreset { name = "Balanced", sugar = 1, protein = 1, pulp = 1 },
            new AllocPreset { name = "Protein", sugar = 0.6, protein = 1.8, pulp = 0.6 },
            new AllocPreset { name = "Sugar", sugar = 1.8, protein = 0.6, pulp = 0.6 },
            new AllocPreset { name = "Build", sugar = 0.7, protein = 0.7, pulp = 1.6 },
            new AllocPreset { name = "Lie low", sugar = 1, protein = 1, pulp = 1, traffic = 0.35 }, // T1-7
        };
        /// Winter with choices (T1-15): gynes winter near the nest; site quality sets survival
        public static class hiber
        {
            public static readonly Num range = 40, pickShare = 0.6, survival = 0.06, reach = 0.15, barkMinR = 0.15;
            public const int spread = 5, chooseTicks = 1800;
            public static Num Q(string kind) => kind switch { "shed" => (Num)0.85, "hollow" => (Num)0.75, "bark" => (Num)0.5, "litter" => (Num)0.3, _ => (Num)0.5 };
        }
        /// the oldest workers guard the entrance against other colonies' wasps and the exterminator (T1-13)
        public static class guard { public const int count = 2, huntTicks = 300; public static readonly Num minAdults = 25, radius = 0.6, chase = 2.5, ring = 0.09, humanRadius = 1.5; }
        public static class ai { public const int maxPhysical = 12, launchEvery = 90, collectTicks = 150, attackTicks = 600, evadeTicks = 50; public static readonly Num arrive = 0.05, canDeficit = 0.35; }
        public static class prey
        {
            public const int fliesPerTable = 3, flyRespawnTicks = 2400;
            public static readonly Num flyOrbit = 0.32, catchDist = 0.03, caterpillarChance = 0.25, flyProtein = 1, caterpillarProtein = 2, beeProtein = 1.5;
        }
        public static class pulp { public const int chewTicks = 120; public static readonly Num amount = 1, reach = 0.018; }
        public static class esc
        {
            public static readonly Num[] levels = { 0, 3, 8, 15, 25, 40 };
            public static readonly Num decayPerDay = 0.25, sting = 1, full = 1, death = 0.3, nuisance = 0.15, headRadius = 0.4, foodRadius = 0.35, faceRadius = 0.2,
                noticeMul = 1, sprayTrait = 0.55, sprayRange = 1.5, citronellaDrain = 1.5;
            public const int cooldownTicks = 80, sprayTicks = 40, trapsPerTable = 1, sprayCharges = 6, fetchTicks = 900; // T1-6
        }
        public static class under { public const int moveTicks = 18, compressEvery = 25; public static readonly Num noticeMul = 2, compressRadius = 0.06, ripPanic = 0.92, panicMul = 1.5, openingRadius = 0.035; }
        public static class sites
        {
            // insulation (T1-14): how much of the outside cold and heat reaches the brood; heat: extra °C under a sunny roof
            public static readonly SiteType trunk = new SiteType { name = "against a trunk", maxCells = 3500, flood = 0, exposure = 1, discovery = 1, insulation = 0.4, heat = 0 };
            public static readonly SiteType ground = new SiteType { name = "in an old burrow", maxCells = 5000, flood = 0.25, exposure = 0.4, discovery = 1.6, insulation = 0.8, heat = 0 };
            public static readonly SiteType branch = new SiteType { name = "hanging from a branch", maxCells = 1800, flood = 0, exposure = 2, discovery = 0.5, insulation = 0.15, heat = 0 };
            public static readonly SiteType wall = new SiteType { name = "in a shed wall", maxCells = 4000, flood = 0, exposure = 0.3, discovery = 1.2, insulation = 0.6, heat = 0 };
            public static readonly SiteType attic = new SiteType { name = "under a shed roof", maxCells = 6000, flood = 0, exposure = 0.2, discovery = 0.8, insulation = 0.55, heat = 7 };
            public static readonly SiteType hollow = new SiteType { name = "in a hollow tree", maxCells = 4500, flood = 0, exposure = 0.25, discovery = 0.7, insulation = 0.85, heat = 0 };
            public static readonly Num rainMortality = 0.06, hollowShare = 0.3, hollowMinR = 0.22; public const int holesPerChunk = 2;
            public static SiteType Of(string site) => site switch { "ground" => ground, "branch" => branch, "wall" => wall, "attic" => attic, "hollow" => hollow, _ => trunk };
        }
        /// Nest thermals (GDD 6.6, T1-14): brood develops at full speed between these temperatures; outside them it slows,
        /// as much as the site lets the weather in
        public static class thermal
        {
            public static readonly Num coldFrom = 18, coldSpan = 12, hotFrom = 31, hotSpan = 8, hotWeight = 0.7, minSpeed = 0.15;
        }
        public static class possess { public static readonly Num freeRange = 30; public const int relayTicks = 240; }
        public static class fruit { public static readonly Num treeShare = 0.3, startFrac = 0.55, rate = 0.8, spread = 1.6; public const int perTree = 6, rotDays = 6; }
        public static class muni
        {
            public const int level = 5, radius = 1, baitsPerChunk = 3;
            public static readonly Num days = 3, cooldownDays = 4, aftermath = 0.5, baitHeight = 1.2, baitDist = 0.04, baitProtein = 2,
                poisonAdults = 0.03, poisonLarvae = 0.08, abstractKillPerDay = 0.18, aiLure = 6;
        }
        public static class ext
        {
            public static readonly Num speed = 1.1, arriveMinute = 9 * 60, minPanicAbort = 0.8;
            public const int treatTicks = 600, level = 4;
            // the search (T1-7)
            public static readonly Num sightR = 8, linesPerSec = 0.6, physPerSec = 1.2, trafficFull = 60, stepLen = 7, errFrac = 0.35, findDist = 4, parkDist = 10;
            public const int minWatchTicks = 120;
        }
        public static class bees
        {
            public const int guards = 6, foragers = 14, ballMin = 3, alarmTicks = 1200, returnTicks = 90;
            public static readonly Num pursueSpeed = 4.2, accel = 30, contact = 0.016, heatPerBeeSec = 0.13, startTemp = 35, lethal = 46, entranceAlarm = 0.5,
                catchAlarmRadius = 3, hiveAlarmRadius = 8, escapePerPress = 0.35;
        }
        public static class alarm { public static readonly Num radius = 6, nestRadius = 3; public const int ticks = 600; }
        public static class season
        {
            public static readonly Num startFrac = 0.3, reproStart = 0.55, reproFull = 0.72, reproProtein = 3, gyneShare = 0.6, matePerDay = 0.5, mateSuccess = 0.7,
                collapseFrom = 0.82, collapseMul = 5, queenDiesAt = 0.95, winterSurvival = 0.03, lineageSurvival = 0.3, winterShare = 0.5;
        }
        public static class queen { public static readonly Num speedMul = 0.8, venomMul = 1.5; }
        public static class web { public static readonly Num spiderSpeed = 0.06, escapePerPress = 0.22, aiEscape = 0.004; public const int spiderDelay = 60; }
        public sealed class Hunter { public Num sight, minY, abortY, maxY, speed, accel, @catch; public int diveTicks, coolTicks; }
        public static readonly Hunter dragon = new Hunter { sight = 2.5, maxY = 2.5, speed = 7.5, accel = 14, @catch = 0.04, diveTicks = 90, coolTicks = 420 };
        public static readonly Hunter bird = new Hunter { sight = 7, minY = 1.5, abortY = 0.8, speed = 9, accel = 26, @catch = 0.06, diveTicks = 150, coolTicks = 600 };
        /// any surface at any angle (GDD 7.2): settle within reach, walk round edges, only Space or Shift take off
        public static class land { public static readonly Num maxSpeed = 0.25, walkSpeed = 0.05, reach = 0.012, stick = 0.03, stingReach = 0.04, stalkR = 0.0035, headR = 0.022; public const int afterTakeoff = 30; }
        public static class perch { public static readonly Num crawlSpeed = 0.06, tickleBase = 4, bareMul = 1, thinMul = 2, backMul = 1.5, faceMul = 0.4, movingMul = 2, panic = 0.05; public const int cooldown = 90; }
        /// People remember stings by recency and place (GDD 8.10, T1-18): wary for a couple of days, most where it happened
        public static class memory { public static readonly Num fasterPerSting = 0.08, minFactor = 0.6, panicPerSting = 0.15, forgetMinutes = 2880, nearDist = 4, farShare = 0.35; public const int maxStings = 4, keep = 8; }
        public static class rival
        {
            public const int maxPhysical = 3, remoteFightTimeout = 240, fightTicks = 40, huntTicks = 600;
            public static readonly Num fightRange = 0.025, remoteFightRange = 0.06, guardRadius = 1.5, raidProtein = 2, mash = 0.15;
        }
        public static class net { public const int commitTicks = 30, stateEvery = 3, remoteTimeout = 45; }
        public static class plaus
        {
            public const int futureTicks = 120, maxSwatDelay = 240, maxSwats = 4, rateWindow = 120, rateMax = 6, strikes = 3;
            public static readonly Num stingReach = 1.6, humanDrift = 3, maxSpeed = 12;
        }
    }

    /// World settings and modifiers (GDD 4.8)
    public sealed class Settings
    {
        public ulong seed = 1234;
        public Num dayMinutes = 2, humanDensity = 1, beeAggression = 1, seasonDays = 40, reaction = 1, escalation = 1;
        public bool exterminator = true, birds = true, rivals = true, pestControl = true;
        public Settings Clone() => (Settings)MemberwiseClone();

#if STING_FIXED
        // a setting like 1.4 is stored as the nearest Q32.32 value; print it as the number that was set
        static string N(Num v) => JsNum.ToString(System.Math.Round((double)v, 6));
#else
        static string N(Num v) => JsNum.ToString((double)v);
#endif
        static string B(bool v) => v ? "true" : "false";

        /// FNV-32 over the rule-changing settings in a fixed order; matches tuning.js rulesHash
        public string RulesHash()
        {
            string str = "gen" + T.GEN_VERSION + "|dayMinutes=" + N(dayMinutes) + "|humanDensity=" + N(humanDensity) + "|beeAggression=" + N(beeAggression)
                + "|seasonDays=" + N(seasonDays) + "|reaction=" + N(reaction) + "|escalation=" + N(escalation)
                + "|exterminator=" + B(exterminator) + "|birds=" + B(birds) + "|rivals=" + B(rivals) + "|pestControl=" + B(pestControl);
            return R.Fnv32(str).ToString("x8");
        }

        /// A short tag that tells this world apart at a glance (GDD 4.8). Empty means the standard rules. (tuning.js worldTag)
        public string WorldTag()
        {
            var d = new Settings(); var t = new System.Collections.Generic.List<string>();
            string X(Num v) => "×" + JsNum.ToString(System.Math.Round((double)v, 2, System.MidpointRounding.AwayFromZero));
            if (dayMinutes != d.dayMinutes) t.Add($"{N(dayMinutes)}-min days");
            if (seasonDays != d.seasonDays) t.Add(seasonDays > d.seasonDays ? $"long seasons ({N(seasonDays)} d)" : $"short seasons ({N(seasonDays)} d)");
            if (humanDensity != d.humanDensity) t.Add($"people {X(humanDensity)}");
            if (reaction != d.reaction) t.Add(reaction > 1 ? "slow humans" : "fast humans");
            if (escalation != d.escalation) t.Add(escalation > 1 ? "touchy neighborhoods" : "easygoing neighborhoods");
            if (beeAggression != d.beeAggression) t.Add($"bees {X(beeAggression)}");
            if (!exterminator) t.Add("no exterminators");
            if (!pestControl) t.Add("no pest control");
            if (!birds) t.Add("no birds");
            if (!rivals) t.Add("no rival colonies");
            return string.Join(" · ", t);
        }
    }

    /// Number to string the way JavaScript prints it, for the few strings the sim hashes
    public static class JsNum
    {
        public static string ToString(double v)
        {
            if (v == System.Math.Floor(v) && System.Math.Abs(v) < 1e21) return ((long)v).ToString(System.Globalization.CultureInfo.InvariantCulture);
            return v.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        }
    }
}
