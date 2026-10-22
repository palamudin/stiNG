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
  isRaining, tempAt, isDaylight, humanWindow, flyPos, beePos,
} from './world.js';
import { newColony, colonyStep, destroyNest } from './colony.js';

const CMD_FIELDS = 9; // mx, my, mz, burst, sting, yawQ, pitchQ, act, alloc
export const Act = { Interact: 1, Switch: 2, Rest: 4 };

const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; };
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byHumanId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class Sim {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
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
    this.colony = newColony();
    this.stung = new Set();
    this.stats = { stings: 0, aiStings: 0, full: 0, deaths: 0, causes: {}, caught: 0, deposits: 0 };
    this.wasps = [];
    this.nextWaspId = 1;
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
  cs(key) {
    let s = this.chunkState.get(key);
    if (!s) { s = { esc: 0, caughtFly: {}, caughtCat: {}, beeLost: {}, chewed: 0 }; this.chunkState.set(key, s); }
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
  addEsc(x, z, pts) { const k = chunkKey(chunkOf(x), chunkOf(z)); const before = this.escLevel(k); this.cs(k).esc += pts; const after = this.escLevel(k); if (after !== before) this.emit('escalation', { key: k, level: after }); }
  get temperature() { return tempAt(this.seed, this.minute); }
  get raining() { return isRaining(this.seed, this.minute); }
  get physicalCount() { return this.wasps.length; }
  canFly() { return this.temperature >= T.weather.flyMinTemp; }

  _spawnWasp(driven) {
    const id = this.nextWaspId++;
    const w = {
      id, x: SPAWN.x, y: SPAWN.y, z: SPAWN.z, vx: 0, vy: 0, vz: 0, yaw: SPAWN.yaw, pitch: 0,
      energy: 1, venom: 1, state: 'fly', stateTicks: 0, attach: null, under: null, ball: null,
      carry: null, groundTicks: 0, chew: 0, role: 'sugar',
      ai: { mode: 'pick', target: null, timer: 0, humanHex: null, stings: 0, stingHold: 0 },
    };
    if (!driven) {
      const a = T.alloc[this.colony.alloc], s = a.sugar + a.protein + a.pulp, r = h32(id, 77) * s;
      w.role = r < a.sugar ? 'sugar' : r < a.sugar + a.protein ? 'protein' : 'pulp';
      w.x = NEST_ENTRANCE.x; w.y = NEST_ENTRANCE.y - 0.03; w.z = NEST_ENTRANCE.z;
    }
    this.wasps.push(w);
    this.wasps.sort(byId);
    this.emit('waspSpawn', { id, driven });
    return w;
  }

  // ---------------------------------------------------------------- chunks and humans

  _updateChunks(force = false) {
    const w = this._driven() || this.ghost || { x: SPAWN.x, z: SPAWN.z };
    const ccx = chunkOf(w.x), ccz = chunkOf(w.z);
    const key = chunkKey(ccx, ccz);
    if (key === this.activeKey && !force) return;
    this.activeKey = key;
    const D = T.chunk.discoverRadius, A = T.chunk.activeRadius;
    for (let dz = -D; dz <= D; dz++) for (let dx = -D; dx <= D; dx++) this._discover(ccx + dx, ccz + dz);
    const act = [];
    for (let dz = -A; dz <= A; dz++) for (let dx = -A; dx <= A; dx++) act.push(this.records.get(chunkKey(ccx + dx, ccz + dz)));
    this.activeChunks = act;
    const list = [];
    for (const rec of act) {
      for (const hs of rec.content.humans) {
        const id = hash(this.seed, Domain.WorldGen, u64(rec.cx), u64(rec.cz), BigInt(hs.slot));
        const hex = hex64(id);
        let hm = this.humans.get(hex);
        if (!hm) {
          const tr = humanTraits(this.seed, id);
          const ax = hs.x + T.panic.approachDist * dcos(hs.exit), az = hs.z + T.panic.approachDist * dsin(hs.exit);
          hm = {
            id, hex, short: hex.slice(0, 4), tr, clothing: humanClothing(this.seed, id, this.day), chunk: chunkKey(rec.cx, rec.cz),
            home: { x: hs.x, z: hs.z, fx: hs.fx, fz: hs.fz, posture: hs.posture, ax, az },
            x: hs.x, z: hs.z, fx: hs.fx, fz: hs.fz, posture: hs.posture,
            state: 'idle', panic: 0, fleeSteps: 0, dirX: 0, dirZ: 0, stungCount: 0, winDay: -1, win: null,
            annoyId: 0, annoy: 0, cooldown: 0, sprayCount: 0, clothesDay: this.day,
            parts: { sit: bodyParts(tr, 'sit'), stand: bodyParts(tr, 'stand') },
          };
          this.humans.set(hex, hm);
        }
        this._catchUpHuman(hm);
        list.push(hm);
      }
    }
    if (this.ext.hm) list.push(this.ext.hm);
    list.sort(byHumanId);
    this.active = list;
    this.emit('chunksActive', { key });
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

    const act = cmd.act | 0, edge = act & ~this.prevAct;
    this.prevAct = act;
    if (cmd.alloc > 0 && cmd.alloc <= T.alloc.length && this.colony.alloc !== cmd.alloc - 1) { this.colony.alloc = cmd.alloc - 1; this.emit('alloc', { preset: this.colony.alloc }); }
    if (edge & Act.Switch) this._possessNearest();
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
    this._alarmDecay();
    // 3. humans at 20 Hz
    if (this.tick % 3 === 0) this._humans();
    // 4. colony at 1 Hz
    if (this.tick % 60 === 0) this._colonyTick();
    // 5. respawn of the driven wasp
    if (!this._driven() && !this.extinct && this.tick >= this.respawnAt) this._respawn();
    this._updateChunks();
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
      for (const s of this.chunkState.values()) { s.esc *= Math.pow(1 - T.esc.decayPerDay, days); s.beeLost = {}; s.caughtCat = {}; }
      this.emit('newDay', { day: newDay });
    }
  }

  // ---------------------------------------------------------------- possession and rest (GDD 7.7)

  _possessNearest() {
    const d = this._driven();
    if (!d || d.state === 'under' || d.state === 'balled') return;
    let best = null, bd = 30 * 30;
    for (const w of this.wasps) {
      if (w === d || w.state === 'dead') continue;
      const q = dist2(w, d);
      if (q < bd) { bd = q; best = w; }
    }
    if (!best) { this.emit('noSwitch'); return; }
    d.ai = { mode: 'pick', target: null, timer: 0, humanHex: null, stings: 0, stingHold: 0 };
    if (d.state === 'attached') this._detach(d, null);
    this.drivenId = best.id;
    if (best.state === 'attached') this._detach(best, null);
    this.emit('possess', { id: best.id, from: d.id });
  }

  _rest() {
    const d = this._driven();
    if (!d || dist2(d, NEST_ENTRANCE) > 0.4 * 0.4) { this.emit('cantRest', { why: 'away' }); return; }
    const md = minuteOfDay(this.minute);
    if (md >= T.time.dawn && md < T.time.dusk) { this.emit('cantRest', { why: 'day' }); return; }
    const target = (md >= T.time.dusk ? this.day + 1 : this.day) * 1440 + T.time.dawn;
    const skipMin = target - this.minute;
    const skipTicks = skipMin * this.tpm;
    this.clockOffset += skipTicks;
    // the colony lives through the skipped time
    const steps = Math.floor(skipTicks / 60), dtDay = 60 / this.dayTicks;
    for (let i = 0; i < steps; i++) colonyStep(this.colony, dtDay, this.wasps.length, false);
    for (const w of this.wasps.slice()) if (w !== d) this._despawn(w);
    this._minute(clockMinutes(this.tick + this.clockOffset, this.settings));
    for (const hm of this.active) this._catchUpHuman(hm);
    d.energy = Math.max(d.energy, T.energy.nestRefill);
    this.emit('rested', { minutes: skipMin });
  }

  // ---------------------------------------------------------------- one wasp per tick

  _stepWasp(w, cmd, edge, driven) {
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
          this._hints(w);
        } else if (armed && w.contact && w.contact.humanHex === w.ai.humanHex) this._beginSting(w, w.contact, 'jab');
        break;
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
    if (this.waspById(w.id)) w.venom = Math.min(1, w.venom + T.venom.regenPerSec * DT);
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
    const n = W.substeps, h = DT / n;
    for (let i = 0; i < n; i++) {
      w.x += w.vx * h; w.y += w.vy * h; w.z += w.vz * h;
      this._collide(w);
    }
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

  // Shared by stings outside and under clothing
  _applySting(w, hm, zone, pointBody, mode, under) {
    const driven = w.id === this.drivenId;
    const ev = { contactTick: this.tick, humanHex: hm.hex, zone, contactPointBody: { ...pointBody }, mode, under };
    const comps = under ? [] : this._companions(hm);
    const lvl = this.escAt(hm.x, hm.z);
    const plan = resolveSting(ev, hm.tr, ZONES[zone], {
      clothingStiffness: hm.clothing.stiffness, panic: hm.panic, companions: comps, panicMul: lvl >= 2 ? 1.3 : 1,
    });
    const actorHex = (id) => (id === hm.id ? hm.hex : comps.find((x) => x.id === id).hex);
    const swats = plan.swats.map((s) => ({
      ...s, actorHex: actorHex(s.actorId), frameHex: hm.hex, stungHex: hm.hex, contactTick: this.tick, hits: [],
      underOnly: under ? w.id : 0, byWasp: w.id,
    }));
    for (const s of swats) this.swats.push(s);
    hm.panic = Math.min(1, hm.panic + plan.panicGain);
    hm.stungCount++;
    const first = !this.stung.has(hm.hex);
    this.stung.add(hm.hex);
    if (driven) this.stats.stings++; else this.stats.aiStings++;
    this.addEsc(hm.x, hm.z, T.esc.sting);
    this.emit('sting', {
      waspId: w.id, driven, humanHex: hm.hex, zone, contactPointBody: pointBody, first, under, panicGain: plan.panicGain,
      swats: swats.map((s) => ({ actorHex: s.actorHex, kind: s.kind, start: s.start, window: s.window, radius: s.radius, kills: s.kills, center: s.center })),
    });
    if (plan.flee && hm.state === 'idle') this._startFlee(hm, w);
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
      hm.panic = Math.min(1, hm.panic + extra);
      this.stats.full++;
      this.addEsc(hm.x, hm.z, T.esc.full);
      this.emit('deepen', { waspId: w.id, humanHex: hm.hex, zone: a.zone, panicGain: extra });
      if (hm.panic >= T.resolve.fleePanic && hm.state === 'idle') this._startFlee(hm, w);
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
    const c = w.contact;
    if (c && c.opening >= 0 && !w.carry) { this._enterUnder(w, c); return; }
    const prey = this._preyNear(w);
    if (prey) { this._catch(w, prey); return; }
    if (!w.carry && this._woodNear(w)) { w.state = 'chewing'; w.chew = 0; w.vx = w.vy = w.vz = 0; this.emit('chewStart', { id: w.id }); return; }
    if (w.carry) this.emit('carrying', { kind: w.carry.kind });
  }

  _hints(w) {
    const c = w.contact;
    this.hint = {
      opening: c && c.opening >= 0 ? c.openingKey : null,
      prey: !w.carry && this._preyNear(w) ? this._preyNear(w).kind : null,
      wood: !w.carry && !c && this._woodNear(w),
      nest: dist2(w, NEST_ENTRANCE) < 0.4 * 0.4,
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
      for (const s of c.sugar) {
        if (s.kind === 'can' && lvl >= 2) continue; // food covered (GDD 8.10)
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
    if (!this.colony.nestAlive) return;
    if (dist2(w, NEST_ENTRANCE) > 0.07 * 0.07) return;
    const col = this.colony;
    let deposited = false;
    if (w.carry) {
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
      const plan = resolveSting({ contactTick: this.tick, zone: here.zone, contactPointBody: point, mode: 'jab', under: true }, hm.tr, ZONES[here.zone], { clothingStiffness: 0, panic: hm.panic, companions: [] });
      for (const s of plan.swats) this.swats.push({ ...s, actorHex: hm.hex, frameHex: hm.hex, stungHex: hm.hex, contactTick: this.tick, hits: [], underOnly: w.id, byWasp: w.id });
      this.emit('press', { humanHex: hm.hex, key: u.key, start: plan.swats[0].start, center: point });
      u.nextPress = this.tick + hm.tr.reactionTicks + T.under.compressEvery;
    }
    // Panic high enough: the shirt comes off and the wasp with it
    if (hm.panic >= T.under.ripPanic && hm.clothing.top !== Top.Suit && !hm.clothing.topOff && here.zone !== Zone.Thighs && here.zone !== Zone.Shins && here.zone !== Zone.Groin && here.zone !== Zone.Buttocks) {
      hm.clothing = { ...hm.clothing, topOff: true, stiffness: 0 };
      this.emit('rip', { humanHex: hm.hex });
      this._exitUnder(w, true);
      if (hm.state === 'idle') this._startFlee(hm, w);
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
        if (s.underOnly ? w.id !== s.underOnly || w.state !== 'under' : !(w.state === 'fly' || w.state === 'attached' || w.state === 'stunned' || w.state === 'chewing')) continue;
        if (dist2(w, c) > r * r) continue;
        s.hits.push(w.id);
        this.emit('swatHit', { waspId: w.id, actorHex: s.actorHex, frameHex: s.frameHex, kind: s.kind, kills: s.kills, delayTicks: s.start - s.contactTick });
        const causes = { [SwatKind.Slap]: 'slap', [SwatKind.Cover]: 'cover', [SwatKind.Compress]: 'crushed under clothing' };
        if (s.kills) this._die(w, (causes[s.kind] || 'swat') + (s.actorHex === s.frameHex || s.pre ? '' : ' (helper)'), s.actorHex);
        else this._stun(w);
      }
    }
    this.swats = live;
  }

  _missed(s) {
    // A wasp that was swatted at and survived may take it personally (GDD 6.3, 8.10)
    const w = this.waspById(s.targetId);
    if (!w || w.id === this.drivenId || w.state !== 'fly') return;
    if (h32(w.id, this.tick, 5) < this.colony.deficit + 0.15) this._aiAttack(w, s.actorHex);
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
        if (!(w.state === 'fly' || w.state === 'stunned' || w.state === 'attached' || w.state === 'chewing')) continue;
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

  _die(w, cause, byHex) {
    const driven = w.id === this.drivenId;
    this.wasps = this.wasps.filter((x) => x !== w);
    w.state = 'dead';
    this.colony.adults = Math.max(0, this.colony.adults - 1);
    this.stats.deaths++;
    this.stats.causes[cause] = (this.stats.causes[cause] || 0) + 1;
    if (byHex) {
      const hm = this.humanByHex(byHex);
      if (hm) this.addEsc(hm.x, hm.z, T.esc.death);
      this.alarms.push({ x: w.x, y: w.y, z: w.z, until: this.tick + T.alarm.ticks, killerHex: byHex });
      this.emit('alarm', { x: w.x, y: w.y, z: w.z, killerHex: byHex });
    }
    this._releaseBees(w.id);
    this.emit('waspDied', { id: w.id, driven, cause, byHex, x: w.x, y: w.y, z: w.z, adultsLeft: Math.floor(this.colony.adults) });
    if (driven) {
      this.ghost = { ...w, state: 'dead' };
      this.respawnAt = this.tick + T.respawnTicks;
    }
  }

  _despawn(w) {
    this.wasps = this.wasps.filter((x) => x !== w);
    this._releaseBees(w.id);
    this.emit('waspDespawn', { id: w.id });
  }

  _respawn() {
    const col = this.colony;
    const inside = col.adults - this.wasps.length;
    if (col.nestAlive && inside >= 1) {
      const w = this._spawnWasp(true);
      this.drivenId = w.id; this.ghost = null;
      this.emit('respawn', { id: w.id, yaw: SPAWN.yaw });
      return;
    }
    if (this.wasps.length) {
      const g = this.ghost || SPAWN;
      let best = this.wasps[0], bd = Infinity;
      for (const w of this.wasps) { const q = dist2(w, g); if (q < bd) { bd = q; best = w; } }
      this.drivenId = best.id; this.ghost = null;
      this.emit('possess', { id: best.id, from: 0 });
      return;
    }
    if (col.nestAlive && col.pupae >= 1) { this.respawnAt = this.tick + 600; this.emit('waitingBrood'); return; }
    this.extinct = true;
    this.emit('lineExtinct', { nestAlive: col.nestAlive });
  }

  // ---------------- humans (GDD 8.2, 8.9, 8.10)

  _startFlee(hm, w) {
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
      if (hm.state === 'idle' && hm.panic >= T.resolve.fleePanic) this._startFlee(hm, this._nearestWasp(hm));
      if (hm.state === 'flee') {
        hm.x += hm.dirX * P.fleeSpeed * 3 * DT; hm.z += hm.dirZ * P.fleeSpeed * 3 * DT;
        if (--hm.fleeSteps <= 0) hm.state = 'return';
      } else if (hm.state === 'return') {
        if (hm.panic >= T.resolve.fleePanic) { this._startFlee(hm, this._nearestWasp(hm)); continue; }
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
      if (!(w.state === 'fly' || w.state === 'chewing')) continue;
      const dx = w.x - hm.x, dz = w.z - hm.z;
      if (dx * dx + dz * dz > 4) continue;
      const lp = toLocal(hm, w);
      const hd2 = dist2(lp, head.a);
      if (hd2 < E.faceRadius * E.faceRadius) { target = w; why = 'face'; break; }
      if (lvl >= 1 && hd2 < E.headRadius * E.headRadius) { target = w; why = 'head'; break; }
      if (lvl >= 1 && w.ai.atFood === 'can' && dx * dx + dz * dz < 1.5) { target = w; why = 'food'; break; }
      if (lvl >= 3 && hm.tr.escalation >= E.sprayTrait && lp.z > 0.1 && lp.z < E.sprayRange && Math.abs(lp.x) < lp.z) { target = w; why = 'spray'; break; }
    }
    if (!target) { hm.annoy = 0; hm.annoyId = 0; return; }
    if (hm.annoyId !== target.id) { hm.annoyId = target.id; hm.annoy = 0; }
    hm.annoy += 3;
    const need = hm.tr.reactionTicks * (why === 'face' ? 3 : E.noticeMul) + (why === 'spray' ? 20 : 0);
    if (hm.annoy < need) return;
    hm.annoy = 0;
    hm.cooldown = this.tick + E.cooldownTicks;
    if (why === 'spray') {
      this.sprays.push({ hex: hm.hex, start: this.tick + 8, end: this.tick + 8 + E.sprayTicks });
      this.emit('spray', { humanHex: hm.hex });
      return;
    }
    const lp = toLocal(hm, target);
    const slap = lvl >= 1;
    const kind = slap ? SwatKind.Slap : SwatKind.Brush;
    const s = {
      actorId: hm.id, actorHex: hm.hex, frameHex: hm.hex, stungHex: hm.hex, kind, start: this.tick + 6, window: windowFor(kind),
      center: { x: lp.x, y: lp.y, z: lp.z }, radius: slap ? (hm.tr.style === Style.Precise ? 0.05 : 0.09) : T.resolve.brushRadius,
      kills: slap, contactTick: this.tick, hits: [], pre: true, targetId: target.id, underOnly: 0,
    };
    this.swats.push(s);
    this.addEsc(hm.x, hm.z, E.nuisance);
    this.emit('preSwat', { humanHex: hm.hex, waspId: target.id, kind, start: s.start, window: s.window, center: s.center, why });
  }

  // ---------------- the exterminator (GDD 8.10 level 4)

  _extCheck() {
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
      const ax = NEST.treeX + 30 * dcos(ang), az = NEST.treeZ + 30 * dsin(ang);
      const goal = { x: NEST.treeX + 0.1, z: NEST.treeZ + 0.85 };
      e.hm = {
        id, hex, short: 'EXT', tr, special: true, clothing: suitClothing(e.visit > 1), chunk: '0,0',
        home: { x: goal.x, z: goal.z, fx: 0, fz: -1, posture: 'stand', ax, az },
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
    let lv = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) lv = Math.max(lv, this.escLevel(chunkKey(dx, dz)));
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
    if (hm.panic >= T.ext.minPanicAbort) { this._startFlee(hm, this._nearestWasp(hm)); this.emit('extAbort', { visit: e.visit }); return; }
    if (hm.state === 'arrive') {
      if (this._walkTo(hm, hm.home.x, hm.home.z, T.ext.speed)) { hm.state = 'treat'; hm.fx = 0; hm.fz = -1; hm.treat = 0; this.emit('extTreat', {}); }
    } else if (hm.state === 'treat') {
      hm.treat += 3;
      if (hm.treat >= T.ext.treatTicks) {
        const outside = this.wasps.length;
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

  _alarmHive(key, h, w, radius) {
    const rec = this.records.get(key), hv = rec.content.hives[h];
    const k = key + '#' + h;
    let al = this.hiveAlarms.get(k);
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
          if (w.state !== 'fly' && w.state !== 'chewing') continue;
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
      const target = this.waspById(al.target);
      if (target && dist2(target, { x: hv.ex, y: hv.ey, z: hv.ez }) < 15 * 15 && target.state !== 'dead') al.until = Math.max(al.until, this.tick + 60);
      const ending = this.tick > al.until || !target;
      let any = false;
      for (const b in al.phys) {
        const p = al.phys[b];
        any = true;
        if (p.stun > 0) { p.stun--; p.vy -= 3 * DT; p.x += p.vx * DT; p.y = Math.max(0.01, p.y + p.vy * DT); p.z += p.vz * DT; continue; }
        if (p.mode === 'ball') {
          if (!target || target.state !== 'balled' || ending) { p.mode = 'return'; continue; }
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

  // ---------------- colony tick (1 Hz)

  _colonyTick() {
    const col = this.colony;
    const daylight = isDaylight(this.minute) && !this.raining && this.canFly();
    colonyStep(col, 60 / this.dayTicks, this.wasps.length, daylight);
    this._extCheck();
    // launch physical AI foragers while the player is near the nest (GDD 11.12: far colonies stay abstract)
    const nearNest = this.activeChunks.some((r) => r.cx === 0 && r.cz === 0);
    if (!nearNest) {
      for (const w of this.wasps.slice()) if (w.id !== this.drivenId) this._despawn(w);
      return;
    }
    const inside = col.adults - this.wasps.length;
    const ai = this.wasps.length - (this._driven() ? 1 : 0);
    const cap = Math.min(T.ai.maxPhysical, Math.floor(col.adults * 0.4));
    if (daylight && col.nestAlive && inside >= 1 && ai < cap && this.tick % T.ai.launchEvery < 60) this._spawnWasp(false);
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
    // alarm pheromone pulls nearby workers into an attack
    if (ai.mode !== 'attack' && ai.mode !== 'evade') {
      for (const a of this.alarms) {
        if (dist2(w, a) < T.alarm.radius * T.alarm.radius && this.humanByHex(a.killerHex)) { this._aiAttack(w, a.killerHex); break; }
      }
    }
    const daylight = isDaylight(this.minute) && !this.raining;
    if (!daylight && ai.mode !== 'home') { ai.mode = 'home'; ai.target = null; }
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
        this._steer(w, NEST_ENTRANCE, cmd);
        if (dist2(w, NEST_ENTRANCE) < 0.07 * 0.07) {
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
      } else if (w.role === 'protein') {
        c.flies.forEach((f, i) => { if ((st.caughtFly[i] || 0) <= this.tick) consider({ kind: 'prey', sub: 'fly', key, i, c: ri }, flyPos(f, this.tick)); });
        c.caterpillars.forEach((f, i) => { if (!st.caughtCat[i]) consider({ kind: 'prey', sub: 'cat', key, i, c: ri + 20 }, f); });
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
