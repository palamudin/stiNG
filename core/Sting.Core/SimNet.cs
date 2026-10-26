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
        void Publish(NetEv ev)
        {
            ev.mk = "ev"; ev.peer = peer; ev.seq = ++evSeq; ev.tick = tick;
            ev.commit = tick + T.net.commitTicks;
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
                carry = w.carry?.what, under = w.under?.hex, rival = w.colony != "own",
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
        string Implausible(NetEv ev)
        {
            plaus.lastSeq.TryGetValue(ev.peer, out int last);
            if (ev.commit != ev.tick + T.net.commitTicks) return "commit tick";
            if (ev.seq <= last) return "replayed or out of order";
            plaus.lastSeq[ev.peer] = ev.seq;
            if (ev.tick > tick + T.plaus.futureTicks) return "from the future";
            if (ev.type == "quarantine" && ev.peer != host) return "only the host rules on peers";
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

        void ApplyImmediate(NetEv ev)
        {
            bool mine = ev.peer == peer;
            switch (ev.type)
            {
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
                    if (a != null && a.colony != "own" && (a.state == "fly" || a.state == "landed" || a.state == "chewing")) StartRemoteFight(a, ev.b, ev.peer);
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
            }
        }
    }
}
