// A simulated network between peers, and a two-peer lab built on it (GDD 11).
// Deterministic: delays and losses come from the counter hash, so lab runs replay exactly.
import { h32 } from './rng.js';
import { T } from './tuning.js';
import { Sim } from './sim.js';
import { chunkOf } from './world.js';

// ---------------------------------------------------------------- wire format for state packets (GDD 11.12)
// Positions are chunk-relative, 16 bits per axis (1 mm horizontally, 0.6 mm vertically); velocity 8 bits per axis.
const STATES = ['fly', 'stunned', 'attached', 'under', 'chewing', 'trapped', 'balled', 'landed', 'webbed', 'fighting', 'dead', 'perched'];
const CARRY = [null, 'fly', 'caterpillar', 'bee', 'pulp', 'larva'];
const CS = T.chunk.size, YMAX = 40, VMAX = 8;
export const BYTES_PER_WASP = 19;

export function encodeState(m) {
  const buf = new ArrayBuffer(6 + m.wasps.length * BYTES_PER_WASP), v = new DataView(buf);
  v.setUint8(0, m.peer); v.setUint32(1, m.tick); v.setUint8(5, m.wasps.length);
  let o = 6;
  const q16 = (x, lo, hi) => Math.max(0, Math.min(65535, Math.round((x - lo) / (hi - lo) * 65535)));
  const q8 = (x) => Math.max(-127, Math.min(127, Math.round(x / VMAX * 127)));
  for (const w of m.wasps) {
    const cx = chunkOf(w.x), cz = chunkOf(w.z);
    v.setUint32(o, w.id); v.setInt16(o + 4, cx); v.setInt16(o + 6, cz);
    v.setUint16(o + 8, q16(w.x - cx * CS, -CS / 2, CS / 2)); v.setUint16(o + 10, q16(w.y, 0, YMAX)); v.setUint16(o + 12, q16(w.z - cz * CS, -CS / 2, CS / 2));
    v.setInt8(o + 14, q8(w.vx)); v.setInt8(o + 15, q8(w.vy)); v.setInt8(o + 16, q8(w.vz));
    v.setUint8(o + 17, Math.max(0, STATES.indexOf(w.state)));
    v.setUint8(o + 18, (w.caste === 'queen' ? 128 : 0) | (w.under ? 64 : 0) | Math.max(0, CARRY.indexOf(w.carry)));
    o += BYTES_PER_WASP;
  }
  return buf;
}

export function decodeState(buf, underHex = null) {
  const v = new DataView(buf), n = v.getUint8(5), wasps = [];
  const d16 = (x, lo, hi) => lo + x / 65535 * (hi - lo);
  let o = 6;
  for (let i = 0; i < n; i++) {
    const cx = v.getInt16(o + 4), cz = v.getInt16(o + 6), flags = v.getUint8(o + 18);
    wasps.push({
      id: v.getUint32(o), x: cx * CS + d16(v.getUint16(o + 8), -CS / 2, CS / 2), y: d16(v.getUint16(o + 10), 0, YMAX), z: cz * CS + d16(v.getUint16(o + 12), -CS / 2, CS / 2),
      vx: v.getInt8(o + 14) / 127 * VMAX, vy: v.getInt8(o + 15) / 127 * VMAX, vz: v.getInt8(o + 16) / 127 * VMAX,
      state: STATES[v.getUint8(o + 17)], caste: flags & 128 ? 'queen' : 'worker', under: flags & 64 ? underHex || 'yes' : null, carry: CARRY[flags & 63],
    });
    o += BYTES_PER_WASP;
  }
  return { mk: 'state', peer: v.getUint8(0), tick: v.getUint32(1), wasps };
}
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
    if (msg.mk === 'state') {
      if (h32(this.seed, n, 1) < this.loss) { this.stats.dropped++; return; }
    } else {
      let k = 0;
      while (h32(this.seed, n, 10 + k) < this.loss && k < 8) { at += T.net.stateEvery; k++; this.stats.resent++; }
      at = Math.max(at, this.lastEventAt);
      this.lastEventAt = at;
    }
    this.q.push({ at, n, msg: msg.bin ? { mk: 'bin', bin: msg.bin.slice(0) } : JSON.parse(JSON.stringify(msg)) });
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
    this.bytes = { ab: 0, ba: 0, abState: 0, abEvents: 0, since: 0 };
  }
  _out(sim, link, dir) {
    for (const m of sim.outbox) {
      if (m.mk === 'state') {
        const bin = encodeState(m);
        this.bytes[dir] += bin.byteLength + 28; if (dir === 'ab') this.bytes.abState += bin.byteLength + 28; // + UDP/IP headers
        link.send({ mk: 'state', bin }, sim.tick);
      } else {
        const len = JSON.stringify(m).length + 28;
        this.bytes[dir] += len; if (dir === 'ab') this.bytes.abEvents += len;
        link.send(m, sim.tick);
      }
    }
    sim.outbox.length = 0;
  }
  _in(msgs) { return msgs.map((m) => (m.mk === 'bin' ? decodeState(m.bin) : m)); }
  // Average upstream bandwidth of peer A (state packets + events), bytes per second
  bandwidth() { const secs = Math.max(1, this.a.tick) / 60; return { total: this.bytes.ab / secs, state: this.bytes.abState / secs, events: this.bytes.abEvents / secs }; }
  step(cmdA, cmdB) {
    const t = this.a.tick + 1;
    if (!this.b) {
      this.a.step(cmdA);
      this.a.outbox.length = 0; // nobody to send to yet
      if (this.a.tick >= this.joinAt) { this.b = joinFrom(snapshot(this.a), 1, { noAI: true }); this.joined = this.a.tick; }
      return;
    }
    this.a.receive(this._in(this.ba.poll(t)));
    this.b.receive(this._in(this.ab.poll(t)));
    this.a.step(cmdA);
    this.b.step(cmdB || this.botB(this.b));
    this._out(this.a, this.ab, 'ab');
    this._out(this.b, this.ba, 'ba');
    this.b.drainEvents();
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
    return Math.hypot(r.x - bw.x, r.y - bw.y, r.z - bw.z);
  }
}
