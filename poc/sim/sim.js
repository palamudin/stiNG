// STING simulation core (iteration 2). Mirrors Sting.Core: no rendering, no wall clock.
// Every wasp, driven or AI, goes through the same flight, contact, sting and swat code.
import { Domain, hash, unit, rangeInt, u64, h32, hseq, dsin, dcos, clamp, clamp01, fnv32, hex64, rnd, sq, datan2, TAU } from './rng.js';
import { T, DT, GEN_VERSION, DEFAULT_SETTINGS } from './tuning.js';
import {
  Zone, ZONES, SwatKind, SwatKindName, Style, humanTraits, humanClothing, suitClothing, zoneCover, bodyParts,
  segClosest, classify, toWorld, toLocal, dirToWorld, resolveSting, windowFor, selfReach, garmentGraph, Top,
} from './body.js';
import {
  chunkOf, chunkKey, NEST, NEST_ENTRANCE, SPAWN, generateChunk, ticksPerMinute, clockMinutes, dayOf, minuteOfDay,
  isRaining, tempAt, windAt, isDaylight, humanWindow, flyPos, beePos, birdPos, dragonPos, shedSites, makeNest,
} from './world.js';
import { newColony, colonyStep, destroyNest, colonyFinished, seasonPhase } from './colony.js';

export const CMD_FIELDS = 10; // mx, my, mz, burst, sting, yawQ, pitchQ, act, alloc, pick (a wasp id to switch to, from the colony view)
export const Act = { Interact: 1, Switch: 2, Rest: 4 };

const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; };
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byHumanId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Events that change shared world state. Most commit at the end of the consequence window so every
// peer applies them on the same tick (GDD 11.5); a few cosmetic or owner-decided ones apply on receipt.
const IMMEDIATE = new Set(['caught', 'sip', 'beeAlarm', 'died', 'fight', 'fightReq', 'fightJoin', 'fightRefuse', 'fightEnd', 'raid']); // wasp-level: never touch humans

export class Sim {
  constructor(settings = {}, opts = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.peer = opts.peer | 0;
    this.net = !!opts.net;
    this.noAI = !!opts.noAI;
    this.outbox = [];
    this.pending = [];
    this.evSeq = 0;
    this.remote = new Map();
    this.netStats = { sent: 0, recv: 0, late: 0, lateMax: 0, rejected: 0, dropped: 0 };
    this.plaus = { strikes: {}, quarantined: [], lastSeq: {}, stingTicks: {} };
    // Which chunks each peer is near. Humans are simulated over the union, changes commit like any event (Q-16)
    this.interest = new Map();
    for (const p of opts.peers || [this.peer]) this.interest.set(p, chunkKey(chunkOf(SPAWN.x), chunkOf(SPAWN.z)));
    this.host = Math.min(...(opts.peers || [this.peer])); // rules on cheaters for everyone (GDD 11.8)
    this.seed = u64(this.settings.seed ?? 1234);
    this.tpm = ticksPerMinute(this.settings);
    this.dayTicks = this.tpm * 1440;
    this.tick = 0;
    this.clockOffset = 0;
    this.events = [];
    this.records = new Map();
    this.chunkState = new Map();
    this.humans = new Map();
    this.active = [];
    this.activeChunks = [];
    this.activeKey = '';
    this.swats = [];
    this.sprays = [];
    this.alarms = [];
    this.hiveAlarms = new Map();
    this.birdState = new Map();
    this.dragonState = new Map();
    this.colony = newColony();
    this.nest = makeNest(NEST.treeX, NEST.treeZ, NEST.x, NEST.y, NEST.z);
    this.colony.maxCells = T.sites.trunk.maxCells;
    this.oldNests = [];
    this.stung = new Set();
    this.stats = { stings: 0, aiStings: 0, remoteStings: 0, full: 0, deaths: 0, causes: {}, caught: 0, deposits: 0 };
    this.wasps = [];
    this.nextWaspId = this.peer * 1000000 + 1;
    this.winter = null; this.hiberPick = null; this.springAt = null; // T1-15
    this.ext = { visit: 0, state: 'none', arriveMinute: 0, hm: null, lead: null };
    this.prevAct = 0;
    this.pressUsed = false;
    this.respawnAt = 0;
    this.extinct = false;
    this.ghost = null;
    this.hint = {};
    this.log = new Int32Array(CMD_FIELDS * 4096);
    this.logLen = 0;
    this.minute = clockMinutes(0, this.settings);
    this.day = dayOf(this.minute);
    this.bio = this.settings.seasonDays / 200;
    this.season = { n: 1, startMinute: this.minute - T.season.startFrac * this.settings.seasonDays * 1440, phase: '' };
    this.season.phase = seasonPhase(this.seasonFrac);
    this.lineage = 0;
    const w = this._spawnWasp(true);
    this.drivenId = w.id;
    this._updateChunks(true);
  }

  // ---------------------------------------------------------------- basics

  emit(type, data = {}) { this.events.push({ t: this.tick, type, ...data }); }
  drainEvents() { const e = this.events; this.events = []; return e; }
  get wasp() { return this._driven() || this.ghost; }
  _driven() { for (const w of this.wasps) if (w.id === this.drivenId) return w; return null; }
  waspById(id) { for (const w of this.wasps) if (w.id === id) return w; return null; }
  humanByHex(hex) { return this.humans.get(hex) || (this.ext.hm && this.ext.hm.hex === hex ? this.ext.hm : undefined); }
  // Human traits with the world's modifiers applied (GDD 4.8). The resolver still enforces the consequence window.
  traitsFor(id) {
    const tr = humanTraits(this.seed, id), r = this.settings.reaction;
    if (r !== 1) tr.reactionTicks = Math.max(T.resolve.minConsequenceTicks, rnd(tr.reactionTicks * r));
    return tr;
  }

  cs(key) {
    let s = this.chunkState.get(key);
    if (!s) { s = { esc: 0, caughtFly: {}, caughtCat: {}, beeLost: {}, chewed: 0, lastSting: null }; this.chunkState.set(key, s); }
    return s;
  }
  escLevel(key) {
    const s = this.chunkState.get(key);
    if (!s) return 0;
    const L = T.esc.levels;
    let lv = 0;
    for (let i = 1; i < L.length; i++) if (s.esc >= L[i]) lv = i;
    return lv;
  }
  escAt(x, z) { return this.escLevel(chunkKey(chunkOf(x), chunkOf(z))); }
  addEsc(x, z, pts) { const k = chunkKey(chunkOf(x), chunkOf(z)); const before = this.escLevel(k); this.cs(k).esc += pts * this.settings.escalation * (this.colony && this.colony.sited && k === this.nest.key ? T.sites[this.nest.site || 'trunk'].discovery : 1); const after = this.escLevel(k); if (after !== before) this.emit('escalation', { key: k, level: after }); }
  // the day's weather plus the season's swing: cold springs for founding queens, cooling autumns (GDD 5.3)
  get temperature() {
    const c = this._tc;
    if (c && c.m === this.minute && c.s === this.season.startMinute) return c.v; // asked by every wasp every tick
    const v = this.airAt(this.minute);
    this._tc = { m: this.minute, s: this.season.startMinute, v };
    return v;
  }
  airAt(m) {
    const W = T.weather, f = (m - this.season.startMinute) / (this.settings.seasonDays * 1440);
    return tempAt(this.seed, m) - W.springChill * clamp01((0.25 - f) / 0.25) - W.autumnChill * clamp01((f - 0.8) / 0.2);
  }
  // How fast the brood develops at a minute (GDD 6.6, T1-14): full speed in a comfortable nest; cold snaps and heat
  // slow it, as much as the site lets the weather in. An attic heats up on sunny afternoons.
  broodSpeed(m = this.minute) {
    const H = T.thermal, S = T.sites[this.nest.site || 'trunk'], d = minuteOfDay(m);
    const air = this.airAt(m) + S.heat * Math.max(0, dsin(TAU * (d - 540) / 1440)) * (isRaining(this.seed, m) ? 0 : 1);
    const cold = clamp01((H.coldFrom - air) / H.coldSpan), hot = clamp01((air - H.hotFrom) / H.hotSpan) * H.hotWeight;
    return Math.max(H.minSpeed, 1 - (1 - S.insulation) * (cold + hot));
  }
  get wind() {
    const c = this._wc;
    if (c && c.m === this.minute) return c.v;
    const v = windAt(this.seed, this.minute);
    this._wc = { m: this.minute, v };
    return v;
  }
  get raining() { return isRaining(this.seed, this.minute); }
  get physicalCount() { return this._own().length; }
  _own() { return this.wasps.filter((w) => w.colony === 'own'); }
  get seasonFrac() { return (this.minute - this.season.startMinute) / (this.settings.seasonDays * 1440); }
  canFly() { return this.temperature >= T.weather.flyMinTemp; }

  _spawnWasp(driven, caste = 'worker') {
    const id = this.nextWaspId++;
    const w = {
      id, caste, x: this.nest.spawn.x, y: this.nest.spawn.y, z: this.nest.spawn.z, vx: 0, vy: 0, vz: 0, yaw: this.nest.spawn.yaw, pitch: 0,
      energy: 1, venom: 1, bodyT: T.cold.nestTemp, chill: 0, state: 'fly', stateTicks: 0, attach: null, under: null, ball: null, born: this.minute,
      carry: null, groundTicks: 0, chew: 0, role: 'sugar', colony: 'own', web: null, fight: null, land: null,
      ai: { mode: 'pick', target: null, timer: 0, humanHex: null, stings: 0, stingHold: 0 },
    };
    if (!driven) {
      const a = T.alloc[this.colony.alloc], s = a.sugar + a.protein + a.pulp, r = h32(id, 77) * s;
      w.role = r < a.sugar ? 'sugar' : r < a.sugar + a.protein ? 'protein' : 'pulp';
      w.x = this.nest.entrance.x; w.y = this.nest.entrance.y - 0.03; w.z = this.nest.entrance.z;
    }
    this.wasps.push(w);
    this.wasps.sort(byId);
    this.emit('waspSpawn', { id, driven, caste });
    return w;
  }

  // ---------------------------------------------------------------- chunks and humans

  _updateChunks(force = false) {
    const w = this._driven() || this.ghost || this.nest.spawn;
    const ccx = chunkOf(w.x), ccz = chunkOf(w.z);
    const key = chunkKey(ccx, ccz);
    if (key === this.activeKey && !force) return;
    const changed = key !== this.activeKey;
    this.activeKey = key;
    const D = T.chunk.discoverRadius, A = T.chunk.activeRadius;
    for (let dz = -D; dz <= D; dz++) for (let dx = -D; dx <= D; dx++) this._discover(ccx + dx, ccz + dz);
    const act = [];
    for (let dz = -A; dz <= A; dz++) for (let dx = -A; dx <= A; dx++) act.push(this.records.get(chunkKey(ccx + dx, ccz + dz)));
    this.activeChunks = act;
    this.emit('chunksActive', { key });
    if (changed && this.interest.get(this.peer) !== key) this._publish({ type: 'interest', key });
    if (force) this._rebuildHumans();
  }

  // The humans every peer simulates: those in the 3x3 window around any peer's committed interest
  _rebuildHumans() {
    const A = T.chunk.activeRadius, keys = new Set();
    for (const k of this.interest.values()) {
      const [cx, cz] = k.split(',').map(Number);
      for (let dz = -A; dz <= A; dz++) for (let dx = -A; dx <= A; dx++) keys.add(chunkKey(cx + dx, cz + dz));
    }
    const before = new Set(this.active);
    const list = [];
    for (const k of [...keys].sort()) {
      const [cx, cz] = k.split(',').map(Number);
      this._discover(cx, cz);
      const rec = this.records.get(k);
      for (const hs of rec.content.humans) {
        const id = hash(this.seed, Domain.WorldGen, u64(rec.cx), u64(rec.cz), BigInt(hs.slot));
        const hex = hex64(id);
        let hm = this.humans.get(hex);
        if (!hm) {
          const tr = this.traitsFor(id);
          const ax = hs.x + T.panic.approachDist * dcos(hs.exit), az = hs.z + T.panic.approachDist * dsin(hs.exit);
          hm = {
            id, hex, short: hex.slice(0, 4), tr, clothing: humanClothing(this.seed, id, this.day), chunk: k,
            home: { x: hs.x, z: hs.z, fx: hs.fx, fz: hs.fz, posture: hs.posture, ax, az },
            x: hs.x, z: hs.z, fx: hs.fx, fz: hs.fz, posture: hs.posture,
            state: 'idle', panic: 0, fleeSteps: 0, dirX: 0, dirZ: 0, stungCount: 0, winDay: -1, win: null,
            annoyId: 0, annoy: 0, cooldown: 0, sprayCount: 0, fetchT: 0, wantSpray: false, clothesDay: this.day,
            parts: { sit: bodyParts(tr, 'sit'), stand: bodyParts(tr, 'stand') },
          };
          this.humans.set(hex, hm);
        }
        if (!before.has(hm)) this._catchUpHuman(hm);
        list.push(hm);
      }
    }
    if (this.ext.hm) list.push(this.ext.hm);
    list.sort(byHumanId);
    this.active = list;
    this.emit('humansActive', { count: list.length });
  }

  _window(hm) {
    if (hm.winDay !== this.day) { hm.winDay = this.day; hm.win = hm.special ? null : humanWindow(this.seed, hm.id, this.day, this.settings.humanDensity); }
    return hm.win;
  }

  // On (re)activation, put a human where their schedule says they are (GDD 8.2)
  _catchUpHuman(hm) {
    if (hm.special) return;
    const w = this._window(hm), m = minuteOfDay(this.minute);
    const present = w && m >= w.arrive && m < w.leave;
    if (present && (hm.state === 'away' || hm.state === 'leave')) this._seat(hm);
    if (!present && hm.state !== 'away') this._goAway(hm);
  }
  _seat(hm) {
    const h = hm.home;
    hm.x = h.x; hm.z = h.z; hm.fx = h.fx; hm.fz = h.fz; hm.posture = h.posture; hm.state = 'idle';
    if (hm.clothesDay !== this.day) { hm.clothing = humanClothing(this.seed, hm.id, this.day); hm.clothesDay = this.day; }
  }
  _goAway(hm) { hm.x = hm.home.ax; hm.z = hm.home.az; hm.state = 'away'; hm.posture = 'stand'; hm.panic = 0; }
  present(hm) { return hm.state !== 'away'; }

  _discover(cx, cz) {
    const key = chunkKey(cx, cz);
    if (this.records.has(key)) return;
    const content = generateChunk(this.seed, cx, cz);
    const rec = { cx, cz, genVersion: GEN_VERSION, discoveredTick: this.tick, contentHash: fnv32(JSON.stringify(content)), content };
    this.records.set(key, rec);
    this.emit('chunkDiscovered', { cx, cz });
  }

  // ---------------------------------------------------------------- step

  step(cmd) {
    this._record(cmd);
    this.tick++;
    const m = clockMinutes(this.tick + this.clockOffset, this.settings);
    if (m !== this.minute) this._minute(m);
    this._applyPending();
    if (this.remote.size) this._extrapolateRemote();

    const act = cmd.act | 0, edge = act & ~this.prevAct;
    this.prevAct = act;
    if (cmd.alloc > 0 && cmd.alloc <= T.alloc.length && this.colony.alloc !== cmd.alloc - 1) { this.colony.alloc = cmd.alloc - 1; this.emit('alloc', { preset: this.colony.alloc }); }
    let pick = cmd.pick | 0;
    if (this.winter) { this._winterStep(pick); pick = 0; } // in winter a pick chooses the queen (T1-15)
    if (edge & Act.Switch) this._possessNearest();
    else if (pick > 0 && pick !== this.drivenId) this._possessNearest(pick);
    this._pendingSwitchTick();
    if (edge & Act.Rest) this._rest();
    if (!cmd.sting) this.pressUsed = false;

    // 1. wasps, in id order
    const driven = this._driven();
    this.hint = {};
    for (const w of this.wasps.slice()) {
      if (!this.wasps.includes(w)) continue;
      if (w === driven) this._stepWasp(w, cmd, edge, true);
      else this._stepWasp(w, this._think(w), 0, false);
    }
    // 2. swats, sprays, bees: every tick
    this._swats();
    this._sprays();
    this._bees();
    this._birds();
    this._dragonflies();
    this._fights(cmd);
    this._alarmDecay();
    // 3. humans at 20 Hz
    if (this.tick % 3 === 0) this._humans();
    // 4. colony at 1 Hz
    if (this.tick % 60 === 0) this._colonyTick();
    // 5. respawn of the driven wasp
    if (!this._driven() && !this.extinct && !this.winter && this.tick >= this.respawnAt) this._respawn();
    this._updateChunks();
    if (this.net && this.tick % T.net.stateEvery === 0) this._sendState();
  }

  // ---------------------------------------------------------------- networking (GDD 11)

  // Every change to shared world state is an event. Its immediate part (swats, sprays) runs as soon as a
  // peer has it; its human-state part (panic, flight, counters, alert points) commits on one agreed tick,
  // T.net.commitTicks after it happened, so every peer applies it identically (GDD 11.5).
  _publish(ev) {
    ev.mk = 'ev'; ev.peer = this.peer; ev.seq = ++this.evSeq; ev.tick = this.tick;
    ev.commit = this.tick + T.net.commitTicks;
    if (this.net) { this.outbox.push(ev); this.netStats.sent++; }
    this._applyImmediate(ev);
    if (!IMMEDIATE.has(ev.type)) this._schedule(ev);
  }

  _schedule(ev) {
    const before = (a, b) => a.commit !== b.commit ? a.commit < b.commit : a.peer !== b.peer ? a.peer < b.peer : a.seq < b.seq;
    let i = this.pending.length;
    while (i > 0 && before(ev, this.pending[i - 1])) i--;
    this.pending.splice(i, 0, ev);
  }

  receive(msgs) {
    for (const m of msgs) {
      this.netStats.recv++;
      if (this.plaus.quarantined.includes(m.peer)) { this.netStats.dropped++; continue; }
      if (m.mk === 'state') { this._remoteState(m); continue; }
      const why = this._implausible(m);
      if (why) { this._strike(m.peer, m.type, why); continue; }
      this._applyImmediate(m);
      if (IMMEDIATE.has(m.type)) continue;
      if (m.commit < this.tick) { this.netStats.late++; this.netStats.lateMax = Math.max(this.netStats.lateMax, this.tick - m.commit); this.emit('lateEvent', { type: m.type, by: this.tick - m.commit }); }
      this._schedule(m);
    }
  }

  _applyPending() {
    while (this.pending.length && this.pending[0].commit <= this.tick) this._applyCommit(this.pending.shift());
  }

  _sendState() {
    const wasps = this.wasps.map((w) => ({
      id: w.id, caste: w.caste, x: w.x, y: w.y, z: w.z, vx: w.vx, vy: w.vy, vz: w.vz, state: w.state,
      carry: w.carry ? w.carry.what : null, under: w.under ? w.under.hex : null, rival: w.colony !== 'own',
    }));
    this.outbox.push({ mk: 'state', peer: this.peer, tick: this.tick, wasps });
  }

  // GDD 11.8. Checks on events read only the event and shared human state, so every honest peer drops the same ones.
  _implausible(ev) {
    const P = T.plaus, last = this.plaus.lastSeq[ev.peer] || 0;
    if (typeof ev.tick !== 'number' || ev.commit !== ev.tick + T.net.commitTicks) return 'commit tick';
    if (ev.seq <= last) return 'replayed or out of order';
    this.plaus.lastSeq[ev.peer] = ev.seq;
    if (ev.tick > this.tick + P.futureTicks) return 'from the future';
    if (ev.type === 'quarantine' && ev.peer !== this.host) return 'only the host rules on peers';
    if (ev.type === 'sting' || ev.type === 'notice' || ev.type === 'press' || ev.type === 'preSwat') {
      const hm = this.humanByHex(ev.humanHex);
      const swats = ev.swats || (ev.type === 'preSwat' ? [{ start: ev.start }] : []);
      if (swats.length > P.maxSwats) return 'too many swats';
      for (const sw of swats) if (sw.start - ev.tick < (ev.type === 'sting' ? T.resolve.minConsequenceTicks : 0) || sw.start - ev.tick > P.maxSwatDelay) return 'swat timing';
      if (ev.type === 'sting') {
        if (!(ev.panicGain >= 0 && ev.panicGain <= 1)) return 'panic out of range';
        if (hm && typeof ev.sx === 'number') {
          const drift = P.humanDrift * Math.max(0, this.tick - ev.tick) / 60;
          if (Math.sqrt(sq(ev.sx - hm.x) + sq(ev.sz - hm.z)) > P.stingReach + drift) return 'stung from out of reach';
        }
        const k = ev.peer + ':' + ev.waspId, ts = (this.plaus.stingTicks[k] || []).filter((t) => t > ev.tick - P.rateWindow);
        ts.push(ev.tick); this.plaus.stingTicks[k] = ts;
        if (ts.length > P.rateMax) return 'stinging faster than venom allows';
      }
    }
    return null;
  }

  // Every peer drops implausible events the same way, but only the host rules on a peer: it publishes the verdict as
  // a committed event, so every peer cuts the cheater off on the same tick and purges the same pending events.
  _strike(peer, type, why) {
    this.netStats.rejected++;
    const n = (this.plaus.strikes[peer] || 0) + 1;
    this.plaus.strikes[peer] = n;
    this.emit('implausible', { peer, evType: type, why, strikes: n });
    if (n < T.plaus.strikes || this.plaus.quarantined.includes(peer) || (this.plaus.ruled || []).includes(peer)) return;
    if (!this.net) { this._quarantine(peer); return; }
    if (this.peer !== this.host) return;
    (this.plaus.ruled || (this.plaus.ruled = [])).push(peer);
    this._publish({ type: 'quarantine', target: peer, why });
  }

  _quarantine(peer) {
    if (this.plaus.quarantined.includes(peer)) return;
    this.plaus.quarantined.push(peer);
    for (const [id, r] of this.remote) if (r.peer === peer) this.remote.delete(id);
    // whatever it sent that has not committed yet is void on every peer alike
    this.pending = this.pending.filter((e) => e.peer !== peer);
    this.interest.delete(peer);
    this.emit('quarantine', { peer, me: peer === this.peer });
  }

  _remoteState(m) {
    const ids = new Set();
    for (const r of m.wasps) {
      const prev = this.remote.get(r.id);
      // display only: a wasp that moved faster than any wasp can is not drawn there (local, so it cannot desync)
      if (prev && prev.peer === m.peer && m.tick > prev.stamp) {
        const v = Math.sqrt(sq(r.x - prev.px) + sq(r.y - prev.py) + sq(r.z - prev.pz)) / ((m.tick - prev.stamp) / 60);
        if (v > T.plaus.maxSpeed && (prev.bad = (prev.bad || 0) + 1) < 4) { this.netStats.dropped++; ids.add(r.id); prev.seen = this.tick; continue; }
        prev.bad = 0;
      }
      ids.add(r.id);
      const e = this.remote.get(r.id) || {};
      Object.assign(e, r, { peer: m.peer, stamp: m.tick, px: r.x, py: r.y, pz: r.z, seen: this.tick });
      this.remote.set(r.id, e);
    }
    for (const [id, e] of this.remote) if (e.peer === m.peer && !ids.has(id) && e.stamp < m.tick) this.remote.delete(id);
  }

  // Remote wasps are drawn where they probably are now: last state plus velocity (GDD 11.4)
  _extrapolateRemote() {
    for (const [id, e] of this.remote) {
      if (this.tick - e.seen > T.net.remoteTimeout) { this.remote.delete(id); continue; }
      const dt = (this.tick - e.stamp) / 60;
      const moving = e.state === 'fly' || e.state === 'stunned';
      e.x = e.px + (moving ? e.vx * dt : 0); e.y = Math.max(T.wasp.radius, e.py + (moving ? e.vy * dt : 0)); e.z = e.pz + (moving ? e.vz * dt : 0);
    }
  }

  _anyWasp(id) { return this.waspById(id) || this.remote.get(id) || null; }

  _applyImmediate(ev) {
    const mine = ev.peer === this.peer;
    switch (ev.type) {
      case 'sting': {
        const hm = this.humanByHex(ev.humanHex);
        if (!hm) break;
        for (const s of ev.swats) this.swats.push({ ...s, frameHex: hm.hex, stungHex: hm.hex, contactTick: ev.tick, hits: [], underOnly: ev.under ? ev.waspId : 0, byWasp: ev.waspId, why: ev.under ? 'stungUnder' : 'stung' });
        if (!mine) this.emit('remoteSting', { waspId: ev.waspId, humanHex: hm.hex, zone: ev.zone, contactTick: ev.tick, under: ev.under, swats: ev.swats });
        break;
      }
      case 'preSwat': {
        const hm = this.humanByHex(ev.humanHex);
        if (!hm) break;
        this.swats.push({
          actorId: hm.id, actorHex: hm.hex, frameHex: hm.hex, stungHex: hm.hex, kind: ev.kind, start: ev.start, window: ev.window,
          center: ev.center, radius: ev.radius, kills: ev.kills, contactTick: ev.tick, hits: [], pre: true, targetId: ev.waspId, underOnly: 0, why: ev.why,
        });
        if (mine) hm.cooldown = Math.max(hm.cooldown, ev.tick + T.esc.cooldownTicks);
        this.emit('preSwat', { humanHex: hm.hex, waspId: ev.waspId, kind: ev.kind, start: ev.start, window: ev.window, center: ev.center, why: ev.why, contactTick: ev.tick });
        break;
      }
      case 'press': {
        const hm = this.humanByHex(ev.humanHex);
        if (!hm) break;
        for (const s of ev.swats) this.swats.push({ ...s, actorHex: hm.hex, frameHex: hm.hex, stungHex: hm.hex, contactTick: ev.tick, hits: [], underOnly: ev.waspId, byWasp: ev.waspId, why: 'felt under clothing' });
        this.emit('press', { humanHex: hm.hex, start: ev.swats[0].start, center: ev.swats[0].center, contactTick: ev.tick });
        break;
      }
      case 'spray':
        this.sprays.push({ hex: ev.humanHex, start: ev.start, end: ev.end });
        this.emit('spray', { humanHex: ev.humanHex });
        break;
      case 'notice': {
        const hm = this.humanByHex(ev.humanHex);
        if (!hm) break;
        for (const s of ev.swats) this.swats.push({ ...s, frameHex: hm.hex, stungHex: hm.hex, contactTick: ev.tick, hits: [], underOnly: 0, byWasp: ev.waspId, pre: true, why: 'felt' });
        this.emit('notice', { humanHex: hm.hex, waspId: ev.waspId, zone: ev.zone, swats: ev.swats, contactTick: ev.tick });
        break;
      }
      // Fights between a rival (owned by the world-authority peer) and another peer's wasp (GDD 9.3, 11.6).
      // Each peer decides only about its own wasp; both compute the same winner from published values.
      case 'fight': {
        if (mine || ev.toPeer !== this.peer) break;
        const w = this.waspById(ev.b);
        if (w && (w.state === 'fly' || w.state === 'landed' || w.state === 'chewing')) {
          w.state = 'fighting'; w.vx = w.vy = w.vz = 0;
          w.fight = { other: ev.a, remote: true, peer: ev.peer, start: ev.tick, until: this.tick + T.rival.fightTicks, mash: 0, theirVenom: ev.venom, theirQueen: ev.queen, myVenom: w.venom };
          this._publish({ type: 'fightJoin', a: ev.a, b: ev.b, toPeer: ev.peer, venom: w.venom, queen: w.caste === 'queen' });
          this.emit('fight', { a: ev.a, b: ev.b, driven: w.id === this.drivenId, remote: true });
        } else this._publish({ type: 'fightRefuse', a: ev.a, b: ev.b, toPeer: ev.peer });
        break;
      }
      case 'raid': // another player robbed a rival nest whose workers live on this peer: send them after the thief
        if (!mine) this._rivalsHunt(ev.key, ev.id, ev);
        break;
      case 'fightReq': {
        // another peer's wasp touched one of my rivals on its own screen: start the fight if the rival is free
        if (mine || ev.toPeer !== this.peer) break;
        const a = this.waspById(ev.a);
        if (a && a.colony !== 'own' && (a.state === 'fly' || a.state === 'landed' || a.state === 'chewing')) this._startRemoteFight(a, ev.b, ev.peer);
        break;
      }
      case 'fightJoin': {
        if (mine || ev.toPeer !== this.peer) break;
        const w = this.waspById(ev.a);
        if (w && w.fight && w.fight.other === ev.b) { w.fight.theirVenom = ev.venom; w.fight.theirQueen = ev.queen; }
        break;
      }
      case 'fightRefuse': {
        if (mine || ev.toPeer !== this.peer) break;
        const w = this.waspById(ev.a);
        if (w && w.fight && w.fight.other === ev.b) { w.state = 'fly'; w.fight = null; }
        break;
      }
      case 'fightEnd': {
        if (mine || ev.toPeer !== this.peer) break;
        const w = this.waspById(ev.a);
        if (!w || !w.fight || w.fight.other !== ev.b) break;
        const f = w.fight;
        const aWins = this._fightScore(w.id, f.myVenom, w.caste === 'queen', 0, f.start) >= this._fightScore(ev.b, ev.venom, ev.queen, ev.mash, f.start);
        this._fightResolve(w, aWins, ev.b);
        break;
      }
      case 'caught': {
        if (mine) break;
        const st = this.cs(ev.key);
        if (ev.what === 'fly') st.caughtFly[ev.i] = ev.tick + T.prey.flyRespawnTicks;
        else if (ev.what === 'caterpillar') st.caughtCat[ev.i] = 1;
        else if (ev.what === 'carrion') { const cr = st.carrion || (st.carrion = {}); cr[ev.i] = (cr[ev.i] || 0) + 1; }
        else if (ev.what === 'honey') { const rb = st.robbed || (st.robbed = {}); rb[ev.i] = (rb[ev.i] || 0) + 1; }
        else (st.beeLost[ev.hive] || (st.beeLost[ev.hive] = {}))[ev.i] = 1;
        break;
      }
      case 'sip': // another player's wasp drank from a flower (T1-8)
        if (!mine && this.records.get(ev.key)) this._sip(ev.key, ev.i, ev.amount);
        break;
      case 'beeAlarm': {
        if (mine || !this.records.get(ev.key)) break;
        const t = this.remote.get(ev.target);
        if (t) this._alarmHive(ev.key, ev.h, t, ev.radius, true);
        break;
      }
      case 'died':
        if (!mine) { this.remote.delete(ev.waspId); this.emit('remoteDied', { waspId: ev.waspId, cause: ev.cause, x: ev.x, y: ev.y, z: ev.z }); }
        break;
    }
  }

  _applyCommit(ev) {
    const mine = ev.peer === this.peer;
    switch (ev.type) {
      case 'quarantine':
        if (ev.peer === this.host) this._quarantine(ev.target);
        break;
      case 'sting': {
        const hm = this.humanByHex(ev.humanHex);
        if (!hm) break;
        hm.panic = Math.min(1, hm.panic + ev.panicGain);
        hm.stungCount++;
        (hm.mem || (hm.mem = [])).push({ m: this.minute, x: hm.x, z: hm.z });
        if (hm.mem.length > T.memory.keep) hm.mem.shift();
        const first = !this.stung.has(hm.hex);
        this.stung.add(hm.hex);
        if (!mine) this.stats.remoteStings++; else if (ev.driven) this.stats.stings++; else this.stats.aiStings++;
        this.addEsc(hm.x, hm.z, T.esc.sting);
        this.cs(hm.chunk).lastSting = { x: ev.sx, z: ev.sz };
        // at level 3 a person with it in them goes for a can once things calm down (T1-6)
        if (!hm.special && !(hm.sprayCount > 0) && hm.tr.escalation >= T.esc.sprayTrait && this.escAt(hm.x, hm.z) >= 3) hm.wantSpray = true;
        this.emit('sting', { waspId: ev.waspId, remote: !mine, driven: mine && ev.driven, humanHex: hm.hex, zone: ev.zone, first, under: ev.under });
        if (ev.flee && hm.state === 'idle') this._startFlee(hm, { x: ev.sx, z: ev.sz });
        break;
      }
      case 'deepen': {
        const hm = this.humanByHex(ev.humanHex);
        if (!hm) break;
        hm.panic = Math.min(1, hm.panic + ev.extra);
        this.addEsc(hm.x, hm.z, T.esc.full);
        this.emit('deepen', { humanHex: hm.hex, zone: ev.zone });
        if (hm.panic >= T.resolve.fleePanic && hm.state === 'idle') this._startFlee(hm, { x: ev.sx, z: ev.sz });
        break;
      }
      case 'preSwat': {
        const hm = this.humanByHex(ev.humanHex);
        if (hm) this.addEsc(hm.x, hm.z, T.esc.nuisance);
        break;
      }
      case 'cover': {
        // a hand goes over the cup on the agreed tick; whoever is inside is shut in (GDD 7.5)
        const st = this.cs(ev.key), cv = st.cover || (st.cover = {});
        cv[ev.i] = Math.max(cv[ev.i] || 0, ev.end);
        this.emit('cover', { humanHex: ev.humanHex, key: ev.key, i: ev.i });
        break;
      }
      case 'spray': {
        // the can empties on the agreed tick, so every peer counts the same sprays (T1-6)
        const hm = this.humanByHex(ev.humanHex);
        if (hm && hm.sprayCount > 0) hm.sprayCount--;
        break;
      }
      case 'rip': {
        const hm = this.humanByHex(ev.humanHex);
        if (!hm || hm.clothing.topOff) break;
        hm.clothing = { ...hm.clothing, topOff: true, stiffness: 0 };
        this.emit('rip', { humanHex: hm.hex });
        if (hm.state === 'idle') this._startFlee(hm, { x: ev.sx, z: ev.sz });
        break;
      }
      case 'killed': {
        const hm = this.humanByHex(ev.byHex);
        if (hm) this.addEsc(hm.x, hm.z, T.esc.death);
        break;
      }
      case 'interest':
        this.interest.set(ev.peer, ev.key);
        this._rebuildHumans();
        break;
      case 'notice': {
        const hm = this.humanByHex(ev.humanHex);
        if (!hm) break;
        hm.panic = Math.min(1, hm.panic + T.perch.panic * hm.tr.panicSusceptibility);
        this.addEsc(hm.x, hm.z, T.esc.nuisance);
        break;
      }
    }
  }

  // Agreement check between peers: everything about the shared humans
  humanHash() {
    const buf = new Float64Array(1), bytes = new Uint8Array(buf.buffer);
    let h = 0x811c9dc5;
    const f = (v) => { buf[0] = v; for (let i = 0; i < 8; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } };
    const states = ['away', 'arrive', 'idle', 'flee', 'return', 'leave', 'treat', 'fetch', 'seek', 'watch'];
    // the exterminator works for one colony and searches by what that colony does (T1-7), so he is not a shared human
    for (const hm of this.active) { if (hm.special) continue; f(hm.x); f(hm.z); f(hm.panic); f(states.indexOf(hm.state)); f(hm.stungCount); f(hm.clothing.topOff ? 1 : 0); f(hm.sprayCount || 0); }
    // alert points, in key order; chunks a peer never touched count as zero on both sides
    for (const [k, st] of [...this.chunkState].filter(([, x]) => x.esc > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      f(k.length); f(st.esc);
      if (st.spilled) for (const i of Object.keys(st.spilled).sort()) { f(+i); f(st.spilled[i]); }
      if (st.cover) for (const i of Object.keys(st.cover).sort()) { f(+i); f(st.cover[i]); }
    }
    f(this.stung.size);
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  _record(cmd) {
    if (this.logLen + CMD_FIELDS > this.log.length) { const n = new Int32Array(this.log.length * 2); n.set(this.log); this.log = n; }
    const L = this.log, i = this.logLen;
    L[i] = cmd.mx | 0; L[i + 1] = cmd.my | 0; L[i + 2] = cmd.mz | 0; L[i + 3] = cmd.burst ? 1 : 0; L[i + 4] = cmd.sting ? 1 : 0;
    L[i + 5] = cmd.yawQ | 0; L[i + 6] = cmd.pitchQ | 0; L[i + 7] = cmd.act | 0; L[i + 8] = cmd.alloc | 0; L[i + 9] = cmd.pick | 0;
    this.logLen += CMD_FIELDS;
  }
  static cmdAt(log, t) {
    const i = t * CMD_FIELDS;
    return { mx: log[i], my: log[i + 1], mz: log[i + 2], burst: log[i + 3], sting: log[i + 4], yawQ: log[i + 5], pitchQ: log[i + 6], act: log[i + 7], alloc: log[i + 8], pick: log[i + 9] };
  }

  _minute(m) {
    const newDay = dayOf(m);
    this.minute = m;
    if (newDay !== this.day) {
      const days = newDay - this.day;
      this.day = newDay;
      let k = 1;
      for (let i = 0; i < days; i++) k *= 1 - T.esc.decayPerDay;
      for (const s of this.chunkState.values()) { s.esc *= k; s.beeLost = {}; s.caughtCat = {}; s.robbed = {}; }
      this.emit('newDay', { day: newDay });
    }
  }

  // ---------------------------------------------------------------- possession and rest (GDD 7.7)

  // Q-03 settled: any worker within 30 m is free to take. Beyond that the colony relays you, after a delay, to the
  // nearest worker anywhere, or to a worker inside the nest who comes out.
  _possessNearest(pick = 0) {
    const d = this._driven();
    if (!d || d.state === 'under' || d.state === 'balled') return;
    if (this.pendingSwitch) { const same = pick && this.pendingSwitch.target === pick; this.pendingSwitch = null; this.emit('switchCancelled'); if (!pick || same) return; }
    let best = null, bd = Infinity;
    if (pick) {
      // the colony view asked for this one
      const w = this.waspById(pick);
      if (!w || w.colony !== 'own' || w === d) return;
      best = w; bd = dist2(w, d);
    } else for (const w of this.wasps) {
      if (w === d || w.state === 'dead' || w.colony !== 'own') continue;
      const q = dist2(w, d);
      if (q < bd) { bd = q; best = w; }
    }
    const P = T.possess;
    if (best && bd <= P.freeRange * P.freeRange) { this._possess(d, best); return; }
    const inside = this.colony.nestAlive && this.colony.sited !== false && this.colony.adults - this._own().filter((x) => x.caste !== 'queen').length >= 1;
    if (!best && !inside) { this.emit('noSwitch'); return; }
    this.pendingSwitch = { at: this.tick + P.relayTicks, target: best ? best.id : 0 };
    this.emit('switchPending', { seconds: P.relayTicks / 60, toNest: !best });
  }

  _possess(d, best) {
    d.ai = { mode: 'pick', target: null, timer: 0, humanHex: null, stings: 0, stingHold: 0 };
    if (d.state === 'attached') this._detach(d, null);
    this.drivenId = best.id;
    if (best.state === 'attached') this._detach(best, null);
    this.emit('possess', { id: best.id, from: d.id });
  }

  _pendingSwitchTick() {
    const ps = this.pendingSwitch;
    if (!ps || this.tick < ps.at) return;
    this.pendingSwitch = null;
    const d = this._driven();
    if (!d) return;
    let to = ps.target ? this.waspById(ps.target) : null;
    if (!to) {
      if (!(this.colony.nestAlive && this.colony.adults - this._own().filter((x) => x.caste !== 'queen').length >= 1)) { this.emit('noSwitch'); return; }
      to = this._spawnWasp(true); // a worker from inside the nest
    }
    this._possess(d, to);
  }

  _rest() {
    if (this.net) { this.emit('cantRest', { why: 'net' }); return; }
    const d = this._driven();
    if (!d || dist2(d, this.nest.entrance) > 0.4 * 0.4) { this.emit('cantRest', { why: 'away' }); return; }
    const md = minuteOfDay(this.minute);
    if (md >= T.time.dawn && md < T.time.dusk) { this.emit('cantRest', { why: 'day' }); return; }
    const target = (md >= T.time.dusk ? this.day + 1 : this.day) * 1440 + T.time.dawn;
    const skipMin = target - this.minute;
    const skipTicks = skipMin * this.tpm;
    this.clockOffset += skipTicks;
    // the colony lives through the skipped time
    const steps = Math.floor(skipTicks / 60), dtDay = 60 / this.dayTicks;
    const m0 = this.minute, frac0 = this.seasonFrac;
    for (let i = 0; i < steps; i++) colonyStep(this.colony, dtDay, this.wasps.length, false, frac0, this.bio, this.broodSpeed(m0 + Math.floor(i * 60 / this.tpm)));
    for (const w of this.wasps.slice()) if (w !== d) this._despawn(w);
    this._minute(clockMinutes(this.tick + this.clockOffset, this.settings));
    for (const hm of this.active) this._catchUpHuman(hm);
    d.energy = Math.max(d.energy, T.energy.nestRefill);
    this.emit('rested', { minutes: skipMin });
  }

  // ---------------------------------------------------------------- one wasp per tick

  // A worker's span is that of her sisters (GDD 7.5): 1/adultMortality days, scaled to the season, ±20% by hash.
  lifespanMinutes(w) { return (1 / T.colony.adultMortality) * this.bio * 1440 * (0.8 + 0.4 * h32(w.id, 7)); }

  _stepWasp(w, cmd, edge, driven) {
    if (driven && w.caste !== 'queen' && w.colony === 'own' && this.minute - (w.born ?? this.minute) > this.lifespanMinutes(w) && (w.state === 'fly' || w.state === 'landed')) {
      this._die(w, 'old age', null);
      return;
    }
    const armed = driven ? cmd.sting && !this.pressUsed : cmd.sting;
    switch (w.state) {
      case 'fly':
      case 'stunned':
        this._flight(w, cmd);
        if (w.state === 'stunned' && --w.stateTicks <= 0) { w.state = 'fly'; this.emit('recovered', { id: w.id }); }
        if (w.state !== 'fly') break;
        if (driven || w.ai.mode === 'attack') this._contactQuery(w); else w.contact = null;
        this._feed(w, driven);
        if (w.state !== 'fly') break;
        this._nestTouch(w);
        if (driven) {
          if (edge & Act.Interact) this._interact(w);
          if (w.state === 'fly' && armed && w.contact) { this.pressUsed = true; this._beginSting(w, w.contact, 'jab'); }
          if (w.state === 'fly') this._maybeLand(w, cmd);
          this._hints(w);
        } else if (armed && w.contact && w.contact.humanHex === w.ai.humanHex) this._beginSting(w, w.contact, 'jab');
        break;
      case 'landed': {
        // Walk on the surface with the move keys, at any angle; only climb (Space) or burst (Shift) take off (GDD 7.2)
        if (!driven || cmd.my > 0 || cmd.burst) { this._takeoff(w); break; }
        if (armed) {
          // a sting reaches a person close by: a leg next to the bench, an arm on the table
          this.pressUsed = true;
          this._contactQuery(w, T.land.stingReach);
          const c = w.contact;
          w.contact = null;
          if (c && this._beginSting(w, c, 'jab')) { w.land = null; w.walking = false; break; }
        }
        if (edge & Act.Interact) { this._interact(w); if (w.state !== 'landed') break; }
        this._nestTouch(w); // landed at the entrance: in with the load
        this._turn(w, cmd);
        w.walking = false;
        if (cmd.mx || cmd.mz) this._walk(w, cmd);
        if (w.state !== 'landed') break;
        if (this._cupCheck(w)) break;
        this._feed(w, driven);
        if (w.state !== 'landed') break;
        this._hints(w);
        break;
      }
      case 'webbed': this._webStep(w, cmd, driven); break;
      case 'drowning': this._drownStep(w, cmd, driven); break;
      case 'robbing': this._robStep(w, cmd, driven); break;
      case 'perched': this._perchStep(w, cmd, edge, armed, driven); break;
      case 'fighting': if (driven && cmd.sting && !this.pressUsed) { this.pressUsed = true; w.fight.mash += T.rival.mash; } break;
      case 'attached': this._attached(w, cmd, driven); break;
      case 'under': this._underStep(w, cmd, edge, armed); break;
      case 'chewing': this._chewStep(w, cmd, driven); break;
      case 'trapped':
        if (--w.stateTicks <= 0) this._die(w, w.trapCause || 'drowned in a trap', null);
        break;
      case 'balled':
        if (driven) { this._ballEscape(w, cmd.burst && !w.ball.prevBurst); if (w.ball) w.ball.prevBurst = cmd.burst; }
        break;
    }
    if (this.waspById(w.id)) {
      w.venom = Math.min(w.caste === 'queen' ? T.queen.venomMul : 1, w.venom + T.venom.regenPerSec * DT);
      this._bodyHeat(w);
    }
  }

  // Body temperature (GDD 7.1, T1-2): flight muscles heat a flying wasp, a resting one shivers to stay ready
  // (burning sugar), human skin and a bee ball set it outright. Below the flight temperature a wasp cannot take
  // off; in cold torpor it dies unless it finds warmth.
  _bodyHeat(w) {
    const C = T.cold, air = this.temperature;
    let target;
    const flying = (w.state === 'fly' || w.state === 'stunned') && w.energy > 0 && w.bodyT >= C.flyBody;
    switch (flying ? 'flying' : w.state) {
      case 'flying': target = air + C.flightHeat; break;
      case 'attached': case 'perched': case 'under': target = C.skinTemp; break;
      case 'balled': target = w.ball ? w.ball.temp : air; break;
      default: {
        // shivering warms a resting wasp, but not in real cold
        const shiver = w.energy > 0 && w.bodyT < C.flyBody + 2 && air >= C.shiverMinAir;
        if (shiver) w.energy = Math.max(0, w.energy - T.energy.cruisePerSec * DT * T.energy.hoverShare * C.shiverCost);
        target = air + (shiver ? C.shiverHeat : 0);
      }
    }
    w.bodyT += (target - w.bodyT) * C.rate;
    if (w.bodyT < C.torpor) {
      if (++w.chill > C.lethalTicks) this._die(w, 'cold', null);
    } else if (w.chill > 0) w.chill--;
  }

  // ---------------- flight (GDD 7.2)

  _flight(w, cmd) {
    const W = T.wasp;
    const powered = w.state === 'fly' && w.energy > 0 && w.bodyT >= T.cold.flyBody;
    const rain = this.raining;
    let burst = powered && cmd.burst;
    let dx, dy, dz;
    if (cmd.dirX !== undefined) {
      dx = cmd.dirX * cmd.throttle; dy = cmd.dirY * cmd.throttle; dz = cmd.dirZ * cmd.throttle;
    } else {
      w.yaw = cmd.yawQ * 1e-4;
      w.pitch = clamp(cmd.pitchQ * 1e-4, -1.45, 1.45);
      const sy = dsin(w.yaw), cy = dcos(w.yaw), sp = dsin(w.pitch), cp = dcos(w.pitch);
      const mz = cmd.mz / 100, mx = cmd.mx / 100, my = cmd.my / 100;
      dx = sy * cp * mz - cy * mx; dy = sp * mz + my * (W.climb / W.cruise); dz = cy * cp * mz + sy * mx;
      const m = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (m > 1) { dx /= m; dy /= m; dz /= m; }
    }
    if (powered) {
      let top = burst ? W.burst : W.cruise;
      if (w.carry) top *= W.carrySpeedMul;
      if (w.caste === 'queen') top *= T.queen.speedMul;
      if (rain) top *= T.weather.rainSpeedMul;
      dx *= top; dy *= top; dz *= top;
      // the air moves: the wasp holds most of its course but drifts with the wind, less near the ground (GDD 5.3)
      const wd = this._drift(w);
      dx += wd.x; dz += wd.z;
      let ex = dx - w.vx, ey = dy - w.vy, ez = dz - w.vz;
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez), amax = (burst ? W.burstAccel : W.accel) * DT;
      if (el > amax) { ex *= amax / el; ey *= amax / el; ez *= amax / el; }
      w.vx += ex; w.vy += ey; w.vz += ez;
      const speed = Math.sqrt(w.vx * w.vx + w.vy * w.vy + w.vz * w.vz);
      const E = T.energy;
      let drain = E.cruisePerSec * DT * (E.hoverShare + (1 - E.hoverShare) * Math.min(speed / W.cruise, 2)) * (burst ? E.burstMul : 1);
      if (rain) drain *= T.weather.rainDrainMul;
      if (this._nearCitronella(w)) drain *= T.esc.citronellaDrain;
      w.energy -= drain;
      if (w.energy < 0) { w.energy = 0; this.emit('exhausted', { id: w.id }); }
    } else {
      w.vy -= W.gravity * DT;
      if (w.vy < -W.maxFall) w.vy = -W.maxFall;
      const wd = this._drift(w);
      w.vx = w.vx * 0.97 + wd.x * 0.03; w.vz = w.vz * 0.97 + wd.z * 0.03;
    }
    const n = W.substeps, h = DT / n, p0 = { x: w.x, y: w.y, z: w.z };
    for (let i = 0; i < n; i++) {
      w.x += w.vx * h; w.y += w.vy * h; w.z += w.vz * h;
      this._collide(w);
    }
    this._webCheck(w, p0);
    this._cupCheck(w);
    // grounded without fuel: starvation clock
    if (w.energy <= 0 && w.y <= W.radius + 1e-6) {
      if (++w.groundTicks > W.starveTicks) this._die(w, 'starved', null);
    } else w.groundTicks = 0;
  }

  // The wind a wasp feels: the day's wind, gusting, falling off toward the ground, times the share it cannot hold against
  _drift(w) {
    const W = T.wind, wind = this.wind, t = this.tick;
    const gust = 1 + W.gust * dsin(t * 0.031) * dsin(t * 0.0137 + 1);
    const k = W.drift * gust * clamp01(w.y / W.refHeight);
    return { x: wind.x * k, z: wind.z * k };
  }

  _nearCitronella(w) {
    if (this.escAt(w.x, w.z) < 2) return false;
    for (const rec of this.activeChunks) for (const t of rec.content.tables) {
      const dx = w.x - t.x, dz = w.z - t.z;
      if (dx * dx + dz * dz < 2.25 && this.escLevel(chunkKey(rec.cx, rec.cz)) >= 2) return true;
    }
    return false;
  }

  _collide(w) {
    const R = T.wasp.radius;
    if (w.y < R) { w.y = R; if (w.vy < 0) w.vy = 0; w.vx *= 0.9; w.vz *= 0.9; }
    if (w.y > T.wasp.ceiling) { w.y = T.wasp.ceiling; if (w.vy > 0) w.vy = 0; }
    for (const rec of this.activeChunks) {
      const c = rec.content;
      for (const b of c.boxes) {
        if (w.x < b.minx - R || w.x > b.maxx + R || w.y < b.miny - R || w.y > b.maxy + R || w.z < b.minz - R || w.z > b.maxz + R) continue;
        const pen = [w.x - (b.minx - R), (b.maxx + R) - w.x, w.y - (b.miny - R), (b.maxy + R) - w.y, w.z - (b.minz - R), (b.maxz + R) - w.z];
        let k = 0;
        for (let i = 1; i < 6; i++) if (pen[i] < pen[k]) k = i;
        if (k === 0) { w.x = b.minx - R; if (w.vx > 0) w.vx = 0; }
        else if (k === 1) { w.x = b.maxx + R; if (w.vx < 0) w.vx = 0; }
        else if (k === 2) { w.y = b.miny - R; if (w.vy > 0) w.vy = 0; }
        else if (k === 3) { w.y = b.maxy + R; if (w.vy < 0) w.vy = 0; }
        else if (k === 4) { w.z = b.minz - R; if (w.vz > 0) w.vz = 0; }
        else { w.z = b.maxz + R; if (w.vz < 0) w.vz = 0; }
      }
      // hollow cups: thin walls, open at the top unless covered (GDD 7.5)
      const ck = chunkKey(rec.cx, rec.cz), C = T.cup, rIn = C.r - C.wall, mid = (rIn + C.r) / 2;
      for (const cp of this.cupsIn(rec)) {
        const hx = w.x - cp.x, hz = w.z - cp.z, hd = Math.sqrt(hx * hx + hz * hz);
        if (hd > C.r + R || w.y > C.rim + R || w.y < C.base || this.canSpilled(ck, cp.i)) continue;
        const cov = this.cupCovered(ck, cp.i);
        if (w.y > C.rim) { // on the rim, or on a lid
          if (cov || hd > rIn - R) { w.y = C.rim + R; if (w.vy < 0) w.vy = 0; }
          continue;
        }
        if (hd === 0) continue;
        const ux = hx / hd, uz = hz / hd;
        if (hd >= mid) { // outside the wall
          if (hd < C.r + R) { w.x = cp.x + ux * (C.r + R); w.z = cp.z + uz * (C.r + R); const vn = w.vx * ux + w.vz * uz; if (vn < 0) { w.vx -= vn * ux; w.vz -= vn * uz; } }
        } else { // inside
          if (hd > rIn - R) { w.x = cp.x + ux * (rIn - R); w.z = cp.z + uz * (rIn - R); const vn = w.vx * ux + w.vz * uz; if (vn > 0) { w.vx -= vn * ux; w.vz -= vn * uz; } }
          if (cov && w.y > C.rim - R) { w.y = C.rim - R; if (w.vy > 0) w.vy = 0; }
        }
      }
      for (const cy of c.cylinders) {
        if (w.y > cy.h) continue;
        const dx = w.x - cy.x, dz = w.z - cy.z, rr = cy.r + R, d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
        w.x = cy.x + nx * rr; w.z = cy.z + nz * rr;
        const vn = w.vx * nx + w.vz * nz;
        if (vn < 0) { w.vx -= vn * nx; w.vz -= vn * nz; }
      }
    }
    for (const hm of this.active) {
      if (hm.state === 'away') continue;
      const dx = w.x - hm.x, dz = w.z - hm.z;
      if (dx * dx + dz * dz > 4) continue;
      const lp = toLocal(hm, w);
      let pushed = false;
      for (const part of hm.parts[hm.posture]) {
        const q = segClosest(part.a, part.b, lp);
        const ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z, rr = part.r + R;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 >= rr * rr || d2 === 0) continue;
        pushed = true;
        const d = Math.sqrt(d2);
        lp.x = q.x + ex / d * rr; lp.y = q.y + ey / d * rr; lp.z = q.z + ez / d * rr;
        const nw = dirToWorld(hm, { x: ex / d, y: ey / d, z: ez / d });
        const vn = w.vx * nw.x + w.vy * nw.y + w.vz * nw.z;
        if (vn < 0) { w.vx -= vn * nw.x; w.vy -= vn * nw.y; w.vz -= vn * nw.z; }
      }
      if (!pushed) continue;
      const p = toWorld(hm, lp);
      w.x = p.x; w.y = p.y; w.z = p.z;
    }
  }

  // ---------------- contact (GDD 7.4)

  _contactQuery(w, reach = T.wasp.contactGap) {
    const R = T.wasp.radius;
    let best = null, bestGap = reach;
    for (const hm of this.active) {
      if (hm.state === 'away') continue;
      const dx = w.x - hm.x, dz = w.z - hm.z;
      if (dx * dx + dz * dz > 4) continue;
      const lp = toLocal(hm, w);
      for (const part of hm.parts[hm.posture]) {
        const q = segClosest(part.a, part.b, lp);
        const ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z;
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (d === 0) continue;
        const gap = d - part.r - R;
        if (gap <= bestGap) {
          bestGap = gap;
          const n = { x: ex / d, y: ey / d, z: ez / d };
          const surf = { x: q.x + n.x * part.r, y: q.y + n.y * part.r, z: q.z + n.z * part.r };
          const zone = classify(part, q, n, surf, hm.tr.height / 1.75);
          best = { hm, part, n, surf, zone, lp };
        }
      }
    }
    if (!best) { w.contact = null; return; }
    const hm = best.hm, z = ZONES[best.zone];
    // nearest garment opening within reach of the wasp (GDD 8.8)
    let opening = -1;
    const nodes = garmentGraph(hm.tr, hm.clothing, hm.posture, hm.parts[hm.posture]);
    const or2 = T.under.openingRadius * T.under.openingRadius;
    let od = or2;
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i].opening) continue;
      const q = dist2(nodes[i].pos, best.lp);
      if (q <= od) { od = q; opening = i; }
    }
    w.contact = {
      humanHex: hm.hex, zone: best.zone, blocked: zoneCover(hm.clothing, best.zone) === 2,
      reach: selfReach(z, hm.tr, hm.clothing.stiffness), n: best.n, surf: best.surf, part: best.part.name,
      opening, openingKey: opening >= 0 ? nodes[opening].key : null,
    };
  }

  _companions(hm) {
    const out = [];
    for (const o of this.active) {
      if (o === hm || o.state !== 'idle' || o.special) continue;
      const dx = o.x - hm.x, dz = o.z - hm.z, d2 = dx * dx + dz * dz;
      if (d2 > T.resolve.helperRange * T.resolve.helperRange) continue;
      out.push({ id: o.id, hex: o.hex, distance: Math.sqrt(d2), reactionTicks: o.tr.reactionTicks, style: o.tr.style });
    }
    return out;
  }

  _beginSting(w, c, mode) {
    const hm = this.humanByHex(c.humanHex);
    const driven = w.id === this.drivenId;
    if (c.blocked) { if (driven) this.emit('blocked', { humanHex: hm.hex, zone: c.zone }); return false; }
    if (w.venom < T.venom.jab) { if (driven) this.emit('noVenom'); return false; }
    w.venom -= T.venom.jab;
    const R = T.wasp.radius;
    const local = { x: c.surf.x + c.n.x * R, y: c.surf.y + c.n.y * R, z: c.surf.z + c.n.z * R };
    w.state = 'attached';
    w.vx = w.vy = w.vz = 0;
    w.attach = { hex: hm.hex, posture: hm.posture, local, n: c.n, start: this.tick, deepened: false, zone: c.zone };
    this._applySting(w, hm, c.zone, c.surf, mode, false);
    return true;
  }

  // Shared by stings outside and under clothing. The stinger's peer resolves the plan at contact and
  // publishes it; every peer (this one too) applies the human side at the commit tick (GDD 11.5).
  _applySting(w, hm, zone, pointBody, mode, under) {
    const driven = w.id === this.drivenId;
    const ev = { contactTick: this.tick, humanHex: hm.hex, zone, contactPointBody: { ...pointBody }, mode, under };
    const comps = under ? [] : this._companions(hm);
    const lvl = this.escAt(hm.x, hm.z);
    const plan = resolveSting(ev, hm.tr, ZONES[zone], {
      clothingStiffness: hm.clothing.stiffness, panic: hm.panic, companions: comps, panicMul: lvl >= 2 ? 1.3 : 1, stung: this.wary(hm),
    });
    const actorHex = (id) => (id === hm.id ? hm.hex : comps.find((x) => x.id === id).hex);
    const swats = plan.swats.map((s) => ({ actorHex: actorHex(s.actorId), kind: s.kind, start: s.start, window: s.window, radius: s.radius, kills: s.kills, center: { ...s.center } }));
    this.emit('stingContact', { waspId: w.id, driven, humanHex: hm.hex, zone, first: !this.stung.has(hm.hex), under, swats, contactTick: this.tick });
    this._publish({ type: 'sting', waspId: w.id, driven, humanHex: hm.hex, zone, under, swats, panicGain: plan.panicGain, flee: plan.flee, sx: w.x, sz: w.z });
  }

  _attached(w, cmd, driven) {
    const a = w.attach, hm = this.humanByHex(a.hex);
    const held = this.tick - a.start;
    if (!hm || hm.posture !== a.posture || hm.state === 'away') { this._detach(w, 'knocked off'); return; }
    const p = toWorld(hm, a.local);
    w.x = p.x; w.y = p.y; w.z = p.z;
    const holding = driven ? cmd.sting : held < T.sting.jabTicks;
    if (holding && held >= T.sting.fullTicks && !a.deepened) {
      a.deepened = true;
      const extra = (T.resolve.fullPain - T.resolve.jabPain) * ZONES[a.zone].sens * hm.tr.panicSusceptibility;
      w.venom = Math.max(0, w.venom - T.venom.deepen);
      this.stats.full++;
      this._publish({ type: 'deepen', humanHex: hm.hex, zone: a.zone, extra, sx: w.x, sz: w.z });
    }
    if ((!holding && held >= T.sting.jabTicks) || a.deepened) this._detach(w, null);
  }

  _detach(w, why) {
    const a = w.attach, hm = a && this.humanByHex(a.hex);
    if (hm) {
      const n = dirToWorld(hm, a.n);
      w.vx = n.x * T.wasp.pushOff; w.vy = n.y * T.wasp.pushOff + 0.2; w.vz = n.z * T.wasp.pushOff;
    }
    w.attach = null;
    w.state = 'fly';
    this.emit('detach', { id: w.id, why });
    if (w.id !== this.drivenId && w.ai.mode === 'attack') this._aiAfterSting(w);
  }

  // ---------------- interactions (E): crawl under, catch prey, chew pulp

  _interact(w) {
    if (w.caste === 'queen' && !this.colony.sited) { const site = this._siteNear(w); if (site) { this._foundNest(w, site); return; } }
    if (w.caste !== 'queen' && this.seasonFrac >= T.season.reproStart && this.colony.mated + this.colony.gynes >= 1) {
      const hs = this._hiberNear(w);
      if (hs) { this.hiberPick = { season: this.season.n, x: hs.x, z: hs.z, kind: hs.kind }; this.emit('hiberScouted', { kind: hs.kind, q: hs.q }); return; }
    }
    const hb = !w.carry && w.caste !== 'queen' ? this._hiveEntranceNear(w) : null;
    if (hb) { this._startRob(w, hb.key, hb.h); return; }
    const rv = this._rivalNestNear(w);
    if (rv && !w.carry) { this._raid(w, rv); return; }
    const c = w.contact;
    if (c && c.opening >= 0 && !w.carry) { this._enterUnder(w, c); return; }
    if (c && w.state === 'fly') { this._perch(w, c); return; }
    const prey = this._preyNear(w);
    if (prey) { this._catch(w, prey); return; }
    if (!w.carry && this._baitNear(w)) { this._takeBait(w); return; }
    if (!w.carry && this._woodNear(w)) { w.state = 'chewing'; w.chew = 0; w.vx = w.vy = w.vz = 0; this.emit('chewStart', { id: w.id }); return; }
    if (w.carry) this.emit('carrying', { kind: w.carry.kind });
  }

  _hints(w) {
    const c = w.contact;
    this.hint = {
      opening: c && c.opening >= 0 ? c.openingKey : null,
      prey: !w.carry && this._preyNear(w) ? this._preyNear(w).kind : null,
      bait: !w.carry && !!this._baitNear(w),
      wood: !w.carry && !c && this._woodNear(w),
      nest: dist2(w, this.nest.entrance) < 0.4 * 0.4,
      site: w.caste === 'queen' && !this.colony.sited ? (this._siteNear(w) || {}).type || null : null,
      rival: !w.carry && !!this._rivalNestNear(w),
      hive: !w.carry && w.caste !== 'queen' && !!this._hiveEntranceNear(w),
      hiber: w.caste !== 'queen' && this.seasonFrac >= T.season.reproStart && this.colony.mated + this.colony.gynes >= 1 ? (this._hiberNear(w) || {}).kind || null : null,
    };
  }

  _preyNear(w) {
    const r2 = T.prey.catchDist * T.prey.catchDist;
    for (const rec of this.activeChunks) {
      const c = rec.content, key = chunkKey(rec.cx, rec.cz), st = this.cs(key);
      for (let i = 0; i < c.flies.length; i++) {
        if ((st.caughtFly[i] || 0) > this.tick || !this.flyActive(rec, i)) continue;
        if (dist2(w, flyPos(c.flies[i], this.tick)) <= r2) return { kind: 'fly', key, i, protein: T.prey.flyProtein };
      }
      for (let i = 0; i < c.caterpillars.length; i++) {
        if (st.caughtCat[i] || !this.catActive(rec, i)) continue;
        if (dist2(w, c.caterpillars[i]) <= r2 * 2) return { kind: 'caterpillar', key, i, protein: T.prey.caterpillarProtein };
      }
      for (const cr of this.carrionIn(rec)) if (dist2(w, cr) <= T.eco.carrionReach * T.eco.carrionReach) return { kind: 'carrion', key, i: cr.d, protein: T.eco.carrionProtein };
      const hives = this.hivesIn(rec);
      for (let h = 0; h < hives.length; h++) {
        const hv = hives[h], lost = st.beeLost[h] || {}, al = this.hiveAlarms.get(key + '#' + h);
        for (let k = T.bees.guards; k < hv.bees.length; k++) {
          if (lost[k] || (al && al.phys[k])) continue;
          if (dist2(w, beePos(hv, k, this.tick)) <= r2) return { kind: 'bee', key, i: k, hive: h, protein: T.prey.beeProtein };
        }
      }
    }
    return null;
  }

  _catch(w, p) {
    const st = this.cs(p.key);
    if (p.kind === 'fly') st.caughtFly[p.i] = this.tick + T.prey.flyRespawnTicks;
    else if (p.kind === 'caterpillar') st.caughtCat[p.i] = 1;
    else if (p.kind === 'carrion') { const cr = st.carrion || (st.carrion = {}); cr[p.i] = (cr[p.i] || 0) + 1; }
    else {
      (st.beeLost[p.hive] || (st.beeLost[p.hive] = {}))[p.i] = 1;
      this._alarmHive(p.key, p.hive, w, T.bees.catchAlarmRadius * 3);
    }
    w.carry = { kind: 'protein', amount: p.protein, what: p.kind };
    this._publish({ type: 'caught', key: p.key, what: p.kind, i: p.i, hive: p.hive });
    this.stats.caught++;
    this.emit('caught', { id: w.id, kind: p.kind });
  }

  _woodNear(w) {
    const reach = T.pulp.reach + T.wasp.radius;
    for (const rec of this.activeChunks) {
      for (const b of rec.content.boxes) {
        if (!b.wood || b.hive) continue;
        const qx = clamp(w.x, b.minx, b.maxx), qy = clamp(w.y, b.miny, b.maxy), qz = clamp(w.z, b.minz, b.maxz);
        const dx = w.x - qx, dy = w.y - qy, dz = w.z - qz;
        if (dx * dx + dy * dy + dz * dz <= reach * reach) return true;
      }
      for (const cy of rec.content.cylinders) {
        if (w.y > cy.h) continue;
        const dx = w.x - cy.x, dz = w.z - cy.z, d = Math.sqrt(dx * dx + dz * dz) - cy.r;
        if (d <= reach) return true;
      }
    }
    return false;
  }

  _chewStep(w, cmd, driven) {
    const holding = driven ? (cmd.act & Act.Interact) : true;
    if (!holding) { w.state = 'fly'; this.emit('chewCancel', { id: w.id }); return; }
    w.chew++;
    w.energy -= T.energy.cruisePerSec * DT * T.energy.hoverShare;
    if (w.chew >= T.pulp.chewTicks) {
      w.state = 'fly';
      w.carry = { kind: 'pulp', amount: T.pulp.amount, what: 'pulp' };
      this.cs(chunkKey(chunkOf(w.x), chunkOf(w.z))).chewed++;
      this.emit('chewed', { id: w.id });
    }
  }

  _feed(w, driven) {
    const d2max = T.energy.feedDist * T.energy.feedDist;
    if (driven) this.feeding = false;
    for (const rec of this.activeChunks) {
      const key = chunkKey(rec.cx, rec.cz), lvl = this.escLevel(key);
      const c = rec.content;
      if (lvl >= 3) {
        for (const tr of c.traps) {
          if (dist2(w, tr) <= d2max) {
            w.state = 'trapped'; w.stateTicks = 90; w.vx = w.vy = w.vz = 0;
            this.emit('trapped', { id: w.id, driven });
            return;
          }
        }
      }
      if (w.energy >= 1 && !(w.ai.mode === 'collect' && w.role === 'sugar')) continue;
      // a drink is reached at its surface, inside the cup (GDD 7.5)
      for (const cp of this.cupsIn(rec)) {
        if (this.canSpilled(key, cp.i) || this.cupCovered(key, cp.i)) continue; // knocked over, or covered (GDD 8.10)
        if (dist2(w, { x: cp.x, y: cp.level, z: cp.z }) > d2max) continue;
        const add = T.energy.refuelPerSec * DT;
        if (w.energy < 1) w.energy = Math.min(1, w.energy + add);
        else if (!driven) w.ai.cargo = Math.min(1, (w.ai.cargo || 0) + add);
        if (driven) this.feeding = true;
        w.ai.atFood = 'can';
        // an open drink is a trap of its own: a feeding wasp may slip in (GDD 7.5, T1-3)
        if (h32(w.id, this.tick, 53) < T.drown.chancePerSec * DT) this._fallIn(w, cp, key, driven);
        return;
      }
      // flowers in bloom with nectar left (T1-8): a sip draws the flower down
      for (let i = 0; i < c.flowers.length; i++) {
        const f = c.flowers[i];
        if (sq(w.x - f.x) + sq(w.y - f.y - 0.02) + sq(w.z - f.z) > d2max || !this.inBloom(rec, i)) continue;
        if (this.nectarAt(rec, i) <= 0) continue;
        const add = T.energy.refuelPerSec * T.eco.flowerRate * DT;
        if (w.energy < 1) w.energy = Math.min(1, w.energy + add);
        else if (!driven) w.ai.cargo = Math.min(1, (w.ai.cargo || 0) + add);
        if (driven) this.feeding = true;
        w.ai.atFood = 'flower';
        const take = T.eco.sipPerSec * DT;
        this._sip(key, i, take);
        if (this.net) { // tell the other peers in sips of a tenth (T1-8)
          let sp = w.sipPend;
          if (sp && (sp.key !== key || sp.i !== i)) { this._publish({ type: 'sip', key: sp.key, i: sp.i, amount: sp.amount }); sp = null; }
          if (!sp) sp = w.sipPend = { key, i, amount: 0 };
          sp.amount += take;
          if (sp.amount >= 0.1) { this._publish({ type: 'sip', key, i, amount: sp.amount }); w.sipPend = null; }
        }
        return;
      }
      for (const s of c.sugar.concat(this.spillsIn(key), this.fruitIn(rec))) {
        if (s.kind === 'can' || s.kind === 'flower') continue; // cups and flowers are handled above
        if (dist2(w, s) <= d2max) {
          const add = T.energy.refuelPerSec * s.rate * DT;
          if (w.energy < 1) w.energy = Math.min(1, w.energy + add);
          else if (!driven) w.ai.cargo = Math.min(1, (w.ai.cargo || 0) + add);
          if (driven) this.feeding = true;
          w.ai.atFood = s.kind;
          return;
        }
      }
    }
    w.ai.atFood = null;
  }

  _fallIn(w, cup, key, driven) {
    w.state = 'drowning'; w.vx = w.vy = w.vz = 0; w.land = null;
    w.x = cup.x; w.y = cup.level; w.z = cup.z;
    w.drown = { key, i: cup.i, until: this.tick + T.drown.ticks, progress: 0, prevBurst: 1 };
    this.emit('fellIn', { id: w.id, driven });
  }

  // Cups (GDD 7.5): one per can on a table, a pure function of the seed and the chunk, cached on the chunk record
  // (never saved). The drink level is set by hash; the rim and walls are the same for every cup.
  cupsIn(rec) {
    if (rec._cups) return rec._cups;
    const C = T.cup, sd = Number(this.seed & 0xffffffffn), lo = C.base + 0.006, span = C.rim - lo;
    rec._cups = rec.content.cans.map((cn, i) => ({ x: cn.x, z: cn.z, i, level: lo + (C.fillMin + C.fillSpan * hseq(sd, rec.cx, rec.cz, i, 961)) * span }));
    return rec._cups;
  }
  // a hand over it (a person who saw a wasp go in) or a lid (level 2)
  cupCovered(key, i) {
    if (this.escLevel(key) >= 2) return true;
    const st = this.chunkState.get(key);
    return !!(st && st.cover && (st.cover[i] || 0) > this.tick);
  }
  // the cup a point is inside (below the rim, within the wall), if any
  _inCup(p) {
    const C = T.cup, rIn = C.r - C.wall;
    if (p.y >= C.rim || p.y <= C.base) return null;
    for (const rec of this.activeChunks) {
      const key = chunkKey(rec.cx, rec.cz);
      for (const cp of this.cupsIn(rec)) {
        if (sq(p.x - cp.x) + sq(p.z - cp.z) >= rIn * rIn || this.canSpilled(key, cp.i)) continue;
        return { key, cup: cp };
      }
    }
    return null;
  }
  // Inside a cup: touching the drink pulls a wasp in; a covered cup shuts it in to drown. Returns true if it did.
  _cupCheck(w) {
    if (w.state !== 'fly' && w.state !== 'stunned' && w.state !== 'landed') return false;
    const k = this._inCup(w);
    if (!k) return false;
    const driven = w.id === this.drivenId;
    if (this.cupCovered(k.key, k.cup.i)) {
      w.state = 'trapped'; w.stateTicks = T.cup.drownTicks; w.trapCause = 'drowned under a lid'; w.vx = w.vy = w.vz = 0; w.land = null;
      this.emit('coveredIn', { id: w.id, driven, key: k.key, i: k.cup.i });
      return true;
    }
    if (w.y - T.wasp.radius < k.cup.level) { this._fallIn(w, k.cup, k.key, driven); return true; }
    return false;
  }

  // Mash burst to climb out before the drink takes you; AI wasps get a small chance each tick
  _drownStep(w, cmd, driven) {
    const d = w.drown, D = T.drown;
    if (driven) { if (cmd.burst && !d.prevBurst) d.progress += D.escapePerPress; d.prevBurst = cmd.burst; }
    else if (h32(w.id, this.tick, 57) < D.aiEscape) d.progress = 1;
    if (d.progress >= 1) {
      // out over the rim (GDD 7.5)
      const rec = this.records.get(d.key), cp = rec && d.i !== undefined ? this.cupsIn(rec)[d.i] : null;
      w.drown = null; w.state = 'stunned'; w.stateTicks = 30; w.vy = 0.6;
      if (cp) { w.x = cp.x; w.y = T.cup.rim + 0.02; w.z = cp.z; } else w.y += 0.04;
      w.energy = Math.min(1, w.energy + 0.1); // a sticky, sugary escape
      this.emit('climbedOut', { id: w.id });
      return;
    }
    if (this.tick >= d.until) this._die(w, 'drowned in a drink', null);
  }

  _nestTouch(w) {
    if (!this.colony.nestAlive || w.colony !== 'own') return;
    if (!this.colony.sited || dist2(w, this.nest.entrance) > 0.07 * 0.07) return;
    const col = this.colony;
    let deposited = false;
    if (w.carry && w.carry.kind === 'pulp' && w.caste === 'queen') {
      // a founding queen builds her own cells straight away (GDD 6.1)
      col.cells += w.carry.amount * T.colony.cellsPerPulp;
      col.stats.deposited.pulp += w.carry.amount;
      this.emit('deposit', { id: w.id, kind: 'cells', amount: w.carry.amount * T.colony.cellsPerPulp, what: 'cells' });
      w.carry = null; deposited = true;
    } else if (w.carry && w.carry.poison) {
      this._poison(w.carry.amount, w.id);
      w.carry = null; deposited = true;
    } else if (w.carry) {
      col[w.carry.kind] += w.carry.amount;
      col.stats.deposited[w.carry.kind] += w.carry.amount;
      this.emit('deposit', { id: w.id, kind: w.carry.kind, amount: w.carry.amount, what: w.carry.what });
      w.carry = null; deposited = true;
    }
    const surplus = w.energy - T.energy.nestRefill + (w.ai.cargo || 0);
    if (surplus > 0.05) {
      const amt = surplus * 0.6;
      col.sugar += amt; col.stats.deposited.sugar += amt;
      w.energy = Math.min(w.energy, T.energy.nestRefill); w.ai.cargo = 0;
      this.emit('deposit', { id: w.id, kind: 'sugar', amount: amt, what: 'sugar' });
      deposited = true;
    } else if (w.energy < T.energy.nestRefill && col.sugar > 0) {
      const take = Math.min(col.sugar, (T.energy.nestRefill - w.energy) * 0.6);
      col.sugar -= take; w.energy += take / 0.6;
    }
    if (deposited) this.stats.deposits++;
  }

  // ---------------- under clothing (GDD 8.8)

  _enterUnder(w, c) {
    const hm = this.humanByHex(c.humanHex);
    const nodes = garmentGraph(hm.tr, hm.clothing, hm.posture, hm.parts[hm.posture]);
    const notice = Math.max(T.resolve.minConsequenceTicks, hm.tr.reactionTicks * (T.under.noticeMul - 1));
    w.state = 'under';
    w.vx = w.vy = w.vz = 0;
    w.under = { hex: hm.hex, posture: hm.posture, node: c.opening, key: nodes[c.opening].key, sel: 0, move: null, entered: this.tick, nextPress: this.tick + notice };
    this._placeUnder(w, hm, nodes);
    this.emit('underEnter', { id: w.id, humanHex: hm.hex, key: w.under.key });
  }

  _underNodes(hm) { return garmentGraph(hm.tr, hm.clothing, hm.posture, hm.parts[hm.posture]); }

  _underPoint(u, nodes) {
    const a = nodes[u.node].pos;
    if (!u.move) return a;
    const b = nodes[u.move.to].pos, s = u.move.t / T.under.moveTicks;
    return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s, z: a.z + (b.z - a.z) * s };
  }

  _placeUnder(w, hm, nodes) {
    const p = toWorld(hm, this._underPoint(w.under, nodes));
    w.x = p.x; w.y = p.y; w.z = p.z;
  }

  _underStep(w, cmd, edge, armed) {
    const u = w.under, hm = this.humanByHex(u.hex);
    if (!hm || hm.state === 'away') { this._exitUnder(w, true); return; }
    let nodes = this._underNodes(hm);
    if (hm.posture !== u.posture) {
      const i = nodes.findIndex((n) => n.key === u.key);
      if (i < 0) { this._exitUnder(w, true); return; }
      u.node = i; u.posture = hm.posture; u.move = null;
    }
    if (u.node >= nodes.length || nodes[u.node].key !== u.key) { const i = nodes.findIndex((n) => n.key === u.key); if (i < 0) { this._exitUnder(w, true); return; } u.node = i; }
    const here = nodes[u.node];
    if (u.move) {
      if (++u.move.t >= T.under.moveTicks) { u.node = u.move.to; u.key = nodes[u.node].key; u.move = null; u.sel = 0; this.emit('underMove', { id: w.id, key: u.key }); }
    } else if (w.id === this.drivenId) {
      const nl = here.links.length;
      if (nl) {
        if (cmd.mx !== 0 && !u.mxHeld) u.sel = (u.sel + (cmd.mx > 0 ? 1 : nl - 1)) % nl;
        u.mxHeld = cmd.mx !== 0;
        if (cmd.mz > 0 && !u.mzHeld) u.move = { to: here.links[u.sel], t: 0 };
        u.mzHeld = cmd.mz > 0;
      }
      if ((edge & Act.Interact) && here.opening) { this._exitUnder(w, false); return; }
      if (armed) {
        this.pressUsed = true;
        if (w.venom >= T.venom.jab) { w.venom -= T.venom.jab; this._applySting(w, hm, here.zone, here.pos, 'jab', true); }
        else this.emit('noVenom');
      }
    }
    this._placeUnder(w, hm, nodes);
    // The human presses the cloth wherever they feel the wasp
    if (this.tick >= u.nextPress) {
      const point = this._underPoint(u, nodes);
      const plan = resolveSting({ contactTick: this.tick, zone: here.zone, contactPointBody: point, mode: 'jab', under: true }, hm.tr, ZONES[here.zone], { clothingStiffness: 0, panic: hm.panic, companions: [], stung: this.wary(hm) });
      const swats = plan.swats.map((s) => ({ kind: s.kind, start: Math.max(s.start, this.tick + T.net.commitTicks), window: s.window, radius: s.radius, kills: s.kills, center: { ...point } }));
      this._publish({ type: 'press', humanHex: hm.hex, waspId: w.id, swats });
      u.nextPress = this.tick + hm.tr.reactionTicks + T.under.compressEvery;
    }
    // Panic high enough: the shirt comes off and the wasp with it
    if (hm.panic >= T.under.ripPanic && hm.clothing.top !== Top.Suit && !hm.clothing.topOff && here.zone !== Zone.Thighs && here.zone !== Zone.Shins && here.zone !== Zone.Groin && here.zone !== Zone.Buttocks) {
      this._publish({ type: 'rip', humanHex: hm.hex, sx: w.x, sz: w.z });
      this._exitUnder(w, true);
    }
  }

  _exitUnder(w, ejected) {
    const u = w.under, hm = this.humanByHex(u.hex);
    w.under = null;
    if (hm) {
      const nodes = this._underNodes(hm);
      const i = Math.min(u.node, nodes.length - 1);
      const n = dirToWorld(hm, nodes[i].n);
      w.x += n.x * 0.025; w.y += n.y * 0.025 + 0.005; w.z += n.z * 0.025;
      w.vx = n.x * 0.8; w.vy = 0.4; w.vz = n.z * 0.8;
    }
    if (ejected) { w.state = 'stunned'; w.stateTicks = T.stunTicks; } else w.state = 'fly';
    this.emit('underExit', { id: w.id, ejected });
  }

  // ---------------- swats and sprays (GDD 8.7, 8.10)

  _swats() {
    const live = [];
    for (const s of this.swats) {
      if (this.tick >= s.start + s.window) {
        if (s.pre && s.targetId && !s.hits.length) this._missed(s);
        continue;
      }
      live.push(s);
      if (this.tick === s.start) this.emit('swatStrike', { actorHex: s.actorHex, frameHex: s.frameHex, kind: s.kind });
      if (this.tick < s.start) continue;
      const hm = this.humanByHex(s.frameHex);
      if (!hm) continue;
      const c = toWorld(hm, s.center), r = s.radius + T.wasp.radius;
      for (const w of this.wasps.slice()) {
        if (s.hits.includes(w.id)) continue;
        if (s.underOnly ? w.id !== s.underOnly || w.state !== 'under' : !(w.state === 'fly' || w.state === 'attached' || w.state === 'stunned' || w.state === 'chewing' || w.state === 'landed' || w.state === 'perched')) continue;
        if (dist2(w, c) > r * r) continue;
        s.hits.push(w.id);
        this.emit('swatHit', { waspId: w.id, actorHex: s.actorHex, frameHex: s.frameHex, kind: s.kind, kills: s.kills, delayTicks: s.start - s.contactTick });
        const causes = { [SwatKind.Slap]: 'slap', [SwatKind.Cover]: 'cover', [SwatKind.Compress]: 'crushed under clothing' };
        if (s.kills) this._die(w, (causes[s.kind] || 'swat') + (s.actorHex === s.frameHex || s.pre ? '' : ' (helper)'), s.actorHex, { why: s.why, own: s.byWasp === w.id || s.targetId === w.id, delay: s.start - s.contactTick });
        else this._stun(w);
      }
    }
    this.swats = live;
  }

  _missed(s) {
    // A wasp that was swatted at and survived may take it personally (GDD 6.3, 8.10)
    const w = this.waspById(s.targetId);
    if (!w || w.id === this.drivenId || w.state !== 'fly') return;
    if (h32(w.id, this.tick, 5) < (w.colony === 'own' ? this.colony.deficit : 0.3) + 0.15) this._aiAttack(w, s.actorHex);
  }

  _sprays() {
    if (!this.sprays.length) return;
    const live = [];
    for (const sp of this.sprays) {
      if (this.tick >= sp.end) continue;
      live.push(sp);
      if (this.tick < sp.start) continue;
      const hm = this.humanByHex(sp.hex);
      if (!hm || hm.state === 'away') continue;
      const headY = hm.parts[hm.posture][0].a.y;
      for (const w of this.wasps.slice()) {
        if (!(w.state === 'fly' || w.state === 'stunned' || w.state === 'attached' || w.state === 'chewing' || w.state === 'landed' || w.state === 'perched')) continue;
        const lp = toLocal(hm, w);
        for (const [z, r] of [[0.35, 0.14], [0.7, 0.22], [1.05, 0.3]]) {
          const dx = lp.x, dy = lp.y - headY, dz = lp.z - z;
          if (dx * dx + dy * dy + dz * dz <= r * r) { this._die(w, 'insecticide', hm.hex); break; }
        }
      }
    }
    this.sprays = live;
  }

  _stun(w) {
    if (w.state === 'attached') this._detach(w, 'stunned');
    w.state = 'stunned'; w.stateTicks = T.stunTicks;
    this.emit('stunned', { id: w.id, driven: w.id === this.drivenId });
  }

  _die(w, cause, byHex, detail = null) {
    const driven = w.id === this.drivenId;
    this.wasps = this.wasps.filter((x) => x !== w);
    w.state = 'dead';
    if (w.colony !== 'own') { /* a rival worker */ }
    else if (w.caste === 'queen') { this.colony.queenAlive = false; this.emit('queenDied', { cause }); }
    else this.colony.adults = Math.max(0, this.colony.adults - 1);
    if (w.fight) { const o = this.waspById(w.fight.other); if (o && o.state === 'fighting') { o.state = 'fly'; o.fight = null; } }
    this.stats.deaths++;
    this.stats.causes[cause] = (this.stats.causes[cause] || 0) + 1;
    if (byHex) {
      this._publish({ type: 'killed', byHex });
      this.alarms.push({ x: w.x, y: w.y, z: w.z, until: this.tick + T.alarm.ticks, killerHex: byHex });
      this.emit('alarm', { x: w.x, y: w.y, z: w.z, killerHex: byHex });
    }
    this._publish({ type: 'died', waspId: w.id, cause, x: w.x, y: w.y, z: w.z });
    this._releaseBees(w.id);
    this.emit('waspDied', { id: w.id, driven, cause, byHex, detail, x: w.x, y: w.y, z: w.z, adultsLeft: Math.floor(this.colony.adults) });
    if (driven) {
      this.ghost = { ...w, state: 'dead' };
      this.respawnAt = this.tick + T.respawnTicks;
    }
  }

  _despawn(w) {
    this.wasps = this.wasps.filter((x) => x !== w);
    this._publish({ type: 'died', waspId: w.id, cause: 'home', x: w.x, y: w.y, z: w.z });
    this._releaseBees(w.id);
    this.emit('waspDespawn', { id: w.id });
  }

  _respawn() {
    const col = this.colony;
    const inside = col.adults - this._own().length;
    if (col.nestAlive && inside >= 1) {
      const w = this._spawnWasp(true);
      this.drivenId = w.id; this.ghost = null;
      this.emit('respawn', { id: w.id, yaw: this.nest.spawn.yaw });
      return;
    }
    if (this._own().length) {
      const g = this.ghost || this.nest.spawn;
      let best = null, bd = Infinity;
      for (const w of this._own()) { const q = dist2(w, g); if (q < bd) { bd = q; best = w; } }
      this.drivenId = best.id; this.ghost = null;
      this.emit('possess', { id: best.id, from: 0 });
      return;
    }
    if (!colonyFinished(col, 0) && col.queenAlive) { this.respawnAt = this.tick + 600; this.emit('waitingBrood'); return; }
    if (!colonyFinished(col, 0) && col.pupae >= 1) { this.respawnAt = this.tick + 600; this.emit('waitingBrood'); return; }
    this._endSeason('colony lost');
  }

  // ---------------- the yearly cycle (GDD 2.2, 5.2, 6.7)

  // Hibernation sites near the nest (T1-15): shed walls, hollow trees, loose bark on thick trunks and the leaf litter,
  // from the 3x3 chunks around the nest. A pure function of the seed and the nest, so it is cached and never saved.
  hiberSites() {
    const n = this.nest, H = T.hiber;
    const ck = n.key + '|' + n.x + '|' + n.z;
    if (this._hiberCache && this._hiberCache.k === ck) return this._hiberCache.list;
    const [cx, cz] = n.key.split(',').map(Number), sd = Number(this.seed & 0xffffffffn), list = [];
    const add = (kind, x, y, z) => { if (sq(x - n.x) + sq(z - n.z) <= H.range * H.range) list.push({ kind, x, y, z, q: H.q[kind] }); };
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const rc = { cx: cx + dx, cz: cz + dz, content: this._content(cx + dx, cz + dz) }, s = this.sitesIn(rc);
      rc.content.sheds.forEach((sh, si) => { if (!this.feralWall(rc, si)) { const p = shedSites(sh).wall; add('shed', p.x, p.y, p.z); } });
      s.hollows.forEach((h, j) => { if (!this.feralHollow(rc, j)) add('hollow', h.x, h.y, h.z); });
      rc.content.trees.forEach((t, i) => {
        if (t.r < H.barkMinR) return;
        const a = hseq(sd, rc.cx, rc.cz, i, 941) * 6.28318;
        add('bark', t.x + (t.r + 0.01) * dcos(a), 0.4, t.z + (t.r + 0.01) * dsin(a));
      });
      for (const h of s.holes) add('litter', h.x, 0.02, h.z);
    }
    this._hiberCache = { k: ck, list };
    return list;
  }
  _treeNear(p) {
    const cx = chunkOf(p.x), cz = chunkOf(p.z);
    let best = null, bd = Infinity;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const t of this._content(cx + dx, cz + dz).trees) {
      if (t.h < 2.5) continue;
      const d = sq(t.x - p.x) + sq(t.z - p.z);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
  _hiberNear(w) {
    const r2 = T.hiber.reach * T.hiber.reach;
    for (const s of this.hiberSites()) if (dist2(w, s) < r2) return s;
    return null;
  }

  // Autumn's end (GDD 6.7, T1-15). The mated gynes spread over a few hibernation sites near the nest, most of them to
  // the one a worker scouted; each site's quality sets how many wake. The colony sleeps until the player picks a queen.
  _endSeason(why) {
    const S = T.season, H = T.hiber, col = this.colony, n = this.season.n;
    const cands = this.hiberSites();
    const order = cands.map((s, i) => i).sort((a, b) => h32(n, a, 951) - h32(n, b, 951) || a - b);
    const pk = this.hiberPick && this.hiberPick.season === n ? cands.findIndex((s) => s.x === this.hiberPick.x && s.z === this.hiberPick.z) : -1;
    const chosen = order.filter((i) => i !== pk).slice(0, H.spread);
    const share = new Map();
    if (pk >= 0) share.set(pk, H.pickShare);
    for (const i of chosen) share.set(i, (1 - (pk >= 0 ? H.pickShare : 0)) / Math.max(1, chosen.length));
    const sites = [];
    let survivors = 0;
    for (const [i, f] of share) {
      const s = cands[i], k = Math.floor(col.mated * f * H.survival * s.q + h32(n, i, 952));
      if (k >= 1) { sites.push({ kind: s.kind, x: s.x, y: s.y, z: s.z, q: s.q, n: k, scouted: i === pk }); survivors += k; }
    }
    sites.sort((a, b) => b.n - a.n || b.q - a.q || a.x - b.x || a.z - b.z);
    const lineage = Math.floor(this.lineage * S.lineageSurvival + h32(n, 32));
    this.emit('winter', { why, mated: col.mated, survivors, lineage, season: n, sites: sites.map((s) => ({ kind: s.kind, n: s.n, q: s.q, scouted: s.scouted, dist: Math.sqrt(sq(s.x - this.nest.x) + sq(s.z - this.nest.z)) })) });
    if (survivors + lineage < 1) { this.extinct = true; for (const w of this.wasps.slice()) this._despawn(w); this.emit('lineExtinct', { nestAlive: col.nestAlive }); return; }
    // only sister nests made it: you wake in one of them
    if (!sites.length) sites.push({ kind: 'sister', x: this.nest.spawn.x, y: this.nest.spawn.y, z: this.nest.spawn.z, q: H.q.sister, n: 0, scouted: false });
    for (const w of this.wasps.slice()) this._despawn(w);
    this.ghost = null;
    this.winter = { why, sites, survivors, lineage, until: this.tick + H.chooseTicks };
  }

  _winterStep(k) {
    const W = this.winter;
    const ok = k >= 1 && k <= W.sites.length;
    if (ok || this.tick >= W.until) this._spring(ok ? k - 1 : 0);
  }

  _spring(choice) {
    const W = this.winter, site = W.sites[choice], survivors = W.survivors, lineage = W.lineage;
    this.winter = null;
    // the queen that continues is yours; the rest found lineage colonies (Q-10)
    this.lineage = survivors + lineage - 1;
    const winterDays = rnd(this.settings.seasonDays * T.season.winterShare);
    const target = (this.day + 1 + winterDays) * 1440 + T.time.dawn;
    this.clockOffset += (target - this.minute) * this.tpm;
    this._minute(clockMinutes(this.tick + this.clockOffset, this.settings));
    this.season = { n: this.season.n + 1, startMinute: target, phase: 'Founding' };
    const alloc = this.colony.alloc;
    this.colony = newColony(true);
    this.colony.alloc = alloc;
    this.colony.sited = false;
    this.colony.sugar *= 0.5 + site.q; // a queen who wintered well wakes with more in reserve
    this.springAt = { x: site.x, z: site.z };
    this.hiberPick = null;
    this.oldNests.push(this.nest);
    for (const w of this.wasps.slice()) this._despawn(w);
    for (const s of this.chunkState.values()) s.esc = 0;
    this.swats = []; this.sprays = []; this.alarms = []; this.hiveAlarms.clear();
    this.ext = { visit: 0, state: 'none', arriveMinute: 0, hm: null, lead: null };
    this.ghost = null;
    const q = this._spawnWasp(true, 'queen');
    q.x = site.x; q.y = site.y + 0.05; q.z = site.z;
    this.drivenId = q.id;
    for (const hm of this.active) this._catchUpHuman(hm);
    this._updateChunks(true);
    this.emit('spring', { season: this.season.n, lineage: this.lineage, id: q.id, kind: site.kind });
  }

  // ---------------- humans (GDD 8.2, 8.9, 8.10)

  // p: where the threat came from ({x, z}); null flees backwards. Never a live wasp position, so peers agree.
  // A sitter who jumps up jolts the table: the nearest drink on it may go over and become an open puddle of sugar.
  // Pure function of shared human state and the tick, so every peer spills the same can. Lidded drinks (level 2+) stay put.
  _spill(hm) {
    const P = T.panic, key = hm.chunk, rec = this.records.get(key);
    if (!rec || this.escLevel(key) >= 2) return;
    if (unit(hash(this.seed, Domain.HumanSchedule, hm.id, BigInt(this.tick) * 2n + 1n)) >= P.spillChance) return;
    let best = -1, bd = P.spillReach * P.spillReach;
    rec.content.cans.forEach((c, i) => { const d = sq(c.x - hm.x) + sq(c.z - hm.z); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return;
    const st = this.cs(key), sp = st.spilled || (st.spilled = {});
    if ((sp[best] || 0) > this.minute) return;
    sp[best] = this.minute + P.spillMinutes;
    this.emit('spill', { key, i: best, humanHex: hm.hex });
  }

  // live puddles in a chunk: { x, y, z, rate, kind: 'spill', i }
  spillsIn(key) {
    const st = this.chunkState.get(key), rec = this.records.get(key);
    if (!st || !st.spilled || !rec) return [];
    const out = [];
    for (const i of Object.keys(st.spilled).map(Number).sort((a, b) => a - b)) {
      if (st.spilled[i] <= this.minute) continue;
      const c = rec.content.cans[i];
      out.push({ x: c.x + 0.06, y: 0.765, z: c.z, rate: T.panic.spillRate, kind: 'spill', i });
    }
    return out;
  }
  canSpilled(key, i) { const st = this.chunkState.get(key); return !!(st && st.spilled && st.spilled[i] > this.minute); }

  _startFlee(hm, p) {
    if (hm.posture === 'sit') this._spill(hm);
    const w = p;
    let dx = hm.x - (w ? w.x : hm.x - hm.fx), dz = hm.z - (w ? w.z : hm.z - hm.fz);
    let d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-6) { dx = -hm.fx; dz = -hm.fz; d = 1; }
    hm.dirX = dx / d; hm.dirZ = dz / d;
    hm.state = 'flee';
    hm.posture = 'stand';
    hm.fx = hm.dirX; hm.fz = hm.dirZ;
    const P = T.panic;
    hm.fleeSteps = rangeInt(hash(this.seed, Domain.HumanSchedule, hm.id, BigInt(this.tick)), P.fleeStepsMin, P.fleeStepsMax);
    this.emit('flee', { humanHex: hm.hex });
  }

  _walkTo(hm, tx, tz, speed) {
    const step = 3 * DT * speed;
    const dx = tx - hm.x, dz = tz - hm.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d <= step) { hm.x = tx; hm.z = tz; return true; }
    hm.fx = dx / d; hm.fz = dz / d;
    hm.x += hm.fx * step; hm.z += hm.fz * step;
    return false;
  }

  _humans() {
    const P = T.panic;
    // a snapshot: the exterminator leaving rebuilds the list mid-step, and he leaves on different ticks on different
    // peers (his search is his colony's own business, T1-7), so no one else's step may depend on it
    const list = this.active.slice();
    const old = list.map((h) => h.panic);
    const r2 = P.contagionRadius * P.contagionRadius;
    const md = minuteOfDay(this.minute);
    for (let i = 0; i < list.length; i++) {
      const hm = list[i];
      if (hm.special) { this._extStep(hm, old[i]); continue; }
      // schedule
      const win = this._window(hm);
      const present = win && md >= win.arrive && md < win.leave;
      if (hm.state === 'away') {
        if (present) {
          hm.state = 'arrive'; hm.posture = 'stand'; hm.x = hm.home.ax; hm.z = hm.home.az; hm.panic = 0;
          if (hm.clothesDay !== this.day) { hm.clothing = humanClothing(this.seed, hm.id, this.day); hm.clothesDay = this.day; }
          this.emit('arrive', { humanHex: hm.hex });
        }
        continue;
      }
      if (!present && hm.state !== 'leave') { hm.state = 'leave'; hm.posture = 'stand'; this.emit('leave', { humanHex: hm.hex }); }
      if (hm.state === 'arrive') { if (this._walkTo(hm, hm.home.x, hm.home.z, P.walkSpeed)) this._seat(hm); continue; }
      if (hm.state === 'leave') { if (this._walkTo(hm, hm.home.ax, hm.home.az, P.walkSpeed)) this._goAway(hm); continue; }
      // panic
      let gain = 0;
      for (let j = 0; j < list.length; j++) {
        if (i === j || old[j] < P.contagionMin) continue;
        const o = list[j], dx = o.x - hm.x, dz = o.z - hm.z;
        if (o.special) continue; // nor does his panic spread to shared humans
        if (dx * dx + dz * dz <= r2 && this.canSee(hm, o)) gain += P.contagionRate * old[j] * hm.tr.sociability * hm.tr.panicSusceptibility;
      }
      hm.panic = Math.min(1, old[i] * P.decayPerStep + gain);
      if (hm.state === 'idle' && hm.panic >= T.resolve.fleePanic) this._startFlee(hm, this.cs(hm.chunk).lastSting || null);
      if (hm.state === 'flee') {
        hm.x += hm.dirX * P.fleeSpeed * 3 * DT; hm.z += hm.dirZ * P.fleeSpeed * 3 * DT;
        if (--hm.fleeSteps <= 0) hm.state = 'return';
      } else if (hm.state === 'return') {
        if (hm.panic >= T.resolve.fleePanic) { this._startFlee(hm, this.cs(hm.chunk).lastSting || null); continue; }
        if (this._walkTo(hm, hm.home.x, hm.home.z, P.walkSpeed)) { this._seat(hm); this.emit('settled', { humanHex: hm.hex }); }
      } else if (hm.state === 'fetch') this._fetchStep(hm);
      else if (hm.state === 'idle') {
        if (hm.wantSpray) { hm.wantSpray = false; hm.state = 'fetch'; hm.posture = 'stand'; hm.fetchT = 0; this.emit('fetchSpray', { humanHex: hm.hex }); }
        else this._annoyance(hm);
      }
    }
  }

  // Off to the house for a can and back (T1-6): out of sight at the exit, then back to the seat armed
  _fetchStep(hm) {
    if (!(hm.fetchT > 0) && !this._walkTo(hm, hm.home.ax, hm.home.az, T.panic.walkSpeed)) return;
    hm.fetchT = (hm.fetchT || 0) + 3;
    if (hm.fetchT < T.esc.fetchTicks) return;
    hm.fetchT = 0; hm.sprayCount = T.esc.sprayCharges; hm.state = 'return';
    this.emit('armed', { humanHex: hm.hex });
  }

  // How wary a person is from the stings they remember (GDD 8.10, T1-18): each one fades over a couple of days and
  // counts in full only near where it happened. The resolver reads this where it used to read the plain count.
  wary(hm) {
    const M = T.memory;
    let n = 0;
    for (const e of hm.mem || []) {
      const r = 1 - (this.minute - e.m) / M.forgetMinutes;
      if (r <= 0) continue;
      n += r * (sq(hm.x - e.x) + sq(hm.z - e.z) <= M.nearDist * M.nearDist ? 1 : M.farShare);
    }
    return n;
  }

  // Can two people see each other (GDD 8.9, T1-17)? Sheds and anything above eye height block the line, and so do tree
  // trunks. Chunk content is a pure function of the seed, so peers agree whichever chunks each has discovered.
  canSee(a, b) {
    const H = T.panic.sightHeight, ax = a.x, az = a.z, bx = b.x, bz = b.z;
    const cx = chunkOf((ax + bx) / 2), cz = chunkOf((az + bz) / 2);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const c = this._content(cx + i, cz + j);
      for (const bo of c.boxes) {
        if (bo.maxy < H) continue;
        // segment against the box footprint (slab test)
        let t0 = 0, t1 = 1, ok = true;
        for (const [p, d, lo, hi] of [[ax, bx - ax, bo.minx, bo.maxx], [az, bz - az, bo.minz, bo.maxz]]) {
          if (d === 0) { if (p < lo || p > hi) { ok = false; break; } continue; }
          let u = (lo - p) / d, v = (hi - p) / d;
          if (u > v) { const s = u; u = v; v = s; }
          if (u > t0) t0 = u;
          if (v < t1) t1 = v;
          if (t0 > t1) { ok = false; break; }
        }
        if (ok) return false;
      }
      for (const cy of c.cylinders) {
        if (cy.h < H) continue;
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
        const t = L2 > 0 ? clamp(((cy.x - ax) * dx + (cy.z - az) * dz) / L2, 0, 1) : 0;
        if (sq(ax + dx * t - cy.x) + sq(az + dz * t - cy.z) < cy.r * cy.r) return false;
      }
    }
    return true;
  }
  _content(cx, cz) {
    const rec = this.records.get(chunkKey(cx, cz));
    if (rec) return rec.content;
    const cache = this._genCache || (this._genCache = new Map()), k = chunkKey(cx, cz);
    let c = cache.get(k);
    if (!c) { if (cache.size > 32) cache.clear(); c = generateChunk(this.seed, cx, cz); cache.set(k, c); }
    return c;
  }

  _nearestWasp(hm) {
    let best = null, bd = Infinity;
    for (const w of this.wasps) { const dx = w.x - hm.x, dz = w.z - hm.z, q = dx * dx + dz * dz; if (q < bd) { bd = q; best = w; } }
    return best;
  }

  // Wasps hovering at a face or at food get swatted; level decides how hard (GDD 8.10)
  _annoyance(hm) {
    if (hm.tr.style === Style.Freezer) return;
    if (hm.cooldown > this.tick) return;
    const lvl = this.escAt(hm.x, hm.z), E = T.esc;
    const head = hm.parts[hm.posture][0];
    let target = null, why = null, cupHit = null;
    for (const w of this.wasps) {
      if (!(w.state === 'fly' || w.state === 'chewing' || w.state === 'landed')) continue;
      const dx = w.x - hm.x, dz = w.z - hm.z;
      if (dx * dx + dz * dz > 4) continue;
      const lp = toLocal(hm, w);
      const hd2 = dist2(lp, head.a);
      // a wasp gone into a drink in front of them: a hand over the cup (GDD 7.5)
      const ic = dx * dx + dz * dz < T.cup.noticeDist * T.cup.noticeDist ? this._inCup(w) : null;
      if (ic && !this.cupCovered(ic.key, ic.cup.i)) { target = w; why = 'cup'; cupHit = ic; break; }
      if (hd2 < E.faceRadius * E.faceRadius) { target = w; why = 'face'; break; }
      if (lvl >= 1 && hd2 < E.headRadius * E.headRadius) { target = w; why = 'head'; break; }
      if (lvl >= 1 && (w.ai.atFood === 'can' || (w.state === 'landed' && this._nearCan(w))) && dx * dx + dz * dz < 1.5) { target = w; why = 'food'; break; }
      if (lvl >= 3 && hm.sprayCount > 0 && lp.z > 0.1 && lp.z < E.sprayRange && Math.abs(lp.x) < lp.z) { target = w; why = 'spray'; break; }
    }
    if (!target) { hm.annoy = 0; hm.annoyId = 0; return; }
    if (hm.annoyId !== target.id) { hm.annoyId = target.id; hm.annoy = 0; }
    hm.annoy += 3;
    const need = hm.tr.reactionTicks * (why === 'face' ? 3 : why === 'cup' ? T.cup.noticeMul : E.noticeMul) + (why === 'spray' ? 20 : 0);
    if (hm.annoy < need) return;
    hm.annoy = 0;
    hm.cooldown = this.tick + E.cooldownTicks;
    const start = this.tick + T.net.commitTicks + 1;
    if (why === 'cup') {
      this._publish({ type: 'cover', humanHex: hm.hex, key: cupHit.key, i: cupHit.cup.i, end: start + T.cup.coverTicks });
      return;
    }
    if (why === 'spray') {
      this._publish({ type: 'spray', humanHex: hm.hex, start, end: start + E.sprayTicks });
      return;
    }
    const lp = toLocal(hm, target);
    const slap = lvl >= 1;
    const kind = slap ? SwatKind.Slap : SwatKind.Brush;
    this._publish({
      type: 'preSwat', humanHex: hm.hex, waspId: target.id, kind, start, window: windowFor(kind), why,
      center: { x: lp.x, y: lp.y, z: lp.z }, radius: slap ? (hm.tr.style === Style.Precise ? 0.05 : 0.09) : T.resolve.brushRadius, kills: slap,
    });
  }

  // ---------------- the exterminator (GDD 8.10 level 4)

  _extCheck() {
    if (!this.settings.exterminator) return;
    const e = this.ext, col = this.colony;
    if (!col.nestAlive) return;
    if (e.state === 'none' || e.state === 'cancelled') {
      if (this._nestAreaLevel() >= T.ext.level) {
        e.visit++;
        const md = minuteOfDay(this.minute);
        e.arriveMinute = md < 15 * 60 && md >= T.time.dawn ? this.minute + 120 : (md >= T.time.dawn ? this.day + 1 : this.day) * 1440 + T.ext.arriveMinute;
        e.state = 'scheduled';
        this.emit('extScheduled', { visit: e.visit, arriveMinute: e.arriveMinute });
      }
    } else if (e.state === 'scheduled' && this._nestAreaLevel() < 3) {
      e.state = 'cancelled';
      this.emit('extCancelled', { visit: e.visit });
    } else if (e.state === 'scheduled' && this.minute >= e.arriveMinute) {
      const id = hash(this.seed, Domain.WorldGen, 0xE77n, BigInt(e.visit));
      const hex = hex64(id);
      const tr = { ...humanTraits(this.seed, id), height: 1.8, armRatio: 1, girth: 0.4, reactionTicks: 12, style: Style.Precise, accuracy: 0.9, panicSusceptibility: 0.45, sociability: 0, escalation: 1 };
      const ang = h32(e.visit, 9) * 6.28318;
      const n = this.nest, dxn = n.x - n.treeX, dzn = n.z - n.treeZ, dn = Math.sqrt(dxn * dxn + dzn * dzn) || 1;
      const goal = { x: n.x + dxn / dn * 0.45, z: n.z + dzn / dn * 0.45 };
      // he starts where people were stung, or where he left off yesterday (T1-7), and parks nearby
      const st = this._extStart(n.treeX + 30 * dcos(ang), n.treeZ + 30 * dsin(ang));
      const ax = st.x + T.ext.parkDist * dcos(ang), az = st.z + T.ext.parkDist * dsin(ang);
      const near = sq(st.x - n.x) + sq(st.z - n.z) <= T.ext.findDist * T.ext.findDist;
      e.hm = {
        id, hex, short: 'EXT', tr, special: true, clothing: suitClothing(e.visit > 1), chunk: this.nest.key,
        home: { x: goal.x, z: goal.z, fx: -dxn / dn, fz: -dzn / dn, posture: 'stand', ax, az },
        x: ax, z: az, fx: 0, fz: 1, posture: 'stand', state: near ? 'arrive' : 'seek', panic: 0, fleeSteps: 0, dirX: 0, dirZ: 0, stungCount: 0,
        annoyId: 0, annoy: 0, cooldown: 0, treat: 0, wpx: st.x, wpz: st.z, watch: 0, clue: 0, lines: 0,
        parts: { sit: bodyParts(tr, 'sit'), stand: bodyParts(tr, 'stand') },
      };
      e.state = 'active';
      this.emit('extArrive', { visit: e.visit, taped: e.visit > 1, known: near });
      this._updateChunks(true);
    }
  }

  _nestAreaLevel() {
    const [cx, cz] = this.nest.key.split(',').map(Number);
    let lv = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) lv = Math.max(lv, this.escLevel(chunkKey(cx + dx, cz + dz)));
    return lv;
  }

  _extStep(hm, oldPanic) {
    const e = this.ext;
    hm.panic = Math.max(0, oldPanic * T.panic.decayPerStep);
    if (hm.state === 'flee' || hm.state === 'leave') {
      if (hm.state === 'flee') { hm.x += hm.dirX * T.panic.fleeSpeed * 3 * DT; hm.z += hm.dirZ * T.panic.fleeSpeed * 3 * DT; if (--hm.fleeSteps <= 0) hm.state = 'leave'; }
      else if (this._walkTo(hm, hm.home.ax, hm.home.az, T.ext.speed)) this._extGone(false);
      return;
    }
    if (hm.panic >= T.ext.minPanicAbort) { this._startFlee(hm, this.cs(this.nest.key).lastSting || null); this.emit('extAbort', { visit: e.visit }); return; }
    if ((hm.state === 'seek' || hm.state === 'watch') && minuteOfDay(this.minute) >= T.time.dusk) { hm.state = 'leave'; this.emit('extGiveUp', { visit: e.visit, lines: hm.lines }); return; }
    if (hm.state === 'seek') {
      if (this._walkTo(hm, hm.wpx, hm.wpz, T.ext.speed)) { hm.state = 'watch'; hm.watch = 0; }
    } else if (hm.state === 'watch') this._extWatch(hm);
    else if (hm.state === 'arrive') {
      if (this._walkTo(hm, hm.home.x, hm.home.z, T.ext.speed)) { hm.state = 'treat'; hm.fx = hm.home.fx; hm.fz = hm.home.fz; hm.treat = 0; this.emit('extTreat', {}); }
    } else if (hm.state === 'treat') {
      hm.treat += 3;
      if (hm.treat >= T.ext.treatTicks) {
        const outside = this._own().length;
        const died = Math.max(0, this.colony.adults - outside);
        destroyNest(this.colony);
        this.colony.adults = outside;
        this.colony.stats.died += died;
        this.emit('nestDestroyed', { died: Math.floor(died) });
        hm.state = 'leave';
      }
    }
  }

  // Where the search starts: yesterday's last flight line if it was for this nest, else the spot near the nest where
  // people were stung most (chunk state is read without creating it), else where he came in
  _extStart(ax, az) {
    const e = this.ext, n = this.nest;
    if (e.lead && e.lead.nx === n.x && e.lead.nz === n.z) return { x: e.lead.x, z: e.lead.z };
    const [cx, cz] = n.key.split(',').map(Number);
    let best = null, bl = -1;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const st = this.chunkState.get(chunkKey(cx + dx, cz + dz));
      if (st && st.lastSting && st.esc > bl) { bl = st.esc; best = st.lastSting; }
    }
    return best ? { x: best.x, z: best.z } : { x: ax, z: az };
  }

  // Flight lines he can see from where he stands, per second (T1-7). The colony's foragers fly out along lines from
  // the nest: the nearer he is, the more of them cross his view. Fewer foragers ('Lie low'), a well hidden site and bad
  // weather all slow him down. Any of our wasps flying where he can see it gives him a line of its own.
  extSightings(hm) {
    const X = T.ext, col = this.colony, n = this.nest;
    let rate = 0;
    if (col.nestAlive && isDaylight(this.minute) && !this.raining && this.canFly()) {
      const foragers = Math.max(0, col.adults - col.young - this._own().length) * T.colony.forageShare * T.alloc[col.alloc].traffic;
      const d = Math.sqrt(sq(hm.x - n.x) + sq(hm.z - n.z));
      rate = X.linesPerSec * Math.min(1, foragers / X.trafficFull) * Math.min(1, X.sightR / Math.max(d, 0.5)) * T.sites[n.site || 'trunk'].discovery;
    }
    for (const w of this.wasps) {
      if (w.colony !== 'own' || w.state !== 'fly' || sq(w.x - hm.x) + sq(w.z - hm.z) > X.sightR * X.sightR) continue;
      if (this.canSee(hm, w)) rate += X.physPerSec;
    }
    return rate;
  }

  _extWatch(hm) {
    const e = this.ext, X = T.ext, n = this.nest;
    hm.watch += 3;
    hm.clue += this.extSightings(hm) * 3 * DT;
    if (hm.watch < X.minWatchTicks || hm.clue < 1) return;
    hm.clue -= 1;
    hm.lines++;
    const dx = hm.x - n.x, dz = hm.z - n.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d <= X.findDist) {
      e.lead = { x: n.x, z: n.z, nx: n.x, nz: n.z };
      hm.state = 'arrive';
      this.emit('extFound', { visit: e.visit, lines: hm.lines });
      return;
    }
    // follow the line toward the nest; a line is only a direction, so he lands off to one side
    const nd = Math.max(X.findDist * 0.5, d - X.stepLen);
    const err = (h32(e.visit, hm.lines, 0xE7) * 2 - 1) * X.errFrac * nd;
    const ux = dx / d, uz = dz / d;
    hm.wpx = n.x + ux * nd - uz * err; hm.wpz = n.z + uz * nd + ux * err;
    e.lead = { x: hm.wpx, z: hm.wpz, nx: n.x, nz: n.z };
    hm.state = 'seek';
    this.emit('extLine', { visit: e.visit, lines: hm.lines, x: hm.wpx, z: hm.wpz });
  }

  _extGone() {
    const e = this.ext;
    e.hm = null;
    if (this.colony.nestAlive) {
      e.state = 'scheduled';
      e.visit++;
      e.arriveMinute = (this.day + 1) * 1440 + T.ext.arriveMinute;
      this.emit('extScheduled', { visit: e.visit, arriveMinute: e.arriveMinute });
    } else e.state = 'done';
    this._updateChunks(true);
  }

  // ---------------- bees (GDD 9.2)

  _alarmHive(key, h, w, radius, fromRemote = false) {
    const rec = this.records.get(key), hv = this.hivesIn(rec)[h];
    const k = key + '#' + h;
    let al = this.hiveAlarms.get(k);
    if (!fromRemote && (!al || al.target !== w.id)) this._publish({ type: 'beeAlarm', key, h, target: w.id, radius });
    if (!al) { al = { key, h, target: w.id, until: 0, phys: {} }; this.hiveAlarms.set(k, al); this.emit('beeAlarm', { key, h, waspId: w.id }); }
    al.target = w.id;
    al.until = this.tick + T.bees.alarmTicks;
    const lost = this.cs(key).beeLost[h] || {};
    for (let b = 0; b < hv.bees.length; b++) {
      if (al.phys[b] || lost[b]) continue;
      const p = beePos(hv, b, this.tick);
      const nearHive = sq(w.x - hv.ex) + sq(w.z - hv.ez) < sq(T.bees.hiveAlarmRadius);
      if (dist2(p, w) < radius * radius || (hv.bees[b].guard && nearHive)) al.phys[b] = { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, mode: 'pursue', stun: 0 };
    }
  }

  _bees() {
    // entrance guard check for every active hive
    for (const rec of this.activeChunks) {
      const key = chunkKey(rec.cx, rec.cz);
      this.hivesIn(rec).forEach((hv, h) => {
        for (const w of this.wasps) {
          if (w.state !== 'fly' && w.state !== 'chewing' && w.state !== 'landed') continue;
          const dx = w.x - hv.ex, dy = w.y - hv.ey, dz = w.z - hv.ez;
          if (dx * dx + dy * dy + dz * dz < sq(T.bees.entranceAlarm)) { this._alarmHive(key, h, w, 2); break; }
        }
      });
    }
    if (!this.hiveAlarms.size) return;
    const B = T.bees, agg = this.settings.beeAggression;
    const attached = new Map();
    for (const [k, al] of this.hiveAlarms) {
      const rec = this.records.get(al.key), hv = this.hivesIn(rec)[al.h];
      const target = this._anyWasp(al.target);
      if (target && dist2(target, { x: hv.ex, y: hv.ey, z: hv.ez }) < 15 * 15 && target.state !== 'dead') al.until = Math.max(al.until, this.tick + 60);
      const ending = this.tick > al.until || !target;
      let any = false;
      for (const b in al.phys) {
        const p = al.phys[b];
        any = true;
        if (p.stun > 0) { p.stun--; p.vy -= 3 * DT; p.x += p.vx * DT; p.y = Math.max(0.01, p.y + p.vy * DT); p.z += p.vz * DT; continue; }
        if (p.mode === 'ball') {
          if (!target || ending || (this.waspById(target.id) && target.state !== 'balled')) { p.mode = 'return'; continue; }
          p.x = target.x; p.y = target.y; p.z = target.z;
          attached.set(target.id, (attached.get(target.id) || 0) + 1);
          continue;
        }
        let tx, ty, tz;
        if (p.mode === 'pursue' && target && !ending && (target.state === 'fly' || target.state === 'stunned' || target.state === 'chewing' || target.state === 'balled')) {
          tx = target.x; ty = target.y; tz = target.z;
        } else {
          p.mode = 'return';
          const q = beePos(hv, +b, this.tick); tx = q.x; ty = q.y; tz = q.z;
          if (dist2(p, q) < 0.01) { delete al.phys[b]; continue; }
        }
        let dx = tx - p.x, dy = ty - p.y, dz = tz - p.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const sp = B.pursueSpeed * (0.9 + 0.2 * agg);
        dx = dx / d * sp - p.vx; dy = dy / d * sp - p.vy; dz = dz / d * sp - p.vz;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz), amax = B.accel * DT;
        if (dl > amax) { dx *= amax / dl; dy *= amax / dl; dz *= amax / dl; }
        p.vx += dx; p.vy += dy; p.vz += dz;
        p.x += p.vx * DT; p.y += p.vy * DT; p.z += p.vz * DT;
        if (p.mode === 'pursue' && target && d < B.contact + 0.01) { p.mode = 'ball'; attached.set(target.id, (attached.get(target.id) || 0) + 1); }
      }
      if (!any && ending) this.hiveAlarms.delete(k);
    }
    // balls: heat the wasp (GDD 9.2)
    for (const [id, n] of attached) {
      const w = this.waspById(id);
      if (!w) continue;
      if (w.state !== 'balled' && n >= B.ballMin && w.state !== 'under' && w.state !== 'trapped' && w.state !== 'robbing') { // inside the hive it is the bees inside that count (T1-9)
        if (w.state === 'attached') this._detach(w, 'balled');
        w.state = 'balled'; w.ball = { temp: B.startTemp, progress: 0, prevBurst: 0 }; w.vx = w.vy = w.vz = 0;
        this.emit('balled', { id: w.id, driven: w.id === this.drivenId });
      }
      if (w.state !== 'balled') continue;
      w.ball.bees = n;
      w.ball.temp += B.heatPerBeeSec * n * DT * agg;
      w.y = Math.max(T.wasp.radius, w.y - 0.05 * DT);
      if (w.ball.temp >= B.lethal) { this._die(w, 'cooked by bees', null); continue; }
    }
  }

  // Burst presses break out of a ball (driven wasp); AI wasps get a small chance each tick
  _ballEscape(w, burstEdge) {
    if (w.state !== 'balled') return;
    const n = Math.max(1, w.ball.bees || T.bees.ballMin);
    if (burstEdge) w.ball.progress += T.bees.escapePerPress / (n * 0.2);
    if (w.id !== this.drivenId && h32(w.id, this.tick, 11) < 0.004) w.ball.progress = 1;
    if (w.ball.progress >= 1) {
      w.state = 'fly'; w.ball = null; w.vy = 2.5; w.vx = (h32(w.id, this.tick) - 0.5) * 3; w.vz = (h32(this.tick, w.id) - 0.5) * 3;
      for (const al of this.hiveAlarms.values()) for (const b in al.phys) { const p = al.phys[b]; if (p.mode === 'ball') { p.mode = 'pursue'; p.stun = 45; p.vx = (h32(+b, this.tick) - 0.5) * 2; p.vy = 0; p.vz = (h32(this.tick, +b) - 0.5) * 2; } }
      this.emit('ballEscape', { id: w.id });
    }
  }

  _releaseBees(id) {
    for (const al of this.hiveAlarms.values()) if (al.target === id) al.until = Math.min(al.until, this.tick);
  }

  _alarmDecay() { if (this.alarms.length) this.alarms = this.alarms.filter((a) => a.until > this.tick); }

  // ---------------- perching and crawling on people (GDD 7.2, 8.3)

  _tickleNeed(hm, zone) {
    const P = T.perch, cover = zoneCover(hm.clothing, zone);
    let k = P.tickleBase * (cover === 2 ? P.thinMul * 1.5 : cover === 1 ? P.thinMul : P.bareMul);
    if (zone === Zone.UpperBack || zone === Zone.Acnestis || zone === Zone.LowerBack || zone === Zone.Buttocks) k *= P.backMul;
    if (zone === Zone.Face || zone === Zone.Ears || zone === Zone.NeckFront) k *= P.faceMul;
    return Math.max(T.resolve.minConsequenceTicks, rnd(hm.tr.reactionTicks * k));
  }

  _perch(w, c) {
    const hm = this.humanByHex(c.humanHex);
    if (!hm) return;
    const R = T.wasp.radius;
    w.state = 'perched'; w.vx = w.vy = w.vz = 0;
    w.perch = { hex: hm.hex, posture: hm.posture, local: { x: c.surf.x + c.n.x * R, y: c.surf.y + c.n.y * R, z: c.surf.z + c.n.z * R }, n: c.n, surf: c.surf, zone: c.zone, part: c.part, tickle: 0, need: this._tickleNeed(hm, c.zone), quietUntil: 0 };
    this.emit('perch', { id: w.id, humanHex: hm.hex, zone: c.zone });
  }

  // Put a local point back on the nearest body surface; returns the new contact description
  _onBody(hm, lp) {
    let best = null, bd = Infinity;
    for (const part of hm.parts[hm.posture]) {
      const q = segClosest(part.a, part.b, lp);
      const ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z, d = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9;
      const gap = d - part.r;
      if (gap < bd) { bd = gap; best = { part, q, n: { x: ex / d, y: ey / d, z: ez / d } }; }
    }
    const { part, q, n } = best, R = T.wasp.radius;
    const surf = { x: q.x + n.x * part.r, y: q.y + n.y * part.r, z: q.z + n.z * part.r };
    return { part: part.name, n, surf, local: { x: surf.x + n.x * R, y: surf.y + n.y * R, z: surf.z + n.z * R }, zone: classify(part, q, n, surf, hm.tr.height / 1.75) };
  }

  _perchStep(w, cmd, edge, armed, driven) {
    const p = w.perch, hm = this.humanByHex(p.hex);
    if (!hm || hm.state === 'away' || hm.posture !== p.posture) { w.perch = null; w.state = 'stunned'; w.stateTicks = 20; w.vy = 0.3; this.emit('knockedOff', { id: w.id }); return; }
    if (!driven || cmd.burst || cmd.my > 0) { // take off
      const n = dirToWorld(hm, p.n);
      w.perch = null; w.state = 'fly'; w.vx = n.x * 0.6; w.vy = n.y * 0.6 + 0.4; w.vz = n.z * 0.6;
      this.emit('takeoff', { id: w.id });
      return;
    }
    let moving = false;
    if (cmd.mx || cmd.mz) {
      // crawl relative to the camera, projected onto the skin
      const yaw = cmd.yawQ * 1e-4, sy = dsin(yaw), cy = dcos(yaw);
      const mz = cmd.mz / 100, mx = cmd.mx / 100, sp = T.perch.crawlSpeed * DT;
      const wx = (sy * mz - cy * mx) * sp, wz = (cy * mz + sy * mx) * sp;
      const lw = { x: hm.fz * wx - hm.fx * wz, z: hm.fx * wx + hm.fz * wz }; // world delta -> body frame
      const pitch = cmd.pitchQ * 1e-4;
      const nl = { x: p.local.x + lw.x, y: p.local.y + mz * sp * dsin(pitch) * 2, z: p.local.z + lw.z };
      const c = this._onBody(hm, nl);
      Object.assign(p, { local: c.local, n: c.n, surf: c.surf, zone: c.zone, part: c.part });
      p.need = this._tickleNeed(hm, c.zone);
      moving = true;
    }
    const at = toWorld(hm, p.local);
    w.x = at.x; w.y = at.y; w.z = at.z;
    if (edge & Act.Interact) {
      const nodes = garmentGraph(hm.tr, hm.clothing, hm.posture, hm.parts[hm.posture]);
      let best = -1, bd = T.under.openingRadius * T.under.openingRadius;
      nodes.forEach((nd, i) => { if (nd.opening) { const q = dist2(nd.pos, p.local); if (q <= bd) { bd = q; best = i; } } });
      if (best >= 0) { w.perch = null; w.state = 'fly'; this._enterUnder(w, { humanHex: hm.hex, opening: best }); return; }
    }
    if (armed) {
      this.pressUsed = true;
      const c = { humanHex: hm.hex, zone: p.zone, surf: p.surf, n: p.n, blocked: zoneCover(hm.clothing, p.zone) === 2 };
      w.perch = null; w.state = 'fly';
      if (!this._beginSting(w, c, 'jab')) this._perch(w, { humanHex: hm.hex, zone: c.zone, surf: c.surf, n: c.n, part: '' });
      return;
    }
    // they start to feel the feet on their skin
    if (this.tick >= p.quietUntil) {
      p.tickle += moving ? T.perch.movingMul : 1;
      if (p.tickle >= p.need) {
        p.tickle = 0; p.quietUntil = this.tick + T.perch.cooldown;
        const comps = this._companions(hm);
        const plan = resolveSting({ contactTick: this.tick, zone: p.zone, contactPointBody: p.surf, mode: 'touch' }, hm.tr, ZONES[p.zone], { clothingStiffness: hm.clothing.stiffness, panic: hm.panic, companions: comps, stung: this.wary(hm) });
        const actorHex = (id) => (id === hm.id ? hm.hex : comps.find((x) => x.id === id).hex);
        const swats = plan.swats.map((s) => ({ actorHex: actorHex(s.actorId), kind: s.kind, start: s.start, window: s.window, radius: s.radius, kills: s.kills, center: { ...s.center } }));
        this._publish({ type: 'notice', humanHex: hm.hex, waspId: w.id, zone: p.zone, swats });
      }
    }
  }

  // ---------------- founding a nest (GDD 6.6)

  _trunkNear(w) {
    for (const rec of this.activeChunks) for (const t of rec.content.trees) {
      const dx = w.x - t.x, dz = w.z - t.z, d = Math.sqrt(dx * dx + dz * dz) - t.r;
      if (d <= 0.06 && w.y > 0.8 && w.y < t.h) return t;
    }
    return null;
  }

  // Candidate nest sites around the queen (GDD 6.6). Burrows and branch points are derived from the seed and the
  // chunk's frozen content, so they cost nothing to store and every peer sees the same ones.
  sitesIn(rec) {
    const cache = this._siteCache || (this._siteCache = new Map()), key = chunkKey(rec.cx, rec.cz);
    if (cache.has(key)) return cache.get(key);
    const S = T.sites, CS = T.chunk.size, sd = Number(this.seed & 0xffffffffn);
    const holes = [];
    for (let i = 0; i < S.holesPerChunk; i++) {
      const x = (rec.cx + (hseq(sd, rec.cx, rec.cz, i, 913) - 0.5) * 0.8) * CS, z = (rec.cz + (hseq(sd, rec.cx, rec.cz, i, 914) - 0.5) * 0.8) * CS;
      holes.push({ x, z });
    }
    const branches = rec.content.trees.map((t, i) => {
      const a = hseq(sd, rec.cx, rec.cz, i, 915) * 6.28318, d = t.cr * 0.55;
      return { x: t.x + d * dcos(a), y: Math.max(1.8, t.h - t.cr * 0.7), z: t.z + d * dsin(a), t };
    });
    // hollow trees (T1-14): some thick trunks have a hole a wasp can nest in
    const hollows = [];
    rec.content.trees.forEach((t, i) => {
      if (t.r < S.hollowMinR || hseq(sd, rec.cx, rec.cz, i, 916) >= S.hollowShare) return;
      const a = hseq(sd, rec.cx, rec.cz, i, 917) * 6.28318, y = Math.min(t.h - 0.5, 0.7 + hseq(sd, rec.cx, rec.cz, i, 918) * 1.2);
      hollows.push({ x: t.x + (t.r + 0.015) * dcos(a), y, z: t.z + (t.r + 0.015) * dsin(a), t });
    });
    const out = { holes, branches, hollows };
    if (cache.size > 64) cache.clear();
    cache.set(key, out);
    return out;
  }

  // ---------------- feral hives and robbing (GDD 9.1, T1-9)

  feralHollow(rec, j) { return hseq(Number(this.seed & 0xffffffffn), rec.cx, rec.cz, j, 981) < T.feral.hollowShare; }
  feralWall(rec, si) { return hseq(Number(this.seed & 0xffffffffn), rec.cx, rec.cz, si, 982) < T.feral.wallShare; }
  // The chunk's hives: the managed boxes from the generator, then wild colonies in hollow trees and shed walls,
  // derived from the seed like the nest sites (so old worlds keep their frozen content). Indices are stable.
  hivesIn(rec) {
    if (rec._hives) return rec._hives;
    const F = T.feral, sd = Number(this.seed & 0xffffffffn), c = rec.content, list = c.hives.slice();
    const u = (a, b) => hseq(sd, rec.cx, rec.cz, a, b, 983);
    const wild = (x, y, z, nx, nz, slot) => {
      const hv = { x, z, fx: nx, fz: nz, ex: x + nx * 0.03, ey: y, ez: z + nz * 0.03, bees: [], slot, feral: true };
      for (let k = 0; k < F.guards + F.foragers; k++) {
        const s = slot * 64 + k * 6;
        if (k < F.guards) { hv.bees.push({ guard: true, p: u(s, 0) * 6.28, w: (1.5 + 1.5 * u(s, 1)) * (k % 2 ? 1 : -1) }); continue; }
        const f = c.flowers.length ? c.flowers[Math.floor(u(s, 2) * c.flowers.length)] : { x: x + 8, y: 0.4, z: z + 8 };
        hv.bees.push({ guard: false, tx: f.x, ty: f.y, tz: f.z, period: 1500 + Math.floor(u(s, 3) * 1500), phase: Math.floor(u(s, 4) * 3000), p: u(s, 5) * 6.28 });
      }
      list.push(hv);
    };
    this.sitesIn(rec).hollows.forEach((h, j) => {
      if (!this.feralHollow(rec, j)) return;
      const dx = h.x - h.t.x, dz = h.z - h.t.z, d = Math.sqrt(dx * dx + dz * dz) || 1;
      wild(h.x, h.y, h.z, dx / d, dz / d, 100 + j);
    });
    c.sheds.forEach((sh, si) => {
      if (!this.feralWall(rec, si)) return;
      const p = shedSites(sh).wall;
      wild(p.x, p.y, p.z, p.nx, p.nz, 200 + si);
    });
    rec._hives = list;
    return list;
  }
  hiveLoadsLeft(key, h) { const st = this.chunkState.get(key); return T.feral.loadsPerDay - ((st && st.robbed && st.robbed[h]) || 0); }
  _hiveEntranceNear(w) {
    const r2 = T.feral.robReach * T.feral.robReach;
    for (const rec of this.activeChunks) {
      const key = chunkKey(rec.cx, rec.cz), hives = this.hivesIn(rec);
      for (let h = 0; h < hives.length; h++) if (dist2(w, { x: hives[h].ex, y: hives[h].ey, z: hives[h].ez }) <= r2) return { key, h };
    }
    return null;
  }
  // in through the entrance: the whole hive is roused
  _startRob(w, key, h) {
    const hv = this.hivesIn(this.records.get(key))[h];
    w.state = 'robbing'; w.vx = w.vy = w.vz = 0; w.land = null;
    w.x = hv.ex; w.y = hv.ey; w.z = hv.ez;
    w.rob = { key, h, progress: 0, prevSting: 1 };
    this._alarmHive(key, h, w, T.bees.hiveAlarmRadius);
    this.emit('robStart', { id: w.id, driven: w.id === this.drivenId, key, h, feral: !!hv.feral });
  }
  // Inside: the grab fills over a few seconds, faster for each sting press; any tick the bees may get you; Space or
  // Shift bails out empty-handed. Out with honey in the crop and a larva in the jaws, into an alarmed hive's air.
  _robStep(w, cmd, driven) {
    const r = w.rob, F = T.feral, hv = this.hivesIn(this.records.get(r.key))[r.h];
    const out = () => { w.rob = null; w.state = 'fly'; w.x = hv.ex + hv.fx * 0.05; w.z = hv.ez + hv.fz * 0.05; w.vx = hv.fx * 1.5; w.vz = hv.fz * 1.5; w.vy = 0.3; w.noLandUntil = this.tick + T.land.afterTakeoff; };
    if (driven && (cmd.burst || cmd.my > 0)) { out(); this.emit('robAbort', { id: w.id }); return; }
    if (h32(w.id, this.tick, 87) < F.insideKill * DT) { w.rob = null; this._die(w, 'stung inside a hive', null); return; }
    r.progress += DT / F.robSecs;
    if (driven) { if (cmd.sting && !r.prevSting) r.progress += F.pressGain; r.prevSting = cmd.sting ? 1 : 0; }
    if (r.progress < 1) return;
    out();
    if (this.hiveLoadsLeft(r.key, r.h) <= 0) { this.emit('hiveEmpty', { id: w.id, key: r.key, h: r.h }); if (!driven) { w.ai.mode = 'return'; w.ai.target = null; } return; }
    const st = this.cs(r.key), rb = st.robbed || (st.robbed = {});
    rb[r.h] = (rb[r.h] || 0) + 1;
    w.energy = 1; w.ai.cargo = Math.max(w.ai.cargo || 0, F.honeyCargo);
    w.carry = { kind: 'protein', amount: F.broodProtein, what: 'bee brood' };
    this._publish({ type: 'caught', key: r.key, what: 'honey', i: r.h });
    this.stats.caught++;
    this.emit('robbed', { id: w.id, driven, key: r.key, h: r.h });
    if (!driven) { w.ai.mode = 'return'; w.ai.target = null; }
  }

  // ---------------- seasonal ecology (GDD 9.4, T1-8): pure functions of the seed, the chunk and the clock, plus the
  // sips taken (chunk state). The ecology tick of GDD 3.3 is evaluated lazily: a flower's nectar is its level at the
  // last sip plus regrowth (less what the local bees take) since, so nothing has to run while nobody looks.
  inBloom(rec, i) {
    const E = T.eco, f = rec.content.flowers[i], w = E.bloom[f.color % E.bloom.length], frac = this.seasonFrac;
    const j = (hseq(Number(this.seed & 0xffffffffn), rec.cx, rec.cz, i, 971) - 0.5) * 2 * E.bloomJitter;
    return frac >= w[0] + j && frac < w[1] + j;
  }
  // forager bees working each flower of the chunk (they forage only their own chunk's flowers)
  _beeLoad(rec) {
    if (rec._beeLoad) return rec._beeLoad;
    const c = rec.content;
    const hives = this.hivesIn(rec);
    rec._beeLoad = c.flowers.map((f) => { let n = 0; for (const hv of hives) for (const b of hv.bees) if (!b.guard && b.tx === f.x && b.tz === f.z) n++; return n; });
    return rec._beeLoad;
  }
  nectarAt(rec, i) {
    if (!this.inBloom(rec, i)) return 0;
    const E = T.eco, st = this.chunkState.get(chunkKey(rec.cx, rec.cz)), n = st && st.nectar && st.nectar[i];
    const net = (E.regenPerDay - E.beeDrawPerDay * this._beeLoad(rec)[i]) / 1440;
    if (!n) return net >= 0 ? 1 : clamp(1 + net * (this.minute - this.season.startMinute), 0, 1);
    return clamp(n[0] + net * (this.minute - n[1]), 0, 1);
  }
  _sip(key, i, amount) {
    const rec = this.records.get(key);
    if (!rec) return;
    const st = this.cs(key), nt = st.nectar || (st.nectar = {});
    nt[i] = [Math.max(0, this.nectarAt(rec, i) - amount), this.minute];
  }
  // sugar index -> flower index, for the AI's picks (the generator pushes a sugar node right after each flower)
  _flowerIdx(rec) {
    if (rec._flowerIdx) return rec._flowerIdx;
    let k = 0;
    rec._flowerIdx = rec.content.sugar.map((s) => (s.kind === 'flower' ? k++ : -1));
    return rec._flowerIdx;
  }
  catActive(rec, i) {
    const E = T.eco, frac = this.seasonFrac;
    const j = (hseq(Number(this.seed & 0xffffffffn), rec.cx, rec.cz, i, 972) - 0.5) * 2 * E.catJitter;
    return frac >= E.catFrom + j && frac < E.catTo + j;
  }
  flyShare() { const E = T.eco; return clamp(E.flyBase + E.flySlope * clamp(this.seasonFrac, 0, 1), 0, 1); }
  flyActive(rec, i) { return hseq(Number(this.seed & 0xffffffffn), rec.cx, rec.cz, i, this.day, 973) < this.flyShare(); }
  // Carrion: some days a dead mouse or bird lies somewhere in a chunk for a few days, good for a few loads of meat
  carrionIn(rec) {
    const E = T.eco, sd = Number(this.seed & 0xffffffffn), CS = T.chunk.size, out = [];
    const st = this.chunkState.get(chunkKey(rec.cx, rec.cz)), taken = (st && st.carrion) || {};
    for (let d = this.day - E.carrionDays + 1; d <= this.day; d++) {
      if (d < 0 || hseq(sd, rec.cx, rec.cz, d, 974) >= E.carrionChance) continue;
      const left = E.carrionLoads - (taken[d] || 0);
      if (left <= 0) continue;
      out.push({ x: (rec.cx + (hseq(sd, rec.cx, rec.cz, d, 975) - 0.5) * 0.8) * CS, y: 0.03, z: (rec.cz + (hseq(sd, rec.cx, rec.cz, d, 976) - 0.5) * 0.8) * CS, d, left });
    }
    return out;
  }
  // what the season offers the abstract foragers: multipliers on sugar and protein income
  ecoAvail() {
    const E = T.eco, f = clamp(this.seasonFrac, 0, 1);
    const bloom = E.bloom.filter((w) => f >= w[0] && f < w[1]).length / E.bloom.length;
    const sugar = E.sugarBase + E.sugarBloom * bloom + (f >= T.fruit.startFrac ? E.sugarFruit : 0);
    const protein = E.protBase + (f >= E.catFrom && f < E.catTo ? E.protCat : 0) + E.protFly * this.flyShare();
    return { sugar, protein };
  }

  // Windfall fruit under fruit trees from mid-season (GDD 9.4). Each fruit falls on a day picked by hash and lies
  // for a few days; a pure function of the seed, the chunk and the clock.
  fruitIn(rec) {
    const F = T.fruit, frac = this.seasonFrac;
    if (frac < F.startFrac) return [];
    const sd = Number(this.seed & 0xffffffffn), key = chunkKey(rec.cx, rec.cz), today = this.day;
    const cache = this._fruitCache || (this._fruitCache = new Map()), ck = key + '|' + today + '|' + this.season.n;
    if (cache.has(ck)) return cache.get(ck);
    const out = [], span = 1 - F.startFrac, days = this.settings.seasonDays * span;
    rec.content.trees.forEach((t, ti) => {
      if (hseq(sd, rec.cx, rec.cz, ti, 931) >= F.treeShare) return;
      for (let k = 0; k < F.perTree; k++) {
        const fall = Math.floor(this.season.startMinute / 1440 + this.settings.seasonDays * (F.startFrac + span * hseq(sd, rec.cx, rec.cz, ti, k, 932)));
        if (today < fall || today >= fall + F.rotDays) continue;
        const a = hseq(sd, rec.cx, rec.cz, ti, k, 933) * 6.28318, d = t.r + 0.2 + F.spread * hseq(sd, rec.cx, rec.cz, ti, k, 934);
        out.push({ x: t.x + d * dcos(a), y: 0.03, z: t.z + d * dsin(a), rate: F.rate, kind: 'fruit', i: ti * 16 + k });
      }
    });
    if (cache.size > 128) cache.clear();
    cache.set(ck, out);
    return out;
  }

  _siteNear(w) {
    for (const rec of this.activeChunks) {
      const { holes, branches, hollows } = this.sitesIn(rec);
      for (let j = 0; j < hollows.length; j++) { const h = hollows[j]; if (!this.feralHollow(rec, j) && dist2(w, h) < 0.12 * 0.12) return { type: 'hollow', x: h.x, y: h.y, z: h.z, t: h.t }; } // bees already live in some (T1-9)
      for (const h of holes) if (w.y < 0.3 && sq(w.x - h.x) + sq(w.z - h.z) < 0.12 * 0.12) return { type: 'ground', x: h.x, z: h.z };
      for (const b of branches) if (dist2(w, b) < 0.15 * 0.15) return { type: 'branch', x: b.x, y: b.y, z: b.z, t: b.t };
      for (let si = 0; si < rec.content.sheds.length; si++) {
        const ss = shedSites(rec.content.sheds[si]);
        for (const type of ['wall', 'attic']) { if (type === 'wall' && this.feralWall(rec, si)) continue; const p = ss[type]; if (dist2(w, p) < 0.14 * 0.14) return { type, ...p }; }
      }
    }
    const t = this._trunkNear(w);
    return t ? { type: 'trunk', t } : null;
  }

  _foundNest(w, site) {
    if (!site.type) site = { type: 'trunk', t: site }; // older callers pass a tree
    if (site.type === 'ground') {
      this.nest = makeNest(site.x - 0.5, site.z, site.x, -0.25, site.z, NEST.r, 'ground');
    } else if (site.type === 'wall' || site.type === 'attic') {
      this.nest = makeNest(site.ix, site.iz, site.x, site.y, site.z, NEST.r, site.type);
    } else if (site.type === 'hollow') {
      this.nest = makeNest(site.t.x, site.t.z, site.x, site.y, site.z, NEST.r, 'hollow');
    } else if (site.type === 'branch') {
      this.nest = makeNest(site.t.x, site.t.z, site.x, site.y - NEST.r * 1.3, site.z, NEST.r, 'branch');
    } else {
      const t = site.t;
      let dx = w.x - t.x, dz = w.z - t.z;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= d; dz /= d;
      const y = clamp(w.y, 1.2, Math.max(1.2, t.h - 0.6));
      this.nest = makeNest(t.x, t.z, t.x + dx * (t.r + 0.2), y, t.z + dz * (t.r + 0.2), NEST.r, 'trunk');
    }
    this.colony.sited = true;
    this.colony.maxCells = T.sites[this.nest.site].maxCells;
    w.x = this.nest.spawn.x; w.y = this.nest.spawn.y; w.z = this.nest.spawn.z; w.vx = w.vy = w.vz = 0;
    this.emit('nestFounded', { x: this.nest.x, y: this.nest.y, z: this.nest.z, key: this.nest.key, site: this.nest.site });
  }

  // ---------------- predators (GDD 9.3)

  // A wasp that flies through a web sticks where it crossed the web's plane
  _webCheck(w, p0) {
    if (w.state !== 'fly' && w.state !== 'stunned') return;
    for (const rec of this.activeChunks) {
      const webs = rec.content.webs;
      if (!webs.length) continue;
      const st = this.cs(chunkKey(rec.cx, rec.cz));
      for (let i = 0; i < webs.length; i++) {
        const wb = webs[i];
        if (st.webTorn && st.webTorn[i] === this.day) continue;
        const d0 = (p0.x - wb.x) * wb.nx + (p0.z - wb.z) * wb.nz, d1 = (w.x - wb.x) * wb.nx + (w.z - wb.z) * wb.nz;
        if (d0 * d1 > 0 && Math.abs(d1) > T.wasp.radius) continue;
        const t = d0 === d1 ? 1 : clamp(d0 / (d0 - d1), 0, 1);
        const q = { x: p0.x + (w.x - p0.x) * t, y: p0.y + (w.y - p0.y) * t, z: p0.z + (w.z - p0.z) * t };
        const dx = q.x - wb.x, dy = q.y - wb.y, dz = q.z - wb.z;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > wb.r * wb.r) continue;
        w.x = q.x; w.y = q.y; w.z = q.z; w.vx = w.vy = w.vz = 0;
        w.state = 'webbed';
        w.web = { key: chunkKey(rec.cx, rec.cz), i, progress: 0, prevBurst: 1, start: this.tick, spiderAt: this.tick + T.web.spiderDelay + Math.ceil(Math.sqrt(r2) / T.web.spiderSpeed * 60) };
        if (w.attach) w.attach = null;
        this.emit('webbed', { id: w.id, driven: w.id === this.drivenId, spiderAt: w.web.spiderAt });
        return;
      }
    }
  }

  _webStep(w, cmd, driven) {
    const wb = w.web;
    if (driven) { if (cmd.burst && !wb.prevBurst) wb.progress += T.web.escapePerPress; wb.prevBurst = cmd.burst; }
    else if (h32(w.id, this.tick, 41) < T.web.aiEscape) wb.progress = 1;
    if (wb.progress >= 1) {
      const st = this.cs(wb.key);
      (st.webTorn || (st.webTorn = {}))[wb.i] = this.day;
      w.web = null; w.state = 'stunned'; w.stateTicks = 15; w.vy = 0.4;
      this.emit('webEscape', { id: w.id });
      return;
    }
    if (this.tick >= wb.spiderAt) this._die(w, 'eaten by a spider', null);
  }

  // Canopy cover: a tree crown overhead hides a wasp from birds
  _underCanopy(w) {
    for (const rec of this.activeChunks) for (const t of rec.content.trees) {
      const dx = w.x - t.x, dz = w.z - t.z;
      if (dx * dx + dz * dz < t.cr * t.cr && w.y < t.h + t.cr) return true;
    }
    return false;
  }

  _birds() {
    if (!this.settings.birds) return;
    this._hunters('birds', birdPos, T.bird, this.birdState, (w) => w.y >= T.bird.minY, (t) => t.y < T.bird.abortY, 'taken by a bird', 'bird', 6);
  }

  // Dragonflies hunt the low air birds leave alone; landing, perching or ducking under a canopy is safe (GDD 9.3)
  _dragonflies() {
    if (!this.settings.birds) return;
    const D = T.dragon;
    this._hunters('dragonflies', dragonPos, { ...D, diveTicks: D.dartTicks }, this.dragonState || (this.dragonState = new Map()), (w) => w.y <= D.maxY, (t) => t.y > D.maxY + 0.5, 'taken by a dragonfly', 'dragon', 4);
  }

  // One code path for every aerial hunter: patrol a pure-function loop, pick a flying wasp in sight, chase it with a
  // capped acceleration (so sharp turns escape), give up after a while, then cool off and return to the loop.
  _hunters(listName, posFn, B, states, canSee, abort, cause, ev, cruise) {
    for (const rec of this.activeChunks) {
      const key = chunkKey(rec.cx, rec.cz);
      rec.content[listName].forEach((bd, i) => {
        const k = key + '#' + i;
        let st = states.get(k);
        if (!st) {
          if (this.tick % 6 !== i % 6) return;
          const p = posFn(bd, this.tick);
          let target = null, best = B.sight * B.sight;
          for (const w of this.wasps) {
            if (w.state !== 'fly' || !canSee(w)) continue;
            const q = dist2(w, p);
            if (q < best && !this._underCanopy(w)) { best = q; target = w; }
          }
          if (!target) return;
          const d = Math.sqrt(best) || 1;
          st = { mode: 'dive', x: p.x, y: p.y, z: p.z, vx: (target.x - p.x) / d * 3, vy: (target.y - p.y) / d * 3, vz: (target.z - p.z) / d * 3, target: target.id, until: this.tick + B.diveTicks };
          states.set(k, st);
          this.emit(ev + 'Dive', { key, i, target: target.id, driven: target.id === this.drivenId });
          return;
        }
        let tx, ty, tz, speed = B.speed;
        if (st.mode === 'dive') {
          const t = this.waspById(st.target);
          if (!t || t.state !== 'fly' || abort(t) || this.tick > st.until || this._underCanopy(t)) {
            st.mode = 'cool'; st.until = this.tick + B.coolTicks;
            if (t && t.id === this.drivenId) this.emit(ev + 'Miss', { id: t.id });
            return;
          }
          tx = t.x; ty = t.y; tz = t.z;
          if (dist2(st, t) < B.catch * B.catch) { this._die(t, cause, null); st.mode = 'cool'; st.until = this.tick + B.coolTicks; return; }
        } else {
          const p = posFn(bd, this.tick);
          tx = p.x; ty = p.y; tz = p.z; speed = cruise;
          if (dist2(st, p) < 0.25 || this.tick > st.until + 900) { states.delete(k); return; }
        }
        let dx = tx - st.x, dy = ty - st.y, dz = tz - st.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx = dx / d * speed - st.vx; dy = dy / d * speed - st.vy; dz = dz / d * speed - st.vz;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz), amax = B.accel * DT;
        if (dl > amax) { dx *= amax / dl; dy *= amax / dl; dz *= amax / dl; }
        st.vx += dx; st.vy += dy; st.vz += dz;
        st.x += st.vx * DT; st.y = Math.max(0.3, st.y + st.vy * DT); st.z += st.vz * DT;
      });
    }
  }


  // ---------------- landing (GDD 7.2)

  // The nearest static surface to p (GDD 7.2): the ground, any face of a box (undersides too), tree trunks, flower
  // stalks and heads, and capsules (branches, when the world has them). Returns the point, the outward normal, what
  // it is, and the gap between the wasp's body and it; null if nothing is within maxGap. Pure geometry on frozen
  // chunk content, so every peer agrees.
  _staticSurface(p, maxGap) {
    const R = T.wasp.radius, L = T.land, lim = maxGap + R;
    let best = null, bd = lim;
    const take = (qx, qy, qz, nx, ny, nz, d, kind) => { if (d < bd) { bd = d; best = { x: qx, y: qy, z: qz, nx, ny, nz, kind }; } };
    // a point against a solid capsule (segment a-b, radius r)
    const capsule = (ax, ay, az, bx, by, bz, r, kind) => {
      const q = segClosest({ x: ax, y: ay, z: az }, { x: bx, y: by, z: bz }, p);
      const ex = p.x - q.x, ey = p.y - q.y, ez = p.z - q.z, d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (d - r >= bd || d === 0) return;
      take(q.x + ex / d * r, q.y + ey / d * r, q.z + ez / d * r, ex / d, ey / d, ez / d, d - r, kind);
    };
    if (p.y < lim) take(p.x, 0, p.z, 0, 1, 0, p.y, 'ground');
    for (const rec of this.activeChunks) {
      const c = rec.content;
      for (const b of c.boxes) {
        if (p.x < b.minx - lim || p.x > b.maxx + lim || p.y < b.miny - lim || p.y > b.maxy + lim || p.z < b.minz - lim || p.z > b.maxz + lim) continue;
        const qx = clamp(p.x, b.minx, b.maxx), qy = clamp(p.y, b.miny, b.maxy), qz = clamp(p.z, b.minz, b.maxz);
        const ex = p.x - qx, ey = p.y - qy, ez = p.z - qz, d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        const kind = b.hive ? 'hive' : b.shed ? 'shed' : 'wood';
        if (d > 0) { take(qx, qy, qz, ex / d, ey / d, ez / d, d, kind); continue; }
        // inside: out through the nearest face
        const f = [p.x - b.minx, b.maxx - p.x, p.y - b.miny, b.maxy - p.y, p.z - b.minz, b.maxz - p.z];
        let k = 0;
        for (let i = 1; i < 6; i++) if (f[i] < f[k]) k = i;
        const nx = k === 0 ? -1 : k === 1 ? 1 : 0, ny = k === 2 ? -1 : k === 3 ? 1 : 0, nz = k === 4 ? -1 : k === 5 ? 1 : 0;
        take(p.x + nx * f[k], p.y + ny * f[k], p.z + nz * f[k], nx, ny, nz, 0, kind);
      }
      for (const cy of c.cylinders) {
        const hx = p.x - cy.x, hz = p.z - cy.z, hd = Math.sqrt(hx * hx + hz * hz);
        if (hd - cy.r >= bd || p.y > cy.h + bd) continue;
        if (p.y > cy.h && hd <= cy.r) { take(p.x, cy.h, p.z, 0, 1, 0, p.y - cy.h, 'bark'); continue; } // the top
        if (hd === 0) continue;
        const qx = cy.x + hx / hd * cy.r, qz = cy.z + hz / hd * cy.r;
        if (p.y > cy.h) { const ey = p.y - cy.h, dr = hd - cy.r, d = Math.sqrt(dr * dr + ey * ey); take(qx, cy.h, qz, (hx / hd) * dr / d, ey / d, (hz / hd) * dr / d, d, 'bark'); }
        else take(qx, p.y, qz, hx / hd, 0, hz / hd, Math.max(0, hd - cy.r), 'bark');
      }
      for (const f of c.flowers) {
        if (Math.abs(p.x - f.x) > lim + L.headR || Math.abs(p.z - f.z) > lim + L.headR || p.y > f.y + lim + L.headR) continue;
        capsule(f.x, 0, f.z, f.x, f.y - L.headR, f.z, L.stalkR, 'stalk');
        capsule(f.x, f.y, f.z, f.x, f.y, f.z, L.headR, 'flower');
      }
      for (const k of c.capsules || []) capsule(k.ax, k.ay, k.az, k.bx, k.by, k.bz, k.r, k.kind || 'branch');
      // cups: the outer and inner wall, the rim, and the lid or hand over a covered one
      const ck = chunkKey(rec.cx, rec.cz), C = T.cup, rIn = C.r - C.wall;
      for (const cp of this.cupsIn(rec)) {
        const hx = p.x - cp.x, hz = p.z - cp.z, hd = Math.sqrt(hx * hx + hz * hz);
        if (hd > C.r + lim || p.y > C.rim + lim || p.y < C.base || this.canSpilled(ck, cp.i)) continue;
        const cov = this.cupCovered(ck, cp.i);
        if (p.y >= C.rim) {
          if (hd === 0) { if (cov) take(p.x, C.rim, p.z, 0, 1, 0, p.y - C.rim, 'cup'); continue; }
          const qr = cov ? Math.min(hd, C.r) : clamp(hd, rIn, C.r), qx = cp.x + hx / hd * qr, qz = cp.z + hz / hd * qr;
          const ex = p.x - qx, ey = p.y - C.rim, ez = p.z - qz, d = Math.sqrt(ex * ex + ey * ey + ez * ez);
          if (d > 0) take(qx, C.rim, qz, ex / d, ey / d, ez / d, d, 'cup');
          continue;
        }
        if (hd === 0) continue;
        if (hd >= (rIn + C.r) / 2) take(cp.x + hx / hd * C.r, p.y, cp.z + hz / hd * C.r, hx / hd, 0, hz / hd, Math.max(0, hd - C.r), 'cup');
        else {
          take(cp.x + hx / hd * rIn, p.y, cp.z + hz / hd * rIn, -hx / hd, 0, -hz / hd, Math.max(0, rIn - hd), 'cup');
          if (cov) take(p.x, C.rim, p.z, 0, -1, 0, C.rim - p.y, 'cup');
        }
      }
    }
    // our own paper nest, where it hangs in the open
    const n = this.nest;
    if (this.colony.sited !== false && this.colony.nestAlive && (n.site === 'trunk' || n.site === 'branch')) capsule(n.x, n.y, n.z, n.x, n.y, n.z, n.r, 'nest');
    if (!best) return null;
    best.gap = bd;
    return best;
  }

  // Put the wasp on surface s and keep its heading: a tangent direction that turns with the mouse around the
  // surface normal, as yaw does on flat ground. Moving onto a surface at another angle (round an edge, up a trunk)
  // carries the heading over by the smallest rotation from the old normal to the new one. Landing from flight takes
  // the camera's direction, laid on the surface.
  _settle(w, s, cmd) {
    const R = T.wasp.radius, L = w.land;
    w.x = s.x + s.nx * R; w.y = s.y + s.ny * R; w.z = s.z + s.nz * R;
    let h = null;
    if (L && L.hx !== undefined) {
      let hx = L.hx, hy = L.hy, hz = L.hz;
      const c = L.nx * s.nx + L.ny * s.ny + L.nz * s.nz;
      if (c < 0.999999 && c > -0.999999) {
        const kx = L.ny * s.nz - L.nz * s.ny, ky = L.nz * s.nx - L.nx * s.nz, kz = L.nx * s.ny - L.ny * s.nx;
        const kv = (kx * hx + ky * hy + kz * hz) / (1 + c);
        const rx = hx * c + (ky * hz - kz * hy) + kx * kv, ry = hy * c + (kz * hx - kx * hz) + ky * kv, rz = hz * c + (kx * hy - ky * hx) + kz * kv;
        hx = rx; hy = ry; hz = rz;
      }
      h = this._onPlane(s, hx, hy, hz);
    }
    if (!h) h = this._camHeading(s, cmd);
    w.land = { nx: s.nx, ny: s.ny, nz: s.nz, kind: s.kind, hx: h[0], hy: h[1], hz: h[2], yawQ: L ? L.yawQ : cmd.yawQ | 0 };
  }
  // v laid on the plane with normal n, unit length; null if v points (almost) along n
  _onPlane(n, x, y, z) {
    const k = x * n.nx + y * n.ny + z * n.nz;
    x -= k * n.nx; y -= k * n.ny; z -= k * n.nz;
    const l = Math.sqrt(x * x + y * y + z * z);
    return l < 1e-3 ? null : [x / l, y / l, z / l];
  }
  // the camera's forward laid on the surface; looking straight at it, the camera's up; failing both, any tangent
  _camHeading(n, cmd) {
    const yaw = cmd.yawQ * 1e-4, pitch = cmd.pitchQ * 1e-4, sy = dsin(yaw), cy = dcos(yaw), sp = dsin(pitch), cp = dcos(pitch);
    return this._onPlane(n, sy * cp, sp, cy * cp) || this._onPlane(n, -sy * sp, cp, -cy * sp) || this._onPlane(n, 1, 0, 0) || this._onPlane(n, 0, 0, 1);
  }
  // mouse left/right turns a landed wasp about the surface normal, exactly as yaw turns it on flat ground
  _turn(w, cmd) {
    const L = w.land;
    if (!L) return;
    if (L.hx === undefined) { const h = this._camHeading(L, cmd); L.hx = h[0]; L.hy = h[1]; L.hz = h[2]; L.yawQ = cmd.yawQ | 0; }
    const d = ((cmd.yawQ | 0) - L.yawQ) * 1e-4;
    L.yawQ = cmd.yawQ | 0;
    if (d === 0) return;
    const c = dcos(d), s = dsin(d);
    const ex = L.ny * L.hz - L.nz * L.hy, ey = L.nz * L.hx - L.nx * L.hz, ez = L.nx * L.hy - L.ny * L.hx; // n x h
    const h = this._onPlane(L, L.hx * c + ex * s, L.hy * c + ey * s, L.hz * c + ez * s);
    if (h) { L.hx = h[0]; L.hy = h[1]; L.hz = h[2]; }
  }

  _maybeLand(w, cmd) {
    if (cmd.mx || cmd.my || cmd.mz || cmd.burst || cmd.sting || this.tick < (w.noLandUntil || 0)) return;
    if (w.vx * w.vx + w.vy * w.vy + w.vz * w.vz > T.land.maxSpeed * T.land.maxSpeed) return;
    if (w.contact && !w.contact.blockedPerch) { this._perch(w, w.contact); return; }
    const s = this._staticSurface(w, T.land.reach);
    if (!s) return;
    w.state = 'landed'; w.vx = w.vy = w.vz = 0;
    w.land = null;
    this._settle(w, s, cmd);
    this.emit('landed', { id: w.id, surface: s.kind });
  }

  // push off along the surface normal: up from the ground, sideways off a trunk, down from under a table
  _takeoff(w) {
    const n = w.land || { nx: 0, ny: 1, nz: 0 };
    w.state = 'fly'; w.vx = n.nx * 0.5; w.vy = n.ny * 0.5 + 0.1; w.vz = n.nz * 0.5; w.walking = false;
    w.noLandUntil = this.tick + T.land.afterTakeoff; // clear of the surface before it can settle again
    // the camera picks up the heading the wasp had on the surface
    this.emit('takeoff', { id: w.id, hx: w.land && w.land.hx, hy: w.land && w.land.hy, hz: w.land && w.land.hz });
    w.land = null;
  }

  // Walk along whatever the wasp stands on, at any angle: forward along its heading, strafe across it, as on flat
  // ground. After each step the wasp is put back on the nearest surface, so it follows round edges, up trunks and
  // under table tops, and never falls off: only Space or Shift take off.
  _walk(w, cmd) {
    const L = w.land;
    if (!L || L.hx === undefined) return;
    const mz = cmd.mz / 100, mx = cmd.mx / 100;
    const rx = L.hy * L.nz - L.hz * L.ny, ry = L.hz * L.nx - L.hx * L.nz, rz = L.hx * L.ny - L.hy * L.nx; // h x n: to the right
    const dx = L.hx * mz + rx * mx, dy = L.hy * mz + ry * mx, dz = L.hz * mz + rz * mx;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return;
    const step = T.land.walkSpeed * DT * Math.min(1, len) / len;
    const s = this._staticSurface({ x: w.x + dx * step, y: w.y + dy * step, z: w.z + dz * step }, T.land.stick);
    if (!s) return; // nothing to hold on to that way
    this._settle(w, s, cmd);
    w.walking = true;
    // walking into a person climbs onto them (an arm on the table, a leg on the grass)
    this._contactQuery(w);
    if (w.contact && !w.contact.blockedPerch) { w.walking = false; w.land = null; this._perch(w, w.contact); return; }
    w.contact = null;
  }

  // ---------------- level 5: municipal pest control (GDD 8.10)

  // Runs first in every colony tick on every peer. It reads only shared state (chunk escalation and the clock),
  // so every peer starts and ends a campaign on the same tick.
  _muniTick() {
    if (!this.settings.pestControl) return;
    const M = T.muni, m = this.muni || (this.muni = { n: 0, active: null, cooldownUntil: 0 });
    if (m.active) {
      if (this.minute >= m.active.until) {
        for (const k of m.active.keys) { const st = this.chunkState.get(k); if (st) st.esc *= M.aftermath; }
        this.emit('muniEnd', { n: m.active.n, keys: m.active.keys });
        m.active = null; m.cooldownUntil = this.minute + M.cooldownDays * 1440;
      } else this._muniAbstract();
      return;
    }
    if (this.minute < m.cooldownUntil) return;
    const keys = [...this.chunkState.keys()].sort();
    for (const k of keys) {
      if (this.escLevel(k) < M.level) continue;
      const [cx, cz] = k.split(',').map(Number), area = [];
      for (let dz = -M.radius; dz <= M.radius; dz++) for (let dx = -M.radius; dx <= M.radius; dx++) area.push(chunkKey(cx + dx, cz + dz));
      m.n++;
      m.active = { n: m.n, center: k, keys: area, until: this.minute + M.days * 1440 };
      this.emit('muniStart', { n: m.n, center: k, keys: area, until: m.active.until });
      return;
    }
  }

  // Bait stations hang on tree trunks at chest height, picked by hash from the chunk's trees
  _baitsIn(key) {
    const m = this.muni;
    if (!m || !m.active || !m.active.keys.includes(key)) return [];
    const rec = this.records.get(key);
    if (!rec) return [];
    const cache = this._baitCache || (this._baitCache = new Map()), ck = m.active.n + '|' + key;
    if (cache.has(ck)) return cache.get(ck);
    const trees = rec.content.trees.map((t, i) => ({ t, h: hseq(m.active.n, rec.cx, rec.cz, i, 77) })).sort((a, b) => a.h - b.h).slice(0, T.muni.baitsPerChunk);
    const out = trees.map(({ t, h }) => {
      const a = h * 6.28318, r = t.r + 0.03;
      return { x: t.x + r * dcos(a), y: T.muni.baitHeight, z: t.z + r * dsin(a), key };
    });
    if (cache.size > 64) cache.clear();
    cache.set(ck, out);
    return out;
  }

  muniBaits() { const m = this.muni; if (!m || !m.active) return []; return this.activeChunks.flatMap((r) => this._baitsIn(chunkKey(r.cx, r.cz))); }

  _baitNear(w) {
    const r2 = T.muni.baitDist * T.muni.baitDist;
    for (const b of this.muniBaits()) if (dist2(w, b) <= r2) return b;
    return null;
  }

  _takeBait(w) {
    w.carry = { kind: 'protein', amount: T.muni.baitProtein, what: 'bait', poison: true };
    this.emit('baitTaken', { id: w.id, driven: w.id === this.drivenId });
  }

  // A poisoned load reaches the nest: it is fed to larvae and shared with adults
  _poison(amount, byId) {
    const M = T.muni, col = this.colony;
    const inside = Math.max(0, col.adults - this._own().filter((x) => x.caste !== 'queen').length);
    const adults = Math.min(inside, col.adults * M.poisonAdults * amount);
    const lf = Math.min(1, M.poisonLarvae * amount), larvae = col.larvae * lf + col.rLarvae * lf;
    col.adults -= adults; col.larvae -= col.larvae * lf; col.rLarvae -= col.rLarvae * lf;
    col.stats.poisoned = (col.stats.poisoned || 0) + adults + larvae;
    this.emit('poisoned', { id: byId, adults, larvae });
  }

  // Abstract foragers in a baited area bring poison home too, in proportion to how hard they hunt protein
  _muniAbstract() {
    const m = this.muni, col = this.colony;
    if (!col.nestAlive || !m.active.keys.includes(this.nest.key)) return;
    if (!(isDaylight(this.minute) && !this.raining && this.canFly())) return;
    const a = T.alloc[col.alloc], share = a.protein / ((a.sugar + a.protein + a.pulp) / 3) * a.traffic; // fewer foragers out, less bait brought home
    const dtDay = 60 / this.dayTicks;
    const inside = Math.max(0, col.adults - this._own().length);
    const kill = inside * T.muni.abstractKillPerDay * share * dtDay;
    col.adults -= kill; col.larvae -= col.larvae * T.muni.abstractKillPerDay * share * dtDay;
    col.stats.poisoned = (col.stats.poisoned || 0) + kill;
  }

  _nearCan(w) {
    for (const rec of this.activeChunks) for (const c of rec.content.cans) { const dx = w.x - c.x, dz = w.z - c.z; if (dx * dx + dz * dz < 0.09) return true; }
    return false;
  }

  // ---------------- rival colonies (GDD 9.3)

  _rivalNestNear(w) {
    for (const rec of this.activeChunks) {
      const rv = rec.content.rival;
      if (rv && sq(w.x - rv.ex) + sq(w.y - rv.ey) + sq(w.z - rv.ez) < 0.08 * 0.08) return { rv, key: chunkKey(rec.cx, rec.cz) };
    }
    return null;
  }

  _raid(w, r) {
    w.carry = { kind: 'protein', amount: T.rival.raidProtein, what: 'larva' };
    this._rivalsHunt(r.key, w.id, w);
    if (this.net) this._publish({ type: 'raid', key: r.key, id: w.id, x: w.x, y: w.y, z: w.z });
    this.emit('raid', { id: w.id, key: r.key });
  }

  _rivalsHunt(key, id, at) {
    for (const x of this.wasps) if (x.colony === key && dist2(x, at) < 64) { x.ai.mode = 'hunt'; x.ai.huntId = id; x.ai.timer = this.tick + T.rival.huntTicks; }
  }

  // Rival workers come and go only around their own nest, and only on the world-authority peer
  _rivals(daylight) {
    if (this.net && this.peer !== 0) return;
    if (!this.settings.rivals) { for (const w of this.wasps.slice()) if (w.colony !== 'own') this._despawn(w); return; }
    const activeKeys = new Set(this.activeChunks.map((r) => chunkKey(r.cx, r.cz)));
    for (const w of this.wasps.slice()) if (w.colony !== 'own' && !activeKeys.has(w.colony)) this._despawn(w);
    if (!daylight) return;
    for (const rec of this.activeChunks) {
      const rv = rec.content.rival;
      if (!rv) continue;
      const key = chunkKey(rec.cx, rec.cz);
      const n = this.wasps.filter((x) => x.colony === key).length;
      if (n >= Math.min(T.rival.maxPhysical, rv.workers) || this.tick % 180 >= 60) continue;
      const w = this._spawnWasp(false);
      w.colony = key; w.x = rv.ex; w.y = rv.ey - 0.03; w.z = rv.ez;
      w.role = n === 0 ? 'guard' : h32(w.id, 9) < 0.5 ? 'sugar' : 'protein';
      w.ai.mode = w.role === 'guard' ? 'guard' : 'pick';
    }
  }

  _thinkRival(w, cmd) {
    const ai = w.ai, rec = this.records.get(w.colony), rv = rec && rec.content.rival;
    if (!rv) { this._despawn(w); return cmd; }
    const home = { x: rv.ex, y: rv.ey - 0.02, z: rv.ez };
    if (!isDaylight(this.minute) || this.raining) ai.mode = 'home';
    if (ai.mode === 'guard') {
      let t = this.wasps.find((x) => x.colony === 'own' && (x.state === 'fly' || x.state === 'landed') && dist2(x, home) < sq(T.rival.guardRadius));
      // other players' wasps near the nest count too (rivals live on this peer only)
      if (!t) for (const r of this.remote.values()) if (!r.rival && (r.state === 'fly' || r.state === 'landed') && dist2(r, home) < sq(T.rival.guardRadius)) { t = r; break; }
      if (t) { ai.mode = 'hunt'; ai.huntId = t.id; ai.timer = this.tick + T.rival.huntTicks; }
      else { this._steer(w, { x: home.x + 0.12 * dcos(this.tick / 40 + w.id), y: home.y + 0.05, z: home.z + 0.12 * dsin(this.tick / 40 + w.id) }, cmd); return cmd; }
    }
    if (ai.mode === 'hunt') {
      const t = this.waspById(ai.huntId) || this.remote.get(ai.huntId);
      if (!t || (t.colony !== undefined && t.colony !== 'own') || t.rival || this.tick > ai.timer || (t.state !== 'fly' && t.state !== 'landed' && t.state !== 'chewing')) { ai.mode = w.role === 'guard' ? 'guard' : 'return'; return cmd; }
      this._steer(w, t, cmd); cmd.throttle = 1; cmd.burst = 1;
      return cmd;
    }
    if (ai.mode === 'home' || ai.mode === 'return') {
      this._steer(w, home, cmd);
      if (dist2(w, home) < 0.07 * 0.07) {
        w.carry = null; w.ai.cargo = 0; w.energy = 1;
        if (ai.mode === 'home') { this._despawn(w); return cmd; }
        ai.mode = w.role === 'guard' ? 'guard' : 'pick';
      }
      return cmd;
    }
    if (w.energy < 0.2) { ai.mode = 'return'; return cmd; }
    if (ai.mode === 'pick') { this._aiPick(w); return cmd; }
    if (ai.mode === 'outbound' || ai.mode === 'collect') {
      const tp = this._aiTargetPos(w);
      if (!tp) { ai.mode = w.carry ? 'return' : 'pick'; return cmd; }
      this._steer(w, tp, cmd);
      if (ai.mode === 'outbound' && dist2(w, tp) < T.ai.arrive * T.ai.arrive) { ai.mode = 'collect'; ai.timer = this.tick + T.ai.collectTicks; }
      if (ai.mode === 'collect') {
        if (ai.target.kind === 'prey') { const p = this._preyNear(w); if (p) { this._catch(w, p); ai.mode = 'return'; } else if (this.tick > ai.timer) ai.mode = 'pick'; }
        else if (ai.target.kind === 'bait') { if (!w.carry) this._takeBait(w); ai.mode = 'return'; ai.target = null; }
        else if ((ai.cargo || 0) >= 0.95 || this.tick > ai.timer + 300) ai.mode = 'return';
      }
      return cmd;
    }
    ai.mode = 'pick';
    return cmd;
  }

  // Wasps of different colonies that touch grapple; the weaker one dies (GDD 9.3)
  _startRemoteFight(a, otherId, peer) {
    a.state = 'fighting'; a.vx = a.vy = a.vz = 0;
    a.fight = { other: otherId, remote: true, starter: true, peer, start: this.tick, until: this.tick + T.rival.fightTicks, myVenom: a.venom, mash: 0 };
    this._publish({ type: 'fight', a: a.id, b: otherId, toPeer: peer, venom: a.venom, queen: a.caste === 'queen' });
  }

  _fightScore(id, venom, queen, mash, start) { return venom + (queen ? 1 : 0) + mash + h32(id, start, 61) * 1.2; }

  _fightResolve(w, won, otherId) {
    if (won) { w.state = 'stunned'; w.stateTicks = 20; w.fight = null; this.emit('fightOver', { winner: w.id, loser: otherId }); }
    else { this._die(w, w.colony === 'own' ? 'killed by a rival wasp' : 'killed by a player\'s wasp', null); this.emit('fightOver', { winner: otherId, loser: w.id }); }
  }

  // A fight with a wasp another peer owns. The joining side resolves when the fight ends and publishes its mash;
  // the starting side waits for that, and gives up if it never comes.
  _remoteFightTick(w) {
    const f = w.fight;
    if (f.starter) { if (this.tick > f.until + T.rival.remoteFightTimeout) { w.state = 'fly'; w.fight = null; } return; }
    if (this.tick < f.until) return;
    const bWins = this._fightScore(w.id, f.myVenom, w.caste === 'queen', f.mash, f.start) > this._fightScore(f.other, f.theirVenom, f.theirQueen, 0, f.start);
    this._publish({ type: 'fightEnd', a: f.other, b: w.id, toPeer: f.peer, mash: f.mash, venom: f.myVenom, queen: w.caste === 'queen' });
    this._fightResolve(w, bWins, f.other);
  }

  _fights() {
    const R = T.rival;
    for (const w of this.wasps.slice()) {
      if (w.state !== 'fighting') continue;
      if (w.fight.remote) { this._remoteFightTick(w); continue; }
      if (this.tick < w.fight.until || w.fight.other < w.id) continue;
      const o = this.waspById(w.fight.other);
      if (!o) { w.state = 'fly'; w.fight = null; continue; }
      const score = (x) => x.venom + (x.caste === 'queen' ? 1 : 0) + x.fight.mash + h32(x.id, this.tick, 61) * 1.2;
      const [win, lose] = score(w) >= score(o) ? [w, o] : [o, w];
      win.state = 'stunned'; win.stateTicks = 20; win.fight = null;
      this._die(lose, lose.colony === 'own' ? 'killed by a rival wasp' : 'killed by your worker', null);
      this.emit('fightOver', { winner: win.id, loser: lose.id });
    }
    const free = this.wasps.filter((w) => w.state === 'fly' || w.state === 'landed' || w.state === 'chewing');
    for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
      const a = free[i], b = free[j];
      if (a.colony === b.colony || a.state === 'fighting' || b.state === 'fighting') continue;
      if (dist2(a, b) > R.fightRange * R.fightRange) continue;
      for (const [x, y] of [[a, b], [b, a]]) { x.state = 'fighting'; x.vx = x.vy = x.vz = 0; x.fight = { other: y.id, until: this.tick + R.fightTicks, mash: 0 }; }
      this.emit('fight', { a: a.id, b: b.id, driven: a.id === this.drivenId || b.id === this.drivenId });
    }
    if (!this.net || !this.remote.size) return;
    // My wasps touching another peer's rival on my screen: ask its owner to start the fight
    for (const w of free) {
      if (w.colony !== 'own' || (w.fightReqUntil || 0) > this.tick) continue;
      for (const [id, r] of this.remote) {
        if (!r.rival || r.state !== 'fly' && r.state !== 'landed' && r.state !== 'chewing') continue;
        if (dist2(w, r) > R.fightRange * R.fightRange * 4) continue;
        w.fightReqUntil = this.tick + 30;
        this._publish({ type: 'fightReq', a: id, b: w.id, toPeer: r.peer });
        break;
      }
    }
    // My guards against other players' wasps near my nest (T1-13): I own the guards, so I start these fights.
    // Their rivals are left to the fightReq path above.
    const busy = new Set();
    for (const w of this.wasps) if (w.state === 'fighting' && w.fight.remote) busy.add(w.fight.other);
    for (const g of free) {
      if (g.colony !== 'own' || g.role !== 'guard' || g.ai.mode !== 'hunt' || g.id === this.drivenId || g.state === 'fighting') continue;
      const r = this.remote.get(g.ai.huntId);
      if (!r || r.rival || busy.has(g.ai.huntId) || !(r.state === 'fly' || r.state === 'landed' || r.state === 'chewing')) continue;
      if (dist2(g, r) > R.remoteFightRange * R.remoteFightRange) continue;
      this._startRemoteFight(g, g.ai.huntId, r.peer);
      busy.add(g.ai.huntId);
    }
    // My rivals against other peers' wasps: I own the rivals, so I start these fights
    const rr = R.remoteFightRange * R.remoteFightRange;
    for (const a of free) {
      if (a.colony === 'own' || a.state === 'fighting') continue;
      for (const [id, r] of this.remote) {
        if (r.rival || busy.has(id) || !(r.state === 'fly' || r.state === 'landed' || r.state === 'chewing')) continue;
        if (dist2(a, r) > rr) continue;
        this._startRemoteFight(a, id, r.peer);
        busy.add(id);
        break;
      }
    }
  }

  // ---------------- colony tick (1 Hz)

  _colonyTick() {
    this._muniTick(); // the town's campaign runs on whether or not any colony is left
    if (this.extinct || this.winter) return; // the line is over, or the queens sleep until one is chosen
    const col = this.colony;
    const daylight = isDaylight(this.minute) && !this.raining && this.canFly();
    const frac = this.seasonFrac;
    if (this.colony.sited === false && frac > 0.03) {
      const old = this.oldNests[this.oldNests.length - 1] || this.nest;
      const t = this.springAt ? this._treeNear(this.springAt) : null;
      if (t) { // the nearest tree to where she wintered (T1-15)
        let dx = this.springAt.x - t.x, dz = this.springAt.z - t.z; const d = Math.sqrt(dx * dx + dz * dz) || 1; dx /= d; dz /= d;
        this.nest = makeNest(t.x, t.z, t.x + dx * (t.r + 0.2), clamp(1.6, 1.2, Math.max(1.2, t.h - 0.6)), t.z + dz * (t.r + 0.2), NEST.r, 'trunk');
      } else this.nest = makeNest(old.treeX, old.treeZ, old.x, old.y, old.z, old.r, old.site || 'trunk');
      this.colony.sited = true;
      this.colony.maxCells = T.sites[this.nest.site].maxCells;
      this.emit('nestFounded', { x: this.nest.x, y: this.nest.y, z: this.nest.z, key: this.nest.key, auto: true });
    }
    colonyStep(col, 60 / this.dayTicks, this._own().filter((w) => w.caste !== 'queen').length, daylight, frac, this.bio, this.broodSpeed(), this.ecoAvail());
    if (this.raining && col.nestAlive && col.sited) {
      // the site decides what rain costs: burrows flood, open nests chill (GDD 6.6)
      const st = T.sites[this.nest.site || 'trunk'], dt = 60 / this.dayTicks;
      const fl = st.flood * dt, inside = Math.max(0, col.adults - this._own().length);
      col.eggs -= col.eggs * fl; col.larvae -= col.larvae * fl; col.pupae -= col.pupae * fl;
      col.rEggs -= col.rEggs * fl; col.rLarvae -= col.rLarvae * fl; col.rPupae -= col.rPupae * fl;
      const cold = Math.min(inside, inside * T.sites.rainMortality * st.exposure * dt);
      col.adults -= cold; col.stats.died += cold;
    }
    const ph = seasonPhase(frac);
    if (ph !== this.season.phase) { this.season.phase = ph; this.emit('season', { phase: ph }); }
    if (frac >= 1) { this._endSeason('autumn'); return; }
    if (colonyFinished(col, this._own().length) && !this._own().length) { this._endSeason('colony lost'); return; }
    this._extCheck();
    // launch physical AI foragers while the player is near the nest (GDD 11.12: far colonies stay abstract)
    this._rivals(daylight);
    const nearNest = this.colony.sited && this.activeChunks.some((r) => chunkKey(r.cx, r.cz) === this.nest.key);
    if (!nearNest) {
      for (const w of this._own()) if (w.id !== this.drivenId) this._despawn(w);
      return;
    }
    const own = this._own().length;
    const inside = col.adults - own;
    const d = this._driven();
    const guards = this._own().filter((w) => w.role === 'guard' && w !== d).length;
    const ai = own - (d ? 1 : 0) - guards;
    // the oldest workers guard the entrance first (T1-13); the rest of the cap is foragers, and the young stay in
    const mature = col.adults - col.young;
    const cap = Math.min(T.ai.maxPhysical, Math.floor(mature * 0.4 * T.alloc[col.alloc].traffic));
    if (this.noAI || !daylight || !col.nestAlive || inside - col.young < 1 || this.tick % T.ai.launchEvery >= 60) return;
    if (guards < (mature >= T.guard.minAdults ? T.guard.count : 0)) {
      const w = this._spawnWasp(false);
      w.role = 'guard'; w.ai.mode = 'guard';
      this.emit('guardOut', { id: w.id });
    } else if (ai < cap) this._spawnWasp(false);
  }

  // ---------------------------------------------------------------- AI brain (one decision per tick per AI wasp)

  _aiAttack(w, humanHex) {
    w.ai.mode = 'attack'; w.ai.humanHex = humanHex; w.ai.timer = this.tick + T.ai.attackTicks; w.ai.until = w.ai.timer; w.ai.stings = 2; w.ai.target = null;
    this.emit('aiAttack', { id: w.id, humanHex });
  }

  _think(w) {
    const ai = w.ai;
    const cmd = { dirX: 0, dirY: 0, dirZ: 0, throttle: 0, burst: 0, sting: 0, act: 0 };
    if (w.state === 'balled') { this._ballEscape(w, false); return cmd; }
    if (w.state !== 'fly') return cmd;
    if (w.colony !== 'own') return this._thinkRival(w, cmd);
    // alarm pheromone pulls nearby workers into an attack
    if (ai.mode !== 'attack' && ai.mode !== 'evade') {
      for (const a of this.alarms) {
        const k = this.humanByHex(a.killerHex);
        if (dist2(w, a) < T.alarm.radius * T.alarm.radius && k && k.state !== 'away') { this._aiAttack(w, a.killerHex); break; }
      }
    }
    const daylight = isDaylight(this.minute) && !this.raining;
    if ((!daylight || w.caste === 'queen') && ai.mode !== 'home') { ai.mode = 'home'; ai.target = null; }
    if (w.energy < 0.2 && ai.mode !== 'home' && ai.mode !== 'collect') { ai.mode = 'return'; ai.target = null; }
    if (w.role === 'guard' && (ai.mode === 'guard' || ai.mode === 'hunt' || ai.mode === 'pick')) return this._thinkGuard(w, cmd);
    switch (ai.mode) {
      case 'pick': this._aiPick(w); break;
      case 'outbound': {
        const tp = this._aiTargetPos(w);
        if (!tp) { ai.mode = 'pick'; break; }
        this._steer(w, tp, cmd);
        if (dist2(w, tp) < T.ai.arrive * T.ai.arrive) { ai.mode = 'collect'; ai.timer = this.tick + T.ai.collectTicks; }
        break;
      }
      case 'collect': {
        const tp = this._aiTargetPos(w);
        if (!tp) { ai.mode = w.carry || ai.cargo > 0.3 ? 'return' : 'pick'; break; }
        this._steer(w, tp, cmd);
        const t = ai.target;
        if (t.kind === 'prey') {
          const p = this._preyNear(w);
          if (p) { this._catch(w, p); ai.mode = 'return'; ai.target = null; }
          else if (this.tick > ai.timer) ai.mode = 'pick';
        } else if (t.kind === 'hive') {
          if (!w.carry && this.hiveLoadsLeft(t.key, t.i) > 0) { this._startRob(w, t.key, t.i); return cmd; }
          ai.mode = 'return'; ai.target = null;
        } else if (t.kind === 'wood') {
          if (this.tick > ai.timer) { w.carry = { kind: 'pulp', amount: T.pulp.amount, what: 'pulp' }; ai.mode = 'return'; ai.target = null; this.emit('chewed', { id: w.id }); }
        } else if ((ai.cargo || 0) >= 0.95 || this.tick > ai.timer + 300) { ai.mode = 'return'; ai.target = null; }
        break;
      }
      case 'return':
      case 'home': {
        this._steer(w, this.nest.entrance, cmd);
        if (dist2(w, this.nest.entrance) < 0.07 * 0.07) {
          if (ai.mode === 'home' || (w.energy < 0.3 && this.colony.sugar <= 0)) { this._nestTouch(w); this._despawn(w); return cmd; }
          ai.mode = 'pick';
        }
        break;
      }
      case 'attack': {
        const hm = this.humanByHex(ai.humanHex);
        if (!hm || hm.state === 'away' || this.tick > ai.timer || ai.stings <= 0) { ai.mode = 'return'; break; }
        if (!ai.target || ai.target.hex !== hm.hex || this.tick % 30 === 0) ai.target = this._aiStingPoint(w, hm);
        if (!ai.target) { ai.mode = 'return'; break; }
        const tp = toWorld(hm, ai.target.p);
        this._steer(w, tp, cmd);
        if (dist2(w, tp) < 0.08 * 0.08) cmd.sting = 1;
        break;
      }
      case 'evade': {
        cmd.dirY = 0.6; cmd.dirX = dcos(w.id); cmd.dirZ = dsin(w.id); cmd.throttle = 1; cmd.burst = 1;
        if (this.tick > ai.timer) { if (ai.stings > 0 && this.tick < ai.until) { ai.mode = 'attack'; ai.timer = ai.until; } else ai.mode = 'return'; }
        break;
      }
    }
    return cmd;
  }

  // A guard (T1-13) circles just outside the entrance. Another colony's wasp near it (a rival, or another player's)
  // gets chased and grappled; the exterminator close to the nest gets stung.
  _thinkGuard(w, cmd) {
    const ai = w.ai, G = T.guard, n = this.nest, e = n.entrance;
    const ox = e.x - n.x, oz = e.z - n.z, od = Math.sqrt(ox * ox + oz * oz);
    const post = od > 0.01 ? { x: e.x + ox / od * 0.08, y: e.y, z: e.z + oz / od * 0.08 } : { x: e.x, y: e.y - 0.08, z: e.z };
    const live = (t) => t && (t.state === 'fly' || t.state === 'landed' || t.state === 'chewing');
    if (ai.mode === 'hunt') {
      const t = this.waspById(ai.huntId) || this.remote.get(ai.huntId);
      if (!live(t) || (t.colony === 'own') || this.tick > ai.timer || dist2(t, post) > G.chase * G.chase) ai.mode = 'guard';
      else { this._steer(w, t, cmd); cmd.throttle = 1; cmd.burst = 1; return cmd; }
    }
    ai.mode = 'guard';
    const r2 = G.radius * G.radius;
    let t = this.wasps.find((x) => x.colony !== 'own' && live(x) && dist2(x, post) < r2);
    if (!t) for (const [id, r] of this.remote) if (live(r) && dist2(r, post) < r2) { t = { id, remote: !r.rival }; break; }
    if (t) { ai.mode = 'hunt'; ai.huntId = t.id; ai.timer = this.tick + G.huntTicks; this.emit('guardHunt', { id: w.id, target: t.id, player: !!t.remote }); return cmd; }
    const x = this.ext.hm;
    if (x && x.state !== 'flee' && x.state !== 'leave' && sq(x.x - e.x) + sq(x.z - e.z) < G.humanRadius * G.humanRadius) { this._aiAttack(w, x.hex); return cmd; }
    const a = this.tick / 40 + w.id;
    this._steer(w, { x: post.x + G.ring * dcos(a), y: post.y + 0.03, z: post.z + G.ring * dsin(a) }, cmd);
    return cmd;
  }

  _aiPick(w) {
    const ai = w.ai, col = this.colony;
    let best = null, bs = Infinity;
    const consider = (t, pos) => {
      const s = Math.sqrt(dist2(w, pos)) + h32(w.id, t.i | 0, t.c | 0, this.day) * 12;
      if (s < bs) { bs = s; best = t; }
    };
    for (let ri = 0; ri < this.activeChunks.length; ri++) {
      const rec = this.activeChunks[ri], c = rec.content, key = chunkKey(rec.cx, rec.cz), st = this.cs(key), lvl = this.escLevel(key);
      if (w.role === 'sugar') {
        const fi = this._flowerIdx(rec);
        c.sugar.forEach((s, i) => {
          if (s.kind === 'can' && (lvl >= 2 || col.deficit < T.ai.canDeficit)) return;
          if (s.kind === 'flower' && (!this.inBloom(rec, fi[i]) || this.nectarAt(rec, fi[i]) < 0.2)) return; // nothing there (T1-8)
          consider({ kind: 'sugar', key, i, c: ri }, s);
        });
        if (lvl >= 3 && col.deficit >= T.ai.canDeficit) c.traps.forEach((tr, i) => consider({ kind: 'trap', key, i, c: ri + 50 }, tr));
        // short of sugar, a forager will rob a hive (T1-9)
        if (col.deficit >= T.ai.canDeficit) this.hivesIn(rec).forEach((hv, h) => { if (this.hiveLoadsLeft(key, h) > 0) consider({ kind: 'hive', key, i: h, c: ri + 100 }, { x: hv.ex, y: hv.ey, z: hv.ez }); });
        this.spillsIn(key).forEach((sp) => consider({ kind: 'spill', key, i: sp.i, c: ri + 60 }, sp));
        this.fruitIn(rec).forEach((f) => consider({ kind: 'fruit', key, i: f.i, c: ri + 80 }, f));
      } else if (w.role === 'protein') {
        c.flies.forEach((f, i) => { if ((st.caughtFly[i] || 0) <= this.tick && this.flyActive(rec, i)) consider({ kind: 'prey', sub: 'fly', key, i, c: ri }, flyPos(f, this.tick)); });
        c.caterpillars.forEach((f, i) => { if (!st.caughtCat[i] && this.catActive(rec, i)) consider({ kind: 'prey', sub: 'cat', key, i, c: ri + 20 }, f); });
        for (const cr of this.carrionIn(rec)) consider({ kind: 'prey', sub: 'carrion', key, i: cr.d, c: ri + 90 }, cr);
        this._baitsIn(key).forEach((b, i) => {
          // a bait station smells of meat from a long way off
          const s = Math.sqrt(dist2(w, b)) - T.muni.aiLure + h32(w.id, i, ri + 70, this.day) * 12;
          if (s < bs) { bs = s; best = { kind: 'bait', key, i, c: ri + 70 }; }
        });
      } else {
        c.boxes.forEach((b, i) => { if (b.wood && !b.hive) consider({ kind: 'wood', key, i, c: ri + 40 }, { x: (b.minx + b.maxx) / 2, y: b.maxy, z: (b.minz + b.maxz) / 2 }); });
      }
    }
    if (best) { ai.target = best; ai.mode = 'outbound'; } else ai.mode = 'return';
  }

  _aiTargetPos(w) {
    const t = w.ai.target;
    if (!t) return null;
    const rec = this.records.get(t.key);
    if (!rec || !this.activeChunks.includes(rec)) return null;
    const c = rec.content, st = this.cs(t.key);
    if (t.kind === 'sugar') {
      const s = c.sugar[t.i];
      if (s.kind === 'can') {
        // into the cup: above the opening first, then down to just over the drink (GDD 7.5)
        const cp = this.cupsIn(rec).find((q) => q.x === s.x && q.z === s.z), rIn = T.cup.r - T.cup.wall;
        if (cp) return sq(w.x - cp.x) + sq(w.z - cp.z) > sq(rIn * 0.5) && w.y < T.cup.rim + 0.01 ? { x: cp.x, y: T.cup.rim + 0.03, z: cp.z } : { x: cp.x, y: cp.level + 0.016, z: cp.z };
      }
      return { x: s.x, y: s.y + 0.012, z: s.z };
    }
    if (t.kind === 'trap') return c.traps[t.i];
    if (t.kind === 'hive') { const hv = this.hivesIn(rec)[t.i]; return hv ? { x: hv.ex, y: hv.ey, z: hv.ez } : null; }
    if (t.kind === 'fruit') { const f = this.fruitIn(rec).find((x) => x.i === t.i); return f ? { x: f.x, y: f.y + 0.015, z: f.z } : null; }
    if (t.kind === 'spill') { const sp = this.spillsIn(t.key).find((x) => x.i === t.i); return sp ? { x: sp.x, y: sp.y + 0.012, z: sp.z } : null; }
    if (t.kind === 'bait') return this._baitsIn(t.key)[t.i] || null;
    if (t.kind === 'wood') { const b = c.boxes[t.i]; return { x: (b.minx + b.maxx) / 2 + 0.2 * (h32(w.id, t.i) - 0.5), y: b.maxy + T.wasp.radius + 0.008, z: (b.minz + b.maxz) / 2 }; }
    if (t.sub === 'fly') return (st.caughtFly[t.i] || 0) > this.tick || !this.flyActive(rec, t.i) ? null : flyPos(c.flies[t.i], this.tick);
    if (t.sub === 'cat') return st.caughtCat[t.i] || !this.catActive(rec, t.i) ? null : c.caterpillars[t.i];
    if (t.sub === 'carrion') return this.carrionIn(rec).find((x) => x.d === t.i) || null;
    return null;
  }

  // An exposed spot on a human that the wasp can reach (GDD 6.3: late-summer stings)
  _aiStingPoint(w, hm) {
    const parts = hm.parts[hm.posture];
    const lp = toLocal(hm, w);
    const order = [];
    for (let i = 0; i < parts.length; i++) order.push(i);
    order.sort((a, b) => h32(w.id, a, this.day) - h32(w.id, b, this.day));
    for (const i of order) {
      const part = parts[i];
      const mid = { x: (part.a.x + part.b.x) / 2, y: (part.a.y + part.b.y) / 2, z: (part.a.z + part.b.z) / 2 };
      const q = segClosest(part.a, part.b, mid);
      let nx = lp.x - q.x, ny = lp.y - q.y, nz = lp.z - q.z;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const surf = { x: q.x + nx * part.r, y: q.y + ny * part.r, z: q.z + nz * part.r };
      const zone = classify(part, q, { x: nx, y: ny, z: nz }, surf, hm.tr.height / 1.75);
      if (zoneCover(hm.clothing, zone) === 2) continue;
      return { hex: hm.hex, p: { x: surf.x + nx * 0.012, y: surf.y + ny * 0.012, z: surf.z + nz * 0.012 } };
    }
    return null;
  }

  _steer(w, tp, cmd) {
    let dx = tp.x - w.x, dy = tp.y - w.y, dz = tp.z - w.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-6) return;
    // climb over obstacles on long legs
    if (d > 3 && w.y < 1.4) dy += 1.2;
    const m = Math.sqrt(dx * dx + dy * dy + dz * dz);
    cmd.dirX = dx / m; cmd.dirY = dy / m; cmd.dirZ = dz / m;
    cmd.throttle = clamp(Math.sqrt(2 * T.wasp.accel * d) * 0.7 / T.wasp.cruise, 0.06, 1);
  }

  // after an AI sting: get out
  _aiAfterSting(w) { w.ai.stings--; w.ai.mode = 'evade'; w.ai.until = w.ai.timer; w.ai.timer = this.tick + T.ai.evadeTicks; }

  // ---------------------------------------------------------------- state hash (GDD 3.8)

  stateHash() {
    const buf = new Float64Array(1), bytes = new Uint8Array(buf.buffer);
    let h = 0x811c9dc5;
    const f = (v) => { buf[0] = v; for (let i = 0; i < 8; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } };
    f(this.tick); f(this.clockOffset); f(this.drivenId);
    for (const w of this.wasps) { f(w.id); f(w.x); f(w.y); f(w.z); f(w.vx); f(w.vy); f(w.vz); f(w.energy); f(w.venom); f(w.bodyT); }
    const c = this.colony;
    f(c.adults); f(c.eggs); f(c.larvae); f(c.pupae); f(c.cells); f(c.protein); f(c.sugar); f(c.pulp); f(c.deficit);
    f(c.rEggs); f(c.rLarvae); f(c.rPupae); f(c.gynes); f(c.mated); f(this.season.n); f(this.lineage);
    f(this.stung.size); f(this.stats.stings); f(this.stats.aiStings); f(this.records.size);
    for (const hm of this.active) { f(hm.x); f(hm.z); f(hm.panic); f(hm.posture === 'sit' ? 1 : 0); }
    for (const s of this.swats) { f(s.start); f(s.radius); }
    for (const [k, s] of this.chunkState) { f(s.esc); f(k.length); }
    for (const al of this.hiveAlarms.values()) for (const b in al.phys) { const p = al.phys[b]; f(p.x); f(p.y); f(p.z); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  static replay(settings, log, ticks) {
    const s = new Sim(settings);
    for (let t = 0; t < ticks; t++) { s.step(Sim.cmdAt(log, t)); s.events.length = 0; }
    return s.stateHash();
  }
}
