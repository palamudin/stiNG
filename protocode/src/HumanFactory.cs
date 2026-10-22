// --- file: HumanFactory.cs
namespace Sting.Core
{
    public static class HumanFactory
    {
        public static HumanTraits Traits(ulong seed, ulong humanId)
        {
            ulong H(ulong i) => Rng.Hash(seed, RngDomain.HumanTraits, humanId, i);
            var h = new HumanTraits
            {
                Id = humanId,
                HeightM = Rng.Range(H(0), Fix64.FromRatio(150, 100), Fix64.FromRatio(195, 100)),
                ArmRatio = Rng.Range(H(1), Fix64.FromRatio(92, 100), Fix64.FromRatio(108, 100)),
                Flexibility = Rng.Unit(H(2)),
                Girth = Rng.Unit(H(3)),
                AgeStiffness = Rng.Unit(H(4)),
                ReactionTicks = Rng.RangeInt(H(5), 11, 43),
                Style = (SwatStyle)Rng.RangeInt(H(6), 0, 5),
                Accuracy = Rng.Unit(H(7)),
                PanicSusceptibility = Rng.Unit(H(8)),
                Sociability = Rng.Unit(H(9)),
                Escalation = Rng.Unit(H(10)),
            };
            return h;
        }
    }
}
