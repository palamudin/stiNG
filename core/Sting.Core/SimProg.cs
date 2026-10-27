// Progression (GDD 6.8): XP, skills learned with it, the year's turn. Port of the progression part of sim.js.
using System.Collections.Generic;
using static Sting.Core.R;
using static Sting.Core.World;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed partial class Sim
    {
        public int Rank(string id) => prog.ranks[Skills.Index(id)];
        /// an insect of the player's line has a skill once the line learned it ("all": every unlock from the start)
        public bool HasSkill(Wasp w, string id)
        {
            if (w != null && w.colony != "own") return false;
            return (settings.skills == "all" && Skills.IsUnlock(id)) || Rank(id) > 0;
        }
        /// a ranked skill's multiplier for this insect (1 exactly when unlearned)
        public Num Mul(WaspBase wb, string id) => wb is Wasp w && w.colony == "own" ? 1 + T.skills.Of(id) * Rank(id) : 1;
        /// the hive skills' multipliers for the player's colony
        public Boost BoostNow() => new Boost { forage = 1 + T.skills.forage * Rank("forage"), brood = 1 + T.skills.brood * Rank("brood"), lay = 1 + T.skills.lay * Rank("lay"), build = 1 + T.skills.build * Rank("build") };
        void Gain(bool unit, Num v) { if (unit) { prog.unit += v; prog.unitTotal += v; } else { prog.hive += v; prog.hiveTotal += v; } }
        /// unit XP for what the insect the player flies does
        void Xp(Wasp w, string k) { if (w.id == drivenId && w.colony == "own") Gain(true, T.xp.Of(k)); }
        internal static Num HiveScore(ColonyState c) { var s = c.stats; return s.emerged * T.xp.emerged + (s.depSugar + s.depProtein + s.depPulp + s.depWater) * T.xp.load + s.gynesRaised * T.xp.raised; }
        /// hive XP: what the colony did since the last colony tick
        void HiveXp(ColonyState c)
        {
            Num v = HiveScore(c);
            if (v > c.xpSeen) Gain(false, v - c.xpSeen);
            c.xpSeen = v;
        }
        void Learn(int i)
        {
            string id = i >= 0 && i < Skills.ALL.Length ? Skills.ALL[i] : null; var c = Skills.Cost(i, prog.ranks);
            if (c == null || (settings.skills == "all" && Skills.IsUnlock(id)) || (c.Value.pool == "unit" ? prog.unit : prog.hive) < c.Value.cost) { Emit("learnDenied", ("id", id)); return; }
            if (c.Value.pool == "unit") prog.unit -= c.Value.cost; else prog.hive -= c.Value.cost;
            prog.ranks[i]++;
            Emit("learned", ("id", id), ("rank", prog.ranks[i]), ("pool", c.Value.pool), ("cost", c.Value.cost));
        }
        /// the year's turn: a wasp line strong enough may wake as hornets; one that is not is offered honeybees
        internal string Offer()
        {
            Num xp = prog.unitTotal + prog.hiveTotal; string pg = settings.progression ?? "open";
            if (species != "wasp" || pg.StartsWith("fixed:", System.StringComparison.Ordinal)) return null;
            if (xp >= T.xp.hornetXp && prog.stabs >= T.xp.hornetStabs) return "hornet";
            if (xp < T.xp.beeXp && prog.stabs < T.xp.beeStabs) return "bee";
            return null;
        }
        /// quick release: an insect of the line stinging a person pulls out and away when a hand is about to land on it
        void QuickRelease()
        {
            if (swats.Count == 0) return;
            foreach (var w in new List<Wasp>(wasps))
            {
                if (w.state != "attached" || !HasSkill(w, "release")) continue;
                foreach (var s in swats)
                {
                    if (s.underOnly != 0 || tick >= s.start || s.start - tick > T.skills.releaseLead) continue;
                    var hm = HumanByHex(s.frameHex);
                    if (hm == null) continue;
                    var c = Body.ToWorld(hm.F, s.center); Num r = s.radius + T.wasp.radius + Spw(w).swatR + T.skills.releaseMargin;
                    if (D2(w, c) > r * r) continue;
                    Detach(w, "released");
                    Num dx = w.x - c.x, dy = w.y - c.y, dz = w.z - c.z, d = Sqrt(dx * dx + dy * dy + dz * dz); if (d == 0) d = 1;
                    w.vx += dx / d * T.skills.releaseKick; w.vy += dy / d * T.skills.releaseKick + 0.3; w.vz += dz / d * T.skills.releaseKick;
                    w.noLandUntil = tick + T.land.afterTakeoff;
                    Xp(w, "release");
                    Emit("quickRelease", ("id", w.id), ("driven", w.id == drivenId));
                    break;
                }
            }
        }
    }
}
