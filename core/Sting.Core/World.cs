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
    public sealed class HumanSlot { public int slot; public Num x, z, fx, fz, exit; public string posture; public string act; public Num[] path; public bool evening; }
    public sealed class Box { public Num minx, maxx, miny, maxy, minz, maxz; public bool wood, hive, shed, fence, mall, shop, bench, garage, porch, hedge, row, wall, retain, step, back; }
    /// an urban building (S6, world.js addUrban): its frontage, front and back lines, side of the street, height and look
    public sealed class Row { public Num x0, x1, zF, zB, h; public int s, storeys, c; public bool shop, mid; }
    /// a flight of stairs down from a lot's pad into its court: its middle, its top's line, its side, steps, rise each, drop
    public sealed class Stair { public Num x, z, rise, drop; public int s, n; }
    /// an urban chunk's planned building (world.js urbanBuildings)
    public sealed class UrbanBuilding { public Num x0, x1; public int s, storeys, c; public bool shop, mid; }
    /// a house's garage (S4, world.js garageOf): its walls' extent, the line of its door, its side of the street, its height and siding
    public sealed class Garage { public Num x0, x1, z0, z1, zf, h; public int s, c; }
    /// the porch before a house's front door: the door's middle on the wall, and the house's side of the street
    public sealed class Porch { public Num x, z; public int s; }
    public sealed class Cyl { public Num x, z, r, h; public bool wood, grill, bath; }
    /// a birdbath (T2-1): a basin on a pedestal; h is the water's surface
    public sealed class Bath { public Num x, z, r, h; public bool fountain; }
    /// a pond (world.js pondsOf): its water at the ground
    public sealed class Pond { public Num x, z, r, a, b; public bool park; }
    /// A sugar source: a can, a flower, a puddle ('spill') or fallen 'fruit'. i identifies spills and fruit.
    public sealed class SugarNode { public Num x, y, z, rate; public string kind; public int table = -1, i; }
    public sealed class Bee { public bool guard; public Num p, w, tx, ty, tz; public int period, phase; }
    public sealed class Hive { public Num x, z, fx, fz, ex, ey, ez; public int slot; public List<Bee> bees = new List<Bee>(); public bool feral; }
    public sealed class Trap { public Num x, y, z; public int table; }
    public sealed class Web { public Num x, y, z, nx, nz, r; public int tree; }
    /// Birds and dragonflies: a patrol loop
    public sealed class Patrol { public Num x, y, z, r, dir; public int period, phase; }
    public sealed class Rival { public Num x, y, z, r, ex, ey, ez; public int workers; }
    public sealed class Shed { public Num x, z, hw, hd, h; public int crack, eave; public bool house, farm, barn; public Garage g; }
    /// a shed's or house's pitched roof (see World.ShedRoof)
    public sealed class Roof { public Num x, z, wall, wallHalf, half, S, y0, rise, L; public bool alongX; }
    /// streets and parking lots (T1-12): flat rectangles; cul-de-sacs; strip-mall buildings
    public sealed class Rect { public Num minx, maxx, minz, maxz; }
    public sealed class Loop { public Num x, z, r; }
    public sealed class Mall { public Num x, z, hw, hd, h; }
    /// a town centre's shop (T2-5); a beer garden's footprint
    public sealed class Shop { public Num x, z, hw, hd, h; public int color; }
    public sealed class Garden { public Num x, z, hw, hd; }
    /// a forest corner (x, z, n chunks square); a town centre's 2x2 block and which quarter of it is the beer garden
    public sealed class ForestBlock { public int x, z, n; }
    public sealed class Town { public int tx, tz, garden; }
    public sealed class RegionLayout { public int strip, mallSide, mallFrom, forest; public List<ForestBlock> forests = new List<ForestBlock>(); public List<Town> towns = new List<Town>(); }
    public sealed class TownQ { public int qx, qz; public bool garden, fountain; }
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
        public List<Garage> garages = new List<Garage>(); public List<Rect> drives = new List<Rect>(); public List<Porch> porches = new List<Porch>();
        public List<Rect> lanes = new List<Rect>(), farmyards = new List<Rect>();
        public List<Row> rows = new List<Row>(); public List<Stair> stairs = new List<Stair>();
        /// land use and the suburban layout (T1-12)
        public string use = "park"; public List<Rect> roads = new List<Rect>(), lots = new List<Rect>(); public List<Loop> loops = new List<Loop>(); public List<Mall> malls = new List<Mall>();
        /// birdbaths (T2-1)
        public List<Bath> baths = new List<Bath>();
        /// ponds (GEN_VERSION 8)
        public List<Pond> ponds = new List<Pond>();
        /// a town centre's paving, its shop buildings, its beer garden (T2-5)
        public List<Rect> plazas = new List<Rect>(); public List<Shop> shops = new List<Shop>(); public List<Garden> gardens = new List<Garden>();
    }

    public sealed class ShedSite { public Num x, y, z, ix, iz, nx, nz; }
    public sealed class DayWeather
    {
        public long day; public bool rain; public Num rainStart, rainEnd, @base, wind, windDir;
        /// extreme weather (T2-2): normal, heat, cold or storm; how heavy the rain is; how hard the wind gusts; which day of how long a spell
        public string kind = "normal"; public Num pour = 1, gust = T.wind.gust; public int spellDay, spellLen;
    }
    public sealed class Spell { public string kind; public long start; public int len; }
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
            // extreme weather (T2-2): a spell running on this day, else a storm roll
            var sp = WeatherSpell(seed, day);
            if (sp != null) { w.kind = sp.kind; w.spellDay = (int)(day - sp.start + 1); w.spellLen = sp.len; }
            if (w.kind == "heat") { w.@base += T.extreme.heatBoost; w.rain = false; w.wind *= T.extreme.heatWind; }
            else if (w.kind == "cold") w.@base -= T.extreme.coldDrop;
            else if (day > 0 && Unit(H(24)) < T.extreme.stormChance)
            {
                w.kind = "storm"; w.rain = true; w.pour = T.extreme.pour; w.gust = T.extreme.stormGust;
                w.rainStart = 13 * 60 + RangeInt(H(25), 0, 240); w.rainEnd = w.rainStart + 45 + RangeInt(H(26), 0, 90);
                w.wind = Range(H(27), T.extreme.stormWind[0], T.extreme.stormWind[1]);
            }
            lock (weatherCache) weatherCache[key] = w;
            return w;
        }
        static readonly Dictionary<ulong, List<Spell>> spellMemo = new Dictionary<ulong, List<Spell>>();
        /// A heatwave or a cold snap running on a day (T2-2): a spell runs its length, and a new one starts only on a day no
        /// spell covers; day by day from the first, memoized per seed (see world.js weatherSpell)
        public static Spell WeatherSpell(ulong seed, long day)
        {
            if (day < 1) return null;
            lock (spellMemo)
            {
                if (!spellMemo.TryGetValue(seed, out var memo)) { memo = new List<Spell> { null }; spellMemo[seed] = memo; }
                for (long d = memo.Count; d <= day; d++)
                {
                    var prev = memo[(int)d - 1];
                    if (prev != null && d < prev.start + prev.len) { memo.Add(prev); continue; }
                    ulong H(ulong i) => Hash(seed, Domain.Weather, U64(d), i);
                    Spell sp = null;
                    if (Unit(H(20)) < T.extreme.heatChance) sp = new Spell { kind = "heat", start = d, len = RangeInt(H(21), T.extreme.heatLen[0], T.extreme.heatLen[1] + 1) };
                    else if (Unit(H(22)) < T.extreme.coldChance) sp = new Spell { kind = "cold", start = d, len = RangeInt(H(23), T.extreme.coldLen[0], T.extreme.coldLen[1] + 1) };
                    memo.Add(sp);
                }
                return memo[(int)day];
            }
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
        public static HumanWin HumanWindow(ulong seed, ulong id, long day, Num density, bool evening = false)
        {
            ulong H(ulong i) => Hash(seed, Domain.HumanSchedule, id, U64(day), i);
            if (day > 0 && Unit(H(0)) > 0.85 * density) return null;
            // a beer garden's drinkers come in the afternoon and stay into the night (T2-5)
            Num arrive = day == 0 ? 0 : evening ? T.days.eveningFrom + RangeInt(H(1), 0, (int)T.days.eveningSpread) : 600 + RangeInt(H(1), 0, 150);
            Num leave = evening ? T.days.lateFrom + RangeInt(H(2), 0, (int)T.days.lateSpread) : 1020 + RangeInt(H(2), 0, 180);
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
        /// The pitched roof on a shed or a house, drawn and solid: the ridge runs along the long side, rise above the eaves at
        /// the top of the walls; it overhangs the walls by 0.12 m on the long sides and 0.1 m at the gable ends (world.js shedRoof)
        public static Roof ShedRoof(Shed sh)
        {
            bool alongX = sh.hw >= sh.hd; Num wall = alongX ? sh.hd : sh.hw, wallHalf = alongX ? sh.hw : sh.hd, S = wall + 0.12, rise = sh.house ? 1.9 : sh.barn ? 2.6 : 0.55;
            return new Roof { x = sh.x, z = sh.z, alongX = alongX, wall = wall, wallHalf = wallHalf, half = wallHalf + 0.1, S = S, y0 = sh.h, rise = rise, L = Sqrt(rise * rise + S * S) };
        }
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
        /// The build list (GDD 21.3, S3; world.js buildList): what a chunk's buildings and furniture are made of, as parts.
        /// s shape (0 box, 1 cylinder: sx top radius, sz foot radius, sy high, n sides; 2 gable sx either side, sy high; 3 bulb),
        /// m surface (0 siding, 1 plaster, 2 panels, 3 planks, 4 shingles, 5 plain, 6 lit), c colour, middle, size, turns,
        /// near (small), and a wall's top and footprint wb for its windows.
        public sealed class Part { public int s, m, n; public string c; public Num x, y, z, sx, sy, sz, rx, ry, rz, top; public Num[] wb; public bool near; }
        public static readonly string[] Sidings = { "#e3dccb", "#c9d3d6", "#dcc9a8", "#c7cdb6", "#efe9dd" };
        public static readonly string[] ShopColors = { "#c98f6b", "#d8c7a4", "#9fb3a1", "#b8a1c4", "#e0d0b8", "#a8bccd" };
        public static readonly string[] Awnings = { "#7a2f24", "#2f5f7a", "#3f7a2f", "#7a6a2f", "#5a2f7a", "#7a2f5a" };
        public static List<Part> BuildList(ChunkContent c)
        {
            var P = new List<Part>();
            void Add(int s, int m, string col, Num x, Num y, Num z, Num sx, Num sy, Num sz, bool near, Num rx = default, Num ry = default, Num rz = default, int n = 0, Num top = default, Num[] wb = null)
                => P.Add(new Part { s = s, m = m, c = col, x = x, y = y, z = z, sx = sx, sy = sy, sz = sz, rx = rx, ry = ry, rz = rz, n = n, near = near, top = top, wb = wb ?? new Num[] { 0, 0, 1e3, 1e3 } });
            foreach (var b in c.baths)
            {
                if (b.fountain) { Add(1, 5, "#b8b0a2", b.x, (b.h - 0.02) / 2, b.z, b.r + 0.15, b.h - 0.02, b.r + 0.2, false, n: 28); continue; }
                Add(1, 5, "#a9a49a", b.x, (b.h - 0.08) / 2, b.z, 0.07, b.h - 0.08, 0.11, true, n: 10);
                Add(1, 5, "#bdb8ad", b.x, b.h - 0.055, b.z, b.r + 0.03, 0.1, b.r * 0.55, true, n: 18);
            }
            foreach (var sh in c.shops)
            {
                Add(0, 1, ShopColors[sh.color % ShopColors.Length], sh.x, sh.h / 2, sh.z, sh.hw * 2, sh.h, sh.hd * 2, false, top: sh.h, wb: new[] { sh.x, sh.z, sh.hw, sh.hd });
                Add(0, 5, Awnings[sh.color % Awnings.Length], sh.x, 2.75, sh.z, sh.hw * 2 + 0.8, 0.12, sh.hd * 2 + 0.8, false);
            }
            int[,] lines = { { -1, -1, 1, -1 }, { 1, -1, 1, 1 }, { 1, 1, -1, 1 }, { -1, 1, -1, -1 }, { -1, 0, 1, 0 } }, posts = { { -1, -1 }, { 1, -1 }, { 1, 1 }, { -1, 1 } };
            foreach (var gd in c.gardens)
            {
                for (int l = 0; l < 5; l++)
                    for (int k = 0; k <= 12; k++) { Num f = (Num)k / 12; Add(3, 6, "#ffe7a8", gd.x + (lines[l, 0] + (lines[l, 2] - lines[l, 0]) * f) * gd.hw, 2.8 - 0.35 * DSin(3.141592653589793 * f), gd.z + (lines[l, 1] + (lines[l, 3] - lines[l, 1]) * f) * gd.hd, 0.05, 0.05, 0.05, true); }
                for (int k = 0; k < 4; k++) Add(1, 5, "#4a3a2c", gd.x + posts[k, 0] * gd.hw, 1.45, gd.z + posts[k, 1] * gd.hd, 0.05, 2.9, 0.05, false, n: 6);
            }
            foreach (var m in c.malls)
            {
                Add(0, 2, "#cdbfa6", m.x, m.h / 2, m.z, m.hw * 2, m.h, m.hd * 2, false, top: m.h - 1.2, wb: new[] { m.x, m.z, m.hw, m.hd });
                Add(0, 5, "#7a2f24", m.x, m.h - 0.6, m.z, m.hw * 2 + 0.1, 1.2, m.hd * 2 + 0.1, false);
            }
            foreach (var sh in c.sheds)
            {
                string siding = sh.house ? Sidings[(int)Abs(Floor(sh.x * 7 + sh.z * 3 + 0.5)) % 5] : "#7a5a3c";
                Add(0, sh.house ? 0 : 3, siding, sh.x, sh.h / 2, sh.z, sh.hw * 2, sh.h, sh.hd * 2, false, top: sh.h, wb: new[] { sh.x, sh.z, sh.hw, sh.hd });
                bool lng = sh.hw >= sh.hd; var rf = ShedRoof(sh);
                if (sh.house)
                {
                    int al0 = lng ? 1 : 0, al1 = lng ? 0 : 1, ac0 = lng ? 0 : 1, ac1 = lng ? 1 : 0; Num half = lng ? sh.hw : sh.hd, depth = lng ? sh.hd : sh.hw;
                    Num dv = lng ? c.cz * CS - sh.z : c.cx * CS - sh.x; int ds = dv > 0 ? 1 : dv < 0 ? -1 : 1;
                    Add(0, 5, "#6b3b2a", sh.x + ac0 * ds * (depth + 0.02), 1.49, sh.z + ac1 * ds * (depth + 0.02), al0 != 0 ? 1.0 : 0.06, 2.1, al1 != 0 ? 1.0 : 0.06, false); // at the stoop's height
                    foreach (int s in new[] { -1, 1 }) Add(2, 0, siding, sh.x + al0 * s * half, sh.h, sh.z + al1 * s * half, depth, rf.rise, 0, false, ry: lng ? 1.5707963267948966 : 0);
                }
                Num ang = DAtan2(rf.rise, rf.S), th = sh.house ? 0.12 : 0.05, cy = sh.h + rf.rise / 2 - rf.S / rf.L * th / 2, cu = rf.S / 2 - rf.rise / rf.L * th / 2;
                Num sx = lng ? rf.half * 2 : rf.L, sz = lng ? rf.L : rf.half * 2; string col = sh.house ? "#4e4b52" : "#3d3a36";
                foreach (int side in new[] { -1, 1 })
                {
                    if (lng) Add(0, 4, col, sh.x, cy, sh.z + side * cu, sx, th, sz, false, rx: side * ang);
                    else Add(0, 4, col, sh.x + side * cu, cy, sh.z, sx, th, sz, false, rz: -side * ang);
                }
                var ss = ShedSites(sh);
                Add(0, 5, "#0d0a07", ss.wall.x - ss.wall.nx * 0.008, ss.wall.y, ss.wall.z - ss.wall.nz * 0.008, ss.wall.nx != 0 ? 0.012 : 0.05, 0.12, ss.wall.nz != 0 ? 0.012 : 0.05, true);
                Add(0, 5, "#0d0a07", ss.attic.x - ss.attic.nx * 0.008, ss.attic.y, ss.attic.z - ss.attic.nz * 0.008, ss.attic.nx != 0 ? 0.012 : 0.4, 0.03, ss.attic.nz != 0 ? 0.012 : 0.4, true);
            }
            foreach (var g in c.garages) // a garage (S4): the house's siding, a flat roof, an up-and-over door facing the drive
            {
                Num w = g.x1 - g.x0, d = g.z1 - g.z0, mx = (g.x0 + g.x1) / 2, mz = (g.z0 + g.z1) / 2;
                Add(0, 0, Sidings[g.c], mx, g.h / 2, mz, w, g.h, d, false);
                Add(0, 5, "#4e4b52", mx, g.h + 0.06, mz, w + 0.2, 0.12, d + 0.2, false);
                Add(0, 5, "#d9d4c7", mx, 1.1, g.zf - g.s * 0.02, w - 0.8, 2.2, 0.06, false);
            }
            foreach (var r in c.rows) // an urban building (S6): plastered with a shopfront below, or sided with a door; a flat roof and cornice
            {
                Num w = r.x1 - r.x0 - 0.1, d = Abs(r.zB - r.zF), xm = (r.x0 + r.x1) / 2, zm = (r.zF + r.zB) / 2; string col = UrbanColors[r.c];
                Add(0, r.shop ? 1 : 0, col, xm, r.h / 2, zm, w, r.h, d, false, top: r.h, wb: new[] { xm, zm, w / 2, d / 2 });
                Add(0, 5, "#5a5652", xm, r.h + 0.06, zm, w, 0.12, d, false);
                Add(0, 5, "#77706a", xm, r.h - 0.15, zm, w + 0.12, 0.3, d + 0.12, false);
                if (r.shop) Add(0, 5, Awnings[r.c % Awnings.Length], xm, 2.75, r.zF - r.s * 0.45, w - 0.4, 0.12, 0.9, false);
                else Add(0, 5, "#4a3328", xm, 1.05, r.zF - r.s * 0.02, 1.0, 2.1, 0.06, false);
            }
            foreach (var b in c.boxes) if (b.wall || b.step)
                Add(0, 5, b.step ? "#b9b4a8" : b.back ? "#8f5a46" : b.retain ? "#9a9284" : "#a39b8e", (b.minx + b.maxx) / 2, b.maxy / 2, (b.minz + b.maxz) / 2, b.maxx - b.minx, b.maxy, b.maxz - b.minz, !b.back && !b.retain);
            string[] hedgeShades = { "#3b5a2a", "#46652f", "#355024" };
            foreach (var b in c.boxes) if (b.hedge) // a hedgerow section: a blocky bush (world.js)
                Add(0, 5, hedgeShades[(int)Abs(Floor(b.minx * 0.37 + b.minz * 0.61)) % 3], (b.minx + b.maxx) / 2, b.maxy / 2, (b.minz + b.maxz) / 2, b.maxx - b.minx, b.maxy, b.maxz - b.minz, false);
            foreach (var sh in c.sheds) if (sh.farm) Add(0, 5, "#8d8577", sh.x, 0.25, sh.z, sh.hw * 2 + 0.12, 0.5, sh.hd * 2 + 0.12, false); // the stone base course of a building on its footing
            foreach (var p in c.porches) // the stoop and its step, concrete
            {
                Add(0, 5, "#b9b4a8", p.x, 0.22, p.z - p.s * 0.6, 1.8, 0.44, 1.2, true);
                Add(0, 5, "#aea99c", p.x, 0.11, p.z - p.s * 1.35, 1.8, 0.22, 0.3, true);
            }
            foreach (var t in c.trees) Add(1, 5, "#5b4330", t.x, t.h / 2, t.z, t.r * 0.8, t.h, t.r, false, n: 9);
            foreach (var t in c.tables)
            {
                int al0 = t.axisX ? 1 : 0, al1 = t.axisX ? 0 : 1, ac0 = t.axisX ? 0 : 1, ac1 = t.axisX ? 1 : 0;
                foreach (Num s in new Num[] { -0.8, 0.8 }) foreach (Num q in new Num[] { -0.3, 0.3 }) Add(0, 5, "#8a6440", t.x + al0 * s + ac0 * q, 0.355, t.z + al1 * s + ac1 * q, 0.05, 0.71, 0.05, true);
                foreach (Num side in new Num[] { -0.67, 0.67 }) foreach (Num s in new Num[] { -0.75, 0.75 }) Add(0, 5, "#8a6440", t.x + al0 * s + ac0 * side, 0.2, t.z + al1 * s + ac1 * side, 0.05, 0.4, 0.05, true);
            }
            foreach (var b in c.boxes) if (b.bench && b.miny < 0.45) // a pond bench's seat stands on four legs at its corners
            {
                Num ix = (b.maxx - b.minx) / 2 - 0.08, iz = (b.maxz - b.minz) / 2 - 0.06, mx = (b.minx + b.maxx) / 2, mz = (b.minz + b.maxz) / 2;
                foreach (Num sx in new Num[] { -1, 1 }) foreach (Num sz in new Num[] { -1, 1 }) Add(0, 5, "#5b4330", mx + sx * ix, b.miny / 2, mz + sz * iz, 0.06, b.miny, 0.06, true);
            }
            foreach (var hv in c.hives)
            {
                Add(0, 5, "#5b4330", hv.x, 0.2, hv.z, 0.5, 0.4, 0.5, true);
                Add(0, 5, "#ece8dc", hv.x, 0.53, hv.z, 0.45, 0.25, 0.45, true);
                Add(0, 5, "#e2dccb", hv.x, 0.755, hv.z, 0.45, 0.2, 0.45, true);
                Add(0, 5, "#8d8a80", hv.x, 0.885, hv.z, 0.5, 0.06, 0.5, true);
                Add(0, 5, "#17120c", hv.ex, hv.ey - 0.05, hv.ez, hv.fx != 0 ? 0.01 : 0.16, 0.02, hv.fz != 0 ? 0.01 : 0.16, true);
            }
            return P;
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
        /// Feature modifiers (GDD 4.8, T2-6, see world.js features): woods 0-2, towns 0-2, water x0.5-2, hives x0-2
        public static Settings Features(Settings st) => st ?? DefaultFeatures;
        static readonly Settings DefaultFeatures = new Settings();
        public static RegionLayout Region(ulong seed, int rx, int rz, Settings st = null)
        {
            var F = Features(st);
            string key = seed + ":" + rx + "," + rz + ":" + F.woods + "," + F.towns;
            lock (regionCache)
            {
                if (regionCache.TryGetValue(key, out var L)) return L;
                ulong H(long slot) => Hash(seed, Domain.WorldGen, U64(rx), U64(rz), U64(90000 + slot));
                L = new RegionLayout { strip = rx == 0 && rz == 0 ? REGION / 2 : 2 + RangeInt(H(1), 0, 4), mallSide = RangeInt(H(2), 0, 4), mallFrom = RangeInt(H(3), 0, REGION - 2), forest = RangeInt(H(4), 0, 4) };
                // forest corners (2x2; a wooded world has two of 3x3, the second diagonally across)
                int fs = F.woods >= 2 ? 3 : 2;
                for (int k = 0; k < System.Math.Min(F.woods, 2); k++) { int f = k != 0 ? L.forest ^ 3 : L.forest; L.forests.Add(new ForestBlock { x = (f & 1) != 0 ? REGION - fs : 0, z = (f & 2) != 0 ? REGION - fs : 0, n = fs }); }
                // town centres (T2-5): a 2x2 block of yards, scanned for from a hashed start; never beside the home chunk, and a
                // second town never touching the first
                for (int t = 0; t < F.towns; t++)
                {
                    int sx = RangeInt(H(t != 0 ? 8 : 5), 0, REGION - 1), sz = RangeInt(H(t != 0 ? 9 : 6), 0, REGION - 1); bool home = rx == 0 && rz == 0;
                    for (int i = 0; i < (REGION - 1) * (REGION - 1); i++)
                    {
                        int tx = (sx + i) % (REGION - 1), tz = (sz + i / (REGION - 1)) % (REGION - 1);
                        bool ok = true;
                        foreach (var o in L.towns) if (!(tx > o.tx + 2 || tx + 1 < o.tx - 1 || tz > o.tz + 2 || tz + 1 < o.tz - 1)) ok = false;
                        for (int dz = 0; dz < 2 && ok; dz++) for (int dx = 0; dx < 2 && ok; dx++)
                        {
                            int lx = tx + dx, lz = tz + dz;
                            if (BaseUse(L, lx, lz) != "yards" || (home && System.Math.Abs(lx - REGION / 2) <= 1 && System.Math.Abs(lz - REGION / 2) <= 1)) ok = false;
                        }
                        if (ok) { L.towns.Add(new Town { tx = tx, tz = tz, garden = RangeInt(H(t != 0 ? 10 : 7), 0, 4) }); break; }
                    }
                }
                if (regionCache.Count > 256) regionCache.Clear();
                regionCache[key] = L;
                return L;
            }
        }
        /// land use before the town centres are laid over it
        static string BaseUse(RegionLayout L, int lx, int lz)
        {
            if (lz == L.strip) return "park";
            bool edge = L.mallSide == 0 ? lz == 0 : L.mallSide == 1 ? lx == REGION - 1 : L.mallSide == 2 ? lz == REGION - 1 : lx == 0;
            int along = L.mallSide % 2 != 0 ? lz : lx;
            if (edge && along >= L.mallFrom && along < L.mallFrom + 3) return "mall";
            foreach (var f in L.forests) if (lx >= f.x && lx < f.x + f.n && lz >= f.z && lz < f.z + f.n) return "forest";
            return "yards";
        }
        static (int rx, int rz, int lx, int lz) RegionOf(int cx, int cz) { int h = REGION / 2, rx = FloorDiv(cx + h, REGION), rz = FloorDiv(cz + h, REGION); return (rx, rz, cx + h - rx * REGION, cz + h - rz * REGION); }
        /// which quarter of a town centre a chunk is (0 or 1 each way), whether it is the beer garden or has the fountain, or null
        public static TownQ TownQuarter(ulong seed, int cx, int cz, Settings st = null)
        {
            var R = RegionOf(cx, cz); var L = Region(seed, R.rx, R.rz, st);
            foreach (var t in L.towns)
            {
                int qx = R.lx - t.tx, qz = R.lz - t.tz, k = qx + 2 * qz;
                if (qx >= 0 && qx < 2 && qz >= 0 && qz < 2) return new TownQ { qx = qx, qz = qz, garden = k == t.garden, fountain = k == (t.garden + 2) % 4 };
            }
            return null;
        }
        /// farmland (world.js RURAL, S5): the settled area's outer ring, its lanes, hedgerows and farmsteads
        public static readonly Num RuralRing = 128, RuralInner = 192, RuralLane = 5.5, RuralHedge = 1.2, RuralHedgeH = 1.7, RuralStead = 0.35, RuralPlinth = 1.5, RuralSteep = (Num)1 / 3, RuralMax = 0.35;
        public static string LandUse(ulong seed, int cx, int cz, Settings st = null)
        {
            if (cx == 0 && cz == 0) return "park";
            if (st != null && st.settled > 0)
            {
                // squared, in whole numbers: exact as far from home as a long reaches (a Num or an int overflows past ~46 km, ~3,000 km)
                long n = (long)cx * cx + (long)cz * cz, csz = (long)(double)CS, m = System.Math.Max(st.settled - (long)(double)RuralRing, (long)(double)RuralInner);
                if (n * csz * csz > (long)st.settled * st.settled) return "wild"; // past the settled area
                if (n * csz * csz > m * m) return "farm"; // its outer ring (S5)
            }
            var R = RegionOf(cx, cz);
            if (TownQuarter(seed, cx, cz, st) != null) return "town";
            string bu = BaseUse(Region(seed, R.rx, R.rz, st), R.lx, R.lz);
            // the urban blocks round a town square (S6): yards beside a town centre, never beside the home park
            if (bu == "yards" && (System.Math.Abs(cx) > 1 || System.Math.Abs(cz) > 1)) for (int dz = -1; dz <= 1; dz++) for (int dx = -1; dx <= 1; dx++) if ((dx != 0 || dz != 0) && TownQuarter(seed, cx + dx, cz + dz, st) != null) return "urban";
            return bu;
        }
        // ---------------------------------------------------------------- terrain (T2-6, ground v2 GDD 20 G1; see world.js groundAt)
        static readonly Num[] lat = new Num[65536];
        static ulong latticeSeed; static bool latticeOn;
        static long CellKey(long ix, long iz) => (ix + 33554432) * 67108864 + (iz + 33554432); // |i| < 2^25 (world.js)
        /// the 256 x 256 lattice from the world seed (a fast 32-bit hash keyed by one full hash of the seed)
        static Num Lattice(ulong seed, long ix, long iz)
        {
            lock (lat)
            {
                if (!latticeOn || latticeSeed != seed)
                {
                    latticeOn = true; latticeSeed = seed;
                    int b = unchecked((int)(uint)(Hash(seed, Domain.WorldGen, U64(0x7E50)) >> 32));
                    for (int j = 0; j < 256; j++) for (int i = 0; i < 256; i++) lat[(j << 8) | i] = H32(b, i, j, 0x7E50) * 2 - 1;
                }
                return lat[(int)(((iz & 255) << 8) | (ix & 255))];
            }
        }
        /// value noise with its derivatives (quintic fade)
        static (Num v, Num dx, Num dy) Noised(ulong seed, Num x, Num y)
        {
            Num fpx = Floor(x), fpy = Floor(y); long px = (long)fpx, py = (long)fpy; Num fx = x - fpx, fy = y - fpy;
            Num ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
            Num dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
            Num a = Lattice(seed, px, py), b = Lattice(seed, px + 1, py), c = Lattice(seed, px, py + 1), d = Lattice(seed, px + 1, py + 1);
            Num k1 = b - a, k2 = c - a, k4 = a - b - c + d;
            return (a + k1 * ux + k2 * uy + k4 * ux * uy, dux * (k1 + k4 * uy), duy * (k2 + k4 * ux));
        }
        static Num Smooth(Num t) => t * t * (3 - 2 * t);
        /// the shape, before the modifier, the home ring and land use: derivative-damped, rotated, domain-warped fbm
        static Num GroundShape(ulong seed, Num x, Num z, int oct)
        {
            Num bx = (0.6 * x - 0.8 * z) / T.terrain.cell, by = (0.8 * x + 0.6 * z) / T.terrain.cell;
            Num wx = Noised(seed, bx * 0.43 + 3.1, by * 0.43 + 7.7).v;
            Num wy = Noised(seed, bx * 0.43 - 5.3, by * 0.43 + 1.9).v;
            Num px = bx + T.terrain.warp * wx, py = by + T.terrain.warp * wy, a = 0, b = 1, dx = 0, dy = 0, lo = 0;
            int L = System.Math.Min(oct, 2);
            for (int i = 0; i < oct; i++)
            {
                var n = Noised(seed, px, py);
                dx += n.dx; dy += n.dy;
                a += b * n.v / (1 + dx * dx + dy * dy);
                if (i == L - 1) lo = a;
                b *= 0.5;
                Num qx = 0.8 * px - 0.6 * py, qy = 0.6 * px + 0.8 * py; px = qx * 2; py = qy * 2;
            }
            if (T.terrain.ridge != 0) { Num r = 1 - Abs(Noised(seed, bx * 0.5 + 11.7, by * 0.5 - 4.2).v); a += T.terrain.ridge * (r * r - 0.4); }
            if (T.terrain.terrace != 0) // steps cut in the broad shape only, so they stay put; the treads kept flat
            {
                Num q = lo / T.terrain.terraceStep, fl = Floor(q), f = q - fl, s5 = f * f * f * (f * (f * 6 - 15) + 10);
                a += (fl + Min(1, Max(0, (s5 - 0.5) * 1.5 + 0.5))) * T.terrain.terraceStep * T.terrain.terrace - lo * T.terrain.terrace - (a - lo) * 0.6 * T.terrain.terrace;
            }
            return a;
        }
        static readonly Dictionary<long, Num> rolls = new Dictionary<long, Num>(); static string rollTag;
        /// how much a chunk's land use lets the ground roll
        static Num ChunkRoll(ulong seed, int cx, int cz, Settings st)
        {
            var F = Features(st); string tag = seed + ":" + F.woods + "," + F.towns;
            lock (rolls)
            {
                if (rollTag != tag) { rollTag = tag; rolls.Clear(); }
                long k = CellKey(cx, cz);
                if (rolls.TryGetValue(k, out var v)) return v;
                if (rolls.Count > 4096) rolls.Clear();
                string u = LandUse(seed, cx, cz, st);
                v = u == "park" ? T.terrain.roll.park : u == "forest" ? T.terrain.roll.forest : u == "yards" ? T.terrain.roll.yards : u == "mall" ? T.terrain.roll.mall : u == "town" ? T.terrain.roll.town : u == "farm" ? T.terrain.roll.farm : u == "urban" ? T.terrain.roll.urban : 1;
                rolls[k] = v;
                return v;
            }
        }
        /// the ground before grading: oct octaves, times the modifier, the home ring and land use
        static Num NaturalGround(ulong seed, Num x, Num z, Settings st, int terrain, int oct)
        {
            Num f = Smooth(Clamp01((Sqrt(x * x + z * z) - T.terrain.flatR) / T.terrain.rise));
            if (f == 0) return 0;
            Num u = x / CS, v = z / CS; int i = (int)Floor(u), j = (int)Floor(v); Num tu = Smooth(u - i), tv = Smooth(v - j);
            Num a = ChunkRoll(seed, i, j, st), b = ChunkRoll(seed, i + 1, j, st), c = ChunkRoll(seed, i, j + 1, st), d = ChunkRoll(seed, i + 1, j + 1, st);
            Num roll = a + (b - a) * tu + (c - a) * tv + (a - b - c + d) * tu * tv;
            return terrain * T.terrain.amp * f * roll * GroundShape(seed, x, z, oct);
        }
        /// a chunk's paving and buildings, as GenerateChunk places them, without generating the rest (world.js pavingOf)
        public sealed class Paving
        {
            public List<Rect> roads = new List<Rect>(), lots = new List<Rect>(), plazas = new List<Rect>();
            public List<Loop> loops = new List<Loop>(); public List<Mall> malls = new List<Mall>(); public List<Shop> shops = new List<Shop>(); public List<Shed> houses = new List<Shed>();
            public List<Pond> ponds = new List<Pond>(); public List<Rect> drives = new List<Rect>(); public List<UrbanBuilding> rows = new List<UrbanBuilding>();
        }
        /// urban blocks (world.js URBAN, S6)
        public static readonly Num UrbLot = 7.5, UrbSetback = 1, UrbDepth = 11, UrbRear = 2.2, UrbM = 0.6, UrbMr = 0.05, UrbWall = 0.3, UrbStep = 0.18, UrbRun = 0.28, UrbStairW = 1.2, UrbLow = 0.45, UrbBack = 2.2, UrbMid = 0.6, UrbShop = 0.25;
        public const int UrbLots = 8;
        public static readonly string[] UrbanColors = { "#b5654a", "#c9b49a", "#a8553f", "#d8cdb8", "#8f5a46", "#cfc2a6" };
        static bool Streets(string u) => u == "yards" || u == "urban";
        public static List<UrbanBuilding> UrbanBuildings(System.Func<long, ulong> H, Num ox, bool main)
        {
            var o = new List<UrbanBuilding>();
            foreach (int s in new[] { -1, 1 })
            {
                long b = s < 0 ? 8000 : 8500; int mid = Unit(H(b)) < UrbMid ? RangeInt(H(b + 1), 0, UrbLots - 2) : -1;
                for (int k = 0; k < UrbLots; k++)
                {
                    bool big = k == mid; int n = big ? 3 : 1; Num x0 = ox - UrbLot * UrbLots / 2 + k * UrbLot, x1 = x0 + n * UrbLot;
                    o.Add(new UrbanBuilding { x0 = x0, x1 = x1, s = s, storeys = big ? RangeInt(H(b + 10 + k), 4, 6) : RangeInt(H(b + 10 + k), 2, 4), c = RangeInt(H(b + 30 + k), 0, UrbanColors.Length), shop = main || Unit(H(b + 50 + k)) < UrbShop, mid = big });
                    if (big) k += 2;
                }
            }
            return o;
        }
        public static (Num zA, Num zF, Num zB, Num zD, Num zE) UrbanLines(Num oz, int s)
        {
            Num a = 4 + T.terrain.grade.walk, f = a + UrbSetback, b = f + UrbDepth, e = b + UrbRear;
            return (oz + s * a, oz + s * f, oz + s * b, oz + s * e, oz + s * 32);
        }
        static bool UrbanMain(ulong seed, int cx, int cz, Settings st) => TownQuarter(seed, cx + 1, cz, st) != null || TownQuarter(seed, cx - 1, cz, st) != null || TownQuarter(seed, cx, cz + 1, st) != null || TownQuarter(seed, cx, cz - 1, st) != null;
        /// A house's garage and drive (world.js garageOf, driveOf; GDD 21.2, S4)
        public static readonly Num GarageShare = 0.8, GarageW = 3.6, GarageD = 6.5, GarageH = 2.8, GarageInset = 0.3, GarageGap = 1.2, PorchRun = 1.6;
        public static Garage GarageOf(System.Func<long, ulong> H, long b, Num x, Num z, Num hw, Num hd, int s)
        {
            if (Unit(H(b + 7)) >= GarageShare) return null;
            int side = Unit(H(b + 8)) < 0.5 ? -1 : 1; Num x0 = side > 0 ? x + hw + GarageGap : x - hw - GarageGap - GarageW, zf = z - s * hd, zb = zf + s * GarageD;
            return new Garage { x0 = x0, x1 = x0 + GarageW, z0 = Min(zf, zb), z1 = Max(zf, zb), zf = zf, s = s, h = GarageH, c = (int)Abs(Floor(x * 7 + z * 3 + 0.5)) % 5 };
        }
        public static Rect DriveOf(Garage g, Num oz)
        {
            Num zs = oz + g.s * (4 + T.terrain.grade.walk);
            return new Rect { minx = g.x0 + GarageInset, maxx = g.x1 - GarageInset, minz = Min(zs, g.zf), maxz = Max(zs, g.zf) };
        }
        /// a chunk's pond (world.js pondsOf): some parks and woods, never the home park, clear of the picnic table, the walk
        /// round a park and a wood's path; a few spots tried, the first that fits taken
        /// a pond's edge at bearing a: lobed, 0.72 to 1 times its radius (world.js pondEdge)
        public static Num PondEdge(Pond p, Num a) => p.r * (0.86 + 0.08 * DSin(2 * a + p.a) + 0.06 * DSin(3 * a + p.b));
        public static bool InPond(Pond p, Num x, Num z, Num m)
        {
            Num dx = x - p.x, dz = z - p.z, d2 = dx * dx + dz * dz;
            if (d2 >= (p.r + m) * (p.r + m)) return false;
            Num e = PondEdge(p, DAtan2(dz, dx)) + m;
            return d2 < e * e;
        }
        public static class PondPath { public static Num inner = 1.2, outer = 2.2, bench = 2.9; }
        public static List<Pond> PondsOf(ulong seed, int cx, int cz, Settings st = null)
        {
            var o = new List<Pond>();
            if (cx == 0 && cz == 0) return o;
            string use = LandUse(seed, cx, cz, st);
            if (use != "park" && use != "forest") return o;
            ulong H(long slot) => Hash(seed, Domain.WorldGen, U64(cx), U64(cz), U64(slot));
            var F = Features(st); Num ox = cx * CS, oz = cz * CS; bool park = use == "park";
            bool home = cx == -1 && cz == 0 && park; // the park beside the home park always has one
            if (!home && Unit(H(9100)) >= (park ? T.water.pondPark : T.water.pondForest) * F.water) return o;
            Num r = home ? Range(H(9101), T.water.pondMin, T.water.pondMin + 2) : park ? Range(H(9101), T.water.pondMin, T.water.pondMax) : Range(H(9101), T.water.pondForestMin, T.water.pondForestMax), ring = park ? PondPath.bench + 0.6 : 0, m = 28 - r - ring;
            Num pa = Range(H(9120), 0, 6.28), pb = Range(H(9121), 0, 6.28);
            bool picnic = park && Unit(H(1)) < 0.6; Num px = 0, pz = 0;
            if (picnic) { px = ox + Range(H(2), -20, 20); pz = oz + Range(H(3), -20, 20); }
            Num walk = park && Unit(H(6000)) < 0.6 ? Range(H(6001), 12, 22) : 0;
            bool path = !park && Unit(H(6300)) < 0.3;
            for (int k = 0; k < (home ? 36 : 10); k++) // a few spots tried; the home pond tries harder, at last across the walk
            {
                Num x = ox + Range(H(9102 + 2 * k), -m, m), z = oz + Range(H(9103 + 2 * k), -m, m);
                if (picnic && (x - px) * (x - px) + (z - pz) * (z - pz) < (r + ring + 6) * (r + ring + 6)) continue;
                if (walk != 0 && !(home && k >= 12)) { Num c = Max(Abs(x - ox), Abs(z - oz)), e = r + ring; if (c - e < walk + 2 && c + e > walk - 2) continue; }
                if (path)
                {
                    Num ax = x - (ox - 26), az = z - (oz - 20), t = Max(0, Min(1, (ax * 52 + az * 40) / (52 * 52 + 40 * 40))), dx = ax - 52 * t, dz = az - 40 * t;
                    if (dx * dx + dz * dz < (r + 2) * (r + 2)) continue;
                }
                o.Add(new Pond { x = x, z = z, r = r, a = pa, b = pb, park = park });
                return o;
            }
            return o;
        }
        public static Paving PavingOf(ulong seed, int cx, int cz, Settings st = null)
        {
            ulong H(long slot) => Hash(seed, Domain.WorldGen, U64(cx), U64(cz), U64(slot));
            Num ox = cx * CS, oz = cz * CS; var o = new Paving();
            if (cx == 0 && cz == 0) return o;
            o.ponds = PondsOf(seed, cx, cz, st);
            string use = LandUse(seed, cx, cz, st);
            if (use == "yards" || use == "urban")
            {
                bool endW = !Streets(LandUse(seed, cx - 1, cz, st)), endE = !Streets(LandUse(seed, cx + 1, cz, st));
                o.roads.Add(new Rect { minx = ox + (endW ? -22 : -32), maxx = ox + (endE ? 22 : 32), minz = oz - 4, maxz = oz + 4 });
                if (endW) o.loops.Add(new Loop { x = ox - 22, z = oz, r = 11 });
                if (endE) o.loops.Add(new Loop { x = ox + 22, z = oz, r = 11 });
            }
            if (use == "urban") o.rows = UrbanBuildings(H, ox, UrbanMain(seed, cx, cz, st));
            else if (use == "yards")
            {
                for (int li = 0; li < 4; li++)
                {
                    int s = li < 2 ? -1 : 1; Num lx = ox + (li % 2 != 0 ? 16 : -16); long b = 3000 + li * 2000;
                    if (Unit(H(b)) < 0.9)
                    {
                        Num x = lx + Range(H(b + 1), -3, 3), z = oz + s * 15.5, hw = Range(H(b + 2), 5, 6.5), hd = Range(H(b + 3), 4, 5); var g = GarageOf(H, b, x, z, hw, hd, s);
                        o.houses.Add(new Shed { x = x, z = z, hw = hw, hd = hd, house = true, g = g });
                        if (g != null) o.drives.Add(DriveOf(g, oz));
                    }
                }
            }
            else if (use == "mall")
            {
                int side = MallSide(seed, cx, cz, st);
                int o0 = side == 1 ? 1 : side == 3 ? -1 : 0, o1 = side == 0 ? -1 : side == 2 ? 1 : 0, a0 = o0 != 0 ? 0 : 1, a1 = o0 != 0 ? 1 : 0;
                (Num x, Num z) At(Num u, Num v) => (ox + a0 * u + o0 * v, oz + a1 * u + o1 * v);
                var bp = At(0, 21); Num hx = o0 != 0 ? 8 : 27, hz = o0 != 0 ? 27 : 8; var l0 = At(-28, 11); var l1 = At(28, -20);
                o.malls.Add(new Mall { x = bp.x, z = bp.z, hw = hx, hd = hz });
                o.lots.Add(new Rect { minx = Min(l0.x, l1.x), maxx = Max(l0.x, l1.x), minz = Min(l0.z, l1.z), maxz = Max(l0.z, l1.z) });
            }
            else if (use == "town")
            {
                var q = TownQuarter(seed, cx, cz, st); int ix = q.qx != 0 ? -1 : 1, iz = q.qz != 0 ? -1 : 1;
                o.plazas.Add(new Rect { minx = ox - 32, maxx = ox + 32, minz = oz - 32, maxz = oz + 32 });
                o.shops.Add(new Shop { x = ox - ix * 22, z = oz - iz * 22, hw = 9, hd = 9 });
                o.shops.Add(new Shop { x = ox - ix * 25, z = oz + iz * 6, hw = 6, hd = 8 });
                o.shops.Add(new Shop { x = ox + ix * 6, z = oz - iz * 25, hw = 8, hd = 6 });
            }
            return o;
        }
        /// graded ground (GDD 20): kinds 0 street (levelled across at hz), 1 level rect, 2 cul-de-sac, 3 broad-shaped rect, 4 pond (level disc)
        sealed class Pad
        {
            public int k; public Num minx, maxx, minz, maxz, x, z, r, m, hx, hz, h; public bool hSet; public Shed src;
            // a house pad (5) and its front-yard ramp (6), a street (0) or cul-de-sac (2), a footing: worked out per step of the
            // modifier (GDD 21.2): height, shoulder, the ramp's start height
            public Num z0, run, zw, zf, cap, xd; public int sg; public bool road, @fixed, drv; public Pad pad, ramp; public List<Pad> rows;
            public readonly Num[] hT = new Num[4], mT = new Num[4], hwT = new Num[4]; public readonly bool[] tSet = new bool[4];
        }
        static readonly Dictionary<long, List<Pad>> pads = new Dictionary<long, List<Pad>>(); static string padTag;
        static List<Pad> PadsOf(ulong seed, int cx, int cz, Settings st)
        {
            var F = Features(st); string tag = seed + ":" + F.woods + "," + F.towns + "," + N(F.water) + "," + N(F.hives) + "," + F.settled + ShapeTag();
            lock (pads)
            {
                if (padTag != tag) { padTag = tag; pads.Clear(); }
                long key = CellKey(cx, cz);
                if (pads.TryGetValue(key, out var P)) return P;
                if (pads.Count > 4096) pads.Clear();
                var c = PavingOf(seed, cx, cz, st); P = new List<Pad>();
                void R(int k, Num minx, Num maxx, Num minz, Num maxz, Num m, Num hx, Num hz) => P.Add(new Pad { k = k, minx = minx, maxx = maxx, minz = minz, maxz = maxz, m = m, hx = hx, hz = hz });
                foreach (var l in c.loops) P.Add(new Pad { k = 2, x = l.x, z = l.z, r = l.r, m = T.terrain.grade.road, hx = 0, hz = l.z });
                foreach (var l in c.lots) R(1, l.minx, l.maxx, l.minz, l.maxz, T.terrain.grade.lot, (l.minx + l.maxx) / 2, (l.minz + l.maxz) / 2);
                foreach (var q in c.plazas) R(3, q.minx, q.maxx, q.minz, q.maxz, T.terrain.grade.lot, 0, 0);
                foreach (var b in c.malls) R(1, b.x - b.hw, b.x + b.hw, b.z - b.hd, b.z + b.hd, T.terrain.grade.house, b.x, b.z);
                foreach (var b in c.shops) R(1, b.x - b.hw, b.x + b.hw, b.z - b.hd, b.z + b.hd, T.terrain.grade.house, b.x, b.z);
                foreach (var q in c.ponds) P.Add(new Pad { k = 4, x = q.x, z = q.z, r = q.r, m = T.terrain.grade.pond, hx = q.x, hz = q.z });
                foreach (var r in c.roads) R(0, r.minx, r.maxx, r.minz - T.terrain.grade.walk, r.maxz + T.terrain.grade.walk, T.terrain.grade.road, 0, (r.minz + r.maxz) / 2);
                var ramps = new List<Pad>();
                foreach (var b in c.houses) // a house's pad and its front-yard ramp (GDD 21.2), neither past the sidewalk
                {
                    var road = c.roads.Count > 0 ? c.roads[0] : null; Num rz = road != null ? (road.minz + road.maxz) / 2 : b.z;
                    int sg = road == null ? 1 : b.z - rz > 0 ? 1 : b.z - rz < 0 ? -1 : 0;
                    Num zw = road != null ? (sg > 0 ? road.maxz + T.terrain.grade.walk : road.minz - T.terrain.grade.walk) : b.z;
                    // the pad takes in the garage beside the house and the porch before its door (S4); the front yard runs from there
                    Num zf = b.z - sg * (b.hd + PorchRun), x0 = b.g != null ? Min(b.x - b.hw, b.g.x0) : b.x - b.hw, x1 = b.g != null ? Max(b.x + b.hw, b.g.x1) : b.x + b.hw;
                    var pad = new Pad { k = 5, minx = x0, maxx = x1, minz = Min(zf, b.z - b.hd), maxz = Max(zf, b.z + b.hd), m = T.terrain.grade.house, hx = b.x, hz = b.z, z0 = rz, run = Abs(zf - zw), road = road != null, zw = zw, sg = sg, drv = b.g != null, xd = b.g != null ? (b.g.x0 + b.g.x1) / 2 : 0 };
                    P.Add(pad);
                    if (road != null) ramps.Add(pad.ramp = new Pad { k = 6, minx = x0, maxx = x1, minz = Min(zw, zf), maxz = Max(zw, zf), m = T.terrain.grade.house, zw = zw, zf = zf, sg = sg, z0 = rz, pad = pad });
                }
                P.AddRange(ramps);
                // an urban block (S6): each side's court (8) at its lowest building pad, then each building's pad (7) at the street's height
                if (c.rows.Count > 0)
                {
                    Num z0 = (c.roads[0].minz + c.roads[0].maxz) / 2, oxu = cx * CS;
                    foreach (int s in new[] { -1, 1 })
                    {
                        var L = UrbanLines(z0, s); var rows = new List<Pad>();
                        foreach (var b in c.rows) if (b.s == s) rows.Add(new Pad { k = 7, minx = b.x0, maxx = b.x1, minz = Min(L.zA + s * 0.06, L.zD), maxz = Max(L.zA + s * 0.06, L.zD), m = UrbMr, hx = (b.x0 + b.x1) / 2, hz = (L.zA + L.zD) / 2, z0 = z0 });
                        P.Add(new Pad { k = 8, minx = oxu - UrbLot * UrbLots / 2, maxx = oxu + UrbLot * UrbLots / 2, minz = Min(L.zD, L.zE), maxz = Max(L.zD, L.zE), m = UrbM, hx = oxu, hz = (L.zD + L.zE) / 2, rows = rows });
                        P.AddRange(rows);
                    }
                }
                pads[key] = P;
                return P;
            }
        }
        /// the terrain's shape tuning: a cache of pads, footings or street nodes is dropped when it changes (world.js shapeStamp)
        static string ShapeTag() => "|" + N(T.terrain.amp) + "," + N(T.terrain.cell) + "," + T.terrain.octaves + "," + N(T.terrain.warp) + "," + N(T.terrain.ridge) + "," + N(T.terrain.terrace) + "," + N(T.terrain.terraceStep) + "," + T.terrain.grade.oct;
        static string N(Num v) => ((double)v).ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        /// The ground's height: the shape times the modifier, flat when the terrain modifier is 0 and round the home
        /// tree, damped under built-up land, graded under streets, lots, squares and buildings. The sim works in height above it.
        /// a world settled only round the home tree (GDD 21.6; world.js settledOf): the site on the wild land and the band
        public static (int S, WildSite site, Num R0, Num R1) SettledOf(ulong seed, Settings st)
        {
            int S = Wild.Seed(seed); var site = Wild.Site(S, st.settled); Num R0 = st.settled + Wild.Edge;
            return (S, site, R0, R0 + Wild.Band);
        }
        /// the wild land at (x, z) of a settled world, in the sim's coordinates
        public static Num[] WildHere(ulong seed, Num x, Num z, Settings st, Num[] o = null)
        {
            var I = SettledOf(seed, st);
            return Wild.At(I.S, x + I.site.x, z + I.site.z, o);
        }
        /// the ground before the footings (world.js groundNatural)
        public static Num GroundNatural(ulong seed, Num x, Num z, Settings st)
        {
            int terrain = st != null ? st.terrain : 0; Num h = terrain != 0 ? GroundBase(seed, x, z, st, terrain) : 0;
            return st != null && st.settled > 0 ? h + SettledOf(seed, st).site.h : h;
        }
        public static Num GroundAt(ulong seed, Num x, Num z, Settings st)
        {
            if (st != null && st.settled > 0)
            {
                var I = SettledOf(seed, st); Num r = Sqrt(x * x + z * z);
                if (r >= I.R1) return Wild.At(I.S, x + I.site.x, z + I.site.z)[0];
                Num hs = GroundSim(seed, x, z, st) + I.site.h;
                if (r <= I.R0) return hs;
                Num k = Smooth(Min(1, (r - I.R0) / (I.R1 - I.R0)));
                return hs + (Wild.At(I.S, x + I.site.x, z + I.site.z)[0] - hs) * k;
            }
            return GroundSim(seed, x, z, st);
        }
        static Num GroundSim(ulong seed, Num x, Num z, Settings st)
        {
            int terrain = st?.terrain ?? 0;
            if (terrain == 0) return 0;
            Num h = GroundBase(seed, x, z, st, terrain);
            Num M = T.terrain.grade.reach;
            int c0x = ChunkOf(x - M), c1x = ChunkOf(x + M), c0z = ChunkOf(z - M), c1z = ChunkOf(z + M);
            for (int cz = c0z; cz <= c1z; cz++) for (int cx = c0x; cx <= c1x; cx++)
                    foreach (var p in FootingsOf(seed, cx, cz, st))
                    {
                        Num d;
                        if (p.k == 6) d = Max(0, Sqrt((x - p.x) * (x - p.x) + (z - p.z) * (z - p.z)) - p.r);
                        else { Num dx = Max(Max(p.minx - x, 0), x - p.maxx), dz = Max(Max(p.minz - z, 0), z - p.maxz); d = Sqrt(dx * dx + dz * dz); }
                        Footing(seed, p, st, terrain);
                        Num pm = p.mT[terrain];
                        if (d >= pm) continue;
                        Num w = 1 - Smooth(d / pm);
                        h += (p.hT[terrain] - h) * w;
                    }
            return h;
        }
        /// Footings (GDD 18.75, G3): a level pad under each small thing that stands on the ground, apron m round its
        /// footprint at the ground's height at its middle, blending back over shed m. Kinds: 5 rect, 6 disc.
        static readonly Dictionary<long, List<Pad>> feet = new Dictionary<long, List<Pad>>(); static string feetTag;
        public static int FootingCount(ulong seed, int cx, int cz, Settings st) => FootingsOf(seed, cx, cz, st).Count;
        static List<Pad> FootingsOf(ulong seed, int cx, int cz, Settings st)
        {
            var F = Features(st); string tag = seed + ":" + F.woods + "," + F.towns + "," + N(F.water) + "," + N(F.hives) + "," + F.settled + ShapeTag();
            lock (feet)
            {
                if (feetTag != tag) { feetTag = tag; feet.Clear(); }
                long key = CellKey(cx, cz);
                if (feet.TryGetValue(key, out var P)) return P;
                if (feet.Count > 4096) feet.Clear();
                var c = GenerateChunk(seed, cx, cz, st); P = new List<Pad>(); Num a = T.terrain.grade.apron, m = T.terrain.grade.shed;
                void R(Num x, Num z, Num hw, Num hd) => P.Add(new Pad { k = 5, minx = x - hw - a, maxx = x + hw + a, minz = z - hd - a, maxz = z + hd + a, m = m, hx = x, hz = z });
                foreach (var t in c.tables) { if (t.axisX) R(t.x, t.z, 0.95, 0.81); else R(t.x, t.z, 0.81, 0.95); }
                foreach (var s in c.sheds) if (!s.house || s.farm) { R(s.x, s.z, s.hw, s.hd + (s.house ? 1.6 : 0)); P[P.Count - 1].src = s; } // a farmhouse too, with its porch (S5)
                foreach (var hv in c.hives) R(hv.x, hv.z, 0.225, 0.225);
                foreach (var b in c.boxes) if (b.bench && b.miny < 0.45) { R((b.minx + b.maxx) / 2, (b.minz + b.maxz) / 2, (b.maxx - b.minx) / 2 + 0.25, (b.maxz - b.minz) / 2 + 0.25); P[P.Count - 1].@fixed = true; }
                foreach (var b in c.baths) P.Add(new Pad { k = 6, x = b.x, z = b.z, r = b.r + a, m = m, hx = b.x, hz = b.z });
                var Bq = new List<(Num x, Num z, Num hw, Num hd)>(); // a footing's shoulder stops short of any building's pad
                foreach (var q in c.sheds) if (q.house && !q.farm) Bq.Add((q.x, q.z, q.hw, q.hd));
                foreach (var q in c.shops) Bq.Add((q.x, q.z, q.hw, q.hd));
                foreach (var q in c.malls) Bq.Add((q.x, q.z, q.hw, q.hd));
                foreach (var f in P)
                {
                    Num cap = T.terrain.grade.reach;
                    foreach (var o in P) // and of a farmstead's other buildings' footings (S5)
                    {
                        if (o == f || o.src == null || !o.src.farm || o.k != 5 || f.k != 5) continue;
                        Num ox2 = Max(Max(0, o.minx - f.maxx), f.minx - o.maxx), oz2 = Max(Max(0, o.minz - f.maxz), f.minz - o.maxz);
                        cap = Min(cap, Sqrt(ox2 * ox2 + oz2 * oz2));
                    }
                    foreach (var q in Bq)
                    {
                        Num dx = f.k == 6 ? Max(0, Abs(f.x - q.x) - q.hw - f.r) : Max(Max(0, q.x - q.hw - f.maxx), f.minx - q.x - q.hw), dz = f.k == 6 ? Max(0, Abs(f.z - q.z) - q.hd - f.r) : Max(Max(0, q.z - q.hd - f.maxz), f.minz - q.z - q.hd);
                        cap = Min(cap, Sqrt(dx * dx + dz * dz));
                    }
                    f.cap = Max(0.25, cap);
                }
                feet[key] = P;
                return P;
            }
        }
        /// a footing's height and shoulder (2:1 banks at most), once per step of the modifier (world.js footing)
        static void Footing(ulong seed, Pad p, Settings st, int terrain)
        {
            lock (p)
            {
                if (p.tSet[terrain]) return;
                Num h = GroundBase(seed, p.hx, p.hz, st, terrain), drop = 0;
                int[,] c4 = { { -1, -1 }, { 1, -1 }, { 1, 1 }, { -1, 1 } };
                for (int k = 0; k < 4; k++)
                {
                    int ax = c4[k, 0], az = c4[k, 1];
                    Num x = p.k == 6 ? p.x + ax * (p.r + 1) : ax < 0 ? p.minx - 1 : p.maxx + 1, z = p.k == 6 ? p.z + az * (p.r + 1) : az < 0 ? p.minz - 1 : p.maxz + 1;
                    drop = Max(drop, Abs(h - GroundBase(seed, x, z, st, terrain)));
                }
                p.hT[terrain] = h; p.mT[terrain] = Min(p.cap, p.@fixed ? T.terrain.grade.shed : Max(T.terrain.grade.shed, Min(T.terrain.grade.reach, 4 * drop + 0.5))); p.tSet[terrain] = true;
            }
        }
        /// a street's height along its length, held to its grade limit with no kinks (GDD 21.1; world.js streetAt): levels
        /// at nodes from the mean of the highest and lowest lines of the limiting slope, a quadratic B-spline through them
        static readonly Dictionary<long, Num> streetNodes = new Dictionary<long, Num>(), streetLevels = new Dictionary<long, Num>(); static string streetTag;
        static Num StreetLevel(ulong seed, int i, int row, Num z0, Settings st, int terrain)
        {
            Num G = T.terrain.grade.street, Nn = T.terrain.grade.node; int K = (int)Ceil(T.terrain.grade.window / Nn); long ke = CellKey(i, row * 8 + terrain);
            lock (streetNodes) { if (streetLevels.TryGetValue(ke, out var e0)) return e0; }
            Num U = 0, L = 0; bool first = true;
            for (int j = i - K; j <= i + K; j++)
            {
                Num b; long k = CellKey(j, row);
                lock (streetNodes) { if (!streetNodes.TryGetValue(k, out b)) { if (streetNodes.Count > 65536) streetNodes.Clear(); b = NaturalGround(seed, j * Nn, z0, st, 1, T.terrain.grade.oct); streetNodes[k] = b; } }
                Num d = Abs(i - j) * Nn, h = b * terrain;
                if (first || h + G * d < U) U = h + G * d;
                if (first || h - G * d > L) L = h - G * d;
                first = false;
            }
            Num e = (U + L) / 2;
            lock (streetNodes) { if (streetLevels.Count > 65536) streetLevels.Clear(); streetLevels[ke] = e; }
            return e;
        }
        static Num StreetAt(ulong seed, Num x, Num z0, Settings st, int terrain)
        {
            var F = Features(st); string tag = seed + ":" + F.woods + "," + F.towns + "," + N(F.water) + "," + N(F.hives) + "," + F.settled + ShapeTag();
            lock (streetNodes) { if (streetTag != tag) { streetTag = tag; streetNodes.Clear(); streetLevels.Clear(); } }
            Num Nn = T.terrain.grade.node; int row = (int)Floor(z0 / CS + 0.5); Num u = x / Nn - 0.5; int i = (int)Floor(u); Num f = u - i;
            Num a = StreetLevel(seed, i, row, z0, st, terrain), b = StreetLevel(seed, i + 1, row, z0, st, terrain), c = StreetLevel(seed, i + 2, row, z0, st, terrain);
            return 0.5 * (1 - f) * (1 - f) * a + (0.5 + f - f * f) * b + 0.5 * f * f * c;
        }
        /// a street's shoulder: 2:1 banks at most (world.js streetBank)
        static void StreetBank(ulong seed, Pad p, Settings st, int terrain)
        {
            lock (p)
            {
                if (p.tSet[terrain]) return;
                int A = T.terrain.octaves; Num drop = 0;
                if (p.k == 0)
                {
                    for (Num x = p.minx; x <= p.maxx; x += T.terrain.grade.node)
                    {
                        Num hs = StreetAt(seed, x, p.hz, st, terrain);
                        drop = Max(drop, Abs(hs - NaturalGround(seed, x, p.minz - 3, st, terrain, A)));
                        drop = Max(drop, Abs(hs - NaturalGround(seed, x, p.maxz + 3, st, terrain, A)));
                    }
                }
                else for (int k = 0; k < 8; k++)
                    {
                        Num a = k * 0.7853981633974483, x = p.x + DCos(a) * (p.r + 3), z = p.z + DSin(a) * (p.r + 3);
                        drop = Max(drop, Abs(StreetAt(seed, x, p.hz, st, terrain) - NaturalGround(seed, x, z, st, terrain, A)));
                    }
                p.mT[terrain] = Max(T.terrain.grade.road, Min(T.terrain.grade.bank, 4 * drop + 1)); p.tSet[terrain] = true;
            }
        }
        /// a house's pad within its drive's grade of the street, its banks 2:1 at most (world.js housePad)
        /// an urban building's pad: the street's height before it (S6)
        static void UrbanPad(ulong seed, Pad p, Settings st, int terrain)
        {
            lock (p) { if (p.tSet[terrain]) return; p.hT[terrain] = StreetAt(seed, p.hx, p.z0, st, terrain); p.tSet[terrain] = true; }
        }
        static void HousePad(ulong seed, Pad p, Settings st, int terrain)
        {
            lock (p)
            {
                if (p.tSet[terrain]) return;
                int GO = T.terrain.grade.oct, A = T.terrain.octaves;
                Num h = NaturalGround(seed, p.hx, p.hz, st, terrain, GO), hw = h;
                if (p.road)
                {
                    hw = StreetAt(seed, p.hx, p.z0, st, terrain);
                    Num a = StreetAt(seed, p.drv ? p.xd : p.minx, p.z0, st, terrain), b2 = StreetAt(seed, p.drv ? p.xd : p.maxx, p.z0, st, terrain), lim = T.terrain.grade.drive * p.run; // with a garage: at its walk and its drive (world.js)
                    Num lo = Max(Max(a, b2), hw) - lim, hi = Min(Min(a, b2), hw) + lim;
                    h = lo <= hi ? Max(lo, Min(hi, h)) : (lo + hi) / 2;
                }
                Num m = 3; int[,] e8 = { { -1, -1 }, { 0, -1 }, { 1, -1 }, { 1, 0 }, { 1, 1 }, { 0, 1 }, { -1, 1 }, { -1, 0 } };
                for (int pass = 0; pass < 2; pass++)
                {
                    Num drop = 0;
                    for (int k = 0; k < 8; k++)
                    {
                        int ax = e8[k, 0], az = e8[k, 1];
                        Num x = ax < 0 ? p.minx - m : ax > 0 ? p.maxx + m : p.hx, z = az < 0 ? p.minz - m : az > 0 ? p.maxz + m : p.hz;
                        drop = Max(drop, Abs(h - NaturalGround(seed, x, z, st, terrain, A)));
                    }
                    if (p.ramp != null) { drop = Max(drop, Abs(hw - NaturalGround(seed, p.minx - m, p.ramp.zw, st, terrain, A))); drop = Max(drop, Abs(hw - NaturalGround(seed, p.maxx + m, p.ramp.zw, st, terrain, A))); }
                    m = Max(m, Max(T.terrain.grade.house, Min(T.terrain.grade.bank, 4 * drop + 1)));
                }
                p.hT[terrain] = h; p.mT[terrain] = m;
                if (p.ramp != null) { p.ramp.hwT[terrain] = hw; p.ramp.mT[terrain] = m; p.ramp.tSet[terrain] = true; }
                p.tSet[terrain] = true;
            }
        }
        /// the ground graded under paving, buildings and ponds, before the footings
        static Num GroundBase(ulong seed, Num x, Num z, Settings st, int terrain)
        {
            Num h = NaturalGround(seed, x, z, st, terrain, T.terrain.octaves);
            Num M = T.terrain.grade.reach; int GO = T.terrain.grade.oct;
            int c0x = ChunkOf(x - M), c1x = ChunkOf(x + M), c0z = ChunkOf(z - M), c1z = ChunkOf(z + M);
            bool late = false; // urban courts and lots (S6) go last, whatever chunk they are in (world.js)
            for (int pass = 0; pass < 2 && (pass == 0 || late); pass++)
                for (int cz = c0z; cz <= c1z; cz++) for (int cx = c0x; cx <= c1x; cx++)
                    foreach (var p in PadsOf(seed, cx, cz, st))
                    {
                        if ((p.k == 7 || p.k == 8) != (pass == 1)) { if (pass == 0) late = true; continue; }
                        if (p.k == 5 || p.k == 6) HousePad(seed, p.k == 6 ? p.pad : p, st, terrain);
                        else if (p.k == 0 || p.k == 2) StreetBank(seed, p, st, terrain);
                        else if (p.k == 7) UrbanPad(seed, p, st, terrain);
                        else if (p.k == 8) { lock (p) { if (!p.tSet[terrain]) { Num lo = Num.MaxValue; foreach (var r in p.rows) { UrbanPad(seed, r, st, terrain); lo = Min(lo, r.hT[terrain]); } p.hT[terrain] = lo; p.tSet[terrain] = true; } } }
                        Num pm = p.k == 5 || p.k == 6 || p.k == 0 || p.k == 2 ? p.mT[terrain] : p.m;
                        if ((p.k == 5 || p.k == 6) && p.sg * (z - p.zw) < 0) continue; // not past the sidewalk
                        Num d;
                        if (p.k == 2 || p.k == 4) d = Max(0, Sqrt((x - p.x) * (x - p.x) + (z - p.z) * (z - p.z)) - p.r);
                        else { Num dx = Max(Max(p.minx - x, 0), x - p.maxx), dz = Max(Max(p.minz - z, 0), z - p.maxz); d = Sqrt(dx * dx + dz * dz); }
                        if (d >= pm) continue;
                        Num hp;
                        if (p.k == 0 || p.k == 2) hp = StreetAt(seed, x, p.hz, st, terrain);
                        else if (p.k == 3) hp = NaturalGround(seed, x, z, st, terrain, GO);
                        else if (p.k == 5 || p.k == 7 || p.k == 8) hp = p.hT[terrain];
                        else if (p.k == 6) { Num f = Max(0, Min(1, (z - p.zw) / (p.zf - p.zw))), w0 = StreetAt(seed, x, p.z0, st, terrain); hp = w0 + (p.pad.hT[terrain] - w0) * f; }
                        else { lock (p) { if (!p.hSet) { p.h = NaturalGround(seed, p.hx, p.hz, st, 1, GO); p.hSet = true; } } hp = p.h * terrain; }
                        Num w = 1 - Smooth(d / pm);
                        if (p.k == 5 && p.road) w *= Smooth(Min(1, p.sg * (z - p.zw) / p.run)); // a house's banks fade out across its front yard
                        h += (hp - h) * w;
                    }
            return h;
        }
        /// the ground's slope (rise per metre along x and z), from the heights a quarter metre either side
        public static (Num x, Num z) GroundSlope(ulong seed, Num x, Num z, Settings st)
        {
            if ((st?.terrain ?? 0) == 0 && (st?.settled ?? 0) == 0) return (0, 0);
            Num e = 0.25;
            return ((GroundAt(seed, x + e, z, st) - GroundAt(seed, x - e, z, st)) / (2 * e), (GroundAt(seed, x, z + e, st) - GroundAt(seed, x, z - e, st)) / (2 * e));
        }
        public static int MallSide(ulong seed, int cx, int cz, Settings st = null) { var R = RegionOf(cx, cz); return Region(seed, R.rx, R.rz, st).mallSide; }

        // ---------------------------------------------------------------- chunk generation (GDD 4.3)
        struct Occ { public Num x, z, r; }

        public static ChunkContent GenerateChunk(ulong seed, int cx, int cz, Settings st = null)
        {
            var F = Features(st);
            ulong H(long slot) => Hash(seed, Domain.WorldGen, U64(cx), U64(cz), U64(slot));
            Num ox = cx * CS, oz = cz * CS;
            var c = new ChunkContent { cx = cx, cz = cz, tint = Unit(H(0)) };
            c.ponds = PondsOf(seed, cx, cz, st);
            var occupied = new List<Occ>();
            foreach (var q in c.ponds) occupied.Add(new Occ { x = q.x, z = q.z, r = q.r + (q.park ? PondPath.outer + 0.3 : 1) }); // nothing stands in a pond or on its path
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

            // someone with something to do (T1-11): a stroller walks a loop (path: x, z pairs), a gardener works the spots on
            // its path in turn, a sunbather lies at the spot
            void AddActor(long slot, Num x, Num z, Num fx, Num fz, string posture, string act, Num[] path)
            {
                c.humans.Add(new HumanSlot { slot = (int)slot, x = x, z = z, fx = fx, fz = fz, posture = posture, exit = Range(H(slot + 200), 0, 6.28), act = act, path = path });
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
                    bool wet = false; foreach (var q in c.ponds) if (InPond(q, x, z, 0.3)) wet = true;
                    if (wet) continue; // not in a pond
                    c.flowers.Add(new Flower { x = x, y = y, z = z, color = color });
                    c.sugar.Add(new SugarNode { x = x, y = y + 0.02, z = z, rate = 0.35, kind = "flower" });
                    if (Unit(H(slot + 70 + i)) < T.prey.caterpillarChance) c.caterpillars.Add(new Caterpillar { x = x + 0.006, y = y * 0.6, z = z });
                }
                AddFly(px, 0.7, pz, slot + 5);
            }

            void AddHive(Num x, Num z, long slot)
            {
                if ((x - NEST.treeX) * (x - NEST.treeX) + (z - NEST.treeZ) * (z - NEST.treeZ) < T.bees.nestClear * T.bees.nestClear) return; // not by the first nest
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
            // an urban block (world.js addUrban, S6): the street, the rows on their pads, walls, stairs, courts
            void AddUrban()
            {
                bool endW = !Streets(LandUse(seed, cx - 1, cz, st)), endE = !Streets(LandUse(seed, cx + 1, cz, st));
                c.roads.Add(new Rect { minx = ox + (endW ? -22 : -32), maxx = ox + (endE ? 22 : 32), minz = oz - 4, maxz = oz + 4 });
                if (endW) c.loops.Add(new Loop { x = ox - 22, z = oz, r = 11 });
                if (endE) c.loops.Add(new Loop { x = ox + 22, z = oz, r = 11 });
                occupied.Add(new Occ { x = ox, z = oz, r = 4 });
                int terrain = st != null ? st.terrain : 0;
                Num Gb(Num x, Num z) => terrain != 0 ? GroundBase(seed, x, z, st, terrain) : 0;
                void Bx(Num minx, Num maxx, Num miny, Num maxy, Num minz, Num maxz, bool row = false, bool wall = false, bool retain = false, bool step = false, bool back = false)
                    => c.boxes.Add(new Box { minx = Min(minx, maxx), maxx = Max(minx, maxx), miny = miny, maxy = maxy, minz = Min(minz, maxz), maxz = Max(minz, maxz), wood = false, row = row, wall = wall, retain = retain, step = step, back = back });
                var plan = UrbanBuildings(H, ox, UrbanMain(seed, cx, cz, st));
                foreach (int s in new[] { -1, 1 })
                {
                    var L = UrbanLines(oz, s); Num court = Gb(ox, (L.zD + L.zE) / 2), xa = ox - UrbLot * UrbLots / 2, xb = ox + UrbLot * UrbLots / 2;
                    foreach (var b in plan)
                    {
                        if (b.s != s) continue;
                        Num h = b.storeys * 3 + 0.4, xm = (b.x0 + b.x1) / 2;
                        c.rows.Add(new Row { x0 = b.x0, x1 = b.x1, zF = L.zF, zB = L.zB, s = s, h = h, storeys = b.storeys, c = b.c, shop = b.shop, mid = b.mid });
                        Bx(b.x0 + 0.05, b.x1 - 0.05, 0, h, L.zF, L.zB, row: true);
                        Bx(b.x0 + 0.05, xm - 0.8, 0, UrbLow, L.zA + s * 0.08, L.zA + s * 0.38, wall: true);
                        Bx(xm + 0.8, b.x1 - 0.05, 0, UrbLow, L.zA + s * 0.08, L.zA + s * 0.38, wall: true);
                        var ends = b.x1 >= xb - 1e-9 ? new[] { (b.x0 + 0.05, b.x0 + 0.3), (b.x1 - 0.3, b.x1 - 0.05) } : new[] { (b.x0 + 0.05, b.x0 + 0.3) };
                        foreach (var (xw0, xw1) in ends)
                        {
                            Bx(xw0, xw1, 0, UrbLow, L.zA + s * 0.38, L.zF, wall: true);
                            Bx(xw0, xw1, 0, 1.2, L.zB, L.zD - s * 0.05, wall: true);
                        }
                        Num drop = Gb(xm, (L.zF + L.zB) / 2) - court;
                        if (drop > 0.3)
                        {
                            int n = (int)Ceil(drop / UrbStep); Num rise = drop / n, zw0 = L.zD + s * 0.1, zw1 = zw0 + s * UrbWall, half = UrbStairW / 2;
                            Bx(b.x0 + 0.05, xm - half, 0, drop + 1, zw0, zw1, wall: true, retain: true);
                            Bx(xm + half, b.x1 - 0.05, 0, drop + 1, zw0, zw1, wall: true, retain: true);
                            Bx(xm - half, xm + half, 0, drop, L.zD + s * 0.05, zw1, step: true);
                            for (int k = 1; k < n; k++) Bx(xm - half, xm + half, 0, drop - k * rise, zw1 + s * (k - 1) * UrbRun, zw1 + s * k * UrbRun, step: true);
                            c.stairs.Add(new Stair { x = xm, z = zw1, s = s, n = n, rise = rise, drop = drop });
                        }
                    }
                    Bx(ox - 32, ox + 32, 0, UrbBack, L.zE - s * 0.35, L.zE - s * 0.05, wall: true, back: true);
                    Num cm = (L.zD + L.zE) / 2 + s * 1.5; long slot = s < 0 ? 8100 : 8600;
                    occupied.Add(new Occ { x = ox, z = (L.zD + L.zE) / 2, r = 1 });
                    foreach (var q in c.stairs) if (q.s == s) occupied.Add(new Occ { x = q.x, z = q.z + s * q.n * UrbRun / 2, r = q.n * UrbRun / 2 + 1 });
                    for (int k = 0; k < 2; k++) { Num x = ox + Range(H(slot + k * 2), -26, 26), z = cm + Range(H(slot + 1 + k * 2), -2.5, 2.5); if (Free(x, z, 3)) { AddTree(x, z, slot + 20 + k * 4); occupied.Add(new Occ { x = x, z = z, r = 2 }); } }
                    if (Unit(H(slot + 40)) < 0.6) { Num x = ox + Range(H(slot + 41), -20, 20); if (Free(x, cm, 2.5)) AddPicnic(x, cm, true, RangeInt(H(slot + 42), 1, 64) | 1, slot + 60); }
                    if (Unit(H(slot + 200)) < 0.7) { Num x = ox + Range(H(slot + 201), -24, 24); if (Free(x, cm - s * 3, 1.5)) AddFlowers(x, cm - s * 3, slot + 210); }
                }
                Num x0s = ox + (endW ? -18 : -30), x1s = ox + (endE ? 18 : 30);
                if (Unit(H(8900)) < 0.8) AddActor(8910, x0s, oz - 5.2, 1, 0, "stand", "stroll", new[] { x0s, oz - 5.2, x1s, oz - 5.2, x1s, oz + 5.2, x0s, oz + 5.2 });
                if (Unit(H(8950)) < 0.5) AddActor(8960, x1s, oz + 5.2, -1, 0, "stand", "stroll", new[] { x1s, oz + 5.2, x0s, oz + 5.2, x0s, oz - 5.2, x1s, oz - 5.2 });
            }
            // farmland (world.js addFarm, S5): fields in hedgerows, a gravel lane through every other row, now and then a farmstead
            void AddFarm()
            {
                bool lane = ((cz % 2) + 2) % 2 == 0; Num lz0 = oz - RuralLane / 2, lz1 = oz + RuralLane / 2;
                if (lane) { c.lanes.Add(new Rect { minx = ox - 32, maxx = ox + 32, minz = lz0, maxz = lz1 }); occupied.Add(new Occ { x = ox - 16, z = oz, r = 3 }); occupied.Add(new Occ { x = ox, z = oz, r = 3 }); occupied.Add(new Occ { x = ox + 16, z = oz, r = 3 }); }
                void Hedge(bool alongX, Num at, long slot)
                {
                    int gate = RangeInt(H(slot), 0, 16); Num t = RuralHedge / 2;
                    for (int k = 0; k < 16; k++)
                    {
                        Num a = -32 + k * 4, b = a + 4;
                        if (k == gate) continue;
                        if (alongX) c.boxes.Add(new Box { minx = ox + a, maxx = ox + b, miny = 0, maxy = RuralHedgeH, minz = at - t, maxz = at + t, wood = false, hedge = true });
                        else { if (lane && oz + b > lz0 - 0.5 && oz + a < lz1 + 0.5) continue; c.boxes.Add(new Box { minx = at - t, maxx = at + t, miny = 0, maxy = RuralHedgeH, minz = oz + a, maxz = oz + b, wood = false, hedge = true }); }
                    }
                }
                Hedge(true, oz - 32, 7000); Hedge(false, ox - 32, 7001);
                occupied.Add(new Occ { x = ox - 32, z = oz, r = 1 });
                if (Unit(H(7100)) < RuralStead)
                {
                    int terrain = st != null ? st.terrain : 0;
                    Num Gb(Num x, Num z) => terrain != 0 ? GroundBase(seed, x, z, st, terrain) : 0;
                    Num Sl(Num x, Num z) => Sqrt(Sq(Gb(x + 0.5, z) - Gb(x - 0.5, z)) + Sq(Gb(x, z + 0.5) - Gb(x, z - 0.5)));
                    int[,] c4 = { { -1, -1 }, { 1, -1 }, { 1, 1 }, { -1, 1 } }, e8 = { { -1, -1 }, { 0, -1 }, { 1, -1 }, { 1, 0 }, { 1, 1 }, { 0, 1 }, { -1, 1 }, { -1, 0 } };
                    bool Fits(Num x, Num z, Num hw, Num hd, Num h)
                    {
                        Num hm = Gb(x, z), lo = hm, hi = hm;
                        for (int q = 0; q < 4; q++) { Num g = Gb(x + c4[q, 0] * hw, z + c4[q, 1] * hd); lo = Min(lo, g); hi = Max(hi, g); if (Sl(x + c4[q, 0] * hw, z + c4[q, 1] * hd) > RuralMax) return false; }
                        if (hm - lo > RuralPlinth || hi - hm > RuralPlinth || Sl(x, z) > RuralMax) return false;
                        Num sb = Min(4.6, h / 2);
                        foreach (Num f in new Num[] { 0.5, 1 }) for (int q = 0; q < 8; q++) if (Sl(x + e8[q, 0] * (hw + sb * f), z + e8[q, 1] * (hd + sb * f)) > RuralSteep) return false;
                        return true;
                    }
                    for (int k = 0; k < 6; k++)
                    {
                        int side = Unit(H(7110 + k * 4)) < 0.5 ? -1 : 1; Num x = ox + Range(H(7111 + k * 4), -18, 2), z = oz + side * Range(H(7112 + k * 4), 14, 20);
                        Num hhw = Range(H(7113 + k * 4), 4.2, 5), hhd = 4, hh = Range(H(7140 + k), 5.6, 6.4), bx = x + hhw + 10, bhw = 6, bhd = 4.5, bh = 4.5;
                        if (!Free(x, z, 7) || !Free(bx, z, 8) || !Fits(x, z, hhw, hhd + 1.6, hh + 1.9) || !Fits(bx, z, bhw, bhd, bh + 2.6)) continue;
                        c.sheds.Add(new Shed { x = x, z = z, hw = hhw, hd = hhd, h = hh, crack = RangeInt(H(7150), 0, 4), eave = RangeInt(H(7151), 0, 4), house = true, farm = true });
                        c.boxes.Add(new Box { minx = x - hhw, maxx = x + hhw, miny = 0, maxy = hh, minz = z - hhd, maxz = z + hhd, wood = false, shed = true });
                        Num zf = z - side * hhd;
                        c.porches.Add(new Porch { x = x, z = zf, s = side });
                        c.boxes.Add(new Box { minx = x - 0.9, maxx = x + 0.9, miny = 0, maxy = 0.44, minz = Min(zf, zf - side * 1.2), maxz = Max(zf, zf - side * 1.2), wood = false, porch = true });
                        c.boxes.Add(new Box { minx = x - 0.9, maxx = x + 0.9, miny = 0, maxy = 0.22, minz = Min(zf - side * 1.2, zf - side * 1.5), maxz = Max(zf - side * 1.2, zf - side * 1.5), wood = false, porch = true });
                        c.sheds.Add(new Shed { x = bx, z = z, hw = bhw, hd = bhd, h = bh, crack = RangeInt(H(7152), 0, 4), eave = RangeInt(H(7153), 0, 4), house = false, farm = true, barn = true });
                        c.boxes.Add(new Box { minx = bx - bhw, maxx = bx + bhw, miny = 0, maxy = bh, minz = z - bhd, maxz = z + bhd, wood = true, shed = true });
                        occupied.Add(new Occ { x = x, z = z, r = 7 }); occupied.Add(new Occ { x = bx, z = z, r = 8 });
                        Num yz0 = Min(zf - side * 1.6, zf - side * 7), yz1 = Max(zf - side * 1.6, zf - side * 7);
                        c.farmyards.Add(new Rect { minx = x - hhw, maxx = bx + bhw, minz = yz0, maxz = yz1 });
                        occupied.Add(new Occ { x = (x + bx) / 2, z = (yz0 + yz1) / 2, r = 5 });
                        Num sx = x - hhw - 3.5, sz = z;
                        if (Free(sx, sz, 2) && Fits(sx, sz, 1.2, 0.9, 2.7)) AddShed(sx, sz, true, 7160, false);
                        Num ym = (yz0 + yz1) / 2;
                        if (Unit(H(7200)) < 0.7) AddActor(7210, x, ym, 1, 0, "stand", "garden", new[] { x, ym, (x + bx) / 2, ym, bx - 2, ym, bx - 2, z - side * (bhd + 1) });
                        break;
                    }
                }
                if (lane && Unit(H(7300)) < 0.35) AddActor(7310, ox - 30, oz + 1.6, 1, 0, "stand", "stroll", new Num[] { ox - 30, oz + 1.6, ox + 30, oz + 1.6, ox + 30, oz - 1.6, ox - 30, oz - 1.6 });
                int nf = RangeInt(H(7400), 0, 3);
                for (int i = 0; i < nf; i++) { Num x = ox + Range(H(7401 + i * 2), -28, 28), z = oz + Range(H(7402 + i * 2), -28, 28); if (Free(x, z, 2)) AddFlowers(x, z, 7420 + i * 80); }
            }
            // suburban yards (see world.js addYards)
            void AddYards()
            {
                bool endW = !Streets(LandUse(seed, cx - 1, cz, st)), endE = !Streets(LandUse(seed, cx + 1, cz, st));
                c.roads.Add(new Rect { minx = ox + (endW ? -22 : -32), maxx = ox + (endE ? 22 : 32), minz = oz - 4, maxz = oz + 4 });
                if (endW) c.loops.Add(new Loop { x = ox - 22, z = oz, r = 11 });
                if (endE) c.loops.Add(new Loop { x = ox + 22, z = oz, r = 11 });
                occupied.Add(new Occ { x = ox, z = oz, r = 4 });
                for (int li = 0; li < 4; li++)
                {
                    int s = li < 2 ? -1 : 1; Num lx = ox + (li % 2 != 0 ? 16 : -16); long b = 3000 + li * 2000;
                    if (Unit(H(b)) < 0.9)
                    {
                        AddShed(lx + Range(H(b + 1), -3, 3), oz + s * 15.5, true, b + 2, true);
                        var sh = c.sheds[c.sheds.Count - 1]; var g = GarageOf(H, b, sh.x, sh.z, sh.hw, sh.hd, s); Num zf = sh.z - s * sh.hd;
                        if (g != null) // a garage beside the house, a drive to it (S4)
                        {
                            var d = DriveOf(g, oz);
                            c.garages.Add(g); c.drives.Add(d);
                            c.boxes.Add(new Box { minx = g.x0, maxx = g.x1, miny = 0, maxy = g.h, minz = g.z0, maxz = g.z1, wood = false, garage = true });
                            occupied.Add(new Occ { x = (g.x0 + g.x1) / 2, z = (g.z0 + g.z1) / 2, r = 4 }); occupied.Add(new Occ { x = (d.minx + d.maxx) / 2, z = (d.minz + d.maxz) / 2, r = 3 });
                        }
                        // the porch before the front door: a stoop at the door's sill and a step down to the walk
                        c.porches.Add(new Porch { x = sh.x, z = zf, s = s });
                        c.boxes.Add(new Box { minx = sh.x - 0.9, maxx = sh.x + 0.9, miny = 0, maxy = 0.44, minz = Min(zf, zf - s * 1.2), maxz = Max(zf, zf - s * 1.2), wood = false, porch = true });
                        c.boxes.Add(new Box { minx = sh.x - 0.9, maxx = sh.x + 0.9, miny = 0, maxy = 0.22, minz = Min(zf - s * 1.2, zf - s * 1.5), maxz = Max(zf - s * 1.2, zf - s * 1.5), wood = false, porch = true });
                    }
                    AddFence(lx - 15.6, oz + s * 20.5, lx - 15.6, oz + s * 31.6);
                    AddFence(lx - 15.6, oz + s * 31.6, lx + 15.6, oz + s * 31.6);
                    if (li % 2 != 0) AddFence(lx + 15.6, oz + s * 20.5, lx + 15.6, oz + s * 31.6);
                    if (Unit(H(b + 10)) < 0.55) AddPicnic(lx + Range(H(b + 11), -6, 6), oz + s * 24.5, true, RangeInt(H(b + 12), 1, 64) | 1, b + 20);
                    if (Unit(H(b + 300)) < 0.75) AddFlowers(lx + Range(H(b + 301), -11, 11), oz + s * 29.5, b + 310);
                    if (Unit(H(b + 500)) < 0.3) { Num sx = lx + (Unit(H(b + 501)) < 0.5 ? -12.5 : 12.5), sz = oz + s * 28.7; if (Free(sx, sz, 2)) AddShed(sx, sz, true, b + 502, false); }
                    if (Unit(H(b + 510)) < 0.08 * F.hives) { Num hx = lx + Range(H(b + 511), -10, 10), hz = oz + s * 22; if (Free(hx, hz, 2)) AddHive(hx, hz, b + 600); }
                    if (Unit(H(b + 800)) < 0.2) { Num gx = lx + Range(H(b + 801), -8, 8), gz = oz + s * 7; if (Free(gx, gz, 2)) AddGroup(gx, gz, RangeInt(H(b + 802), 2, 4), b + 1000); }
                    // a gardener working the beds along the back fence and the lawn; someone sunbathing in the backyard (T1-11)
                    if (Unit(H(b + 1400)) < 0.3)
                    {
                        var p = new Num[] { lx + Range(H(b + 1401), -10, 10), oz + s * 28.8, lx + Range(H(b + 1402), -12, 12), oz + s * 26, lx + Range(H(b + 1403), -12, 12), oz + s * 22.5 };
                        AddActor(b + 1410, p[0], p[1], 0, s, "stand", "garden", p);
                    }
                    if (Unit(H(b + 1450)) < 0.25)
                    {
                        Num x = lx + Range(H(b + 1451), -11, 11), z = oz + s * 22.5;
                        if (Free(x, z, 1.2)) { occupied.Add(new Occ { x = x, z = z, r = 1.2 }); AddActor(b + 1460, x, z, Unit(H(b + 1452)) < 0.5 ? 1 : -1, 0, "lie", "sun", null); }
                    }
                }
                // people out for a walk round the block, along one sidewalk and back along the other
                Num x0 = ox + (endW ? -18 : -30), x1 = ox + (endE ? 18 : 30);
                if (Unit(H(2500)) < 0.6) AddActor(2510, x0, oz - 5.2, 1, 0, "stand", "stroll", new Num[] { x0, oz - 5.2, x1, oz - 5.2, x1, oz + 5.2, x0, oz + 5.2 });
                if (Unit(H(2600)) < 0.3) AddActor(2610, x1, oz + 5.2, -1, 0, "stand", "stroll", new Num[] { x1, oz + 5.2, x0, oz + 5.2, x0, oz - 5.2, x1, oz - 5.2 });
            }
            // a strip mall on the region's edge (see world.js addMall)
            void AddMall()
            {
                int side = MallSide(seed, cx, cz, st);
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
                // a shopper crossing the lot to the doors and back (T1-11)
                if (Unit(H(5200)) < 0.7)
                {
                    var a = At(-14, -12); var bb = At(-14, 11); var dd = At(14, 11); var e = At(14, -12);
                    AddActor(5210, a.x, a.z, o0, o1, "stand", "stroll", new Num[] { a.x, a.z, bb.x, bb.z, dd.x, dd.z, e.x, e.z });
                }
            }

            // a town centre (GDD 4.3, T2-5, see world.js addTown): one quarter of a 2x2 block, paved, shops on its outer edges;
            // one quarter of each block is a beer garden, the one across from it has the fountain
            void AddTown()
            {
                var q = TownQuarter(seed, cx, cz, st); int ix = q.qx != 0 ? -1 : 1, iz = q.qz != 0 ? -1 : 1;
                c.plazas.Add(new Rect { minx = ox - 32, maxx = ox + 32, minz = oz - 32, maxz = oz + 32 });
                void AddShop(Num x, Num z, Num hw, Num hd, long slot)
                {
                    Num h = Range(H(slot), 7, 11);
                    c.shops.Add(new Shop { x = x, z = z, hw = hw, hd = hd, h = h, color = RangeInt(H(slot + 1), 0, 6) });
                    c.boxes.Add(new Box { minx = x - hw, maxx = x + hw, miny = 0, maxy = h, minz = z - hd, maxz = z + hd, wood = false, shop = true });
                    occupied.Add(new Occ { x = x, z = z, r = Max(hw, hd) + 1.5 });
                }
                AddShop(ox - ix * 22, oz - iz * 22, 9, 9, 7000);
                AddShop(ox - ix * 25, oz + iz * 6, 6, 8, 7010);
                AddShop(ox + ix * 6, oz - iz * 25, 8, 6, 7020);
                if (q.garden)
                {
                    Num gx = ox + ix * 12, gz = oz + iz * 12;
                    c.gardens.Add(new Garden { x = gx, z = gz, hw = 9, hd = 7 });
                    for (int k = 0; k < 6; k++)
                    {
                        Num px = gx + ((k % 3) - 1) * 5.5, pz = gz + ((k / 3) - 0.5) * 5; long b = 7100 + k * 400; int ti = c.tables.Count;
                        AddPicnic(px, pz, true, 0b111111, b);
                        for (int hi = c.humans.Count - 6; hi < c.humans.Count; hi++) c.humans[hi].evening = true; // they stay into the night
                        for (int i = 0; i < 3; i++) // a round of drinks on every table
                        {
                            Num x = px + Range(H(b + 90 + i), -0.8, 0.8), z = pz + Range(H(b + 95 + i), -0.22, 0.22);
                            c.cans.Add(new Can { x = x, z = z, color = 4, table = ti }); c.sugar.Add(new SugarNode { x = x, y = 0.87, z = z, rate = 1.0, kind = "can", table = ti });
                        }
                    }
                }
                else
                {
                    int ng = RangeInt(H(7050), 1, 3);
                    for (int k = 0; k < ng; k++) { Num gx = ox + ix * Range(H(7051 + k * 3), 4, 22), gz = oz + iz * Range(H(7052 + k * 3), 4, 22); if (Free(gx, gz, 2)) AddGroup(gx, gz, RangeInt(H(7053 + k * 3), 2, 4), 7060 + k * 400); }
                    for (int k = 0; k < 2; k++) { Num fx = ox + ix * Range(H(7070 + k * 2), 2, 24), fz = oz + iz * Range(H(7071 + k * 2), 2, 24); if (Free(fx, fz, 1.5)) AddFlowers(fx, fz, 7080 + k * 80); }
                    if (q.fountain)
                    {
                        // a fountain at the middle of the block: water (T2-1)
                        Num fx = ox + ix * 27, fz = oz + iz * 27;
                        c.baths.Add(new Bath { x = fx, z = fz, r = 1.1, h = 0.55, fountain = true });
                        c.cylinders.Add(new Cyl { x = fx, z = fz, r = 1.1, h = 0.55, wood = false, bath = true });
                        occupied.Add(new Occ { x = fx, z = fz, r = 2.5 });
                    }
                }
                // someone crossing the square
                if (Unit(H(7600)) < 0.7) { Num ax = ox + ix * 2, az = oz + iz * 26, bx = ox + ix * 26, bz = oz + iz * 2; AddActor(7610, ax, az, 0, -iz, "stand", "stroll", new Num[] { ax, az, bx, bz }); }
            }

            // a park pond's surroundings (world.js): two benches beside its path facing the water, now and then a walker round it
            foreach (var p in c.ponds)
            {
                if (!p.park) continue;
                Num a0 = Range(H(9130), 0, 6.28);
                for (int k = 0; k < 2; k++)
                {
                    Num a = a0 + k * 3.1416 + Range(H(9131 + k), -0.6, 0.6), e = PondEdge(p, a) + PondPath.bench, ca = DCos(a), sa = DSin(a);
                    Num x = p.x + e * ca, z = p.z + e * sa; bool alongX = Abs(sa) > Abs(ca);
                    Num hw = alongX ? 0.8 : 0.2, hd = alongX ? 0.2 : 0.8, bx = alongX ? 0 : (ca > 0 ? 0.2 : -0.2), bz = alongX ? (sa > 0 ? 0.2 : -0.2) : 0;
                    c.boxes.Add(new Box { minx = x - hw, maxx = x + hw, miny = 0.4, maxy = 0.46, minz = z - hd, maxz = z + hd, wood = true, bench = true });
                    c.boxes.Add(new Box { minx = x + bx - (alongX ? hw : 0.03), maxx = x + bx + (alongX ? hw : 0.03), miny = 0.46, maxy = 0.9, minz = z + bz - (alongX ? 0.03 : hd), maxz = z + bz + (alongX ? 0.03 : hd), wood = true, bench = true });
                    occupied.Add(new Occ { x = x, z = z, r = 1.2 });
                }
                if (Unit(H(9140)) < 0.7)
                {
                    var path = new Num[24];
                    for (int k = 0; k < 12; k++) { Num a = k * TAU / 12, e = PondEdge(p, a) + (PondPath.inner + PondPath.outer) / 2; path[k * 2] = p.x + e * DCos(a); path[k * 2 + 1] = p.z + e * DSin(a); }
                    AddActor(9150, path[0], path[1], 0, 1, "stand", "stroll", path);
                }
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
            else if ((c.use = LandUse(seed, cx, cz, st)) == "yards") AddYards();
            else if (c.use == "farm") AddFarm();
            else if (c.use == "urban") AddUrban();
            else if (c.use == "mall") AddMall();
            else if (c.use == "town") AddTown();
            else if (c.use == "wild") // wild land past the settled area (GDD 21.6): trees where the wild forest stands, meadow flowers
            {
                var o = new Num[5];
                for (int k = 0; k < 40; k++)
                {
                    Num x = ox + Range(H(2200 + k * 2), -30, 30), z = oz + Range(H(2201 + k * 2), -30, 30);
                    WildHere(seed, x, z, st, o);
                    if (o[0] > o[4] + 0.6 && Unit(H(2300 + k)) < o[2] * 0.85 && Free(x, z, 1.5)) { AddTree(x, z, 2400 + k * 4); occupied.Add(new Occ { x = x, z = z, r = 1 }); }
                }
                for (int k = 0; k < 3; k++)
                {
                    Num x = ox + Range(H(2600 + k * 2), -26, 26), z = oz + Range(H(2601 + k * 2), -26, 26);
                    WildHere(seed, x, z, st, o);
                    if (o[0] > o[4] + 1 && o[2] < 0.3 && Unit(H(2610 + k)) < 0.6) AddFlowers(x, z, 2620 + k * 80);
                }
            }
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
                bool forcedHive = cx == 1 && cz == 0 && F.hives > 0;
                if (forcedHive || Unit(H(12)) < 0.3 * F.hives)
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
            int nt = c.use == "wild" || c.use == "urban" ? 0 : c.use == "farm" ? RangeInt(H(2004), 1, 5) : forest ? RangeInt(H(2000), 16, 26) : c.use == "yards" ? RangeInt(H(2001), 1, 4) : c.use == "mall" ? RangeInt(H(2002), 0, 3) : c.use == "town" ? RangeInt(H(2003), 0, 3) : RangeInt(H(11), isOrigin ? 3 : 2, isOrigin ? 6 : 8);
            for (int i = 0; i < nt; i++)
            {
                Num x = ox + Range(H(150 + i * 4), -30, 30), z = oz + Range(H(151 + i * 4), -30, 30);
                if (Free(x, z, forest ? 1.5 : 3)) { AddTree(x, z, 200 + i * 4); occupied.Add(new Occ { x = x, z = z, r = forest ? 1 : 2 }); }
            }
            // people out for the day in the open (T1-11): a walk round the park or through the woods, sunbathers on the grass
            if (!isOrigin && c.use == "park")
            {
                if (Unit(H(6000)) < 0.6) { Num r = Range(H(6001), 12, 22); AddActor(6010, ox - r, oz - r, 1, 0, "stand", "stroll", new Num[] { ox - r, oz - r, ox + r, oz - r, ox + r, oz + r, ox - r, oz + r }); }
                int ns = RangeInt(H(6100), 0, 3);
                for (int k = 0; k < ns; k++)
                {
                    Num x = ox + Range(H(6101 + k * 10), -26, 26), z = oz + Range(H(6102 + k * 10), -26, 26), a = Range(H(6103 + k * 10), 0, 6.28);
                    if (Free(x, z, 1.5)) { occupied.Add(new Occ { x = x, z = z, r = 1.5 }); AddActor(6110 + k * 10, x, z, DSin(a), DCos(a), "lie", "sun", null); }
                }
            }
            if (forest && Unit(H(6300)) < 0.3) AddActor(6310, ox - 26, oz - 20, 1, 0, "stand", "stroll", new Num[] { ox - 26, oz - 20, ox + 26, oz + 20 });
            // birdbaths (T2-1, see world.js): some backyards, now and then a park, one in the home park
            void AddBath(Num x, Num z)
            {
                c.baths.Add(new Bath { x = x, z = z, r = T.water.bathR, h = T.water.bathY });
                c.cylinders.Add(new Cyl { x = x, z = z, r = T.water.bathR, h = T.water.bathY, wood = false, bath = true });
                occupied.Add(new Occ { x = x, z = z, r = 0.6 });
            }
            if (c.use == "yards")
            {
                for (int li = 0; li < 4; li++)
                {
                    int s = li < 2 ? -1 : 1; Num lx = ox + (li % 2 != 0 ? 16 : -16); long b = 3000 + li * 2000;
                    if (Unit(H(b + 1500)) >= T.water.bathShare * F.water) continue;
                    Num x = lx + Range(H(b + 1501), -9, 9), z = oz + s * 24.5;
                    if (Free(x, z, 0.6)) AddBath(x, z);
                }
            }
            else if (c.use == "park")
            {
                int n = isOrigin ? 6 : Unit(H(6500)) < T.water.bathPark * F.water ? 4 : 0; // tries
                for (int k = 0; k < n; k++)
                {
                    Num x = ox + Range(H(6501 + k * 2), -18, 18), z = oz + Range(H(6502 + k * 2), -18, 18);
                    if (Free(x, z, 1)) { AddBath(x, z); break; }
                }
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
