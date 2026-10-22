// A simulated network between peers, and a two-peer lab built on it (GDD 11).
// Deterministic: delays and losses come from the counter hash, so lab runs replay exactly.
import { h32 } from './rng.js';
import { T } from './tuning.js';
import { Sim } from './sim.js';
import { stingBot } from './bots.js';

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
    this.q.push({ at, n, msg: JSON.parse(JSON.stringify(msg)) });
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
  constructor(settings, linkName = 'good', botOpts = {}) {
    const L = LINKS[linkName] || LINKS.good;
    this.linkName = linkName;
    this.a = new Sim(settings, { peer: 0, net: true, peers: [0, 1] });
    this.b = new Sim(settings, { peer: 1, net: true, noAI: true, peers: [0, 1] });
    this.ab = new Link({ ...L, seed: 11 });
    this.ba = new Link({ ...L, seed: 22 });
    this.botB = stingBot({ plan: 'jab', rest: 240, ...botOpts });
    this.checks = { compared: 0, agreed: 0, skipped: 0, firstDiverge: 0 };
  }
  step(cmdA, cmdB) {
    const t = this.a.tick + 1;
    this.a.receive(this.ba.poll(t));
    this.b.receive(this.ab.poll(t));
    this.a.step(cmdA);
    this.b.step(cmdB || this.botB(this.b));
    for (const m of this.a.outbox) this.ab.send(m, this.a.tick);
    for (const m of this.b.outbox) this.ba.send(m, this.b.tick);
    this.a.outbox.length = 0; this.b.outbox.length = 0;
    this.b.drainEvents();
  }
  // Compare the shared humans: both peers simulate the same union of interest, so they must agree everywhere.
  check() {
    this.checks.compared++;
    const same = this.a.humanHash() === this.b.humanHash();
    if (same) this.checks.agreed++; else if (!this.checks.firstDiverge) this.checks.firstDiverge = this.a.tick;
    return same;
  }
  // How far A's picture of B's wasp is from where B's wasp really is (GDD 11.4)
  remoteError() {
    const bw = this.b._driven();
    if (!bw) return null;
    const r = this.a.remote.get(bw.id);
    if (!r) return null;
    return Math.hypot(r.x - bw.x, r.y - bw.y, r.z - bw.z);
  }
}
