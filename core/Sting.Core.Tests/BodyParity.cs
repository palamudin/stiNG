using System.Collections.Generic;
using Sting.Core;
using static Sting.Core.R;

namespace Sting.Core.Tests
{
    static partial class Program
    {
        static void BodyParity()
        {
            foreach (var seed in Seeds)
            {
                var d = new Digest();
                for (int i = 0; i < 120; i++)
                {
                    ulong id = Hash(seed, Domain.WorldGen, U64(i - 60), 7, 1000 + (ulong)i);
                    var tr = Body.HumanTraits(seed, id);
                    foreach (var v in new[] { tr.height, tr.armRatio, tr.flexibility, tr.girth, tr.ageStiffness, tr.reactionTicks, tr.style, tr.accuracy, tr.panicSusceptibility, tr.sociability, tr.escalation }) d.F(v);
                    var off = Body.HumanClothing(seed, id, 1); off.topOff = true;
                    var cls = new[] { Body.HumanClothing(seed, id, 0), Body.HumanClothing(seed, id, 3), Body.SuitClothing(i % 2 == 0), off };
                    foreach (var c in cls) { d.F(c.top); d.F(c.bottom); d.F(c.stiffness); for (int z = 0; z < 17; z++) { d.F(Body.ZoneCover(c, z)); d.F(Body.SelfReach(Body.ZONES[z], tr, c.stiffness)); d.F(Body.PredictedKind(z, tr, c)); } }
                    foreach (var posture in new[] { "stand", "sit" })
                    {
                        var parts = Body.BodyParts(tr, posture);
                        foreach (var p in parts) { d.S(p.name); d.F(p.a.x); d.F(p.a.y); d.F(p.a.z); d.F(p.b.x); d.F(p.b.y); d.F(p.b.z); d.F(p.r); d.F(p.side); }
                        var hm = new Frame(3 + i * 0.1, -2 + i * 0.05, DSin(i), DSin(i + 1.5707963267948966));
                        for (int k = 0; k < 24; k++)
                        {
                            var wp = new V3(hm.x + DSin(k * 1.7) * 0.4, 0.2 + (k % 8) * 0.22, hm.z + DSin(k * 2.3 + 1) * 0.4);
                            var lp = Body.ToLocal(hm, wp); var back = Body.ToWorld(hm, lp); d.F(lp.x); d.F(lp.y); d.F(lp.z); d.F(back.x); d.F(back.z);
                            foreach (var part in parts)
                            {
                                var q = Body.SegClosest(part.a, part.b, lp);
                                Num nx = lp.x - q.x, ny = lp.y - q.y, nz = lp.z - q.z, nl = Sqrt(nx * nx + ny * ny + nz * nz); if (nl == 0) nl = 1;
                                d.F(q.t); d.F(q.x); d.F(q.y); d.F(q.z);
                                d.F(Body.Classify(part, q, new V3(nx / nl, ny / nl, nz / nl), lp, tr.height / 1.75));
                            }
                        }
                        foreach (var c in cls)
                        {
                            var g = Body.GarmentGraph(tr, c, posture, parts);
                            d.F(g.Count);
                            foreach (var n in g) { d.S(n.key); d.F(n.zone); d.F(n.opening); d.F(n.n.x); d.F(n.n.y); d.F(n.n.z); d.F(n.pos.x); d.F(n.pos.y); d.F(n.pos.z); d.F(n.links.Count); foreach (var l in n.links) d.F(l); }
                        }
                    }
                    var comp = new List<Companion> { new Companion { id = id ^ 5, distance = 0.5 + (i % 4), style = i % 5, reactionTicks = 11 + (i % 30) }, new Companion { id = id ^ 9, distance = 1.2, style = (i + 2) % 5, reactionTicks = 20 } };
                    for (int z = 0; z < 17; z++) foreach (var mode in new[] { "jab", "full", "touch" }) foreach (var under in new[] { false, true })
                            {
                                var plan = Body.ResolveSting(new StingIn { contactTick = 1000 + i, mode = mode, under = under, contactPointBody = new V3(0.01 * z, 1.1, -0.1) }, tr, Body.ZONES[z],
                                    new StingCtx { clothingStiffness = (i % 3) * 0.15, panic = (i % 7) * 0.1, stung = i % 6, panicMul = i % 4 == 0 ? 0 : 1.3, companions = i % 2 != 0 ? comp : null });
                                d.F(plan.panicGain); d.F(plan.flee); d.F(plan.swats.Count);
                                foreach (var sw in plan.swats) { d.F(sw.kind); d.F(sw.start); d.F(sw.window); d.F(sw.radius); d.F(sw.kills); d.F(sw.reach); d.F(sw.center.x); }
                            }
                }
                Out($"bodies.{seed}", d.Hex);
            }
        }
    }
}
