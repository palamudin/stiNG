// The PoC's network checks (poc/test/net.test.mjs) that the lab digests do not already cover, ported.
// Run in both builds: peers far apart, rival fights across peers, a remote raid, pest control across peers, the wire format.
using System;
using System.Collections.Generic;
using System.Linq;
using Sting.Core;
using static Sting.Core.R;

namespace Sting.Core.Tests
{
    static partial class Program
    {
        static void Okn(bool cond, string msg) => Assert("net: " + msg, cond);

        static void NetBehaviour()
        {
            // peers far apart: B works a picnic two chunks east while A stays home; humans still agree everywhere
            {
                var lab = new NetLab(new Settings { seed = 1234 }, "good", Bots.StingBot("jab", h => h.chunk == "2,0", 240));
                var botA = Bots.StingBot("jab", null, 200);
                for (int i = 0; i < 18000; i++)
                {
                    var bw = lab.b.Driven();
                    Cmd cmdB = null;
                    if (bw != null && bw.x < 100 && !lab.b.active.Any(h => h.chunk == "2,0" && h.state == "idle" && h.posture == "sit" && Hypot(h.x - bw.x, h.z - bw.z) < 40))
                        cmdB = new Cmd { mz = 100, burst = 1, yawQ = RndI(PI / 2 * 1e4), pitchQ = bw.y < 2 ? 2000 : 0 };
                    lab.Step(botA(lab.a), cmdB);
                    lab.a.DrainEvents();
                    if (i % 60 == 0) lab.Check();
                }
                var c = lab.checks;
                Okn(lab.a.activeKey != lab.b.activeKey && lab.b.stats.stings > 0, $"apart: the peers work different chunks (A at {lab.a.activeKey}, B at {lab.b.activeKey}, B stung {lab.b.stats.stings})");
                Okn(c.agreed == c.compared && c.compared > 100, $"apart: human state identical on both peers ({c.agreed}/{c.compared})");
            }
            // rival fights across peers: A owns the rivals; B's wasp grapples one; both agree on every winner
            {
                ulong seed = 0; Rival rv = null;
                for (ulong sd = 1; sd < 80 && rv == null; sd++) { var t = new Sim(new Settings { seed = sd }); foreach (var r in t.activeChunks) if (r.content.rival != null) { seed = sd; rv = r.content.rival; break; } }
                int fightsB = 0; var overA = new List<string>(); var overB = new List<string>();
                foreach (var link in new[] { "good", "bad" })
                {
                    var lab = new NetLab(new Settings { seed = seed }, link);
                    for (int i = 0; i < 9000; i++)
                    {
                        var aw = lab.a.Driven(); var bw = lab.b.Driven();
                        if (aw != null && aw.state == "fly") Place(aw, P(rv.ex + 2.5, rv.ey + 1, rv.ez));
                        if (bw != null && (bw.state == "fly" || bw.state == "landed"))
                        {
                            bw.state = "fly";
                            RemoteWasp best = null; Num bd = 1e9;
                            foreach (var r in lab.b.remote.Values) if (r.rival && r.state == "fly") { Num d = Sq(r.x - bw.x) + Sq(r.z - bw.z); if (d < bd) { bd = d; best = r; } }
                            Place(bw, best != null && bd < 25 ? P(best.x + 0.01, best.y, best.z) : P(rv.ex + 0.5, rv.ey, rv.ez));
                        }
                        lab.Step(Idle(), Idle(cm => cm.sting = i % 6 < 3 ? 1 : 0));
                        foreach (var e in lab.a.DrainEvents()) if (e.type == "fightOver" && ((int)e["winner"] > 1000000 || (int)e["loser"] > 1000000)) overA.Add(e["winner"] + ">" + e["loser"]);
                        foreach (var e in lab.bEvents) { if (e.type == "fight" && e.d.ContainsKey("remote")) fightsB++; if (e.type == "fightOver") overB.Add(e["winner"] + ">" + e["loser"]); }
                    }
                }
                int agree = overB.Count(f => overA.Contains(f));
                Okn(fightsB >= 2 && overB.Count >= 2 && agree == overB.Count, $"a remote player's wasp fights A's rivals and both peers agree on every winner ({agree}/{overB.Count}, seed {seed})");
            }
            // a remote raid: B steals a larva from a rival nest whose guards live on A; A's guards hunt B's wasp down
            {
                ulong seed = 0; Rival rv = null;
                for (ulong sd = 1; sd < 80 && rv == null; sd++) { var t = new Sim(new Settings { seed = sd }); foreach (var r in t.activeChunks) if (r.content.rival != null) { seed = sd; rv = r.content.rival; break; } }
                var lab = new NetLab(new Settings { seed = seed }, "good");
                bool raided = false; int hunted = 0, grappled = 0;
                for (int i = 0; i < 6000; i++)
                {
                    var aw = lab.a.Driven(); var bw = lab.b.Driven();
                    if (aw != null && aw.state == "fly") Place(aw, P(rv.ex + 4, rv.ey + 1, rv.ez));
                    int act = 0;
                    if (bw != null && bw.state == "fly" && !raided)
                    {
                        if (i > 1200) { Place(bw, P(rv.ex, rv.ey - 0.02, rv.ez)); act = 1; }
                        else Place(bw, P(rv.ex + 3, rv.ey, rv.ez));
                    }
                    else if (bw != null && bw.state == "fly") Place(bw, P(rv.ex + 1, rv.ey, rv.ez));
                    lab.Step(Idle(), Idle(cm => cm.act = act));
                    foreach (var e in lab.bEvents) { if (e.type == "raid") raided = true; if (e.type == "fight" && e.d.ContainsKey("remote")) grappled++; }
                    lab.a.DrainEvents();
                    if (raided) hunted = Math.Max(hunted, lab.a.wasps.Count(w => w.colony != "own" && w.ai.mode == "hunt" && w.ai.huntId > 1000000));
                }
                Okn(raided && hunted >= 1 && grappled >= 1, $"a raid by another player sends the rival guards after that player, and they catch it (hunted {hunted}, grappled {grappled})");
            }
            // level 5 across peers: both start and end the campaign on the same tick and still agree on every human
            {
                var lab = new NetLab(new Settings { seed = 1234 }, "bad");
                var botA = Bots.StingBot("jab", null, 200);
                int sa = 0, sb = 0, ea = 0, eb = 0;
                for (int i = 0; i < 26000; i++)
                {
                    if (i == 600) { lab.a.CS("0,0").esc = 45; lab.b.CS("0,0").esc = 45; }
                    lab.Step(botA(lab.a));
                    foreach (var e in lab.a.DrainEvents()) { if (e.type == "muniStart") sa = lab.a.tick; if (e.type == "muniEnd") ea = lab.a.tick; }
                    foreach (var e in lab.bEvents) { if (e.type == "muniStart") sb = lab.b.tick; if (e.type == "muniEnd") eb = lab.b.tick; }
                    if (i % 60 == 0) lab.Check();
                }
                var c = lab.checks;
                Okn(sa != 0 && sa == sb && ea != 0 && ea == eb && c.agreed == c.compared, $"both peers run the municipal campaign on the same ticks ({sa}-{ea}) and agree on every human ({c.agreed}/{c.compared})");
            }
            // wire format: quantization error and size
            {
                var m = new StateMsg { peer = 1, tick = 123456 };
                m.wasps.Add(new RemoteWasp { id = 1000001, caste = "worker", x = -3.1234, y = 2.0456, z = -1.2789, vx = 2.9, vy = -0.4, vz = 1.1, state = "fly", carry = "fly" });
                m.wasps.Add(new RemoteWasp { id = 1000002, caste = "queen", x = 70.5, y = 0.0071, z = -95.25, state = "landed" });
                var bin = Wire.EncodeState(m); var d = Wire.DecodeState(bin);
                double err = 0;
                for (int i = 0; i < 2; i++) { var a = d.wasps[i]; var o = m.wasps[i]; err = Math.Max(err, Math.Max(Math.Abs(D(a.x - o.x)), Math.Max(Math.Abs(D(a.y - o.y)), Math.Abs(D(a.z - o.z))))); }
                Okn(err < 0.001 && d.wasps[1].caste == "queen" && d.wasps[0].carry == "fly" && d.wasps[1].state == "landed" && bin.Length == 6 + 2 * Wire.BYTES_PER_WASP && d.tick == 123456,
                    $"state packet round-trips within 1 mm ({err * 1000:0.00} mm), {Wire.BYTES_PER_WASP} bytes per wasp");
            }
        }
    }
}
