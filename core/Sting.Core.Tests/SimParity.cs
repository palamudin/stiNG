// Whole simulations driven by the same scripted pilots as poc/test/parity.mjs (SIM_SCENARIOS)
using System;
using System.Collections.Generic;
using System.Globalization;
using Sting.Core;

namespace Sting.Core.Tests
{
    static partial class Program
    {
        /// Per scenario, once a second: tick, digest of every event so far, driven wasp position, adults
        static readonly Dictionary<string, List<string>> traces = new Dictionary<string, List<string>>();

        /// How far the two builds drift apart: the first second whose events differ, and the largest position gap before it
        static void CompareTraces(string thisBuild, string otherFile)
        {
            if (!System.IO.File.Exists(otherFile)) return;
            var other = new Dictionary<string, List<string[]>>();
            string cur = null;
            foreach (var line in System.IO.File.ReadAllLines(otherFile))
            {
                if (line.StartsWith("# ", StringComparison.Ordinal)) { cur = line.Substring(2); other[cur] = new List<string[]>(); continue; }
                other[cur].Add(line.Split(' '));
            }
            Console.WriteLine("\ndrift between the builds (fixed point against doubles), per scenario:");
            foreach (var kv in traces)
            {
                if (!other.TryGetValue(kv.Key, out var o)) continue;
                int firstEvent = -1; double gap = 0, adultsGap = 0;
                for (int i = 0; i < kv.Value.Count && i < o.Count; i++)
                {
                    var a = kv.Value[i].Split(' '); var b = o[i];
                    if (firstEvent < 0 && a[1] != b[1]) firstEvent = int.Parse(a[0]);
                    if (firstEvent >= 0) continue;
                    double P(string[] r, int k) => double.Parse(r[k], CultureInfo.InvariantCulture);
                    gap = Math.Max(gap, Math.Sqrt(Math.Pow(P(a, 2) - P(b, 2), 2) + Math.Pow(P(a, 3) - P(b, 3), 2) + Math.Pow(P(a, 4) - P(b, 4), 2)));
                    adultsGap = Math.Max(adultsGap, Math.Abs(P(a, 5) - P(b, 5)));
                }
                Console.WriteLine($"  {kv.Key,-8} {(firstEvent < 0 ? "same events throughout" : $"events first differ at tick {firstEvent}")}; until then the driven wasp is at most {gap * 1000:0.000} mm apart, adults at most {adultsGap:0.000000} apart");
            }
        }

        static void SaveTraces(string file)
        {
            var lines = new List<string>();
            foreach (var kv in traces) { lines.Add("# " + kv.Key); lines.AddRange(kv.Value); }
            System.IO.File.WriteAllLines(file, lines);
        }

        static void SimParity()
        {
            Run("jab", new Settings { seed = 1234 }, 7200, () => Bots.StingBot("jab"));
            Run("full", new Settings { seed = 1234 }, 7200, () => Bots.StingBot("full", null, 60));
            Run("idle7", new Settings { seed = 7 }, 12000, () => sim => { var c = Bots.IdleCmd(); c.alloc = sim.tick < 4000 ? 0 : sim.tick < 8000 ? 2 : 4; return c; });
            Run("season", new Settings { seed = 99, dayMinutes = 0.4, seasonDays = 10 }, 30000, () => sim => Bots.IdleCmd());
            Run("hot", new Settings { seed = 1234, escalation = 6, reaction = 1.5 }, 20000, () => Bots.StingBot("full", h => true, 40));
            // the species (GDD 6.8): hornets stinging through a night, a honeybee season with a swarm and a winter, bees that die stinging
            Run("hornet", new Settings { seed = 1234, species = "hornet" }, 9000, () => Bots.StingBot("full", null, 60));
            Run("bee", new Settings { seed = 99, dayMinutes = 0.4, seasonDays = 10, species = "bee" }, 30000, () => sim => Bots.IdleCmd());
            Run("beesting", new Settings { seed = 1234, species = "bee" }, 7200, () => Bots.StingBot("jab"));
            // a save restored mid-run must carry on exactly like the run that was never saved
            {
                string Go(bool save)
                {
                    var sim = new Sim(new Settings { seed = 1234, escalation = 3 }); var bot = Bots.StingBot("full", null, 50);
                    for (int t = 0; t < 7200; t++)
                    {
                        if (t == 3600) { if (save) sim = Persist.Restore(Persist.Snapshot(sim)); bot = Bots.StingBot("full", null, 50); }
                        sim.Step(bot(sim)); sim.DrainEvents();
                    }
                    return sim.StateHash() + "/" + sim.HumanHash();
                }
                string a = Go(false), b = Go(true);
                Assert("save.continues", a == b, $"{a} {(a == b ? "==" : "!=")} {b}");
            }
        }

        static void Run(string name, Settings settings, int ticks, Func<Func<Sim, Cmd>> makeBot)
        {
            var d = new Digest(); var sim = new Sim(settings); var bot = makeBot();
            uint kinds = 0x811c9dc5; var trace = new List<string>(); // what happened (event types and ticks only) and where, once a second
            for (int t = 0; t < ticks; t++)
            {
                sim.Step(bot(sim));
                foreach (var e in sim.DrainEvents()) { d.S(e.type); d.F(e.t); foreach (char ch in e.type + "@" + e.t) kinds = unchecked((kinds ^ ch) * 0x01000193); }
                if (sim.tick % 60 == 0)
                {
                    d.S(sim.StateHash()); d.S(sim.HumanHash());
                    var w = sim.wasp; double x = w != null ? (double)w.x : 0, y = w != null ? (double)w.y : 0, z = w != null ? (double)w.z : 0;
                    trace.Add(string.Join(" ", sim.tick, kinds.ToString("x8"), x.ToString("R", CultureInfo.InvariantCulture), y.ToString("R", CultureInfo.InvariantCulture), z.ToString("R", CultureInfo.InvariantCulture), ((double)sim.colony.adults).ToString("R", CultureInfo.InvariantCulture)));
                }
            }
            traces[name] = trace;
            d.S(sim.StateHash()); d.S(sim.HumanHash());
            Out($"sim.{name}", d.Hex);
            stats.Add(Stat(name, sim));
        }
    }
}
