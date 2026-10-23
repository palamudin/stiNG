// The world around the wasps: humans, the exterminator, bees, perching, nest sites, fruit, webs, aerial hunters,
// landing and walking, municipal pest control, rival colonies, fights and the 1 Hz colony tick.
using System.Collections.Generic;
using static Sting.Core.R;
using static Sting.Core.World;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed partial class Sim
    {
        // ---------------- humans (GDD 8.2, 8.9, 8.10)

        // A sitter who jumps up jolts the table: the nearest drink on it may go over and become an open puddle of sugar.
        // Pure function of shared human state and the tick, so every peer spills the same can. Lidded drinks (level 2+) stay put.
        void Spill(Human hm)
        {
            string key = hm.chunk; var rec = records.Get(key);
            if (rec == null || EscLevel(key) >= 2) return;
            if (Unit(Hash(seed, Domain.HumanSchedule, hm.id, unchecked((ulong)tick * 2 + 1))) >= T.panic.spillChance) return;
            int best = -1; Num bd = T.panic.spillReach * T.panic.spillReach;
            var cans = rec.content.cans;
            for (int i = 0; i < cans.Count; i++) { Num d = Sq(cans[i].x - hm.x) + Sq(cans[i].z - hm.z); if (d < bd) { bd = d; best = i; } }
            if (best < 0) return;
            var st = CS(key); var sp = st.spilled ??= new Dictionary<int, Num>();
            if ((sp.TryGetValue(best, out var until) ? until : 0) > minute) return;
            sp[best] = minute + T.panic.spillMinutes;
            Emit("spill", ("key", key), ("i", best), ("humanHex", hm.hex));
        }

        /// Live puddles in a chunk: { x, y, z, rate, kind: 'spill', i }
        public List<Food> SpillsIn(string key)
        {
            var o = new List<Food>();
            if (!chunkState.TryGet(key, out var st) || st.spilled == null || !records.TryGet(key, out var rec)) return o;
            var ks = new List<int>(st.spilled.Keys); ks.Sort();
            foreach (var i in ks)
            {
                if (st.spilled[i] <= minute) continue;
                var c = rec.content.cans[i];
                o.Add(new Food { x = c.x + 0.06, y = 0.765, z = c.z, rate = T.panic.spillRate, kind = "spill", i = i });
            }
            return o;
        }
        public bool CanSpilled(string key, int i) => chunkState.TryGet(key, out var st) && st.spilled != null && st.spilled.TryGetValue(i, out var v) && v > minute;

        /// p: where the threat came from; null flees backwards. Never a live wasp position, so peers agree.
        void StartFlee(Human hm, LastSting p)
        {
            if (hm.posture == "sit") Spill(hm);
            Num dx = hm.x - (p != null ? p.x : hm.x - hm.fx), dz = hm.z - (p != null ? p.z : hm.z - hm.fz);
            Num d = Sqrt(dx * dx + dz * dz);
            if (d < 1e-6) { dx = -hm.fx; dz = -hm.fz; d = 1; }
            hm.dirX = dx / d; hm.dirZ = dz / d;
            hm.state = "flee";
            hm.posture = "stand";
            hm.fx = hm.dirX; hm.fz = hm.dirZ;
            hm.fleeSteps = RangeInt(Hash(seed, Domain.HumanSchedule, hm.id, unchecked((ulong)tick)), T.panic.fleeStepsMin, T.panic.fleeStepsMax);
            Emit("flee", ("humanHex", hm.hex));
        }

        static bool WalkTo(Human hm, Num tx, Num tz, Num speed)
        {
            Num step = 3 * T.DT * speed;
            Num dx = tx - hm.x, dz = tz - hm.z, d = Sqrt(dx * dx + dz * dz);
            if (d <= step) { hm.x = tx; hm.z = tz; return true; }
            hm.fx = dx / d; hm.fz = dz / d;
            hm.x += hm.fx * step; hm.z += hm.fz * step;
            return false;
        }

        void Humans()
        {
            var old = new Num[active.Count];
            for (int i = 0; i < old.Length; i++) old[i] = active[i].panic;
            Num r2 = T.panic.contagionRadius * T.panic.contagionRadius;
            long md = MinuteOfDay(minute);
            // active may be replaced inside the loop (the exterminator leaving); like the JS, keep indexing the live list
            for (int i = 0; i < active.Count; i++)
            {
                var hm = active[i];
                Num oldI = i < old.Length ? old[i] : Num.NaN;
                if (hm.special) { ExtStep(hm, oldI); continue; }
                // schedule
                var win = Window(hm);
                bool present = win != null && md >= win.arrive && md < win.leave;
                if (hm.state == "away")
                {
                    if (present)
                    {
                        hm.state = "arrive"; hm.posture = "stand"; hm.x = hm.home.ax; hm.z = hm.home.az; hm.panic = 0;
                        if (hm.clothesDay != day) { hm.clothing = Body.HumanClothing(seed, hm.id, day); hm.clothesDay = day; }
                        Emit("arrive", ("humanHex", hm.hex));
                    }
                    continue;
                }
                if (!present && hm.state != "leave") { hm.state = "leave"; hm.posture = "stand"; Emit("leave", ("humanHex", hm.hex)); }
                if (hm.state == "arrive") { if (WalkTo(hm, hm.home.x, hm.home.z, T.panic.walkSpeed)) Seat(hm); continue; }
                if (hm.state == "leave") { if (WalkTo(hm, hm.home.ax, hm.home.az, T.panic.walkSpeed)) GoAway(hm); continue; }
                // panic
                Num gain = 0;
                for (int j = 0; j < active.Count; j++)
                {
                    Num oj = j < old.Length ? old[j] : Num.NaN;
                    if (i == j || oj < T.panic.contagionMin) continue;
                    var o = active[j]; Num dx = o.x - hm.x, dz = o.z - hm.z;
                    if (dx * dx + dz * dz <= r2) gain += T.panic.contagionRate * oj * hm.tr.sociability * hm.tr.panicSusceptibility;
                }
                hm.panic = Min(1, oldI * T.panic.decayPerStep + gain);
                if (hm.state == "idle" && hm.panic >= T.resolve.fleePanic) StartFlee(hm, CS(hm.chunk).lastSting);
                if (hm.state == "flee")
                {
                    hm.x += hm.dirX * T.panic.fleeSpeed * 3 * T.DT; hm.z += hm.dirZ * T.panic.fleeSpeed * 3 * T.DT;
                    if (--hm.fleeSteps <= 0) hm.state = "return";
                }
                else if (hm.state == "return")
                {
                    if (hm.panic >= T.resolve.fleePanic) { StartFlee(hm, CS(hm.chunk).lastSting); continue; }
                    if (WalkTo(hm, hm.home.x, hm.home.z, T.panic.walkSpeed)) { Seat(hm); Emit("settled", ("humanHex", hm.hex)); }
                }
                else if (hm.state == "idle") Annoyance(hm);
            }
        }

        // Wasps hovering at a face or at food get swatted; level decides how hard (GDD 8.10)
        void Annoyance(Human hm)
        {
            if (hm.tr.style == Style.Freezer) return;
            if (hm.cooldown > tick) return;
            int lvl = EscAt(hm.x, hm.z);
            var head = hm.PartsNow[0];
            Wasp target = null; string why = null;
            foreach (var w in wasps)
            {
                if (!(w.state == "fly" || w.state == "chewing" || w.state == "landed")) continue;
                Num dx = w.x - hm.x, dz = w.z - hm.z;
                if (dx * dx + dz * dz > 4) continue;
                var lp = Body.ToLocal(hm.F, w.P);
                Num hd2 = D2(lp, head.a);
                if (hd2 < T.esc.faceRadius * T.esc.faceRadius) { target = w; why = "face"; break; }
                if (lvl >= 1 && hd2 < T.esc.headRadius * T.esc.headRadius) { target = w; why = "head"; break; }
                if (lvl >= 1 && (w.ai.atFood == "can" || (w.state == "landed" && NearCan(w))) && dx * dx + dz * dz < 1.5) { target = w; why = "food"; break; }
                if (lvl >= 3 && hm.tr.escalation >= T.esc.sprayTrait && lp.z > 0.1 && lp.z < T.esc.sprayRange && Abs(lp.x) < lp.z) { target = w; why = "spray"; break; }
            }
            if (target == null) { hm.annoy = 0; hm.annoyId = 0; return; }
            if (hm.annoyId != target.id) { hm.annoyId = target.id; hm.annoy = 0; }
            hm.annoy += 3;
            Num need = hm.tr.reactionTicks * (why == "face" ? 3 : T.esc.noticeMul) + (why == "spray" ? 20 : 0);
            if (hm.annoy < need) return;
            hm.annoy = 0;
            hm.cooldown = tick + T.esc.cooldownTicks;
            int start = tick + T.net.commitTicks + 1;
            if (why == "spray")
            {
                Publish(new NetEv { type = "spray", humanHex = hm.hex, start = start, end = start + T.esc.sprayTicks });
                return;
            }
            var tl = Body.ToLocal(hm.F, target.P);
            bool slap = lvl >= 1;
            int kind = slap ? SwatKind.Slap : SwatKind.Brush;
            Publish(new NetEv
            {
                type = "preSwat", humanHex = hm.hex, waspId = target.id, kind = kind, start = start, window = Body.WindowFor(kind), why = why,
                center = tl, radius = slap ? (hm.tr.style == Style.Precise ? 0.05 : 0.09) : T.resolve.brushRadius, kills = slap,
            });
        }

        // ---------------- the exterminator (GDD 8.10 level 4)

        public static Traits ExtTraits(ulong seed, ulong id)
        {
            var tr = Body.HumanTraits(seed, id);
            tr.height = 1.8; tr.armRatio = 1; tr.girth = 0.4; tr.reactionTicks = 12; tr.style = Style.Precise; tr.accuracy = 0.9; tr.panicSusceptibility = 0.45; tr.sociability = 0; tr.escalation = 1;
            return tr;
        }

        void ExtCheck()
        {
            if (!settings.exterminator) return;
            var e = ext; var col = colony;
            if (!col.nestAlive) return;
            if (e.state == "none" || e.state == "cancelled")
            {
                if (NestAreaLevel() >= T.ext.level)
                {
                    e.visit++;
                    long md = MinuteOfDay(minute);
                    e.arriveMinute = md < 15 * 60 && md >= T.time.dawn ? minute + 120 : (md >= T.time.dawn ? day + 1 : day) * 1440 + T.ext.arriveMinute;
                    e.state = "scheduled";
                    Emit("extScheduled", ("visit", e.visit), ("arriveMinute", e.arriveMinute));
                }
            }
            else if (e.state == "scheduled" && NestAreaLevel() < 3)
            {
                e.state = "cancelled";
                Emit("extCancelled", ("visit", e.visit));
            }
            else if (e.state == "scheduled" && minute >= e.arriveMinute)
            {
                ulong id = Hash(seed, Domain.WorldGen, 0xE77, (ulong)e.visit);
                string hex = Hex64(id);
                var tr = ExtTraits(seed, id);
                Num ang = H32(e.visit, 9) * 6.28318;
                var n = nest; Num dxn = n.x - n.treeX, dzn = n.z - n.treeZ, dn = Sqrt(dxn * dxn + dzn * dzn); if (dn == 0) dn = 1;
                Num ax = n.treeX + 30 * DCos(ang), az = n.treeZ + 30 * DSin(ang);
                Num gx = n.x + dxn / dn * 0.45, gz = n.z + dzn / dn * 0.45;
                e.hm = new Human
                {
                    id = id, hex = hex, @short = "EXT", tr = tr, special = true, clothing = Body.SuitClothing(e.visit > 1), chunk = nest.key,
                    home = new Home { x = gx, z = gz, fx = -dxn / dn, fz = -dzn / dn, posture = "stand", ax = ax, az = az },
                    x = ax, z = az, fx = 0, fz = 1, posture = "stand", state = "arrive",
                    sit = Body.BodyParts(tr, "sit"), stand = Body.BodyParts(tr, "stand"),
                };
                e.state = "active";
                Emit("extArrive", ("visit", e.visit), ("taped", e.visit > 1));
                UpdateChunks(true);
            }
        }

        int NestAreaLevel()
        {
            var (cx, cz) = SplitKey(nest.key);
            int lv = 0;
            for (int dz = -1; dz <= 1; dz++) for (int dx = -1; dx <= 1; dx++) lv = System.Math.Max(lv, EscLevel(ChunkKey(cx + dx, cz + dz)));
            return lv;
        }

        void ExtStep(Human hm, Num oldPanic)
        {
            var e = ext;
            hm.panic = Max(0, oldPanic * T.panic.decayPerStep);
            if (hm.state == "flee" || hm.state == "leave")
            {
                if (hm.state == "flee") { hm.x += hm.dirX * T.panic.fleeSpeed * 3 * T.DT; hm.z += hm.dirZ * T.panic.fleeSpeed * 3 * T.DT; if (--hm.fleeSteps <= 0) hm.state = "leave"; }
                else if (WalkTo(hm, hm.home.ax, hm.home.az, T.ext.speed)) ExtGone();
                return;
            }
            if (hm.panic >= T.ext.minPanicAbort) { StartFlee(hm, CS(nest.key).lastSting); Emit("extAbort", ("visit", e.visit)); return; }
            if (hm.state == "arrive")
            {
                if (WalkTo(hm, hm.home.x, hm.home.z, T.ext.speed)) { hm.state = "treat"; hm.fx = hm.home.fx; hm.fz = hm.home.fz; hm.treat = 0; Emit("extTreat"); }
            }
            else if (hm.state == "treat")
            {
                hm.treat += 3;
                if (hm.treat >= T.ext.treatTicks)
                {
                    int outside = Own().Count;
                    Num died = Max(0, colony.adults - outside);
                    Colony.DestroyNest(colony);
                    colony.adults = outside;
                    colony.stats.died += died;
                    Emit("nestDestroyed", ("died", Floor(died)));
                    hm.state = "leave";
                }
            }
        }

        void ExtGone()
        {
            var e = ext;
            e.hm = null;
            if (colony.nestAlive)
            {
                e.state = "scheduled";
                e.visit++;
                e.arriveMinute = (day + 1) * 1440 + T.ext.arriveMinute;
                Emit("extScheduled", ("visit", e.visit), ("arriveMinute", e.arriveMinute));
            }
            else e.state = "done";
            UpdateChunks(true);
        }

        // ---------------- bees (GDD 9.2)

        void AlarmHive(string key, int h, WaspBase w, Num radius, bool fromRemote = false)
        {
            var rec = records.Get(key); var hv = rec.content.hives[h];
            string k = key + "#" + h;
            var al = hiveAlarms.Get(k);
            if (!fromRemote && (al == null || al.target != w.id)) Publish(new NetEv { type = "beeAlarm", key = key, h = h, target = w.id, radius = radius });
            if (al == null) { al = new HiveAlarm { key = key, h = h, target = w.id, until = 0 }; hiveAlarms.Set(k, al); Emit("beeAlarm", ("key", key), ("h", h), ("waspId", w.id)); }
            al.target = w.id;
            al.until = tick + T.bees.alarmTicks;
            CS(key).beeLost.TryGetValue(h, out var lost);
            for (int b = 0; b < hv.bees.Count; b++)
            {
                if (al.phys.ContainsKey(b) || (lost != null && lost.ContainsKey(b))) continue;
                var p = BeePos(hv, b, tick);
                bool nearHive = Sq(w.x - hv.ex) + Sq(w.z - hv.ez) < Sq(T.bees.hiveAlarmRadius);
                if (D2(p, w.P) < radius * radius || (hv.bees[b].guard && nearHive)) al.phys[b] = new BeePhys { x = p.x, y = p.y, z = p.z, mode = "pursue" };
            }
        }

        void Bees()
        {
            // entrance guard check for every active hive
            foreach (var rec in activeChunks)
            {
                string key = ChunkKey(rec.cx, rec.cz);
                var hives = rec.content.hives;
                for (int h = 0; h < hives.Count; h++)
                {
                    var hv = hives[h];
                    foreach (var w in wasps)
                    {
                        if (w.state != "fly" && w.state != "chewing" && w.state != "landed") continue;
                        Num dx = w.x - hv.ex, dy = w.y - hv.ey, dz = w.z - hv.ez;
                        if (dx * dx + dy * dy + dz * dz < Sq(T.bees.entranceAlarm)) { AlarmHive(key, h, w, 2); break; }
                    }
                }
            }
            if (hiveAlarms.Count == 0) return;
            Num agg = settings.beeAggression;
            var attached = new OrderedMap<int, int>();
            foreach (var kv in hiveAlarms)
            {
                var al = kv.Value;
                var rec = records.Get(al.key); var hv = rec.content.hives[al.h];
                var target = AnyWasp(al.target);
                if (target != null && D2(target, new V3(hv.ex, hv.ey, hv.ez)) < 15 * 15 && target.state != "dead") al.until = Max(al.until, tick + 60);
                bool ending = tick > al.until || target == null;
                bool any = false;
                foreach (var b in new List<int>(al.phys.Keys))
                {
                    var p = al.phys[b];
                    any = true;
                    if (p.stun > 0) { p.stun--; p.vy -= 3 * T.DT; p.x += p.vx * T.DT; p.y = Max(0.01, p.y + p.vy * T.DT); p.z += p.vz * T.DT; continue; }
                    if (p.mode == "ball")
                    {
                        if (target == null || ending || (WaspById(target.id) != null && target.state != "balled")) { p.mode = "return"; continue; }
                        p.x = target.x; p.y = target.y; p.z = target.z;
                        attached.Set(target.id, attached.Get(target.id) + 1);
                        continue;
                    }
                    Num tx, ty, tz;
                    if (p.mode == "pursue" && target != null && !ending && (target.state == "fly" || target.state == "stunned" || target.state == "chewing" || target.state == "balled"))
                    {
                        tx = target.x; ty = target.y; tz = target.z;
                    }
                    else
                    {
                        p.mode = "return";
                        var q = BeePos(hv, b, tick); tx = q.x; ty = q.y; tz = q.z;
                        if (D2(new V3(p.x, p.y, p.z), q) < 0.01) { al.phys.Remove(b); continue; }
                    }
                    Num dx = tx - p.x, dy = ty - p.y, dz = tz - p.z;
                    Num d = Sqrt(dx * dx + dy * dy + dz * dz); if (d == 0 || d.IsNaN) d = 1;
                    Num sp = T.bees.pursueSpeed * (0.9 + 0.2 * agg);
                    dx = dx / d * sp - p.vx; dy = dy / d * sp - p.vy; dz = dz / d * sp - p.vz;
                    Num dl = Sqrt(dx * dx + dy * dy + dz * dz), amax = T.bees.accel * T.DT;
                    if (dl > amax) { dx *= amax / dl; dy *= amax / dl; dz *= amax / dl; }
                    p.vx += dx; p.vy += dy; p.vz += dz;
                    p.x += p.vx * T.DT; p.y += p.vy * T.DT; p.z += p.vz * T.DT;
                    if (p.mode == "pursue" && target != null && d < T.bees.contact + 0.01) { p.mode = "ball"; attached.Set(target.id, attached.Get(target.id) + 1); }
                }
                if (!any && ending) hiveAlarms.Delete(kv.Key);
            }
            // balls: heat the wasp (GDD 9.2)
            foreach (var kv in attached)
            {
                int n = kv.Value;
                var w = WaspById(kv.Key);
                if (w == null) continue;
                if (w.state != "balled" && n >= T.bees.ballMin && w.state != "under" && w.state != "trapped")
                {
                    if (w.state == "attached") Detach(w, "balled");
                    w.state = "balled"; w.ball = new Ball { temp = T.bees.startTemp, progress = 0, prevBurst = 0 }; w.vx = w.vy = w.vz = 0;
                    Emit("balled", ("id", w.id), ("driven", w.id == drivenId));
                }
                if (w.state != "balled") continue;
                w.ball.bees = n;
                w.ball.temp += T.bees.heatPerBeeSec * n * T.DT * agg;
                w.y = Max(T.wasp.radius, w.y - 0.05 * T.DT);
                if (w.ball.temp >= T.bees.lethal) { Die(w, "cooked by bees", null); continue; }
            }
        }

        /// Burst presses break out of a ball (driven wasp); AI wasps get a small chance each tick
        void BallEscape(Wasp w, bool burstEdge)
        {
            if (w.state != "balled") return;
            Num n = Max(1, w.ball.bees != 0 ? w.ball.bees : T.bees.ballMin);
            if (burstEdge) w.ball.progress += T.bees.escapePerPress / (n * 0.2);
            if (w.id != drivenId && H32(w.id, tick, 11) < 0.004) w.ball.progress = 1;
            if (w.ball.progress >= 1)
            {
                w.state = "fly"; w.ball = null; w.vy = 2.5; w.vx = (H32(w.id, tick) - 0.5) * 3; w.vz = (H32(tick, w.id) - 0.5) * 3;
                foreach (var al in hiveAlarms.Values) foreach (var kv in al.phys)
                    {
                        var p = kv.Value; int b = kv.Key;
                        if (p.mode == "ball") { p.mode = "pursue"; p.stun = 45; p.vx = (H32(b, tick) - 0.5) * 2; p.vy = 0; p.vz = (H32(tick, b) - 0.5) * 2; }
                    }
                Emit("ballEscape", ("id", w.id));
            }
        }

        void ReleaseBees(int id)
        {
            foreach (var al in hiveAlarms.Values) if (al.target == id) al.until = Min(al.until, tick);
        }

        void AlarmDecay() { if (alarms.Count > 0) alarms = alarms.FindAll(a => a.until > tick); }

        // ---------------- perching and crawling on people (GDD 7.2, 8.3)

        Num TickleNeed(Human hm, int zone)
        {
            int cover = Body.ZoneCover(hm.clothing, zone);
            Num k = T.perch.tickleBase * (cover == 2 ? T.perch.thinMul * 1.5 : cover == 1 ? T.perch.thinMul : T.perch.bareMul);
            if (zone == Zone.UpperBack || zone == Zone.Acnestis || zone == Zone.LowerBack || zone == Zone.Buttocks) k *= T.perch.backMul;
            if (zone == Zone.Face || zone == Zone.Ears || zone == Zone.NeckFront) k *= T.perch.faceMul;
            return Max(T.resolve.minConsequenceTicks, Rnd(hm.tr.reactionTicks * k));
        }

        void PerchOn(Wasp w, string humanHex, int zone, V3 surf, V3 n, string part)
        {
            var hm = HumanByHex(humanHex);
            if (hm == null) return;
            Num R = T.wasp.radius;
            w.state = "perched"; w.vx = w.vy = w.vz = 0;
            w.perch = new Perch { hex = hm.hex, posture = hm.posture, local = new V3(surf.x + n.x * R, surf.y + n.y * R, surf.z + n.z * R), n = n, surf = surf, zone = zone, part = part, tickle = 0, need = TickleNeed(hm, zone), quietUntil = 0 };
            Emit("perch", ("id", w.id), ("humanHex", hm.hex), ("zone", zone));
        }

        /// Put a local point back on the nearest body surface
        (string part, V3 n, V3 surf, V3 local, int zone) OnBody(Human hm, V3 lp)
        {
            Part best = null; SegQ bq = default; V3 bn = default; Num bd = Num.MaxValue;
            foreach (var part in hm.PartsNow)
            {
                var q = Body.SegClosest(part.a, part.b, lp);
                Num ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z, d = Sqrt(ex * ex + ey * ey + ez * ez); if (d == 0) d = 1e-9;
                Num gap = d - part.r;
                if (gap < bd) { bd = gap; best = part; bq = q; bn = new V3(ex / d, ey / d, ez / d); }
            }
            Num R = T.wasp.radius;
            var surf = new V3(bq.x + bn.x * best.r, bq.y + bn.y * best.r, bq.z + bn.z * best.r);
            return (best.name, bn, surf, new V3(surf.x + bn.x * R, surf.y + bn.y * R, surf.z + bn.z * R), Body.Classify(best, bq, bn, surf, hm.tr.height / 1.75));
        }

        void PerchStep(Wasp w, Cmd cmd, int edge, bool armed, bool driven)
        {
            var p = w.perch; var hm = HumanByHex(p.hex);
            if (hm == null || hm.state == "away" || hm.posture != p.posture) { w.perch = null; w.state = "stunned"; w.stateTicks = 20; w.vy = 0.3; Emit("knockedOff", ("id", w.id)); return; }
            if (!driven || cmd.burst != 0 || cmd.my > 0)
            { // take off
                var n = Body.DirToWorld(hm.F, p.n);
                w.perch = null; w.state = "fly"; w.vx = n.x * 0.6; w.vy = n.y * 0.6 + 0.4; w.vz = n.z * 0.6;
                Emit("takeoff", ("id", w.id));
                return;
            }
            bool moving = false;
            if (cmd.mx != 0 || cmd.mz != 0)
            {
                // crawl relative to the camera, projected onto the skin
                Num yaw = cmd.yawQ * 1e-4, sy = DSin(yaw), cy = DCos(yaw);
                Num mz = (Num)cmd.mz / 100, mx = (Num)cmd.mx / 100, sp = T.perch.crawlSpeed * T.DT;
                Num wx = (sy * mz - cy * mx) * sp, wz = (cy * mz + sy * mx) * sp;
                Num lwx = hm.fz * wx - hm.fx * wz, lwz = hm.fx * wx + hm.fz * wz; // world delta -> body frame
                Num pitch = cmd.pitchQ * 1e-4;
                var nl = new V3(p.local.x + lwx, p.local.y + mz * sp * DSin(pitch) * 2, p.local.z + lwz);
                var c = OnBody(hm, nl);
                p.local = c.local; p.n = c.n; p.surf = c.surf; p.zone = c.zone; p.part = c.part;
                p.need = TickleNeed(hm, c.zone);
                moving = true;
            }
            var at = Body.ToWorld(hm.F, p.local);
            w.x = at.x; w.y = at.y; w.z = at.z;
            if ((edge & Act.Interact) != 0)
            {
                var nodes = UnderNodes(hm);
                int best = -1; Num bd = T.under.openingRadius * T.under.openingRadius;
                for (int i = 0; i < nodes.Count; i++) if (nodes[i].opening) { Num q = D2(nodes[i].pos, p.local); if (q <= bd) { bd = q; best = i; } }
                if (best >= 0) { w.perch = null; w.state = "fly"; EnterUnder(w, hm.hex, best); return; }
            }
            if (armed)
            {
                pressUsed = true;
                var c = new Contact { humanHex = hm.hex, zone = p.zone, surf = p.surf, n = p.n, blocked = Body.ZoneCover(hm.clothing, p.zone) == 2 };
                w.perch = null; w.state = "fly";
                if (!BeginSting(w, c, "jab")) PerchOn(w, hm.hex, c.zone, c.surf, c.n, "");
                return;
            }
            // they start to feel the feet on their skin
            if (tick >= p.quietUntil)
            {
                p.tickle += moving ? T.perch.movingMul : 1;
                if (p.tickle >= p.need)
                {
                    p.tickle = 0; p.quietUntil = tick + T.perch.cooldown;
                    var comps = Companions(hm);
                    var plan = Body.ResolveSting(new StingIn { contactTick = tick, contactPointBody = p.surf, mode = "touch" }, hm.tr, Body.ZONES[p.zone],
                        new StingCtx { clothingStiffness = hm.clothing.stiffness, panic = hm.panic, companions = comps, stung = hm.stungCount });
                    Publish(new NetEv { type = "notice", humanHex = hm.hex, waspId = w.id, zone = p.zone, swats = SwatsOut(plan, hm, comps) });
                }
            }
        }

        // ---------------- founding a nest (GDD 6.6)

        Tree TrunkNear(Wasp w)
        {
            foreach (var rec in activeChunks) foreach (var t in rec.content.trees)
                {
                    Num dx = w.x - t.x, dz = w.z - t.z, d = Sqrt(dx * dx + dz * dz) - t.r;
                    if (d <= 0.06 && w.y > 0.8 && w.y < t.h) return t;
                }
            return null;
        }

        public sealed class Sites { public List<V3> holes = new List<V3>(); public List<(V3 p, Tree t)> branches = new List<(V3, Tree)>(); }
        readonly Dictionary<string, Sites> siteCache = new Dictionary<string, Sites>();
        readonly Dictionary<string, List<Food>> fruitCache = new Dictionary<string, List<Food>>();
        readonly Dictionary<string, List<Bait>> baitCache = new Dictionary<string, List<Bait>>();

        /// Candidate nest sites around the queen (GDD 6.6). Burrows and branch points are derived from the seed and the
        /// chunk's frozen content, so they cost nothing to store and every peer sees the same ones.
        public Sites SitesIn(ChunkRec rec)
        {
            string key = ChunkKey(rec.cx, rec.cz);
            if (siteCache.TryGetValue(key, out var hit)) return hit;
            Num CSz = T.chunk.size, sd = seed & 0xffffffffUL;
            var o = new Sites();
            // h32 reads four arguments; the JS passes a fifth that it ignores, kept so both sides agree
            for (int i = 0; i < T.sites.holesPerChunk; i++)
            {
                Num x = (rec.cx + (H32(sd, rec.cx, rec.cz, i) - 0.5) * 0.8) * CSz, z = (rec.cz + (H32(sd, rec.cx, rec.cz, i) - 0.5) * 0.8) * CSz;
                o.holes.Add(new V3(x, 0, z));
            }
            var trees = rec.content.trees;
            for (int i = 0; i < trees.Count; i++)
            {
                var t = trees[i];
                Num a = H32(sd, rec.cx, rec.cz, i) * 6.28318, d = t.cr * 0.55;
                o.branches.Add((new V3(t.x + d * DCos(a), Max(1.8, t.h - t.cr * 0.7), t.z + d * DSin(a)), t));
            }
            if (siteCache.Count > 64) siteCache.Clear();
            siteCache[key] = o;
            return o;
        }

        /// Windfall fruit under fruit trees from mid-season (GDD 9.4). Each fruit falls on a day picked by hash and lies
        /// for a few days; a pure function of the seed, the chunk and the clock.
        public List<Food> FruitIn(ChunkRec rec)
        {
            Num frac = SeasonFrac;
            if (frac < T.fruit.startFrac) return new List<Food>();
            Num sd = seed & 0xffffffffUL; string key = ChunkKey(rec.cx, rec.cz); long today = day;
            string ck = key + "|" + today + "|" + season.n;
            if (fruitCache.TryGetValue(ck, out var hit)) return hit;
            var o = new List<Food>(); Num span = 1 - T.fruit.startFrac;
            var trees = rec.content.trees;
            for (int ti = 0; ti < trees.Count; ti++)
            {
                var t = trees[ti];
                if (H32(sd, rec.cx, rec.cz, ti) >= T.fruit.treeShare) continue;
                for (int k = 0; k < T.fruit.perTree; k++)
                {
                    Num fall = Floor(season.startMinute / 1440 + settings.seasonDays * (T.fruit.startFrac + span * H32(sd, rec.cx, rec.cz, ti)));
                    if (today < fall || today >= fall + T.fruit.rotDays) continue;
                    Num a = H32(sd, ti, k, 933) * 6.28318, d = t.r + 0.2 + T.fruit.spread * H32(sd, ti, k, 934);
                    o.Add(new Food { x = t.x + d * DCos(a), y = 0.03, z = t.z + d * DSin(a), rate = T.fruit.rate, kind = "fruit", i = ti * 16 + k });
                }
            }
            if (fruitCache.Count > 128) fruitCache.Clear();
            fruitCache[ck] = o;
            return o;
        }

        SiteHit SiteNear(Wasp w)
        {
            foreach (var rec in activeChunks)
            {
                var s = SitesIn(rec);
                foreach (var h in s.holes) if (w.y < 0.3 && Sq(w.x - h.x) + Sq(w.z - h.z) < 0.12 * 0.12) return new SiteHit { type = "ground", x = h.x, z = h.z };
                foreach (var (b, t) in s.branches) if (D2(w, b) < 0.15 * 0.15) return new SiteHit { type = "branch", x = b.x, y = b.y, z = b.z, t = t };
                foreach (var sh in rec.content.sheds)
                {
                    var ss = ShedSites(sh);
                    foreach (var (type, p) in new[] { ("wall", ss.wall), ("attic", ss.attic) })
                        if (D2(w, new V3(p.x, p.y, p.z)) < 0.14 * 0.14) return new SiteHit { type = type, x = p.x, y = p.y, z = p.z, ix = p.ix, iz = p.iz, nx = p.nx, nz = p.nz };
                }
            }
            var tr = TrunkNear(w);
            return tr != null ? new SiteHit { type = "trunk", t = tr } : null;
        }

        void FoundNest(Wasp w, SiteHit site)
        {
            if (site.type == "ground") nest = MakeNest(site.x - 0.5, site.z, site.x, -0.25, site.z, NEST.r, "ground");
            else if (site.type == "wall" || site.type == "attic") nest = MakeNest(site.ix, site.iz, site.x, site.y, site.z, NEST.r, site.type);
            else if (site.type == "branch") nest = MakeNest(site.t.x, site.t.z, site.x, site.y - NEST.r * 1.3, site.z, NEST.r, "branch");
            else
            {
                var t = site.t;
                Num dx = w.x - t.x, dz = w.z - t.z;
                Num d = Sqrt(dx * dx + dz * dz); if (d == 0) d = 1;
                dx /= d; dz /= d;
                Num y = Clamp(w.y, 1.2, Max(1.2, t.h - 0.6));
                nest = MakeNest(t.x, t.z, t.x + dx * (t.r + 0.2), y, t.z + dz * (t.r + 0.2), NEST.r, "trunk");
            }
            colony.sited = true;
            colony.maxCells = T.sites.Of(nest.site).maxCells;
            w.x = nest.spawn.x; w.y = nest.spawn.y; w.z = nest.spawn.z; w.vx = w.vy = w.vz = 0;
            Emit("nestFounded", ("x", nest.x), ("y", nest.y), ("z", nest.z), ("key", nest.key), ("site", nest.site));
        }

        // ---------------- predators (GDD 9.3)

        /// A wasp that flies through a web sticks where it crossed the web's plane
        void WebCheck(Wasp w, V3 p0)
        {
            if (w.state != "fly" && w.state != "stunned") return;
            foreach (var rec in activeChunks)
            {
                var webs = rec.content.webs;
                if (webs.Count == 0) continue;
                var st = CS(ChunkKey(rec.cx, rec.cz));
                for (int i = 0; i < webs.Count; i++)
                {
                    var wb = webs[i];
                    if (st.webTorn != null && st.webTorn.TryGetValue(i, out var td) && td == day) continue;
                    Num d0 = (p0.x - wb.x) * wb.nx + (p0.z - wb.z) * wb.nz, d1 = (w.x - wb.x) * wb.nx + (w.z - wb.z) * wb.nz;
                    if (d0 * d1 > 0 && Abs(d1) > T.wasp.radius) continue;
                    Num t = d0 == d1 ? 1 : Clamp(d0 / (d0 - d1), 0, 1);
                    var q = new V3(p0.x + (w.x - p0.x) * t, p0.y + (w.y - p0.y) * t, p0.z + (w.z - p0.z) * t);
                    Num dx = q.x - wb.x, dy = q.y - wb.y, dz = q.z - wb.z;
                    Num r2 = dx * dx + dy * dy + dz * dz;
                    if (r2 > wb.r * wb.r) continue;
                    w.x = q.x; w.y = q.y; w.z = q.z; w.vx = w.vy = w.vz = 0;
                    w.state = "webbed";
                    w.web = new WebHold { key = ChunkKey(rec.cx, rec.cz), i = i, progress = 0, prevBurst = 1, start = tick, spiderAt = tick + T.web.spiderDelay + Ceil(Sqrt(r2) / T.web.spiderSpeed * 60) };
                    if (w.attach != null) w.attach = null;
                    Emit("webbed", ("id", w.id), ("driven", w.id == drivenId), ("spiderAt", w.web.spiderAt));
                    return;
                }
            }
        }

        void WebStep(Wasp w, Cmd cmd, bool driven)
        {
            var wb = w.web;
            if (driven) { if (cmd.burst != 0 && wb.prevBurst == 0) wb.progress += T.web.escapePerPress; wb.prevBurst = cmd.burst; }
            else if (H32(w.id, tick, 41) < T.web.aiEscape) wb.progress = 1;
            if (wb.progress >= 1)
            {
                var st = CS(wb.key);
                (st.webTorn ??= new Dictionary<int, long>())[wb.i] = day;
                w.web = null; w.state = "stunned"; w.stateTicks = 15; w.vy = 0.4;
                Emit("webEscape", ("id", w.id));
                return;
            }
            if (tick >= wb.spiderAt) Die(w, "eaten by a spider", null);
        }

        /// Canopy cover: a tree crown overhead hides a wasp from birds
        bool UnderCanopy(WaspBase w)
        {
            foreach (var rec in activeChunks) foreach (var t in rec.content.trees)
                {
                    Num dx = w.x - t.x, dz = w.z - t.z;
                    if (dx * dx + dz * dz < t.cr * t.cr && w.y < t.h + t.cr) return true;
                }
            return false;
        }

        void Birds()
        {
            if (!settings.birds) return;
            Hunters(c => c.birds, BirdPos, T.bird, birdState, w => w.y >= T.bird.minY, t => t.y < T.bird.abortY, "taken by a bird", "bird", 6);
        }

        /// Dragonflies hunt the low air birds leave alone; landing, perching or ducking under a canopy is safe (GDD 9.3)
        void Dragonflies()
        {
            if (!settings.birds) return;
            Hunters(c => c.dragonflies, DragonPos, T.dragon, dragonState, w => w.y <= T.dragon.maxY, t => t.y > T.dragon.maxY + 0.5, "taken by a dragonfly", "dragon", 4);
        }

        /// One code path for every aerial hunter: patrol a pure-function loop, pick a flying wasp in sight, chase it with a
        /// capped acceleration (so sharp turns escape), give up after a while, then cool off and return to the loop.
        void Hunters(System.Func<ChunkContent, List<Patrol>> list, System.Func<Patrol, Num, V3> posFn, T.Hunter B, OrderedMap<string, HunterState> states,
            System.Func<Wasp, bool> canSee, System.Func<Wasp, bool> abort, string cause, string ev, Num cruise)
        {
            foreach (var rec in activeChunks)
            {
                string key = ChunkKey(rec.cx, rec.cz);
                var pl = list(rec.content);
                for (int i = 0; i < pl.Count; i++)
                {
                    var bd = pl[i];
                    string k = key + "#" + i;
                    var st = states.Get(k);
                    if (st == null)
                    {
                        if (tick % 6 != i % 6) continue;
                        var p = posFn(bd, tick);
                        Wasp target = null; Num best = B.sight * B.sight;
                        foreach (var w in wasps)
                        {
                            if (w.state != "fly" || !canSee(w)) continue;
                            Num q = D2(w, p);
                            if (q < best && !UnderCanopy(w)) { best = q; target = w; }
                        }
                        if (target == null) continue;
                        Num d0 = Sqrt(best); if (d0 == 0) d0 = 1;
                        st = new HunterState { mode = "dive", x = p.x, y = p.y, z = p.z, vx = (target.x - p.x) / d0 * 3, vy = (target.y - p.y) / d0 * 3, vz = (target.z - p.z) / d0 * 3, target = target.id, until = tick + B.diveTicks };
                        states.Set(k, st);
                        Emit(ev + "Dive", ("key", key), ("i", i), ("target", target.id), ("driven", target.id == drivenId));
                        continue;
                    }
                    Num tx, ty, tz, speed = B.speed;
                    if (st.mode == "dive")
                    {
                        var t = WaspById(st.target);
                        if (t == null || t.state != "fly" || abort(t) || tick > st.until || UnderCanopy(t))
                        {
                            st.mode = "cool"; st.until = tick + B.coolTicks;
                            if (t != null && t.id == drivenId) Emit(ev + "Miss", ("id", t.id));
                            continue;
                        }
                        tx = t.x; ty = t.y; tz = t.z;
                        if (D2(new V3(st.x, st.y, st.z), t.P) < B.@catch * B.@catch) { Die(t, cause, null); st.mode = "cool"; st.until = tick + B.coolTicks; continue; }
                    }
                    else
                    {
                        var p = posFn(bd, tick);
                        tx = p.x; ty = p.y; tz = p.z; speed = cruise;
                        if (D2(new V3(st.x, st.y, st.z), p) < 0.25 || tick > st.until + 900) { states.Delete(k); continue; }
                    }
                    Num dx = tx - st.x, dy = ty - st.y, dz = tz - st.z;
                    Num d = Sqrt(dx * dx + dy * dy + dz * dz); if (d == 0) d = 1;
                    dx = dx / d * speed - st.vx; dy = dy / d * speed - st.vy; dz = dz / d * speed - st.vz;
                    Num dl = Sqrt(dx * dx + dy * dy + dz * dz), amax = B.accel * T.DT;
                    if (dl > amax) { dx *= amax / dl; dy *= amax / dl; dz *= amax / dl; }
                    st.vx += dx; st.vy += dy; st.vz += dz;
                    st.x += st.vx * T.DT; st.y = Max(0.3, st.y + st.vy * T.DT); st.z += st.vz * T.DT;
                }
            }
        }

        // ---------------- landing (GDD 7.2)

        string SurfaceBelow(Wasp w)
        {
            Num R = T.wasp.radius, g = T.land.gap;
            if (w.y <= R + g) return "ground";
            foreach (var rec in activeChunks) foreach (var b in rec.content.boxes)
                {
                    if (w.x < b.minx || w.x > b.maxx || w.z < b.minz || w.z > b.maxz) continue;
                    if (Abs(w.y - (b.maxy + R)) <= g) return b.hive ? "hive" : "wood";
                }
            return null;
        }

        void MaybeLand(Wasp w, Cmd cmd)
        {
            if (cmd.mx != 0 || cmd.my != 0 || cmd.mz != 0 || cmd.burst != 0 || cmd.sting != 0) return;
            if (w.vx * w.vx + w.vy * w.vy + w.vz * w.vz > T.land.maxSpeed * T.land.maxSpeed) return;
            if (w.contact != null) { var c = w.contact; PerchOn(w, c.humanHex, c.zone, c.surf, c.n, c.part); return; }
            string surf = SurfaceBelow(w);
            if (surf == null) return;
            w.state = "landed"; w.vx = w.vy = w.vz = 0;
            Emit("landed", ("id", w.id), ("surface", surf));
        }

        void Takeoff(Wasp w) { w.state = "fly"; w.vy = 0.5; w.walking = false; Emit("takeoff", ("id", w.id)); }

        /// Walk camera-relative across the surface the wasp stands on. Off the edge it drops into flight;
        /// the sides of boxes and tree trunks stop it.
        void Walk(Wasp w, Cmd cmd)
        {
            Num yaw = cmd.yawQ * 1e-4, sy = DSin(yaw), cy = DCos(yaw);
            Num mz = (Num)cmd.mz / 100, mx = (Num)cmd.mx / 100, sp = T.land.walkSpeed * T.DT;
            Num nx = w.x + (sy * mz - cy * mx) * sp, nz = w.z + (cy * mz + sy * mx) * sp;
            Num R = T.wasp.radius;
            foreach (var rec in activeChunks)
            {
                foreach (var b in rec.content.boxes)
                {
                    if (nx < b.minx - R || nx > b.maxx + R || nz < b.minz - R || nz > b.maxz + R) continue;
                    if (w.y > b.miny && w.y < b.maxy) return; // blocked by the side
                }
                foreach (var t in rec.content.trees) { Num dx = nx - t.x, dz = nz - t.z; if (dx * dx + dz * dz < Sq(t.r + R)) return; }
            }
            w.x = nx; w.z = nz; w.yaw = yaw; w.walking = true;
            // walking into a person climbs onto them (an arm on the table, a leg on the grass)
            ContactQuery(w);
            if (w.contact != null) { w.walking = false; var c = w.contact; PerchOn(w, c.humanHex, c.zone, c.surf, c.n, c.part); return; }
            w.contact = null;
            if (SurfaceBelow(w) == null) { w.state = "fly"; w.walking = false; w.vy = 0; Emit("walkOff", ("id", w.id)); }
        }

        // ---------------- level 5: municipal pest control (GDD 8.10)

        /// Runs first in every colony tick on every peer. It reads only shared state (chunk escalation and the clock),
        /// so every peer starts and ends a campaign on the same tick.
        void MuniTick()
        {
            if (!settings.pestControl) return;
            var m = muni ??= new Muni();
            if (m.active != null)
            {
                if (minute >= m.active.until)
                {
                    foreach (var k in m.active.keys) if (chunkState.TryGet(k, out var st)) st.esc *= T.muni.aftermath;
                    Emit("muniEnd", ("n", m.active.n), ("keys", m.active.keys));
                    m.active = null; m.cooldownUntil = minute + T.muni.cooldownDays * 1440;
                }
                else MuniAbstract();
                return;
            }
            if (minute < m.cooldownUntil) return;
            var keys = new List<string>(chunkState.Keys); keys.Sort(Ordinal);
            foreach (var k in keys)
            {
                if (EscLevel(k) < T.muni.level) continue;
                var (cx, cz) = SplitKey(k); var area = new List<string>();
                for (int dz = -T.muni.radius; dz <= T.muni.radius; dz++) for (int dx = -T.muni.radius; dx <= T.muni.radius; dx++) area.Add(ChunkKey(cx + dx, cz + dz));
                m.n++;
                m.active = new MuniCampaign { n = m.n, center = k, keys = area, until = minute + T.muni.days * 1440 };
                Emit("muniStart", ("n", m.n), ("center", k), ("keys", area), ("until", m.active.until));
                return;
            }
        }

        /// Bait stations hang on tree trunks at chest height, picked by hash from the chunk's trees
        List<Bait> BaitsIn(string key)
        {
            var m = muni;
            if (m == null || m.active == null || !m.active.keys.Contains(key)) return new List<Bait>();
            if (!records.TryGet(key, out var rec)) return new List<Bait>();
            string ck = m.active.n + "|" + key;
            if (baitCache.TryGetValue(ck, out var hit)) return hit;
            var trees = new List<(Tree t, Num h)>();
            for (int i = 0; i < rec.content.trees.Count; i++) trees.Add((rec.content.trees[i], H32(m.active.n, rec.cx, rec.cz, i)));
            Stable.Sort(trees, (a, b) => Stable.Sign(a.h - b.h));
            var o = new List<Bait>();
            for (int i = 0; i < trees.Count && i < T.muni.baitsPerChunk; i++)
            {
                var (t, h) = trees[i];
                Num a = h * 6.28318, r = t.r + 0.03;
                o.Add(new Bait { x = t.x + r * DCos(a), y = T.muni.baitHeight, z = t.z + r * DSin(a), key = key });
            }
            if (baitCache.Count > 64) baitCache.Clear();
            baitCache[ck] = o;
            return o;
        }

        public List<Bait> MuniBaits()
        {
            var o = new List<Bait>();
            if (muni == null || muni.active == null) return o;
            foreach (var r in activeChunks) o.AddRange(BaitsIn(ChunkKey(r.cx, r.cz)));
            return o;
        }

        Bait BaitNear(Wasp w)
        {
            Num r2 = T.muni.baitDist * T.muni.baitDist;
            foreach (var b in MuniBaits()) if (D2(w, new V3(b.x, b.y, b.z)) <= r2) return b;
            return null;
        }

        void TakeBait(Wasp w)
        {
            w.carry = new Carry { kind = "protein", amount = T.muni.baitProtein, what = "bait", poison = true };
            Emit("baitTaken", ("id", w.id), ("driven", w.id == drivenId));
        }

        /// A poisoned load reaches the nest: it is fed to larvae and shared with adults
        void Poison(Num amount, int byId)
        {
            var col = colony;
            Num inside = Max(0, col.adults - OwnWorkers());
            Num adults = Min(inside, col.adults * T.muni.poisonAdults * amount);
            Num lf = Min(1, T.muni.poisonLarvae * amount), larvae = col.larvae * lf + col.rLarvae * lf;
            col.adults -= adults; col.larvae -= col.larvae * lf; col.rLarvae -= col.rLarvae * lf;
            col.stats.poisoned += adults + larvae;
            Emit("poisoned", ("id", byId), ("adults", adults), ("larvae", larvae));
        }

        /// Abstract foragers in a baited area bring poison home too, in proportion to how hard they hunt protein
        void MuniAbstract()
        {
            var m = muni; var col = colony;
            if (!col.nestAlive || !m.active.keys.Contains(nest.key)) return;
            if (!(IsDaylight(minute) && !Raining && CanFly())) return;
            var a = T.alloc[col.alloc]; Num share = a.protein / ((a.sugar + a.protein + a.pulp) / 3);
            Num dtDay = (Num)60 / dayTicks;
            Num inside = Max(0, col.adults - Own().Count);
            Num kill = inside * T.muni.abstractKillPerDay * share * dtDay;
            col.adults -= kill; col.larvae -= col.larvae * T.muni.abstractKillPerDay * share * dtDay;
            col.stats.poisoned += kill;
        }

        bool NearCan(Wasp w)
        {
            foreach (var rec in activeChunks) foreach (var c in rec.content.cans) { Num dx = w.x - c.x, dz = w.z - c.z; if (dx * dx + dz * dz < 0.09) return true; }
            return false;
        }

        // ---------------- rival colonies (GDD 9.3)

        (Rival rv, string key)? RivalNestNear(Wasp w)
        {
            foreach (var rec in activeChunks)
            {
                var rv = rec.content.rival;
                if (rv != null && Sq(w.x - rv.ex) + Sq(w.y - rv.ey) + Sq(w.z - rv.ez) < 0.08 * 0.08) return (rv, ChunkKey(rec.cx, rec.cz));
            }
            return null;
        }

        void Raid(Wasp w, (Rival rv, string key)? r)
        {
            string key = r.Value.key;
            w.carry = new Carry { kind = "protein", amount = T.rival.raidProtein, what = "larva" };
            RivalsHunt(key, w.id, w.P);
            if (net) Publish(new NetEv { type = "raid", key = key, id = w.id, x = w.x, y = w.y, z = w.z });
            Emit("raid", ("id", w.id), ("key", key));
        }

        void RivalsHunt(string key, int id, V3 at)
        {
            foreach (var x in wasps) if (x.colony == key && D2(x, at) < 64) { x.ai.mode = "hunt"; x.ai.huntId = id; x.ai.timer = tick + T.rival.huntTicks; }
        }

        /// Rival workers come and go only around their own nest, and only on the world-authority peer
        void Rivals(bool daylight)
        {
            if (net && peer != 0) return;
            if (!settings.rivals) { foreach (var w in new List<Wasp>(wasps)) if (w.colony != "own") Despawn(w); return; }
            var activeKeys = new HashSet<string>();
            foreach (var r in activeChunks) activeKeys.Add(ChunkKey(r.cx, r.cz));
            foreach (var w in new List<Wasp>(wasps)) if (w.colony != "own" && !activeKeys.Contains(w.colony)) Despawn(w);
            if (!daylight) return;
            foreach (var rec in activeChunks)
            {
                var rv = rec.content.rival;
                if (rv == null) continue;
                string key = ChunkKey(rec.cx, rec.cz);
                int n = 0; foreach (var x in wasps) if (x.colony == key) n++;
                if (n >= System.Math.Min(T.rival.maxPhysical, rv.workers) || tick % 180 >= 60) continue;
                var w = SpawnWasp(false);
                w.colony = key; w.x = rv.ex; w.y = rv.ey - 0.03; w.z = rv.ez;
                w.role = n == 0 ? "guard" : H32(w.id, 9) < 0.5 ? "sugar" : "protein";
                w.ai.mode = w.role == "guard" ? "guard" : "pick";
            }
        }

        Cmd ThinkRival(Wasp w, Cmd cmd)
        {
            var ai = w.ai; var rec = records.Get(w.colony); var rv = rec?.content.rival;
            if (rv == null) { Despawn(w); return cmd; }
            var home = new V3(rv.ex, rv.ey - 0.02, rv.ez);
            if (!IsDaylight(minute) || Raining) ai.mode = "home";
            if (ai.mode == "guard")
            {
                WaspBase t = null;
                foreach (var x in wasps) if (x.colony == "own" && (x.state == "fly" || x.state == "landed") && D2(x, home) < Sq(T.rival.guardRadius)) { t = x; break; }
                // other players' wasps near the nest count too (rivals live on this peer only)
                if (t == null) foreach (var r in remote.Values) if (!r.rival && (r.state == "fly" || r.state == "landed") && D2(r, home) < Sq(T.rival.guardRadius)) { t = r; break; }
                if (t != null) { ai.mode = "hunt"; ai.huntId = t.id; ai.timer = tick + T.rival.huntTicks; }
                else { Steer(w, new V3(home.x + 0.12 * DCos((Num)tick / 40 + w.id), home.y + 0.05, home.z + 0.12 * DSin((Num)tick / 40 + w.id)), cmd); return cmd; }
            }
            if (ai.mode == "hunt")
            {
                WaspBase t = (WaspBase)WaspById(ai.huntId) ?? remote.Get(ai.huntId);
                bool rivalOfMine = t is Wasp tw && tw.colony != "own";
                bool remoteRival = t is RemoteWasp tr && tr.rival;
                if (t == null || rivalOfMine || remoteRival || tick > ai.timer || !Free3(t.state)) { ai.mode = w.role == "guard" ? "guard" : "return"; return cmd; }
                Steer(w, t.P, cmd); cmd.throttle = 1; cmd.burst = 1;
                return cmd;
            }
            if (ai.mode == "home" || ai.mode == "return")
            {
                Steer(w, home, cmd);
                if (D2(w, home) < 0.07 * 0.07)
                {
                    w.carry = null; w.ai.cargo = 0; w.energy = 1;
                    if (ai.mode == "home") { Despawn(w); return cmd; }
                    ai.mode = w.role == "guard" ? "guard" : "pick";
                }
                return cmd;
            }
            if (w.energy < 0.2) { ai.mode = "return"; return cmd; }
            if (ai.mode == "pick") { AiPick(w); return cmd; }
            if (ai.mode == "outbound" || ai.mode == "collect")
            {
                var tp = AiTargetPos(w);
                if (tp == null) { ai.mode = w.carry != null ? "return" : "pick"; return cmd; }
                Steer(w, tp.Value, cmd);
                if (ai.mode == "outbound" && D2(w, tp.Value) < T.ai.arrive * T.ai.arrive) { ai.mode = "collect"; ai.timer = tick + T.ai.collectTicks; }
                if (ai.mode == "collect")
                {
                    if (ai.target.kind == "prey") { var p = PreyNear(w); if (p != null) { Catch(w, p); ai.mode = "return"; } else if (tick > ai.timer) ai.mode = "pick"; }
                    else if (ai.target.kind == "bait") { if (w.carry == null) TakeBait(w); ai.mode = "return"; ai.target = null; }
                    else if (ai.cargo >= 0.95 || tick > ai.timer + 300) ai.mode = "return";
                }
                return cmd;
            }
            ai.mode = "pick";
            return cmd;
        }

        // Wasps of different colonies that touch grapple; the weaker one dies (GDD 9.3)
        void StartRemoteFight(Wasp a, int otherId, int p)
        {
            a.state = "fighting"; a.vx = a.vy = a.vz = 0;
            a.fight = new Fight { other = otherId, remote = true, starter = true, peer = p, start = tick, until = tick + T.rival.fightTicks, myVenom = a.venom, mash = 0 };
            Publish(new NetEv { type = "fight", a = a.id, b = otherId, toPeer = p, venom = a.venom, queen = a.caste == "queen" });
        }

        static Num FightScore(int id, Num venom, bool queen, Num mash, Num start) => venom + (queen ? 1 : 0) + mash + H32(id, start, 61) * 1.2;

        void FightResolve(Wasp w, bool won, int otherId)
        {
            if (won) { w.state = "stunned"; w.stateTicks = 20; w.fight = null; Emit("fightOver", ("winner", w.id), ("loser", otherId)); }
            else { Die(w, w.colony == "own" ? "killed by a rival wasp" : "killed by a player's wasp", null); Emit("fightOver", ("winner", otherId), ("loser", w.id)); }
        }

        // A fight with a wasp another peer owns. The joining side resolves when the fight ends and publishes its mash;
        // the starting side waits for that, and gives up if it never comes.
        void RemoteFightTick(Wasp w)
        {
            var f = w.fight;
            if (f.starter) { if (tick > f.until + T.rival.remoteFightTimeout) { w.state = "fly"; w.fight = null; } return; }
            if (tick < f.until) return;
            bool bWins = FightScore(w.id, f.myVenom, w.caste == "queen", f.mash, f.start) > FightScore(f.other, f.theirVenom, f.theirQueen, 0, f.start);
            Publish(new NetEv { type = "fightEnd", a = f.other, b = w.id, toPeer = f.peer, mash = f.mash, venom = f.myVenom, queen = w.caste == "queen" });
            FightResolve(w, bWins, f.other);
        }

        void Fights()
        {
            foreach (var w in new List<Wasp>(wasps))
            {
                if (w.state != "fighting") continue;
                if (w.fight.remote) { RemoteFightTick(w); continue; }
                if (tick < w.fight.until || w.fight.other < w.id) continue;
                var o = WaspById(w.fight.other);
                if (o == null) { w.state = "fly"; w.fight = null; continue; }
                Num Score(Wasp x) => x.venom + (x.caste == "queen" ? 1 : 0) + x.fight.mash + H32(x.id, tick, 61) * 1.2;
                var (win, lose) = Score(w) >= Score(o) ? (w, o) : (o, w);
                win.state = "stunned"; win.stateTicks = 20; win.fight = null;
                Die(lose, lose.colony == "own" ? "killed by a rival wasp" : "killed by your worker", null);
                Emit("fightOver", ("winner", win.id), ("loser", lose.id));
            }
            var free = wasps.FindAll(w => Free3(w.state));
            for (int i = 0; i < free.Count; i++) for (int j = i + 1; j < free.Count; j++)
                {
                    var a = free[i]; var b = free[j];
                    if (a.colony == b.colony || a.state == "fighting" || b.state == "fighting") continue;
                    if (D2(a, b) > T.rival.fightRange * T.rival.fightRange) continue;
                    foreach (var (x, y) in new[] { (a, b), (b, a) }) { x.state = "fighting"; x.vx = x.vy = x.vz = 0; x.fight = new Fight { other = y.id, until = tick + T.rival.fightTicks, mash = 0 }; }
                    Emit("fight", ("a", a.id), ("b", b.id), ("driven", a.id == drivenId || b.id == drivenId));
                }
            if (!net || remote.Count == 0) return;
            // My wasps touching another peer's rival on my screen: ask its owner to start the fight
            foreach (var w in free)
            {
                if (w.colony != "own" || w.fightReqUntil > tick) continue;
                foreach (var kv in remote)
                {
                    var r = kv.Value;
                    if (!r.rival || !Free3(r.state)) continue;
                    if (D2(w, r) > T.rival.fightRange * T.rival.fightRange * 4) continue;
                    w.fightReqUntil = tick + 30;
                    Publish(new NetEv { type = "fightReq", a = kv.Key, b = w.id, toPeer = r.peer });
                    break;
                }
            }
            // My rivals against other peers' wasps: I own the rivals, so I start these fights
            var busy = new HashSet<int>();
            foreach (var w in wasps) if (w.state == "fighting" && w.fight.remote) busy.Add(w.fight.other);
            Num rr = T.rival.remoteFightRange * T.rival.remoteFightRange;
            foreach (var a in free)
            {
                if (a.colony == "own" || a.state == "fighting") continue;
                foreach (var kv in remote)
                {
                    var r = kv.Value;
                    if (r.rival || busy.Contains(kv.Key) || !Free3(r.state)) continue;
                    if (D2(a, r) > rr) continue;
                    StartRemoteFight(a, kv.Key, r.peer);
                    busy.Add(kv.Key);
                    break;
                }
            }
        }

        // ---------------- colony tick (1 Hz)

        void ColonyTick()
        {
            if (extinct) return; // the line is over: nothing left to tick
            MuniTick();
            var col = colony;
            bool daylight = IsDaylight(minute) && !Raining && CanFly();
            Num frac = SeasonFrac;
            if (!colony.sited && frac > 0.03)
            {
                var old = oldNests.Count > 0 ? oldNests[oldNests.Count - 1] : nest;
                nest = MakeNest(old.treeX, old.treeZ, old.x, old.y, old.z, old.r, old.site ?? "trunk");
                colony.sited = true;
                colony.maxCells = T.sites.Of(nest.site).maxCells;
                Emit("nestFounded", ("x", nest.x), ("y", nest.y), ("z", nest.z), ("key", nest.key), ("auto", true));
            }
            Colony.Step(col, (Num)60 / dayTicks, OwnWorkers(), daylight, frac, bio);
            if (Raining && col.nestAlive && col.sited)
            {
                // the site decides what rain costs: burrows flood, open nests chill (GDD 6.6)
                var st = T.sites.Of(nest.site); Num dt = (Num)60 / dayTicks;
                Num fl = st.flood * dt, inside = Max(0, col.adults - Own().Count);
                col.eggs -= col.eggs * fl; col.larvae -= col.larvae * fl; col.pupae -= col.pupae * fl;
                col.rEggs -= col.rEggs * fl; col.rLarvae -= col.rLarvae * fl; col.rPupae -= col.rPupae * fl;
                Num cold = Min(inside, inside * T.sites.rainMortality * st.exposure * dt);
                col.adults -= cold; col.stats.died += cold;
            }
            string ph = Colony.SeasonPhase(frac);
            if (ph != season.phase) { season.phase = ph; Emit("season", ("phase", ph)); }
            if (frac >= 1) { EndSeason("autumn"); return; }
            if (Colony.Finished(col, Own().Count) && Own().Count == 0) { EndSeason("colony lost"); return; }
            ExtCheck();
            // launch physical AI foragers while the player is near the nest (GDD 11.12: far colonies stay abstract)
            Rivals(daylight);
            bool nearNest = false;
            if (colony.sited) foreach (var r in activeChunks) if (ChunkKey(r.cx, r.cz) == nest.key) { nearNest = true; break; }
            if (!nearNest)
            {
                foreach (var w in Own()) if (w.id != drivenId) Despawn(w);
                return;
            }
            int own = Own().Count;
            Num inside2 = col.adults - own;
            int ai = own - (Driven() != null ? 1 : 0);
            Num cap = Min(T.ai.maxPhysical, Floor(col.adults * 0.4));
            if (!noAI && daylight && col.nestAlive && inside2 >= 1 && ai < cap && tick % T.ai.launchEvery < 60) SpawnWasp(false);
        }
    }
}
