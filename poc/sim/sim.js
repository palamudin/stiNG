// STING simulation core (iteration 2). Mirrors Sting.Core: no rendering, no wall clock.
// Every wasp, driven or AI, goes through the same flight, contact, sting and swat code.
import { Domain, hash, unit, rangeInt, u64, h32, dsin, dcos, clamp, clamp01, fnv32, hex64 } from './rng.js';
import { T, DT, GEN_VERSION, DEFAULT_SETTINGS } from './tuning.js';
import {
  Zone, ZONES, SwatKind, SwatKindName, Style, humanTraits, humanClothing, suitClothing, zoneCover, bodyParts,
  segClosest, classify, toWorld, toLocal, dirToWorld, resolveSting, windowFor, selfReach, garmentGraph, Top,
} from './body.js';
import {
  chunkOf, chunkKey, NEST, NEST_ENTRANCE, SPAWN, generateChunk, ticksPerMinute, clockMinutes, dayOf, minuteOfDay,
  isRaining, tempAt, isDaylight, humanWindow, flyPos, beePos, birdPos, makeNest,
} from './world.js';
import { newColony, colonyStep, destroyNest, colonyFinished, seasonPhase } from './colony.js';

const CMD_FIELDS = 9; // mx, my, mz, burst, sting, yawQ, pitchQ, act, alloc
export const Act = { Interact: 1, Switch: 2, Rest: 4 };

const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; };
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byHumanId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Events that change shared world state. Most commit at the end of the consequence window so every
// peer applies them on the same tick (GDD 11.5); a few cosmetic or owner-decided ones apply on receipt.
const IMMEDIATE = new Set(['caught', 'beeAlarm', 'died', 'fight', 'fightReq', 'fightJoin', 'fightRefuse', 'fightEnd', 'raid']); // wasp-level: never touch humans

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
    this.colony = newColony();
    this.nest = makeNest(NEST.treeX, NEST.treeZ, NEST.x, NEST.y, NEST.z);
    this.colony.maxCells = T.sites.trunk.maxCells;
    this.oldNests = [];
    this.stung = new Set();
    this.stats = { stings: 0, aiStings: 0, remoteStings: 0, full: 0, deaths: 0, causes: {}, caught: 0, deposits: 0 };
    this.wasps = [];
    this.nextWaspId = this.peer * 1000000 + 1;
    this.ext = { visit: 0, state: 'none', arriveMinute: 0, hm: null };
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
    if (r !== 1) tr.reactionTicks = Math.max(T.resolve.minConsequenceTicks, Math.round(tr.reactionTicks * r));
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
  get temperature() { return tempAt(this.seed, this.minute); }
  get raining() { return isRaining(this.seed, this.minute); }
  get physicalCount() { return this._own().length; }
  _own() { return this.wasps.filter((w) => w.colony === 'own'); }
  get seasonFrac() { return (this.minute - this.season.startMinute) / (this.settings.seasonDays * 1440); }
  canFly() { return this.temperature >= T.weather.flyMinTemp; }

  _spawnWasp(driven, caste = 'worker') {
    const id = this.nextWaspId++;
    const w = {
      id, caste, x: this.nest.spawn.x, y: this.nest.spawn.y, z: this.nest.spawn.z, vx: 0, vy: 0, vz: 0, yaw: this.nest.spawn.yaw, pitch: 0,
      energy: 1, venom: 1, state: 'fly', stateTicks: 0, attach: null, under: null, ball: null, born: this.minute,
      carry: null, groundTicks: 0, chew: 0, role: 'sugar', colony: 'own', web: null, fight: null,
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
            annoyId: 0, annoy: 0, cooldown: 0, sprayCount: 0, clothesDay: this.day,
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
    if (edge & Act.Switch) this._possessNearest();
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
    this._fights(cmd);
    this._alarmDecay();
    // 3. humans at 20 Hz
    if (this.tick % 3 === 0) this._humans();
    // 4. colony at 1 Hz
    if (this.tick % 60 === 0) this._colonyTick();
    // 5. respawn of the driven wasp
    if (!this._driven() && !this.extinct && this.tick >= this.respawnAt) this._respawn();
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
    if (ev.type === 'sting' || ev.type === 'notice' || ev.type === 'press' || ev.type === 'preSwat') {
      const hm = this.humanByHex(ev.humanHex);
      const swats = ev.swats || (ev.type === 'preSwat' ? [{ start: ev.start }] : []);
      if (swats.length > P.maxSwats) return 'too many swats';
      for (const sw of swats) if (sw.start - ev.tick < (ev.type === 'sting' ? T.resolve.minConsequenceTicks : 0) || sw.start - ev.tick > P.maxSwatDelay) return 'swat timing';
      if (ev.type === 'sting') {
        if (!(ev.panicGain >= 0 && ev.panicGain <= 1)) return 'panic out of range';
        if (hm && typeof ev.sx === 'number') {
          const drift = P.humanDrift * Math.max(0, this.tick - ev.tick) / 60;
          if (Math.hypot(ev.sx - hm.x, ev.sz - hm.z) > P.stingReach + drift) return 'stung from out of reach';
        }
        const k = ev.peer + ':' + ev.waspId, ts = (this.plaus.stingTicks[k] || []).filter((t) => t > ev.tick - P.rateWindow);
        ts.push(ev.tick); this.plaus.stingTicks[k] = ts;
        if (ts.length > P.rateMax) return 'stinging faster than venom allows';
      }
    }
    return null;
  }

  _strike(peer, type, why) {
    this.netStats.rejected++;
    const n = (this.plaus.strikes[peer] || 0) + 1;
    this.plaus.strikes[peer] = n;
    this.emit('implausible', { peer, evType: type, why, strikes: n });
    if (n >= T.plaus.strikes && !this.plaus.quarantined.includes(peer)) {
      this.plaus.quarantined.push(peer);
      for (const [id, r] of this.remote) if (r.peer === peer) this.remote.delete(id);
      this.emit('quarantine', { peer });
    }
  }

  _remoteState(m) {
    const ids = new Set();
    for (const r of m.wasps) {
      const prev = this.remote.get(r.id);
      // display only: a wasp that moved faster than any wasp can is not drawn there (local, so it cannot desync)
      if (prev && prev.peer === m.peer && m.tick > prev.stamp) {
        const v = Math.hypot(r.x - prev.px, r.y - prev.py, r.z - prev.pz) / ((m.tick - prev.stamp) / 60);
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
        else (st.beeLost[ev.hive] || (st.beeLost[ev.hive] = {}))[ev.i] = 1;
        break;
      }
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
      case 'sting': {
        const hm = this.humanByHex(ev.humanHex);
        if (!hm) break;
        hm.panic = Math.min(1, hm.panic + ev.panicGain);
        hm.stungCount++;
        const first = !this.stung.has(hm.hex);
        this.stung.add(hm.hex);
        if (!mine) this.stats.remoteStings++; else if (ev.driven) this.stats.stings++; else this.stats.aiStings++;
        this.addEsc(hm.x, hm.z, T.esc.sting);
        this.cs(hm.chunk).lastSting = { x: ev.sx, z: ev.sz };
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
    const states = ['away', 'arrive', 'idle', 'flee', 'return', 'leave', 'treat'];
    for (const hm of this.active) { f(hm.x); f(hm.z); f(hm.panic); f(states.indexOf(hm.state)); f(hm.stungCount); f(hm.clothing.topOff ? 1 : 0); }
    // alert points, in key order; chunks a peer never touched count as zero on both sides
    for (const [k, st] of [...this.chunkState].filter(([, x]) => x.esc > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      f(k.length); f(st.esc);
      if (st.spilled) for (const i of Object.keys(st.spilled).sort()) { f(+i); f(st.spilled[i]); }
    }
    f(this.stung.size);
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  _record(cmd) {
    if (this.logLen + CMD_FIELDS > this.log.length) { const n = new Int32Array(this.log.length * 2); n.set(this.log); this.log = n; }
    const L = this.log, i = this.logLen;
    L[i] = cmd.mx | 0; L[i + 1] = cmd.my | 0; L[i + 2] = cmd.mz | 0; L[i + 3] = cmd.burst ? 1 : 0; L[i + 4] = cmd.sting ? 1 : 0;
    L[i + 5] = cmd.yawQ | 0; L[i + 6] = cmd.pitchQ | 0; L[i + 7] = cmd.act | 0; L[i + 8] = cmd.alloc | 0;
    this.logLen += CMD_FIELDS;
  }
  static cmdAt(log, t) {
    const i = t * CMD_FIELDS;
    return { mx: log[i], my: log[i + 1], mz: log[i + 2], burst: log[i + 3], sting: log[i + 4], yawQ: log[i + 5], pitchQ: log[i + 6], act: log[i + 7], alloc: log[i + 8] };
  }

  _minute(m) {
    const newDay = dayOf(m);
    this.minute = m;
    if (newDay !== this.day) {
      const days = newDay - this.day;
      this.day = newDay;
      let k = 1;
      for (let i = 0; i < days; i++) k *= 1 - T.esc.decayPerDay;
      for (const s of this.chunkState.values()) { s.esc *= k; s.beeLost = {}; s.caughtCat = {}; }
      this.emit('newDay', { day: newDay });
    }
  }

  // ---------------------------------------------------------------- possession and rest (GDD 7.7)

  // Q-03 settled: any worker within 30 m is free to take. Beyond that the colony relays you, after a delay, to the
  // nearest worker anywhere, or to a worker inside the nest who comes out.
  _possessNearest() {
    const d = this._driven();
    if (!d || d.state === 'under' || d.state === 'balled') return;
    if (this.pendingSwitch) { this.pendingSwitch = null; this.emit('switchCancelled'); return; }
    let best = null, bd = Infinity;
    for (const w of this.wasps) {
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
    for (let i = 0; i < steps; i++) colonyStep(this.colony, dtDay, this.wasps.length, false, this.seasonFrac, this.bio);
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
        // Walk on the surface with the move keys; climb, burst or sting to take off (GDD 7.2)
        if (!driven || cmd.my > 0 || cmd.burst || cmd.sting) { this._takeoff(w); break; }
        if (edge & Act.Interact) { this._interact(w); if (w.state !== 'landed') break; }
        w.walking = false;
        if (cmd.mx || cmd.mz) this._walk(w, cmd);
        if (w.state !== 'landed') break;
        this._feed(w, driven);
        if (w.state !== 'landed') break;
        this._hints(w);
        break;
      }
      case 'webbed': this._webStep(w, cmd, driven); break;
      case 'perched': this._perchStep(w, cmd, edge, armed, driven); break;
      case 'fighting': if (driven && cmd.sting && !this.pressUsed) { this.pressUsed = true; w.fight.mash += T.rival.mash; } break;
      case 'attached': this._attached(w, cmd, driven); break;
      case 'under': this._underStep(w, cmd, edge, armed); break;
      case 'chewing': this._chewStep(w, cmd, driven); break;
      case 'trapped':
        if (--w.stateTicks <= 0) this._die(w, 'drowned in a trap', null);
        break;
      case 'balled':
        if (driven) { this._ballEscape(w, cmd.burst && !w.ball.prevBurst); if (w.ball) w.ball.prevBurst = cmd.burst; }
        break;
    }
    if (this.waspById(w.id)) w.venom = Math.min(w.caste === 'queen' ? T.queen.venomMul : 1, w.venom + T.venom.regenPerSec * DT);
  }

  // ---------------- flight (GDD 7.2)

  _flight(w, cmd) {
    const W = T.wasp;
    const powered = w.state === 'fly' && w.energy > 0 && this.canFly();
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
      w.vx *= 0.97; w.vz *= 0.97;
    }
    const n = W.substeps, h = DT / n, p0 = { x: w.x, y: w.y, z: w.z };
    for (let i = 0; i < n; i++) {
      w.x += w.vx * h; w.y += w.vy * h; w.z += w.vz * h;
      this._collide(w);
    }
    this._webCheck(w, p0);
    // grounded without fuel: starvation clock
    if (w.energy <= 0 && w.y <= W.radius + 1e-6) {
      if (++w.groundTicks > W.starveTicks) this._die(w, 'starved', null);
    } else w.groundTicks = 0;
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

  _contactQuery(w) {
    const R = T.wasp.radius;
    let best = null, bestGap = T.wasp.contactGap;
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
      clothingStiffness: hm.clothing.stiffness, panic: hm.panic, companions: comps, panicMul: lvl >= 2 ? 1.3 : 1, stung: hm.stungCount,
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
    };
  }

  _preyNear(w) {
    const r2 = T.prey.catchDist * T.prey.catchDist;
    for (const rec of this.activeChunks) {
      const c = rec.content, key = chunkKey(rec.cx, rec.cz), st = this.cs(key);
      for (let i = 0; i < c.flies.length; i++) {
        if ((st.caughtFly[i] || 0) > this.tick) continue;
        if (dist2(w, flyPos(c.flies[i], this.tick)) <= r2) return { kind: 'fly', key, i, protein: T.prey.flyProtein };
      }
      for (let i = 0; i < c.caterpillars.length; i++) {
        if (st.caughtCat[i]) continue;
        if (dist2(w, c.caterpillars[i]) <= r2 * 2) return { kind: 'caterpillar', key, i, protein: T.prey.caterpillarProtein };
      }
      for (let h = 0; h < c.hives.length; h++) {
        const hv = c.hives[h], lost = st.beeLost[h] || {}, al = this.hiveAlarms.get(key + '#' + h);
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
      for (const s of c.sugar.concat(this.spillsIn(key), this.fruitIn(rec))) {
        if (s.kind === 'can' && (lvl >= 2 || this.canSpilled(key, c.sugar.indexOf(s)))) continue; // food covered (GDD 8.10) or knocked over
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
      const plan = resolveSting({ contactTick: this.tick, zone: here.zone, contactPointBody: point, mode: 'jab', under: true }, hm.tr, ZONES[here.zone], { clothingStiffness: 0, panic: hm.panic, companions: [], stung: hm.stungCount });
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

  _endSeason(why) {
    const S = T.season, col = this.colony;
    const survivors = Math.floor(col.mated * S.winterSurvival + h32(this.season.n, 31));
    const lineage = Math.floor(this.lineage * S.lineageSurvival + h32(this.season.n, 32));
    this.emit('winter', { why, mated: col.mated, survivors, lineage, season: this.season.n });
    if (survivors + lineage < 1) { this.extinct = true; for (const w of this.wasps.slice()) this._despawn(w); this.emit('lineExtinct', { nestAlive: col.nestAlive }); return; }
    this._spring(survivors, lineage);
  }

  _spring(survivors, lineage) {
    // the queen that continues is yours; the rest found lineage colonies (Q-10)
    this.lineage = survivors + lineage - 1;
    const winterDays = Math.round(this.settings.seasonDays * T.season.winterShare);
    const target = (this.day + 1 + winterDays) * 1440 + T.time.dawn;
    this.clockOffset += (target - this.minute) * this.tpm;
    this._minute(clockMinutes(this.tick + this.clockOffset, this.settings));
    this.season = { n: this.season.n + 1, startMinute: target, phase: 'Founding' };
    const alloc = this.colony.alloc;
    this.colony = newColony(true);
    this.colony.alloc = alloc;
    this.colony.sited = false;
    this.oldNests.push(this.nest);
    for (const w of this.wasps.slice()) this._despawn(w);
    for (const s of this.chunkState.values()) s.esc = 0;
    this.swats = []; this.sprays = []; this.alarms = []; this.hiveAlarms.clear();
    this.ext = { visit: 0, state: 'none', arriveMinute: 0, hm: null };
    this.ghost = null;
    const q = this._spawnWasp(true, 'queen');
    this.drivenId = q.id;
    for (const hm of this.active) this._catchUpHuman(hm);
    this._updateChunks(true);
    this.emit('spring', { season: this.season.n, lineage: this.lineage, id: q.id });
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
    rec.content.cans.forEach((c, i) => { const d = (c.x - hm.x) ** 2 + (c.z - hm.z) ** 2; if (d < bd) { bd = d; best = i; } });
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
    const old = this.active.map((h) => h.panic);
    const r2 = P.contagionRadius * P.contagionRadius;
    const md = minuteOfDay(this.minute);
    for (let i = 0; i < this.active.length; i++) {
      const hm = this.active[i];
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
      for (let j = 0; j < this.active.length; j++) {
        if (i === j || old[j] < P.contagionMin) continue;
        const o = this.active[j], dx = o.x - hm.x, dz = o.z - hm.z;
        if (dx * dx + dz * dz <= r2) gain += P.contagionRate * old[j] * hm.tr.sociability * hm.tr.panicSusceptibility;
      }
      hm.panic = Math.min(1, old[i] * P.decayPerStep + gain);
      if (hm.state === 'idle' && hm.panic >= T.resolve.fleePanic) this._startFlee(hm, this.cs(hm.chunk).lastSting || null);
      if (hm.state === 'flee') {
        hm.x += hm.dirX * P.fleeSpeed * 3 * DT; hm.z += hm.dirZ * P.fleeSpeed * 3 * DT;
        if (--hm.fleeSteps <= 0) hm.state = 'return';
      } else if (hm.state === 'return') {
        if (hm.panic >= T.resolve.fleePanic) { this._startFlee(hm, this.cs(hm.chunk).lastSting || null); continue; }
        if (this._walkTo(hm, hm.home.x, hm.home.z, P.walkSpeed)) { this._seat(hm); this.emit('settled', { humanHex: hm.hex }); }
      } else if (hm.state === 'idle') this._annoyance(hm);
    }
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
    let target = null, why = null;
    for (const w of this.wasps) {
      if (!(w.state === 'fly' || w.state === 'chewing' || w.state === 'landed')) continue;
      const dx = w.x - hm.x, dz = w.z - hm.z;
      if (dx * dx + dz * dz > 4) continue;
      const lp = toLocal(hm, w);
      const hd2 = dist2(lp, head.a);
      if (hd2 < E.faceRadius * E.faceRadius) { target = w; why = 'face'; break; }
      if (lvl >= 1 && hd2 < E.headRadius * E.headRadius) { target = w; why = 'head'; break; }
      if (lvl >= 1 && (w.ai.atFood === 'can' || (w.state === 'landed' && this._nearCan(w))) && dx * dx + dz * dz < 1.5) { target = w; why = 'food'; break; }
      if (lvl >= 3 && hm.tr.escalation >= E.sprayTrait && lp.z > 0.1 && lp.z < E.sprayRange && Math.abs(lp.x) < lp.z) { target = w; why = 'spray'; break; }
    }
    if (!target) { hm.annoy = 0; hm.annoyId = 0; return; }
    if (hm.annoyId !== target.id) { hm.annoyId = target.id; hm.annoy = 0; }
    hm.annoy += 3;
    const need = hm.tr.reactionTicks * (why === 'face' ? 3 : E.noticeMul) + (why === 'spray' ? 20 : 0);
    if (hm.annoy < need) return;
    hm.annoy = 0;
    hm.cooldown = this.tick + E.cooldownTicks;
    const start = this.tick + T.net.commitTicks + 1;
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
      const ax = n.treeX + 30 * dcos(ang), az = n.treeZ + 30 * dsin(ang);
      const goal = { x: n.x + dxn / dn * 0.45, z: n.z + dzn / dn * 0.45 };
      e.hm = {
        id, hex, short: 'EXT', tr, special: true, clothing: suitClothing(e.visit > 1), chunk: this.nest.key,
        home: { x: goal.x, z: goal.z, fx: -dxn / dn, fz: -dzn / dn, posture: 'stand', ax, az },
        x: ax, z: az, fx: 0, fz: 1, posture: 'stand', state: 'arrive', panic: 0, fleeSteps: 0, dirX: 0, dirZ: 0, stungCount: 0,
        annoyId: 0, annoy: 0, cooldown: 0, treat: 0,
        parts: { sit: bodyParts(tr, 'sit'), stand: bodyParts(tr, 'stand') },
      };
      e.state = 'active';
      this.emit('extArrive', { visit: e.visit, taped: e.visit > 1 });
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
    if (hm.state === 'arrive') {
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
    const rec = this.records.get(key), hv = rec.content.hives[h];
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
      const nearHive = (w.x - hv.ex) ** 2 + (w.z - hv.ez) ** 2 < T.bees.hiveAlarmRadius ** 2;
      if (dist2(p, w) < radius * radius || (hv.bees[b].guard && nearHive)) al.phys[b] = { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, mode: 'pursue', stun: 0 };
    }
  }

  _bees() {
    // entrance guard check for every active hive
    for (const rec of this.activeChunks) {
      const key = chunkKey(rec.cx, rec.cz);
      rec.content.hives.forEach((hv, h) => {
        for (const w of this.wasps) {
          if (w.state !== 'fly' && w.state !== 'chewing' && w.state !== 'landed') continue;
          const dx = w.x - hv.ex, dy = w.y - hv.ey, dz = w.z - hv.ez;
          if (dx * dx + dy * dy + dz * dz < T.bees.entranceAlarm ** 2) { this._alarmHive(key, h, w, 2); break; }
        }
      });
    }
    if (!this.hiveAlarms.size) return;
    const B = T.bees, agg = this.settings.beeAggression;
    const attached = new Map();
    for (const [k, al] of this.hiveAlarms) {
      const rec = this.records.get(al.key), hv = rec.content.hives[al.h];
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
      if (w.state !== 'balled' && n >= B.ballMin && w.state !== 'under' && w.state !== 'trapped') {
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
    return Math.max(T.resolve.minConsequenceTicks, Math.round(hm.tr.reactionTicks * k));
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
        const plan = resolveSting({ contactTick: this.tick, zone: p.zone, contactPointBody: p.surf, mode: 'touch' }, hm.tr, ZONES[p.zone], { clothingStiffness: hm.clothing.stiffness, panic: hm.panic, companions: comps, stung: hm.stungCount });
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
      const x = (rec.cx + (h32(sd, rec.cx, rec.cz, i, 913) - 0.5) * 0.8) * CS, z = (rec.cz + (h32(sd, rec.cx, rec.cz, i, 914) - 0.5) * 0.8) * CS;
      holes.push({ x, z });
    }
    const branches = rec.content.trees.map((t, i) => {
      const a = h32(sd, rec.cx, rec.cz, i, 915) * 6.28318, d = t.cr * 0.55;
      return { x: t.x + d * dcos(a), y: Math.max(1.8, t.h - t.cr * 0.7), z: t.z + d * dsin(a), t };
    });
    const out = { holes, branches };
    if (cache.size > 64) cache.clear();
    cache.set(key, out);
    return out;
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
      if (h32(sd, rec.cx, rec.cz, ti, 931) >= F.treeShare) return;
      for (let k = 0; k < F.perTree; k++) {
        const fall = Math.floor(this.season.startMinute / 1440 + this.settings.seasonDays * (F.startFrac + span * h32(sd, rec.cx, rec.cz, ti, k, 932)));
        if (today < fall || today >= fall + F.rotDays) continue;
        const a = h32(sd, ti, k, 933) * 6.28318, d = t.r + 0.2 + F.spread * h32(sd, ti, k, 934);
        out.push({ x: t.x + d * dcos(a), y: 0.03, z: t.z + d * dsin(a), rate: F.rate, kind: 'fruit', i: ti * 16 + k });
      }
    });
    if (cache.size > 128) cache.clear();
    cache.set(ck, out);
    return out;
  }

  _siteNear(w) {
    for (const rec of this.activeChunks) {
      const { holes, branches } = this.sitesIn(rec);
      for (const h of holes) if (w.y < 0.3 && (w.x - h.x) ** 2 + (w.z - h.z) ** 2 < 0.12 * 0.12) return { type: 'ground', x: h.x, z: h.z };
      for (const b of branches) if (dist2(w, b) < 0.15 * 0.15) return { type: 'branch', x: b.x, y: b.y, z: b.z, t: b.t };
    }
    const t = this._trunkNear(w);
    return t ? { type: 'trunk', t } : null;
  }

  _foundNest(w, site) {
    if (!site.type) site = { type: 'trunk', t: site }; // older callers pass a tree
    if (site.type === 'ground') {
      this.nest = makeNest(site.x - 0.5, site.z, site.x, -0.25, site.z, NEST.r, 'ground');
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
    const B = T.bird;
    for (const rec of this.activeChunks) {
      const key = chunkKey(rec.cx, rec.cz);
      rec.content.birds.forEach((bd, i) => {
        const k = key + '#' + i;
        let st = this.birdState.get(k);
        if (!st) {
          if (this.tick % 6 !== i % 6) return;
          const p = birdPos(bd, this.tick);
          let target = null, best = B.sight * B.sight;
          for (const w of this.wasps) {
            if (w.state !== 'fly' || w.y < B.minY) continue;
            const q = dist2(w, p);
            if (q < best && !this._underCanopy(w)) { best = q; target = w; }
          }
          if (!target) return;
          const d = Math.sqrt(best) || 1;
          st = { mode: 'dive', x: p.x, y: p.y, z: p.z, vx: (target.x - p.x) / d * 3, vy: (target.y - p.y) / d * 3, vz: (target.z - p.z) / d * 3, target: target.id, until: this.tick + B.diveTicks };
          this.birdState.set(k, st);
          this.emit('birdDive', { key, i, target: target.id, driven: target.id === this.drivenId });
          return;
        }
        let tx, ty, tz, speed = B.speed;
        if (st.mode === 'dive') {
          const t = this.waspById(st.target);
          if (!t || t.state !== 'fly' || t.y < B.abortY || this.tick > st.until || this._underCanopy(t)) {
            st.mode = 'cool'; st.until = this.tick + B.coolTicks;
            if (t && t.id === this.drivenId) this.emit('birdMiss', { id: t.id });
            return;
          }
          tx = t.x; ty = t.y; tz = t.z;
          if (dist2(st, t) < B.catch * B.catch) { this._die(t, 'taken by a bird', null); st.mode = 'cool'; st.until = this.tick + B.coolTicks; return; }
        } else {
          const p = birdPos(bd, this.tick);
          tx = p.x; ty = p.y; tz = p.z; speed = 6;
          if (dist2(st, p) < 0.25 || this.tick > st.until + 900) { this.birdState.delete(k); return; }
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

  _surfaceBelow(w) {
    const R = T.wasp.radius, g = T.land.gap;
    if (w.y <= R + g) return 'ground';
    for (const rec of this.activeChunks) for (const b of rec.content.boxes) {
      if (w.x < b.minx || w.x > b.maxx || w.z < b.minz || w.z > b.maxz) continue;
      if (Math.abs(w.y - (b.maxy + R)) <= g) return b.hive ? 'hive' : 'wood';
    }
    return null;
  }

  _maybeLand(w, cmd) {
    if (cmd.mx || cmd.my || cmd.mz || cmd.burst || cmd.sting) return;
    if (w.vx * w.vx + w.vy * w.vy + w.vz * w.vz > T.land.maxSpeed * T.land.maxSpeed) return;
    if (w.contact && !w.contact.blockedPerch) { this._perch(w, w.contact); return; }
    const surf = this._surfaceBelow(w);
    if (!surf) return;
    w.state = 'landed'; w.vx = w.vy = w.vz = 0;
    this.emit('landed', { id: w.id, surface: surf });
  }

  _takeoff(w) { w.state = 'fly'; w.vy = 0.5; w.walking = false; this.emit('takeoff', { id: w.id }); }

  // Walk camera-relative across the surface the wasp stands on. Off the edge it drops into flight;
  // the sides of boxes and tree trunks stop it.
  _walk(w, cmd) {
    const yaw = cmd.yawQ * 1e-4, sy = dsin(yaw), cy = dcos(yaw);
    const mz = cmd.mz / 100, mx = cmd.mx / 100, sp = T.land.walkSpeed * DT;
    const nx = w.x + (sy * mz - cy * mx) * sp, nz = w.z + (cy * mz + sy * mx) * sp;
    const R = T.wasp.radius;
    for (const rec of this.activeChunks) {
      for (const b of rec.content.boxes) {
        if (nx < b.minx - R || nx > b.maxx + R || nz < b.minz - R || nz > b.maxz + R) continue;
        if (w.y > b.miny && w.y < b.maxy) return; // blocked by the side
      }
      for (const t of rec.content.trees) { const dx = nx - t.x, dz = nz - t.z; if (dx * dx + dz * dz < (t.r + R) ** 2) return; }
    }
    w.x = nx; w.z = nz; w.yaw = yaw; w.walking = true;
    // walking into a person climbs onto them (an arm on the table, a leg on the grass)
    this._contactQuery(w);
    if (w.contact && !w.contact.blockedPerch) { w.walking = false; this._perch(w, w.contact); return; }
    w.contact = null;
    if (!this._surfaceBelow(w)) { w.state = 'fly'; w.walking = false; w.vy = 0; this.emit('walkOff', { id: w.id }); }
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
    const trees = rec.content.trees.map((t, i) => ({ t, h: h32(m.active.n, rec.cx, rec.cz, i, 77) })).sort((a, b) => a.h - b.h).slice(0, T.muni.baitsPerChunk);
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
    const a = T.alloc[col.alloc], share = a.protein / ((a.sugar + a.protein + a.pulp) / 3);
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
      if (rv && (w.x - rv.ex) ** 2 + (w.y - rv.ey) ** 2 + (w.z - rv.ez) ** 2 < 0.08 * 0.08) return { rv, key: chunkKey(rec.cx, rec.cz) };
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
      let t = this.wasps.find((x) => x.colony === 'own' && (x.state === 'fly' || x.state === 'landed') && dist2(x, home) < T.rival.guardRadius ** 2);
      // other players' wasps near the nest count too (rivals live on this peer only)
      if (!t) for (const r of this.remote.values()) if (!r.rival && (r.state === 'fly' || r.state === 'landed') && dist2(r, home) < T.rival.guardRadius ** 2) { t = r; break; }
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
    // My rivals against other peers' wasps: I own the rivals, so I start these fights
    const busy = new Set();
    for (const w of this.wasps) if (w.state === 'fighting' && w.fight.remote) busy.add(w.fight.other);
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
    this._muniTick();
    const col = this.colony;
    const daylight = isDaylight(this.minute) && !this.raining && this.canFly();
    const frac = this.seasonFrac;
    if (this.colony.sited === false && frac > 0.03) {
      const old = this.oldNests[this.oldNests.length - 1] || this.nest;
      this.nest = makeNest(old.treeX, old.treeZ, old.x, old.y, old.z, old.r, old.site || 'trunk');
      this.colony.sited = true;
      this.colony.maxCells = T.sites[this.nest.site].maxCells;
      this.emit('nestFounded', { x: this.nest.x, y: this.nest.y, z: this.nest.z, key: this.nest.key, auto: true });
    }
    colonyStep(col, 60 / this.dayTicks, this._own().filter((w) => w.caste !== 'queen').length, daylight, frac, this.bio);
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
    const ai = own - (this._driven() ? 1 : 0);
    const cap = Math.min(T.ai.maxPhysical, Math.floor(col.adults * 0.4));
    if (!this.noAI && daylight && col.nestAlive && inside >= 1 && ai < cap && this.tick % T.ai.launchEvery < 60) this._spawnWasp(false);
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
        if (dist2(w, a) < T.alarm.radius * T.alarm.radius && this.humanByHex(a.killerHex)) { this._aiAttack(w, a.killerHex); break; }
      }
    }
    const daylight = isDaylight(this.minute) && !this.raining;
    if ((!daylight || w.caste === 'queen') && ai.mode !== 'home') { ai.mode = 'home'; ai.target = null; }
    if (w.energy < 0.2 && ai.mode !== 'home' && ai.mode !== 'collect') { ai.mode = 'return'; ai.target = null; }
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
        c.sugar.forEach((s, i) => {
          if (s.kind === 'can' && (lvl >= 2 || col.deficit < T.ai.canDeficit)) return;
          consider({ kind: 'sugar', key, i, c: ri }, s);
        });
        if (lvl >= 3 && col.deficit >= T.ai.canDeficit) c.traps.forEach((tr, i) => consider({ kind: 'trap', key, i, c: ri + 50 }, tr));
        this.spillsIn(key).forEach((sp) => consider({ kind: 'spill', key, i: sp.i, c: ri + 60 }, sp));
        this.fruitIn(rec).forEach((f) => consider({ kind: 'fruit', key, i: f.i, c: ri + 80 }, f));
      } else if (w.role === 'protein') {
        c.flies.forEach((f, i) => { if ((st.caughtFly[i] || 0) <= this.tick) consider({ kind: 'prey', sub: 'fly', key, i, c: ri }, flyPos(f, this.tick)); });
        c.caterpillars.forEach((f, i) => { if (!st.caughtCat[i]) consider({ kind: 'prey', sub: 'cat', key, i, c: ri + 20 }, f); });
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
    if (t.kind === 'sugar') { const s = c.sugar[t.i]; return { x: s.x, y: s.y + 0.012, z: s.z }; }
    if (t.kind === 'trap') return c.traps[t.i];
    if (t.kind === 'fruit') { const f = this.fruitIn(rec).find((x) => x.i === t.i); return f ? { x: f.x, y: f.y + 0.015, z: f.z } : null; }
    if (t.kind === 'spill') { const sp = this.spillsIn(t.key).find((x) => x.i === t.i); return sp ? { x: sp.x, y: sp.y + 0.012, z: sp.z } : null; }
    if (t.kind === 'bait') return this._baitsIn(t.key)[t.i] || null;
    if (t.kind === 'wood') { const b = c.boxes[t.i]; return { x: (b.minx + b.maxx) / 2 + 0.2 * (h32(w.id, t.i) - 0.5), y: b.maxy + T.wasp.radius + 0.008, z: (b.minz + b.maxz) / 2 }; }
    if (t.sub === 'fly') return (st.caughtFly[t.i] || 0) > this.tick ? null : flyPos(c.flies[t.i], this.tick);
    if (t.sub === 'cat') return st.caughtCat[t.i] ? null : c.caterpillars[t.i];
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
    for (const w of this.wasps) { f(w.id); f(w.x); f(w.y); f(w.z); f(w.vx); f(w.vy); f(w.vz); f(w.energy); f(w.venom); }
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
