// Humans as bodies: traits, clothing, capsule parts, zones, reach, sting resolution and the space under clothing
// (GDD 8.1-8.8, A.5-A.7, A.10). Port of poc/sim/body.js.
using System.Collections.Generic;
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public static class Zone
    {
        public const int Scalp = 0, Face = 1, Ears = 2, NeckFront = 3, NeckBack = 4, Shoulders = 5, UpperBack = 6, Acnestis = 7,
            LowerBack = 8, Chest = 9, Belly = 10, Groin = 11, Buttocks = 12, UpperArms = 13, Forearms = 14, Shins = 15, Thighs = 16;
        public static readonly string[] Name = { "Scalp", "Face", "Ears", "NeckFront", "NeckBack", "Shoulders", "UpperBack", "Acnestis", "LowerBack", "Chest", "Belly", "Groin", "Buttocks", "UpperArms", "Forearms", "Shins", "Thighs" };
    }
    public static class Policy { public const int Slap = 0, BrushOrShake = 1, Brush = 2, Contort = 3, CoverSwipe = 4, SlapOppositeHand = 5; }
    public static class SwatKind { public const int Slap = 0, Brush = 1, Cover = 2, Contort = 3, Compress = 4, Spray = 5; }
    public static class Style { public const int Precise = 0, Flailer = 1, Brusher = 2, Freezer = 3, Runner = 4; }
    public static class Top { public const int TShirt = 0, Tank = 1, Jacket = 2, Suit = 3; }
    public static class Bottom { public const int Jeans = 0, Shorts = 1, Skirt = 2, Suit = 3; }

    public sealed class ZoneDef { public double @base, back, girth, stiff, sens, extra; public int policy; public bool helper; }

    public sealed class Traits
    {
        public ulong id;
        public double height, armRatio, flexibility, girth, ageStiffness, reactionTicks, style, accuracy, panicSusceptibility, sociability, escalation;
        public Traits Clone() => (Traits)MemberwiseClone();
    }
    public sealed class Clothing { public int top, bottom; public double stiffness; public bool topOff, collarTaped; public Clothing Clone() => (Clothing)MemberwiseClone(); }
    public sealed class Part { public string name; public V3 a, b; public double r, side; }
    public struct SegQ { public double t, x, y, z; }
    /// A body frame: position and facing on the ground plane
    public struct Frame { public double x, z, fx, fz; public Frame(double x, double z, double fx, double fz) { this.x = x; this.z = z; this.fx = fx; this.fz = fz; } }

    public sealed class Swat
    {
        public ulong actorId; public string actorHex, frameHex, stungHex; public int kind; public double start, window, radius, reach, contactTick;
        public V3 center; public bool kills, pre; public List<int> hits = new List<int>(); public int underOnly, byWasp, targetId; public string why;
        public Swat Clone() { var s = (Swat)MemberwiseClone(); s.hits = new List<int>(hits); return s; }
    }
    public sealed class Plan { public List<Swat> swats = new List<Swat>(); public double panicGain; public bool flee; }
    public sealed class StingIn { public double contactTick; public string mode = "jab"; public bool under; public V3 contactPointBody; }
    public sealed class Companion { public ulong id; public string hex; public double distance, reactionTicks; public double style; }
    public sealed class StingCtx { public double clothingStiffness, panic, stung, panicMul; public List<Companion> companions; }
    public sealed class GNode { public string key; public int zone; public bool opening; public V3 n, pos; public List<int> links = new List<int>(); }

    public static class Body
    {
        static ZoneDef Z(double @base, double back, double girth, double stiff, double sens, int policy, bool helper, double extra = 0) =>
            new ZoneDef { @base = @base, back = back, girth = girth, stiff = stiff, sens = sens, policy = policy, helper = helper, extra = extra };
        public static readonly ZoneDef[] ZONES = {
            Z(0.90, 0.2, 0.0, 0.3, 0.9, Policy.Slap, true),
            Z(1.00, 0.0, 0.0, 0.0, 1.6, Policy.BrushOrShake, false),
            Z(0.95, 0.1, 0.0, 0.2, 1.2, Policy.Brush, true),
            Z(0.95, 0.1, 0.2, 0.3, 1.2, Policy.Slap, true),
            Z(0.85, 0.5, 0.3, 0.6, 1.1, Policy.Slap, true),
            Z(0.85, 0.5, 0.4, 0.8, 0.9, Policy.Slap, true),
            Z(0.35, 1.0, 1.0, 1.0, 1.0, Policy.Contort, true),
            Z(0.10, 1.0, 1.0, 1.0, 1.0, Policy.Contort, true),
            Z(0.55, 1.0, 1.0, 1.0, 1.0, Policy.Slap, true),
            Z(0.95, 0.1, 0.3, 0.3, 1.3, Policy.CoverSwipe, false),
            Z(0.95, 0.1, 0.5, 0.3, 1.0, Policy.Slap, true),
            Z(0.95, 0.1, 0.6, 0.2, 2.0, Policy.CoverSwipe, false),
            Z(0.70, 0.6, 0.6, 0.3, 1.0, Policy.Slap, false, 4),
            Z(0.85, 0.3, 0.3, 0.8, 0.9, Policy.SlapOppositeHand, true),
            Z(0.95, 0.1, 0.1, 0.5, 0.8, Policy.SlapOppositeHand, true),
            Z(0.85, 0.5, 0.6, 0.2, 0.9, Policy.Slap, true, 6),
            Z(0.95, 0.3, 0.5, 0.2, 0.9, Policy.Slap, true),
        };

        public static double SelfReach(ZoneDef z, Traits h, double clothingStiffness)
        {
            double r = z.@base
                + T.reach.arm * (h.armRatio - 1)
                + T.reach.flex * (h.flexibility - 0.5) * z.back
                - T.reach.girth * h.girth * z.girth
                - clothingStiffness * z.stiff
                - T.reach.age * h.ageStiffness * z.back;
            return Clamp01(r);
        }

        public static Traits HumanTraits(ulong seed, ulong id)
        {
            ulong H(ulong i) => Hash(seed, Domain.HumanTraits, id, i);
            return new Traits
            {
                id = id, height = Range(H(0), 1.5, 1.95), armRatio = Range(H(1), 0.92, 1.08), flexibility = Unit(H(2)), girth = Unit(H(3)),
                ageStiffness = Unit(H(4)), reactionTicks = RangeInt(H(5), 11, 43), style = RangeInt(H(6), 0, 5), accuracy = Unit(H(7)),
                panicSusceptibility = Unit(H(8)), sociability = Unit(H(9)), escalation = Unit(H(10)),
            };
        }

        public static Clothing HumanClothing(ulong seed, ulong id, long day = 0)
        {
            int a = RangeInt(Hash(seed, Domain.Clothing, id, U64(day), 0), 0, 100);
            int b = RangeInt(Hash(seed, Domain.Clothing, id, U64(day), 1), 0, 100);
            int top = a < 15 ? Top.Jacket : a < 45 ? Top.Tank : Top.TShirt;
            int bottom = b < 40 ? Bottom.Jeans : b < 75 ? Bottom.Shorts : Bottom.Skirt;
            return new Clothing { top = top, bottom = bottom, stiffness = top == Top.Jacket ? 0.3 : 0 };
        }
        public static Clothing SuitClothing(bool taped) => new Clothing { top = Top.Suit, bottom = Bottom.Suit, stiffness = 0.35, collarTaped = taped };

        static readonly int[] TORSO = { Zone.Chest, Zone.Belly, Zone.UpperBack, Zone.Acnestis, Zone.LowerBack };
        static readonly int[] LOWER = { Zone.Groin, Zone.Buttocks, Zone.Thighs, Zone.Shins };
        public static bool IsLowerZone(int z) => System.Array.IndexOf(LOWER, z) >= 0;

        /// Cover: 0 bare, 1 thin, 2 thick
        public static int ZoneCover(Clothing c, int zone)
        {
            if (c.top == Top.Suit) return 2;
            int top = c.topOff ? -1 : c.top;
            if (System.Array.IndexOf(TORSO, zone) >= 0) return top < 0 ? 0 : top == Top.Jacket ? 2 : 1;
            if (zone == Zone.Shoulders || zone == Zone.UpperArms) return top == Top.Jacket ? 2 : top == Top.TShirt ? 1 : 0;
            if (zone == Zone.Forearms) return top == Top.Jacket ? 2 : 0;
            if (zone == Zone.Groin || zone == Zone.Buttocks) return c.bottom == Bottom.Jeans ? 2 : 1;
            if (zone == Zone.Thighs) return c.bottom == Bottom.Jeans ? 2 : 1;
            if (zone == Zone.Shins) return c.bottom == Bottom.Jeans ? 2 : 0;
            return 0;
        }

        static Part P(string name, double ax, double ay, double az, double bx, double by, double bz, double r, double side = 0) =>
            new Part { name = name, a = new V3(ax, ay, az), b = new V3(bx, by, bz), r = r, side = side };

        public static List<Part> BodyParts(Traits h, string posture)
        {
            double s = h.height / 1.75, g = h.girth, ar = h.armRatio;
            double tor = 0.14 + 0.08 * g, pel = 0.12 + 0.05 * g;
            double ax = tor + 0.065, lx = 0.085 + 0.025 * g;
            var L = new List<Part>();
            void Arm(string name, double sd, double[] a, double[] b, double r) =>
                L.Add(P(name, a[0] * sd, a[1], a[2], (a[0] + (b[0] - a[0]) * ar) * sd, a[1] + (b[1] - a[1]) * ar, a[2] + (b[2] - a[2]) * ar, r, sd));
            if (posture == "stand")
            {
                L.Add(P("Head", 0, 1.62, 0.01, 0, 1.62, 0.01, 0.105));
                L.Add(P("Neck", 0, 1.44, 0, 0, 1.53, 0, 0.055));
                L.Add(P("Shoulders", -(ax - 0.03), 1.385, -0.01, ax - 0.03, 1.385, -0.01, 0.062));
                L.Add(P("Torso", 0, 1.0, 0, 0, 1.29, 0, tor));
                L.Add(P("Pelvis", -0.07, 0.9, 0, 0.07, 0.9, 0, pel));
                foreach (double sd in new double[] { -1, 1 })
                {
                    string n = sd < 0 ? "L" : "R";
                    Arm("UpperArm" + n, sd, new[] { ax, 1.37, 0 }, new[] { ax + 0.03, 1.08, 0 }, 0.045);
                    var e = new[] { ax + 0.03 * ar, 1.37 - 0.29 * ar, 0 };
                    Arm("Forearm" + n, sd, e, new[] { e[0] + 0.02, e[1] - 0.26, 0.04 }, 0.04);
                    L.Add(P("Thigh" + n, lx * sd, 0.86, 0, (lx + 0.01) * sd, 0.48, 0.01, 0.075, sd));
                    L.Add(P("Shin" + n, (lx + 0.01) * sd, 0.48, 0.01, (lx + 0.01) * sd, 0.07, 0, 0.052, sd));
                }
            }
            else
            {
                L.Add(P("Head", 0, 1.22, 0.03, 0, 1.22, 0.03, 0.105));
                L.Add(P("Neck", 0, 1.04, 0.01, 0, 1.13, 0.01, 0.055));
                L.Add(P("Shoulders", -(ax - 0.03), 0.985, -0.01, ax - 0.03, 0.985, -0.01, 0.062));
                L.Add(P("Torso", 0, 0.6, 0, 0, 0.89, 0.01, tor));
                L.Add(P("Pelvis", -0.07, 0.5, 0, 0.07, 0.5, 0, pel));
                foreach (double sd in new double[] { -1, 1 })
                {
                    string n = sd < 0 ? "L" : "R";
                    Arm("UpperArm" + n, sd, new[] { ax, 0.97, 0 }, new[] { ax + 0.02, 0.74, 0.12 }, 0.045);
                    var e = new[] { ax + 0.02 * ar, 0.97 - 0.23 * ar, 0.12 * ar };
                    Arm("Forearm" + n, sd, e, new[] { e[0] - 0.08, e[1] + 0.03, e[2] + 0.28 }, 0.04);
                    L.Add(P("Thigh" + n, lx * sd, 0.48, 0.04, (lx + 0.01) * sd, 0.49, 0.44, 0.075, sd));
                    L.Add(P("Shin" + n, (lx + 0.01) * sd, 0.47, 0.44, (lx + 0.01) * sd, 0.06, 0.48, 0.052, sd));
                }
            }
            foreach (var p in L) { p.a.x *= s; p.a.y *= s; p.a.z *= s; p.b.x *= s; p.b.y *= s; p.b.z *= s; p.r *= s; }
            return L;
        }

        public static SegQ SegClosest(V3 a, V3 b, V3 p)
        {
            double abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
            double L2 = abx * abx + aby * aby + abz * abz;
            double t = L2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / L2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            return new SegQ { t = t, x = a.x + abx * t, y = a.y + aby * t, z = a.z + abz * t };
        }

        public static int Classify(Part part, SegQ q, V3 n, V3 p, double s)
        {
            switch (part.name)
            {
                case "Head":
                    if (n.z > 0.35 && n.y < 0.6) return Zone.Face;
                    if (Abs(n.x) > 0.7) return Zone.Ears;
                    return Zone.Scalp;
                case "Neck": return n.z >= 0 ? Zone.NeckFront : Zone.NeckBack;
                case "Shoulders": return Zone.Shoulders;
                case "Torso":
                    if (n.z > -0.15) return q.t > 0.55 ? Zone.Chest : Zone.Belly;
                    if (q.t > 0.42) return Abs(p.x) < 0.4 * part.r ? Zone.Acnestis : Zone.UpperBack;
                    return Zone.LowerBack;
                case "Pelvis":
                    if (n.z > 0.3 && Abs(p.x) < 0.08 * s) return Zone.Groin;
                    if (n.z < -0.2 || n.y < -0.6) return Zone.Buttocks;
                    return Zone.Thighs;
                default:
                    if (part.name.StartsWith("UpperArm", System.StringComparison.Ordinal)) return Zone.UpperArms;
                    if (part.name.StartsWith("Forearm", System.StringComparison.Ordinal)) return Zone.Forearms;
                    if (part.name.StartsWith("Thigh", System.StringComparison.Ordinal)) return Zone.Thighs;
                    return Zone.Shins;
            }
        }

        // Body frame: forward f = (fx, 0, fz), right r = (fz, 0, -fx), up = y.
        public static V3 ToWorld(Frame hm, V3 p) => new V3(hm.x + hm.fz * p.x + hm.fx * p.z, p.y, hm.z - hm.fx * p.x + hm.fz * p.z);
        public static V3 ToLocal(Frame hm, V3 w) { double dx = w.x - hm.x, dz = w.z - hm.z; return new V3(dx * hm.fz - dz * hm.fx, w.y, dx * hm.fx + dz * hm.fz); }
        public static V3 DirToWorld(Frame hm, V3 d) => new V3(hm.fz * d.x + hm.fx * d.z, d.y, -hm.fx * d.x + hm.fz * d.z);

        static int KindFor(int policy, double reach)
        {
            if (reach < T.reach.minReachToSwat) return SwatKind.Contort;
            switch (policy)
            {
                case Policy.BrushOrShake:
                case Policy.Brush: return SwatKind.Brush;
                case Policy.CoverSwipe: return SwatKind.Cover;
                case Policy.Contort: return SwatKind.Contort;
                default: return SwatKind.Slap;
            }
        }
        public static double WindowFor(int k) => k == SwatKind.Slap ? 4 : k == SwatKind.Brush ? 6 : k == SwatKind.Cover ? 8 : k == SwatKind.Compress ? 8 : 10;
        static double RadiusFor(int k, double style, double accuracy, double reach)
        {
            if (k == SwatKind.Brush) return T.resolve.brushRadius;
            if (k == SwatKind.Cover) return T.resolve.coverRadius;
            if (k == SwatKind.Contort) return T.resolve.contortRadius;
            double b = style == Style.Precise ? T.resolve.preciseRadius : T.resolve.flailerRadius;
            return b * (1 + (1 - accuracy) * 0.5) * (1 + (1 - reach) * 0.5);
        }

        public static int PredictedKind(int zone, Traits h, Clothing clothing)
        {
            if (ZoneCover(clothing, zone) == 2) return -1;
            if (h.style == Style.Freezer) return -2;
            return KindFor(ZONES[zone].policy, SelfReach(ZONES[zone], h, clothing.stiffness));
        }

        /// Pure function. Same inputs, same plan on every machine. e.under: the wasp is under clothing (compression).
        public static Plan ResolveSting(StingIn e, Traits h, ZoneDef z, StingCtx ctx)
        {
            var plan = new Plan();
            double n = Min(ctx.stung, T.memory.maxStings);
            double quick = Max(T.memory.minFactor, 1 - T.memory.fasterPerSting * n);
            double pain = e.mode == "touch" ? 0 : (e.mode == "full" ? T.resolve.fullPain : T.resolve.jabPain) * z.sens * (e.under ? T.under.panicMul : 1);
            plan.panicGain = pain * h.panicSusceptibility * (ctx.panicMul != 0 ? ctx.panicMul : 1) * (1 + T.memory.panicPerSting * n);
            plan.flee = e.mode != "touch" && !e.under && (ctx.panic + plan.panicGain >= T.resolve.fleePanic || h.style == Style.Runner);
            if (e.under)
            {
                double delay = Rnd(h.reactionTicks * quick);
                if (delay < T.resolve.minConsequenceTicks) delay = T.resolve.minConsequenceTicks;
                plan.swats.Add(new Swat { actorId = h.id, kind = SwatKind.Compress, start = e.contactTick + delay, window = WindowFor(SwatKind.Compress), center = e.contactPointBody, radius = T.under.compressRadius, kills = true, reach = 1 });
                return plan;
            }
            if (h.style != Style.Freezer)
            {
                double reach = SelfReach(z, h, ctx.clothingStiffness);
                int kind = KindFor(z.policy, reach);
                double delay = Rnd((h.reactionTicks + z.extra + (kind == SwatKind.Contort ? T.resolve.contortExtraTicks : 0)) * quick);
                if (delay < T.resolve.minConsequenceTicks) delay = T.resolve.minConsequenceTicks;
                plan.swats.Add(new Swat
                {
                    actorId = h.id, kind = kind, start = e.contactTick + delay, window = WindowFor(kind), center = e.contactPointBody,
                    radius = RadiusFor(kind, h.style, h.accuracy, reach), kills = kind == SwatKind.Slap || kind == SwatKind.Cover, reach = reach,
                });
            }
            if (z.helper && ctx.companions != null)
            {
                foreach (var c in ctx.companions)
                {
                    if (plan.swats.Count >= 3) break;
                    if (c.distance > T.resolve.helperRange || c.style == Style.Freezer) continue;
                    plan.swats.Add(new Swat
                    {
                        actorId = c.id, kind = SwatKind.Slap,
                        start = e.contactTick + Max(T.resolve.minConsequenceTicks, Rnd((h.reactionTicks + T.resolve.helperNoticeTicks + c.reactionTicks) * quick)),
                        window = WindowFor(SwatKind.Slap), center = e.contactPointBody, radius = c.style == Style.Precise ? T.resolve.preciseRadius : T.resolve.flailerRadius,
                        kills = true, reach = 1,
                    });
                }
            }
            return plan;
        }

        // ---------------------------------------------------------------- under clothing (GDD 8.8)
        static Part PartByName(List<Part> parts, string name) { foreach (var p in parts) if (p.name == name) return p; return null; }
        static V3 Norm(double x, double y, double z) { double m = Sqrt(x * x + y * y + z * z); return new V3(x / m, y / m, z / m); }

        public static List<GNode> GarmentGraph(Traits h, Clothing clothing, string posture, List<Part> parts)
        {
            var nodes = new List<GNode>();
            int Add(string key, string partName, double t, V3 n, int zone, bool opening)
            {
                var p = PartByName(parts, partName);
                double ax = p.a.x + (p.b.x - p.a.x) * t, ay = p.a.y + (p.b.y - p.a.y) * t, az = p.a.z + (p.b.z - p.a.z) * t;
                nodes.Add(new GNode { key = key, zone = zone, opening = opening, n = n, pos = new V3(ax + n.x * p.r, ay + n.y * p.r, az + n.z * p.r) });
                return nodes.Count - 1;
            }
            void Link(int a, int b) { if (a < 0 || b < 0) return; nodes[a].links.Add(b); nodes[b].links.Add(a); }
            bool sit = posture == "sit";
            int top = clothing.topOff ? -1 : clothing.top;
            if (top >= 0)
            {
                bool suit = top == Top.Suit;
                int collar = Add("collar", "Neck", 0.15, new V3(0, 0, -1), Zone.NeckBack, !suit || !clothing.collarTaped);
                int acn = Add("acnestis", "Torso", 0.8, new V3(0, 0, -1), Zone.Acnestis, false);
                int lb = Add("lower back", "Torso", 0.3, new V3(0, 0, -1), Zone.LowerBack, false);
                int hb = Add("back hem", "Torso", 0.02, new V3(0, 0, -1), Zone.LowerBack, !suit);
                int ch = Add("chest", "Torso", 0.78, new V3(0, 0, 1), Zone.Chest, false);
                int be = Add("belly", "Torso", 0.35, new V3(0, 0, 1), Zone.Belly, false);
                int hf = Add("front hem", "Torso", 0.02, new V3(0, 0, 1), Zone.Belly, !suit);
                Link(collar, acn); Link(collar, ch); Link(acn, lb); Link(lb, hb); Link(ch, be); Link(be, hf);
                foreach (double sd in new double[] { -1, 1 })
                {
                    string S = sd < 0 ? "L" : "R";
                    int ub = Add("upper back " + S, "Torso", 0.65, Norm(0.7 * sd, 0, -0.7), Zone.UpperBack, false);
                    Link(acn, ub);
                    if (top == Top.Tank)
                    {
                        int hole = Add("arm hole " + S, "Torso", 0.88, Norm(sd, 0, 0), Zone.UpperBack, true);
                        Link(hole, ub); Link(hole, ch);
                    }
                    else
                    {
                        int arm = Add("upper arm " + S, "UpperArm" + S, 0.45, new V3(sd, 0, 0), Zone.UpperArms, false);
                        Link(ub, arm);
                        if (top == Top.TShirt) Link(arm, Add("sleeve " + S, "UpperArm" + S, 0.95, new V3(sd, 0, 0), Zone.UpperArms, true));
                        else
                        {
                            int fa = Add("forearm " + S, "Forearm" + S, 0.5, new V3(sd, 0, 0), Zone.Forearms, false);
                            Link(arm, fa);
                            Link(fa, Add("cuff " + S, "Forearm" + S, 0.97, new V3(sd, 0, 0), Zone.Forearms, top == Top.Jacket));
                        }
                    }
                }
            }
            int bottom = clothing.bottom;
            V3 thighN = sit ? new V3(0, 1, 0) : new V3(0, 0, 1);
            int groin = Add("groin", "Pelvis", 0.5, new V3(0, 0, 1), Zone.Groin, false);
            foreach (double sd in new double[] { -1, 1 })
            {
                string S = sd < 0 ? "L" : "R";
                int butt = Add("buttock " + S, "Pelvis", sd < 0 ? 0.1 : 0.9, new V3(0, 0, -1), Zone.Buttocks, false);
                int thigh = Add("thigh " + S, "Thigh" + S, 0.45, thighN, Zone.Thighs, false);
                Link(thigh, groin); Link(thigh, butt);
                if (bottom == Bottom.Shorts) Link(thigh, Add("leg opening " + S, "Thigh" + S, 0.92, thighN, Zone.Thighs, true));
                else if (bottom == Bottom.Skirt) Link(thigh, Add("hem " + S, "Thigh" + S, 0.75, thighN, Zone.Thighs, true));
                else
                {
                    int knee = Add("knee " + S, "Thigh" + S, 0.95, thighN, Zone.Thighs, false);
                    int shin = Add("shin " + S, "Shin" + S, 0.5, new V3(0, 0, 1), Zone.Shins, false);
                    Link(thigh, knee); Link(knee, shin);
                    Link(shin, Add("cuff " + S, "Shin" + S, 0.95, new V3(0, 0, 1), Zone.Shins, bottom == Bottom.Jeans));
                }
            }
            return nodes;
        }
    }
}
