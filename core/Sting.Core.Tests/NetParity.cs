// Saved and restored worlds, and the networked labs, built the same way as poc/test/parity.mjs
using System;
using Sting.Core;

namespace Sting.Core.Tests
{
    static partial class Program
    {
        static void NetParity()
        {
            {
                var d = new Digest();
                var sim = new Sim(new Settings { seed = 1234, escalation = 3 }); var bot = Bots.StingBot("full", null, 50);
                for (int t = 0; t < 6000; t++)
                {
                    if (t == 3000) { sim = Persist.Restore(Persist.Snapshot(sim)); bot = Bots.StingBot("full", null, 50); }
                    sim.Step(bot(sim));
                    foreach (var e in sim.DrainEvents()) { d.S(e.type); d.F(e.t); }
                    if (sim.tick % 60 == 0) { d.S(sim.StateHash()); d.S(sim.HumanHash()); }
                }
                Out("sim.restored", d.Hex);
            }
            Lab("good", "good", 9000);
            Lab("awful", "awful", 6000);
            Lab("join", "good", 9000, 3000);
            Lab("cheat", "good", 14000, 0, true);
            {
                var d = new Digest(); var lab = new MeshLab(new Settings { seed = 1234 }, 3, "bad"); var botA = Bots.StingBot("jab", null, 200);
                lab.tamper = (from, m, sim) => { if (from == 2 && sim.tick > 1500 && m is NetEv ev && ev.type == "sting") foreach (var sw in ev.swats) sw.start += 1000; };
                for (int i = 0; i < 17400; i++) // the host cuts the cheater off near tick 16656
                {
                    lab.Step(botA(lab.sims[0]));
                    foreach (var s in lab.sims) foreach (var e in s.DrainEvents()) { d.S(e.type); d.F(e.t); }
                    if (i % 60 == 0) { d.F(lab.Agree(0, 1) ? 1 : 0); foreach (var s in lab.sims) { d.S(s.StateHash()); d.S(s.HumanHash()); } }
                }
                Out("net.mesh", d.Hex);
                Assert("net.mesh", lab.checks.agreed == lab.checks.compared && lab.sims[0].plaus.quarantined.Contains(2) && lab.sims[1].plaus.quarantined.Contains(2),
                    $"the host rules on the cheater, both honest peers cut it off and agree on every human ({lab.checks.agreed}/{lab.checks.compared})");
            }
        }

        static void Lab(string name, string link, int ticks, int joinAt = 0, bool cheat = false)
        {
            var d = new Digest(); var lab = new NetLab(new Settings { seed = 1234 }, link, null, joinAt); var botA = Bots.StingBot("jab", null, 200);
            if (cheat) lab.beforeOut = (sim, dir) => { if (dir == "ba" && sim.tick > 1200) foreach (var m in sim.outbox) if (m is NetEv ev && ev.type == "sting") foreach (var sw in ev.swats) sw.start += 1000; };
            for (int i = 0; i < ticks; i++)
            {
                lab.Step(botA(lab.a));
                foreach (var e in lab.a.DrainEvents()) { d.S(e.type); d.F(e.t); }
                foreach (var e in lab.bEvents) { d.S(e.type); d.F(e.t); }
                if (i % 60 == 0)
                {
                    d.F(lab.Check() == true ? 1 : 0);
                    d.S(lab.a.StateHash()); if (lab.b != null) d.S(lab.b.StateHash());
                    d.F(lab.a.remote.Count); var e = lab.RemoteError(); d.F(e ?? -1);
                }
            }
            Out($"net.{name}", d.Hex);
            var c = lab.checks;
            if (cheat) Assert($"net.{name}", lab.a.plaus.quarantined.Contains(1) && lab.a.remote.Count == 0, $"the cheating peer is quarantined (rejected {lab.a.netStats.rejected})");
            else Assert($"net.{name}", c.compared > 50 && c.agreed == c.compared, $"peers agree on every human ({c.agreed}/{c.compared})");
            stats.Add(Stat("net." + name, lab.a));
        }
    }
}
