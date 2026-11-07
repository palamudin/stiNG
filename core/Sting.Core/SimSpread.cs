// Spreading the line (GDD 6.10) and the tutorial world's script (GDD 10.7). Port of the same section of poc/sim/sim.js.
using System.Collections.Generic;
using static Sting.Core.R;
using static Sting.Core.World;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed partial class Sim
    {
        /// the tutorial world's script (GDD 10.7)
        public Tut tut = new Tut();

        /// A rival nest as it stands: none once a queen of the player's has taken it (the chunk's state)
        internal Rival RivalOf(ChunkRec rec) { var rv = rec.content.rival; return rv != null && !(CS(rec.key).taken > 0) ? rv : null; }
        /// A way of spreading the line a species has: its trait (true to the insects that do it), or every one in the tutorial world
        bool Trait(string id, string sp)
        {
            if (settings.tutorial) return true;
            var row = T.species.Of(sp);
            return (id == "swarmFound" ? row.swarmFound : id == "usurp" ? row.usurp : row.emergency) > 0;
        }
        int Foundresses() { int n = 0; foreach (var w in wasps) if (w.foundress) n++; return n; }
        bool LineRoom() => line.Count + swarms.Count + Foundresses() + (colony.queenOrder != null ? 1 : 0) < LineMax();
        int RaiseTicks(Num days) => System.Math.Max(60, RndI(days * (Num)dayTicks * (settings.tutorial ? T.found.tutorial : 1)));

        /// Raise a queen to found a colony (swarmFound): from the colony in hand, for protein and sugar, in some days
        void RaiseQueen()
        {
            var c = colony;
            string why = !Trait("swarmFound", c.species ?? "wasp") ? "trait" : !c.sited || !c.nestAlive || !c.queenAlive || winter != null ? "nest" : c.queenOrder != null ? "raising"
                : !LineRoom() ? "cap" : c.adults < T.found.adults ? "adults" : c.protein < T.found.protein || c.sugar < T.found.sugar ? "food" : null;
            if (why != null) { Emit("queenDenied", ("why", why)); return; }
            c.protein -= T.found.protein; c.sugar -= T.found.sugar;
            c.queenOrder = tick + RaiseTicks(T.found.days);
            Emit("queenOrdered", ("at", c.queenOrder.Value));
        }
        /// at the colony's tick: the queen raised on order comes out, mated, to found; an emergency queen for a queenless colony
        void QueenTick(ColonyState c, Nest n, Num frac)
        {
            if (c.queenOrder != null && tick >= c.queenOrder.Value)
            {
                c.queenOrder = null;
                if (c.nestAlive)
                {
                    var q = SpawnWasp(false, "gyne"); q.role = "gyne"; q.foundress = true; q.mated = true; q.venom = 1;
                    q.ai.mode = "found"; q.ai.found = null; q.x = n.entrance.x; q.y = n.entrance.y - 0.03; q.z = n.entrance.z;
                    Emit("queenRaised", ("id", q.id));
                }
            }
            HeirTick(c, n, frac, "own");
        }
        /// emergency: a queenless colony with brood and food raises a new queen (honeybees)
        void HeirTick(ColonyState c, Nest n, Num frac, string who)
        {
            if (c.queenAlive || !c.nestAlive || !Trait("emergency", c.species ?? "wasp") || frac >= T.season.collapseFrom) { if (c.heir != null && (c.queenAlive || !c.nestAlive)) c.heir = null; return; }
            if (c.heir == null) { if (Colony.BroodTotal(c) >= T.found.heirBrood && c.sugar + c.protein > 1) c.heir = tick + RaiseTicks(T.found.heirDays); return; }
            if (tick < c.heir.Value) return;
            c.heir = null; c.queenAlive = true; c.sugarlessDays = 0;
            Emit("heirRaised", ("colony", who));
            FieldNote("emergency");
        }
        /// The nearest free tree for a foundress: no nest of the player's, a swarm's or another foundress's within minGap of it
        Tree FreeTree(Wasp w)
        {
            var used = new List<(Num x, Num z)> { (nest.treeX, nest.treeZ) };
            foreach (var x in line) used.Add((x.nest.treeX, x.nest.treeZ));
            foreach (var x in swarms) if (x.nest != null) used.Add((x.nest.treeX, x.nest.treeZ));
            foreach (var q in wasps) if (q.foundress && q != w && q.ai.found != null) used.Add((q.ai.found.tx, q.ai.found.tz));
            return LineTree(new HiberSite { x = w.x, z = w.z }, used);
        }
        static FoundSpot TreeNest(Tree t, WaspBase from)
        {
            Num dx = from.x - t.x, dz = from.z - t.z, d = Sqrt(dx * dx + dz * dz); if (d == 0) d = 1; dx /= d; dz /= d;
            return new FoundSpot { tx = t.x, tz = t.z, x = t.x + dx * (t.r + 0.2), y = Clamp(1.6, 1.2, Max(1.2, t.h - 0.6)), z = t.z + dz * (t.r + 0.2) };
        }
        /// A foundress on her own flies to the nearest free tree and founds there; flown by the player, she founds where E is
        /// pressed by a free trunk, or takes a small rival nest at its entrance
        Cmd ThinkFoundress(Wasp w, Cmd cmd)
        {
            var ai = w.ai;
            if (ai.found == null)
            {
                var t = FreeTree(w);
                if (t == null) { Steer(w, new V3(nest.entrance.x + 0.6, nest.entrance.y + 0.4, nest.entrance.z), cmd); return cmd; }
                ai.found = TreeNest(t, w);
            }
            var f = ai.found; var fp = new V3(f.x, f.y, f.z);
            Steer(w, fp, cmd);
            if (D2(w, fp) < 0.3 * 0.3) Found(w, f);
            return cmd;
        }
        void FoundHere(Wasp w)
        {
            var t = FreeTree(w); var f = t != null ? TreeNest(t, w) : null;
            if (f == null || Sq(w.x - f.x) + Sq(w.z - f.z) > T.found.reach * T.found.reach) { Emit("foundDenied", ("id", w.id), ("why", "site")); return; }
            Found(w, f);
        }
        /// the young queen's colony: a founding queen and the workers about her (the escort), a colony of the line
        void Found(Wasp q, FoundSpot f)
        {
            if (line.Count + swarms.Count >= LineMax()) { Emit("foundDenied", ("id", q.id), ("why", "cap")); return; }
            string sp = q.sp ?? species; var n = MakeNest(f.tx, f.tz, f.x, f.y, f.z, NEST.r, "trunk");
            var c = Colony.New(true, sp); c.sited = true; c.maxCells = MaxCells("trunk", sp); c.alloc = 0;
            int escort = 0; Num R2 = T.found.escortR * T.found.escortR;
            foreach (var w in new List<Wasp>(wasps))
            {
                if (w == q || w.id == drivenId || w.colony != "own" || w.caste != "worker" || D2(w, q) > R2 || (w.state != "fly" && w.state != "landed")) continue;
                wasps.Remove(w); colony.adults = Max(0, colony.adults - 1); c.adults += 1; escort++;
            }
            var sc = new LineColony { id = ++lineSeq, nest = n, colony = c, season = season.n };
            line.Add(sc);
            QueenGone(q);
            if (settings.tutorial) tut.founded = sc.id;
            Emit("founded", ("id", sc.id), ("x", n.x), ("z", n.z), ("escort", escort), ("species", sp));
            FieldNote("swarmfound");
        }
        /// A queen takes a small rival nest whose guards are down (usurp): she kills its queen and its workers raise her brood
        void Usurp(Wasp q, (Rival rv, string key) r)
        {
            var own = q.foundress ? null : colony; Num frac = SeasonFrac;
            var e = new V3(r.rv.ex, r.rv.ey, r.rv.ez); Num gr = T.rival.guardRadius * T.rival.guardRadius;
            int guards = 0; foreach (var x in wasps) if (x.colony == r.key && x.state != "dead" && D2(x, e) < gr) guards++; // its defenders at the door
            string why = !Trait("usurp", q.foundress ? q.sp : colony.species ?? "wasp") ? "trait" : !settings.tutorial && frac >= T.found.usurpFrac ? "late"
                : guards > 0 ? "guards" : q.foundress && line.Count + swarms.Count >= LineMax() ? "cap" : null;
            if (why != null)
            {
                Emit("usurpDenied", ("id", q.id), ("why", why), ("guards", guards));
                if (why == "guards") foreach (var x in wasps) if (x.colony == r.key && D2(x, e) < gr) { x.ai.mode = "hunt"; x.ai.huntId = q.id; x.ai.timer = tick + T.rival.huntTicks; }
                return;
            }
            var rv = r.rv; string sp = q.sp ?? species;
            int workers = 0;
            foreach (var x in new List<Wasp>(wasps)) if (x.colony == r.key) { wasps.Remove(x); workers++; } // the host's workers out are hers now
            var n = MakeNest(rv.x - rv.r - 0.25, rv.z, rv.x, rv.y, rv.z, rv.r, "branch"); n.entrance = new V3(rv.ex, rv.ey, rv.ez);
            var c = Colony.New(true, sp);
            c.sited = true; c.maxCells = MaxCells("branch", sp); c.alloc = 0; c.adults = T.found.hostAdults + rv.workers * T.found.hostWorker;
            c.eggs = 0; c.larvae = T.found.hostBrood; c.pupae = T.found.hostBrood / 2; c.cells = T.found.hostBrood * 4; c.protein = 1; c.sugar = 1.5; c.pulp = 1;
            CS(r.key).taken = 1;
            if (own != null)
            { // the player's own queen, not yet nested: this is her nest now
                c.stats = own.stats; c.xpSeen = own.xpSeen; c.vets = own.vets ?? new List<Vet>();
                colony = c; n.key = r.key; nest = n;
                Emit("usurped", ("id", q.id), ("key", r.key), ("own", true), ("workers", (int)Floor(c.adults)));
            }
            else
            {
                var sc = new LineColony { id = ++lineSeq, nest = n, colony = c, season = season.n };
                line.Add(sc);
                QueenGone(q);
                if (settings.tutorial) tut.usurped = sc.id;
                Emit("usurped", ("id", q.id), ("key", r.key), ("own", false), ("line", sc.id), ("workers", (int)Floor(c.adults)));
            }
            FieldNote("usurp");
        }
        /// a foundress gone into her nest: off the wing; flown by the player, the player goes on in a worker of the hand
        void QueenGone(Wasp q)
        {
            bool driven = q.id == drivenId;
            wasps.Remove(q);
            if (!driven) return;
            Wasp best = null; Num bd = Num.MaxValue;
            foreach (var w in wasps) if (w.colony == "own" && w.caste == "worker") { Num d = D2(w, q); if (d < bd) { bd = d; best = w; } }
            var nw = best ?? SpawnWasp(true);
            drivenId = nw.id;
            Emit("possess", ("id", nw.id), ("from", q.id));
        }
        /// a field note found by doing (the ways of spreading), as places are found by reaching them (T3-2)
        void FieldNote(string kind)
        {
            if (guide.ContainsKey(kind)) return;
            guide[kind] = day; guideOrder.Add(kind);
            Emit("fieldNote", ("kind", kind), ("day", day));
        }
        /// The tutorial world: once the player has founded a colony and taken one, the exterminator is called to the home nest
        /// and the taken one; with them gone the player goes on in the colony they founded
        void TutorialTick()
        {
            var t = tut;
            if (t.done) return;
            if (!t.ext && t.founded != 0 && t.usurped != 0 && settings.exterminator)
            {
                t.ext = true;
                var e = ext;
                if (colony.nestAlive && e.state != "active") { e.visit++; e.state = "scheduled"; e.forced = true; e.arriveMinute = minute + 30; Emit("extScheduled", ("visit", e.visit), ("arriveMinute", e.arriveMinute), ("why", "tutorial")); }
                var sc = line.Find(x => x.id == t.usurped);
                if (sc != null && sc.colony.nestAlive) { sc.ext = minute + 45; sc.extForced = true; Emit("sisterExtScheduled", ("id", sc.id), ("arriveMinute", sc.ext)); }
            }
            // the home nest gone: the player goes on in the colony they founded, at once
            if (t.ext && !t.moved && !colony.nestAlive)
            {
                var sc = line.Find(x => x.id == t.founded && x.colony.nestAlive);
                t.moved = true;
                if (sc != null) { TakeColony(sc); Emit("tutorialHome", ("id", sc.id)); }
            }
            if (t.moved && !line.Exists(x => x.id == t.usurped && x.colony.nestAlive)) { t.done = true; Emit("tutorialDone"); }
        }
    }
}
