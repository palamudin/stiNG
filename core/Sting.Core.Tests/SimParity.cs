// Whole simulations driven by the same scripted pilots as poc/test/parity.mjs (SIM_SCENARIOS)
using System;
using Sting.Core;

namespace Sting.Core.Tests
{
    static partial class Program
    {
        static void SimParity()
        {
            Run("jab", new Settings { seed = 1234 }, 7200, () => Bots.StingBot("jab"));
            Run("full", new Settings { seed = 1234 }, 7200, () => Bots.StingBot("full", null, 60));
            Run("idle7", new Settings { seed = 7 }, 12000, () => sim => { var c = Bots.IdleCmd(); c.alloc = sim.tick < 4000 ? 0 : sim.tick < 8000 ? 2 : 4; return c; });
            Run("season", new Settings { seed = 99, dayMinutes = 0.4, seasonDays = 10 }, 30000, () => sim => Bots.IdleCmd());
            Run("hot", new Settings { seed = 1234, escalation = 6, reaction = 1.5 }, 20000, () => Bots.StingBot("full", h => true, 40));
        }

        static void Run(string name, Settings settings, int ticks, Func<Func<Sim, Cmd>> makeBot)
        {
            var d = new Digest(); var sim = new Sim(settings); var bot = makeBot();
            for (int t = 0; t < ticks; t++)
            {
                sim.Step(bot(sim));
                foreach (var e in sim.DrainEvents()) { d.S(e.type); d.F(e.t); }
                if (sim.tick % 60 == 0) { d.S(sim.StateHash()); d.S(sim.HumanHash()); }
            }
            d.S(sim.StateHash()); d.S(sim.HumanHash());
            Out($"sim.{name}", d.Hex);
        }
    }
}
