// Barbecues (GDD 4.3, 6.2, T1-10). Port of the barbecue part of sim.js: grills at some picnic tables, the cook, the
// meat on the grate and the plate, the hot grate and the hot air over it.
using System.Collections.Generic;
using static Sting.Core.R;
using static Sting.Core.World;
#pragma warning disable IDE1006
namespace Sting.Core
{
    /// a grill at the end of a table, where its cook stands, who cooks, and where the plate goes; plus today's barbecue
    public sealed class Grill
    {
        public int ti; public Num x, z, sx, sz, fx, fz, px, pz; public ulong cookId; public string cook;
        internal long d = long.MinValue; internal int s; internal bool on; internal Num from, end;
    }
    public sealed class Meat { public Num x, y, z; public int i, left; public bool hot; }

    public sealed partial class Sim
    {
        /// The grills of a chunk, derived from the seed at the sim level (the chunk generator is unchanged)
        public List<Grill> GrillsIn(ChunkRec rec)
        {
            if (rec.grills != null) return rec.grills;
            var c = rec.content; long sd = (long)(seed & 0xffffffffUL); var o = new List<Grill>();
            for (int ti = 0; ti < c.tables.Count; ti++)
            {
                var tb = c.tables[ti];
                if (HSeq(sd, rec.cx, rec.cz, ti, 941) >= T.bbq.share) continue;
                Num ux = tb.axisX ? -1 : 0, uz = tb.axisX ? 0 : -1, hw = 0.95;
                Num gx = tb.x + ux * (hw + T.bbq.gap), gz = tb.z + uz * (hw + T.bbq.gap), sx = gx + ux * T.bbq.station, sz = gz + uz * T.bbq.station;
                bool Clear(Num x, Num z, Num r)
                {
                    foreach (var cy in c.cylinders) if (!(Sq(cy.x - x) + Sq(cy.z - z) > Sq(cy.r + r))) return false;
                    foreach (var b in c.boxes) if (!(x < b.minx - r || x > b.maxx + r || z < b.minz - r || z > b.maxz + r)) return false;
                    return true;
                }
                if (!Clear(gx, gz, T.bbq.r + 0.1) || !Clear(sx, sz, 0.3)) continue;
                HumanSlot cook = null; int cs = int.MaxValue;
                foreach (var hs in c.humans) if (hs.posture == "sit" && Sq(hs.x - tb.x) + Sq(hs.z - tb.z) < 1.5 && hs.slot < cs) { cs = hs.slot; cook = hs; }
                if (cook == null) continue;
                ulong id = Hash(seed, Domain.WorldGen, U64(rec.cx), U64(rec.cz), (ulong)cook.slot);
                o.Add(new Grill { ti = ti, x = gx, z = gz, sx = sx, sz = sz, fx = -ux, fz = -uz, cookId = id, cook = Hex64(id),
                    px = tb.x + (tb.axisX ? T.bbq.along : 0), pz = tb.z + (tb.axisX ? 0 : T.bbq.along) });
            }
            rec.grills = o;
            return o;
        }

        /// Is there a barbecue at this grill today, and when (see sim.js _bbqDay)
        internal bool BbqDay(ChunkRec rec, Grill g)
        {
            long sd = (long)(seed & 0xffffffffUL), d = day;
            if (g.d == d && g.s == season.n) return g.on;
            g.d = d; g.s = season.n;
            var win = HumanWindow(seed, g.cookId, d, settings.humanDensity);
            g.on = false;
            if (win == null || HSeq(sd, rec.cx, rec.cz, g.ti, d, 943) >= T.bbq.dayChance || World.Weather(seed, d).rain || AirAt(d * 1440 + 13 * 60) < T.bbq.minTemp) return false;
            // people walk in real time while the clock runs on: the walk from the path to the seat in game minutes
            Num walk = Ceil(T.panic.approachDist / T.panic.walkSpeed * 1440 / (settings.dayMinutes * 60));
            g.from = Max(T.bbq.from + Floor((HSeq(sd, rec.cx, rec.cz, g.ti, d, 944) * 2 - 1) * T.bbq.jitter + 0.5), win.arrive + walk + T.bbq.settle);
            g.end = Min(g.from + T.bbq.to - T.bbq.from, win.leave - T.bbq.settle);
            g.on = g.end - g.from >= T.bbq.minLength;
            return g.on;
        }
        public bool BbqLit(ChunkRec rec, Grill g)
        {
            if (!BbqDay(rec, g) || Raining) return false;
            Num md = MinuteOfDay(minute);
            return md >= g.from && md < g.end;
        }
        public List<Meat> MeatIn(ChunkRec rec)
        {
            var o = new List<Meat>();
            chunkState.TryGet(rec.key, out var st);
            var taken = st?.meat;
            Num md = MinuteOfDay(minute); int lvl = EscLevel(rec.key);
            foreach (var g in GrillsIn(rec))
            {
                if (!BbqDay(rec, g)) continue;
                int t0 = taken != null && taken.TryGetValue(g.ti * 2, out var a) ? a : 0, t1 = taken != null && taken.TryGetValue(g.ti * 2 + 1, out var b) ? b : 0;
                int left0 = T.bbq.grillLoads - t0, left1 = T.bbq.plateLoads - t1;
                if (BbqLit(rec, g) && left0 > 0) o.Add(new Meat { x = g.x, y = T.bbq.grateY + 0.025, z = g.z, i = g.ti * 2, left = left0, hot = true });
                Num end = g.end + T.bbq.plateEnd;
                if (md >= g.from + T.bbq.serve && md < end && lvl < 2 && left1 > 0) o.Add(new Meat { x = g.px, y = 0.77, z = g.pz, i = g.ti * 2 + 1, left = left1, hot = false });
            }
            return o;
        }
        /// trunks and grills as solid cylinders, for collision and landing (a grill's top is its grate)
        /// the roofs of a chunk's sheds and houses, and a point in a roof's own frame (u across the ridge, y above the eaves,
        /// v along it) and back (sim.js _roofsOf)
        internal List<Roof> RoofsOf(ChunkRec rec) => rec.roofs ??= rec.content.sheds.ConvertAll(World.ShedRoof);
        internal static (Num u, Num y, Num v) RoofLocal(Roof f, Num x, Num y, Num z) => f.alongX ? (z - f.z, y - f.y0, x - f.x) : (x - f.x, y - f.y0, z - f.z);
        internal static V3 RoofWorld(Roof f, Num u, Num y, Num v) => f.alongX ? new V3(f.x + v, f.y0 + y, f.z + u) : new V3(f.x + u, f.y0 + y, f.z + v);
        internal List<Cyl> CylsOf(ChunkRec rec)
        {
            if (rec.cyls != null) return rec.cyls;
            var o = new List<Cyl>(rec.content.cylinders);
            foreach (var g in GrillsIn(rec)) o.Add(new Cyl { x = g.x, z = g.z, r = T.bbq.r, h = T.bbq.grateY, grill = true });
            return rec.cyls = o;
        }
        Grill GrillOf(Human hm)
        {
            if (!records.TryGet(hm.chunk, out var rec)) return null;
            foreach (var g in GrillsIn(rec)) if (g.cook == hm.hex) return g;
            return null;
        }
        /// the air over a lit grill: hot right over the grate, cooling with height; null elsewhere
        internal Num? GrillAir(Wasp w)
        {
            if (w.y < T.bbq.grateY || w.y > T.bbq.grateY + T.bbq.plumeH) return null;
            foreach (var rec in activeChunks) foreach (var g in GrillsIn(rec))
            {
                if (Sq(w.x - g.x) + Sq(w.z - g.z) > T.bbq.plumeR * T.bbq.plumeR || !BbqLit(rec, g)) continue;
                Num air = Temperature;
                return air + (T.bbq.plumeTemp - air) * (1 - (w.y - T.bbq.grateY) / T.bbq.plumeH);
            }
            return null;
        }
        bool OnHotGrate(Wasp w)
        {
            if (w.y > T.bbq.grateY + T.wasp.radius + T.bbq.burnH || w.y < T.bbq.grateY - 0.05) return false;
            foreach (var rec in activeChunks) foreach (var g in GrillsIn(rec)) if (Sq(w.x - g.x) + Sq(w.z - g.z) < T.bbq.r * T.bbq.r && BbqLit(rec, g)) return true;
            return false;
        }
        // the cook: to the grill while it is lit, standing at it, back to the seat when it goes out
        bool CookNow(Human hm)
        {
            var g = GrillOf(hm);
            return g != null && BbqLit(records.Get(hm.chunk), g);
        }
        void CookStep(Human hm)
        {
            var g = GrillOf(hm);
            if (g == null || !BbqLit(records.Get(hm.chunk), g)) { hm.state = "return"; Emit("cookEnd", ("humanHex", hm.hex)); return; }
            if (hm.state == "toGrill")
            {
                if (WalkTo(hm, g.sx, g.sz, T.panic.walkSpeed)) { hm.state = "cook"; hm.fx = g.fx; hm.fz = g.fz; }
                return;
            }
            Annoyance(hm);
        }
    }
}
