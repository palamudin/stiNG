// Scripted pilots (port of poc/sim/bots.js). They produce input commands exactly like a player would, so runs stay replayable.
using System;
using System.Collections.Generic;
using static Sting.Core.R;
namespace Sting.Core
{
    public static class Bots
    {
        public static Cmd IdleCmd(int yawQ = 9800) => new Cmd { yawQ = yawQ };

        /// Flies to a seated human's forearm, stings, gets out. plan: "jab" (release fast) or "full" (hold and linger).
        /// pick filters candidate humans; default: seated in the origin chunk.
        public static Func<Sim, Cmd> StingBot(string plan = "jab", Func<Human, bool> pick = null, int rest = 120)
        {
            pick ??= h => h.chunk == "0,0";
            string phase = "approach"; Human tHm = null; V3 tMid = default; int k = 0, idx = 0;
            return sim =>
            {
                var w = sim.wasp;
                Num wy = w != null ? w.yaw : 0; if (wy.IsNaN) wy = 0;
                var cmd = IdleCmd(RndI(wy * 1e4));
                if (w == null || w.state == "dead" || sim.Driven() == null) { phase = "approach"; tHm = null; return cmd; }
                if (tHm == null || tHm.state != "idle" || tHm.posture != "sit")
                {
                    var seated = sim.active.FindAll(h => h.posture == "sit" && h.state == "idle" && !h.special && pick(h));
                    if (seated.Count == 0) return cmd;
                    var hm = seated[idx++ % seated.Count];
                    Part part = null; foreach (var p in hm.sit) if (p.name == "ForearmR") { part = p; break; }
                    tHm = hm;
                    tMid = new V3((part.a.x + part.b.x) / 2, (part.a.y + part.b.y) / 2 + part.r + 0.012, (part.a.z + part.b.z) / 2);
                    phase = "approach";
                }
                var tp = Body.ToWorld(tHm.F, tMid);
                Num dx = tp.x - w.x, dy = tp.y - w.y, dz = tp.z - w.z, d = Sqrt(dx * dx + dy * dy + dz * dz);
                Num yaw = DAtan2(dx, dz), pitch = DAtan2(dy, Sqrt(dx * dx + dz * dz));
                if (phase == "approach")
                {
                    cmd.yawQ = RndI(yaw * 1e4); cmd.pitchQ = RndI(pitch * 1e4);
                    cmd.mz = (int)Max(6, Min(100, Rnd(Sqrt(2 * T.wasp.accel * d) * 0.7 / T.wasp.cruise * 100)));
                    if (d < 0.1) cmd.sting = 1;
                    if (w.state == "attached") { phase = "sting"; k = 0; }
                }
                if (phase == "sting")
                {
                    cmd.sting = 1; k++;
                    if (plan == "jab" && k >= T.sting.jabTicks + 1) cmd.sting = 0;
                    if (w.state == "fly" && k > 2) { phase = plan == "full" ? "linger" : "escape"; k = 0; }
                }
                if (phase == "linger") { if (++k > 25) { phase = "escape"; k = 0; } }
                if (phase == "escape")
                {
                    cmd.yawQ = RndI((yaw + PI) * 1e4); cmd.pitchQ = 3000; cmd.mz = 100; cmd.burst = 1;
                    if (++k > rest) { phase = "approach"; tHm = null; }
                }
                return cmd;
            };
        }
    }
}
