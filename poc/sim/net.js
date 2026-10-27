// A simulated network between peers, and a two-peer lab built on it (GDD 11).
// Deterministic: delays and losses come from the counter hash, so lab runs replay exactly.
import { h32, rnd, sq } from './rng.js';
import { T } from './tuning.js';
import { Sim } from './sim.js';
import { chunkOf, chunkKey } from './world.js';

// ---------------------------------------------------------------- wire format for state packets (GDD 11.12)
// Positions are chunk-relative, 16 bits per axis (1 mm horizontally, 0.6 mm vertically); velocity 8 bits per axis.
const STATES = ['fly', 'stunned', 'attached', 'under', 'chewing', 'trapped', 'balled', 'landed', 'webbed', 'fighting', 'dead', 'perched', 'drowning', 'robbing'];
const CARRY = [null, 'fly', 'caterpillar', 'bee', 'pulp', 'larva', 'carrion', 'meat', 'bee brood', 'bait'];
const CS = T.chunk.size, YMAX = 40, VMAX = 8;
export const BYTES_PER_WASP = 19;

// A state packet (driven and near wasps): peer, tick, count, the sender's driven wasp, the wasps gone since the last one
const STATE_HEAD = 11;
export function encodeState(m) {
  const gone = m.gone || [];
  const buf = new ArrayBuffer(STATE_HEAD + gone.length * 4 + m.wasps.length * BYTES_PER_WASP), v = new DataView(buf);
  v.setUint8(0, m.peer); v.setUint32(1, m.tick); v.setUint8(5, m.wasps.length); v.setUint32(6, m.driven || 0); v.setUint8(10, gone.length);
  let o = STATE_HEAD;
  for (const id of gone) { v.setUint32(o, id); o += 4; }
  const q16 = (x, lo, hi) => Math.max(0, Math.min(65535, rnd((x - lo) / (hi - lo) * 65535)));
  const q8 = (x) => Math.max(-127, Math.min(127, rnd(x / VMAX * 127)));
  for (const w of m.wasps) {
    const cx = chunkOf(w.x), cz = chunkOf(w.z);
    v.setUint32(o, w.id); v.setInt16(o + 4, cx); v.setInt16(o + 6, cz);
    v.setUint16(o + 8, q16(w.x - cx * CS, -CS / 2, CS / 2)); v.setUint16(o + 10, q16(w.y, 0, YMAX)); v.setUint16(o + 12, q16(w.z - cz * CS, -CS / 2, CS / 2));
    v.setInt8(o + 14, q8(w.vx)); v.setInt8(o + 15, q8(w.vy)); v.setInt8(o + 16, q8(w.vz));
    v.setUint8(o + 17, Math.max(0, STATES.indexOf(w.state)) | (w.caste === 'male' ? 64 : 0) | (w.caste === 'gyne' ? 128 : 0)); // males and young queens (T2-3)
    v.setUint8(o + 18, (w.caste === 'queen' ? 128 : 0) | (w.under ? 64 : 0) | (w.rival ? 32 : 0) | Math.max(0, CARRY.indexOf(w.carry)));
    o += BYTES_PER_WASP;
  }
  return buf;
}

export function decodeState(buf, underHex = null) {
  const v = new DataView(buf), n = v.getUint8(5), ng = v.getUint8(10), wasps = [], gone = [];
  const d16 = (x, lo, hi) => lo + x / 65535 * (hi - lo);
  let o = STATE_HEAD;
  for (let i = 0; i < ng; i++) { gone.push(v.getUint32(o)); o += 4; }
  for (let i = 0; i < n; i++) {
    const cx = v.getInt16(o + 4), cz = v.getInt16(o + 6), flags = v.getUint8(o + 18), sb = v.getUint8(o + 17);
    wasps.push({
      id: v.getUint32(o), x: cx * CS + d16(v.getUint16(o + 8), -CS / 2, CS / 2), y: d16(v.getUint16(o + 10), 0, YMAX), z: cz * CS + d16(v.getUint16(o + 12), -CS / 2, CS / 2),
      vx: v.getInt8(o + 14) / 127 * VMAX, vy: v.getInt8(o + 15) / 127 * VMAX, vz: v.getInt8(o + 16) / 127 * VMAX,
      state: STATES[sb & 63], caste: flags & 128 ? 'queen' : sb & 64 ? 'male' : sb & 128 ? 'gyne' : 'worker', under: flags & 64 ? underHex || 'yes' : null, rival: !!(flags & 32), carry: CARRY[flags & 31],
    });
    o += BYTES_PER_WASP;
  }
  return { mk: 'state', peer: v.getUint8(0), tick: v.getUint32(1), driven: v.getUint32(6), gone, wasps };
}

// A swarm packet (mid-tier wasps, GDD 11.12): one header per chunk (cx, cz, base id, count), then per wasp an id
// offset, a chunk-relative position and a state byte (state, queen, rival). No velocity: the receiver works it out.
export const BYTES_PER_SWARM_WASP = 9;
const GROUP_HEAD = 9;
function swarmGroups(wasps) {
  const groups = [], byKey = new Map();
  for (const w of wasps) {
    const k = chunkKey(chunkOf(w.x), chunkOf(w.z));
    let g = byKey.get(k);
    if (!g) { g = { cx: chunkOf(w.x), cz: chunkOf(w.z), ws: [] }; byKey.set(k, g); groups.push(g); }
    g.ws.push(w);
  }
  // within a chunk by id; a new group whenever the id offset or the count would overflow
  const out = [];
  for (const g of groups) {
    g.ws.sort((a, b) => a.id - b.id);
    let cur = null;
    for (const w of g.ws) {
      if (!cur || w.id - cur.base > 65535 || cur.ws.length >= 255) { cur = { cx: g.cx, cz: g.cz, base: w.id, ws: [] }; out.push(cur); }
      cur.ws.push(w);
    }
  }
  return out;
}
export function encodeSwarm(m) {
  const groups = swarmGroups(m.wasps);
  const buf = new ArrayBuffer(6 + groups.length * GROUP_HEAD + m.wasps.length * BYTES_PER_SWARM_WASP), v = new DataView(buf);
  v.setUint8(0, m.peer); v.setUint32(1, m.tick); v.setUint8(5, groups.length);
  const q16 = (x, lo, hi) => Math.max(0, Math.min(65535, rnd((x - lo) / (hi - lo) * 65535)));
  let o = 6;
  for (const g of groups) {
    v.setInt16(o, g.cx); v.setInt16(o + 2, g.cz); v.setUint32(o + 4, g.base); v.setUint8(o + 8, g.ws.length); o += GROUP_HEAD;
    for (const w of g.ws) {
      v.setUint16(o, w.id - g.base);
      v.setUint16(o + 2, q16(w.x - g.cx * CS, -CS / 2, CS / 2)); v.setUint16(o + 4, q16(w.y, 0, YMAX)); v.setUint16(o + 6, q16(w.z - g.cz * CS, -CS / 2, CS / 2));
      v.setUint8(o + 8, Math.max(0, STATES.indexOf(w.state)) | (w.caste === 'queen' ? 16 : 0) | (w.rival ? 32 : 0) | (w.caste === 'male' ? 64 : 0) | (w.caste === 'gyne' ? 128 : 0));
      o += BYTES_PER_SWARM_WASP;
    }
  }
  return buf;
}
export function decodeSwarm(buf) {
  const v = new DataView(buf), ng = v.getUint8(5), wasps = [];
  const d16 = (x, lo, hi) => lo + x / 65535 * (hi - lo);
  let o = 6;
  for (let gi = 0; gi < ng; gi++) {
    const cx = v.getInt16(o), cz = v.getInt16(o + 2), base = v.getUint32(o + 4), n = v.getUint8(o + 8); o += GROUP_HEAD;
    for (let i = 0; i < n; i++) {
      const s = v.getUint8(o + 8);
      wasps.push({ id: base + v.getUint16(o), x: cx * CS + d16(v.getUint16(o + 2), -CS / 2, CS / 2), y: d16(v.getUint16(o + 4), 0, YMAX), z: cz * CS + d16(v.getUint16(o + 6), -CS / 2, CS / 2),
        state: STATES[s & 15], caste: s & 16 ? 'queen' : s & 64 ? 'male' : s & 128 ? 'gyne' : 'worker', rival: !!(s & 32) });
      o += BYTES_PER_SWARM_WASP;
    }
  }
  return { mk: 'swarm', peer: v.getUint8(0), tick: v.getUint32(1), wasps };
}

// A traffic packet (far tier): how many of the sender's wasps are out in each chunk beyond the receiver's interest
export function encodeTraffic(m) {
  const buf = new ArrayBuffer(7 + m.chunks.length * 6), v = new DataView(buf);
  v.setUint8(0, m.peer); v.setUint32(1, m.tick); v.setUint16(5, m.chunks.length);
  let o = 7;
  for (const [k, n] of m.chunks) { const [cx, cz] = k.split(',').map(Number); v.setInt16(o, cx); v.setInt16(o + 2, cz); v.setUint16(o + 4, Math.min(65535, n)); o += 6; }
  return buf;
}
export function decodeTraffic(buf) {
  const v = new DataView(buf), n = v.getUint16(5), chunks = [];
  let o = 7;
  for (let i = 0; i < n; i++) { chunks.push([chunkKey(v.getInt16(o), v.getInt16(o + 2)), v.getUint16(o + 4)]); o += 6; }
  return { mk: 'traffic', peer: v.getUint8(0), tick: v.getUint32(1), chunks };
}

const ENCODE = { state: encodeState, swarm: encodeSwarm, traffic: encodeTraffic }, DECODE = { state: decodeState, swarm: decodeSwarm, traffic: decodeTraffic };
// what goes on the wire for a message: binary for the unreliable channels, the event itself otherwise
export function wire(m) { return ENCODE[m.mk] ? { mk: 'bin', kind: m.mk, bin: ENCODE[m.mk](m) } : m; }
export function unwire(m) { return m.mk === 'bin' ? DECODE[m.kind](m.bin) : m; }

import { stingBot } from './bots.js';
import { snapshot, joinFrom } from './persist.js';

export const LINKS = {
  lan: { name: 'LAN', latency: 1, jitter: 1, loss: 0 },
  good: { name: 'Good internet', latency: 5, jitter: 2, loss: 0.02 },
  bad: { name: 'Bad internet', latency: 9, jitter: 4, loss: 0.08 },
  awful: { name: 'Past the window', latency: 16, jitter: 6, loss: 0.1 },
};

// Unreliable state packets are simply dropped on loss. Events ride redundantly in following packets
// (GDD 11.13), so a lost event costs one state interval rather than a full round trip. Events stay in order.
export class Link {
  constructor({ latency = 5, jitter = 2, loss = 0.02, seed = 1 } = {}) {
    Object.assign(this, { latency, jitter, loss, seed });
    this.q = []; this.n = 0; this.lastEventAt = 0;
    this.stats = { sent: 0, dropped: 0, resent: 0 };
  }
  send(msg, tick) {
    this.stats.sent++;
    const n = this.n++;
    let at = tick + this.latency + Math.floor(h32(this.seed, n, 2) * (this.jitter + 1));
    if (msg.bin) { // the unreliable channel: state, swarm and traffic packets
      if (h32(this.seed, n, 1) < this.loss) { this.stats.dropped++; return; }
    } else {
      let k = 0;
      while (h32(this.seed, n, 10 + k) < this.loss && k < 8) { at += T.net.stateEvery; k++; this.stats.resent++; }
      at = Math.max(at, this.lastEventAt);
      this.lastEventAt = at;
    }
    this.q.push({ at, n, msg: msg.bin ? { mk: 'bin', kind: msg.kind, bin: msg.bin.slice(0) } : JSON.parse(JSON.stringify(msg)) });
  }
  poll(tick) {
    const out = [], keep = [];
    for (const e of this.q) (e.at <= tick ? out : keep).push(e);
    this.q = keep;
    out.sort((a, b) => a.at - b.at || a.n - b.n);
    return out.map((e) => e.msg);
  }
}

// Peer A is the player; peer B is a scripted second player stinging the same humans.
export class NetLab {
  constructor(settings, linkName = 'good', botOpts = {}, joinAt = 0) {
    const L = LINKS[linkName] || LINKS.good;
    this.linkName = linkName;
    this.a = new Sim(settings, { peer: 0, net: true, peers: [0, 1] });
    this.joinAt = joinAt;
    // a late joiner is built from a snapshot of A's world when the time comes (GDD 11.10)
    this.b = joinAt ? null : new Sim(settings, { peer: 1, net: true, noAI: true, peers: [0, 1] });
    this.ab = new Link({ ...L, seed: 11 });
    this.ba = new Link({ ...L, seed: 22 });
    this.botB = stingBot({ plan: 'jab', rest: 240, ...botOpts });
    this.checks = { compared: 0, agreed: 0, skipped: 0, firstDiverge: 0 };
    this.bytes = { ab: 0, ba: 0, abState: 0, abSwarm: 0, abTraffic: 0, abEvents: 0, since: 0 };
  }
  _out(sim, link, dir) {
    const to = dir === 'ab' ? 1 : 0;
    for (const m of sim.outbox) {
      if (m.to !== undefined && m.to !== to) continue;
      const w = wire(m), len = (w.bin ? w.bin.byteLength : JSON.stringify(m).length) + 28; // + UDP/IP headers
      this.bytes[dir] += len;
      if (dir === 'ab') this.bytes[w.bin ? { state: 'abState', swarm: 'abSwarm', traffic: 'abTraffic' }[w.kind] : 'abEvents'] += len;
      link.send(w, sim.tick);
    }
    sim.outbox.length = 0;
  }
  _in(msgs) { return msgs.map(unwire); }
  // Average upstream bandwidth of peer A by channel, bytes per second
  bandwidth() {
    const secs = Math.max(1, this.a.tick) / 60, b = this.bytes;
    return { total: b.ab / secs, state: b.abState / secs, swarm: b.abSwarm / secs, traffic: b.abTraffic / secs, events: b.abEvents / secs };
  }
  step(cmdA, cmdB) {
    const t = this.a.tick + 1;
    if (!this.b) {
      this.a.step(cmdA);
      this.a.outbox.length = 0; // nobody to send to yet
      if (this.a.tick >= this.joinAt) { const snap = snapshot(this.a); this.joinBytes = snap.length; this.b = joinFrom(snap, 1, { noAI: true }); this.joined = this.a.tick; }
      return;
    }
    this.a.receive(this._in(this.ba.poll(t)));
    this.b.receive(this._in(this.ab.poll(t)));
    this.a.step(cmdA);
    this.b.step(cmdB || this.botB(this.b));
    this._out(this.a, this.ab, 'ab');
    this._out(this.b, this.ba, 'ba');
    this.bEvents = this.b.drainEvents(); // kept for one step so tests and the lab can look
  }
  // Compare the shared humans: both peers simulate the same union of interest, so they must agree everywhere.
  check() {
    if (!this.b) { this.checks.skipped++; return null; }
    this.checks.compared++;
    const same = this.a.humanHash() === this.b.humanHash();
    if (same) this.checks.agreed++; else if (!this.checks.firstDiverge) this.checks.firstDiverge = this.a.tick;
    return same;
  }
  // How far A's picture of B's wasp is from where B's wasp really is (GDD 11.4)
  remoteError() {
    if (!this.b) return null;
    const bw = this.b._driven();
    if (!bw) return null;
    const r = this.a.remote.get(bw.id);
    if (!r) return null;
    return Math.sqrt(sq(r.x - bw.x) + sq(r.y - bw.y) + sq(r.z - bw.z));
  }
}

// N peers over a full mesh of simulated links (GDD 11.11, personal worlds with friends). Peer 0 is the player and the
// host; the others are scripted. `tamper(from, msg)` lets a test turn one peer into a cheater.
export class MeshLab {
  constructor(settings, n = 3, linkName = 'good', botOpts = {}) {
    const L = LINKS[linkName] || LINKS.good, peers = [...Array(n).keys()];
    this.sims = peers.map((p) => new Sim(settings, { peer: p, net: true, noAI: p > 0, peers }));
    this.links = peers.map((i) => peers.map((j) => (i === j ? null : new Link({ ...L, seed: 100 + i * 10 + j }))));
    this.bots = peers.map((p) => (p ? stingBot({ plan: 'jab', rest: 240 + p * 37, ...botOpts }) : null));
    this.tamper = null;
    this.checks = { compared: 0, agreed: 0 };
  }
  step(cmd0) {
    const t = this.sims[0].tick + 1, n = this.sims.length;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (i !== j) this.sims[j].receive(this.links[i][j].poll(t).map(unwire));
    this.sims.forEach((s, i) => s.step(i ? this.bots[i](s) : cmd0));
    this.sims.forEach((s, i) => {
      for (const m of s.outbox) {
        if (this.tamper) this.tamper(i, m, s);
        const w = wire(m);
        for (let j = 0; j < n; j++) if (j !== i && (m.to === undefined || m.to === j)) this.links[i][j].send(w, s.tick);
      }
      s.outbox.length = 0;
    });
  }
  // do these peers agree on every shared human?
  agree(peers) {
    this.checks.compared++;
    const h = peers.map((p) => this.sims[p].humanHash());
    const same = h.every((x) => x === h[0]);
    if (same) this.checks.agreed++;
    return same;
  }
}
