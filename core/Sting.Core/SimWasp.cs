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
        public Num LifespanMinutes(Wasp w) => (w.caste == "male" ? T.males.maleLifeDays : 1 / T.colony.adultMortality) * bio * 1440 * (0.8 + 0.4 * H32(w.id, 7));

        static bool Free3(string s) => s == "fly" || s == "landed" || s == "chewing";

        void StepWasp(Wasp w, Cmd cmd, int edge, bool driven)
        {
            if (w.spent) { Die(w, "left its sting in a person", null); return; } // a bee that stung a person (T2-11)
            if (driven && w.caste != "queen" && w.colony == "own" && minute - w.born > LifespanMinutes(w) && (w.state == "fly" || w.state == "landed"))
            {
                Die(w, "old age", null);
                return;
            }
            bool armed = w.caste != "male" && (driven ? cmd.sting != 0 && !pressUsed : cmd.sting != 0); // males have no sting (T2-3)
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
                        if ((edge & Act.Swoop) != 0 && w.state == "fly") StartSwoop(w, cmd);
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
                    Turn(w, cmd);
                    w.walking = false;
                    if (cmd.mx != 0 || cmd.mz != 0) Walk(w, cmd);
                    if (w.state != "landed") break;
                    if (CupCheck(w)) break;
                    if (OnHotGrate(w)) { Die(w, "burned on a grill", null); break; } // T1-10
                    Feed(w, driven);
                    if (w.state != "landed") break;
                    Hints(w);
                    break;
                case "webbed": WebStep(w, cmd, driven); break;
                case "drowning": DrownStep(w, cmd, driven); break;
                case "robbing": RobStep(w, cmd, driven); break;
                case "perched": PerchStep(w, cmd, edge, armed, driven); break;
                case "fighting": if (driven && cmd.sting != 0 && !pressUsed) { pressUsed = true; w.fight.mash += T.rival.mash; } break;
                case "attached": Attached(w, cmd, driven); break;
                case "under": UnderStep(w, cmd, edge, armed); break;
                case "chewing": ChewStep(w, cmd, driven); break;
                case "trapped":
                    if (--w.stateTicks <= 0) Die(w, w.trapCause ?? "drowned in a trap", null);
                    break;
                case "balled":
                    if (driven) { BallEscape(w, cmd.burst != 0 && w.ball.prevBurst == 0); if (w.ball != null) w.ball.prevBurst = cmd.burst; }
                    break;
            }
            if (WaspById(w.id) != null)
            {
                w.venom = w.caste == "male" ? 0 : Min(w.caste == "queen" ? T.queen.venomMul : 1, w.venom + T.venom.regenPerSec * T.DT);
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
            // the air over a lit grill (T1-10) heats a wasp fast, and past the lethal temperature it is cooked
            Num? hot = w.state == "fly" || w.state == "landed" ? GrillAir(w) : null;
            if (hot.HasValue && hot.Value > target)
            {
                w.bodyT += (hot.Value - w.bodyT) * T.bbq.heatRate;
                if (w.bodyT >= T.bbq.lethal) { Die(w, "cooked over a grill", null); return; }
            }
            else w.bodyT += (target - w.bodyT) * T.cold.rate;
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
                bool sw = w.swoopUntil > tick; // the swoop: a dash along the heading, steered at speed (GDD 7.9)
                if (sw && dx == 0 && dy == 0 && dz == 0) { Num sy = DSin(w.yaw), cy = DCos(w.yaw), sp = DSin(w.pitch), cp = DCos(w.pitch); dx = sy * cp; dy = sp; dz = cy * cp; }
                Num top = sw ? T.swoop.speed : burst ? T.wasp.burst : T.wasp.cruise;
                if (w.carry != null) top *= T.wasp.carrySpeedMul;
                if (w.caste == "queen") top *= T.queen.speedMul;
                else if (w.caste == "male") top *= T.males.speedMul;
                if (rain) top *= T.weather.rainSpeedMul;
                top *= Spw(w).speed * Mul(w, "speed"); // a hornet is quicker, a bee slower (GDD 6.8); the speed skill
                // the wasp flies in moving air (GDD 5.3): airspeed capped at its top speed plus the wind; no input leans into the
                // wind and holds its place, full input flies the course at top airspeed (see sim.js)
                var wd = Drift(w); Num thr = Min(1, Sqrt(dx * dx + dy * dy + dz * dz));
                Num ax = dx * top - wd.x * (1 - thr), ay = dy * top, az = dz * top - wd.z * (1 - thr);
                Num am = Sqrt(ax * ax + ay * ay + az * az);
                if (am > top) { ax *= top / am; ay *= top / am; az *= top / am; }
                Num ex = ax + wd.x - w.vx, ey = ay - w.vy, ez = az + wd.z - w.vz;
                Num el = Sqrt(ex * ex + ey * ey + ez * ez), amax = (sw ? T.swoop.accel : burst ? T.wasp.burstAccel : T.wasp.accel) * T.DT;
                if (el > amax) { ex *= amax / el; ey *= amax / el; ez *= amax / el; }
                w.vx += ex; w.vy += ey; w.vz += ez;
                // the work is in the airspeed: holding still in a breeze costs like flying
                Num rx = w.vx - wd.x, rz = w.vz - wd.z, air = Sqrt(rx * rx + w.vy * w.vy + rz * rz);
                Num drain = T.energy.cruisePerSec * T.DT * (T.energy.hoverShare + (1 - T.energy.hoverShare) * Min(air / T.wasp.cruise, 2)) * (burst ? T.energy.burstMul : 1);
                if (rain) drain *= T.weather.rainDrainMul;
                if (NearCitronella(w)) drain *= T.esc.citronellaDrain;
                Num air0 = Temperature;
                if (air0 > T.extreme.heatFrom) drain *= 1 + T.extreme.heatDrain * (air0 - T.extreme.heatFrom); // flying in heat costs more (T2-2)
                drain *= Spw(w).drain;
                w.energy -= drain;
                if (w.energy < 0) { w.energy = 0; Emit("exhausted", ("id", w.id)); }
                // a downpour knocks a wasp in the open out of the air (T2-2)
                if (rain && WeatherToday.pour > 1 && !Sheltered(w) && H32(w.id, tick, 71) < T.extreme.knockPerSec * T.DT)
                {
                    w.state = "stunned"; w.stateTicks = T.extreme.knockTicks; w.vy = -1.2; w.land = null;
                    Emit("knockedDown", ("id", w.id), ("driven", w.id == drivenId));
                }
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
                var v0 = new V3(w.vx, w.vy, w.vz); // the speed going in, before a collision stops it
                w.x += w.vx * h; w.y += w.vy * h; w.z += w.vz * h;
                Collide(w);
                if (w.swoopUntil > tick && w.state == "fly" && SwoopHit(w, v0, cmd)) return;
            }
            WebCheck(w, p0);
            CupCheck(w);
            if (OnHotGrate(w)) { Die(w, "burned on a grill", null); return; } // T1-10

            // grounded without fuel: starvation clock
            if (w.energy <= 0 && w.y <= T.wasp.radius + 1e-6)
            {
                if (++w.groundTicks > T.wasp.starveTicks) Die(w, "starved", null);
            }
            else w.groundTicks = 0;
        }

        /// The wind a wasp feels: the day's wind, gusting, falling off toward the ground, times the share it cannot hold against
        internal V3 Drift(Wasp w)
        {
            var wind = Wind; int t = tick;
            Num gust = 1 + WeatherToday.gust * DSin((Num)t * 0.031) * DSin((Num)t * 0.0137 + 1); // hard in a storm (T2-2)
            Num k = T.wind.felt * gust * Clamp01(w.y / T.wind.refHeight) * Spw(w).felt;
            if (settings.terrain != 0) k *= 1 + T.terrain.exposure * Max(0, Ground(w.x, w.z)); // windier on a rise (T2-6)
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

        internal void Collide(Wasp w)
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
                // pitched roofs: the slope on the wasp's side, the gable ends, and the underside where it overhangs the walls
                foreach (var f in RoofsOf(rec))
                {
                    var r = RoofLocal(f, w.x, w.y, w.z); Num au = Abs(r.u), av = Abs(r.v);
                    if (av > f.half + R || au > f.S + R || r.y < -R || r.y > f.rise + R) continue;
                    Num su = r.u < 0 ? -1 : 1, dS = (f.rise * (au - f.S) + f.S * r.y) / f.L, dE = av - f.half;
                    Num k = dS, nu = su * f.rise / f.L, ny = f.S / f.L, nv = 0;
                    if (dE > k) { k = dE; nu = 0; ny = 0; nv = r.v < 0 ? -1 : 1; }
                    if ((au > f.wall || av > f.wallHalf) && -r.y > k) { k = -r.y; nu = 0; ny = -1; nv = 0; }
                    if (k >= R) continue;
                    Num push = R - k, nx = f.alongX ? nv : nu, nz = f.alongX ? nu : nv;
                    w.x += nx * push; w.y += ny * push; w.z += nz * push;
                    Num vn = w.vx * nx + w.vy * ny + w.vz * nz;
                    if (vn < 0) { w.vx -= vn * nx; w.vy -= vn * ny; w.vz -= vn * nz; }
                }
                // hollow cups: thin walls, open at the top unless covered (GDD 7.5)
                {
                    string ck = rec.key; Num rIn = T.cup.r - T.cup.wall, mid = (rIn + T.cup.r) / 2;
                    foreach (var cp in CupsIn(rec))
                    {
                        Num hx = w.x - cp.x, hz = w.z - cp.z, hd = Sqrt(hx * hx + hz * hz);
                        if (hd > T.cup.r + R || w.y > T.cup.rim + R || w.y < T.cup.@base || CanSpilled(ck, cp.i)) continue;
                        bool cov = CupCovered(ck, cp.i);
                        if (w.y > T.cup.rim) { if (cov || hd > rIn - R) { w.y = T.cup.rim + R; if (w.vy < 0) w.vy = 0; } continue; }
                        if (hd == 0) continue;
                        Num ux = hx / hd, uz = hz / hd;
                        if (hd >= mid)
                        {
                            if (hd < T.cup.r + R) { w.x = cp.x + ux * (T.cup.r + R); w.z = cp.z + uz * (T.cup.r + R); Num vn = w.vx * ux + w.vz * uz; if (vn < 0) { w.vx -= vn * ux; w.vz -= vn * uz; } }
                        }
                        else
                        {
                            if (hd > rIn - R) { w.x = cp.x + ux * (rIn - R); w.z = cp.z + uz * (rIn - R); Num vn = w.vx * ux + w.vz * uz; if (vn > 0) { w.vx -= vn * ux; w.vz -= vn * uz; } }
                            if (cov && w.y > T.cup.rim - R) { w.y = T.cup.rim - R; if (w.vy > 0) w.vy = 0; }
                        }
                    }
                }
                foreach (var cy in CylsOf(rec))
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
                // a walker moves in steps (20 Hz): their pace over one step is how far off they may be between them (GDD 7.9)
                Num slack = Sqrt(Sq(hm.vx) + Sq(hm.vz)) * 3 * T.DT;
                foreach (var part in hm.PartsNow)
                {
                    var q = Body.SegClosest(part.a, part.b, lp);
                    Num ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z;
                    Num d = Sqrt(ex * ex + ey * ey + ez * ez);
                    if (d == 0) continue;
                    Num gap = d - part.r - R - slack;
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
            Num pain = Spw(w).pain; // a hornet's sting hurts more (GDD 6.8)
            Publish(new NetEv { type = "sting", waspId = w.id, driven = driven, humanHex = hm.hex, zone = zone, under = under, swats = sw, panicGain = Min(1, plan.panicGain * pain), pain = pain, flee = plan.flee, sx = w.x, sz = w.z });
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
                Deepen(w, hm, a);
            }
            if ((!holding && held >= T.sting.jabTicks) || a.deepened) Detach(w, null);
        }

        /// the sting driven home: more venom, more pain (GDD 7.4)
        void Deepen(Wasp w, Human hm, Attach a)
        {
            Num pain = Spw(w).pain;
            Num extra = (T.resolve.fullPain - T.resolve.jabPain) * Body.ZONES[a.zone].sens * hm.tr.panicSusceptibility * pain;
            w.venom = Max(0, w.venom - T.venom.deepen);
            stats.full++;
            Xp(w, "full");
            Publish(new NetEv { type = "deepen", humanHex = hm.hex, zone = a.zone, extra = extra, pain = pain, sx = w.x, sz = w.z });
        }

        void Detach(Wasp w, string why)
        {
            var a = w.attach; var hm = a != null ? HumanByHex(a.hex) : null;
            if (hm != null)
            {
                var n = Body.DirToWorld(hm.F, a.n);
                w.vx = n.x * T.wasp.pushOff; w.vy = n.y * T.wasp.pushOff + 0.2; w.vz = n.z * T.wasp.pushOff;
            }
            // a honeybee's barbed sting stays in the skin and pumps the rest of its venom in; the bee dies of it (T2-11)
            if (a != null && Spw(w).barbed != 0 && w.caste != "queen") { if (hm != null && !a.deepened) Deepen(w, hm, a); w.spent = true; }
            w.attach = null;
            w.state = "fly";
            Emit("detach", ("id", w.id), ("why", why));
            if (w.id != drivenId && w.ai.mode == "attack") AiAfterSting(w);
        }

        // ---------------- interactions (E): crawl under, catch prey, chew pulp

        internal void Interact(Wasp w)
        {
            if (w.caste == "male") { var mc = w.contact; if (mc != null && w.state == "fly") PerchOn(w, mc.humanHex, mc.zone, mc.surf, mc.n, mc.part); return; } // a male does no work (T2-3)
            if (w.caste == "queen" && !colony.sited) { var site = SiteNear(w); if (site != null) { FoundNest(w, site); return; } }
            if (w.caste != "queen" && Spw(w).perennial == 0 && SeasonFrac >= T.season.reproStart && colony.mated + colony.gynes >= 1)
            {
                var hs = HiberNear(w);
                if (hs != null) { hiberPick = new HiberPick { season = season.n, x = hs.x, z = hs.z, kind = hs.kind }; Emit("hiberScouted", ("kind", hs.kind), ("q", hs.q)); return; }
            }
            var hb = w.carry == null && w.caste != "queen" ? HiveEntranceNear(w) : null;
            if (hb != null) { StartRob(w, hb.Value.key, hb.Value.h); return; }
            var SP = Spw(w);
            var rv = SP.hunts != 0 ? RivalNestNear(w) : null; // bees raid no wasp nest (T2-11)
            if (rv != null && w.carry == null) { Raid(w, rv); return; }
            var pnest = w.carry == null && SP.hunts != 0 ? PeerNestNear(w) : null;
            if (pnest != null) { RaidPeer(w, pnest.Value.peer); return; }
            var c = w.contact;
            if (c != null && c.opening >= 0 && w.carry == null) { EnterUnder(w, c.humanHex, c.opening); return; }
            if (c != null && w.state == "fly") { PerchOn(w, c.humanHex, c.zone, c.surf, c.n, c.part); return; }
            var prey = w.carry == null ? PreyNear(w) : null; // one load at a time (T1-20)
            if (prey != null) { Catch(w, prey); return; }
            if (w.carry == null && SP.hunts != 0 && BaitNear(w) != null) { TakeBait(w); return; }
            var wet = w.carry == null ? WaterNear(w) : null; // T2-1
            if (wet != null) { w.state = "chewing"; w.chew = 0; w.chewAt = new WoodSpot { key = wet.Value.key, i = wet.Value.i, water = true }; w.vx = w.vy = w.vz = 0; Emit("drinkStart", ("id", w.id)); return; }
            var wood = w.carry == null && SP.wood != 0 ? WoodNear(w) : null;
            if (wood != null) { w.state = "chewing"; w.chew = 0; w.chewAt = wood; w.vx = w.vy = w.vz = 0; Emit("chewStart", ("id", w.id)); return; }
            if (w.carry != null) Emit("carrying", ("kind", w.carry.kind));
        }

        internal void Hints(Wasp w)
        {
            var c = w.contact; var SP = Spw(w);
            var pn = w.carry == null ? PreyNear(w) : null;
            hint = new Hint
            {
                opening = c != null && c.opening >= 0 ? c.openingKey : null,
                prey = pn?.kind,
                bait = w.carry == null && SP.hunts != 0 && BaitNear(w) != null,
                wood = w.carry == null && c == null && SP.wood != 0 && WoodNear(w) != null,
                water = w.carry == null && c == null && WaterNear(w) != null,
                nest = D2(w, nest.entrance) < 0.4 * 0.4,
                site = w.caste == "queen" && !colony.sited ? SiteNear(w)?.type : null,
                rival = w.carry == null && SP.hunts != 0 && RivalNestNear(w) != null,
                raid = w.carry == null && SP.hunts != 0 && w.caste == "worker" ? PeerNestNear(w)?.peer : null,
                hive = w.carry == null && w.caste != "queen" && HiveEntranceNear(w) != null,
                hiber = w.caste != "queen" && SP.perennial == 0 && SeasonFrac >= T.season.reproStart && colony.mated + colony.gynes >= 1 ? HiberNear(w)?.kind : null,
            };
        }

        // ---------------- the swoop (GDD 7.9); see sim.js

        void StartSwoop(Wasp w, Cmd cmd)
        {
            if (!HasSkill(w, "swoop")) return; // the dash is a skill (GDD 6.8)
            if (tick < w.swoopReady || w.energy <= T.swoop.energy || w.bodyT < T.cold.flyBody) return;
            w.yaw = cmd.yawQ * 1e-4; w.pitch = Clamp(cmd.pitchQ * 1e-4, -1.45, 1.45);
            w.swoopUntil = tick + T.swoop.ticks; w.swoopReady = tick + T.swoop.cooldown; w.energy -= T.swoop.energy;
            w.noLandUntil = tick + T.swoop.ticks; // the dash does not settle the gentle way: the slam does
            Emit("swoop", ("id", w.id));
        }
        /// within reach of something during the swoop: prey is caught, a person is perched on and startled, a surface the
        /// wasp flies into is landed on; anyone near a slam is startled too
        bool SwoopHit(Wasp w, V3 v, Cmd cmd)
        {
            Num speed = Sqrt(v.x * v.x + v.y * v.y + v.z * v.z); if (speed == 0) speed = 1;
            string kind = null, personHex = null;
            var prey = w.carry == null ? PreyNear(w, T.swoop.reach) : null;
            if (prey != null) { Catch(w, prey); kind = prey.kind; }
            if (kind == null)
            {
                ContactQuery(w, T.swoop.reach);
                var c = w.contact;
                if (c != null)
                {
                    var hm = HumanByHex(c.humanHex);
                    PerchOn(w, c.humanHex, c.zone, c.surf, c.n, c.part); kind = "person"; personHex = c.humanHex;
                    if (hm != null)
                    {
                        var comps = Companions(hm);
                        var plan = Body.ResolveSting(new StingIn { contactTick = tick, contactPointBody = c.surf, mode = "touch" }, hm.tr, Body.ZONES[c.zone],
                            new StingCtx { clothingStiffness = hm.clothing.stiffness, panic = hm.panic, companions = comps, stung = Wary(hm) });
                        Publish(new NetEv { type = "notice", humanHex = hm.hex, waspId = w.id, zone = c.zone, swats = SwatsOut(plan, hm, comps) });
                        Publish(new NetEv { type = "startle", humanHex = hm.hex, waspId = w.id, amount = T.swoop.panic, x = w.x, z = w.z });
                    }
                }
            }
            if (kind == null)
            {
                var s = StaticSurface(w.P, T.swoop.reach);
                if (s != null && -(v.x * s.nx + v.y * s.ny + v.z * s.nz) >= T.swoop.minInto * speed)
                {
                    w.state = "landed"; w.vx = w.vy = w.vz = 0; w.land = null;
                    Settle(w, s, cmd);
                    Emit("landed", ("id", w.id), ("surface", s.kind), ("swoop", true));
                    kind = s.kind;
                }
            }
            if (kind == null) return false;
            w.swoopUntil = 0;
            foreach (var hm in active)
            {
                if (hm.state == "away" || hm.special || hm.hex == personHex || Sq(hm.x - w.x) + Sq(hm.z - w.z) > T.swoop.scareR * T.swoop.scareR) continue;
                Publish(new NetEv { type = "startle", humanHex = hm.hex, waspId = w.id, amount = T.swoop.nearPanic, x = w.x, z = w.z });
            }
            Emit("slam", ("id", w.id), ("kind", kind), ("driven", w.id == drivenId));
            return true;
        }

        internal PreyHit PreyNear(Wasp w) => PreyNear(w, T.prey.catchDist * Mul(w, "grabR")); // the grab reach skill (GDD 6.8)
        PreyHit PreyNear(Wasp w, Num reach)
        {
            Num r2 = reach * reach; var SP = Spw(w);
            if (SP.hunts == 0) return null; // bees take no prey (T2-11)
            // a hornet takes another colony's wasp on the wing (T2-10)
            if (SP.fight > 0) foreach (var x in wasps) if (IsRival(x) && Spw(x).fight < SP.fight && (x.state == "fly" || x.state == "landed") && D2(w, x.P) <= r2) return new PreyHit { kind = "wasp", id = x.id, protein = T.moths.waspProtein };
            foreach (var rec in activeChunks)
            {
                if (!Near(rec, w.x, w.z)) { CS(rec.key); continue; } // the JS creates chunk state here, and the state hash sees it
                foreach (var mo in MothsIn(rec)) if (D2(w, mo.p) <= r2) return new PreyHit { kind = "moth", key = rec.key, i = mo.i, protein = T.moths.protein };
                var c = rec.content; string key = rec.key; var st = CS(key);
                for (int i = 0; i < c.flies.Count; i++)
                {
                    if ((st.caughtFly.TryGetValue(i, out var cf) ? cf : 0) > tick || !FlyActive(rec, i)) continue;
                    if (D2(w, FlyPos(c.flies[i], tick)) <= r2) return new PreyHit { kind = "fly", key = key, i = i, protein = T.prey.flyProtein };
                }
                for (int i = 0; i < c.caterpillars.Count; i++)
                {
                    if (st.caughtCat.ContainsKey(i) || !CatActive(rec, i)) continue;
                    var cp = c.caterpillars[i];
                    if (D2(w, new V3(cp.x, cp.y, cp.z)) <= r2 * 2) return new PreyHit { kind = "caterpillar", key = key, i = i, protein = T.prey.caterpillarProtein };
                }
                foreach (var cr in CarrionIn(rec)) if (D2(w, new V3(cr.x, cr.y, cr.z)) <= Sq(Max(reach, T.eco.carrionReach))) return new PreyHit { kind = "carrion", key = key, i = (int)cr.d, protein = T.eco.carrionProtein };
                foreach (var mt in MeatIn(rec)) if (D2(w, new V3(mt.x, mt.y, mt.z)) <= Sq(Max(reach, T.bbq.reach))) return new PreyHit { kind = "meat", key = key, i = mt.i, protein = T.bbq.meatProtein };
                var hives = HivesIn(rec);
                for (int h = 0; h < hives.Count; h++)
                {
                    var hv = hives[h]; st.beeLost.TryGetValue(h, out var lost); var al = hiveAlarms.Get(rec.Sub(h));
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
            if (p.kind == "wasp")
            { // killed and carried off, not a pickup anyone else could make
                var x = WaspById(p.id);
                if (x != null) Die(x, "taken by a hornet", null);
                w.carry = new Carry { kind = "protein", amount = p.protein, what = "wasp" };
                stats.caught++;
                Xp(w, "catch");
                Emit("caught", ("id", w.id), ("kind", "wasp"));
                return;
            }
            var st = CS(p.key);
            if (p.kind == "fly") st.caughtFly[p.i] = tick + T.prey.flyRespawnTicks;
            else if (p.kind == "caterpillar") st.caughtCat[p.i] = 1;
            else if (p.kind == "carrion") { st.carrion ??= new Dictionary<int, int>(); st.carrion[p.i] = (st.carrion.TryGetValue(p.i, out var cn) ? cn : 0) + 1; }
            else if (p.kind == "meat") { st.meat ??= new Dictionary<int, int>(); st.meat[p.i] = (st.meat.TryGetValue(p.i, out var mn) ? mn : 0) + 1; }
            else if (p.kind == "moth") (st.caughtMoth ??= new Dictionary<int, long>())[p.i] = tick + T.moths.respawnTicks;
            else
            {
                if (!st.beeLost.TryGetValue(p.hive, out var l)) st.beeLost[p.hive] = l = new Dictionary<int, int>();
                l[p.i] = 1;
                AlarmHive(p.key, p.hive, w, T.bees.catchAlarmRadius * 3);
            }
            w.carry = new Carry { kind = "protein", amount = p.protein, what = p.kind };
            Pickup(w, new NetEv { type = "caught", key = p.key, what = p.kind, i = p.i, hive = p.hive });
            stats.caught++;
            Xp(w, "catch");
            Emit("caught", ("id", w.id), ("kind", p.kind));
        }

        /// wood within reach: a box with pulp left ({ key, i }), or a tree (i = -1), or null
        WoodSpot WoodNear(Wasp w)
        {
            Num reach = T.pulp.reach + T.wasp.radius;
            foreach (var rec in activeChunks)
            {
                if (!Near(rec, w.x, w.z)) continue;
                var boxes = rec.content.boxes;
                for (int i = 0; i < boxes.Count; i++)
                {
                    var b = boxes[i];
                    if (!b.wood || b.hive) continue;
                    Num qx = Clamp(w.x, b.minx, b.maxx), qy = Clamp(w.y, b.miny, b.maxy), qz = Clamp(w.z, b.minz, b.maxz);
                    Num dx = w.x - qx, dy = w.y - qy, dz = w.z - qz;
                    if (dx * dx + dy * dy + dz * dz <= reach * reach && PulpLeft(rec.key, i) > 0) return new WoodSpot { key = rec.key, i = i };
                }
                foreach (var cy in rec.content.cylinders)
                {
                    if (!cy.wood || w.y > cy.h) continue; // a birdbath is not wood (T2-1)
                    Num dx = w.x - cy.x, dz = w.z - cy.z, d = Sqrt(dx * dx + dz * dz) - cy.r;
                    if (d <= reach) return new WoodSpot { key = rec.key, i = -1 };
                }
            }
            return null;
        }
        // ---------------- water (GDD 6.2, T2-1); see sim.js

        /// the rainy day whose puddles lie at a minute, or -1
        public long PuddleDay(long m)
        {
            for (long d = DayOf(m); d >= DayOf(m) - 1; d--)
            {
                if (d < 0) continue;
                var w = World.Weather(seed, d); long t0 = d * 1440;
                if (w.rain && m >= t0 + w.rainStart + T.water.wetAfter && m < t0 + w.rainEnd + T.water.dryMinutes) return d;
            }
            return -1;
        }
        public long PuddleDay() => PuddleDay(minute);
        /// the puddles a rainy day leaves in a chunk: i = day * 16 + k
        public List<WaterSrc> PuddlesIn(ChunkRec rec, long d)
        {
            if (rec.puddles != null && rec.puddleDay == d) return rec.puddles;
            var c = rec.content; long sd = (long)(seed & 0xffffffffUL); Num CSz = T.chunk.size; var list = new List<WaterSrc>();
            var paved = new List<Rect>(c.roads); paved.AddRange(c.lots); paved.AddRange(c.plazas);
            int pn = (int)Floor(T.water.puddles * settings.water) * (World.Weather(seed, d).pour > 1 ? 2 : 1); // a storm leaves twice as many (T2-2); the water modifier (T2-6)
            for (int k = 0; k < pn; k++)
            {
                Num U(int j) => HSeq(sd, rec.cx, rec.cz, d, k, 990 + j);
                Num x, z;
                if (paved.Count > 0) { var p = paved[(int)Floor(U(0) * paved.Count)]; x = p.minx + (p.maxx - p.minx) * U(1); z = p.minz + (p.maxz - p.minz) * U(2); }
                else { x = (rec.cx + (U(1) - 0.5) * 0.9) * CSz; z = (rec.cz + (U(2) - 0.5) * 0.9) * CSz; }
                if (settings.terrain != 0 && paved.Count == 0) // on open ground, rain settles in the lowest of a few spots (T2-6)
                {
                    Num lo = Ground(x, z);
                    for (int j = 1; j < T.terrain.poolTries; j++) { Num qx = (rec.cx + (U(10 + j * 2) - 0.5) * 0.9) * CSz, qz = (rec.cz + (U(11 + j * 2) - 0.5) * 0.9) * CSz, g = Ground(qx, qz); if (g < lo) { lo = g; x = qx; z = qz; } }
                }
                Num r = T.water.puddleRMin + (T.water.puddleRMax - T.water.puddleRMin) * U(3);
                bool blocked = false;
                foreach (var b in c.boxes) if (x > b.minx - r && x < b.maxx + r && z > b.minz - r && z < b.maxz + r) { blocked = true; break; }
                if (!blocked) foreach (var cy in c.cylinders) if (Sq(x - cy.x) + Sq(z - cy.z) < Sq(cy.r + r)) { blocked = true; break; }
                if (blocked) continue;
                list.Add(new WaterSrc { x = x, y = 0.003, z = z, r = r, kind = "puddle", i = (int)(d * 16 + k) });
            }
            rec.puddleDay = d; rec.puddles = list;
            return list;
        }
        /// every water source in a chunk now: its birdbaths, and puddles while the ground is wet
        public List<WaterSrc> WaterIn(ChunkRec rec) => WaterIn(rec, minute);
        public List<WaterSrc> WaterIn(ChunkRec rec, long m)
        {
            var o = new List<WaterSrc>();
            for (int i = 0; i < rec.content.baths.Count; i++) { var b = rec.content.baths[i]; o.Add(new WaterSrc { x = b.x, y = b.h, z = b.z, r = b.r, kind = "bath", i = i }); }
            long d = PuddleDay(m);
            if (d >= 0) o.AddRange(PuddlesIn(rec, d));
            return o;
        }
        /// water a wasp can drink from where it is: over the surface, close to it
        internal (string key, int i, string kind)? WaterNear(V3 w)
        {
            Num reach = T.wasp.radius + T.water.reach;
            foreach (var rec in activeChunks)
                foreach (var s in WaterIn(rec))
                {
                    Num dy = w.y - s.y;
                    if (dy < -0.005 || dy > reach || Sq(w.x - s.x) + Sq(w.z - s.z) > s.r * s.r) continue;
                    return (rec.key, s.i, s.kind);
                }
            return null;
        }
        internal (string key, int i, string kind)? WaterNear(Wasp w) => WaterNear(new V3(w.x, w.y, w.z));

        /// pulp in a wooden box (T1-12): by its longest side, less what wasps have taken
        public int PulpLoads(Box b) => System.Math.Max(T.pulp.minLoads, (int)Rnd(Max(b.maxx - b.minx, b.maxz - b.minz) * T.pulp.perMeter));
        public int PulpLeft(string key, int i)
        {
            if (!records.TryGet(key, out var rec) || i < 0 || i >= rec.content.boxes.Count) return 0;
            chunkState.TryGet(key, out var st);
            return PulpLoads(rec.content.boxes[i]) - (st?.pulp != null && st.pulp.TryGetValue(i, out var n) ? n : 0);
        }
        /// a load of pulp chewed off: from a box it is taken through the chunk authority like any pickup (T1-19)
        internal bool TakePulp(Wasp w, WoodSpot at)
        {
            if (at != null && at.i >= 0)
            {
                if (PulpLeft(at.key, at.i) <= 0) { Emit("pulpGone", ("id", w.id)); return false; }
                w.carry = new Carry { kind = "pulp", amount = T.pulp.amount, what = "pulp" };
                var st = CS(at.key); st.pulp ??= new Dictionary<int, int>();
                st.pulp[at.i] = (st.pulp.TryGetValue(at.i, out var n) ? n : 0) + 1;
                Pickup(w, new NetEv { type = "caught", key = at.key, what = "pulp", i = at.i });
            }
            else w.carry = new Carry { kind = "pulp", amount = T.pulp.amount, what = "pulp" };
            CS(at != null ? at.key : ChunkKey(ChunkOf(w.x), ChunkOf(w.z))).chewed++;
            Emit("chewed", ("id", w.id));
            return true;
        }

        void ChewStep(Wasp w, Cmd cmd, bool driven)
        {
            bool holding = driven ? (cmd.act & Act.Interact) != 0 : true;
            if (!holding) { w.state = "fly"; Emit("chewCancel", ("id", w.id)); return; }
            w.chew++;
            w.energy -= T.energy.cruisePerSec * T.DT * T.energy.hoverShare;
            if (w.chewAt != null && w.chewAt.water) // a load of water (T2-1)
            {
                if (w.chew < T.water.fillTicks) return;
                w.state = "fly"; w.chewAt = null;
                w.carry = new Carry { kind = "water", amount = T.water.amount, what = "water" };
                Emit("watered", ("id", w.id));
                return;
            }
            if (w.chew >= T.pulp.chewTicks)
            {
                w.state = "fly";
                TakePulp(w, w.chewAt);
                w.chewAt = null;
            }
        }

        void Feed(Wasp w, bool driven)
        {
            Num fr = T.energy.feedDist * Mul(w, "feedR"), d2max = fr * fr; // the feeding reach skill (GDD 6.8)
            if (driven) feeding = false;
            if (Spw(w).pollen != 0 && w.carry == null && w.caste == "worker") Pollen(w, driven, d2max);
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
                // a drink is reached at its surface, inside the cup (GDD 7.5)
                foreach (var cp in CupsIn(rec))
                {
                    if (CanSpilled(key, cp.i) || CupCovered(key, cp.i)) continue; // knocked over, or covered (GDD 8.10)
                    if (D2(w, new V3(cp.x, cp.level, cp.z)) > d2max) continue;
                    Num add = T.energy.refuelPerSec * T.DT;
                    if (w.energy < 1) w.energy = Min(1, w.energy + add);
                    else if (!driven) w.ai.cargo = Min(1, w.ai.cargo + add);
                    if (driven) feeding = true;
                    w.ai.atFood = "can";
                    // an open drink is a trap of its own: a feeding wasp may slip in (GDD 7.5, T1-3)
                    if (H32(w.id, tick, 53) < T.drown.chancePerSec * T.DT) FallIn(w, cp, key, driven);
                    return;
                }
                // flowers in bloom with nectar left (T1-8): a sip draws the flower down
                for (int i = 0; i < c.flowers.Count; i++)
                {
                    var f = c.flowers[i];
                    // over the flower, or standing anywhere on its head (landed under it too)
                    bool onHead = w.state == "landed" && Sq(w.x - f.x) + Sq(w.y - f.y) + Sq(w.z - f.z) <= Sq(T.land.headR + T.wasp.radius + 0.006);
                    if ((!onHead && Sq(w.x - f.x) + Sq(w.y - f.y - 0.02) + Sq(w.z - f.z) > d2max) || !InBloom(rec, i)) continue;
                    if (NectarAt(rec, i) <= 0) continue;
                    Num add = T.energy.refuelPerSec * T.eco.flowerRate * T.DT;
                    if (w.energy < 1) w.energy = Min(1, w.energy + add);
                    else if (!driven) w.ai.cargo = Min(1, w.ai.cargo + add);
                    if (driven) feeding = true;
                    w.ai.atFood = "flower";
                    Num take = T.eco.sipPerSec * T.DT;
                    Sip(key, i, take);
                    if (net)
                    {
                        // tell the other peers in sips of a tenth (T1-8)
                        var sp = w.sipPend;
                        void Out(SipPend q) => Publish(new NetEv { type = "sip", key = q.key, i = q.i, amount = q.amount, waspId = w.id, x = q.x, y = q.y, z = q.z });
                        if (sp != null && (sp.key != key || sp.i != i)) { Out(sp); sp = null; }
                        if (sp == null) sp = w.sipPend = new SipPend { key = key, i = i, amount = 0 };
                        sp.amount += take; sp.x = w.x; sp.y = w.y; sp.z = w.z; // where it last drank, for the check (T1-20)
                        if (sp.amount >= 0.1) { Out(sp); w.sipPend = null; }
                    }
                    return;
                }
                for (int i = 0; i < c.sugar.Count; i++)
                {
                    var s = c.sugar[i];
                    if (s.kind == "can" || s.kind == "flower") continue; // cups and flowers are handled above
                    if (FeedAt(w, driven, s.x, s.y, s.z, s.rate, s.kind, d2max, key)) return;
                }
                foreach (var s in SpillsIn(key)) if (FeedAt(w, driven, s.x, s.y, s.z, s.rate, s.kind, d2max, key)) return;
                foreach (var s in FruitIn(rec)) if (FeedAt(w, driven, s.x, s.y, s.z, s.rate, s.kind, d2max, key)) return;
            }
            w.ai.atFood = null;
        }

        /// a bee at a flower in bloom packs pollen into its leg baskets: a load of protein after a few seconds (T2-11)
        void Pollen(Wasp w, bool driven, Num d2max)
        {
            foreach (var rec in activeChunks)
            {
                if (!Near(rec, w.x, w.z)) continue;
                var fl = rec.content.flowers;
                for (int i = 0; i < fl.Count; i++)
                {
                    var f = fl[i];
                    bool onHead = w.state == "landed" && Sq(w.x - f.x) + Sq(w.y - f.y) + Sq(w.z - f.z) <= Sq(T.land.headR + T.wasp.radius + 0.006);
                    if ((!onHead && Sq(w.x - f.x) + Sq(w.y - f.y - 0.02) + Sq(w.z - f.z) > d2max) || !InBloom(rec, i)) continue;
                    w.pollenT++;
                    if (w.pollenT >= T.hive.pollenSecs * 60) { w.pollenT = 0; w.carry = new Carry { kind = "protein", amount = T.hive.pollenLoad, what = "pollen" }; Emit("pollen", ("id", w.id), ("driven", driven)); }
                    return;
                }
            }
        }

        bool FeedAt(Wasp w, bool driven, Num x, Num y, Num z, Num rate, string kind, Num d2max, string key)
        {
            if (D2(w, new V3(x, y, z)) > d2max) return false;
            Num add = T.energy.refuelPerSec * rate * T.DT;
            if (w.energy < 1) w.energy = Min(1, w.energy + add);
            else if (!driven) w.ai.cargo = Min(1, w.ai.cargo + add);
            if (driven) feeding = true;
            w.ai.atFood = kind;
            return true;
        }

        // ---------------- feral hives and robbing (GDD 9.1, T1-9)

        public bool FeralHollow(ChunkRec rec, int j) => HSeq((long)(seed & 0xffffffffUL), rec.cx, rec.cz, j, 981) < T.feral.hollowShare;
        public bool FeralWall(ChunkRec rec, int si) => HSeq((long)(seed & 0xffffffffUL), rec.cx, rec.cz, si, 982) < T.feral.wallShare;
        /// The chunk's hives: the managed boxes from the generator, then wild colonies in hollow trees and shed walls,
        /// derived from the seed like the nest sites. Indices are stable.
        public List<Hive> HivesIn(ChunkRec rec)
        {
            if (rec.hives != null) return rec.hives;
            long sd = (long)(seed & 0xffffffffUL); var c = rec.content; var list = new List<Hive>(c.hives);
            Num U(long a, long b) => HSeq(sd, rec.cx, rec.cz, a, b, 983);
            void Wild(Num x, Num y, Num z, Num nx, Num nz, int slot)
            {
                var hv = new Hive { x = x, z = z, fx = nx, fz = nz, ex = x + nx * 0.03, ey = y, ez = z + nz * 0.03, slot = slot, feral = true };
                for (int k = 0; k < T.feral.guards + T.feral.foragers; k++)
                {
                    long s = slot * 64 + k * 6;
                    if (k < T.feral.guards) { hv.bees.Add(new Bee { guard = true, p = U(s, 0) * 6.28, w = (1.5 + 1.5 * U(s, 1)) * (k % 2 != 0 ? 1 : -1) }); continue; }
                    Num fx, fy, fz;
                    if (c.flowers.Count > 0) { var f = c.flowers[(int)Floor(U(s, 2) * c.flowers.Count)]; fx = f.x; fy = f.y; fz = f.z; } else { fx = x + 8; fy = 0.4; fz = z + 8; }
                    hv.bees.Add(new Bee { guard = false, tx = fx, ty = fy, tz = fz, period = 1500 + (int)Floor(U(s, 3) * 1500), phase = (int)Floor(U(s, 4) * 3000), p = U(s, 5) * 6.28 });
                }
                list.Add(hv);
            }
            var hol = SitesIn(rec).hollows;
            for (int j = 0; j < hol.Count; j++)
            {
                if (!FeralHollow(rec, j)) continue;
                var (h, t) = hol[j];
                Num dx = h.x - t.x, dz = h.z - t.z, d = Sqrt(dx * dx + dz * dz); if (d == 0) d = 1;
                Wild(h.x, h.y, h.z, dx / d, dz / d, 100 + j);
            }
            for (int si = 0; si < c.sheds.Count; si++)
            {
                if (!FeralWall(rec, si)) continue;
                var p = World.ShedSites(c.sheds[si]).wall;
                Wild(p.x, p.y, p.z, p.nx, p.nz, 200 + si);
            }
            return rec.hives = list;
        }
        public int HiveLoadsLeft(string key, int h) => T.feral.loadsPerDay - (chunkState.TryGet(key, out var st) && st.robbed != null && st.robbed.TryGetValue(h, out var n) ? n : 0);
        (string key, int h)? HiveEntranceNear(Wasp w)
        {
            Num r2 = T.feral.robReach * T.feral.robReach;
            foreach (var rec in activeChunks)
            {
                var hives = HivesIn(rec);
                for (int h = 0; h < hives.Count; h++) if (D2(w, new V3(hives[h].ex, hives[h].ey, hives[h].ez)) <= r2) return (rec.key, h);
            }
            return null;
        }
        /// in through the entrance: the whole hive is roused
        internal void StartRob(Wasp w, string key, int h)
        {
            var hv = HivesIn(records.Get(key))[h];
            w.state = "robbing"; w.vx = w.vy = w.vz = 0; w.land = null;
            w.x = hv.ex; w.y = hv.ey; w.z = hv.ez;
            w.rob = new Rob { key = key, h = h, progress = 0, prevSting = 1 };
            AlarmHive(key, h, w, T.bees.hiveAlarmRadius);
            Emit("robStart", ("id", w.id), ("driven", w.id == drivenId), ("key", key), ("h", h), ("feral", hv.feral));
        }
        /// Inside: the grab fills over a few seconds, faster for each sting press; any tick the bees may get you;
        /// Space or Shift bails out empty-handed. Out with honey in the crop and a larva, into an alarmed hive's air.
        void RobStep(Wasp w, Cmd cmd, bool driven)
        {
            var r = w.rob; var hv = HivesIn(records.Get(r.key))[r.h];
            void Out() { w.rob = null; w.state = "fly"; w.x = hv.ex + hv.fx * 0.05; w.z = hv.ez + hv.fz * 0.05; w.vx = hv.fx * 1.5; w.vz = hv.fz * 1.5; w.vy = 0.3; w.noLandUntil = tick + T.land.afterTakeoff; }
            if (driven && (cmd.burst != 0 || cmd.my > 0)) { Out(); Emit("robAbort", ("id", w.id)); return; }
            if (H32(w.id, tick, 87) < (T.feral.killOverride ?? T.feral.insideKill) * T.DT) { w.rob = null; Die(w, "stung inside a hive", null); return; }
            r.progress += T.DT / T.feral.robSecs;
            if (driven) { if (cmd.sting != 0 && r.prevSting == 0) r.progress += T.feral.pressGain; r.prevSting = cmd.sting != 0 ? 1 : 0; }
            if (r.progress < 1) return;
            Out();
            if (HiveLoadsLeft(r.key, r.h) <= 0) { Emit("hiveEmpty", ("id", w.id), ("key", r.key), ("h", r.h)); if (!driven) { w.ai.mode = "return"; w.ai.target = null; } return; }
            var st = CS(r.key); st.robbed ??= new Dictionary<int, int>();
            st.robbed[r.h] = (st.robbed.TryGetValue(r.h, out var n) ? n : 0) + 1;
            w.energy = 1; w.ai.cargo = Max(w.ai.cargo, T.feral.honeyCargo);
            if (Spw(w).hunts != 0) w.carry = new Carry { kind = "protein", amount = T.feral.broodProtein, what = "bee brood" }; // a robbing bee takes only honey (T2-11)
            Pickup(w, new NetEv { type = "caught", key = r.key, what = "honey", i = r.h });
            stats.caught++;
            Xp(w, "rob");
            Emit("robbed", ("id", w.id), ("driven", driven), ("key", r.key), ("h", r.h));
            if (!driven) { w.ai.mode = "return"; w.ai.target = null; }
        }

        // ---------------- seasonal ecology (GDD 9.4, T1-8): pure functions of the seed, the chunk and the clock, plus the
        // sips taken (chunk state). The ecology tick of GDD 3.3 is evaluated lazily from the last sip.
        public bool InBloom(ChunkRec rec, int i)
        {
            var f = rec.content.flowers[i]; var w = T.eco.bloom[f.color % T.eco.bloom.Length]; Num frac = SeasonFrac;
            Num j = (HSeq((long)(seed & 0xffffffffUL), rec.cx, rec.cz, i, 971) - 0.5) * 2 * T.eco.bloomJitter;
            return frac >= w[0] + j && frac < w[1] + j;
        }
        /// forager bees working each flower of the chunk (they forage only their own chunk's flowers)
        internal int[] BeeLoad(ChunkRec rec)
        {
            if (rec.beeLoad != null) return rec.beeLoad;
            var c = rec.content; var l = new int[c.flowers.Count];
            for (int i = 0; i < l.Length; i++) { var f = c.flowers[i]; int n = 0; foreach (var hv in HivesIn(rec)) foreach (var b in hv.bees) if (!b.guard && b.tx == f.x && b.tz == f.z) n++; l[i] = n; }
            return rec.beeLoad = l;
        }
        public Num NectarAt(ChunkRec rec, int i)
        {
            if (nectarOverride != null) return nectarOverride(rec, i);
            if (!InBloom(rec, i)) return 0;
            Num net = (T.eco.regenPerDay - T.eco.beeDrawPerDay * BeeLoad(rec)[i]) / 1440;
            if (!chunkState.TryGet(rec.key, out var st) || st.nectar == null || !st.nectar.TryGetValue(i, out var n))
                return net >= 0 ? 1 : Clamp(1 + net * (minute - season.startMinute), 0, 1);
            return Clamp(n.lv + net * (minute - n.m), 0, 1);
        }
        internal void Sip(string key, int i, Num amount)
        {
            if (!records.TryGet(key, out var rec)) return;
            Num lv = Max(0, NectarAt(rec, i) - amount);
            var st = CS(key); st.nectar ??= new Dictionary<int, Nectar>();
            st.nectar[i] = new Nectar { lv = lv, m = minute };
        }
        /// sugar index -> flower index, for the AI's picks (the generator pushes a sugar node right after each flower)
        internal int[] FlowerIdx(ChunkRec rec)
        {
            if (rec.flowerIdx != null) return rec.flowerIdx;
            var l = new int[rec.content.sugar.Count]; int k = 0;
            for (int i = 0; i < l.Length; i++) l[i] = rec.content.sugar[i].kind == "flower" ? k++ : -1;
            return rec.flowerIdx = l;
        }
        public bool CatActive(ChunkRec rec, int i)
        {
            Num frac = SeasonFrac, j = (HSeq((long)(seed & 0xffffffffUL), rec.cx, rec.cz, i, 972) - 0.5) * 2 * T.eco.catJitter;
            return frac >= T.eco.catFrom + j && frac < T.eco.catTo + j;
        }
        public Num FlyShare() => Clamp(T.eco.flyBase + T.eco.flySlope * Clamp(SeasonFrac, 0, 1), 0, 1);
        public bool FlyActive(ChunkRec rec, int i) => IsDaylight(minute) && HSeq((long)(seed & 0xffffffffUL), rec.cx, rec.cz, i, day, 973) < FlyShare(); // flies settle for the night
        /// porch lights (T2-10): one on each house, on a long wall at the middle, burning from dusk to dawn; derived from
        /// the frozen houses, so old worlds have them; moths circle each one, and a hornet takes them
        public List<PorchLight> LightsIn(ChunkRec rec)
        {
            if (rec.lights != null) return rec.lights;
            long sd = (long)(seed & 0xffffffffUL); var list = new List<PorchLight>();
            var sheds = rec.content.sheds;
            for (int si = 0; si < sheds.Count; si++)
            {
                var sh = sheds[si];
                if (!sh.house) continue;
                Num side = HSeq(sd, rec.cx, rec.cz, si, 991) < 0.5 ? -1 : 1; bool alongX = sh.hw >= sh.hd;
                Num nx = alongX ? 0 : side, nz = alongX ? side : 0;
                list.Add(new PorchLight { si = si, x = sh.x + nx * ((alongX ? 0 : sh.hw) + T.moths.@out), y = T.moths.height, z = sh.z + nz * ((alongX ? sh.hd : 0) + T.moths.@out), nx = nx, nz = nz });
            }
            rec.lights = list;
            return list;
        }
        public bool Lit() => !IsDaylight(minute);
        public bool Lit(long m) => !IsDaylight(m);
        /// where moth k of a light is
        public static V3 MothPos(PorchLight l, int k, long tick)
        {
            Num a = (Num)tick * 0.045 * (1 + 0.25 * k) + k * 2.1;
            return new V3(l.x + l.nx * T.moths.orbit * 0.6 + T.moths.orbit * DCos(a), l.y + 0.12 * DSin((Num)tick * 0.07 + k), l.z + l.nz * T.moths.orbit * 0.6 + T.moths.orbit * DSin(a));
        }
        public List<Moth> MothsIn(ChunkRec rec)
        {
            var o = new List<Moth>();
            if (!Lit() || Raining) return o;
            Dictionary<int, long> cm = chunkState.TryGet(rec.key, out var st) ? st.caughtMoth : null;
            var L = LightsIn(rec);
            for (int li = 0; li < L.Count; li++) for (int k = 0; k < T.moths.perLight; k++) { int i = li * T.moths.perLight + k; if (!(cm != null && cm.TryGetValue(i, out var until) && until > tick)) o.Add(new Moth { i = i, p = MothPos(L[li], k, tick) }); }
            return o;
        }
        /// carrion: some days a dead mouse or bird lies in a chunk for a few days, good for a few loads of meat
        public List<Carrion> CarrionIn(ChunkRec rec)
        {
            if (carrionOverride != null) return carrionOverride(rec);
            var o = new List<Carrion>();
            chunkState.TryGet(rec.key, out var st);
            for (long d = day - T.eco.carrionDays + 1; d <= day; d++)
            {
                var p = CarrionSpot(rec.cx, rec.cz, d);
                if (p == null) continue;
                int taken = st != null && st.carrion != null && st.carrion.TryGetValue((int)d, out var tk) ? tk : 0;
                int left = T.eco.carrionLoads - taken;
                if (left <= 0) continue;
                o.Add(new Carrion { x = p.Value.x, y = p.Value.y, z = p.Value.z, d = d, left = left });
            }
            return o;
        }
        /// where the carrion of day d lies in a chunk, if that day has any: a pure function of the seed
        public V3? CarrionSpot(int cx, int cz, long d)
        {
            if (carrionSpotOverride != null) return carrionSpotOverride(cx, cz, d);
            long sd = (long)(seed & 0xffffffffUL); Num CSz = T.chunk.size;
            if (d < 0 || HSeq(sd, cx, cz, d, 974) >= T.eco.carrionChance) return null;
            return new V3((cx + (HSeq(sd, cx, cz, d, 975) - 0.5) * 0.8) * CSz, 0.03, (cz + (HSeq(sd, cx, cz, d, 976) - 0.5) * 0.8) * CSz);
        }
        /// what the season offers the abstract foragers: multipliers on sugar and protein income
        public (Num sugar, Num protein) EcoAvail()
        {
            Num f = Clamp(SeasonFrac, 0, 1); int nb = 0;
            foreach (var w in T.eco.bloom) if (f >= w[0] && f < w[1]) nb++;
            Num bloom = (Num)nb / T.eco.bloom.Length;
            Num sugar = T.eco.sugarBase + T.eco.sugarBloom * bloom + (f >= T.fruit.startFrac ? T.eco.sugarFruit : 0);
            Num protein = T.eco.protBase + (f >= T.eco.catFrom && f < T.eco.catTo ? T.eco.protCat : 0) + T.eco.protFly * FlyShare();
            return (sugar, protein);
        }

        void FallIn(Wasp w, Cup cup, string key, bool driven)
        {
            w.state = "drowning"; w.vx = w.vy = w.vz = 0; w.land = null;
            w.x = cup.x; w.y = cup.level; w.z = cup.z;
            w.drown = new Drown { key = key, i = cup.i, until = tick + T.drown.ticks, progress = 0, prevBurst = 1 };
            Emit("fellIn", ("id", w.id), ("driven", driven));
        }

        /// Cups (GDD 7.5): one per can on a table, a pure function of the seed and the chunk, cached on the chunk
        /// record (never saved). The drink level is set by hash; the rim and walls are the same for every cup.
        public List<Cup> CupsIn(ChunkRec rec)
        {
            if (rec.cups != null) return rec.cups;
            long sd = (long)(seed & 0xffffffffUL); Num lo = T.cup.@base + 0.006, span = T.cup.rim - lo;
            var l = new List<Cup>();
            for (int i = 0; i < rec.content.cans.Count; i++) { var cn = rec.content.cans[i]; l.Add(new Cup { x = cn.x, z = cn.z, i = i, level = lo + (T.cup.fillMin + T.cup.fillSpan * HSeq(sd, rec.cx, rec.cz, i, 961)) * span }); }
            rec.cups = l;
            return l;
        }
        /// a hand over it (a person who saw a wasp go in) or a lid (level 2)
        public bool CupCovered(string key, int i)
        {
            if (EscLevel(key) >= 2) return true;
            return chunkState.TryGet(key, out var st) && st.cover != null && st.cover.TryGetValue(i, out var u) && u > tick;
        }
        /// the cup a point is inside (below the rim, within the wall), if any
        internal (string key, Cup cup)? InCup(V3 p)
        {
            Num rIn = T.cup.r - T.cup.wall;
            if (p.y >= T.cup.rim || p.y <= T.cup.@base) return null;
            foreach (var rec in activeChunks)
            {
                string key = rec.key;
                foreach (var cp in CupsIn(rec))
                {
                    if (Sq(p.x - cp.x) + Sq(p.z - cp.z) >= rIn * rIn || CanSpilled(key, cp.i)) continue;
                    return (key, cp);
                }
            }
            return null;
        }
        /// Inside a cup: touching the drink pulls a wasp in; a covered cup shuts it in to drown. True if it did.
        bool CupCheck(Wasp w)
        {
            if (w.state != "fly" && w.state != "stunned" && w.state != "landed") return false;
            var k = InCup(w.P);
            if (k == null) return false;
            var (key, cup) = k.Value;
            bool driven = w.id == drivenId;
            if (CupCovered(key, cup.i))
            {
                w.state = "trapped"; w.stateTicks = T.cup.drownTicks; w.trapCause = "drowned under a lid"; w.vx = w.vy = w.vz = 0; w.land = null;
                Emit("coveredIn", ("id", w.id), ("driven", driven), ("key", key), ("i", cup.i));
                return true;
            }
            if (w.y - T.wasp.radius < cup.level) { FallIn(w, cup, key, driven); return true; }
            return false;
        }

        /// Mash burst to climb out before the drink takes you; AI wasps get a small chance each tick
        void DrownStep(Wasp w, Cmd cmd, bool driven)
        {
            var d = w.drown;
            if (driven) { int press = cmd.burst != 0 || cmd.my > 0 ? 1 : 0; if (press != 0 && d.prevBurst == 0) d.progress += T.drown.escapePerPress; d.prevBurst = press; } // Shift or Space
            else if (H32(w.id, tick, 57) < T.drown.aiEscape) d.progress = 1;
            if (d.progress >= 1)
            {
                // out over the rim and down the outside of the cup (GDD 7.5), the way it faces (see sim.js)
                Cup cp = d.i >= 0 && records.TryGet(d.key, out var drec) ? CupsIn(drec)[d.i] : null;
                w.drown = null; w.state = "stunned"; w.stateTicks = 30;
                if (cp != null)
                {
                    Num sx = DSin(w.yaw), sz = DCos(w.yaw), o = T.cup.r + T.wasp.radius + 0.012;
                    w.x = cp.x + sx * o; w.y = T.cup.rim + T.wasp.radius; w.z = cp.z + sz * o;
                    w.vx = sx * 0.3; w.vy = 0.3; w.vz = sz * 0.3;
                }
                else { w.y += 0.04; w.vy = 0.6; }
                w.energy = Min(1, w.energy + 0.1); // a sticky, sugary escape
                Emit("climbedOut", ("id", w.id));
                return;
            }
            if (tick >= d.until) Die(w, "drowned in a drink", null);
        }

        void AddDeposited(string kind, Num amt)
        {
            var s = colony.stats;
            if (kind == "sugar") s.depSugar += amt; else if (kind == "protein") s.depProtein += amt; else if (kind == "water") s.depWater += amt; else s.depPulp += amt;
        }

        internal void NestTouch(Wasp w)
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
            if (deposited) { stats.deposits++; Xp(w, "deposit"); }
            // a forager home with food remembers where it was (site fidelity), and its load carries the scent of the
            // source to nestmates leaving soon after (GDD 7.3, T1-16)
            var from = w.ai.from;
            if (deposited && from != null && w.role != null && from.kind != "wood" && from.kind != "bait")
            {
                w.ai.known = new Known { role = w.role, t = from };
                homeScent = new Known { role = w.role, t = from, until = tick + T.sense.homeScentTicks };
            }
            w.ai.from = null;
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
                    if (w.venom >= T.venom.jab) { w.venom -= T.venom.jab; ApplySting(w, hm, here.zone, here.pos, "jab", true); if (Spw(w).barbed != 0 && w.caste != "queen") w.spent = true; }
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
                    Num rw = r + Spw(w).swatR; // a hornet is a bigger target
                    if (D2(w, c) > rw * rw) continue;
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
            else if (w.caste == "worker") colony.adults = Max(0, colony.adults - 1); // a male or gyne out was already counted out (T2-3)
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

        internal void Despawn(Wasp w)
        {
            ColonyState home = null;
            if (w.colony == "own") home = colony;
            else if ((w.caste == "male" || w.caste == "gyne") && w.colony != null && w.colony.StartsWith("line:")) foreach (var x in line) if ("line:" + x.id == w.colony) { home = x.colony; break; }
            if (home != null && w.caste == "male") home.males += 1; // back in the nest (T2-3), the player's or a sister colony's
            else if (home != null && w.caste == "gyne") { if (w.mated) home.mated += 1; else home.gynes += 1; }
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
                    for (int si = 0; si < rc.content.sheds.Count; si++) if (!FeralWall(rc, si)) { var p = World.ShedSites(rc.content.sheds[si]).wall; Add("shed", p.x, p.y, p.z); }
                    for (int j = 0; j < s.hollows.Count; j++) if (!FeralHollow(rc, j)) Add("hollow", s.hollows[j].p.x, s.hollows[j].p.y, s.hollows[j].p.z);
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
        internal void EndSeasonForTest(string why) => EndSeason(why);
        void EndSeason(string why)
        {
            if (Colony.Sp(colony).perennial != 0) { BeeWinter(why); return; } // a bee colony winters as a cluster (T2-11)
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
            // the sister colonies' mated queens winter by their nests (T2-4)
            foreach (var sc in line)
            {
                int k = (int)Floor(sc.colony.mated * T.hiber.survival * T.hiber.Q("sister") + H32(sn, sc.id, 953));
                if (k >= 1) { sites.Add(new HiberSite { kind = "sister", x = sc.nest.spawn.x, y = sc.nest.spawn.y, z = sc.nest.spawn.z, q = T.hiber.Q("sister"), n = k }); survivors += k; }
            }
            sites.Sort((a, b) => a.n != b.n ? b.n.CompareTo(a.n) : a.q != b.q ? (b.q < a.q ? -1 : 1) : a.x != b.x ? (a.x < b.x ? -1 : 1) : a.z != b.z ? (a.z < b.z ? -1 : 1) : 0);
            foreach (var w in new List<Wasp>(wasps)) if (w.colony != "own" && !IsRival(w)) Despawn(w);
            // a honeybee colony of the line winters as a cluster and goes on in spring (GDD 6.8, multi-colony play)
            Num days = Rnd(settings.seasonDays * T.season.winterShare); var keep = line.FindAll(sc => (Colony.Sp(sc.colony).perennial != 0 || sc.colony.warm) && Cluster(sc.colony, days, sc.nest.site));
            Num mated0 = col.mated; bool home = why != "colony lost" && col.sited && Cluster(col, days, nest.site);
            line = new List<LineColony>();
            Num lin = Floor(lineage * T.season.lineageSurvival + H32(sn, 32)); // queens of the line beyond the colonies that were real
            Emit("winter", ("why", why), ("mated", mated0), ("survivors", survivors), ("lineage", lin), ("season", sn), ("home", home), ("adults", Floor(home ? col.adults : 0)), ("sites", sites.Count));
            if (survivors + lin < 1 && (home || keep.Count > 0)) { foreach (var w in new List<Wasp>(wasps)) Despawn(w); line = keep; HiveSpring(days, sn, home); return; } // no queen made it, a colony that wintered in did
            if (survivors + lin < 1) { extinct = true; foreach (var w in new List<Wasp>(wasps)) Despawn(w); Emit("lineExtinct", ("nestAlive", col.nestAlive)); return; }
            // only sister nests made it: you wake in one of them
            if (sites.Count == 0) sites.Add(new HiberSite { kind = "sister", x = nest.spawn.x, y = nest.spawn.y, z = nest.spawn.z, q = T.hiber.Q("sister"), n = 0 });
            foreach (var w in new List<Wasp>(wasps)) Despawn(w);
            ghost = null;
            winter = new Winter { why = why, sites = sites, survivors = survivors, lineage = lin, until = tick + T.hiber.chooseTicks, offer = Offer(), keep = keep, home = home };
            if (winter.offer != null) Emit("offer", ("species", winter.offer));
        }

        /// A honeybee colony's winter (T2-11): no queens to choose. Each colony of the line, yours and its swarms, clusters
        /// on its honey; what the store covers lives, less the winter's losses, and a cluster too small dies. In spring
        /// the colony goes on in the same hive; with yours gone, you go on in the strongest of the line's. See sim.js.
        /// a honeybee colony's winter on its honey: what the store covers lives, less the winter's losses; too small dies
        /// a wasp or hornet colony nested somewhere warm sits the winter out: no store to eat, a share of it lost (GDD 6.8)
        internal bool ClusterForTest(ColonyState c, Num days, string site) => Cluster(c, days, site);
        bool Cluster(ColonyState c, Num days, string site = "trunk")
        {
            bool bee = Colony.Sp(c).perennial != 0;
            if (!c.nestAlive || !c.queenAlive || (!bee && !c.warm)) return false;
            Num need = bee ? c.adults * T.hive.winterNeed * days : 0, fed = need > 0 ? Clamp01(c.sugar / need) : 1;
            Num loss = bee ? T.hive.winterLoss + (c.warm ? 0 : T.warm.exposedBeeLoss * (1 - T.sites.Of(site ?? "trunk").insulation)) : T.warm.loss;
            c.sugar = Max(0, c.sugar - need);
            c.adults *= (1 - loss) * fed;
            c.eggs = c.larvae = c.pupae = c.rEggs = c.rLarvae = c.rPupae = 0; c.young = 0; c.gynes = 0; c.males = 0; c.mated = 0;
            c.deficit = 0; c.sugarlessDays = 0; c.water = 0; c.cool = 1; c.thirst = 0;
            if (c.adults < (bee ? T.hive.minCluster : T.warm.minAdults)) { c.adults = 0; c.queenAlive = false; return false; }
            return true;
        }
        void BeeWinter(string why)
        {
            int n = season.n; Num days = Rnd(settings.seasonDays * T.season.winterShare);
            foreach (var w in new List<Wasp>(wasps)) Despawn(w);
            bool mine = why != "colony lost" && Cluster(colony, days, nest.site);
            // the line's bee colonies cluster, and a wasp colony nested somewhere warm sits it out; the rest die with the autumn
            line = line.FindAll(sc =>
            {
                if (Colony.Sp(sc.colony).perennial != 0 || sc.colony.warm) return Cluster(sc.colony, days, sc.nest.site);
                lineage += Floor(sc.colony.mated * T.hiber.survival * T.hiber.Q("sister") + H32(n, sc.id, 953));
                return false;
            });
            Emit("winter", ("why", why), ("bee", true), ("adults", Floor(mine ? colony.adults : 0)), ("honey", colony.sugar), ("sisters", line.Count), ("season", n), ("mated", (Num)0), ("survivors", (Num)(mine ? 1 : 0)), ("lineage", (Num)line.Count), ("sites", 0));
            if (!mine && line.Count == 0) { extinct = true; Emit("lineExtinct", ("nestAlive", colony.nestAlive)); return; }
            HiveSpring(days, n, mine);
        }
        /// spring after a winter in the hive: the same hive, or with yours gone the strongest colony of the line's
        void HiveSpring(Num days, int n, bool mine)
        {
            Num target = (day + 1 + days) * 1440 + T.time.dawn;
            clockOffset += (long)((target - minute) * tpm);
            Minute(ClockMinutes(tick + clockOffset, settings));
            season = new Season { n = n + 1, startMinute = target, phase = "Founding" };
            if (!mine)
            { // yours did not make it: the line goes on in its strongest colony
                var best = line[0];
                foreach (var x in line) if (x.colony.adults > best.colony.adults) best = x;
                line.Remove(best);
                int alloc = colony.alloc;
                oldNests.Add(nest); nest = best.nest; colony = best.colony; colony.alloc = alloc;
                colony.xpSeen = HiveScore(colony);
                species = colony.species ?? "wasp"; settings.species = species;
            }
            foreach (var st in chunkState.Values) st.esc = 0;
            swats = new List<Swat>(); sprays = new List<Spray>(); alarms = new List<Alarm>(); hiveAlarms.Clear(); homeScent = null; hiberPick = null;
            ext = new Ext();
            ghost = null;
            var q = SpawnWasp(true);
            drivenId = q.id;
            foreach (var hm in active) CatchUpHuman(hm);
            UpdateChunks(true);
            Emit("spring", ("season", season.n), ("lineage", lineage), ("id", q.id), ("kind", "hive"), ("bee", Colony.Sp(colony).perennial != 0), ("home", Colony.Sp(colony).perennial == 0), ("took", !mine));
        }

        /// A crowded honeybee colony with a daughter queen raised swarms (T2-11): the old queen leaves with most of the
        /// workers and some honey and founds a colony of the line on a tree nearby; the daughter keeps the hive.
        void Swarm(ColonyState c, Nest from)
        {
            if (!c.nestAlive || !c.queenAlive || c.gynes < 1 || c.adults < T.hive.swarmAdults || c.swarmed == season.n) return;
            Num frac = SeasonFrac;
            if (frac < T.hive.swarmFrom || frac >= T.hive.swarmTo || !IsDaylight(minute) || Raining) return;
            Num moved = c.adults * T.hive.swarmShare, honey = c.sugar * T.hive.swarmHoney;
            c.adults -= moved; c.young = Min(c.young, c.adults); c.sugar -= honey; c.gynes = 0; c.swarmed = season.n;
            var used = new List<(Num x, Num z)> { (nest.treeX, nest.treeZ) };
            foreach (var x in line) used.Add((x.nest.treeX, x.nest.treeZ));
            var t = line.Count < T.line.max ? LineTree(new HiberSite { x = from.x, z = from.z }, used) : null;
            if (t == null) { lineage++; Emit("swarm", ("x", from.x), ("z", from.z), ("adults", moved), ("gone", true)); return; }
            Num dx = from.x - t.x, dz = from.z - t.z, d = Sqrt(dx * dx + dz * dz); if (d == 0) d = 1; dx /= d; dz /= d;
            var nn = World.MakeNest(t.x, t.z, t.x + dx * (t.r + 0.2), Clamp(1.6, 1.2, Max(1.2, t.h - 0.6)), t.z + dz * (t.r + 0.2), World.NEST.r, "trunk");
            var col = Colony.New(true, "bee"); col.sited = true; col.maxCells = MaxCells("trunk", "bee"); col.alloc = 0;
            col.adults = moved; col.sugar = honey; col.swarmed = season.n;
            line.Add(new LineColony { id = ++lineSeq, nest = nn, colony = col, season = season.n });
            Emit("swarm", ("x", nn.x), ("z", nn.z), ("adults", moved), ("id", lineSeq), ("from", from == nest ? "own" : "line"));
        }

        /// a pick of 1..n wakes that queen; 1001..1000+n wakes her as the species the year's turn offers (GDD 6.8)
        /// 2000 stays in the nest that wintered in, the default when it did (GDD 6.8)
        void WinterStep(int k)
        {
            var W = winter;
            if (W.home && (k == 2000 || (k == 0 && tick >= W.until))) { WakeHome(); return; }
            bool morph = k > 1000 && k < 2000 && W.offer != null;
            if (morph) k -= 1000;
            bool ok = k >= 1 && k <= W.sites.Count;
            if (ok || tick >= W.until) Spring(ok ? k - 1 : 0, ok && morph);
        }

        /// spring in the nest that wintered in: the same colony, its queen, a worker of it in hand; the young queens found
        /// colonies of the line as usual
        void WakeHome()
        {
            var W = winter; int n = season.n;
            winter = null;
            Num winterDays = Rnd(settings.seasonDays * T.season.winterShare);
            Num target = (day + 1 + winterDays) * 1440 + T.time.dawn;
            clockOffset += (long)((target - minute) * tpm);
            Minute(ClockMinutes(tick + clockOffset, settings));
            season = new Season { n = n + 1, startMinute = target, phase = "Founding" };
            foreach (var w in new List<Wasp>(wasps)) Despawn(w);
            foreach (var s in chunkState.Values) s.esc = 0;
            swats = new List<Swat>(); sprays = new List<Spray>(); alarms = new List<Alarm>(); hiveAlarms.Clear(); homeScent = null; hiberPick = null;
            ext = new Ext();
            ghost = null;
            lineage = FoundLine(W.sites, -1, W.survivors + W.lineage, species);
            if (W.keep != null) line.AddRange(W.keep);
            var dw = SpawnWasp(true);
            drivenId = dw.id;
            foreach (var hm in active) CatchUpHuman(hm);
            UpdateChunks(true);
            Emit("spring", ("season", season.n), ("lineage", lineage), ("id", dw.id), ("kind", "home"), ("home", true));
        }

        void Spring(int choice, bool morph = false)
        {
            var W = winter; var site = W.sites[choice]; Num survivors = W.survivors, lin = W.lineage; string was = species;
            var oldNest = nest; var oldColony = colony;
            winter = null;
            if (morph) { species = W.offer; settings.species = W.offer; } // the line changes species with this queen
            // the queen that continues is yours; the rest found lineage colonies (Q-10), real ones first (T2-4)
            Num winterDays = Rnd(settings.seasonDays * T.season.winterShare);
            Num target = (day + 1 + winterDays) * 1440 + T.time.dawn;
            clockOffset += (long)((target - minute) * tpm);
            Minute(ClockMinutes(tick + clockOffset, settings));
            season = new Season { n = season.n + 1, startMinute = target, phase = "Founding" };
            int alloc = colony.alloc;
            colony = Colony.New(true, species);
            colony.alloc = alloc;
            colony.sited = false;
            colony.sugar *= 0.5 + site.q; // a queen who wintered well wakes with more in reserve
            if (Colony.Sp(colony).perennial != 0) { colony.adults = T.xp.beeSwarm; colony.stats.emerged = 0; } // a honeybee queen comes with a swarm
            springAt = new Spot { x = site.x, z = site.z };
            hiberPick = null;
            if (!W.home) oldNests.Add(nest); // a nest that wintered in goes on, under the AI
            foreach (var w in new List<Wasp>(wasps)) Despawn(w);
            foreach (var s in chunkState.Values) s.esc = 0;
            swats = new List<Swat>(); sprays = new List<Spray>(); alarms = new List<Alarm>(); hiveAlarms.Clear(); homeScent = null;
            ext = new Ext();
            ghost = null;
            var q = SpawnWasp(true, "queen");
            q.x = site.x; q.y = site.y + 0.05; q.z = site.z;
            drivenId = q.id;
            lineage = FoundLine(W.sites, choice, survivors + lin - 1, was); // the other queens wake as they were
            if (W.keep != null) line.AddRange(W.keep); // and the line's hives come through the winter
            if (W.home) line.Add(new LineColony { id = ++lineSeq, nest = oldNest, colony = oldColony, season = season.n }); // and yours, left to the AI
            foreach (var hm in active) CatchUpHuman(hm);
            UpdateChunks(true);
            Emit("spring", ("season", season.n), ("lineage", lineage), ("id", q.id), ("kind", site.kind), ("species", morph ? species : null));
        }
    }
}
