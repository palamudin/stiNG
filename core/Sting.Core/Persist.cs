// Snapshot and restore of a whole sim (GDD 4.6 persistence, 11.10 joining a world in progress). Port of poc/sim/persist.js.
// The C# save is binary and exact: every double is written as its 8 bytes, every ordered map keeps its order, frozen
// chunks are regenerated from the seed and checked against their stored content hash. One Io method per type both
// writes and reads, so the two directions cannot drift apart.
using System;
using System.Collections.Generic;
using System.IO;
#pragma warning disable IDE1006
namespace Sting.Core
{
    /// Reads or writes, depending on how it was made. Every Io call moves one value in the current direction.
    public sealed class Archive
    {
        readonly BinaryWriter w; readonly BinaryReader r;
        public bool Reading => r != null;
        public Archive(BinaryWriter w) { this.w = w; }
        public Archive(BinaryReader r) { this.r = r; }

        public void D(ref Num v) { if (Reading) v = Num.FromBits(r.ReadInt64()); else w.Write(v.Bits); }
        public void I(ref int v) { if (Reading) v = r.ReadInt32(); else w.Write(v); }
        public void L(ref long v) { if (Reading) v = r.ReadInt64(); else w.Write(v); }
        public void U(ref ulong v) { if (Reading) v = r.ReadUInt64(); else w.Write(v); }
        public void U(ref uint v) { if (Reading) v = r.ReadUInt32(); else w.Write(v); }
        public void B(ref bool v) { if (Reading) v = r.ReadBoolean(); else w.Write(v); }
        public void S(ref string v)
        {
            bool has = v != null; B(ref has);
            if (!has) { v = null; return; }
            if (Reading) v = r.ReadString(); else w.Write(v);
        }
        public void V(ref V3 v) { D(ref v.x); D(ref v.y); D(ref v.z); }
        /// An optional object: writes a presence flag, makes a fresh one when reading. Returns whether there is one.
        public bool Opt<TObj>(ref TObj o) where TObj : class, new()
        {
            bool has = o != null; B(ref has);
            if (Reading) o = has ? new TObj() : null;
            return has;
        }
        public void List<TItem>(ref List<TItem> list, Func<TItem> make, Action<TItem> io)
        {
            bool has = list != null; B(ref has);
            if (!has) { list = null; return; }
            int n = list?.Count ?? 0; I(ref n);
            if (Reading) { list = new List<TItem>(n); for (int i = 0; i < n; i++) { var x = make(); io(x); list.Add(x); } }
            else foreach (var x in list) io(x);
        }
        public void Ints(ref List<int> list)
        {
            bool has = list != null; B(ref has);
            if (!has) { list = null; return; }
            int n = list?.Count ?? 0; I(ref n);
            if (Reading) { list = new List<int>(n); for (int i = 0; i < n; i++) { int v = 0; I(ref v); list.Add(v); } }
            else foreach (var x in list) { int v = x; I(ref v); }
        }
        public void Strings(ref List<string> list)
        {
            bool has = list != null; B(ref has);
            if (!has) { list = null; return; }
            int n = list?.Count ?? 0; I(ref n);
            if (Reading) { list = new List<string>(n); for (int i = 0; i < n; i++) { string v = null; S(ref v); list.Add(v); } }
            else foreach (var x in list) { string v = x; S(ref v); }
        }
        /// A dictionary whose order does not matter to the sim; written in key order so saves are reproducible
        public void Dict<TV>(ref Dictionary<int, TV> d, Func<TV> make, Func<TV, TV> io)
        {
            bool has = d != null; B(ref has);
            if (!has) { d = null; return; }
            int n = d?.Count ?? 0; I(ref n);
            if (Reading) { d = new Dictionary<int, TV>(n); for (int i = 0; i < n; i++) { int k = 0; I(ref k); d[k] = io(make()); } }
            else { var ks = new List<int>(d.Keys); ks.Sort(); foreach (var k in ks) { int kk = k; I(ref kk); io(d[k]); } }
        }
        public void Map<TK, TV>(OrderedMap<TK, TV> m, Func<TK> makeKey, Action<Archive, Ref<TK>> ioKey, Func<TV> make, Func<TV, TV> io)
        {
            int n = m.Count; I(ref n);
            if (Reading)
            {
                m.Clear();
                for (int i = 0; i < n; i++) { var k = new Ref<TK>(makeKey()); ioKey(this, k); m.Set(k.v, io(make())); }
            }
            else foreach (var kv in m) { var k = new Ref<TK>(kv.Key); ioKey(this, k); io(kv.Value); }
        }
        public sealed class Ref<TX> { public TX v; public Ref(TX v) { this.v = v; } }
        public static void KeyS(Archive a, Ref<string> k) => a.S(ref k.v);
        public static void KeyI(Archive a, Ref<int> k) => a.I(ref k.v);
    }

    public static class Persist
    {
        public const int SAVE_VERSION = 23; // 2: records which number build wrote it; 3: body temperature and drowning; 4: remembered stings; 5: spray fetching and the exterminator's search; 6: young workers; 7: winter with choices; 8: landing on any surface; 9: surface heading, hollow cups; 10: seasonal ecology; 11: feral hives and robbing; 12: the tuning hash; 13: senses (search, remembered sources, the scent brought home); 14: barbecue meat taken; 15: regions, pulp taken from wood; 16: strolls and garden rounds; 17: the carry ledger and sips (T1-20); 18: water (T2-1); 19: young queens on their mating flight (T2-3); 20: lineage colonies (T2-4); 21: feature modifiers (T2-6); 22: the exterminator called to a sister colony; 23: terrain
        const uint MAGIC = 0x474E4953; // "SING"

        // ---------------------------------------------------------------- one Io per type

        public static void Io(Archive a, Settings s)
        {
            a.U(ref s.seed); a.D(ref s.dayMinutes); a.D(ref s.humanDensity); a.D(ref s.beeAggression); a.D(ref s.seasonDays); a.D(ref s.reaction); a.D(ref s.escalation);
            a.B(ref s.exterminator); a.B(ref s.birds); a.B(ref s.rivals); a.B(ref s.pestControl);
            a.I(ref s.woods); a.I(ref s.towns); a.D(ref s.water); a.D(ref s.hives); a.I(ref s.terrain); // T2-6
        }

        static Swat Io(Archive a, Swat s)
        {
            a.U(ref s.actorId); a.S(ref s.actorHex); a.S(ref s.frameHex); a.S(ref s.stungHex); a.I(ref s.kind);
            a.D(ref s.start); a.D(ref s.window); a.D(ref s.radius); a.D(ref s.reach); a.D(ref s.contactTick);
            a.V(ref s.center); a.B(ref s.kills); a.B(ref s.pre); a.Ints(ref s.hits); a.I(ref s.underOnly); a.I(ref s.byWasp); a.I(ref s.targetId); a.S(ref s.why);
            return s;
        }

        static NetEv Io(Archive a, NetEv e)
        {
            a.S(ref e.mk); a.I(ref e.peer); a.I(ref e.tick); a.S(ref e.type); a.I(ref e.seq); a.I(ref e.commit);
            a.I(ref e.waspId); a.B(ref e.driven); a.S(ref e.humanHex); a.I(ref e.zone); a.B(ref e.under);
            a.List(ref e.swats, () => new Swat(), s => Io(a, s));
            a.D(ref e.panicGain); a.B(ref e.flee); a.D(ref e.sx); a.D(ref e.sz); a.D(ref e.extra);
            a.S(ref e.key); a.I(ref e.i); a.I(ref e.hive); a.I(ref e.h); a.I(ref e.target); a.S(ref e.what); a.D(ref e.radius);
            a.S(ref e.byHex); a.S(ref e.cause); a.D(ref e.x); a.D(ref e.y); a.D(ref e.z);
            a.D(ref e.start); a.D(ref e.end); a.D(ref e.window); a.I(ref e.kind); a.V(ref e.center); a.B(ref e.kills); a.S(ref e.why);
            a.I(ref e.a); a.I(ref e.b); a.I(ref e.toPeer); a.D(ref e.venom); a.D(ref e.mash); a.B(ref e.queen); a.I(ref e.id);
            return e;
        }

        static void IoTarget(Archive a, AiTarget t) { a.S(ref t.kind); a.S(ref t.key); a.S(ref t.sub); a.S(ref t.hex); a.I(ref t.i); a.I(ref t.c); a.V(ref t.p); }
        static void IoKnown(Archive a, Known k) { a.S(ref k.role); a.I(ref k.until); k.t ??= new AiTarget(); IoTarget(a, k.t); }

        static void Io(Archive a, Ai ai)
        {
            a.S(ref ai.mode);
            if (a.Opt(ref ai.target)) { var t = ai.target; a.S(ref t.kind); a.S(ref t.key); a.S(ref t.sub); a.S(ref t.hex); a.I(ref t.i); a.I(ref t.c); a.V(ref t.p); }
            a.D(ref ai.timer); a.D(ref ai.until); a.S(ref ai.humanHex); a.I(ref ai.stings); a.I(ref ai.huntId); a.D(ref ai.stingHold); a.D(ref ai.cargo); a.S(ref ai.atFood);
            if (a.Opt(ref ai.from)) IoTarget(a, ai.from);
            if (a.Opt(ref ai.known)) IoKnown(a, ai.known);
            a.D(ref ai.head); a.D(ref ai.leg); a.I(ref ai.spin);
        }

        static Wasp Io(Archive a, Wasp w)
        {
            a.I(ref w.id); a.S(ref w.caste); a.D(ref w.x); a.D(ref w.y); a.D(ref w.z); a.D(ref w.vx); a.D(ref w.vy); a.D(ref w.vz); a.S(ref w.state);
            a.D(ref w.yaw); a.D(ref w.pitch); a.D(ref w.energy); a.D(ref w.venom); a.D(ref w.bodyT); a.I(ref w.chill); a.I(ref w.stateTicks);
            if (a.Opt(ref w.attach)) { var t = w.attach; a.S(ref t.hex); a.S(ref t.posture); a.V(ref t.local); a.V(ref t.n); a.I(ref t.start); a.B(ref t.deepened); a.I(ref t.zone); }
            if (a.Opt(ref w.under))
            {
                var u = w.under; a.S(ref u.hex); a.S(ref u.posture); a.S(ref u.key); a.I(ref u.node); a.I(ref u.sel); a.I(ref u.entered);
                if (a.Opt(ref u.move)) { a.I(ref u.move.to); a.I(ref u.move.t); }
                a.D(ref u.nextPress); a.B(ref u.mxHeld); a.B(ref u.mzHeld);
            }
            if (a.Opt(ref w.ball)) { var b = w.ball; a.D(ref b.temp); a.D(ref b.progress); a.D(ref b.prevBurst); a.D(ref b.bees); }
            a.D(ref w.born);
            if (a.Opt(ref w.carry)) { var c = w.carry; a.S(ref c.kind); a.S(ref c.what); a.D(ref c.amount); a.B(ref c.poison); }
            a.B(ref w.pubLoad); a.B(ref w.mated); // T2-3
            a.I(ref w.groundTicks); a.I(ref w.chew); a.S(ref w.role); a.S(ref w.colony);
            if (a.Opt(ref w.chewAt)) { a.S(ref w.chewAt.key); a.I(ref w.chewAt.i); a.B(ref w.chewAt.water); }
            if (a.Opt(ref w.web)) { var b = w.web; a.S(ref b.key); a.I(ref b.i); a.D(ref b.progress); a.D(ref b.prevBurst); a.I(ref b.start); a.D(ref b.spiderAt); }
            if (a.Opt(ref w.drown)) { var d = w.drown; a.S(ref d.key); a.I(ref d.until); a.I(ref d.i); a.D(ref d.progress); a.D(ref d.prevBurst); }
            if (a.Opt(ref w.fight))
            {
                var f = w.fight; a.I(ref f.other); a.B(ref f.remote); a.B(ref f.starter); a.I(ref f.peer);
                a.D(ref f.start); a.D(ref f.until); a.D(ref f.mash); a.D(ref f.myVenom); a.D(ref f.theirVenom); a.B(ref f.theirQueen);
            }
            if (a.Reading) w.ai = new Ai();
            Io(a, w.ai);
            if (a.Opt(ref w.contact))
            {
                var c = w.contact; a.S(ref c.humanHex); a.I(ref c.zone); a.B(ref c.blocked); a.D(ref c.reach); a.V(ref c.n); a.V(ref c.surf); a.S(ref c.part); a.I(ref c.opening); a.S(ref c.openingKey);
            }
            if (a.Opt(ref w.perch))
            {
                var p = w.perch; a.S(ref p.hex); a.S(ref p.posture); a.V(ref p.local); a.V(ref p.n); a.V(ref p.surf); a.I(ref p.zone); a.S(ref p.part);
                a.D(ref p.tickle); a.D(ref p.need); a.D(ref p.quietUntil);
            }
            a.B(ref w.walking); a.D(ref w.fightReqUntil);
            if (a.Opt(ref w.land)) { a.D(ref w.land.nx); a.D(ref w.land.ny); a.D(ref w.land.nz); a.S(ref w.land.kind); a.B(ref w.land.hasH); a.D(ref w.land.hx); a.D(ref w.land.hy); a.D(ref w.land.hz); a.I(ref w.land.yawQ); }
            a.I(ref w.noLandUntil); a.S(ref w.trapCause);
            if (a.Opt(ref w.rob)) { a.S(ref w.rob.key); a.I(ref w.rob.h); a.D(ref w.rob.progress); a.D(ref w.rob.prevSting); }
            return w;
        }

        static void IoClothing(Archive a, ref Clothing c)
        {
            if (a.Reading) c = new Clothing();
            a.I(ref c.top); a.I(ref c.bottom); a.D(ref c.stiffness); a.B(ref c.topOff); a.B(ref c.collarTaped);
        }

        /// The parts of a human that change; the rest comes from the world (seed and chunk)
        static void IoHumanState(Archive a, Human h)
        {
            IoClothing(a, ref h.clothing);
            a.D(ref h.x); a.D(ref h.z); a.D(ref h.fx); a.D(ref h.fz); a.S(ref h.posture); a.S(ref h.state);
            a.D(ref h.panic); a.D(ref h.fleeSteps); a.D(ref h.dirX); a.D(ref h.dirZ); a.D(ref h.stungCount);
            a.L(ref h.winDay);
            if (a.Opt(ref h.win)) { a.D(ref h.win.arrive); a.D(ref h.win.leave); }
            a.I(ref h.annoyId); a.D(ref h.annoy); a.D(ref h.cooldown); a.D(ref h.sprayCount); a.D(ref h.treat); a.L(ref h.clothesDay); a.B(ref h.special);
            a.List(ref h.mem, () => new MemRec(), e => { a.D(ref e.m); a.D(ref e.x); a.D(ref e.z); });
            a.I(ref h.fetchT); a.B(ref h.wantSpray); a.D(ref h.wpx); a.D(ref h.wpz); a.D(ref h.clue); a.I(ref h.watch); a.I(ref h.lines);
            a.I(ref h.wp); a.L(ref h.until); a.B(ref h.walking);
        }

        /// a human's state and a chunk's shared state as bytes, for a late-event correction (GDD 11.6)
        internal static byte[] HumanBytes(Human h) { using var ms = new MemoryStream(); using (var bw = new BinaryWriter(ms)) IoHumanState(new Archive(bw), h); return ms.ToArray(); }
        internal static void HumanFromBytes(Human h, byte[] data) { using var br = new BinaryReader(new MemoryStream(data)); IoHumanState(new Archive(br), h); }
        internal static byte[] ChunkBytes(ChunkState s) { using var ms = new MemoryStream(); using (var bw = new BinaryWriter(ms)) IoChunkState(new Archive(bw), s); return ms.ToArray(); }
        internal static ChunkState ChunkFromBytes(byte[] data) { using var br = new BinaryReader(new MemoryStream(data)); return IoChunkState(new Archive(br), new ChunkState()); }

        static void IoNest(Archive a, Nest n)
        {
            a.D(ref n.x); a.D(ref n.y); a.D(ref n.z); a.D(ref n.r); a.D(ref n.treeX); a.D(ref n.treeZ); a.V(ref n.entrance);
            if (a.Reading) n.spawn = new Spawn();
            a.D(ref n.spawn.x); a.D(ref n.spawn.y); a.D(ref n.spawn.z); a.D(ref n.spawn.yaw); a.S(ref n.site); a.S(ref n.key);
        }

        static void IoColony(Archive a, ColonyState c)
        {
            a.B(ref c.queenAlive); a.B(ref c.nestAlive); a.B(ref c.sited);
            a.D(ref c.adults); a.D(ref c.eggs); a.D(ref c.larvae); a.D(ref c.pupae); a.D(ref c.cells); a.D(ref c.protein); a.D(ref c.sugar); a.D(ref c.pulp);
            a.D(ref c.rEggs); a.D(ref c.rLarvae); a.D(ref c.rPupae); a.D(ref c.gynes); a.D(ref c.males); a.D(ref c.mated); a.D(ref c.young);
            a.D(ref c.deficit); a.D(ref c.fed); a.D(ref c.sugarlessDays); a.I(ref c.alloc); a.D(ref c.maxCells);
            var s = c.stats;
            a.D(ref s.emerged); a.D(ref s.laid); a.D(ref s.starvedLarvae); a.D(ref s.died); a.D(ref s.gynesRaised); a.D(ref s.sugarSpilled); a.D(ref s.proteinSpilled); a.D(ref s.poisoned);
            a.D(ref s.depSugar); a.D(ref s.depProtein); a.D(ref s.depPulp);
            a.D(ref c.water); a.D(ref c.cool); a.D(ref c.thirst); a.D(ref s.depWater); a.D(ref s.cooked); // T2-1
        }

        static ChunkState IoChunkState(Archive a, ChunkState s)
        {
            a.D(ref s.esc); a.D(ref s.chewed);
            a.Dict(ref s.caughtFly, () => (Num)0, v => { a.D(ref v); return v; });
            a.Dict(ref s.caughtCat, () => 0, v => { a.I(ref v); return v; });
            a.Dict(ref s.beeLost, () => null, v => { a.Dict(ref v, () => 0, x => { a.I(ref x); return x; }); return v; });
            if (a.Opt(ref s.lastSting)) { a.D(ref s.lastSting.x); a.D(ref s.lastSting.z); }
            a.Dict(ref s.webTorn, () => 0L, v => { a.L(ref v); return v; });
            a.Dict(ref s.spilled, () => (Num)0, v => { a.D(ref v); return v; });
            a.Dict(ref s.cover, () => 0, v => { a.I(ref v); return v; });
            a.Dict(ref s.nectar, () => null, v => { v ??= new Nectar(); a.D(ref v.lv); a.L(ref v.m); return v; });
            a.Dict(ref s.carrion, () => 0, v => { a.I(ref v); return v; });
            a.Dict(ref s.robbed, () => 0, v => { a.I(ref v); return v; });
            a.Dict(ref s.meat, () => 0, v => { a.I(ref v); return v; });
            a.Dict(ref s.pulp, () => 0, v => { a.I(ref v); return v; });
            return s;
        }

        static HiveAlarm IoHiveAlarm(Archive a, HiveAlarm h)
        {
            a.S(ref h.key); a.I(ref h.h); a.I(ref h.target); a.D(ref h.until);
            int n = h.phys.Count; a.I(ref n);
            if (a.Reading) { h.phys.Clear(); for (int i = 0; i < n; i++) { int k = 0; a.I(ref k); var p = new BeePhys(); IoBee(a, p); h.phys[k] = p; } }
            else foreach (var kv in h.phys) { int k = kv.Key; a.I(ref k); IoBee(a, kv.Value); }
            return h;
        }
        static void IoBee(Archive a, BeePhys p) { a.D(ref p.x); a.D(ref p.y); a.D(ref p.z); a.D(ref p.vx); a.D(ref p.vy); a.D(ref p.vz); a.D(ref p.stun); a.S(ref p.mode); }

        static HunterState IoHunter(Archive a, HunterState h)
        {
            a.S(ref h.mode); a.D(ref h.x); a.D(ref h.y); a.D(ref h.z); a.D(ref h.vx); a.D(ref h.vy); a.D(ref h.vz); a.D(ref h.until); a.I(ref h.target);
            return h;
        }

        static void IoPlaus(Archive a, Plaus p)
        {
            a.Dict(ref p.strikes, () => 0, v => { a.I(ref v); return v; });
            a.Ints(ref p.quarantined);
            a.Dict(ref p.lastSeq, () => 0, v => { a.I(ref v); return v; });
            int n = p.stingTicks.Count; a.I(ref n);
            if (a.Reading) { p.stingTicks.Clear(); for (int i = 0; i < n; i++) { string k = null; a.S(ref k); List<int> l = null; a.Ints(ref l); p.stingTicks[k] = l; } }
            else { var ks = new List<string>(p.stingTicks.Keys); ks.Sort(string.CompareOrdinal); foreach (var k in ks) { string kk = k; a.S(ref kk); var l = p.stingTicks[k]; a.Ints(ref l); } }
            a.Ints(ref p.ruled);
            int hn = p.held.Count; a.I(ref hn);
            if (a.Reading) { p.held.Clear(); for (int i = 0; i < hn; i++) { string k = null; a.S(ref k); int v = 0; a.I(ref v); p.held[k] = v; } }
            else { var hk = new List<string>(p.held.Keys); hk.Sort(string.CompareOrdinal); foreach (var k in hk) { string kk = k; a.S(ref kk); int v = p.held[k]; a.I(ref v); } }
            int m = p.sips.Count; a.I(ref m);
            if (a.Reading)
            {
                p.sips.Clear();
                for (int i = 0; i < m; i++) { string k = null; a.S(ref k); var l = new List<SipRec>(); int c = 0; a.I(ref c); for (int j = 0; j < c; j++) { var r = new SipRec(); a.I(ref r.t); a.D(ref r.amount); l.Add(r); } p.sips[k] = l; }
            }
            else
            {
                var ks = new List<string>(p.sips.Keys); ks.Sort(string.CompareOrdinal);
                foreach (var k in ks) { string kk = k; a.S(ref kk); var l = p.sips[k]; int c = l.Count; a.I(ref c); foreach (var r in l) { a.I(ref r.t); a.D(ref r.amount); } }
            }
        }

        // ---------------------------------------------------------------- the whole sim

        static void IoSim(Archive a, Sim s)
        {
            a.I(ref s.evSeq);
            a.List(ref s.pending, () => new NetEv(), e => Io(a, e));
            IoPlaus(a, s.plaus);
            a.Map(s.interest, () => 0, Archive.KeyI, () => null, v => { a.S(ref v); return v; });
            a.I(ref s.host); a.U(ref s.seed); a.I(ref s.tpm); a.L(ref s.dayTicks); a.I(ref s.tick); a.L(ref s.clockOffset);
            a.Map(s.chunkState, () => null, Archive.KeyS, () => new ChunkState(), v => IoChunkState(a, v));
            a.S(ref s.activeKey);
            a.List(ref s.swats, () => new Swat(), x => Io(a, x));
            a.List(ref s.sprays, () => new Spray(), x => { a.S(ref x.hex); a.D(ref x.start); a.D(ref x.end); });
            a.List(ref s.alarms, () => new Alarm(), x => { a.D(ref x.x); a.D(ref x.y); a.D(ref x.z); a.D(ref x.until); a.S(ref x.killerHex); });
            a.Map(s.hiveAlarms, () => null, Archive.KeyS, () => new HiveAlarm(), v => IoHiveAlarm(a, v));
            a.Map(s.birdState, () => null, Archive.KeyS, () => new HunterState(), v => IoHunter(a, v));
            a.Map(s.dragonState, () => null, Archive.KeyS, () => new HunterState(), v => IoHunter(a, v));
            if (a.Reading) s.colony = new ColonyState();
            IoColony(a, s.colony);
            if (a.Reading) s.nest = new Nest();
            IoNest(a, s.nest);
            a.List(ref s.oldNests, () => new Nest(), n => IoNest(a, n));
            a.Map(s.stung, () => null, Archive.KeyS, () => false, v => { a.B(ref v); return v; });
            var st = s.stats;
            a.D(ref st.stings); a.D(ref st.aiStings); a.D(ref st.remoteStings); a.D(ref st.full); a.D(ref st.deaths); a.D(ref st.caught); a.D(ref st.deposits);
            {
                int n = st.causes.Count; a.I(ref n);
                if (a.Reading) { st.causes.Clear(); for (int i = 0; i < n; i++) { string k = null; Num v = 0; a.S(ref k); a.D(ref v); st.causes[k] = v; } }
                else { var ks = new List<string>(st.causes.Keys); ks.Sort(string.CompareOrdinal); foreach (var k in ks) { string kk = k; Num v = st.causes[k]; a.S(ref kk); a.D(ref v); } }
            }
            a.List(ref s.wasps, () => new Wasp(), w => Io(a, w));
            a.I(ref s.nextWaspId); a.I(ref s.prevAct); a.B(ref s.pressUsed); a.I(ref s.respawnAt); a.B(ref s.extinct);
            if (a.Opt(ref s.ghost)) Io(a, s.ghost);
            a.L(ref s.minute); a.L(ref s.day); a.D(ref s.bio);
            if (a.Reading) s.season = new Season();
            a.I(ref s.season.n); a.D(ref s.season.startMinute); a.S(ref s.season.phase);
            a.D(ref s.lineage); a.I(ref s.drivenId);
            a.List(ref s.line, () => new LineColony(), x => { a.I(ref x.id); a.I(ref x.season); if (a.Reading) { x.nest = new Nest(); x.colony = new ColonyState(); } IoNest(a, x.nest); IoColony(a, x.colony); a.L(ref x.ext); }); a.I(ref s.lineSeq); // T2-4
            if (a.Opt(ref s.winter))
            {
                var W = s.winter; a.S(ref W.why); a.D(ref W.survivors); a.D(ref W.lineage); a.I(ref W.until);
                a.List(ref W.sites, () => new HiberSite(), h => { a.S(ref h.kind); a.D(ref h.x); a.D(ref h.y); a.D(ref h.z); a.D(ref h.q); a.I(ref h.n); a.B(ref h.scouted); });
            }
            if (a.Opt(ref s.hiberPick)) { a.I(ref s.hiberPick.season); a.D(ref s.hiberPick.x); a.D(ref s.hiberPick.z); a.S(ref s.hiberPick.kind); }
            if (a.Opt(ref s.springAt)) { a.D(ref s.springAt.x); a.D(ref s.springAt.z); }
            if (a.Opt(ref s.homeScent)) IoKnown(a, s.homeScent);
            if (a.Opt(ref s.pendingSwitch)) { a.I(ref s.pendingSwitch.at); a.I(ref s.pendingSwitch.target); }
            if (a.Opt(ref s.muni))
            {
                var m = s.muni; a.I(ref m.n); a.D(ref m.cooldownUntil);
                if (a.Opt(ref m.active)) { a.I(ref m.active.n); a.S(ref m.active.center); a.Strings(ref m.active.keys); a.D(ref m.active.until); }
            }
        }

        public static byte[] Snapshot(Sim sim)
        {
            using var ms = new MemoryStream();
            using (var bw = new BinaryWriter(ms))
            {
                var a = new Archive(bw);
                uint magic = MAGIC; int v = SAVE_VERSION, gen = T.GEN_VERSION; bool fixedPoint = Num.Fixed;
                a.U(ref magic); a.I(ref v); a.I(ref gen); a.B(ref fixedPoint);
                string tune = Tune.Hash; a.S(ref tune);
                Io(a, sim.settings);
                int peer = sim.peer; bool net = sim.net, noAI = sim.noAI; a.I(ref peer); a.B(ref net); a.B(ref noAI);
                var peers = new List<int>(sim.interest.Keys); a.Ints(ref peers);
                // frozen chunks: where they are and what they must regenerate to (GDD 4.4)
                int n = sim.records.Count; a.I(ref n);
                foreach (var r in sim.records.Values) { int cx = r.cx, cz = r.cz, gv = r.genVersion, dt = r.discoveredTick; uint h = r.contentHash; a.I(ref cx); a.I(ref cz); a.I(ref gv); a.I(ref dt); a.U(ref h); }
                IoSim(a, sim);
                // humans: only what changes
                int hn = sim.humans.Count; a.I(ref hn);
                foreach (var hm in sim.humans.Values) { string hex = hm.hex; a.S(ref hex); IoHumanState(a, hm); }
                var act = sim.active.ConvertAll(h => h.hex); a.Strings(ref act);
                // the exterminator, if one is on the job
                var e = sim.ext; a.I(ref e.visit); a.S(ref e.state); a.D(ref e.arriveMinute);
                if (a.Opt(ref e.lead)) { a.D(ref e.lead.x); a.D(ref e.lead.z); a.D(ref e.lead.nx); a.D(ref e.lead.nz); }
                bool hasHm = e.hm != null; a.B(ref hasHm);
                if (hasHm)
                {
                    var h = e.hm; string hex = h.hex, sh = h.@short, chunk = h.chunk; a.S(ref hex); a.S(ref sh); a.S(ref chunk);
                    var home = h.home; a.D(ref home.x); a.D(ref home.z); a.D(ref home.fx); a.D(ref home.fz); a.D(ref home.ax); a.D(ref home.az); a.S(ref home.posture);
                    IoHumanState(a, h);
                }
            }
            return ms.ToArray();
        }

        public static Sim Restore(byte[] data)
        {
            using var br = new BinaryReader(new MemoryStream(data));
            var a = new Archive(br);
            uint magic = 0; int v = 0, gen = 0; bool fixedPoint = false;
            a.U(ref magic); a.I(ref v); a.I(ref gen); a.B(ref fixedPoint);
            if (magic != MAGIC) throw new InvalidDataException("not a STING save");
            if (v != SAVE_VERSION) throw new InvalidDataException($"save version {v} is not {SAVE_VERSION}");
            if (gen != T.GEN_VERSION) throw new InvalidDataException($"world generator {gen} differs from {T.GEN_VERSION}");
            // numbers are saved as their bits, which mean different things in the two builds
            if (fixedPoint != Num.Fixed) throw new InvalidDataException(fixedPoint ? "this save is from the fixed-point build" : "this save is from the double build");
            string tune = null; a.S(ref tune);
            if (tune != Tune.Hash) throw new InvalidDataException($"world was made with tuning {tune}, this game runs {Tune.Hash}"); // T1-22
            var settings = new Settings(); Io(a, settings);
            int peer = 0; bool net = false, noAI = false; a.I(ref peer); a.B(ref net); a.B(ref noAI);
            List<int> peers = null; a.Ints(ref peers);
            var sim = new Sim(settings, new SimOpts { peer = peer, net = net, noAI = noAI, peers = peers });
            sim.DrainEvents();
            sim.records = new OrderedMap<string, ChunkRec>();
            int n = 0; a.I(ref n);
            for (int i = 0; i < n; i++)
            {
                int cx = 0, cz = 0, gv = 0, dt = 0; uint h = 0; a.I(ref cx); a.I(ref cz); a.I(ref gv); a.I(ref dt); a.U(ref h);
                var content = World.GenerateChunk(sim.seed, cx, cz, sim.settings);
                if (Sim.ContentHash(content) != h) throw new InvalidDataException($"chunk {cx},{cz} does not match its stored hash");
                sim.records.Set(cx + "," + cz, new ChunkRec { cx = cx, cz = cz, genVersion = gv, discoveredTick = dt, contentHash = h, content = content });
            }
            IoSim(a, sim);
            // humans: fixed parts come from the world, mutable parts from the save
            var saved = new Dictionary<string, Human>();
            int hn = 0; a.I(ref hn);
            for (int i = 0; i < hn; i++) { string hex = null; a.S(ref hex); var h = new Human(); IoHumanState(a, h); saved[hex] = h; }
            sim.humans = new OrderedMap<string, Human>();
            foreach (var rec in sim.records.Values)
                foreach (var hs in rec.content.humans)
                {
                    ulong id = R.Hash(sim.seed, Domain.WorldGen, R.U64(rec.cx), R.U64(rec.cz), (ulong)hs.slot);
                    string hex = R.Hex64(id);
                    if (!saved.TryGetValue(hex, out var hm)) continue;
                    hm.id = id; hm.hex = hex; hm.@short = hex.Substring(0, 4); hm.tr = sim.TraitsFor(id); hm.chunk = rec.cx + "," + rec.cz;
                    hm.home = new Home { x = hs.x, z = hs.z, fx = hs.fx, fz = hs.fz, posture = hs.posture, ax = hs.x + T.panic.approachDist * R.DCos(hs.exit), az = hs.z + T.panic.approachDist * R.DSin(hs.exit), act = hs.act, path = hs.path, evening = hs.evening };
                    hm.sit = Body.BodyParts(hm.tr, "sit"); hm.stand = Body.BodyParts(hm.tr, "stand");
                    sim.humans.Set(hex, hm);
                }
            List<string> act = null; a.Strings(ref act);
            var e = new Ext(); a.I(ref e.visit); a.S(ref e.state); a.D(ref e.arriveMinute);
            if (a.Opt(ref e.lead)) { a.D(ref e.lead.x); a.D(ref e.lead.z); a.D(ref e.lead.nx); a.D(ref e.lead.nz); }
            bool hasHm = false; a.B(ref hasHm);
            if (hasHm)
            {
                var h = new Human(); a.S(ref h.hex); a.S(ref h.@short); a.S(ref h.chunk);
                h.home = new Home(); a.D(ref h.home.x); a.D(ref h.home.z); a.D(ref h.home.fx); a.D(ref h.home.fz); a.D(ref h.home.ax); a.D(ref h.home.az); a.S(ref h.home.posture);
                IoHumanState(a, h);
                h.id = R.Hash(sim.seed, Domain.WorldGen, 0xE77, (ulong)e.visit);
                h.tr = Sim.ExtTraits(sim.seed, h.id);
                h.sit = Body.BodyParts(h.tr, "sit"); h.stand = Body.BodyParts(h.tr, "stand");
                e.hm = h;
            }
            sim.ext = e;
            // derived views
            var (cx0, cz0) = (int.Parse(sim.activeKey.Split(',')[0]), int.Parse(sim.activeKey.Split(',')[1]));
            int A = T.chunk.activeRadius;
            sim.activeChunks = new List<ChunkRec>();
            for (int dz = -A; dz <= A; dz++) for (int dx = -A; dx <= A; dx++) sim.activeChunks.Add(sim.records.Get((cx0 + dx) + "," + (cz0 + dz)));
            sim.active = act.ConvertAll(hex => sim.HumanByHex(hex));
            sim.log = new int[Sim.CMD_FIELDS * 4096]; sim.logLen = 0;
            sim.events = new List<SimEvent>();
            sim.Emit("chunksActive", ("key", sim.activeKey));
            sim.Emit("restored", ("tick", sim.tick));
            return sim;
        }

        /// Replay from a snapshot plus the input recorded after it (the lab's determinism check for restored worlds)
        public static string ReplayFrom(byte[] snap, int[] log, int ticks)
        {
            var s = Restore(snap);
            for (int t = 0; t < ticks; t++) { s.Step(Sim.CmdAt(log, t)); s.events.Clear(); }
            return s.StateHash();
        }

        /// A new peer joins a world in progress (GDD 11.10): it takes the shared world from a snapshot
        /// (frozen chunks, chunk deltas, humans, pending events, interest) and starts its own colony.
        public static Sim JoinFrom(byte[] snap, int peer, bool noAI = false)
        {
            var sim = Restore(snap);
            sim.peer = peer;
            sim.net = true;
            sim.noAI = noAI;
            sim.nextWaspId = peer * 1000000 + 1;
            sim.wasps = new List<Wasp>(); sim.remote = new OrderedMap<int, RemoteWasp>(); sim.outbox = new List<Msg>();
            sim.colony = Colony.New(); sim.nest = World.MakeNest(World.NEST.treeX, World.NEST.treeZ, World.NEST.x, World.NEST.y, World.NEST.z); sim.colony.maxCells = T.sites.trunk.maxCells; sim.oldNests = new List<Nest>();
            sim.stats = new SimStats();
            sim.netStats = new NetStats();
            sim.ghost = null; sim.extinct = false; sim.lineage = 0; sim.evSeq = 0; sim.prevAct = 0; sim.pressUsed = false;
            sim.alarms = new List<Alarm>(); sim.birdState = new OrderedMap<string, HunterState>(); sim.dragonState = new OrderedMap<string, HunterState>(); sim.homeScent = null;
            sim.JoinSpawn();
            return sim;
        }
    }
}
