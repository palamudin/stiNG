// STING simulation core. Port of poc/sim/sim.js, kept bit-identical to it (core/fixtures/parity.txt proves it).
// No rendering, no wall clock. Every wasp, driven or AI, goes through the same flight, contact, sting and swat code.
// The class is split by topic over Sim*.cs; method names follow the JS (_flight -> Flight) so both read side by side.
using System.Collections.Generic;
using static Sting.Core.R;
using static Sting.Core.World;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed partial class Sim
    {
        public const int CMD_FIELDS = 10; // mx, my, mz, burst, sting, yawQ, pitchQ, act, alloc, pick

        static Num D2(V3 a, V3 b) { Num dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; }
        static Num D2(WaspBase a, V3 b) => D2(a.P, b);
        static Num D2(WaspBase a, WaspBase b) => D2(a.P, b.P);
        static readonly HashSet<string> IMMEDIATE = new HashSet<string> { "caught", "claim", "denied", "drop", "sip", "beeAlarm", "died", "fight", "fightReq", "fightJoin", "fightRefuse", "fightEnd", "raid" };

        public Settings settings;
        public int peer; public bool net, noAI;
        public List<Msg> outbox = new List<Msg>();
        public List<NetEv> pending = new List<NetEv>();
        public int evSeq;
        public OrderedMap<int, RemoteWasp> remote = new OrderedMap<int, RemoteWasp>();
        public NetStats netStats = new NetStats();
        public Plaus plaus = new Plaus();
        public OrderedMap<int, string> interest = new OrderedMap<int, string>();
        /// pickups waiting for the chunk authority (T1-19), by wasp id; never saved
        public OrderedMap<int, Claim> claims = new OrderedMap<int, Claim>();
        /// relevance tiers (T1-21): each peer's driven wasp, the far traffic each peer reports, the wasps last sent; never saved
        public OrderedMap<int, int> remoteDriven = new OrderedMap<int, int>(); public OrderedMap<int, TrafficMsg> remoteTraffic = new OrderedMap<int, TrafficMsg>(); List<int> lastIds = new List<int>();
        public int host;
        public ulong seed;
        public int tpm; public long dayTicks;
        public int tick; public long clockOffset;
        public List<SimEvent> events = new List<SimEvent>();
        public OrderedMap<string, ChunkRec> records = new OrderedMap<string, ChunkRec>();
        public OrderedMap<string, ChunkState> chunkState = new OrderedMap<string, ChunkState>();
        public OrderedMap<string, Human> humans = new OrderedMap<string, Human>();
        public List<Human> active = new List<Human>();
        public List<ChunkRec> activeChunks = new List<ChunkRec>();
        public string activeKey = "";
        public List<Swat> swats = new List<Swat>();
        public List<Spray> sprays = new List<Spray>();
        public List<Alarm> alarms = new List<Alarm>();
        public Known homeScent; // the scent of the last food a forager brought home (T1-16)
        public OrderedMap<string, HiveAlarm> hiveAlarms = new OrderedMap<string, HiveAlarm>();
        public OrderedMap<string, HunterState> birdState = new OrderedMap<string, HunterState>();
        public OrderedMap<string, HunterState> dragonState = new OrderedMap<string, HunterState>();
        public ColonyState colony;
        public Nest nest;
        public List<Nest> oldNests = new List<Nest>();
        public OrderedMap<string, bool> stung = new OrderedMap<string, bool>();
        public SimStats stats = new SimStats();
        public List<Wasp> wasps = new List<Wasp>();
        public int nextWaspId;
        public Ext ext = new Ext();
        public Winter winter; public HiberPick hiberPick; public Spot springAt; // T1-15
        internal (string k, List<HiberSite> list) hiberCache;
        public int prevAct; public bool pressUsed;
        public int respawnAt; public bool extinct;
        public Wasp ghost;
        public Hint hint = new Hint();
        public int[] log = new int[CMD_FIELDS * 4096]; public int logLen;
        public long minute, day;
        public Num bio;
        public Season season;
        public Num lineage;
        public int drivenId;
        public PendingSwitch pendingSwitch;
        public Muni muni;
        public bool feeding;

        public Sim(Settings settings = null, SimOpts opts = null)
        {
            opts ??= new SimOpts();
            this.settings = settings != null ? settings.Clone() : new Settings { seed = 1234 };
            peer = opts.peer; net = opts.net; noAI = opts.noAI;
            var peers = opts.peers ?? new List<int> { peer };
            foreach (var p in peers) interest.Set(p, ChunkKey(ChunkOf(SPAWN.x), ChunkOf(SPAWN.z)));
            host = int.MaxValue; foreach (var p in peers) if (p < host) host = p;
            seed = this.settings.seed;
            tpm = TicksPerMinute(this.settings);
            dayTicks = (long)tpm * 1440;
            colony = Colony.New();
            nest = MakeNest(NEST.treeX, NEST.treeZ, NEST.x, NEST.y, NEST.z);
            colony.maxCells = T.sites.trunk.maxCells;
            nextWaspId = peer * 1000000 + 1;
            minute = ClockMinutes(0, this.settings);
            day = DayOf(minute);
            bio = this.settings.seasonDays / 200;
            season = new Season { n = 1, startMinute = minute - T.season.startFrac * this.settings.seasonDays * 1440, phase = "" };
            season.phase = Colony.SeasonPhase(SeasonFrac);
            var w = SpawnWasp(true);
            drivenId = w.id;
            UpdateChunks(true);
        }

        /// After a join from a snapshot: a fresh driven wasp of this peer's own colony, and an interest change to publish
        public void JoinSpawn()
        {
            var w = SpawnWasp(true);
            drivenId = w.id;
            activeKey = "";
            UpdateChunks();
            DrainEvents();
        }

        // ---------------------------------------------------------------- basics

        public void Emit(string type, params (string k, object v)[] data)
        {
            var e = new SimEvent { t = tick, type = type };
            foreach (var (k, v) in data) e.d[k] = v;
            events.Add(e);
        }
        public List<SimEvent> DrainEvents() { var e = events; events = new List<SimEvent>(); return e; }
        public Wasp wasp => Driven() ?? ghost;
        public Wasp Driven() { foreach (var w in wasps) if (w.id == drivenId) return w; return null; }
        public Wasp WaspById(int id) { foreach (var w in wasps) if (w.id == id) return w; return null; }
        public Human HumanByHex(string hex)
        {
            if (hex != null && humans.TryGet(hex, out var h)) return h;
            return ext.hm != null && ext.hm.hex == hex ? ext.hm : null;
        }
        /// Human traits with the world's modifiers applied (GDD 4.8). The resolver still enforces the consequence window.
        public Traits TraitsFor(ulong id)
        {
            var tr = Body.HumanTraits(seed, id); Num r = settings.reaction;
            if (r != 1) tr.reactionTicks = Max(T.resolve.minConsequenceTicks, Rnd(tr.reactionTicks * r));
            return tr;
        }

        public ChunkState CS(string key)
        {
            if (!chunkState.TryGet(key, out var s)) { s = new ChunkState(); chunkState.Set(key, s); }
            return s;
        }
        public int EscLevel(string key)
        {
            if (!chunkState.TryGet(key, out var s)) return 0;
            var L = T.esc.levels; int lv = 0;
            for (int i = 1; i < L.Length; i++) if (s.esc >= L[i]) lv = i;
            return lv;
        }
        /// Everything a chunk holds lies within 34 m of its centre (world generation keeps to that; a test checks it).
        /// Scans for things near a point skip chunks farther than this, which changes no result and saves most of the work.
        public static readonly Num REACH = 40;
        static bool Near(ChunkRec rec, Num x, Num z) => Abs(x - rec.cx * World.CS) <= REACH && Abs(z - rec.cz * World.CS) <= REACH;

        public int EscAt(Num x, Num z) => EscLevel(KeyOf(ChunkOf(x), ChunkOf(z)));
        /// Chunk keys without building a string every call (the sim asks for the same few chunks every tick)
        readonly Dictionary<long, string> keyCache = new Dictionary<long, string>();
        public string KeyOf(int cx, int cz)
        {
            long k = ((long)cx << 32) ^ (uint)cz;
            if (!keyCache.TryGetValue(k, out var s)) { if (keyCache.Count > 4096) keyCache.Clear(); keyCache[k] = s = ChunkKey(cx, cz); }
            return s;
        }
        public void AddEsc(Num x, Num z, Num pts)
        {
            string k = ChunkKey(ChunkOf(x), ChunkOf(z)); int before = EscLevel(k);
            CS(k).esc += pts * settings.escalation * (colony != null && colony.sited && k == nest.key ? T.sites.Of(nest.site).discovery : 1);
            int after = EscLevel(k);
            if (after != before) Emit("escalation", ("key", k), ("level", after));
        }
        /// The day's weather plus the season's swing: cold springs for founding queens, cooling autumns (GDD 5.3)
        long tcMinute = long.MinValue; Num tcStart, tcVal;
        /// Debug and test hook: force the air temperature; null follows the weather and the season
        public Num? tempOverride;
        public Num Temperature
        {
            get
            {
                if (tempOverride.HasValue) return tempOverride.Value;
                if (tcMinute == minute && tcStart == season.startMinute) return tcVal; // asked by every wasp every tick
                tcVal = AirAt(minute);
                tcMinute = minute; tcStart = season.startMinute;
                return tcVal;
            }
        }
        /// The air at a minute: the day's weather plus the season's swing
        public Num AirAt(long m)
        {
            Num f = (m - season.startMinute) / (settings.seasonDays * 1440);
            return TempAt(seed, m) - T.weather.springChill * Clamp01((0.25 - f) / 0.25) - T.weather.autumnChill * Clamp01((f - 0.8) / 0.2);
        }
        /// How fast the brood develops at a minute (GDD 6.6, T1-14): full speed in a comfortable nest; cold snaps and heat
        /// slow it, as much as the site lets the weather in. An attic heats up on sunny afternoons.
        /// Water the colony has fanned over the comb takes the heat's share away (T2-1)
        public Num BroodSpeed(long m)
        {
            var S = T.sites.Of(nest.site); Num air = NestAir(m);
            Num cold = Clamp01((T.thermal.coldFrom - air) / T.thermal.coldSpan), hot = Clamp01((air - T.thermal.hotFrom) / T.thermal.hotSpan) * T.thermal.hotWeight * (1 - Clamp01(colony.cool));
            return Max(T.thermal.minSpeed, 1 - (1 - S.insulation) * (cold + hot));
        }
        /// the air at the nest: the weather, plus the sun on an attic roof
        Num NestAir(long m)
        {
            var S = T.sites.Of(nest.site); long d = MinuteOfDay(m);
            return AirAt(m) + S.heat * Max(0, DSin(TAU * (d - 540) / 1440)) * (IsRaining(seed, m) ? 0 : 1);
        }
        /// The nest's heat (GDD 6.6, T2-1): past comfort through the site's insulation (0..1), and how far the comb is past
        /// the temperature that kills brood (0..1)
        public (Num heat, Num cook, Num nestT) NestHeat(long m)
        {
            var S = T.sites.Of(nest.site); Num air = NestAir(m), keep = 1 - S.insulation;
            Num nestT = T.water.nestBase + Max(0, air - T.water.nestBase) * keep;
            return (keep * Clamp01((air - T.thermal.hotFrom) / T.thermal.hotSpan), Clamp01((nestT - T.water.lethal) / T.water.lethalSpan), nestT);
        }
        public (Num heat, Num cook, Num nestT) NestHeat() => NestHeat(minute);
        public Num BroodSpeed() => BroodSpeed(minute);
        long wcMinute = long.MinValue; V3 wcVal;
        public V3 Wind { get { if (windOverride.HasValue) return windOverride.Value; if (wcMinute != minute) { wcVal = WindAt(seed, minute); wcMinute = minute; } return wcVal; } }
        internal V3? windOverride; internal System.Func<ChunkRec, int, Num> nectarOverride; internal System.Func<ChunkRec, List<Carrion>> carrionOverride; internal System.Func<int, int, long, V3?> carrionSpotOverride; // test hooks
        /// Debug and test hook: force rain on (true) or off (false); null follows the weather
        public bool? rainOverride;
        public bool Raining => rainOverride ?? IsRaining(seed, minute);
        public DayWeather WeatherToday => World.Weather(seed, day);
        /// under something that keeps the rain off (T2-2): a box overhead, or a tree crown
        internal bool Sheltered(Wasp w)
        {
            foreach (var rec in activeChunks)
            {
                var c = rec.content;
                foreach (var b in c.boxes) if (w.x > b.minx && w.x < b.maxx && w.z > b.minz && w.z < b.maxz && b.miny >= w.y) return true;
                foreach (var t in c.trees) if (w.y < t.h && Sq(w.x - t.x) + Sq(w.z - t.z) < t.cr * t.cr) return true;
            }
            return false;
        }
        public int PhysicalCount => Own().Count;
        List<Wasp> Own() { var l = new List<Wasp>(); foreach (var w in wasps) if (w.colony == "own") l.Add(w); return l; }
        int OwnWorkers() { int n = 0; foreach (var w in wasps) if (w.colony == "own" && w.caste == "worker") n++; return n; } // males and gynes out are not workers (T2-3)
        public Num SeasonFrac => (minute - season.startMinute) / (settings.seasonDays * 1440);
        public bool CanFly() => Temperature >= T.weather.flyMinTemp;

        static int ById(Wasp a, Wasp b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

        internal Wasp SpawnWasp(bool driven, string caste = "worker")
        {
            int id = nextWaspId++;
            var w = new Wasp
            {
                id = id, caste = caste, x = nest.spawn.x, y = nest.spawn.y, z = nest.spawn.z, yaw = nest.spawn.yaw, born = minute,
            };
            if (!driven)
            {
                var a = T.alloc[colony.alloc]; Num s = a.sugar + a.protein + a.pulp, r = H32(id, 77) * s;
                w.role = r < a.sugar ? "sugar" : r < a.sugar + a.protein ? "protein" : "pulp";
                if (H32(id, 78) < colony.thirst * T.water.aiShare) w.role = "water"; // a hot nest sends water carriers (T2-1)
                w.x = nest.entrance.x; w.y = nest.entrance.y - 0.03; w.z = nest.entrance.z;
            }
            wasps.Add(w);
            Stable.Sort(wasps, ById);
            Emit("waspSpawn", ("id", id), ("driven", driven), ("caste", caste));
            return w;
        }

        // ---------------------------------------------------------------- chunks and humans

        void UpdateChunks(bool force = false)
        {
            Num wx, wz;
            var dw = Driven() ?? ghost;
            if (dw != null) { wx = dw.x; wz = dw.z; } else { wx = nest.spawn.x; wz = nest.spawn.z; }
            int ccx = ChunkOf(wx), ccz = ChunkOf(wz);
            string key = KeyOf(ccx, ccz);
            if (key == activeKey && !force) return;
            bool changed = key != activeKey;
            activeKey = key;
            int D = T.chunk.discoverRadius, A = T.chunk.activeRadius;
            for (int dz = -D; dz <= D; dz++) for (int dx = -D; dx <= D; dx++) Discover(ccx + dx, ccz + dz);
            var act = new List<ChunkRec>();
            for (int dz = -A; dz <= A; dz++) for (int dx = -A; dx <= A; dx++) act.Add(records.Get(ChunkKey(ccx + dx, ccz + dz)));
            activeChunks = act;
            Emit("chunksActive", ("key", key));
            if (changed && interest.Get(peer) != key) Publish(new NetEv { type = "interest", key = key });
            if (force) RebuildHumans();
        }

        static (int, int) SplitKey(string k) { int c = k.IndexOf(','); return (int.Parse(k.Substring(0, c)), int.Parse(k.Substring(c + 1))); }
        static int Ordinal(string a, string b) => string.CompareOrdinal(a, b);

        /// The humans every peer simulates: those in the 3x3 window around any peer's committed interest
        public void RebuildHumans()
        {
            int A = T.chunk.activeRadius; var keys = new HashSet<string>();
            foreach (var k in interest.Values)
            {
                var (cx, cz) = SplitKey(k);
                for (int dz = -A; dz <= A; dz++) for (int dx = -A; dx <= A; dx++) keys.Add(ChunkKey(cx + dx, cz + dz));
            }
            var before = new HashSet<Human>(active);
            var list = new List<Human>();
            var sorted = new List<string>(keys); sorted.Sort(Ordinal);
            foreach (var k in sorted)
            {
                var (cx, cz) = SplitKey(k);
                Discover(cx, cz);
                var rec = records.Get(k);
                foreach (var hs in rec.content.humans)
                {
                    ulong id = Hash(seed, Domain.WorldGen, U64(rec.cx), U64(rec.cz), (ulong)hs.slot);
                    string hex = Hex64(id);
                    if (!humans.TryGet(hex, out var hm))
                    {
                        var tr = TraitsFor(id);
                        Num ax = hs.x + T.panic.approachDist * DCos(hs.exit), az = hs.z + T.panic.approachDist * DSin(hs.exit);
                        hm = new Human
                        {
                            id = id, hex = hex, @short = hex.Substring(0, 4), tr = tr, clothing = Body.HumanClothing(seed, id, day), chunk = k,
                            home = new Home { x = hs.x, z = hs.z, fx = hs.fx, fz = hs.fz, posture = hs.posture, ax = ax, az = az, act = hs.act, path = hs.path },
                            x = hs.x, z = hs.z, fx = hs.fx, fz = hs.fz, posture = hs.posture, clothesDay = day,
                            sit = Body.BodyParts(tr, "sit"), stand = Body.BodyParts(tr, "stand"),
                        };
                        humans.Set(hex, hm);
                    }
                    if (!before.Contains(hm)) CatchUpHuman(hm);
                    list.Add(hm);
                }
            }
            if (ext.hm != null) list.Add(ext.hm);
            Stable.Sort(list, (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            active = list;
            Emit("humansActive", ("count", list.Count));
        }

        HumanWin Window(Human hm)
        {
            if (hm.winDay != day)
            {
                hm.winDay = day; hm.win = hm.special ? null : HumanWindow(seed, hm.id, day, settings.humanDensity);
                if (hm.win != null && hm.home != null && hm.home.act != null) hm.win = ActWindow(hm.home.act, hm.win);
            }
            return hm.win;
        }
        /// The weather picks who comes out (GDD 8.2, T1-11): nobody strolls, gardens or sunbathes in the rain; gardeners need
        /// a mild day, sunbathers a warm one and only stay through the warm hours
        internal HumanWin ActWindow(string act, HumanWin win)
        {
            if (World.Weather(seed, day).rain) return null;
            Num warm = AirAt(day * 1440 + 13 * 60);
            if (act == "garden" && warm < T.days.gardenTemp) return null;
            if (act == "sun")
            {
                if (warm < T.days.sunTemp) return null;
                Num arrive = Max(win.arrive, T.days.sunFrom), leave = Min(win.leave, T.days.sunTo);
                return leave - arrive >= T.days.minStay ? new HumanWin { arrive = arrive, leave = leave } : null;
            }
            return win;
        }

        /// On (re)activation, put a human where their schedule says they are (GDD 8.2)
        void CatchUpHuman(Human hm)
        {
            if (hm.special) return;
            var w = Window(hm); long m = MinuteOfDay(minute);
            bool present = w != null && m >= w.arrive && m < w.leave;
            if (present && (hm.state == "away" || hm.state == "leave")) Seat(hm);
            if (!present && hm.state != "away") GoAway(hm);
        }
        void Seat(Human hm)
        {
            var h = hm.home;
            hm.x = h.x; hm.z = h.z; hm.fx = h.fx; hm.fz = h.fz; hm.posture = h.posture; hm.state = "idle";
            if (hm.clothesDay != day) { hm.clothing = Body.HumanClothing(seed, hm.id, day); hm.clothesDay = day; }
        }
        /// at their table, or out for a walk or in the beds (T1-11)
        internal static bool Calm(Human hm) => hm.state == "idle" || hm.state == "stroll" || hm.state == "garden";
        void GoAway(Human hm) { hm.x = hm.home.ax; hm.z = hm.home.az; hm.state = "away"; hm.posture = "stand"; hm.panic = 0; }
        public bool Present(Human hm) => hm.state != "away";

        void Discover(int cx, int cz)
        {
            string key = ChunkKey(cx, cz);
            if (records.Has(key)) return;
            var content = GenerateChunk(seed, cx, cz);
            records.Set(key, new ChunkRec { cx = cx, cz = cz, genVersion = T.GEN_VERSION, discoveredTick = tick, contentHash = ContentHash(content), content = content });
            Emit("chunkDiscovered", ("cx", cx), ("cz", cz));
        }

        // ---------------------------------------------------------------- step

        public void Step(Cmd cmd)
        {
            Record(cmd);
            tick++;
            long m = ClockMinutes(tick + clockOffset, settings);
            if (m != minute) Minute(m);
            ApplyPending();
            if (remote.Count > 0) ExtrapolateRemote();

            int act = cmd.act, edge = act & ~prevAct;
            prevAct = act;
            if (cmd.alloc > 0 && cmd.alloc <= T.alloc.Length && colony.alloc != cmd.alloc - 1) { colony.alloc = cmd.alloc - 1; Emit("alloc", ("preset", colony.alloc)); }
            int pick = cmd.pick;
            if (winter != null) { WinterStep(pick); pick = 0; } // in winter a pick chooses the queen (T1-15)
            if ((edge & Act.Switch) != 0) PossessNearest();
            else if (pick > 0 && pick != drivenId) PossessNearest(pick);
            PendingSwitchTick();
            if ((edge & Act.Rest) != 0) Rest();
            if (cmd.sting == 0) pressUsed = false;

            // 1. wasps, in id order
            var driven = Driven();
            hint = new Hint();
            foreach (var w in new List<Wasp>(wasps))
            {
                if (!wasps.Contains(w)) continue;
                if (w == driven) StepWasp(w, cmd, edge, true);
                else StepWasp(w, Think(w), 0, false);
            }
            // 2. swats, sprays, bees: every tick
            Swats();
            Sprays();
            Bees();
            Birds();
            Dragonflies();
            Fights();
            AlarmDecay();
            // 3. humans at 20 Hz
            if (tick % 3 == 0) Humans();
            // 4. colony at 1 Hz
            if (tick % 60 == 0) ColonyTick();
            // 5. respawn of the driven wasp
            if (Driven() == null && !extinct && winter == null && tick >= respawnAt) Respawn();
            UpdateChunks();
            if (net) { DropSweep(); SendState(); }
            if (claims.Count > 0 && tick % 60 == 0) ExpireClaims();
        }

        void Record(Cmd cmd)
        {
            if (logLen + CMD_FIELDS > log.Length) System.Array.Resize(ref log, log.Length * 2);
            var L = log; int i = logLen;
            L[i] = cmd.mx; L[i + 1] = cmd.my; L[i + 2] = cmd.mz; L[i + 3] = cmd.burst != 0 ? 1 : 0; L[i + 4] = cmd.sting != 0 ? 1 : 0;
            L[i + 5] = cmd.yawQ; L[i + 6] = cmd.pitchQ; L[i + 7] = cmd.act; L[i + 8] = cmd.alloc; L[i + 9] = cmd.pick;
            logLen += CMD_FIELDS;
        }
        public static Cmd CmdAt(int[] log, int t)
        {
            int i = t * CMD_FIELDS;
            return new Cmd { mx = log[i], my = log[i + 1], mz = log[i + 2], burst = log[i + 3], sting = log[i + 4], yawQ = log[i + 5], pitchQ = log[i + 6], act = log[i + 7], alloc = log[i + 8], pick = log[i + 9] };
        }

        internal void Minute(long m)
        {
            long newDay = DayOf(m);
            minute = m;
            if (newDay != day)
            {
                long days = newDay - day;
                day = newDay;
                Num k = 1;
                for (long i = 0; i < days; i++) k *= 1 - T.esc.decayPerDay;
                foreach (var s in chunkState.Values) { s.esc *= k; s.beeLost = new Dictionary<int, Dictionary<int, int>>(); s.caughtCat = new Dictionary<int, int>(); s.robbed = new Dictionary<int, int>(); s.meat = new Dictionary<int, int>(); }
                Emit("newDay", ("day", newDay));
            }
        }

        // ---------------------------------------------------------------- possession and rest (GDD 7.7)

        /// Q-03: any worker within 30 m is free to take. Beyond that the colony relays you, after a delay, to the
        /// nearest worker anywhere, or to a worker inside the nest who comes out.
        void PossessNearest(int pick = 0)
        {
            var d = Driven();
            if (d == null || d.state == "under" || d.state == "balled") return;
            if (pendingSwitch != null) { bool same = pick != 0 && pendingSwitch.target == pick; pendingSwitch = null; Emit("switchCancelled"); if (pick == 0 || same) return; }
            Wasp best = null; Num bd = Num.MaxValue;
            if (pick != 0)
            {
                var w = WaspById(pick);
                if (w == null || w.colony != "own" || w == d || w.caste == "gyne") return;
                best = w; bd = D2(w, d);
            }
            else foreach (var w in wasps)
                {
                    if (w == d || w.state == "dead" || w.colony != "own" || w.caste == "gyne") continue; // a young queen is not yours to fly (T2-3)
                    Num q = D2(w, d);
                    if (q < bd) { bd = q; best = w; }
                }
            if (best != null && bd <= T.possess.freeRange * T.possess.freeRange) { Possess(d, best); return; }
            bool inside = colony.nestAlive && colony.sited && colony.adults - OwnWorkers() >= 1;
            if (best == null && !inside) { Emit("noSwitch"); return; }
            pendingSwitch = new PendingSwitch { at = tick + T.possess.relayTicks, target = best != null ? best.id : 0 };
            Emit("switchPending", ("seconds", (Num)T.possess.relayTicks / 60), ("toNest", best == null));
        }

        void Possess(Wasp d, Wasp best)
        {
            d.ai = new Ai();
            if (d.state == "attached") Detach(d, null);
            drivenId = best.id;
            if (best.state == "attached") Detach(best, null);
            Emit("possess", ("id", best.id), ("from", d.id));
        }

        void PendingSwitchTick()
        {
            var ps = pendingSwitch;
            if (ps == null || tick < ps.at) return;
            pendingSwitch = null;
            var d = Driven();
            if (d == null) return;
            var to = ps.target != 0 ? WaspById(ps.target) : null;
            if (to == null)
            {
                if (!(colony.nestAlive && colony.adults - OwnWorkers() >= 1)) { Emit("noSwitch"); return; }
                to = SpawnWasp(true); // a worker from inside the nest
            }
            Possess(d, to);
        }

        void Rest()
        {
            if (net) { Emit("cantRest", ("why", "net")); return; }
            var d = Driven();
            if (d == null || D2(d, nest.entrance) > 0.4 * 0.4) { Emit("cantRest", ("why", "away")); return; }
            long md = MinuteOfDay(minute);
            if (md >= T.time.dawn && md < T.time.dusk) { Emit("cantRest", ("why", "day")); return; }
            Num target = (md >= T.time.dusk ? day + 1 : day) * 1440 + T.time.dawn;
            Num skipMin = target - minute;
            Num skipTicks = skipMin * tpm;
            clockOffset += (long)skipTicks;
            // the colony lives through the skipped time
            Num steps = Floor(skipTicks / 60), dtDay = (Num)60 / dayTicks;
            long m0 = minute; Num frac0 = SeasonFrac;
            for (int i = 0; i < steps; i++) { long m = m0 + i * 60 / tpm; var nh = NestHeat(m); Colony.Step(colony, dtDay, wasps.Count, false, frac0, bio, BroodSpeed(m), null, (nh.heat, nh.cook)); }
            foreach (var w in new List<Wasp>(wasps)) if (w != d) Despawn(w);
            Minute(ClockMinutes(tick + clockOffset, settings));
            foreach (var hm in active) CatchUpHuman(hm);
            d.energy = Max(d.energy, T.energy.nestRefill);
            Emit("rested", ("minutes", skipMin));
        }

        // ---------------------------------------------------------------- state hash (GDD 3.8)

        sealed class Fnv
        {
            uint h = 0x811c9dc5;
            public void F(Num v)
            {
                ulong b = (ulong)v.Bits;
                for (int i = 0; i < 8; i++) { h ^= (uint)((b >> (8 * i)) & 0xff); h = unchecked(h * 0x01000193); }
            }
            public string Hex => h.ToString("x8");
        }
        static readonly string[] HSTATES = { "away", "arrive", "idle", "flee", "return", "leave", "treat", "fetch", "seek", "watch", "toGrill", "cook", "stroll", "garden" };

        public string StateHash()
        {
            var f = new Fnv();
            f.F(tick); f.F(clockOffset); f.F(drivenId);
            foreach (var w in wasps) { f.F(w.id); f.F(w.x); f.F(w.y); f.F(w.z); f.F(w.vx); f.F(w.vy); f.F(w.vz); f.F(w.energy); f.F(w.venom); f.F(w.bodyT); }
            var c = colony;
            f.F(c.adults); f.F(c.eggs); f.F(c.larvae); f.F(c.pupae); f.F(c.cells); f.F(c.protein); f.F(c.sugar); f.F(c.pulp); f.F(c.deficit); f.F(c.water); f.F(c.cool); // T2-1
            f.F(c.rEggs); f.F(c.rLarvae); f.F(c.rPupae); f.F(c.gynes); f.F(c.mated); f.F(season.n); f.F(lineage);
            f.F(stung.Count); f.F(stats.stings); f.F(stats.aiStings); f.F(records.Count);
            foreach (var hm in active) { f.F(hm.x); f.F(hm.z); f.F(hm.panic); f.F(hm.posture == "sit" ? 1 : 0); }
            foreach (var s in swats) { f.F(s.start); f.F(s.radius); }
            foreach (var kv in chunkState) { f.F(kv.Value.esc); f.F(kv.Key.Length); }
            foreach (var al in hiveAlarms.Values) foreach (var p in al.phys.Values) { f.F(p.x); f.F(p.y); f.F(p.z); }
            return f.Hex;
        }

        /// Agreement check between peers: everything about the shared humans
        public string HumanHash()
        {
            var f = new Fnv();
            // the exterminator works for one colony and searches by what that colony does (T1-7), so he is not a shared human
            foreach (var hm in active) { if (hm.special) continue; f.F(hm.x); f.F(hm.z); f.F(hm.panic); f.F(System.Array.IndexOf(HSTATES, hm.state)); f.F(hm.stungCount); f.F(hm.clothing.topOff ? 1 : 0); f.F(hm.sprayCount); }
            var list = new List<KeyValuePair<string, ChunkState>>();
            foreach (var kv in chunkState) if (kv.Value.esc > 0) list.Add(kv);
            Stable.Sort(list, (a, b) => Ordinal(a.Key, b.Key) < 0 ? -1 : 1);
            foreach (var kv in list)
            {
                f.F(kv.Key.Length); f.F(kv.Value.esc);
                if (kv.Value.spilled != null)
                {
                    var ks = new List<int>(kv.Value.spilled.Keys);
                    Stable.Sort(ks, (a, b) => Ordinal(a.ToString(), b.ToString()));
                    foreach (var i in ks) { f.F(i); f.F(kv.Value.spilled[i]); }
                }
                if (kv.Value.cover != null)
                {
                    var ks = new List<int>(kv.Value.cover.Keys);
                    Stable.Sort(ks, (a, b) => Ordinal(a.ToString(), b.ToString()));
                    foreach (var i in ks) { f.F(i); f.F(kv.Value.cover[i]); }
                }
            }
            f.F(stung.Count);
            return f.Hex;
        }

        public static string Replay(Settings settings, int[] log, int ticks)
        {
            var s = new Sim(settings);
            for (int t = 0; t < ticks; t++) { s.Step(CmdAt(log, t)); s.events.Clear(); }
            return s.StateHash();
        }

        /// Stand-in for the JS content hash (fnv32 of JSON): FNV over the content's numbers. Used to check saves.
        public static uint ContentHash(ChunkContent c)
        {
            uint h = 0x811c9dc5;
            void F(Num v) { ulong b = (ulong)v.Bits; for (int i = 0; i < 8; i++) { h ^= (uint)((b >> (8 * i)) & 0xff); h = unchecked(h * 0x01000193); } }
            F(c.cx); F(c.cz); F(c.tint);
            foreach (var t in c.trees) { F(t.x); F(t.z); F(t.r); F(t.h); }
            foreach (var t in c.boxes) { F(t.minx); F(t.maxx); F(t.miny); F(t.maxy); F(t.minz); F(t.maxz); }
            foreach (var t in c.humans) { F(t.slot); F(t.x); F(t.z); }
            F(c.sugar.Count); F(c.hives.Count); F(c.webs.Count); F(c.sheds.Count);
            return h;
        }
    }
}
