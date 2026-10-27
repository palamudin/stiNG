using System;
using Sting.Core;

namespace Sting.Core.Tests
{
    /// FNV-1a over IEEE-754 bytes, identical to poc/test/parity.mjs Digest()
    public sealed class Digest
    {
        uint h = 0x811c9dc5;
        /// The number's own bits: IEEE bytes in the double build (matching the JS), Q32.32 raw in the fixed build
        public void F(Num v)
        {
            ulong bits = (ulong)v.Bits;
            unchecked { for (int i = 0; i < 8; i++) { h ^= (byte)(bits >> (8 * i)); h *= 0x01000193; } }
        }
        public void F(bool v) => F(v ? 1 : 0);
        public void S(string s) { F(s.Length); foreach (char ch in s) F(ch); }
        public string Hex => h.ToString("x8");

        public void Chunk(ChunkContent c)
        {
            F(c.cx); F(c.cz); F(c.tint);
            F(c.trees.Count); foreach (var t in c.trees) { F(t.x); F(t.z); F(t.r); F(t.h); F(t.cr); F(t.shade); }
            F(c.tables.Count); foreach (var t in c.tables) { F(t.x); F(t.z); F(t.axisX); }
            F(c.benches.Count); foreach (var t in c.benches) { F(t.x); F(t.z); F(t.axisX); }
            F(c.cans.Count); foreach (var t in c.cans) { F(t.x); F(t.z); F(t.color); F(t.table); }
            F(c.flowers.Count); foreach (var t in c.flowers) { F(t.x); F(t.y); F(t.z); F(t.color); }
            F(c.caterpillars.Count); foreach (var t in c.caterpillars) { F(t.x); F(t.y); F(t.z); }
            F(c.flies.Count); foreach (var t in c.flies) { F(t.x); F(t.y); F(t.z); F(t.r); F(t.w1); F(t.w2); F(t.w3); F(t.p1); F(t.p2); F(t.p3); }
            F(c.humans.Count); foreach (var t in c.humans) { F(t.slot); F(t.x); F(t.z); F(t.fx); F(t.fz); F(t.posture == "sit"); F(t.exit); F(t.posture == "lie"); F(t.act == "stroll" ? 1 : t.act == "garden" ? 2 : t.act == "sun" ? 3 : 0); F(t.path == null ? 0 : t.path.Length); if (t.path != null) foreach (var v in t.path) F(v); F(t.evening); }
            F(c.boxes.Count); foreach (var t in c.boxes) { F(t.minx); F(t.maxx); F(t.miny); F(t.maxy); F(t.minz); F(t.maxz); F(t.wood); F(t.hive); F(t.shed); F(t.fence); F(t.mall); F(t.shop); }
            F(c.cylinders.Count); foreach (var t in c.cylinders) { F(t.x); F(t.z); F(t.r); F(t.h); }
            F(c.sugar.Count); foreach (var t in c.sugar) { F(t.x); F(t.y); F(t.z); F(t.rate); F(t.kind == "can" ? 1 : t.kind == "flower" ? 2 : t.kind == "spill" ? 3 : 4); F(t.table); }
            F(c.hives.Count);
            foreach (var t in c.hives)
            {
                F(t.x); F(t.z); F(t.fx); F(t.fz); F(t.ex); F(t.ey); F(t.ez); F(t.slot);
                foreach (var b in t.bees) { F(b.guard); F(b.p); F(b.w); F(b.tx); F(b.ty); F(b.tz); F(b.period); F(b.phase); }
            }
            F(c.traps.Count); foreach (var t in c.traps) { F(t.x); F(t.y); F(t.z); F(t.table); }
            F(c.webs.Count); foreach (var t in c.webs) { F(t.x); F(t.y); F(t.z); F(t.nx); F(t.nz); F(t.r); F(t.tree); }
            foreach (var list in new[] { c.birds, c.dragonflies }) { F(list.Count); foreach (var t in list) { F(t.x); F(t.y); F(t.z); F(t.r); F(t.period); F(t.phase); F(t.dir); } }
            F(c.rival != null ? 1 : 0);
            if (c.rival != null) { var r = c.rival; F(r.x); F(r.y); F(r.z); F(r.r); F(r.ex); F(r.ey); F(r.ez); F(r.workers); }
            F(c.sheds.Count); foreach (var t in c.sheds) { F(t.x); F(t.z); F(t.hw); F(t.hd); F(t.h); F(t.crack); F(t.eave); F(t.house); }
            F(c.hasNest);
            // regions (T1-12)
            F(c.use == "park" ? 0 : c.use == "yards" ? 1 : c.use == "mall" ? 2 : c.use == "forest" ? 3 : 4);
            foreach (var list in new[] { c.roads, c.lots }) { F(list.Count); foreach (var t in list) { F(t.minx); F(t.maxx); F(t.minz); F(t.maxz); } }
            F(c.loops.Count); foreach (var t in c.loops) { F(t.x); F(t.z); F(t.r); }
            F(c.malls.Count); foreach (var t in c.malls) { F(t.x); F(t.z); F(t.hw); F(t.hd); F(t.h); }
            F(c.baths.Count); foreach (var t in c.baths) { F(t.x); F(t.z); F(t.r); F(t.h); F(t.fountain); } // T2-1, T2-5
            // town centres (T2-5)
            F(c.plazas.Count); foreach (var t in c.plazas) { F(t.minx); F(t.maxx); F(t.minz); F(t.maxz); }
            F(c.shops.Count); foreach (var t in c.shops) { F(t.x); F(t.z); F(t.hw); F(t.hd); F(t.h); F(t.color); }
            F(c.gardens.Count); foreach (var t in c.gardens) { F(t.x); F(t.z); F(t.hw); F(t.hd); }
        }
    }
}
