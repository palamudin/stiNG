// sting-headless: runs a STING world with no window and writes a state hash stream (GDD 14).
//
// The point is cross-machine determinism: run the same command on Windows, Linux and ARM and compare the outputs
// line by line. Same seed, settings and input must give the same stream everywhere, and in the fixed-point build
// that holds on any CPU and compiler.
//
//   sting-headless run [--seed N] [--ticks N] [--bot jab|full|idle] [--set key=value ...] [--every N]
//                      [--out hashes.txt] [--log input.stl] [--save world.sav [--save-at TICK]]
//   sting-headless replay --log input.stl [--out hashes.txt] [--every N]
//   sting-headless resume --save world.sav --log input.stl [--ticks N] [--out hashes.txt]
//   sting-headless compare a.txt b.txt
//
// An input log (.stl) holds the world's settings and every tick's command, so a replay needs nothing else.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Sting.Core;

namespace Sting.Headless
{
    static class Program
    {
        const uint LOG_MAGIC = 0x4C4E5453; // "STNL"
        const int LOG_VERSION = 1;

        static int Main(string[] args)
        {
            if (args.Length == 0) return Usage();
            try
            {
                switch (args[0])
                {
                    case "run": return Run(Opts(args));
                    case "replay": return Replay(Opts(args));
                    case "resume": return Resume(Opts(args));
                    case "compare": return args.Length == 3 ? Compare(args[1], args[2]) : Usage();
                    default: return Usage();
                }
            }
            catch (Exception e) when (e is IOException || e is InvalidDataException || e is FormatException || e is ArgumentException)
            {
                Console.Error.WriteLine("error: " + e.Message);
                return 2;
            }
        }

        static int Usage()
        {
            Console.Error.WriteLine(@"sting-headless " + Build + @"
  run [--seed N] [--ticks N] [--bot jab|full|idle] [--set key=value ...] [--every N] [--out file] [--log file] [--save file [--save-at TICK]]
  replay --log file [--out file] [--every N]
  resume --save file --log file [--ticks N] [--out file] [--every N]
  compare a.txt b.txt
settings keys: dayMinutes humanDensity beeAggression seasonDays reaction escalation exterminator birds rivals pestControl");
            return 1;
        }

#if STING_FIXED
        const string Build = "(fixed point)";
#else
        const string Build = "(doubles)";
#endif

        sealed class O
        {
            public ulong seed = 1234; public int ticks = 36000, every = 60, saveAt = -1; public string bot = "jab", outFile, log, save;
            public List<string> set = new List<string>();
        }

        static O Opts(string[] a)
        {
            var o = new O();
            for (int i = 1; i < a.Length; i++)
            {
                string Next() => i + 1 < a.Length ? a[++i] : throw new ArgumentException($"{a[i]} needs a value");
                switch (a[i])
                {
                    case "--seed": o.seed = ulong.Parse(Next(), CultureInfo.InvariantCulture); break;
                    case "--ticks": o.ticks = int.Parse(Next(), CultureInfo.InvariantCulture); break;
                    case "--every": o.every = Math.Max(1, int.Parse(Next(), CultureInfo.InvariantCulture)); break;
                    case "--bot": o.bot = Next(); break;
                    case "--set": o.set.Add(Next()); break;
                    case "--out": o.outFile = Next(); break;
                    case "--log": o.log = Next(); break;
                    case "--save": o.save = Next(); break;
                    case "--save-at": o.saveAt = int.Parse(Next(), CultureInfo.InvariantCulture); break;
                    default: throw new ArgumentException("unknown option " + a[i]);
                }
            }
            return o;
        }

        static Settings MakeSettings(O o)
        {
            var s = new Settings { seed = o.seed };
            foreach (var kv in o.set)
            {
                int eq = kv.IndexOf('=');
                if (eq < 0) throw new ArgumentException("--set wants key=value, got " + kv);
                string k = kv.Substring(0, eq), v = kv.Substring(eq + 1);
                Num N() => double.Parse(v, CultureInfo.InvariantCulture);
                bool B() => v == "true" || v == "1" ? true : v == "false" || v == "0" ? false : throw new ArgumentException($"{k} is true or false");
                switch (k)
                {
                    case "dayMinutes": s.dayMinutes = N(); break;
                    case "humanDensity": s.humanDensity = N(); break;
                    case "beeAggression": s.beeAggression = N(); break;
                    case "seasonDays": s.seasonDays = N(); break;
                    case "reaction": s.reaction = N(); break;
                    case "escalation": s.escalation = N(); break;
                    case "exterminator": s.exterminator = B(); break;
                    case "birds": s.birds = B(); break;
                    case "rivals": s.rivals = B(); break;
                    case "pestControl": s.pestControl = B(); break;
                    default: throw new ArgumentException("unknown setting " + k);
                }
            }
            return s;
        }

        static Func<Sim, Cmd> MakeBot(string name) => name switch
        {
            "jab" => Bots.StingBot("jab", h => true),
            "full" => Bots.StingBot("full", h => true, 60),
            "idle" => sim => Bots.IdleCmd(),
            _ => throw new ArgumentException("bot is jab, full or idle"),
        };

        /// One line per sample: tick, state hash, human hash, wasps out, colony adults (2 decimals) and the build
        static string Line(Sim s) => string.Join(" ", s.tick, s.StateHash(), s.HumanHash(), s.wasps.Count, ((double)s.colony.adults).ToString("0.00", CultureInfo.InvariantCulture));

        static int Run(O o)
        {
            var settings = MakeSettings(o);
            var sim = new Sim(settings); var bot = MakeBot(o.bot);
            var lines = new List<string> { Header(settings) };
            var sw = System.Diagnostics.Stopwatch.StartNew();
            for (int t = 0; t < o.ticks; t++)
            {
                if (o.save != null && t == o.saveAt) File.WriteAllBytes(o.save, Persist.Snapshot(sim));
                sim.Step(bot(sim)); sim.DrainEvents();
                if (sim.tick % o.every == 0) lines.Add(Line(sim));
            }
            lines.Add(Line(sim));
            Write(o.outFile, lines);
            if (o.log != null) WriteLog(o.log, settings, sim.log, sim.logLen);
            if (o.save != null && o.saveAt < 0) File.WriteAllBytes(o.save, Persist.Snapshot(sim));
            Console.Error.WriteLine($"{o.ticks} ticks in {sw.ElapsedMilliseconds} ms ({sw.Elapsed.TotalMilliseconds * 1000 / Math.Max(1, o.ticks):0.0} µs per tick) {Build}; final {Line(sim)}");
            return 0;
        }

        static int Replay(O o)
        {
            if (o.log == null) throw new ArgumentException("replay needs --log");
            var (settings, cmds) = ReadLog(o.log);
            var sim = new Sim(settings);
            var lines = new List<string> { Header(settings) };
            int n = cmds.Length / Sim.CMD_FIELDS;
            for (int t = 0; t < n; t++)
            {
                sim.Step(Sim.CmdAt(cmds, t)); sim.DrainEvents();
                if (sim.tick % o.every == 0) lines.Add(Line(sim));
            }
            lines.Add(Line(sim));
            Write(o.outFile, lines);
            Console.Error.WriteLine($"replayed {n} ticks {Build}; final {Line(sim)}");
            return 0;
        }

        static int Resume(O o)
        {
            if (o.save == null || o.log == null) throw new ArgumentException("resume needs --save and --log");
            var sim = Persist.Restore(File.ReadAllBytes(o.save));
            var (_, cmds) = ReadLog(o.log);
            // the log runs from tick 0; the save knows its tick, so carry on from the matching command
            int from = sim.tick, n = Math.Min(o.ticks, cmds.Length / Sim.CMD_FIELDS - from);
            if (n < 0) throw new ArgumentException($"the log ends before the save's tick {from}");
            var lines = new List<string> { Header(sim.settings) };
            for (int t = 0; t < n; t++)
            {
                sim.Step(Sim.CmdAt(cmds, from + t)); sim.DrainEvents();
                if (sim.tick % o.every == 0) lines.Add(Line(sim));
            }
            lines.Add(Line(sim));
            Write(o.outFile, lines);
            Console.Error.WriteLine($"resumed at tick {sim.tick - n} for {n} ticks {Build}; final {Line(sim)}");
            return 0;
        }

        static int Compare(string a, string b)
        {
            var A = File.ReadAllLines(a); var B = File.ReadAllLines(b);
            for (int i = 0; i < Math.Max(A.Length, B.Length); i++)
            {
                string x = i < A.Length ? A[i] : "(missing)", y = i < B.Length ? B[i] : "(missing)";
                if (x != y) { Console.WriteLine($"line {i + 1} differs:\n  {a}: {x}\n  {b}: {y}"); return 1; }
            }
            Console.WriteLine($"identical: {A.Length} lines");
            return 0;
        }

        static string Header(Settings s) => $"# sting {Build} seed {s.seed} rules {s.RulesHash()} {s.WorldTag()}".TrimEnd();

        static void Write(string file, List<string> lines)
        {
            if (file == null) foreach (var l in lines) Console.WriteLine(l);
            else File.WriteAllLines(file, lines);
        }

        static void WriteLog(string file, Settings settings, int[] log, int len)
        {
            using var w = new BinaryWriter(File.Create(file));
            w.Write(LOG_MAGIC); w.Write(LOG_VERSION);
            WriteSettings(w, settings);
            w.Write(len);
            for (int i = 0; i < len; i++) w.Write(log[i]);
        }

        // settings travel as plain doubles, so a log written by one build replays in the other
        static void WriteSettings(BinaryWriter w, Settings s)
        {
            w.Write(s.seed);
            foreach (var n in new[] { s.dayMinutes, s.humanDensity, s.beeAggression, s.seasonDays, s.reaction, s.escalation }) w.Write((double)n);
            foreach (var b in new[] { s.exterminator, s.birds, s.rivals, s.pestControl }) w.Write(b);
        }
        static Settings ReadSettings(BinaryReader r) => new Settings
        {
            seed = r.ReadUInt64(), dayMinutes = r.ReadDouble(), humanDensity = r.ReadDouble(), beeAggression = r.ReadDouble(), seasonDays = r.ReadDouble(),
            reaction = r.ReadDouble(), escalation = r.ReadDouble(), exterminator = r.ReadBoolean(), birds = r.ReadBoolean(), rivals = r.ReadBoolean(), pestControl = r.ReadBoolean(),
        };

        static (Settings, int[]) ReadLog(string file)
        {
            using var r = new BinaryReader(File.OpenRead(file));
            if (r.ReadUInt32() != LOG_MAGIC) throw new InvalidDataException(file + " is not a STING input log");
            int v = r.ReadInt32();
            if (v != LOG_VERSION) throw new InvalidDataException($"input log version {v} is not {LOG_VERSION}");
            var s = ReadSettings(r);
            int len = r.ReadInt32();
            var log = new int[len];
            for (int i = 0; i < len; i++) log[i] = r.ReadInt32();
            return (s, log);
        }
    }
}
