// The PoC's headless sim checks (poc/test/sim.test.mjs), ported. They run in both builds: in the double build they
// confirm the port behaves like the JS; in the fixed-point build they confirm every mechanic still works in Q32.32.
using System;
using System.Collections.Generic;
using System.Linq;
using Sting.Core;
using static Sting.Core.R;

namespace Sting.Core.Tests
{
    static partial class Program
    {
        static Cmd Idle(Action<Cmd> f = null) { var c = new Cmd { yawQ = 9800 }; f?.Invoke(c); return c; }
        static List<SimEvent> RunS(Sim sim, int n, Func<Sim, int, Cmd> f = null)
        {
            var ev = new List<SimEvent>();
            for (int i = 0; i < n; i++) { sim.Step(f != null ? f(sim, i) : Idle()); ev.AddRange(sim.DrainEvents()); }
            return ev;
        }
        static int Count(List<SimEvent> ev, string type) => ev.Count(e => e.type == type);
        static SimEvent Find(List<SimEvent> ev, string type) => ev.FirstOrDefault(e => e.type == type);
        static void Place(WaspBase w, V3 p) { w.x = p.x; w.y = p.y; w.z = p.z; w.vx = w.vy = w.vz = 0; }
        static V3 P(Num x, Num y, Num z) => new V3(x, y, z);
        static Human Seated(Sim sim, Func<Human, bool> pred) => sim.active.FirstOrDefault(h => !h.special && h.posture == "sit" && h.state == "idle" && pred(h));
        static double D(Num n) => (double)n;
        static string Cause(SimEvent e) => e == null ? "none" : (string)e["cause"];
        static void Ok(bool cond, string msg) => Assert("sim: " + msg, cond);
        static double Hypot(Num a, Num b) => Math.Sqrt(D(a) * D(a) + D(b) * D(b));
        static Sim Spring(ulong seed = 1234)
        {
            var t = new Sim(new Settings { seed = seed });
            t.colony.mated = 200;
            t.season.startMinute -= 0.71 * t.settings.seasonDays * 1440;
            RunS(t, 120);
            RunS(t, 1, (sim, i) => Idle(c => c.pick = 1)); // wake the first queen (T1-15)
            return t;
        }

        static partial void Extra()
        {
            // 1. deterministic sine and arctangent are accurate
            {
                double maxErr = 0;
                for (double x = -20; x <= 20; x += 0.001) maxErr = Math.Max(maxErr, Math.Max(Math.Abs(D(DSin(x)) - Math.Sin(x)), Math.Abs(D(DCos(x)) - Math.Cos(x))));
                double aErr = 0;
                for (int i = 0; i < 20000; i++) { double y = Math.Sin(i * 0.37) * (i % 9 - 4), x = Math.Sin(i * 0.91 + 1) * (i % 5 - 2); if (x == 0 && y == 0) continue; double e = Math.Abs(D(DAtan2(y, x)) - Math.Atan2(y, x)); aErr = Math.Max(aErr, Math.Min(e, Math.Abs(e - 2 * Math.PI))); } // ±π on the cut is the same angle
                Ok(maxErr < 1e-6 && aErr < 1e-6, $"dsin/dcos/datan2 max error {maxErr:E2} / {aErr:E2}");
            }
            // 1b. everything a chunk holds lies within reach of its centre, so scans may skip far chunks (Sim.REACH)
            {
                double worst = 0;
                foreach (ulong seed in new ulong[] { 1234, 7, 99, 0xDEADBEEFCAFEBABEUL })
                {
                    var s = new Sim(new Settings { seed = seed });
                    s.season.startMinute -= 0.45 * s.settings.seasonDays * 1440; // late season: fruit on the ground
                    for (int cz = -4; cz <= 4; cz++) for (int cx = -4; cx <= 4; cx++)
                        {
                            var c = World.GenerateChunk(seed, cx, cz); double ox = cx * 64.0, oz = cz * 64.0;
                            void E(Num x, Num z, Num r) { worst = Math.Max(worst, Math.Max(Math.Abs(D(x) - ox), Math.Abs(D(z) - oz)) + D(r)); }
                            foreach (var t in c.trees) E(t.x, t.z, Max(t.r, t.cr));
                            foreach (var b in c.boxes) { E(b.minx, b.minz, 0); E(b.maxx, b.maxz, 0); }
                            foreach (var y in c.cylinders) E(y.x, y.z, y.r);
                            foreach (var f in c.sugar) E(f.x, f.z, 0);
                            foreach (var f in c.flies) E(f.x, f.z, f.r);
                            foreach (var f in c.caterpillars) E(f.x, f.z, 0);
                            foreach (var f in c.traps) E(f.x, f.z, 0);
                            foreach (var f in c.webs) E(f.x, f.z, f.r);
                            foreach (var f in c.hives) { E(f.x, f.z, 0.3); foreach (var b in f.bees) if (!b.guard) E(b.tx, b.tz, 0.1); }
                            foreach (var f in c.sheds) { E(f.x, f.z, Max(f.hw, f.hd) + 0.05); }
                            if (c.rival != null) E(c.rival.ex, c.rival.ez, 0.1);
                            var rec = new ChunkRec { cx = cx, cz = cz, content = c };
                            foreach (var f in s.FruitIn(rec)) E(f.x, f.z, 0);
                            var st = s.SitesIn(rec); foreach (var h in st.holes) E(h.x, h.z, 0.12); foreach (var (p, _) in st.branches) E(p.x, p.z, 0.15);
                        }
                }
                Ok(worst < 36, $"everything in a chunk lies within {worst:0.00} m of its centre, inside the {D(Sim.REACH)} m reach scans rely on");
            }
            // 2. the consequence window holds for swats and for compression under clothing
            {
                Num minGap = Num.MaxValue;
                for (ulong i = 1; i <= 2000; i++)
                {
                    var h = Body.HumanTraits(7, i);
                    for (int z = 0; z < Body.ZONES.Length; z++) foreach (bool under in new[] { false, true })
                        {
                            var p = Body.ResolveSting(new StingIn { contactTick = 0, contactPointBody = P(0, 1, 0), mode = "full", under = under }, h, Body.ZONES[z],
                                new StingCtx { clothingStiffness = 0, panic = 0, companions = new List<Companion> { new Companion { id = i + 99999, distance = 1, reactionTicks = 11, style = 0 } } });
                            foreach (var s in p.swats) minGap = Min(minGap, s.start);
                        }
                }
                Ok(minGap >= T.resolve.minConsequenceTicks, $"no swat or press lands before {T.resolve.minConsequenceTicks} ticks (min {minGap})");
            }
            // 3. colony economy
            {
                var fed = Colony.New(); var starved = Colony.New();
                for (int i = 0; i < 120 * 10; i++)
                {
                    fed.protein = 1e6; fed.sugar = 1e6; starved.protein = 0; starved.sugar = 1e6;
                    Colony.Step(fed, (Num)1 / 120, 0, false); Colony.Step(starved, (Num)1 / 120, 0, false);
                }
                Ok(fed.adults > 30 && fed.stats.emerged > 10, $"fed colony grows over 10 days ({D(fed.adults):0.0} adults)");
                Ok(starved.stats.starvedLarvae > 10 && starved.larvae < fed.larvae, $"protein-starved larvae die ({D(starved.stats.starvedLarvae):0.0} lost)");
                Ok(starved.deficit > fed.deficit, "sugar deficit rises when larvae go hungry");
                var broke = Colony.New(); broke.sugar = 0; broke.protein = 0;
                for (int i = 0; i < 120 * 3; i++) Colony.Step(broke, (Num)1 / 120, 0, false);
                Ok(!broke.queenAlive, "queen dies after a day without sugar");
            }
            // 4. determinism with AI wasps, humans, colony: two runs and a replay
            {
                (Sim s, List<SimEvent> ev, string hash) Go(string plan, ulong seed = 1234)
                {
                    var s = new Sim(new Settings { seed = seed }); var bot = Bots.StingBot(plan, h => true);
                    var ev = RunS(s, 15000, (sim, i) => bot(sim));
                    return (s, ev, s.StateHash());
                }
                var a = Go("full"); var b = Go("full");
                Ok(a.hash == b.hash, $"two runs, same seed, same state hash ({a.hash})");
                Ok(Sim.Replay(new Settings { seed = 1234 }, a.s.log, 15000) == a.hash, "replay of recorded input reproduces the hash");
                Ok(a.s.stats.stings > 0 && Count(a.ev, "swatHit") > 0, "player stings land and swats hit lingering wasps");
                Ok(Count(a.ev, "waspSpawn") > 3, $"colony launches AI workers ({Count(a.ev, "waspSpawn")} spawns)");
                Ok(Count(a.ev, "deposit") > 0, $"AI workers deposit at the nest ({Count(a.ev, "deposit")} deposits)");
                var j = Go("jab");
                int PD(List<SimEvent> ev) => ev.Count(e => e.type == "waspDied" && (bool)e["driven"]);
                Ok(PD(j.ev) / Math.Max(1, D(j.s.stats.stings)) < PD(a.ev) / Math.Max(1, D(a.s.stats.stings)), "jab-and-run dies less per sting than full-and-linger");
                Ok(Go("full", 99).hash != a.hash, "different seed, different world");
            }
            // 5. escalation ladder: covered food, traps
            {
                var s = new Sim(new Settings { seed = 1234 }); string k0 = "0,0";
                Ok(s.EscLevel(k0) == 0, "neighborhood starts calm");
                s.CS(k0).esc = 9;
                Ok(s.EscLevel(k0) == 2, "level 2 at 9 points");
                var can = s.records.Get(k0).content.sugar.First(x => x.kind == "can");
                var w = s.wasp; w.energy = 0.5; Place(w, P(can.x, can.y + 0.01, can.z));
                RunS(s, 30);
                Ok(w.energy < 0.5, "covered cans give no sugar at level 2");
                s.CS(k0).esc = 16;
                var trap = s.records.Get(k0).content.traps[0];
                Place(w, P(trap.x, trap.y, trap.z));
                var ev = RunS(s, 120);
                var died = ev.FirstOrDefault(e => e.type == "waspDied" && (bool)e["driven"]);
                Ok(Cause(died) == "drowned in a trap", $"level 3 trap drowns a feeding wasp ({Cause(died)})");
            }
            // 6. swatting at a hovering wasp: level 1 kills
            {
                var s = new Sim(new Settings { seed = 1234 });
                s.CS("0,0").esc = 4;
                var hm = Seated(s, h => h.tr.style != Style.Freezer);
                var head = Body.ToWorld(hm.F, hm.sit[0].a);
                var ev = RunS(s, 600, (sim, i) => { var w = sim.wasp; if (w.state == "fly") Place(w, P(head.x, head.y + 0.25, head.z)); return Idle(); });
                var died = Find(ev, "waspDied");
                Ok(Find(ev, "preSwat") != null && Cause(died) == "slap", $"a wasp hovering over a head at level 1 gets slapped ({Cause(died)})");
            }
            // 7. under clothing: compression kills a wasp that sits still; moving dodges and reaches the acnestis
            {
                var s = new Sim(new Settings { seed = 1234 });
                var hm = Seated(s, h => h.clothing.top == Top.TShirt && h.tr.style != Style.Freezer);
                Ok(hm != null, "found a seated human in a T-shirt");
                var nodes = Body.GarmentGraph(hm.tr, hm.clothing, "sit", hm.sit);
                var sleeve = nodes.First(n => n.key == "sleeve R");
                var outside = Body.ToWorld(hm.F, P(sleeve.pos.x + sleeve.n.x * 0.015, sleeve.pos.y + 0.004, sleeve.pos.z));
                Place(s.wasp, outside);
                RunS(s, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Interact : 0));
                Ok(s.wasp.state == "under", $"E at the sleeve crawls under the shirt ({s.wasp.state})");
                var ev = RunS(s, 600);
                var died = Find(ev, "waspDied");
                Ok(Cause(died) == "crushed under clothing", $"staying still under the shirt gets you crushed ({Cause(died)})");

                var s2 = new Sim(new Settings { seed = 1234 });
                var hm2 = s2.HumanByHex(hm.hex);
                Place(s2.wasp, outside);
                RunS(s2, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Interact : 0));
                var path = new[] { "upper arm R", "upper back R", "acnestis" };
                int step = 0;
                ev = RunS(s2, 260, (sim, i) =>
                {
                    var w = sim.wasp;
                    if (w == null || w.state != "under") return Idle();
                    var g = Body.GarmentGraph(hm2.tr, hm2.clothing, hm2.posture, hm2.PartsNow);
                    var here = g[w.under.node];
                    if (w.under.move != null) return Idle();
                    if (step < path.Length)
                    {
                        int want = g.FindIndex(n => n.key == path[step]);
                        int li = here.links.IndexOf(want);
                        if (li < 0) return Idle();
                        if (w.under.sel != li) return Idle(c => c.mx = i % 2 != 0 ? 100 : 0);
                        if (i % 2 != 0) return Idle();
                        step++;
                        return Idle(c => c.mz = 100);
                    }
                    return Idle(c => c.sting = i % 20 < 8 ? 1 : 0);
                });
                var acn = ev.FirstOrDefault(e => e.type == "sting" && (bool)e["under"]);
                string zn = acn != null ? Zone.Name[(int)acn["zone"]] : "none";
                Ok(zn == "Acnestis", $"crawled from the sleeve to the acnestis and stung under the shirt ({zn})");
            }
            // 8. bees: hovering at a hive entrance gets you balled and cooked; mashing burst breaks out
            {
                var s = new Sim(new Settings { seed = 1234 });
                var hv = s.records.Get("1,0").content.hives.FirstOrDefault();
                Ok(hv != null, "chunk (1,0) has a beehive");
                var at = P(hv.ex + hv.fx * 0.3, hv.ey + 0.05, hv.ez + hv.fz * 0.3);
                var w = s.wasp;
                Place(w, at);
                var ev = RunS(s, 1);
                Place(w, at);
                ev.AddRange(RunS(s, 1500));
                Ok(Count(ev, "beeAlarm") > 0 && Count(ev, "balled") > 0, "guards alarm and ball the wasp");
                Ok(Cause(Find(ev, "waspDied")) == "cooked by bees", $"the ball cooks the wasp ({Cause(Find(ev, "waspDied"))})");
                var s2 = new Sim(new Settings { seed = 1234 });
                RunS(s2, 1);
                Place(s2.wasp, at);
                ev = RunS(s2, 900, (sim, i) => Idle(c => c.burst = sim.wasp != null && sim.wasp.state == "balled" ? i % 2 : 0));
                Ok(Count(ev, "ballEscape") > 0, "mashing burst breaks out of the ball");
            }
            // 9. exterminator: level 4 near the nest brings him; he searches by flight lines (T1-7) and destroys the nest
            // unless stopped. A colony lying low gives him fewer lines and is not found in the same time.
            {
                (Sim s, List<SimEvent> first, List<SimEvent> ev) Go(int alloc)
                {
                    var s = new Sim(new Settings { seed = 1234 });
                    s.colony.adults = 120;
                    s.CS("0,0").esc = 30;
                    var first = RunS(s, 60, (sim, i) => Idle(c => c.alloc = alloc));
                    return (s, first, RunS(s, 18000, (sim, i) => Idle(c => c.alloc = alloc)));
                }
                var a = Go(1);
                Ok(Count(a.first, "extScheduled") == 1, "level 4 near the nest schedules the exterminator");
                Ok(Count(a.ev, "extLine") >= 2 && Count(a.ev, "extFound") == 1 && Count(a.ev, "extTreat") == 1,
                    $"he follows flight lines to the nest ({Count(a.ev, "extLine")} lines over {Count(a.ev, "extArrive")} visits) and starts treating it");
                Ok(Count(a.ev, "nestDestroyed") == 1 && !a.s.colony.nestAlive, "an unopposed exterminator destroys the nest");
                var b = Go(5);
                Ok(b.s.colony.nestAlive && Count(b.ev, "extFound") == 0 && Count(b.ev, "extGiveUp") >= 1,
                    $"a colony lying low is not found in the same time ({Count(b.ev, "extLine")} lines, gave up {Count(b.ev, "extGiveUp")} times)");
            }
            // 10. exterminator abort: crawl under his collar, sting, keep moving between stings
            {
                var s = new Sim(new Settings { seed = 1234 });
                s.CS("0,0").esc = 30;
                s.ext.lead = new Lead { x = s.nest.x, z = s.nest.z, nx = s.nest.x, nz = s.nest.z }; // found it on an earlier visit
                var arr = new List<SimEvent>();
                for (int i = 0; i < 4000 && s.ext.hm == null; i++) arr.AddRange(RunS(s, 1));
                var ext = s.ext.hm;
                Ok(ext != null && s.ext.state == "active" && arr.Any(e => e.type == "extArrive" && e["known"] is bool kb && kb) && ext.state == "arrive", "exterminator on site, and he knows where the nest is from last time");
                bool entered = false; int stungAt = -1;
                var ev = RunS(s, 2500, (sim, i) =>
                {
                    var w = sim.wasp;
                    if (w == null || w.state == "dead") return Idle();
                    if (w.state != "under")
                    {
                        if (ext.state != "arrive" && ext.state != "treat") return Idle();
                        var collar = Body.GarmentGraph(ext.tr, ext.clothing, ext.posture, ext.PartsNow).First(n => n.key == "collar");
                        Place(w, Body.ToWorld(ext.F, P(collar.pos.x, collar.pos.y + 0.003, collar.pos.z - 0.012)));
                        return Idle(c => c.act = i % 2 != 0 ? Act.Interact : 0);
                    }
                    entered = true;
                    if (w.under.move != null) return Idle();
                    if (stungAt != w.under.node) { stungAt = w.under.node; return Idle(c => c.sting = 1); }
                    stungAt = -1;
                    return Idle(c => c.mz = 100);
                });
                Ok(entered, "got under the exterminator's collar");
                Ok(Count(ev, "extAbort") == 1, $"stings under his collar make him abort ({Count(ev, "sting")} stings)");
                Ok(s.colony.nestAlive, "the nest survives this visit");
            }
            // 11. day cycle: people leave in the evening, the colony rests, people come back next day
            {
                var s = new Sim(new Settings { seed = 1234, dayMinutes = 2 });
                Place(s.wasp, World.NEST_ENTRANCE);
                var ev = RunS(s, s.tpm * 60 * 21 / 2, (sim, i) => { if (sim.wasp != null && sim.wasp.state == "fly") Place(sim.wasp, World.NEST_ENTRANCE); return Idle(); });
                Ok(Count(ev, "leave") > 0, $"people leave in the evening ({Count(ev, "leave")} left)");
                long day0 = s.day;
                var ev2 = RunS(s, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Rest : 0));
                Ok(Count(ev2, "rested") == 1 && s.day == day0 + 1, "resting at night skips to the next morning");
                var ev3 = RunS(s, s.tpm * 60 * 6, (sim, i) => { if (sim.wasp != null && sim.wasp.state == "fly") Place(sim.wasp, World.NEST_ENTRANCE); return Idle(); });
                Ok(Count(ev3, "arrive") > 0, $"people arrive the next day ({Count(ev3, "arrive")} arrived)");
            }
            // 12. possession: switch to the nearest AI worker
            {
                var s = new Sim(new Settings { seed = 1234 });
                RunS(s, 900, (sim, i) => { if (sim.wasp.state == "fly") Place(sim.wasp, P(World.NEST_ENTRANCE.x + 0.5, 2, World.NEST_ENTRANCE.z)); return Idle(); });
                int before = s.drivenId;
                var ev = RunS(s, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Switch : 0));
                Ok(Count(ev, "possess") == 1 && s.drivenId != before, $"Q possesses a nearby worker ({before} -> {s.drivenId})");
            }
            // 13. the yearly cycle: queen cells, collapse, winter, founding
            {
                var c = Colony.New();
                c.protein = 1e5; c.sugar = 1e5;
                int days = 40, perDay = 120; Num peak = 0;
                for (int i = 0; i < days * perDay; i++)
                {
                    Num f = Min(1, 0.3 + (Num)i / (days * perDay) * 0.7);
                    Colony.Step(c, (Num)1 / perDay, 0, true, f, 0.2);
                    peak = Max(peak, c.adults);
                }
                Ok(c.stats.gynesRaised > 5 && c.mated > 1, $"late season raises young queens that leave to mate ({D(c.stats.gynesRaised):0} raised, {D(c.mated):0} mated)");
                Ok(!c.queenAlive && c.adults < peak * 0.5, $"the old queen dies and the colony collapses in autumn ({D(peak):0} -> {D(c.adults):0} adults)");

                var s = new Sim(new Settings { seed = 1234 });
                s.colony.mated = 200;
                s.season.startMinute -= 0.71 * s.settings.seasonDays * 1440;
                var ev = RunS(s, 120);
                var wi = Find(ev, "winter");
                Ok(wi != null && Find(ev, "spring") == null && s.winter != null && s.winter.sites.Count >= 2 && s.wasps.Count == 0,
                    $"the season ends and the queens sleep until one is chosen ({wi?["survivors"]} survived at {s.winter?.sites.Count} sites: {(s.winter == null ? "" : string.Join(", ", s.winter.sites.Select(x => x.n + " " + x.kind)))})");
                var pickSite = s.winter.sites[1];
                var ev2 = RunS(s, 2, (sim, i) => Idle(cm => cm.pick = i == 0 ? 2 : 0));
                Ok(Count(ev2, "spring") == 1 && s.winter == null && Hypot(s.wasp.x - pickSite.x, s.wasp.z - pickSite.z) < 0.2, $"picking the second wakes that queen where she wintered ({pickSite.kind})");
                Ok(s.wasp.caste == "queen" && s.colony.adults == 0 && s.colony.cells == 0 && s.season.n == 2, "spring: you are the founding queen of a new colony");
                var q = s.wasp;
                Ok(!s.colony.sited, "spring: the queen has no nest yet");
                var tree = s.activeChunks.SelectMany(r => r.content.trees).First(t => Hypot(t.x - World.NEST.treeX, t.z - World.NEST.treeZ) > 3 && t.h > 3);
                Place(q, P(tree.x + tree.r + 0.03, 2, tree.z));
                var fev = RunS(s, 2, (sim, i) => Idle(cm => cm.act = i == 1 ? Act.Interact : 0));
                Ok(Count(fev, "nestFounded") == 1 && Hypot(s.nest.treeX - tree.x, s.nest.treeZ - tree.z) < 1e-9, "E at a trunk founds the nest in that tree");
                var E = s.nest.entrance;
                q.carry = new Carry { kind = "pulp", amount = 3, what = "pulp" };
                Place(q, E); RunS(s, 2);
                q.carry = new Carry { kind = "protein", amount = 3, what = "fly" };
                Place(q, E); RunS(s, 2);
                RunS(s, (int)(s.dayTicks / 2), (sim, i) => { if (sim.wasp.state == "fly") Place(sim.wasp, P(E.x + 0.3, E.y, E.z)); return Idle(); });
                Ok(s.colony.cells > 10 && s.colony.eggs + s.colony.larvae > 1, $"founding: pulp builds cells and the queen lays ({D(s.colony.cells):0} cells, {D(s.colony.eggs + s.colony.larvae):0.0} brood)");
            }
            Predators();
            People();
            SavesAndWorld();
            Batch1();
            Batch2();
            Batch3();
            Batch4();
        }

        // 30-31. Tier 1: fetching spray (T1-6) and the exterminator's search (T1-7)
        static void Batch4()
        {
            {
                var s = new Sim(new Settings { seed = 1234, dayMinutes = 20 }, new SimOpts { noAI = true });
                RunS(s, 3);
                var hm = Seated(s, h => h.tr.escalation >= T.esc.sprayTrait && h.tr.style != Style.Freezer);
                Ok(hm != null, "someone at a table who would spray");
                s.CS(hm.chunk).esc = 16;
                Cmd Front(Sim sim, int i) { if (sim.wasp != null) Place(sim.wasp, Body.ToWorld(hm.F, P(0, 0.3, 1.0))); return Idle(); }
                var ev = RunS(s, 300, Front);
                Ok(s.EscAt(hm.x, hm.z) == 3 && Count(ev, "spray") == 0, "at level 3 a wasp in front of him is not sprayed: no can yet");
                if (s.wasp != null) Place(s.wasp, P(hm.x + 15, 2, hm.z));
                s.ApplyCommit(new NetEv { type = "sting", peer = s.peer, humanHex = hm.hex, panicGain = 0, driven = false, sx = hm.x, sz = hm.z, zone = 0, flee = false, waspId = 0 });
                bool away = false;
                ev = RunS(s, 4500, (sim, i) => { if (hm.state == "fetch" && hm.fetchT > 0) away = true; if (sim.wasp != null) Place(sim.wasp, P(hm.x + 15, 2, hm.z)); return Idle(); });
                Ok(Count(ev, "fetchSpray") == 1 && away && Count(ev, "armed") == 1, "stung, he goes off for a can and is out of sight a while");
                Ok(hm.state == "idle" && hm.sprayCount == T.esc.sprayCharges, $"and comes back to his seat with {D(hm.sprayCount)} sprays");
                ev = RunS(s, 300, Front);
                Ok(Count(ev, "spray") >= 1 && hm.sprayCount < T.esc.sprayCharges, $"now a wasp in front of him gets sprayed ({D(T.esc.sprayCharges - hm.sprayCount)} used)");
            }
            {
                var s = new Sim(new Settings { seed = 1234 });
                s.colony.adults = 120;
                var n = s.nest; var ws = s.wasps;
                s.wasps = new List<Wasp>();
                Num At(Num d) => s.ExtSightings(n.x + d, n.z);
                Num r20 = At(20), r6 = At(6);
                s.colony.alloc = 4; Num low = At(20); s.colony.alloc = 0;
                var site = n.site; n.site = "hollow"; Num hid = At(20); n.site = site;
                Ok(r6 > r20 * 2 && low < r20 * 0.5 && hid < r20, $"lines per second: {D(r6):0.000} at 6 m, {D(r20):0.000} at 20 m, {D(low):0.000} lying low, {D(hid):0.000} in a hollow");
                s.wasps = ws;
                var w = s.wasp; Place(w, P(n.x + 20, 1.5, n.z + 2)); w.state = "fly";
                Num seen = s.ExtSightings(n.x + 20, n.z);
                Ok(seen >= r20 + T.ext.physPerSec * 0.999, $"and our wasp flying in sight adds a line ({D(seen):0.000})");
            }
            // 33. winter with choices (T1-15)
            {
                (Sim s, HiberSite site, int scouted, SimEvent win) Late(string scout)
                {
                    var s = new Sim(new Settings { seed = 1234 });
                    s.colony.mated = 300;
                    s.season.startMinute -= 0.66 * s.settings.seasonDays * 1440;
                    RunS(s, 2);
                    var site = s.HiberSites().FirstOrDefault(x => x.kind == scout);
                    var ev = new List<SimEvent>();
                    if (site != null) { Place(s.wasp, P(site.x, site.y, site.z)); ev = RunS(s, 2, (sim, i) => Idle(cm => cm.act = i == 1 ? Act.Interact : 0)); }
                    s.season.startMinute -= 0.05 * s.settings.seasonDays * 1440;
                    var ev2 = RunS(s, 120);
                    return (s, site, Count(ev, "hiberScouted"), Find(ev2, "winter"));
                }
                var hol = Late("hollow"); var lit = Late("litter");
                HiberSite At((Sim s, HiberSite site, int scouted, SimEvent win) r) => r.s.winter?.sites.FirstOrDefault(x => x.scouted);
                Ok(hol.site != null && lit.site != null && hol.scouted == 1 && lit.scouted == 1, $"kinds of winter site near the nest: {string.Join(", ", hol.s.HiberSites().Select(x => x.kind).Distinct())}; E scouts one in late season");
                Ok(At(hol) != null && At(lit) != null && At(hol).n > At(lit).n * 2, $"most gynes winter where the worker scouted, and a hollow tree wakes more queens than the leaf litter ({At(hol)?.n} vs {At(lit)?.n})");
                string first = hol.s.winter.sites[0].kind;
                var sleeping = Persist.Restore(Persist.Snapshot(hol.s));
                var ev3 = RunS(hol.s, T.hiber.chooseTicks + 2);
                RunS(sleeping, T.hiber.chooseTicks + 2);
                Ok(sleeping.StateHash() == hol.s.StateHash() && sleeping.winter == null, "a world saved in winter restores asleep and wakes the same queen");
                Ok(Count(ev3, "spring") == 1 && (string)Find(ev3, "spring")["kind"] == first, $"left alone, the queen from the site with most survivors wakes ({first})");
                Ok(hol.s.colony.sugar > Colony.New(true).sugar, $"a well wintered queen wakes with more in reserve ({D(hol.s.colony.sugar):0.00} sugar)");
            }
            // 32. worker ages and guards (T1-13)
            {
                Num Forage(Num young) { var c = Colony.New(); c.adults = 100; c.young = young; c.eggs = c.larvae = c.pupae = 0; Num s0 = c.sugar; Colony.Step(c, 0.01, 0, true, 0.3, 1); return c.sugar - s0; }
                Ok(Forage(100) < Forage(0), $"young workers do not forage (sugar {D(Forage(100)):0.000} with all young, {D(Forage(0)):0.000} with none)");
                var cc = Colony.New(); cc.adults = 100; cc.young = 0; cc.eggs = 0; cc.larvae = 0; cc.pupae = 50; cc.sugar = 50;
                for (int i = 0; i < 20; i++) Colony.Step(cc, 0.05, 0, false, 0.3, 1);
                Num em = cc.stats.emerged, y1 = cc.young;
                cc.pupae = 0; cc.young = 50;
                for (int i = 0; i < 80; i++) Colony.Step(cc, 0.05, 0, false, 0.3, 1);
                Ok(y1 > em * 0.8 && cc.young > 50 * 0.3 && cc.young < 50 * 0.45, $"emerging workers count as young ({D(y1):0.0} of {D(em):0.0} after a day) and grow out of it (50 young, {D(cc.young):0.0} after {D(T.colony.youngDays)} days)");

                var s = new Sim(new Settings { seed = 1234 });
                s.colony.adults = 120;
                var ev = RunS(s, 900);
                var e = s.nest.entrance;
                var guards = s.wasps.Where(w => w.colony == "own" && w.role == "guard").ToList();
                double Dist(Wasp g) => Math.Sqrt(D(Sq(g.x - e.x) + Sq(g.y - e.y) + Sq(g.z - e.z)));
                Ok(Count(ev, "guardOut") == T.guard.count && guards.Count == T.guard.count && guards.All(g => Dist(g) < 0.3),
                    $"{guards.Count} guards circle the entrance ({string.Join(", ", guards.Select(g => Dist(g).ToString("0.00")))} m)");
                var rec = s.activeChunks.First(r => r.content.rival != null);
                var rv = s.SpawnWasp(false); rv.colony = rec.key; rv.role = "sugar"; rv.ai.mode = "pick";
                Place(rv, P(e.x + 0.3, e.y, e.z + 0.2));
                var ev2 = RunS(s, 600);
                Ok(Count(ev2, "guardHunt") >= 1 && Count(ev2, "fight") >= 1 && ev2.Any(x => x.type == "fightOver"), $"a rival wasp at the entrance is chased and grappled ({Count(ev2, "fight")} fights)");

                var xs = new Sim(new Settings { seed = 1234 });
                xs.colony.adults = 120;
                xs.CS("0,0").esc = 30;
                xs.ext.lead = new Lead { x = xs.nest.x, z = xs.nest.z, nx = xs.nest.x, nz = xs.nest.z };
                var ev3 = RunS(xs, 9000);
                string hex = xs.ext.hm?.hex ?? ev3.Where(q => q.type == "aiAttack").Select(q => (string)q["humanHex"]).FirstOrDefault();
                Ok(ev3.Any(q => q.type == "aiAttack" && hex != null && (string)q["humanHex"] == hex) && Count(ev3, "extTreat") == 1, "guards go for the exterminator at the nest");
            }
        }

        // 26. Tier 1, batch 1: wind, cold, drowning, clothes by the weather, shaking and flailing
        static void Batch1()
        {
            ulong seed = 1; DayWeather day0 = null;
            for (; seed < 200; seed++) { var w = World.Weather(seed, 0); if (!w.rain && w.wind > 2.2) { day0 = w; break; } }
            double At(long m) { var v = World.WindAt(seed, m); return Hypot(v.x, v.z); }
            Ok(day0 != null && At(15 * 60) > At(7 * 60) * 1.5, $"wind is calm at dawn and stronger mid-afternoon ({At(7 * 60):0.00} -> {At(15 * 60):0.00} m/s)");
            double Drift(Num y)
            {
                var s = new Sim(new Settings { seed = seed, birds = false });
                var p0 = P(40, y, 40); var w = s.wasp; Place(w, p0);
                RunS(s, 180);
                var v = s.Wind; double n = Hypot(v.x, v.z);
                return (D(w.x - p0.x) * D(v.x) + D(w.z - p0.z) * D(v.z)) / n;
            }
            double high = Drift(3), low = Drift(0.3);
            Ok(high > 0.3 && low < high * 0.3, $"a hovering wasp drifts downwind, less near the ground ({high:0.00} m at 3 m, {low:0.00} m at 30 cm in 3 s)");

            var s0 = new Sim(new Settings { seed = 1234, birds = false });
            Ok(s0.wasp.bodyT >= T.cold.flyBody, $"a wasp leaves the nest warm ({D(s0.wasp.bodyT):0.0} °C)");
            var spring = new Sim(new Settings { seed = 1234 }); spring.season.startMinute = spring.minute;
            Ok(Abs((s0.Temperature - spring.Temperature) - T.weather.springChill) < 1e-9, $"spring is colder than summer by {D(T.weather.springChill)} °C");
            Sim Chilly(Action<Sim> f) { var t = new Sim(new Settings { seed = 1234, birds = false }); t.tempOverride = 4; f(t); return t; }
            var c1 = Chilly(t => Place(t.wasp, P(4, 1.5, 4)));
            RunS(c1, 900);
            Ok(c1.wasp.bodyT < T.cold.flyBody && c1.wasp.y < 0.05, $"at 4 °C a flying wasp cools, loses power and drops ({D(c1.wasp.bodyT):0.0} °C)");
            var ev = RunS(c1, 9000);
            var frozen = ev.FirstOrDefault(e => e.type == "waspDied" && (bool)e["driven"]);
            Ok(Cause(frozen) == "cold", $"left on the cold ground it dies of cold ({Cause(frozen)})");
            var c2 = Chilly(t =>
            {
                var hm = Seated(t, h => h.tr.style != Style.Freezer);
                var fa = hm.sit.First(p => p.name == "ForearmR");
                Place(t.wasp, Body.ToWorld(hm.F, P((fa.a.x + fa.b.x) / 2, (fa.a.y + fa.b.y) / 2 + fa.r + 0.008, (fa.a.z + fa.b.z) / 2)));
            });
            RunS(c2, 3);
            bool perched = c2.wasp.state == "perched";
            RunS(c2, 900, (sim, i) => { var w = sim.Driven(); if (w != null && w.state == "perched") w.perch.quietUntil = sim.tick + 10; return Idle(); });
            Ok(perched && c2.Driven() != null && c2.wasp.bodyT > 25, $"perched on a person it stays warm in the cold ({D(c2.wasp.bodyT):0.0} °C)");

            (bool fell, List<SimEvent> ev) IntoCan(bool mash)
            {
                var t = new Sim(new Settings { seed = 1234, birds = false });
                var can = t.records.Get("0,0").content.sugar.First(x => x.kind == "can");
                bool fell = false;
                var e2 = RunS(t, 9000, (sim, i) =>
                {
                    var w = sim.Driven();
                    if (w == null) return Idle();
                    if (w.state == "drowning") { fell = true; return Idle(c => c.burst = mash ? i % 2 : 0); }
                    if (!fell && (w.state == "fly" || w.state == "landed")) { Place(w, P(can.x, can.y + 0.01, can.z)); w.energy = 0.3; }
                    return Idle();
                });
                return (fell, e2);
            }
            var a = IntoCan(false); var b = IntoCan(true);
            var drowned = a.ev.FirstOrDefault(e => e.type == "waspDied" && (bool)e["driven"]);
            Ok(a.fell && Cause(drowned) == "drowned in a drink", $"a wasp feeding at an open can slips in and drowns ({Cause(drowned)})");
            Ok(b.fell && Count(b.ev, "climbedOut") >= 1, "mashing burst climbs out of the drink");

            (double jacket, double tank) Share(Func<Num, bool> pred)
            {
                var days = new List<int>(); for (int d = 1; d < 200 && days.Count < 6; d++) if (pred(World.Weather(1234, d).@base)) days.Add(d);
                int jacket = 0, tank = 0, n = 0;
                foreach (var d in days) for (ulong i = 1; i <= 300; i++) { var c = Body.HumanClothing(1234, i, d); n++; if (c.top == Top.Jacket) jacket++; if (c.top == Top.Tank) tank++; }
                return ((double)jacket / n, (double)tank / n);
            }
            var cool = Share(x => x < 20); var hot = Share(x => x >= 25);
            Ok(cool.jacket > hot.jacket * 3 && hot.tank > cool.tank * 2, $"clothes follow the weather (jackets {cool.jacket:P0} cool vs {hot.jacket:P0} hot; tank tops {cool.tank:P0} vs {hot.tank:P0})");

            Traits As(Num style) { var t = Body.HumanTraits(1234, 5); t.style = style; t.reactionTicks = 20; return t; }
            Plan Pl(Num style, int zone) => Body.ResolveSting(new StingIn { contactTick = 0, contactPointBody = P(0, 1.6, 0), mode = "jab" }, As(style), Body.ZONES[zone], new StingCtx { companions = new List<Companion>() });
            var sc = Pl(Style.Flailer, Zone.Scalp).swats[0]; var sp = Pl(Style.Precise, Zone.Scalp).swats[0];
            Ok(sc.kind == SwatKind.Shake && !sc.kills && sp.kind == SwatKind.Slap, "stung on the scalp a flailer shakes the head (dislodges) where a precise person slaps");
            Ok(Pl(Style.Runner, Zone.Face).swats[0].kind == SwatKind.Shake && Pl(Style.Brusher, Zone.Face).swats[0].kind == SwatKind.Brush, "stung on the face a runner shakes, a brusher brushes");
            var r1 = Pl(Style.Runner, Zone.Forearms);
            Ok(r1.flee && r1.swats.Count > 1 && r1.swats[1].kind == SwatKind.Brush && !r1.swats[1].kills && r1.swats[1].radius >= 0.2 && r1.swats[1].start > r1.swats[0].start, "a runner flails on the way out: a wide, late sweep that stuns");
        }

        // 14. predators, landing, walking, rivals
        // T1-17 panic spreads by sight, T1-18 people remember stings by recency and place
        static void Batch2()
        {
            Sim s = null; Shed sh = null;
            for (ulong seed = 1; seed < 60 && sh == null; seed++) { var t = new Sim(new Settings { seed = seed }); var rec = t.activeChunks.FirstOrDefault(r => r.content.sheds.Count > 0); if (rec != null) { s = t; sh = rec.content.sheds[0]; } }
            Num lx = sh.x - sh.hw - 1.2, lz = sh.z, rx = sh.x + sh.hw + 1.2, rz = sh.z, l2x = lx, l2z = sh.z + 2.5;
            Ok(!s.CanSee(lx, lz, rx, rz) && s.CanSee(lx, lz, l2x, l2z), "a shed blocks the line of sight between two people; open ground does not");
            var tree = s.activeChunks.SelectMany(r => r.content.trees).First();
            Ok(!s.CanSee(tree.x - 1, tree.z, tree.x + 1, tree.z), "so does a tree trunk");
            Num Spread(Num bx, Num bz)
            {
                var t = new Sim(new Settings { seed = s.seed });
                var two = t.active.Where(h => !h.special && h.state == "idle").Take(2).ToList();
                var A = two[0]; var B = two[1];
                foreach (var h in t.active) if (h != A && h != B) { h.x += 500; h.z += 500; }
                A.x = lx; A.z = lz; A.panic = 1; B.x = bx; B.z = bz; B.panic = 0;
                for (int i = 0; i < 3; i++) t.Step(Idle());
                return B.panic;
            }
            Num seen = Spread(l2x, l2z), hidden = Spread(rx, rz);
            Ok(seen > 0.001 && hidden == 0, $"panic spreads to someone in sight ({D(seen):0.0000}) and not behind a shed ({D(hidden)})");

            var s2 = new Sim(new Settings { seed = 1234 }); var bot = Bots.StingBot("jab");
            var ev = new List<SimEvent>();
            for (int i = 0; i < 6000 && !ev.Any(e => e.type == "sting"); i++) { s2.Step(bot(s2)); ev.AddRange(s2.DrainEvents()); }
            var hm = s2.HumanByHex((string)Find(ev, "sting")["humanHex"]);
            Num here = s2.Wary(hm);
            Ok(hm.mem.Count == 1 && Abs(here - 1) < 0.01, $"a sting is remembered with its time and place (wary {D(here):0.00})");
            Num x0 = hm.x; hm.x += 10; Num away = s2.Wary(hm); hm.x = x0;
            hm.mem[0].m -= T.memory.forgetMinutes * 0.75; Num later = s2.Wary(hm);
            Ok(away < here * 0.5 && later < here * 0.3, $"wary where it happened ({D(here):0.00}), calmer 10 m away ({D(away):0.00}) and after a day and a half ({D(later):0.00})");
            Plan Pl(Num n) => Body.ResolveSting(new StingIn { contactTick = 0, contactPointBody = P(0, 1, 0), mode = "jab" }, hm.tr, Body.ZONES[Zone.Forearms], new StingCtx { clothingStiffness = 0, panic = 0, companions = new List<Companion>(), stung = n });
            Ok(hm.tr.style == Style.Freezer || Pl(here).swats[0].start <= Pl(away).swats[0].start, "and the hand comes sooner where they were stung");
            var r = Persist.Restore(Persist.Snapshot(s2));
            Ok(r.HumanByHex(hm.hex).mem.Count == 1 && r.HumanHash() == s2.HumanHash(), "remembered stings survive save and restore");
        }

        // T1-14 hollow trees and nest thermals
        static void Batch3()
        {
            var t = Spring();
            var hol = t.activeChunks.SelectMany(r => t.SitesIn(r).hollows).ToList();
            Ok(hol.Count > 3 && hol.All(x => x.t.r >= T.sites.hollowMinR && x.p.y > 0.6 && x.p.y < x.t.h), $"some thick trees have a hollow in the trunk ({hol.Count} near home)");
            var (h, tr) = hol[0];
            Num o = Sqrt(Sq(h.x - tr.x) + Sq(h.z - tr.z));
            Place(t.wasp, P(h.x + (h.x - tr.x) / o * 0.05, h.y, h.z + (h.z - tr.z) / o * 0.05));
            var ev = RunS(t, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Interact : 0));
            Ok(Count(ev, "nestFounded") == 1 && t.nest.site == "hollow" && t.colony.maxCells == T.sites.hollow.maxCells && Hypot(t.nest.entrance.x - h.x, t.nest.entrance.z - h.z) < 1e-9, "E at a hollow founds a nest inside the tree");
            var s = new Sim(new Settings { seed = 1234 });
            long cold = -1, hot = -1;
            for (long m = s.minute; m < s.minute + 1440 * 30 && (cold < 0 || hot < 0); m += 10)
            {
                Num a = s.AirAt(m);
                if (cold < 0 && a < 11) cold = m;
                if (hot < 0 && a > 29 && !World.IsRaining(s.seed, m)) hot = m;
            }
            Num At(string site, long m) { s.nest.site = site; return s.BroodSpeed(m); }
            Num br = At("branch", cold), tk = At("trunk", cold), gr = At("ground", cold), ho = At("hollow", cold);
            Ok(cold > 0 && br < tk && tk < gr && gr < ho && ho < 1, $"on a cold morning the brood slows most in an open nest and least in a hollow tree (branch {D(br):0.00}, trunk {D(tk):0.00}, burrow {D(gr):0.00}, hollow {D(ho):0.00})");
            Ok(hot > 0 && At("attic", hot) < At("wall", hot), $"a sunny afternoon bakes an attic nest ({D(At("attic", hot)):0.00} vs {D(At("wall", hot)):0.00})");
            Num Grow(Num k) { var c = Colony.New(); for (int i = 0; i < 120 * 6; i++) { c.protein = 1e3; c.sugar = 1e3; Colony.Step(c, (Num)1 / 120, 0, false, 0.3, 1, k); } return c.stats.emerged; }
            Ok(Grow(0.5) < Grow(1) * 0.8, $"a slowed brood brings fewer workers out ({D(Grow(0.5)):0} vs {D(Grow(1)):0} in six days)");
        }

        static void Predators()
        {
            Web FindWeb(Sim s) { foreach (var r in s.activeChunks) if (r.content.webs.Count > 0) return r.content.webs[0]; return null; }
            var s = new Sim(new Settings { seed = 1234 });
            var wb = FindWeb(s);
            void Into(Sim sim) { var w = sim.wasp; Place(w, P(wb.x - wb.nx * 0.1, wb.y, wb.z - wb.nz * 0.1)); w.vx = wb.nx * 2; w.vz = wb.nz * 2; }
            Into(s);
            var ev = RunS(s, 5);
            Ok(s.wasp.state == "webbed", $"flying through a web sticks the wasp ({s.wasp.state})");
            ev = RunS(s, 900);
            Ok(Cause(Find(ev, "waspDied")) == "eaten by a spider", $"a stuck wasp that does nothing is eaten ({Cause(Find(ev, "waspDied"))})");
            var s2 = new Sim(new Settings { seed = 1234 });
            Into(s2); RunS(s2, 5);
            ev = RunS(s2, 60, (sim, i) => Idle(c => c.burst = i % 2));
            Ok(Count(ev, "webEscape") == 1, "mashing burst tears free");

            // bird: hover in the open at 3 m and get taken
            var s3 = new Sim(new Settings { seed = 1234 });
            Patrol bird = null; foreach (var r in s3.activeChunks) if (r.content.birds.Count > 0) { bird = r.content.birds[0]; break; }
            Ok(bird != null, "a bird patrols near the nest");
            ev = RunS(s3, 2400, (sim, i) => { var w = sim.Driven(); if (w != null && w.state == "fly") Place(w, P(bird.x + bird.r, 3, bird.z)); return Idle(); });
            Ok(Count(ev, "birdDive") > 0 && Cause(Find(ev, "waspDied")) == "taken by a bird", $"a wasp hanging in open air is taken by a bird ({Cause(Find(ev, "waspDied"))})");

            // landing on a bench, then walking
            var s4 = new Sim(new Settings { seed = 1234 });
            var bench = s4.records.Get("0,0").content.boxes[1];
            var w4 = s4.wasp; Place(w4, P((bench.minx + bench.maxx) / 2 + 0.3, bench.maxy + 0.0071, (bench.minz + bench.maxz) / 2));
            w4.energy = 0.5;
            RunS(s4, 300);
            Ok(w4.state == "landed" && Math.Abs(D(w4.energy) - 0.5) < 0.01, $"a still wasp lands on the bench and rests ({w4.state}, crop {D(w4.energy):0.000})");
            var table = s4.records.Get("0,0").content.boxes[0];
            Place(w4, P((table.minx + table.maxx) / 2, table.maxy + 0.0071, (table.minz + table.maxz) / 2));
            RunS(s4, 120);
            Num x0 = w4.x;
            RunS(s4, 30, (sim, i) => Idle(c => { c.yawQ = 0; c.mx = -100; }));
            Ok(w4.state == "landed" && w4.x > x0 + 0.02 && Abs(w4.y - (table.maxy + T.wasp.radius)) < 0.01, $"a landed wasp walks across the table ({D(w4.x - x0) * 100:0.0} cm)");
            ev = RunS(s4, 1500, (sim, i) => Idle(c => { c.yawQ = 0; c.mx = -100; }));
            Ok(Count(ev, "walkOff") == 1 && w4.state == "fly" && w4.x >= table.maxx, $"walking off the edge drops it into flight ({w4.state})");
            {
                var s5 = new Sim(new Settings { seed = 1234 }); var b5 = s5.records.Get("0,0").content.boxes[1]; var w5 = s5.wasp;
                var sitter = s5.active.First(h => h.posture == "sit" && h.z > b5.minz - 0.2 && h.z < b5.maxz + 0.2 && h.x - 0.3 > b5.minx);
                Place(w5, P(sitter.x - 0.3, b5.maxy + 0.0071, (b5.minz + b5.maxz) / 2));
                RunS(s5, 120);
                Ok(w5.state == "landed", $"lands on the bench beside a seated person ({w5.state})");
                ev = RunS(s5, 600, (sim, i) => Idle(c => { c.yawQ = 0; c.mx = w5.state == "landed" ? -100 : 0; }));
                Ok(Count(ev, "perch") >= 1, $"walking along the bench into them climbs onto them ({w5.state})");
            }
            var tree = s4.records.Get("0,0").content.trees[0];
            Place(w4, P(tree.x - tree.r - 0.05, T.wasp.radius + 0.001, tree.z));
            RunS(s4, 120);
            Num gx = w4.x;
            RunS(s4, 600, (sim, i) => Idle(c => { c.yawQ = 0; c.mx = -100; }));
            Ok(w4.state == "landed" && w4.x > gx && w4.x < tree.x - tree.r, $"a tree trunk blocks a walking wasp (stopped {D(tree.x - tree.r - w4.x) * 1000:0.0} mm short)");
            RunS(s4, 2, (sim, i) => Idle(c => c.my = 100));
            Ok(w4.state == "fly", "climbing takes off again");

            // rivals: a rival nest near the origin spawns workers; a raid sends them after you
            Sim rs = null; ChunkRec rkey = null;
            for (ulong seed = 1; seed < 60 && rs == null; seed++)
            {
                var t = new Sim(new Settings { seed = seed });
                foreach (var r in t.activeChunks) if (r.content.rival != null) { rs = t; rkey = r; break; }
            }
            Ok(rs != null, "found a world with a rival nest next to the home chunk");
            var rv = rkey.content.rival;
            Place(rs.wasp, P(rv.ex + 3, rv.ey, rv.ez));
            RunS(rs, 1200, (sim, i) => { var w = sim.Driven(); if (w != null && w.state == "fly") Place(w, P(rv.ex + 3, rv.ey, rv.ez)); return Idle(); });
            int rivals = rs.wasps.Count(w => w.colony != "own");
            Ok(rivals > 0, $"rival workers fly from their nest ({rivals})");
            Place(rs.wasp, P(rv.ex, rv.ey - 0.02, rv.ez));
            ev = RunS(rs, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Interact : 0));
            Ok(Count(ev, "raid") == 1 && rs.wasp.carry != null && rs.wasp.carry.what == "larva", "E at a rival entrance steals a larva");
            ev = RunS(rs, 600);
            Ok(Count(ev, "fight") > 0 && Find(ev, "fightOver") != null, "rival workers hunt the raider and the fight ends with one dead");
        }

        // 15. perching and crawling on people; jumpy humans; 19b spills; 24 switching; 25 dragonflies and sheds
        static void People()
        {
            {
                var s = new Sim(new Settings { seed = 1234 });
                var hm = Seated(s, h => h.tr.style != Style.Freezer && h.clothing.top != Top.Jacket);
                var torso = hm.sit.First(p => p.name == "Torso");
                Place(s.wasp, Body.ToWorld(hm.F, P(0.03, torso.a.y + (torso.b.y - torso.a.y) * 0.25, -(torso.r + 0.012))));
                RunS(s, 3);
                Ok(s.wasp.state == "perched", $"hovering still against a back perches the wasp ({s.wasp.state})");
                int face = RndI(DAtan2(hm.fx, hm.fz) * 1e4);
                bool reached = false;
                var ev = RunS(s, 400, (sim, i) =>
                {
                    var w = sim.wasp;
                    if (w.state != "perched") return Idle();
                    if (w.perch.zone == Zone.Acnestis) { reached = true; return Idle(c => c.yawQ = face); }
                    return Idle(c => { c.mz = 100; c.yawQ = face; c.pitchQ = 14000; });
                });
                Ok(reached, "crawling up the back reaches the acnestis without stinging");
                Ok(Count(ev, "notice") > 0, $"sooner or later they feel the feet and swat ({Count(ev, "notice")} notices)");
                var h = Body.HumanTraits(1234, 77); var z = Body.ZONES[Zone.Forearms];
                Plan Pl(int n) => Body.ResolveSting(new StingIn { contactTick = 0, contactPointBody = P(0, 1, 0), mode = "jab" }, h, z, new StingCtx { clothingStiffness = 0, panic = 0, companions = new List<Companion>(), stung = n });
                Ok(h.style == Style.Freezer || (Pl(3).swats[0].start < Pl(0).swats[0].start && Pl(3).swats[0].start >= T.resolve.minConsequenceTicks), "after three stings the swat comes sooner");
                Ok(Pl(3).panicGain > Pl(0).panicGain, "and each sting hurts more");
            }
            {
                var s = new Sim(new Settings { seed = 1234 });
                var cans = s.records.Get("0,0").content.cans;
                var ev = new List<SimEvent>();
                foreach (var hm in s.active.Where(x => x.posture == "sit" && x.chunk == "0,0").ToList())
                {
                    if (Count(ev, "spill") > 0) break;
                    s.StartFlee(hm, null);
                    ev.AddRange(s.DrainEvents());
                }
                var sp = Find(ev, "spill");
                Ok(sp != null && s.CanSpilled("0,0", (int)sp["i"]) && s.SpillsIn("0,0").Count == 1, "a sitter who jumps up knocks a drink over");
                var pud = s.SpillsIn("0,0")[0]; var w = s.wasp;
                w.energy = 0.3;
                Place(w, P(pud.x, 0.75 + T.wasp.radius, pud.z)); w.state = "landed";
                RunS(s, 120);
                Ok(w.energy > 0.6, $"the puddle feeds a wasp (crop {D(w.energy):0.00})");
                var c = cans[(int)sp["i"]];
                w.energy = 0.3;
                RunS(s, 240, (sim, i) => { Place(w, P(c.x, 0.87, c.z)); return Idle(); });
                Ok(w.energy < 0.35, $"the knocked-over can itself is empty (crop {D(w.energy):0.00})");
                var t = new Sim(new Settings { seed = 1234 }); t.CS("0,0").esc = 9;
                var e2 = new List<SimEvent>();
                foreach (var hm in t.active.Where(x => x.posture == "sit" && x.chunk == "0,0").ToList()) { t.StartFlee(hm, null); e2.AddRange(t.DrainEvents()); }
                Ok(Count(e2, "spill") == 0, "lidded drinks at alert level 2 do not spill");
            }
            {
                var s = new Sim(new Settings { seed = 1234 });
                RunS(s, 600);
                var d = s.wasp;
                Place(d, P(s.nest.x + 80, 2, s.nest.z));
                var ev = RunS(s, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Switch : 0));
                Ok(Find(ev, "switchPending") != null && s.drivenId == d.id, "far from every worker, switching is relayed with a delay");
                ev = RunS(s, T.possess.relayTicks + 5, (sim, i) => { Place(d, P(s.nest.x + 80, 2, s.nest.z)); return Idle(); });
                Ok(Count(ev, "possess") == 1 && s.drivenId != d.id, "after the delay you drive another worker");
                var me = s.Driven();
                var near = s.wasps.First(x => x != me && x.colony == "own");
                Place(me, P(near.x + 2, near.y, near.z));
                ev = RunS(s, 1, (sim, i) => Idle(c => c.pick = near.id));
                Ok(Count(ev, "possess") == 1 && s.drivenId == near.id, $"picking a worker in the colony view drives it (worker {near.id})");
                var far = s.wasps.First(x => x != near && x.colony == "own");
                Place(near, P(far.x + 60, 2, far.z));
                ev = RunS(s, 1, (sim, i) => Idle(c => c.pick = far.id));
                ev.AddRange(RunS(s, T.possess.relayTicks + 2, (sim, i) => { if (s.drivenId == near.id) { Place(near, P(far.x + 60, T.wasp.radius + 0.001, far.z)); near.state = "landed"; } return Idle(); }));
                Ok(Count(ev, "switchPending") == 1 && Count(ev, "possess") == 1 && s.drivenId != near.id, "a far worker picked in the colony view is reached through the relay");
            }
            {
                Sim ds = null; Patrol df = null;
                for (ulong seed = 1; seed < 40 && ds == null; seed++) { var t = new Sim(new Settings { seed = seed }); foreach (var r in t.activeChunks) if (r.content.dragonflies.Count > 0) { ds = t; df = r.content.dragonflies[0]; break; } }
                var p0 = World.DragonPos(df, ds.tick);
                var ev = RunS(ds, 600, (sim, i) => { var d = sim.Driven(); if (d != null && d.state == "fly") Place(d, P(p0.x + 1, 1, p0.z)); return Idle(); });
                Ok(Count(ev, "dragonDive") >= 1 && ev.Any(e => e.type == "waspDied" && Cause(e) == "taken by a dragonfly"), "a dragonfly darts at a wasp hovering low in the open and takes it");
                var t2 = new Sim(new Settings { seed = ds.seed });
                Place(t2.wasp, P(p0.x + 1, T.wasp.radius + 0.001, p0.z)); t2.wasp.state = "landed";
                ev = RunS(t2, 600);
                Ok(!ev.Any(e => e.type == "waspDied" && Cause(e) == "taken by a dragonfly"), "a landed wasp is left alone");
                ulong shedSeed = 0; Shed sh = null;
                for (ulong seed = 1; seed < 60 && sh == null; seed++)
                {
                    var t = Spring(seed);
                    var rec = t.activeChunks.FirstOrDefault(r => r.content.sheds.Count > 0);
                    if (rec != null) { shedSeed = seed; sh = rec.content.sheds[0]; }
                }
                Ok(sh != null, "some chunks near home have a garden shed");
                var sites = World.ShedSites(sh);
                foreach (var (type, p) in new[] { ("wall", sites.wall), ("attic", sites.attic) })
                {
                    var t = Spring(shedSeed);
                    Place(t.wasp, P(p.x + p.nx * 0.05, p.y, p.z + p.nz * 0.05));
                    ev = RunS(t, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Interact : 0));
                    Ok(Count(ev, "nestFounded") == 1 && t.nest.site == type && t.colony.maxCells == T.sites.Of(type).maxCells, $"E at the {type} site founds a nest {T.sites.Of(type).name}");
                }
            }
        }

        // 16 saves, 17 frozen chunks, 20 pest control, 21 modifiers, 22 nest sites, 23 fruit
        static void SavesAndWorld()
        {
            {
                var a = new Sim(new Settings { seed = 1234 });
                var bot = Bots.StingBot("full", null, 150);
                RunS(a, 9000, (sim, i) => bot(sim));
                a.CS("0,0").esc = 9.5;
                var snap = Persist.Snapshot(a);
                var b = Persist.Restore(snap);
                Ok(b.StateHash() == a.StateHash() && b.HumanHash() == a.HumanHash(), $"restored world hashes match the original ({a.StateHash()})");
                var cmds = new List<Cmd>();
                RunS(a, 6000, (sim, i) => { var c = bot(sim); cmds.Add(c); return c; });
                RunS(b, 6000, (sim, i) => cmds[i]);
                Ok(b.StateHash() == a.StateHash(), $"after 6000 more ticks of the same input the restored world is identical ({b.StateHash()})");
                var tail = new int[a.logLen - Sim.CMD_FIELDS * 9000];
                Array.Copy(a.log, Sim.CMD_FIELDS * 9000, tail, 0, tail.Length);
                Ok(Persist.ReplayFrom(snap, tail, 6000) == a.StateHash(), $"replaying the input recorded after a snapshot reproduces the world ({snap.Length / 1024} KB save)");
            }
            {
                var s = new Sim(new Settings { seed = 5 });
                var rec = s.records.Get("0,0"); uint before = rec.contentHash;
                RunS(s, 600, (sim, i) => Idle(c => { c.mz = 100; c.burst = 1; c.yawQ = 0; }));
                Ok(s.records.Get("0,0") == rec && rec.contentHash == before, "discovered chunk record stays frozen");
            }
            {
                var s = new Sim(new Settings { seed = 1234 });
                s.CS("0,0").esc = 45;
                var ev = RunS(s, 120);
                var m = s.muni?.active;
                Ok(Count(ev, "muniStart") == 1 && m != null && m.keys.Count == 9 && m.keys.Contains("0,0"), "a chunk at level 5 starts a campaign over the 3x3 area around it");
                var baits = s.MuniBaits();
                Ok(baits.Count >= 6 && baits.All(b => Abs(b.y - T.muni.baitHeight) < 1e-9), $"bait stations hang on trees in every discovered chunk of the area ({baits.Count})");
                var w = s.wasp; var b0 = baits[0];
                Place(w, P(b0.x + 0.01, b0.y, b0.z));
                RunS(s, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Interact : 0));
                Ok(w.carry != null && w.carry.poison && w.carry.what == "bait", "E at a station takes the bait");
                Num L0 = s.colony.larvae, A0 = s.colony.adults;
                Place(w, s.nest.entrance);
                ev = RunS(s, 3);
                Ok(Find(ev, "poisoned") != null && s.colony.larvae < L0 * 0.9 && s.colony.adults < A0, $"bait carried home poisons the brood and the workers (larvae {D(L0):0} -> {D(s.colony.larvae):0})");
                var r = Persist.Restore(Persist.Snapshot(s));
                string Bs(Sim x) => string.Join(";", x.MuniBaits().Select(b => $"{b.x} {b.y} {b.z} {b.key}"));
                Ok(r.muni.active != null && r.muni.active.n == s.muni.active.n && Bs(r) == Bs(s), "a campaign survives save and restore");
                Num Loss(int alloc)
                {
                    var t = new Sim(new Settings { seed = 1234 });
                    t.CS("0,0").esc = 45;
                    RunS(t, 120 * 60, (sim, i) => { var d = sim.Driven(); if (d != null) Place(d, P(sim.nest.entrance.x, sim.nest.entrance.y + 0.3, sim.nest.entrance.z)); return Idle(c => c.alloc = alloc); });
                    return t.colony.stats.poisoned;
                }
                Num lp = Loss(2), ls = Loss(3);
                Ok(lp > ls * 1.5 && ls > 0, $"foraging for protein in a baited area poisons more of the colony than foraging for sugar ({D(lp):0.0} vs {D(ls):0.0})");
                ev = RunS(s, (int)((m.until - s.minute) * s.tpm) + 120);
                Ok(Count(ev, "muniEnd") == 1 && s.muni.active == null && s.CS("0,0").esc < 25 && s.MuniBaits().Count == 0, $"after {T.muni.days} days the stations come down and the area calms (escalation {D(s.CS("0,0").esc):0.0})");
            }
            {
                string tag = new Settings { beeAggression = 1.5, exterminator = false, reaction = 1.4 }.WorldTag();
                Ok(new Settings().WorldTag() == "" && tag == "slow humans · bees ×1.5 · no exterminators", $"a world's modifiers read as a short tag (\"{tag}\")");
                Ok(new Settings { seed = 1 }.RulesHash() == new Settings { seed = 2 }.RulesHash() && new Settings().RulesHash() != new Settings { birds = false }.RulesHash() && new Settings().RulesHash() != new Settings { escalation = 1.6 }.RulesHash(), "the rules hash changes with every modifier and not with the seed");
                var bs = new Sim(new Settings { seed = 1234 }); var slow = new Sim(new Settings { seed = 1234, reaction = 1.4 }); var fast = new Sim(new Settings { seed = 1234, reaction = 0.3 });
                var hb = bs.active[0]; var hs = slow.HumanByHex(hb.hex); var hf = fast.HumanByHex(hb.hex);
                Ok(hs.tr.reactionTicks == Rnd(hb.tr.reactionTicks * 1.4) && hf.tr.reactionTicks >= T.resolve.minConsequenceTicks, $"slow humans react later ({hb.tr.reactionTicks} -> {hs.tr.reactionTicks} ticks); fast ones never inside the consequence window ({hf.tr.reactionTicks})");
                var r = Persist.Restore(Persist.Snapshot(slow));
                Ok(r.HumanHash() == slow.HumanHash() && r.HumanByHex(hb.hex).tr.reactionTicks == hs.tr.reactionTicks, "modifiers survive save and restore");
                var touchy = new Sim(new Settings { seed = 1234, escalation = 2 });
                touchy.AddEsc(0, 0, 3); bs.AddEsc(0, 0, 3);
                Ok(touchy.CS("0,0").esc == 2 * bs.CS("0,0").esc, "touchy neighborhoods escalate twice as fast");
                var quiet = new Sim(new Settings { seed = 1234, pestControl = false, exterminator = false, birds = false });
                quiet.CS("0,0").esc = 45;
                var ev = RunS(quiet, 3000);
                Ok(Count(ev, "muniStart") == 0 && Count(ev, "extScheduled") == 0 && quiet.birdState.Count == 0, "systems switched off stay off: no pest control, no exterminator, no birds");
            }
            {
                List<SimEvent> Found(Sim t, V3 p) { Place(t.wasp, p); return RunS(t, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Interact : 0)); }
                var g = Spring();
                var hole = g.activeChunks.SelectMany(r => g.SitesIn(r).holes).First(h => Hypot(h.x - g.wasp.x, h.z - g.wasp.z) < 40);
                var ev = Found(g, P(hole.x + 0.03, 0.12, hole.z));
                Ok(Count(ev, "nestFounded") == 1 && g.nest.site == "ground" && g.nest.entrance.y < 0.05 && g.colony.maxCells == T.sites.ground.maxCells, "E at a burrow in the grass founds an underground nest");
                var b = Spring();
                var br = b.activeChunks.SelectMany(r => b.SitesIn(r).branches).First(x => Hypot(x.t.x - World.NEST.treeX, x.t.z - World.NEST.treeZ) > 3);
                ev = Found(b, P(br.p.x, br.p.y - 0.05, br.p.z));
                Ok(Count(ev, "nestFounded") == 1 && b.nest.site == "branch" && b.nest.y > 1.5, $"E under a branch founds a hanging nest ({D(b.nest.y):0.0} m up)");
                b.colony.pulp = 1e4; b.colony.adults = 2000; b.colony.sugar = 1e3;
                for (int i = 0; i < 400; i++) Colony.Step(b.colony, 0.05, 0, false, 0.3, 0.2);
                Ok(b.colony.cells == T.sites.branch.maxCells, $"a branch nest stops at {T.sites.branch.maxCells} cells");
                var tr = Spring(); var t0 = tr.activeChunks.SelectMany(r => r.content.trees).First(t => Hypot(t.x - World.NEST.treeX, t.z - World.NEST.treeZ) > 3 && t.h > 3);
                Found(tr, P(t0.x + t0.r + 0.03, 2, t0.z));
                (Num brood, Num adults) Rainy(Sim t)
                {
                    t.rainOverride = true;
                    t.colony.adults = 100; t.colony.eggs = 50; t.colony.larvae = 50; t.colony.pupae = 50; t.colony.protein = 50; t.colony.sugar = 50;
                    RunS(t, (int)(t.dayTicks / 4));
                    return (t.colony.eggs + t.colony.larvae + t.colony.pupae, t.colony.adults);
                }
                var rg = Rainy(g); var rt = Rainy(tr); var rb = Rainy(b);
                Ok(rg.brood < rt.brood * 0.97, $"rain floods a burrow's brood ({D(rg.brood):0} vs {D(rt.brood):0} in a trunk nest)");
                Ok(rb.adults < rt.adults && rt.adults < rg.adults, $"rain chills an open nest most and a burrow least (adults: branch {D(rb.adults):0.0}, trunk {D(rt.adults):0.0}, burrow {D(rg.adults):0.0})");
                Num before = g.CS(g.nest.key).esc; g.AddEsc(g.nest.x, g.nest.z, 1);
                Ok(Abs(g.CS(g.nest.key).esc - before - T.sites.ground.discovery) < 1e-9, "stings near a burrow nest raise the alert faster");
            }
            {
                var s = new Sim(new Settings { seed = 1234 });
                int early = s.activeChunks.Sum(r => s.FruitIn(r).Count);
                s.season.startMinute -= 0.45 * s.settings.seasonDays * 1440;
                RunS(s, 2);
                var fruit = s.activeChunks.SelectMany(r => s.FruitIn(r)).ToList();
                Ok(early == 0 && fruit.Count > 3, $"no fruit in early summer; windfalls lie under fruit trees late in the season ({fruit.Count} nearby)");
                var f = fruit[0]; var w = s.wasp;
                Place(w, P(f.x, T.wasp.radius + 0.001, f.z)); w.state = "landed"; w.energy = 0.3;
                RunS(s, 120);
                Ok(w.energy > 0.6, $"a wasp feeds on fallen fruit (crop {D(w.energy):0.00})");
                var r = Persist.Restore(Persist.Snapshot(s));
                string Fs(Sim x) => string.Join(";", x.activeChunks.SelectMany(c => x.FruitIn(c)).Select(q => $"{q.x} {q.z} {q.i}"));
                Ok(Fs(r) == Fs(s), "the same fruit lies in the same places after a restore");
            }
        }
    }
}
