// Colony economy and the yearly cycle (GDD 2.2, 5.2, 6.2-6.7, A.4). Port of poc/sim/colony.js.
// A compartment model stepped once per sim second. bio = seasonDays / 200 scales biological durations.
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed class ColonyStats
    {
        public Num emerged, laid, starvedLarvae, died, gynesRaised, sugarSpilled, proteinSpilled, poisoned;
        public Num depSugar, depProtein, depPulp, depWater, cooked;
        public ColonyStats Clone() => (ColonyStats)MemberwiseClone();
    }

    public sealed class ColonyState
    {
        public bool queenAlive = true, nestAlive = true, sited = true;
        public Num adults, eggs, larvae, pupae, cells, protein, sugar, pulp;
        public Num rEggs, rLarvae, rPupae, gynes, males, mated;
        /// new workers who nurse and build inside before they forage (T1-13)
        public Num young;
        public Num deficit, fed = 1, sugarlessDays;
        /// water (T2-1): the store, how well the comb's heat was met with it (1 when cool), how short the nest is of it
        public Num water, cool = 1, thirst;
        public int alloc;
        public Num maxCells = Num.MaxValue;
        /// the colony's species (GDD 6.8), and the season a honeybee colony last swarmed in (T2-11)
        public string species = "wasp"; public int swarmed;
        /// the hive XP already counted from this colony's work (GDD 6.8)
        public Num xpSeen;
        /// nested somewhere warm (a house, a giant tree's hollow), inside a house, and found by the household there (GDD 6.8)
        public bool warm, house, found;
        public ColonyStats stats = new ColonyStats();
        public ColonyState Clone() { var c = (ColonyState)MemberwiseClone(); c.stats = stats.Clone(); return c; }
        public Num this[string k]
        {
            get => k switch { "sugar" => sugar, "protein" => protein, "pulp" => pulp, "water" => water, _ => throw new System.ArgumentException(k) };
            set { switch (k) { case "sugar": sugar = value; break; case "protein": protein = value; break; case "pulp": pulp = value; break; case "water": water = value; break; default: throw new System.ArgumentException(k); } }
        }
    }

    /// the hive skills' multipliers (GDD 6.8)
    public sealed class Boost { public Num forage = 1, brood = 1, lay = 1, build = 1; public static readonly Boost None = new Boost(); }

    public static class Colony
    {
        /// the colony's species row (GDD 6.8)
        public static SpeciesRow Sp(ColonyState c) => T.species.Of(c?.species);
        public static ColonyState New(bool founding = false, string species = "wasp") { Num k = T.species.Of(species).start; return new ColonyState // a hornet colony starts small, a bee colony big
        {
            species = species,
            adults = founding ? 0 : T.colony.start.adults * k, eggs = founding ? 0 : T.colony.start.eggs * k, larvae = founding ? 0 : T.colony.start.larvae * k,
            pupae = founding ? 0 : T.colony.start.pupae * k, cells = founding ? 0 : T.colony.start.cells * k, protein = founding ? 0 : T.colony.start.protein,
            sugar = founding ? 0.5 : T.colony.start.sugar, pulp = founding ? 0 : T.colony.start.pulp, water = founding ? 0 : T.colony.start.water,
        }; }

        public static Num ProteinCap(ColonyState c) => T.colony.proteinCapBase + (c.larvae + c.rLarvae * T.season.reproProtein) * T.colony.larvaProtein * T.colony.proteinCapDays;
        public static Num SugarCap(ColonyState c) => (T.colony.sugarCapBase + c.adults * T.colony.adultSugar * T.colony.sugarCapDays) * Sp(c).store; // bees keep honey
        /// the males a young queen can meet (T2-3): her colony's and the neighbourhood's, which peak with the breeding season
        public static Num MalesAbout(ColonyState c, Num frac) => Clamp01((c.males + T.males.area * ReproShare(frac)) / T.males.need);
        public static Num WaterCap(ColonyState c) => T.water.capBase + c.adults * T.water.capPerAdult; // T2-1
        public static Num BroodTotal(ColonyState c) => c.eggs + c.larvae + c.pupae + c.rEggs + c.rLarvae + c.rPupae;

        static readonly (Num from, string name)[] PHASES = { (0, "Founding"), (0.15, "Growth"), (0.55, "Peak"), (0.8, "Collapse") };
        public static string SeasonPhase(Num frac) { var p = PHASES[0]; foreach (var x in PHASES) if (frac >= x.from) p = x; return p.name; }
        public static Num ReproShare(Num frac) => Clamp01((frac - T.season.reproStart) / (T.season.reproFull - T.season.reproStart));
        /// a honeybee colony raises queens and drones early in the season, and only when crowded (T2-11)
        public static Num BeeRepro(ColonyState c, Num frac) => frac >= T.hive.swarmFrom && frac < T.hive.swarmTo && c.adults >= T.hive.swarmAdults ? T.hive.reproShare : 0;

        /// One step of dtDay in-game days (colony.js colonyStep)
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging) => Step(c, dtDay, physical, foraging, 0.3, 1);
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging, Num frac) => Step(c, dtDay, physical, foraging, frac, 1);
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging, Num frac, Num bio) => Step(c, dtDay, physical, foraging, frac, bio, 1);
        /// thermal: brood development speed from the nest's temperature (T1-14), 1 when comfortable
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging, Num frac, Num bio, Num thermal) => Step(c, dtDay, physical, foraging, frac, bio, thermal, null);
        /// avail: what the season offers foragers (T1-8), sugar and protein multipliers
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging, Num frac, Num bio, Num thermal, (Num sugar, Num protein)? avail) => Step(c, dtDay, physical, foraging, frac, bio, thermal, avail, null);
        /// hot: the nest's heat (T2-1), heat 0..1 through the site's insulation and cook 0..1 past the brood's lethal temperature
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging, Num frac, Num bio, Num thermal, (Num sugar, Num protein)? avail, (Num heat, Num cook)? hot) => Step(c, dtDay, physical, foraging, frac, bio, thermal, avail, hot, null);
        /// boost: the hive skills' multipliers (GDD 6.8), the player's colony only; null is 1 for all
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging, Num frac, Num bio, Num thermal, (Num sugar, Num protein)? avail, (Num heat, Num cook)? hot, Boost boost)
        {
            var K = boost ?? Boost.None;
            if (!c.nestAlive) return;
            var SP = Sp(c);
            Num inside = Max(0, c.adults - physical);
            Num heat = hot.HasValue ? hot.Value.heat : 0, wcap = WaterCap(c);
            // a hot nest with a low store sends some foragers for water instead of food
            c.thirst = heat * (1 - Clamp01(c.water / wcap));
            Num divert = T.water.divert * c.thirst;
            if (foraging)
            {
                var a = T.alloc[c.alloc]; Num wsum = (a.sugar + a.protein + a.pulp) / 3;
                Num f = Max(0, inside - c.young) * T.colony.forageShare * a.traffic * dtDay; // 'Lie low' sends fewer out (T1-7); the young stay in (T1-13)
                Num food = f * (1 - divert);
                c.sugar += food * T.colony.income.sugar * a.sugar / wsum * (avail.HasValue ? avail.Value.sugar : 1) * SP.sugarIn * K.forage;
                c.protein += food * T.colony.income.protein * a.protein / wsum * (avail.HasValue ? avail.Value.protein : 1) * SP.proteinIn * K.forage;
                if (SP.wood != 0) c.pulp += food * T.colony.income.pulp * a.pulp / wsum * K.forage; // bees build wax from sugar instead (T2-11)
                else c.sugar += food * T.colony.income.pulp * a.pulp / wsum * SP.sugarIn * K.forage;
                c.water += f * divert * T.water.income;
            }
            if (c.water > wcap) c.water = wcap;
            // cooling: the heat uses water; how much of the need was met decides how much the heat still slows the brood
            Num demand = heat * T.water.coolPerDay * dtDay;
            if (demand > 0) { Num wp = Min(c.water, demand); c.water -= wp; c.cool += (wp / demand - c.cool) * T.water.smoothing; }
            else c.cool += (1 - c.cool) * T.water.smoothing;
            // past the lethal temperature the brood the water does not save cooks
            Num cook = (hot.HasValue ? hot.Value.cook : 0) * (1 - c.cool) * T.water.broodCook * dtDay;
            if (cook > 0)
            {
                Num k = Min(1, cook), lost = 0;
                Num Cut(ref Num x) { Num y = x * k; x -= y; return y; }
                lost += Cut(ref c.eggs); lost += Cut(ref c.larvae); lost += Cut(ref c.pupae); lost += Cut(ref c.rEggs); lost += Cut(ref c.rLarvae); lost += Cut(ref c.rPupae);
                c.stats.cooked += lost;
            }
            Num cap = SugarCap(c);
            if (c.sugar > cap) { c.stats.sugarSpilled = c.stats.sugarSpilled + c.sugar - cap; c.sugar = cap; }
            Num pcap = ProteinCap(c);
            if (c.protein > pcap) { c.stats.proteinSpilled = c.stats.proteinSpilled + c.protein - pcap; c.protein = pcap; }

            Num need = (c.larvae + c.rLarvae * T.season.reproProtein) * T.colony.larvaProtein * dtDay;
            Num fed = need > 0 ? Min(1, c.protein / need) : 1;
            c.protein -= need * fed;
            c.fed = c.fed + (fed - c.fed) * 0.2;
            Num secretion = (c.larvae + c.rLarvae) * fed * T.colony.larvaSecretion * dtDay;

            Num sugarNeed = c.adults * T.colony.adultSugar * dtDay;
            Num fromStore = Max(0, sugarNeed - secretion);
            Num paid = Min(fromStore, c.sugar);
            c.sugar -= paid;
            Num unpaid = fromStore - paid;
            Num raw = sugarNeed > 0 ? Clamp01((sugarNeed - secretion) / sugarNeed) : 0;
            c.deficit += (raw - c.deficit) * T.colony.deficitSmoothing;
            if (unpaid > 0 && c.adults > 0)
            {
                Num starve = Min(inside, unpaid / (T.colony.adultSugar * dtDay) * 0.02);
                c.adults -= starve; c.stats.died += starve;
            }
            if (unpaid > 0 && c.sugar <= 0)
            {
                c.sugarlessDays += dtDay;
                if (c.sugarlessDays >= T.colony.queenStarveDays) c.queenAlive = false;
            }
            else c.sugarlessDays = 0;

            Num eD = T.colony.eggDays * bio, lD = T.colony.larvaDays * bio, pD = T.colony.pupaDays * bio, th = thermal * K.brood;
            Num Pipe(ref Num eggs, ref Num larvae, ref Num pupae)
            {
                Num e2l = eggs / eD * dtDay * th, l2p = larvae / lD * dtDay * fed * th, p2a = pupae / pD * dtDay * th;
                Num ls = larvae * (1 - fed) * T.colony.larvaStarve * dtDay;
                eggs -= e2l; larvae += e2l - l2p - ls; pupae += l2p - p2a;
                c.stats.starvedLarvae += ls;
                return p2a;
            }
            Num newWorkers = Pipe(ref c.eggs, ref c.larvae, ref c.pupae);
            Num newRepro = Pipe(ref c.rEggs, ref c.rLarvae, ref c.rPupae);
            c.adults += newWorkers; c.stats.emerged += newWorkers;
            // new workers stay in a few days before they forage (T1-13)
            c.young += newWorkers - c.young / (T.colony.youngDays * bio) * dtDay;
            c.gynes += newRepro * T.season.gyneShare; c.males += newRepro * (1 - T.season.gyneShare); c.stats.gynesRaised += newRepro * T.season.gyneShare;

            if (foraging && c.gynes > 0 && SP.perennial == 0) { Num m = c.gynes * T.season.matePerDay * dtDay; c.gynes -= m; c.mated += m * T.season.mateSuccess * MalesAbout(c, frac); } // T2-3

            Num late = frac > T.season.collapseFrom && SP.perennial == 0 && !c.warm ? 1 + T.season.collapseMul * (frac - T.season.collapseFrom) / (1 - T.season.collapseFrom) : 1;
            Num die = inside * T.colony.adultMortality / bio * late * dtDay;
            c.adults -= die; c.stats.died += die;
            c.males -= c.males * 0.2 * dtDay / bio;
            if (frac >= T.season.queenDiesAt && SP.perennial == 0 && !c.warm) c.queenAlive = false; // a colony nested somewhere warm keeps its queen (GDD 6.8)

            Num use;
            if (SP.wood != 0) { use = Min(c.pulp, T.colony.buildPerDay * dtDay * (1 + inside / 40)); c.pulp -= use; }
            else
            { // wax from the store above a reserve (T2-11)
                use = Min(Max(0, c.sugar - SugarCap(c) * T.hive.waxFrom) / T.hive.waxSugar, T.colony.buildPerDay * dtDay * (1 + inside / 40));
                if (c.cells >= (c.maxCells != 0 ? c.maxCells : Num.MaxValue)) use = 0;
                c.sugar -= use * T.hive.waxSugar;
            }
            c.cells = Min(c.cells + use * T.colony.cellsPerPulp * K.build, c.maxCells != 0 ? c.maxCells : Num.MaxValue);

            if (c.queenAlive && c.protein > 0)
            {
                Num free = Max(0, c.cells - BroodTotal(c));
                Num lay = Min(free, Min(T.colony.layMax * SP.lay * K.lay, (T.colony.layBase + c.adults * T.colony.layPerAdult) * SP.lay * K.lay) * dtDay);
                Num r = SP.perennial != 0 ? BeeRepro(c, frac) : c.warm ? Min(ReproShare(frac), T.warm.reproMax) : ReproShare(frac); // a warm nest keeps raising workers to winter with (GDD 6.8)
                c.eggs += lay * (1 - r); c.rEggs += lay * r; c.stats.laid += lay;
            }
            if (c.adults < 0) c.adults = 0;
            if (c.young > c.adults) c.young = c.adults;
        }

        public static void DestroyNest(ColonyState c)
        {
            c.nestAlive = false; c.queenAlive = false; c.young = 0;
            c.eggs = 0; c.larvae = 0; c.pupae = 0; c.rEggs = 0; c.rLarvae = 0; c.rPupae = 0; c.gynes = 0;
            c.protein = 0; c.sugar = 0; c.pulp = 0;
        }

        public static bool Finished(ColonyState c, Num physical)
        {
            bool brood = BroodTotal(c) >= 1;
            return (!c.nestAlive || !c.queenAlive) && !brood && c.adults - physical < 1 && c.gynes < 0.5;
        }
    }
}
