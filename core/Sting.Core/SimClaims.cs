// Chunk authority and contested pickups (GDD 11.6, A.9, T1-19). Port of the same part of sim.js.
using System.Collections.Generic;
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed partial class Sim
    {
        /// The peer that rules on a chunk: of the peers whose interest is within the active window of it, the one with the
        /// smallest Hash(seed, chunk, peer) (rendezvous hashing). Every peer elects the same one from committed interest.
        public int ChunkAuthority(string key)
        {
            var parts = key.Split(','); int cx = int.Parse(parts[0]), cz = int.Parse(parts[1]), A = T.chunk.activeRadius;
            ulong k64 = ((ulong)(uint)cx << 32) | (uint)cz;
            int best = -1; ulong bs = 0;
            foreach (var kv in interest)
            {
                int p = kv.Key;
                if (plaus.quarantined.Contains(p)) continue;
                var ip = kv.Value.Split(','); int ix = int.Parse(ip[0]), iz = int.Parse(ip[1]);
                if (System.Math.Max(System.Math.Abs(ix - cx), System.Math.Abs(iz - cz)) > A) continue;
                ulong s = Hash(seed, Domain.WorldGen, k64, (ulong)p, 0xA11CE);
                if (best < 0 || s < bs || (s == bs && p < best)) { bs = s; best = p; }
            }
            return best < 0 ? peer : best;
        }

        /// A wasp takes something only one can have: at once, and off the authority's peer also as a claim
        void Pickup(Wasp w, NetEv ev)
        {
            // where the wasp took it, and which wasp: every peer checks both (T1-20)
            ev.waspId = w.id; ev.x = w.x; ev.y = w.y; ev.z = w.z;
            if (net) { if (w.pubLoad) Publish(new NetEv { type = "drop", waspId = w.id }); w.pubLoad = true; }
            int auth = net ? ChunkAuthority(ev.key) : peer;
            if (auth == peer) { Publish(ev); return; }
            claims.Set(w.id, new Claim { auth = auth, key = ev.key, what = ev.what, i = ev.i, hive = ev.hive, carry = w.carry?.what, tick = tick });
            var c = ev.Copy(); c.type = "claim"; c.auth = auth;
            Publish(c);
        }
        bool Available(NetEv ev)
        {
            var st = CS(ev.key);
            switch (ev.what)
            {
                case "fly": return !((st.caughtFly.TryGetValue(ev.i, out var cf) ? cf : 0) > tick);
                case "caterpillar": return !st.caughtCat.ContainsKey(ev.i);
                case "carrion": return T.eco.carrionLoads - (st.carrion != null && st.carrion.TryGetValue(ev.i, out var cn) ? cn : 0) > 0;
                case "meat": return (ev.i % 2 != 0 ? T.bbq.plateLoads : T.bbq.grillLoads) - (st.meat != null && st.meat.TryGetValue(ev.i, out var mn) ? mn : 0) > 0;
                case "honey": return HiveLoadsLeft(ev.key, ev.i) > 0;
                case "bee": return !(st.beeLost.TryGetValue(ev.hive, out var l) && l.ContainsKey(ev.i));
                case "pulp": return PulpLeft(ev.key, ev.i) > 0;
            }
            return records.TryGet(ev.key, out _);
        }
        void Taken(NetEv ev, int sign, int t)
        {
            var st = CS(ev.key);
            void Inc(Dictionary<int, int> o, int k) => o[k] = System.Math.Max(0, (o.TryGetValue(k, out var v) ? v : 0) + sign);
            switch (ev.what)
            {
                case "fly": if (sign > 0) st.caughtFly[ev.i] = t + T.prey.flyRespawnTicks; break;
                case "caterpillar": if (sign > 0) st.caughtCat[ev.i] = 1; break;
                case "carrion": Inc(st.carrion ??= new Dictionary<int, int>(), ev.i); break;
                case "meat": Inc(st.meat ??= new Dictionary<int, int>(), ev.i); break;
                case "honey": Inc(st.robbed ??= new Dictionary<int, int>(), ev.i); break;
                case "bee": if (sign > 0) { if (!st.beeLost.TryGetValue(ev.hive, out var l)) st.beeLost[ev.hive] = l = new Dictionary<int, int>(); l[ev.i] = 1; } break;
                case "pulp": Inc(st.pulp ??= new Dictionary<int, int>(), ev.i); break;
            }
        }
        /// The authority's ruling on another peer's claim: first to reach it wins
        void Rule(NetEv ev)
        {
            var o = new NetEv { key = ev.key, what = ev.what, i = ev.i, hive = ev.hive, claimPeer = ev.peer, claimWasp = ev.waspId };
            if (!Available(ev)) { o.type = "denied"; Publish(o); Emit("claimDenied", ("peer", ev.peer), ("what", ev.what)); return; }
            Taken(ev, 1, ev.tick);
            o.type = "caught"; o.ctick = ev.tick;
            Publish(o);
        }
        /// Our claim lost: undo our share of a load count, and the wasp lets go if it still holds it
        void Denied(NetEv ev)
        {
            if (!claims.TryGet(ev.claimWasp, out var c) || c.auth != ev.peer || c.key != ev.key || c.what != ev.what || c.i != ev.i) return;
            claims.Delete(ev.claimWasp);
            if (ev.what == "carrion" || ev.what == "meat" || ev.what == "honey" || ev.what == "pulp") Taken(ev, -1, 0);
            var w = WaspById(ev.claimWasp); bool had = w != null && w.carry != null && w.carry.what == c.carry;
            if (had) { w.carry = null; if (w.id != drivenId) { w.ai.mode = "pick"; w.ai.target = null; } }
            if (ev.what != "pulp") stats.caught--;
            Emit("claimLost", ("id", ev.claimWasp), ("what", ev.what), ("driven", ev.claimWasp == drivenId), ("had", had));
        }
        /// a claim nobody answered (the authority left) stands
        void ExpireClaims()
        {
            foreach (var kv in claims) if (tick - kv.Value.tick > T.net.claimTicks) claims.Delete(kv.Key);
        }
    }
}
