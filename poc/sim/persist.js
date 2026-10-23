// Snapshot and restore of a whole sim (GDD 4.6 persistence, 11.10 joining a world in progress).
// Exact: numbers round-trip through JSON bit for bit (negative zero and BigInt are tagged), frozen chunks
// are regenerated from seed and checked against their stored content hash, and every Map keeps its order.
import { Domain, hash, u64, fnv32, dcos, dsin } from './rng.js';
import { T, GEN_VERSION } from './tuning.js';
import { TUNE } from './tunefile.js';
import { humanTraits, bodyParts, Style } from './body.js';
import { generateChunk, makeNest, NEST } from './world.js';
import { newColony } from './colony.js';
import { Sim } from './sim.js';

export const SAVE_VERSION = 1;

const replacer = (k, v) => {
  if (typeof v === 'bigint') return { $b: v.toString() };
  if (typeof v === 'number' && Object.is(v, -0)) return { $n: '-0' };
  if (v instanceof Map) return { $map: [...v] };
  if (v instanceof Set) return { $set: [...v] };
  return v;
};
const reviver = (k, v) => {
  if (v && typeof v === 'object') {
    if ('$b' in v) return BigInt(v.$b);
    if ('$n' in v) return -0;
    if ('$map' in v) return new Map(v.$map);
    if ('$set' in v) return new Set(v.$set);
  }
  return v;
};

const HUMAN_FIXED = new Set(['id', 'hex', 'short', 'tr', 'chunk', 'home', 'parts']);
const SKIP = new Set(['events', 'outbox', 'remote', 'log', 'logLen', 'hint', 'feeding', 'humans', 'active', 'activeChunks', 'records', 'ext', 'netStats', '_baitCache', '_siteCache', '_fruitCache', '_tc', '_wc', '_genCache', '_hiberCache']);

export function snapshot(sim) {
  const out = { v: SAVE_VERSION, gen: GEN_VERSION, tune: TUNE.hash, opts: { peer: sim.peer, net: sim.net, noAI: sim.noAI, peers: [...sim.interest.keys()] } };
  for (const k of Object.keys(sim)) if (!SKIP.has(k)) out[k] = sim[k];
  out.records = [...sim.records.values()].map((r) => ({ cx: r.cx, cz: r.cz, genVersion: r.genVersion, discoveredTick: r.discoveredTick, contentHash: r.contentHash }));
  out.humans = [...sim.humans.values()].map((hm) => { const o = {}; for (const k of Object.keys(hm)) if (!HUMAN_FIXED.has(k)) o[k] = hm[k]; o.hex = hm.hex; return o; });
  out.active = sim.active.map((hm) => hm.hex);
  const e = sim.ext;
  out.ext = { visit: e.visit, state: e.state, arriveMinute: e.arriveMinute, lead: e.lead || null, hm: e.hm ? Object.fromEntries(Object.entries(e.hm).filter(([k]) => !['id', 'tr', 'parts'].includes(k))) : null };
  return JSON.stringify(out, replacer);
}

export function restore(json) {
  const d = JSON.parse(json, reviver);
  if (d.v !== SAVE_VERSION) throw new Error(`save version ${d.v} is not ${SAVE_VERSION}`);
  if (d.gen !== GEN_VERSION) throw new Error(`world generator ${d.gen} differs from ${GEN_VERSION}`);
  if (d.tune && d.tune !== TUNE.hash) throw new Error(`world was made with tuning ${d.tune}, this game runs ${TUNE.hash}`); // T1-22
  const sim = new Sim(d.settings, d.opts);
  sim.drainEvents();
  // frozen chunks: regenerate and verify (GDD 4.4)
  sim.records = new Map();
  for (const r of d.records) {
    const content = generateChunk(sim.seed, r.cx, r.cz);
    const h = fnv32(JSON.stringify(content));
    if (h !== r.contentHash) throw new Error(`chunk ${r.cx},${r.cz} does not match its stored hash`);
    sim.records.set(r.cx + ',' + r.cz, { ...r, content });
  }
  // plain state
  for (const k of Object.keys(d)) if (!['v', 'gen', 'tune', 'opts', 'records', 'humans', 'active', 'ext'].includes(k)) sim[k] = d[k];
  if (sim.colony.young === undefined) sim.colony.young = 0; // saves from before worker ages (T1-13)
  // saves from before body temperature (T1-2): wasps come out warm
  for (const w of [...sim.wasps, ...(sim.ghost ? [sim.ghost] : [])]) if (w.bodyT === undefined) { w.bodyT = T.cold.nestTemp; w.chill = 0; }
  // humans: fixed parts come from the world, mutable parts from the save
  sim.humans = new Map();
  const byHex = new Map(d.humans.map((h) => [h.hex, h]));
  for (const rec of sim.records.values()) {
    rec.content.humans.forEach((hs) => {
      const id = hash(sim.seed, Domain.WorldGen, u64(rec.cx), u64(rec.cz), BigInt(hs.slot));
      const hex = id.toString(16).padStart(16, '0');
      const saved = byHex.get(hex);
      if (!saved) return;
      const tr = sim.traitsFor(id);
      const ax = hs.x + T.panic.approachDist * dcos(hs.exit), az = hs.z + T.panic.approachDist * dsin(hs.exit);
      const home = { x: hs.x, z: hs.z, fx: hs.fx, fz: hs.fz, posture: hs.posture, ax, az };
      const hm = { id, hex, short: hex.slice(0, 4), tr, chunk: rec.cx + ',' + rec.cz, parts: { sit: bodyParts(tr, 'sit'), stand: bodyParts(tr, 'stand') }, home };
      Object.assign(hm, saved);
      sim.humans.set(hex, hm);
    });
  }
  // the exterminator, if one is on the job
  sim.ext = { visit: d.ext.visit, state: d.ext.state, arriveMinute: d.ext.arriveMinute, lead: d.ext.lead || null, hm: null };
  if (d.ext.hm) {
    const id = hash(sim.seed, Domain.WorldGen, 0xE77n, BigInt(d.ext.visit));
    const tr = { ...humanTraits(sim.seed, id), height: 1.8, armRatio: 1, girth: 0.4, reactionTicks: 12, style: Style.Precise, accuracy: 0.9, panicSusceptibility: 0.45, sociability: 0, escalation: 1 };
    sim.ext.hm = { ...d.ext.hm, id, tr, parts: { sit: bodyParts(tr, 'sit'), stand: bodyParts(tr, 'stand') } };
  }
  // derived views
  const [cx, cz] = sim.activeKey.split(',').map(Number), A = T.chunk.activeRadius;
  sim.activeChunks = [];
  for (let dz = -A; dz <= A; dz++) for (let dx = -A; dx <= A; dx++) sim.activeChunks.push(sim.records.get((cx + dx) + ',' + (cz + dz)));
  sim.active = d.active.map((hex) => sim.humanByHex(hex));
  sim.log = new Int32Array(9 * 4096); sim.logLen = 0;
  sim.logStartTick = sim.tick;
  sim.events = [];
  sim.emit('chunksActive', { key: sim.activeKey });
  sim.emit('restored', { tick: sim.tick });
  return sim;
}

// Replay from a snapshot plus the input recorded after it (the lab's determinism check for restored worlds)
export function replayFrom(json, log, ticks) {
  const s = restore(json);
  for (let t = 0; t < ticks; t++) { s.step(Sim.cmdAt(log, t)); s.events.length = 0; }
  return s.stateHash();
}

// A new peer joins a world in progress (GDD 11.10): it takes the shared world from a snapshot
// (frozen chunks, chunk deltas, humans, pending events, interest) and starts its own colony.
export function joinFrom(json, peer, opts = {}) {
  const sim = restore(json);
  sim.peer = peer;
  sim.net = true;
  sim.noAI = !!opts.noAI;
  sim.nextWaspId = peer * 1000000 + 1;
  sim.wasps = []; sim.remote = new Map(); sim.outbox = [];
  sim.colony = newColony(); sim.nest = makeNest(NEST.treeX, NEST.treeZ, NEST.x, NEST.y, NEST.z); sim.colony.maxCells = T.sites.trunk.maxCells; sim.oldNests = [];
  sim.stats = { stings: 0, aiStings: 0, remoteStings: 0, full: 0, deaths: 0, causes: {}, caught: 0, deposits: 0 };
  sim.netStats = { sent: 0, recv: 0, late: 0, lateMax: 0 };
  sim.ghost = null; sim.extinct = false; sim.lineage = 0; sim.evSeq = 0; sim.prevAct = 0; sim.pressUsed = false;
  sim.alarms = []; sim.birdState = new Map(); sim.dragonState = new Map();
  const w = sim._spawnWasp(true);
  sim.drivenId = w.id;
  sim.activeKey = '';
  sim._updateChunks();
  sim.drainEvents();
  return sim;
}
