// STING presentation layer (GDD 12). Reads sim state and events, never decides outcomes.
// Floats and Math.sin are fine here; nothing in this file feeds back into the sim except input commands.
import * as THREE from 'three';
import {
  Sim, Act, T, DT, ZONES, ZoneName, SwatKind, SwatKindName, StyleName, TopName, BottomName, Top, Bottom,
  toWorld, toLocal, dirToWorld, chunkKey, chunkOf, hash, Domain, rangeInt, resolveSting, zoneCover, segClosest, classify, predictedKind,
  NEST, NEST_ENTRANCE, flyPos, beePos, fmtClock, minuteOfDay, isLowerZone, broodTotal, sugarCap, proteinCap, waterCap, garmentGraph, dayWeather,
  NetLab, LINKS, birdPos, dragonPos, shedSites, shedRoof, groundAt, pickTarget, targetPos, targetLabel, assistPilot, TARGET_KIND, LOCK, snapshot, restore, replayFrom, worldTag, rulesHash, applyTuning, TUNE,
} from './sim/index.js';

// Tuning as data (GDD 13, T1-22): read tuning/sting.tune, served next to the page, before anything uses T. Without it
// the game runs the built-in values, and the pause screen and rules hash say so.
try {
  const r = await fetch(new URL('tuning/sting.tune', import.meta.url));
  if (r.ok) {
    const { unknown, missing } = applyTuning(T, await r.text());
    if (unknown.length || missing.length) console.warn(`tuning ${TUNE.hash}: ${unknown.length} unknown keys, ${missing.length} left built-in`, unknown, missing);
  }
} catch (e) { console.warn('tuning: running the built-in values', e.message); }

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ms = (ticks) => Math.round(ticks * 1000 / 60);
const zoneLabel = (z) => ZoneName[z].replace(/([a-z])([A-Z])/g, '$1 $2');
const V = (p) => new THREE.Vector3(p.x, p.y, p.z);

// ------------------------------------------------------------------ renderer and scene

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const SKY_FLASH = new THREE.Color('#e8ecff'), SKY_DAY = new THREE.Color('#a9cfe3'), SKY_DUSK = new THREE.Color('#e3a271'), SKY_NIGHT = new THREE.Color('#0e1626'), SKY_RAIN = new THREE.Color('#7d8792');
const sky = SKY_DAY.clone();
const scene = new THREE.Scene();
scene.background = sky;
scene.fog = new THREE.Fog(sky, 30, 115);

const camera = new THREE.PerspectiveCamera(70, 1, 0.002, 400);
const hemi = new THREE.HemisphereLight('#dceefa', '#4d5b2c', 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff3dc', 2.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 80 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.01;
scene.add(sun, sun.target);
const sunDir = new THREE.Vector3(0.45, 1, 0.3).normalize();

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
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
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
  return t;
}
const grassTex = canvasTex(256, 256, (g) => {
  g.fillStyle = '#5d8a37'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, l = 3 + Math.random() * 7;
    g.strokeStyle = `hsl(${85 + Math.random() * 25}, ${35 + Math.random() * 20}%, ${30 + Math.random() * 45}%)`;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 3, y - l); g.stroke();
  }
}, true);
const paperTex = canvasTex(64, 256, (g) => { for (let y = 0; y < 256; y += 4) { g.fillStyle = `hsl(36, ${10 + Math.random() * 14}%, ${48 + Math.random() * 22}%)`; g.fillRect(0, y, 64, 4); } });

const GROUND_TILE = 3;
grassTex.repeat.set(399 / GROUND_TILE, 399 / GROUND_TILE);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(399, 399, 133, 133), new THREE.MeshLambertMaterial({ map: grassTex }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ------------------------------------------------------------------ terrain (T2-6)
// The sim works in height above the ground. When the world has terrain, every vertex of everything drawn is lifted by
// the ground's height where it stands, read from a height map round the camera (4 m texels, linear between them), and
// the camera with it. Flat worlds never patch a material, so they draw exactly as before.
const TERR = { N: 128, step: 4, on: false, ox: 1e9, oz: 1e9, data: new Float32Array(128 * 128), frame: 0 };
const terrTex = new THREE.DataTexture(new Uint16Array(TERR.N * TERR.N), TERR.N, TERR.N, THREE.RedFormat, THREE.HalfFloatType);
terrTex.magFilter = terrTex.minFilter = THREE.LinearFilter; terrTex.needsUpdate = true;
const terrUniforms = { terrMap: { value: terrTex }, terrOrigin: { value: new THREE.Vector2() }, terrSize: { value: TERR.N * TERR.step } };
THREE.ShaderChunk.common += `
#ifdef TERRAIN
uniform sampler2D terrMap; uniform vec2 terrOrigin; uniform float terrSize;
#endif
`;
THREE.ShaderChunk.begin_vertex += `
#ifdef TERRAIN
{
  mat4 tm = modelMatrix;
#ifdef USE_INSTANCING
  tm = modelMatrix * instanceMatrix;
#endif
  vec4 tw = tm * vec4(transformed, 1.0);
  float th = texture2D(terrMap, (tw.xz - terrOrigin) / terrSize).r;
  transformed += inverse(mat3(tm)) * vec3(0.0, th, 0.0);
}
#endif
`;
function terrPatch(m) {
  if (!m || m.userData.terr) return;
  m.userData.terr = true;
  m.defines = { ...(m.defines || {}), TERRAIN: '' };
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => { Object.assign(sh.uniforms, terrUniforms); if (prev) prev.call(m, sh, r); };
  m.needsUpdate = true;
}
const terrDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
terrPatch(terrDepth);
function terrApply(root) {
  root.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) terrPatch(m);
    if (o.castShadow && !o.customDepthMaterial) o.customDepthMaterial = terrDepth;
  });
}
// the height map round a point, rebuilt when the point has moved a quarter of the way to its edge
function terrCenter(x, z) {
  const h = TERR.N * TERR.step / 2;
  if (Math.abs(x - TERR.ox - h) < h / 4 && Math.abs(z - TERR.oz - h) < h / 4) return;
  TERR.ox = Math.round((x - h) / 16) * 16; TERR.oz = Math.round((z - h) / 16) * 16;
  const d = TERR.data, out = terrTex.image.data;
  for (let j = 0; j < TERR.N; j++) for (let i = 0; i < TERR.N; i++) {
    const v = groundAt(sim.seed, TERR.ox + i * TERR.step, TERR.oz + j * TERR.step, sim.settings);
    d[j * TERR.N + i] = v; out[j * TERR.N + i] = THREE.DataUtils.toHalfFloat(v);
  }
  terrTex.needsUpdate = true;
  terrUniforms.terrOrigin.value.set(TERR.ox - TERR.step / 2, TERR.oz - TERR.step / 2);
}
// the ground's height as drawn there (the same texels, bilinear), for the camera and the sun
function terrAt(x, z) {
  if (!TERR.on) return 0;
  const N = TERR.N, fx = Math.min(N - 1.001, Math.max(0, (x - TERR.ox) / TERR.step)), fz = Math.min(N - 1.001, Math.max(0, (z - TERR.oz) / TERR.step));
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, d = TERR.data;
  const a = d[j * N + i], b = d[j * N + i + 1], c = d[(j + 1) * N + i], e = d[(j + 1) * N + i + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + e) * tx * tz;
}
function terrFrame(focus) {
  TERR.on = !!(sim && sim.settings.terrain);
  if (!TERR.on) { // a flat world after a hilly one: materials already patched read a flat map
    if (TERR.filled) { TERR.data.fill(0); terrTex.image.data.fill(0); terrTex.needsUpdate = true; TERR.filled = false; TERR.ox = 1e9; }
    return;
  }
  TERR.filled = true;
  terrCenter(focus.x, focus.z);
  if (TERR.frame++ % 30 === 0) terrApply(scene);
}

const SKIN = ['#f1c9a8', '#e2b08a', '#c98d66', '#a96e49', '#7f4c2f', '#5b3622'];
const HAIR = ['#2a1d14', '#4a2f1d', '#8a5a2b', '#c9a15c', '#1b1b1b', '#9a9a9a'];
const SHIRT = ['#d6503c', '#3f7cc4', '#efede6', '#2f8f6b', '#e2b23a', '#6b4fa3', '#232c38', '#e584a3'];
const JACKET = ['#4b513b', '#7a3b2e', '#2b3a55'];
const JEANS = ['#3c5a86', '#2c3e5c', '#4d6d99'];
const SHORTS = ['#c7b48d', '#5c6e4a', '#8a8f99', '#a3473a'];
const SKIRT = ['#7a2e3b', '#2f4858', '#c9a227'];
const CANS = ['#d42c2c', '#2b6fd6', '#f2f2f2', '#28a35a', '#e8eef0']; // 4: a beer glass (T2-5)
const FLOWERS = ['#f4f1ea', '#f6c700', '#e5412d', '#b06ad9', '#f08a24'];
function pick(seed, id, k, arr) { return arr[rangeInt(hash(seed, Domain.Cosmetic, id, BigInt(k)), 0, arr.length)]; }

// ------------------------------------------------------------------ state

let lab = null; // two-peer network lab when a second player is on
let sim = null, settings = { seed: 1234, dayMinutes: 2, humanDensity: 1, beeAggression: 1, seasonDays: 40 };
let running = false, paused = false;
const input = { pick: 0, keys: new Set(), lmb: false, yaw: 0, pitch: 0, alloc: 1, autopilot: null, free: { yaw: 0, pitch: 0, held: false },
  lock: null, pilot: null, autoTurn: false, turning: false, gazeOff: 0, gDown: 0, gLong: false }; // lock-on, assisted flight, eye turn (GDD 7.9)
// Player options from the Esc menu, kept per browser
const opts = { volume: 0.7, sens: 1, invert: false, reflex: true };
try { Object.assign(opts, JSON.parse(localStorage.getItem('sting.options') || '{}')); } catch { /* optional */ }
const saveOpts = () => { try { localStorage.setItem('sting.options', JSON.stringify(opts)); } catch { /* optional */ } };
const ySign = () => (opts.invert ? -1 : 1);
const chunkViews = new Map(), humanViews = new Map(), waspViews = new Map();
const pos = new Map(); // wasp id -> {p: prev, c: current}
const anims = [];
const ui = { lab: false, nest: false, zones: false, swats: true, log: [], speed: 1, reflexUntil: 0 };
// Solo time (GDD 5.1, 7.8, T1-23). Both only change how fast the wall clock feeds ticks to the sim, never the sim:
// replays and saves are unaffected. A shared world's clock never changes speed.
const SPEEDS = [1, 4, 16];
const solo = () => !lab && sim && !sim.net;
const timeScale = () => {
  if (!solo()) return 1;
  const reflex = opts.reflex && performance.now() < ui.reflexUntil ? 0.25 : 1;
  return (ui.nest ? ui.speed : 1) * reflex;
};
function setSpeed(s) { ui.speed = s; SPEEDS.forEach((v) => { const b = $('speed' + v); if (b) b.setAttribute('aria-pressed', v === s); }); }
function calmTime(why) { if (ui.speed !== 1) { setSpeed(1); toast(why + ' · back to normal time', 'var(--yellow)', 1.6); } }
function reflex() { if (solo() && opts.reflex) ui.reflexUntil = performance.now() + 900; }
let deathSpot = null, deadUntil = 0, toastTimer = 0, bumpTimer = 0;
const camPos = new THREE.Vector3();
let camDist = 0.1, eyeBlend = 0;

// ------------------------------------------------------------------ chunk visuals

const geoTrunk = new THREE.CylinderGeometry(0.8, 1, 1, 9);
const geoBlob = new THREE.IcosahedronGeometry(1, 1);
const geoBox = new THREE.BoxGeometry(1, 1, 1);
const geoCan = new THREE.CylinderGeometry(0.033, 0.033, 0.12, 18, 1, true); // hollow: open at the top (GDD 7.5)
const geoCanIn = new THREE.CylinderGeometry(0.030, 0.030, 0.12, 18, 1, true);
const geoDrink = new THREE.CircleGeometry(0.030, 18);
const DRINKS = ['#3a1b0c', '#6b3a12', '#d9c27a', '#9fc23a', '#e0a526'];
const geoStem = new THREE.CylinderGeometry(0.0035, 0.0035, 1, 4);
const geoHead = new THREE.IcosahedronGeometry(0.022, 1);
const geoBottle = new THREE.CylinderGeometry(0.035, 0.04, 0.2, 12);
const geoCandle = new THREE.CylinderGeometry(0.04, 0.04, 0.07, 14);
const geoBowl = new THREE.SphereGeometry(0.27, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2); // the lower half: a kettle open at the top
const geoGrillLeg = new THREE.CylinderGeometry(0.012, 0.012, 0.72, 6);
const geoGrate = new THREE.CircleGeometry(0.26, 16, 0, Math.PI * 2);
const geoPuff = new THREE.SphereGeometry(0.06, 8, 6);
const STRIPPED = new THREE.Color('#c9c5bb');
const geoFlame = new THREE.ConeGeometry(0.008, 0.025, 6);
const webMat = new THREE.LineBasicMaterial({ color: '#f4f4f4', transparent: true, opacity: 0.32 });

function buildChunk(rec) {
  const g = new THREE.Group();
  const c = rec.content;
  const dyn = { lids: [], traps: [], candles: [], cans: [], puddles: [], crowns: [], grills: [], wood: [], rain: [], rainDay: -2 };
  // birdbaths (T2-1): a stone basin on a pedestal, water to the brim
  for (const b of c.baths || []) {
    if (b.fountain) { // a town fountain (T2-5): a low stone basin, a jet in the middle
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(b.r + 0.15, b.r + 0.2, b.h - 0.02, 28), mat('#b8b0a2')); rim.position.set(b.x, (b.h - 0.02) / 2, b.z); rim.receiveShadow = true;
      const water = new THREE.Mesh(new THREE.CircleGeometry(b.r, 28), WATER_MAT); water.rotation.x = -Math.PI / 2; water.position.set(b.x, b.h + 0.002, b.z);
      const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.12, 1.2, 8), new THREE.MeshLambertMaterial({ color: '#d8ecf6', transparent: true, opacity: 0.6 })); jet.position.set(b.x, b.h + 0.6, b.z);
      g.add(rim, water, jet);
      continue;
    }
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, b.h - 0.08, 10), mat('#a9a49a')); ped.position.set(b.x, (b.h - 0.08) / 2, b.z);
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(b.r + 0.03, b.r * 0.55, 0.1, 18), mat('#bdb8ad')); basin.position.set(b.x, b.h - 0.055, b.z); // its rim just under the water line
    const water = new THREE.Mesh(new THREE.CircleGeometry(b.r, 20), WATER_MAT); water.rotation.x = -Math.PI / 2; water.position.set(b.x, b.h + 0.002, b.z);
    for (const m of [ped, basin]) { m.castShadow = m.receiveShadow = true; }
    g.add(ped, basin, water);
  }
  // garden sheds: plank walls, a pitched roof, a crack in one wall and a gap under one eave (nest sites)
  // land use (T1-12): the ground of a yard is a mown lawn, a forest floor is dark; streets, cul-de-sacs, parking lots
  if (c.use === 'yards' || c.use === 'forest' || c.use === 'mall') {
    const tint = new THREE.Mesh(new THREE.PlaneGeometry(64, 64, 16, 16), new THREE.MeshLambertMaterial({ color: c.use === 'yards' ? '#7fbf4a' : c.use === 'forest' ? '#3d4a22' : '#8f9a6a', transparent: true, opacity: c.use === 'yards' ? 0.28 : 0.45, depthWrite: false }));
    tint.rotation.x = -Math.PI / 2; tint.position.set(rec.cx * 64, 0.002, rec.cz * 64); tint.receiveShadow = true; g.add(tint);
  }
  const flat = (minx, maxx, minz, maxz, color, y) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(maxx - minx, maxz - minz, Math.max(1, Math.ceil((maxx - minx) / 4)), Math.max(1, Math.ceil((maxz - minz) / 4))), mat(color)); m.rotation.x = -Math.PI / 2; m.position.set((minx + maxx) / 2, y, (minz + maxz) / 2); m.receiveShadow = true; g.add(m); };
  for (const r of c.roads || []) {
    flat(r.minx, r.maxx, r.minz - 1.6, r.minz, '#b9b4a8', 0.004); flat(r.minx, r.maxx, r.maxz, r.maxz + 1.6, '#b9b4a8', 0.004); // sidewalks
    flat(r.minx, r.maxx, r.minz, r.maxz, '#45464a', 0.005);
  }
  for (const l of c.loops || []) { const m = new THREE.Mesh(new THREE.RingGeometry(0, l.r, 40, 4), mat('#45464a')); m.rotation.x = -Math.PI / 2; m.position.set(l.x, 0.006, l.z); m.receiveShadow = true; g.add(m); }
  for (const l of c.lots || []) {
    flat(l.minx, l.maxx, l.minz, l.maxz, '#4b4c50', 0.005);
    const along = l.maxx - l.minx > l.maxz - l.minz;
    for (let k = -12; k <= 12; k++) { const x = (l.minx + l.maxx) / 2 + (along ? k * 2.5 : 0), z = (l.minz + l.maxz) / 2 + (along ? 0 : k * 2.5); flat(x - (along ? 0.06 : 2.4), x + (along ? 0.06 : 2.4), z - (along ? 2.4 : 0.06), z + (along ? 2.4 : 0.06), '#d8d6cf', 0.006); }
  }
  // a town centre (T2-5): stone paving, shops with lit windows and awnings, a beer garden under string lights, a fountain
  for (const p of c.plazas || []) {
    flat(p.minx, p.maxx, p.minz, p.maxz, '#bdb4a4', 0.005);
    for (let k = -3; k <= 3; k++) { flat(p.minx, p.maxx, (p.minz + p.maxz) / 2 + k * 9 - 0.04, (p.minz + p.maxz) / 2 + k * 9 + 0.04, '#a99f8e', 0.006); flat((p.minx + p.maxx) / 2 + k * 9 - 0.04, (p.minx + p.maxx) / 2 + k * 9 + 0.04, p.minz, p.maxz, '#a99f8e', 0.006); }
  }
  const SHOP = ['#c98f6b', '#d8c7a4', '#9fb3a1', '#b8a1c4', '#e0d0b8', '#a8bccd'], AWN = ['#7a2f24', '#2f5f7a', '#3f7a2f', '#7a6a2f', '#5a2f7a', '#7a2f5a'];
  for (const sh of c.shops || []) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(sh.hw * 2, sh.h, sh.hd * 2), mat(SHOP[sh.color % SHOP.length])); b.position.set(sh.x, sh.h / 2, sh.z); b.castShadow = b.receiveShadow = true;
    // shop windows on every side: one pane across the x faces, one across the z faces
    const glass = new THREE.Mesh(new THREE.BoxGeometry(sh.hw * 2 - 1, 2.2, sh.hd * 2 + 0.06), mat('#2c3a44')); glass.position.set(sh.x, 1.4, sh.z);
    const glass2 = new THREE.Mesh(new THREE.BoxGeometry(sh.hw * 2 + 0.06, 2.2, sh.hd * 2 - 1), mat('#2c3a44')); glass2.position.set(sh.x, 1.4, sh.z);
    const awn = new THREE.Mesh(new THREE.BoxGeometry(sh.hw * 2 + 0.8, 0.12, sh.hd * 2 + 0.8), mat(AWN[sh.color % AWN.length])); awn.position.set(sh.x, 2.75, sh.z);
    for (let fl = 1; fl < Math.floor(sh.h / 3); fl++) { const wv = new THREE.Mesh(new THREE.BoxGeometry(sh.hw * 2 + 0.04, 1.0, sh.hd * 2 + 0.04), mat('#3a4652')); wv.scale.set(0.8, 1, 0.8); wv.position.set(sh.x, fl * 3 + 1.4, sh.z); g.add(wv); }
    g.add(b, glass, glass2, awn);
  }
  for (const gd of c.gardens || []) {
    const lights = new THREE.Group(), bulb = new THREE.SphereGeometry(0.05, 6, 4), on = new THREE.MeshBasicMaterial({ color: '#ffe7a8' });
    for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1], [-1, 0, 1, 0]]) {
      for (let k = 0; k <= 12; k++) { const f = k / 12, x = gd.x + (ax + (bx - ax) * f) * gd.hw, z = gd.z + (az + (bz - az) * f) * gd.hd; const m = new THREE.Mesh(bulb, on); m.position.set(x, 2.8 - 0.35 * Math.sin(Math.PI * f), z); lights.add(m); }
    }
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.9, 6), mat('#4a3a2c')); post.position.set(gd.x + sx * gd.hw, 1.45, gd.z + sz * gd.hd); lights.add(post); }
    g.add(lights);
  }
  for (const m of c.malls || []) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(m.hw * 2, m.h, m.hd * 2), mat('#cdbfa6')); b.position.set(m.x, m.h / 2, m.z); b.castShadow = b.receiveShadow = true;
    const band = new THREE.Mesh(new THREE.BoxGeometry(m.hw * 2 + 0.1, 1.2, m.hd * 2 + 0.1), mat('#7a2f24')); band.position.set(m.x, m.h - 0.6, m.z);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(m.hw * 2 - 1, 2.4, m.hd * 2 + 0.06), mat('#2c3a44')); glass.position.set(m.x, 1.5, m.z);
    if (m.hd > m.hw) glass.scale.set((m.hw * 2 + 0.06) / (m.hw * 2 - 1), 1, (m.hd * 2 - 1) / (m.hd * 2 + 0.06));
    g.add(b, band, glass);
  }
  for (const sh of c.sheds || []) {
    const siding = sh.house ? ['#e3dccb', '#c9d3d6', '#dcc9a8', '#c7cdb6', '#efe9dd'][Math.abs(Math.round(sh.x * 7 + sh.z * 3)) % 5] : '#7a5a3c';
    const walls = new THREE.Mesh(new THREE.BoxGeometry(sh.hw * 2, sh.h, sh.hd * 2), mat(siding));
    walls.position.set(sh.x, sh.h / 2, sh.z); walls.castShadow = walls.receiveShadow = true;
    const long = sh.hw >= sh.hd, span = long ? sh.hd : sh.hw, len = (long ? sh.hw : sh.hd) * 2 + 0.2, rise = sh.house ? 1.9 : 0.55;
    if (sh.house) {
      // windows on the long sides, a door on one, and the gable ends closed with a wedge
      const win = mat('#33404a'), along = long ? [1, 0] : [0, 1], across = long ? [0, 1] : [1, 0], half = long ? sh.hw : sh.hd, depth = long ? sh.hd : sh.hw;
      for (const s of [-1, 1]) for (let k = -1; k <= 1; k++) for (const y of [1.5, sh.h - 1.4]) {
        if (s === (long ? Math.sign(rec.cz * 64 - sh.z) || 1 : Math.sign(rec.cx * 64 - sh.x) || 1) && k === 0 && y < 2) continue; // the door goes there
        const wv = new THREE.Mesh(new THREE.BoxGeometry(along[0] ? 1.1 : 0.06, 1.0, along[1] ? 1.1 : 0.06), win);
        wv.position.set(sh.x + along[0] * k * half * 0.6 + across[0] * s * (depth + 0.02), y, sh.z + along[1] * k * half * 0.6 + across[1] * s * (depth + 0.02)); g.add(wv);
      }
      const door = new THREE.Mesh(new THREE.BoxGeometry(along[0] ? 1.0 : 0.06, 2.1, along[1] ? 1.0 : 0.06), mat('#6b3b2a'));
      const ds = long ? Math.sign(rec.cz * 64 - sh.z) || 1 : Math.sign(rec.cx * 64 - sh.x) || 1; // the door faces the street
      door.position.set(sh.x + across[0] * ds * (depth + 0.02), 1.05, sh.z + across[1] * ds * (depth + 0.02)); g.add(door);
      const gable = new THREE.Shape([new THREE.Vector2(-depth, 0), new THREE.Vector2(depth, 0), new THREE.Vector2(0, rise)]);
      for (const s of [-1, 1]) {
        const gm = new THREE.Mesh(new THREE.ShapeGeometry(gable), mat(siding, { side: THREE.DoubleSide }));
        gm.position.set(sh.x + along[0] * s * half, sh.h, sh.z + along[1] * s * half); gm.rotation.y = long ? Math.PI / 2 : 0; g.add(gm);
      }
    }
    // the slabs' top faces lie on the solid roof the sim collides with (world.js shedRoof)
    const rf = shedRoof(sh), slope = rf.L, ang = Math.atan2(rf.rise, rf.S), th = sh.house ? 0.12 : 0.05;
    const cy = sh.h + rf.rise / 2 - rf.S / rf.L * th / 2, cu = rf.S / 2 - rf.rise / rf.L * th / 2;
    for (const side of [-1, 1]) {
      const roof = new THREE.Mesh(new THREE.BoxGeometry(long ? rf.half * 2 : slope, th, long ? slope : rf.half * 2), mat(sh.house ? '#4e4b52' : '#3d3a36'));
      if (long) { roof.position.set(sh.x, cy, sh.z + side * cu); roof.rotation.x = side * ang; }
      else { roof.position.set(sh.x + side * cu, cy, sh.z); roof.rotation.z = -side * ang; }
      roof.castShadow = true; g.add(roof);
    }
    const ss = shedSites(sh);
    const crack = new THREE.Mesh(new THREE.BoxGeometry(ss.wall.nx ? 0.012 : 0.05, 0.12, ss.wall.nz ? 0.012 : 0.05), mat('#0d0a07'));
    crack.position.set(ss.wall.x - ss.wall.nx * 0.008, ss.wall.y, ss.wall.z - ss.wall.nz * 0.008);
    const eave = new THREE.Mesh(new THREE.BoxGeometry(ss.attic.nx ? 0.012 : 0.4, 0.03, ss.attic.nz ? 0.012 : 0.4), mat('#0d0a07'));
    eave.position.set(ss.attic.x - ss.attic.nx * 0.008, ss.attic.y, ss.attic.z - ss.attic.nz * 0.008);
    g.add(walls, crack, eave);
  }
  for (const t of c.trees) {
    const trunk = new THREE.Mesh(geoTrunk, mat('#5b4330'));
    trunk.scale.set(t.r, t.h, t.r); trunk.position.set(t.x, t.h / 2, t.z);
    trunk.castShadow = trunk.receiveShadow = true;
    const leaf = mat(new THREE.Color().setHSL(0.27 + t.shade * 0.06, 0.45, 0.26 + t.shade * 0.08).getStyle(), { flatShading: true });
    const a = new THREE.Mesh(geoBlob, leaf); a.scale.setScalar(t.cr); a.position.set(t.x, t.h + t.cr * 0.35, t.z);
    const b = new THREE.Mesh(geoBlob, leaf); b.scale.setScalar(t.cr * 0.7); b.position.set(t.x + t.cr * 0.45, t.h - t.cr * 0.1, t.z - t.cr * 0.3);
    a.castShadow = b.castShadow = true;
    for (const m of [a, b]) dyn.crowns.push({ m, x: m.position.x, z: m.position.z, ph: t.x * 0.7 + t.z * 0.3 });
    g.add(trunk, a, b);
  }
  const wood = mat('#8a6440');
  c.boxes.forEach((b, bi) => {
    if (b.hive || b.shed || b.mall) return; // drawn with their own shapes
    // fences in cedar; each wooden box keeps its own material so it can pale as wasps strip its pulp (T1-12)
    const m = new THREE.Mesh(geoBox, b.wood ? mat(b.fence ? '#b98a55' : '#8a6440') : wood);
    m.scale.set(b.maxx - b.minx, b.maxy - b.miny, b.maxz - b.minz);
    m.position.set((b.minx + b.maxx) / 2, (b.miny + b.maxy) / 2, (b.minz + b.maxz) / 2);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    if (b.wood) dyn.wood.push({ m, i: bi, base: new THREE.Color(b.fence ? '#b98a55' : '#8a6440'), shown: -1 });
  });
  c.tables.forEach((t, ti) => {
    const along = t.axisX ? [1, 0] : [0, 1], across = t.axisX ? [0, 1] : [1, 0];
    for (const s of [-0.8, 0.8]) for (const q of [-0.3, 0.3]) {
      const leg = new THREE.Mesh(geoBox, wood); leg.scale.set(0.05, 0.71, 0.05);
      leg.position.set(t.x + along[0] * s + across[0] * q, 0.355, t.z + along[1] * s + across[1] * q); leg.castShadow = true; g.add(leg);
    }
    for (const side of [-0.67, 0.67]) for (const s of [-0.75, 0.75]) {
      const leg = new THREE.Mesh(geoBox, wood); leg.scale.set(0.05, 0.4, 0.05);
      leg.position.set(t.x + along[0] * s + across[0] * side, 0.2, t.z + along[1] * s + across[1] * side); g.add(leg);
    }
    const candle = new THREE.Group();
    const cup = new THREE.Mesh(geoCandle, mat('#e8c547')); cup.position.y = 0.035;
    const flame = new THREE.Mesh(geoFlame, new THREE.MeshBasicMaterial({ color: '#ffb347' })); flame.position.y = 0.085;
    candle.add(cup, flame); candle.position.set(t.x, 0.75, t.z); candle.visible = false;
    g.add(candle); dyn.candles.push(candle);
  });
  // kettle grills at some tables (T1-10): a black bowl on three legs, a grate, coals and smoke when lit, a plate
  for (const gr of sim.grillsIn(rec)) {
    const B = T.bbq, grp = new THREE.Group(); grp.position.set(gr.x, 0, gr.z);
    const bowl = new THREE.Mesh(geoBowl, mat('#1c1c1e', { side: THREE.DoubleSide })); bowl.position.y = B.grateY; bowl.castShadow = true;
    for (let k = 0; k < 3; k++) {
      const a = k * 2.094, leg = new THREE.Mesh(geoGrillLeg, mat('#2a2a2c'));
      leg.position.set(Math.cos(a) * B.r * 0.7, (B.grateY - 0.12) / 2, Math.sin(a) * B.r * 0.7); leg.rotation.set(Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12); grp.add(leg);
    }
    const grate = new THREE.Mesh(geoGrate, new THREE.MeshLambertMaterial({ color: '#555', wireframe: true })); grate.rotation.x = -Math.PI / 2; grate.position.y = B.grateY;
    const coals = new THREE.Mesh(new THREE.CircleGeometry(B.r * 0.8, 20), new THREE.MeshBasicMaterial({ color: '#ff6a1a' })); coals.rotation.x = -Math.PI / 2; coals.position.y = B.grateY - 0.06; coals.visible = false;
    const smoke = [];
    for (let k = 0; k < 6; k++) { const p = new THREE.Mesh(geoPuff, new THREE.MeshBasicMaterial({ color: '#c8c8c8', transparent: true, opacity: 0, depthWrite: false })); p.visible = false; grp.add(p); smoke.push(p); }
    grp.add(bowl, grate, coals); g.add(grp);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.012, 20), mat('#f2efe8')); plate.position.set(gr.px, 0.757, gr.pz); plate.visible = false; g.add(plate);
    dyn.grills.push({ gr, coals, smoke, plate });
  }
  const cups = sim.cupsIn(rec);
  c.cans.forEach((can, ci) => {
    // a hollow cup: painted outside, plain inside, the drink at its level
    const m = new THREE.Group(); m.position.set(can.x, 0.81, can.z);
    const outer = new THREE.Mesh(geoCan, new THREE.MeshLambertMaterial({ color: CANS[can.color], side: THREE.FrontSide })); outer.castShadow = true;
    const inner = new THREE.Mesh(geoCanIn, new THREE.MeshLambertMaterial({ color: '#b9b4a8', side: THREE.BackSide }));
    const drink = new THREE.Mesh(geoDrink, new THREE.MeshLambertMaterial({ color: DRINKS[can.color] })); drink.rotation.x = -Math.PI / 2; drink.position.y = cups[ci].level - 0.81;
    m.add(outer, inner, drink); m.userData.drink = drink;
    g.add(m); dyn.cans.push(m);
    const pud = new THREE.Mesh(new THREE.CircleGeometry(0.075, 18), new THREE.MeshLambertMaterial({ color: '#b07a1e', transparent: true, opacity: 0.75 }));
    pud.rotation.x = -Math.PI / 2; pud.position.set(can.x + 0.06, 0.752, can.z); pud.visible = false; g.add(pud); dyn.puddles.push(pud);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.006, 14), new THREE.MeshLambertMaterial({ color: '#d9d4c7' })); lid.position.set(can.x, 0.874, can.z); lid.visible = false;
    g.add(lid); dyn.lids.push(lid);
  });
  for (const tr of c.traps) {
    const grp = new THREE.Group();
    const bottle = new THREE.Mesh(geoBottle, new THREE.MeshLambertMaterial({ color: '#b9d6c9', transparent: true, opacity: 0.7 }));
    const liquid = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.038, 0.08, 12), mat('#c98a2a')); liquid.position.y = -0.055;
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.15, 4), mat('#ddd')); string.position.y = 0.17;
    grp.add(bottle, liquid, string); grp.position.set(tr.x, tr.y, tr.z); grp.visible = false;
    g.add(grp); dyn.traps.push(grp);
  }
  if (c.flowers.length) {
    const stems = new THREE.InstancedMesh(geoStem, mat('#4f7a2a'), c.flowers.length);
    const heads = new THREE.InstancedMesh(geoHead, new THREE.MeshLambertMaterial(), c.flowers.length);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    c.flowers.forEach((f, i) => {
      m4.makeScale(1, f.y, 1).setPosition(f.x, f.y / 2, f.z); stems.setMatrixAt(i, m4);
      m4.makeTranslation(f.x, f.y, f.z); heads.setMatrixAt(i, m4); heads.setColorAt(i, col.set(FLOWERS[f.color]));
    });
    g.add(stems, heads);
    dyn.heads = heads; dyn.bloomKey = -1;
  }
  for (const hv of c.hives) {
    const white = mat('#ece8dc'), roof = mat('#8d8a80');
    const stand = new THREE.Mesh(geoBox, mat('#5b4330')); stand.scale.set(0.5, 0.4, 0.5); stand.position.set(hv.x, 0.2, hv.z);
    const s1 = new THREE.Mesh(geoBox, white); s1.scale.set(0.45, 0.25, 0.45); s1.position.set(hv.x, 0.53, hv.z);
    const s2 = new THREE.Mesh(geoBox, mat('#e2dccb')); s2.scale.set(0.45, 0.2, 0.45); s2.position.set(hv.x, 0.755, hv.z);
    const lid = new THREE.Mesh(geoBox, roof); lid.scale.set(0.5, 0.06, 0.5); lid.position.set(hv.x, 0.885, hv.z);
    const slot = new THREE.Mesh(geoBox, mat('#17120c')); slot.scale.set(hv.fx ? 0.01 : 0.16, 0.02, hv.fz ? 0.01 : 0.16);
    slot.position.set(hv.ex, hv.ey - 0.05, hv.ez);
    for (const m of [stand, s1, s2, lid]) { m.castShadow = m.receiveShadow = true; }
    g.add(stand, s1, s2, lid, slot);
  }
  dyn.webs = c.webs.map((wb) => {
    const pts = [];
    const ux = -wb.nz, uz = wb.nx; // in-plane horizontal axis
    const P = (r, a) => [wb.x + ux * r * Math.cos(a), wb.y + r * Math.sin(a), wb.z + uz * r * Math.cos(a)];
    for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; pts.push(...P(0, a), ...P(wb.r, a)); }
    for (let ring = 1; ring <= 6; ring++) {
      const r = wb.r * ring / 6.5;
      for (let k = 0; k < 10; k++) { const a0 = k / 10 * Math.PI * 2, a1 = (k + 1) / 10 * Math.PI * 2; pts.push(...P(r, a0), ...P(r, a1)); }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(geo, webMat);
    g.add(lines);
    return lines;
  });
  if (c.rival) {
    const rv = c.rival;
    const nest = new THREE.Mesh(new THREE.SphereGeometry(rv.r, 18, 14), new THREE.MeshLambertMaterial({ map: paperTex, color: '#9a958a' }));
    nest.scale.set(1, 1.3, 1); nest.position.set(rv.x, rv.y, rv.z); nest.castShadow = true;
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.025, 14), mat('#120d08', { side: THREE.DoubleSide }));
    hole.rotation.x = Math.PI / 2; hole.position.set(rv.ex, rv.ey + 0.005, rv.ez);
    g.add(nest, hole);
  }
  g.userData.dyn = dyn;
  return g;
}

function syncChunks() {
  const want = new Set(sim.activeChunks.map((r) => chunkKey(r.cx, r.cz)));
  for (const [k, g] of chunkViews) if (!want.has(k)) { scene.remove(g); chunkViews.delete(k); }
  for (const r of sim.activeChunks) {
    const k = chunkKey(r.cx, r.cz);
    if (!chunkViews.has(k)) { const g = buildChunk(r); g.userData.key = k; chunkViews.set(k, g); scene.add(g); }
  }
  const want2 = new Set(sim.active.map((h) => h.hex));
  for (const [k, v] of humanViews) if (!want2.has(k)) { scene.remove(v.group); humanViews.delete(k); }
  for (const hm of sim.active) if (!humanViews.has(hm.hex)) humanViews.set(hm.hex, buildHuman(hm));
}

// Crowns lean and sway with the wind (presentation only; the sim's wind pushes wasps, GDD 5.3)
function swayTrees(time) {
  const w = sim.wind;
  for (const g of chunkViews.values()) for (const c of g.userData.dyn.crowns) {
    const s = 0.035 * (1 + 0.45 * Math.sin(time * 1.7 + c.ph));
    c.m.position.x = c.x + w.x * s; c.m.position.z = c.z + w.z * s;
  }
}

function updateChunkDynamics() {
  for (const [k, g] of chunkViews) {
    const lv = sim.escLevel(k), d = g.userData.dyn, torn = (sim.chunkState.get(k) || {}).webTorn || {};
    d.webs.forEach((l, i) => { l.visible = torn[i] !== sim.day; });
    d.lids.forEach((l, i) => { l.visible = sim.cupCovered(k, i) && !sim.canSpilled(k, i); l.material.color.set(lv >= 2 ? '#d9d4c7' : '#c99a7a'); }); // a lid, or a hand over it
    d.cans.forEach((m, i) => {
      const down = sim.canSpilled(k, i);
      m.rotation.z = down ? Math.PI / 2 : 0; m.position.y = down ? 0.785 : 0.81;
      m.userData.drink.visible = !down;
      d.puddles[i].visible = down;
    });
    for (const c of d.candles) c.visible = lv >= 2;
    // puddles after rain (T2-1): laid down when the ground gets wet, taken up when it dries
    const pd = sim.puddleDay();
    if (pd !== d.rainDay) {
      d.rainDay = pd;
      for (const m of d.rain) g.remove(m);
      d.rain = [];
      const rec4 = sim.records.get(k);
      if (pd >= 0 && rec4) for (const p of sim.puddlesIn(rec4, pd)) {
        const m = new THREE.Mesh(new THREE.CircleGeometry(p.r, 18), WATER_MAT); m.rotation.x = -Math.PI / 2; m.position.set(p.x, 0.008, p.z);
        g.add(m); d.rain.push(m);
      }
    }
    // flowers by season (T1-8): a green bud before, the colour in bloom, a brown head after
    const rec = d.heads && sim.records.get(k), bk = Math.floor(sim.seasonFrac * 200) + sim.season.n * 1000;
    if (rec && d.bloomKey !== bk) {
      d.bloomKey = bk;
      const col = new THREE.Color(), m4 = new THREE.Matrix4();
      rec.content.flowers.forEach((f, i) => {
        const on = sim.inBloom(rec, i), w = T.eco.bloom[f.color % T.eco.bloom.length], before = sim.seasonFrac < (w[0] + w[1]) / 2;
        const sc = on ? 1 : before ? 0.45 : 0.6;
        m4.makeScale(sc, sc, sc).setPosition(f.x, f.y, f.z); d.heads.setMatrixAt(i, m4);
        d.heads.setColorAt(i, col.set(on ? FLOWERS[f.color] : before ? '#6f9a3c' : '#7a5c3a'));
      });
      d.heads.instanceMatrix.needsUpdate = true; if (d.heads.instanceColor) d.heads.instanceColor.needsUpdate = true;
    }
    for (const t of d.traps) t.visible = lv >= 3;
    // wood stripped of pulp goes grey (T1-12)
    if (d.wood.length) {
      const taken = (sim.chunkState.get(k) || {}).pulp || {}, rec3 = sim.records.get(k);
      for (const wv of d.wood) {
        const n = taken[wv.i] || 0;
        if (n === wv.shown || !rec3) continue;
        wv.shown = n;
        const f = Math.min(1, n / sim.pulpLoads(rec3.content.boxes[wv.i]));
        if (!wv.own) { wv.m.material = wv.m.material.clone(); wv.own = true; } // materials are shared until one is stripped
        wv.m.material.color.copy(wv.base).lerp(STRIPPED, f * 0.85);
      }
    }
    // barbecues (T1-10): coals and smoke while lit, the plate while meat is served
    if (d.grills.length) {
      const rec2 = sim.records.get(k), meat = rec2 ? sim.meatIn(rec2) : [], now = performance.now() / 1000;
      for (const gv of d.grills) {
        const lit = rec2 && sim.bbqLit(rec2, gv.gr);
        gv.coals.visible = lit;
        if (lit) gv.coals.material.color.setHSL(0.05, 1, 0.5 + 0.08 * Math.sin(now * 7 + gv.gr.ti));
        gv.smoke.forEach((p, i) => {
          p.visible = lit;
          if (!lit) return;
          const f = (now * 0.35 + i / gv.smoke.length) % 1, w = sim.wind;
          p.position.set(w.x * f * 0.6 + 0.05 * Math.sin(now + i), T.bbq.grateY + 0.05 + f * 1.4, w.z * f * 0.6 + 0.05 * Math.cos(now * 1.3 + i));
          p.scale.setScalar(0.6 + f * 2.2); p.material.opacity = 0.35 * (1 - f);
        });
        gv.plate.visible = meat.some((m) => m.i === gv.gr.ti * 2 + 1);
      }
    }

  }
}

// ------------------------------------------------------------------ nests (the colony's current one, and abandoned ones)

function buildNestMesh(n, abandoned) {
  const g = new THREE.Group();
  if (n.site === 'wall' || n.site === 'attic' || n.site === 'hollow') {
    // the nest is inside the shed; outside you see papery comb pushing out of the gap
    const dx = n.x - n.treeX, dz = n.z - n.treeZ, d = Math.hypot(dx, dz) || 1;
    const rim = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshLambertMaterial({ map: paperTex, color: abandoned ? '#857a68' : '#ffffff' }));
    rim.scale.set(dx ? 0.35 : 1, 0.8, dz ? 0.35 : 1); rim.position.set(n.x + dx / d * 0.005, n.y, n.z + dz / d * 0.005);
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.02, 12), mat('#0c0905', { side: THREE.DoubleSide }));
    hole.position.set(n.x + dx / d * 0.03, n.y, n.z + dz / d * 0.03); hole.lookAt(n.x + dx / d, n.y, n.z + dz / d);
    g.add(rim, hole);
    g.userData.ball = rim;
    scene.add(g);
    return g;
  }
  if (n.site === 'ground') {
    // an old burrow: a low ring of dug-out soil around a dark hole
    const mound = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.03, 8, 20), mat(abandoned ? '#5a4a3a' : '#6d5139'));
    mound.rotation.x = Math.PI / 2; mound.position.set(n.entrance.x, 0.012, n.entrance.z); mound.scale.z = 0.5; mound.receiveShadow = true;
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.045, 16), mat('#0c0905'));
    hole.rotation.x = -Math.PI / 2; hole.position.set(n.entrance.x, 0.006, n.entrance.z);
    g.add(mound, hole);
    g.userData.ball = hole;
    scene.add(g);
    return g;
  }
  const ball = new THREE.Mesh(new THREE.SphereGeometry(n.r, 20, 16), new THREE.MeshLambertMaterial({ map: paperTex, color: abandoned ? '#857a68' : '#ffffff' }));
  ball.scale.set(1, 1.25, 1); ball.position.set(n.x, n.y, n.z); ball.castShadow = true;
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.03, 16), mat('#120d08', { side: THREE.DoubleSide }));
  hole.rotation.x = Math.PI / 2; hole.position.set(n.entrance.x, n.entrance.y + 0.002, n.entrance.z);
  const dx = n.x - n.treeX, dz = n.z - n.treeZ, len = Math.hypot(dx, dz);
  const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, len, 6), mat('#5b4330'));
  branch.position.set((n.x + n.treeX) / 2, n.y + n.r * (n.site === 'branch' ? 1.6 : 1.1), (n.z + n.treeZ) / 2);
  branch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, 0, dz).normalize());
  g.add(ball, hole, branch);
  if (n.site === 'branch') {
    // hanging from a stalk under the branch
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, n.r * 0.5, 5), mat('#5b4330'));
    stalk.position.set(n.x, n.y + n.r * 1.4, n.z);
    g.add(stalk);
  }
  g.userData.ball = ball;
  scene.add(g);
  return g;
}
let nestView = null, nestSig = '';
const oldNestViews = [];
const lineViews = new Map(); // the line's sister colonies (T2-4)
function syncNests() {
  const n = sim.nest, sig = `${n.x},${n.y},${n.z},${sim.colony.sited}`;
  if (sig !== nestSig) {
    if (nestView) scene.remove(nestView);
    nestView = sim.colony.sited !== false ? buildNestMesh(n, false) : null;
    nestSig = sig;
  }
  if (nestView && sim.nest.site !== 'ground') nestView.userData.ball.material.color.set(sim.colony.nestAlive ? '#ffffff' : '#6b5d4a');
  while (oldNestViews.length < sim.oldNests.length) {
    const o = sim.oldNests[oldNestViews.length];
    const same = o.x === n.x && o.y === n.y && o.z === n.z && sim.colony.sited !== false;
    oldNestViews.push(same ? null : buildNestMesh(o, true));
  }
  // sister colonies: a nest each while they live (one taken over is now yours, drawn above)
  const ids = new Set(sim.line.map((x) => x.id));
  for (const [id, v] of lineViews) if (!ids.has(id)) { scene.remove(v); lineViews.delete(id); }
  for (const sc of sim.line) if (!lineViews.has(sc.id)) lineViews.set(sc.id, buildNestMesh(sc.nest, false));
}

// ------------------------------------------------------------------ prey and bees (instanced, positions each frame)

const MAXI = 600;
const flyMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0035, 6, 5), mat('#1b1a17'), MAXI);
const catMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.0035, 0.018, 3, 6), mat('#6fa83a'), MAXI);
const beeMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0045, 8, 6), mat('#a7742a'), MAXI);
for (const m of [flyMesh, catMesh, beeMesh]) { m.count = 0; m.frustumCulled = false; scene.add(m); }
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();

// Pest-control bait stations: a dark box on the trunk with the bait showing through its slot
const baitPool = [];
const baitBoxGeo = new THREE.BoxGeometry(0.07, 0.1, 0.05), baitMeatGeo = new THREE.BoxGeometry(0.04, 0.012, 0.01);
// Windfall fruit in the grass late in the season (apples and plums)
const carrionMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.022, 0.06, 4, 8).rotateZ(Math.PI / 2), mat('#4a3a30'), 64);
carrionMesh.count = 0; carrionMesh.frustumCulled = false; scene.add(carrionMesh);
const meatMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.011, 0.07, 4, 8).rotateZ(Math.PI / 2), mat('#7a3018'), 64);
meatMesh.count = 0; meatMesh.frustumCulled = false; scene.add(meatMesh);
const honeyMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.03, 8, 6).scale(1, 1.3, 0.5), mat('#c98a1b'), 64);
honeyMesh.count = 0; honeyMesh.frustumCulled = false; scene.add(honeyMesh);
const fruitMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.032, 10, 8), new THREE.MeshLambertMaterial({ color: '#ffffff' }), 400);
fruitMesh.count = 0; fruitMesh.frustumCulled = false; fruitMesh.castShadow = true; scene.add(fruitMesh);
const FRUIT_COLORS = ['#b8322a', '#c9a227', '#6e2a4a', '#9a3a1e'].map((c) => new THREE.Color(c));
function renderFruit() {
  let n = 0;
  for (const rec of sim.activeChunks) for (const f of sim.fruitIn(rec)) {
    if (n >= 400) break;
    _p.set(f.x, f.y, f.z); _s.set(1, 0.9, 1);
    _m4.compose(_p, _q, _s); fruitMesh.setMatrixAt(n, _m4);
    fruitMesh.setColorAt(n, FRUIT_COLORS[f.i % FRUIT_COLORS.length]);
    n++;
  }
  _s.set(1, 1, 1);
  fruitMesh.count = n;
  fruitMesh.instanceMatrix.needsUpdate = true;
  if (fruitMesh.instanceColor) fruitMesh.instanceColor.needsUpdate = true;
}

// Burrows are always there; branch points show only while a queen is choosing a site
const holePool = [], knobPool = [], hollowPool = [];
const hollowGeo = new THREE.CircleGeometry(0.045, 14);
const holeGeo = new THREE.CircleGeometry(0.035, 12), knobGeo = new THREE.SphereGeometry(0.035, 8, 6);
function renderSites() {
  const holes = [], knobs = [], hollows = [];
  const choosing = sim.colony.sited === false && sim.wasp && sim.wasp.caste === 'queen';
  for (const rec of sim.activeChunks) {
    const st = sim.sitesIn(rec);
    holes.push(...st.holes);
    hollows.push(...st.hollows);
    if (choosing) knobs.push(...st.branches);
  }
  while (holePool.length < holes.length) { const m = new THREE.Mesh(holeGeo, mat('#15100a')); m.rotation.x = -Math.PI / 2; scene.add(m); holePool.push(m); }
  while (knobPool.length < knobs.length) { const m = new THREE.Mesh(knobGeo, mat('#7a5a3c')); scene.add(m); knobPool.push(m); }
  holePool.forEach((m, i) => { const h = holes[i]; m.visible = !!h && !(sim.nest.site === 'ground' && Math.hypot(h.x - sim.nest.x, h.z - sim.nest.z) < 0.01); if (h) m.position.set(h.x, 0.004, h.z); });
  // hollow trees (T1-14): a dark knot-hole on the trunk, always there
  while (hollowPool.length < hollows.length) { const m = new THREE.Mesh(hollowGeo, mat('#120d08', { side: THREE.DoubleSide })); m.scale.set(0.7, 1.3, 1); scene.add(m); hollowPool.push(m); }
  hollowPool.forEach((m, i) => {
    const h = hollows[i]; m.visible = !!h && !(sim.nest.site === 'hollow' && Math.hypot(h.x - sim.nest.x, h.z - sim.nest.z) < 0.01);
    if (h) { m.position.set(h.x, h.y, h.z); m.lookAt(h.x + (h.x - h.t.x), h.y, h.z + (h.z - h.t.z)); }
  });
  knobPool.forEach((m, i) => { const k = knobs[i]; m.visible = !!k; if (k) m.position.set(k.x, k.y + 0.06, k.z); });
}

function renderBaits() {
  const baits = sim.muniBaits ? sim.muniBaits() : [];
  while (baitPool.length < baits.length) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(baitBoxGeo, mat('#24402c')); box.castShadow = true;
    const meat = new THREE.Mesh(baitMeatGeo, mat('#8a3b2a')); meat.position.set(0, 0.012, 0.026);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.008, 0.055), mat('#d8c64a')); lid.position.y = 0.054;
    g.add(box, meat, lid); scene.add(g); baitPool.push(g);
  }
  baitPool.forEach((g, i) => {
    const b = baits[i];
    g.visible = !!b;
    if (!b) return;
    g.position.set(b.x, b.y, b.z);
    // face away from the trunk the station hangs on
    let best = null, bd = Infinity;
    const rec = sim.records.get(b.key);
    if (rec) for (const tr of rec.content.trees) { const d = (tr.x - b.x) ** 2 + (tr.z - b.z) ** 2; if (d < bd) { bd = d; best = tr; } }
    if (best) g.rotation.y = Math.atan2(b.x - best.x, b.z - best.z);
  });
}

function renderCritters(t) {
  let nf = 0, nc = 0, nb = 0, nh = 0;
  for (const rec of sim.activeChunks) {
    const c = rec.content, key = chunkKey(rec.cx, rec.cz), st = sim.cs(key);
    c.flies.forEach((f, i) => {
      if ((st.caughtFly[i] || 0) > sim.tick || nf >= MAXI || !sim.flyActive(rec, i)) return;
      const p = flyPos(f, t);
      flyMesh.setMatrixAt(nf++, _m4.makeTranslation(p.x, p.y, p.z));
    });
    c.caterpillars.forEach((cp, i) => {
      if (st.caughtCat[i] || nc >= MAXI || !sim.catActive(rec, i)) return;
      _q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.2);
      catMesh.setMatrixAt(nc++, _m4.compose(_p.set(cp.x, cp.y, cp.z), _q, _s));
    });
    sim.hivesIn(rec).forEach((hv, h) => {
      const lost = st.beeLost[h] || {}, al = sim.hiveAlarms.get(key + '#' + h);
      if (hv.feral && nh < 64) honeyMesh.setMatrixAt(nh++, _m4.compose(_p.set(hv.ex, hv.ey, hv.ez), _q.identity(), _s)); // a smear of comb at a wild entrance (T1-9)
      for (let k = 0; k < hv.bees.length && nb < MAXI; k++) {
        if (lost[k]) continue;
        const ph = al && al.phys[k];
        const p = ph || beePos(hv, k, t);
        _s.set(1, 0.9, 1.4);
        beeMesh.setMatrixAt(nb++, _m4.compose(_p.set(p.x, p.y, p.z), _q.identity(), _s));
        _s.set(1, 1, 1);
      }
    });
  }
  // carrion (T1-8): a small dark carcass on the grass
  let nk = 0;
  for (const rec of sim.activeChunks) for (const cr of sim.carrionIn(rec)) {
    if (nk >= 64) break;
    _q.setFromAxisAngle(UP, cr.d * 1.7);
    carrionMesh.setMatrixAt(nk++, _m4.compose(_p.set(cr.x, 0.02, cr.z), _q, _s));
  }
  carrionMesh.count = nk; carrionMesh.instanceMatrix.needsUpdate = true;
  // barbecue meat (T1-10): sausages on the grate and on the plate, one for each load left (up to four)
  let nm = 0;
  for (const rec of sim.activeChunks) for (const mt of sim.meatIn(rec)) {
    for (let k = 0; k < Math.min(4, mt.left) && nm < 64; k++) {
      _q.setFromAxisAngle(UP, mt.hot ? 0.3 : 1.2);
      meatMesh.setMatrixAt(nm++, _m4.compose(_p.set(mt.x + (k - 1.5) * 0.045, mt.y - 0.012, mt.z + (k % 2) * 0.02), _q, _s));
    }
  }
  meatMesh.count = nm; meatMesh.instanceMatrix.needsUpdate = true;
  honeyMesh.count = nh; honeyMesh.instanceMatrix.needsUpdate = true;
  flyMesh.count = nf; catMesh.count = nc; beeMesh.count = nb;
  flyMesh.instanceMatrix.needsUpdate = catMesh.instanceMatrix.needsUpdate = beeMesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------ birds and spiders

function buildDragonfly() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.002, 0.07, 6), mat('#1f5f6b')); body.rotation.x = Math.PI / 2; body.position.z = -0.02;
  const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), mat('#2b7f8a')); thorax.position.z = 0.016;
  const eyes = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 8, 6), mat('#4a9fb0')); eyes.scale.set(1.5, 1, 1); eyes.position.z = 0.025;
  const wmat = new THREE.MeshBasicMaterial({ color: '#dfeff2', transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false });
  const wgeo = new THREE.PlaneGeometry(0.045, 0.01); wgeo.rotateX(-Math.PI / 2); wgeo.translate(0.0225, 0, 0);
  const mk = (z, sx) => { const m = new THREE.Mesh(wgeo, wmat); m.position.set(0, 0.003, z); m.scale.x = sx; return m; };
  const w1 = mk(0.018, 1), w2 = mk(0.018, -1), w3 = mk(0.008, 1), w4 = mk(0.008, -1);
  g.add(body, thorax, eyes, w1, w2, w3, w4);
  g.userData = { w1, w2, w3, w4 };
  scene.add(g);
  return g;
}

function buildBird() {
  const g = new THREE.Group();
  const brown = mat('#3b2f26'), dark = mat('#1e1813');
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), brown); body.scale.set(0.8, 0.7, 1.6);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), dark); head.position.z = 0.08; head.position.y = 0.015;
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.03, 6), mat('#d8a43a')); beak.rotation.x = Math.PI / 2; beak.position.set(0, 0.012, 0.115);
  const wingGeo = new THREE.BoxGeometry(0.16, 0.006, 0.07); wingGeo.translate(0.08, 0, 0);
  const wl = new THREE.Mesh(wingGeo, brown), wr = new THREE.Mesh(wingGeo, brown); wr.scale.x = -1;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.005, 0.06), dark); tail.position.z = -0.09;
  g.add(body, head, beak, wl, wr, tail);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData = { wl, wr, prev: new THREE.Vector3() };
  scene.add(g);
  return g;
}
const birdViews = new Map();
const spiderPool = [];
function renderBirdsAndSpiders(t, dt) {
  const seen = new Set();
  for (const rec of sim.activeChunks) {
    const key = chunkKey(rec.cx, rec.cz);
    rec.content.birds.forEach((bd, i) => {
      const k = key + '#' + i;
      seen.add(k);
      let g = birdViews.get(k);
      if (!g) { g = buildBird(); birdViews.set(k, g); }
      const st = sim.birdState.get(k);
      const p = st ? new THREE.Vector3(st.x, st.y, st.z) : V(birdPos(bd, t));
      const v = st ? new THREE.Vector3(st.vx, st.vy, st.vz) : V(birdPos(bd, t + 1)).sub(p);
      g.position.lerp(p, g.userData.init ? 1 - Math.exp(-dt * 20) : 1); g.userData.init = true;
      if (v.lengthSq() > 1e-8) { g.rotation.order = 'YXZ'; g.rotation.y = Math.atan2(v.x, v.z); g.rotation.x = -Math.atan2(v.y, Math.hypot(v.x, v.z)); }
      const diving = st && st.mode === 'dive';
      const flap = diving ? 0.15 : Math.sin(t * 0.35 + i) * 0.7;
      g.userData.wl.rotation.z = flap; g.userData.wr.rotation.z = -flap;
    });
  }
  for (const [k, g] of birdViews) if (!seen.has(k)) { scene.remove(g); birdViews.delete(k); }
  // dragonflies: long thin body, two pairs of glassy wings
  const dstate = sim.dragonState || new Map();
  for (const rec of sim.activeChunks) {
    const key = chunkKey(rec.cx, rec.cz);
    (rec.content.dragonflies || []).forEach((df, i) => {
      const k = 'D' + key + '#' + i;
      seen.add(k);
      let g = birdViews.get(k);
      if (!g) { g = buildDragonfly(); birdViews.set(k, g); }
      const st = dstate.get(key + '#' + i);
      const p = st ? new THREE.Vector3(st.x, st.y, st.z) : V(dragonPos(df, t));
      const v = st ? new THREE.Vector3(st.vx, st.vy, st.vz) : V(dragonPos(df, t + 1)).sub(p);
      g.position.lerp(p, g.userData.init ? 1 - Math.exp(-dt * 25) : 1); g.userData.init = true;
      if (v.lengthSq() > 1e-8) { g.rotation.order = 'YXZ'; g.rotation.y = Math.atan2(v.x, v.z); g.rotation.x = -Math.atan2(v.y, Math.hypot(v.x, v.z)) * 0.5; }
      const flap = Math.sin(performance.now() * 0.6 + i * 7) * 0.5;
      g.userData.w1.rotation.z = flap; g.userData.w2.rotation.z = -flap; g.userData.w3.rotation.z = -flap * 0.8; g.userData.w4.rotation.z = flap * 0.8;
    });
  }
  for (const [k, g] of birdViews) if (k[0] === 'D' && !seen.has(k)) { scene.remove(g); birdViews.delete(k); }
  // a spider walks out to every stuck wasp
  let n = 0;
  for (const w of sim.wasps) {
    if (w.state !== 'webbed' || !w.web) continue;
    const rec = sim.records.get(w.web.key), wb = rec && rec.content.webs[w.web.i];
    if (!wb) continue;
    while (spiderPool.length <= n) {
      const sp = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), mat('#1a1410'));
      const abd = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), mat('#2b2018')); abd.position.y = 0.011;
      sp.add(body, abd);
      for (let l = 0; l < 8; l++) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.0007, 0.0007, 0.02, 3), mat('#1a1410')); leg.rotation.z = (l < 4 ? 1 : -1) * (0.9 + (l % 4) * 0.2); leg.position.x = (l < 4 ? 1 : -1) * 0.008; leg.position.y = -0.002 + (l % 4) * 0.003; sp.add(leg); }
      scene.add(sp); spiderPool.push(sp);
    }
    const sp = spiderPool[n++];
    const u = Math.min(1, Math.max(0, (t - w.web.start) / Math.max(1, w.web.spiderAt - w.web.start)));
    sp.visible = true;
    sp.position.set(wb.x + (w.x - wb.x) * u, wb.y + (w.y - wb.y) * u, wb.z + (w.z - wb.z) * u);
    sp.rotation.y = Math.atan2(wb.nx, wb.nz);
  }
  for (; n < spiderPool.length; n++) spiderPool[n].visible = false;
}

// ------------------------------------------------------------------ humans

const UP = new THREE.Vector3(0, 1, 0);

function partMaterial(view, hm, name) {
  const cl = hm.clothing, { top, bottom, skin } = view.colors;
  const suit = cl.top === Top.Suit;
  if (suit) return name === 'Head' ? skin : top;
  const topOn = !cl.topOff;
  if (name === 'Torso' || name === 'Shoulders') return topOn ? top : skin;
  if (name.startsWith('UpperArm')) return topOn && cl.top !== Top.Tank ? top : skin;
  if (name.startsWith('Forearm')) return topOn && cl.top === Top.Jacket ? top : skin;
  if (name === 'Pelvis' || name.startsWith('Thigh')) return bottom;
  if (name.startsWith('Shin')) return cl.bottom === Bottom.Jeans ? bottom : skin;
  return skin;
}

function humanColors(hm) {
  const id = hm.id, cl = hm.clothing;
  if (cl.top === Top.Suit) return { skin: mat('#c98d66'), hair: mat('#ece8dc'), top: mat('#ece8dc'), bottom: mat('#ece8dc') };
  return {
    skin: mat(pick(sim.seed, id, 0, SKIN)), hair: mat(pick(sim.seed, id, 1, HAIR)),
    top: mat(cl.top === Top.Jacket ? pick(sim.seed, id, 2 + hm.clothesDay * 7, JACKET) : pick(sim.seed, id, 2 + hm.clothesDay * 7, SHIRT)),
    bottom: mat(cl.bottom === Bottom.Jeans ? pick(sim.seed, id, 3 + hm.clothesDay * 7, JEANS) : cl.bottom === Bottom.Shorts ? pick(sim.seed, id, 3 + hm.clothesDay * 7, SHORTS) : pick(sim.seed, id, 3 + hm.clothesDay * 7, SKIRT)),
  };
}

function buildHuman(hm) {
  const group = new THREE.Group();
  const view = { hm, group, meshes: {}, posture: null, sig: '', x: hm.x, z: hm.z, ang: Math.atan2(hm.fx, hm.fz), flinch: 0, lean: new THREE.Vector3(), walk: 0, zonesOn: false };
  scene.add(group);
  rebuildHuman(view);
  return view;
}

function rebuildHuman(view) {
  const { hm, group } = view;
  for (const m of Object.values(view.meshes)) group.remove(m);
  view.meshes = {};
  view.colors = humanColors(hm);
  view.sig = JSON.stringify(hm.clothing) + hm.posture;
  view.rest = hm.parts[hm.posture];
  for (const p of view.rest) {
    const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y, p.b.z - p.a.z);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(p.r, len, 5, 10), partMaterial(view, hm, p.name));
    m.castShadow = true;
    group.add(m);
    view.meshes[p.name] = m;
  }
  const head = view.rest[0];
  const hair = new THREE.Mesh(new THREE.SphereGeometry(head.r * 1.04, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), view.colors.hair);
  hair.rotation.x = -0.35;
  const eyeGeo = new THREE.SphereGeometry(head.r * 0.11, 6, 5);
  view.meshes.Hair = hair;
  view.meshes.EyeL = new THREE.Mesh(eyeGeo, mat('#15110d'));
  view.meshes.EyeR = new THREE.Mesh(eyeGeo, mat('#15110d'));
  group.add(hair, view.meshes.EyeL, view.meshes.EyeR);
  if (hm.clothing.top === Top.Suit) {
    const veil = new THREE.Mesh(new THREE.SphereGeometry(head.r * 1.35, 14, 10), new THREE.MeshLambertMaterial({ color: '#1a1a1a', transparent: true, opacity: 0.55 }));
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(head.r * 2.2, head.r * 2.2, 0.01, 18), mat('#ece8dc'));
    view.meshes.Veil = veil; view.meshes.Brim = brim;
    group.add(veil, brim);
  }
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.19, 12), mat('#2f8f3a')); // a spray can (T1-6), green so it doesn't read as a cup
  view.meshes.Can = can; group.add(can);
  if (hm.posture === 'lie') { // a towel under a sunbather (T1-11), flat on the grass in the lying frame
    const towels = ['#d9534f', '#3a7bd5', '#f0c419', '#ffffff', '#2bb3a3'];
    const towel = new THREE.Mesh(new THREE.BoxGeometry(0.8, hm.tr.height + 0.25, 0.012), mat(towels[parseInt(hm.hex.slice(0, 2), 16) % towels.length]));
    towel.position.set(0, hm.tr.height * 0.5, 0.012 - T.days.lieLift);
    towel.receiveShadow = true;
    view.meshes.Towel = towel; group.add(towel);
  }
  view.posture = hm.posture;
  view.zonesOn = false;
}

function placeCapsule(mesh, a, b) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
}

function solveArm(S, target, la, lb, side) {
  const d = new THREE.Vector3().subVectors(target, S);
  let dist = d.length();
  const dn = dist > 1e-6 ? d.clone().divideScalar(dist) : new THREE.Vector3(0, -1, 0);
  dist = Math.min(Math.max(dist, Math.abs(la - lb) + 1e-3), la + lb - 1e-3);
  const x = (la * la - lb * lb + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, la * la - x * x));
  const pole = new THREE.Vector3(side, -1, -0.4).normalize();
  pole.sub(dn.clone().multiplyScalar(pole.dot(dn))).normalize();
  return { E: S.clone().add(dn.clone().multiplyScalar(x)).add(pole.multiplyScalar(h)), H: S.clone().add(dn.clone().multiplyScalar(dist)) };
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

function setArm(P, side, tgt) {
  const n = side < 0 ? 'L' : 'R', ua = P['UpperArm' + n], fa = P['Forearm' + n];
  const { E, H } = solveArm(ua.a, tgt, ua.a.distanceTo(ua.b), fa.a.distanceTo(fa.b), side);
  ua.b.copy(E); fa.a.copy(E); fa.b.copy(H);
}

function poseHuman(view, t, dt) {
  const { hm, group } = view;
  group.visible = hm.state !== 'away' && !(hm.state === 'fetch' && hm.fetchT > 0); // indoors fetching a can (T1-6)
  if (!group.visible) return;
  if (view.sig !== JSON.stringify(hm.clothing) + hm.posture) rebuildHuman(view);
  if (ui.zones !== view.zonesOn) applyZoneColors(view, ui.zones);

  const k = 1 - Math.exp(-dt * 12);
  if (Math.hypot(hm.x - view.x, hm.z - view.z) > 3) { view.x = hm.x; view.z = hm.z; }
  view.x += (hm.x - view.x) * k; view.z += (hm.z - view.z) * k;
  let da = Math.atan2(hm.fx, hm.fz) - view.ang;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  view.ang += da * Math.min(1, dt * 10);
  view.flinch = Math.max(0, view.flinch - dt * 4);

  const moving = hm.state === 'flee' || hm.state === 'return' || hm.state === 'arrive' || hm.state === 'leave' || hm.state === 'fetch' || hm.state === 'seek' ||
    ((hm.state === 'stroll' || hm.state === 'garden') && hm.walking); // T1-11
  if (moving) view.walk += dt * (hm.state === 'flee' ? 13 : hm.state === 'stroll' ? 5 : 7);

  const P = {};
  for (const p of view.rest) P[p.name] = { a: V(p.a), b: V(p.b) };
  const X = new THREE.Vector3(1, 0, 0);
  view.bob = 0;
  if (moving && hm.posture === 'stand') {
    // A gait, in the body frame (+z forward; a positive turn about X swings a hanging bone backward).
    // The hip swings the thigh forward and back; the knee only ever folds the shin backward: most in the swing,
    // as the leg comes through, a little while the foot is planted. Arms swing against the legs, elbows bent.
    const run = hm.state === 'flee';
    const hipAmp = run ? 0.75 : 0.42, kneeAmp = run ? 1.5 : 0.8, kneeStance = run ? 0.25 : 0.08;
    const armAmp = run ? 0.9 : 0.5, elbow = run ? 1.3 : 0.35;
    const restFoot = Math.min(view.rest.find((q) => q.name === 'ShinL').b.y, view.rest.find((q) => q.name === 'ShinR').b.y);
    let lowFoot = Infinity;
    for (const [side, ph] of [['L', 0], ['R', Math.PI]]) {
      const phase = view.walk + ph;
      const hip = Math.sin(phase) * hipAmp;                                    // + = thigh forward
      const knee = kneeStance + kneeAmp * Math.pow(Math.max(0, Math.cos(phase)), 1.5); // swinging forward: fold
      // take each bone's vector before moving its end: copy() runs before the argument of add() is built
      const th = P['Thigh' + side], sh = P['Shin' + side];
      const thv = th.b.clone().sub(th.a).applyAxisAngle(X, -hip);
      const shv = sh.b.clone().sub(sh.a).applyAxisAngle(X, -hip + knee);
      th.b.copy(th.a).add(thv);
      sh.a.copy(th.b); sh.b.copy(th.b).add(shv);
      lowFoot = Math.min(lowFoot, sh.b.y);
      const ua = P['UpperArm' + side], fa = P['Forearm' + side];
      const arm = Math.sin(phase) * armAmp;                                    // against this side's leg
      const uav = ua.b.clone().sub(ua.a).applyAxisAngle(X, arm);
      const fav = fa.b.clone().sub(fa.a).applyAxisAngle(X, arm - elbow);
      ua.b.copy(ua.a).add(uav);
      fa.a.copy(ua.b); fa.b.copy(ua.b).add(fav);
    }
    view.bob = restFoot - lowFoot; // bent legs are shorter: drop the body so the planted foot stays on the ground
  }
  if ((hm.tr.style === 3 && hm.panic > 0.15) || hm.state === 'treat') {
    for (const side of [-1, 1]) {
      const ua = P['UpperArm' + (side < 0 ? 'L' : 'R')];
      const tgt = hm.state === 'treat'
        ? ua.a.clone().add(new THREE.Vector3(side * 0.05, 0.35 + Math.sin(t * 0.3 + side) * 0.03, 0.35))
        : ua.a.clone().add(new THREE.Vector3(side * 0.12, 0.05 + Math.sin(t * 2.7) * 0.01, 0.22));
      setArm(P, side, tgt);
    }
  }

  view.lean.set(0, 0, 0);
  let twist = 0;
  for (const an of anims) {
    if (an.actorHex !== hm.hex) continue;
    const e = envelope(an, t);
    if (e <= 0) continue;
    const frame = humanViews.get(an.frameHex);
    if (!frame) continue;
    const impactW = frame.group.localToWorld(V(an.center));
    if (an.kind === SwatKind.Shake) { twist += Math.sin(t * 1.1) * 0.5 * e; continue; } // a head shake dislodges
    if (an.kind === SwatKind.Contort) {
      twist = Math.sin(t * 1.9) * 0.45 * e;
      for (const side of [-1, 1]) {
        const ua = P['UpperArm' + (side < 0 ? 'L' : 'R')], fa = P['Forearm' + (side < 0 ? 'L' : 'R')];
        const over = ua.a.clone().add(new THREE.Vector3(-side * 0.06 + Math.sin(t * 2.3 + side) * 0.07, 0.16 + Math.sin(t * 1.7 * side) * 0.05, -0.16));
        setArm(P, side, fa.b.clone().lerp(over, e));
      }
      continue;
    }
    const local = group.worldToLocal(impactW.clone());
    if (an.actorHex !== an.frameHex) {
      const need = Math.max(0, Math.hypot(local.x, local.z) - 0.42);
      if (need > 0) view.lean.add(new THREE.Vector3(impactW.x - group.position.x, 0, impactW.z - group.position.z).normalize().multiplyScalar(need * e));
    }
    const fa = P['Forearm' + (an.side < 0 ? 'L' : 'R')];
    const tgt = fa.b.clone().lerp(local, e);
    if (an.kind === SwatKind.Brush && t >= an.start) tgt.x += Math.sin((t - an.start) * 0.9) * 0.07;
    if (an.flail && t >= an.start - 2) tgt.add(new THREE.Vector3(Math.sin(t * 3.1) * 0.03, Math.cos(t * 2.3) * 0.03, 0));
    setArm(P, an.side, tgt);
  }
  if (twist) for (const nm of ['Head', 'Neck']) { const pr = P[nm], piv = P.Torso.b; for (const pt of [pr.a, pr.b]) pt.sub(piv).applyAxisAngle(UP, twist).add(piv); }
  for (const p of view.rest) placeCapsule(view.meshes[p.name], P[p.name].a, P[p.name].b);
  const head = P.Head.a, r = view.rest[0].r;
  view.meshes.Hair.position.copy(head).add(new THREE.Vector3(0, r * 0.08, -r * 0.05));
  view.meshes.Hair.rotation.y = twist;
  const fwd = new THREE.Vector3(Math.sin(twist), 0, Math.cos(twist)), right = new THREE.Vector3(fwd.z, 0, -fwd.x);
  view.meshes.EyeL.position.copy(head).addScaledVector(fwd, r * 0.9).addScaledVector(right, -r * 0.35).add(new THREE.Vector3(0, r * 0.15, 0));
  view.meshes.EyeR.position.copy(head).addScaledVector(fwd, r * 0.9).addScaledVector(right, r * 0.35).add(new THREE.Vector3(0, r * 0.15, 0));
  view.meshes.Can.visible = hm.sprayCount > 0;
  if (hm.sprayCount > 0) view.meshes.Can.position.copy(P.ForearmR.b).add(new THREE.Vector3(0, 0.02, 0));
  if (view.meshes.Veil) { view.meshes.Veil.position.copy(head); view.meshes.Brim.position.copy(head).add(new THREE.Vector3(0, r * 0.75, 0)); }
  const jolt = view.flinch > 0 ? Math.sin(view.flinch * 40) * 0.015 * view.flinch : 0;
  group.position.set(view.x + view.lean.x, jolt + view.bob, view.z + view.lean.z);
  group.rotation.y = view.ang + (hm.state === 'watch' ? Math.sin(t * 0.03 + hm.lines) * 0.9 : 0); // scanning for flight lines (T1-7)
  if (hm.posture === 'lie') { // on a towel (T1-11): the standing body turned onto its back, head toward the facing
    group.quaternion.setFromAxisAngle(UP, view.ang).multiply(LIE_Q);
    group.position.y += T.days.lieLift;
  }
}
const LIE_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 1).normalize(), Math.PI);

// The world normal of the surface a wasp stands on: a landed wasp keeps its own; a perched one takes the skin's,
// turned from the person's body frame into the world
const _basis = new THREE.Matrix4();
function surfaceNormal(w) {
  if (w.state === 'landed' && w.land) return new THREE.Vector3(w.land.nx, w.land.ny, w.land.nz);
  const on = w.state === 'perched' ? w.perch : w.state === 'attached' ? w.attach : null;
  if (!on) return null;
  const hm = sim.humanByHex(on.hex);
  if (!hm) return null;
  const n = on.n;
  const d = dirToWorld(hm, n);
  return new THREE.Vector3(d.x, d.y, d.z).normalize();
}

// Lab: color every vertex by what the human does if stung there (GDD 8.3-8.5)
let kindColors = null;
const zoneMat = new THREE.MeshLambertMaterial({ vertexColors: true });
function applyZoneColors(view, on) {
  view.zonesOn = on;
  const { hm } = view;
  kindColors = kindColors || {
    [-1]: new THREE.Color(css('--slate')), [-2]: new THREE.Color(css('--lilac')),
    [SwatKind.Slap]: new THREE.Color(css('--red')), [SwatKind.Cover]: new THREE.Color(css('--orange')),
    [SwatKind.Brush]: new THREE.Color(css('--yellow')), [SwatKind.Contort]: new THREE.Color(css('--green')),
    [SwatKind.Shake]: new THREE.Color('#e9d9a8'),
  };
  for (const p of view.rest) {
    const m = view.meshes[p.name];
    if (!on) { m.material = partMaterial(view, hm, p.name); continue; }
    const geo = m.geometry, posA = geo.attributes.position, nrm = geo.attributes.normal;
    const colors = new Float32Array(posA.count * 3);
    const rest = new THREE.Object3D(); placeCapsule(rest, V(p.a), V(p.b)); rest.updateMatrix();
    const v = new THREE.Vector3(), n = new THREE.Vector3(), s = hm.tr.height / 1.75;
    for (let i = 0; i < posA.count; i++) {
      v.fromBufferAttribute(posA, i).applyMatrix4(rest.matrix);
      n.fromBufferAttribute(nrm, i).applyQuaternion(rest.quaternion);
      const lp = { x: v.x, y: v.y, z: v.z };
      const zone = classify(p, segClosest(p.a, p.b, lp), { x: n.x, y: n.y, z: n.z }, lp, s);
      const c = kindColors[predictedKind(zone, hm.tr, hm.clothing)];
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    m.material = zoneMat;
  }
}

// ------------------------------------------------------------------ wasps

const CASTE_SCALE = { queen: 1.3, gyne: 1.25, male: 1.1, worker: 1 }; // T2-3
function buildWasp(remote = false, rival = false, caste = 'worker') {
  const g = new THREE.Group();
  if (remote) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.0009, 6, 24), new THREE.MeshBasicMaterial({ color: '#4fd1ff' }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.007;
    g.add(ring);
  }
  const black = mat('#15120c'), yellow = mat(rival ? '#e0901a' : '#f2c200');
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.0021, 12, 10), yellow); head.position.z = 0.0058; head.scale.set(1.15, 1, 0.9);
  const eyes = new THREE.Mesh(new THREE.SphereGeometry(0.0013, 8, 6), black); eyes.scale.set(2.0, 1.1, 0.8); eyes.position.set(0, 0.0004, 0.0062);
  const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.0026, 12, 10), black); thorax.position.z = 0.0025; thorax.scale.set(1, 0.95, 1.2);
  const abdomen = new THREE.Group(); abdomen.position.z = 0.0004;
  let z = -0.0012;
  for (const [r, m] of [[0.0027, yellow], [0.003, black], [0.0029, yellow], [0.0025, black], [0.0021, yellow], [0.0014, black]]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), m); s.position.z = z; s.scale.set(1, 0.9, 0.8); abdomen.add(s); z -= r * 1.05;
  }
  if (caste === 'male') { // a male: a seventh segment and no sting, long antennae (T2-3)
    const s7 = new THREE.Mesh(new THREE.SphereGeometry(0.0011, 10, 6), yellow); s7.position.z = z; s7.scale.set(1, 0.9, 0.8); abdomen.add(s7);
    for (const sd of [-1, 1]) { const ant = new THREE.Mesh(new THREE.BoxGeometry(0.00025, 0.00025, 0.0062), black); ant.position.set(sd * 0.0009, 0.0016, 0.0085); ant.rotation.set(-0.45, sd * 0.35, 0); g.add(ant); }
  } else { const sting = new THREE.Mesh(new THREE.ConeGeometry(0.0004, 0.002, 6), black); sting.rotation.x = -Math.PI / 2; sting.position.z = z - 0.0004; abdomen.add(sting); }
  const wingMat = new THREE.MeshBasicMaterial({ color: '#e8eef2', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
  const wingGeo = new THREE.PlaneGeometry(0.0034, 0.0085); wingGeo.translate(0.0017, 0, -0.003);
  const wl = new THREE.Mesh(wingGeo, wingMat), wr = new THREE.Mesh(wingGeo, wingMat);
  wl.position.set(0.001, 0.0018, 0.003); wr.position.set(-0.001, 0.0018, 0.003); wr.scale.x = -1;
  const carry = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 8, 6), mat('#1b1a17')); carry.position.set(0, -0.004, 0.004); carry.visible = false;
  // six legs on hip pivots; tripod gait when walking or crawling
  const legGeo = new THREE.BoxGeometry(0.0055, 0.00035, 0.00035); legGeo.translate(0.00275, 0, 0);
  const legs = [];
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? 1 : -1, k = i % 3;
    const hip = new THREE.Group(); hip.position.set(side * 0.0012, -0.0012, 0.0036 - k * 0.0011);
    const leg = new THREE.Mesh(legGeo, black); hip.add(leg);
    hip.userData = { side, base: (1 - k) * 0.55, phase: (k + (side > 0 ? 0 : 1)) % 2 };
    legs.push(hip); g.add(hip);
  }
  g.add(head, eyes, thorax, abdomen, wl, wr, carry);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  Object.assign(g.userData, { abdomen, wl, wr, carry, legs, head, eyes, yaw: 0, step: 0 });
  scene.add(g);
  return g;
}
const bulge = new THREE.Mesh(new THREE.SphereGeometry(0.013, 12, 8), mat('#888'));
bulge.visible = false;
scene.add(bulge);

const WATER_MAT = new THREE.MeshLambertMaterial({ color: '#6f93ad', transparent: true, opacity: 0.75, depthWrite: false }); // T2-1
const CARRY_MAT = { fly: mat('#1b1a17'), caterpillar: mat('#6fa83a'), bee: mat('#a7742a'), pulp: mat('#b7ab92'), water: new THREE.MeshLambertMaterial({ color: '#9cc7e6', transparent: true, opacity: 0.7 }) };

function renderWasps(alpha, t, dt) {
  const seen = new Set();
  let drivenPos = null;
  bulge.visible = false;
  for (const w of sim.wasps) {
    seen.add(w.id);
    let g = waspViews.get(w.id);
    if (!g) { g = buildWasp(false, sim.isRival(w), w.caste); waspViews.set(w.id, g); } // the line's sister colonies look like yours (T2-4)
    const pp = pos.get(w.id);
    const p = pp ? new THREE.Vector3().lerpVectors(pp.p, pp.c, alpha) : V(w);
    const driven = w.id === sim.drivenId;
    if (driven) drivenPos = p;
    // looking out of its own eyes: the body is not drawn (compound eyes see nearly all the way round)
    g.visible = w.state !== 'under' && w.state !== 'robbing' && !(driven && eyeBlend > 0.5); // inside clothes or a hive
    g.position.copy(p);
    g.scale.setScalar(CASTE_SCALE[w.caste] || 1);
    g.rotation.order = 'YXZ';
    if (driven && w.state !== 'balled') { g.rotation.y = input.yaw; g.rotation.x = w.state === 'landed' ? 0 : -input.pitch * 0.6; }
    else {
      const sp = Math.hypot(w.vx, w.vz);
      if (sp > 0.05) { let d = Math.atan2(w.vx, w.vz) - g.userData.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); g.userData.yaw += d * Math.min(1, dt * 10); }
      g.rotation.y = g.userData.yaw; g.rotation.x = -Math.atan2(w.vy, Math.max(0.3, sp)) * 0.6;
    }
    g.rotation.z = w.state === 'stunned' ? t * 0.6 : w.state === 'fighting' ? Math.sin(t * 3 + w.id) * 1.4 : 0;
    // on a surface the body lies along it: belly to the surface, head toward where the camera points (GDD 7.2)
    const sn = surfaceNormal(w);
    if (sn && w.state === 'landed' && w.land && typeof w.land.hx === 'number') {
      // landed: the sim keeps the heading, turned by the mouse about the surface
      const f = new THREE.Vector3(w.land.hx, w.land.hy, w.land.hz);
      g.quaternion.setFromRotationMatrix(_basis.makeBasis(new THREE.Vector3().crossVectors(sn, f), sn, f));
    } else if (sn) {
      const f = driven ? new THREE.Vector3(Math.sin(input.yaw) * Math.cos(input.pitch), Math.sin(input.pitch), Math.cos(input.yaw) * Math.cos(input.pitch)) : new THREE.Vector3(Math.sin(g.userData.yaw), 0, Math.cos(g.userData.yaw));
      f.addScaledVector(sn, -f.dot(sn));
      if (f.lengthSq() < 0.04) f.set(-Math.sin(input.yaw) * Math.sin(input.pitch), Math.cos(input.pitch), -Math.cos(input.yaw) * Math.sin(input.pitch)).projectOnPlane(sn); // looking straight at the surface: head up the screen
      if (f.lengthSq() > 1e-8) { f.normalize(); g.quaternion.setFromRotationMatrix(_basis.makeBasis(new THREE.Vector3().crossVectors(sn, f), sn, f)); }
    }
    const flap = w.state === 'attached' || w.state === 'balled' || w.state === 'trapped' || w.state === 'landed' || w.state === 'perched' ? 0.15 : w.state === 'webbed' ? Math.sin(t * 2.3) * 0.3 : w.state === 'fighting' ? Math.sin(t * 5 + w.id) * 1.2 : Math.sin(performance.now() * 0.9 + w.id) * 0.9;
    g.userData.wl.rotation.z = flap; g.userData.wr.rotation.z = -flap;
    // legs: planted and stepping on a surface, tucked back in flight
    const onSurface = w.state === 'landed' || w.state === 'perched' || w.state === 'attached' || w.state === 'chewing';
    const moving = pp && onSurface && pp.p.distanceToSquared(pp.c) > 1e-10;
    if (moving) g.userData.step += dt * 14;
    for (const hip of g.userData.legs) {
      const u = hip.userData, swing = moving ? Math.sin(g.userData.step + u.phase * Math.PI) * 0.35 : 0;
      const lift = moving ? Math.max(0, Math.cos(g.userData.step + u.phase * Math.PI)) * 0.25 : 0;
      hip.rotation.order = 'YZX';
      hip.rotation.y = u.side > 0 ? -(onSurface ? u.base + swing : -0.9) : Math.PI + (onSurface ? u.base + swing : -0.9);
      hip.rotation.z = -(onSurface ? 0.75 - lift : 1.2);
    }
    g.userData.abdomen.rotation.x = w.state === 'attached' ? 0.5 + Math.sin(t * 0.8) * 0.06 : 0;
    const cv = g.userData.carry;
    cv.visible = !!w.carry;
    if (w.carry) cv.material = CARRY_MAT[w.carry.what] || CARRY_MAT.fly;
    if (w.state === 'under') {
      const hv = humanViews.get(w.under.hex);
      bulge.visible = true;
      bulge.position.copy(p);
      if (hv) bulge.material = isLowerZone(garmentZone(w)) ? hv.colors.bottom : hv.colors.top;
    }
  }
  // remote wasps: drawn where the sim extrapolates them, eased so corrections don't snap (GDD 11.4)
  for (const [id, r] of sim.remote) {
    seen.add(id);
    let g = waspViews.get(id);
    if (!g) { g = buildWasp(!r.rival, !!r.rival, r.caste); waspViews.set(id, g); g.position.set(r.x, r.y, r.z); }
    const tgt = new THREE.Vector3(r.x, r.y, r.z);
    if (g.position.distanceTo(tgt) > 0.5) g.position.copy(tgt); else g.position.lerp(tgt, 1 - Math.exp(-dt * 25));
    g.visible = r.state !== 'under';
    g.scale.setScalar(CASTE_SCALE[r.caste] || 1);
    const sp = Math.hypot(r.vx, r.vz);
    if (sp > 0.05) { let d = Math.atan2(r.vx, r.vz) - g.userData.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); g.userData.yaw += d * Math.min(1, dt * 10); }
    g.rotation.order = 'YXZ'; g.rotation.y = g.userData.yaw; g.rotation.x = 0; g.rotation.z = 0;
    const flap = r.state === 'attached' ? 0.15 : Math.sin(performance.now() * 0.9 + id) * 0.9;
    g.userData.wl.rotation.z = flap; g.userData.wr.rotation.z = -flap;
    g.userData.abdomen.rotation.x = r.state === 'attached' ? 0.5 : 0;
    g.userData.carry.visible = !!r.carry;
  }
  for (const [id, g] of waspViews) if (!seen.has(id)) { scene.remove(g); waspViews.delete(id); pos.delete(id); }
  return drivenPos;
}
function garmentZone(w) {
  const hm = sim.humanByHex(w.under.hex);
  const nodes = garmentGraph(hm.tr, hm.clothing, hm.posture, hm.parts[hm.posture]);
  const n = nodes[w.under.node];
  return n ? n.zone : 0;
}

// ------------------------------------------------------------------ swat volumes, sprays, rain

const swatGeo = new THREE.SphereGeometry(1, 18, 12);
const swatMats = {
  kill: new THREE.MeshBasicMaterial({ color: css('--red'), wireframe: true, transparent: true, opacity: 0.55 }),
  stun: new THREE.MeshBasicMaterial({ color: css('--green'), wireframe: true, transparent: true, opacity: 0.55 }),
};
const swatPool = [];
function renderSwats(t) {
  let i = 0;
  if (ui.lab && ui.swats) {
    for (const s of sim.swats) {
      const hm = sim.humanByHex(s.frameHex);
      if (!hm) continue;
      const c = toWorld(hm, s.center);
      while (swatPool.length <= i) { const m = new THREE.Mesh(swatGeo, swatMats.kill); scene.add(m); swatPool.push(m); }
      const m = swatPool[i++];
      m.visible = true;
      m.position.set(c.x, c.y, c.z);
      const active = sim.tick >= s.start;
      m.scale.setScalar(active ? s.radius : s.radius * (0.3 + 0.7 * Math.max(0, 1 - (s.start - t) / 40)));
      m.material = s.kills ? swatMats.kill : swatMats.stun;
    }
  }
  for (; i < swatPool.length; i++) swatPool[i].visible = false;
}

const sprayGeo = new THREE.ConeGeometry(0.32, 1.1, 18, 1, true);
sprayGeo.translate(0, -0.55, 0); sprayGeo.rotateX(-Math.PI / 2);
const sprayMat = new THREE.MeshBasicMaterial({ color: '#e9f1f2', transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
const sprayPool = [];
function renderSprays() {
  let i = 0;
  for (const sp of sim.sprays) {
    if (sim.tick < sp.start) continue;
    const v = humanViews.get(sp.hex);
    if (!v) continue;
    while (sprayPool.length <= i) { const m = new THREE.Mesh(sprayGeo, sprayMat); scene.add(m); sprayPool.push(m); }
    const m = sprayPool[i++];
    m.visible = true;
    const head = v.rest[0].a;
    m.position.copy(v.group.localToWorld(new THREE.Vector3(head.x, head.y, head.z + 0.1)));
    m.rotation.set(0, v.group.rotation.y, 0);
    m.scale.setScalar(0.9 + Math.random() * 0.15);
  }
  for (; i < sprayPool.length; i++) sprayPool[i].visible = false;
}

const RAIN = 1400;
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN * 6), 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: '#c9d6e3', transparent: true, opacity: 0.45 }));
rain.frustumCulled = false; rain.visible = false; scene.add(rain);
const rainDrops = Array.from({ length: RAIN }, () => [Math.random() * 24 - 12, Math.random() * 12, Math.random() * 24 - 12]);
let flash = 0;
function renderRain(center, dt) {
  rain.visible = sim.raining;
  if (!rain.visible) { flash = 0; return; }
  const pour = sim.weatherToday.pour, w = sim.wind, a = rainGeo.attributes.position.array;
  // a downpour falls faster and slants with the gale (T2-2)
  const fall = 9 * (pour > 1 ? 1.6 : 1), sx = pour > 1 ? w.x * 0.05 : 0.02, sz = pour > 1 ? w.z * 0.05 : 0;
  rainDrops.forEach((d, i) => {
    d[1] -= dt * fall; if (d[1] < 0) d[1] += 12;
    const x = center.x + d[0], y = d[1], z = center.z + d[2];
    a.set([x, y, z, x + sx, y + 0.25 * (pour > 1 ? 1.5 : 1), z + sz], i * 6);
  });
  rainGeo.attributes.position.needsUpdate = true;
  // lightning now and then in a storm (presentation only)
  if (pour > 1 && Math.random() < dt * 0.12) { flash = 1; setTimeout(() => blip(60, 35, 0.9, 0.25, 'sawtooth'), 300 + Math.random() * 1500); }
  flash = Math.max(0, flash - dt * 5);
}

function lighting() {
  const md = minuteOfDay(sim.minute) + (sim.tick % sim.tpm) / sim.tpm;
  const f = (md - 360) / 900; // 06:00 .. 21:00
  const elev = Math.sin(Math.PI * Math.min(1, Math.max(0, f)));
  const dayAmt = Math.min(1, Math.max(0, elev * 2.2));
  const duskAmt = Math.max(0, 1 - Math.abs(elev - 0.12) / 0.18) * (f > 0 && f < 1 ? 1 : 0);
  sky.copy(SKY_NIGHT).lerp(SKY_DAY, dayAmt).lerp(SKY_DUSK, duskAmt * 0.6);
  const storm = sim.raining && sim.weatherToday.pour > 1;
  if (sim.raining) sky.lerp(SKY_RAIN, 0.7 * dayAmt + 0.2);
  if (storm) sky.multiplyScalar(0.6);
  if (flash > 0) sky.lerp(SKY_FLASH, flash * 0.8);
  scene.fog.color.copy(sky);
  sunDir.set(Math.cos(Math.PI * f) * 0.8, Math.max(0.08, elev), 0.35).normalize();
  sun.intensity = (sim.raining ? (storm ? 0.25 : 0.5) : 2.1) * dayAmt;
  hemi.intensity = 0.18 + 0.97 * dayAmt * (storm ? 0.6 : 1) + flash * 1.5;
}

// ------------------------------------------------------------------ sound (procedural, presentation only)

const audio = { ctx: null, on: true };
function initAudio() {
  if (audio.ctx) return;
  let ctx;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  audio.ctx = ctx;
  const master = ctx.createGain(); master.gain.value = opts.volume; master.connect(ctx.destination); audio.master = master;
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.6 + b * 2.5; }
  audio.noiseBuf = noiseBuf;
  const loopNoise = (type, freq, q) => {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(master); src.start();
    return g;
  };
  const buzz = (freq) => {
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'sawtooth'; o1.frequency.value = freq; o2.frequency.value = freq * 1.012;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400; f.Q.value = 2;
    const g = ctx.createGain(); g.gain.value = 0;
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(master); o1.start(); o2.start();
    return { o1, o2, g, f };
  };
  audio.wings = buzz(200);
  audio.others = buzz(215);
  audio.bees = buzz(245);
  audio.stare = buzz(55); audio.stare.f.frequency.value = 160;
  audio.wind = loopNoise('lowpass', 500, 0.5);
  audio.rain = loopNoise('highpass', 2500, 0.4);
  audio.spray = loopNoise('highpass', 4000, 0.7);
  audio.nextChirp = 0;
}
function blip(freqA, freqB, dur, vol, type = 'sine', delay = 0) {
  const ctx = audio.ctx; if (!ctx || !audio.on) return;
  const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freqA, t); o.frequency.exponentialRampToValueAtTime(freqB, t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(audio.master); o.start(t); o.stop(t + dur + 0.05);
}
function thwack(vol) {
  const ctx = audio.ctx; if (!ctx || !audio.on) return;
  const t = ctx.currentTime, src = ctx.createBufferSource(); src.buffer = audio.noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 0.8;
  const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  src.connect(f); f.connect(g); g.connect(audio.master); src.start(t, Math.random()); src.stop(t + 0.15);
}
function yelp(height) { const base = 520 - (height - 1.5) * 500; blip(base * 1.4, base, 0.28, 0.12, 'triangle'); blip(base * 2.1, base * 1.5, 0.22, 0.04, 'sine'); }
const near = (p, r) => { const w = sim.wasp; return w && Math.hypot(p.x - w.x, p.y - w.y, p.z - w.z) < r; };
function updateAudio(dt) {
  const ctx = audio.ctx; if (!ctx) return;
  const now = ctx.currentTime, set = (g, v) => g.gain.setTargetAtTime(audio.on ? v : 0, now, 0.05);
  const w = sim._driven();
  const flying = w && (w.state === 'fly' || w.state === 'chewing') && !paused && running;
  const sp = w ? Math.hypot(w.vx, w.vy, w.vz) : 0;
  set(audio.wings.g, flying ? 0.035 + Math.min(0.03, sp * 0.006) : w && w.state === 'balled' ? 0.02 : 0);
  if (w) { const f = (w.caste === 'queen' ? 165 : 195) + sp * 10; audio.wings.o1.frequency.setTargetAtTime(f, now, 0.08); audio.wings.o2.frequency.setTargetAtTime(f * 1.012, now, 0.08); }
  let nd = Infinity;
  if (w) for (const x of sim.wasps) if (x !== w) nd = Math.min(nd, Math.hypot(x.x - w.x, x.y - w.y, x.z - w.z));
  set(audio.others.g, running && nd < 4 ? 0.03 / (1 + nd * nd * 4) : 0);
  let bees = 0;
  if (w) for (const al of sim.hiveAlarms.values()) for (const b in al.phys) { const p = al.phys[b]; if (Math.hypot(p.x - w.x, p.y - w.y, p.z - w.z) < 2) bees++; }
  set(audio.bees.g, running ? Math.min(0.05, bees * 0.006) : 0);
  const md = minuteOfDay(sim.minute), day = md >= T.time.dawn && md < T.time.dusk;
  set(audio.wind, (running ? 0.05 : 0.02) * (1 - 0.85 * stare));
  set(audio.stare.g, running ? 0.05 * stare : 0);
  set(audio.rain, sim.raining ? 0.09 : 0);
  let spraying = false;
  for (const spx of sim.sprays) if (sim.tick >= spx.start) { const h = sim.humanByHex(spx.hex); if (h && near(h, 4)) spraying = true; }
  set(audio.spray, spraying ? 0.08 : 0);
  if (running && !paused && now > audio.nextChirp && stare < 0.4) {
    if (day && !sim.raining) { const f = 2500 + Math.random() * 2000; for (let i = 0; i < 2 + Math.random() * 3; i++) blip(f, f * (0.7 + Math.random() * 0.5), 0.07, 0.012, 'sine', i * 0.09); }
    else if (!day) blip(4200, 4300, 0.04, 0.006, 'square');
    audio.nextChirp = now + (day ? 1.5 + Math.random() * 4 : 0.35 + Math.random() * 0.4);
  }
}

// ------------------------------------------------------------------ input

const pad = { prev: [] };
function readPad() {
  const gp = navigator.getGamepads ? [...navigator.getGamepads()].find((g) => g && g.connected) : null;
  if (!gp) return null;
  const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
  const b = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));
  const edge = (i) => b(i) && !pad.prev[i];
  const out = { lx: dz(gp.axes[0] || 0), ly: dz(gp.axes[1] || 0), rx: dz(gp.axes[2] || 0), ry: dz(gp.axes[3] || 0), b, edge };
  if (edge(8)) toggleNest();
  if (edge(11)) toggleLock(); // R3: lock on
  if (edge(10)) eyeTurnDown(); else if (pad.prev[10] && !b(10)) eyeTurnUp(); // L3: turn to where you look
  pad.prev = gp.buttons.map((x) => !!(x && (x.pressed || x.value > 0.5)));
  return out;
}

function buildCmd() {
  if (input.autopilot) return input.autopilot(sim); // test hook: scripted pilots use the same input path
  const gp = readPad();
  if (gp) {
    input.yaw -= gp.rx * 2.4 * opts.sens * DT;
    input.pitch = Math.max(-1.45, Math.min(1.45, input.pitch - ySign() * gp.ry * 1.8 * opts.sens * DT));
  }
  const k = input.keys, a = (p, n) => ((k.has(p) ? 100 : 0) - (k.has(n) ? 100 : 0));
  const look = 1.6 * DT;
  if (k.has('ArrowLeft')) input.yaw += look;
  if (k.has('ArrowRight')) input.yaw -= look;
  if (k.has('ArrowUp')) input.pitch = Math.min(1.45, input.pitch + look * 0.8);
  if (k.has('ArrowDown')) input.pitch = Math.max(-1.45, input.pitch - look * 0.8);
  const clamp100 = (v) => Math.max(-100, Math.min(100, Math.round(v)));
  const cmd = {
    mx: clamp100(a('KeyD', 'KeyA') + (gp ? gp.lx * 100 : 0)),
    mz: clamp100(a('KeyW', 'KeyS') - (gp ? gp.ly * 100 : 0)),
    my: clamp100(a('Space', 'KeyC') + (gp ? ((gp.b(5) ? 100 : 0) - (gp.b(4) || gp.b(1) ? 100 : 0)) : 0)),
    burst: k.has('ShiftLeft') || k.has('ShiftRight') || (gp && gp.b(6)) ? 1 : 0,
    sting: input.lmb || k.has('KeyF') || (gp && gp.b(7)) ? 1 : 0,
    yawQ: Math.round(input.yaw * 1e4), pitchQ: Math.round(input.pitch * 1e4),
    act: (k.has('KeyE') || (gp && gp.b(0)) ? Act.Interact : 0) | (k.has('KeyQ') || (gp && gp.b(3)) ? Act.Switch : 0) | (k.has('KeyR') || (gp && gp.b(2)) ? Act.Rest : 0),
    alloc: input.alloc,
    pick: input.pick ? (input.pick = 0, pickOnce) : 0,
  };
  // locked on: closing in slows near the target, so W brings you up to it rather than past it
  if (input.lock && !input.pilot && cmd.mz > 0) {
    const w = sim._driven(), p = w && targetPos(sim, input.lock);
    if (p) cmd.mz = Math.max(1, Math.round(cmd.mz * Math.max(0.12, Math.min(1, Math.hypot(p.x - w.x, p.y - w.y, p.z - w.z) / 0.6))));
  }
  // assisted flight: the wasp flies itself to the locked target until you touch the controls (GDD 7.9)
  if (input.pilot) {
    const w = sim._driven();
    if (!w || cmd.mx || cmd.my || cmd.mz || cmd.burst || cmd.sting) { input.pilot = null; if (w) toast('You have it', 'var(--muted)', 0.8); return cmd; }
    const r = assistPilot(sim, w, input.pilot, cmd);
    if (r.done) {
      input.pilot = null;
      const say = { landed: 'Landed', perched: 'On them', caught: 'Got it', gone: 'It is gone' }[r.done];
      if (say) toast(say, 'var(--yellow)', 1);
      return cmd;
    }
    return r.cmd; // the camera keeps watching the target meanwhile (updateAssist)
  }
  return cmd;
}

// ------------------------------------------------------------------ lock-on, assisted flight and the eye turn (GDD 7.9)

const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function aimDir() { const y = input.yaw + input.free.yaw, p = input.pitch + input.free.pitch; return { x: Math.sin(y) * Math.cos(p), y: Math.sin(p), z: Math.cos(y) * Math.cos(p) }; }
function toggleLock() {
  const w = sim && sim._driven();
  if (!w || !running || paused) return;
  if (input.lock) { input.lock = null; input.pilot = null; toast('Lock released', 'var(--muted)', 0.9); return; }
  const t = pickTarget(sim, w, aimDir());
  if (!t) { toast('Nothing to lock on to', 'var(--muted)', 1.1); return; }
  input.lock = t;
  toast(`Locked on: ${targetLabel(sim, t)}`, 'var(--yellow)', 1.2);
}
// E with a lock on something the wasp can go to, and nothing to act on right here: fly there
function interactNear() { const h = sim.hint || {}; return !!(h.prey || h.bait || h.wood || h.water || h.site || h.rival || h.hive || h.hiber || h.opening || (h.raid !== null && h.raid !== undefined)); }
function startPilot() {
  if (!input.lock || !TARGET_KIND[input.lock.kind].go || interactNear()) return false;
  input.pilot = input.lock;
  toast(`Flying to the ${targetLabel(sim, input.lock)}`, 'var(--yellow)', 1);
  return true;
}
// G (or L3): a tap turns the wasp to where you are looking; held a second it switches the auto turn on or off, which
// turns the wasp after your gaze once you have looked away for a second
function eyeTurnDown() { input.gDown = performance.now(); input.gLong = false; }
function eyeTurnUp() {
  if (!input.gDown) return;
  if (!input.gLong) input.turning = true;
  input.gDown = 0;
}
function updateAssist(dt) {
  const w = sim && sim._driven(), f = input.free;
  if (input.gDown && !input.gLong && performance.now() - input.gDown >= 1000) {
    input.gLong = true; input.autoTurn = !input.autoTurn;
    toast(input.autoTurn ? 'Auto turn on · the wasp follows your gaze' : 'Auto turn off', 'var(--muted)', 1.4);
  }
  if (input.lock) {
    const p = targetPos(sim, input.lock);
    if (!w || !p || (p.x - w.x) ** 2 + (p.y - w.y) ** 2 + (p.z - w.z) ** 2 > LOCK.lostRange ** 2) {
      if (input.lock) toast(input.pilot ? 'It is gone' : 'Lost the lock', 'var(--muted)', 1);
      input.lock = null; input.pilot = null;
    } else if (w.state === 'fly') {
      // face the target: W closes in, S backs off, A and D circle it; on an assisted flight the camera just watches it
      const dx = p.x - w.x, dy = p.y - w.y, dz = p.z - w.z, k = Math.min(1, dt * 8), pl = input.pilot ? 0.7 : 1.45;
      input.yaw += wrapA(Math.atan2(dx, dz) - input.yaw) * k;
      input.pitch += (Math.max(-pl, Math.min(pl, Math.atan2(dy, Math.hypot(dx, dz)))) - input.pitch) * k;
    }
  }
  // the eye turn: the body comes round to the gaze and the gaze stays where it was
  const off = Math.abs(f.yaw) + Math.abs(f.pitch);
  input.gazeOff = input.autoTurn && f.held && off > 0.06 ? input.gazeOff + dt : 0;
  if (input.gazeOff >= 1 && !input.lock && !input.pilot) input.turning = true;
  if (input.turning) {
    if (input.lock || input.pilot || off < 0.01) { input.turning = false; return; }
    const k = Math.min(1, dt * 7), dy = f.yaw * k;
    let dp = f.pitch * k;
    dp = Math.max(-1.45 - input.pitch, Math.min(1.45 - input.pitch, dp));
    input.yaw += dy; f.yaw -= dy; input.pitch += dp; f.pitch -= dp;
    if (Math.abs(f.yaw) + Math.abs(f.pitch) < 0.01 || Math.abs(dp) + Math.abs(dy) < 1e-4) input.turning = false;
  }
}
const lockMark = document.getElementById('lockMark');
function drawLock() {
  if (!lockMark) return;
  const t = input.lock, p = t && targetPos(sim, t);
  if (!p) { lockMark.hidden = true; return; }
  const v = new THREE.Vector3(p.x, p.y + terrAt(p.x, p.z), p.z).project(camera);
  if (v.z > 1 || v.z < -1) { lockMark.hidden = true; return; }
  lockMark.hidden = false;
  lockMark.style.left = `${(v.x + 1) / 2 * innerWidth}px`; lockMark.style.top = `${(1 - v.y) / 2 * innerHeight}px`;
  const K = TARGET_KIND[t.kind];
  lockMark.dataset.hazard = K.hazard ? '1' : '';
  lockMark.querySelector('span').textContent = targetLabel(sim, t) + (input.pilot ? ' · flying there' : K.go ? ` · E ${K.go}` : K.hazard ? ' · keep clear' : '');
}
let pickOnce = 0; // a colony-view pick goes out in exactly one command

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Tab') { e.preventDefault(); toggleLab(); return; }
  if (e.code === 'KeyN' && !e.repeat) { toggleNest(); return; }
  if (e.code === 'KeyT' && !e.repeat && ui.nest && solo()) { setSpeed(SPEEDS[(SPEEDS.indexOf(ui.speed) + 1) % SPEEDS.length]); return; }
  if (e.code === 'KeyV' && !e.repeat && running && !paused) { toggleLock(); return; }
  if (e.code === 'KeyG' && !e.repeat && running && !paused) { eyeTurnDown(); return; }
  if (e.code === 'KeyE' && !e.repeat && running && !paused && startPilot()) return;
  if (e.code === 'KeyM' && !e.repeat) { audio.on = !audio.on; toast(audio.on ? 'Sound on' : 'Sound off', 'var(--muted)', 1.2); return; }
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  input.keys.add(e.code);
});
addEventListener('keyup', (e) => { input.keys.delete(e.code); if (e.code === 'KeyG') eyeTurnUp(); });
addEventListener('blur', () => { input.keys.clear(); input.lmb = false; input.free.held = false; });
let lockFailed = false, pointerLockWorked = false;
document.addEventListener('pointerlockerror', () => { lockFailed = true; toast('Mouse capture unavailable · drag with right button to look', 'var(--muted)', 3); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (!running || paused) return;
  if (document.pointerLockElement !== canvas && !lockFailed && !pointerLockWorked) { lock(); return; }
  if (e.button === 0) input.lmb = true;
  if (e.button === 1) { e.preventDefault(); toggleLock(); } // middle button: lock on
  if (e.button === 2 && document.pointerLockElement === canvas) input.free.held = true; // free look
});
addEventListener('mouseup', (e) => { if (e.button === 0) input.lmb = false; if (e.button === 2) input.free.held = false; });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas && !(e.buttons & 2)) return;
  if (paused) return;
  const k = 0.0022 * opts.sens;
  if (input.free.held) {
    // free look: the camera orbits, the wasp keeps its heading
    const f = input.free;
    f.yaw -= e.movementX * k;
    f.pitch = Math.max(-1.5 - input.pitch, Math.min(1.5 - input.pitch, f.pitch - ySign() * e.movementY * k));
    f.yaw = Math.atan2(Math.sin(f.yaw), Math.cos(f.yaw));
    return;
  }
  input.yaw -= e.movementX * k;
  input.pitch = Math.max(-1.45, Math.min(1.45, input.pitch - ySign() * e.movementY * k));
});
function lock() { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* optional */ } }
document.addEventListener('pointerlockchange', () => {
  if (!running) return;
  const locked = document.pointerLockElement === canvas;
  if (!locked && pointerLockWorked && $('winterScreen').hidden && $('extinctScreen').hidden) setPaused(true);
  if (locked) { pointerLockWorked = true; setPaused(false); }
});
function setPaused(p) { paused = p; if (p && sim) $('pauseTag').textContent = `${tagText(sim.settings)} · rules ${rulesHash(sim.settings)} · tuning ${TUNE.hash}`; input.free.held = false; $('pauseScreen').hidden = !p; input.lmb = false; input.keys.clear(); if (p) { $('saveNote').textContent = ''; saveWorld(false); } }
$('bResume').addEventListener('click', () => { setPaused(false); lock(); });
function showOpts() {
  $('optVol').value = Math.round(opts.volume * 100); $('optVolOut').textContent = Math.round(opts.volume * 100) + '%';
  $('optSens').value = Math.round(opts.sens * 100); $('optSensOut').textContent = opts.sens.toFixed(2) + '×';
  $('optInvert').checked = opts.invert;
  $('optReflex').checked = opts.reflex;
}
showOpts();
$('optVol').addEventListener('input', (e) => {
  opts.volume = +e.target.value / 100; saveOpts(); showOpts();
  if (audio.master) audio.master.gain.setTargetAtTime(opts.volume, audio.ctx.currentTime, 0.03);
});
$('optSens').addEventListener('input', (e) => { opts.sens = +e.target.value / 100; saveOpts(); showOpts(); });
$('optInvert').addEventListener('change', (e) => { opts.invert = e.target.checked; saveOpts(); });
$('optReflex').addEventListener('change', (e) => { opts.reflex = e.target.checked; saveOpts(); });
$('bQuit').addEventListener('click', () => {
  if (!lab) saveWorld(true);
  paused = false; running = false; input.keys.clear(); input.lmb = false;
  $('pauseScreen').hidden = true; $('startScreen').hidden = false;
  showContinue();
});
// Esc opens the menu even when the mouse was never captured (the browser handles Esc itself while it is)
addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || !running || document.pointerLockElement === canvas) return;
  if (!$('winterScreen').hidden || !$('extinctScreen').hidden) return;
  setPaused(!paused);
});

// ------------------------------------------------------------------ panels

function toggleLab() {
  ui.lab = !ui.lab;
  $('lab').hidden = !ui.lab;
  document.body.classList.toggle('lab-open', ui.lab);
  try { localStorage.setItem('sting.lab', ui.lab ? '1' : '0'); } catch { /* optional */ }
}
function toggleNest() { ui.nest = !ui.nest; $('nest').hidden = !ui.nest; document.body.classList.toggle('nest-open', ui.nest); }
$('bZones').addEventListener('click', (e) => { ui.zones = !ui.zones; e.currentTarget.setAttribute('aria-pressed', ui.zones); });
$('bSwats').addEventListener('click', (e) => { ui.swats = !ui.swats; e.currentTarget.setAttribute('aria-pressed', ui.swats); });
$('bVerify').addEventListener('click', () => {
  if (lab) { $('verifyOut').textContent = 'Replay check is for solo worlds. With a second player, the Network section checks agreement instead.'; return; }
  const live = sim.stateHash(), t0 = performance.now();
  const ticks = loadSnap ? sim.tick - sim.logStartTick : sim.tick;
  const replayed = loadSnap ? replayFrom(loadSnap, sim.log, ticks) : Sim.replay(settings, sim.log, ticks);
  const took = Math.round(performance.now() - t0);
  $('verifyOut').innerHTML = replayed === live
    ? `<span class="ok">Match</span> · replayed ${fmt(ticks)} ticks in ${took} ms · ${replayed}`
    : `<span class="bad">Mismatch</span> · live ${live} · replay ${replayed}`;
});
SPEEDS.forEach((v) => {
  const b = document.createElement('button');
  b.className = 'ghost'; b.textContent = v + '×'; b.id = 'speed' + v;
  b.addEventListener('click', () => setSpeed(v));
  $('nSpeed').appendChild(b);
});
setSpeed(1);
T.alloc.forEach((a, i) => {
  const b = document.createElement('button');
  b.className = 'ghost'; b.textContent = a.name; b.id = 'alloc' + i;
  b.addEventListener('click', () => { input.alloc = i + 1; });
  $('nAlloc').appendChild(b);
});

function logEvent(text) {
  ui.log.unshift(`<span>${sim.tick}</span> <b>${text}</b>`);
  ui.log.length = Math.min(ui.log.length, 16);
}

// Colony view (GDD 10.3): the workers that are out, nearest first, each one a button to drive her
const ROLE_NAME = { sugar: 'sugar forager', protein: 'hunter', pulp: 'pulp forager', guard: 'guard', water: 'water carrier', male: 'patrolling the mating spot', gyne: 'on her mating flight' };
const MODE_NAME = { pick: 'choosing', search: 'searching', outbound: 'flying out', collect: 'collecting', return: 'flying home', attack: 'attacking', evade: 'getting away', guard: 'guarding', hunt: 'chasing' };
$('nWorkers').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  pickOnce = +b.dataset.id; input.pick = 1;
});
function updateWorkers() {
  const me = sim._driven();
  const list = sim.wasps.filter((x) => x.colony === 'own' && x !== me)
    .map((x) => ({ x, d: me ? Math.hypot(x.x - me.x, x.z - me.z) : 0 }))
    .sort((a, b) => a.d - b.d).slice(0, 10);
  $('nWorkers').innerHTML = list.length ? list.map(({ x, d }) => {
    const what = x.state === 'fly' ? (MODE_NAME[x.ai.mode] || x.ai.mode) : x.state;
    const carry = x.carry ? ` · carrying ${x.carry.what}` : '';
    return `<div class="wk"><span>${x.caste === 'queen' ? 'Queen' : x.caste === 'male' ? 'Male ' + x.id : x.caste === 'gyne' ? 'Young queen ' + x.id : 'Worker ' + x.id} · ${ROLE_NAME[x.role] || x.role} · ${what}${carry}</span><span class="n">${d < 1 ? '<1' : Math.round(d)} m</span><button class="ghost" data-id="${x.id}">${d <= T.possess.freeRange ? 'Drive' : 'Relay'}</button></div>`;
  }).join('') : '<p class="label">Nobody is out. Workers leave the nest when you are near it in daylight.</p>';
}

function updateNest() {
  updateWorkers();
  const c = sim.colony, out = sim.wasps.length;
  $('nStores').innerHTML = [
    ['Queen', c.queenAlive ? 'laying' : c.nestAlive ? 'dead' : 'nest destroyed'],
    ...(c.sited !== false ? [['Site', `${T.sites[sim.nest.site || 'trunk'].name} · up to ${fmt(c.maxCells || T.sites.trunk.maxCells)} cells`]] : []),
    ['Adults inside / out', `${fmt(Math.max(0, c.adults - out))} / ${out}`],
    ['Young · guards out', `${fmt(c.young || 0)} still nursing · ${sim._own().filter((w) => w.role === 'guard' && w.id !== sim.drivenId).length} at the door`], // T1-13
    ['Protein', `${c.protein.toFixed(1)} / ${proteinCap(c).toFixed(0)}`], ['Sugar', `${c.sugar.toFixed(1)} / ${sugarCap(c).toFixed(0)}`], ['Pulp', c.pulp.toFixed(1)],
    ['Water', `${(c.water || 0).toFixed(1)} / ${waterCap(c).toFixed(0)}`], // T2-1
    ...(c.sited !== false ? [['Comb temperature', (() => { const h = sim.nestHeat(); return `${h.nestT.toFixed(1)} °C${h.cook > 0 && (c.cool ?? 1) < 0.95 ? ' · the brood is cooking' : h.heat > 0 ? ((c.cool ?? 1) > 0.95 ? ' · cooled with water' : ' · too hot, short of water') : ''}`; })()]] : []),
    ['Cells used', `${fmt(broodTotal(c))} / ${fmt(c.cells)}`], ['Larvae fed', Math.round(c.fed * 100) + '%'],
    ['Forage this season', (() => { const a = sim.ecoAvail(); return `sugar ${Math.round(a.sugar * 100)}% · protein ${Math.round(a.protein * 100)}%`; })()], // T1-8
    ...(c.sited !== false ? [['Brood speed', (() => { const v = sim.broodSpeed(); return `${Math.round(v * 100)}%${v < 0.98 ? (sim.temperature < T.thermal.coldFrom ? ' · too cold' : ' · too hot') : ''}`; })()]] : []),
    ['Weather', (() => { // today and tomorrow (T2-2): a heatwave coming is the time to bring water in
      const name = (w) => (w.kind === 'heat' ? 'heatwave' : w.kind === 'cold' ? 'cold snap' : w.kind === 'storm' ? 'storm in the afternoon' : w.rain ? 'showers' : 'fair') + ` (${Math.round(w.base)} °C)`;
      return `today ${name(sim.weatherToday)} · tomorrow ${name(dayWeather(sim.seed, sim.day + 1))}`;
    })()],
    ['Emerged · laid', `${fmt(c.stats.emerged)} · ${fmt(c.stats.laid)}`],
    ...(sim.muni && sim.muni.active ? [['Pest control', `${sim.muni.active.keys.includes(sim.nest.key) ? 'baits around the nest' : 'baits nearby'} · until ${dayLabel(sim.muni.active.until)}`]] : []),
    ...(c.stats.poisoned ? [['Lost to poison', fmt(c.stats.poisoned)]] : []),
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('nDeficit').style.width = (c.deficit * 100).toFixed(0) + '%';
  const max = Math.max(1, c.eggs, c.larvae, c.pupae);
  $('nBrood').innerHTML = [['Eggs', c.eggs], ['Larvae', c.larvae], ['Pupae', c.pupae]]
    .map(([k, v]) => `<span class="label">${k}</span><div class="b"><i style="width:${(v / max * 100).toFixed(0)}%"></i></div><span class="n">${fmt(v)}</span>`).join('');
  $('nRepro').innerHTML = [
    ['Queen cells (brood)', fmt(c.rEggs + c.rLarvae + c.rPupae)], ['Young queens in the nest', fmt(c.gynes)],
    ['Mated and gone to hibernate', fmt(c.mated)], ['Males', fmt(c.males)],
    ['Sister colonies of the line', sim.line.length ? sim.line.map((x) => `${fmt(x.colony.adults)} adults, ${fmt(broodTotal(x.colony))} brood ${Math.round(Math.hypot(x.nest.x - sim.nest.x, x.nest.z - sim.nest.z))} m off`).join(' · ') + (sim.lineage ? ` · ${fmt(sim.lineage)} more queens elsewhere` : '') : sim.lineage ? `${fmt(sim.lineage)} queens elsewhere` : 'none'], // T2-4
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  T.alloc.forEach((a, i) => $('alloc' + i).setAttribute('aria-pressed', c.alloc === i));
}

function updateLab() {
  const w = sim.wasp;
  $('lTick').textContent = fmt(sim.tick);
  $('lHash').textContent = sim.stateHash();
  $('lSeed').textContent = `${settings.seed} · ${settings.dayMinutes} min days`;
  $('lChunks').textContent = `${sim.records.size} / ${sim.activeChunks.length}`;
  $('lWasp').textContent = w ? `${w.state} · ${Math.hypot(w.vx, w.vy, w.vz).toFixed(2)} m/s · y ${w.y.toFixed(2)} m` : '-';
  const modes = {};
  for (const x of sim.wasps) if (x.id !== sim.drivenId) modes[x.ai.mode + ' ' + x.role] = (modes[x.ai.mode + ' ' + x.role] || 0) + 1;
  $('lAI').textContent = Object.entries(modes).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  const key = w ? chunkKey(chunkOf(w.x), chunkOf(w.z)) : '0,0';
  $('lEsc').textContent = `${(sim.chunkState.get(key)?.esc || 0).toFixed(1)} · level ${sim.escLevel(key)}`;
  const c = w && w.contact;
  if (c) {
    const hm = sim.humanByHex(c.humanHex);
    const cover = ['bare', 'thin cloth', 'thick cloth'][zoneCover(hm.clothing, c.zone)];
    let html = `<dl><dt>Human</dt><dd>#${hm.short}</dd><dt>Zone</dt><dd>${zoneLabel(c.zone)}</dd><dt>Cover</dt><dd>${cover}</dd><dt>Self reach</dt><dd>${c.reach.toFixed(2)}</dd>${c.openingKey ? `<dt>Opening</dt><dd>${c.openingKey}</dd>` : ''}</dl>`;
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
    $('lContact').innerHTML = html; $('lContact').className = '';
  } else { $('lContact').textContent = 'Fly within 2 cm of a person.'; $('lContact').className = 'label'; }
  let near = null, nd = Infinity;
  if (w) for (const hm of sim.active) { if (hm.state === 'away') continue; const d = Math.hypot(hm.x - w.x, hm.z - w.z); if (d < nd) { nd = d; near = hm; } }
  $('lHuman').innerHTML = near ? [
    ['ID', '#' + near.short], ['Distance', nd.toFixed(1) + ' m'], ['Height', near.tr.height.toFixed(2) + ' m'], ['Arm ratio', near.tr.armRatio.toFixed(2)],
    ['Flexibility', near.tr.flexibility.toFixed(2)], ['Girth', near.tr.girth.toFixed(2)], ['Stiffness (age)', near.tr.ageStiffness.toFixed(2)],
    ['Reaction', `${near.tr.reactionTicks} ticks · ${ms(near.tr.reactionTicks)} ms`], ['Swat style', StyleName[near.tr.style]], ['Accuracy', near.tr.accuracy.toFixed(2)],
    ['Panic', `${near.panic.toFixed(2)} · ${near.state}`], ['Sprays at level 3', near.tr.escalation >= T.esc.sprayTrait ? 'yes' : 'no'],
    ['Clothes', `${near.clothing.topOff ? 'shirt off' : TopName[near.clothing.top]}, ${BottomName[near.clothing.bottom]}`], ['Stung', near.stungCount + '×'],
    ['In the park', near.win ? `${fmtClock(near.win.arrive)}–${fmtClock(near.win.leave)}` : near.special ? 'on the job' : 'not today'],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') : '';
  $('lLog').innerHTML = ui.log.map((l) => `<div>${l}</div>`).join('');
  $('lNetSec').hidden = !lab;
  if (lab) {
    const L = LINKS[lab.linkName], c = lab.checks, err = lab.remoteError();
    $('lNet').innerHTML = [
      ['Link', `${L.name}`], ['One-way delay', `${ms(L.latency)}–${ms(L.latency + L.jitter)} ms`], ['Loss', `${Math.round(L.loss * 100)}%`],
      ['Commit window', `${T.net.commitTicks} ticks · ${ms(T.net.commitTicks)} ms`],
      ['Player 2', lab.b ? (lab.joined ? `joined after ${Math.round(lab.joined / 60)} s from a ${(lab.joinBytes / 1024).toFixed(0)} KB snapshot` : 'in from the start') : `joins in ${Math.ceil((lab.joinAt - sim.tick) / 60)} s`],
      ['Events sent / received', `${sim.netStats.sent} / ${sim.netStats.recv}`], ['Late events', `${sim.netStats.late + (lab.b ? lab.b.netStats.late : 0)}${sim.netStats.lateMax ? ` (max ${sim.netStats.lateMax} ticks)` : ''}`],
      ['Rules hash', lab.b ? `${rulesHash(sim.settings)} / ${rulesHash(lab.b.settings)}${rulesHash(sim.settings) === rulesHash(lab.b.settings) ? ' · same' : ' · DIFFERENT'}` : rulesHash(sim.settings)],
      ['Rejected by checks', `${sim.netStats.rejected}${sim.plaus.quarantined.length ? ' · player 2 quarantined' : ''}`],
      ['Rules here (chunk authority)', lab.b ? `player ${sim.chunkAuthority(sim.activeKey) + 1}${sim.claims.size ? ` · ${sim.claims.size} claim${sim.claims.size > 1 ? 's' : ''} waiting` : ''}` : '-'],
      ['Corrections (late events)', `${sim.netStats.fixes + (lab.b ? lab.b.netStats.fixes : 0)} sent · ${sim.netStats.fixed} applied here`],
      ['Humans agree', c.compared ? `${c.agreed}/${c.compared} checks${c.agreed === c.compared ? '' : ` · differed at tick ${c.firstDiverge}${c.lastDiverge > c.firstDiverge ? '–' + c.lastDiverge : ''}${c.last ? ', agree now' : ''}`}` : '-'],
      ['Player 2 drawn off by', err === null ? '-' : `${(err * 100).toFixed(1)} cm`],
      ['Your upstream', (() => { const b = lab.bandwidth(); return `${(b.total / 1024).toFixed(1)} KB/s · state ${(b.state / 1024).toFixed(1)}, swarm ${(b.swarm / 1024).toFixed(1)}, traffic ${(b.traffic / 1024).toFixed(2)}`; })()],
      // relevance tiers (T1-21): how player 2 hears about your wasps, from where its wasp is
      ['Your wasps to player 2', (() => {
        if (!lab.b) return '-';
        const R = T.relevance, ref = sim._peerRef(1), rc = [chunkOf(ref.x), chunkOf(ref.z)], n = { near: 0, mid: 0, far: 0 };
        for (const w of sim.wasps) {
          if (w.id === sim.drivenId) continue;
          if (Math.hypot(w.x - ref.x, w.z - ref.z) <= R.nearDist) n.near++;
          else if (Math.max(Math.abs(chunkOf(w.x) - rc[0]), Math.abs(chunkOf(w.z) - rc[1])) <= R.interestChunks) n.mid++; else n.far++;
        }
        return `driven at ${60 / T.net.stateEvery} Hz · ${n.near} near at ${60 / R.nearEvery} Hz · ${n.mid} in swarms at ${60 / R.midEvery} Hz · ${n.far} far as counts`;
      })()],
      ['Player 2 stings', lab.b ? `${lab.b.stats.stings}` : '-'],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }
}

// ------------------------------------------------------------------ HUD

function toast(text, color = 'var(--fg)', secs = 2.2) {
  const el = $('toast'); el.textContent = text; el.style.color = color; el.style.opacity = 1; toastTimer = secs;
}

const kbd = (k) => `<kbd>${k}</kbd>`;
function updateHud() {
  const w = sim.wasp, c = sim.colony;
  $('stungN').textContent = fmt(sim.stung.size);
  $('adults').textContent = fmt(c.adults);
  $('brood').textContent = fmt(broodTotal(c));
  $('serial').textContent = w ? (w.caste === 'queen' ? 'The queen' : w.caste === 'male' ? 'Male ' + w.id : 'Worker ' + w.id) : '-';
  const md = minuteOfDay(sim.minute);
  { const sc = timeScale(); $('clockT').textContent = `Day ${sim.day + 1} · ${fmtClock(sim.minute)}${sc > 1 ? ` · ${sc}×` : sc < 1 ? ' · REFLEX' : ''}`; }
  const wnd = sim.wind, ws = Math.hypot(wnd.x, wnd.z);
  const wxk = sim.weatherToday, spell = wxk.kind === 'heat' ? `heatwave ${wxk.spellDay}/${wxk.spellLen} · ` : wxk.kind === 'cold' ? `cold snap ${wxk.spellDay}/${wxk.spellLen} · ` : wxk.kind === 'storm' ? 'storm · ' : ''; // T2-2
  $('clockW').textContent = `${spell}${Math.round(sim.temperature)} °C · ${sim.raining ? (wxk.pour > 1 ? 'downpour' : 'rain') : md < T.time.dawn || md >= T.time.dusk ? 'night' : 'clear'} · ${ws < 0.5 ? 'calm' : `wind ${ws.toFixed(1)} m/s`}`;
  const frac = Math.min(1, Math.max(0, sim.seasonFrac));
  $('seasonBar').style.width = (frac * 100).toFixed(1) + '%';
  $('seasonT').textContent = `Season ${sim.season.n} · ${sim.season.phase}${sim.lineage > 0 ? ` · ${sim.lineage} sister nest${sim.lineage === 1 ? '' : 's'}` : ''}`;
  const e = sim.ext;
  const extT = e.state === 'scheduled' ? `Exterminator due ${dayLabel(e.arriveMinute)}` : e.state === 'active' && e.hm ? (e.hm.state === 'treat' ? 'Exterminator treating the nest' : e.hm.state === 'seek' || e.hm.state === 'watch' ? `Exterminator watching for flight lines, ${Math.round(Math.hypot(e.hm.x - sim.nest.x, e.hm.z - sim.nest.z))} m out` : e.hm.state === 'arrive' ? 'Exterminator heading for the nest' : 'Exterminator leaving') : '';
  const muniT = sim.muni && sim.muni.active ? `Pest control baits out until ${dayLabel(sim.muni.active.until)}` : '';
  $('ext').textContent = [extT, muniT].filter(Boolean).join(' · ');
  const lv = w ? sim.escAt(w.x, w.z) : 0;
  document.querySelectorAll('#alert i').forEach((el, i) => { el.className = i < lv ? (lv >= 3 ? 'on hot' : 'on') : ''; });
  if (!w) return;
  $('venomBar').style.width = (w.venom * 100).toFixed(1) + '%';
  { const life = w.caste === 'queen' ? 0 : Math.min(1, (sim.minute - (w.born ?? sim.minute)) / sim.lifespanMinutes(w)); $('ageRow').hidden = $('ageWrap').hidden = w.caste === 'queen'; $('ageBar').style.width = (life * 100).toFixed(1) + '%'; }
  $('cropBar').style.width = (w.energy * 100).toFixed(1) + '%';
  { const bt = w.bodyT ?? 30, cold = bt < T.cold.flyBody; // body temperature (GDD 10.2): 0 °C to the lethal heat of a grill
    $('bodyBar').style.width = Math.max(0, Math.min(100, bt / T.bbq.lethal * 100)).toFixed(1) + '%'; $('bodyWrap').classList.toggle('cold', cold); $('bodyWrap').classList.toggle('hot', bt > 36); $('bodyL').textContent = `Body ${Math.round(bt)} °C`; }
  $('cropBar').style.background = w.energy < 0.2 ? 'var(--red)' : '';
  $('ball').hidden = w.state !== 'balled';
  $('tickle').hidden = w.state !== 'perched';
  if (w.state === 'perched') $('tickleBar').style.width = Math.min(100, w.perch.tickle / w.perch.need * 100).toFixed(0) + '%';
  if (w.state === 'balled') $('heatBar').style.width = Math.min(100, (w.ball.temp - T.bees.startTemp) / (T.bees.lethal - T.bees.startTemp) * 100).toFixed(0) + '%';
  let status = '';
  if (w.state === 'attached') status = sim.tick - w.attach.start >= T.sting.jabTicks ? 'Stinging · release to pull out' : 'Stinging';
  else if (w.state === 'stunned') status = 'Stunned';
  else if (w.state === 'balled') status = `Balled by ${w.ball.bees || 0} bees · ${w.ball.temp.toFixed(1)} °C`;
  else if (w.state === 'under') status = 'Under the clothes';
  else if (w.state === 'chewing') status = w.chewAt && w.chewAt.water ? `Drinking water ${Math.round(w.chew / T.water.fillTicks * 100)}%` : `Chewing pulp ${Math.round(w.chew / T.pulp.chewTicks * 100)}%`;
  else if (w.state === 'trapped') status = 'Stuck in the trap';
  else if (w.state === 'webbed') status = `Stuck in a web · spider in ${Math.max(0, (w.web.spiderAt - sim.tick) / 60).toFixed(1)} s`;
  else if (w.state === 'landed') status = sim.feeding ? 'Feeding' : w.land && w.land.kind === 'flower' ? 'Flower drained · try the next' : 'Resting';
  else if (w.state === 'perched') status = `On #${w.perch.hex.slice(0, 4)} · ${zoneLabel(w.perch.zone)}`;
  else if (w.state === 'fighting') status = 'Fighting a rival wasp';
  else if (w.state === 'robbing') status = `Inside the hive · ${Math.round(Math.min(1, w.rob.progress) * 100)}% · mash LMB · Space bails out`;
  else if (w.state === 'drowning') status = `In the drink · ${Math.max(0, (w.drown.until - sim.tick) / 60).toFixed(1)} s`;
  else if (!sim._driven()) status = '';
  else if ((w.bodyT ?? 30) < T.cold.flyBody) status = (w.bodyT ?? 30) < T.cold.torpor ? 'Torpid with cold · find warmth or die' : 'Too cold to fly · warm up (rest, sun, a person)';
  else if (sim.feeding) status = 'Feeding';
  else if (w.energy <= 0) status = 'Crop empty · falling';
  else if (w.carry) status = `Carrying ${w.carry.what}`;
  else if (Math.hypot(w.vx, w.vy, w.vz) < 0.05) status = 'Hovering';
  if ((w.state === 'fly' || w.state === 'landed') && sim._grillAir(w) !== null) status = `Over the grill · ${Math.round(w.bodyT)} °C, cooked at ${T.bbq.lethal}`; // T1-10
  $('status').textContent = status;

  let hint = '';
  const h = sim.hint || {};
  if (w.state === 'balled') hint = `Mash ${kbd('Shift')} to break out`;
  else if (w.state === 'webbed') hint = `Mash ${kbd('Shift')} to tear free`;
  else if (w.state === 'drowning') hint = `Mash ${kbd('Space')} or ${kbd('Shift')} to climb out over the side`;
  else if (w.state === 'fighting') hint = `Mash ${kbd('LMB')} to sting it first`;
  else if (w.state === 'landed') hint = w.walking ? 'Walking · it follows the surface round edges, up trunks and under tables · look where you want to go' : `Resting costs no sugar in the warmth · mouse turns · ${kbd('W')}${kbd('A')}${kbd('S')}${kbd('D')} walk on any surface · ${kbd('LMB')} sting someone within reach · ${kbd('Space')} or ${kbd('Shift')} take off`;
  else if (w.state === 'perched') hint = `${kbd('W')}${kbd('A')}${kbd('S')}${kbd('D')} crawl (look up or down to climb) · ${kbd('LMB')} sting · ${kbd('Space')} take off · ${kbd('E')} crawl under at an opening`;
  else if (input.pilot) hint = `Flying to the ${targetLabel(sim, input.pilot)} · any move key takes over`;
  else if (input.lock && !h.prey && !h.opening && !h.water && !h.wood) hint = `Locked on the ${targetLabel(sim, input.lock)} · ${kbd('W')} close in · ${kbd('S')} back off · ${kbd('A')}${kbd('D')} circle${TARGET_KIND[input.lock.kind].go ? ` · ${kbd('E')} ${TARGET_KIND[input.lock.kind].go}` : ''} · ${kbd('V')} release`;
  else if (h.rival) hint = `${kbd('E')} steal a larva from the rival nest`;
  else if (h.raid !== null && h.raid !== undefined) hint = `${kbd('E')} steal a larva from player ${h.raid + 1}'s nest · their guards will come after you`;
  else if (h.hive) hint = `${kbd('E')} get into the hive for honey and brood · the bees inside fight back`;
  else if (h.hiber) hint = `${kbd('E')} scout this winter site for the young queens: ${T.hiber.name[h.hiber]}, shelter ${Math.round(T.hiber.q[h.hiber] * 100)}%`;
  else if (w.state === 'under') {
    const hm = sim.humanByHex(w.under.hex);
    const g = garmentGraph(hm.tr, hm.clothing, hm.posture, hm.parts[hm.posture]);
    const here = g[w.under.node];
    if (here) {
      const nb = here.links.map((l, i) => (i === w.under.sel ? `<b>[${g[l].key}]</b>` : g[l].key)).join(' · ');
      hint = `${here.key} · ${kbd('A')}${kbd('D')} choose ${nb} · ${kbd('W')} crawl · ${kbd('LMB')} sting${here.opening ? ` · ${kbd('E')} get out` : ''}`;
    }
  } else if (w.state === 'chewing') hint = `Keep holding ${kbd('E')}`;
  else if (h.opening) hint = `${kbd('E')} crawl in at the ${h.opening}`;
  else if (h.prey) hint = h.prey === 'carrion' ? `${kbd('E')} take a load of meat from the carcass` : h.prey === 'meat' ? `${kbd('E')} grab a piece of barbecue meat` : `${kbd('E')} catch the ${h.prey}`;
  else if (h.bait) hint = `${kbd('E')} take the meat from the station`;
  else if (h.water) hint = `Hold ${kbd('E')} to take water home${sim.nestHeat().heat > 0 ? ' · the nest is hot' : ''}`;
  else if (h.wood) hint = `Hold ${kbd('E')} to chew pulp`;
  else if (h.nest && (md < T.time.dawn || md >= T.time.dusk)) hint = `${kbd('R')} rest until morning`;
  else if (w.carry) hint = 'Bring it to the nest';
  else if (h.site) hint = `${kbd('E')} found the nest ${T.sites[h.site].name} · ${SITE_NOTE[h.site]}`;
  else if (w.caste === 'male') { // T2-3
    const lk = sim.lekSpot(), dd = Math.round(Math.hypot(lk.x - w.x, lk.z - w.z));
    hint = `A male: no sting, no work. Young queens come to the tallest tree near the nest (${dd} m) · fly into one to mate`;
  } else if (w.caste === 'queen' && sim.colony.sited === false) hint = 'Pick a nest site and press E: a trunk, a burrow in the grass, under a branch, or a gap in a shed';
  else if (w.caste === 'queen' && sim.colony.adults < 1) hint = 'Founding: chew pulp for cells, catch prey for the brood, bring both to the nest';
  $('hint').innerHTML = hint;

  const ret = $('reticle'), zl = $('zone'), ct = sim._driven() ? w.contact : null;
  ret.className = 'hud' + (ct && w.state === 'fly' ? (ct.blocked ? ' blocked' : ' contact') : '');
  if (ct && w.state === 'fly') {
    const hm = sim.humanByHex(ct.humanHex);
    const coverName = isLowerZone(ct.zone) ? BottomName[hm.clothing.bottom] : TopName[hm.clothing.top];
    zl.innerHTML = `${zoneLabel(ct.zone)}<small>${ct.blocked ? coverName + ' · can\'t sting through' : 'hold to sting'}</small>`;
  } else if (w.state === 'attached') zl.innerHTML = `${zoneLabel(w.attach.zone)}<small>${((sim.tick - w.attach.start) / 60).toFixed(2)} s in</small>`;
  else zl.innerHTML = '';
}
const dayLabel = (m) => (Math.floor(m / 1440) === sim.day ? fmtClock(m) : `day ${Math.floor(m / 1440) + 1}, ${fmtClock(m)}`);

// ------------------------------------------------------------------ minimap

const mapCtx = $('map').getContext('2d');
function drawMap() {
  const ctx = mapCtx, W = 336, cell = 48, span = 4, CSZ = T.chunk.size;
  const w = sim.wasp || { x: 0, z: 0 };
  const toS = (x, z) => [W / 2 - (x - w.x) / CSZ * cell, W / 2 - (z - w.z) / CSZ * cell];
  const ccx = chunkOf(w.x), ccz = chunkOf(w.z);
  ctx.clearRect(0, 0, W, W);
  const yellow = css('--yellow'), red = css('--red');
  for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) {
    const cx = ccx + dx, cz = ccz + dz, key = chunkKey(cx, cz);
    const [sx, sy] = toS((cx + 0.5) * CSZ, (cz + 0.5) * CSZ);
    const rec = sim.records.get(key);
    if (rec) {
      const use = rec.content.use || 'park';
      ctx.fillStyle = use === 'yards' ? 'hsla(95, 22%, 31%, 0.92)' : use === 'forest' ? 'hsla(100, 35%, 14%, 0.95)' : use === 'mall' ? 'hsla(40, 6%, 30%, 0.92)' : use === 'town' ? 'hsla(30, 18%, 42%, 0.95)' : `hsla(${88 + rec.content.tint * 20}, 30%, ${21 + rec.content.tint * 8}%, 0.92)`;
      ctx.fillRect(sx + 1, sy + 1, cell - 2, cell - 2);
      // streets and buildings (T1-12)
      ctx.fillStyle = 'rgba(30,30,32,.75)';
      for (const r of rec.content.roads || []) { const [x0, y0] = toS(r.maxx, r.maxz), [x1, y1] = toS(r.minx, r.minz); ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.max(2, Math.abs(y1 - y0))); }
      for (const l of rec.content.loops || []) { const [x, y] = toS(l.x, l.z); ctx.beginPath(); ctx.arc(x, y, l.r / CSZ * cell, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = 'rgba(214,206,190,.55)';
      for (const sh of rec.content.sheds || []) if (sh.house) { const [x, y] = toS(sh.x, sh.z); ctx.fillRect(x - sh.hw / CSZ * cell, y - sh.hd / CSZ * cell, sh.hw * 2 / CSZ * cell, sh.hd * 2 / CSZ * cell); }
      for (const m of rec.content.malls || []) { const [x, y] = toS(m.x, m.z); ctx.fillRect(x - m.hw / CSZ * cell, y - m.hd / CSZ * cell, m.hw * 2 / CSZ * cell, m.hd * 2 / CSZ * cell); }
      const lv = sim.escLevel(key);
      if (lv) { ctx.fillStyle = `rgba(229,65,45,${0.1 + lv * 0.1})`; ctx.fillRect(sx + 1, sy + 1, cell - 2, cell - 2); }
      ctx.fillStyle = 'rgba(243,238,226,.4)';
      for (const t of rec.content.tables) { const [x, y] = toS(t.x, t.z); ctx.fillRect(x - 2, y - 2, 4, 4); }
      ctx.fillStyle = '#ece8dc';
      for (const hv of sim.hivesIn(rec)) { const [x, y] = toS(hv.x, hv.z); ctx.fillRect(x - 3, y - 3, 6, 6); }
      if (rec.content.rival) { const [x, y] = toS(rec.content.rival.x, rec.content.rival.z); ctx.strokeStyle = css('--orange'); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke(); }
    } else { ctx.strokeStyle = 'rgba(165,157,138,.2)'; ctx.strokeRect(sx + 1.5, sy + 1.5, cell - 3, cell - 3); }
    if (Math.abs(dx) <= T.chunk.activeRadius && Math.abs(dz) <= T.chunk.activeRadius) { ctx.strokeStyle = 'rgba(246,199,0,.3)'; ctx.strokeRect(sx + 0.5, sy + 0.5, cell - 1, cell - 1); }
  }
  for (const hm of sim.active) {
    if (hm.state === 'away') continue;
    const [x, y] = toS(hm.x, hm.z);
    ctx.fillStyle = hm.special ? red : hm.panic > 0.5 ? red : sim.stung.has(hm.hex) ? yellow : 'rgba(243,238,226,.85)';
    ctx.fillRect(x - 2, y - 2, hm.special ? 6 : 4, hm.special ? 6 : 4);
  }
  ctx.fillStyle = 'rgba(246,199,0,.8)';
  for (const x of sim.wasps) { if (x.id === sim.drivenId) continue; ctx.fillStyle = x.colony === 'own' ? 'rgba(246,199,0,.8)' : css('--orange'); const [px, py] = toS(x.x, x.z); ctx.fillRect(px - 1, py - 1, 2, 2); }
  // other players' wasps (T1-21): near and mid ones as dots; far traffic as a count per chunk, a cluster of dots where
  // the chunk is on the map and a tick at the edge of the map, pointing at it, where it is off it
  const blue = '#4fd1ff';
  ctx.fillStyle = blue;
  for (const [, r] of sim.remote) { if (r.rival) continue; const [px, py] = toS(r.x, r.z); ctx.fillRect(px - 2, py - 2, 4, 4); }
  // other players' nests (colony against colony)
  ctx.strokeStyle = blue; ctx.lineWidth = 2;
  for (const [, n] of sim.peerNests) { if (!n.alive) continue; const [px, py] = toS(n.x, n.z); ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.stroke(); }
  const far = new Map();
  for (const [, tr] of sim.remoteTraffic) for (const [k, n] of tr.chunks) far.set(k, (far.get(k) || 0) + n);
  ctx.font = '600 18px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [k, n] of far) {
    const [cx, cz] = k.split(',').map(Number), [sx, sy] = toS((cx + 0.5) * CSZ, (cz + 0.5) * CSZ);
    if (sx > 4 && sx < W - 4 && sy > 4 && sy < W - 4) {
      for (let i = 0; i < Math.min(n, 9); i++) { const a = i * 2.4, rr = 4 + 4 * Math.sqrt(i); ctx.fillRect(sx + rr * Math.cos(a) - 2, sy + rr * Math.sin(a) - 2, 4, 4); }
      if (n > 9) ctx.fillText(String(n), sx, sy - 20);
    } else {
      const dx = sx - W / 2, dy = sy - W / 2, m = (W / 2 - 12) / Math.max(Math.abs(dx), Math.abs(dy));
      const ex = W / 2 + dx * m, ey = W / 2 + dy * m, ang = Math.atan2(dy, dx);
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-4, -8); ctx.lineTo(-4, 8); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillText(String(n), ex - Math.cos(ang) * 20, ey - Math.sin(ang) * 20);
    }
  }
  const [nx, ny] = toS(sim.nest.x, sim.nest.z);
  ctx.strokeStyle = sim.colony.nestAlive ? yellow : red; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(nx, ny, 5, 0, Math.PI * 2); ctx.stroke();
  ctx.save(); ctx.translate(W / 2, W / 2); ctx.rotate(-input.yaw);
  ctx.fillStyle = yellow; ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------ events

// One line on why it happened, so a death teaches something (GDD 8.2: the outcome is fixed; the player should be able to read it)
const SITE_NOTE = {
  trunk: 'medium nest, sheltered',
  ground: 'biggest nest, floods in rain, people notice it fastest',
  branch: 'small nest, cold in rain, hardest to find',
  wall: 'big nest, sheltered, people use the shed',
  attic: 'biggest nest, best shelter, rare, hot on sunny afternoons',
  hollow: 'big nest, warmest in a cold snap, people rarely notice it',
};

function deathWhy(e) {
  const d = e.detail || {};
  if (e.cause === 'taken by a bird') return 'Birds hunt wasps in open air above head height. Keep low or under the trees.';
  if (e.cause === 'taken by a dragonfly') return 'Dragonflies hunt low over open ground. They outrun you but turn worse: break hard, land, or stay under the trees.';
  if (e.cause === 'eaten by a spider') return 'Webs hang between trees. Mash Shift the moment you stick.';
  if (e.cause === 'cooked by bees') return 'Bees ball an intruder and heat it. Mash Shift before it reaches 46 °C.';
  if (e.cause === 'drowned in a trap') return 'Sweet-smelling bottles at alert level 3 are traps.';
  if (e.cause === 'drowned in a drink') return 'Cups are deep. Feed just above the drink without touching it, and mash Space or Shift the moment you slip in.';
  if (e.cause === 'stung inside a hive') return 'Every second inside a hive is a chance for the bees to get you. Mash to grab fast, or bail out with Space.';
  if (e.cause === 'burned on a grill') return 'A lit grate burns on contact. Grab the meat from just above it, never land on it.';
  if (e.cause === 'cooked over a grill') return 'The air over a lit grill heats you in a second or two. Dive in, grab, and get out; watch your body temperature.';
  if (e.cause === 'drowned under a lid') return 'Someone saw you go into their drink and covered it. Don\'t linger inside a cup in front of people.';
  if (e.cause === 'cold') return 'Below about 8 °C a wasp goes torpid and dies. Get home before cold nights, or warm up on a person.';
  if (e.cause === 'insecticide') return 'Some people carry spray once the area is alert. Stay out of the cone in front of them.';
  if (e.cause === 'old age') return 'Workers live a few weeks. Take over a younger sister with Q.';
  if (e.cause === 'starved') return 'Your crop ran empty. Feed at flowers, cans or plates before it does.';
  if (e.cause.startsWith('killed by a rival')) return 'Rival wasps defend their nest. Mash sting to win a fight.';
  if (!d.own && d.why !== undefined) return 'You were caught in a swat aimed at another wasp.';
  switch (d.why) {
    case 'stung': return `You stung and were still there when the hand arrived (${ms(d.delay)} ms). Jab and pull out sooner.`;
    case 'stungUnder': return 'You stung under the clothing; the hand pressed you flat through it.';
    case 'felt under clothing': return 'They felt you moving under the clothing and pressed.';
    case 'felt': return 'They felt you crawling on them. Bare skin and the face give you away fastest.';
    case 'face': return 'You hovered in front of a face. Everyone swats at that.';
    case 'head': return 'You hovered around a head in an alert area.';
    case 'food': return 'You hung around their food in an alert area.';
    default: return '';
  }
}
const DEATH_TITLE = { 'eaten by a spider': 'EATEN', 'taken by a bird': 'TAKEN', 'killed by a rival wasp': 'KILLED', slap: 'SWATTED', cover: 'SMOTHERED', 'crushed under clothing': 'CRUSHED', insecticide: 'SPRAYED', 'drowned in a trap': 'DROWNED', 'cooked by bees': 'COOKED', starved: 'STARVED', 'old age': 'SPENT', 'taken by a dragonfly': 'TAKEN', cold: 'CHILLED', 'drowned in a drink': 'DROWNED', 'drowned under a lid': 'SHUT IN', 'stung inside a hive': 'STUNG', 'burned on a grill': 'BURNED', 'cooked over a grill': 'GRILLED' };

function pushSwatAnims(list, frameHex, contactTick) {
  const frame = sim.humanByHex(frameHex);
  for (const s of list) {
    const actor = sim.humanByHex(s.actorHex);
    let side = 1;
    if (s.actorHex === frameHex) side = s.center.x > 0.02 ? -1 : 1;
    else if (actor && frame) { const lp = toLocal(actor, toWorld(frame, s.center)); side = lp.x >= 0 ? 1 : -1; }
    anims.push({ ...s, frameHex, contactTick, side, flail: actor && actor.tr.style === 1 });
  }
}

// Anything aimed at the driven wasp: Reflex slows time when a hand is scheduled, and a sped-up clock drops to 1×
const HAND = new Set(['preSwat', 'notice', 'press']);
const DANGER = new Set(['webbed', 'balled', 'fellIn', 'birdDive', 'dragonDive', 'stunned', 'fight', 'trapped', 'waspDied']);
function threatCue(e) {
  const me = sim.drivenId;
  if (HAND.has(e.type) && e.waspId === me) { reflex(); calmTime('Someone is swatting at you'); return; }
  if (e.type === 'stingContact' && e.driven && e.swats && e.swats.length) { reflex(); calmTime('You stung someone'); return; }
  if (DANGER.has(e.type) && (e.driven || e.id === me || e.target === me)) calmTime('Danger');
}

function handleEvents(events) {
  for (const e of events) {
    threatCue(e);
    switch (e.type) {
      case 'chunksActive':
      case 'humansActive': syncChunks(); break;
      case 'stingContact':
      case 'remoteSting': {
        const v = humanViews.get(e.humanHex);
        if (v) v.flinch = 1;
        { const hm = sim.humanByHex(e.humanHex); if (hm && near(hm, 6)) yelp(hm.tr.height); }
        pushSwatAnims(e.swats, e.humanHex, e.contactTick);
        if (e.type === 'stingContact' && e.first && e.driven) { const b = $('bump'); b.textContent = '+1 · ' + zoneLabel(e.zone); b.style.opacity = 1; bumpTimer = 1.6; }
        if (e.type === 'remoteSting') logEvent(`player 2 stung #${e.humanHex.slice(0, 4)} · ${zoneLabel(e.zone)}`);
        break;
      }
      case 'sting':
        if (!e.remote) logEvent(`${e.driven ? 'you stung' : 'a worker stung'} #${e.humanHex.slice(0, 4)} · ${zoneLabel(e.zone)}${e.under ? ' (under clothes)' : ''}`);
        break;
      case 'remoteDied': logEvent(`player 2's wasp died · ${e.cause}`); break;
      case 'lateEvent': logEvent(`late ${e.evType} event (${e.by} ticks)`); break;
      case 'preSwat':
        pushSwatAnims([{ actorHex: e.humanHex, kind: e.kind, start: e.start, window: e.window, center: e.center }], e.humanHex, e.contactTick ?? e.t);
        if (e.waspId === sim.drivenId) logEvent(`#${e.humanHex.slice(0, 4)} swats at you (${e.why})`);
        break;
      case 'press':
        pushSwatAnims([{ actorHex: e.humanHex, kind: SwatKind.Slap, start: e.start, window: 8, center: e.center }], e.humanHex, e.contactTick ?? e.t);
        break;
      case 'deepen': logEvent(`full sting #${e.humanHex.slice(0, 4)}`); break;
      case 'blocked': toast(`${zoneLabel(e.zone)} is covered. Can't sting through.`, 'var(--muted)', 1.6); break;
      case 'noVenom': toast('Out of venom', 'var(--muted)', 1.4); break;
      case 'swatStrike': { const h = sim.humanByHex(e.actorHex); if (h && near(h, 4)) thwack(0.25); break; }
      case 'swatHit': if (e.waspId === sim.drivenId) logEvent(`${SwatKindName[e.kind].toLowerCase()} by #${e.actorHex.slice(0, 4)} at ${ms(e.delayTicks)} ms`); break;
      case 'stunned': if (e.driven) toast('Knocked away · stunned', 'var(--yellow)', 1.6); break;
      case 'flee': logEvent(`#${e.humanHex.slice(0, 4)} runs`); break;
      case 'mated': if (e.driven) toast('Mated. A male mates once, and that is his life.', 'var(--yellow)', 3); else if (sim.wasps.length) toast('A young queen of the line has mated', 'var(--yellow)', 1.6); break; // T2-3
      case 'knockedDown': if (e.driven) toast('Knocked down by the rain · get under a table, a roof or a tree', 'var(--red)', 2.4); break; // T2-2
      case 'exhausted': if (e.id === sim.drivenId) toast('Crop empty · feed on flowers or soda', 'var(--red)', 2.6); break;
      case 'caught': if (e.id === sim.drivenId) { toast(`Caught a ${e.kind}`, 'var(--yellow)', 1.4); blip(900, 600, 0.08, 0.05, 'square'); } break;
      case 'chewed': if (e.id === sim.drivenId) toast('Pulp ready · bring it home', 'var(--yellow)', 1.4); break;
      case 'watered': if (e.id === sim.drivenId) toast('Water taken · bring it home to cool the comb', 'var(--yellow)', 1.4); break;
      case 'deposit': if (e.id === sim.drivenId) { toast(`Delivered ${e.what}`, 'var(--yellow)', 1.2); blip(500, 750, 0.12, 0.05, 'triangle'); } break;
      case 'underEnter': if (e.id === sim.drivenId) toast(`In at the ${e.key}. Keep moving.`, 'var(--yellow)', 1.8); break;
      case 'rip': toast(`#${e.humanHex.slice(0, 4)} tears the shirt off`, 'var(--orange)', 2); logEvent(`#${e.humanHex.slice(0, 4)} rips the shirt off`); break;
      case 'trapped': if (e.driven) toast('Stuck in the sugar trap', 'var(--red)', 2); break;
      case 'spray': logEvent(`#${e.humanHex.slice(0, 4)} sprays`); break;
      case 'escalation': toast(['Neighborhood calm again', 'People start swatting', 'Food covered · citronella out', 'Sprays and traps out', 'They called an exterminator'][e.level], e.level >= 3 ? 'var(--red)' : 'var(--orange)', 2.6); break;
      case 'beeAlarm': logEvent('the hive is alarmed'); break;
      case 'balled': if (e.driven) toast('Balled by bees · mash Shift', 'var(--red)', 2.2); break;
      case 'ballEscape': if (e.id === sim.drivenId) toast('Broke free', 'var(--yellow)', 1.4); break;
      case 'aiAttack': logEvent(`worker ${e.id} attacks #${e.humanHex.slice(0, 4)}`); break;
      case 'alarm': logEvent('alarm pheromone'); break;
      case 'extScheduled': toast(`Exterminator booked for ${dayLabel(e.arriveMinute)}`, 'var(--red)', 3); logEvent('exterminator booked'); break;
      case 'spill': logEvent('a drink went over · open sugar on the table'); break;
      case 'quarantine': toast('Player 2 failed the plausibility checks and was cut off', 'var(--red)', 3); logEvent(`peer ${e.peer} quarantined`); break;
      case 'implausible': logEvent(`rejected ${e.evType} from peer ${e.peer}: ${e.why}`); break;
      case 'dragonDive': if (e.driven) toast('Dragonfly! Turn hard or land', 'var(--red)', 1.6); break;
      case 'dragonMiss': if (e.id === sim.drivenId) toast('It missed', 'var(--yellow)', 1.2); break;
      case 'muniStart': toast('The council sent pest control. Bait stations on the trees.', 'var(--red)', 3.4); logEvent(`pest control: ${e.keys.length} chunks baited`); break;
      case 'muniEnd': logEvent('pest control packed up'); break;
      case 'baitTaken': if (e.driven) toast('Meat from the station', 'var(--yellow)', 1.4); break;
      case 'poisoned': if (e.id === sim.drivenId) toast('The brood is dying. That meat was poisoned.', 'var(--red)', 3.4); else logEvent(`a forager brought poison home · ${fmt(e.adults + e.larvae)} died`); break;
      case 'extArrive': toast(e.known ? 'The exterminator is back and knows where the nest is.' : e.taped ? 'The exterminator is back, watching for flight lines. Collar taped.' : 'The exterminator is here, watching for flight lines. Keep traffic low, or get under his collar.', 'var(--red)', 3.6); break;
      case 'extLine': logEvent(`exterminator follows a flight line (${e.lines})`); break;
      case 'extFound': toast('The exterminator has spotted the nest', 'var(--red)', 3); logEvent('exterminator found the nest'); break;
      case 'extGiveUp': toast('The exterminator calls it a day. He will be back.', 'var(--yellow)', 3); logEvent(`exterminator gave up for today after ${e.lines} line${e.lines === 1 ? '' : 's'}`); break;
      case 'guardHunt': logEvent(`a guard chases off ${e.player ? "another player's wasp" : 'a rival wasp'}`); break;
      case 'guardOut': logEvent('a guard takes up post at the entrance'); break;
      case 'fetchSpray': logEvent(`#${e.humanHex.slice(0, 4)} goes for a can of spray`); break;
      case 'cookStart': logEvent(`#${e.humanHex.slice(0, 4)} lights the barbecue`); break;
      case 'cookEnd': logEvent(`#${e.humanHex.slice(0, 4)} is done at the grill`); break;
      case 'armed': logEvent(`#${e.humanHex.slice(0, 4)} is back with spray`); break;
      case 'extAbort': toast('The exterminator gives up for today', 'var(--yellow)', 3); break;
      case 'extCancelled': toast('Exterminator cancelled', 'var(--yellow)', 2.4); break;
      case 'nestDestroyed': toast('The nest is destroyed', 'var(--red)', 4); logEvent(`nest destroyed · ${e.died} inside died`); break;
      case 'possess': waspSwitched(e.id); logEvent(`now driving worker ${e.id}`); break;
      case 'noSwitch': toast('No worker to take over', 'var(--muted)', 1.4); break;
      case 'switchPending': toast(`Relaying through the colony · ${e.seconds} s · Q cancels`, 'var(--muted)', 2.2); break;
      case 'switchCancelled': toast('Switch cancelled', 'var(--muted)', 1.2); break;
      case 'cantRest': toast(e.why === 'day' ? 'Rest only at night' : e.why === 'net' ? 'No resting with a second player' : 'Rest at the nest entrance', 'var(--muted)', 1.6); break;
      case 'rested': toast('Morning', 'var(--yellow)', 1.6); break;
      case 'newDay': logEvent(`day ${e.day + 1}`); saveWorld(false); break;
      case 'season': {
        const msg = { Growth: 'The first workers are out. Growth season.', Peak: 'Peak season. The queen starts laying queen cells.', Collapse: 'Autumn. The colony is dying off. Young queens are leaving to mate.' }[e.phase];
        if (msg) toast(msg, 'var(--yellow)', 3.5);
        logEvent(`season: ${e.phase}`);
        break;
      }
      case 'queenDied': toast('The queen is dead', 'var(--red)', 3); logEvent(`the queen died · ${e.cause}`); break;
      case 'webbed': if (e.driven) { toast('Stuck in a web · mash Shift', 'var(--red)', 2); blip(300, 260, 0.2, 0.05, 'triangle'); } break;
      case 'webEscape': if (e.id === sim.drivenId) toast('Tore free', 'var(--yellow)', 1.2); break;
      case 'fellIn': if (e.driven) { toast('Slipped into the drink · mash Space or Shift', 'var(--red)', 2); blip(420, 180, 0.25, 0.05, 'sine'); } break;
      case 'climbedOut': if (e.id === sim.drivenId) toast('Climbed out, sticky', 'var(--yellow)', 1.2); break;
      case 'robStart': if (e.driven) { toast(e.feral ? 'Into the wild hive · mash LMB to grab' : 'Into the hive · mash LMB to grab', 'var(--red)', 1.8); } break;
      case 'robbed': if (e.driven) toast('Honey and brood · now get out, the hive is up', 'var(--yellow)', 2.2); else logEvent(`worker ${e.id} robbed a hive`); break;
      case 'hiveEmpty': if (e.id === sim.drivenId) toast('Nothing left in this hive today', 'var(--muted)', 2); break;
      // contested pickups (T1-19): the chunk authority gave it to another player's wasp
      case 'claimLost': if (e.driven) toast(`Another player's wasp got the ${e.what === 'honey' ? 'brood' : e.what} first`, 'var(--muted)', 2.2); else logEvent(`worker ${e.id} lost the ${e.what} to another player`); break;
      case 'claimDenied': logEvent(`ruled for the first wasp to the ${e.what}; peer ${e.peer} was too late`); break;
      case 'robAbort': if (e.id === sim.drivenId) toast('Bailed out', 'var(--muted)', 1.2); break;
      case 'cover': logEvent(`#${e.humanHex.slice(0, 4)} covers a drink`); break;
      case 'coveredIn': if (e.driven) toast('Covered! Shut in the cup', 'var(--red)', 2); break;
      case 'takeoff':
        // the camera picks up the heading the wasp had on the surface (GDD 7.2)
        if (e.id === sim.drivenId && typeof e.hx === 'number') { input.yaw = Math.atan2(e.hx, e.hz); input.pitch = Math.max(-1.2, Math.min(1.2, Math.asin(Math.max(-1, Math.min(1, e.hy))))); }
        break;
      case 'birdDive': if (e.driven) { toast('A bird is diving at you · get low or under a tree', 'var(--red)', 2.4); blip(2600, 1800, 0.3, 0.06, 'sine'); } break;
      case 'birdMiss': toast('The bird missed', 'var(--yellow)', 1.2); break;
      case 'fight': if (e.driven) toast('Grappling a rival wasp · mash LMB', 'var(--red)', 1.8); break;
      case 'fightOver': logEvent(`fight: worker ${e.winner} killed worker ${e.loser}`); break;
      case 'raid': toast(e.peer !== undefined ? `Stole a larva from player ${e.peer + 1}'s nest · get it home` : 'Stole a larva · their workers are coming', 'var(--orange)', 2.2); break;
      case 'raided': toast(`Player ${e.by + 1} stole a larva from your nest · your guards are after them`, 'var(--red)', 2.6); logEvent(`player ${e.by + 1} raided the nest`); break;
      case 'notice':
        pushSwatAnims(e.swats, e.humanHex, e.contactTick);
        if (e.waspId === sim.drivenId) toast('They felt you · get off', 'var(--red)', 1.6);
        logEvent(`#${e.humanHex.slice(0, 4)} felt a wasp on the ${zoneLabel(e.zone).toLowerCase()}`);
        break;
      case 'perch': if (sim.wasp && e.id === sim.drivenId) logEvent(`perched on #${e.humanHex.slice(0, 4)}`); break;
      case 'knockedOff': if (e.id === sim.drivenId) toast('Knocked off', 'var(--yellow)', 1.2); break;
      case 'nestFounded': toast(e.auto ? 'The queen settled in a tree near where she wintered' : 'Nest founded', 'var(--yellow)', 2.4); logEvent('nest founded'); break;
      case 'winter':
        {
          const total = e.survivors + e.lineage;
          if (!lab && sim.winter) showWinter(`${e.why === 'autumn' ? 'The colony died with the autumn, as colonies do.' : 'Your colony did not make it through the season.'} ${fmt(e.mated)} young queen${Math.round(e.mated) === 1 ? '' : 's'} mated and went into hibernation; ${e.survivors} survived the cold.${e.lineage ? ` ${e.lineage} older sister nest${e.lineage === 1 ? '' : 's'} of your line also made it.` : ''} ${total > 1 ? 'Choose which queen you wake as; the others found sister nests.' : 'You wake as the last queen of the line.'}`);
        }
        break;
      case 'sisterFounded': logEvent(`a sister colony of the line was founded ${Math.round(Math.hypot(e.x - sim.nest.x, e.z - sim.nest.z))} m away`); break; // T2-4
      case 'sisterLost': toast('A sister colony of the line has died out', 'var(--red)', 2); break;
      case 'sisterTakeover': toast(`Your colony is gone. The line goes on: you are now a worker of a sister colony (${e.adults} adults).`, 'var(--yellow)', 4); syncNests(); break;
      case 'hiberScouted': toast(`Winter site scouted: ${T.hiber.name[e.kind]}. Most of the young queens will winter here.`, 'var(--yellow)', 3); break;
      case 'spring':
        logEvent(`season ${e.season} · you are the queen, waking ${T.hiber.name[e.kind] || ''}`);
        waspSwitched(e.id, 0.98);
        syncChunks();
        break;
      case 'waspDied': {
        if (!e.driven) { logEvent(`worker ${e.id} died · ${e.cause}`); break; }
        deathSpot = new THREE.Vector3(e.x, e.y, e.z);
        const by = e.byHex ? ` by #${e.byHex.slice(0, 4)}` : '';
        const sw = anims.find((a) => a.actorHex === e.byHex);
        const when = sw && e.cause !== 'insecticide' ? ` · ${ms(sw.start - sw.contactTick)} ms after contact` : '';
        $('deadTitle').textContent = DEATH_TITLE[e.cause.replace(' (helper)', '')] || 'DEAD';
        $('deadSub').textContent = `${e.cause}${by}${when} · ${sim.colony.queenAlive ? fmt(e.adultsLeft) + ' adults left' : 'the queen is gone'}`;
        $('deadWhy').textContent = deathWhy(e);
        $('dead').hidden = false;
        deadUntil = performance.now() + 2400;
        logEvent(`you died · ${e.cause}`);
        break;
      }
      case 'respawn':
        waspSwitched(e.id, e.yaw);
        $('dead').hidden = true;
        logEvent(`worker ${e.id} leaves the nest`);
        break;
      case 'waitingBrood': toast('The nest is empty. Waiting for brood to emerge.', 'var(--muted)', 3); break;
      case 'lineExtinct':
        try { if (!lab) { localStorage.removeItem('sting.save'); localStorage.removeItem('sting.saveMeta'); showContinue(); } } catch { /* optional */ }
        $('dead').hidden = true;
        $('extinctStats').textContent = `No young queen survived the winter and no sister nest is left. ${sim.season.n} season${sim.season.n === 1 ? '' : 's'}, ${sim.day + 1} days. ${fmt(sim.stung.size)} humans stung (${fmt(sim.stats.stings)} by you, ${fmt(sim.stats.aiStings)} by workers). ${fmt(sim.stats.deaths)} wasps lost. ${fmt(sim.records.size)} chunks discovered.`;
        $('extinctScreen').hidden = false;
        document.exitPointerLock?.();
        break;
    }
  }
}

function waspSwitched(id, yaw) {
  const w = sim.waspById(id);
  if (!w) return;
  input.yaw = yaw ?? (Math.hypot(w.vx, w.vz) > 0.05 ? Math.atan2(w.vx, w.vz) : input.yaw);
  input.pitch = 0;
  pos.set(id, { p: V(w), c: V(w) });
  if (yaw !== undefined) camOff.set(-Math.sin(yaw) * 0.3, 0.1, -Math.cos(yaw) * 0.3);
}

// ------------------------------------------------------------------ camera and frame

// The stare (GDD 12, key-art direction): hovering in front of someone's face pulls in letterbox bars, narrows the
// lens and thins the soundscape. Presentation only; the sim never sees it.
let stare = 0;
function updateStare(dt) {
  const w = sim._driven();
  let k = 0;
  if (w && running && !paused && (w.state === 'fly' || w.state === 'perched')) {
    const fwd = { x: Math.sin(input.yaw + input.free.yaw), z: Math.cos(input.yaw + input.free.yaw) };
    for (const hm of sim.active) {
      if (hm.state === 'away' || Math.abs(hm.x - w.x) > 1.2 || Math.abs(hm.z - w.z) > 1.2) continue;
      const head = hm.parts[hm.posture][0], lp = toLocal(hm, w);
      const dx = lp.x - head.a.x, dy = lp.y - head.a.y, dz = lp.z - head.a.z, d = Math.hypot(dx, dy, dz);
      if (d > 0.7 || dz < 0.04) continue; // in front of the face only
      const hw = toWorld(hm, head.a), hx = hw.x - w.x, hz = hw.z - w.z, hl = Math.hypot(hx, hz) || 1;
      const facing = (fwd.x * hx + fwd.z * hz) / hl;
      k = Math.max(k, Math.min(1, (0.7 - d) / 0.4) * (facing > 0.75 ? 1 : 0.25));
    }
  }
  stare += (k - stare) * (1 - Math.exp(-dt * (k > stare ? 2.5 : 4)));
  const h = (stare * 11).toFixed(2) + 'vh';
  $('barTop').style.height = h; $('barBot').style.height = h;
  const fov = 70 - stare * 22;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// The wasp carries the camera: the camera's position is the wasp's position plus an offset, so flight itself adds
// no lag or pull. Only the offset (where the camera sits around the wasp) is smoothed.
// Holding RMB switches to the wasp's own eyes: a free first-person look all the way round. Letting go blends back
// out to the chase view behind the direction of travel.
const camOff = new THREE.Vector3(0, 0.03, -0.1);
// Scent cues (GDD 7.3, 10.2): which way the strongest sugar, meat and alarm scents come from, as small markers around
// the crosshair. They are the AI's own senses (sim.smellAt): reach depends on the source and carries downwind, spills
// fade as they dry, carrion grows stronger. The wasp smells, it does not see, so walls and trees do not block it.
// Prey that moves (flies) is not smelled: you see it. Bees roused at a hive add to the alarm.
function nearestScents(w) {
  const out = sim.smellAt(w);
  for (const al of sim.hiveAlarms.values()) {
    const rec = sim.records.get(al.key), hv = rec && sim.hivesIn(rec)[al.h];
    if (!hv) continue;
    const d = Math.hypot(hv.ex - w.x, hv.ez - w.z), s = 1 - d / T.bees.hiveAlarmRadius;
    if (s > 0 && (!out.alarm || s > out.alarm.s)) out.alarm = { s, x: hv.ex - w.x, z: hv.ez - w.z };
  }
  return out;
}
let scentTimer = 0, scentCache = null;
function updateScents(dt) {
  const w = sim._driven();
  const show = w && running && !paused && eyeBlend < 0.5;
  if ((scentTimer -= dt) <= 0 && w) { scentCache = nearestScents(w); scentTimer = 0.25; }
  for (const [k, id] of [['sugar', 'scentSugar'], ['protein', 'scentProtein'], ['alarm', 'scentAlarm']]) {
    const el = $(id), p = scentCache && scentCache[k];
    if (!show || !p || p.s <= 0) { el.style.opacity = 0; continue; }
    const ang = Math.atan2(p.x, p.z) - input.yaw; // 0 = straight ahead
    const r = 34 + (k === 'alarm' ? 10 : k === 'protein' ? 5 : 0);
    el.style.transform = `translate(${(-Math.sin(ang) * r - 6).toFixed(1)}px, ${(-Math.cos(ang) * r - 5).toFixed(1)}px) rotate(${(-ang).toFixed(3)}rad)`;
    el.style.opacity = (0.25 + 0.75 * p.s).toFixed(2);
  }
}

const camUp = new THREE.Vector3(0, 1, 0);
function updateCamera(p, dt) {
  const w = sim.wasp;
  const dead = !sim._driven();
  const fl = input.free;
  eyeBlend = fl.held && !dead ? Math.min(1, eyeBlend + dt / 0.12) : Math.max(0, eyeBlend - dt / 0.35);
  if (!fl.held && eyeBlend === 0) { fl.yaw = 0; fl.pitch = 0; }
  // chase view: always behind the heading. Landed, the heading is the wasp's own along the surface, and the mouse
  // pitch tilts the view toward or away from the surface, so turning feels the same on a trunk or under a table.
  const ld = !dead && w && w.state === 'landed' && w.land && typeof w.land.hx === 'number' ? w.land : null;
  const fwd = ld
    ? new THREE.Vector3(ld.hx, ld.hy, ld.hz).multiplyScalar(Math.cos(input.pitch)).addScaledVector(new THREE.Vector3(ld.nx, ld.ny, ld.nz), Math.sin(input.pitch))
    : new THREE.Vector3(Math.sin(input.yaw) * Math.cos(input.pitch), Math.sin(input.pitch), Math.cos(input.yaw) * Math.cos(input.pitch));
  // the camera's up follows the surface the wasp stands on, and eases back to the sky in flight
  camUp.lerp(ld ? new THREE.Vector3(ld.nx, ld.ny, ld.nz) : UP, 1 - Math.exp(-dt * 6)).normalize();
  camera.up.copy(camUp);
  const want = dead ? 0.9 : sim._inCup(w) || (w.state === 'drowning') ? 0.035 : w.state === 'attached' || w.state === 'under' || w.state === 'perched' ? 0.17 : w.state === 'balled' ? 0.25 : w.contact ? 0.13 : 0.1;
  camDist += (want - camDist) * (1 - Math.exp(-dt * 4));
  const focus = dead && deathSpot ? deathSpot : p || (w ? V(w) : V(sim.nest.spawn)); // no wasp at all in winter (T1-15)
  let off = fwd.clone().multiplyScalar(-camDist).add(new THREE.Vector3(0, camDist * 0.28, 0));
  // on a body: look at the wasp from outside the skin, along the surface normal, blended with the view direction
  // on a body or any surface: look at the wasp from outside it, along the surface normal, blended with the view
  // direction, so the camera never ends up inside a trunk or a table top
  const nw = !dead && w ? surfaceNormal(w) : null;
  const onBody = !!nw;
  if (nw) off = nw.multiplyScalar(0.75).addScaledVector(fwd, -0.45).normalize().multiplyScalar(camDist);
  camOff.lerp(off, 1 - Math.exp(-dt * (dead ? 2 : 14)));
  const chase = focus.clone().add(camOff);
  if (chase.y < 0.006) chase.y = 0.006;
  for (const hm of sim.active) {
    if (hm.state === 'away' || Math.hypot(hm.x - chase.x, hm.z - chase.z) > 1.5) continue;
    const lp = toLocal(hm, chase);
    let pushed = false;
    for (const part of hm.parts[hm.posture]) {
      const q = segClosest(part.a, part.b, lp);
      const ex = lp.x - q.x, ey = lp.y - q.y, ez = lp.z - q.z, d = Math.hypot(ex, ey, ez), rr = part.r + 0.012;
      if (d < rr && d > 1e-6) { lp.x = q.x + ex / d * rr; lp.y = q.y + ey / d * rr; lp.z = q.z + ez / d * rr; pushed = true; }
    }
    if (pushed) { const wpt = toWorld(hm, lp); chase.set(wpt.x, wpt.y, wpt.z); }
  }
  const chaseLook = onBody ? focus.clone() : focus.clone().addScaledVector(fwd, 0.06);
  let pos = chase, look = chaseLook;
  if (eyeBlend > 0 && !dead) {
    // eye view: at the front of the head, looking wherever the mouse says, carried rigidly
    const sc = w.caste === 'queen' ? 1.3 : 1;
    // in the wasp's own frame: its heading, the up of whatever it stands on (the sky in flight), and the side between;
    // landed on a trunk or under a table the eyes turn with the wasp, not with the world
    const hf = ld ? new THREE.Vector3(ld.hx, ld.hy, ld.hz) : new THREE.Vector3(Math.sin(input.yaw), 0, Math.cos(input.yaw));
    const hn = ld ? new THREE.Vector3(ld.nx, ld.ny, ld.nz) : UP.clone(), hs = new THREE.Vector3().crossVectors(hn, hf);
    const eye = focus.clone().addScaledVector(hf, 0.0078 * sc).addScaledVector(hn, 0.0012 * sc);
    const lp = Math.max(-1.5, Math.min(1.5, input.pitch + fl.pitch));
    const dir = hf.clone().multiplyScalar(Math.cos(fl.yaw)).addScaledVector(hs, Math.sin(fl.yaw)).multiplyScalar(Math.cos(lp)).addScaledVector(hn, Math.sin(lp));
    const k = eyeBlend * eyeBlend * (3 - 2 * eyeBlend);
    pos = chase.clone().lerp(eye, k);
    const d0 = chaseLook.clone().sub(chase).normalize();
    look = pos.clone().add(d0.lerp(dir, k).normalize());
  }
  camPos.copy(pos); // in the sim's frame, height above the ground
  if (TERR.on) { // lift the camera and its target onto the ground as drawn (T2-6)
    pos = pos.clone(); pos.y += terrAt(pos.x, pos.z);
    look = look.clone(); look.y += terrAt(look.x, look.z);
  }
  camera.position.copy(pos);
  camera.lookAt(look);
  const fy = terrAt(focus.x, focus.z);
  sun.position.copy(focus).addScaledVector(sunDir, 40); sun.position.y += fy;
  sun.target.position.copy(focus); sun.target.position.y += fy;
  ground.position.set(Math.round(focus.x / GROUND_TILE) * GROUND_TILE, 0, Math.round(focus.z / GROUND_TILE) * GROUND_TILE);
  return focus;
}

let last = performance.now(), acc = 0, panelTimer = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (running && !paused) {
    if (sim) updateAssist(dt);
    const scale = timeScale(), cap = Math.max(8, Math.ceil(8 * scale));
    acc += dt * scale;
    let n = 0;
    while (acc >= DT && n < cap) {
      for (const w of sim.wasps) { const e = pos.get(w.id); if (e) e.p.copy(e.c); }
      if (lab) { lab.step(buildCmd()); if (sim.tick % 30 === 0) lab.check(); } else sim.step(buildCmd());
      for (const w of sim.wasps) { const e = pos.get(w.id); if (e) e.c.set(w.x, w.y, w.z); else pos.set(w.id, { p: V(w), c: V(w) }); }
      handleEvents(sim.drainEvents());
      acc -= DT; n++;
    }
    if (n === cap) acc = 0;
  }
  if (sim) {
    const P = window.__prof, tm = P ? (k, t0) => { P[k] = (P[k] || 0) + performance.now() - t0; } : null;
    let t0 = performance.now();
    const alpha = running && !paused ? acc / DT : 1;
    const t = sim.tick + alpha;
    for (let i = anims.length - 1; i >= 0; i--) if (envelope(anims[i], t) < 0) anims.splice(i, 1);
    for (const v of humanViews.values()) poseHuman(v, t, dt);
    if (tm) { tm('humans', t0); t0 = performance.now(); }
    const p = renderWasps(alpha, t, dt);
    if (sim) terrFrame(p || V(sim.nest.spawn));
    const focus = updateCamera(p, dt);
    drawLock();
    updateStare(dt);
    updateScents(dt);
    if (tm) { tm('wasps+cam', t0); t0 = performance.now(); }
    renderCritters(t);
    swayTrees(t / 60);
    renderBaits();
    renderSites();
    renderFruit();
    renderBirdsAndSpiders(t, dt);
    renderSwats(t);
    renderSprays();
    renderRain(focus, dt);
    lighting();
    updateAudio(dt);
    if (tm) { tm('fx', t0); t0 = performance.now(); }
    updateHud();
    if (tm) { tm('hud', t0); t0 = performance.now(); }
    if (toastTimer > 0 && (toastTimer -= dt) <= 0) $('toast').style.opacity = 0;
    if (bumpTimer > 0 && (bumpTimer -= dt) <= 0) $('bump').style.opacity = 0;
    if (deadUntil && now > deadUntil && sim._driven()) { $('dead').hidden = true; deadUntil = 0; }
    if ((panelTimer -= dt) <= 0) {
      panelTimer = 0.12;
      if (ui.lab) updateLab();
      if (ui.nest) updateNest();
      updateChunkDynamics();
      syncNests();
      drawMap();
    }
    if (tm) { tm('panels', t0); t0 = performance.now(); }
  }
  const r0 = performance.now();
  renderer.render(scene, camera);
  if (window.__prof) window.__prof.render = (window.__prof.render || 0) + performance.now() - r0;
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot

let loadSnap = null; // the snapshot a restored world started from, for the replay check
function newWorld(s, restored = null) {
  for (const g of chunkViews.values()) scene.remove(g);
  for (const v of humanViews.values()) scene.remove(v.group);
  for (const g of waspViews.values()) scene.remove(g);
  chunkViews.clear(); humanViews.clear(); waspViews.clear(); pos.clear(); anims.length = 0; ui.log.length = 0;
  if (nestView) scene.remove(nestView);
  for (const o of oldNestViews) if (o) scene.remove(o);
  nestView = null; nestSig = ''; oldNestViews.length = 0;
  TERR.ox = TERR.oz = 1e9; // a new world: build its height map afresh
  input.lock = input.pilot = null; input.turning = false;
  for (const v of lineViews.values()) scene.remove(v); lineViews.clear();
  if (restored) { sim = restored.sim; loadSnap = restored.json; lab = null; settings = sim.settings; }
  else {
    loadSnap = null;
    settings = s;
    lab = s.net && s.net !== 'off' ? new NetLab(settings, s.net.replace('+late', ''), {}, s.net.endsWith('+late') ? 3600 : 0) : null;
    sim = lab ? lab.a : new Sim(settings);
  }
  sim.drainEvents();
  syncChunks();
  syncNests();
  const w = sim.wasp;
  input.yaw = w.yaw; input.pitch = 0; input.alloc = 1;
  pos.set(w.id, { p: V(w), c: V(w) });
  camOff.set(-Math.sin(input.yaw) * 0.6, 0.2, -Math.cos(input.yaw) * 0.6);
  $('verifyOut').textContent = '';
}

function readSettings() {
  const raw = $('seed').value.trim();
  let seed;
  try { seed = BigInt.asUintN(64, BigInt(raw || '0')); } catch { seed = BigInt(Array.from(raw).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)); }
  return {
    seed, dayMinutes: +$('dayLen').value, humanDensity: +$('density').value, beeAggression: +$('bees').value, seasonDays: +$('seasonLen').value, net: $('netMode').value,
    reaction: +$('reaction').value, escalation: +$('escRate').value,
    woods: +$('woods').value, towns: +$('towns').value, water: +$('water').value, hives: +$('hives').value, terrain: +$('terrain').value, // T2-6
    exterminator: $('sysExt').checked, pestControl: $('sysMuni').checked, birds: $('sysBirds').checked, rivals: $('sysRivals').checked,
  };
}
const tagText = (st) => worldTag(st) || 'Standard rules';
function showTag() { $('worldTag').textContent = 'World: ' + tagText(readSettings()); }
for (const id of ['dayLen', 'density', 'seasonLen', 'bees', 'reaction', 'escRate', 'woods', 'towns', 'water', 'hives', 'terrain', 'sysExt', 'sysMuni', 'sysBirds', 'sysRivals']) $(id).addEventListener('change', showTag);
showTag();

function applyDisplaySettings() {
  const low = $('gfx').value === 'low';
  renderer.shadowMap.enabled = !low;
  sun.castShadow = !low;
  renderer.setPixelRatio(low ? 1 : Math.min(devicePixelRatio, 2));
  scene.fog.near = low ? 22 : 30; scene.fog.far = low ? 80 : 115;
  resize();
  document.body.classList.toggle('hardcore', $('hudMode').value === 'hardcore');
  try { localStorage.setItem('sting.display', JSON.stringify({ gfx: $('gfx').value, hud: $('hudMode').value })); } catch { /* optional */ }
}
try { const d = JSON.parse(localStorage.getItem('sting.display') || 'null'); if (d) { $('gfx').value = d.gfx; $('hudMode').value = d.hud; } } catch { /* optional */ }

// ------------------------------------------------------------------ save and continue (personal worlds)

function saveWorld(manual) {
  if (!sim || lab || sim.extinct) { if (manual) $('saveNote').textContent = 'Only solo worlds can be saved.'; return; }
  try {
    const json = snapshot(sim);
    localStorage.setItem('sting.save', json);
    localStorage.setItem('sting.saveMeta', JSON.stringify({ day: sim.day + 1, season: sim.season.n, phase: sim.season.phase, stung: sim.stung.size, seed: String(settings.seed), tag: worldTag(sim.settings), at: Date.now() }));
    if (manual) $('saveNote').textContent = `Saved · day ${sim.day + 1}, ${(json.length / 1024).toFixed(0)} KB in this browser`;
    showContinue();
  } catch (err) { if (manual) $('saveNote').textContent = 'This browser would not store the save.'; }
}
function showContinue() {
  let meta = null;
  try { meta = JSON.parse(localStorage.getItem('sting.saveMeta') || 'null'); } catch { /* optional */ }
  $('bContinue').hidden = !meta;
  if (meta) $('bContinue').textContent = `Continue · day ${meta.day}, season ${meta.season}${meta.tag ? ' · ' + meta.tag : ''}`;
}
$('bSave').addEventListener('click', () => saveWorld(true));
$('bContinue').addEventListener('click', () => {
  let json = null;
  try { json = localStorage.getItem('sting.save'); } catch { /* optional */ }
  if (!json) return;
  try {
    initAudio(); applyDisplaySettings();
    newWorld(null, { sim: restore(json), json });
    $('startScreen').hidden = true; running = true; lock();
    toast(`Day ${sim.day + 1} · season ${sim.season.n}`, 'var(--yellow)', 2);
    if (sim.winter) showWinter('Winter. The young queens of your line are asleep. Choose which one you wake as.');
  } catch (err) { $('startNote').textContent = /generator/.test(err.message) ? 'That save is from an older version of the world generator and cannot be continued. Start a new world.' : `That save could not be loaded: ${err.message}`; }
});
showContinue();

$('bStart').addEventListener('click', () => { initAudio(); applyDisplaySettings(); newWorld(readSettings()); $('startScreen').hidden = true; running = true; lock(); });
// Winter (T1-15): one button per wintering site; where she wakes is where the next season starts
function showWinter(text) {
  $('winterText').textContent = text;
  $('winterSites').innerHTML = sim.winter.sites.map((s, i) => {
    const d = Math.round(Math.hypot(s.x - sim.nest.x, s.z - sim.nest.z));
    return `<button class="ghost" data-i="${i + 1}"><b>${s.n || 1} queen${(s.n || 1) === 1 ? '' : 's'} ${T.hiber.name[s.kind]}</b><span>${d} m from the old nest · shelter ${Math.round(s.q * 100)}%${s.scouted ? ' · the site you scouted' : ''}</span></button>`;
  }).join('');
  $('winterScreen').hidden = false;
  setPaused(true);
  $('pauseScreen').hidden = true;
  document.exitPointerLock?.();
}
// Waking: a pick goes out in the next command, and the sim wakes that queen
function wake(i) {
  pickOnce = i; input.pick = 1;
  $('winterScreen').hidden = true; setPaused(false); lock();
  toast('Spring. Find a nest site and press E: a trunk, a burrow, under a branch, a gap in a shed or a hollow tree.', 'var(--yellow)', 4);
}
$('bSpring').addEventListener('click', () => wake(1));
$('winterSites').addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) wake(+b.dataset.i); });
$('bNewLine').addEventListener('click', () => { $('extinctScreen').hidden = true; newWorld(settings); running = true; lock(); });
try { if (localStorage.getItem('sting.lab') === '1') toggleLab(); } catch { /* optional */ }
if (matchMedia('(pointer: coarse)').matches) $('startNote').textContent = 'Needs a keyboard and mouse. On touch devices you can look around but not fly.';

newWorld({ seed: 1234n, dayMinutes: 2, humanDensity: 1, beeAggression: 1, seasonDays: 40 });
requestAnimationFrame(frame);

// test hook for automated checks
window.__sting = { get sim() { return sim; }, get lab() { return lab; }, input, start: () => $("bStart").click(), humanViews, toggleNest, toggleLab, saveWorld, camera };
window.__garment = (hm) => garmentGraph(hm.tr, hm.clothing, hm.posture, hm.parts[hm.posture]);
window.__toWorld = toWorld;
window.__weather = dayWeather;
