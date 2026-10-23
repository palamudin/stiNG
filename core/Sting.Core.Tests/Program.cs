// Parity runner: recomputes every digest in core/fixtures/parity.txt from the C# port and compares.
// Run: dotnet run -c Release (from core/Sting.Core.Tests)
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Sting.Core;
using static Sting.Core.R;

namespace Sting.Core.Tests
{
    static partial class Program
    {
        static readonly Dictionary<string, string> got = new Dictionary<string, string>();
        static void Out(string name, string hex) => got[name] = hex;
        static readonly ulong[] Seeds = { 1234UL, 7UL, 0xDEADBEEFCAFEBABEUL };

        /// Properties that must hold in both builds (self-consistency, peers agreeing); name, held, detail
        static readonly List<(string name, bool ok, string detail)> asserts = new List<(string, bool, string)>();
        static void Assert(string name, bool ok, string detail = "") => asserts.Add((name, ok, detail));
        /// Outcome figures per scenario, written per build so the two builds can be compared
        static readonly List<string> stats = new List<string>();
        static string Fixtures(string f) => Path.Combine(AppContext.BaseDirectory, "../../../../fixtures/" + f);
        static string FixturesOut(string f) => Path.GetFullPath(Fixtures(f));

        static int Main(string[] args)
        {
            if (args.Length >= 1 && args[0] == "--opbench")
            {
                Num acc = 0.5, x = 1.2345, y = 0.987; int n = 5000000;
                void Time(string what, Func<Num> f) { var t0 = System.Diagnostics.Stopwatch.StartNew(); for (int i = 0; i < n; i++) acc += f(); Console.WriteLine($"{what,-12} {t0.Elapsed.TotalMilliseconds * 1e6 / n:0.0} ns"); }
                Time("mul", () => x * y); Time("div", () => x / y); Time("sqrt", () => Sqrt(x)); Time("literal", () => 0.97); Time("dsin", () => DSin(x)); Time("add", () => x + y);
                Console.WriteLine(acc);
                return 0;
            }
            if (args.Length >= 1 && args[0] == "--bench")
            {
                // time per tick of a busy world: AI foragers out, the player stinging, humans reacting
                foreach (var (name, set) in new[] { ("jab", new Settings { seed = 1234 }), ("hot", new Settings { seed = 1234, escalation = 6, reaction = 1.5 }) })
                {
                    var sim = new Sim(set); var bot = Bots.StingBot("full", h => true, 40);
                    for (int t = 0; t < 3000; t++) { sim.Step(bot(sim)); sim.DrainEvents(); }
                    var sw0 = System.Diagnostics.Stopwatch.StartNew(); int n = 12000, wasps = 0;
                    for (int t = 0; t < n; t++) { sim.Step(bot(sim)); sim.DrainEvents(); wasps += sim.wasps.Count; }
                    Console.WriteLine($"{name}: {sw0.Elapsed.TotalMilliseconds * 1000 / n:0.0} µs per tick, {(double)wasps / n:0.0} wasps out on average, {sim.active.Count} humans");
                }
                return 0;
            }
            if (args.Length >= 2 && args[0] == "--events")
            {
                // print every event of the jab scenario up to a tick, to see where the two builds part
                var sim = new Sim(new Settings { seed = 1234 }); var bot = Bots.StingBot("jab"); int until = int.Parse(args[1]);
                for (int t = 0; t < until; t++) { sim.Step(bot(sim)); foreach (var e in sim.DrainEvents()) Console.WriteLine($"{e.t} {e.type} {string.Join(",", e.d.Values)}"); }
                return 0;
            }
            var sw = System.Diagnostics.Stopwatch.StartNew();
            WorldParity();
            BodyParity();
            ColonyParity();
            SimParity();
            NetParity();
            Extra();
            NetBehaviour();
            int fail = 0;
            foreach (var (name, ok, detail) in asserts) { Console.WriteLine($"{(ok ? "PASS" : "FAIL")} {name} {detail}"); if (!ok) fail++; }
#if STING_FIXED
            const string build = "fixed";
            // Q32.32 cannot match the JS doubles; the fixed build is locked against its own earlier digests instead
            string lockFile = FixturesOut("fixed.txt");
            bool update = Array.IndexOf(args, "--update") >= 0 || !File.Exists(lockFile);
            var want = update ? new List<(string, string)>() : Read(lockFile);
            if (update) { var lines = new List<string>(); foreach (var kv in got) lines.Add(kv.Key + " " + kv.Value); File.WriteAllLines(lockFile, lines); Console.WriteLine($"wrote {lockFile}"); }
#else
            const string build = "double";
            var want = Read(Fixtures("parity.txt"));
#endif
            int pass = 0, differ = 0, missing = 0;
            foreach (var (name, hex) in want)
            {
                if (!got.TryGetValue(name, out var g)) { missing++; Console.WriteLine($"SKIP {name} (not ported yet)"); continue; }
                if (g == hex) { pass++; Console.WriteLine($"PASS {name} {hex}"); }
                else { differ++; Console.WriteLine($"FAIL {name} want {hex} got {g}"); }
            }
            File.WriteAllLines(FixturesOut($"stats.{build}.txt"), stats);
            SaveTraces(FixturesOut($"trace.{build}.txt"));
            CompareTraces(build, FixturesOut(build == "fixed" ? "trace.double.txt" : "trace.fixed.txt"));
            string other = FixturesOut(build == "fixed" ? "stats.double.txt" : "stats.fixed.txt");
            if (File.Exists(other))
            {
                Console.WriteLine($"\noutcomes, this build ({build}) | the other build:");
                var o = File.ReadAllLines(other);
                for (int i = 0; i < stats.Count; i++) Console.WriteLine($"  {stats[i]}\n  {(i < o.Length ? o[i] : "")}");
            }
            Console.WriteLine($"\n{build} build: {pass} digests match, {differ} differ, {missing} missing; {asserts.Count - fail}/{asserts.Count} properties hold · {sw.ElapsedMilliseconds} ms");
            return differ == 0 && fail == 0 ? 0 : 1;
        }

        static List<(string, string)> Read(string path)
        {
            var want = new List<(string, string)>();
            foreach (var line in File.ReadAllLines(path)) { if (line.Trim().Length == 0) continue; var p = line.Split(' '); want.Add((p[0], p[1])); }
            return want;
        }

        static string Stat(string name, Sim s) =>
            $"{name,-10} stings {s.stats.stings + s.stats.aiStings,4} (driven {s.stats.stings,3}) deaths {s.stats.deaths,3} caught {s.stats.caught,4} deposits {s.stats.deposits,4} " +
            $"adults {(double)s.colony.adults,8:0.0} brood {(double)Colony.BroodTotal(s.colony),8:0.0} season {s.season.n} humans stung {s.stung.Count}";

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
                for (int i = 0; i < 2000; i++) { Num y = DSin(i * 0.37) * (i % 9 - 4), x = DSin(i * 0.91 + 1) * (i % 5 - 2); d.F(DAtan2(y, x)); d.F(DSin(i * 0.013 - 7)); d.F(H32(i, -i * 3, i * 7 + 0.5, 1e9 + i)); }
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
