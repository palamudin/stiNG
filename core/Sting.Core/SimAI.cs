// AI brain: one decision per tick per AI wasp. Port of the AI part of sim.js.
using System.Collections.Generic;
using static Sting.Core.R;
using static Sting.Core.World;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed partial class Sim
    {
        void AiAttack(Wasp w, string humanHex)
        {
            w.ai.mode = "attack"; w.ai.humanHex = humanHex; w.ai.timer = tick + T.ai.attackTicks; w.ai.until = w.ai.timer; w.ai.stings = 2; w.ai.target = null;
            Emit("aiAttack", ("id", w.id), ("humanHex", humanHex));
        }

        /// A guard (T1-13) circles just outside the entrance. Another colony's wasp near it (a rival, or another
        /// player's) gets chased and grappled; the exterminator close to the nest gets stung.
        Cmd ThinkGuard(Wasp w, Cmd cmd) => ThinkGuard(w, cmd, nest);
        Cmd ThinkGuard(Wasp w, Cmd cmd, Nest n)
        {
            var ai = w.ai; var e = n.entrance;
            Num ox = e.x - n.x, oz = e.z - n.z, od = Sqrt(ox * ox + oz * oz);
            var post = od > 0.01 ? new V3(e.x + ox / od * 0.08, e.y, e.z + oz / od * 0.08) : new V3(e.x, e.y - 0.08, e.z);
            if (ai.mode == "hunt")
            {
                WaspBase t = (WaspBase)WaspById(ai.huntId) ?? remote.Get(ai.huntId);
                if (t == null || !GuardLive(t) || (t is Wasp tw && !IsRival(tw)) || tick > ai.timer || D2(t, post) > T.guard.chase * T.guard.chase) ai.mode = "guard";
                else { Steer(w, t.P, cmd); cmd.throttle = 1; cmd.burst = 1; return cmd; }
            }
            ai.mode = "guard";
            Num r2 = T.guard.radius * T.guard.radius;
            int tid = 0; bool found = false, player = false;
            foreach (var x in wasps) if (IsRival(x) && GuardLive(x) && D2(x, post) < r2) { tid = x.id; found = true; break; }
            if (!found) foreach (var kv in remote) if (GuardLive(kv.Value) && D2(kv.Value, post) < r2) { tid = kv.Key; found = true; player = !kv.Value.rival; break; }
            if (found) { ai.mode = "hunt"; ai.huntId = tid; ai.timer = tick + T.guard.huntTicks; Emit("guardHunt", ("id", w.id), ("target", tid), ("player", player)); return cmd; }
            var xh = n == nest ? ext.hm : null;
            if (xh != null && xh.state != "flee" && xh.state != "leave" && Sq(xh.x - e.x) + Sq(xh.z - e.z) < T.guard.humanRadius * T.guard.humanRadius) { AiAttack(w, xh.hex); return cmd; }
            Num a = (Num)tick / 40 + w.id;
            Steer(w, new V3(post.x + T.guard.ring * DCos(a), post.y + 0.03, post.z + T.guard.ring * DSin(a)), cmd);
            return cmd;
        }

        /// what a guard goes for: a wasp out and about, or one the line's bees are balling (T2-11)
        static bool GuardLive(WaspBase t) => Free3(t.state) || (t is Wasp x && x.state == "balled" && x.ball != null && x.ball.own);

        Cmd Think(Wasp w)
        {
            var ai = w.ai;
            var cmd = new Cmd { hasDir = true };
            if (w.state == "balled") { BallEscape(w, false); return cmd; }
            if (w.state != "fly") return cmd;
            if (w.colony != "own") return IsRival(w) ? ThinkRival(w, cmd) : ThinkSister(w, cmd);
            if (w.caste == "male") return ThinkMale(w, cmd); // T2-3
            if (w.caste == "gyne") return ThinkGyne(w, cmd);
            // alarm pheromone pulls nearby workers into an attack
            if (ai.mode != "attack" && ai.mode != "evade")
            {
                foreach (var a in alarms)
                {
                    var k = HumanByHex(a.killerHex);
                    if (D2(w, new V3(a.x, a.y, a.z)) < Sq(AlarmReach(w, a)) && k != null && k.state != "away") { AiAttack(w, a.killerHex); break; }
                }
            }
            bool daylight = ForageHours(Spw(w)); // hornets hunt after dark (T2-10)
            if ((!daylight || w.caste == "queen") && ai.mode != "home") { ai.mode = "home"; ai.target = null; }
            if (w.energy < 0.2 && ai.mode != "home" && ai.mode != "collect") { ai.mode = "return"; ai.target = null; }
            if (w.role == "guard" && (ai.mode == "guard" || ai.mode == "hunt" || ai.mode == "pick")) return ThinkGuard(w, cmd);
            switch (ai.mode)
            {
                case "pick": AiPick(w); break;
                case "search": Search(w, cmd, nest.entrance); break;
                case "outbound":
                {
                    var tp = AiTargetPos(w);
                    if (tp == null) { ai.mode = "pick"; break; }
                    Steer(w, tp.Value, cmd);
                    if (D2(w, tp.Value) < T.ai.arrive * T.ai.arrive) { ai.mode = "collect"; ai.timer = tick + T.ai.collectTicks; ai.from = ai.target; }
                    break;
                }
                case "collect":
                {
                    var tp = AiTargetPos(w);
                    if (tp == null) { ai.mode = w.carry != null || ai.cargo > 0.3 ? "return" : "pick"; break; }
                    Steer(w, tp.Value, cmd);
                    var t = ai.target;
                    if (t.kind == "prey")
                    {
                        var p = w.carry == null ? PreyNear(w) : null;
                        if (p != null) { Catch(w, p); ai.mode = "return"; ai.target = null; }
                        else if (w.carry != null) { ai.mode = "return"; ai.target = null; } // won it in a wrestle (T2-10)
                        else if (tick > ai.timer) ai.mode = "pick";
                    }
                    else if (t.kind == "hive")
                    {
                        if (w.carry == null && HiveLoadsLeft(t.key, t.i) > 0) { StartRob(w, t.key, t.i); return cmd; }
                        ai.mode = "return"; ai.target = null;
                    }
                    else if (t.kind == "pollen") // stay at the flower until the baskets are full (T2-11)
                    {
                        if (w.carry != null) { ai.mode = "return"; ai.target = null; } else if (tick > ai.timer + 300) ai.mode = "pick";
                    }
                    else if (t.kind == "wood")
                    {
                        if (tick > ai.timer) { bool got = TakePulp(w, new WoodSpot { key = t.key, i = t.i }); ai.mode = got ? "return" : "pick"; ai.target = null; }
                    }
                    else if (t.kind == "water") // drink a load at the surface, then home (T2-1)
                    {
                        if (tick > ai.timer - T.ai.collectTicks + T.water.fillTicks)
                        {
                            if (w.carry == null && WaterNear(w) != null) { w.carry = new Carry { kind = "water", amount = T.water.amount, what = "water" }; Emit("watered", ("id", w.id)); ai.mode = "return"; ai.target = null; }
                            else if (tick > ai.timer) { ai.mode = "pick"; ai.target = null; }
                        }
                    }
                    else if (ai.cargo >= 0.95 || tick > ai.timer + 300) { ai.mode = "return"; ai.target = null; }
                    break;
                }
                case "return":
                case "home":
                {
                    Steer(w, nest.entrance, cmd);
                    if (D2(w, nest.entrance) < 0.07 * 0.07)
                    {
                        if (ai.mode == "home" || (w.energy < 0.3 && colony.sugar <= 0)) { NestTouch(w); Despawn(w); return cmd; }
                        ai.mode = "pick";
                    }
                    break;
                }
                case "attack":
                {
                    var hm = HumanByHex(ai.humanHex);
                    if (hm == null || hm.state == "away" || tick > ai.timer || ai.stings <= 0) { ai.mode = "return"; break; }
                    if (ai.target == null || ai.target.hex != hm.hex || tick % 30 == 0) ai.target = AiStingPoint(w, hm);
                    if (ai.target == null) { ai.mode = "return"; break; }
                    var tp = Body.ToWorld(hm.F, ai.target.p);
                    Steer(w, tp, cmd);
                    if (D2(w, tp) < 0.08 * 0.08) cmd.sting = 1;
                    break;
                }
                case "evade":
                {
                    cmd.dirY = 0.6; cmd.dirX = DCos(w.id); cmd.dirZ = DSin(w.id); cmd.throttle = 1; cmd.burst = 1;
                    if (tick > ai.timer) { if (ai.stings > 0 && tick < ai.until) { ai.mode = "attack"; ai.timer = ai.until; } else ai.mode = "return"; }
                    break;
                }
            }
            return cmd;
        }

        // ---------------- senses (GDD 7.3, T1-16)

        /// How far a scent of the given strength from src reaches the wasp at p: further when p is downwind of it
        internal Num ScentRange(Num px, Num pz, V3 src, Num strength)
        {
            var wd = Wind;
            Num dx = px - src.x, dz = pz - src.z;
            Num d = Sqrt(dx * dx + dz * dz);
            Num mul = 1;
            if (d > 1e-6) mul = 1 + T.sense.downwind * Clamp((dx * wd.x + dz * wd.z) / d / T.sense.windRef, -1, 1);
            return T.sense.smell * strength * mul;
        }

        /// Every source of food in a chunk for a forager of this role, with its scent strength (0: moving prey, seen not
        /// smelled). Lidded or knocked-over cans have nothing to smell, and traps are only out from level 3. With policy,
        /// the AI's own choices apply (cans, traps and hives only when short of sugar); without, the list is what there
        /// is to smell, which the player's nose reads.
        internal void Sources(ChunkRec rec, int ri, string role, bool policy, System.Action<AiTarget, V3, Num> cb) => Sources(rec, ri, role, policy, cb, T.species.wasp);
        internal void Sources(ChunkRec rec, int ri, string role, bool policy, System.Action<AiTarget, V3, Num> cb, SpeciesRow kind)
        {
            var c = rec.content; string key = rec.key; var st = CS(key); int lvl = EscLevel(key); var col = colony;
            // a bee's protein is pollen: flowers in bloom (T2-11)
            if (role == "protein" && kind.pollen != 0) { for (int i = 0; i < c.flowers.Count; i++) if (InBloom(rec, i)) { var f = c.flowers[i]; cb(new AiTarget { kind = "pollen", key = key, i = i, c = ri + 120 }, new V3(f.x, f.y, f.z), T.sense.flower); } return; }
            bool shortOf = col.deficit >= T.ai.canDeficit;
            if (role == "sugar")
            {
                var fi = FlowerIdx(rec);
                for (int i = 0; i < c.sugar.Count; i++)
                {
                    var s = c.sugar[i]; var sp = new V3(s.x, s.y, s.z);
                    if (s.kind == "can") { if (lvl >= 2 || CanSpilled(key, i) || (policy && !shortOf)) continue; cb(new AiTarget { kind = "sugar", key = key, i = i, c = ri }, sp, T.sense.can); continue; }
                    if (!InBloom(rec, fi[i])) continue;
                    Num nv = NectarAt(rec, fi[i]);
                    if (nv < 0.2) continue; // nothing there (T1-8)
                    cb(new AiTarget { kind = "sugar", key = key, i = i, c = ri }, sp, T.sense.flower * nv);
                }
                if (lvl >= 3 && (!policy || shortOf)) for (int i = 0; i < c.traps.Count; i++) { var tr = c.traps[i]; cb(new AiTarget { kind = "trap", key = key, i = i, c = ri + 50 }, new V3(tr.x, tr.y, tr.z), T.sense.trap); }
                // short of sugar, a forager will rob a hive (T1-9)
                if (!policy || shortOf) { var hvs = HivesIn(rec); for (int h = 0; h < hvs.Count; h++) if (HiveLoadsLeft(key, h) > 0) cb(new AiTarget { kind = "hive", key = key, i = h, c = ri + 100 }, new V3(hvs[h].ex, hvs[h].ey, hvs[h].ez), T.sense.hive); }
                // a spill dries: its scent fades with what is left of it
                foreach (var sp in SpillsIn(key)) cb(new AiTarget { kind = "spill", key = key, i = sp.i, c = ri + 60 }, new V3(sp.x, sp.y, sp.z), T.sense.spill * Clamp01((st.spilled[sp.i] - minute) / T.panic.spillMinutes));
                foreach (var f in FruitIn(rec)) cb(new AiTarget { kind = "fruit", key = key, i = f.i, c = ri + 80 }, new V3(f.x, f.y, f.z), T.sense.fruit);
            }
            else if (role == "protein")
            {
                for (int i = 0; i < c.flies.Count; i++) if ((st.caughtFly.TryGetValue(i, out var cf) ? cf : 0) <= tick && FlyActive(rec, i)) cb(new AiTarget { kind = "prey", sub = "fly", key = key, i = i, c = ri }, FlyPos(c.flies[i], tick), 0);
                for (int i = 0; i < c.caterpillars.Count; i++) if (!st.caughtCat.ContainsKey(i) && CatActive(rec, i)) { var f = c.caterpillars[i]; cb(new AiTarget { kind = "prey", sub = "cat", key = key, i = i, c = ri + 20 }, new V3(f.x, f.y, f.z), T.sense.cat); }
                // carrion smells stronger by the day
                foreach (var cr in CarrionIn(rec)) cb(new AiTarget { kind = "prey", sub = "carrion", key = key, i = (int)cr.d, c = ri + 90 }, new V3(cr.x, cr.y, cr.z), T.sense.carrion + T.sense.carrionPerDay * (Num)(day - cr.d));
                var baits = BaitsIn(key);
                for (int i = 0; i < baits.Count; i++) cb(new AiTarget { kind = "bait", key = key, i = i, c = ri + 70 }, new V3(baits[i].x, baits[i].y, baits[i].z), T.sense.bait);
                // barbecue meat smells a long way (T1-10)
                foreach (var mt in MeatIn(rec)) cb(new AiTarget { kind = "prey", sub = "meat", key = key, i = mt.i, c = ri + 110 }, new V3(mt.x, mt.y, mt.z), T.sense.meat);
                // a porch light at night shows from afar, and moths at it (T2-10)
                if (kind.night != 0) foreach (var mo in MothsIn(rec)) cb(new AiTarget { kind = "prey", sub = "moth", key = key, i = mo.i, c = ri + 130 }, mo.p, T.moths.strength);
                // a hornet sees another colony's wasp on the wing as prey
                if (kind.fight > 0) foreach (var x in wasps) if (IsRival(x) && x.state == "fly" && World.ChunkOf(x.x) == rec.cx && World.ChunkOf(x.z) == rec.cz) cb(new AiTarget { kind = "prey", sub = "wasp", key = key, i = x.id, c = ri + 140 }, x.P, 0);
            }
        }

        /// What this wasp senses from where it is: the most attractive source it can smell or see, or null
        internal AiTarget Sense(Wasp w)
        {
            Num spd = Sqrt(w.vx * w.vx + w.vy * w.vy + w.vz * w.vz);
            AiTarget best = null; Num bs = Num.MaxValue;
            for (int ri = 0; ri < activeChunks.Count; ri++)
            {
                Sources(activeChunks[ri], ri, w.role, true, (t, pos, strength) =>
                {
                    Num dx = pos.x - w.x, dy = pos.y - w.y, dz = pos.z - w.z, d = Sqrt(dx * dx + dy * dy + dz * dz);
                    Num reach;
                    if (strength == 0)
                    {
                        // moving prey is seen: close by in any direction, or ahead in the cone
                        bool ahead = spd > T.sense.minSpeed && d > 1e-6 && (dx * w.vx + dy * w.vy + dz * w.vz) / (d * spd) > T.sense.cone;
                        reach = d < T.sense.near ? T.sense.near : ahead ? T.sense.sight : 0;
                    }
                    else reach = ScentRange(w.x, w.z, pos, strength);
                    if (!(d < reach)) return;
                    Num sc = d / reach + H32(w.id, t.i, t.c, day) * T.sense.jitter;
                    if (sc < bs) { bs = sc; best = t; }
                }, Spw(w));
            }
            // a rival forager smells honey in the player's hive and comes to rob it (T2-11)
            var col = colony; var e = nest.entrance;
            if (IsRival(w) && w.role == "sugar" && Colony.Sp(col).perennial != 0 && col.nestAlive && col.sited && col.sugar >= T.hive.robHoney)
            {
                Num d = Sqrt(D2(w, e)), reach = ScentRange(w.x, w.z, e, T.hive.robStrength);
                if (d < reach) { Num sc = d / reach + H32(w.id, 0, 999, day) * T.sense.jitter; if (sc < bs) best = new AiTarget { kind = "phive", key = nest.key, i = 0, c = 999 }; }
            }
            return best;
        }

        /// Is a remembered source still there for a forager of this role (in the active world, still worth it)?
        bool StillThere(string role, AiTarget t) => StillThere(role, t, T.species.wasp);
        bool StillThere(string role, AiTarget t, SpeciesRow sp)
        {
            if (t == null) return false;
            int ri = -1;
            for (int i = 0; i < activeChunks.Count; i++) if (activeChunks[i].key == t.key) { ri = i; break; }
            if (ri < 0) return false;
            // a hunter remembers where the flies are (a table), not the one fly it took
            if (t.sub == "fly") return role == "protein" && FlyActive(activeChunks[ri], t.i);
            bool found = false;
            Sources(activeChunks[ri], ri, role, true, (u, _, __) => { if (u.kind == t.kind && u.sub == t.sub && u.i == t.i) found = true; }, sp);
            return found;
        }

        /// Alarm pheromone is a decaying scent too: strongest when fresh, carried downwind
        internal Num AlarmReach(Wasp w, Alarm a) => T.alarm.radius * (0.5 + 0.5 * Clamp01((a.until - tick) / (Num)T.alarm.ticks)) * ScentRange(w.x, w.z, new V3(a.x, a.y, a.z), 1) / T.sense.smell;

        // ---------------- lineage colonies (GDD 6.7, T2-4); see sim.js

        internal Num FoundLine(List<HiberSite> sites, int choice, Num queens)
        {
            int sn = season.n; var used = new List<(Num x, Num z)> { (sites[choice].x, sites[choice].z) };
            line = new List<LineColony>();
            Num left = queens;
            for (int si = 0; si < sites.Count; si++)
            {
                int k = sites[si].n - (si == choice ? 1 : 0);
                for (; k > 0 && line.Count < T.line.max; k--)
                {
                    var t = LineTree(sites[si], used);
                    if (t == null) break;
                    Num dx = sites[si].x - t.x, dz = sites[si].z - t.z, dd = Sqrt(dx * dx + dz * dz); if (dd == 0) dd = 1; dx /= dd; dz /= dd;
                    var n = World.MakeNest(t.x, t.z, t.x + dx * (t.r + 0.2), Clamp(1.6, 1.2, Max(1.2, t.h - 0.6)), t.z + dz * (t.r + 0.2), World.NEST.r, "trunk");
                    var c = Colony.New(true, species); c.sited = true; c.maxCells = MaxCells("trunk"); c.alloc = 0;
                    line.Add(new LineColony { id = ++lineSeq, nest = n, colony = c, season = sn });
                    used.Add((t.x, t.z)); left--;
                    Emit("sisterFounded", ("id", lineSeq), ("x", n.x), ("z", n.z));
                }
            }
            return left;
        }
        Tree LineTree(HiberSite s, List<(Num x, Num z)> used)
        {
            int cx = World.ChunkOf(s.x), cz = World.ChunkOf(s.z);
            Tree best = null; Num bd = T.line.treeRange * T.line.treeRange;
            for (int dz = -1; dz <= 1; dz++) for (int dx = -1; dx <= 1; dx++) foreach (var t in Content(cx + dx, cz + dz).trees)
            {
                Num d = Sq(t.x - s.x) + Sq(t.z - s.z);
                if (d >= bd) continue;
                bool near = false; foreach (var u in used) if (Sq(u.x - t.x) + Sq(u.z - t.z) < T.line.minGap * T.line.minGap) { near = true; break; }
                if (near) continue;
                bd = d; best = t;
            }
            return best;
        }
        void LineTick(bool daylight, Num frac)
        {
            if (line.Count == 0) return;
            Num dt = (Num)60 / dayTicks; var av = EcoAvail();
            foreach (var sc in new List<LineColony>(line))
            {
                var c = sc.colony; string key = "line:" + sc.id; int outN = 0; foreach (var w in wasps) if (w.colony == key) outN++;
                if (c.adults < 1 && c.queenAlive && daylight)
                {
                    c.sugar += T.line.queenForage.sugar * dt * av.sugar; c.protein += T.line.queenForage.protein * dt * av.protein; c.pulp += T.line.queenForage.pulp * dt;
                }
                var h = NestHeat(minute, sc.nest.site);
                Colony.Step(c, dt, outN, daylight, frac, bio, BroodSpeed(minute, sc.nest.site, c.cool), av, (h.heat, h.cook));
                if (Colony.Sp(c).perennial != 0) Swarm(c, sc.nest);
                // the exterminator (abstract; he is drawn only for the player's own nest): called to a sister nest's
                // neighbourhood, he comes the next morning, or in two hours before mid-afternoon, and destroys it unless things
                // calm down first (sim.js)
                if (settings.exterminator && c.nestAlive)
                {
                    int lv = NestAreaLevel(sc.nest.key);
                    if (!(sc.ext > 0) && lv >= T.ext.level)
                    {
                        long md = MinuteOfDay(minute);
                        sc.ext = md < 15 * 60 && md >= (long)T.time.dawn ? minute + 120 : (md >= (long)T.time.dawn ? day + 1 : day) * 1440 + (long)T.ext.arriveMinute;
                        Emit("sisterExtScheduled", ("id", sc.id), ("arriveMinute", sc.ext));
                    }
                    else if (sc.ext > 0 && lv < 3) sc.ext = 0;
                    else if (sc.ext > 0 && minute >= sc.ext)
                    {
                        sc.ext = 0; Colony.DestroyNest(c);
                        foreach (var w in new List<Wasp>(wasps)) if (w.colony == key) Despawn(w);
                        Emit("sisterExterminated", ("id", sc.id));
                    }
                }
                if (Colony.Finished(c, 0))
                {
                    line.Remove(sc);
                    foreach (var w in new List<Wasp>(wasps)) if (w.colony == key) Despawn(w);
                    Emit("sisterLost", ("id", sc.id));
                }
            }
        }
        void LineTraffic(bool daylight)
        {
            var keys = new HashSet<string>(); foreach (var r in activeChunks) keys.Add(r.key);
            foreach (var w in new List<Wasp>(wasps))
            {
                if (w.colony == "own" || IsRival(w)) continue;
                LineColony sc = null; foreach (var x in line) if ("line:" + x.id == w.colony) { sc = x; break; }
                if (sc == null || !keys.Contains(sc.nest.key)) Despawn(w);
            }
            if (!daylight || noAI || tick % 180 >= 60) return;
            bool breeding = SeasonFrac >= T.season.reproStart;
            foreach (var sc in line)
            {
                if (!keys.Contains(sc.nest.key) || !sc.colony.nestAlive) continue;
                string key = "line:" + sc.id; var c = sc.colony;
                int guards = 0, males = 0, gynes = 0, foragers = 0;
                foreach (var w in wasps) if (w.colony == key) { if (w.role == "guard") guards++; if (w.caste == "male") males++; else if (w.caste == "gyne") gynes++; else if (w.caste == "worker" && w.role != "guard") foragers++; }
                Wasp At(Wasp w) { w.colony = key; w.sp = c.species ?? "wasp"; w.x = sc.nest.entrance.x; w.y = sc.nest.entrance.y - 0.03; w.z = sc.nest.entrance.z; return w; }
                // guards at the entrance once it is big enough, as at yours (T1-13)
                if (guards < (c.adults - c.young >= T.guard.minAdults ? Colony.Sp(c).guards : 0)) { var g = At(SpawnWasp(false)); g.role = "guard"; g.ai.mode = "guard"; continue; }
                // in the breeding season its males and young queens fly to its own mating spot (T2-3)
                if (breeding)
                {
                    if (c.males >= 1 && males < T.males.physMales && H32(tick, sc.id, 511) < T.males.launchChance) { c.males -= 1; var m = At(SpawnWasp(false, "male")); m.role = "male"; m.venom = 0; m.ai.mode = "patrol"; continue; }
                    if (c.gynes >= 1 && Colony.Sp(c).perennial == 0 && gynes < T.males.physGynes && H32(tick, sc.id, 512) < T.males.launchChance) { c.gynes -= 1; var q = At(SpawnWasp(false, "gyne")); q.role = "gyne"; q.ai.mode = "mate"; q.ai.timer = tick + T.males.gyneTicks; continue; }
                }
                if (foragers >= System.Math.Min(T.line.physical, (int)Floor(c.adults * 0.2))) continue;
                var nw = At(SpawnWasp(false));
                nw.role = H32(nw.id, 9) < 0.5 ? "sugar" : "protein"; nw.ai.mode = "pick";
            }
        }
        void TakeOverSister()
        {
            Num Size(LineColony x) => x.colony.adults + Colony.BroodTotal(x.colony);
            var best = line[0];
            foreach (var x in line) if (Size(x) > Size(best)) best = x;
            line.Remove(best);
            foreach (var w in new List<Wasp>(wasps)) if (w.colony == "line:" + best.id) Despawn(w);
            int alloc = colony.alloc;
            oldNests.Add(nest);
            nest = best.nest; colony = best.colony; colony.alloc = alloc;
            var d = Driven();
            foreach (var w in new List<Wasp>(wasps)) if (w.colony == "own" && w != d) Despawn(w);
            if (d != null) { d.x = nest.spawn.x; d.y = nest.spawn.y; d.z = nest.spawn.z; d.vx = d.vy = d.vz = 0; d.carry = null; }
            Emit("sisterTakeover", ("id", best.id), ("adults", (int)Floor(colony.adults)));
        }

        // ---------------- males and mating flights (GDD 6.5, 6.7, T2-3); see sim.js

        internal void LaunchRepro(ColonyState col)
        {
            int males = 0, gynes = 0;
            foreach (var w in Own()) { if (w.caste == "male") males++; else if (w.caste == "gyne") gynes++; }
            if (col.males >= 1 && males < T.males.physMales && H32(tick, 501) < T.males.launchChance)
            {
                col.males -= 1;
                var w = SpawnWasp(false, "male"); w.role = "male"; w.venom = 0; w.ai.mode = "patrol";
            }
            else if (col.gynes >= 1 && Colony.Sp(col).perennial == 0 && gynes < T.males.physGynes && H32(tick, 502) < T.males.launchChance) // a bee colony's queens stay in to swarm (T2-11)
            {
                col.gynes -= 1;
                var w = SpawnWasp(false, "gyne"); w.role = "gyne"; w.ai.mode = "mate"; w.ai.timer = tick + T.males.gyneTicks;
            }
        }
        readonly Dictionary<string, (V3 p, Num r)> leks = new Dictionary<string, (V3 p, Num r)>();
        /// the mating spot: over the crown of the tallest tree near the nest, nearer ones preferred (a sister colony's too)
        public (V3 p, Num r) LekSpot() => LekSpot(nest);
        public (V3 p, Num r) LekSpot(Nest n)
        {
            string key = n.key + ":" + n.x + ":" + n.z;
            if (leks.TryGetValue(key, out var hit)) return hit;
            V3 lekP; Num lekR;
            int cx = World.ChunkOf(n.x), cz = World.ChunkOf(n.z);
            Tree best = null; Num bs = Num.MinValue;
            for (int dz = -1; dz <= 1; dz++) for (int dx = -1; dx <= 1; dx++) foreach (var t in Content(cx + dx, cz + dz).trees)
            {
                Num dd = Sqrt(Sq(t.x - n.x) + Sq(t.z - n.z));
                if (dd > T.males.lekRange) continue;
                Num s = t.h - 0.05 * dd;
                if (s > bs) { bs = s; best = t; }
            }
            if (best != null) { lekP = new V3(best.x, best.h + T.males.lekAbove, best.z); lekR = best.cr; } else { lekP = new V3(n.x, n.y + 3, n.z); lekR = 1; }
            if (leks.Count > 16) leks.Clear();
            leks[key] = (lekP, lekR);
            return (lekP, lekR);
        }
        Cmd ThinkMale(Wasp w, Cmd cmd) => ThinkMale(w, cmd, nest);
        Cmd ThinkMale(Wasp w, Cmd cmd, Nest n)
        {
            var ai = w.ai; var (lek, lr) = LekSpot(n);
            if (!IsDaylight(minute) || Raining || w.energy < 0.3) ai.mode = "home";
            if (ai.mode == "home")
            {
                Steer(w, n.entrance, cmd);
                if (D2(w, n.entrance) < 0.07 * 0.07) Despawn(w);
                return cmd;
            }
            Num a = tick * 0.02 + w.id, r = Max(T.males.patrolR, lr * 0.8);
            Steer(w, new V3(lek.x + r * DCos(a), lek.y + 0.4 * DSin(a * 1.7), lek.z + r * DSin(a)), cmd);
            return cmd;
        }
        Cmd ThinkGyne(Wasp w, Cmd cmd) => ThinkGyne(w, cmd, nest);
        Cmd ThinkGyne(Wasp w, Cmd cmd, Nest n)
        {
            var ai = w.ai; var (lek, lr) = LekSpot(n);
            if (ai.mode == "mate" && (tick > ai.timer || !IsDaylight(minute) || Raining)) ai.mode = "home";
            if (ai.mode == "home")
            {
                Steer(w, n.entrance, cmd);
                if (D2(w, n.entrance) < 0.07 * 0.07) Despawn(w);
                return cmd;
            }
            Num a = -tick * 0.015 + w.id * 2, r = Max(T.males.patrolR, lr * 0.8) * 0.9;
            Steer(w, new V3(lek.x + r * DCos(a), lek.y + 0.2 * DSin(a * 1.3), lek.z + r * DSin(a)), cmd);
            if (D2(w, lek) > Sq(r + 3)) return cmd;
            Wasp mate = null; Num md = T.males.mateDist * T.males.mateDist;
            foreach (var x in wasps)
            {
                if (x.caste != "male" || IsRival(x) || (x.state != "fly" && x.state != "landed")) continue;
                Num q = D2(x, w);
                if (q <= md) { md = q; mate = x; }
            }
            Num area = T.males.area * Colony.ReproShare(SeasonFrac) / T.males.need;
            if (mate != null || H32(w.id, tick, 503) < T.males.areaRate * T.DT * Min(1, area)) Mate(w, mate);
            return cmd;
        }
        void Mate(Wasp g, Wasp male)
        {
            g.mated = true;
            Emit("mated", ("gyne", g.id), ("male", male != null ? male.id : 0), ("driven", male != null && male.id == drivenId));
            Despawn(g); // she leaves to find a place to winter: counted as mated
            if (male != null) Die(male, "mated", null); // a male mates once and dies
        }

        internal void AiPick(Wasp w) => AiPick(w, nest.entrance);
        internal void AiPick(Wasp w, V3 home)
        {
            var ai = w.ai;
            if (w.role == "water")
            {
                // water carriers know the baths and puddles round the nest (T2-1)
                AiTarget best = null; Num bs = Num.MaxValue, R2 = T.water.range * T.water.range;
                for (int ri = 0; ri < activeChunks.Count; ri++)
                {
                    var rec = activeChunks[ri];
                    foreach (var s in WaterIn(rec))
                    {
                        if (Sq(s.x - home.x) + Sq(s.z - home.z) > R2) continue;
                        Num sc = Sqrt(D2(w, new V3(s.x, s.y, s.z))) + H32(w.id, s.i, ri + 60, day) * 6;
                        if (sc < bs) { bs = sc; best = new AiTarget { kind = "water", key = rec.key, i = s.i }; }
                    }
                }
                if (best != null) { ai.target = best; ai.mode = "outbound"; } else ai.mode = "return";
                return;
            }
            if (w.role != "sugar" && w.role != "protein")
            {
                // wood is a landmark: a wasp knows the sheds and fences around its nest
                AiTarget wb = null; Num ws = Num.MaxValue;
                for (int ri = 0; ri < activeChunks.Count; ri++)
                {
                    var rec = activeChunks[ri]; var bx = rec.content.boxes;
                    for (int i = 0; i < bx.Count; i++)
                    {
                        var b = bx[i]; if (!b.wood || b.hive || PulpLeft(rec.key, i) <= 0) continue;
                        Num s = Sqrt(D2(w, new V3((b.minx + b.maxx) / 2, b.maxy, (b.minz + b.maxz) / 2))) + H32(w.id, i, ri + 40, day) * 12;
                        if (s < ws) { ws = s; wb = new AiTarget { kind = "wood", key = rec.key, i = i, c = ri + 40 }; }
                    }
                }
                if (wb != null) { ai.target = wb; ai.mode = "outbound"; } else ai.mode = "return";
                return;
            }
            // a forager goes back to a source that paid (site fidelity), then to the one whose scent a nestmate brought home
            if (ai.known != null && ai.known.role == w.role && StillThere(w.role, ai.known.t, Spw(w))) { ai.target = ai.known.t.Copy(); ai.mode = "outbound"; return; }
            ai.known = null;
            // a rival knows where the player's bee hive is and some days goes to rob it of honey and brood (T2-11)
            var pc = colony; var ne = nest.entrance;
            if (IsRival(w) && (w.role == "sugar" || w.role == "protein") && Colony.Sp(pc).perennial != 0 && pc.nestAlive && pc.sited && pc.sugar >= T.hive.robHoney
                && D2(w, ne) < T.hive.robRange * T.hive.robRange && H32(w.id, day, 92) < T.hive.robChance) { ai.target = new AiTarget { kind = "phive", key = nest.key, i = 0, c = 999 }; ai.mode = "outbound"; return; }
            var hs = homeScent;
            if (w.colony == "own" && hs != null && hs.until > tick && hs.role == w.role && D2(w, nest.entrance) < 1 && StillThere(w.role, hs.t, Spw(w))) { ai.target = hs.t.Copy(); ai.mode = "outbound"; return; }
            var t = Sense(w);
            if (t != null) { ai.target = t; ai.mode = "outbound"; return; }
            // nothing in reach: search in a widening spiral round home, sniffing as it goes
            ai.mode = "search"; ai.target = null; ai.timer = tick + T.sense.searchTicks;
            ai.head = DAtan2(w.z - home.z, w.x - home.x) + (H32(w.id, tick, 32) - 0.5);
            ai.leg = Max(T.sense.searchR0, Sqrt(Sq(w.x - home.x) + Sq(w.z - home.z)));
            ai.spin = H32(w.id, tick, 33) < 0.5 ? -1 : 1;
        }

        void Search(Wasp w, Cmd cmd, V3 home)
        {
            var ai = w.ai;
            if (tick > ai.timer) { ai.mode = "return"; return; }
            if ((tick + w.id) % T.sense.every == 0)
            {
                var t = Sense(w);
                if (t != null) { ai.target = t; ai.mode = "outbound"; Emit("aiFound", ("id", w.id), ("kind", t.sub ?? t.kind)); return; }
            }
            // along the spiral at searchSpeed, the rings ringStep apart; out of range, give up
            Num step = T.sense.searchSpeed * T.DT;
            ai.head += ai.spin * step / ai.leg;
            ai.leg += T.sense.ringStep * step / (TAU * ai.leg);
            if (ai.leg > T.sense.searchRange) { ai.mode = "return"; return; }
            Num a = ai.head + ai.spin * 1.5 / ai.leg;
            Steer(w, new V3(home.x + ai.leg * DCos(a), T.sense.searchY, home.z + ai.leg * DSin(a)), cmd);
        }

        V3? AiTargetPos(Wasp w)
        {
            var t = w.ai.target;
            if (t == null) return null;
            if (!records.TryGet(t.key ?? "", out var rec) || !activeChunks.Contains(rec)) return null;
            var c = rec.content; var st = CS(t.key);
            if (t.kind == "sugar")
            {
                var s = c.sugar[t.i];
                if (s.kind == "can")
                {
                    // into the cup: above the opening first, then down to just over the drink (GDD 7.5)
                    Cup cp = null; foreach (var q in CupsIn(rec)) if (q.x == s.x && q.z == s.z) { cp = q; break; }
                    Num rIn = T.cup.r - T.cup.wall;
                    if (cp != null) return Sq(w.x - cp.x) + Sq(w.z - cp.z) > Sq(rIn * 0.5) && w.y < T.cup.rim + 0.01 ? new V3(cp.x, T.cup.rim + 0.03, cp.z) : new V3(cp.x, cp.level + 0.016, cp.z);
                }
                return new V3(s.x, s.y + 0.012, s.z);
            }
            if (t.kind == "trap") { var tr = c.traps[t.i]; return new V3(tr.x, tr.y, tr.z); }
            if (t.kind == "pollen") { if (t.i >= c.flowers.Count || !InBloom(rec, t.i)) return null; var f = c.flowers[t.i]; return new V3(f.x, f.y + 0.012, f.z); }
            if (t.kind == "phive") return Colony.Sp(colony).perennial != 0 && colony.nestAlive ? nest.entrance : (V3?)null;
            if (t.kind == "hive") { var hvs = HivesIn(rec); return t.i < hvs.Count ? new V3(hvs[t.i].ex, hvs[t.i].ey, hvs[t.i].ez) : (V3?)null; }
            if (t.kind == "fruit") { foreach (var f in FruitIn(rec)) if (f.i == t.i) return new V3(f.x, f.y + 0.015, f.z); return null; }
            if (t.kind == "spill") { foreach (var sp in SpillsIn(t.key)) if (sp.i == t.i) return new V3(sp.x, sp.y + 0.012, sp.z); return null; }
            if (t.kind == "bait") { var bs = BaitsIn(t.key); return t.i < bs.Count ? new V3(bs[t.i].x, bs[t.i].y, bs[t.i].z) : (V3?)null; }
            if (t.kind == "water")
            {
                foreach (var s in WaterIn(rec))
                    if (s.i == t.i && (t.i >= 16 ? s.kind == "puddle" : s.kind == "bath"))
                        return new V3(s.x + s.r * 0.4 * (H32(w.id, t.i, 61) - 0.5), s.y + T.wasp.radius + 0.006, s.z + s.r * 0.4 * (H32(w.id, t.i, 62) - 0.5));
                return null;
            }
            if (t.kind == "wood")
            {
                var b = c.boxes[t.i];
                if (b.shed) return new V3((b.minx + b.maxx) / 2 + 0.2 * (H32(w.id, t.i) - 0.5), Min(1.2, b.maxy / 2), b.maxz + T.wasp.radius + 0.008); // a shed's wall: its top is under the roof
                return new V3((b.minx + b.maxx) / 2 + 0.2 * (H32(w.id, t.i) - 0.5), b.maxy + T.wasp.radius + 0.008, (b.minz + b.maxz) / 2);
            }
            // a fly already taken: its table still draws flies, so go there and take whatever is about (T1-16)
            if (t.sub == "fly") { if (!FlyActive(rec, t.i)) return null; var fl = c.flies[t.i]; return (st.caughtFly.TryGetValue(t.i, out var cf) ? cf : 0) > tick ? new V3(fl.x, fl.y, fl.z) : FlyPos(fl, tick); }
            if (t.sub == "cat") { if (st.caughtCat.ContainsKey(t.i) || !CatActive(rec, t.i)) return null; var cp = c.caterpillars[t.i]; return new V3(cp.x, cp.y, cp.z); }
            if (t.sub == "carrion") { foreach (var cr in CarrionIn(rec)) if (cr.d == t.i) return new V3(cr.x, cr.y, cr.z); return null; }
            if (t.sub == "meat") { foreach (var mt in MeatIn(rec)) if (mt.i == t.i) return new V3(mt.x, mt.y + 0.012, mt.z); return null; }
            if (t.sub == "moth") { var L = LightsIn(rec); int li = t.i / T.moths.perLight; return li < L.Count && Lit() ? (st.caughtMoth != null && st.caughtMoth.TryGetValue(t.i, out var cm) && cm > tick ? new V3(L[li].x, L[li].y, L[li].z) : MothPos(L[li], t.i % T.moths.perLight, tick)) : (V3?)null; }
            if (t.sub == "wasp") { var x = WaspById(t.i); return x != null && x.state == "fly" ? x.P : (V3?)null; }
            return null;
        }

        /// An exposed spot on a human that the wasp can reach (GDD 6.3: late-summer stings)
        AiTarget AiStingPoint(Wasp w, Human hm)
        {
            var parts = hm.PartsNow;
            var lp = Body.ToLocal(hm.F, w.P);
            var order = new List<int>();
            for (int i = 0; i < parts.Count; i++) order.Add(i);
            Stable.Sort(order, (a, b) => Stable.Sign(H32(w.id, a, day) - H32(w.id, b, day)));
            foreach (int i in order)
            {
                var part = parts[i];
                var mid = new V3((part.a.x + part.b.x) / 2, (part.a.y + part.b.y) / 2, (part.a.z + part.b.z) / 2);
                var q = Body.SegClosest(part.a, part.b, mid);
                Num nx = lp.x - q.x, ny = lp.y - q.y, nz = lp.z - q.z;
                Num nl = Sqrt(nx * nx + ny * ny + nz * nz); if (nl == 0) nl = 1;
                nx /= nl; ny /= nl; nz /= nl;
                var surf = new V3(q.x + nx * part.r, q.y + ny * part.r, q.z + nz * part.r);
                int zone = Body.Classify(part, q, new V3(nx, ny, nz), surf, hm.tr.height / 1.75);
                if (Body.ZoneCover(hm.clothing, zone) == 2) continue;
                return new AiTarget { hex = hm.hex, p = new V3(surf.x + nx * 0.012, surf.y + ny * 0.012, surf.z + nz * 0.012) };
            }
            return null;
        }

        static void Steer(Wasp w, V3 tp, Cmd cmd)
        {
            Num dx = tp.x - w.x, dy = tp.y - w.y, dz = tp.z - w.z;
            Num d = Sqrt(dx * dx + dy * dy + dz * dz);
            if (d < 1e-6) return;
            // climb over obstacles on long legs
            if (d > 3 && w.y < 1.4) dy += 1.2;
            Num m = Sqrt(dx * dx + dy * dy + dz * dz);
            cmd.dirX = dx / m; cmd.dirY = dy / m; cmd.dirZ = dz / m;
            cmd.throttle = Clamp(Sqrt(2 * T.wasp.accel * d) * 0.7 / T.wasp.cruise, 0.06, 1);
        }

        /// a rival forager in at the player's bee hive: honey in its crop, a larva in its jaws, the guards after it (T2-11)
        void RobHive(Wasp w)
        {
            var col = colony;
            if (Colony.Sp(col).perennial == 0 || !col.nestAlive || D2(w, nest.entrance) > Sq(T.ai.arrive * 2)) return;
            col.sugar -= Min(col.sugar, T.hive.robHoney); w.ai.cargo = 1;
            if (col.larvae >= 1) { col.larvae -= 1; w.carry = new Carry { kind = "protein", amount = T.rival.raidProtein, what = "bee brood" }; }
            foreach (var g in Own()) if (g.role == "guard" && g.state == "fly" && g.id != drivenId) { g.ai.mode = "hunt"; g.ai.huntId = w.id; g.ai.timer = tick + T.guard.huntTicks; }
            Emit("hiveRobbed", ("id", w.id));
        }

        /// After an AI sting: get out
        void AiAfterSting(Wasp w) { w.ai.stings--; w.ai.mode = "evade"; w.ai.until = w.ai.timer; w.ai.timer = tick + T.ai.evadeTicks; }
    }
}
