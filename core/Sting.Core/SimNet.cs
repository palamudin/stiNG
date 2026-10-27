// Networking (GDD 11): events, commit ticks, plausibility, remote wasps. Port of the networking part of sim.js.
using System.Collections.Generic;
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed partial class Sim
    {
        // Every change to shared world state is an event. Its immediate part (swats, sprays) runs as soon as a
        // peer has it; its human-state part (panic, flight, counters, alert points) commits on one agreed tick,
        // T.net.commitTicks after it happened, so every peer applies it identically (GDD 11.5).
        internal void Publish(NetEv ev)
        {
            ev.mk = "ev"; ev.peer = peer; ev.seq = ++evSeq; ev.tick = tick;
            ev.commit = tick + (ev.type == "fix" ? T.net.fixTicks : T.net.commitTicks);
            if (net) { outbox.Add(ev); netStats.sent++; }
            ApplyImmediate(ev);
            if (!IMMEDIATE.Contains(ev.type)) Schedule(ev);
        }

        void Schedule(NetEv ev)
        {
            static bool Before(NetEv a, NetEv b) => a.commit != b.commit ? a.commit < b.commit : a.peer != b.peer ? a.peer < b.peer : a.seq < b.seq;
            int i = pending.Count;
            while (i > 0 && Before(ev, pending[i - 1])) i--;
            pending.Insert(i, ev);
        }

        public void Receive(IEnumerable<Msg> msgs)
        {
            foreach (var m in msgs)
            {
                netStats.recv++;
                if (plaus.quarantined.Contains(m.peer)) { netStats.dropped++; continue; }
                if (m is StateMsg sm) { RemoteState(sm); continue; }
                if (m is SwarmMsg wm) { RemoteSwarm(wm); continue; }
                if (m is TrafficMsg tm) { remoteTraffic.Set(tm.peer, tm); continue; }
                var ev = (NetEv)m;
                string why = Implausible(ev);
                if (why != null) { Strike(ev.peer, ev.type, why); continue; }
                ApplyImmediate(ev);
                if (IMMEDIATE.Contains(ev.type)) continue;
                // this tick's commits are already applied, so an event committing on it now is late too (applied next tick)
                if (ev.commit <= tick)
                {
                    int by = tick + 1 - ev.commit;
                    netStats.late++; netStats.lateMax = Max(netStats.lateMax, by);
                    if (netStats.firstLate == 0) netStats.firstLate = tick;
                    Emit("lateEvent", ("evType", ev.type), ("by", by));
                    // the chunk's authority sets its humans right for everyone (GDD 11.6)
                    string key = EvChunk(ev);
                    if (key != null) { if (ChunkAuthority(key) == peer) OwesFix(key); else Publish(new NetEv { type = "fixReq", key = key }); }
                }
                Schedule(ev);
            }
        }

        void ApplyPending()
        {
            while (pending.Count > 0 && pending[0].commit <= tick) { var e = pending[0]; pending.RemoveAt(0); ApplyCommit(e); }
        }

        /// State to each other peer by relevance tier (GDD 11.12, T1-21), judged from where that peer's wasp is
        void SendState()
        {
            int t = tick;
            bool dueD = t % T.net.stateEvery == 0, dueN = t % T.relevance.nearEvery == 0, dueM = t % T.relevance.midEvery == 0, dueF = t % T.relevance.farEvery == 0;
            if (!dueD && !dueN && !dueM && !dueF) return;
            RemoteWasp Pack(Wasp w) => new RemoteWasp
            {
                id = w.id, caste = w.caste, x = w.x, y = w.y, z = w.z, vx = w.vx, vy = w.vy, vz = w.vz, state = w.state,
                carry = w.carry?.what, under = w.under?.hex, rival = IsRival(w),
            };
            // wasps gone since the last state packets, so receivers drop them at once
            var gone = new List<int>();
            if (dueD)
            {
                var now = new HashSet<int>(); foreach (var w in wasps) now.Add(w.id);
                foreach (var id in lastIds) if (!now.Contains(id)) gone.Add(id);
                lastIds = wasps.ConvertAll(w => w.id);
            }
            int driven = Driven() != null ? drivenId : 0;
            foreach (var kv in interest)
            {
                int p = kv.Key;
                if (p == peer || plaus.quarantined.Contains(p)) continue;
                var (rx, rz) = PeerRef(p); int rcx = World.ChunkOf(rx), rcz = World.ChunkOf(rz);
                var near = new List<RemoteWasp>(); var mid = new List<RemoteWasp>(); var far = new OrderedMap<string, int>();
                foreach (var w in wasps)
                {
                    if (w.id == drivenId) { if (dueD) near.Add(Pack(w)); continue; }
                    if (Sq(w.x - rx) + Sq(w.z - rz) <= T.relevance.nearDist * T.relevance.nearDist) { if (dueN) near.Add(Pack(w)); }
                    else if (System.Math.Max(System.Math.Abs(World.ChunkOf(w.x) - rcx), System.Math.Abs(World.ChunkOf(w.z) - rcz)) <= T.relevance.interestChunks) { if (dueM) mid.Add(Pack(w)); }
                    else if (dueF) { string k = World.ChunkKey(World.ChunkOf(w.x), World.ChunkOf(w.z)); far.Set(k, far.Get(k) + 1); }
                }
                if (dueD || near.Count > 0) outbox.Add(new StateMsg { peer = peer, to = p, tick = t, driven = driven, gone = gone, wasps = near });
                if (mid.Count > 0) outbox.Add(new SwarmMsg { peer = peer, to = p, tick = t, wasps = mid });
                if (dueF) outbox.Add(new TrafficMsg { peer = peer, to = p, tick = t, chunks = far.Snapshot() });
            }
        }
        /// where a peer is: its driven wasp as last heard, or the middle of the chunk it has interest in
        internal (Num x, Num z) PeerRef(int p)
        {
            if (remoteDriven.TryGet(p, out int id) && remote.TryGet(id, out var r) && r.peer == p) return (r.x, r.z);
            var parts = (interest.Get(p) ?? "0,0").Split(',');
            return (int.Parse(parts[0]) * T.chunk.size, int.Parse(parts[1]) * T.chunk.size);
        }

        // GDD 11.8. Checks on events read only the event and shared human state, so every honest peer drops the same ones.
        internal string Implausible(NetEv ev)
        {
            plaus.lastSeq.TryGetValue(ev.peer, out int last);
            if (ev.commit != ev.tick + (ev.type == "fix" ? T.net.fixTicks : T.net.commitTicks)) return "commit tick";
            if (ev.seq <= last) return "replayed or out of order";
            plaus.lastSeq[ev.peer] = ev.seq;
            if (ev.tick > tick + T.plaus.futureTicks) return "from the future";
            if (ev.type == "quarantine" && ev.peer != host) return "only the host rules on peers";
            if (ev.type == "startle" && !(ev.amount > 0 && ev.amount <= T.swoop.panic)) return "startle out of range";
            if (ev.type == "praid") // from that nest's entrance, as its owner or anyone who has heard where it is knows
            {
                V3? n = ev.toPeer == peer ? nest.entrance : peerNests.TryGetValue(ev.toPeer, out var pn) ? new V3(pn.x, pn.y, pn.z) : (V3?)null;
                if (n != null && Sq(ev.x - n.Value.x) + Sq(ev.y - n.Value.y) + Sq(ev.z - n.Value.z) > T.plaus.pickupReach * T.plaus.pickupReach) return "raided from out of reach";
            }
            if (ev.type == "sting" || ev.type == "notice" || ev.type == "press" || ev.type == "preSwat")
            {
                var hm = HumanByHex(ev.humanHex);
                var sw = ev.swats ?? (ev.type == "preSwat" ? new List<Swat> { new Swat { start = ev.start } } : new List<Swat>());
                if (sw.Count > T.plaus.maxSwats) return "too many swats";
                foreach (var s in sw) if (s.start - ev.tick < (ev.type == "sting" ? T.resolve.minConsequenceTicks : 0) || s.start - ev.tick > T.plaus.maxSwatDelay) return "swat timing";
                if (ev.type == "sting")
                {
                    if (!(ev.panicGain >= 0 && ev.panicGain <= 1)) return "panic out of range";
                    if (hm != null)
                    {
                        Num drift = T.plaus.humanDrift * Max(0, tick - ev.tick) / 60;
                        if (Sqrt(Sq(ev.sx - hm.x) + Sq(ev.sz - hm.z)) > T.plaus.stingReach + drift) return "stung from out of reach";
                    }
                    string k = ev.peer + ":" + ev.waspId;
                    var ts = new List<int>();
                    if (plaus.stingTicks.TryGetValue(k, out var old)) foreach (var t in old) if (t > ev.tick - T.plaus.rateWindow) ts.Add(t);
                    ts.Add(ev.tick); plaus.stingTicks[k] = ts;
                    if (ts.Count > T.plaus.rateMax) return "stinging faster than venom allows";
                }
            }
            // T1-20: what a wasp takes must be where it says, it must not be inside anything solid, and it carries one load
            var held = plaus.held;
            if (ev.type == "claim" || (ev.type == "caught" && ev.claimPeer < 0))
            {
                string why = PickupCause(ev);
                if (why != null) return why;
                string k = ev.peer + ":" + ev.waspId;
                if (held.ContainsKey(k)) return "already carrying";
                held[k] = 1;
            }
            else if (ev.type == "sip") return SipCause(ev);
            else if (ev.type == "drop" || ev.type == "died") held.Remove(ev.peer + ":" + ev.waspId);
            else if (ev.type == "denied") held.Remove(ev.claimPeer + ":" + ev.claimWasp);
            return null;
        }

        /// A wasp carries one load (GDD 11.8, T1-20): when one of ours lets go of a load the other peers saw it pick up, say so
        void DropSweep()
        {
            foreach (var w in wasps) if (w.pubLoad && w.carry == null) { w.pubLoad = false; Publish(new NetEv { type = "drop", waspId = w.id }); }
        }
        // the world as frozen chunks hold it, for chunks this peer may not have discovered (see sim.js _plausRec)
        readonly Dictionary<string, ChunkRec> plausCache = new Dictionary<string, ChunkRec>();
        internal ChunkRec PlausRec(int cx, int cz)
        {
            string key = KeyOf(cx, cz);
            if (records.TryGet(key, out var rec)) return rec;
            if (!plausCache.TryGetValue(key, out var r)) { if (plausCache.Count > 32) plausCache.Clear(); plausCache[key] = r = new ChunkRec { cx = cx, cz = cz, content = Content(cx, cz) }; }
            return r;
        }
        /// A position deep inside something solid (a house, shed, table, trunk, grill) or under the ground
        internal bool InSolid(Num x, Num y, Num z)
        {
            Num D = T.plaus.solidDepth;
            if (y < -D) return true;
            var rec = PlausRec(World.ChunkOf(x), World.ChunkOf(z));
            foreach (var b in rec.content.boxes)
            {
                if (b.hive) continue; // a wasp robs a bee box from its entrance
                if (x > b.minx + D && x < b.maxx - D && y > b.miny + D && y < b.maxy - D && z > b.minz + D && z < b.maxz - D) return true;
            }
            foreach (var cy in CylsOf(rec)) if (cy.r > D && y < cy.h - D && Sq(x - cy.x) + Sq(z - cy.z) < Sq(cy.r - D)) return true;
            foreach (var f in RoofsOf(rec)) { var r = RoofLocal(f, x, y, z); if (Abs(r.v) < f.half - D && r.y > D && (f.rise * (Abs(r.u) - f.S) + f.S * r.y) / f.L < -D) return true; }
            return false;
        }
        /// A straight move from a to b through a thin box (a fence, a table top, a bench seat) well inside its face, which the
        /// solid check's margin cannot see; the margin from the face's edges is half the distance a wasp can fly in the time
        /// between the two positions, so an honest turn round the end of a fence or over its top is never taken for one
        internal bool ThroughThin(V3 a, V3 b, Num dt)
        {
            Num D = T.plaus.solidDepth, M = Max(D, T.plaus.maxSpeed * dt / 2);
            var A = new[] { a.x, a.y, a.z }; var B = new[] { b.x, b.y, b.z };
            var ra = PlausRec(World.ChunkOf(a.x), World.ChunkOf(a.z)); var rb = PlausRec(World.ChunkOf(b.x), World.ChunkOf(b.z));
            foreach (var rec in ra == rb ? new[] { ra } : new[] { ra, rb })
                foreach (var bx in rec.content.boxes)
                {
                    var lo = new[] { bx.minx, bx.miny, bx.minz }; var hi = new[] { bx.maxx, bx.maxy, bx.maxz };
                    int k = 0;
                    for (int i = 1; i < 3; i++) if (hi[i] - lo[i] < hi[k] - lo[k]) k = i;
                    if (hi[k] - lo[k] > 2 * D) continue; // thicker ones the solid check sees
                    if (!((A[k] < lo[k] && B[k] > hi[k]) || (B[k] < lo[k] && A[k] > hi[k]))) continue;
                    Num t = ((lo[k] + hi[k]) / 2 - A[k]) / (B[k] - A[k]);
                    bool inside = true;
                    for (int i = 0; i < 3; i++) if (i != k) { Num q = A[i] + (B[i] - A[i]) * t; if (q < lo[i] + M || q > hi[i] - M) inside = false; }
                    if (inside) return true;
                }
            return false;
        }
        static bool ParseKey(string key, out int cx, out int cz)
        {
            cx = cz = 0;
            if (key == null) return false;
            var p = key.Split(',');
            return p.Length == 2 && int.TryParse(p[0], out cx) && int.TryParse(p[1], out cz);
        }
        /// Was the thing taken there, at that tick, within reach of where the wasp says it was? Null if so, else why not.
        internal int plausPickups, plausSips; // how many were checked (tests only; never saved or hashed)
        string PickupCause(NetEv ev)
        {
            plausPickups++;
            if (!ParseKey(ev.key, out int cx, out int cz)) return "no such thing";
            var rec = PlausRec(cx, cz); var c = rec.content; Num R = T.plaus.pickupReach; int i = ev.i;
            V3? at = null;
            switch (ev.what)
            {
                case "fly": if (i >= 0 && i < c.flies.Count) at = World.FlyPos(c.flies[i], ev.tick); break;
                case "caterpillar": if (i >= 0 && i < c.caterpillars.Count) { var q = c.caterpillars[i]; at = new V3(q.x, q.y, q.z); } break;
                case "carrion": if (i <= day && i >= day - T.eco.carrionDays) at = CarrionSpot(cx, cz, i); break;
                case "meat":
                {
                    if (i < 0) break;
                    foreach (var g in GrillsIn(rec)) if (g.ti == i / 2) { at = i % 2 != 0 ? new V3(g.px, 0.77, g.pz) : new V3(g.x, T.bbq.grateY + 0.025, g.z); break; }
                    break;
                }
                case "bee":
                {
                    var hs = HivesIn(rec);
                    if (ev.hive >= 0 && ev.hive < hs.Count && i >= 0 && i < hs[ev.hive].bees.Count) at = World.BeePos(hs[ev.hive], i, ev.tick);
                    break;
                }
                case "honey": { var hs = HivesIn(rec); if (i >= 0 && i < hs.Count) at = new V3(hs[i].ex, hs[i].ey, hs[i].ez); break; }
                case "pulp":
                {
                    if (i < 0 || i >= c.boxes.Count) break;
                    var b = c.boxes[i];
                    if (b.wood && !b.hive) at = new V3(Clamp(ev.x, b.minx, b.maxx), Clamp(ev.y, b.miny, b.maxy), Clamp(ev.z, b.minz, b.maxz));
                    break;
                }
                default: return "no such thing";
            }
            if (at == null) return "no such thing";
            var a = at.Value;
            if (Sq(ev.x - a.x) + Sq(ev.y - a.y) + Sq(ev.z - a.z) > R * R) return "taken from out of reach";
            if (InSolid(ev.x, ev.y, ev.z)) return "inside something solid";
            return null;
        }
        /// A sip from a flower: a flower that is there, within reach, a sip's worth, at a rate one wasp can drink
        string SipCause(NetEv ev)
        {
            plausSips++;
            if (!ParseKey(ev.key, out int cx, out int cz)) return "no such flower";
            var fl = PlausRec(cx, cz).content.flowers;
            if (ev.i < 0 || ev.i >= fl.Count) return "no such flower";
            var f = fl[ev.i];
            if (!(ev.amount > 0 && ev.amount <= T.plaus.sipMax)) return "sip out of range";
            if (Sq(ev.x - f.x) + Sq(ev.y - f.y) + Sq(ev.z - f.z) > T.plaus.pickupReach * T.plaus.pickupReach) return "sipped from out of reach";
            if (InSolid(ev.x, ev.y, ev.z)) return "inside something solid";
            string k = ev.peer + ":" + ev.waspId;
            var list = new List<SipRec>();
            if (plaus.sips.TryGetValue(k, out var old)) foreach (var s in old) if (s.t > ev.tick - T.plaus.rateWindow) list.Add(s);
            list.Add(new SipRec { t = ev.tick, amount = ev.amount }); plaus.sips[k] = list;
            Num sum = 0; foreach (var s in list) sum += s.amount;
            if (sum > T.eco.sipPerSec * T.plaus.rateWindow / 60 + T.plaus.sipMax) return "drinking faster than a wasp can";
            return null;
        }

        // Every peer drops implausible events the same way, but only the host rules on a peer: it publishes the verdict as
        // a committed event, so every peer cuts the cheater off on the same tick and purges the same pending events.
        void Strike(int p, string type, string why)
        {
            netStats.rejected++;
            plaus.strikes.TryGetValue(p, out int n); n++;
            plaus.strikes[p] = n;
            Emit("implausible", ("peer", p), ("evType", type), ("why", why), ("strikes", n));
            if (n < T.plaus.strikes || plaus.quarantined.Contains(p) || plaus.ruled.Contains(p)) return;
            if (!net) { Quarantine(p); return; }
            if (peer != host) return;
            plaus.ruled.Add(p);
            Publish(new NetEv { type = "quarantine", target = p, why = why });
        }

        void Quarantine(int p)
        {
            if (plaus.quarantined.Contains(p)) return;
            plaus.quarantined.Add(p);
            foreach (var kv in remote) if (kv.Value.peer == p) remote.Delete(kv.Key);
            // whatever it sent that has not committed yet is void on every peer alike
            pending = pending.FindAll(e => e.peer != p);
            interest.Delete(p);
            Emit("quarantine", ("peer", p), ("me", p == peer));
        }

        void RemoteState(StateMsg m)
        {
            var ids = new HashSet<int>();
            foreach (var r in m.wasps)
            {
                var prev = remote.Get(r.id);
                // display only: a wasp that moved faster than any wasp can is not drawn there (local, so it cannot desync)
                if (prev != null && prev.peer == m.peer && m.tick > prev.stamp)
                {
                    Num v = Sqrt(Sq(r.x - prev.px) + Sq(r.y - prev.py) + Sq(r.z - prev.pz)) / ((Num)(m.tick - prev.stamp) / 60);
                    if (v > T.plaus.maxSpeed && (prev.bad = prev.bad + 1) < 4) { netStats.dropped++; ids.Add(r.id); prev.seen = tick; continue; }
                    prev.bad = 0;
                }
                // display only, like speed: a player's own wasp is never inside a wall or the ground (T1-20)
                if (r.id == m.driven && InSolid(r.x, r.y, r.z)) { netStats.dropped++; ids.Add(r.id); if (prev != null) prev.seen = tick; continue; }
                // nor does it go through a fence or a table top between two packets, which is too thin for that margin
                if (r.id == m.driven && prev != null && prev.peer == m.peer && m.tick > prev.stamp && ThroughThin(new V3(prev.px, prev.py, prev.pz), new V3(r.x, r.y, r.z), (Num)(m.tick - prev.stamp) / 60)) { netStats.dropped++; ids.Add(r.id); prev.seen = tick; continue; }
                ids.Add(r.id);
                var e = remote.Get(r.id) ?? new RemoteWasp();
                e.id = r.id; e.caste = r.caste; e.x = r.x; e.y = r.y; e.z = r.z; e.vx = r.vx; e.vy = r.vy; e.vz = r.vz; e.state = r.state;
                e.carry = r.carry; e.under = r.under; e.rival = r.rival;
                e.peer = m.peer; e.stamp = m.tick; e.px = r.x; e.py = r.y; e.pz = r.z; e.seen = tick; e.ttl = T.net.remoteTimeout;
                remote.Set(r.id, e);
            }
            // a wasp missing from a packet may just be in another tier now (T1-21); gone ones are listed
            if (m.driven != 0) remoteDriven.Set(m.peer, m.driven);
            foreach (var id in m.gone) { var e = remote.Get(id); if (e != null && e.peer == m.peer) remote.Delete(id); }
        }

        /// Mid-tier wasps: position and state at a few hertz; velocity from the last two positions, for drawing in between
        void RemoteSwarm(SwarmMsg m)
        {
            foreach (var r in m.wasps)
            {
                var prev = remote.Get(r.id);
                Num vx = 0, vy = 0, vz = 0;
                if (prev != null && prev.peer == m.peer && m.tick > prev.stamp)
                {
                    Num dt = (Num)(m.tick - prev.stamp) / 60;
                    vx = (r.x - prev.px) / dt; vy = (r.y - prev.py) / dt; vz = (r.z - prev.pz) / dt;
                    if (Sqrt(vx * vx + vy * vy + vz * vz) > T.plaus.maxSpeed && (prev.bad = prev.bad + 1) < 4) { netStats.dropped++; prev.seen = tick; continue; }
                    prev.bad = 0;
                    if (dt > 1) vx = vy = vz = 0;
                }
                else if (prev != null && prev.peer == m.peer) continue; // older than what we have
                var e = prev ?? new RemoteWasp();
                e.id = r.id; e.caste = r.caste; e.x = r.x; e.y = r.y; e.z = r.z; e.vx = vx; e.vy = vy; e.vz = vz; e.state = r.state;
                e.carry = prev?.carry; e.under = null; e.rival = r.rival;
                e.peer = m.peer; e.stamp = m.tick; e.px = r.x; e.py = r.y; e.pz = r.z; e.seen = tick; e.ttl = T.relevance.midTtl;
                remote.Set(r.id, e);
            }
        }

        // Remote wasps are drawn where they probably are now: last state plus velocity (GDD 11.4)
        void ExtrapolateRemote()
        {
            foreach (var kv in remote)
            {
                var e = kv.Value;
                if (tick - e.seen > (e.ttl > 0 ? e.ttl : T.net.remoteTimeout)) { remote.Delete(kv.Key); continue; }
                Num dt = (Num)(tick - e.stamp) / 60;
                bool moving = e.state == "fly" || e.state == "stunned";
                e.x = e.px + (moving ? e.vx * dt : 0); e.y = Max(T.wasp.radius, e.py + (moving ? e.vy * dt : 0)); e.z = e.pz + (moving ? e.vz * dt : 0);
            }
        }

        WaspBase AnyWasp(int id) => (WaspBase)WaspById(id) ?? remote.Get(id);

        Swat FromEv(Swat s, string actorHex, string frameHex, string stungHex, Num contactTick, int underOnly, int byWasp, bool pre, string why)
        {
            var c = s.Clone();
            if (actorHex != null) c.actorHex = actorHex;
            c.frameHex = frameHex; c.stungHex = stungHex; c.contactTick = contactTick; c.hits = new List<int>(); c.underOnly = underOnly; c.byWasp = byWasp; c.why = why;
            if (pre) c.pre = true;
            return c;
        }

        // ---------------- another player's nest (colony against colony); see sim.js

        public readonly Dictionary<int, PeerNest> peerNests = new Dictionary<int, PeerNest>();
        string nestSig = ""; int nestSentTick = -1000000000;
        /// every peer says where its nest is when it moves or dies, and every ten seconds so a peer that joins hears it
        void ShareNest()
        {
            var e = nest.entrance; bool alive = colony.sited && colony.nestAlive;
            string sig = e.x + "," + e.y + "," + e.z + "," + alive;
            if (sig == nestSig && tick - nestSentTick < 600) return;
            nestSig = sig; nestSentTick = tick;
            Publish(new NetEv { type = "nest", x = e.x, y = e.y, z = e.z, key = nest.key, alive = alive });
        }
        /// another player's live nest at the wasp, not where its own is (players can share the home tree)
        internal (int peer, PeerNest n)? PeerNestNear(Wasp w)
        {
            var own = nest.entrance;
            foreach (var kv in peerNests)
            {
                var n = kv.Value;
                if (!n.alive || plaus.quarantined.Contains(kv.Key) || Sq(n.x - own.x) + Sq(n.y - own.y) + Sq(n.z - own.z) < 0.3 * 0.3) continue;
                if (Sq(w.x - n.x) + Sq(w.y - n.y) + Sq(w.z - n.z) < 0.08 * 0.08) return (kv.Key, n);
            }
            return null;
        }
        /// steal a larva from it, as from a rival's nest: its owner loses one and sends its guards after the thief
        void RaidPeer(Wasp w, int toPeer)
        {
            w.carry = new Carry { kind = "protein", amount = T.rival.raidProtein, what = "larva" };
            Publish(new NetEv { type = "praid", toPeer = toPeer, waspId = w.id, x = w.x, y = w.y, z = w.z });
            Emit("raid", ("id", w.id), ("peer", toPeer));
        }

        // ---------------- late-event corrections (GDD 11.6); see sim.js

        readonly List<string> fixDue = new List<string>(); readonly Dictionary<string, int> fixLast = new Dictionary<string, int>();
        /// the chunk an event's consequences land in: its human's, or the chunk it names
        string EvChunk(NetEv ev)
        {
            if (ev.humanHex != null) { var hm = HumanByHex(ev.humanHex); if (hm != null && !hm.special) return hm.chunk; }
            return ev.key != null && System.Text.RegularExpressions.Regex.IsMatch(ev.key, @"^-?\d+,-?\d+$") ? ev.key : null;
        }
        void OwesFix(string key) { if (!fixDue.Contains(key)) fixDue.Add(key); }
        /// as a chunk's authority, publish its humans and its shared state as they are now; every peer, this one too, takes
        /// them as they stand when the correction commits; at most one per chunk per fixEvery ticks
        void SendFixes()
        {
            if (fixDue.Count == 0) return;
            var keep = new List<string>();
            foreach (var key in fixDue)
            {
                if (ChunkAuthority(key) != peer) continue;
                if (fixLast.TryGetValue(key, out int l) && tick < l + T.net.fixEvery) { keep.Add(key); continue; }
                fixLast[key] = tick;
                var hs = new List<(string, byte[])>();
                foreach (var hm in active) if (!hm.special && hm.chunk == key) hs.Add((hm.hex, Persist.HumanBytes(hm)));
                chunkState.TryGet(key, out var st);
                Publish(new NetEv { type = "fix", key = key, fixHumans = hs, fixChunk = st != null ? Persist.ChunkBytes(st) : null });
                netStats.fixes++;
                Emit("fixSent", ("key", key), ("humans", hs.Count));
            }
            fixDue.Clear(); fixDue.AddRange(keep);
        }
        void ApplyFix(NetEv ev)
        {
            if (ChunkAuthority(ev.key) != ev.peer) return; // only the chunk's authority sets it right
            foreach (var (hex, s) in ev.fixHumans) { var hm = HumanByHex(hex); if (hm != null) Persist.HumanFromBytes(hm, s); }
            if (ev.fixChunk != null) chunkState.Set(ev.key, Persist.ChunkFromBytes(ev.fixChunk)); else chunkState.Delete(ev.key);
            netStats.fixed_++;
            Emit("fixed", ("key", ev.key), ("humans", ev.fixHumans.Count), ("from", ev.peer));
        }

        void ApplyImmediate(NetEv ev)
        {
            bool mine = ev.peer == peer;
            switch (ev.type)
            {
                case "fixReq": if (ChunkAuthority(ev.key) == peer) OwesFix(ev.key); break;
                case "nest": if (!mine) peerNests[ev.peer] = new PeerNest { x = ev.x, y = ev.y, z = ev.z, key = ev.key, alive = ev.alive }; break;
                case "praid": // another player's wasp took a larva from my nest: one fewer, and my guards go after it
                    if (mine || ev.toPeer != peer || !colony.nestAlive) break;
                    colony.larvae = Max(0, colony.larvae - 1);
                    foreach (var g in Own()) if (g.role == "guard" && g.state == "fly") { g.ai.mode = "hunt"; g.ai.huntId = ev.waspId; g.ai.timer = tick + T.guard.huntTicks; }
                    Emit("raided", ("by", ev.peer), ("waspId", ev.waspId));
                    break;
                case "sting":
                {
                    var hm = HumanByHex(ev.humanHex);
                    if (hm == null) break;
                    foreach (var s in ev.swats) swats.Add(FromEv(s, null, hm.hex, hm.hex, ev.tick, ev.under ? ev.waspId : 0, ev.waspId, false, ev.under ? "stungUnder" : "stung"));
                    if (!mine) Emit("remoteSting", ("waspId", ev.waspId), ("humanHex", hm.hex), ("zone", ev.zone), ("contactTick", ev.tick), ("under", ev.under), ("swats", ev.swats));
                    break;
                }
                case "preSwat":
                {
                    var hm = HumanByHex(ev.humanHex);
                    if (hm == null) break;
                    swats.Add(new Swat
                    {
                        actorId = hm.id, actorHex = hm.hex, frameHex = hm.hex, stungHex = hm.hex, kind = ev.kind, start = ev.start, window = ev.window,
                        center = ev.center, radius = ev.radius, kills = ev.kills, contactTick = ev.tick, pre = true, targetId = ev.waspId, underOnly = 0, why = ev.why,
                    });
                    if (mine) hm.cooldown = Max(hm.cooldown, ev.tick + T.esc.cooldownTicks);
                    Emit("preSwat", ("humanHex", hm.hex), ("waspId", ev.waspId), ("kind", ev.kind), ("start", ev.start), ("window", ev.window), ("center", ev.center), ("why", ev.why), ("contactTick", ev.tick));
                    break;
                }
                case "press":
                {
                    var hm = HumanByHex(ev.humanHex);
                    if (hm == null) break;
                    foreach (var s in ev.swats) swats.Add(FromEv(s, hm.hex, hm.hex, hm.hex, ev.tick, ev.waspId, ev.waspId, false, "felt under clothing"));
                    Emit("press", ("humanHex", hm.hex), ("start", ev.swats[0].start), ("center", ev.swats[0].center), ("contactTick", ev.tick));
                    break;
                }
                case "spray":
                    sprays.Add(new Spray { hex = ev.humanHex, start = ev.start, end = ev.end });
                    Emit("spray", ("humanHex", ev.humanHex));
                    break;
                case "notice":
                {
                    var hm = HumanByHex(ev.humanHex);
                    if (hm == null) break;
                    foreach (var s in ev.swats) swats.Add(FromEv(s, null, hm.hex, hm.hex, ev.tick, 0, ev.waspId, true, "felt"));
                    Emit("notice", ("humanHex", hm.hex), ("waspId", ev.waspId), ("zone", ev.zone), ("swats", ev.swats), ("contactTick", ev.tick));
                    break;
                }
                // Fights between a rival (owned by the world-authority peer) and another peer's wasp (GDD 9.3, 11.6).
                // Each peer decides only about its own wasp; both compute the same winner from published values.
                case "fight":
                {
                    if (mine || ev.toPeer != peer) break;
                    var w = WaspById(ev.b);
                    if (w != null && (w.state == "fly" || w.state == "landed" || w.state == "chewing"))
                    {
                        w.state = "fighting"; w.vx = w.vy = w.vz = 0;
                        w.fight = new Fight { other = ev.a, remote = true, peer = ev.peer, start = ev.tick, until = tick + T.rival.fightTicks, mash = 0, theirVenom = ev.venom, theirQueen = ev.queen, myVenom = w.venom };
                        Publish(new NetEv { type = "fightJoin", a = ev.a, b = ev.b, toPeer = ev.peer, venom = w.venom, queen = w.caste == "queen" });
                        Emit("fight", ("a", ev.a), ("b", ev.b), ("driven", w.id == drivenId), ("remote", true));
                    }
                    else Publish(new NetEv { type = "fightRefuse", a = ev.a, b = ev.b, toPeer = ev.peer });
                    break;
                }
                case "raid": // another player robbed a rival nest whose workers live on this peer: send them after the thief
                    if (!mine) RivalsHunt(ev.key, ev.id, new V3(ev.x, ev.y, ev.z));
                    break;
                case "fightReq":
                {
                    // another peer's wasp touched one of my rivals on its own screen: start the fight if the rival is free
                    if (mine || ev.toPeer != peer) break;
                    var a = WaspById(ev.a);
                    if (a != null && IsRival(a) && (a.state == "fly" || a.state == "landed" || a.state == "chewing")) StartRemoteFight(a, ev.b, ev.peer);
                    break;
                }
                case "fightJoin":
                {
                    if (mine || ev.toPeer != peer) break;
                    var w = WaspById(ev.a);
                    if (w != null && w.fight != null && w.fight.other == ev.b) { w.fight.theirVenom = ev.venom; w.fight.theirQueen = ev.queen; }
                    break;
                }
                case "fightRefuse":
                {
                    if (mine || ev.toPeer != peer) break;
                    var w = WaspById(ev.a);
                    if (w != null && w.fight != null && w.fight.other == ev.b) { w.state = "fly"; w.fight = null; }
                    break;
                }
                case "fightEnd":
                {
                    if (mine || ev.toPeer != peer) break;
                    var w = WaspById(ev.a);
                    if (w == null || w.fight == null || w.fight.other != ev.b) break;
                    var f = w.fight;
                    bool aWins = FightScore(w.id, f.myVenom, w.caste == "queen", 0, f.start) >= FightScore(ev.b, ev.venom, ev.queen, ev.mash, f.start);
                    FightResolve(w, aWins, ev.b);
                    break;
                }
                case "claim": // a pickup in a chunk this peer rules on (T1-19)
                    if (!mine && ev.auth == peer) Rule(ev);
                    break;
                case "denied":
                    if (!mine && ev.claimPeer == peer) Denied(ev);
                    break;
                case "caught":
                {
                    if (mine) break;
                    if (ev.claimPeer == peer) { claims.Delete(ev.claimWasp); break; } // our own claim, granted: applied already
                    var st = CS(ev.key);
                    if (ev.what == "fly") st.caughtFly[ev.i] = (ev.ctick ?? ev.tick) + T.prey.flyRespawnTicks;
                    else if (ev.what == "caterpillar") st.caughtCat[ev.i] = 1;
                    else if (ev.what == "carrion") { st.carrion ??= new Dictionary<int, int>(); st.carrion[ev.i] = (st.carrion.TryGetValue(ev.i, out var cn) ? cn : 0) + 1; }
                    else if (ev.what == "meat") { st.meat ??= new Dictionary<int, int>(); st.meat[ev.i] = (st.meat.TryGetValue(ev.i, out var mn) ? mn : 0) + 1; }
                    else if (ev.what == "pulp") { st.pulp ??= new Dictionary<int, int>(); st.pulp[ev.i] = (st.pulp.TryGetValue(ev.i, out var pn) ? pn : 0) + 1; }
                    else if (ev.what == "honey") { st.robbed ??= new Dictionary<int, int>(); st.robbed[ev.i] = (st.robbed.TryGetValue(ev.i, out var rn) ? rn : 0) + 1; }
                    else { if (!st.beeLost.TryGetValue(ev.hive, out var l)) st.beeLost[ev.hive] = l = new Dictionary<int, int>(); l[ev.i] = 1; }
                    break;
                }
                case "sip": // another player's wasp drank from a flower (T1-8)
                    if (!mine && records.TryGet(ev.key, out _)) Sip(ev.key, ev.i, ev.amount);
                    break;
                case "beeAlarm":
                {
                    if (mine || !records.Has(ev.key)) break;
                    var t = remote.Get(ev.target);
                    if (t != null) AlarmHive(ev.key, ev.h, t, ev.radius, true);
                    break;
                }
                case "died":
                    if (!mine) { remote.Delete(ev.waspId); Emit("remoteDied", ("waspId", ev.waspId), ("cause", ev.cause), ("x", ev.x), ("y", ev.y), ("z", ev.z)); }
                    break;
            }
        }

        internal void ApplyCommit(NetEv ev)
        {
            bool mine = ev.peer == peer;
            switch (ev.type)
            {
                case "fix": ApplyFix(ev); break;
                case "quarantine":
                    if (ev.peer == host) Quarantine(ev.target);
                    break;
                case "sting":
                {
                    var hm = HumanByHex(ev.humanHex);
                    if (hm == null) break;
                    hm.panic = Min(1, hm.panic + ev.panicGain);
                    hm.stungCount++;
                    hm.mem.Add(new MemRec { m = minute, x = hm.x, z = hm.z });
                    if (hm.mem.Count > T.memory.keep) hm.mem.RemoveAt(0);
                    bool first = !stung.Has(hm.hex);
                    stung.Set(hm.hex, true);
                    if (!mine) stats.remoteStings++; else if (ev.driven) stats.stings++; else stats.aiStings++;
                    AddEsc(hm.x, hm.z, T.esc.sting);
                    CS(hm.chunk).lastSting = new LastSting { x = ev.sx, z = ev.sz };
                    // at level 3 a person with it in them goes for a can once things calm down (T1-6)
                    if (!hm.special && !(hm.sprayCount > 0) && hm.tr.escalation >= T.esc.sprayTrait && EscAt(hm.x, hm.z) >= 3) hm.wantSpray = true;
                    Emit("sting", ("waspId", ev.waspId), ("remote", !mine), ("driven", mine && ev.driven), ("humanHex", hm.hex), ("zone", ev.zone), ("first", first), ("under", ev.under));
                    if (ev.flee && Calm(hm)) StartFlee(hm, new LastSting { x = ev.sx, z = ev.sz });
                    break;
                }
                case "deepen":
                {
                    var hm = HumanByHex(ev.humanHex);
                    if (hm == null) break;
                    hm.panic = Min(1, hm.panic + ev.extra);
                    AddEsc(hm.x, hm.z, T.esc.full);
                    Emit("deepen", ("humanHex", hm.hex), ("zone", ev.zone));
                    if (hm.panic >= T.resolve.fleePanic && Calm(hm)) StartFlee(hm, new LastSting { x = ev.sx, z = ev.sz });
                    break;
                }
                case "preSwat":
                {
                    var hm = HumanByHex(ev.humanHex);
                    if (hm != null) AddEsc(hm.x, hm.z, T.esc.nuisance);
                    break;
                }
                case "cover":
                {
                    // a hand goes over the cup on the agreed tick; whoever is inside is shut in (GDD 7.5)
                    var cst = CS(ev.key); cst.cover ??= new Dictionary<int, int>();
                    int until = (int)ev.end;
                    cst.cover[ev.i] = System.Math.Max(cst.cover.TryGetValue(ev.i, out var cu) ? cu : 0, until);
                    Emit("cover", ("humanHex", ev.humanHex), ("key", ev.key), ("i", ev.i));
                    break;
                }
                case "spray":
                {
                    // the can empties on the agreed tick, so every peer counts the same sprays (T1-6)
                    var hm = HumanByHex(ev.humanHex);
                    if (hm != null && hm.sprayCount > 0) hm.sprayCount--;
                    break;
                }
                case "rip":
                {
                    var hm = HumanByHex(ev.humanHex);
                    if (hm == null || hm.clothing.topOff) break;
                    hm.clothing = hm.clothing.Clone(); hm.clothing.topOff = true; hm.clothing.stiffness = 0;
                    Emit("rip", ("humanHex", hm.hex));
                    if (Calm(hm)) StartFlee(hm, new LastSting { x = ev.sx, z = ev.sz });
                    break;
                }
                case "killed":
                {
                    var hm = HumanByHex(ev.byHex);
                    if (hm != null) AddEsc(hm.x, hm.z, T.esc.death);
                    break;
                }
                case "interest":
                    interest.Set(ev.peer, ev.key);
                    RebuildHumans();
                    break;
                case "notice":
                {
                    var hm = HumanByHex(ev.humanHex);
                    if (hm == null) break;
                    hm.panic = Min(1, hm.panic + T.perch.panic * hm.tr.panicSusceptibility);
                    AddEsc(hm.x, hm.z, T.esc.nuisance);
                    break;
                }
                case "startle": // a wasp slammed down on them or beside them (the swoop, GDD 7.9)
                {
                    var hm = HumanByHex(ev.humanHex);
                    if (hm == null || hm.special) break;
                    hm.panic = Min(1, hm.panic + ev.amount * hm.tr.panicSusceptibility);
                    if (hm.panic >= T.resolve.fleePanic && Calm(hm)) StartFlee(hm, new LastSting { x = ev.x, z = ev.z });
                    break;
                }
            }
        }
    }
}
