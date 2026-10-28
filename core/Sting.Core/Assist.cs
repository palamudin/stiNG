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
                var hm = sim.HumanByHex(t.hex); var hp = hm != null ? HumanPoint(hm, t) : null;
                if (hp == null) return null;
                V3 q = hp.Value.p, n = hp.Value.n; Num off = R + 0.006;
                return new Goal { p = new V3(q.x + n.x * off, q.y + n.y * off, q.z + n.z * off), n = n };
            }
            return new Goal { p = p };
        }

        /// how far a moving target counts as moving (m/s), the most lead (s), the extra throttle share over its pace when
        /// steering by hand, and the least closing speed the pilot keeps (m/s); see assist.js
        public static readonly Num chaseMoving = 0.05, chaseLead = 0.5, chaseClose = 0.35, chaseCloseMin = 1;
        /// how fast a target is moving, m/s (zero for anything that stays put); prey positions are functions of the tick
        public static V3 TargetVel(Sim sim, LockTarget t)
        {
            var Z = new V3(0, 0, 0);
            if (t == null) return Z;
            if (t.kind == "wasp") { WaspBase x = (WaspBase)sim.WaspById(t.id) ?? sim.remote.Get(t.id); return x != null ? new V3(x.vx, x.vy, x.vz) : Z; }
            if (t.kind != "fly" && t.kind != "bee" && t.kind != "bird" && t.kind != "dragonfly") return Z;
            if (!sim.records.TryGet(t.key, out var rec)) return Z;
            var c = rec.content; int k = sim.tick; V3? a = null, b = null;
            if (t.kind == "fly") { if (t.i < c.flies.Count) { a = World.FlyPos(c.flies[t.i], k); b = World.FlyPos(c.flies[t.i], k + 1); } }
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

        public static (Cmd cmd, string done) Pilot(Sim sim, Wasp w, LockTarget t, Cmd cmd)
        {
            var K = Kinds.TryGetValue(t.kind, out var kk) ? kk : null;
            if (K == null || K.go == null) return (cmd, "no");
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
            Num top = T.wasp.cruise * (w.carry != null ? T.wasp.carrySpeedMul : 1);
            // a moving target: aim where it will be, and fly at its pace plus closing speed (with burst when it is quick)
            var v = TargetVel(sim, t); Num vs = Sqrt(v.x * v.x + v.y * v.y + v.z * v.z); bool moving = vs > chaseMoving;
            var g = g0;
            if (moving) { Num lead = Min(chaseLead, Sqrt(D2(w, g0.p)) / top); g = new Goal { p = new V3(g0.p.x + v.x * lead, g0.p.y + v.y * lead, g0.p.z + v.z * lead), above = g0.above, n = g0.n }; }
            Num hd = Sqrt(Sq(g.p.x - w.x) + Sq(g.p.z - w.z));
            V3 wp = g.p;
            if (g.above && hd > 0.06) wp = new V3(g.p.x, g.p.y + Min(0.4, 0.3 * hd + 0.04), g.p.z);
            else if (g.n != null && Sqrt(D2(w, g.p)) > 0.2) { var n = g.n.Value; wp = new V3(g.p.x + n.x * 0.15, g.p.y + n.y * 0.15, g.p.z + n.z * 0.15); }
            Num dx = wp.x - w.x, dy = wp.y - w.y, dz = wp.z - w.z, d = Sqrt(dx * dx + dy * dy + dz * dz), dg = Sqrt(D2(w, g0.p)); // how near it really is
            var o = Copy();
            if (K.prey && dg < T.prey.catchDist * 0.9) { o.mz = 0; o.act = (sim.tick & 1) != 0 ? 1 : 0; return (o, null); } // grab it
            if (dg < 0.004 && !K.prey) { o.mz = 0; return (o, null); } // hold still: it settles on its own
            Num want = Clamp(Min(d, dg) * 2.2, K.prey ? 0.3 : 0.06, top) * (dg < 0.15 && !K.prey ? 0.6 : 1);
            if (moving)
            { // its pace plus closing speed; burst when that is past cruising
                Num close = Max(want, chaseCloseMin); bool fast = vs + close > top; Num cap = fast ? T.wasp.burst * (w.carry != null ? T.wasp.carrySpeedMul : 1) : top;
                o.burst = fast ? 1 : 0;
                o.mz = RndI(Clamp((vs + close) / cap, 0, 1) * 100);
            }
            else o.mz = RndI(Clamp(want / top, 0, 1) * 100);
            var h = AvoidHeading(sim, w, dx, dy, dz, d);
            if (!h.turned) { o.yawQ = RndI(DAtan2(dx, dz) * 1e4); o.pitchQ = RndI(Clamp(DAtan2(dy, Sqrt(dx * dx + dz * dz)), -1.45, 1.45) * 1e4); }
            else { o.yawQ = RndI(h.yaw * 1e4); o.pitchQ = RndI(Clamp(h.pitch, -1.45, 1.45) * 1e4); if (!moving) o.mz = o.mz > 50 ? o.mz : 50; }
            o.act = 0;
            return (o, null);
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
