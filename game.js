// STING tier-0 presentation layer (GDD 12). Reads sim state and events, never decides outcomes.
// Everything here may use floats and Math.sin freely; nothing here feeds back into the sim.
import * as THREE from 'three';
import {
  Sim, T, DT, ZONES, ZoneName, SwatKind, SwatKindName, StyleName, TopName, BottomName, Top, Bottom,
  toWorld, toLocal, chunkKey, chunkOf, hash, Domain, unit, rangeInt, resolveSting, zoneCover, selfReach,
  segClosest, classify, predictedKind, NEST,
} from './sim.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ------------------------------------------------------------------ renderer and scene

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const SKY = new THREE.Color('#a9cfe3');
const scene = new THREE.Scene();
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 30, 115);

const camera = new THREE.PerspectiveCamera(70, 1, 0.002, 400);
scene.add(new THREE.HemisphereLight('#dceefa', '#4d5b2c', 1.15));
const sun = new THREE.DirectionalLight('#fff3dc', 2.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 80 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.01;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(0.45, 1, 0.3).normalize();

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ materials

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshLambertMaterial({ color, ...opts }));
  return matCache.get(key);
}

function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#5d8a37';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, l = 3 + Math.random() * 7;
    const shade = 30 + Math.random() * 45;
    g.strokeStyle = `hsl(${85 + Math.random() * 25}, ${35 + Math.random() * 20}%, ${shade}%)`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 3, y - l); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function paperTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  for (let y = 0; y < 256; y += 4) {
    g.fillStyle = `hsl(36, ${10 + Math.random() * 14}%, ${48 + Math.random() * 22}%)`;
    g.fillRect(0, y, 64, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const GROUND_TILE = 3;
const groundTex = grassTexture();
groundTex.repeat.set(399 / GROUND_TILE, 399 / GROUND_TILE);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(399, 399), new THREE.MeshLambertMaterial({ map: groundTex }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ------------------------------------------------------------------ cosmetic palette (presentation only)

const SKIN = ['#f1c9a8', '#e2b08a', '#c98d66', '#a96e49', '#7f4c2f', '#5b3622'];
const HAIR = ['#2a1d14', '#4a2f1d', '#8a5a2b', '#c9a15c', '#1b1b1b', '#9a9a9a'];
const SHIRT = ['#d6503c', '#3f7cc4', '#efede6', '#2f8f6b', '#e2b23a', '#6b4fa3', '#232c38', '#e584a3'];
const JACKET = ['#4b513b', '#7a3b2e', '#2b3a55'];
const JEANS = ['#3c5a86', '#2c3e5c', '#4d6d99'];
const SHORTS = ['#c7b48d', '#5c6e4a', '#8a8f99', '#a3473a'];
const SKIRT = ['#7a2e3b', '#2f4858', '#c9a227'];
const CANS = ['#d42c2c', '#2b6fd6', '#f2f2f2', '#28a35a'];
const FLOWERS = ['#f4f1ea', '#f6c700', '#e5412d', '#b06ad9', '#f08a24'];

function pick(seed, id, k, arr) { return arr[rangeInt(hash(seed, Domain.Cosmetic, id, BigInt(k)), 0, arr.length)]; }

// ------------------------------------------------------------------ game state

let sim = null, seed = 1234n;
let running = false, paused = false;
const input = { keys: new Set(), lmb: false, yaw: 0, pitch: 0 };
const chunkViews = new Map();
const humanViews = new Map();
const anims = [];
const labState = { open: false, zones: false, swats: true, log: [] };
const waspPrev = new THREE.Vector3(), waspCurr = new THREE.Vector3();
let deathSpot = null, deadUntil = 0, toastTimer = 0, bumpTimer = 0;
const camPos = new THREE.Vector3();
let camDist = 0.1;

// ------------------------------------------------------------------ chunk visuals

const geoTrunk = new THREE.CylinderGeometry(0.8, 1, 1, 9);
const geoBlob = new THREE.IcosahedronGeometry(1, 1);
const geoBox = new THREE.BoxGeometry(1, 1, 1);
const geoCan = new THREE.CylinderGeometry(0.033, 0.033, 0.12, 14);
const geoStem = new THREE.CylinderGeometry(0.0035, 0.0035, 1, 4);
const geoHead = new THREE.IcosahedronGeometry(0.022, 1);

function buildChunk(rec) {
  const g = new THREE.Group();
  const c = rec.content;
  for (const t of c.trees) {
    const trunk = new THREE.Mesh(geoTrunk, mat('#5b4330'));
    trunk.scale.set(t.r, t.h, t.r);
    trunk.position.set(t.x, t.h / 2, t.z);
    trunk.castShadow = trunk.receiveShadow = true;
    const leaf = mat(new THREE.Color().setHSL(0.27 + t.shade * 0.06, 0.45, 0.26 + t.shade * 0.08).getStyle(), { flatShading: true });
    const a = new THREE.Mesh(geoBlob, leaf);
    a.scale.setScalar(t.cr);
    a.position.set(t.x, t.h + t.cr * 0.35, t.z);
    const b = new THREE.Mesh(geoBlob, leaf);
    b.scale.setScalar(t.cr * 0.7);
    b.position.set(t.x + t.cr * 0.45, t.h - t.cr * 0.1, t.z - t.cr * 0.3);
    a.castShadow = b.castShadow = true;
    g.add(trunk, a, b);
  }
  const wood = mat('#8a6440');
  for (const b of c.boxes) {
    const m = new THREE.Mesh(geoBox, wood);
    m.scale.set(b.maxx - b.minx, b.maxy - b.miny, b.maxz - b.minz);
    m.position.set((b.minx + b.maxx) / 2, (b.miny + b.maxy) / 2, (b.minz + b.maxz) / 2);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  }
  for (const t of c.tables) {
    const along = t.axisX ? [1, 0] : [0, 1], across = t.axisX ? [0, 1] : [1, 0];
    for (const s of [-0.8, 0.8]) for (const q of [-0.3, 0.3]) {
      const leg = new THREE.Mesh(geoBox, wood);
      leg.scale.set(0.05, 0.71, 0.05);
      leg.position.set(t.x + along[0] * s + across[0] * q, 0.355, t.z + along[1] * s + across[1] * q);
      leg.castShadow = true;
      g.add(leg);
    }
    for (const side of [-0.67, 0.67]) for (const s of [-0.75, 0.75]) {
      const leg = new THREE.Mesh(geoBox, wood);
      leg.scale.set(0.05, 0.4, 0.05);
      leg.position.set(t.x + along[0] * s + across[0] * side, 0.2, t.z + along[1] * s + across[1] * side);
      g.add(leg);
    }
  }
  for (const can of c.cans) {
    const m = new THREE.Mesh(geoCan, mat(CANS[can.color]));
    m.position.set(can.x, 0.81, can.z);
    m.castShadow = true;
    g.add(m);
  }
  if (c.flowers.length) {
    const stems = new THREE.InstancedMesh(geoStem, mat('#4f7a2a'), c.flowers.length);
    const heads = new THREE.InstancedMesh(geoHead, new THREE.MeshLambertMaterial(), c.flowers.length);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    c.flowers.forEach((f, i) => {
      m4.makeScale(1, f.y, 1).setPosition(f.x, f.y / 2, f.z);
      stems.setMatrixAt(i, m4);
      m4.makeTranslation(f.x, f.y, f.z);
      heads.setMatrixAt(i, m4);
      heads.setColorAt(i, col.set(FLOWERS[f.color]));
    });
    g.add(stems, heads);
  }
  if (c.nest) {
    const n = c.nest;
    const nest = new THREE.Mesh(new THREE.SphereGeometry(n.r, 20, 16), new THREE.MeshLambertMaterial({ map: paperTexture() }));
    nest.scale.set(1, 1.25, 1);
    nest.position.set(n.x, n.y, n.z);
    nest.castShadow = true;
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.03, 16), mat('#120d08', { side: THREE.DoubleSide }));
    hole.rotation.x = Math.PI / 2;
    hole.position.set(n.x, n.y - n.r * 1.24, n.z);
    const branch = new THREE.Mesh(geoTrunk, mat('#5b4330'));
    branch.scale.set(0.035, 1.0, 0.035);
    branch.rotation.x = Math.PI / 2.4;
    branch.position.set(n.x, n.y + 0.2, n.z - 0.15);
    g.add(nest, hole, branch);
  }
  return g;
}

function syncChunks() {
  const want = new Set(sim.activeChunks.map((r) => chunkKey(r.cx, r.cz)));
  for (const [k, g] of chunkViews) if (!want.has(k)) { scene.remove(g); chunkViews.delete(k); }
  for (const r of sim.activeChunks) {
    const k = chunkKey(r.cx, r.cz);
    if (!chunkViews.has(k)) { const g = buildChunk(r); chunkViews.set(k, g); scene.add(g); }
  }
  const want2 = new Set(sim.active.map((h) => h.hex));
  for (const [k, v] of humanViews) if (!want2.has(k)) { scene.remove(v.group); humanViews.delete(k); }
  for (const hm of sim.active) if (!humanViews.has(hm.hex)) humanViews.set(hm.hex, buildHuman(hm));
}

// ------------------------------------------------------------------ humans

const UP = new THREE.Vector3(0, 1, 0);

function partMaterial(view, hm, name) {
  const cl = hm.clothing;
  const top = view.colors.top, bottom = view.colors.bottom, skin = view.colors.skin;
  if (name === 'Torso' || name === 'Shoulders') return top;
  if (name.startsWith('UpperArm')) return cl.top === Top.Tank ? skin : top;
  if (name.startsWith('Forearm')) return cl.top === Top.Jacket ? top : skin;
  if (name === 'Pelvis') return bottom;
  if (name.startsWith('Thigh')) return cl.bottom === Bottom.Shorts ? bottom : bottom;
  if (name.startsWith('Shin')) return cl.bottom === Bottom.Jeans ? bottom : skin;
  return skin;
}

function buildHuman(hm) {
  const id = hm.id;
  const colors = {
    skin: mat(pick(seed, id, 0, SKIN)),
    hair: mat(pick(seed, id, 1, HAIR)),
    top: mat(hm.clothing.top === Top.Jacket ? pick(seed, id, 2, JACKET) : pick(seed, id, 2, SHIRT)),
    bottom: mat(hm.clothing.bottom === Bottom.Jeans ? pick(seed, id, 3, JEANS) : hm.clothing.bottom === Bottom.Shorts ? pick(seed, id, 3, SHORTS) : pick(seed, id, 3, SKIRT)),
  };
  const group = new THREE.Group();
  const view = { hm, group, colors, meshes: {}, posture: null, x: hm.x, z: hm.z, ang: Math.atan2(hm.fx, hm.fz), flinch: 0, lean: new THREE.Vector3(), walk: 0, zonesOn: false };
  scene.add(group);
  rebuildHuman(view);
  return view;
}

function rebuildHuman(view) {
  const { hm, group } = view;
  for (const m of Object.values(view.meshes)) group.remove(m);
  view.meshes = {};
  view.rest = hm.parts[hm.posture];
  for (const p of view.rest) {
    const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y, p.b.z - p.a.z);
    const geo = new THREE.CapsuleGeometry(p.r, len, 5, 10);
    const m = new THREE.Mesh(geo, partMaterial(view, hm, p.name));
    m.castShadow = true;
    m.userData.part = p;
    m.userData.len = len;
    group.add(m);
    view.meshes[p.name] = m;
  }
  const head = view.rest.find((p) => p.name === 'Head');
  const hair = new THREE.Mesh(new THREE.SphereGeometry(head.r * 1.04, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), view.colors.hair);
  hair.rotation.x = -0.35;
  view.meshes.Hair = hair;
  const eyeGeo = new THREE.SphereGeometry(head.r * 0.11, 6, 5);
  const eyeL = new THREE.Mesh(eyeGeo, mat('#15110d')), eyeR = new THREE.Mesh(eyeGeo, mat('#15110d'));
  view.meshes.EyeL = eyeL; view.meshes.EyeR = eyeR;
  group.add(hair, eyeL, eyeR);
  view.posture = hm.posture;
  view.zonesOn = false;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
function placeCapsule(mesh, a, b) {
  _d.subVectors(b, a);
  const len = _d.length();
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, _d.divideScalar(len));
}

const V = (p) => new THREE.Vector3(p.x, p.y, p.z);

// Two-bone IK in the human's local frame. Returns elbow and hand.
function solveArm(S, target, la, lb, side) {
  const d = new THREE.Vector3().subVectors(target, S);
  let dist = d.length();
  const dn = dist > 1e-6 ? d.clone().divideScalar(dist) : new THREE.Vector3(0, -1, 0);
  dist = Math.min(Math.max(dist, Math.abs(la - lb) + 1e-3), la + lb - 1e-3);
  const x = (la * la - lb * lb + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, la * la - x * x));
  const pole = new THREE.Vector3(side, -1, -0.4).normalize();
  pole.sub(dn.clone().multiplyScalar(pole.dot(dn))).normalize();
  const E = S.clone().add(dn.clone().multiplyScalar(x)).add(pole.multiplyScalar(h));
  const H = S.clone().add(dn.clone().multiplyScalar(dist));
  return { E, H };
}

function envelope(an, t) {
  const windup = Math.max(4, Math.min(10, an.start - an.contactTick - 1));
  const ws = an.start - windup, end = an.start + an.window;
  if (t < ws) return 0;
  if (t < an.start) { const u = (t - ws) / windup; return u * u; }
  if (t < end) return 1;
  if (t < end + 16) return 1 - (t - end) / 16;
  return -1;
}

function poseHuman(view, t, dt) {
  const { hm, group } = view;
  if (view.posture !== hm.posture) rebuildHuman(view);
  if (labState.zones !== view.zonesOn) applyZoneColors(view, labState.zones);

  // smooth body frame
  const k = 1 - Math.exp(-dt * 12);
  view.x += (hm.x - view.x) * k;
  view.z += (hm.z - view.z) * k;
  const target = Math.atan2(hm.fx, hm.fz);
  let da = target - view.ang;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  view.ang += da * Math.min(1, dt * 10);
  view.flinch = Math.max(0, view.flinch - dt * 4);

  const moving = hm.state === 'flee' || hm.state === 'return';
  if (moving) view.walk += dt * (hm.state === 'flee' ? 13 : 7);

  // endpoints from rest pose
  const P = {};
  for (const p of view.rest) P[p.name] = { a: V(p.a), b: V(p.b) };
  const pivotSwing = (name, ang) => {
    const pr = P[name];
    const v = pr.b.clone().sub(pr.a).applyAxisAngle(new THREE.Vector3(1, 0, 0), ang);
    pr.b.copy(pr.a).add(v);
    return v;
  };
  if (moving && hm.posture === 'stand') {
    const amp = hm.state === 'flee' ? 0.7 : 0.4;
    for (const [side, ph] of [['L', 0], ['R', Math.PI]]) {
      const s = Math.sin(view.walk + ph) * amp;
      pivotSwing('Thigh' + side, s);
      const th = P['Thigh' + side], sh = P['Shin' + side];
      const shv = sh.b.clone().sub(sh.a).applyAxisAngle(new THREE.Vector3(1, 0, 0), s - Math.max(0, -s) * 0.8);
      sh.a.copy(th.b); sh.b.copy(th.b).add(shv);
      pivotSwing('UpperArm' + side, -s * 0.8);
      const ua = P['UpperArm' + side], fa = P['Forearm' + side];
      const fav = fa.b.clone().sub(fa.a).applyAxisAngle(new THREE.Vector3(1, 0, 0), -s * 0.8 - 0.5);
      fa.a.copy(ua.b); fa.b.copy(ua.b).add(fav);
    }
  }
  if (hm.tr.style === 3 && hm.panic > 0.15) {
    // freezer: arms half raised, trembling
    for (const side of ['L', 'R']) {
      const sd = side === 'L' ? -1 : 1;
      const ua = P['UpperArm' + side];
      const tgt = ua.a.clone().add(new THREE.Vector3(sd * 0.12, 0.05 + Math.sin(t * 2.7) * 0.01, 0.22));
      const la = ua.a.distanceTo(ua.b), lb = P['Forearm' + side].a.distanceTo(P['Forearm' + side].b);
      const { E, H } = solveArm(ua.a, tgt, la, lb, sd);
      ua.b.copy(E); P['Forearm' + side].a.copy(E); P['Forearm' + side].b.copy(H);
    }
  }

  // swat animations on this human's arms
  view.lean.set(0, 0, 0);
  let twist = 0;
  for (const an of anims) {
    if (an.actorHex !== hm.hex) continue;
    const e = envelope(an, t);
    if (e <= 0) continue;
    const stung = humanViews.get(an.stungHex);
    if (!stung) continue;
    const impactW = stung.group.localToWorld(V(an.center));
    if (an.kind === SwatKind.Contort) {
      twist = Math.sin(t * 1.9) * 0.45 * e;
      for (const side of ['L', 'R']) {
        const sd = side === 'L' ? -1 : 1;
        const ua = P['UpperArm' + side], fa = P['Forearm' + side];
        const reachOver = ua.a.clone().add(new THREE.Vector3(-sd * 0.06 + Math.sin(t * 2.3 + sd) * 0.07, 0.16 + Math.sin(t * 1.7 * sd) * 0.05, -0.16));
        const rest = fa.b.clone();
        const tgt = rest.lerp(reachOver, e);
        const { E, H } = solveArm(ua.a, tgt, ua.a.distanceTo(ua.b), fa.a.distanceTo(fa.b), sd);
        ua.b.copy(E); fa.a.copy(E); fa.b.copy(H);
      }
      continue;
    }
    // helpers lean in so the hand can reach (presentation only)
    const local = group.worldToLocal(impactW.clone());
    if (an.actorHex !== an.stungHex) {
      const horiz = Math.hypot(local.x, local.z);
      const need = Math.max(0, horiz - 0.42);
      if (need > 0) {
        const dirW = new THREE.Vector3(impactW.x - group.position.x, 0, impactW.z - group.position.z).normalize();
        view.lean.add(dirW.multiplyScalar(need * e));
      }
    }
    const side = an.side;
    const n = side < 0 ? 'L' : 'R';
    const ua = P['UpperArm' + n], fa = P['Forearm' + n];
    let tgt = fa.b.clone().lerp(local, e);
    if (an.kind === SwatKind.Brush && t >= an.start) tgt.x += Math.sin((t - an.start) * 0.9) * 0.07;
    if (an.flail && t >= an.start - 2) tgt.add(new THREE.Vector3(Math.sin(t * 3.1) * 0.03, Math.cos(t * 2.3) * 0.03, 0));
    const { E, H } = solveArm(ua.a, tgt, ua.a.distanceTo(ua.b), fa.a.distanceTo(fa.b), side);
    ua.b.copy(E); fa.a.copy(E); fa.b.copy(H);
  }

  // head twist for contort, flinch jolt
  if (twist) {
    for (const nm of ['Head', 'Neck']) {
      const pr = P[nm], piv = P.Torso.b;
      for (const pt of [pr.a, pr.b]) pt.sub(piv).applyAxisAngle(UP, twist).add(piv);
    }
  }
  for (const p of view.rest) {
    const m = view.meshes[p.name];
    placeCapsule(m, P[p.name].a, P[p.name].b);
  }
  const head = P.Head.a, r = view.rest.find((p) => p.name === 'Head').r;
  view.meshes.Hair.position.copy(head).add(new THREE.Vector3(0, r * 0.08, -r * 0.05));
  view.meshes.Hair.rotation.y = twist;
  const fwd = new THREE.Vector3(Math.sin(twist), 0, Math.cos(twist));
  const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
  view.meshes.EyeL.position.copy(head).addScaledVector(fwd, r * 0.9).addScaledVector(right, -r * 0.35).add(new THREE.Vector3(0, r * 0.15, 0));
  view.meshes.EyeR.position.copy(head).addScaledVector(fwd, r * 0.9).addScaledVector(right, r * 0.35).add(new THREE.Vector3(0, r * 0.15, 0));

  const jolt = view.flinch > 0 ? Math.sin(view.flinch * 40) * 0.015 * view.flinch : 0;
  group.position.set(view.x + view.lean.x, jolt, view.z + view.lean.z);
  group.rotation.y = view.ang;
}

// Lab: color every vertex of the body by what the human does if stung there (GDD 8.3-8.5)
const KIND_COLOR = () => ({
  [-1]: new THREE.Color(css('--slate')), [-2]: new THREE.Color('#c9c3f0'),
  [SwatKind.Slap]: new THREE.Color(css('--red')), [SwatKind.Cover]: new THREE.Color(css('--orange')),
  [SwatKind.Brush]: new THREE.Color(css('--yellow')), [SwatKind.Contort]: new THREE.Color(css('--green')),
});
let kindColors = null;
const zoneMatCache = new Map();
function applyZoneColors(view, on) {
  view.zonesOn = on;
  const { hm } = view;
  kindColors = kindColors || KIND_COLOR();
  for (const p of view.rest) {
    const m = view.meshes[p.name];
    if (!on) { m.material = partMaterial(view, hm, p.name); continue; }
    const geo = m.geometry;
    const pos = geo.attributes.position, nrm = geo.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    const restMesh = new THREE.Object3D();
    placeCapsule(restMesh, V(p.a), V(p.b));
    restMesh.updateMatrix();
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    const s = hm.tr.height / 1.75;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(restMesh.matrix);
      n.fromBufferAttribute(nrm, i).applyQuaternion(restMesh.quaternion);
      const lp = { x: v.x, y: v.y, z: v.z };
      const q = segClosest(p.a, p.b, lp);
      const zone = classify(p, q, { x: n.x, y: n.y, z: n.z }, lp, s);
      const c = kindColors[predictedKind(zone, hm.tr, hm.clothing)];
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (!zoneMatCache.has('z')) zoneMatCache.set('z', new THREE.MeshLambertMaterial({ vertexColors: true }));
    m.material = zoneMatCache.get('z');
  }
}

// ------------------------------------------------------------------ wasp

function buildWasp() {
  const g = new THREE.Group();
  const black = mat('#15120c'), yellow = mat('#f2c200');
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.0021, 12, 10), yellow);
  head.position.z = 0.0058; head.scale.set(1.15, 1, 0.9);
  const eyes = new THREE.Mesh(new THREE.SphereGeometry(0.0013, 8, 6), black);
  eyes.scale.set(2.0, 1.1, 0.8); eyes.position.set(0, 0.0004, 0.0062);
  const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.0026, 12, 10), black);
  thorax.position.z = 0.0025; thorax.scale.set(1, 0.95, 1.2);
  const abdomen = new THREE.Group();
  abdomen.position.z = 0.0004;
  const segs = [[0.0027, yellow], [0.003, black], [0.0029, yellow], [0.0025, black], [0.0021, yellow], [0.0014, black]];
  let z = -0.0012;
  for (const [r, m] of segs) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), m);
    s.position.z = z; s.scale.set(1, 0.9, 0.8);
    abdomen.add(s);
    z -= r * 1.05;
  }
  const sting = new THREE.Mesh(new THREE.ConeGeometry(0.0004, 0.002, 6), black);
  sting.rotation.x = -Math.PI / 2; sting.position.z = z - 0.0004;
  abdomen.add(sting);
  const wingMat = new THREE.MeshBasicMaterial({ color: '#e8eef2', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
  const wingGeo = new THREE.PlaneGeometry(0.0034, 0.0085);
  wingGeo.translate(0.0017, 0, -0.003);
  const wl = new THREE.Mesh(wingGeo, wingMat), wr = new THREE.Mesh(wingGeo, wingMat);
  wl.position.set(0.001, 0.0018, 0.003); wr.position.set(-0.001, 0.0018, 0.003);
  wr.scale.x = -1;
  g.add(head, eyes, thorax, abdomen, wl, wr);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData = { abdomen, wl, wr };
  return g;
}
const waspMesh = buildWasp();
scene.add(waspMesh);

const swatGeo = new THREE.SphereGeometry(1, 18, 12);
const swatMats = {
  kill: new THREE.MeshBasicMaterial({ color: css('--red'), wireframe: true, transparent: true, opacity: 0.55 }),
  stun: new THREE.MeshBasicMaterial({ color: css('--green'), wireframe: true, transparent: true, opacity: 0.55 }),
};
const swatPool = [];
function swatMesh(i) {
  while (swatPool.length <= i) { const m = new THREE.Mesh(swatGeo, swatMats.kill); scene.add(m); swatPool.push(m); }
  return swatPool[i];
}

// ------------------------------------------------------------------ input

function buildCmd() {
  if (input.autopilot) return input.autopilot(sim); // test hook: scripted pilots go through the same input path
  const k = input.keys;
  const a = (p, n) => ((k.has(p) ? 100 : 0) - (k.has(n) ? 100 : 0));
  const look = 1.6 * DT;
  if (k.has('ArrowLeft')) input.yaw += look;
  if (k.has('ArrowRight')) input.yaw -= look;
  if (k.has('ArrowUp')) input.pitch = Math.min(1.45, input.pitch + look * 0.8);
  if (k.has('ArrowDown')) input.pitch = Math.max(-1.45, input.pitch - look * 0.8);
  return {
    mx: a('KeyD', 'KeyA'), mz: a('KeyW', 'KeyS'), my: a('Space', 'KeyC'),
    burst: k.has('ShiftLeft') || k.has('ShiftRight') ? 1 : 0,
    sting: input.lmb || k.has('KeyF') ? 1 : 0,
    yawQ: Math.round(input.yaw * 1e4), pitchQ: Math.round(input.pitch * 1e4),
  };
}

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Tab') { e.preventDefault(); toggleLab(); return; }
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  input.keys.add(e.code);
});
addEventListener('keyup', (e) => input.keys.delete(e.code));
addEventListener('blur', () => { input.keys.clear(); input.lmb = false; });
let lockFailed = false;
document.addEventListener('pointerlockerror', () => { lockFailed = true; toast('Mouse capture unavailable · drag with right button to look', 'var(--muted)', 3); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (!running || paused) return;
  if (document.pointerLockElement !== canvas && !lockFailed && !pointerLockWorked) { lock(); return; }
  if (e.button === 0) input.lmb = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) input.lmb = false; });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas && !(e.buttons & 2)) return;
  input.yaw -= e.movementX * 0.0022;
  input.pitch = Math.max(-1.45, Math.min(1.45, input.pitch - e.movementY * 0.0022));
});
function lock() {
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* optional */ }
}
document.addEventListener('pointerlockchange', () => {
  if (!running) return;
  const locked = document.pointerLockElement === canvas;
  if (!locked && pointerLockWorked) setPaused(true);
  if (locked) { pointerLockWorked = true; setPaused(false); }
});
let pointerLockWorked = false;
function setPaused(p) { paused = p; $('pauseScreen').hidden = !p; input.lmb = false; input.keys.clear(); }
$('bResume').addEventListener('click', () => { setPaused(false); lock(); });

// ------------------------------------------------------------------ lab

function toggleLab() {
  labState.open = !labState.open;
  $('lab').hidden = !labState.open;
  document.body.classList.toggle('lab-open', labState.open);
  try { localStorage.setItem('sting.lab', labState.open ? '1' : '0'); } catch { /* optional */ }
}
$('bZones').addEventListener('click', (e) => { labState.zones = !labState.zones; e.currentTarget.setAttribute('aria-pressed', labState.zones); });
$('bSwats').addEventListener('click', (e) => { labState.swats = !labState.swats; e.currentTarget.setAttribute('aria-pressed', labState.swats); });
$('bVerify').addEventListener('click', () => {
  const ticks = sim.tick, live = sim.stateHash();
  const t0 = performance.now();
  const replayed = Sim.replay(seed, sim.log, ticks);
  const ms = Math.round(performance.now() - t0);
  const out = $('verifyOut');
  out.innerHTML = replayed === live
    ? `<span class="ok">Match</span> · replayed ${fmt(ticks)} ticks in ${ms} ms · ${replayed}`
    : `<span class="bad">Mismatch</span> · live ${live} · replay ${replayed}`;
});

function logEvent(text) {
  labState.log.unshift(`<span>${sim.tick}</span> <b>${text}</b>`);
  labState.log.length = Math.min(labState.log.length, 14);
}

const ms = (ticks) => Math.round(ticks * 1000 / 60);
const zoneLabel = (z) => ZoneName[z].replace(/([a-z])([A-Z])/g, '$1 $2');

function updateLab() {
  const w = sim.wasp;
  $('lTick').textContent = fmt(sim.tick);
  $('lHash').textContent = sim.stateHash();
  $('lSeed').textContent = String(seed);
  $('lChunks').textContent = `${sim.records.size} / ${sim.activeChunks.length}`;
  $('lWasp').textContent = `${w.state} · ${Math.hypot(w.vx, w.vy, w.vz).toFixed(2)} m/s · y ${w.y.toFixed(2)} m`;
  const c = sim.contact;
  if (c) {
    const hm = sim.humanByHex(c.humanHex);
    const cover = ['bare', 'thin cloth', 'thick cloth'][zoneCover(hm.clothing, c.zone)];
    let html = `<dl><dt>Human</dt><dd>#${hm.short}</dd><dt>Zone</dt><dd>${zoneLabel(c.zone)}</dd><dt>Cover</dt><dd>${cover}</dd><dt>Self reach</dt><dd>${c.reach.toFixed(2)}</dd></dl>`;
    if (!c.blocked) {
      const comps = sim._companions(hm);
      const plan = resolveSting({ contactTick: 0, zone: c.zone, contactPointBody: c.surf, mode: 'jab' }, hm.tr, ZONES[c.zone], { clothingStiffness: hm.clothing.stiffness, panic: hm.panic, companions: comps });
      if (!plan.swats.length) html += `<div class="swatline"><span>Nobody swats</span><span>freezes</span></div>`;
      for (const s of plan.swats) {
        const who = s.actorId === hm.id ? 'self' : '#' + comps.find((x) => x.id === s.actorId).hex.slice(0, 4);
        html += `<div class="swatline"><span>${who} ${SwatKindName[s.kind].toLowerCase()}${s.kills ? ', kills' : ', stuns'}</span><span>${ms(s.start)} ms</span></div>`;
      }
      if (plan.flee) html += `<div class="swatline"><span>Runs</span><span>on contact</span></div>`;
    }
    $('lContact').innerHTML = html;
    $('lContact').className = '';
  } else {
    $('lContact').textContent = 'Fly within 2 cm of a person.';
    $('lContact').className = 'label';
  }
  let near = null, nd = Infinity;
  for (const hm of sim.active) { const d = Math.hypot(hm.x - w.x, hm.z - w.z); if (d < nd) { nd = d; near = hm; } }
  if (near) {
    const t = near.tr;
    $('lHuman').innerHTML = [
      ['ID', '#' + near.short], ['Distance', nd.toFixed(1) + ' m'], ['Height', t.height.toFixed(2) + ' m'], ['Arm ratio', t.armRatio.toFixed(2)],
      ['Flexibility', t.flexibility.toFixed(2)], ['Girth', t.girth.toFixed(2)], ['Stiffness (age)', t.ageStiffness.toFixed(2)],
      ['Reaction', `${t.reactionTicks} ticks · ${ms(t.reactionTicks)} ms`], ['Swat style', StyleName[t.style]], ['Accuracy', t.accuracy.toFixed(2)],
      ['Panic', `${near.panic.toFixed(2)} · ${near.state}`], ['Sociability', t.sociability.toFixed(2)],
      ['Clothes', `${TopName[near.clothing.top]}, ${BottomName[near.clothing.bottom]}`], ['Stung', near.stungCount + '×'],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }
  $('lLog').innerHTML = labState.log.map((l) => `<div>${l}</div>`).join('');
}

// ------------------------------------------------------------------ HUD

function toast(text, color = 'var(--fg)', secs = 2.2) {
  const el = $('toast');
  el.textContent = text;
  el.style.color = color;
  el.style.opacity = 1;
  toastTimer = secs;
}

function updateHud() {
  const w = sim.wasp;
  $('stungN').textContent = fmt(sim.stung.size);
  $('workers').textContent = fmt(sim.workers);
  $('serial').textContent = 'Worker ' + w.serial;
  $('venomBar').style.width = (w.venom * 100).toFixed(1) + '%';
  $('cropBar').style.width = (w.energy * 100).toFixed(1) + '%';
  $('cropBar').style.background = w.energy < 0.2 ? 'var(--red)' : '';
  let status = '';
  if (w.state === 'attached') status = sim.tick - w.attach.start >= T.sting.jabTicks ? 'Stinging · release to pull out' : 'Stinging';
  else if (w.state === 'stunned') status = 'Stunned';
  else if (w.state === 'dead') status = '';
  else if (sim.feeding) status = 'Feeding';
  else if (w.energy <= 0) status = 'Crop empty · falling';
  else if (Math.hypot(w.vx, w.vy, w.vz) < 0.05) status = 'Hovering';
  $('status').textContent = status;
  const c = sim.contact, ret = $('reticle'), zl = $('zone');
  ret.className = 'hud' + (c ? (c.blocked ? ' blocked' : ' contact') : '');
  if (c && w.state === 'fly') {
    const hm = sim.humanByHex(c.humanHex);
    const lower = ['Groin', 'Buttocks', 'Thighs', 'Shins'].includes(ZoneName[c.zone]);
    const coverName = lower ? BottomName[hm.clothing.bottom] : TopName[hm.clothing.top];
    zl.innerHTML = `${zoneLabel(c.zone)}<small>${c.blocked ? coverName + ' · can\'t sting through' : 'hold to sting'}</small>`;
  } else if (w.state === 'attached') {
    zl.innerHTML = `${zoneLabel(w.attach.zone)}<small>${((sim.tick - w.attach.start) / 60).toFixed(2)} s in</small>`;
  } else zl.innerHTML = '';
}

// ------------------------------------------------------------------ minimap

const mapCtx = $('map').getContext('2d');
// Map is oriented like the view when facing +z: +z up, +x to the LEFT (the camera's right is -x).
function drawMap() {
  const ctx = mapCtx, W = 336, cell = 48, span = 4, CSZ = T.chunk.size;
  const w = sim.wasp;
  const toS = (x, z) => [W / 2 - (x - w.x) / CSZ * cell, W / 2 - (z - w.z) / CSZ * cell];
  const ccx = chunkOf(w.x), ccz = chunkOf(w.z);
  ctx.clearRect(0, 0, W, W);
  for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) {
    const cx = ccx + dx, cz = ccz + dz;
    const [sx, sy] = toS((cx + 0.5) * CSZ, (cz + 0.5) * CSZ); // top-left corner on screen
    const rec = sim.records.get(chunkKey(cx, cz));
    if (rec) {
      ctx.fillStyle = `hsla(${88 + rec.content.tint * 20}, 30%, ${21 + rec.content.tint * 8}%, 0.92)`;
      ctx.fillRect(sx + 1, sy + 1, cell - 2, cell - 2);
      ctx.fillStyle = 'rgba(243,238,226,.4)';
      for (const t of rec.content.tables) { const [x, y] = toS(t.x, t.z); ctx.fillRect(x - 2, y - 2, 4, 4); }
    } else {
      ctx.strokeStyle = 'rgba(165,157,138,.2)';
      ctx.strokeRect(sx + 1.5, sy + 1.5, cell - 3, cell - 3);
    }
    if (Math.abs(dx) <= T.chunk.activeRadius && Math.abs(dz) <= T.chunk.activeRadius) {
      ctx.strokeStyle = 'rgba(246,199,0,.3)';
      ctx.strokeRect(sx + 0.5, sy + 0.5, cell - 1, cell - 1);
    }
  }
  const yellow = css('--yellow'), red = css('--red');
  for (const hm of sim.active) {
    const [x, y] = toS(hm.x, hm.z);
    ctx.fillStyle = hm.panic > 0.5 ? red : sim.stung.has(hm.hex) ? yellow : 'rgba(243,238,226,.85)';
    ctx.fillRect(x - 2, y - 2, 4, 4);
  }
  const [nx, ny] = toS(NEST.x, NEST.z);
  ctx.strokeStyle = yellow; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(nx, ny, 5, 0, Math.PI * 2); ctx.stroke();
  ctx.save();
  ctx.translate(W / 2, W / 2);
  ctx.rotate(-input.yaw);
  ctx.fillStyle = yellow;
  ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------ events

function handleEvents(events) {
  for (const e of events) {
    switch (e.type) {
      case 'chunksActive': syncChunks(); break;
      case 'chunkDiscovered': break;
      case 'sting': {
        const v = humanViews.get(e.humanHex);
        if (v) v.flinch = 1;
        const hm = sim.humanByHex(e.humanHex);
        for (const s of e.swats) {
          const self = s.actorHex === e.humanHex;
          let side = 1;
          if (self) side = e.contactPointBody.x > 0.02 ? -1 : 1;
          else {
            const actor = sim.humanByHex(s.actorHex);
            const wpt = toWorld(hm, s.center), lp = toLocal(actor, wpt);
            side = lp.x >= 0 ? 1 : -1;
          }
          const actor = sim.humanByHex(s.actorHex);
          anims.push({ ...s, stungHex: e.humanHex, contactTick: e.t, side, flail: actor && actor.tr.style === 1 });
        }
        if (e.first) {
          const b = $('bump'); b.textContent = '+1 · ' + zoneLabel(e.zone); b.style.opacity = 1; bumpTimer = 1.6;
        }
        logEvent(`stung #${hm.short} · ${zoneLabel(e.zone)} · ${e.swats.length} swat${e.swats.length === 1 ? '' : 's'} coming`);
        break;
      }
      case 'deepen': logEvent(`full sting #${e.humanHex.slice(0, 4)}`); break;
      case 'blocked': toast(`${zoneLabel(e.zone)} is covered. Can't sting through.`, 'var(--muted)', 1.6); break;
      case 'noVenom': toast('Out of venom', 'var(--muted)', 1.4); break;
      case 'swatHit': logEvent(`${SwatKindName[e.kind].toLowerCase()} hit by #${e.actorHex.slice(0, 4)} at ${ms(e.delayTicks)} ms`); break;
      case 'stunned': toast('Brushed off · stunned', 'var(--yellow)', 1.6); break;
      case 'flee': logEvent(`#${e.humanHex.slice(0, 4)} runs`); break;
      case 'exhausted': toast('Crop empty · feed on flowers or soda', 'var(--red)', 2.6); break;
      case 'waspDied': {
        deathSpot = new THREE.Vector3(e.x, e.y, e.z);
        const by = e.byHex ? `#${e.byHex.slice(0, 4)}` : '';
        const sw = anims.find((a) => a.actorHex === e.byHex);
        const when = sw ? ` · ${ms(sw.start - sw.contactTick)} ms after contact` : '';
        $('deadTitle').textContent = 'SWATTED';
        $('deadSub').textContent = `${e.cause} by ${by}${when} · ${fmt(e.workersLeft)} workers left`;
        $('dead').hidden = false;
        deadUntil = performance.now() + 2400;
        logEvent(`worker died · ${e.cause}`);
        break;
      }
      case 'respawn':
        input.yaw = e.yaw; input.pitch = 0;
        waspPrev.set(sim.wasp.x, sim.wasp.y, sim.wasp.z); waspCurr.copy(waspPrev);
        camPos.copy(waspCurr).add(new THREE.Vector3(-Math.sin(e.yaw) * 0.3, 0.1, -Math.cos(e.yaw) * 0.3));
        $('dead').hidden = true;
        logEvent(`worker ${e.serial} leaves the nest`);
        break;
      case 'lineExtinct':
        $('dead').hidden = true;
        $('extinctStats').textContent = `${fmt(sim.stung.size)} humans stung across ${fmt(sim.stats.stings)} stings. ${fmt(sim.stats.deaths)} workers lost. ${fmt(sim.records.size)} chunks discovered.`;
        $('extinctScreen').hidden = false;
        document.exitPointerLock?.();
        break;
    }
  }
}

// ------------------------------------------------------------------ frame

function renderWasp(alpha, t, dt) {
  const w = sim.wasp;
  const p = new THREE.Vector3().lerpVectors(waspPrev, waspCurr, alpha);
  const alive = w.state !== 'dead' && w.state !== 'extinct';
  waspMesh.visible = alive;
  waspMesh.position.copy(p);
  waspMesh.rotation.order = 'YXZ';
  waspMesh.rotation.y = input.yaw;
  waspMesh.rotation.x = -input.pitch * 0.6;
  if (w.state === 'stunned') { waspMesh.rotation.z = t * 0.6; waspMesh.rotation.x += Math.sin(t * 0.4); } else waspMesh.rotation.z = 0;
  const flap = w.state === 'attached' ? 0.15 : Math.sin(performance.now() * 0.9) * 0.9;
  waspMesh.userData.wl.rotation.z = flap; waspMesh.userData.wr.rotation.z = -flap;
  waspMesh.userData.abdomen.rotation.x = w.state === 'attached' ? 0.5 + Math.sin(t * 0.8) * 0.06 : 0;
  return p;
}

function updateCamera(p, dt) {
  const w = sim.wasp;
  const dead = w.state === 'dead' || w.state === 'extinct';
  const fwd = new THREE.Vector3(Math.sin(input.yaw) * Math.cos(input.pitch), Math.sin(input.pitch), Math.cos(input.yaw) * Math.cos(input.pitch));
  const want = dead ? 0.9 : w.state === 'attached' ? 0.17 : sim.contact ? 0.13 : 0.1;
  camDist += (want - camDist) * (1 - Math.exp(-dt * 4));
  const focus = dead && deathSpot ? deathSpot : p;
  const target = focus.clone().addScaledVector(fwd, -camDist).add(new THREE.Vector3(0, camDist * 0.28, 0));
  if (target.y < 0.006) target.y = 0.006;
  camPos.lerp(target, 1 - Math.exp(-dt * (dead ? 2 : 14)));
  // keep the camera out of people (presentation only)
  for (const hm of sim.active) {
    if (Math.hypot(hm.x - camPos.x, hm.z - camPos.z) > 1.5) continue;
    const lp = toLocal(hm, camPos);
    for (const part of hm.parts[hm.posture]) {
      const q = segClosest(part.a, part.b, lp);
      const ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z, d = Math.hypot(ex, ey, ez), rr = part.r + 0.012;
      if (d < rr && d > 1e-6) { lp.x = q.x + ex / d * rr; lp.y = q.y + ey / d * rr; lp.z = q.z + ez / d * rr; }
    }
    const wpt = toWorld(hm, lp);
    camPos.set(wpt.x, wpt.y, wpt.z);
  }
  camera.position.copy(camPos);
  camera.lookAt(focus.clone().addScaledVector(fwd, 0.06));
  sun.position.copy(focus).addScaledVector(SUN_DIR, 40);
  sun.target.position.copy(focus);
  ground.position.set(Math.round(focus.x / GROUND_TILE) * GROUND_TILE, 0, Math.round(focus.z / GROUND_TILE) * GROUND_TILE);
}

function renderSwats(t) {
  let i = 0;
  if (labState.open && labState.swats) {
    for (const s of sim.swats) {
      const hm = sim.humanByHex(s.stungHex);
      if (!hm) continue;
      const c = toWorld(hm, s.center);
      const m = swatMesh(i++);
      m.visible = true;
      m.position.set(c.x, c.y, c.z);
      const active = sim.tick >= s.start;
      m.scale.setScalar(active ? s.radius : s.radius * (0.3 + 0.7 * Math.max(0, 1 - (s.start - t) / 40)));
      m.material = s.kills ? swatMats.kill : swatMats.stun;
      m.material.opacity = active ? 0.85 : 0.35;
    }
  }
  for (; i < swatPool.length; i++) swatPool[i].visible = false;
}

let last = performance.now(), acc = 0, labTimer = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (running && !paused) {
    acc += dt;
    let n = 0;
    while (acc >= DT && n < 8) {
      waspPrev.set(sim.wasp.x, sim.wasp.y, sim.wasp.z);
      sim.step(buildCmd());
      waspCurr.set(sim.wasp.x, sim.wasp.y, sim.wasp.z);
      handleEvents(sim.drainEvents());
      acc -= DT; n++;
    }
    if (n === 8) acc = 0;
  }
  if (sim) {
    const alpha = running && !paused ? acc / DT : 1;
    const t = sim.tick + alpha;
    for (let i = anims.length - 1; i >= 0; i--) if (envelope(anims[i], t) < 0) anims.splice(i, 1);
    for (const v of humanViews.values()) poseHuman(v, t, dt);
    const p = renderWasp(alpha, t, dt);
    updateCamera(p, dt);
    renderSwats(t);
    updateHud();
    if (toastTimer > 0 && (toastTimer -= dt) <= 0) $('toast').style.opacity = 0;
    if (bumpTimer > 0 && (bumpTimer -= dt) <= 0) $('bump').style.opacity = 0;
    if (deadUntil && now > deadUntil && sim.wasp.state !== 'dead') { $('dead').hidden = true; deadUntil = 0; }
    if ((labTimer -= dt) <= 0) { labTimer = 0.1; if (labState.open) updateLab(); drawMap(); }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot

function newWorld(s) {
  for (const g of chunkViews.values()) scene.remove(g);
  for (const v of humanViews.values()) scene.remove(v.group);
  chunkViews.clear(); humanViews.clear(); anims.length = 0; labState.log.length = 0;
  seed = s;
  sim = new Sim(seed);
  sim.drainEvents();
  syncChunks();
  input.yaw = sim.wasp.yaw; input.pitch = 0;
  waspPrev.set(sim.wasp.x, sim.wasp.y, sim.wasp.z); waspCurr.copy(waspPrev);
  camPos.copy(waspCurr).add(new THREE.Vector3(-Math.sin(input.yaw) * 0.6, 0.2, -Math.cos(input.yaw) * 0.6));
  $('verifyOut').textContent = '';
}

function parseSeed() {
  const raw = $('seed').value.trim();
  try { return BigInt.asUintN(64, BigInt(raw || '0')); } catch { return BigInt(Array.from(raw).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)); }
}

$('bStart').addEventListener('click', () => {
  newWorld(parseSeed());
  $('startScreen').hidden = true;
  running = true;
  lock();
});
$('bNewLine').addEventListener('click', () => {
  $('extinctScreen').hidden = true;
  newWorld(seed);
  running = true;
  lock();
});
try { if (localStorage.getItem('sting.lab') === '1') toggleLab(); } catch { /* optional */ }
if (matchMedia('(pointer: coarse)').matches) $('startNote').textContent = 'Needs a keyboard and mouse. On touch devices you can look around but not fly.';

// show the world behind the start screen
newWorld(1234n);
requestAnimationFrame(frame);

// test hook for automated checks
window.__sting = { get sim() { return sim; }, input, start: () => $('bStart').click(), humanViews };
