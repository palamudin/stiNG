// World generation, clock, weather and schedules (GDD 4, 5, 8.2). Port of poc/sim/world.js.
using System.Collections.Generic;
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public struct V3 { public Num x, y, z; public V3(Num x, Num y, Num z) { this.x = x; this.y = y; this.z = z; } }

    public sealed class Tree { public Num x, z, r, h, cr, shade; }
    public sealed class Table { public Num x, z; public bool axisX; }
    public sealed class Bench { public Num x, z; public bool axisX; }
    public sealed class Can { public Num x, z; public int color, table; }
    public sealed class Flower { public Num x, y, z; public int color; }
    public sealed class Caterpillar { public Num x, y, z; }
    public sealed class Fly { public Num x, y, z, r, w1, w2, w3, p1, p2, p3; }
    public sealed class HumanSlot { public int slot; public Num x, z, fx, fz, exit; public string posture; }
    public sealed class Box { public Num minx, maxx, miny, maxy, minz, maxz; public bool wood, hive, shed, fence, mall; }
    public sealed class Cyl { public Num x, z, r, h; public bool wood, grill; }
    /// A sugar source: a can, a flower, a puddle ('spill') or fallen 'fruit'. i identifies spills and fruit.
    public sealed class SugarNode { public Num x, y, z, rate; public string kind; public int table = -1, i; }
    public sealed class Bee { public bool guard; public Num p, w, tx, ty, tz; public int period, phase; }
    public sealed class Hive { public Num x, z, fx, fz, ex, ey, ez; public int slot; public List<Bee> bees = new List<Bee>(); public bool feral; }
    public sealed class Trap { public Num x, y, z; public int table; }
    public sealed class Web { public Num x, y, z, nx, nz, r; public int tree; }
    /// Birds and dragonflies: a patrol loop
    public sealed class Patrol { public Num x, y, z, r, dir; public int period, phase; }
    public sealed class Rival { public Num x, y, z, r, ex, ey, ez; public int workers; }
    public sealed class Shed { public Num x, z, hw, hd, h; public int crack, eave; public bool house; }
    /// streets and parking lots (T1-12): flat rectangles; cul-de-sacs; strip-mall buildings
    public sealed class Rect { public Num minx, maxx, minz, maxz; }
    public sealed class Loop { public Num x, z, r; }
    public sealed class Mall { public Num x, z, hw, hd, h; }
    public sealed class RegionLayout { public int strip, mallSide, mallFrom, forest; }
    public sealed class Spawn { public Num x, y, z, yaw; }
    public sealed class Nest
    {
        public Num x, y, z, r, treeX, treeZ; public V3 entrance; public Spawn spawn; public string site = "trunk"; public string key;
        public Nest Clone() { var n = (Nest)MemberwiseClone(); n.spawn = new Spawn { x = spawn.x, y = spawn.y, z = spawn.z, yaw = spawn.yaw }; return n; }
    }

    public sealed class ChunkContent
    {
        public int cx, cz; public Num tint;
        public List<Tree> trees = new List<Tree>(); public List<Table> tables = new List<Table>(); public List<Bench> benches = new List<Bench>();
        public List<Can> cans = new List<Can>(); public List<Flower> flowers = new List<Flower>(); public List<Caterpillar> caterpillars = new List<Caterpillar>();
        public List<Fly> flies = new List<Fly>(); public List<HumanSlot> humans = new List<HumanSlot>(); public List<Box> boxes = new List<Box>();
        public List<Cyl> cylinders = new List<Cyl>(); public List<SugarNode> sugar = new List<SugarNode>(); public List<Hive> hives = new List<Hive>();
        public List<Trap> traps = new List<Trap>(); public bool hasNest; public List<Web> webs = new List<Web>(); public List<Patrol> birds = new List<Patrol>();
        public Rival rival; public List<Shed> sheds = new List<Shed>(); public List<Patrol> dragonflies = new List<Patrol>();
        /// land use and the suburban layout (T1-12)
        public string use = "park"; public List<Rect> roads = new List<Rect>(), lots = new List<Rect>(); public List<Loop> loops = new List<Loop>(); public List<Mall> malls = new List<Mall>();
    }

    public sealed class ShedSite { public Num x, y, z, ix, iz, nx, nz; }
    public sealed class DayWeather { public long day; public bool rain; public Num rainStart, rainEnd, @base, wind, windDir; }
    public sealed class HumanWin { public Num arrive, leave; }

    public static class World
    {
        public static readonly Num CS = T.chunk.size;
        public static int ChunkOf(Num v) => (int)Floor(v / CS + 0.5);
        public static string ChunkKey(int cx, int cz) => cx + "," + cz;

        public static readonly Nest NEST = new Nest { x = -3, y = 2.3, z = -1.55, r = 0.14, treeX = -3, treeZ = -2 };
        public static readonly V3 NEST_ENTRANCE = new V3(-3, 2.3 - 0.14 * 1.25, -1.55);
        public static readonly Spawn SPAWN = new Spawn { x = -3, y = 2.05, z = -1.25, yaw = 0.98 };

        public static Nest MakeNest(Num treeX, Num treeZ, Num x, Num y, Num z) => MakeNest(treeX, treeZ, x, y, z, 0.14, "trunk");
        public static Nest MakeNest(Num treeX, Num treeZ, Num x, Num y, Num z, Num r, string site = "trunk")
        {
            bool inside = site == "wall" || site == "attic" || site == "hollow";
            V3 entrance = site == "ground" ? new V3(x, 0.02, z) : inside ? new V3(x, y, z) : new V3(x, y - r * 1.25, z);
            Spawn spawn = site == "ground" ? new Spawn { x = x, y = 0.3, z = z + 0.3, yaw = 0.98 } : new Spawn { x = x, y = entrance.y - 0.1, z = z + 0.3, yaw = 0.98 };
            if (inside)
            {
                Num dx = x - treeX, dz = z - treeZ, d = Sqrt(dx * dx + dz * dz); if (d == 0) d = 1;
                spawn = new Spawn { x = x + dx / d * 0.3, y = y, z = z + dz / d * 0.3, yaw = DAtan2(dx, dz) };
            }
            return new Nest { x = x, y = y, z = z, r = r, treeX = treeX, treeZ = treeZ, entrance = entrance, spawn = spawn, site = site, key = ChunkKey(ChunkOf(x), ChunkOf(z)) };
        }

        // ---------------------------------------------------------------- clock and weather (GDD 5)
        public static int TicksPerMinute(Settings s) => RndI(s.dayMinutes * 2.5);
        /// Integer division: equal to the JS floor(tick / tpm) for the non-negative ticks the sim has
        public static long ClockMinutes(long tickEff, Settings s) => (long)T.time.startMinute + tickEff / TicksPerMinute(s);
        public static long DayOf(long m) => m >= 0 ? m / 1440 : -((-m + 1439) / 1440);
        public static long MinuteOfDay(long m) => m - DayOf(m) * 1440;

        static readonly Dictionary<string, DayWeather> weatherCache = new Dictionary<string, DayWeather>();
        public static DayWeather Weather(ulong seed, long day)
        {
            string key = seed + ":" + day;
            lock (weatherCache) if (weatherCache.TryGetValue(key, out var c)) return c;
            ulong H(ulong i) => Hash(seed, Domain.Weather, U64(day), i);
            bool rain = day > 0 && Unit(H(0)) < T.weather.rainChance;
            Num rainStart = 11 * 60 + RangeInt(H(1), 0, 6 * 60);
            var w = new DayWeather { day = day, rain = rain, rainStart = rainStart, rainEnd = rainStart + 60 + RangeInt(H(2), 0, 120), @base = Range(H(3), T.weather.baseMin, T.weather.baseMax),
                wind = Range(H(4), T.wind.min, T.wind.max) * (rain ? T.wind.rainMul : 1), windDir = Range(H(5), 0, TAU) };
            lock (weatherCache) weatherCache[key] = w;
            return w;
        }
        public static bool IsRaining(ulong seed, long m) { var w = Weather(seed, DayOf(m)); long d = MinuteOfDay(m); return w.rain && d >= w.rainStart && d < w.rainEnd; }
        public static Num TempAt(ulong seed, long m)
        {
            var w = Weather(seed, DayOf(m)); long d = MinuteOfDay(m);
            return w.@base + T.weather.diurnalAmp * DSin(TAU * (d - 540) / 1440) - (IsRaining(seed, m) ? 4 : 0);
        }
        /// The wind at a minute, as a velocity (m/s) in the open at reference height: calm at night and dawn, strongest mid-afternoon
        public static V3 WindAt(ulong seed, long m)
        {
            var w = Weather(seed, DayOf(m)); long d = MinuteOfDay(m);
            Num s = w.wind * (0.35 + 0.65 * Max(0, DSin(TAU * (d - 540) / 1440)));
            return new V3(s * DSin(w.windDir), 0, s * DCos(w.windDir));
        }
        public static bool IsDaylight(long m) { long d = MinuteOfDay(m); return d >= T.time.dawn && d < T.time.dusk; }

        public static HumanWin HumanWindow(ulong seed, ulong id, long day) => HumanWindow(seed, id, day, 1);
        public static HumanWin HumanWindow(ulong seed, ulong id, long day, Num density)
        {
            ulong H(ulong i) => Hash(seed, Domain.HumanSchedule, id, U64(day), i);
            if (day > 0 && Unit(H(0)) > 0.85 * density) return null;
            Num arrive = day == 0 ? 0 : 600 + RangeInt(H(1), 0, 150);
            Num leave = 1020 + RangeInt(H(2), 0, 180);
            var w = Weather(seed, day);
            if (w.rain)
            {
                if (arrive < w.rainStart) leave = Min(leave, w.rainStart);
                else if (w.rainEnd + 30 < leave) arrive = w.rainEnd + 30;
                else return null;
            }
            return new HumanWin { arrive = arrive, leave = leave };
        }

        // ---------------------------------------------------------------- pure motion
        public static V3 FlyPos(Fly f, Num tick)
        {
            Num t = tick / 60;
            return new V3(f.x + f.r * DSin(f.w1 * t + f.p1), f.y + 0.1 * DSin(f.w2 * t + f.p2), f.z + f.r * DCos(f.w3 * t + f.p3));
        }
        public static V3 BirdPos(Patrol b, Num tick)
        {
            Num a = ((tick + b.phase) / b.period) * 6.283185307179586 * b.dir;
            return new V3(b.x + b.r * DCos(a), b.y + 0.6 * DSin(a * 3), b.z + b.r * DSin(a));
        }
        public static V3 DragonPos(Patrol b, Num tick)
        {
            Num a = ((tick + b.phase) / b.period) * 6.283185307179586 * b.dir;
            return new V3(b.x + b.r * DCos(a) * (1 + 0.3 * DSin(a * 2)), b.y + 0.25 * DSin(a * 5), b.z + b.r * DSin(a));
        }
        static readonly int[,] Faces = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } };
        public static (ShedSite wall, ShedSite attic) ShedSites(Shed sh)
        {
            ShedSite At(int f, Num y)
            {
                int fx = Faces[f, 0], fz = Faces[f, 1];
                Num ex = fx != 0 ? fx * (sh.hw + 0.01) : 0.3, ez = fz != 0 ? fz * (sh.hd + 0.01) : -0.2;
                return new ShedSite { x = sh.x + ex, y = y, z = sh.z + ez, ix = sh.x + ex - fx * 0.3, iz = sh.z + ez - fz * 0.3, nx = fx, nz = fz };
            }
            return (At(sh.crack, 1.0), At(sh.eave, sh.h - 0.08));
        }
        public static V3 BeePos(Hive hive, int k, Num tick)
        {
            var b = hive.bees[k];
            Num t = tick / 60;
            if (b.guard)
            {
                Num ga = b.p + t * b.w;
                return new V3(hive.ex + 0.13 * DCos(ga), hive.ey + 0.05 + 0.04 * DSin(ga * 1.7), hive.ez + 0.13 * DSin(ga));
            }
            Num P = b.period, u = ((tick + b.phase) % P) / P;
            Num fx = b.tx, fy = b.ty + 0.04, fz = b.tz;
            if (u < 0.4 || u >= 0.6)
            {
                Num s = u < 0.4 ? u / 0.4 : 1 - (u - 0.6) / 0.4;
                Num arc = 1.4 * DSin(3.141592653589793 * s);
                return new V3(hive.ex + (fx - hive.ex) * s, hive.ey + (fy - hive.ey) * s + arc, hive.ez + (fz - hive.ez) * s);
            }
            Num a = (u - 0.4) * 60 + b.p;
            return new V3(fx + 0.05 * DCos(a), fy + 0.02 * DSin(a * 1.3), fz + 0.05 * DSin(a));
        }

        // ---------------------------------------------------------------- regions (GDD 4.2, 4.3, T1-12)
        public const int REGION = 8;
        static readonly Dictionary<string, RegionLayout> regionCache = new Dictionary<string, RegionLayout>();
        static int FloorDiv(int a, int b) => a >= 0 ? a / b : -((-a + b - 1) / b);
        public static RegionLayout Region(ulong seed, int rx, int rz)
        {
            string key = seed + ":" + rx + "," + rz;
            lock (regionCache)
            {
                if (regionCache.TryGetValue(key, out var L)) return L;
                ulong H(long slot) => Hash(seed, Domain.WorldGen, U64(rx), U64(rz), U64(90000 + slot));
                L = new RegionLayout { strip = rx == 0 && rz == 0 ? REGION / 2 : 2 + RangeInt(H(1), 0, 4), mallSide = RangeInt(H(2), 0, 4), mallFrom = RangeInt(H(3), 0, REGION - 2), forest = RangeInt(H(4), 0, 4) };
                if (regionCache.Count > 256) regionCache.Clear();
                regionCache[key] = L;
                return L;
            }
        }
        public static string LandUse(ulong seed, int cx, int cz)
        {
            if (cx == 0 && cz == 0) return "park";
            int h = REGION / 2, rx = FloorDiv(cx + h, REGION), rz = FloorDiv(cz + h, REGION), lx = cx + h - rx * REGION, lz = cz + h - rz * REGION;
            var L = Region(seed, rx, rz);
            if (lz == L.strip) return "park";
            bool edge = L.mallSide == 0 ? lz == 0 : L.mallSide == 1 ? lx == REGION - 1 : L.mallSide == 2 ? lz == REGION - 1 : lx == 0;
            int along = L.mallSide % 2 != 0 ? lz : lx;
            if (edge && along >= L.mallFrom && along < L.mallFrom + 3) return "mall";
            int fx = (L.forest & 1) != 0 ? REGION - 2 : 0, fz = (L.forest & 2) != 0 ? REGION - 2 : 0;
            if (lx >= fx && lx < fx + 2 && lz >= fz && lz < fz + 2) return "forest";
            return "yards";
        }
        public static int MallSide(ulong seed, int cx, int cz) { int h = REGION / 2; return Region(seed, FloorDiv(cx + h, REGION), FloorDiv(cz + h, REGION)).mallSide; }

        // ---------------------------------------------------------------- chunk generation (GDD 4.3)
        struct Occ { public Num x, z, r; }

        public static ChunkContent GenerateChunk(ulong seed, int cx, int cz)
        {
            ulong H(long slot) => Hash(seed, Domain.WorldGen, U64(cx), U64(cz), U64(slot));
            Num ox = cx * CS, oz = cz * CS;
            var c = new ChunkContent { cx = cx, cz = cz, tint = Unit(H(0)) };
            var occupied = new List<Occ>();
            bool isOrigin = cx == 0 && cz == 0;
            bool Free(Num x, Num z, Num r) { foreach (var o in occupied) { Num dx = x - o.x, dz = z - o.z; if (!(dx * dx + dz * dz > (r + o.r) * (r + o.r))) return false; } return true; }
            void AddFly(Num x, Num y, Num z, long slot)
            {
                c.flies.Add(new Fly
                {
                    x = x, y = y, z = z, r = T.prey.flyOrbit * Range(H(slot), 0.6, 1.2),
                    w1 = Range(H(slot + 1), 1.2, 2.6), w2 = Range(H(slot + 2), 2, 4), w3 = Range(H(slot + 3), 1.2, 2.6),
                    p1 = Range(H(slot + 4), 0, 6.28), p2 = Range(H(slot + 5), 0, 6.28), p3 = Range(H(slot + 6), 0, 6.28),
                });
            }
            void AddBox(Num minx, Num maxx, Num miny, Num maxy, Num minz, Num maxz, bool wood) =>
                c.boxes.Add(new Box { minx = minx, maxx = maxx, miny = miny, maxy = maxy, minz = minz, maxz = maxz, wood = wood });

            void AddPicnic(Num px, Num pz, bool axisX, int seatMask, long slotBase)
            {
                occupied.Add(new Occ { x = px, z = pz, r = 5 });
                Num hw = 0.95, hd = 0.4;
                int ti = c.tables.Count;
                c.tables.Add(new Table { x = px, z = pz, axisX = axisX });
                if (axisX)
                {
                    AddBox(px - hw, px + hw, 0.71, 0.75, pz - hd, pz + hd, true);
                    foreach (int s in new[] { -1, 1 }) { AddBox(px - hw, px + hw, 0.40, 0.45, pz + s * 0.67 - 0.14, pz + s * 0.67 + 0.14, true); c.benches.Add(new Bench { x = px, z = pz + s * 0.67, axisX = axisX }); }
                }
                else
                {
                    AddBox(px - hd, px + hd, 0.71, 0.75, pz - hw, pz + hw, true);
                    foreach (int s in new[] { -1, 1 }) { AddBox(px + s * 0.67 - 0.14, px + s * 0.67 + 0.14, 0.40, 0.45, pz - hw, pz + hw, true); c.benches.Add(new Bench { x = px + s * 0.67, z = pz, axisX = axisX }); }
                }
                int k = 0;
                foreach (int side in new[] { -1, 1 })
                {
                    foreach (Num along in new[] { -0.6, 0, 0.6 })
                    {
                        if ((seatMask & (1 << k)) != 0)
                        {
                            Num hx = axisX ? px + along : px + side * 0.67;
                            Num hz = axisX ? pz + side * 0.67 : pz + along;
                            Num fx = axisX ? 0 : -side, fz = axisX ? -side : 0;
                            c.humans.Add(new HumanSlot { slot = (int)slotBase + k, x = hx, z = hz, fx = fx, fz = fz, posture = "sit", exit = Range(H(slotBase + 200 + k), 0, 6.28) });
                        }
                        k++;
                    }
                }
                int nCans = RangeInt(H(slotBase + 50), 1, 4);
                for (int i = 0; i < nCans; i++)
                {
                    Num u = Range(H(slotBase + 60 + i), -0.8, 0.8), v = Range(H(slotBase + 70 + i), -0.22, 0.22);
                    Num x = axisX ? px + u : px + v, z = axisX ? pz + v : pz + u;
                    c.cans.Add(new Can { x = x, z = z, color = RangeInt(H(slotBase + 80 + i), 0, 4), table = ti });
                    c.sugar.Add(new SugarNode { x = x, y = 0.87, z = z, rate = 1.0, kind = "can", table = ti });
                }
                Num tx = axisX ? px + hw + 0.05 : px, tz = axisX ? pz : pz + hw + 0.05;
                c.traps.Add(new Trap { x = tx, y = 0.6, z = tz, table = ti });
                for (int i = 0; i < T.prey.fliesPerTable; i++) AddFly(px + Range(H(slotBase + 90 + i * 8), -0.6, 0.6), 0.95, pz + Range(H(slotBase + 91 + i * 8), -0.3, 0.3), slotBase + 92 + i * 8);
            }

            void AddGroup(Num gx, Num gz, int count, long slotBase)
            {
                occupied.Add(new Occ { x = gx, z = gz, r = 3 });
                Num[,] offs = { { 0, 0.75 }, { 0.75, 0 }, { 0, -0.75 }, { -0.75, 0 } };
                for (int k = 0; k < count; k++)
                {
                    Num dx = offs[k, 0], dz = offs[k, 1];
                    c.humans.Add(new HumanSlot { slot = (int)slotBase + k, x = gx + dx, z = gz + dz, fx = -dx / 0.75, fz = -dz / 0.75, posture = "stand", exit = Range(H(slotBase + 200 + k), 0, 6.28) });
                }
                AddFly(gx, 1.7, gz, slotBase + 300);
            }

            void AddTree(Num x, Num z, long slot)
            {
                Num r = Range(H(slot), 0.15, 0.35), h = Range(H(slot + 1), 3.2, 6.0), cr = Range(H(slot + 2), 1.4, 2.8);
                c.trees.Add(new Tree { x = x, z = z, r = r, h = h, cr = cr, shade = Unit(H(slot + 3)) });
                c.cylinders.Add(new Cyl { x = x, z = z, r = r, h = h, wood = true });
            }

            void AddFlowers(Num px, Num pz, long slot)
            {
                int n = RangeInt(H(slot), 4, 11), color = RangeInt(H(slot + 1), 0, 5);
                for (int i = 0; i < n; i++)
                {
                    Num x = px + Range(H(slot + 10 + i), -1.2, 1.2), z = pz + Range(H(slot + 30 + i), -1.2, 1.2);
                    Num y = Range(H(slot + 50 + i), 0.2, 0.55);
                    c.flowers.Add(new Flower { x = x, y = y, z = z, color = color });
                    c.sugar.Add(new SugarNode { x = x, y = y + 0.02, z = z, rate = 0.35, kind = "flower" });
                    if (Unit(H(slot + 70 + i)) < T.prey.caterpillarChance) c.caterpillars.Add(new Caterpillar { x = x + 0.006, y = y * 0.6, z = z });
                }
                AddFly(px, 0.7, pz, slot + 5);
            }

            void AddHive(Num x, Num z, long slot)
            {
                occupied.Add(new Occ { x = x, z = z, r = 4 });
                int dir = RangeInt(H(slot), 0, 4);
                Num fx = new Num[] { 0, 1, 0, -1 }[dir], fz = new Num[] { 1, 0, -1, 0 }[dir];
                var hive = new Hive { x = x, z = z, fx = fx, fz = fz, ex = x + fx * 0.24, ey = 0.47, ez = z + fz * 0.24, slot = (int)slot };
                c.boxes.Add(new Box { minx = x - 0.225, maxx = x + 0.225, miny = 0, maxy = 0.98, minz = z - 0.225, maxz = z + 0.225, wood = true, hive = true });
                c.hives.Add(hive);
            }

            // a garden shed (GDD 6.6), or a house: a big one that is not wood
            void AddShed(Num sx, Num sz, bool axisX, long slot, bool house)
            {
                Num hw = house ? Range(H(slot), 5, 6.5) : axisX ? 1.2 : 0.9, hd = house ? Range(H(slot + 1), 4, 5) : axisX ? 0.9 : 1.2, h = house ? Range(H(slot + 2), 5, 6.5) : 2.1;
                occupied.Add(new Occ { x = sx, z = sz, r = house ? 8 : 4 });
                c.sheds.Add(new Shed { x = sx, z = sz, hw = hw, hd = hd, h = h, crack = RangeInt(H(slot + 3), 0, 4), eave = RangeInt(H(slot + 4), 0, 4), house = house });
                c.boxes.Add(new Box { minx = sx - hw, maxx = sx + hw, miny = 0, maxy = h, minz = sz - hd, maxz = sz + hd, wood = !house, shed = true });
            }
            // a wooden fence along x or z, in sections of up to 4 m (each its own store of pulp)
            void AddFence(Num ax, Num az, Num bx, Num bz)
            {
                Num L = Abs(bx - ax) + Abs(bz - az), t = 0.03, fh = 1.5; int n = System.Math.Max(1, (int)Ceil(L / 4));
                for (int k = 0; k < n; k++)
                {
                    Num x0 = ax + (bx - ax) * k / n, z0 = az + (bz - az) * k / n, x1 = ax + (bx - ax) * (k + 1) / n, z1 = az + (bz - az) * (k + 1) / n;
                    c.boxes.Add(new Box { minx = Min(x0, x1) - t, maxx = Max(x0, x1) + t, miny = 0, maxy = fh, minz = Min(z0, z1) - t, maxz = Max(z0, z1) + t, wood = true, fence = true });
                }
            }
            // suburban yards (see world.js addYards)
            void AddYards()
            {
                bool endW = LandUse(seed, cx - 1, cz) != "yards", endE = LandUse(seed, cx + 1, cz) != "yards";
                c.roads.Add(new Rect { minx = ox + (endW ? -22 : -32), maxx = ox + (endE ? 22 : 32), minz = oz - 4, maxz = oz + 4 });
                if (endW) c.loops.Add(new Loop { x = ox - 22, z = oz, r = 11 });
                if (endE) c.loops.Add(new Loop { x = ox + 22, z = oz, r = 11 });
                occupied.Add(new Occ { x = ox, z = oz, r = 4 });
                for (int li = 0; li < 4; li++)
                {
                    int s = li < 2 ? -1 : 1; Num lx = ox + (li % 2 != 0 ? 16 : -16); long b = 3000 + li * 2000;
                    if (Unit(H(b)) < 0.9) AddShed(lx + Range(H(b + 1), -3, 3), oz + s * 15.5, true, b + 2, true);
                    AddFence(lx - 15.6, oz + s * 20.5, lx - 15.6, oz + s * 31.6);
                    AddFence(lx - 15.6, oz + s * 31.6, lx + 15.6, oz + s * 31.6);
                    if (li % 2 != 0) AddFence(lx + 15.6, oz + s * 20.5, lx + 15.6, oz + s * 31.6);
                    if (Unit(H(b + 10)) < 0.55) AddPicnic(lx + Range(H(b + 11), -6, 6), oz + s * 24.5, true, RangeInt(H(b + 12), 1, 64) | 1, b + 20);
                    if (Unit(H(b + 300)) < 0.75) AddFlowers(lx + Range(H(b + 301), -11, 11), oz + s * 29.5, b + 310);
                    if (Unit(H(b + 500)) < 0.3) { Num sx = lx + (Unit(H(b + 501)) < 0.5 ? -12.5 : 12.5), sz = oz + s * 28.7; if (Free(sx, sz, 2)) AddShed(sx, sz, true, b + 502, false); }
                    if (Unit(H(b + 510)) < 0.08) { Num hx = lx + Range(H(b + 511), -10, 10), hz = oz + s * 22; if (Free(hx, hz, 2)) AddHive(hx, hz, b + 600); }
                    if (Unit(H(b + 800)) < 0.2) { Num gx = lx + Range(H(b + 801), -8, 8), gz = oz + s * 7; if (Free(gx, gz, 2)) AddGroup(gx, gz, RangeInt(H(b + 802), 2, 4), b + 1000); }
                }
            }
            // a strip mall on the region's edge (see world.js addMall)
            void AddMall()
            {
                int side = MallSide(seed, cx, cz);
                int o0 = side == 1 ? 1 : side == 3 ? -1 : 0, o1 = side == 0 ? -1 : side == 2 ? 1 : 0, a0 = o0 != 0 ? 0 : 1, a1 = o0 != 0 ? 1 : 0;
                (Num x, Num z) At(Num u, Num v) => (ox + a0 * u + o0 * v, oz + a1 * u + o1 * v);
                var bp = At(0, 21); Num hu = 27, hv = 8, hx = o0 != 0 ? hv : hu, hz = o0 != 0 ? hu : hv;
                c.malls.Add(new Mall { x = bp.x, z = bp.z, hw = hx, hd = hz, h = 6 });
                c.boxes.Add(new Box { minx = bp.x - hx, maxx = bp.x + hx, miny = 0, maxy = 6, minz = bp.z - hz, maxz = bp.z + hz, wood = false, mall = true });
                occupied.Add(new Occ { x = bp.x, z = bp.z, r = 28 });
                var l0 = At(-28, 11); var l1 = At(28, -20);
                c.lots.Add(new Rect { minx = Min(l0.x, l1.x), maxx = Max(l0.x, l1.x), minz = Min(l0.z, l1.z), maxz = Max(l0.z, l1.z) });
                for (int k = 0; k < 2; k++) { var p = At(k != 0 ? 9 : -9, 9.5); AddPicnic(p.x, p.z, o0 == 0, RangeInt(H(4000 + k * 400), 7, 64) | 1, 4010 + k * 400); }
                if (Unit(H(4900)) < 0.5) { var p = At(Range(H(4901), -20, 20), 6); if (Free(p.x, p.z, 2)) AddGroup(p.x, p.z, RangeInt(H(4902), 2, 5), 4910); }
                int nf = RangeInt(H(4950), 0, 3);
                for (int i = 0; i < nf; i++) { var p = At(Range(H(4951 + i), -24, 24), 13); AddFlowers(p.x, p.z, 4960 + i * 80); }
            }

            if (isOrigin)
            {
                AddTree(NEST.treeX, NEST.treeZ, 100);
                occupied.Add(new Occ { x = NEST.treeX, z = NEST.treeZ, r = 3 });
                c.hasNest = true;
                AddPicnic(6, 4, true, 0b111111, 1000);
                AddGroup(1, 10, 3, 1100);
                AddFlowers(-6, 2, 400);
                AddFlowers(3, -5, 480);
            }
            else if ((c.use = LandUse(seed, cx, cz)) == "yards") AddYards();
            else if (c.use == "mall") AddMall();
            else if (c.use == "forest")
            {
                int npf = RangeInt(H(2010), 1, 3);
                for (int i = 0; i < npf; i++) AddFlowers(ox + Range(H(2020 + i), -26, 26), oz + Range(H(2030 + i), -26, 26), 2100 + i * 80);
            }
            else
            {
                if (Unit(H(1)) < 0.6)
                {
                    Num px = ox + Range(H(2), -20, 20), pz = oz + Range(H(3), -20, 20);
                    AddPicnic(px, pz, Unit(H(4)) < 0.5, RangeInt(H(5), 1, 64) | 1, 1000);
                }
                if (Unit(H(6)) < 0.5)
                {
                    Num gx = ox + Range(H(7), -24, 24), gz = oz + Range(H(8), -24, 24);
                    if (Free(gx, gz, 2)) AddGroup(gx, gz, RangeInt(H(9), 2, 5), 1100);
                }
                bool forcedHive = cx == 1 && cz == 0;
                if (forcedHive || Unit(H(12)) < 0.3)
                {
                    Num hx = forcedHive ? ox - 18 : ox + Range(H(13), -22, 22), hz = forcedHive ? oz + 6 : oz + Range(H(14), -22, 22);
                    if (Free(hx, hz, 3)) AddHive(hx, hz, 1500);
                }
                if (Unit(H(15)) < 0.35)
                {
                    Num sx = ox + Range(H(16), -22, 22), sz = oz + Range(H(17), -22, 22);
                    if (Free(sx, sz, 3))
                    {
                        occupied.Add(new Occ { x = sx, z = sz, r = 4 });
                        bool axisX = Unit(H(18)) < 0.5; Num hw = axisX ? 1.2 : 0.9, hd = axisX ? 0.9 : 1.2, h = 2.1;
                        c.sheds.Add(new Shed { x = sx, z = sz, hw = hw, hd = hd, h = h, crack = RangeInt(H(19), 0, 4), eave = RangeInt(H(21), 0, 4), house = false });
                        c.boxes.Add(new Box { minx = sx - hw, maxx = sx + hw, miny = 0, maxy = h, minz = sz - hd, maxz = sz + hd, wood = true, shed = true });
                    }
                }
                int np = RangeInt(H(10), 3, 9);
                for (int i = 0; i < np; i++) AddFlowers(ox + Range(H(20 + i), -28, 28), oz + Range(H(40 + i), -28, 28), 400 + i * 80);
            }
            // trees: a few in a park, yard trees, dense at the forest edge, hardly any by a mall
            bool forest = c.use == "forest";
            int nt = forest ? RangeInt(H(2000), 16, 26) : c.use == "yards" ? RangeInt(H(2001), 1, 4) : c.use == "mall" ? RangeInt(H(2002), 0, 3) : RangeInt(H(11), isOrigin ? 3 : 2, isOrigin ? 6 : 8);
            for (int i = 0; i < nt; i++)
            {
                Num x = ox + Range(H(150 + i * 4), -30, 30), z = oz + Range(H(151 + i * 4), -30, 30);
                if (Free(x, z, forest ? 1.5 : 3)) { AddTree(x, z, 200 + i * 4); occupied.Add(new Occ { x = x, z = z, r = forest ? 1 : 2 }); }
            }
            for (int i = 0; i < c.trees.Count; i++)
            {
                var t = c.trees[i];
                if (Unit(H(700 + i)) > 0.45) continue;
                Num a = Range(H(710 + i), 0, 6.28), d = t.r + Range(H(720 + i), 0.15, 0.35);
                Num x = t.x + d * DCos(a), z = t.z + d * DSin(a);
                c.webs.Add(new Web { x = x, y = Range(H(730 + i), 0.45, 1.6), z = z, nx = -DSin(a), nz = DCos(a), r = Range(H(740 + i), 0.12, 0.26), tree = i });
            }
            if (Unit(H(800)) < 0.55)
                c.birds.Add(new Patrol { x = ox + Range(H(801), -15, 15), z = oz + Range(H(802), -15, 15), y = Range(H(803), 4, 8), r = Range(H(804), 7, 14), period = RangeInt(H(805), 1200, 2400), phase = RangeInt(H(806), 0, 2400), dir = Unit(H(807)) < 0.5 ? 1 : -1 });
            if (Unit(H(820)) < 0.45)
                c.dragonflies.Add(new Patrol { x = ox + Range(H(821), -20, 20), z = oz + Range(H(822), -20, 20), y = Range(H(823), 0.6, 1.4), r = Range(H(824), 2, 5), period = RangeInt(H(825), 500, 1100), phase = RangeInt(H(826), 0, 1100), dir = Unit(H(827)) < 0.5 ? 1 : -1 });
            if (!isOrigin && !(cx == 1 && cz == 0) && c.trees.Count > 0 && Unit(H(900)) < 0.12)
            {
                var t = c.trees[RangeInt(H(901), 0, c.trees.Count)];
                Num y = Min(t.h - 0.6, Range(H(902), 1.8, 2.6));
                c.rival = new Rival { x = t.x + t.r + 0.25, y = y, z = t.z, r = 0.12, ex = t.x + t.r + 0.25, ey = y - 0.15, ez = t.z, workers = RangeInt(H(903), 3, 6) };
            }
            foreach (var hv in c.hives)
            {
                for (int k = 0; k < T.bees.guards + T.bees.foragers; k++)
                {
                    long s = hv.slot + 10 + k * 6;
                    if (k < T.bees.guards) { hv.bees.Add(new Bee { guard = true, p = Range(H(s), 0, 6.28), w = Range(H(s + 1), 1.5, 3) * (k % 2 != 0 ? 1 : -1) }); continue; }
                    Num ftx, fty, ftz;
                    if (c.flowers.Count > 0) { var f = c.flowers[RangeInt(H(s + 2), 0, c.flowers.Count)]; ftx = f.x; fty = f.y; ftz = f.z; }
                    else { ftx = hv.x + 8; fty = 0.4; ftz = hv.z + 8; }
                    hv.bees.Add(new Bee { guard = false, tx = ftx, ty = fty, tz = ftz, period = RangeInt(H(s + 3), 1500, 3000), phase = RangeInt(H(s + 4), 0, 3000), p = Range(H(s + 5), 0, 6.28) });
                }
            }
            return c;
        }
    }
}
