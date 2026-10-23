// Tuning tables (GDD 13). Port of poc/sim/tuning.js; names kept as in the JS so the two read side by side.
// Every fraction is written as a Num expression (1.0 / 90, never 1 / 90).
#pragma warning disable IDE1006 // lower-case names on purpose: they mirror the JS reference
namespace Sting.Core
{
    public sealed class AllocPreset { public string name; public Num sugar, protein, pulp; }
    public sealed class SiteType { public string name; public Num maxCells, flood, exposure, discovery; }

    public static class T
    {
        public const int TICK_RATE = 60;
        public static readonly Num DT = 1.0 / TICK_RATE;
        public const int GEN_VERSION = 3;

        public static readonly Num population = 8200000000;
        public static class chunk { public static readonly Num size = 64; public const int activeRadius = 1, discoverRadius = 2; }
        public static class time { public static readonly Num startMinute = 11 * 60, dawn = 7 * 60, dusk = 20 * 60 + 30; }
        public static class weather { public static readonly Num rainChance = 0.2, baseMin = 17, baseMax = 29, diurnalAmp = 6, flyMinTemp = 11, rainSpeedMul = 0.35, rainDrainMul = 3; }
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
                contortRadius = 0.15, helperRange = 2.0, fleePanic = 0.8;
            public const int contortExtraTicks = 12, helperNoticeTicks = 8, minConsequenceTicks = 11;
        }
        public static class panic
        {
            public static readonly Num decayPerStep = 0.993, contagionRadius = 5, contagionRate = 0.03, contagionMin = 0.3,
                spillChance = 0.6, spillReach = 0.75, spillRate = 1.6, spillMinutes = 240,
                calm = 0.2, fleeSpeed = 3.2, walkSpeed = 1.3, approachDist = 26;
            public const int fleeStepsMin = 60, fleeStepsMax = 120;
        }
        public static class colony
        {
            public static class start { public static readonly Num adults = 30, eggs = 30, larvae = 45, pupae = 30, cells = 160, protein = 6, sugar = 8, pulp = 2; }
            public static readonly Num adultSugar = 0.10, larvaProtein = 0.12, larvaSecretion = 0.06, eggDays = 5, larvaDays = 13, pupaDays = 12,
                larvaStarve = 0.25, adultMortality = 1.0 / 22, layBase = 20, layPerAdult = 0.8, layMax = 250, cellsPerPulp = 8, buildPerDay = 1.5,
                forageShare = 0.55, deficitSmoothing = 0.1, queenStarveDays = 1,
                sugarCapBase = 6, sugarCapDays = 2.5, proteinCapBase = 6, proteinCapDays = 2;
            public static class income { public static readonly Num sugar = 0.3, protein = 0.35, pulp = 0.15; }
        }
        public static readonly AllocPreset[] alloc = {
            new AllocPreset { name = "Balanced", sugar = 1, protein = 1, pulp = 1 },
            new AllocPreset { name = "Protein", sugar = 0.6, protein = 1.8, pulp = 0.6 },
            new AllocPreset { name = "Sugar", sugar = 1.8, protein = 0.6, pulp = 0.6 },
            new AllocPreset { name = "Build", sugar = 0.7, protein = 0.7, pulp = 1.6 },
        };
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
            public const int cooldownTicks = 80, sprayTicks = 40, trapsPerTable = 1;
        }
        public static class under { public const int moveTicks = 18, compressEvery = 25; public static readonly Num noticeMul = 2, compressRadius = 0.06, ripPanic = 0.92, panicMul = 1.5, openingRadius = 0.035; }
        public static class sites
        {
            public static readonly SiteType trunk = new SiteType { name = "against a trunk", maxCells = 3500, flood = 0, exposure = 1, discovery = 1 };
            public static readonly SiteType ground = new SiteType { name = "in an old burrow", maxCells = 5000, flood = 0.25, exposure = 0.4, discovery = 1.6 };
            public static readonly SiteType branch = new SiteType { name = "hanging from a branch", maxCells = 1800, flood = 0, exposure = 2, discovery = 0.5 };
            public static readonly SiteType wall = new SiteType { name = "in a shed wall", maxCells = 4000, flood = 0, exposure = 0.3, discovery = 1.2 };
            public static readonly SiteType attic = new SiteType { name = "under a shed roof", maxCells = 6000, flood = 0, exposure = 0.2, discovery = 0.8 };
            public static readonly Num rainMortality = 0.06; public const int holesPerChunk = 2;
            public static SiteType Of(string site) => site switch { "ground" => ground, "branch" => branch, "wall" => wall, "attic" => attic, _ => trunk };
        }
        public static class possess { public static readonly Num freeRange = 30; public const int relayTicks = 240; }
        public static class fruit { public static readonly Num treeShare = 0.3, startFrac = 0.55, rate = 0.8, spread = 1.6; public const int perTree = 6, rotDays = 6; }
        public static class muni
        {
            public const int level = 5, radius = 1, baitsPerChunk = 3;
            public static readonly Num days = 3, cooldownDays = 4, aftermath = 0.5, baitHeight = 1.2, baitDist = 0.04, baitProtein = 2,
                poisonAdults = 0.03, poisonLarvae = 0.08, abstractKillPerDay = 0.18, aiLure = 6;
        }
        public static class ext { public static readonly Num speed = 1.1, arriveMinute = 9 * 60, minPanicAbort = 0.8; public const int treatTicks = 600, level = 4; }
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
        public static class land { public static readonly Num maxSpeed = 0.25, gap = 0.004, walkSpeed = 0.05; }
        public static class perch { public static readonly Num crawlSpeed = 0.06, tickleBase = 4, bareMul = 1, thinMul = 2, backMul = 1.5, faceMul = 0.4, movingMul = 2, panic = 0.05; public const int cooldown = 90; }
        public static class memory { public static readonly Num fasterPerSting = 0.08, minFactor = 0.6, panicPerSting = 0.15; public const int maxStings = 4; }
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

        static string N(Num v) => JsNum.ToString((double)v);
        static string B(bool v) => v ? "true" : "false";

        /// FNV-32 over the rule-changing settings in a fixed order; matches tuning.js rulesHash
        public string RulesHash()
        {
            string str = "gen" + T.GEN_VERSION + "|dayMinutes=" + N(dayMinutes) + "|humanDensity=" + N(humanDensity) + "|beeAggression=" + N(beeAggression)
                + "|seasonDays=" + N(seasonDays) + "|reaction=" + N(reaction) + "|escalation=" + N(escalation)
                + "|exterminator=" + B(exterminator) + "|birds=" + B(birds) + "|rivals=" + B(rivals) + "|pestControl=" + B(pestControl);
            return R.Fnv32(str).ToString("x8");
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
