// --- file: ColonyEconomy.cs
namespace Sting.Core
{
    public struct ColonyState
    {
        public Fix64 Protein, Sugar, Pulp;
        public int Adults, Larvae, Eggs, Pupae;
        public int CellsTotal, CellsFree;
        public bool QueenAlive;
        public Fix64 SugarDeficit;   // 0..1, drives AI attraction to human food (6.3)
    }

    public struct EconomyTuning
    {
        public Fix64 AdultSugarPerSec;        // upkeep per adult
        public Fix64 LarvaProteinPerSec;      // need per larva
        public Fix64 LarvaSecretionPerSec;    // sugar returned per fed larva
        public Fix64 DeficitSmoothing;        // 0..1 per step
    }

    public static class ColonyEconomy
    {
        public static void Step(ref ColonyState c, in EconomyTuning t)
        {
            // Larvae are fed protein first; fed larvae return secretion.
            Fix64 proteinNeed = t.LarvaProteinPerSec * Fix64.FromInt(c.Larvae);
            Fix64 proteinFed = Fix64.Min(proteinNeed, c.Protein);
            c.Protein -= proteinFed;

            Fix64 fedFraction = proteinNeed > Fix64.Zero ? proteinFed / proteinNeed : Fix64.Zero;
            Fix64 secretion = t.LarvaSecretionPerSec * Fix64.FromInt(c.Larvae) * fedFraction;

            // Adults burn sugar; secretion covers part of it.
            Fix64 sugarNeed = t.AdultSugarPerSec * Fix64.FromInt(c.Adults);
            Fix64 fromStore = Fix64.Max(Fix64.Zero, sugarNeed - secretion);
            Fix64 paid = Fix64.Min(fromStore, c.Sugar);
            c.Sugar -= paid;

            // Deficit = share of adult need not met by secretion, smoothed.
            Fix64 rawDeficit = sugarNeed > Fix64.Zero
                ? Fix64.Clamp01((sugarNeed - secretion) / sugarNeed)
                : Fix64.Zero;
            c.SugarDeficit += (rawDeficit - c.SugarDeficit) * t.DeficitSmoothing;

            // Starvation, brood stage advance and egg laying are separate steps, omitted here.
        }
    }
}
