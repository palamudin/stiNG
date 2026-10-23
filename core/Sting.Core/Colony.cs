// Colony economy and the yearly cycle (GDD 2.2, 5.2, 6.2-6.7, A.4). Port of poc/sim/colony.js.
// A compartment model stepped once per sim second. bio = seasonDays / 200 scales biological durations.
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed class ColonyStats
    {
        public double emerged, laid, starvedLarvae, died, gynesRaised, sugarSpilled, proteinSpilled, poisoned;
        public double depSugar, depProtein, depPulp;
        public ColonyStats Clone() => (ColonyStats)MemberwiseClone();
    }

    public sealed class ColonyState
    {
        public bool queenAlive = true, nestAlive = true, sited = true;
        public double adults, eggs, larvae, pupae, cells, protein, sugar, pulp;
        public double rEggs, rLarvae, rPupae, gynes, males, mated;
        public double deficit, fed = 1, sugarlessDays;
        public int alloc;
        public double maxCells = double.PositiveInfinity;
        public ColonyStats stats = new ColonyStats();
        public ColonyState Clone() { var c = (ColonyState)MemberwiseClone(); c.stats = stats.Clone(); return c; }
        public double this[string k]
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

        public static double ProteinCap(ColonyState c) => T.colony.proteinCapBase + (c.larvae + c.rLarvae * T.season.reproProtein) * T.colony.larvaProtein * T.colony.proteinCapDays;
        public static double SugarCap(ColonyState c) => T.colony.sugarCapBase + c.adults * T.colony.adultSugar * T.colony.sugarCapDays;
        public static double BroodTotal(ColonyState c) => c.eggs + c.larvae + c.pupae + c.rEggs + c.rLarvae + c.rPupae;

        static readonly (double from, string name)[] PHASES = { (0, "Founding"), (0.15, "Growth"), (0.55, "Peak"), (0.8, "Collapse") };
        public static string SeasonPhase(double frac) { var p = PHASES[0]; foreach (var x in PHASES) if (frac >= x.from) p = x; return p.name; }
        public static double ReproShare(double frac) => Clamp01((frac - T.season.reproStart) / (T.season.reproFull - T.season.reproStart));

        /// One step of dtDay in-game days (colony.js colonyStep)
        public static void Step(ColonyState c, double dtDay, double physical, bool foraging, double frac = 0.3, double bio = 1)
        {
            if (!c.nestAlive) return;
            double inside = Max(0, c.adults - physical);
            if (foraging)
            {
                var a = T.alloc[c.alloc]; double wsum = (a.sugar + a.protein + a.pulp) / 3;
                double f = inside * T.colony.forageShare * dtDay;
                c.sugar += f * T.colony.income.sugar * a.sugar / wsum;
                c.protein += f * T.colony.income.protein * a.protein / wsum;
                c.pulp += f * T.colony.income.pulp * a.pulp / wsum;
            }
            double cap = SugarCap(c);
            if (c.sugar > cap) { c.stats.sugarSpilled = c.stats.sugarSpilled + c.sugar - cap; c.sugar = cap; }
            double pcap = ProteinCap(c);
            if (c.protein > pcap) { c.stats.proteinSpilled = c.stats.proteinSpilled + c.protein - pcap; c.protein = pcap; }

            double need = (c.larvae + c.rLarvae * T.season.reproProtein) * T.colony.larvaProtein * dtDay;
            double fed = need > 0 ? Min(1, c.protein / need) : 1;
            c.protein -= need * fed;
            c.fed = c.fed + (fed - c.fed) * 0.2;
            double secretion = (c.larvae + c.rLarvae) * fed * T.colony.larvaSecretion * dtDay;

            double sugarNeed = c.adults * T.colony.adultSugar * dtDay;
            double fromStore = Max(0, sugarNeed - secretion);
            double paid = Min(fromStore, c.sugar);
            c.sugar -= paid;
            double unpaid = fromStore - paid;
            double raw = sugarNeed > 0 ? Clamp01((sugarNeed - secretion) / sugarNeed) : 0;
            c.deficit += (raw - c.deficit) * T.colony.deficitSmoothing;
            if (unpaid > 0 && c.adults > 0)
            {
                double starve = Min(inside, unpaid / (T.colony.adultSugar * dtDay) * 0.02);
                c.adults -= starve; c.stats.died += starve;
            }
            if (unpaid > 0 && c.sugar <= 0)
            {
                c.sugarlessDays += dtDay;
                if (c.sugarlessDays >= T.colony.queenStarveDays) c.queenAlive = false;
            }
            else c.sugarlessDays = 0;

            double eD = T.colony.eggDays * bio, lD = T.colony.larvaDays * bio, pD = T.colony.pupaDays * bio;
            double Pipe(ref double eggs, ref double larvae, ref double pupae)
            {
                double e2l = eggs / eD * dtDay, l2p = larvae / lD * dtDay * fed, p2a = pupae / pD * dtDay;
                double ls = larvae * (1 - fed) * T.colony.larvaStarve * dtDay;
                eggs -= e2l; larvae += e2l - l2p - ls; pupae += l2p - p2a;
                c.stats.starvedLarvae += ls;
                return p2a;
            }
            double newWorkers = Pipe(ref c.eggs, ref c.larvae, ref c.pupae);
            double newRepro = Pipe(ref c.rEggs, ref c.rLarvae, ref c.rPupae);
            c.adults += newWorkers; c.stats.emerged += newWorkers;
            c.gynes += newRepro * T.season.gyneShare; c.males += newRepro * (1 - T.season.gyneShare); c.stats.gynesRaised += newRepro * T.season.gyneShare;

            if (foraging && c.gynes > 0) { double m = c.gynes * T.season.matePerDay * dtDay; c.gynes -= m; c.mated += m * T.season.mateSuccess; }

            double late = frac > T.season.collapseFrom ? 1 + T.season.collapseMul * (frac - T.season.collapseFrom) / (1 - T.season.collapseFrom) : 1;
            double die = inside * T.colony.adultMortality / bio * late * dtDay;
            c.adults -= die; c.stats.died += die;
            c.males -= c.males * 0.2 * dtDay / bio;
            if (frac >= T.season.queenDiesAt) c.queenAlive = false;

            double use = Min(c.pulp, T.colony.buildPerDay * dtDay * (1 + inside / 40));
            c.pulp -= use; c.cells = Min(c.cells + use * T.colony.cellsPerPulp, c.maxCells != 0 ? c.maxCells : double.PositiveInfinity);

            if (c.queenAlive && c.protein > 0)
            {
                double free = Max(0, c.cells - BroodTotal(c));
                double lay = Min(free, Min(T.colony.layMax, T.colony.layBase + c.adults * T.colony.layPerAdult) * dtDay);
                double r = ReproShare(frac);
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

        public static bool Finished(ColonyState c, double physical)
        {
            bool brood = BroodTotal(c) >= 1;
            return (!c.nestAlive || !c.queenAlive) && !brood && c.adults - physical < 1 && c.gynes < 0.5;
        }
    }
}
