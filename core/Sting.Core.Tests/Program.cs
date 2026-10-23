// Parity runner: recomputes every digest in core/fixtures/parity.txt from the C# port and compares.
// Run: dotnet run -c Release (from core/Sting.Core.Tests)
using System;
using System.Collections.Generic;
using System.IO;
using Sting.Core;
using static Sting.Core.R;

namespace Sting.Core.Tests
{
    static partial class Program
    {
        static readonly Dictionary<string, string> got = new Dictionary<string, string>();
        static void Out(string name, string hex) => got[name] = hex;
        static readonly ulong[] Seeds = { 1234UL, 7UL, 0xDEADBEEFCAFEBABEUL };

        static int Main(string[] args)
        {
            string fixtures = Path.Combine(AppContext.BaseDirectory, "../../../../fixtures/parity.txt");
            var want = new List<(string, string)>();
            foreach (var line in File.ReadAllLines(fixtures)) { if (line.Trim().Length == 0) continue; var p = line.Split(' '); want.Add((p[0], p[1])); }
            var sw = System.Diagnostics.Stopwatch.StartNew();
            WorldParity();
            BodyParity();
            ColonyParity();
            Extra();
            int fail = 0, pass = 0, missing = 0;
            foreach (var (name, hex) in want)
            {
                if (!got.TryGetValue(name, out var g)) { missing++; Console.WriteLine($"SKIP {name} (not ported yet)"); continue; }
                if (g == hex) { pass++; Console.WriteLine($"PASS {name} {hex}"); }
                else { fail++; Console.WriteLine($"FAIL {name} js {hex} cs {g}"); }
            }
            Console.WriteLine($"\n{pass} match, {fail} differ, {missing} not ported · {sw.ElapsedMilliseconds} ms");
            return fail == 0 ? 0 : 1;
        }

        static void WorldParity()
        {
            foreach (var seed in Seeds)
            {
                var d = new Digest();
                for (int cz = -4; cz <= 4; cz++) for (int cx = -4; cx <= 4; cx++) d.Chunk(World.GenerateChunk(seed, cx, cz));
                Out($"chunks.{seed}", d.Hex);
            }
            foreach (var seed in Seeds)
            {
                var d = new Digest();
                for (int day = 0; day < 60; day++) { var w = World.Weather(seed, day); d.F(w.rain); d.F(w.rainStart); d.F(w.rainEnd); d.F(w.@base); }
                for (int i = 0; i < 40; i++)
                {
                    ulong id = Hash(seed, Domain.WorldGen, U64(i), 3, 1000);
                    for (int day = 0; day < 20; day++) { var w = World.HumanWindow(seed, id, day, 1 - (i % 3) * 0.15); d.F(w != null ? 1 : 0); if (w != null) { d.F(w.arrive); d.F(w.leave); } }
                }
                Out($"weather.{seed}", d.Hex);
            }
            {
                var d = new Digest();
                var c = World.GenerateChunk(1234, 1, 0); var c2 = World.GenerateChunk(1234, 2, -1);
                for (int t = 0; t < 4000; t += 37)
                {
                    foreach (var fl in c.flies) { var p = World.FlyPos(fl, t + 0.25); d.F(p.x); d.F(p.y); d.F(p.z); }
                    foreach (var hv in c.hives) for (int k = 0; k < hv.bees.Count; k++) { var p = World.BeePos(hv, k, t); d.F(p.x); d.F(p.y); d.F(p.z); }
                    foreach (var b in Concat(c.birds, c2.birds)) { var p = World.BirdPos(b, t); d.F(p.x); d.F(p.y); d.F(p.z); }
                    foreach (var b in Concat(c.dragonflies, c2.dragonflies)) { var p = World.DragonPos(b, t); d.F(p.x); d.F(p.y); d.F(p.z); }
                }
                for (int i = 0; i < 2000; i++) { double y = DSin(i * 0.37) * (i % 9 - 4), x = DSin(i * 0.91 + 1) * (i % 5 - 2); d.F(DAtan2(y, x)); d.F(DSin(i * 0.013 - 7)); d.F(H32(i, -i * 3, i * 7 + 0.5, 1e9 + i)); }
                foreach (var site in new[] { "trunk", "ground", "branch", "wall", "attic" })
                {
                    var n = World.MakeNest(-3, -2, 4.5, 2.1, 7.25, 0.14, site);
                    foreach (var v in new[] { n.x, n.y, n.z, n.entrance.x, n.entrance.y, n.entrance.z, n.spawn.x, n.spawn.y, n.spawn.z, n.spawn.yaw }) d.F(v);
                    d.S(n.key);
                }
                var sheds = new List<Shed>(); sheds.AddRange(World.GenerateChunk(1234, 2, 0).sheds); sheds.AddRange(World.GenerateChunk(1234, -3, 1).sheds); sheds.AddRange(World.GenerateChunk(7, 1, 1).sheds);
                foreach (var sh in sheds) { var ss = World.ShedSites(sh); foreach (var p in new[] { ss.wall, ss.attic }) { d.F(p.x); d.F(p.y); d.F(p.z); d.F(p.ix); d.F(p.iz); d.F(p.nx); d.F(p.nz); } }
                Out("motion", d.Hex);
            }
        }

        static IEnumerable<TItem> Concat<TItem>(List<TItem> a, List<TItem> b) { foreach (var x in a) yield return x; foreach (var x in b) yield return x; }
        static partial void Extra();
    }
}
