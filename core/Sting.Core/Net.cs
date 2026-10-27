// A simulated network between peers, and the two-peer and N-peer labs built on it (GDD 11). Port of poc/sim/net.js.
// Deterministic: delays and losses come from the counter hash, so lab runs replay exactly.
using System;
using System.Collections.Generic;
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    /// A packet on the unreliable channel: the encoded bytes and which kind (state, swarm, traffic)
    public sealed class BinMsg : Msg { public byte[] bin; public string kind = "state"; public BinMsg() { mk = "bin"; } }

    // ---------------------------------------------------------------- wire formats (GDD 11.12)
    // Positions are chunk-relative, 16 bits per axis (1 mm horizontally, 0.6 mm vertically); velocity 8 bits per axis.
    public static class Wire
    {
        static readonly string[] STATES = { "fly", "stunned", "attached", "under", "chewing", "trapped", "balled", "landed", "webbed", "fighting", "dead", "perched", "drowning", "robbing" };
        static readonly string[] CARRY = { null, "fly", "caterpillar", "bee", "pulp", "larva", "carrion", "meat", "bee brood", "bait" };
        static readonly Num CS = T.chunk.size, YMAX = 40, VMAX = 8;
        public const int BYTES_PER_WASP = 19, STATE_HEAD = 11, BYTES_PER_SWARM_WASP = 9, GROUP_HEAD = 9;

        static void U8(byte[] b, int o, int v) => b[o] = (byte)v;
        static void U16(byte[] b, int o, int v) { b[o] = (byte)(v >> 8); b[o + 1] = (byte)v; }
        static void U32(byte[] b, int o, uint v) { b[o] = (byte)(v >> 24); b[o + 1] = (byte)(v >> 16); b[o + 2] = (byte)(v >> 8); b[o + 3] = (byte)v; }
        static int R16(byte[] b, int o) => (b[o] << 8) | b[o + 1];
        static uint R32(byte[] b, int o) => ((uint)b[o] << 24) | ((uint)b[o + 1] << 16) | ((uint)b[o + 2] << 8) | b[o + 3];
        static int Q16(Num x, Num lo, Num hi) => (int)Max(0, Min(65535, Rnd((x - lo) / (hi - lo) * 65535)));
        static int Q8(Num x) => (int)Max(-127, Min(127, Rnd(x / VMAX * 127)));
        static Num D16(int x, Num lo, Num hi) => lo + (Num)x / 65535 * (hi - lo);

        /// a state packet (driven and near wasps): peer, tick, count, the sender's driven wasp, the wasps gone since the last one
        public static byte[] EncodeState(StateMsg m)
        {
            var b = new byte[STATE_HEAD + m.gone.Count * 4 + m.wasps.Count * BYTES_PER_WASP];
            U8(b, 0, m.peer); U32(b, 1, (uint)m.tick); U8(b, 5, m.wasps.Count); U32(b, 6, (uint)m.driven); U8(b, 10, m.gone.Count);
            int o = STATE_HEAD;
            foreach (var id in m.gone) { U32(b, o, (uint)id); o += 4; }
            foreach (var w in m.wasps)
            {
                int cx = World.ChunkOf(w.x), cz = World.ChunkOf(w.z);
                U32(b, o, (uint)w.id); U16(b, o + 4, (short)cx); U16(b, o + 6, (short)cz);
                U16(b, o + 8, Q16(w.x - cx * CS, -CS / 2, CS / 2)); U16(b, o + 10, Q16(w.y, 0, YMAX)); U16(b, o + 12, Q16(w.z - cz * CS, -CS / 2, CS / 2));
                b[o + 14] = (byte)(sbyte)Q8(w.vx); b[o + 15] = (byte)(sbyte)Q8(w.vy); b[o + 16] = (byte)(sbyte)Q8(w.vz);
                U8(b, o + 17, Math.Max(0, Array.IndexOf(STATES, w.state)) | (w.caste == "male" ? 64 : 0) | (w.caste == "gyne" ? 128 : 0)); // males and young queens (T2-3)
                U8(b, o + 18, (w.caste == "queen" ? 128 : 0) | (w.under != null ? 64 : 0) | (w.rival ? 32 : 0) | Math.Max(0, Array.IndexOf(CARRY, w.carry)));
                o += BYTES_PER_WASP;
            }
            return b;
        }

        public static StateMsg DecodeState(byte[] b, string underHex = null)
        {
            int n = b[5], ng = b[10];
            var m = new StateMsg { peer = b[0], tick = (int)R32(b, 1), driven = (int)R32(b, 6) };
            int o = STATE_HEAD;
            for (int i = 0; i < ng; i++) { m.gone.Add((int)R32(b, o)); o += 4; }
            for (int i = 0; i < n; i++)
            {
                int cx = (short)R16(b, o + 4), cz = (short)R16(b, o + 6), flags = b[o + 18];
                m.wasps.Add(new RemoteWasp
                {
                    id = (int)R32(b, o), x = cx * CS + D16(R16(b, o + 8), -CS / 2, CS / 2), y = D16(R16(b, o + 10), 0, YMAX), z = cz * CS + D16(R16(b, o + 12), -CS / 2, CS / 2),
                    vx = (Num)(sbyte)b[o + 14] / 127 * VMAX, vy = (Num)(sbyte)b[o + 15] / 127 * VMAX, vz = (Num)(sbyte)b[o + 16] / 127 * VMAX,
                    state = (b[o + 17] & 63) < STATES.Length ? STATES[b[o + 17] & 63] : null, caste = (flags & 128) != 0 ? "queen" : (b[o + 17] & 64) != 0 ? "male" : (b[o + 17] & 128) != 0 ? "gyne" : "worker",
                    under = (flags & 64) != 0 ? underHex ?? "yes" : null, rival = (flags & 32) != 0, carry = (flags & 31) < CARRY.Length ? CARRY[flags & 31] : null,
                });
                o += BYTES_PER_WASP;
            }
            return m;
        }

        sealed class Group { public int cx, cz, @base; public List<RemoteWasp> ws = new List<RemoteWasp>(); }
        static List<Group> SwarmGroups(List<RemoteWasp> wasps)
        {
            var groups = new List<Group>(); var byKey = new Dictionary<string, Group>();
            foreach (var w in wasps)
            {
                int cx = World.ChunkOf(w.x), cz = World.ChunkOf(w.z); string k = World.ChunkKey(cx, cz);
                if (!byKey.TryGetValue(k, out var g)) { g = new Group { cx = cx, cz = cz }; byKey[k] = g; groups.Add(g); }
                g.ws.Add(w);
            }
            var o = new List<Group>();
            foreach (var g in groups)
            {
                Stable.Sort(g.ws, (p, q) => p.id - q.id);
                Group cur = null;
                foreach (var w in g.ws)
                {
                    if (cur == null || w.id - cur.@base > 65535 || cur.ws.Count >= 255) { cur = new Group { cx = g.cx, cz = g.cz, @base = w.id }; o.Add(cur); }
                    cur.ws.Add(w);
                }
            }
            return o;
        }
        /// a swarm packet (mid tier): per chunk a header (cx, cz, base id, count), per wasp an id offset, position, state byte
        public static byte[] EncodeSwarm(SwarmMsg m)
        {
            var groups = SwarmGroups(m.wasps);
            var b = new byte[6 + groups.Count * GROUP_HEAD + m.wasps.Count * BYTES_PER_SWARM_WASP];
            U8(b, 0, m.peer); U32(b, 1, (uint)m.tick); U8(b, 5, groups.Count);
            int o = 6;
            foreach (var g in groups)
            {
                U16(b, o, (short)g.cx); U16(b, o + 2, (short)g.cz); U32(b, o + 4, (uint)g.@base); U8(b, o + 8, g.ws.Count); o += GROUP_HEAD;
                foreach (var w in g.ws)
                {
                    U16(b, o, w.id - g.@base);
                    U16(b, o + 2, Q16(w.x - g.cx * CS, -CS / 2, CS / 2)); U16(b, o + 4, Q16(w.y, 0, YMAX)); U16(b, o + 6, Q16(w.z - g.cz * CS, -CS / 2, CS / 2));
                    U8(b, o + 8, Math.Max(0, Array.IndexOf(STATES, w.state)) | (w.caste == "queen" ? 16 : 0) | (w.rival ? 32 : 0) | (w.caste == "male" ? 64 : 0) | (w.caste == "gyne" ? 128 : 0));
                    o += BYTES_PER_SWARM_WASP;
                }
            }
            return b;
        }
        public static SwarmMsg DecodeSwarm(byte[] b)
        {
            int ng = b[5];
            var m = new SwarmMsg { peer = b[0], tick = (int)R32(b, 1) };
            int o = 6;
            for (int gi = 0; gi < ng; gi++)
            {
                int cx = (short)R16(b, o), cz = (short)R16(b, o + 2), n = b[o + 8]; uint bs = R32(b, o + 4); o += GROUP_HEAD;
                for (int i = 0; i < n; i++)
                {
                    int s = b[o + 8];
                    m.wasps.Add(new RemoteWasp { id = (int)(bs + (uint)R16(b, o)), x = cx * CS + D16(R16(b, o + 2), -CS / 2, CS / 2), y = D16(R16(b, o + 4), 0, YMAX), z = cz * CS + D16(R16(b, o + 6), -CS / 2, CS / 2),
                        state = (s & 15) < STATES.Length ? STATES[s & 15] : null, caste = (s & 16) != 0 ? "queen" : (s & 64) != 0 ? "male" : (s & 128) != 0 ? "gyne" : "worker", rival = (s & 32) != 0 });
                    o += BYTES_PER_SWARM_WASP;
                }
            }
            return m;
        }
        /// a traffic packet (far tier): wasps out per chunk
        public static byte[] EncodeTraffic(TrafficMsg m)
        {
            var b = new byte[7 + m.chunks.Count * 6];
            U8(b, 0, m.peer); U32(b, 1, (uint)m.tick); U16(b, 5, m.chunks.Count);
            int o = 7;
            foreach (var kv in m.chunks)
            {
                var p = kv.Key.Split(','); U16(b, o, (short)int.Parse(p[0])); U16(b, o + 2, (short)int.Parse(p[1])); U16(b, o + 4, Math.Min(65535, kv.Value)); o += 6;
            }
            return b;
        }
        public static TrafficMsg DecodeTraffic(byte[] b)
        {
            int n = R16(b, 5); var m = new TrafficMsg { peer = b[0], tick = (int)R32(b, 1) };
            int o = 7;
            for (int i = 0; i < n; i++) { m.chunks.Add(new KeyValuePair<string, int>(World.ChunkKey((short)R16(b, o), (short)R16(b, o + 2)), R16(b, o + 4))); o += 6; }
            return m;
        }
        /// what goes on the wire for a message: bytes for the unreliable channel, the event itself otherwise
        public static Msg ToWire(Msg m) => m switch
        {
            StateMsg s => new BinMsg { kind = "state", bin = EncodeState(s) },
            SwarmMsg s => new BinMsg { kind = "swarm", bin = EncodeSwarm(s) },
            TrafficMsg s => new BinMsg { kind = "traffic", bin = EncodeTraffic(s) },
            _ => m,
        };
        public static Msg FromWire(Msg m) => m is BinMsg bm ? bm.kind switch { "swarm" => DecodeSwarm(bm.bin), "traffic" => DecodeTraffic(bm.bin), _ => DecodeState(bm.bin) } : m;
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
            ["over"] = new LinkSpec { name = "Well past the window", latency = 24, jitter = 6, loss = 0.1 }, // late events often: the corrections at work
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
            Msg copy = msg is BinMsg bm ? new BinMsg { bin = (byte[])bm.bin.Clone(), kind = bm.kind } : (Msg)((NetEv)msg).WireCopy();
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

    public sealed class Checks { public int compared, agreed, skipped, firstDiverge, lastDiverge; public bool last; }

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
        public Num bytesAB, bytesBA, bytesABState, bytesABSwarm, bytesABTraffic, bytesABEvents;
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
            int to = dir == "ab" ? 1 : 0;
            foreach (var m in sim.outbox)
            {
                if (m.to >= 0 && m.to != to) continue;
                var w = Wire.ToWire(m);
                Num len = (w is BinMsg bm ? bm.bin.Length : ((NetEv)m).ApproxJsonLength()) + 28; // + UDP/IP headers
                if (dir == "ab")
                {
                    bytesAB += len;
                    if (w is BinMsg b2) { if (b2.kind == "swarm") bytesABSwarm += len; else if (b2.kind == "traffic") bytesABTraffic += len; else bytesABState += len; }
                    else bytesABEvents += len;
                }
                else bytesBA += len;
                link.Send(w, sim.tick);
            }
            sim.outbox.Clear();
        }

        static List<Msg> In(List<Msg> msgs) => msgs.ConvertAll(Wire.FromWire);

        /// Average upstream bandwidth of peer A by channel, bytes per second
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
            if (same) checks.agreed++; else { if (checks.firstDiverge == 0) checks.firstDiverge = a.tick; checks.lastDiverge = a.tick; }
            checks.last = same;
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
            for (int j = 0; j < n; j++) for (int i = 0; i < n; i++) if (i != j) sims[j].Receive(links[i, j].Poll(t).ConvertAll(Wire.FromWire));
            for (int i = 0; i < n; i++) sims[i].Step(i != 0 ? bots[i](sims[i]) : cmd0);
            for (int i = 0; i < n; i++)
            {
                var s = sims[i];
                foreach (var m in s.outbox)
                {
                    tamper?.Invoke(i, m, s);
                    var w = Wire.ToWire(m);
                    for (int j = 0; j < n; j++) if (j != i && (m.to < 0 || m.to == j)) links[i, j].Send(w, s.tick);
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
