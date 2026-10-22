// --- file: Reach.cs
namespace Sting.Core
{
    public enum Zone : byte
    {
        Scalp, Face, Ears, NeckFront, NeckBack, Shoulders, UpperBack, Acnestis, LowerBack,
        Chest, Belly, Groin, Buttocks, UpperArms, Forearms, Shins, Thighs, Count
    }

    public enum ResponsePolicy : byte { Slap, BrushOrShake, Brush, Contort, CoverSwipe, SlapOppositeHand }

    public struct ZoneDef
    {
        public Fix64 BaseReach;
        public Fix64 BackSensitivity;       // how much flexibility/age matter
        public Fix64 GirthSensitivity;
        public Fix64 StiffnessSensitivity;
        public Fix64 Sensitivity;           // pain multiplier
        public ResponsePolicy Policy;
        public bool HelperMaySwat;
        public int ExtraDelayTicks;
    }

    public struct HumanTraits
    {
        public ulong Id;
        public Fix64 HeightM, ArmRatio, Flexibility, Girth, AgeStiffness;
        public int ReactionTicks;           // 11..42
        public SwatStyle Style;
        public Fix64 Accuracy, PanicSusceptibility, Sociability, Escalation;
    }

    public enum SwatStyle : byte { Precise, Flailer, Brusher, Freezer, Runner }

    public struct ReachTuning
    {
        public Fix64 ArmCoef, FlexCoef, GirthCoef, AgeCoef, MinReachToSwat;
    }

    public static class Reach
    {
        public static Fix64 SelfReach(in ZoneDef z, in HumanTraits h, Fix64 clothingStiffness, in ReachTuning t)
        {
            Fix64 r = z.BaseReach
                + t.ArmCoef * (h.ArmRatio - Fix64.One)
                + t.FlexCoef * (h.Flexibility - Fix64.Half) * z.BackSensitivity
                - t.GirthCoef * h.Girth * z.GirthSensitivity
                - clothingStiffness * z.StiffnessSensitivity
                - t.AgeCoef * h.AgeStiffness * z.BackSensitivity;
            return Fix64.Clamp01(r);
        }
    }
}
