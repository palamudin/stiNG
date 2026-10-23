// A simulated network between peers, and the two-peer and N-peer labs built on it (GDD 11). Port of poc/sim/net.js.
// Deterministic: delays and losses come from the counter hash, so lab runs replay exactly.
using System;
using System.Collections.Generic;
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    /// A state packet on the wire: the encoded bytes
    public sealed class BinMsg : Msg { public byte[] bin; public BinMsg() { mk = "bin"; } }

    // ---------------------------------------------------------------- wire format for state packets (GDD 11.12)
    // Positions are chunk-relative, 16 bits per axis (1 mm horizontally, 0.6 mm vertically); velocity 8 bits per axis.
    public static class Wire
    {
        static readonly string[] STATES = { "fly", "stunned", "attached", "under", "chewing", "trapped", "balled", "landed", "webbed", "fighting", "dead", "perched", "drowning", "robbing" };
        static readonly string[] CARRY = { null, "fly", "caterpillar", "bee", "pulp", "larva" };
        static readonly Num CS = T.chunk.size, YMAX = 40, VMAX = 8;
        public const int BYTES_PER_WASP = 19;

        static void U8(byte[] b, int o, int v) => b[o] = (byte)v;
        static void U16(byte[] b, int o, int v) { b[o] = (byte)(v >> 8); b[o + 1] = (byte)v; }
        static void U32(byte[] b, int o, uint v) { b[o] = (byte)(v >> 24); b[o + 1] = (byte)(v >> 16); b[o + 2] = (byte)(v >> 8); b[o + 3] = (byte)v; }
        static int R16(byte[] b, int o) => (b[o] << 8) | b[o + 1];
        static uint R32(byte[] b, int o) => ((uint)b[o] << 24) | ((uint)b[o + 1] << 16) | ((uint)b[o + 2] << 8) | b[o + 3];

        public static byte[] EncodeState(StateMsg m)
        {
            var b = new byte[6 + m.wasps.Count * BYTES_PER_WASP];
            U8(b, 0, m.peer); U32(b, 1, (uint)m.tick); U8(b, 5, m.wasps.Count);
            int o = 6;
            static int Q16(Num x, Num lo, Num hi) => (int)Max(0, Min(65535, Rnd((x - lo) / (hi - lo) * 65535)));
            static int Q8(Num x) => (int)Max(-127, Min(127, Rnd(x / VMAX * 127)));
            foreach (var w in m.wasps)
            {
                int cx = World.ChunkOf(w.x), cz = World.ChunkOf(w.z);
                U32(b, o, (uint)w.id); U16(b, o + 4, (short)cx); U16(b, o + 6, (short)cz);
                U16(b, o + 8, Q16(w.x - cx * CS, -CS / 2, CS / 2)); U16(b, o + 10, Q16(w.y, 0, YMAX)); U16(b, o + 12, Q16(w.z - cz * CS, -CS / 2, CS / 2));
                b[o + 14] = (byte)(sbyte)Q8(w.vx); b[o + 15] = (byte)(sbyte)Q8(w.vy); b[o + 16] = (byte)(sbyte)Q8(w.vz);
                U8(b, o + 17, Math.Max(0, Array.IndexOf(STATES, w.state)));
                U8(b, o + 18, (w.caste == "queen" ? 128 : 0) | (w.under != null ? 64 : 0) | (w.rival ? 32 : 0) | Math.Max(0, Array.IndexOf(CARRY, w.carry)));
                o += BYTES_PER_WASP;
            }
            return b;
        }

        public static StateMsg DecodeState(byte[] b, string underHex = null)
        {
            int n = b[5];
            static Num D16(int x, Num lo, Num hi) => lo + (Num)x / 65535 * (hi - lo);
            var m = new StateMsg { peer = b[0], tick = (int)R32(b, 1) };
            int o = 6;
            for (int i = 0; i < n; i++)
            {
                int cx = (short)R16(b, o + 4), cz = (short)R16(b, o + 6), flags = b[o + 18];
                m.wasps.Add(new RemoteWasp
                {
                    id = (int)R32(b, o), x = cx * CS + D16(R16(b, o + 8), -CS / 2, CS / 2), y = D16(R16(b, o + 10), 0, YMAX), z = cz * CS + D16(R16(b, o + 12), -CS / 2, CS / 2),
                    vx = (Num)(sbyte)b[o + 14] / 127 * VMAX, vy = (Num)(sbyte)b[o + 15] / 127 * VMAX, vz = (Num)(sbyte)b[o + 16] / 127 * VMAX,
                    state = b[o + 17] < STATES.Length ? STATES[b[o + 17]] : null, caste = (flags & 128) != 0 ? "queen" : "worker",
                    under = (flags & 64) != 0 ? underHex ?? "yes" : null, rival = (flags & 32) != 0, carry = (flags & 31) < CARRY.Length ? CARRY[flags & 31] : null,
                });
                o += BYTES_PER_WASP;
            }
            return m;
        }
    }

    public sealed class LinkSpec { public string name; public int latency, jitter; public Num loss; }

    /// Unreliable state packets are simply dropped on loss. Events ride redundantly in following packets
    /// (GDD 11.13), so a lost event costs one state interval rather than a full round trip. Events stay in order.
    public sealed class Link
    {
        public static readonly Dictionary<string, LinkSpec> LINKS = new Dictionary<string, LinkSpec>
        {
            ["lan"] = new LinkSpec { name = "LAN", latency = 1, jitter = 1, loss = 0 },
            ["good"] = new LinkSpec { name = "Good internet", latency = 5, jitter = 2, loss = 0.02 },
            ["bad"] = new LinkSpec { name = "Bad internet", latency = 9, jitter = 4, loss = 0.08 },
            ["awful"] = new LinkSpec { name = "Past the window", latency = 16, jitter = 6, loss = 0.1 },
        };
        public static LinkSpec Spec(string name) => name != null && LINKS.TryGetValue(name, out var s) ? s : LINKS["good"];

        readonly int latency, jitter, seed; readonly Num loss;
        struct Q { public Num at; public int n; public Msg msg; }
        List<Q> q = new List<Q>();
        int n; Num lastEventAt;
        public int sent, dropped, resent;

        public Link(LinkSpec s, int seed) { latency = s.latency; jitter = s.jitter; loss = s.loss; this.seed = seed; }

        public void Send(Msg msg, int tick)
        {
            sent++;
            int k0 = n++;
            Num at = tick + latency + Floor(H32(seed, k0, 2) * (jitter + 1));
            if (msg is BinMsg)
            {
                if (H32(seed, k0, 1) < loss) { dropped++; return; }
            }
            else
            {
                int k = 0;
                while (H32(seed, k0, 10 + k) < loss && k < 8) { at += T.net.stateEvery; k++; resent++; }
                at = Max(at, lastEventAt);
                lastEventAt = at;
            }
            // what arrives is a copy, as if serialized (JSON in the JS lab: -0 arrives as 0)
            Msg copy = msg is BinMsg bm ? new BinMsg { bin = (byte[])bm.bin.Clone() } : (Msg)((NetEv)msg).WireCopy();
            q.Add(new Q { at = at, n = k0, msg = copy });
        }

        public List<Msg> Poll(int tick)
        {
            var o = new List<Q>(); var keep = new List<Q>();
            foreach (var e in q) (e.at <= tick ? o : keep).Add(e);
            q = keep;
            Stable.Sort(o, (a, b) => a.at != b.at ? Stable.Sign(a.at - b.at) : a.n - b.n);
            return o.ConvertAll(e => e.msg);
        }
    }

    public sealed class Checks { public int compared, agreed, skipped, firstDiverge; }

    /// Peer A is the player; peer B is a scripted second player stinging the same humans.
    public sealed class NetLab
    {
        public readonly string linkName;
        public Sim a, b;
        public readonly int joinAt;
        public int joined, joinBytes;
        readonly Link ab, ba;
        public Func<Sim, Cmd> botB;
        public readonly Checks checks = new Checks();
        public Num bytesAB, bytesBA, bytesABState, bytesABEvents;
        public List<SimEvent> bEvents = new List<SimEvent>();
        /// A test hook: runs on a peer's outbox before it is sent ("ab" or "ba"), so a test can turn a peer into a cheater
        public Action<Sim, string> beforeOut;

        public NetLab(Settings settings, string linkName = "good", Func<Sim, Cmd> botB = null, int joinAt = 0)
        {
            var L = Link.Spec(linkName);
            this.linkName = linkName;
            a = new Sim(settings, new SimOpts { peer = 0, net = true, peers = new List<int> { 0, 1 } });
            this.joinAt = joinAt;
            // a late joiner is built from a snapshot of A's world when the time comes (GDD 11.10)
            b = joinAt != 0 ? null : new Sim(settings, new SimOpts { peer = 1, net = true, noAI = true, peers = new List<int> { 0, 1 } });
            ab = new Link(L, 11);
            ba = new Link(L, 22);
            this.botB = botB ?? Bots.StingBot("jab", null, 240);
        }

        void Out(Sim sim, Link link, string dir)
        {
            beforeOut?.Invoke(sim, dir);
            foreach (var m in sim.outbox)
            {
                if (m is StateMsg sm)
                {
                    var bin = Wire.EncodeState(sm);
                    Num len = bin.Length + 28; // + UDP/IP headers
                    if (dir == "ab") { bytesAB += len; bytesABState += len; } else bytesBA += len;
                    link.Send(new BinMsg { bin = bin }, sim.tick);
                }
                else
                {
                    Num len = ((NetEv)m).ApproxJsonLength() + 28;
                    if (dir == "ab") { bytesAB += len; bytesABEvents += len; } else bytesBA += len;
                    link.Send(m, sim.tick);
                }
            }
            sim.outbox.Clear();
        }

        static List<Msg> In(List<Msg> msgs) => msgs.ConvertAll(m => m is BinMsg bm ? Wire.DecodeState(bm.bin) : m);

        /// Average upstream bandwidth of peer A (state packets + events), bytes per second
        public (Num total, Num state, Num events) Bandwidth() { Num secs = (Num)Math.Max(1, a.tick) / 60; return (bytesAB / secs, bytesABState / secs, bytesABEvents / secs); }

        public void Step(Cmd cmdA, Cmd cmdB = null)
        {
            int t = a.tick + 1;
            if (b == null)
            {
                a.Step(cmdA);
                a.outbox.Clear(); // nobody to send to yet
                if (a.tick >= joinAt) { var snap = Persist.Snapshot(a); joinBytes = snap.Length; b = Persist.JoinFrom(snap, 1, true); joined = a.tick; }
                return;
            }
            a.Receive(In(ba.Poll(t)));
            b.Receive(In(ab.Poll(t)));
            a.Step(cmdA);
            b.Step(cmdB ?? botB(b));
            Out(a, ab, "ab");
            Out(b, ba, "ba");
            bEvents = b.DrainEvents(); // kept for one step so tests and the lab can look
        }

        /// Compare the shared humans: both peers simulate the same union of interest, so they must agree everywhere.
        public bool? Check()
        {
            if (b == null) { checks.skipped++; return null; }
            checks.compared++;
            bool same = a.HumanHash() == b.HumanHash();
            if (same) checks.agreed++; else if (checks.firstDiverge == 0) checks.firstDiverge = a.tick;
            return same;
        }

        /// How far A's picture of B's wasp is from where B's wasp really is (GDD 11.4)
        public Num? RemoteError()
        {
            if (b == null) return null;
            var bw = b.Driven();
            if (bw == null) return null;
            var r = a.remote.Get(bw.id);
            if (r == null) return null;
            return Sqrt(Sq(r.x - bw.x) + Sq(r.y - bw.y) + Sq(r.z - bw.z));
        }
    }

    /// N peers over a full mesh of simulated links (GDD 11.11, personal worlds with friends). Peer 0 is the player and the
    /// host; the others are scripted. tamper(from, msg, sim) lets a test turn one peer into a cheater.
    public sealed class MeshLab
    {
        public readonly Sim[] sims;
        readonly Link[,] links;
        readonly Func<Sim, Cmd>[] bots;
        public Action<int, Msg, Sim> tamper;
        public readonly Checks checks = new Checks();

        public MeshLab(Settings settings, int n = 3, string linkName = "good")
        {
            var L = Link.Spec(linkName);
            var peers = new List<int>(); for (int p = 0; p < n; p++) peers.Add(p);
            sims = new Sim[n]; links = new Link[n, n]; bots = new Func<Sim, Cmd>[n];
            for (int p = 0; p < n; p++) sims[p] = new Sim(settings, new SimOpts { peer = p, net = true, noAI = p > 0, peers = peers });
            for (int i = 0; i < n; i++) for (int j = 0; j < n; j++) links[i, j] = i == j ? null : new Link(L, 100 + i * 10 + j);
            for (int p = 1; p < n; p++) bots[p] = Bots.StingBot("jab", null, 240 + p * 37);
        }

        public void Step(Cmd cmd0)
        {
            int t = sims[0].tick + 1, n = sims.Length;
            for (int j = 0; j < n; j++) for (int i = 0; i < n; i++) if (i != j) sims[j].Receive(links[i, j].Poll(t).ConvertAll(m => m is BinMsg bm ? Wire.DecodeState(bm.bin) : m));
            for (int i = 0; i < n; i++) sims[i].Step(i != 0 ? bots[i](sims[i]) : cmd0);
            for (int i = 0; i < n; i++)
            {
                var s = sims[i];
                foreach (var m in s.outbox)
                {
                    tamper?.Invoke(i, m, s);
                    for (int j = 0; j < n; j++) if (j != i) links[i, j].Send(m is StateMsg sm ? new BinMsg { bin = Wire.EncodeState(sm) } : m, s.tick);
                }
                s.outbox.Clear();
            }
        }

        /// Do these peers agree on every shared human?
        public bool Agree(params int[] peers)
        {
            checks.compared++;
            string h0 = sims[peers[0]].HumanHash();
            bool same = true;
            foreach (var p in peers) if (sims[p].HumanHash() != h0) same = false;
            if (same) checks.agreed++;
            return same;
        }
    }
}
