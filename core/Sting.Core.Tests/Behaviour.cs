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
        /// someone sitting at a table, in the home park if there is one (the chunks around it are yards since T1-12)
        static Human Seated(Sim sim, Func<Human, bool> pred)
        {
            bool ok(Human h) => !h.special && h.posture == "sit" && h.state == "idle" && pred(h);
            return sim.active.FirstOrDefault(h => h.chunk == "0,0" && ok(h)) ?? sim.active.FirstOrDefault(ok);
        }
        static double D(Num n) => (double)n;
        static string Cause(SimEvent e) => e == null ? "none" : (string)e["cause"];
        static void Ok(bool cond, string msg) => Assert("sim: " + msg, cond);
        static double Hypot(Num a, Num b) => Math.Sqrt(D(a) * D(a) + D(b) * D(b));
        /// nobody swats or covers: every human a freezer
        static Sim Calm(Sim s) { foreach (var h in s.active) { var c = h.tr.Clone(); c.style = Style.Freezer; h.tr = c; } return s; }
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
                    var s = new Sim(new Settings { seed = seed }); var bot = Bots.StingBot(plan, h => h.chunk == "0,0"); // the home park (the yards around it are fenced since T1-12)
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
            // 36. tuning as data (T1-22): the file sets every tunable value of T and nothing else
            {
                var (unknown, missing) = TuneResult;
                Ok(unknown.Count == 0 && missing.Count == 0 && Tune.Hash != "built-in", $"the tuning file sets every value of T ({Tune.Keys().Count} keys, hash {Tune.Hash}; unknown {string.Join(", ", unknown)}; missing {string.Join(", ", missing)})");
                Ok(T.hiber.name.hollow == "in a hollow tree" && T.alloc[0].name.Length > 0, "strings and tables of tables land too");
                Ok(Tune.HashOf("a = 1\r\n") == Tune.HashOf("a = 1\n"), "the tuning hash ignores carriage returns");
                bool threw = false; try { Tune.Parse("x = [1, 2"); } catch (FormatException) { threw = true; }
                Ok(threw, "a malformed tuning file is refused");
                var snap = Persist.Snapshot(new Sim(new Settings { seed = 1234 }, new SimOpts { noAI = true }));
                string keep = Tune.Hash, why = ""; Tune.Hash = "deadbeef";
                try { Persist.Restore(snap); } catch (System.IO.InvalidDataException e) { why = e.Message; }
                Tune.Hash = keep;
                Ok(why.Contains("tuning " + keep) && Persist.Restore(snap) != null, $"a save made with other tuning will not load ({why})");
            }
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
                // a world with a free hollow tree near home to winter in (some hold wild bees, T1-9)
                ulong hseed = 1234;
                for (ulong sd = 1234; sd < 1300; sd++) { var t0 = new Sim(new Settings { seed = sd }); if (t0.HiberSites().Any(x => x.kind == "hollow")) { hseed = sd; break; } }
                (Sim s, HiberSite site, int scouted, SimEvent win) Late(string scout)
                {
                    var s = new Sim(new Settings { seed = hseed });
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
            // 34. seasonal ecology (T1-8)
            {
                var s = Calm(new Sim(new Settings { seed = 1234, birds = false }));
                void At(double frac) { s.season.startMinute = s.minute - frac * D(s.settings.seasonDays) * 1440; }
                var recs = s.activeChunks.Where(r => r.content.flowers.Count > 0).ToList();
                int[] Blooming(double frac) { At(frac); var k = new int[5]; foreach (var r in recs) for (int i = 0; i < r.content.flowers.Count; i++) if (s.InBloom(r, i)) k[r.content.flowers[i].color]++; return k; }
                var early = Blooming(0.1); var late = Blooming(0.85);
                Ok(early[0] > 0 && early[4] == 0 && late[0] == 0 && late[4] > 0, $"each kind of flower blooms in its own part of the season (early {string.Join("/", early)}, late {string.Join("/", late)})");
                At(0.5);
                ChunkRec rec = null; int fi = -1;
                foreach (var r in recs) { var b = s.BeeLoad(r); for (int i = 0; i < r.content.flowers.Count && fi < 0; i++) if (s.InBloom(r, i) && b[i] == 0) { rec = r; fi = i; } if (fi >= 0) break; }
                var f = rec.content.flowers[fi]; var w = s.wasp;
                w.energy = 0.2;
                Num n0 = s.NectarAt(rec, fi);
                RunS(s, 600, (sim, i) => { if (w.state == "fly" || w.state == "landed") Place(w, P(f.x, f.y + 0.03, f.z)); w.energy = Min(w.energy, 0.5); return Idle(); });
                Num n1 = s.NectarAt(rec, fi), e1 = w.energy;
                RunS(s, 30, (sim, i) => { Place(w, P(f.x, f.y + 0.03, f.z)); return Idle(); });
                Ok(n0 == 1 && n1 == 0 && w.energy <= e1 + 0.02, $"a wasp drinks a flower dry and gets only the trickle that regrows (nectar {D(n0)} -> {D(n1)}, crop {D(e1):0.000} -> {D(w.energy):0.000})");
                s.CS(rec.key).nectar[fi].m -= 360;
                Ok(s.NectarAt(rec, fi) > 0.5, $"the flower refills over the day ({D(s.NectarAt(rec, fi)):0.00} after six hours)");
                (ChunkRec r, int i, int n)? bee = null;
                foreach (var r in s.activeChunks) { var b = s.BeeLoad(r); for (int i = 0; i < b.Length; i++) if (bee == null && b[i] * T.eco.beeDrawPerDay > T.eco.regenPerDay && s.InBloom(r, i)) bee = (r, i, b[i]); }
                Ok(bee == null || s.NectarAt(bee.Value.r, bee.Value.i) < 0.2, $"flowers the bees work stay drained ({(bee == null ? "no such flower here" : $"{bee.Value.n} bees, nectar {D(s.NectarAt(bee.Value.r, bee.Value.i)):0.00}")})");
                (int cats, int flies) Prey(double frac) { At(frac); int cats = 0, flies = 0; foreach (var r in s.activeChunks) { for (int i = 0; i < r.content.caterpillars.Count; i++) if (s.CatActive(r, i)) cats++; for (int i = 0; i < r.content.flies.Count; i++) if (s.FlyActive(r, i)) flies++; } return (cats, flies); }
                var p1 = Prey(0.4); var p2 = Prey(0.95);
                Ok(p1.cats > 0 && p2.cats == 0 && p2.flies > p1.flies, $"caterpillars in early summer, more flies late (caterpillars {p1.cats} -> {p2.cats}, flies {p1.flies} -> {p2.flies})");
                At(0.5); var a1 = s.EcoAvail(); At(0.97); var a2 = s.EcoAvail();
                Ok(a2.sugar < a1.sugar && a2.protein < a1.protein, $"the abstract foragers find less late in the season (sugar {D(a1.sugar):0.00} -> {D(a2.sugar):0.00}, protein {D(a1.protein):0.00} -> {D(a2.protein):0.00})");
                Carrion cr = null; ChunkRec crRec = null;
                for (int d = 0; d < 30 && cr == null; d++) { s.day = d; foreach (var r in s.activeChunks) { var l = s.CarrionIn(r); if (l.Count > 0) { cr = l[0]; crRec = r; break; } } }
                Ok(cr != null, $"carrion turns up now and then (day {s.day})");
                var w2 = s.wasp; w2.carry = null; w2.state = "fly";
                Place(w2, P(cr.x, cr.y + 0.02, cr.z));
                RunS(s, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Interact : 0));
                var left = s.CarrionIn(crRec).FirstOrDefault(x => x.d == cr.d);
                Ok(w2.carry != null && w2.carry.what == "carrion" && (left?.left ?? 0) == cr.left - 1, $"E at the carcass takes a load of meat ({w2.carry?.what}, {left?.left ?? 0} left)");
            }
            // 35. feral hives and robbing (T1-9)
            {
                var s = new Sim(new Settings { seed = 1234, birds = false });
                var wild = new List<(ChunkRec r, Hive hv, int h, string key)>();
                foreach (var r in s.activeChunks) { var hs = s.HivesIn(r); for (int h = 0; h < hs.Count; h++) if (hs[h].feral) wild.Add((r, hs[h], h, r.key)); }
                Ok(wild.Count >= 2 && wild.All(x => x.hv.bees.Count == T.feral.guards + T.feral.foragers), $"wild bee colonies live in hollow trees and shed walls near home ({wild.Count})");
                Ok(!s.HiberSites().Any(x => wild.Any(y => Hypot(x.x - y.hv.x, x.z - y.hv.z) < 0.05)), "a hollow or a wall crack that bees hold is not a winter site");
                var (_, hv, hh, key) = wild[0]; var w = s.wasp;
                T.feral.killOverride = 0;
                List<SimEvent> Rob(bool mash)
                {
                    w.carry = null; w.energy = 0.3; w.state = "fly"; Place(w, P(hv.ex, hv.ey, hv.ez));
                    var ev = new List<SimEvent>();
                    for (int i = 0; i < 400; i++) { int ii = i; ev.AddRange(RunS(s, 1, (sim, j) => Idle(c => { c.act = ii == 1 ? Act.Interact : 0; c.sting = mash && ii % 2 != 0 ? 1 : 0; }))); if (i > 2 && w.state != "robbing") break; }
                    return ev;
                }
                var e1 = Rob(true);
                var done = Find(e1, "robbed"); var start = Find(e1, "robStart");
                Ok(start != null && done != null && done.t - start.t < D(T.feral.robSecs) * 60, $"E at the entrance goes in, and mashing sting grabs faster ({(done != null && start != null ? (done.t - start.t) / 60.0 : 0):0.0} s)");
                Ok(w.carry != null && w.carry.what == "bee brood" && w.energy == 1 && s.hiveAlarms.Get(key + "#" + hh) != null, "out with honey in the crop and a larva, into an alarmed hive");
                for (int k = 1; k < T.feral.loadsPerDay; k++) Rob(true);
                var e2 = Rob(true);
                Ok(Count(e2, "hiveEmpty") == 1 && w.carry == null, $"a hive gives {T.feral.loadsPerDay} loads a day, then nothing");
                w.carry = null; w.state = "fly"; Place(w, P(hv.ex, hv.ey, hv.ez));
                var e3 = RunS(s, 30, (sim, i) => Idle(c => { c.act = i == 1 ? Act.Interact : 0; c.burst = i == 20 ? 1 : 0; }));
                Ok(Count(e3, "robAbort") == 1 && w.state != "robbing" && w.carry == null, "Shift bails out empty-handed");
                T.feral.killOverride = 1000;
                var s2 = new Sim(new Settings { seed = 1234, birds = false }); var w2 = s2.wasp;
                Place(w2, P(hv.ex, hv.ey, hv.ez));
                var e4 = RunS(s2, 10, (sim, i) => Idle(c => c.act = i == 1 ? Act.Interact : 0));
                Ok(Cause(e4.FirstOrDefault(e => e.type == "waspDied")) == "stung inside a hive", $"the bees inside can kill a robber ({Cause(e4.FirstOrDefault(e => e.type == "waspDied"))})");
                T.feral.killOverride = null;
                var s3 = new Sim(new Settings { seed = 1234, birds = false });
                s3.colony.deficit = 0.9;
                int picks = 0;
                for (int k = 0; k < 40; k++) { var a = s3.SpawnWasp(false); a.role = "sugar"; Place(a, P(hv.ex + 0.5, hv.ey, hv.ez)); s3.AiPick(a); if (a.ai.target != null && a.ai.target.kind == "hive") picks++; }
                Ok(picks > 0, $"short of sugar, AI foragers go for hives ({picks} of 40 near one)");
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
            // 37. senses for AI wasps (T1-16): food by scent, prey by sight, finds remembered and shared at the nest
            {
                var s = new Sim(new Settings { seed = 1234, birds = false });
                RunS(s, 1);
                s.windOverride = new V3(0, 0, 0);
                Num jit = T.sense.jitter; T.sense.jitter = 0;
                s.colony.deficit = 0;
                var rec = s.activeChunks[4]; string key = rec.key; var fi = s.FlowerIdx(rec);
                int fl = -1;
                for (int i = 0; i < rec.content.sugar.Count && fl < 0; i++) if (rec.content.sugar[i].kind == "flower" && s.InBloom(rec, fi[i])) fl = i;
                var fx = rec.content.sugar[fl];
                s.nectarOverride = (r, j) => r == rec && j == fi[fl] ? 1 : 0; // this flower alone has nectar
                var a = s.SpawnWasp(false); a.role = "sugar";
                Num R = T.sense.smell * T.sense.flower;
                Place(a, P(fx.x, fx.y + 0.9 * R, fx.z)); var t1 = s.Sense(a);
                Place(a, P(fx.x, fx.y + 1.1 * R, fx.z)); var t2 = s.Sense(a);
                Ok(t1 != null && t1.kind == "sugar" && t1.key == key && t1.i == fl && t2 == null, $"a flower is smelled within its reach ({D(R):0.0} m in still air) and not beyond");
                s.windOverride = new V3(T.sense.windRef, 0, 0);
                Num dn = s.ScentRange(fx.x + 5, fx.z, P(fx.x, fx.y, fx.z), 1), up = s.ScentRange(fx.x - 5, fx.z, P(fx.x, fx.y, fx.z), 1);
                Ok(Abs(dn - T.sense.smell * (1 + T.sense.downwind)) < 1e-6 && Abs(up - T.sense.smell * (1 - T.sense.downwind)) < 1e-6, $"scent carries downwind ({D(dn):0.0} m) and hardly upwind ({D(up):0.0} m)");
                s.windOverride = new V3(0, 0, 0);
                var p = s.SpawnWasp(false); p.role = "protein";
                int fly = 0; while (!s.FlyActive(rec, fly)) fly++;
                var fp = World.FlyPos(rec.content.flies[fly], s.tick);
                Place(p, P(fp.x + 3, fp.y, fp.z)); p.vx = -2; var seen = s.Sense(p);
                p.vx = 2; var unseen = s.Sense(p);
                Ok(seen != null && seen.sub == "fly" && !(unseen != null && unseen.sub == "fly"), "a fly 3 m ahead is seen; flying away, it is not");
                var n = s.nest.entrance; var tgt = new AiTarget { kind = "sugar", key = key, i = fl, c = 4 };
                Place(a, n); a.ai.from = tgt; a.ai.cargo = 0.9; a.energy = 1;
                s.NestTouch(a);
                Ok(a.ai.known != null && a.ai.known.t == tgt && s.homeScent != null && s.homeScent.t == tgt, "a forager home with food remembers its source, and the colony smells it on her");
                var b = s.SpawnWasp(false); b.role = "sugar"; Place(b, n);
                s.AiPick(b);
                Ok(b.ai.mode == "outbound" && b.ai.target.i == fl && b.ai.target.key == key, "a nestmate leaving next goes for that source");
                s.homeScent = null; s.nectarOverride = null;
                Num smell = T.sense.smell; T.sense.smell = 0.01;
                var c = s.SpawnWasp(false); c.role = "sugar"; Place(c, n); c.state = "fly";
                s.AiPick(c);
                bool searching = c.ai.mode == "search";
                Num far = 0, inner = 1e9;
                for (int i = 0; i < 900 && c.ai.mode == "search"; i++)
                {
                    RunS(s, 1);
                    Num d = Sqrt(Sq(c.x - n.x) + Sq(c.z - n.z));
                    far = Max(far, d); if (i > 300) inner = Min(inner, d);
                }
                Ok(searching && far > T.sense.searchR0 + 0.5 * T.sense.ringStep && far < T.sense.searchRange && inner > T.sense.searchR0, $"with nothing in reach a forager searches in a widening spiral round the nest (out to {D(far):0.0} m in 15 s)");
                T.sense.smell = smell;
                var ev = RunS(s, 900);
                Ok(ev.Any(e => e.type == "aiFound" && (int)e["id"] == c.id) || c.ai.mode != "search", $"with its nose back it finds food on the way round ({c.ai.mode})");
                var al = new Alarm { x = n.x, y = n.y, z = n.z, until = s.tick + T.alarm.ticks, killerHex = "" };
                Num fresh = s.AlarmReach(a, al); al.until = s.tick + 1; Num old = s.AlarmReach(a, al);
                Ok(Abs(fresh - T.alarm.radius) < 1e-6 && old < 0.51 * T.alarm.radius, $"alarm pheromone reaches {D(fresh)} m fresh and half that as it fades");
                T.sense.jitter = jit; s.windOverride = null;
            }
            // 38. barbecues (T1-10): grills, a cook, meat on the grate and the plate, the hot grate and the air over it
            {
                var s = new Sim(new Settings { seed = 7, birds = false });
                RunS(s, 1);
                void Jump(Sim x, long m) { x.clockOffset += (m - x.minute) * x.tpm; x.Minute(World.ClockMinutes(x.tick + x.clockOffset, x.settings)); }
                ChunkRec rec = null; Grill g = null;
                foreach (var r in s.activeChunks) if (g == null && s.GrillsIn(r).Count > 0) { rec = r; g = s.GrillsIn(r)[0]; }
                var tb = rec.content.tables[g.ti];
                Num gd = Sqrt(Sq(g.x - tb.x) + Sq(g.z - tb.z));
                Ok(gd > 1.5 && gd < 2.5, $"some picnic tables have a grill at one end ({s.activeChunks.Sum(r => s.GrillsIn(r).Count)} of {s.activeChunks.Sum(r => r.content.tables.Count)} tables)");
                long d0 = s.day, day = -1;
                for (long d = d0 + 1; d < d0 + 40 && day < 0; d++) { s.day = d; g.d = long.MinValue; if (s.BbqDay(rec, g)) day = d; }
                s.day = d0; g.d = long.MinValue;
                Ok(day > 0, $"a warm dry day with the cook about brings a barbecue (day {day})");
                Jump(s, day * 1440 + (long)g.from - 240);
                var cook = s.HumanByHex(g.cook);
                bool atGrill = false, grillMeat = false, plate = false, lit = false;
                var ev = new List<SimEvent>();
                for (int i = 0; i < 4000 && !(plate && atGrill); i++)
                {
                    ev.AddRange(RunS(s, 1));
                    lit |= s.BbqLit(rec, g);
                    if (cook.state == "cook" && Sqrt(Sq(cook.x - g.sx) + Sq(cook.z - g.sz)) < 0.01) atGrill = true;
                    var m = s.MeatIn(rec);
                    if (m.Any(x => x.hot)) grillMeat = true;
                    if (m.Any(x => !x.hot)) plate = true;
                }
                Ok(lit && atGrill && cook.posture == "stand" && Count(ev, "cookStart") >= 1, "the cook leaves the table and stands at the lit grill");
                Ok(grillMeat && plate, "meat sits on the grate, and later on a plate on the table");
                var w = s.wasp; var pm = s.MeatIn(rec).First(x => !x.hot);
                Place(w, P(pm.x, pm.y + 0.01, pm.z)); w.state = "fly"; w.carry = null;
                RunS(s, 2, (sim, i) => Idle(c => c.act = i == 1 ? Act.Interact : 0));
                Ok(w.carry != null && w.carry.what == "meat" && s.MeatIn(rec).First(x => x.i == pm.i).left == pm.left - 1, $"E at the plate takes meat ({w.carry?.what}, {pm.left - 1} left)");
                var pm2 = s.MeatIn(rec).FirstOrDefault(x => !x.hot);
                var guard = new List<SimEvent>();
                for (int i = 0; i < 600 && pm2 != null && !guard.Any(e => e.type == "preSwat" && (string)e["why"] == "meat"); i++)
                {
                    var wd = s.Driven(); if (wd == null) break;
                    Place(wd, P(pm2.x + 0.1, pm2.y + 0.05, pm2.z)); wd.state = "fly";
                    guard.AddRange(RunS(s, 1));
                }
                Ok(guard.Any(e => e.type == "preSwat" && (string)e["why"] == "meat"), "a wasp hanging over the plate gets slapped at");
                var s2 = new Sim(new Settings { seed = 7, birds = false }); RunS(s2, 1);
                var r2 = s2.records.Get(rec.key); var g2 = s2.GrillsIn(r2)[0];
                Jump(s2, day * 1440 + 600); s2.BbqDay(r2, g2);
                Jump(s2, day * 1440 + (long)g2.from + 10);
                var w2 = s2.wasp;
                Place(w2, P(g2.x, T.bbq.grateY + T.wasp.radius + 0.004, g2.z)); w2.state = "fly";
                var e2 = RunS(s2, 3);
                Ok(s2.BbqLit(r2, g2) && Cause(e2.FirstOrDefault(e => e.type == "waspDied")) == "burned on a grill", $"touching a lit grate burns ({Cause(e2.FirstOrDefault(e => e.type == "waspDied"))})");
                RunS(s2, 200);
                var w3 = s2.Driven() ?? s2.wasp;
                foreach (var hm in s2.active) hm.cooldown = int.MaxValue; // nobody swats: the heat alone
                w3.state = "fly"; w3.bodyT = 30;
                var e3 = new List<SimEvent>();
                for (int i = 0; i < 600 && !e3.Any(e => e.type == "waspDied"); i++) { Place(w3, P(g2.x + 0.05, T.bbq.grateY + 0.12, g2.z)); e3.AddRange(RunS(s2, 1)); }
                Ok(Cause(e3.FirstOrDefault(e => e.type == "waspDied")) == "cooked over a grill", $"hanging in the hot air over it cooks a wasp ({Cause(e3.FirstOrDefault(e => e.type == "waspDied"))})");
                var a = s.SpawnWasp(false); a.role = "protein";
                Place(a, P(g.x + 12, 1.5, g.z));
                Num jit = T.sense.jitter; T.sense.jitter = 0;
                var t = s.Sense(a); T.sense.jitter = jit;
                Ok(t != null && t.sub == "meat", $"barbecue meat draws a hunter from 12 m ({t?.sub ?? t?.kind ?? "nothing"})");
            }
            // 39. regions (T1-12): the layout, a yards chunk, houses that block the view, pulp that runs out
            {
                var uses = new Dictionary<string, int>();
                for (int z = -4; z < 4; z++) for (int x = -4; x < 4; x++) { var u = World.LandUse(1234, x, z); uses[u] = (uses.TryGetValue(u, out var n0) ? n0 : 0) + 1; }
                Ok(World.LandUse(1234, 0, 0) == "park" && new[] { -4, -1, 1, 3 }.All(x => World.LandUse(1234, x, 0) == "park") && uses["yards"] >= 40 && uses["mall"] == 3 && uses["forest"] >= 3,
                    $"the home region: a park strip through home, a strip mall, a forest corner, yards everywhere else ({string.Join(", ", uses.Select(kv => kv.Key + " " + kv.Value))})");
                var c = World.GenerateChunk(1234, 0, 1);
                var houses = c.sheds.Where(q => q.house).ToList(); int fences = c.boxes.Count(q => q.fence);
                Ok(c.use == "yards" && houses.Count >= 2 && fences >= 30 && c.roads.Count == 1, $"a yards chunk: a street, {houses.Count} houses, backyard fences in {fences} sections");
                var s = new Sim(new Settings { seed = 1234, birds = false });
                RunS(s, 1);
                var rec = s.records.Get("0,1"); var h = rec.content.sheds.First(q => q.house);
                Ok(!s.CanSee(h.x, h.z - h.hd - 2, h.x, h.z + h.hd + 2) && s.CanSee(h.x + h.hw + 3, h.z - h.hd - 2, h.x + h.hw + 3, h.z + h.hd + 2), "a house blocks the view across it; the gap beside it does not");
                // pitched roofs are solid as drawn: a wasp is pushed out onto the slope, can land on it, and keeps dry under the eaves
                {
                    var f = World.ShedRoof(h); Num R = T.wasp.radius;
                    V3 At(Num u, Num y, Num v) => Sim.RoofWorld(f, u, y, v);
                    Num Off(Num x, Num y, Num z) { var l = Sim.RoofLocal(f, x, y, z); return (f.rise * (Abs(l.u) - f.S) + f.S * l.y) / f.L; }
                    var ww = s.wasp; var p0 = At(0.8, 0.5, 1); Place(ww, p0);
                    for (int i = 0; i < 6; i++) s.Collide(ww);
                    var sf = s.StaticSurface(At(1.5, f.rise * (1 - 1.5 / f.S) + 0.05, 0), 0.2);
                    Ok(D(Abs(Off(ww.x, ww.y, ww.z) - R)) < 1e-9 && ww.y > f.y0 + 0.5 && sf != null && sf.kind == "roof" && sf.ny < 0.99 && sf.ny > 0.5 && D(Abs(Off(sf.x, sf.y, sf.z))) < 1e-9,
                        $"a house's roof is pitched: a wasp inside it comes out on the slope ({D(ww.y - f.y0):0.00} m above the eaves, not on a flat top), and lands on it at its tilt");
                    var a1 = At(0, 1, 0); var a2 = At(0, f.rise + 0.1, 0);
                    Place(ww, At(f.wall + 0.06, -0.3, 0)); bool dry = s.Sheltered(ww); Place(ww, At(f.S + 0.4, -0.3, 0)); bool wet = !s.Sheltered(ww);
                    Ok(s.InSolid(a1.x, a1.y, a1.z) && !s.InSolid(a2.x, a2.y, a2.z) && dry && wet, "inside the roof is solid; under the eaves it is dry, a step out it is not");
                }
                int fi = rec.content.boxes.FindIndex(q => q.fence); var fb = rec.content.boxes[fi]; int loads = s.PulpLoads(fb);
                var w = s.wasp; int got = 0;
                for (int k = 0; k < loads + 2; k++)
                {
                    Place(w, P(fb.maxx + T.wasp.radius + 0.005, 0.8, (fb.minz + fb.maxz) / 2)); w.state = "fly"; w.carry = null; w.energy = 1;
                    var ev = RunS(s, T.pulp.chewTicks + 4, (sim, i) => Idle(cm => cm.act = Act.Interact));
                    if (ev.Any(e => e.type == "chewed" && (int)e["id"] == w.id)) got++;
                    RunS(s, 2);
                }
                Ok(got == loads && s.PulpLeft("0,1", fi) == 0, $"a fence section gives {got} loads of pulp, then it is stripped bare");
                var r2 = Persist.Restore(Persist.Snapshot(s));
                Ok(r2.PulpLeft("0,1", fi) == 0, "a stripped fence stays stripped after save and restore (a chunk delta)");
            }
            // 40. human days (T1-11): strollers, gardeners, sunbathers; the weather picks who comes out
            {
                var acts = new Dictionary<string, int>(); bool shapes = true;
                for (int z = -4; z < 4; z++) for (int x = -4; x < 4; x++) foreach (var h in World.GenerateChunk(1234, x, z).humans)
                {
                    if (h.act == null) continue;
                    acts[h.act] = (acts.TryGetValue(h.act, out var n0) ? n0 : 0) + 1;
                    if (h.act == "sun" ? h.posture != "lie" || h.path != null : h.posture != "stand" || h.path == null || h.path.Length < 4 || h.path.Length % 2 != 0) shapes = false;
                }
                Ok(acts.GetValueOrDefault("stroll") >= 10 && acts.GetValueOrDefault("garden") >= 10 && acts.GetValueOrDefault("sun") >= 10 && shapes, $"the home region has strollers, gardeners and sunbathers ({string.Join(", ", acts.Select(kv => kv.Key + " " + kv.Value))})");
                var lie = new Frame(3, -2, 0.6, 0.8, true); var parts = Body.BodyParts(Body.HumanTraits(7, 77), "stand");
                var head = Body.ToWorld(lie, parts[0].a); var foot = Body.ToWorld(lie, parts.First(q => q.name == "ShinL").b); var up = Body.DirToWorld(lie, P(0, 0, 1));
                Ok(head.y < 0.5 && foot.y < 0.5 && (head.x - foot.x) * lie.fx + (head.z - foot.z) * lie.fz > 1.2 && Abs(up.y - 1) < 1e-9, $"a sunbather lies on their back along the facing (head {D(head.y):0.00} m up)");
                var s = new Sim(new Settings { seed = 1234, dayMinutes = 20 }, new SimOpts { noAI = true });
                var win = new HumanWin { arrive = 480, leave = 1200 };
                HumanWin At(long d, string a) { s.day = d; return s.ActWindow(a, win); }
                long mild = 1;
                while (World.Weather(s.seed, mild).rain || s.AirAt(mild * 1440 + 780) < T.days.gardenTemp || s.AirAt(mild * 1440 + 780) >= T.days.sunTemp) mild++;
                Ok(new[] { "stroll", "garden", "sun" }.All(a => At(8, a) == null) && At(mild, "sun") == null && At(mild, "garden") != null, "nobody is out in the rain; a dry, mild day brings gardeners but no sunbathers");
                var w2 = At(2, "sun");
                Ok(w2 != null && w2.arrive == T.days.sunFrom && w2.leave == T.days.sunTo, "on a hot day sunbathers lie out through the warm hours");
                s.day = 0;
                RunS(s, 3);
                var moved = new Dictionary<string, double>(); var pos = new Dictionary<string, (Num x, Num z)>(); int dwell = 0, lying = 0;
                for (int t = 0; t < 6000; t++)
                {
                    RunS(s, 1);
                    if (t % 30 != 0) continue;
                    foreach (var hm in s.active)
                    {
                        if (hm.home.act == null) continue;
                        if (pos.TryGetValue(hm.hex, out var p0)) moved[hm.hex] = moved.GetValueOrDefault(hm.hex) + D(Hypot(hm.x - p0.x, hm.z - p0.z));
                        pos[hm.hex] = (hm.x, hm.z);
                        if (hm.state == "garden" && !hm.walking) dwell++;
                        if (hm.home.act == "sun" && hm.state == "idle" && hm.posture == "lie") lying++;
                    }
                }
                var strollers = s.active.Where(h => h.home.act == "stroll").ToList();
                Ok(strollers.Any(h => moved.GetValueOrDefault(h.hex) > 60) && dwell > 0 && lying > 0, $"strollers walk their loops, gardeners stop at their beds, sunbathers lie out ({string.Join(", ", strollers.Select(h => moved.GetValueOrDefault(h.hex).ToString("0") + " m"))})");
                var st = strollers.First(h => h.state == "stroll");
                s.ApplyCommit(new NetEv { type = "sting", peer = s.peer, humanHex = st.hex, panicGain = 0, driven = false, sx = st.x - st.fx, sz = st.z - st.fz, zone = 0, flee = true, waspId = 0 });
                bool ran = st.state == "flee", back = false; Num x0 = st.x, z0 = st.z; var pth = st.home.path;
                for (int t = 0; t < 3000 && !back; t++) { RunS(s, 1); back = st.state == "stroll"; }
                var onPath = s.Rejoin(st); double fromStart = D(Sqrt(Sq(pth[0] - x0) + Sq(pth[1] - z0))), fromRun = D(Sqrt(Sq(st.x - x0) + Sq(st.z - z0)));
                Ok(ran && back && D(Sqrt(Sq(onPath.x - st.x) + Sq(onPath.z - st.z))) < 1e-6 && (fromRun < 8 || fromRun < fromStart), $"a stroller who is stung runs, then walks back to the nearest point of the round and walks on ({fromRun:0.0} m from where it ran, the round starts {fromStart:0.0} m away)");
                var r = Persist.Restore(Persist.Snapshot(s));
                Ok(r.HumanHash() == s.HumanHash() && r.HumanByHex(st.hex).wp == st.wp && r.HumanByHex(st.hex).home.path.Length == st.home.path.Length, "a walk in progress survives save and restore");
            }
            // 41. water (T2-1): birdbaths and puddles, loads carried home, a hot nest cooled by water
            {
                int baths = 0, yb = 0;
                for (int z = -4; z < 4; z++) for (int x = -4; x < 4; x++) { var cc = World.GenerateChunk(1234, x, z); baths += cc.baths.Count; if (cc.use == "yards") yb += cc.baths.Count; }
                var home = World.GenerateChunk(1234, 0, 0);
                Ok(home.baths.Count == 1 && baths >= 30 && yb >= 20 && home.cylinders.Any(q => q.bath && !q.wood), $"birdbaths in backyards and parks ({baths} in the home region, {yb} in yards, one in the home park), solid but not wood");
                var s = new Sim(new Settings { seed = 1234, birds = false, dayMinutes = 20 }, new SimOpts { noAI = true });
                RunS(s, 2);
                long rd = 1; while (!World.Weather(s.seed, rd).rain) rd++;
                var w0 = World.Weather(s.seed, rd); long t0 = rd * 1440;
                Ok(s.PuddleDay(t0 + (long)w0.rainStart - 1) < 0 && s.PuddleDay(t0 + (long)w0.rainStart + (long)T.water.wetAfter) == rd && s.PuddleDay(t0 + (long)w0.rainEnd + (long)T.water.dryMinutes - 1) == rd && s.PuddleDay(t0 + (long)w0.rainEnd + (long)T.water.dryMinutes) < 0,
                    $"puddles lie from {D(T.water.wetAfter)} min after the rain starts until {D(T.water.dryMinutes) / 60} h after it stops (day {rd})");
                var rec = s.records.Get("0,1"); var ps = s.PuddlesIn(rec, rd);
                var paved = rec.content.roads.Concat(rec.content.lots).ToList();
                Ok(ps.Count > 0 && ps.All(p => paved.Any(r => p.x >= r.minx && p.x <= r.maxx && p.z >= r.minz && p.z <= r.maxz)) && ps.All(p => !rec.content.boxes.Any(b => p.x > b.minx && p.x < b.maxx && p.z > b.minz && p.z < b.maxz)),
                    $"in a yards chunk they lie on the street ({ps.Count} puddles), never under anything");
                var bb = home.baths[0]; var w = s.wasp;
                Place(w, P(bb.x + 0.05, bb.h + T.wasp.radius + 0.004, bb.z)); w.state = "fly"; w.carry = null;
                RunS(s, 1);
                Ok(s.hint.water && !s.hint.wood, "over a birdbath the wasp can take water, and it is not wood");
                var ev = RunS(s, T.water.fillTicks + 2, (sim, i) => { if (w.state == "fly") Place(w, P(bb.x + 0.05, bb.h + T.wasp.radius + 0.004, bb.z)); return Idle(c => c.act = Act.Interact); });
                Ok(w.carry != null && w.carry.kind == "water" && Count(ev, "watered") == 1, "holding E at the water takes a load");
                Place(w, s.nest.entrance); ev = RunS(s, 2);
                Ok(w.carry == null && s.colony.stats.depWater == 1 && ev.Any(e => e.type == "deposit" && (string)e["what"] == "water"), $"delivered at the nest it goes into the store ({D(s.colony.water):0.00})");
                (ColonyState c, Num lost, Num brood0) HotRun(bool wet)
                {
                    var c = Colony.New(); c.water = wet ? 50 : 0; Num b0 = c.eggs + c.larvae + c.pupae;
                    for (int i = 0; i < 120; i++) { if (wet) c.water = 50; Colony.Step(c, (Num)1 / 120, 0, false, 0.3, 0.2, 1, null, ((Num)1, (Num)1)); }
                    return (c, c.stats.cooked, b0);
                }
                var wr = HotRun(true); var dr = HotRun(false);
                Ok(wr.c.cool > 0.99 && wr.lost == 0 && dr.c.cool < 0.05 && dr.lost > dr.brood0 * 0.2, $"a day of lethal heat: with water no brood is lost; dry, {D(dr.lost):0} of {D(dr.brood0):0} brood cook");
                ColonyState Fed(Num heat) { var c = Colony.New(); c.water = 0; c.sugar = 0; c.protein = 0; Colony.Step(c, 0.01, 0, true, 0.3, 0.2, 1, null, (heat, (Num)0)); return c; }
                var coolC = Fed(0); var thirsty = Fed(1);
                Ok(thirsty.cool > 0.8 && thirsty.sugar < coolC.sugar && thirsty.thirst > 0.9, $"a hot nest with an empty store sends foragers for water at the cost of food (sugar {D(thirsty.sugar):0.000} vs {D(coolC.sugar):0.000})");
                var a = new Sim(new Settings { seed = 1234, birds = false }, new SimOpts { noAI = true });
                RunS(a, 2);
                var cw = a.SpawnWasp(false); cw.role = "water";
                bool got = false;
                for (int i = 0; i < 4000 && !got; i++) { foreach (var e in RunS(a, 1)) if (e.type == "deposit" && (int)e["id"] == cw.id && (string)e["what"] == "water") got = true; if (!a.wasps.Contains(cw)) break; }
                Ok(got, "a water carrier flies to the water, drinks a load and brings it home");
            }
            // 42. extreme weather (T2-2): heatwaves, cold snaps, storms
            {
                var days = Enumerable.Range(0, 600).Select(d => World.Weather(1234, d)).ToList();
                List<int> Runs(string kind) { var o = new List<int>(); int n = 0; foreach (var w in days) { if (w.kind == kind) n++; else if (n > 0) { o.Add(n); n = 0; } } return o; }
                var hr = Runs("heat"); var cr = Runs("cold"); var heat = days.Where(w => w.kind == "heat").ToList(); var storms = days.Where(w => w.kind == "storm").ToList();
                Ok(days[0].kind == "normal" && hr.Count >= 3 && cr.Count >= 3 && storms.Count >= 10 && hr.All(n => n >= T.extreme.heatLen[0]) && cr.All(n => n >= T.extreme.coldLen[0]),
                    $"spells run for days: {hr.Count} heatwaves ({string.Join(", ", hr)} days), {cr.Count} cold snaps ({string.Join(", ", cr)}), {storms.Count} storms in {days.Count} days");
                Ok(heat.All(w => !w.rain && w.@base >= T.weather.baseMin + T.extreme.heatBoost - 1e-9) && storms.All(w => w.rain && w.pour == T.extreme.pour && w.wind >= T.extreme.stormWind[0] && w.rainStart >= 13 * 60),
                    "a heatwave is dry and hot from the start; a storm is an afternoon downpour in a gale");
                var sd = storms[0]; var s = new Sim(new Settings { seed = 1234, birds = false, dayMinutes = 20 }, new SimOpts { noAI = true });
                RunS(s, 2);
                void Into(Sim x, long m) { var dw = x.Driven(); if (dw != null) dw.born = m; x.clockOffset += (m - x.minute) * x.tpm; RunS(x, 1); }
                Into(s, sd.day * 1440 + (long)sd.rainStart + 10);
                var tb = s.records.Get("0,0").content.tables[0];
                int Knocks(V3 p, int n)
                {
                    int k = 0;
                    foreach (var e in RunS(s, n, (sim, i) => { var w = sim.wasp; if (w == null) return Idle(); if (w.state != "stunned") { Place(w, p); w.state = "fly"; w.energy = 1; w.bodyT = 30; w.born = sim.minute; } return Idle(c => c.mz = 0); }))
                        if (e.type == "knockedDown") k++;
                    return k;
                }
                int open = Knocks(P(tb.x + 6, 1.5, tb.z + 6), 1200), under = Knocks(P(tb.x, 0.35, tb.z), 1200);
                Ok(s.Raining && s.WeatherToday.kind == "storm" && open >= 3 && under == 0, $"a downpour knocks a wasp in the open out of the air ({open} times in 20 s); under a table it is sheltered");
                Num kp = T.extreme.knockPerSec; T.extreme.knockPerSec = 0;
                Place(s.wasp, P(tb.x + 8, 3, tb.z + 8)); s.wasp.state = "fly";
                Num px = s.wasp.x, pz = s.wasp.z;
                RunS(s, 180, (sim, i) => Idle(c => c.mz = 0));
                T.extreme.knockPerSec = kp;
                double moved = D(Hypot(s.wasp.x - px, s.wasp.z - pz));
                Ok(moved > 2, $"the gale carries a hovering wasp off ({moved:0.0} m in 3 s)");
                ulong hs = 1; DayWeather hd = null;
                for (; hs < 200 && hd == null; hs++) for (int d = 2; d < 30 && hd == null; d++) { var w = World.Weather(hs, d); if (w.kind == "heat" && w.@base > 31) hd = w; }
                var h = new Sim(new Settings { seed = hs - 1, birds = false }, new SimOpts { noAI = true });
                RunS(h, 2);
                (double used, double air) Burn(long m)
                {
                    Into(h, m);
                    var wv = h.wasp; Place(wv, P(20, 3, 20)); wv.state = "fly"; wv.energy = 1; wv.born = h.minute; wv.bodyT = 30;
                    RunS(h, 120, (sim, i) => Idle(c => c.mz = 100));
                    return (D(1 - h.wasp.energy), D(h.Temperature));
                }
                var cool = Burn(1440 + 9 * 60); var hot = Burn(hd.day * 1440 + 15 * 60);
                Ok(hot.air > D(T.extreme.heatFrom) + 4 && hot.used > cool.used * 1.15, $"flying at {hot.air:0} °C in a heatwave burns more sugar than at {cool.air:0} °C ({hot.used * 1000:0.0} vs {cool.used * 1000:0.0})");
                long hm = hd.day * 1440 + 15 * 60;
                h.nest.site = "attic"; var att = h.NestHeat(hm); h.nest.site = "hollow"; var hol = h.NestHeat(hm); h.nest.site = "trunk";
                Ok(att.cook > 0 && hol.cook == 0, $"on a heatwave afternoon an attic comb reaches {D(att.nestT):0.0} °C and its brood cooks without water; in a hollow tree {D(hol.nestT):0.0} °C");
            }
            // 43. males and mating flights (T2-3)
            {
                var c0 = Colony.New(); c0.males = 0;
                Num early = Colony.MalesAbout(c0, T.season.reproStart + 0.01), full = Colony.MalesAbout(c0, T.season.reproFull);
                c0.males = T.males.need; Num ownM = Colony.MalesAbout(c0, T.season.reproStart + 0.01);
                Ok(early < 0.2 && full == 1 && ownM == 1, $"a young queen's chance to find a male: {D(early):0.00} early with none of her own, {D(full):0.00} at the height of the season, {D(ownM):0.00} with brothers");
                Num MateN(Num males) { var c = Colony.New(); c.gynes = 20; c.males = males; Colony.Step(c, 0.5, 0, true, T.season.reproStart + 0.02, 1); return c.mated; }
                Ok(MateN(0) < MateN(T.males.need) * 0.3, $"with no males about few young queens mate ({D(MateN(0)):0.00} vs {D(MateN(T.males.need)):0.00})");
                var s = new Sim(new Settings { seed = 1234, birds = false, dayMinutes = 20 });
                RunS(s, 2);
                s.season.startMinute -= 0.45 * s.settings.seasonDays * 1440;
                s.colony.males = 12; s.colony.gynes = 4;
                var (lek, lr) = s.LekSpot();
                Ok(Hypot(lek.x - s.nest.x, lek.z - s.nest.z) <= T.males.lekRange && lek.y > 2, "the mating spot is over a tree crown near the nest");
                var ev = new List<SimEvent>(); int outM = 0, near = 0;
                for (int i = 0; i < 9000; i++)
                {
                    if (s.wasp != null) { Place(s.wasp, P(s.nest.x + 2, 2, s.nest.z + 2)); s.wasp.born = s.minute; }
                    ev.AddRange(RunS(s, 1));
                    var ms = s.wasps.Where(x => x.caste == "male").ToList();
                    outM = System.Math.Max(outM, ms.Count);
                    if (i % 60 == 0) near += ms.Count(x => Hypot(x.x - lek.x, x.z - lek.z) < T.males.patrolR + 2 && Abs(x.y - lek.y) < 1.5);
                }
                int mated = Count(ev, "mated"), spent = ev.Count(e => e.type == "waspDied" && Cause(e) == "mated");
                Ok(outM >= 2 && near > 20, $"males fly out (up to {outM} at once) and patrol the crown");
                Ok(mated >= 2 && spent >= 1 && spent <= mated, $"young queens fly out and mate ({mated} matings, {spent} with males of the line, who die after)");
                var t = new Sim(new Settings { seed = 1234, birds = false }, new SimOpts { noAI = true });
                RunS(t, 2);
                var m = t.wasp; m.caste = "male"; m.venom = 0;
                var hm = Seated(t, h => true); var arm = hm.sit.First(p => p.name == "ForearmR");
                var spot = Body.ToWorld(hm.F, P((arm.a.x + arm.b.x) / 2, (arm.a.y + arm.b.y) / 2 + arm.r + 0.006, (arm.a.z + arm.b.z) / 2));
                ev = RunS(t, 30, (sim, i) => { Place(m, spot); return Idle(c => c.sting = 1); });
                Ok(Count(ev, "sting") == 0 && m.state != "attached", "a male pressed against an arm cannot sting");
                var u = new Sim(new Settings { seed = 1234, birds = false, dayMinutes = 20 }, new SimOpts { noAI = true });
                RunS(u, 2);
                u.season.startMinute -= 0.45 * u.settings.seasonDays * 1440; u.colony.gynes = 1;
                var me = u.wasp; me.caste = "male"; me.venom = 0;
                var g = u.SpawnWasp(false, "gyne"); g.role = "gyne"; g.ai.mode = "mate"; g.ai.timer = u.tick + T.males.gyneTicks; u.colony.gynes -= 1;
                Num mated0 = u.colony.mated; ev = new List<SimEvent>();
                for (int i = 0; i < 3000 && u.wasps.Contains(g); i++) { ev.AddRange(RunS(u, 1)); if (u.wasp == me) { Place(me, P(g.x, g.y, g.z)); me.born = u.minute; } }
                var mine = ev.FirstOrDefault(e => e.type == "mated");
                Ok(mine != null && (bool)mine["driven"] && ev.Any(e => e.type == "waspDied" && (bool)e["driven"] && Cause(e) == "mated") && u.colony.mated == mated0 + 1, "a player flying a male into a young queen mates with her, and his life ends there");
            }
            // 44. lineage colonies (T2-4): the line's other queens found real colonies run by the AI
            {
                var s = new Sim(new Settings { seed = 1234, birds = false, dayMinutes = 20 });
                RunS(s, 2);
                var sites = new List<HiberSite> { new HiberSite { kind = "bark", x = s.nest.x + 3, y = 1, z = s.nest.z + 3, q = 0.5, n = 3 }, new HiberSite { kind = "litter", x = s.nest.x - 25, y = 0.1, z = s.nest.z + 10, q = 0.3, n = 2 } };
                Num left = s.FoundLine(sites, 0, 4);
                bool gapsOk = true;
                for (int a = 0; a < s.line.Count; a++) for (int b = a + 1; b < s.line.Count; b++) if (Hypot(s.line[a].nest.treeX - s.line[b].nest.treeX, s.line[a].nest.treeZ - s.line[b].nest.treeZ) < T.line.minGap) gapsOk = false;
                Ok(s.line.Count >= 2 && s.line.Count <= T.line.max && left == 4 - s.line.Count && gapsOk && s.line.All(x => x.colony.sited && x.colony.queenAlive && x.colony.adults == 0),
                    $"four queens besides yours: {s.line.Count} found colonies on trunks near where they wintered; {D(left)} stay a count");
                Ok(!Sim.IsRival(new Wasp { colony = "line:1" }) && Sim.IsRival(new Wasp { colony = "3,4" }) && !Sim.IsRival(new Wasp { colony = "own" }), "a sister colony is not a rival");
                var sc = s.line[0];
                for (int i = 0; i < 20 * 60 * 50 * 6 && sc.colony.adults < 1; i += 60) { RunS(s, 1); if (s.wasp != null) s.wasp.born = s.minute; RunS(s, 59); }
                Ok(sc.colony.adults >= 1 && sc.colony.cells > 0 && s.line.Contains(sc), $"a sister queen founds alone and raises her first workers ({D(sc.colony.adults):0.0} adults, {D(sc.colony.cells):0} cells by day {s.day})");
                sc.colony.adults = 40;
                void Jump(long m) { var dw = s.Driven(); if (dw != null) dw.born = m; s.clockOffset += (m - s.minute) * s.tpm; RunS(s, 1); }
                Jump((s.day + 1) * 1440 + 11 * 60);
                while (World.Weather(s.seed, s.day).rain) Jump((s.day + 1) * 1440 + 11 * 60);
                Wasp outW = null;
                for (int i = 0; i < 1200 && outW == null; i++) { RunS(s, 1); if (s.wasp != null) { Place(s.wasp, P(sc.nest.x + 1, sc.nest.y, sc.nest.z + 1)); s.wasp.born = s.minute; } outW = s.wasps.FirstOrDefault(w => w.colony == "line:" + sc.id); }
                Ok(outW != null, "a sister colony near the player sends workers out");
                if (outW != null && s.wasp != null)
                {
                    Place(s.wasp, P(outW.x, outW.y, outW.z)); outW.state = "fly"; s.wasp.state = "fly";
                    var ev = RunS(s, 3, (sim, i) => { if (sim.wasp != null) Place(sim.wasp, P(outW.x, outW.y, outW.z)); return Idle(); });
                    Ok(Count(ev, "fight") == 0 && outW.state != "fighting", "your wasp touching a sister colony's worker does not fight it");
                }
                // a big sister colony posts guards at its entrance, and they go for a rival there, not for you
                sc.colony.young = 0;
                void NearSis() { if (s.wasp != null) { Place(s.wasp, P(sc.nest.x + 1, sc.nest.y, sc.nest.z + 1)); s.wasp.born = s.minute; } }
                string sk2 = "line:" + sc.id; List<Wasp> sg = new List<Wasp>();
                for (int i = 0; i < 1500 && sg.Count < T.guard.count; i++) { RunS(s, 1); NearSis(); sg = s.wasps.Where(w => w.colony == sk2 && w.role == "guard").ToList(); }
                var riv = s.SpawnWasp(false); riv.colony = "9,9"; Place(riv, P(sc.nest.entrance.x + 0.2, sc.nest.entrance.y, sc.nest.entrance.z)); riv.state = "fly";
                bool hunted = false;
                for (int i = 0; i < 30 && !hunted; i++) { NearSis(); foreach (var e in RunS(s, 1)) if (e.type == "guardHunt" && (int)e["target"] == riv.id && sg.Any(g => g.id == (int)e["id"])) hunted = true; }
                s.Despawn(riv);
                Ok(sg.Count == T.guard.count && hunted && sg.All(g => g.ai.huntId != s.drivenId), $"a sister colony of {D(sc.colony.adults):0} posts {sg.Count} guards, who go for a rival at its entrance and not for you");
                // in the breeding season its males and young queens fly to its own mating spot, and its queens mate with the line's males
                s.season.startMinute = s.minute - (T.season.reproStart + 0.05) * s.settings.seasonDays * 1440;
                sc.colony.males = 20; sc.colony.gynes = 10;
                var lek = s.LekSpot(sc.nest).p; var sisM = new HashSet<int>(); var sisQ = new HashSet<int>(); bool mt = false;
                for (int i = 0; i < 6000 && !mt; i++)
                {
                    var evs = RunS(s, 1); NearSis();
                    foreach (var w in s.wasps) if (w.colony == sk2) { if (w.caste == "male") sisM.Add(w.id); if (w.caste == "gyne") sisQ.Add(w.id); }
                    foreach (var e in evs) if (e.type == "mated" && sisQ.Contains((int)e["gyne"]) && sisM.Contains((int)e["male"])) mt = true;
                    var sm0 = s.wasps.FirstOrDefault(w => w.colony == sk2 && w.caste == "male");
                    if (sm0 != null) foreach (var g in s.wasps) if (g.colony == sk2 && g.caste == "gyne" && g.ai.mode == "mate" && D(Sqrt(Sq(g.x - lek.x) + Sq(g.z - lek.z))) < 4) Place(g, P(sm0.x, sm0.y, sm0.z));
                }
                Ok(mt && D(Sqrt(Sq(lek.x - sc.nest.x) + Sq(lek.z - sc.nest.z))) < D(T.males.lekRange) + 1, $"its males ({sisM.Count}) and young queens ({sisQ.Count}) fly from its nest to its own mating spot, where they mate");
                {
                    var sx = new Sim(new Settings { seed = 1234, birds = false }, new SimOpts { noAI = true }); RunS(sx, 2);
                    sx.FoundLine(new List<HiberSite> { new HiberSite { kind = "bark", x = sx.nest.x + 3, y = 1, z = sx.nest.z + 3, q = 0.5, n = 2 } }, 0, 1);
                    var t = sx.line[0]; t.colony.adults = 20;
                    sx.CS(t.nest.key).esc = 30;
                    var ev1 = RunS(sx, 120); var sched = ev1.FirstOrDefault(e => e.type == "sisterExtScheduled");
                    if (sched != null) { long m = (long)sched["arriveMinute"] + 1; sx.clockOffset += (m - sx.minute) * sx.tpm; sx.CS(t.nest.key).esc = 30; }
                    var evX = RunS(sx, 120);
                    Ok(sched != null && Count(evX, "sisterExterminated") == 1 && !t.colony.nestAlive, "the exterminator is called to a sister nest's neighbourhood and destroys the nest");
                    var sp = new Sim(new Settings { seed = 1234, birds = false }, new SimOpts { noAI = true }); RunS(sp, 2);
                    sp.FoundLine(new List<HiberSite> { new HiberSite { kind = "bark", x = sp.nest.x + 3, y = 1, z = sp.nest.z + 3, q = 0.5, n = 2 } }, 0, 1);
                    var pc = sp.line[0]; pc.colony.adults = 30; pc.colony.nestAlive = true;
                    sp.muni = new Muni { n = 1, active = new MuniCampaign { n = 1, keys = new List<string> { pc.nest.key }, until = sp.minute + 1440 }, cooldownUntil = 0 };
                    Num a0 = pc.colony.adults; for (int i = 0; i < 20; i++) sp.MuniAbstract();
                    Ok(pc.colony.adults < a0 && pc.colony.stats.poisoned > 0, $"pest control's bait poisons a sister colony in its area ({D(a0 - pc.colony.adults):0.00} adults)");
                }
                foreach (var x in s.line) x.colony.mated = 200;
                s.EndSeasonForTest("autumn");
                var sis = s.winter?.sites.Where(x => x.kind == "sister").ToList();
                Ok(sis != null && sis.Count >= 1 && s.line.Count == 0, $"the sister colonies' mated queens winter by their nests and are offered with yours ({string.Join(", ", sis?.Select(x => x.n) ?? new int[0])} queens)");
                var u = new Sim(new Settings { seed = 1234, birds = false }, new SimOpts { noAI = true });
                RunS(u, 2);
                u.FoundLine(new List<HiberSite> { new HiberSite { kind = "bark", x = u.nest.x + 3, y = 1, z = u.nest.z + 3, q = 0.5, n = 3 } }, 0, 2);
                u.line[0].colony.adults = 12; if (u.line.Count > 1) u.line[1].colony.adults = 30;
                var strong = u.line.OrderByDescending(x => D(x.colony.adults)).First();
                var r = Persist.Restore(Persist.Snapshot(u));
                Ok(r.line.Count == u.line.Count && r.line[0].nest.x == u.line[0].nest.x && r.line[0].colony.adults == u.line[0].colony.adults, "sister colonies survive save and restore");
                u.colony.queenAlive = false; u.colony.adults = 0; u.colony.eggs = u.colony.larvae = u.colony.pupae = 0;
                var ev2 = RunS(u, 120);
                Ok(Count(ev2, "sisterTakeover") == 1 && u.nest == strong.nest && u.colony == strong.colony && !u.line.Contains(strong) && !u.extinct, $"your colony gone, you go on in the strongest sister colony ({D(Floor(u.colony.adults))} adults)");
            }
            // 45. town centres and beer gardens (T2-5): a paved 2x2 block in every region, shops, a fountain, a packed beer garden
            {
                int towns = 0, regions = 0; bool apart = true;
                foreach (ulong seed in new ulong[] { 1234, 7 }) for (int rz = -2; rz <= 2; rz++) for (int rx = -2; rx <= 2; rx++)
                {
                    regions++;
                    var L = World.Region(seed, rx, rz); if (L.towns.Count != 1) continue;
                    var tw = L.towns[0]; var cs = new List<(int x, int z)>(); for (int dz = 0; dz < 2; dz++) for (int dx = 0; dx < 2; dx++) cs.Add((rx * 8 - 4 + tw.tx + dx, rz * 8 - 4 + tw.tz + dz));
                    if (cs.All(t => World.LandUse(seed, t.x, t.z) == "town" && World.TownQuarter(seed, t.x, t.z) != null)) towns++;
                    if (rx == 0 && rz == 0 && cs.Any(t => System.Math.Abs(t.x) <= 1 && System.Math.Abs(t.z) <= 1)) apart = false;
                }
                Ok(towns == regions && apart, $"every region has one 2x2 town centre ({towns} of {regions}); the home region's is never beside the nest");
                var HL = World.Region(1234, 0, 0).towns[0]; var q = new List<ChunkContent>();
                for (int dz = 0; dz < 2; dz++) for (int dx = 0; dx < 2; dx++) q.Add(World.GenerateChunk(1234, HL.tx - 4 + dx, HL.tz - 4 + dz));
                var garden = q.Where(c => c.gardens.Count > 0).ToList(); var g = garden[0]; var fountains = q.SelectMany(c => c.baths.Where(b => b.fountain)).ToList();
                int beers = g.cans.Count(k => k.color == 4), seated = g.humans.Count(h => h.posture == "sit");
                Ok(garden.Count == 1 && g.tables.Count == 6 && seated == 36 && beers == 18 && g.sugar.Count(k => k.kind == "can") >= 24,
                    $"one quarter is a beer garden: 6 full tables, {seated} drinkers, {beers} beers among {g.cans.Count} drinks");
                var late = new List<HumanWin>(); var seatedG = g.humans.Where(h => h.posture == "sit").ToList();
                for (int dd = 1; dd < 30; dd++) if (!World.Weather(1234, dd).rain) foreach (var h in seatedG) { var w0 = World.HumanWindow(1234, R.Hash(1234, Domain.WorldGen, R.U64(g.cx), R.U64(g.cz), R.U64(h.slot)), dd, 1, h.evening); if (w0 != null) late.Add(w0); }
                Ok(seatedG.All(h => h.evening) && late.Count > 100 && late.All(w0 => w0.arrive >= T.days.eveningFrom && w0.leave >= T.days.lateFrom) && !q.Any(c => c != g && c.humans.Any(h => h.evening)),
                    $"beer garden drinkers come from {D(T.days.eveningFrom) / 60}:00 and stay past {(int)(D(T.days.lateFrom) / 60)}:{D(T.days.lateFrom) % 60} ({late.Count} evenings out in 30 days); nobody else does");
                Ok(q.All(c => c.plazas.Count == 1 && c.shops.Count == 3 && c.boxes.Count(b => b.shop && !b.wood) == 3 && c.roads.Count == 0),
                    "every quarter is paved over, with three shops (solid, not wood) and no street through it");
                Ok(fountains.Count == 1 && !garden.Any(c => c.baths.Count > 0), "the block has one fountain, across from the beer garden");
                var s = new Sim(new Settings { seed = 1234, birds = false, dayMinutes = 20 }, new SimOpts { noAI = true }); var w = s.wasp; var f = fountains[0];
                RunS(s, 2);
                Place(w, P(f.x + 0.3, f.h + T.wasp.radius + 0.004, f.z)); w.state = "fly"; w.carry = null;
                RunS(s, 2);
                var sh = q[0].shops[0];
                Ok(s.hint.water && !s.hint.wood && s.InSolid(sh.x, sh.h / 2, sh.z) && !s.InSolid(sh.x + sh.hw + 0.5, 1, sh.z), "over the fountain the wasp can take water; inside a shop is solid");
                long rd = 1; while (!World.Weather(s.seed, rd).rain) rd++;
                var rec = s.records.Get(World.ChunkKey(q[0].cx, q[0].cz)); var ps = s.PuddlesIn(rec, rd); var pl = rec.content.plazas[0];
                Ok(ps.Count > 0 && ps.All(p => p.x >= pl.minx && p.x <= pl.maxx && p.z >= pl.minz && p.z <= pl.maxz && !rec.content.boxes.Any(b => p.x > b.minx && p.x < b.maxx && p.z > b.minz && p.z < b.maxz)),
                    $"after rain puddles lie on the square ({ps.Count}), never in a shop");
            }
            // 48. lock-on and assisted flight (GDD 7.9); feeding on a flower is not cut short
            {
                var s = new Sim(new Settings { seed = 1234, birds = false }, new SimOpts { noAI = true }); RunS(s, 1);
                var rec = s.records.Get("0,0"); var w = s.wasp; int fi = -1;
                for (int k = 0; k < rec.content.flowers.Count && fi < 0; k++) if (s.InBloom(rec, k) && s.NectarAt(rec, k) > 0) fi = k;
                var f = rec.content.flowers[fi];
                V3 AimAt(Num px, Num py, Num pz) { Num l = Sqrt(Sq(px - w.x) + Sq(py - w.y) + Sq(pz - w.z)); return new V3((px - w.x) / l, (py - w.y) / l, (pz - w.z) / l); }
                (string done, int ticks) Fly(LockTarget t, int n = 1500) { string done = null; int k = 0; for (; k < n && done == null; k++) { var r = Assist.Pilot(s, w, t, Idle()); done = r.done; s.Step(r.cmd); s.DrainEvents(); } return (done, k); }
                Place(w, P(f.x, f.y - 0.01, f.z)); w.state = "fly"; w.energy = 0.3;
                RunS(s, 30);
                Ok(w.state == "landed" && w.land.kind == "flower" && s.feeding, "landed anywhere on a flower head, even under it, the wasp feeds");
                Place(w, P(f.x, f.y, f.z)); w.state = "fly"; w.land = null; w.energy = 0.3;
                var sts = new HashSet<string>(); for (int i = 0; i < 30; i++) { s.Step(Idle()); s.DrainEvents(); sts.Add(w.state + (w.land != null ? w.land.kind : "")); }
                Ok(!sts.Contains("landedstalk") && !sts.Contains("landedground"), $"feeding at a flower it does not settle on the stalk or the grass ({string.Join(", ", sts)})");
                Place(w, P(f.x + 1.2, f.y + 0.6, f.z - 0.9)); w.state = "fly"; w.land = null; w.energy = 0.4;
                var tf = Assist.PickTarget(s, w, AimAt(f.x, f.y, f.z));
                Ok(tf != null && tf.kind == "flower" && tf.i == fi && Assist.Label(tf) == "flower", "locking on picks the flower under the aim");
                var up = Assist.PickTarget(s, w, new V3(0, 1, 0));
                Ok(up == null || new[] { "fly", "caterpillar", "bee", "bird", "dragonfly", "web", "wasp" }.Contains(up.kind), $"aiming at the sky it picks the nearest prey or danger ({(up == null ? "nothing near" : up.kind)})");
                var fl = Fly(tf);
                RunS(s, 30);
                Ok(fl.done == "landed" && w.land != null && w.land.kind == "flower" && s.feeding, $"assisted, it flies in and lands on the flower in {fl.ticks / 60.0:0.0} s and feeds");
                int fj = -1;
                for (int k = 0; k < rec.content.flowers.Count && fj < 0; k++) { var g0 = rec.content.flowers[k]; if (k != fi && s.InBloom(rec, k) && s.NectarAt(rec, k) > 0 && D(Sqrt(Sq(g0.x - f.x) + Sq(g0.z - f.z))) > 0.3) fj = k; }
                var g2 = rec.content.flowers[fj]; var fl2 = Fly(new LockTarget { kind = "flower", key = "0,0", i = fj });
                Ok(fl2.done == "landed" && w.land.kind == "flower" && D(Sqrt(Sq(w.x - g2.x) + Sq(w.z - g2.z))) < 0.04, $"standing on one flower, it takes off and lands on the next in {fl2.ticks / 60.0:0.0} s");
                var hm = s.active.First(h => h.state == "idle" && h.posture == "sit");
                Place(w, P(hm.x + 2, 1.2, hm.z + 1)); w.state = "fly"; w.land = null; w.energy = 1;
                var th = Assist.PickTarget(s, w, AimAt(hm.x, 1.0, hm.z));
                var hp = Assist.TargetPos(s, th).Value; var fh = Fly(th);
                Ok(th != null && th.kind == "human" && th.hex == hm.hex && fh.done == "perched" && w.state == "perched" && D(Sqrt(Sq(w.x - hp.x) + Sq(w.y - hp.y) + Sq(w.z - hp.z))) < 0.06,
                    $"aimed at a person it locks on to the {Assist.Label(th)}, and the pilot sets the wasp down on that spot in {fh.ticks / 60.0:0.0} s");
                w.state = "fly"; w.carry = null;
                LockTarget cat = null;
                foreach (var r in s.activeChunks) { for (int k = 0; k < r.content.caterpillars.Count; k++) if (s.CatActive(r, k) && !(s.CS(r.key).caughtCat.TryGetValue(k, out var cc) && cc != 0)) { cat = new LockTarget { kind = "caterpillar", key = r.key, i = k }; break; } if (cat != null) break; }
                if (cat != null)
                {
                    var cp = Assist.TargetPos(s, cat).Value; Place(w, P(cp.x + 0.8, cp.y + 0.5, cp.z)); w.state = "fly"; w.land = null; w.energy = 1;
                    var fc = Fly(cat);
                    Ok(fc.done == "caught" && w.carry != null && w.carry.what == "caterpillar", $"locked on a caterpillar, the pilot catches it ({fc.done} in {fc.ticks / 60.0:0.0} s)");
                }
                // the swoop: a short dash; whatever it reaches, it slams onto, and a lock makes it home and do what the target calls for
                void Reset(Num x, Num y, Num z) { Place(w, P(x, y, z)); w.state = "fly"; w.land = null; w.perch = null; w.carry = null; w.energy = 1; w.swoopReady = 0; }
                (string done, int ticks, List<SimEvent> ev) Swoop(LockTarget t, int n = 90) { var ev = new List<SimEvent>(); (Cmd cmd, string done) r = (null, null); int k = 0; for (; k < n; k++) { r = Assist.SwoopPilot(s, w, t, Idle(), k == 0); if (r.done != null) break; s.Step(r.cmd); ev.AddRange(s.DrainEvents()); } return (r.done, k, ev); }
                Reset(5, 2, 5);
                s.Step(Idle(c => { c.act = Act.Swoop; c.yawQ = 0; })); s.DrainEvents();
                Num vmax = 0, v59 = 0; Num ax0 = w.x, az0 = w.z;
                for (int i = 0; i < 60; i++) { s.Step(Idle(c => c.yawQ = 0)); s.DrainEvents(); Num v = Sqrt(w.vx * w.vx + w.vy * w.vy + w.vz * w.vz); vmax = Max(vmax, v); v59 = v; }
                Ok(vmax > 8 && v59 < T.wasp.cruise + 0.5 && w.state == "fly", $"with nothing locked the swoop is a short dash: {D(vmax):0.0} m/s at its peak, {D(Sqrt(Sq(w.x - ax0) + Sq(w.z - az0))):0.0} m in a second, back to cruising after");
                Reset(5, 2, 5); s.Step(Idle(c => { c.act = Act.Swoop; c.yawQ = 0; })); int firstUntil = w.swoopUntil; s.Step(Idle(c => c.yawQ = 0)); s.Step(Idle(c => { c.act = Act.Swoop; c.yawQ = 0; }));
                Ok(firstUntil > 0 && w.swoopUntil == firstUntil, "a second swoop waits for the first to recover");
                Reset(3, 0.05, 3); s.Step(Idle(c => { c.act = Act.Swoop; c.yawQ = 0; c.pitchQ = 0; })); RunS(s, 15, (sim, i) => Idle(c => c.yawQ = 0));
                Ok(w.state == "fly", "skimming the grass, the dash does not land on it: only a surface flown into is slammed onto");
                int g3 = -1; for (int k = 0; k < rec.content.flowers.Count && g3 < 0; k++) if (s.InBloom(rec, k) && s.NectarAt(rec, k) > 0) g3 = k;
                var f3 = rec.content.flowers[g3];
                Reset(f3.x + 1.0, f3.y + 0.5, f3.z - 0.6);
                var sf = Swoop(new LockTarget { kind = "flower", key = "0,0", i = g3 });
                Ok(sf.done == "landed" && w.land.kind == "flower" && sf.ticks < 30, $"locked on a flower, the swoop dives in and lands on it in {sf.ticks / 60.0:0.00} s: an escape from the air");
                var hm2 = s.active.First(h => h.state == "idle" && h.posture == "sit" && h.panic < 0.1);
                Reset(hm2.x + 1.5, 1.2, hm2.z + 1);
                var th2 = Assist.PickTarget(s, w, AimAt(hm2.x, 1.0, hm2.z)); Num pp0 = hm2.panic;
                var sh = Swoop(th2); sh.ev.AddRange(RunS(s, T.net.commitTicks + 2));
                Ok(sh.done == "perched" && w.state == "perched" && hm2.panic > pp0 + 0.05 && sh.ev.Any(e => e.type == "notice" && (string)e["humanHex"] == hm2.hex),
                    $"locked on a person, the swoop slams onto them: they feel it at once and it frightens them (panic {D(pp0):0.00} -> {D(hm2.panic):0.00})");
                LockTarget cat2 = null;
                foreach (var r in s.activeChunks) { for (int k = 0; k < r.content.caterpillars.Count; k++) if (s.CatActive(r, k) && !(s.CS(r.key).caughtCat.TryGetValue(k, out var cc2) && cc2 != 0)) { cat2 = new LockTarget { kind = "caterpillar", key = r.key, i = k }; break; } if (cat2 != null) break; }
                if (cat2 != null)
                {
                    var cp2 = Assist.TargetPos(s, cat2).Value; Reset(cp2.x + 0.9, cp2.y + 0.4, cp2.z);
                    var sc = Swoop(cat2);
                    Ok(sc.done == "caught" || (w.carry != null && w.carry.what == "caterpillar"), $"locked on a caterpillar, the swoop snatches it ({sc.done} in {sc.ticks / 60.0:0.00} s)");
                }
                LockTarget web = null; V3 wp0 = default;
                foreach (var r in s.activeChunks) { for (int k = 0; k < r.content.webs.Count; k++) if (r.content.webs[k].y > 0.8) { web = new LockTarget { kind = "web", key = r.key, i = k }; wp0 = new V3(r.content.webs[k].x, r.content.webs[k].y, r.content.webs[k].z); break; } if (web != null) break; }
                if (web != null)
                {
                    Reset(wp0.x + 0.8, wp0.y + 0.3, wp0.z); Num dw0 = Sqrt(Sq(w.x - wp0.x) + Sq(w.z - wp0.z));
                    Swoop(web); Num dw1 = Sqrt(Sq(w.x - wp0.x) + Sq(w.z - wp0.z));
                    Ok(dw1 > dw0 + 1, $"locked on a danger, the swoop dashes away from it ({D(dw0):0.0} -> {D(dw1):0.0} m from a web)");
                }
            }
            // 47. terrain (T2-6): a height field the sim works above; hills block sight, gather puddles, catch the wind
            {
                var S1 = new Settings { terrain = 1 }; var S2 = new Settings { terrain = 2 };
                Num G1(Num x, Num z) => World.GroundAt(1234, x, z, S1); Num G2(Num x, Num z) => World.GroundAt(1234, x, z, S2);
                bool flat = true, home = true, lin = true; Num hi = Num.MinValue, lo = Num.MaxValue;
                for (int j = -40; j <= 40; j++) for (int i = -40; i <= 40; i++)
                {
                    Num x = i * (Num)3.7, z = j * (Num)4.1, a = G1(x, z);
                    if (World.GroundAt(1234, x, z, new Settings()) != 0) flat = false;
                    if (Sqrt(x * x + z * z) <= T.terrain.flatR && a != 0) home = false;
                    if (D(Abs(G2(x, z) - 2 * a)) > 1e-6) lin = false;
                    hi = Max(hi, a); lo = Min(lo, a);
                }
                Ok(flat && home && lin && hi - lo > 2 && hi - lo < 9, $"the ground rolls {D(hi - lo):0.0} m over 300 m on a rolling world, twice that on a hilly one; a flat world and the home tree's ground stay level");
                Num Slope(Num cx, Num cz) { Num m = 0; for (int j = -5; j <= 5; j++) for (int i = -5; i <= 5; i++) { Num x = cx + i * 4, z = cz + j * 4; m = Max(m, Max(Abs(G2(x + 2, z) - G2(x - 2, z)) / 4, Abs(G2(x, z + 2) - G2(x, z - 2)) / 4)); } return m; }
                var TL = World.Region(1234, 1, 0).towns[0]; Num tcx = (8 - 4 + TL.tx + (Num)0.5) * 64, tcz = (TL.tz - 4 + (Num)0.5) * 64;
                int pkx = 0, pkz = 0; bool fpk = false;
                for (int x = 4; x < 12 && !fpk; x++) for (int z = -4; z < 4 && !fpk; z++) if (World.LandUse(1234, x, z) == "park" && World.LandUse(1234, x + 1, z) == "park") { pkx = x; pkz = z; fpk = true; }
                Ok(Slope(tcx, tcz) < Slope(pkx * 64 + 32, pkz * 64) / 3, $"a town square is near level (slope {D(Slope(tcx, tcz)):0.000}) where a park rolls ({D(Slope(pkx * 64 + 32, pkz * 64)):0.000})");
                var sh = new Sim(new Settings { seed = 1234, birds = false, terrain = 2 }, new SimOpts { noAI = true }); var sf = new Sim(new Settings { seed = 1234, birds = false }, new SimOpts { noAI = true });
                int blocked = 0, pairs = 0;
                for (int j = 0; j < 12; j++) for (int i = 0; i < 12; i++)
                {
                    Num ax = pkx * 64 - 30 + i * 5, az = pkz * 64 - 30 + j * 5, bx = ax + 45, bz = az + 7;
                    if (!sf.CanSee(ax, az, bx, bz)) continue;
                    pairs++; if (!sh.CanSee(ax, az, bx, bz)) blocked++;
                }
                Ok(blocked > 0 && blocked < pairs, $"a rise between two people hides them from each other ({blocked} of {pairs} open sight lines on a flat world are blocked on a hilly one)");
                long rd = 1; while (!World.Weather(1234, rd).rain || World.Weather(1234, rd).pour > 1) rd++;
                var ph = sh.PuddlesIn(sh.PlausRec(pkx, pkz), rd); var pf = sf.PuddlesIn(sf.PlausRec(pkx, pkz), rd);
                Num Mean(List<WaterSrc> ps) { Num m = 0; foreach (var p in ps) m += sh.Ground(p.x, p.z); return m / ps.Count; }
                Ok(ph.Count > 0 && pf.Count > 0 && Mean(ph) < Mean(pf), $"puddles gather in hollows ({D(Mean(ph)):0.00} m against {D(Mean(pf)):0.00} m where they would lie on flat ground)");
                (Num x, Num z, Num g) top = (0, 0, Num.MinValue), bottom = (0, 0, Num.MaxValue);
                for (int j = 0; j < 40; j++) for (int i = 0; i < 40; i++) { Num x = pkx * 64 - 30 + i * (Num)1.5, z = pkz * 64 - 30 + j * (Num)1.5, g = sh.Ground(x, z); if (g > top.g) top = (x, z, g); if (g < bottom.g) bottom = (x, z, g); }
                Num Wd(Sim s0, Num x, Num z) { var w = s0.wasp; Num ox = w.x, oy = w.y, oz = w.z; w.x = x; w.y = 1; w.z = z; var d = s0.Drift(w); w.x = ox; w.y = oy; w.z = oz; return Sqrt(d.x * d.x + d.z * d.z); }
                Ok(top.g > 0 && Wd(sh, top.x, top.z) > Wd(sh, bottom.x, bottom.z) && Wd(sf, top.x, top.z) == Wd(sf, bottom.x, bottom.z), $"the wind is stronger on a rise ({D(Wd(sh, top.x, top.z)):0.000} against {D(Wd(sh, bottom.x, bottom.z)):0.000} m/s at the foot of it)");
                var rs = Persist.Restore(Persist.Snapshot(sh));
                Ok(rs.settings.terrain == 2 && new Settings { terrain = 2 }.WorldTag() == "hilly" && new Settings { terrain = 1 }.WorldTag() == "rolling" && new Settings { terrain = 1 }.RulesHash() != new Settings().RulesHash(),
                    "terrain is a world setting: kept in saves, in the world tag and in the rules peers compare");
            }
            // 46. feature modifiers (T2-6): woods, towns, water and hives set at world creation act on generation
            {
                (int forest, int town, int baths, int hives, bool apart) Census(Settings st)
                {
                    int forest = 0, town = 0, baths = 0, hives = 0; bool apart = true;
                    for (int rz = -1; rz <= 1; rz++) for (int rx = -1; rx <= 1; rx++)
                    {
                        var L = World.Region(1234, rx, rz, st);
                        if (L.towns.Count == 2) { var a = L.towns[0]; var b = L.towns[1]; if (!(b.tx > a.tx + 2 || b.tx + 1 < a.tx - 1 || b.tz > a.tz + 2 || b.tz + 1 < a.tz - 1)) apart = false; }
                        for (int lz = 0; lz < 8; lz++) for (int lx = 0; lx < 8; lx++)
                        {
                            int cx = rx * 8 - 4 + lx, cz = rz * 8 - 4 + lz; string u = World.LandUse(1234, cx, cz, st);
                            if (u == "forest") forest++; if (u == "town") town++;
                            if (rx == 0 && rz == 0) { var c = World.GenerateChunk(1234, cx, cz, st); baths += c.baths.Count(b => !b.fountain); hives += c.hives.Count; }
                        }
                    }
                    return (forest, town, baths, hives, apart);
                }
                var cb = Census(null); var cd = Census(new Settings { woods = 1, towns = 1, water = 1, hives = 1 });
                var wild = Census(new Settings { woods = 2, towns = 0, water = 2, hives = 2 }); var tame = Census(new Settings { woods = 0, towns = 2, water = 0.5, hives = 0 });
                Ok(cb == cd && World.GenerateChunk(1234, 3, 2).flowers.Count == World.GenerateChunk(1234, 3, 2, new Settings()).flowers.Count, "the default modifiers generate exactly the standard world");
                Ok(cb.forest >= 34 && wild.forest > cb.forest * 3 && tame.forest == 0, $"woods: {tame.forest} / {cb.forest} / {wild.forest} forest chunks in 9 regions (none, normal, wooded)");
                Ok(cb.town == 36 && wild.town == 0 && tame.town == 72 && tame.apart, $"towns: {wild.town} / {cb.town} / {tame.town} town chunks (none, one, two a region, never touching)");
                Ok(tame.baths < cb.baths && wild.baths > cb.baths * 1.3, $"water: {tame.baths} / {cb.baths} / {wild.baths} birdbaths in the home region (dry, normal, wet)");
                Ok(tame.hives == 0 && wild.hives > cb.hives, $"hives: {tame.hives} / {cb.hives} / {wild.hives} beehives in the home region (none, normal, x2)");
                var s = new Sim(new Settings { seed = 1234, birds = false, woods = 0, towns = 2, water = 0.5, hives = 0 }, new SimOpts { noAI = true });
                RunS(s, 2);
                var r = Persist.Restore(Persist.Snapshot(s));
                Ok(s.records.Values.All(c => c.content.use != "forest" && c.content.hives.Count == 0) && r.settings.towns == 2 && r.settings.RulesHash() == s.settings.RulesHash(),
                    $"a world made with modifiers is generated by them and keeps them through a save ({s.records.Count} chunks)");
                var tag = new Settings { woods = 2, towns = 0, water = 0.5, hives = 2 }.WorldTag();
                Ok(new Settings { water = 2 }.RulesHash() != new Settings().RulesHash() && tag == "wooded · no towns · dry · hives ×2", $"peers with different modifiers do not match rules; the tag reads \"{tag}\"");
                long rd = 1; while (!World.Weather(s.seed, rd).rain || World.Weather(s.seed, rd).pour > 1) rd++;
                var wet = new Sim(new Settings { seed = 1234, birds = false }, new SimOpts { noAI = true }); RunS(wet, 2);
                int dryN = s.PuddlesIn(s.records.Get("0,1"), rd).Count, wetN = wet.PuddlesIn(wet.records.Get("0,1"), rd).Count;
                Ok(dryN <= T.water.puddles / 2 && wetN > dryN, $"a dry world leaves fewer puddles ({dryN} vs {wetN})");
            }
        }

        // 26. Tier 1, batch 1: wind, cold, drowning, clothes by the weather, shaking and flailing
        static void Batch1()
        {
            ulong seed = 1; DayWeather day0 = null;
            for (; seed < 200; seed++) { var w = World.Weather(seed, 0); if (!w.rain && w.wind > 2.2) { day0 = w; break; } }
            double At(long m) { var v = World.WindAt(seed, m); return Hypot(v.x, v.z); }
            Ok(day0 != null && At(15 * 60) > At(7 * 60) * 1.5, $"wind is calm at dawn and stronger mid-afternoon ({At(7 * 60):0.00} -> {At(15 * 60):0.00} m/s)");
            // with no input the wasp leans into the wind and holds its place, paying for it; flat out it is faster downwind
            (double along, double off, double used, double wind) Fly(Num y, int mz, int sign, bool calm)
            {
                var s = new Sim(new Settings { seed = seed, birds = false });
                RunS(s, 1);
                if (calm) s.windOverride = new V3(0, 0, 0);
                var p0 = P(40, y, 40); var w = s.wasp; Place(w, p0); w.energy = 1;
                var v = World.WindAt(seed, s.minute); double n = Hypot(v.x, v.z), yaw = Math.Atan2(sign * D(v.x), sign * D(v.z));
                RunS(s, 180, (sim, i) => Idle(c => { c.mz = mz; c.yawQ = (int)Math.Round(yaw * 1e4); c.pitchQ = 0; }));
                return ((D(w.x - p0.x) * D(v.x) + D(w.z - p0.z) * D(v.z)) / n, Hypot(w.x - p0.x, w.z - p0.z), 1 - D(w.energy), n);
            }
            var hold = Fly(3, 0, 1, false); var calmF = Fly(3, 0, 1, true); var down = Fly(3, 100, 1, false); var up = Fly(3, 100, -1, false);
            Ok(hold.off < 0.1, $"hovering in a {hold.wind:0.0} m/s wind the wasp holds its place ({hold.off * 100:0.0} cm off in 3 s)");
            Ok(hold.used > calmF.used * 1.2, $"holding against the wind costs like flying ({hold.used * 1000:0.00} vs {calmF.used * 1000:0.00})");
            Ok(down.along / 3 > D(T.wasp.cruise) * 0.9 && -up.along / 3 < D(T.wasp.cruise) * 0.9, $"flat out it covers {down.along / 3:0.00} m/s downwind and {-up.along / 3:0.00} m/s upwind");

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

            (bool fell, List<SimEvent> ev) IntoCan(bool mash, bool space = false)
            {
                var t = Calm(new Sim(new Settings { seed = 1234, birds = false })); // nobody at the table swats or covers the cup
                var cup = t.CupsIn(t.records.Get("0,0"))[0];
                bool fell = false;
                var e2 = RunS(t, 9000, (sim, i) =>
                {
                    var w = sim.Driven();
                    if (w == null) return Idle();
                    if (w.state == "drowning") { fell = true; return Idle(c => { if (space) c.my = mash ? (i % 2) * 100 : 0; else c.burst = mash ? i % 2 : 0; }); }
                    if (!fell && (w.state == "fly" || w.state == "landed")) { Place(w, P(cup.x, cup.level + 0.015, cup.z)); w.energy = 0.3; }
                    return Idle();
                });
                return (fell, e2);
            }
            var a = IntoCan(false); var b = IntoCan(true);
            var drowned = a.ev.FirstOrDefault(e => e.type == "waspDied" && (bool)e["driven"]);
            Ok(a.fell && Cause(drowned) == "drowned in a drink", $"a wasp feeding at an open can slips in and drowns ({Cause(drowned)})");
            var spc = IntoCan(true, true);
            Ok(spc.fell && Count(spc.ev, "climbedOut") >= 1, "mashing Space climbs out too");
            int outAt = b.ev.FindIndex(e => e.type == "climbedOut"); int back = outAt < 0 ? 0 : b.ev.Skip(outAt).Count(e => e.type == "fellIn");
            Ok(b.fell && outAt >= 0 && back == 0, $"mashing burst climbs out of the drink, over the side, and it does not fall back in ({back} times)");
            // cups are hollow (GDD 7.5)
            {
                var t = Calm(new Sim(new Settings { seed = 1234, birds = false }));
                var rec = t.records.Get("0,0"); var cup = t.CupsIn(rec)[0]; var w = t.wasp;
                Ok(cup.level > T.cup.@base && cup.level < T.cup.rim, $"a cup holds its drink below the rim (level {D(cup.level - T.cup.@base) * 100:0.0} cm of {D(T.cup.rim - T.cup.@base) * 100:0})");
                Place(w, P(cup.x - 0.08, (T.cup.@base + T.cup.rim) / 2, cup.z)); w.vx = 1;
                RunS(t, 20);
                Ok(w.x < cup.x - T.cup.r, "from the side the wall keeps it out");
                w.energy = 0.3;
                RunS(t, 40, (sim, i) => { if (w.state == "fly") Place(w, P(cup.x, cup.level + 0.015, cup.z)); return Idle(); });
                Ok(w.energy > 0.3 && t.InCup(w.P) != null, $"inside the cup it feeds at the drink (crop {D(w.energy):0.00})");
                var wallP = P(cup.x - (T.cup.r - T.cup.wall - T.wasp.radius - 0.004), cup.level + 0.03, cup.z);
                Place(w, wallP);
                RunS(t, 40, (sim, i) => { if (w.state == "fly") Place(w, wallP); return Idle(c => c.yawQ = 0); });
                Ok(w.state == "landed" && w.land.kind == "cup" && w.land.nx > 0.99, $"it grips the inside of the cup ({w.state}, {w.land?.kind})");
                int quarter = (int)Math.Round(Math.PI / 2 * 1e4);
                var evd = RunS(t, 120, (sim, i) => Idle(c => { c.yawQ = quarter; c.mz = w.state == "landed" ? 100 : 0; })); // a quarter turn on the wall faces down
                Ok(Count(evd, "fellIn") == 1 && (w.state == "drowning" || w.state == "dead"), $"walking down into the drink it falls in ({w.state})");
                var t2 = Calm(new Sim(new Settings { seed = 1234, birds = false })); var w2 = t2.wasp; var cup2 = t2.CupsIn(t2.records.Get("0,0"))[0];
                t2.CS("0,0").esc = 10;
                Place(w2, P(cup2.x, T.cup.rim + 0.05, cup2.z)); w2.vy = -1;
                RunS(t2, 30, (sim, i) => { w2.x = cup2.x; w2.z = cup2.z; return Idle(c => c.my = -100); });
                Ok(w2.y >= T.cup.rim && t2.InCup(w2.P) == null, $"a lidded cup keeps it out ({D(w2.y - T.cup.rim) * 1000:0} mm above the rim)");
            }
            {
                var t = new Sim(new Settings { seed = 1234, birds = false }); var rec = t.records.Get("0,0"); var w = t.wasp;
                RunS(t, 3);
                var cup = t.CupsIn(rec).FirstOrDefault(cp => t.active.Any(h => h.state == "idle" && h.tr.style != Style.Freezer && Hypot(h.x - cp.x, h.z - cp.z) < D(T.cup.noticeDist) * 0.8));
                Ok(cup != null, "a cup within reach of someone at the table");
                var evc = RunS(t, 900, (sim, i) => { if (w.state == "fly") Place(w, P(cup.x, cup.level + 0.015, cup.z)); return Idle(); });
                var died = evc.FirstOrDefault(e => e.type == "waspDied" && (bool)e["driven"]);
                Ok(Count(evc, "cover") >= 1 && Count(evc, "coveredIn") == 1 && Cause(died) == "drowned under a lid", $"someone covers the cup and the wasp inside drowns ({Cause(died)})");
            }

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
            // hollows the bees hold are not nest sites (T1-9); the test takes a free one
            bool BeesIn(V3 p) => t.activeChunks.Any(r => t.HivesIn(r).Any(hv => hv.feral && Hypot(hv.ex - p.x, hv.ez - p.z) < 0.1));
            var hol = t.activeChunks.SelectMany(r => t.SitesIn(r).hollows).Where(x => !BeesIn(x.p)).ToList();
            Ok(hol.Count >= 2 && hol.All(x => x.t.r >= T.sites.hollowMinR && x.p.y > 0.6 && x.p.y < x.t.h), $"some thick trees have a hollow in the trunk ({hol.Count} near home)");
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
            s.colony.cool = 0; // a nest with no water to cool it (T2-1)
            Ok(hot > 0 && At("attic", hot) < At("wall", hot), $"a sunny afternoon bakes a dry attic nest ({D(At("attic", hot)):0.00} vs {D(At("wall", hot)):0.00})");
            s.colony.cool = 1;
            Ok(At("attic", hot) == 1, "with water fanned over the comb the same attic keeps the brood at full speed");
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
            Ok(Count(ev, "takeoff") == 0 && w4.state == "landed" && w4.land.ny < -0.99 && w4.y < table.miny, $"walking over the edge of the table it crawls round, down the side and onto the underside ({w4.state}, normal y {D(w4.land.ny):0.00})");
            {
                Num h0x = w4.land.hx, h0y = w4.land.hy, h0z = w4.land.hz;
                RunS(s4, 2, (sim, i) => Idle(c => c.yawQ = (int)Math.Round(Math.PI / 2 * 1e4)));
                var L = w4.land; Num dot = h0x * L.hx + h0y * L.hy + h0z * L.hz;
                Ok(Abs(dot) < 1e-4 && Abs(L.hy) < 1e-6, $"upside down, a quarter turn of the mouse turns the heading a quarter turn about the surface (dot {D(dot):0.000000})");
                RunS(s4, 2, (sim, i) => Idle(c => c.yawQ = 0));
            }
            ev = RunS(s4, 30, (sim, i) => Idle(c => { c.my = -100; c.sting = i == 3 ? 1 : 0; }));
            Ok(w4.state == "landed" && Count(ev, "takeoff") == 0, "holding down or stinging the air keeps it on the surface");
            ev = RunS(s4, 2, (sim, i) => Idle(c => c.my = i == 0 ? 100 : 0));
            Ok(Count(ev, "takeoff") == 1 && w4.state == "fly", "Space takes off");
            Place(w4, P((table.minx + table.maxx) / 2, table.miny - T.wasp.radius - 0.005, (table.minz + table.maxz) / 2 + 0.1));
            RunS(s4, 120);
            Ok(w4.state == "landed" && Abs(w4.land.ny + 1) < 1e-6 && Abs(w4.y - (table.miny - T.wasp.radius)) < 1e-6, $"hovering under the table it lands upside down on the underside ({w4.state}, normal y {(w4.land == null ? 0 : D(w4.land.ny))})");
            ev = RunS(s4, 2, (sim, i) => Idle(c => c.burst = i == 0 ? 1 : 0));
            Ok(Count(ev, "takeoff") == 1 && w4.state == "fly" && w4.y < table.miny - T.wasp.radius, "Shift takes off, pushing away from the underside");
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
            int east = (int)Math.Round(Math.PI / 2 * 1e4);
            RunS(s4, 900, (sim, i) => Idle(c => { c.yawQ = east; c.mz = 100; }));
            Ok(w4.state == "landed" && w4.land.kind == "bark" && w4.y > 0.1 && Math.Abs(Hypot(w4.x - tree.x, w4.z - tree.z) - D(tree.r + T.wasp.radius)) < 1e-6,
                $"walking into a trunk climbs it ({w4.land?.kind}, {D(w4.y) * 100:0.0} cm up)");
            RunS(s4, 2, (sim, i) => Idle(c => c.my = i == 0 ? 100 : 0));
            Func<Sim, int, Cmd> Hold(V3 hp) => (sim, i) => { if (w4.state == "fly") Place(w4, hp); return Idle(); };
            RunS(s4, 60, Hold(P(tree.x - tree.r - T.wasp.radius - 0.006, 1.2, tree.z)));
            Ok(w4.state == "landed" && w4.land.kind == "bark" && Abs(w4.land.ny) < 1e-9, "hovering beside a trunk it lands on the bark");
            var fl = s4.activeChunks.SelectMany(r => r.content.flowers).First(f => f.y > 0.35);
            RunS(s4, 2, (sim, i) => Idle(c => c.my = i == 0 ? 100 : 0));
            RunS(s4, 60, Hold(P(fl.x + T.land.stalkR + T.wasp.radius + 0.004, fl.y * 0.5, fl.z)));
            Ok(w4.state == "landed" && w4.land.kind == "stalk", $"beside a flower stalk it grips the stalk ({w4.land?.kind})");
            {
                var s6 = new Sim(new Settings { seed = 1234 }); var b6 = s6.records.Get("0,0").content.boxes[1]; var w6 = s6.wasp;
                V3? spot = null;
                foreach (var hm in s6.active)
                {
                    if (hm.posture != "sit" || spot != null) continue;
                    for (Num dx = -0.6; dx <= 0.6 && spot == null; dx += 0.004)
                    {
                        var p = P(hm.x + dx, b6.maxy + T.wasp.radius, (b6.minz + b6.maxz) / 2);
                        if (p.x < b6.minx || p.x > b6.maxx) continue;
                        Place(w6, p);
                        s6.ContactQuery(w6); bool near = w6.contact != null;
                        s6.ContactQuery(w6, T.land.stingReach); bool reach = w6.contact != null;
                        w6.contact = null;
                        if (!near && reach) spot = p;
                    }
                }
                Ok(spot != null, "a spot on the bench a few centimetres from someone's leg");
                Place(w6, spot.Value);
                RunS(s6, 60);
                string landed = w6.state;
                var ev6 = RunS(s6, 3, (sim, i) => Idle(c => c.sting = i == 1 ? 1 : 0));
                Ok(landed == "landed" && (w6.state == "attached" || Count(ev6, "blocked") == 1), $"landed on the bench, a sting reaches them ({landed} -> {w6.state})");
            }
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
                    // a shed whose wall crack is free (some hold wild bees, T1-9)
                    foreach (var rec in t.activeChunks) { int si = rec.content.sheds.FindIndex(x => !t.FeralWall(rec, rec.content.sheds.IndexOf(x))); if (si >= 0 && sh == null) { shedSeed = seed; sh = rec.content.sheds[si]; } }
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
