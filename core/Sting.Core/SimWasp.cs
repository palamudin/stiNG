// One wasp per tick: flight, collision, contact, stinging, interactions, under clothing, swats, death and the yearly cycle.
using System.Collections.Generic;
using static Sting.Core.R;
using static Sting.Core.World;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed partial class Sim
    {
        /// A worker's span is that of her sisters (GDD 7.5): 1/adultMortality days, scaled to the season, ±20% by hash.
        public Num LifespanMinutes(Wasp w) => (1 / T.colony.adultMortality) * bio * 1440 * (0.8 + 0.4 * H32(w.id, 7));

        static bool Free3(string s) => s == "fly" || s == "landed" || s == "chewing";

        void StepWasp(Wasp w, Cmd cmd, int edge, bool driven)
        {
            if (driven && w.caste != "queen" && w.colony == "own" && minute - w.born > LifespanMinutes(w) && (w.state == "fly" || w.state == "landed"))
            {
                Die(w, "old age", null);
                return;
            }
            bool armed = driven ? cmd.sting != 0 && !pressUsed : cmd.sting != 0;
            switch (w.state)
            {
                case "fly":
                case "stunned":
                    Flight(w, cmd);
                    if (w.state == "stunned" && --w.stateTicks <= 0) { w.state = "fly"; Emit("recovered", ("id", w.id)); }
                    if (w.state != "fly") break;
                    if (driven || w.ai.mode == "attack") ContactQuery(w); else w.contact = null;
                    Feed(w, driven);
                    if (w.state != "fly") break;
                    NestTouch(w);
                    if (driven)
                    {
                        if ((edge & Act.Interact) != 0) Interact(w);
                        if (w.state == "fly" && armed && w.contact != null) { pressUsed = true; BeginSting(w, w.contact, "jab"); }
                        if (w.state == "fly") MaybeLand(w, cmd);
                        Hints(w);
                    }
                    else if (armed && w.contact != null && w.contact.humanHex == w.ai.humanHex) BeginSting(w, w.contact, "jab");
                    break;
                case "landed":
                    // Walk on the surface with the move keys, at any angle; only climb (Space) or burst (Shift) take off (GDD 7.2)
                    if (!driven || cmd.my > 0 || cmd.burst != 0) { Takeoff(w); break; }
                    if (armed)
                    {
                        // a sting reaches a person close by: a leg next to the bench, an arm on the table
                        pressUsed = true;
                        ContactQuery(w, T.land.stingReach);
                        var sc = w.contact;
                        w.contact = null;
                        if (sc != null && BeginSting(w, sc, "jab")) { w.land = null; w.walking = false; break; }
                    }
                    if ((edge & Act.Interact) != 0) { Interact(w); if (w.state != "landed") break; }
                    NestTouch(w); // landed at the entrance: in with the load
                    w.walking = false;
                    if (cmd.mx != 0 || cmd.mz != 0) Walk(w, cmd);
                    if (w.state != "landed") break;
                    Feed(w, driven);
                    if (w.state != "landed") break;
                    Hints(w);
                    break;
                case "webbed": WebStep(w, cmd, driven); break;
                case "drowning": DrownStep(w, cmd, driven); break;
                case "perched": PerchStep(w, cmd, edge, armed, driven); break;
                case "fighting": if (driven && cmd.sting != 0 && !pressUsed) { pressUsed = true; w.fight.mash += T.rival.mash; } break;
                case "attached": Attached(w, cmd, driven); break;
                case "under": UnderStep(w, cmd, edge, armed); break;
                case "chewing": ChewStep(w, cmd, driven); break;
                case "trapped":
                    if (--w.stateTicks <= 0) Die(w, "drowned in a trap", null);
                    break;
                case "balled":
                    if (driven) { BallEscape(w, cmd.burst != 0 && w.ball.prevBurst == 0); if (w.ball != null) w.ball.prevBurst = cmd.burst; }
                    break;
            }
            if (WaspById(w.id) != null)
            {
                w.venom = Min(w.caste == "queen" ? T.queen.venomMul : 1, w.venom + T.venom.regenPerSec * T.DT);
                BodyHeat(w);
            }
        }

        /// Body temperature (GDD 7.1, T1-2): flight muscles heat a flying wasp, a resting one shivers to stay ready
        /// (burning sugar), human skin and a bee ball set it outright. Below the flight temperature a wasp cannot take
        /// off; in cold torpor it dies unless it finds warmth.
        void BodyHeat(Wasp w)
        {
            Num air = Temperature, target;
            bool flying = (w.state == "fly" || w.state == "stunned") && w.energy > 0 && w.bodyT >= T.cold.flyBody;
            switch (flying ? "flying" : w.state)
            {
                case "flying": target = air + T.cold.flightHeat; break;
                case "attached": case "perched": case "under": target = T.cold.skinTemp; break;
                case "balled": target = w.ball != null ? w.ball.temp : air; break;
                default:
                {
                    // shivering warms a resting wasp, but not in real cold
                    bool shiver = w.energy > 0 && w.bodyT < T.cold.flyBody + 2 && air >= T.cold.shiverMinAir;
                    if (shiver) w.energy = Max(0, w.energy - T.energy.cruisePerSec * T.DT * T.energy.hoverShare * T.cold.shiverCost);
                    target = air + (shiver ? T.cold.shiverHeat : 0);
                    break;
                }
            }
            w.bodyT += (target - w.bodyT) * T.cold.rate;
            if (w.bodyT < T.cold.torpor)
            {
                if (++w.chill > T.cold.lethalTicks) Die(w, "cold", null);
            }
            else if (w.chill > 0) w.chill--;
        }

        // ---------------- flight (GDD 7.2)

        void Flight(Wasp w, Cmd cmd)
        {
            bool powered = w.state == "fly" && w.energy > 0 && w.bodyT >= T.cold.flyBody;
            bool rain = Raining;
            bool burst = powered && cmd.burst != 0;
            Num dx, dy, dz;
            if (cmd.hasDir)
            {
                dx = cmd.dirX * cmd.throttle; dy = cmd.dirY * cmd.throttle; dz = cmd.dirZ * cmd.throttle;
            }
            else
            {
                w.yaw = cmd.yawQ * 1e-4;
                w.pitch = Clamp(cmd.pitchQ * 1e-4, -1.45, 1.45);
                Num sy = DSin(w.yaw), cy = DCos(w.yaw), sp = DSin(w.pitch), cp = DCos(w.pitch);
                Num mz = (Num)cmd.mz / 100, mx = (Num)cmd.mx / 100, my = (Num)cmd.my / 100;
                dx = sy * cp * mz - cy * mx; dy = sp * mz + my * (T.wasp.climb / T.wasp.cruise); dz = cy * cp * mz + sy * mx;
                Num m = Sqrt(dx * dx + dy * dy + dz * dz);
                if (m > 1) { dx /= m; dy /= m; dz /= m; }
            }
            if (powered)
            {
                Num top = burst ? T.wasp.burst : T.wasp.cruise;
                if (w.carry != null) top *= T.wasp.carrySpeedMul;
                if (w.caste == "queen") top *= T.queen.speedMul;
                if (rain) top *= T.weather.rainSpeedMul;
                dx *= top; dy *= top; dz *= top;
                // the air moves: the wasp holds most of its course but drifts with the wind, less near the ground (GDD 5.3)
                var wd = Drift(w);
                dx += wd.x; dz += wd.z;
                Num ex = dx - w.vx, ey = dy - w.vy, ez = dz - w.vz;
                Num el = Sqrt(ex * ex + ey * ey + ez * ez), amax = (burst ? T.wasp.burstAccel : T.wasp.accel) * T.DT;
                if (el > amax) { ex *= amax / el; ey *= amax / el; ez *= amax / el; }
                w.vx += ex; w.vy += ey; w.vz += ez;
                Num speed = Sqrt(w.vx * w.vx + w.vy * w.vy + w.vz * w.vz);
                Num drain = T.energy.cruisePerSec * T.DT * (T.energy.hoverShare + (1 - T.energy.hoverShare) * Min(speed / T.wasp.cruise, 2)) * (burst ? T.energy.burstMul : 1);
                if (rain) drain *= T.weather.rainDrainMul;
                if (NearCitronella(w)) drain *= T.esc.citronellaDrain;
                w.energy -= drain;
                if (w.energy < 0) { w.energy = 0; Emit("exhausted", ("id", w.id)); }
            }
            else
            {
                w.vy -= T.wasp.gravity * T.DT;
                if (w.vy < -T.wasp.maxFall) w.vy = -T.wasp.maxFall;
                var wd = Drift(w);
                w.vx = w.vx * 0.97 + wd.x * 0.03; w.vz = w.vz * 0.97 + wd.z * 0.03;
            }
            int n = T.wasp.substeps; Num h = T.DT / n; var p0 = w.P;
            for (int i = 0; i < n; i++)
            {
                w.x += w.vx * h; w.y += w.vy * h; w.z += w.vz * h;
                Collide(w);
            }
            WebCheck(w, p0);

            // grounded without fuel: starvation clock
            if (w.energy <= 0 && w.y <= T.wasp.radius + 1e-6)
            {
                if (++w.groundTicks > T.wasp.starveTicks) Die(w, "starved", null);
            }
            else w.groundTicks = 0;
        }

        /// The wind a wasp feels: the day's wind, gusting, falling off toward the ground, times the share it cannot hold against
        V3 Drift(Wasp w)
        {
            var wind = Wind; int t = tick;
            Num gust = 1 + T.wind.gust * DSin((Num)t * 0.031) * DSin((Num)t * 0.0137 + 1);
            Num k = T.wind.drift * gust * Clamp01(w.y / T.wind.refHeight);
            return new V3(wind.x * k, 0, wind.z * k);
        }

        bool NearCitronella(Wasp w)
        {
            if (EscAt(w.x, w.z) < 2) return false;
            foreach (var rec in activeChunks) if (Near(rec, w.x, w.z)) foreach (var t in rec.content.tables)
                {
                    Num dx = w.x - t.x, dz = w.z - t.z;
                    if (dx * dx + dz * dz < 2.25 && EscLevel(rec.key) >= 2) return true;
                }
            return false;
        }

        void Collide(Wasp w)
        {
            Num R = T.wasp.radius;
            if (w.y < R) { w.y = R; if (w.vy < 0) w.vy = 0; w.vx *= 0.9; w.vz *= 0.9; }
            if (w.y > T.wasp.ceiling) { w.y = T.wasp.ceiling; if (w.vy > 0) w.vy = 0; }
            var pen = new Num[6];
            foreach (var rec in activeChunks)
            {
                if (!Near(rec, w.x, w.z)) continue;
                var c = rec.content;
                foreach (var b in c.boxes)
                {
                    if (w.x < b.minx - R || w.x > b.maxx + R || w.y < b.miny - R || w.y > b.maxy + R || w.z < b.minz - R || w.z > b.maxz + R) continue;
                    pen[0] = w.x - (b.minx - R); pen[1] = (b.maxx + R) - w.x; pen[2] = w.y - (b.miny - R); pen[3] = (b.maxy + R) - w.y; pen[4] = w.z - (b.minz - R); pen[5] = (b.maxz + R) - w.z;
                    int k = 0;
                    for (int i = 1; i < 6; i++) if (pen[i] < pen[k]) k = i;
                    if (k == 0) { w.x = b.minx - R; if (w.vx > 0) w.vx = 0; }
                    else if (k == 1) { w.x = b.maxx + R; if (w.vx < 0) w.vx = 0; }
                    else if (k == 2) { w.y = b.miny - R; if (w.vy > 0) w.vy = 0; }
                    else if (k == 3) { w.y = b.maxy + R; if (w.vy < 0) w.vy = 0; }
                    else if (k == 4) { w.z = b.minz - R; if (w.vz > 0) w.vz = 0; }
                    else { w.z = b.maxz + R; if (w.vz < 0) w.vz = 0; }
                }
                foreach (var cy in c.cylinders)
                {
                    if (w.y > cy.h) continue;
                    Num dx = w.x - cy.x, dz = w.z - cy.z, rr = cy.r + R, d2 = dx * dx + dz * dz;
                    if (d2 >= rr * rr || d2 == 0) continue;
                    Num d = Sqrt(d2), nx = dx / d, nz = dz / d;
                    w.x = cy.x + nx * rr; w.z = cy.z + nz * rr;
                    Num vn = w.vx * nx + w.vz * nz;
                    if (vn < 0) { w.vx -= vn * nx; w.vz -= vn * nz; }
                }
            }
            foreach (var hm in active)
            {
                if (hm.state == "away") continue;
                Num dx = w.x - hm.x, dz = w.z - hm.z;
                if (dx * dx + dz * dz > 4) continue;
                var F = hm.F;
                var lp = Body.ToLocal(F, w.P);
                bool pushed = false;
                foreach (var part in hm.PartsNow)
                {
                    var q = Body.SegClosest(part.a, part.b, lp);
                    Num ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z, rr = part.r + R;
                    Num d2 = ex * ex + ey * ey + ez * ez;
                    if (d2 >= rr * rr || d2 == 0) continue;
                    pushed = true;
                    Num d = Sqrt(d2);
                    lp.x = q.x + ex / d * rr; lp.y = q.y + ey / d * rr; lp.z = q.z + ez / d * rr;
                    var nw = Body.DirToWorld(F, new V3(ex / d, ey / d, ez / d));
                    Num vn = w.vx * nw.x + w.vy * nw.y + w.vz * nw.z;
                    if (vn < 0) { w.vx -= vn * nw.x; w.vy -= vn * nw.y; w.vz -= vn * nw.z; }
                }
                if (!pushed) continue;
                var p = Body.ToWorld(F, lp);
                w.x = p.x; w.y = p.y; w.z = p.z;
            }
        }

        // ---------------- contact (GDD 7.4)

        internal void ContactQuery(Wasp w) => ContactQuery(w, T.wasp.contactGap);
        internal void ContactQuery(Wasp w, Num reach)
        {
            Num R = T.wasp.radius;
            Num bestGap = reach;
            Human bHm = null; Part bPart = null; V3 bN = default, bSurf = default, bLp = default; int bZone = 0;
            foreach (var hm in active)
            {
                if (hm.state == "away") continue;
                Num dx = w.x - hm.x, dz = w.z - hm.z;
                if (dx * dx + dz * dz > 4) continue;
                var lp = Body.ToLocal(hm.F, w.P);
                foreach (var part in hm.PartsNow)
                {
                    var q = Body.SegClosest(part.a, part.b, lp);
                    Num ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z;
                    Num d = Sqrt(ex * ex + ey * ey + ez * ez);
                    if (d == 0) continue;
                    Num gap = d - part.r - R;
                    if (gap <= bestGap)
                    {
                        bestGap = gap;
                        var n = new V3(ex / d, ey / d, ez / d);
                        var surf = new V3(q.x + n.x * part.r, q.y + n.y * part.r, q.z + n.z * part.r);
                        bZone = Body.Classify(part, q, n, surf, hm.tr.height / 1.75);
                        bHm = hm; bPart = part; bN = n; bSurf = surf; bLp = lp;
                    }
                }
            }
            if (bHm == null) { w.contact = null; return; }
            var z = Body.ZONES[bZone];
            // nearest garment opening within reach of the wasp (GDD 8.8)
            int opening = -1;
            var nodes = UnderNodes(bHm);
            Num od = T.under.openingRadius * T.under.openingRadius;
            for (int i = 0; i < nodes.Count; i++)
            {
                if (!nodes[i].opening) continue;
                Num q = D2(nodes[i].pos, bLp);
                if (q <= od) { od = q; opening = i; }
            }
            w.contact = new Contact
            {
                humanHex = bHm.hex, zone = bZone, blocked = Body.ZoneCover(bHm.clothing, bZone) == 2,
                reach = Body.SelfReach(z, bHm.tr, bHm.clothing.stiffness), n = bN, surf = bSurf, part = bPart.name,
                opening = opening, openingKey = opening >= 0 ? nodes[opening].key : null,
            };
        }

        List<Companion> Companions(Human hm)
        {
            var o2 = new List<Companion>();
            foreach (var o in active)
            {
                if (o == hm || o.state != "idle" || o.special) continue;
                Num dx = o.x - hm.x, dz = o.z - hm.z, d2 = dx * dx + dz * dz;
                if (d2 > T.resolve.helperRange * T.resolve.helperRange) continue;
                o2.Add(new Companion { id = o.id, hex = o.hex, distance = Sqrt(d2), reactionTicks = o.tr.reactionTicks, style = o.tr.style });
            }
            return o2;
        }

        bool BeginSting(Wasp w, Contact c, string mode)
        {
            var hm = HumanByHex(c.humanHex);
            bool driven = w.id == drivenId;
            if (c.blocked) { if (driven) Emit("blocked", ("humanHex", hm.hex), ("zone", c.zone)); return false; }
            if (w.venom < T.venom.jab) { if (driven) Emit("noVenom"); return false; }
            w.venom -= T.venom.jab;
            Num R = T.wasp.radius;
            var local = new V3(c.surf.x + c.n.x * R, c.surf.y + c.n.y * R, c.surf.z + c.n.z * R);
            w.state = "attached";
            w.vx = w.vy = w.vz = 0;
            w.attach = new Attach { hex = hm.hex, posture = hm.posture, local = local, n = c.n, start = tick, deepened = false, zone = c.zone };
            ApplySting(w, hm, c.zone, c.surf, mode, false);
            return true;
        }

        static List<Swat> SwatsOut(Plan plan, Human hm, List<Companion> comps)
        {
            var o = new List<Swat>();
            foreach (var s in plan.swats)
            {
                string actorHex = null;
                if (s.actorId == hm.id) actorHex = hm.hex;
                else foreach (var x in comps) if (x.id == s.actorId) { actorHex = x.hex; break; }
                o.Add(new Swat { actorHex = actorHex, kind = s.kind, start = s.start, window = s.window, radius = s.radius, kills = s.kills, center = s.center });
            }
            return o;
        }

        // Shared by stings outside and under clothing. The stinger's peer resolves the plan at contact and
        // publishes it; every peer (this one too) applies the human side at the commit tick (GDD 11.5).
        void ApplySting(Wasp w, Human hm, int zone, V3 pointBody, string mode, bool under)
        {
            bool driven = w.id == drivenId;
            var ev = new StingIn { contactTick = tick, contactPointBody = pointBody, mode = mode, under = under };
            var comps = under ? new List<Companion>() : Companions(hm);
            int lvl = EscAt(hm.x, hm.z);
            var plan = Body.ResolveSting(ev, hm.tr, Body.ZONES[zone], new StingCtx
            {
                clothingStiffness = hm.clothing.stiffness, panic = hm.panic, companions = comps, panicMul = lvl >= 2 ? 1.3 : 1, stung = Wary(hm),
            });
            var sw = SwatsOut(plan, hm, comps);
            Emit("stingContact", ("waspId", w.id), ("driven", driven), ("humanHex", hm.hex), ("zone", zone), ("first", !stung.Has(hm.hex)), ("under", under), ("swats", sw), ("contactTick", tick));
            Publish(new NetEv { type = "sting", waspId = w.id, driven = driven, humanHex = hm.hex, zone = zone, under = under, swats = sw, panicGain = plan.panicGain, flee = plan.flee, sx = w.x, sz = w.z });
        }

        void Attached(Wasp w, Cmd cmd, bool driven)
        {
            var a = w.attach; var hm = HumanByHex(a.hex);
            int held = tick - a.start;
            if (hm == null || hm.posture != a.posture || hm.state == "away") { Detach(w, "knocked off"); return; }
            var p = Body.ToWorld(hm.F, a.local);
            w.x = p.x; w.y = p.y; w.z = p.z;
            bool holding = driven ? cmd.sting != 0 : held < T.sting.jabTicks;
            if (holding && held >= T.sting.fullTicks && !a.deepened)
            {
                a.deepened = true;
                Num extra = (T.resolve.fullPain - T.resolve.jabPain) * Body.ZONES[a.zone].sens * hm.tr.panicSusceptibility;
                w.venom = Max(0, w.venom - T.venom.deepen);
                stats.full++;
                Publish(new NetEv { type = "deepen", humanHex = hm.hex, zone = a.zone, extra = extra, sx = w.x, sz = w.z });
            }
            if ((!holding && held >= T.sting.jabTicks) || a.deepened) Detach(w, null);
        }

        void Detach(Wasp w, string why)
        {
            var a = w.attach; var hm = a != null ? HumanByHex(a.hex) : null;
            if (hm != null)
            {
                var n = Body.DirToWorld(hm.F, a.n);
                w.vx = n.x * T.wasp.pushOff; w.vy = n.y * T.wasp.pushOff + 0.2; w.vz = n.z * T.wasp.pushOff;
            }
            w.attach = null;
            w.state = "fly";
            Emit("detach", ("id", w.id), ("why", why));
            if (w.id != drivenId && w.ai.mode == "attack") AiAfterSting(w);
        }

        // ---------------- interactions (E): crawl under, catch prey, chew pulp

        void Interact(Wasp w)
        {
            if (w.caste == "queen" && !colony.sited) { var site = SiteNear(w); if (site != null) { FoundNest(w, site); return; } }
            if (w.caste != "queen" && SeasonFrac >= T.season.reproStart && colony.mated + colony.gynes >= 1)
            {
                var hs = HiberNear(w);
                if (hs != null) { hiberPick = new HiberPick { season = season.n, x = hs.x, z = hs.z, kind = hs.kind }; Emit("hiberScouted", ("kind", hs.kind), ("q", hs.q)); return; }
            }
            var rv = RivalNestNear(w);
            if (rv != null && w.carry == null) { Raid(w, rv); return; }
            var c = w.contact;
            if (c != null && c.opening >= 0 && w.carry == null) { EnterUnder(w, c.humanHex, c.opening); return; }
            if (c != null && w.state == "fly") { PerchOn(w, c.humanHex, c.zone, c.surf, c.n, c.part); return; }
            var prey = PreyNear(w);
            if (prey != null) { Catch(w, prey); return; }
            if (w.carry == null && BaitNear(w) != null) { TakeBait(w); return; }
            if (w.carry == null && WoodNear(w)) { w.state = "chewing"; w.chew = 0; w.vx = w.vy = w.vz = 0; Emit("chewStart", ("id", w.id)); return; }
            if (w.carry != null) Emit("carrying", ("kind", w.carry.kind));
        }

        void Hints(Wasp w)
        {
            var c = w.contact;
            var pn = w.carry == null ? PreyNear(w) : null;
            hint = new Hint
            {
                opening = c != null && c.opening >= 0 ? c.openingKey : null,
                prey = pn?.kind,
                bait = w.carry == null && BaitNear(w) != null,
                wood = w.carry == null && c == null && WoodNear(w),
                nest = D2(w, nest.entrance) < 0.4 * 0.4,
                site = w.caste == "queen" && !colony.sited ? SiteNear(w)?.type : null,
                rival = w.carry == null && RivalNestNear(w) != null,
                hiber = w.caste != "queen" && SeasonFrac >= T.season.reproStart && colony.mated + colony.gynes >= 1 ? HiberNear(w)?.kind : null,
            };
        }

        PreyHit PreyNear(Wasp w)
        {
            Num r2 = T.prey.catchDist * T.prey.catchDist;
            foreach (var rec in activeChunks)
            {
                if (!Near(rec, w.x, w.z)) { CS(rec.key); continue; } // the JS creates chunk state here, and the state hash sees it
                var c = rec.content; string key = rec.key; var st = CS(key);
                for (int i = 0; i < c.flies.Count; i++)
                {
                    if ((st.caughtFly.TryGetValue(i, out var cf) ? cf : 0) > tick) continue;
                    if (D2(w, FlyPos(c.flies[i], tick)) <= r2) return new PreyHit { kind = "fly", key = key, i = i, protein = T.prey.flyProtein };
                }
                for (int i = 0; i < c.caterpillars.Count; i++)
                {
                    if (st.caughtCat.ContainsKey(i)) continue;
                    var cp = c.caterpillars[i];
                    if (D2(w, new V3(cp.x, cp.y, cp.z)) <= r2 * 2) return new PreyHit { kind = "caterpillar", key = key, i = i, protein = T.prey.caterpillarProtein };
                }
                for (int h = 0; h < c.hives.Count; h++)
                {
                    var hv = c.hives[h]; st.beeLost.TryGetValue(h, out var lost); var al = hiveAlarms.Get(rec.Sub(h));
                    for (int k = T.bees.guards; k < hv.bees.Count; k++)
                    {
                        if ((lost != null && lost.ContainsKey(k)) || (al != null && al.phys.ContainsKey(k))) continue;
                        if (D2(w, BeePos(hv, k, tick)) <= r2) return new PreyHit { kind = "bee", key = key, i = k, hive = h, protein = T.prey.beeProtein };
                    }
                }
            }
            return null;
        }

        void Catch(Wasp w, PreyHit p)
        {
            var st = CS(p.key);
            if (p.kind == "fly") st.caughtFly[p.i] = tick + T.prey.flyRespawnTicks;
            else if (p.kind == "caterpillar") st.caughtCat[p.i] = 1;
            else
            {
                if (!st.beeLost.TryGetValue(p.hive, out var l)) st.beeLost[p.hive] = l = new Dictionary<int, int>();
                l[p.i] = 1;
                AlarmHive(p.key, p.hive, w, T.bees.catchAlarmRadius * 3);
            }
            w.carry = new Carry { kind = "protein", amount = p.protein, what = p.kind };
            Publish(new NetEv { type = "caught", key = p.key, what = p.kind, i = p.i, hive = p.hive });
            stats.caught++;
            Emit("caught", ("id", w.id), ("kind", p.kind));
        }

        bool WoodNear(Wasp w)
        {
            Num reach = T.pulp.reach + T.wasp.radius;
            foreach (var rec in activeChunks)
            {
                if (!Near(rec, w.x, w.z)) continue;
                foreach (var b in rec.content.boxes)
                {
                    if (!b.wood || b.hive) continue;
                    Num qx = Clamp(w.x, b.minx, b.maxx), qy = Clamp(w.y, b.miny, b.maxy), qz = Clamp(w.z, b.minz, b.maxz);
                    Num dx = w.x - qx, dy = w.y - qy, dz = w.z - qz;
                    if (dx * dx + dy * dy + dz * dz <= reach * reach) return true;
                }
                foreach (var cy in rec.content.cylinders)
                {
                    if (w.y > cy.h) continue;
                    Num dx = w.x - cy.x, dz = w.z - cy.z, d = Sqrt(dx * dx + dz * dz) - cy.r;
                    if (d <= reach) return true;
                }
            }
            return false;
        }

        void ChewStep(Wasp w, Cmd cmd, bool driven)
        {
            bool holding = driven ? (cmd.act & Act.Interact) != 0 : true;
            if (!holding) { w.state = "fly"; Emit("chewCancel", ("id", w.id)); return; }
            w.chew++;
            w.energy -= T.energy.cruisePerSec * T.DT * T.energy.hoverShare;
            if (w.chew >= T.pulp.chewTicks)
            {
                w.state = "fly";
                w.carry = new Carry { kind = "pulp", amount = T.pulp.amount, what = "pulp" };
                CS(ChunkKey(ChunkOf(w.x), ChunkOf(w.z))).chewed++;
                Emit("chewed", ("id", w.id));
            }
        }

        void Feed(Wasp w, bool driven)
        {
            Num d2max = T.energy.feedDist * T.energy.feedDist;
            if (driven) feeding = false;
            foreach (var rec in activeChunks)
            {
                if (!Near(rec, w.x, w.z)) continue;
                string key = rec.key; int lvl = EscLevel(key);
                var c = rec.content;
                if (lvl >= 3)
                {
                    foreach (var tr in c.traps)
                    {
                        if (D2(w, new V3(tr.x, tr.y, tr.z)) <= d2max)
                        {
                            w.state = "trapped"; w.stateTicks = 90; w.vx = w.vy = w.vz = 0;
                            Emit("trapped", ("id", w.id), ("driven", driven));
                            return;
                        }
                    }
                }
                if (w.energy >= 1 && !(w.ai.mode == "collect" && w.role == "sugar")) continue;
                for (int i = 0; i < c.sugar.Count; i++)
                {
                    var s = c.sugar[i];
                    if (s.kind == "can" && (lvl >= 2 || CanSpilled(key, i))) continue; // food covered (GDD 8.10) or knocked over
                    if (FeedAt(w, driven, s.x, s.y, s.z, s.rate, s.kind, d2max, key)) return;
                }
                foreach (var s in SpillsIn(key)) if (FeedAt(w, driven, s.x, s.y, s.z, s.rate, s.kind, d2max, key)) return;
                foreach (var s in FruitIn(rec)) if (FeedAt(w, driven, s.x, s.y, s.z, s.rate, s.kind, d2max, key)) return;
            }
            w.ai.atFood = null;
        }

        bool FeedAt(Wasp w, bool driven, Num x, Num y, Num z, Num rate, string kind, Num d2max, string key)
        {
            if (D2(w, new V3(x, y, z)) > d2max) return false;
            Num add = T.energy.refuelPerSec * rate * T.DT;
            if (w.energy < 1) w.energy = Min(1, w.energy + add);
            else if (!driven) w.ai.cargo = Min(1, w.ai.cargo + add);
            if (driven) feeding = true;
            w.ai.atFood = kind;
            // an open can is a trap of its own: a feeding wasp may slip in (GDD 7.5, T1-3)
            if (kind == "can" && H32(w.id, tick, 53) < T.drown.chancePerSec * T.DT) FallIn(w, x, y, z, key, driven);
            return true;
        }

        void FallIn(Wasp w, Num x, Num y, Num z, string key, bool driven)
        {
            w.state = "drowning"; w.vx = w.vy = w.vz = 0;
            w.x = x; w.y = y - 0.03; w.z = z;
            w.drown = new Drown { key = key, until = tick + T.drown.ticks, progress = 0, prevBurst = 1 };
            Emit("fellIn", ("id", w.id), ("driven", driven));
        }

        /// Mash burst to climb out before the drink takes you; AI wasps get a small chance each tick
        void DrownStep(Wasp w, Cmd cmd, bool driven)
        {
            var d = w.drown;
            if (driven) { if (cmd.burst != 0 && d.prevBurst == 0) d.progress += T.drown.escapePerPress; d.prevBurst = cmd.burst; }
            else if (H32(w.id, tick, 57) < T.drown.aiEscape) d.progress = 1;
            if (d.progress >= 1)
            {
                w.drown = null; w.state = "stunned"; w.stateTicks = 30; w.vy = 0.6; w.y += 0.04;
                w.energy = Min(1, w.energy + 0.1); // a sticky, sugary escape
                Emit("climbedOut", ("id", w.id));
                return;
            }
            if (tick >= d.until) Die(w, "drowned in a drink", null);
        }

        void AddDeposited(string kind, Num amt)
        {
            var s = colony.stats;
            if (kind == "sugar") s.depSugar += amt; else if (kind == "protein") s.depProtein += amt; else s.depPulp += amt;
        }

        void NestTouch(Wasp w)
        {
            if (!colony.nestAlive || w.colony != "own") return;
            if (!colony.sited || D2(w, nest.entrance) > 0.07 * 0.07) return;
            var col = colony;
            bool deposited = false;
            if (w.carry != null && w.carry.kind == "pulp" && w.caste == "queen")
            {
                // a founding queen builds her own cells straight away (GDD 6.1)
                col.cells += w.carry.amount * T.colony.cellsPerPulp;
                col.stats.depPulp += w.carry.amount;
                Emit("deposit", ("id", w.id), ("kind", "cells"), ("amount", w.carry.amount * T.colony.cellsPerPulp), ("what", "cells"));
                w.carry = null; deposited = true;
            }
            else if (w.carry != null && w.carry.poison)
            {
                Poison(w.carry.amount, w.id);
                w.carry = null; deposited = true;
            }
            else if (w.carry != null)
            {
                col[w.carry.kind] += w.carry.amount;
                AddDeposited(w.carry.kind, w.carry.amount);
                Emit("deposit", ("id", w.id), ("kind", w.carry.kind), ("amount", w.carry.amount), ("what", w.carry.what));
                w.carry = null; deposited = true;
            }
            Num surplus = w.energy - T.energy.nestRefill + w.ai.cargo;
            if (surplus > 0.05)
            {
                Num amt = surplus * 0.6;
                col.sugar += amt; col.stats.depSugar += amt;
                w.energy = Min(w.energy, T.energy.nestRefill); w.ai.cargo = 0;
                Emit("deposit", ("id", w.id), ("kind", "sugar"), ("amount", amt), ("what", "sugar"));
                deposited = true;
            }
            else if (w.energy < T.energy.nestRefill && col.sugar > 0)
            {
                Num take = Min(col.sugar, (T.energy.nestRefill - w.energy) * 0.6);
                col.sugar -= take; w.energy += take / 0.6;
            }
            if (deposited) stats.deposits++;
        }

        // ---------------- under clothing (GDD 8.8)

        void EnterUnder(Wasp w, string humanHex, int opening)
        {
            var hm = HumanByHex(humanHex);
            var nodes = UnderNodes(hm);
            Num notice = Max(T.resolve.minConsequenceTicks, hm.tr.reactionTicks * (T.under.noticeMul - 1));
            w.state = "under";
            w.vx = w.vy = w.vz = 0;
            w.under = new Under { hex = hm.hex, posture = hm.posture, node = opening, key = nodes[opening].key, sel = 0, move = null, entered = tick, nextPress = tick + notice };
            PlaceUnder(w, hm, nodes);
            Emit("underEnter", ("id", w.id), ("humanHex", hm.hex), ("key", w.under.key));
        }

        List<GNode> UnderNodes(Human hm)
        {
            if (hm.gCache == null || hm.gClothing != hm.clothing || hm.gPosture != hm.posture)
            { hm.gCache = Body.GarmentGraph(hm.tr, hm.clothing, hm.posture, hm.PartsNow); hm.gClothing = hm.clothing; hm.gPosture = hm.posture; }
            return hm.gCache;
        }

        static V3 UnderPoint(Under u, List<GNode> nodes)
        {
            var a = nodes[u.node].pos;
            if (u.move == null) return a;
            var b = nodes[u.move.to].pos; Num s = u.move.t / (Num)T.under.moveTicks;
            return new V3(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s, a.z + (b.z - a.z) * s);
        }

        void PlaceUnder(Wasp w, Human hm, List<GNode> nodes)
        {
            var p = Body.ToWorld(hm.F, UnderPoint(w.under, nodes));
            w.x = p.x; w.y = p.y; w.z = p.z;
        }

        static int FindKey(List<GNode> nodes, string key) { for (int i = 0; i < nodes.Count; i++) if (nodes[i].key == key) return i; return -1; }

        void UnderStep(Wasp w, Cmd cmd, int edge, bool armed)
        {
            var u = w.under; var hm = HumanByHex(u.hex);
            if (hm == null || hm.state == "away") { ExitUnder(w, true); return; }
            var nodes = UnderNodes(hm);
            if (hm.posture != u.posture)
            {
                int i = FindKey(nodes, u.key);
                if (i < 0) { ExitUnder(w, true); return; }
                u.node = i; u.posture = hm.posture; u.move = null;
            }
            if (u.node >= nodes.Count || nodes[u.node].key != u.key) { int i = FindKey(nodes, u.key); if (i < 0) { ExitUnder(w, true); return; } u.node = i; }
            var here = nodes[u.node];
            if (u.move != null)
            {
                if (++u.move.t >= T.under.moveTicks) { u.node = u.move.to; u.key = nodes[u.node].key; u.move = null; u.sel = 0; Emit("underMove", ("id", w.id), ("key", u.key)); }
            }
            else if (w.id == drivenId)
            {
                int nl = here.links.Count;
                if (nl > 0)
                {
                    if (cmd.mx != 0 && !u.mxHeld) u.sel = (u.sel + (cmd.mx > 0 ? 1 : nl - 1)) % nl;
                    u.mxHeld = cmd.mx != 0;
                    if (cmd.mz > 0 && !u.mzHeld) u.move = new UnderMove { to = here.links[u.sel], t = 0 };
                    u.mzHeld = cmd.mz > 0;
                }
                if ((edge & Act.Interact) != 0 && here.opening) { ExitUnder(w, false); return; }
                if (armed)
                {
                    pressUsed = true;
                    if (w.venom >= T.venom.jab) { w.venom -= T.venom.jab; ApplySting(w, hm, here.zone, here.pos, "jab", true); }
                    else Emit("noVenom");
                }
            }
            PlaceUnder(w, hm, nodes);
            // The human presses the cloth wherever they feel the wasp
            if (tick >= u.nextPress)
            {
                var point = UnderPoint(u, nodes);
                var plan = Body.ResolveSting(new StingIn { contactTick = tick, contactPointBody = point, mode = "jab", under = true }, hm.tr, Body.ZONES[here.zone],
                    new StingCtx { clothingStiffness = 0, panic = hm.panic, companions = new List<Companion>(), stung = Wary(hm) });
                var sw = new List<Swat>();
                foreach (var s in plan.swats) sw.Add(new Swat { kind = s.kind, start = Max(s.start, tick + T.net.commitTicks), window = s.window, radius = s.radius, kills = s.kills, center = point });
                Publish(new NetEv { type = "press", humanHex = hm.hex, waspId = w.id, swats = sw });
                u.nextPress = tick + hm.tr.reactionTicks + T.under.compressEvery;
            }
            // Panic high enough: the shirt comes off and the wasp with it
            if (hm.panic >= T.under.ripPanic && hm.clothing.top != Top.Suit && !hm.clothing.topOff && here.zone != Zone.Thighs && here.zone != Zone.Shins && here.zone != Zone.Groin && here.zone != Zone.Buttocks)
            {
                Publish(new NetEv { type = "rip", humanHex = hm.hex, sx = w.x, sz = w.z });
                ExitUnder(w, true);
            }
        }

        void ExitUnder(Wasp w, bool ejected)
        {
            var u = w.under; var hm = HumanByHex(u.hex);
            w.under = null;
            if (hm != null)
            {
                var nodes = UnderNodes(hm);
                int i = System.Math.Min(u.node, nodes.Count - 1);
                var n = Body.DirToWorld(hm.F, nodes[i].n);
                w.x += n.x * 0.025; w.y += n.y * 0.025 + 0.005; w.z += n.z * 0.025;
                w.vx = n.x * 0.8; w.vy = 0.4; w.vz = n.z * 0.8;
            }
            if (ejected) { w.state = "stunned"; w.stateTicks = T.stunTicks; } else w.state = "fly";
            Emit("underExit", ("id", w.id), ("ejected", ejected));
        }

        // ---------------- swats and sprays (GDD 8.7, 8.10)

        static bool Swattable(string s) => s == "fly" || s == "attached" || s == "stunned" || s == "chewing" || s == "landed" || s == "perched";

        void Swats()
        {
            var live = new List<Swat>();
            foreach (var s in swats)
            {
                if (tick >= s.start + s.window)
                {
                    if (s.pre && s.targetId != 0 && s.hits.Count == 0) Missed(s);
                    continue;
                }
                live.Add(s);
                if (tick == s.start) Emit("swatStrike", ("actorHex", s.actorHex), ("frameHex", s.frameHex), ("kind", s.kind));
                if (tick < s.start) continue;
                var hm = HumanByHex(s.frameHex);
                if (hm == null) continue;
                var c = Body.ToWorld(hm.F, s.center); Num r = s.radius + T.wasp.radius;
                foreach (var w in new List<Wasp>(wasps))
                {
                    if (s.hits.Contains(w.id)) continue;
                    if (s.underOnly != 0 ? w.id != s.underOnly || w.state != "under" : !Swattable(w.state)) continue;
                    if (D2(w, c) > r * r) continue;
                    s.hits.Add(w.id);
                    Emit("swatHit", ("waspId", w.id), ("actorHex", s.actorHex), ("frameHex", s.frameHex), ("kind", s.kind), ("kills", s.kills), ("delayTicks", s.start - s.contactTick));
                    string cause = s.kind == SwatKind.Slap ? "slap" : s.kind == SwatKind.Cover ? "cover" : s.kind == SwatKind.Compress ? "crushed under clothing" : "swat";
                    if (s.kills) Die(w, cause + (s.actorHex == s.frameHex || s.pre ? "" : " (helper)"), s.actorHex, new Dictionary<string, object> { ["why"] = s.why, ["own"] = s.byWasp == w.id || s.targetId == w.id, ["delay"] = s.start - s.contactTick });
                    else Stun(w);
                }
            }
            swats = live;
        }

        void Missed(Swat s)
        {
            // A wasp that was swatted at and survived may take it personally (GDD 6.3, 8.10)
            var w = WaspById(s.targetId);
            if (w == null || w.id == drivenId || w.state != "fly") return;
            if (H32(w.id, tick, 5) < (w.colony == "own" ? colony.deficit : 0.3) + 0.15) AiAttack(w, s.actorHex);
        }

        static readonly Num[][] SPRAY = { new Num[] { 0.35, 0.14 }, new Num[] { 0.7, 0.22 }, new Num[] { 1.05, 0.3 } };

        void Sprays()
        {
            if (sprays.Count == 0) return;
            var live = new List<Spray>();
            foreach (var sp in sprays)
            {
                if (tick >= sp.end) continue;
                live.Add(sp);
                if (tick < sp.start) continue;
                var hm = HumanByHex(sp.hex);
                if (hm == null || hm.state == "away") continue;
                Num headY = hm.PartsNow[0].a.y;
                foreach (var w in new List<Wasp>(wasps))
                {
                    if (!(w.state == "fly" || w.state == "stunned" || w.state == "attached" || w.state == "chewing" || w.state == "landed" || w.state == "perched")) continue;
                    var lp = Body.ToLocal(hm.F, w.P);
                    foreach (var zr in SPRAY)
                    {
                        Num dx = lp.x, dy = lp.y - headY, dz = lp.z - zr[0];
                        if (dx * dx + dy * dy + dz * dz <= zr[1] * zr[1]) { Die(w, "insecticide", hm.hex); break; }
                    }
                }
            }
            sprays = live;
        }

        void Stun(Wasp w)
        {
            if (w.state == "attached") Detach(w, "stunned");
            w.state = "stunned"; w.stateTicks = T.stunTicks;
            Emit("stunned", ("id", w.id), ("driven", w.id == drivenId));
        }

        void Die(Wasp w, string cause, string byHex, object detail = null)
        {
            bool driven = w.id == drivenId;
            wasps = wasps.FindAll(x => x != w);
            w.state = "dead";
            if (w.colony != "own") { /* a rival worker */ }
            else if (w.caste == "queen") { colony.queenAlive = false; Emit("queenDied", ("cause", cause)); }
            else colony.adults = Max(0, colony.adults - 1);
            if (w.fight != null) { var o = WaspById(w.fight.other); if (o != null && o.state == "fighting") { o.state = "fly"; o.fight = null; } }
            stats.deaths++;
            stats.causes.TryGetValue(cause, out Num cn); stats.causes[cause] = cn + 1;
            if (byHex != null)
            {
                Publish(new NetEv { type = "killed", byHex = byHex });
                alarms.Add(new Alarm { x = w.x, y = w.y, z = w.z, until = tick + T.alarm.ticks, killerHex = byHex });
                Emit("alarm", ("x", w.x), ("y", w.y), ("z", w.z), ("killerHex", byHex));
            }
            Publish(new NetEv { type = "died", waspId = w.id, cause = cause, x = w.x, y = w.y, z = w.z });
            ReleaseBees(w.id);
            Emit("waspDied", ("id", w.id), ("driven", driven), ("cause", cause), ("byHex", byHex), ("detail", detail), ("x", w.x), ("y", w.y), ("z", w.z), ("adultsLeft", Floor(colony.adults)));
            if (driven)
            {
                ghost = w.Ghost();
                respawnAt = tick + T.respawnTicks;
            }
        }

        void Despawn(Wasp w)
        {
            wasps = wasps.FindAll(x => x != w);
            Publish(new NetEv { type = "died", waspId = w.id, cause = "home", x = w.x, y = w.y, z = w.z });
            ReleaseBees(w.id);
            Emit("waspDespawn", ("id", w.id));
        }

        void Respawn()
        {
            var col = colony;
            Num inside = col.adults - Own().Count;
            if (col.nestAlive && inside >= 1)
            {
                var w = SpawnWasp(true);
                drivenId = w.id; ghost = null;
                Emit("respawn", ("id", w.id), ("yaw", nest.spawn.yaw));
                return;
            }
            var own = Own();
            if (own.Count > 0)
            {
                V3 g = ghost != null ? ghost.P : new V3(nest.spawn.x, nest.spawn.y, nest.spawn.z);
                Wasp best = null; Num bd = Num.MaxValue;
                foreach (var w in own) { Num q = D2(w, g); if (q < bd) { bd = q; best = w; } }
                drivenId = best.id; ghost = null;
                Emit("possess", ("id", best.id), ("from", 0));
                return;
            }
            if (!Colony.Finished(col, 0) && col.queenAlive) { respawnAt = tick + 600; Emit("waitingBrood"); return; }
            if (!Colony.Finished(col, 0) && col.pupae >= 1) { respawnAt = tick + 600; Emit("waitingBrood"); return; }
            EndSeason("colony lost");
        }

        // ---------------- the yearly cycle (GDD 2.2, 5.2, 6.7)

        /// Hibernation sites near the nest (T1-15): shed walls, hollow trees, loose bark on thick trunks and the leaf
        /// litter, from the 3x3 chunks around the nest. A pure function of the seed and the nest, cached, never saved.
        public List<HiberSite> HiberSites()
        {
            var n = nest;
            string ck = n.key + "|" + n.x.ToString() + "|" + n.z.ToString();
            if (hiberCache.list != null && hiberCache.k == ck) return hiberCache.list;
            var (cx, cz) = SplitKey(n.key); long sd = (long)(seed & 0xffffffffUL);
            var list = new List<HiberSite>();
            void Add(string kind, Num x, Num y, Num z) { if (Sq(x - n.x) + Sq(z - n.z) <= T.hiber.range * T.hiber.range) list.Add(new HiberSite { kind = kind, x = x, y = y, z = z, q = T.hiber.Q(kind) }); }
            for (int dz = -1; dz <= 1; dz++) for (int dx = -1; dx <= 1; dx++)
                {
                    var rc = new ChunkRec { cx = cx + dx, cz = cz + dz, content = Content(cx + dx, cz + dz) };
                    var s = SitesIn(rc);
                    foreach (var sh in rc.content.sheds) { var p = World.ShedSites(sh).wall; Add("shed", p.x, p.y, p.z); }
                    foreach (var h in s.hollows) Add("hollow", h.p.x, h.p.y, h.p.z);
                    var trees = rc.content.trees;
                    for (int i = 0; i < trees.Count; i++)
                    {
                        var t = trees[i];
                        if (t.r < T.hiber.barkMinR) continue;
                        Num a = HSeq(sd, rc.cx, rc.cz, i, 941) * 6.28318;
                        Add("bark", t.x + (t.r + 0.01) * DCos(a), 0.4, t.z + (t.r + 0.01) * DSin(a));
                    }
                    foreach (var h in s.holes) Add("litter", h.x, 0.02, h.z);
                }
            hiberCache = (ck, list);
            return list;
        }

        HiberSite HiberNear(Wasp w)
        {
            Num r2 = T.hiber.reach * T.hiber.reach;
            foreach (var s in HiberSites()) if (D2(w, new V3(s.x, s.y, s.z)) < r2) return s;
            return null;
        }

        Tree TreeNear(Num px, Num pz)
        {
            int cx = World.ChunkOf(px), cz = World.ChunkOf(pz);
            Tree best = null; Num bd = Num.MaxValue;
            for (int dz = -1; dz <= 1; dz++) for (int dx = -1; dx <= 1; dx++)
                    foreach (var t in Content(cx + dx, cz + dz).trees)
                    {
                        if (t.h < 2.5) continue;
                        Num d = Sq(t.x - px) + Sq(t.z - pz);
                        if (d < bd) { bd = d; best = t; }
                    }
            return best;
        }

        /// Autumn's end (GDD 6.7, T1-15). The mated gynes spread over a few hibernation sites near the nest, most of
        /// them to the one a worker scouted; each site's quality sets how many wake. The colony sleeps until the
        /// player picks a queen.
        void EndSeason(string why)
        {
            var col = colony; int sn = season.n;
            var cands = HiberSites();
            var order = new List<int>(); for (int i = 0; i < cands.Count; i++) order.Add(i);
            order.Sort((a, b) => { Num ha = H32(sn, a, 951), hb = H32(sn, b, 951); return ha != hb ? (ha < hb ? -1 : 1) : a.CompareTo(b); });
            int pk = -1;
            if (hiberPick != null && hiberPick.season == sn) for (int i = 0; i < cands.Count; i++) if (cands[i].x == hiberPick.x && cands[i].z == hiberPick.z) { pk = i; break; }
            var chosen = new List<int>();
            foreach (int i in order) { if (i == pk) continue; if (chosen.Count >= T.hiber.spread) break; chosen.Add(i); }
            var share = new List<(int i, Num f)>();
            if (pk >= 0) share.Add((pk, T.hiber.pickShare));
            foreach (int i in chosen) share.Add((i, (1 - (pk >= 0 ? T.hiber.pickShare : 0)) / System.Math.Max(1, chosen.Count)));
            var sites = new List<HiberSite>();
            Num survivors = 0;
            foreach (var (i, f) in share)
            {
                var s = cands[i]; int k = (int)Floor(col.mated * f * T.hiber.survival * s.q + H32(sn, i, 952));
                if (k >= 1) { sites.Add(new HiberSite { kind = s.kind, x = s.x, y = s.y, z = s.z, q = s.q, n = k, scouted = i == pk }); survivors += k; }
            }
            sites.Sort((a, b) => a.n != b.n ? b.n.CompareTo(a.n) : a.q != b.q ? (b.q < a.q ? -1 : 1) : a.x != b.x ? (a.x < b.x ? -1 : 1) : a.z != b.z ? (a.z < b.z ? -1 : 1) : 0);
            Num lin = Floor(lineage * T.season.lineageSurvival + H32(sn, 32));
            Emit("winter", ("why", why), ("mated", col.mated), ("survivors", survivors), ("lineage", lin), ("season", sn), ("sites", sites.Count));
            if (survivors + lin < 1) { extinct = true; foreach (var w in new List<Wasp>(wasps)) Despawn(w); Emit("lineExtinct", ("nestAlive", col.nestAlive)); return; }
            // only sister nests made it: you wake in one of them
            if (sites.Count == 0) sites.Add(new HiberSite { kind = "sister", x = nest.spawn.x, y = nest.spawn.y, z = nest.spawn.z, q = T.hiber.Q("sister"), n = 0 });
            foreach (var w in new List<Wasp>(wasps)) Despawn(w);
            ghost = null;
            winter = new Winter { why = why, sites = sites, survivors = survivors, lineage = lin, until = tick + T.hiber.chooseTicks };
        }

        void WinterStep(int k)
        {
            var W = winter;
            bool ok = k >= 1 && k <= W.sites.Count;
            if (ok || tick >= W.until) Spring(ok ? k - 1 : 0);
        }

        void Spring(int choice)
        {
            var W = winter; var site = W.sites[choice]; Num survivors = W.survivors, lin = W.lineage;
            winter = null;
            // the queen that continues is yours; the rest found lineage colonies (Q-10)
            lineage = survivors + lin - 1;
            Num winterDays = Rnd(settings.seasonDays * T.season.winterShare);
            Num target = (day + 1 + winterDays) * 1440 + T.time.dawn;
            clockOffset += (long)((target - minute) * tpm);
            Minute(ClockMinutes(tick + clockOffset, settings));
            season = new Season { n = season.n + 1, startMinute = target, phase = "Founding" };
            int alloc = colony.alloc;
            colony = Colony.New(true);
            colony.alloc = alloc;
            colony.sited = false;
            colony.sugar *= 0.5 + site.q; // a queen who wintered well wakes with more in reserve
            springAt = new Spot { x = site.x, z = site.z };
            hiberPick = null;
            oldNests.Add(nest);
            foreach (var w in new List<Wasp>(wasps)) Despawn(w);
            foreach (var s in chunkState.Values) s.esc = 0;
            swats = new List<Swat>(); sprays = new List<Spray>(); alarms = new List<Alarm>(); hiveAlarms.Clear();
            ext = new Ext();
            ghost = null;
            var q = SpawnWasp(true, "queen");
            q.x = site.x; q.y = site.y + 0.05; q.z = site.z;
            drivenId = q.id;
            foreach (var hm in active) CatchUpHuman(hm);
            UpdateChunks(true);
            Emit("spring", ("season", season.n), ("lineage", lineage), ("id", q.id), ("kind", site.kind));
        }
    }
}
