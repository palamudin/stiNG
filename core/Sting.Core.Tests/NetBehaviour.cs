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
            // guards against another player (T1-13): B's wasp at A's entrance is chased and grappled; both peers agree
            {
                var lab = new NetLab(new Settings { seed = 1234 }, "good");
                lab.a.colony.adults = 120;
                var e = lab.a.nest.entrance; var n = lab.a.nest; Num od = Sqrt(Sq(e.x - n.x) + Sq(e.z - n.z)); if (od == 0) od = 1;
                var spot = P(e.x + (e.x - n.x) / od * 0.35, e.y, e.z + (e.z - n.z) / od * 0.35);
                int hunts = 0, fightsB = 0; var overA = new List<string>(); var overB = new List<string>();
                for (int i = 0; i < 3000; i++)
                {
                    var bw = lab.b.Driven();
                    if (i > 900 && bw != null && bw.state == "fly") Place(bw, spot);
                    lab.Step(Idle(), Idle());
                    foreach (var ev in lab.a.DrainEvents()) { if (ev.type == "guardHunt" && ev["player"] is bool pl && pl) hunts++; if (ev.type == "fightOver") overA.Add(ev["winner"] + ">" + ev["loser"]); }
                    foreach (var ev in lab.bEvents) { if (ev.type == "fight" && ev.d.ContainsKey("remote")) fightsB++; if (ev.type == "fightOver") overB.Add(ev["winner"] + ">" + ev["loser"]); }
                }
                int agree = overB.Count(f => overA.Contains(f));
                Okn(hunts >= 1 && fightsB >= 1 && overB.Count >= 1 && agree == overB.Count, $"another player's wasp at the entrance is chased and grappled by the guards, and both peers agree on the winner (hunts {hunts}, grappled {fightsB}, {agree}/{overB.Count})");
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
            // chunk authority and contested pickups (T1-19)
            {
                var lab = new NetLab(new Settings { seed = 1234, birds = false }, "good");
                for (int i = 0; i < 120; i++) lab.Step(Idle(), Idle());
                Sim A = lab.a, B = lab.b;
                var keys = A.activeChunks.Select(r => r.key).ToList();
                Okn(keys.All(k => A.ChunkAuthority(k) == B.ChunkAuthority(k)), $"both peers elect the same authority for every chunk ({string.Concat(keys.Select(k => A.ChunkAuthority(k)))})");
                var before = keys.Select(k => A.ChunkAuthority(k)).ToList();
                A.interest.Set(2, A.interest.Get(0));
                var after = keys.Select(k => A.ChunkAuthority(k)).ToList();
                A.interest.Delete(2);
                Okn(after.Contains(2) && after.Select((p, j) => p == before[j] || p == 2).All(x => x), $"a third peer takes some chunks and moves no others ({string.Concat(after)})");
                (bool[] took, bool[] held, int auth) Grab(string what, V3 spot)
                {
                    for (int i = 0; i < 400 && (A.Driven() == null || B.Driven() == null); i++) lab.Step(Idle(), Idle()); // a wasp lost earlier respawns
                    var wa = A.Driven(); var wb = B.Driven();
                    foreach (var w in new[] { wa, wb }) { w.x = spot.x; w.y = spot.y; w.z = spot.z; w.vx = w.vy = w.vz = 0; w.state = "fly"; w.carry = null; }
                    lab.Step(Idle(), Idle());
                    foreach (var w in new[] { wa, wb }) { w.x = spot.x; w.y = spot.y; w.z = spot.z; w.vx = w.vy = w.vz = 0; }
                    lab.Step(Idle(cm => cm.act = 1), Idle(cm => cm.act = 1));
                    var took = new[] { wa.carry?.what == what, wb.carry?.what == what };
                    for (int i = 0; i < 120; i++) lab.Step(Idle(), Idle());
                    return (took, new[] { wa.carry?.what == what, wb.carry?.what == what }, A.ChunkAuthority("0,0"));
                }
                var rec = A.records.Get("0,0"); int ci = -1;
                for (int i = 0; i < rec.content.caterpillars.Count && ci < 0; i++) if (!A.CS("0,0").caughtCat.ContainsKey(i) && A.CatActive(rec, i)) ci = i;
                var cp = rec.content.caterpillars[ci];
                var r1 = Grab("caterpillar", new V3(cp.x, cp.y, cp.z));
                Okn(r1.took[0] && r1.took[1] && r1.held.Count(x => x) == 1 && r1.held[r1.auth], $"both take the caterpillar at once; the chunk authority (peer {r1.auth}) keeps it, the other lets go");
                Okn(A.CS("0,0").caughtCat.ContainsKey(ci) && B.CS("0,0").caughtCat.ContainsKey(ci), "both peers have the caterpillar gone");
                Num cx = rec.cx * 64 + 5, cz = rec.cz * 64 + 5;
                foreach (var S in new[] { A, B })
                {
                    var st = S.CS("0,0"); st.carrion ??= new Dictionary<int, int>(); st.carrion[0] = T.eco.carrionLoads - 1;
                    S.carrionOverride = r => r.key == "0,0" && T.eco.carrionLoads - (st.carrion.TryGetValue(0, out var n) ? n : 0) > 0 ? new List<Carrion> { new Carrion { x = cx, y = 0.03, z = cz, d = 0, left = 1 } } : new List<Carrion>();
                }
                var r2 = Grab("carrion", new V3(cx, 0.05, cz));
                Okn(r2.held.Count(x => x) == 1 && A.CS("0,0").carrion[0] == T.eco.carrionLoads && B.CS("0,0").carrion[0] == T.eco.carrionLoads, $"the last load of carrion goes to one wasp, counted once on both peers ({A.CS("0,0").carrion[0]}/{B.CS("0,0").carrion[0]})");
                Okn(A.claims.Count == 0 && B.claims.Count == 0, "no claim is left waiting");
                A.carrionOverride = B.carrionOverride = null;
            }
            // relevance tiers (T1-21): swarm and traffic packets round-trip; a far peer gets swarm packets, not state
            {
                var sw = new SwarmMsg { peer = 0, tick = 777 };
                sw.wasps.Add(new RemoteWasp { id = 17, x = 3.25, y = 1.5, z = -7.75, state = "fly" });
                sw.wasps.Add(new RemoteWasp { id = 900017, caste = "queen", x = 70.5, y = 0.2, z = -95.25, state = "landed" });
                sw.wasps.Add(new RemoteWasp { id = 18, x = 4.5, y = 2.5, z = -8.5, state = "chewing", rival = true });
                var ds = Wire.DecodeSwarm(Wire.EncodeSwarm(sw)); double e = 0;
                foreach (var o in sw.wasps) { var w = ds.wasps.Find(x => x.id == o.id); e = Math.Max(e, w == null ? 9 : Math.Max(Math.Abs(D(w.x - o.x)), Math.Max(Math.Abs(D(w.y - o.y)), Math.Abs(D(w.z - o.z))))); }
                var tm = new TrafficMsg { peer = 0, tick = 5 }; tm.chunks.Add(new KeyValuePair<string, int>("3,-2", 41)); tm.chunks.Add(new KeyValuePair<string, int>("-1,0", 7));
                var tr = Wire.DecodeTraffic(Wire.EncodeTraffic(tm));
                Okn(e < 0.001 && ds.wasps.Count == 3 && ds.wasps.Find(x => x.id == 900017).caste == "queen" && ds.wasps.Find(x => x.id == 18).rival && tr.chunks[0].Key == "3,-2" && tr.chunks[1].Value == 7,
                    $"swarm packets round-trip within 1 mm ({e * 1000:0.00} mm), {Wire.BYTES_PER_SWARM_WASP} bytes per wasp; traffic counts too");
                int mp = T.ai.maxPhysical, le = T.ai.launchEvery;
                T.ai.maxPhysical = 200; T.ai.launchEvery = 3;
                Num Run(Num away, out int nWasps)
                {
                    var lab = new NetLab(new Settings { seed = 1234, birds = false, dayMinutes = 20 }, "good");
                    lab.a.colony.adults = 600; lab.a.colony.young = 0;
                    for (int k = 0; k < 200; k++) { var w = lab.a.SpawnWasp(false); w.role = k % 2 != 0 ? "sugar" : "protein"; }
                    Num b0 = 0;
                    for (int i = 0; i < 2400; i++)
                    {
                        var bw = lab.b.Driven(); if (bw != null && away > 0) { bw.x = lab.a.nest.x + away; bw.y = 2; bw.z = lab.a.nest.z; bw.vx = bw.vy = bw.vz = 0; }
                        lab.Step(Idle(), Idle()); lab.a.DrainEvents();
                        if (i == 1200) b0 = lab.bytesAB;
                    }
                    nWasps = lab.a.wasps.Count;
                    return (lab.bytesAB - b0) / 20 / 1024;
                }
                Num near = Run(0, out int n1), mid = Run(150, out int n2);
                T.ai.maxPhysical = mp; T.ai.launchEvery = le;
                Okn(n1 >= 120 && mid < near * 0.3, $"with {n1} wasps out: {D(near):0.0} KB/s to a peer among them, {D(mid):0.0} KB/s to one 150 m off");
            }
            // wire format: quantization error and size
            {
                var m = new StateMsg { peer = 1, tick = 123456 };
                m.wasps.Add(new RemoteWasp { id = 1000001, caste = "worker", x = -3.1234, y = 2.0456, z = -1.2789, vx = 2.9, vy = -0.4, vz = 1.1, state = "fly", carry = "fly" });
                m.wasps.Add(new RemoteWasp { id = 1000002, caste = "queen", x = 70.5, y = 0.0071, z = -95.25, state = "landed" });
                var bin = Wire.EncodeState(m); var d = Wire.DecodeState(bin);
                double err = 0;
                for (int i = 0; i < 2; i++) { var a = d.wasps[i]; var o = m.wasps[i]; err = Math.Max(err, Math.Max(Math.Abs(D(a.x - o.x)), Math.Max(Math.Abs(D(a.y - o.y)), Math.Abs(D(a.z - o.z))))); }
                Okn(err < 0.001 && d.wasps[1].caste == "queen" && d.wasps[0].carry == "fly" && d.wasps[1].state == "landed" && bin.Length == Wire.STATE_HEAD + 2 * Wire.BYTES_PER_WASP && d.tick == 123456,
                    $"state packet round-trips within 1 mm ({err * 1000:0.00} mm), {Wire.BYTES_PER_WASP} bytes per wasp");
            }
        }
    }
}
