// Data types of the simulation (port of the object shapes in poc/sim/sim.js). Fields keep the JS names.
using System.Collections.Generic;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public static class Act { public const int Interact = 1, Switch = 2, Rest = 4, Swoop = 8; }

    /// One tick of input. Players fill mx..pick; AI brains set hasDir with dirX/Y/Z and throttle instead of yaw and pitch.
    public sealed class Cmd
    {
        public int mx, my, mz, burst, sting, yawQ, pitchQ, act, alloc, pick;
        public bool hasDir; public Num dirX, dirY, dirZ, throttle;
        public Cmd Clone() => (Cmd)MemberwiseClone();
    }

    public sealed class Carry { public string kind, what; public Num amount; public bool poison; }
    public sealed class AiTarget { public string kind, key, sub, hex; public int i, c; public V3 p; public AiTarget Copy() => (AiTarget)MemberwiseClone(); }
    /// a source a forager remembers, or whose scent a forager brought home (T1-16)
    public sealed class Known { public string role; public AiTarget t; public int until; }
    public sealed class Ai
    {
        public string mode = "pick"; public AiTarget target; public Num timer, until; public string humanHex; public int stings, huntId;
        public Num stingHold, cargo; public string atFood;
        // senses (T1-16): the source being worked, the one remembered, and the spiral search (angle, radius, which way)
        public AiTarget from; public Known known; public Num head, leg; public int spin;
        public Ai Clone() => (Ai)MemberwiseClone();
    }
    public sealed class Attach { public string hex, posture; public V3 local, n; public int start; public bool deepened; public int zone; }
    public sealed class UnderMove { public int to, t; }
    public sealed class Under { public string hex, posture, key; public int node, sel, entered; public UnderMove move; public Num nextPress; public bool mxHeld, mzHeld; }
    public sealed class Ball { public Num temp, progress, prevBurst, bees; }
    public sealed class Drown { public string key; public int until, i = -1; public Num progress, prevBurst; }
    public sealed class Cup { public Num x, z, level; public int i; }
    public sealed class Nectar { public Num lv; public long m; }
    public sealed class Rob { public string key; public int h; public Num progress, prevSting; }
    public sealed class Carrion { public Num x, y, z; public long d; public int left; }
    public sealed class SipPend { public string key; public int i; public Num amount, x, y, z; }
    public sealed class WebHold { public string key; public int i; public Num progress, prevBurst; public int start; public Num spiderAt; }
    public sealed class Fight
    {
        public int other; public bool remote, starter; public int peer; public Num start, until, mash, myVenom, theirVenom; public bool theirQueen;
    }
    public sealed class Contact
    {
        public string humanHex; public int zone; public bool blocked; public Num reach; public V3 n, surf; public string part;
        public int opening = -1; public string openingKey;
    }
    public sealed class Perch
    {
        public string hex, posture; public V3 local, n, surf; public int zone; public string part; public Num tickle, need, quietUntil;
    }

    /// What every wasp, local or remote, has: enough to be chased, hit or drawn
    public class WaspBase
    {
        public int id; public string caste = "worker";
        public Num x, y, z, vx, vy, vz;
        public string state = "fly";
        public V3 P => new V3(x, y, z);
    }

    public sealed class Wasp : WaspBase
    {
        public Num yaw, pitch, energy = 1, venom = 1, bodyT = T.cold.nestTemp; public int chill;
        public int stateTicks;
        public Attach attach; public Under under; public Ball ball; public Num born;
        public Carry carry; public int groundTicks, chew; public string role = "sugar", colony = "own";
        /// a young queen who has mated on her flight (T2-3)
        public bool mated;
        /// the wood being chewed (T1-12): a box in a chunk, or a tree (i = -1)
        public WoodSpot chewAt;
        public WebHold web; public Drown drown; public Fight fight; public Ai ai = new Ai(); public Contact contact; public Perch perch;
        public bool walking; public Num fightReqUntil;
        /// the surface a landed wasp holds on to, and a short window after takeoff before it can settle again
        public Land land; public int noLandUntil; public string trapCause;
        /// the swoop (GDD 7.9): the tick its dash ends, and the tick the next one may start
        public int swoopUntil, swoopReady;
        internal SipPend sipPend; // net only: sips not yet told to the other peers
        /// net only: holds a load the other peers saw it pick up, so letting go of it is told too (T1-20)
        public bool pubLoad;
        public Rob rob;
        public Wasp Ghost() { var g = (Wasp)MemberwiseClone(); g.state = "dead"; return g; }
    }

    public sealed class RemoteWasp : WaspBase
    {
        public string carry, under; public bool rival;
        public int peer, stamp, seen, bad, ttl; public Num px, py, pz;
    }

    public sealed class MemRec { public Num m, x, z; }
    public sealed class Land { public Num nx, ny, nz; public string kind; public bool hasH; public Num hx, hy, hz; public int yawQ; }
    public sealed class Surf { public Num x, y, z, nx, ny, nz, gap; public string kind; }
    public sealed class Home { public Num x, z, fx, fz, ax, az; public string posture; public string act; public Num[] path; public bool evening; }
    public sealed class Human
    {
        public ulong id; public string hex, @short; public Traits tr; public Clothing clothing; public string chunk; public Home home;
        public Num x, z, fx, fz; public string posture; public string state = "idle";
        public Num panic, fleeSteps, dirX, dirZ, stungCount; public long winDay = -1; public HumanWin win;
        public int annoyId; public Num annoy, cooldown, sprayCount, treat; public long clothesDay; public bool special;
        public List<Part> sit, stand;
        /// The stings this person remembers: when and where (T1-18)
        public List<MemRec> mem = new List<MemRec>();
        /// Fetching spray (T1-6)
        public int fetchT; public bool wantSpray;
        /// A stroll or a round of the beds (T1-11): the next point on the path, when the gardener moves on, on their feet
        public int wp; public long until; public bool walking;
        /// The exterminator's search (T1-7): where he walks next, how long he has watched, the lines he has seen
        public Num wpx, wpz, clue; public int watch, lines;
        // the garment graph is a pure function of traits, clothing and posture; clothing is replaced, never edited
        internal List<GNode> gCache; internal Clothing gClothing; internal string gPosture;
        public List<Part> Parts(string posture) => posture == "sit" ? sit : stand;
        public List<Part> PartsNow => posture == "sit" ? sit : stand;
        public Frame F => new Frame(x, z, fx, fz, posture == "lie");
    }

    /// Anything sent between peers
    public abstract class Msg { public string mk; public int peer, tick; public int to = -1; }

    /// A network event: one class holds every field any event type uses (sim.js publishes plain objects)
    public sealed class WoodSpot { public string key; public int i; public bool water; } // water: a load of water, not pulp (T2-1)
    public sealed class Claim { public int auth, i, hive, tick; public string key, what, carry; }
    public sealed class NetEv : Msg
    {
        public string type; public int seq, commit;
        public int waspId; public bool driven; public string humanHex; public int zone; public bool under; public List<Swat> swats;
        public Num panicGain; public bool flee; public Num sx, sz; public Num extra;
        public string key; public int i, hive, h, target; public string what; public Num radius;
        public string byHex, cause; public Num x, y, z;
        public Num start, end, window; public int kind; public V3 center; public bool kills; public string why; public Num amount;
        public int a, b, toPeer; public Num venom, mash; public bool queen; public int id;
        /// contested pickups (T1-19): the authority a claim is for, and on a ruling the claiming peer, its wasp and the claim's tick
        public int auth = -1, claimPeer = -1, claimWasp; public int? ctick;
        /// a late-event correction (GDD 11.6): the chunk's humans and its shared state, as the chunk authority had them
        public List<(string hex, byte[] s)> fixHumans; public byte[] fixChunk;
        /// a player's nest is alive (the `nest` event)
        public bool alive;
        public NetEv() { mk = "ev"; }
        public NetEv Copy()
        {
            var e = (NetEv)MemberwiseClone();
            if (swats != null) { e.swats = new List<Swat>(); foreach (var s in swats) e.swats.Add(s.Clone()); }
            return e;
        }
        static Num Z(Num v) => v == 0 ? 0 : v; // -0 arrives as 0 (the JS lab serializes events as JSON)
        static V3 Z(V3 v) => new V3(Z(v.x), Z(v.y), Z(v.z));
        /// A copy as it arrives at another peer
        public NetEv WireCopy()
        {
            var e = Copy();
            e.panicGain = Z(e.panicGain); e.sx = Z(e.sx); e.sz = Z(e.sz); e.extra = Z(e.extra); e.radius = Z(e.radius);
            e.x = Z(e.x); e.y = Z(e.y); e.z = Z(e.z); e.start = Z(e.start); e.end = Z(e.end); e.window = Z(e.window); e.center = Z(e.center);
            e.venom = Z(e.venom); e.mash = Z(e.mash);
            if (e.swats != null) foreach (var s in e.swats) { s.start = Z(s.start); s.window = Z(s.window); s.radius = Z(s.radius); s.reach = Z(s.reach); s.contactTick = Z(s.contactTick); s.center = Z(s.center); }
            return e;
        }
        /// Rough size of the event as JSON, for the lab's bandwidth figures
        public int ApproxJsonLength() => 64 + type.Length + (humanHex != null ? 32 : 0) + (key != null ? key.Length + 8 : 0) + (swats?.Count ?? 0) * 112 + 48;
    }

    public sealed class StateMsg : Msg { public List<RemoteWasp> wasps = new List<RemoteWasp>(); public int driven; public List<int> gone = new List<int>(); public StateMsg() { mk = "state"; } }
    /// mid-tier wasps (T1-21): position and state only
    public sealed class SwarmMsg : Msg { public List<RemoteWasp> wasps = new List<RemoteWasp>(); public SwarmMsg() { mk = "swarm"; } }
    /// far tier (T1-21): how many wasps are out in each chunk
    public sealed class TrafficMsg : Msg { public List<KeyValuePair<string, int>> chunks = new List<KeyValuePair<string, int>>(); public TrafficMsg() { mk = "traffic"; } }

    /// Something that happened, for the presentation and for tests (sim.js emit)
    public sealed class SimEvent
    {
        public int t; public string type; public Dictionary<string, object> d = new Dictionary<string, object>();
        public object this[string k] => d.TryGetValue(k, out var v) ? v : null;
        public override string ToString() => type;
    }

    /// a water source (T2-1): a birdbath, or a puddle after rain
    public sealed class WaterSrc { public Num x, y, z, r; public string kind; public int i; }
    public sealed class ChunkRec
    {
        public int cx, cz, genVersion, discoveredTick; public uint contentHash; public ChunkContent content;
        string _key; public string key => _key ??= World.ChunkKey(cx, cz);
        // caches of pure functions of the seed, the chunk and the clock (never saved, never hashed)
        internal object sites; internal List<Food> fruit; internal long fruitDay = long.MinValue; internal int fruitSeason;
        internal List<Bait> baits; internal int baitsCampaign = -1;
        internal List<Cup> cups; internal int[] beeLoad, flowerIdx; internal List<Hive> hives;
        internal List<Grill> grills; internal List<Cyl> cyls; internal List<Roof> roofs;
        internal List<WaterSrc> puddles; internal long puddleDay = long.MinValue; // T2-1
        string[] _sub = new string[0];
        /// "cx,cz#i": the key of the i-th hive or hunter in this chunk
        public string Sub(int i)
        {
            if (i >= _sub.Length) System.Array.Resize(ref _sub, i + 8);
            return _sub[i] ??= key + "#" + i;
        }
    }
    public sealed class LastSting { public Num x, z; }
    public sealed class ChunkState
    {
        public Num esc, chewed;
        public Dictionary<int, Num> caughtFly = new Dictionary<int, Num>();
        public Dictionary<int, int> caughtCat = new Dictionary<int, int>();
        public Dictionary<int, Dictionary<int, int>> beeLost = new Dictionary<int, Dictionary<int, int>>();
        public LastSting lastSting;
        public Dictionary<int, long> webTorn;
        public Dictionary<int, Num> spilled;
        /// a hand over a cup until this tick (GDD 7.5)
        public Dictionary<int, int> cover;
        /// nectar at the last sip and when (T1-8); carrion loads taken, by the day it appeared
        public Dictionary<int, Nectar> nectar; public Dictionary<int, int> carrion;
        /// loads robbed from each hive today (T1-9); barbecue meat taken today, by grill (2 ti) and plate (2 ti + 1) (T1-10)
        public Dictionary<int, int> robbed, meat;
        /// pulp chewed off each wooden box (T1-12)
        public Dictionary<int, int> pulp;
    }

    public sealed class BeePhys { public Num x, y, z, vx, vy, vz, stun; public string mode; }
    /// phys: JS object with integer keys, which iterate in ascending order
    public sealed class HiveAlarm { public string key; public int h, target; public Num until; public SortedDictionary<int, BeePhys> phys = new SortedDictionary<int, BeePhys>(); }
    public sealed class HunterState { public string mode; public Num x, y, z, vx, vy, vz, until; public int target; }
    public sealed class Ext { public int visit; public string state = "none"; public Num arriveMinute; public Human hm; public Lead lead; }
    /// Where the exterminator's last flight line took him, and for which nest (T1-7)
    public sealed class Lead { public Num x, z, nx, nz; }
    public sealed class Spray { public string hex; public Num start, end; }
    public sealed class Alarm { public Num x, y, z, until; public string killerHex; }
    public sealed class Season { public int n; public Num startMinute; public string phase; }
    public sealed class MuniCampaign { public int n; public string center; public List<string> keys; public Num until; }
    public sealed class Muni { public int n; public MuniCampaign active; public Num cooldownUntil; }
    public sealed class PendingSwitch { public int at, target; }
    public sealed class SimStats { public Num stings, aiStings, remoteStings, full, deaths, caught, deposits; public Dictionary<string, Num> causes = new Dictionary<string, Num>(); }
    public sealed class NetStats { public Num sent, recv, late, lateMax, rejected, dropped; public int firstLate, fixes, fixed_; }
    public sealed class Plaus
    {
        public Dictionary<int, int> strikes = new Dictionary<int, int>(); public List<int> quarantined = new List<int>();
        public Dictionary<int, int> lastSeq = new Dictionary<int, int>(); public Dictionary<string, List<int>> stingTicks = new Dictionary<string, List<int>>();
        public List<int> ruled = new List<int>();
        /// T1-20: which of other peers' wasps hold a load they picked up ("peer:wasp"), and each one's recent sips
        public Dictionary<string, int> held = new Dictionary<string, int>(); public Dictionary<string, List<SipRec>> sips = new Dictionary<string, List<SipRec>>();
    }
    public sealed class SipRec { public int t; public Num amount; }
    public sealed class Hint { public string opening, prey, site, hiber; public bool bait, wood, nest, rival, hive, water; public int? raid; }
    /// another player's nest, as it last said (colony against colony)
    public sealed class PeerNest { public Num x, y, z; public string key; public bool alive; }
    /// A hibernation site and the queens waking there (T1-15)
    /// a colony of the line run by the AI (T2-4)
    public sealed class LineColony { public int id, season; public Nest nest; public ColonyState colony; /** when the exterminator comes for it (0: not called) */ public long ext; }
    public sealed class HiberSite { public string kind; public Num x, y, z, q; public int n; public bool scouted; }
    public sealed class Winter { public string why; public List<HiberSite> sites = new List<HiberSite>(); public Num survivors, lineage; public int until; }
    public sealed class HiberPick { public int season; public Num x, z; public string kind; }
    public sealed class Spot { public Num x, z; }
    public sealed class SiteHit { public string type; public Num x, y, z, ix, iz, nx, nz; public Tree t; }
    public sealed class Bait { public Num x, y, z; public string key; }
    public sealed class PreyHit { public string kind, key; public int i, hive; public Num protein; }
    public sealed class Food { public Num x, y, z, rate; public string kind; public int i; public SugarNode node; }
    public sealed class SimOpts { public int peer; public bool net, noAI; public List<int> peers; }
}
