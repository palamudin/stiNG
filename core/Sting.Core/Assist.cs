// Lock-on and assisted flight (GDD 7.9), a port of poc/sim/assist.js: the player directs the wasp, the wasp flies.
// Pure functions of the sim that only build the driven wasp's commands, so an assisted flight replays like any input.
using System.Collections.Generic;
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    /// What a lock is on: a kind, and where to find it (chunk and index, hive, wasp id, or a spot on a person)
    public sealed class LockTarget
    {
        public string kind, key, hex, part; public int i, h, id; public Num t; public V3 n;
    }
    public sealed class TargetKind { public string label, go; public bool prey, hazard; }

    public static class Assist
    {
        public static readonly Num humanRange = 8, coneCos = 0.99, range = 10, nearRange = 8, lostRange = 15, partSlack = 0.12;
        public static readonly Dictionary<string, TargetKind> Kinds = new Dictionary<string, TargetKind>
        {
            ["human"] = new TargetKind { label = "person", go = "land on it" },
            ["fly"] = new TargetKind { label = "fly", go = "catch it", prey = true },
            ["caterpillar"] = new TargetKind { label = "caterpillar", go = "catch it", prey = true },
            ["bee"] = new TargetKind { label = "bee", go = "catch it", prey = true, hazard = true },
            ["moth"] = new TargetKind { label = "moth", go = "catch it", prey = true }, // at a porch light at night (T2-10)
            ["firefly"] = new TargetKind { label = "firefly", go = "catch it", prey = true }, // on summer evenings; spat out, it tastes foul
            ["flower"] = new TargetKind { label = "flower", go = "land on it" },
            ["cup"] = new TargetKind { label = "drink", go = "drink from it" },
            ["bath"] = new TargetKind { label = "water", go = "land at the water" },
            ["nest"] = new TargetKind { label = "your nest", go = "fly home" },
            ["bird"] = new TargetKind { label = "bird", hazard = true },
            ["dragonfly"] = new TargetKind { label = "dragonfly", hazard = true },
            ["web"] = new TargetKind { label = "spider web", hazard = true },
            ["wasp"] = new TargetKind { label = "rival wasp", hazard = true },
        };
        static Num D2(V3 a, V3 b) => Sq(a.x - b.x) + Sq(a.y - b.y) + Sq(a.z - b.z);
        static Num D2(WaspBase a, V3 b) => Sq(a.x - b.x) + Sq(a.y - b.y) + Sq(a.z - b.z);

        static Part PartOf(Human hm, string name) { foreach (var p in hm.PartsNow) if (p.name == name) return p; return null; }
        /// a body point as a part, a place along it and a direction off it, so it follows the person when they move or sit
        static (V3 p, V3 n)? HumanPoint(Human hm, LockTarget t)
        {
            var part = PartOf(hm, t.part);
            if (part == null) return null;
            V3 a = part.a, b = part.b, q = new V3(a.x + (b.x - a.x) * t.t, a.y + (b.y - a.y) * t.t, a.z + (b.z - a.z) * t.t);
            var p = Body.ToWorld(hm.F, new V3(q.x + t.n.x * part.r, q.y + t.n.y * part.r, q.z + t.n.z * part.r));
            V3 o = Body.ToWorld(hm.F, new V3(0, 0, 0)), e = Body.ToWorld(hm.F, t.n);
            return (p, new V3(e.x - o.x, e.y - o.y, e.z - o.z));
        }

        /// the spot to fly to, off the locked spot by off, pushed out of any other part of the body that covers it (GDD 19.6 T3-1)
        static V3? ExposedSpot(Human hm, LockTarget t, Num off)
        {
            var part = PartOf(hm, t.part);
            if (part == null) return null;
            V3 a = part.a, b = part.b, q = new V3(a.x + (b.x - a.x) * t.t, a.y + (b.y - a.y) * t.t, a.z + (b.z - a.z) * t.t);
            var lp = new V3(q.x + t.n.x * (part.r + off), q.y + t.n.y * (part.r + off), q.z + t.n.z * (part.r + off));
            for (int it = 0; it < 3; it++) foreach (var o in hm.PartsNow)
                {
                    var c = Body.SegClosest(o.a, o.b, lp); Num ex = lp.x - c.x, ey = lp.y - c.y, ez = lp.z - c.z, d = Sqrt(ex * ex + ey * ey + ez * ez), need = o.r + off;
                    if (d < need && d > 1e-9) lp = new V3(c.x + ex / d * need, c.y + ey / d * need, c.z + ez / d * need);
                }
            return Body.ToWorld(hm.F, lp);
        }

        /// where a target is now, or null when it is gone
        public static V3? TargetPos(Sim sim, LockTarget t)
        {
            if (t == null) return null;
            if (t.kind == "human") { var hm = sim.HumanByHex(t.hex); if (hm == null || hm.state == "away") return null; var hp = HumanPoint(hm, t); return hp?.p; }
            if (t.kind == "nest") return sim.nest.entrance;
            if (t.kind == "wasp")
            {
                WaspBase x = (WaspBase)sim.WaspById(t.id) ?? sim.remote.Get(t.id);
                return x != null && (x.state == "fly" || x.state == "landed") ? new V3(x.x, x.y, x.z) : (V3?)null;
            }
            var rec = sim.records.Get(t.key);
            if (rec == null) return null;
            var c = rec.content; var st = sim.CS(t.key);
            switch (t.kind)
            {
                case "fly": return (st.caughtFly.TryGetValue(t.i, out var cf) ? cf : 0) > sim.tick || !sim.FlyActive(rec, t.i) ? (V3?)null : World.FlyPos(c.flies[t.i], sim.tick);
                case "caterpillar": { var cp = c.caterpillars[t.i]; return st.caughtCat.ContainsKey(t.i) && st.caughtCat[t.i] != 0 || !sim.CatActive(rec, t.i) ? (V3?)null : new V3(cp.x, cp.y, cp.z); }
                case "bee":
                    {
                        var hives = sim.HivesIn(rec); if (t.h >= hives.Count) return null;
                        bool lost = st.beeLost.TryGetValue(t.h, out var bl) && bl.TryGetValue(t.i, out var lv) && lv != 0;
                        return lost ? (V3?)null : World.BeePos(hives[t.h], t.i, sim.tick);
                    }
                case "flower": { var f = c.flowers[t.i]; return sim.InBloom(rec, t.i) ? new V3(f.x, f.y, f.z) : (V3?)null; }
                case "cup": foreach (var cp in sim.CupsIn(rec)) if (cp.i == t.i) return sim.CanSpilled(t.key, cp.i) ? (V3?)null : new V3(cp.x, cp.level, cp.z); return null;
                case "bath": return t.i < c.baths.Count ? new V3(c.baths[t.i].x, c.baths[t.i].h, c.baths[t.i].z) : (V3?)null;
                case "bird":
                case "dragonfly":
                    {
                        var list = t.kind == "bird" ? c.birds : c.dragonflies; var states = t.kind == "bird" ? sim.birdState : sim.dragonState;
                        if (states.TryGet(t.key + "#" + t.i, out var s)) return new V3(s.x, s.y, s.z);
                        return t.i < list.Count ? (t.kind == "bird" ? World.BirdPos(list[t.i], sim.tick) : World.DragonPos(list[t.i], sim.tick)) : (V3?)null;
                    }
                case "web": return t.i < c.webs.Count ? new V3(c.webs[t.i].x, c.webs[t.i].y, c.webs[t.i].z) : (V3?)null;
                case "firefly": { var fs = sim.FireflySpots(rec); return t.i < fs.Count && sim.FireflyTime() ? Sim.FireflyPos(fs[t.i], sim.tick) : (V3?)null; }
                case "moth":
                    { // circling its porch light while it is lit and not taken
                        if (!sim.Lit() || sim.Raining || (st.caughtMoth != null && st.caughtMoth.TryGetValue(t.i, out var cm) && cm > sim.tick)) return null;
                        var L = sim.LightsIn(rec); int li = t.i / T.moths.perLight;
                        return li < L.Count ? Sim.MothPos(L[li], t.i % T.moths.perLight, sim.tick) : (V3?)null;
                    }
            }
            return null;
        }

        static List<(LockTarget t, V3 p)> Candidates(Sim sim, Wasp w)
        {
            var o = new List<(LockTarget, V3)>(); Num CS = T.chunk.size, R = range * sim.Mul(w, "landR"); // the landing reach skill reaches further (GDD 6.8)
            void Add(LockTarget t) { var p = TargetPos(sim, t); if (p != null && D2(w, p.Value) <= R * R) o.Add((t, p.Value)); }
            foreach (var rec in sim.activeChunks)
            {
                if (Abs(rec.cx * CS - w.x) > CS / 2 + R || Abs(rec.cz * CS - w.z) > CS / 2 + R) continue;
                string key = rec.key; var c = rec.content;
                for (int i = 0; i < c.flies.Count; i++) Add(new LockTarget { kind = "fly", key = key, i = i });
                for (int i = 0; i < c.caterpillars.Count; i++) Add(new LockTarget { kind = "caterpillar", key = key, i = i });
                var hives = sim.HivesIn(rec);
                for (int h = 0; h < hives.Count; h++) for (int k = T.bees.guards; k < hives[h].bees.Count; k++) Add(new LockTarget { kind = "bee", key = key, i = k, h = h });
                for (int i = 0; i < c.flowers.Count; i++) Add(new LockTarget { kind = "flower", key = key, i = i });
                foreach (var cp in sim.CupsIn(rec)) Add(new LockTarget { kind = "cup", key = key, i = cp.i });
                for (int i = 0; i < c.baths.Count; i++) Add(new LockTarget { kind = "bath", key = key, i = i });
                for (int i = 0; i < c.birds.Count; i++) Add(new LockTarget { kind = "bird", key = key, i = i });
                for (int i = 0; i < c.dragonflies.Count; i++) Add(new LockTarget { kind = "dragonfly", key = key, i = i });
                foreach (var mo in sim.MothsIn(rec)) Add(new LockTarget { kind = "moth", key = key, i = mo.i });
                foreach (var ff in sim.FirefliesIn(rec)) Add(new LockTarget { kind = "firefly", key = key, i = ff.i });
                for (int i = 0; i < c.webs.Count; i++) Add(new LockTarget { kind = "web", key = key, i = i });
            }
            foreach (var x in sim.wasps) if (x != w && Sim.IsRival(x)) Add(new LockTarget { kind = "wasp", id = x.id });
            Add(new LockTarget { kind = "nest" });
            return o;
        }

        /// the spot on a person the aim passes nearest: a body part, a place along it and the side of it facing the wasp
        static LockTarget AimAtHuman(Sim sim, Wasp w, V3 aim)
        {
            LockTarget best = null; Num bestMiss = Num.MaxValue;
            foreach (var hm in sim.active)
            {
                if (hm.state == "away" || hm.special || Sq(hm.x - w.x) + Sq(hm.z - w.z) > Sq(humanRange * sim.Mul(w, "landR"))) continue;
                V3 o = Body.ToLocal(hm.F, new V3(w.x, w.y, w.z)), e = Body.ToLocal(hm.F, new V3(w.x + aim.x, w.y + aim.y, w.z + aim.z));
                V3 dv = new V3(e.x - o.x, e.y - o.y, e.z - o.z);
                foreach (var part in hm.PartsNow)
                {
                    Num t = 0.5;
                    V3 At(Num tt) => new V3(part.a.x + (part.b.x - part.a.x) * tt, part.a.y + (part.b.y - part.a.y) * tt, part.a.z + (part.b.z - part.a.z) * tt);
                    for (int k = 0; k < 6; k++)
                    {
                        var q0 = At(t); Num s0 = Max(0, (q0.x - o.x) * dv.x + (q0.y - o.y) * dv.y + (q0.z - o.z) * dv.z);
                        t = Body.SegClosest(part.a, part.b, new V3(o.x + dv.x * s0, o.y + dv.y * s0, o.z + dv.z * s0)).t;
                    }
                    var q = At(t); Num s = Max(0, (q.x - o.x) * dv.x + (q.y - o.y) * dv.y + (q.z - o.z) * dv.z);
                    var r = new V3(o.x + dv.x * s, o.y + dv.y * s, o.z + dv.z * s);
                    Num miss = Sqrt(D2(q, r)) - part.r;
                    if (miss > partSlack || miss >= bestMiss) continue;
                    Num nx = r.x - q.x, ny = r.y - q.y, nz = r.z - q.z;
                    if (nx * nx + ny * ny + nz * nz < 1e-12) { nx = o.x - q.x; ny = o.y - q.y; nz = o.z - q.z; }
                    V3 along = new V3(part.b.x - part.a.x, part.b.y - part.a.y, part.b.z - part.a.z); Num al = Max(1e-9, D2(along, new V3(0, 0, 0)));
                    Num kk = (nx * along.x + ny * along.y + nz * along.z) / al;
                    nx -= along.x * kk; ny -= along.y * kk; nz -= along.z * kk;
                    Num nl = Sqrt(nx * nx + ny * ny + nz * nz); if (nl == 0) nl = 1;
                    bestMiss = miss; best = new LockTarget { kind = "human", hex = hm.hex, part = part.name, t = t, n = new V3(nx / nl, ny / nl, nz / nl) };
                }
            }
            return best;
        }

        /// lock on: the spot on a person under the aim; else what is closest to the aim within a narrow cone; else the
        /// nearest prey or hazard. aim is a unit direction from the wasp.
        public static LockTarget PickTarget(Sim sim, Wasp w, V3 aim)
        {
            var h = AimAtHuman(sim, w, aim);
            if (h != null) return h;
            LockTarget best = null; Num bc = coneCos;
            var cands = Candidates(sim, w);
            foreach (var (t, p) in cands)
            {
                Num dx = p.x - w.x, dy = p.y - w.y, dz = p.z - w.z, d = Sqrt(dx * dx + dy * dy + dz * dz);
                if (d < 1e-6) continue;
                Num cos = (dx * aim.x + dy * aim.y + dz * aim.z) / d;
                if (cos > bc) { bc = cos; best = t; }
            }
            if (best != null) return best;
            Num nd = Sq(nearRange * sim.Mul(w, "landR"));
            foreach (var (t, p) in cands)
            {
                var K = Kinds[t.kind];
                if (!K.prey && !K.hazard) continue;
                Num q = D2(w, p);
                if (q < nd) { nd = q; best = t; }
            }
            return best;
        }

        sealed class Goal { public V3 p; public bool above; public V3? n; }
        static Goal GoalOf(Sim sim, LockTarget t, V3 p)
        {
            Num R = T.wasp.radius;
            if (t.kind == "flower") return new Goal { p = new V3(p.x, p.y + T.land.headR + R + 0.001, p.z), above = true };
            if (t.kind == "cup") return new Goal { p = new V3(p.x, p.y + 0.025, p.z), above = true };
            if (t.kind == "bath") return new Goal { p = new V3(p.x, p.y + R + 0.004, p.z), above = true };
            if (t.kind == "human")
            {
                var hm = sim.HumanByHex(t.hex); var hp = hm != null ? HumanPoint(hm, t) : null; var e = hp != null ? ExposedSpot(hm, t, R + 0.006) : null;
                if (e == null) return null;
                return new Goal { p = e.Value, n = hp.Value.n };
            }
            return new Goal { p = p };
        }

        /// how far a moving target counts as moving (m/s), the most lead (s), and the least closing speed the pilot keeps (m/s); see assist.js
        public static readonly Num chaseMoving = 0.05, chaseLead = 0.5, chaseCloseMin = 2;
        /// how fast a target is moving, m/s (zero for anything that stays put); prey positions are functions of the tick
        public static V3 TargetVel(Sim sim, LockTarget t)
        {
            var Z = new V3(0, 0, 0);
            if (t == null) return Z;
            if (t.kind == "wasp") { WaspBase x = (WaspBase)sim.WaspById(t.id) ?? sim.remote.Get(t.id); return x != null ? new V3(x.vx, x.vy, x.vz) : Z; }
            if (t.kind == "human") { var hm = sim.HumanByHex(t.hex); return hm != null && hm.state != "away" ? new V3(hm.vx, 0, hm.vz) : Z; } // a person's pace over their last step
            if (t.kind != "fly" && t.kind != "bee" && t.kind != "bird" && t.kind != "dragonfly" && t.kind != "moth" && t.kind != "firefly") return Z;
            if (!sim.records.TryGet(t.key, out var rec)) return Z;
            var c = rec.content; int k = sim.tick; V3? a = null, b = null;
            if (t.kind == "fly") { if (t.i < c.flies.Count) { a = World.FlyPos(c.flies[t.i], k); b = World.FlyPos(c.flies[t.i], k + 1); } }
            else if (t.kind == "firefly") { var fs = sim.FireflySpots(rec); if (t.i < fs.Count) { a = Sim.FireflyPos(fs[t.i], k); b = Sim.FireflyPos(fs[t.i], k + 1); } }
            else if (t.kind == "moth") { var L = sim.LightsIn(rec); int li = t.i / T.moths.perLight; if (li < L.Count) { a = Sim.MothPos(L[li], t.i % T.moths.perLight, k); b = Sim.MothPos(L[li], t.i % T.moths.perLight, k + 1); } }
            else if (t.kind == "bee") { var hv = sim.HivesIn(rec); if (t.h < hv.Count) { a = World.BeePos(hv[t.h], t.i, k); b = World.BeePos(hv[t.h], t.i, k + 1); } }
            else
            {
                var list = t.kind == "bird" ? c.birds : c.dragonflies; var states = t.kind == "bird" ? sim.birdState : sim.dragonState;
                if (states.TryGet(t.key + "#" + t.i, out var st)) return new V3(st.vx, st.vy, st.vz);
                if (t.i < list.Count) { a = t.kind == "bird" ? World.BirdPos(list[t.i], k) : World.DragonPos(list[t.i], k); b = t.kind == "bird" ? World.BirdPos(list[t.i], k + 1) : World.DragonPos(list[t.i], k + 1); }
            }
            return a != null && b != null ? new V3((b.Value.x - a.Value.x) * 60, (b.Value.y - a.Value.y) * 60, (b.Value.z - a.Value.z) * 60) : Z;
        }

        /// one tick of the pilot: the command that takes the wasp to the target and settles it there or catches it;
        /// done says why the flight is over ("landed", "perched", "caught", "gone", "no"), null while it goes on
        // Obstacle avoidance (GDD 7.9): before flying straight at the goal, look a short way ahead (further the faster it
        // goes) for anything solid; if the way is blocked, try a fan of turns (up first, then the sides, then wider, a
        // little in favour of the way it is already going so it does not flip between sides), and fly the best clear one.
        // A way that only runs along the obstacle scores worse than one from whose end the goal shows. With none clear it
        // takes the one that stays clear longest. The ground is not an obstacle. Matches poc/sim/assist.js AVOID.
        public static readonly Num avClear = 0.03, avStep = 0.05, avLookMin = 0.3, avLookMax = 1, avLookT = 0.35, avStopShort = 0.12, avKeep = 0.6, avMaxPitch = 1.45, avSeeMax = 2, avBlind = 2;
        public static readonly Num[][] avTurns = {
            new Num[] { 0, 0.5 }, new Num[] { 0.5, 0 }, new Num[] { -0.5, 0 }, new Num[] { 0.5, 0.5 }, new Num[] { -0.5, 0.5 }, new Num[] { 0, 1 }, new Num[] { 1, 0 }, new Num[] { -1, 0 },
            new Num[] { 1, 0.5 }, new Num[] { -1, 0.5 }, new Num[] { 1.5, 0 }, new Num[] { -1.5, 0 }, new Num[] { 0, 1.3 }, new Num[] { 0, 3 }, new Num[] { 3.14159, 1.6 } };
        static bool SolidAt(Sim sim, List<ChunkRec> recs, Num x, Num y, Num z, Num c)
        {
            foreach (var rec in recs)
            {
                foreach (var b in rec.content.boxes) if (x > b.minx - c && x < b.maxx + c && y > b.miny - c && y < b.maxy + c && z > b.minz - c && z < b.maxz + c) return true;
                foreach (var cy in sim.CylsOf(rec)) if (y < cy.h + c && Sq(x - cy.x) + Sq(z - cy.z) < Sq(cy.r + c)) return true;
                foreach (var f in sim.RoofsOf(rec))
                {
                    var r = Sim.RoofLocal(f, x, y, z); Num au = Abs(r.u), av = Abs(r.v);
                    if (av > f.half + c || au > f.S + c || r.y < -c || r.y > f.rise + c) continue;
                    if ((f.rise * (au - f.S) + f.S * r.y) / f.L < c && av - f.half < c) return true;
                }
            }
            return false;
        }
        /// how far the way from (x, y, z) along unit d is clear, up to len m (len when it all is)
        public static Num ClearLen(Sim sim, Num x, Num y, Num z, V3 d, Num len)
        {
            Num c = T.wasp.radius + avClear, ex = x + d.x * len, ez = z + d.z * len, CS = T.chunk.size;
            Num lox = Min(x, ex) - c, hix = Max(x, ex) + c, loz = Min(z, ez) - c, hiz = Max(z, ez) + c;
            var recs = new List<ChunkRec>();
            foreach (var r in sim.activeChunks) if (r.cx * CS + CS / 2 >= lox - 2 && r.cx * CS - CS / 2 <= hix + 2 && r.cz * CS + CS / 2 >= loz - 2 && r.cz * CS - CS / 2 <= hiz + 2) recs.Add(r);
            int n = (int)Floor(len / avStep);
            for (int k = 1; k <= n; k++)
            {
                Num s = k * avStep, py = y + d.y * s;
                if (py < c) continue; // the ground is not in the way
                if (SolidAt(sim, recs, x + d.x * s, py, z + d.z * s, c)) return (k - 1) * avStep;
            }
            return len;
        }
        static V3 Dir(Num yaw, Num pitch) => new V3(DSin(yaw) * DCos(pitch), DSin(pitch), DCos(yaw) * DCos(pitch));
        /// the heading to fly toward (dx, dy, dz) from the wasp, round whatever is in the way
        public static (Num yaw, Num pitch, bool turned) AvoidHeading(Sim sim, Wasp w, Num dx, Num dy, Num dz, Num dist)
        {
            Num hd = Sqrt(dx * dx + dz * dz), yaw0 = DAtan2(dx, dz), pitch0 = DAtan2(dy, hd);
            Num sp = Sqrt(w.vx * w.vx + w.vy * w.vy + w.vz * w.vz), len = Min(Clamp(sp * avLookT + avLookMin, avLookMin, avLookMax), dist - avStopShort);
            if (len < avStep || ClearLen(sim, w.x, w.y, w.z, Dir(yaw0, pitch0), len) >= len) return (yaw0, pitch0, false);
            bool has = false, hasFar = false; Num bs = 0, fl = avStep; (Num, Num) best = (0, 0), far = (0, 0);
            foreach (var tn in avTurns)
            {
                Num yo = tn[0], po = tn[1], yaw = yaw0 + yo, pitch = Clamp(pitch0 + po, -avMaxPitch, avMaxPitch); var d = Dir(yaw, pitch);
                Num sc = Abs(yo) + Abs(po);
                if (sp > 0.3) sc += avKeep * (1 - (d.x * w.vx + d.y * w.vy + d.z * w.vz) / sp);
                if (has && sc >= bs) continue;
                Num cl = ClearLen(sim, w.x, w.y, w.z, d, len);
                if (cl >= len)
                {
                    // a way that only runs along the obstacle (a long fence) gets nowhere: rather one from whose end the goal shows
                    Num ex = dx - d.x * len, ey = dy - d.y * len, ez = dz - d.z * len, el = Sqrt(ex * ex + ey * ey + ez * ez), m = Min(el - avStopShort, avSeeMax);
                    if (m >= avStep && ClearLen(sim, w.x + d.x * len, w.y + d.y * len, w.z + d.z * len, new V3(ex / el, ey / el, ez / el), m) < m) sc += avBlind;
                    if (!has || sc < bs) { has = true; bs = sc; best = (yaw, pitch); }
                }
                else if (cl > fl) { fl = cl; hasFar = true; far = (yaw, pitch); } // none clear yet: the one that gets furthest
            }
            if (has) return (best.Item1, best.Item2, true);
            if (hasFar) return (far.Item1, far.Item2, true);
            return (yaw0, pitch0, false); // boxed in: straight on, and slide as before
        }

        /// Landing: the share of its acceleration it counts on to brake with, the step of the look along a straight way in past
        /// a person's body, and how near the goal that look stops (GDD 7.9). Matches poc/sim/assist.js LAND.
        public static readonly Num landBrake = 0.5, landBodyStep = 0.02, landBodyStop = 0.03, landSpot = 0.04;
        public const int landStall = 90, landGap = 60;
        sealed class SpotMemo { public int first, seen; }
        static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Sim, Dictionary<int, SpotMemo>> spotMemo = new System.Runtime.CompilerServices.ConditionalWeakTable<Sim, Dictionary<int, SpotMemo>>();
        /// touching a walker for landStall ticks without reaching the spot (under a swinging arm): it settles where it is
        static bool SpotStalled(Sim sim, Wasp w)
        {
            var m = spotMemo.GetValue(sim, _ => new Dictionary<int, SpotMemo>());
            if (!m.TryGetValue(w.id, out var c) || sim.tick < c.seen || sim.tick - c.seen > landGap) { m[w.id] = new SpotMemo { first = sim.tick, seen = sim.tick }; return false; }
            c.seen = sim.tick;
            return sim.tick - c.first > landStall;
        }
        /// can it fly straight to the goal? Not into a drink or water (over the rim), nor through anything solid, nor through
        /// the person it is going to land on
        // Routes past long walls (GDD 19.6 T3-1): see poc/sim/assist.js ROUTE. Over the first box in the way (its top, and
        // the roof on a shed or house) or round one of its corners, whichever is shortest with a clear way there.
        public static readonly Num rtFar = 1.2, rtMargin = 0.45, rtClearTop = 0.35, rtSkin = 0.05, rtMoved = 0.3, rtReached = 0.3, rtClimb = 1.5, rtBlocked = 5;
        public const int rtEvery = 12;
        sealed class RouteMemo { public int tick; public V3 g; public V3? wp; }
        static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Sim, Dictionary<int, RouteMemo>> routeMemo = new System.Runtime.CompilerServices.ConditionalWeakTable<Sim, Dictionary<int, RouteMemo>>();
        static List<Box> BoxesAlong(Sim sim, V3 a, V3 b)
        {
            Num CS = T.chunk.size, lox = Min(a.x, b.x) - 2, hix = Max(a.x, b.x) + 2, loz = Min(a.z, b.z) - 2, hiz = Max(a.z, b.z) + 2; var o = new List<Box>();
            foreach (var r in sim.activeChunks) if (r.cx * CS + CS / 2 >= lox && r.cx * CS - CS / 2 <= hix && r.cz * CS + CS / 2 >= loz && r.cz * CS - CS / 2 <= hiz) o.AddRange(r.content.boxes);
            return o;
        }
        /// where the straight way from a to b first enters box bx grown by m, as a share of the way (0..1), or -1
        static Num BoxEntry(V3 a, V3 b, Box bx, Num m)
        {
            Num t0 = 0, t1 = 1;
            Num[] A = { a.x, a.y, a.z }, B = { b.x, b.y, b.z }, LO = { bx.minx - m, bx.miny - m, bx.minz - m }, HI = { bx.maxx + m, bx.maxy + m, bx.maxz + m };
            for (int i = 0; i < 3; i++)
            {
                Num d = B[i] - A[i];
                if (Abs(d) < 1e-9) { if (A[i] < LO[i] || A[i] > HI[i]) return -1; continue; }
                Num u = (LO[i] - A[i]) / d, v = (HI[i] - A[i]) / d;
                if (u > v) { Num q = u; u = v; v = q; }
                if (u > t0) t0 = u;
                if (v < t1) t1 = v;
                if (t0 > t1) return -1;
            }
            return t0;
        }
        static bool InBox(V3 p, Box bx, Num m) => p.x > bx.minx - m && p.x < bx.maxx + m && p.y > bx.miny - m && p.y < bx.maxy + m && p.z > bx.minz - m && p.z < bx.maxz + m;
        static (Box bx, Num t)? FirstBox(List<Box> boxes, V3 a, V3 b, V3 g)
        {
            Box hit = null; Num ht = 2;
            foreach (var bx in boxes)
            {
                if (InBox(g, bx, 2 * rtSkin)) continue; // the goal's own surface
                Num t = BoxEntry(a, b, bx, rtSkin);
                if (t >= 0 && t < ht) { ht = t; hit = bx; }
            }
            return hit != null ? (hit, ht) : ((Box, Num)?)null;
        }
        /// the boxes joined to b, end to end or touching (a run of fence sections): one wall
        static List<Box> WallOf(List<Box> boxes, Box b)
        {
            var set = new List<Box> { b }; Num m = rtSkin * 2;
            for (int i = 0; i < set.Count && set.Count < 64; i++)
            {
                var q = set[i];
                foreach (var o in boxes) if (!set.Contains(o) && o.minx < q.maxx + m && o.maxx > q.minx - m && o.minz < q.maxz + m && o.maxz > q.minz - m && o.miny < q.maxy + m && o.maxy > q.miny - m) set.Add(o);
            }
            return set;
        }
        public static V3? RouteWaypoint(Sim sim, Wasp w, V3 g)
        {
            var a = new V3(w.x, w.y, w.z); var boxes = BoxesAlong(sim, a, g); var f = FirstBox(boxes, a, g, g);
            if (f == null) return null;
            var b = f.Value.bx; var wall = WallOf(boxes, b); Num M = rtMargin, top = b.maxy + (b.shed ? (b.wood ? 0.55 : 1.9) : 0) + rtClearTop, y = Max(a.y, 0.4);
            var cands = new[] { (new V3(a.x + (g.x - a.x) * f.Value.t, top, a.z + (g.z - a.z) * f.Value.t), true),
                (new V3(b.minx - M, y, b.minz - M), false), (new V3(b.maxx + M, y, b.minz - M), false), (new V3(b.minx - M, y, b.maxz + M), false), (new V3(b.maxx + M, y, b.maxz + M), false) };
            V3? best = null; Num bc = Num.MaxValue;
            foreach (var (c, up) in cands)
            {
                if (FirstBox(boxes, a, c, g) != null) continue; // no clear way there
                Num l1 = Sqrt(Sq(c.x - a.x) + Sq(c.y - a.y) + Sq(c.z - a.z)), l2 = Sqrt(Sq(g.x - c.x) + Sq(g.y - c.y) + Sq(g.z - c.z));
                var on = FirstBox(boxes, c, g, g); // still behind the same wall from there: that way gets nowhere
                Num cost = l1 + l2 + (up ? (rtClimb - 1) * Max(0, c.y - a.y) : 0) + (on != null && wall.Contains(on.Value.bx) ? rtBlocked : 0);
                if (cost < bc) { bc = cost; best = c; }
            }
            return best;
        }
        static V3? RouteOf(Sim sim, Wasp w, V3 g)
        {
            var m = routeMemo.GetValue(sim, _ => new Dictionary<int, RouteMemo>());
            if (m.TryGetValue(w.id, out var c) && sim.tick >= c.tick && sim.tick - c.tick < rtEvery && Sq(c.g.x - g.x) + Sq(c.g.y - g.y) + Sq(c.g.z - g.z) < Sq(rtMoved)
                && !(c.wp != null && D2(w, c.wp.Value) < Sq(rtReached))) return c.wp;
            var wp = RouteWaypoint(sim, w, g);
            m[w.id] = new RouteMemo { tick = sim.tick, g = g, wp = wp };
            return wp;
        }
        static bool StraightIn(Sim sim, Wasp w, LockTarget t, V3 g)
        {
            if (t.kind == "cup" || t.kind == "bath") return false;
            Num dx = g.x - w.x, dy = g.y - w.y, dz = g.z - w.z, d = Sqrt(dx * dx + dy * dy + dz * dz), len = d - landBodyStop;
            if (len <= 0) return true;
            var u = new V3(dx / d, dy / d, dz / d);
            if (ClearLen(sim, w.x, w.y, w.z, u, len) < len) return false;
            if (t.kind != "human") return true;
            var hm = sim.HumanByHex(t.hex); Num R = T.wasp.radius;
            if (hm == null) return false;
            var parts = hm.PartsNow; int n = (int)Floor(len / landBodyStep);
            for (int k = 0; k <= n; k++)
            {
                Num s = k * landBodyStep; var lp = Body.ToLocal(hm.F, new V3(w.x + u.x * s, w.y + u.y * s, w.z + u.z * s));
                foreach (var part in parts) { var q = Body.SegClosest(part.a, part.b, lp); if (Sq(lp.x - q.x) + Sq(lp.y - q.y) + Sq(lp.z - q.z) < Sq(part.r + R)) return false; }
            }
            return true;
        }

        public static (Cmd cmd, string done) Pilot(Sim sim, Wasp w, LockTarget t, Cmd cmd)
        {
            var K = Kinds.TryGetValue(t.kind, out var kk) ? kk : null;
            if (K == null || K.go == null) return (cmd, "no");
            if (t.kind == "firefly" && w.spat >= sim.tick - 2) return (cmd, "spat"); // taken and spat out
            Cmd Copy() => new Cmd { mx = 0, my = 0, mz = cmd.mz, burst = 0, sting = 0, yawQ = cmd.yawQ, pitchQ = cmd.pitchQ, act = cmd.act, alloc = cmd.alloc, pick = cmd.pick };
            if (w.state == "landed")
            {
                // settled next to its prey (a caterpillar on a stalk): grab it from there
                var pp = K.prey && w.carry == null ? TargetPos(sim, t) : null;
                if (pp != null && D2(w, pp.Value) < Sq(T.prey.catchDist * 1.4)) { var o2 = Copy(); o2.mz = 0; o2.act = (sim.tick & 1) != 0 ? 1 : 0; return (o2, null); }
                // standing somewhere else: take off and go
                var tp = TargetPos(sim, t); var gl = tp != null ? GoalOf(sim, t, tp.Value) : null;
                if (gl != null && !(K.prey && w.carry != null) && D2(w, gl.p) > Sq(0.05)) { var o3 = Copy(); o3.mz = 0; o3.my = 100; o3.act = 0; return (o3, null); }
                return (cmd, K.prey && w.carry != null ? "caught" : "landed");
            }
            if (w.state == "perched" || w.state == "under") return (cmd, "perched");
            if (w.state != "fly") return (cmd, "gone");
            var p = TargetPos(sim, t);
            if (p == null) return (cmd, K.prey && w.carry != null ? "caught" : "gone");
            if (K.prey && w.carry != null) return (cmd, "caught");
            var g0 = GoalOf(sim, t, p.Value);
            if (g0 == null) return (cmd, "gone");
            bool hurry = cmd.burst != 0; // Shift held on an assisted flight: it flies there at burst speed (and still slows to settle)
            Num top = (hurry ? T.wasp.burst : T.wasp.cruise) * (w.carry != null ? T.wasp.carrySpeedMul : 1);
            // a moving target: fly its velocity plus closing speed toward it (with burst when that is quick), so the gap shrinks
            // whichever way it goes
            var v = TargetVel(sim, t); Num vs = Sqrt(v.x * v.x + v.y * v.y + v.z * v.z); bool moving = vs > chaseMoving;
            var g = g0;
            Num hd = Sqrt(Sq(g.p.x - w.x) + Sq(g.p.z - w.z));
            V3 wp = g.p; bool routed = false; V3? rw = null;
            if (!moving && StraightIn(sim, w, t, g.p)) wp = g.p;
            else if (!moving && hd > rtFar && (rw = RouteOf(sim, w, g.p)) != null) { wp = rw.Value; routed = true; } // past a long wall
            else if (g.above && hd > 0.06) wp = new V3(g.p.x, g.p.y + Min(0.4, 0.3 * hd + 0.04), g.p.z);
            else if (g.n != null && Sqrt(D2(w, g.p)) > 0.2) { var n = g.n.Value; wp = new V3(g.p.x + n.x * 0.15, g.p.y + n.y * 0.15, g.p.z + n.z * 0.15); }
            Num dx = wp.x - w.x, dy = wp.y - w.y, dz = wp.z - w.z, d = Sqrt(dx * dx + dy * dy + dz * dz), dg = Sqrt(D2(w, g0.p)); // how near it really is
            var o = Copy(); o.burst = hurry ? 1 : 0;
            if (K.prey && dg < T.prey.catchDist * 0.9) { o.mz = 0; o.act = (sim.tick & 1) != 0 ? 1 : 0; return (o, null); } // grab it
            if (dg < 0.004 && !K.prey) { o.mz = 0; o.burst = 0; return (o, null); } // hold still: it settles on its own
            // touching the person at their pace on the spot locked: let go of the controls and it settles there (a walker too;
            // touching them anywhere else, it keeps flying on along them to the spot, GDD 19.6 T3-1)
            var onThem = moving && t.kind == "human" && w.contact != null && w.contact.humanHex == t.hex ? sim.HumanByHex(t.hex) : null;
            bool stalled = onThem != null && SpotStalled(sim, w); // kept up every tick it touches them
            if (onThem != null && Sq(w.vx - v.x) + Sq(w.vy) + Sq(w.vz - v.z) < Sq(T.land.maxSpeed) && (dg < landSpot || stalled)) { o.mz = 0; o.burst = 0; return (o, null); }
            // as fast as it can still stop in: cruising until the braking distance, then down to a crawl at the spot
            Num want = moving ? Clamp(Min(d, dg) * 2.2, K.prey ? 0.3 : 0.06, top) * (dg < 0.15 && !K.prey ? 0.6 : 1)
                : Clamp(Sqrt(2 * T.wasp.accel * landBrake * (routed ? dg : Min(d, dg))), K.prey ? 0.3 : 0.06, top); // a waypoint is flown through
            Num fx = dx, fy = dy, fz = dz; // the way to fly
            if (moving)
            { // its velocity plus closing speed (prey is run down; a person is come up to gently); burst when that is past cruising
                Num close = (K.prey ? Max(want, chaseCloseMin) : want) / Max(d, 1e-6);
                fx = v.x + dx * close; fy = v.y + dy * close; fz = v.z + dz * close;
                if (onThem != null)
                { // touching them: slide along the body toward the spot rather than press into it
                    var nW = Body.DirToWorld(onThem.F, w.contact.n);
                    Num rx = fx - v.x, ry = fy - v.y, rz = fz - v.z, dn = rx * nW.x + ry * nW.y + rz * nW.z;
                    if (dn < 0) { rx -= dn * nW.x; ry -= dn * nW.y; rz -= dn * nW.z; fx = v.x + rx; fy = v.y + ry; fz = v.z + rz; }
                }
                { // the air moves it too: ask for the velocity less the wind's share, so it closes on the spot even downwind (T3-1)
                    var wd = sim.Drift(w); Num kw = Min(1, Sqrt(fx * fx + fy * fy + fz * fz) / top);
                    fx -= wd.x * kw; fz -= wd.z * kw;
                }
                Num sp = Sqrt(fx * fx + fy * fy + fz * fz); bool fast = sp > top; Num cap = fast ? T.wasp.burst * (w.carry != null ? T.wasp.carrySpeedMul : 1) : top;
                o.burst = fast || hurry ? 1 : 0;
                o.mz = RndI(Clamp(sp / cap, 0, 1) * 100);
            }
            else o.mz = RndI(Clamp(want / top, 0, 1) * 100);
            var h = AvoidHeading(sim, w, dx, dy, dz, d);
            if (!h.turned) { o.yawQ = RndI(DAtan2(fx, fz) * 1e4); o.pitchQ = RndI(Clamp(DAtan2(fy, Sqrt(fx * fx + fz * fz)), -1.45, 1.45) * 1e4); }
            else { o.yawQ = RndI(h.yaw * 1e4); o.pitchQ = RndI(Clamp(h.pitch, -1.45, 1.45) * 1e4); if (!moving) o.mz = o.mz > 50 ? o.mz : 50; }
            o.act = 0;
            return (o, null);
        }

        /// Hovering round a lock (GDD 7.9): H holds the wasp a short way off the target, facing it, and lets it drift slowly round
        /// it at its own unhurried speed, matching its pace if it moves; from there E lands at once. Matches poc/sim/assist.js HOVER.
        public static readonly Num hoverR = 0.35, hoverUp = 0.1, hoverSpeed = 1.2, hoverOrbit = 0.5, hoverGain = 3, hoverRMin = 0.15, hoverRMax = 1.2, hoverOrbitMax = 1.5;
        /// the player's own hover (GDD 19.6 T3-1): how far off and how fast round, clamped to the ranges
        public static (Num r, Num orbit) HoverSetting(Num r, Num orbit) => (Clamp(r, hoverRMin, hoverRMax), Clamp(orbit, -hoverOrbitMax, hoverOrbitMax));
        public static (Cmd cmd, string done) HoverPilot(Sim sim, Wasp w, LockTarget t, Cmd cmd) => HoverPilot(sim, w, t, cmd, hoverR, hoverOrbit);
        public static (Cmd cmd, string done) HoverPilot(Sim sim, Wasp w, LockTarget t, Cmd cmd, Num setR, Num setOrbit)
        {
            if (w.state == "landed" || w.state == "perched") return (new Cmd { mx = 0, my = 100, mz = 0, burst = 0, sting = 0, yawQ = cmd.yawQ, pitchQ = cmd.pitchQ, act = 0, alloc = cmd.alloc, pick = cmd.pick }, null); // up first
            if (w.state != "fly") return (cmd, "gone");
            var pp = TargetPos(sim, t);
            if (pp == null) return (cmd, "gone");
            var p = pp.Value; var v = TargetVel(sim, t);
            // the station: on the wasp's side of the target, a little further round each tick
            Num ux = w.x - p.x, uz = w.z - p.z, ul = Sqrt(ux * ux + uz * uz);
            if (ul < 1e-6) { ux = 1; uz = 0; } else { ux /= ul; uz /= ul; }
            Num a = DAtan2(ux, uz) + setOrbit / hoverGain, sx = p.x + DSin(a) * setR, sy = p.y + hoverUp, sz = p.z + DCos(a) * setR;
            // the velocity that takes it there and keeps it there: the target's own, plus the way back to station
            Num fx = (sx - w.x) * hoverGain, fy = (sy - w.y) * hoverGain, fz = (sz - w.z) * hoverGain, fl = Sqrt(fx * fx + fy * fy + fz * fz);
            if (fl > hoverSpeed) { fx *= hoverSpeed / fl; fy *= hoverSpeed / fl; fz *= hoverSpeed / fl; }
            fx += v.x; fy += v.y; fz += v.z;
            // facing the target, level: forward and sideways on the move keys, up and down on climb
            Num yaw = DAtan2(p.x - w.x, p.z - w.z), sy0 = DSin(yaw), cy0 = DCos(yaw), top = T.wasp.cruise * (w.carry != null ? T.wasp.carrySpeedMul : 1);
            Num mz = (fx * sy0 + fz * cy0) / top, mx = (-fx * cy0 + fz * sy0) / top, my = fy / T.wasp.climb, m = Sqrt(mz * mz + mx * mx + my * my);
            if (m > 1) { mz /= m; mx /= m; my /= m; }
            return (new Cmd { mx = RndI(mx * 100), my = RndI(my * 100), mz = RndI(mz * 100), burst = 0, sting = 0, yawQ = RndI(yaw * 1e4), pitchQ = 0, act = 0, alloc = cmd.alloc, pick = cmd.pick }, null);
        }

        /// the swoop with a lock: the dash homes on the target and the slam does what the target calls for; locked on a
        /// danger it dashes away instead. first presses the swoop; after that it steers until the dash is spent or hit.
        public static (Cmd cmd, string done) SwoopPilot(Sim sim, Wasp w, LockTarget t, Cmd cmd, bool first)
        {
            var K = Kinds.TryGetValue(t.kind, out var kk) ? kk : new TargetKind();
            if (w.state != "fly") return (cmd, w.state == "landed" ? "landed" : w.state == "perched" ? "perched" : "gone");
            if (!first && !(w.swoopUntil > sim.tick)) return (cmd, K.prey && w.carry != null ? "caught" : "spent");
            var p = TargetPos(sim, t);
            if (p == null) return (cmd, "gone");
            var o = new Cmd { mx = 0, my = 0, mz = 100, burst = 1, sting = 0, yawQ = cmd.yawQ, pitchQ = cmd.pitchQ, act = first ? Act.Swoop : 0, alloc = cmd.alloc, pick = cmd.pick };
            Num dx, dy, dz;
            if (K.hazard && !K.prey)
            {
                dx = w.x - p.Value.x; dz = w.z - p.Value.z; Num l = Sqrt(dx * dx + dz * dz); if (l == 0) l = 1; dx /= l; dz /= l; dy = -0.3;
            }
            else
            {
                var g = GoalOf(sim, t, p.Value); V3 gp = g != null ? g.p : p.Value;
                dx = gp.x - w.x; dy = gp.y - w.y; dz = gp.z - w.z;
                // full speed in, braking over the last half metre so it can turn onto the spot; a moving target is led, and
                // the braking keeps its pace on top
                Num d = Sqrt(dx * dx + dy * dy + dz * dz); var v = TargetVel(sim, t); Num vs = Sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
                if (vs > chaseMoving) { Num lead = Min(chaseLead, d / T.swoop.speed); dx += v.x * lead; dy += v.y * lead; dz += v.z * lead; }
                o.mz = RndI(Clamp(d * 12 + (vs > chaseMoving ? vs : 0), 1.5, T.swoop.speed) / T.swoop.speed * 100);
            }
            o.yawQ = RndI(DAtan2(dx, dz) * 1e4);
            o.pitchQ = RndI(Clamp(DAtan2(dy, Sqrt(dx * dx + dz * dz)), -1.45, 1.45) * 1e4);
            return (o, null);
        }

        public static string Label(LockTarget t)
        {
            if (t == null) return "";
            if (t.kind == "human")
            {
                var sb = new System.Text.StringBuilder();
                for (int i = 0; i < t.part.Length; i++) { char ch = t.part[i]; if (i > 0 && char.IsUpper(ch) && char.IsLower(t.part[i - 1])) sb.Append(' '); sb.Append(ch); }
                string s = sb.ToString();
                if (s.EndsWith(" L") || s.EndsWith("L") && s.Length > 1 && char.IsLower(s[s.Length - 2])) s = s.Substring(0, s.Length - (s.EndsWith(" L") ? 2 : 1)) + " (left)";
                else if (s.EndsWith(" R") || s.EndsWith("R") && s.Length > 1 && char.IsLower(s[s.Length - 2])) s = s.Substring(0, s.Length - (s.EndsWith(" R") ? 2 : 1)) + " (right)";
                return s.ToLowerInvariant();
            }
            return Kinds.TryGetValue(t.kind, out var k) ? k.label : t.kind;
        }
    }
}
