// Data types of the simulation (port of the object shapes in poc/sim/sim.js). Fields keep the JS names.
using System.Collections.Generic;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public static class Act { public const int Interact = 1, Switch = 2, Rest = 4; }

    /// One tick of input. Players fill mx..pick; AI brains set hasDir with dirX/Y/Z and throttle instead of yaw and pitch.
    public sealed class Cmd
    {
        public int mx, my, mz, burst, sting, yawQ, pitchQ, act, alloc, pick;
        public bool hasDir; public double dirX, dirY, dirZ, throttle;
        public Cmd Clone() => (Cmd)MemberwiseClone();
    }

    public sealed class Carry { public string kind, what; public double amount; public bool poison; }
    public sealed class AiTarget { public string kind, key, sub, hex; public int i, c; public V3 p; }
    public sealed class Ai
    {
        public string mode = "pick"; public AiTarget target; public double timer, until; public string humanHex; public int stings, huntId;
        public double stingHold, cargo; public string atFood;
        public Ai Clone() => (Ai)MemberwiseClone();
    }
    public sealed class Attach { public string hex, posture; public V3 local, n; public int start; public bool deepened; public int zone; }
    public sealed class UnderMove { public int to, t; }
    public sealed class Under { public string hex, posture, key; public int node, sel, entered; public UnderMove move; public double nextPress; public bool mxHeld, mzHeld; }
    public sealed class Ball { public double temp, progress, prevBurst, bees; }
    public sealed class WebHold { public string key; public int i; public double progress, prevBurst; public int start; public double spiderAt; }
    public sealed class Fight
    {
        public int other; public bool remote, starter; public int peer; public double start, until, mash, myVenom, theirVenom; public bool theirQueen;
    }
    public sealed class Contact
    {
        public string humanHex; public int zone; public bool blocked; public double reach; public V3 n, surf; public string part;
        public int opening = -1; public string openingKey;
    }
    public sealed class Perch
    {
        public string hex, posture; public V3 local, n, surf; public int zone; public string part; public double tickle, need, quietUntil;
    }

    /// What every wasp, local or remote, has: enough to be chased, hit or drawn
    public class WaspBase
    {
        public int id; public string caste = "worker";
        public double x, y, z, vx, vy, vz;
        public string state = "fly";
        public V3 P => new V3(x, y, z);
    }

    public sealed class Wasp : WaspBase
    {
        public double yaw, pitch, energy = 1, venom = 1;
        public int stateTicks;
        public Attach attach; public Under under; public Ball ball; public double born;
        public Carry carry; public int groundTicks, chew; public string role = "sugar", colony = "own";
        public WebHold web; public Fight fight; public Ai ai = new Ai(); public Contact contact; public Perch perch;
        public bool walking; public double fightReqUntil;
        public Wasp Ghost() { var g = (Wasp)MemberwiseClone(); g.state = "dead"; return g; }
    }

    public sealed class RemoteWasp : WaspBase
    {
        public string carry, under; public bool rival;
        public int peer, stamp, seen, bad; public double px, py, pz;
    }

    public sealed class Home { public double x, z, fx, fz, ax, az; public string posture; }
    public sealed class Human
    {
        public ulong id; public string hex, @short; public Traits tr; public Clothing clothing; public string chunk; public Home home;
        public double x, z, fx, fz; public string posture; public string state = "idle";
        public double panic, fleeSteps, dirX, dirZ, stungCount; public long winDay = -1; public HumanWin win;
        public int annoyId; public double annoy, cooldown, sprayCount, treat; public long clothesDay; public bool special;
        public List<Part> sit, stand;
        public List<Part> Parts(string posture) => posture == "sit" ? sit : stand;
        public List<Part> PartsNow => posture == "sit" ? sit : stand;
        public Frame F => new Frame(x, z, fx, fz);
    }

    /// Anything sent between peers
    public abstract class Msg { public string mk; public int peer, tick; }

    /// A network event: one class holds every field any event type uses (sim.js publishes plain objects)
    public sealed class NetEv : Msg
    {
        public string type; public int seq, commit;
        public int waspId; public bool driven; public string humanHex; public int zone; public bool under; public List<Swat> swats;
        public double panicGain; public bool flee; public double sx, sz; public double extra;
        public string key; public int i, hive, h, target; public string what; public double radius;
        public string byHex, cause; public double x, y, z;
        public double start, end, window; public int kind; public V3 center; public bool kills; public string why;
        public int a, b, toPeer; public double venom, mash; public bool queen; public int id;
        public NetEv() { mk = "ev"; }
        public NetEv Copy()
        {
            var e = (NetEv)MemberwiseClone();
            if (swats != null) { e.swats = new List<Swat>(); foreach (var s in swats) e.swats.Add(s.Clone()); }
            return e;
        }
    }

    public sealed class StateMsg : Msg { public List<RemoteWasp> wasps = new List<RemoteWasp>(); public StateMsg() { mk = "state"; } }

    /// Something that happened, for the presentation and for tests (sim.js emit)
    public sealed class SimEvent
    {
        public int t; public string type; public Dictionary<string, object> d = new Dictionary<string, object>();
        public object this[string k] => d.TryGetValue(k, out var v) ? v : null;
        public override string ToString() => type;
    }

    public sealed class ChunkRec { public int cx, cz, genVersion, discoveredTick; public uint contentHash; public ChunkContent content; }
    public sealed class LastSting { public double x, z; }
    public sealed class ChunkState
    {
        public double esc, chewed;
        public Dictionary<int, double> caughtFly = new Dictionary<int, double>();
        public Dictionary<int, int> caughtCat = new Dictionary<int, int>();
        public Dictionary<int, Dictionary<int, int>> beeLost = new Dictionary<int, Dictionary<int, int>>();
        public LastSting lastSting;
        public Dictionary<int, long> webTorn;
        public Dictionary<int, double> spilled;
    }

    public sealed class BeePhys { public double x, y, z, vx, vy, vz, stun; public string mode; }
    /// phys: JS object with integer keys, which iterate in ascending order
    public sealed class HiveAlarm { public string key; public int h, target; public double until; public SortedDictionary<int, BeePhys> phys = new SortedDictionary<int, BeePhys>(); }
    public sealed class HunterState { public string mode; public double x, y, z, vx, vy, vz, until; public int target; }
    public sealed class Ext { public int visit; public string state = "none"; public double arriveMinute; public Human hm; }
    public sealed class Spray { public string hex; public double start, end; }
    public sealed class Alarm { public double x, y, z, until; public string killerHex; }
    public sealed class Season { public int n; public double startMinute; public string phase; }
    public sealed class MuniCampaign { public int n; public string center; public List<string> keys; public double until; }
    public sealed class Muni { public int n; public MuniCampaign active; public double cooldownUntil; }
    public sealed class PendingSwitch { public int at, target; }
    public sealed class SimStats { public double stings, aiStings, remoteStings, full, deaths, caught, deposits; public Dictionary<string, double> causes = new Dictionary<string, double>(); }
    public sealed class NetStats { public double sent, recv, late, lateMax, rejected, dropped; }
    public sealed class Plaus
    {
        public Dictionary<int, int> strikes = new Dictionary<int, int>(); public List<int> quarantined = new List<int>();
        public Dictionary<int, int> lastSeq = new Dictionary<int, int>(); public Dictionary<string, List<int>> stingTicks = new Dictionary<string, List<int>>();
        public List<int> ruled = new List<int>();
    }
    public sealed class Hint { public string opening, prey, site; public bool bait, wood, nest, rival; }
    public sealed class SiteHit { public string type; public double x, y, z, ix, iz, nx, nz; public Tree t; }
    public sealed class Bait { public double x, y, z; public string key; }
    public sealed class PreyHit { public string kind, key; public int i, hive; public double protein; }
    public sealed class Food { public double x, y, z, rate; public string kind; public int i; public SugarNode node; }
    public sealed class SimOpts { public int peer; public bool net, noAI; public List<int> peers; }
}
