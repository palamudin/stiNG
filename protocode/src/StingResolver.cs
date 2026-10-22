// --- file: StingResolver.cs
namespace Sting.Core
{
    public enum StingMode : byte { Jab, Full }

    public struct StingEvent
    {
        public long ContactTick;
        public ulong WaspId, HumanId;
        public Zone Zone;
        public Vec3F ContactPointBody;   // in the human's body frame
        public StingMode Mode;
    }

    public enum SwatKind : byte { Slap, Brush, Cover, Contort }

    public struct SwatAttempt
    {
        public ulong ActorId;            // the stung human or a helper
        public SwatKind Kind;
        public long StartTick;
        public int WindowTicks;
        public Vec3F CenterBody;         // in the stung human's body frame
        public Fix64 Radius;
        public bool Kills;               // false = stun
    }

    public struct Companion { public ulong Id; public Fix64 DistanceM; public int ReactionTicks; public SwatStyle Style; }

    public struct HumanContext
    {
        public Fix64 ClothingStiffness;
        public Fix64 Panic;
        public Companion[] Companions;   // sorted by Id ascending (R-06); may be null
    }

    public struct ReactionPlan
    {
        public const int MaxSwats = 3;
        public SwatAttempt Swat0, Swat1, Swat2;
        public int SwatCount;
        public Fix64 PanicGain;
        public bool Flee;

        public void Add(in SwatAttempt s)
        {
            if (SwatCount == 0) Swat0 = s;
            else if (SwatCount == 1) Swat1 = s;
            else if (SwatCount == 2) Swat2 = s;
            else return;
            SwatCount++;
        }
    }

    public struct ResolveTuning
    {
        public ReachTuning Reach;
        public Fix64 JabPain, FullPain;
        public Fix64 PreciseRadius, FlailerRadius, BrushRadius, CoverRadius, ContortRadius;
        public int ContortExtraTicks, HelperNoticeTicks, MinConsequenceTicks;
        public Fix64 HelperRangeM, HelperReach, FleePanic;
    }

    public static class StingResolver
    {
        /// Pure function (8.6). Same inputs -> same plan on every machine.
        public static ReactionPlan Resolve(in StingEvent e, in HumanTraits h, in ZoneDef z,
                                           in HumanContext ctx, in ResolveTuning t)
        {
            var plan = new ReactionPlan();

            Fix64 pain = (e.Mode == StingMode.Full ? t.FullPain : t.JabPain) * z.Sensitivity;
            plan.PanicGain = pain * h.PanicSusceptibility;
            plan.Flee = ctx.Panic + plan.PanicGain >= t.FleePanic || h.Style == SwatStyle.Runner;

            if (h.Style != SwatStyle.Freezer)
            {
                Fix64 reach = Reach.SelfReach(z, h, ctx.ClothingStiffness, t.Reach);
                SwatKind kind = KindFor(z.Policy, reach, t.Reach.MinReachToSwat);
                int delay = h.ReactionTicks + z.ExtraDelayTicks + (kind == SwatKind.Contort ? t.ContortExtraTicks : 0);
                if (delay < t.MinConsequenceTicks) delay = t.MinConsequenceTicks;   // 11.5 invariant

                plan.Add(new SwatAttempt
                {
                    ActorId = h.Id,
                    Kind = kind,
                    StartTick = e.ContactTick + delay,
                    WindowTicks = WindowFor(kind),
                    CenterBody = e.ContactPointBody,
                    Radius = RadiusFor(kind, h.Style, h.Accuracy, reach, t),
                    Kills = kind == SwatKind.Slap || kind == SwatKind.Cover,
                });
            }

            // Companions help where the zone allows it. They react to the human's reaction.
            if (z.HelperMaySwat && ctx.Companions != null)
            {
                for (int i = 0; i < ctx.Companions.Length && plan.SwatCount < ReactionPlan.MaxSwats; i++)
                {
                    var c = ctx.Companions[i];
                    if (c.DistanceM > t.HelperRangeM || c.Style == SwatStyle.Freezer) continue;
                    plan.Add(new SwatAttempt
                    {
                        ActorId = c.Id,
                        Kind = SwatKind.Slap,
                        StartTick = e.ContactTick + h.ReactionTicks + t.HelperNoticeTicks + c.ReactionTicks,
                        WindowTicks = WindowFor(SwatKind.Slap),
                        CenterBody = e.ContactPointBody,
                        Radius = c.Style == SwatStyle.Precise ? t.PreciseRadius : t.FlailerRadius,
                        Kills = true,
                    });
                }
            }
            return plan;
        }

        static SwatKind KindFor(ResponsePolicy p, Fix64 reach, Fix64 minReach)
        {
            if (reach < minReach) return SwatKind.Contort;
            switch (p)
            {
                case ResponsePolicy.BrushOrShake:
                case ResponsePolicy.Brush: return SwatKind.Brush;
                case ResponsePolicy.CoverSwipe: return SwatKind.Cover;
                case ResponsePolicy.Contort: return SwatKind.Contort;
                default: return SwatKind.Slap;
            }
        }

        static int WindowFor(SwatKind k)
        {
            switch (k)
            {
                case SwatKind.Slap: return 4;
                case SwatKind.Brush: return 6;
                case SwatKind.Cover: return 8;
                default: return 10;
            }
        }

        static Fix64 RadiusFor(SwatKind k, SwatStyle s, Fix64 accuracy, Fix64 reach, in ResolveTuning t)
        {
            switch (k)
            {
                case SwatKind.Brush: return t.BrushRadius;
                case SwatKind.Cover: return t.CoverRadius;
                case SwatKind.Contort: return t.ContortRadius;
            }
            // Slap: interpolate precise..flailer by accuracy; poor reach widens it.
            Fix64 baseR = s == SwatStyle.Precise ? t.PreciseRadius : t.FlailerRadius;
            Fix64 accuracyScale = Fix64.One + (Fix64.One - accuracy) * Fix64.Half;
            Fix64 reachScale = Fix64.One + (Fix64.One - reach) * Fix64.Half;
            return baseR * accuracyScale * reachScale;
        }
    }
}
