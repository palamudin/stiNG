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
        /// a line's rank in a skill, without making the line if it has none
        public int Rank(string id, string sp) { if (sp == null || sp == species) return Rank(id); return progs.TryGetValue(sp, out var p) ? p.ranks[Skills.Index(id)] : 0; }
        /// a new line takes the experience of the queen that founds it: the line she came from, as it stands (GDD 6.8)
        internal void ForkLine(string from, string to) { if (!progs.ContainsKey(to)) progs[to] = LPW(from).Copy(); }
        /// an insect of the player's line has a skill once the line learned it ("all": every unlock from the start)
        public bool HasSkill(Wasp w, string id)
        {
            if (w != null && w.colony != "own") return false;
            return (settings.skills == "all" && Skills.IsUnlock(id)) || Rank(id) > 0;
        }
        /// a job skill's multiplier for this insect: its own ranks, plus its role's level if the role uses that skill (GDD 6.8)
        public Num Mul(WaspBase wb, string id) => wb is Wasp w && w.colony == "own" ? 1 + T.skills.Of(id) * (OwnRank(w, id) + RoleRank(w, id)) : 1;
        int OwnRank(Wasp w, string id) => w.pers != null ? w.pers.ranks[Skills.Index(id)] : 0;
        public int RoleLevel(string role) => prog.roles[Skills.Role(role)];
        int RoleRank(Wasp w, string id) => Skills.RoleUses(w.role, id) ? RoleLevel(w.role) : 0;
        /// a guard's weight in a fight from its role's level, on top of its species'
        internal Num FightBonus(Wasp w) => Spw(w).fight + (w.colony == "own" && w.role == "guard" ? T.roles.fight * RoleLevel("guard") : 0);
        internal Pers PersOf(Wasp w) => w.pers ??= new Pers();
        /// it dies: one that mastered its job leaves its role a level better for every worker of it
        internal void Legacy(int id, Pers pers)
        {
            if (pers == null || !pers.mastered) return;
            int ri = 0;
            for (int i = 1; i < Skills.ROLES.Length; i++) if (pers.by[i] > pers.by[ri]) ri = i;
            var P = prog;
            if (P.roles[ri] >= T.roles.max) return;
            P.roles[ri]++;
            Emit("legacy", ("id", id), ("role", Skills.ROLES[ri]), ("level", P.roles[ri]));
        }
        internal void PersXp(Wasp w, Num v, string r)
        {
            int ri = r != null ? Skills.Role(r) : -1; var p = PersOf(w);
            p.xp += v;
            if (ri >= 0) { p.by[ri] += v; w.role = r; }
            Num sum = 0; foreach (var b in p.by) sum += b;
            if (!p.mastered && sum >= T.roles.mastery) { p.mastered = true; Emit("mastered", ("id", w.id), ("role", Skills.ROLES[ri >= 0 ? ri : 0])); }
        }
        /// the hive skills' multipliers for the player's colony
        public Boost BoostNow() => new Boost { forage = 1 + T.skills.forage * Rank("forage"), brood = 1 + T.skills.brood * Rank("brood"), lay = 1 + T.skills.lay * Rank("lay"), build = 1 + T.skills.build * Rank("build") };
        /// a line's hive skills on the AI: its own tree, but never past the line in hand (GDD 6.8, the level cap)
        Boost CapBoost(string sp)
        {
            int R(string id) => System.Math.Min(Rank(id, sp), Rank(id));
            return new Boost { forage = 1 + T.skills.forage * R("forage"), brood = 1 + T.skills.brood * R("brood"), lay = 1 + T.skills.lay * R("lay"), build = 1 + T.skills.build * R("build") };
        }
        /// hand: earned by the player's own play (the gauge counts only that)
        void Gain(bool unit, Num v, bool hand = true, string sp = null) { var P = LPW(sp ?? species); if (unit) { P.unit += v; P.unitTotal += v; } else { P.hive += v; P.hiveTotal += v; } if (hand) player.hand += v; }
        /// unit XP for what the insect the player flies does: the line's, and its own, in the role the work belongs to;
        /// doing that work makes it a worker of that role (role: a load's kind, for a deposit)
        internal void Xp(Wasp w, string k, string role = null)
        {
            if (w.id != drivenId || w.colony != "own") return;
            Num v = T.xp.Of(k);
            Gain(true, v);
            PersXp(w, v, role ?? Skills.XpRole(k));
        }
        internal static Num HiveScore(ColonyState c) { var s = c.stats; return s.emerged * T.xp.emerged + (s.depSugar + s.depProtein + s.depPulp + s.depWater) * T.xp.load + s.gynesRaised * T.xp.raised; }
        /// hive XP: what the colony did since the last colony tick
        void HiveXp(ColonyState c) => HiveXp(c, 1, true);
        void HiveXp(ColonyState c, Num k, bool hand)
        {
            Num v = HiveScore(c);
            if (v > c.xpSeen) Gain(false, (v - c.xpSeen) * k, hand, c.species ?? "wasp"); // to the line the colony is of
            c.xpSeen = v;
        }
        /// the player gauge (GDD 6.8): the XP the player earns in hand per in-game day, smoothed; idling lets it fall
        internal void GaugeTick(Num dt)
        {
            var P = player; Num d = P.hand - P.handSeen;
            P.handSeen = P.hand;
            P.gaugeRate += (d / dt - P.gaugeRate) * Min(1, dt / T.gauge.window);
            P.gaugeDays += dt;
        }
        public Num Gauge() => player.gaugeDays < T.gauge.minDays ? T.gauge.floor : Clamp(player.gaugeRate / T.gauge.@ref, T.gauge.floor, 1);
        /// how a colony on the AI works: the hive skills scaled by the gauge, and foraging from effMin to full
        public Boost LineBoost() => LineBoost(species);
        public Boost LineBoost(string sp)
        {
            Num g = Gauge(), e = T.gauge.effMin + (1 - T.gauge.effMin) * g; var B = CapBoost(sp);
            return new Boost { forage = e * (1 + (B.forage - 1) * g), brood = 1 + (B.brood - 1) * g, lay = 1 + (B.lay - 1) * g, build = 1 + (B.build - 1) * g };
        }
        /// take another colony of the line in hand (GDD 6.8, multi-colony play): yours goes on under the AI at your gauge
        /// the same relay rules as taking a far worker (Q-03): a colony whose nest is within 30 m of your insect is taken at
        /// once; a farther one after the relay delay. Asking again for the one on its way, or Q, cancels it.
        void SwitchColony(int id)
        {
            LineColony sc = null; foreach (var x in line) if (x.id == id) { sc = x; break; }
            if (sc == null || winter != null || extinct || !colony.sited || !colony.nestAlive || !sc.colony.nestAlive) { Emit("switchDenied", ("id", id)); return; }
            var ps = pendingSwitch;
            if (ps != null) { pendingSwitch = null; Emit("switchCancelled"); if (ps.colony == id) return; }
            var d = Driven();
            if (d != null && Sq(d.x - sc.nest.x) + Sq(d.y - sc.nest.y) + Sq(d.z - sc.nest.z) <= T.possess.freeRange * T.possess.freeRange) { TakeColony(sc); return; }
            pendingSwitch = new PendingSwitch { at = tick + T.possess.relayTicks, target = 0, colony = id };
            Emit("switchPending", ("seconds", (Num)T.possess.relayTicks / 60), ("toNest", false), ("colony", id), ("species", sc.colony.species ?? "wasp"));
        }
        void TakeColony(LineColony sc)
        {
            foreach (var w in new List<Wasp>(wasps)) if (w.colony == "own" || w.colony == "line:" + sc.id) Despawn(w);
            line.Remove(sc);
            line.Add(new LineColony { id = ++lineSeq, nest = nest, colony = colony, season = season.n });
            nest = sc.nest; colony = sc.colony;
            species = colony.species ?? "wasp"; settings.species = species;
            ext = new Ext();
            hiberPick = null; homeScent = null; ghost = null;
            var dw = SpawnWasp(true);
            drivenId = dw.id;
            UpdateChunks(true);
            Emit("colonySwitch", ("id", lineSeq), ("to", sc.id), ("species", species));
        }
        void Learn(int i)
        {
            if (i >= 0 && i < Skills.ALL.Length && Skills.IsRanked(Skills.ALL[i]))
            { // a job skill: the insect in hand learns it with its own XP
                var w = Driven(); string jid = Skills.ALL[i];
                var p = w != null && w.colony == "own" ? PersOf(w) : null; var jc = p != null ? Skills.Cost(i, p.ranks) : null;
                if (jc == null || p.xp < jc.Value.cost) { Emit("learnDenied", ("id", jid)); return; }
                p.xp -= jc.Value.cost; p.ranks[i]++;
                Emit("learned", ("id", jid), ("rank", p.ranks[i]), ("pool", jc.Value.pool), ("cost", jc.Value.cost), ("wasp", w.id));
                return;
            }
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
        /// a colony in a house that has grown too big is found by the people living there; once found, they know where it is
        bool Crowded(ColonyState c)
        {
            if (!c.house || !c.nestAlive) return false;
            if (c.adults >= T.warm.houseNotice) c.found = true;
            return c.found;
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
