using Sting.Core;

namespace Sting.Core.Tests
{
    static partial class Program
    {
        static void ColonyParity()
        {
            var d = new Digest();
            void Dc(ColonyState c)
            {
                foreach (var v in new[] { c.adults, c.eggs, c.larvae, c.pupae, c.cells, c.protein, c.sugar, c.pulp, c.rEggs, c.rLarvae, c.rPupae, c.gynes, c.males, c.mated, c.deficit, c.fed, c.sugarlessDays, c.water, c.cool, c.thirst }) d.F(v);
                d.F(c.queenAlive); d.F(c.nestAlive);
                var s = c.stats; foreach (var v in new[] { s.emerged, s.laid, s.starvedLarvae, s.died, s.gynesRaised, s.sugarSpilled, s.proteinSpilled, s.cooked }) d.F(v);
            }
            for (int variant = 0; variant < 5; variant++)
            {
                var c = Colony.New(variant == 1);
                if (variant == 1) { c.pulp = 3; c.protein = 2; c.sugar = 4; c.adults = 1; }
                if (variant == 2) c.maxCells = 1800;
                for (int i = 0; i < 24000; i++)
                {
                    c.alloc = (i / 3000) % 4;
                    if (variant == 3 && i == 9000) { c.protein = 0; c.sugar = 0; }
                    if (variant == 2 && i % 500 == 0) c.pulp += 20;
                    Num frac = System.Math.Min(1, 0.3 + i / 24000.0 * 0.75);
                    // variant 4: a nest that runs hot every afternoon, past the lethal heat at its peak (T2-1)
                    (Num, Num)? hot = variant == 4 ? (R.Max(0, R.DSin((Num)(i % 1440) / 1440 * 6.283185307179586)), (i % 1440) > 300 && (i % 1440) < 420 ? (Num)0.6 : 0) : ((Num, Num)?)null;
                    Colony.Step(c, 1.0 / 120, i % 7, (i % 1440) < 900, frac, variant == 0 ? 0.2 : 1, 1, null, hot);
                    if (i % 200 == 0) { Dc(c); d.F(Colony.SugarCap(c)); d.F(Colony.ProteinCap(c)); d.F(Colony.WaterCap(c)); d.F(Colony.Finished(c, i % 3)); d.S(Colony.SeasonPhase(frac)); }
                }
                Colony.DestroyNest(c); Dc(c);
            }
            Out("colony", d.Hex);
        }
    }
}
