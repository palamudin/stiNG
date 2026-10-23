// Colony economy and the yearly cycle (GDD 2.2, 5.2, 6.2-6.7, A.4). Port of poc/sim/colony.js.
// A compartment model stepped once per sim second. bio = seasonDays / 200 scales biological durations.
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed class ColonyStats
    {
        public Num emerged, laid, starvedLarvae, died, gynesRaised, sugarSpilled, proteinSpilled, poisoned;
        public Num depSugar, depProtein, depPulp;
        public ColonyStats Clone() => (ColonyStats)MemberwiseClone();
    }

    public sealed class ColonyState
    {
        public bool queenAlive = true, nestAlive = true, sited = true;
        public Num adults, eggs, larvae, pupae, cells, protein, sugar, pulp;
        public Num rEggs, rLarvae, rPupae, gynes, males, mated;
        public Num deficit, fed = 1, sugarlessDays;
        public int alloc;
        public Num maxCells = Num.MaxValue;
        public ColonyStats stats = new ColonyStats();
        public ColonyState Clone() { var c = (ColonyState)MemberwiseClone(); c.stats = stats.Clone(); return c; }
        public Num this[string k]
        {
            get => k switch { "sugar" => sugar, "protein" => protein, "pulp" => pulp, _ => throw new System.ArgumentException(k) };
            set { switch (k) { case "sugar": sugar = value; break; case "protein": protein = value; break; case "pulp": pulp = value; break; default: throw new System.ArgumentException(k); } }
        }
    }

    public static class Colony
    {
        public static ColonyState New(bool founding = false) => new ColonyState
        {
            adults = founding ? 0 : T.colony.start.adults, eggs = founding ? 0 : T.colony.start.eggs, larvae = founding ? 0 : T.colony.start.larvae,
            pupae = founding ? 0 : T.colony.start.pupae, cells = founding ? 0 : T.colony.start.cells, protein = founding ? 0 : T.colony.start.protein,
            sugar = founding ? 0.5 : T.colony.start.sugar, pulp = founding ? 0 : T.colony.start.pulp,
        };

        public static Num ProteinCap(ColonyState c) => T.colony.proteinCapBase + (c.larvae + c.rLarvae * T.season.reproProtein) * T.colony.larvaProtein * T.colony.proteinCapDays;
        public static Num SugarCap(ColonyState c) => T.colony.sugarCapBase + c.adults * T.colony.adultSugar * T.colony.sugarCapDays;
        public static Num BroodTotal(ColonyState c) => c.eggs + c.larvae + c.pupae + c.rEggs + c.rLarvae + c.rPupae;

        static readonly (Num from, string name)[] PHASES = { (0, "Founding"), (0.15, "Growth"), (0.55, "Peak"), (0.8, "Collapse") };
        public static string SeasonPhase(Num frac) { var p = PHASES[0]; foreach (var x in PHASES) if (frac >= x.from) p = x; return p.name; }
        public static Num ReproShare(Num frac) => Clamp01((frac - T.season.reproStart) / (T.season.reproFull - T.season.reproStart));

        /// One step of dtDay in-game days (colony.js colonyStep)
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging) => Step(c, dtDay, physical, foraging, 0.3, 1);
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging, Num frac) => Step(c, dtDay, physical, foraging, frac, 1);
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging, Num frac, Num bio) => Step(c, dtDay, physical, foraging, frac, bio, 1);
        /// thermal: brood development speed from the nest's temperature (T1-14), 1 when comfortable
        public static void Step(ColonyState c, Num dtDay, Num physical, bool foraging, Num frac, Num bio, Num thermal)
        {
            if (!c.nestAlive) return;
            Num inside = Max(0, c.adults - physical);
            if (foraging)
            {
                var a = T.alloc[c.alloc]; Num wsum = (a.sugar + a.protein + a.pulp) / 3;
                Num f = inside * T.colony.forageShare * a.traffic * dtDay; // 'Lie low' sends fewer out (T1-7)
                c.sugar += f * T.colony.income.sugar * a.sugar / wsum;
                c.protein += f * T.colony.income.protein * a.protein / wsum;
                c.pulp += f * T.colony.income.pulp * a.pulp / wsum;
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

            Num eD = T.colony.eggDays * bio, lD = T.colony.larvaDays * bio, pD = T.colony.pupaDays * bio;
            Num Pipe(ref Num eggs, ref Num larvae, ref Num pupae)
            {
                Num e2l = eggs / eD * dtDay * thermal, l2p = larvae / lD * dtDay * fed * thermal, p2a = pupae / pD * dtDay * thermal;
                Num ls = larvae * (1 - fed) * T.colony.larvaStarve * dtDay;
                eggs -= e2l; larvae += e2l - l2p - ls; pupae += l2p - p2a;
                c.stats.starvedLarvae += ls;
                return p2a;
            }
            Num newWorkers = Pipe(ref c.eggs, ref c.larvae, ref c.pupae);
            Num newRepro = Pipe(ref c.rEggs, ref c.rLarvae, ref c.rPupae);
            c.adults += newWorkers; c.stats.emerged += newWorkers;
            c.gynes += newRepro * T.season.gyneShare; c.males += newRepro * (1 - T.season.gyneShare); c.stats.gynesRaised += newRepro * T.season.gyneShare;

            if (foraging && c.gynes > 0) { Num m = c.gynes * T.season.matePerDay * dtDay; c.gynes -= m; c.mated += m * T.season.mateSuccess; }

            Num late = frac > T.season.collapseFrom ? 1 + T.season.collapseMul * (frac - T.season.collapseFrom) / (1 - T.season.collapseFrom) : 1;
            Num die = inside * T.colony.adultMortality / bio * late * dtDay;
            c.adults -= die; c.stats.died += die;
            c.males -= c.males * 0.2 * dtDay / bio;
            if (frac >= T.season.queenDiesAt) c.queenAlive = false;

            Num use = Min(c.pulp, T.colony.buildPerDay * dtDay * (1 + inside / 40));
            c.pulp -= use; c.cells = Min(c.cells + use * T.colony.cellsPerPulp, c.maxCells != 0 ? c.maxCells : Num.MaxValue);

            if (c.queenAlive && c.protein > 0)
            {
                Num free = Max(0, c.cells - BroodTotal(c));
                Num lay = Min(free, Min(T.colony.layMax, T.colony.layBase + c.adults * T.colony.layPerAdult) * dtDay);
                Num r = ReproShare(frac);
                c.eggs += lay * (1 - r); c.rEggs += lay * r; c.stats.laid += lay;
            }
            if (c.adults < 0) c.adults = 0;
        }

        public static void DestroyNest(ColonyState c)
        {
            c.nestAlive = false; c.queenAlive = false;
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
