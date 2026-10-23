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
        Cmd ThinkGuard(Wasp w, Cmd cmd)
        {
            var ai = w.ai; var n = nest; var e = n.entrance;
            Num ox = e.x - n.x, oz = e.z - n.z, od = Sqrt(ox * ox + oz * oz);
            var post = od > 0.01 ? new V3(e.x + ox / od * 0.08, e.y, e.z + oz / od * 0.08) : new V3(e.x, e.y - 0.08, e.z);
            if (ai.mode == "hunt")
            {
                WaspBase t = (WaspBase)WaspById(ai.huntId) ?? remote.Get(ai.huntId);
                if (t == null || !Free3(t.state) || (t is Wasp tw && tw.colony == "own") || tick > ai.timer || D2(t, post) > T.guard.chase * T.guard.chase) ai.mode = "guard";
                else { Steer(w, t.P, cmd); cmd.throttle = 1; cmd.burst = 1; return cmd; }
            }
            ai.mode = "guard";
            Num r2 = T.guard.radius * T.guard.radius;
            int tid = 0; bool found = false, player = false;
            foreach (var x in wasps) if (x.colony != "own" && Free3(x.state) && D2(x, post) < r2) { tid = x.id; found = true; break; }
            if (!found) foreach (var kv in remote) if (Free3(kv.Value.state) && D2(kv.Value, post) < r2) { tid = kv.Key; found = true; player = !kv.Value.rival; break; }
            if (found) { ai.mode = "hunt"; ai.huntId = tid; ai.timer = tick + T.guard.huntTicks; Emit("guardHunt", ("id", w.id), ("target", tid), ("player", player)); return cmd; }
            var xh = ext.hm;
            if (xh != null && xh.state != "flee" && xh.state != "leave" && Sq(xh.x - e.x) + Sq(xh.z - e.z) < T.guard.humanRadius * T.guard.humanRadius) { AiAttack(w, xh.hex); return cmd; }
            Num a = (Num)tick / 40 + w.id;
            Steer(w, new V3(post.x + T.guard.ring * DCos(a), post.y + 0.03, post.z + T.guard.ring * DSin(a)), cmd);
            return cmd;
        }

        Cmd Think(Wasp w)
        {
            var ai = w.ai;
            var cmd = new Cmd { hasDir = true };
            if (w.state == "balled") { BallEscape(w, false); return cmd; }
            if (w.state != "fly") return cmd;
            if (w.colony != "own") return ThinkRival(w, cmd);
            // alarm pheromone pulls nearby workers into an attack
            if (ai.mode != "attack" && ai.mode != "evade")
            {
                foreach (var a in alarms)
                {
                    var k = HumanByHex(a.killerHex);
                    if (D2(w, new V3(a.x, a.y, a.z)) < T.alarm.radius * T.alarm.radius && k != null && k.state != "away") { AiAttack(w, a.killerHex); break; }
                }
            }
            bool daylight = IsDaylight(minute) && !Raining;
            if ((!daylight || w.caste == "queen") && ai.mode != "home") { ai.mode = "home"; ai.target = null; }
            if (w.energy < 0.2 && ai.mode != "home" && ai.mode != "collect") { ai.mode = "return"; ai.target = null; }
            if (w.role == "guard" && (ai.mode == "guard" || ai.mode == "hunt" || ai.mode == "pick")) return ThinkGuard(w, cmd);
            switch (ai.mode)
            {
                case "pick": AiPick(w); break;
                case "outbound":
                {
                    var tp = AiTargetPos(w);
                    if (tp == null) { ai.mode = "pick"; break; }
                    Steer(w, tp.Value, cmd);
                    if (D2(w, tp.Value) < T.ai.arrive * T.ai.arrive) { ai.mode = "collect"; ai.timer = tick + T.ai.collectTicks; }
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
                        var p = PreyNear(w);
                        if (p != null) { Catch(w, p); ai.mode = "return"; ai.target = null; }
                        else if (tick > ai.timer) ai.mode = "pick";
                    }
                    else if (t.kind == "wood")
                    {
                        if (tick > ai.timer) { w.carry = new Carry { kind = "pulp", amount = T.pulp.amount, what = "pulp" }; ai.mode = "return"; ai.target = null; Emit("chewed", ("id", w.id)); }
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

        void AiPick(Wasp w)
        {
            var ai = w.ai; var col = colony;
            AiTarget best = null; Num bs = Num.MaxValue;
            void Consider(AiTarget t, V3 pos)
            {
                Num s = Sqrt(D2(w, pos)) + H32(w.id, t.i, t.c, day) * 12;
                if (s < bs) { bs = s; best = t; }
            }
            for (int ri = 0; ri < activeChunks.Count; ri++)
            {
                var rec = activeChunks[ri]; var c = rec.content; string key = rec.key; var st = CS(key); int lvl = EscLevel(key);
                if (w.role == "sugar")
                {
                    for (int i = 0; i < c.sugar.Count; i++)
                    {
                        var s = c.sugar[i];
                        if (s.kind == "can" && (lvl >= 2 || col.deficit < T.ai.canDeficit)) continue;
                        Consider(new AiTarget { kind = "sugar", key = key, i = i, c = ri }, new V3(s.x, s.y, s.z));
                    }
                    if (lvl >= 3 && col.deficit >= T.ai.canDeficit) for (int i = 0; i < c.traps.Count; i++) { var tr = c.traps[i]; Consider(new AiTarget { kind = "trap", key = key, i = i, c = ri + 50 }, new V3(tr.x, tr.y, tr.z)); }
                    foreach (var sp in SpillsIn(key)) Consider(new AiTarget { kind = "spill", key = key, i = sp.i, c = ri + 60 }, new V3(sp.x, sp.y, sp.z));
                    foreach (var f in FruitIn(rec)) Consider(new AiTarget { kind = "fruit", key = key, i = f.i, c = ri + 80 }, new V3(f.x, f.y, f.z));
                }
                else if (w.role == "protein")
                {
                    for (int i = 0; i < c.flies.Count; i++) if ((st.caughtFly.TryGetValue(i, out var cf) ? cf : 0) <= tick) Consider(new AiTarget { kind = "prey", sub = "fly", key = key, i = i, c = ri }, FlyPos(c.flies[i], tick));
                    for (int i = 0; i < c.caterpillars.Count; i++) if (!st.caughtCat.ContainsKey(i)) { var f = c.caterpillars[i]; Consider(new AiTarget { kind = "prey", sub = "cat", key = key, i = i, c = ri + 20 }, new V3(f.x, f.y, f.z)); }
                    var baits = BaitsIn(key);
                    for (int i = 0; i < baits.Count; i++)
                    {
                        // a bait station smells of meat from a long way off
                        var b = baits[i];
                        Num s = Sqrt(D2(w, new V3(b.x, b.y, b.z))) - T.muni.aiLure + H32(w.id, i, ri + 70, day) * 12;
                        if (s < bs) { bs = s; best = new AiTarget { kind = "bait", key = key, i = i, c = ri + 70 }; }
                    }
                }
                else
                {
                    for (int i = 0; i < c.boxes.Count; i++) { var b = c.boxes[i]; if (b.wood && !b.hive) Consider(new AiTarget { kind = "wood", key = key, i = i, c = ri + 40 }, new V3((b.minx + b.maxx) / 2, b.maxy, (b.minz + b.maxz) / 2)); }
                }
            }
            if (best != null) { ai.target = best; ai.mode = "outbound"; } else ai.mode = "return";
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
            if (t.kind == "fruit") { foreach (var f in FruitIn(rec)) if (f.i == t.i) return new V3(f.x, f.y + 0.015, f.z); return null; }
            if (t.kind == "spill") { foreach (var sp in SpillsIn(t.key)) if (sp.i == t.i) return new V3(sp.x, sp.y + 0.012, sp.z); return null; }
            if (t.kind == "bait") { var bs = BaitsIn(t.key); return t.i < bs.Count ? new V3(bs[t.i].x, bs[t.i].y, bs[t.i].z) : (V3?)null; }
            if (t.kind == "wood") { var b = c.boxes[t.i]; return new V3((b.minx + b.maxx) / 2 + 0.2 * (H32(w.id, t.i) - 0.5), b.maxy + T.wasp.radius + 0.008, (b.minz + b.maxz) / 2); }
            if (t.sub == "fly") return (st.caughtFly.TryGetValue(t.i, out var cf) ? cf : 0) > tick ? (V3?)null : FlyPos(c.flies[t.i], tick);
            if (t.sub == "cat") { if (st.caughtCat.ContainsKey(t.i)) return null; var cp = c.caterpillars[t.i]; return new V3(cp.x, cp.y, cp.z); }
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

        /// After an AI sting: get out
        void AiAfterSting(Wasp w) { w.ai.stings--; w.ai.mode = "evade"; w.ai.until = w.ai.timer; w.ai.timer = tick + T.ai.evadeTicks; }
    }
}
