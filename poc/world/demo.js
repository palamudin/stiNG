// World v2 template page: the world drawn with no game on top, for looking at, tuning and testing.
// A camera that zooms continuously from kilometres up to a wasp's few centimetres over the grass, a switch between
// the wild world and the game's own world, and the controls the world exposes. window.__w2 is the test hook.
import * as THREE from 'three';
import { World } from './index.js';
import { wildSource } from './sources/wild.js';
import { compositeSource } from './sources/composite.js';
import { MAP, Places, placeCard } from './map.js';
import { seasonName, seasonAt } from './seasons.js';
import { hash01 } from './noise.js';
import { readCompare, compareURL, poseOf, applyPose } from './compare.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) throw new Error('needs WebGL2');
} catch (e) {
  $('bootMsg').textContent = 'This browser cannot draw the world: it needs WebGL2 (' + e.message + ').';
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping; // the post chain tone-maps
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.005, 60000);

// the shore by table (the default) or by live calculation per pixel, for the comparison: ?shore=live, or a page that
// sets window.__SHORE_MODE before this script
const SHORE_MODE = ((m) => (m === 'live' || m === 'none' ? m : 'table'))(new URLSearchParams(location.search).get('shore') || window.__SHORE_MODE || 'table');
const state = { source: 'wild', seed: 7, tod: 16.6, day: 100, weather: 'auto', zoom: 0.42, blocky: 0.6, fog: 1, wet: 0, wind: 5, fstop: 2.8, quality: 'high', ui: true, treeDist: 1 };
let world = null, src = null;

// ------------------------------------------------------------ camera: orbit a focus point on the ground
// zoom 0..1 maps the distance from the focus logarithmically from 6 cm to 9 km. Pitch flattens as you come down, so
// the far view is a map and the near view looks along the grass.
const cam = { fx: 0, fz: 0, yaw: 0.8, pitch: 0.5, dist: 120, target: null, tour: null, map: 0, yawMap: 0, look: 0, invert: false }; // look: the view tilted up (+) or down from the focus, radians
// the map comes in with the distance (map.js): 0 below MAP.from, 1 past MAP.to
const mapFor = (d) => THREE.MathUtils.smoothstep(Math.log(d), Math.log(MAP.from), Math.log(MAP.to));
const zoomToDist = (z) => 0.06 * Math.pow(9000 / 0.06, z);
const distToZoom = (d) => Math.log(d / 0.06) / Math.log(9000 / 0.06);
// the V switch (compare.js): arriving from the new water, the same place, time, weather and pose
const cmp = readCompare();
if (cmp) {
  Object.assign(cam, { fx: cmp.fx, fz: cmp.fz, yaw: cmp.yaw }); if (cmp.dist) { cam.dist = cmp.dist; state.zoom = distToZoom(cmp.dist); } if (cmp.look !== undefined) cam.look = cmp.look;
  if (cmp.hour !== undefined) state.tod = cmp.hour; if (cmp.day !== undefined) state.day = cmp.day; if (cmp.wind !== undefined) state.wind = cmp.wind;
  if (cmp.cover !== undefined && cmp.cover >= 0) { state.weather = 'custom'; state.cover = cmp.cover; }
}
function pitchFor(d) { return 0.12 + 0.95 * THREE.MathUtils.smoothstep(Math.log10(d), -1.2, 3.7); }

let stingMod = null, simMod = null;
async function makeWorld() {
  if (world) { scene.remove(world.group); world = null; }
  if (state.source === 'wild') src = wildSource({ seed: state.seed, blocky: state.blocky });
  else { // 'sting': the game's world alone; 'town', 'village': the game's world in the wild, with a settled radius
    // the game's own world: the sim's generator with hilly ground, its land use, paving and trees
    simMod = simMod || await import('../sim/index.js');
    stingMod = stingMod || await import('./sources/sting.js');
    const settings = { ...simMod.DEFAULT_SETTINGS, terrain: 2, seed: state.seed };
    src = stingMod.stingSource({ seed: simMod.u64(state.seed), settings, records: new Map() }); // the sim's seed is a u64 (BigInt)
    // the game's world set down in the wild one (sources/composite.js): the settled area's radius is the start's kind
    if (state.source !== 'sting') src = compositeSource(src, wildSource({ seed: state.seed, blocky: state.blocky }), { radius: state.source === 'town' ? 420 : 150 });
  }
  world = new World(renderer, scene, camera, src, { quality: state.quality, shore: SHORE_MODE, waterCtl: WCTL });
  world.build(cam.fx, cam.fz);
  standIns();
}
// In the game's world the game draws the birdbaths and fountains (World v2 draws their water). Here, with no game, the
// same basins are stood in, at the game's sizes, so the water has its floor and rim.
let stands = null;
function standIns() {
  if (stands) { scene.remove(stands); stands.traverse((o) => o.geometry && o.geometry.dispose()); stands = null; }
  if (state.source === 'wild') return;
  stands = new THREE.Group(); stands.userData.ring = true;
  const bark = new THREE.MeshStandardMaterial({ color: new THREE.Color('#5b4330'), roughness: 0.95 });
  const stone = new THREE.MeshStandardMaterial({ color: new THREE.Color('#bdb8ad'), roughness: 0.9 }), dark = new THREE.MeshStandardMaterial({ color: new THREE.Color('#a9a49a'), roughness: 0.9 });
  for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) for (const b of src.objects(i, j).baths || []) {
    const y = src.height(b.x, b.z), add = (geo, m, yy) => { const o = new THREE.Mesh(geo, m); o.position.set(b.x, y + yy, b.z); o.castShadow = o.receiveShadow = true; stands.add(o); };
    if (b.fountain) add(new THREE.CylinderGeometry(b.r + 0.15, b.r + 0.2, b.h - 0.02, 28), stone, (b.h - 0.02) / 2);
    else { add(new THREE.CylinderGeometry(0.07, 0.11, b.h - 0.08, 10), dark, (b.h - 0.08) / 2); add(new THREE.CylinderGeometry(b.r + 0.03, b.r * 0.55, 0.1, 18), stone, b.h - 0.055); }
  }
  // the sim's trunks, as the game draws them: solid cylinders of the sim's radius and height (GDD 20.4 point 2)
  for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) for (const t of src.objects(i, j).trees || []) {
    if (src.wildFrom && Math.hypot(t.x, t.z) > src.wildFrom) continue;
    const o = new THREE.Mesh(new THREE.CylinderGeometry(t.r * 0.8, t.r, t.h, 9), bark); o.position.set(t.x, src.height(t.x, t.z) + t.h / 2, t.z); o.castShadow = o.receiveShadow = true; stands.add(o);
  }
  scene.add(stands);
}

// ------------------------------------------------------------ frame
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

const focus = new THREE.Vector3();
let last = performance.now(), frames = 0, fpsT = 0, fps = 0;
const keys = new Set();
// the player (P): a coloured cube flown with the keys, for checking the water's mirror (water3/surface.js MIRROR).
// Third person by default (drag to orbit, wheel for the distance); the right button toggles first person, where the
// cube leaves the view but stays on the mirror's layer, so it shows only in the water under it
const player = { on: false, fp: false, d: 4, pos: new THREE.Vector3(), mesh: null };
function playerMesh() {
  const g = new THREE.BoxGeometry(0.5, 0.5, 0.5).toNonIndexed(), cols = [[0.9, 0.15, 0.1], [0.1, 0.7, 0.2], [0.95, 0.85, 0.1], [0.2, 0.3, 0.9], [0.9, 0.9, 0.9], [0.8, 0.2, 0.8]], c = [];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 6; v++) c.push(...cols[f]); // each face its own colour, so its turn reads in the water
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 12).rotateX(-Math.PI / 2).translate(0, 0, -0.38), new THREE.MeshStandardMaterial({ color: 0xff7700 }));
  m.add(nose); m.castShadow = nose.castShadow = true; m.frustumCulled = nose.frustumCulled = false;
  return m;
}
function setPlayer(on) {
  player.on = on;
  if (on && !player.mesh) { player.mesh = playerMesh(); scene.add(player.mesh); }
  if (on) { player.pos.set(cam.fx, world.surfaceAt(cam.fx, cam.fz) + 1.2, cam.fz); player.fp = false; cam.look = -0.25; }
  if (player.mesh) player.mesh.visible = on;
  for (const l of [world.sun, world.hemi]) l.layers.enable(5); // lit in the mirror's pass too
  if (world.surface) world.surface.mirrorAt = on ? player.pos : null;
}
function playerLayers() { const L = player.mesh.layers; if (player.fp) L.set(5); else { L.set(0); L.enable(5); } player.mesh.children.forEach((c) => c.layers.mask = L.mask); }
function playerStep(dt) {
  const P = player, sp = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1) * 4;
  const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const side = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const up = (keys.has('Space') || keys.has('KeyE') ? 1 : 0) - (keys.has('KeyC') || keys.has('KeyQ') || keys.has('ControlLeft') ? 1 : 0);
  P.pos.x += (-Math.sin(cam.yaw) * fwd + Math.cos(cam.yaw) * side) * sp * dt;
  P.pos.z += (-Math.cos(cam.yaw) * fwd - Math.sin(cam.yaw) * side) * sp * dt;
  P.pos.y = Math.max(P.pos.y + up * sp * dt, world.surfaceAt(P.pos.x, P.pos.z) + 0.3);
  P.mesh.position.copy(P.pos); P.mesh.rotation.set(0, cam.yaw, 0); playerLayers();
  const pt = cam.look, dir = new THREE.Vector3(-Math.sin(cam.yaw) * Math.cos(pt), Math.sin(pt), -Math.cos(cam.yaw) * Math.cos(pt));
  if (P.fp) { camera.position.copy(P.pos).y += 0.1; camera.lookAt(camera.position.clone().add(dir)); }
  else {
    camera.position.copy(P.pos).addScaledVector(dir, -P.d); camera.position.y += 0.4;
    camera.position.y = Math.max(camera.position.y, world.surfaceAt(camera.position.x, camera.position.z) + 0.15);
    camera.lookAt(P.pos.x, P.pos.y + 0.3, P.pos.z);
  }
  camera.fov = 55; camera.near = 0.02; camera.far = 60000; camera.updateProjectionMatrix();
  cam.map = 0; cam.dist = P.fp ? 0.5 : P.d; focus.copy(P.pos);
  if (world.surface) world.surface.mirrorAt = P.pos;
  for (const l of [world.sun, world.hemi]) l.layers.enable(5); // a rebuilt world's lights too
}
function step(dt) {
  if (!world) return;
  if (player.on) playerStep(dt); else {
  // move
  const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1) * Math.max(0.4, cam.dist * 0.6);
  const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const side = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  cam.fx += (-Math.sin(cam.yaw) * fwd + Math.cos(cam.yaw) * side) * sp * dt;
  cam.fz += (-Math.cos(cam.yaw) * fwd - Math.sin(cam.yaw) * side) * sp * dt;
  if (cam.tour) cam.tour(dt);
  cam.dist += (zoomToDist(state.zoom) - cam.dist) * Math.min(1, dt * 6);
  const gy = cam.fy ?? world.surfaceAt(cam.fx, cam.fz); // cam.fy: a focus height of its own (tests)
  focus.set(cam.fx, gy, cam.fz);
  // into the map: the view tips toward straight down, narrows (backing off to keep the framing) and turns north-up
  cam.map = mapFor(cam.dist); const m = cam.map;
  const pitch = cam.pitchOverride ?? THREE.MathUtils.lerp(pitchFor(cam.dist), MAP.pitch, m);
  const fov = THREE.MathUtils.lerp(55, MAP.fov, m), back = Math.tan(55 / 2 * Math.PI / 180) / Math.tan(fov / 2 * Math.PI / 180);
  if (m > 0.5 && !drag) cam.yaw += (0 - cam.yaw) * Math.min(1, dt * 1.5 * (m - 0.5) * 2); // north-up
  camera.fov = fov;
  const D = cam.dist * THREE.MathUtils.lerp(1, back, m);
  const cx = cam.fx + Math.sin(cam.yaw) * Math.cos(pitch) * D, cz = cam.fz + Math.cos(cam.yaw) * Math.cos(pitch) * D;
  let cy = gy + Math.sin(pitch) * D;
  cy = Math.max(cy, world.surfaceAt(cx, cz) + Math.min(0.02 + cam.dist * 0.15, 2));
  camera.position.set(cx, cy, cz);
  camera.lookAt(focus);
  if (cam.look) camera.rotateX(cam.look); // the view tilted from the focus: up to the sky, down to the ground
  camera.near = THREE.MathUtils.clamp(cam.dist * 0.02, 0.003, 20);
  camera.far = 60000;
  camera.updateProjectionMatrix();
  }
  if (cmp && cmp.frozen && cmp.pose) applyPose(camera, cmp.pose); // (held until the user moves)
  if (cmp && !cmp.timeSet && world) { cmp.timeSet = true; if (cmp.wt !== undefined) world.waterTime = cmp.wt; if (cmp.ct !== undefined) world.time = cmp.ct; }
  const m = cam.map;
  // the weather: the day's own, or a forced one from the buttons (then the haze and wind sliders apply)
  const forced = state.weather !== 'auto';
  const F = { clear: { cloud: 0.05, rain: 0, snow: 0, storm: 0 }, overcast: { cloud: 0.92, rain: 0, snow: 0, storm: 0 }, rain: { cloud: 0.95, rain: 0.8, snow: 0, storm: 0 }, storm: { cloud: 0.98, rain: 1, snow: 0, storm: 1 }, fog: { cloud: 0.6, rain: 0, snow: 0, storm: 0 }, snow: { cloud: 0.9, rain: 0.7, snow: 1, storm: 0 } }[state.weather] || (state.weather === 'custom' ? { cloud: state.cover, rain: 0, snow: 0, storm: 0 } : {});
  const w10 = [state.wind * 0.94, state.wind * 0.35];
  world.set(forced
    ? { hour: state.tod, day: state.day, auto: false, haze: state.fog * (state.weather === 'fog' ? 3 : 1), mist: state.fog * (state.weather === 'fog' ? 6 : 1), wet: F.rain, cloud: F.cloud, cloudDens: 0.6 + 0.6 * F.cloud + F.storm * 0.8, wind10: w10, wind: [w10[0] * 0.35, w10[1] * 0.35], rain: F.rain, snow: F.snow, storm: F.storm, flash: F.storm && hash01(Math.floor(world.time * 2), 7, 99) < 0.08 ? 1 : Math.max(0, (world.env.flash || 0) - dt * 6), map: m }
    : { hour: state.tod, day: state.day, auto: true, map: m });
  if (world.forest.rangeK !== state.treeDist) world.forest.setRange(state.treeDist);
  world.post.U.uFstop.value = state.fstop;
  world.update(dt, camera.position, cam.dist);
  updatePins(dt);
}
let manual = false;
function frame(now) {
  if (manual) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  step(dt);
  if (world) world.render();
  frames++; fpsT += dt; if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; showStats(); }
  requestAnimationFrame(frame);
}
function showStats() {
  if (!world) return;
  const i = world.frameInfo || { calls: 0, tris: 0 }; i.triangles = i.tris;
  const d = cam.dist, ds = d < 1 ? (d * 100).toFixed(0) + ' cm' : d < 1000 ? d.toFixed(d < 10 ? 1 : 0) + ' m' : (d / 1000).toFixed(2) + ' km';
  const g = world.timer.ms, gpu = world.timer.on ? (g.total ? `gpu ${g.total.toFixed(1)} ms: ` + ['scene', 'water', 'shore', 'clouds', 'composite', 'rays', 'dof', 'bloom', 'final', 'waves'].filter((k) => g[k] !== undefined).map((k) => `${k} ${g[k].toFixed(1)}`).join(' · ') : 'gpu timing…') : 'gpu timing: not given by this browser';
  const w = world.weather, wx = w ? `${w.kind}, ${w.temp.toFixed(0)} °C, wind ${Math.hypot(...w.wind).toFixed(0)} m/s` : state.weather;
  const sm = world.post.samplers, dbg = world.post.U.uDebug.value, smt = (sm ? ` · samplers ${sm.composite}/${sm.max}` : '') + ` · shore by ${world.shoreMode}` + (world.surface ? ` · water ${(world.surface.stats.verts / 1000).toFixed(0)}k verts` : '') + (dbg ? " · DEBUG water's kinds: blue large, green river, bands its flow" : '');
  $('stats').textContent = `${fps.toFixed(0)} fps · ${i.calls} draws · ${(i.triangles / 1000).toFixed(0)}k tris · ${(world.forest.stats.far / 1000).toFixed(0)}k far cells${smt}\n${gpu}\nview ${ds} · ${seasonName(state.day)} day ${state.day} · ${wx} · ${world.forest.stats.trees} near trees` + (player.on ? `\nplayer (P off) · ${player.fp ? 'first person' : 'third person'} (right button) · WASD, Space/E up, C/Q down, Shift fast, wheel distance · mirror ${world.surface && world.surface.U.uMirrorOn.value ? 'on' : 'off (needs water under the cube, the eye within 40 m, 32 texture units)'}` : '');
}

// ------------------------------------------------------------ input
let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { if (e.button === 2) { if (player.on) player.fp = !player.fp; return; } drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, look: cam.look, id: e.pointerId }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (drag && drag.id === e.pointerId) { cam.yaw = drag.yaw - (e.clientX - drag.x) * 0.005; cam.look = THREE.MathUtils.clamp(drag.look + (e.clientY - drag.y) * 0.005 * (cam.invert ? 1 : -1), -1.45, 1.45); } }); // across: round the focus; up and down: the view tilts (a wasp looks anywhere)
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (player.on) { player.d = THREE.MathUtils.clamp(player.d * (1 + e.deltaY * 0.001), 1.2, 40); return; } setZoom(state.zoom + e.deltaY * 0.0006); }, { passive: false });
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keydown', (e) => { if (e.code === 'KeyK' && !e.repeat && world) world.waterLog(); });
addEventListener('keydown', (e) => { if (e.code === 'KeyV' && !e.repeat && world) location.href = compareURL('world-gpu.html', { fx: cam.fx, fz: cam.fz, yaw: cam.yaw, dist: cam.dist, look: cam.look, hour: state.tod, day: state.day, wind: state.wind, cover: state.weather === 'auto' ? -1 : state.weather === 'custom' ? state.cover : ({ clear: 0.05, overcast: 0.92, rain: 0.95, storm: 0.98, fog: 0.6, snow: 0.9 })[state.weather] ?? -1, wt: world.waterTime, ct: world.time, pose: poseOf(camera) }); }); // the V switch (compare.js)
addEventListener('keydown', (e) => { if (e.code === 'KeyP' && !e.repeat && world) setPlayer(!player.on); }); // the player cube: P on and off, right button first person // the water's log (world/index.js)
window.waterLog = (x, z) => (world ? world.waterLog(x, z) : 'no world');
// L toggles the water's debug view: its kinds (blue large, green a river) and the river's flow
addEventListener('keydown', (e) => { if (e.code === 'KeyL' && world) { const U = world.post.U.uDebug; U.value = U.value === 0 ? 8 : 0; } });
addEventListener('keyup', (e) => keys.delete(e.code));
function setZoom(z) { state.zoom = THREE.MathUtils.clamp(z, 0, 1); $('zoom').value = state.zoom; $('oZoom').textContent = fmtDist(zoomToDist(state.zoom)); }
const fmtDist = (d) => (d < 1 ? (d * 100).toFixed(0) + ' cm' : d < 1000 ? d.toFixed(0) + ' m' : (d / 1000).toFixed(1) + ' km');
const fmtTod = (h) => String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.floor((h % 1) * 60)).padStart(2, '0');
function bindRange(id, key, out, f = (v) => v.toFixed(2), on) {
  const el = $(id);
  const show = () => { $(out).textContent = f(state[key]); };
  el.addEventListener('input', () => { state[key] = parseFloat(el.value); show(); on && on(); });
  show();
}
bindRange('seed', 'seed', 'oSeed', (v) => String(v), () => makeWorld());
bindRange('tod', 'tod', 'oTod', fmtTod);
bindRange('day', 'day', 'oDay', (v) => `${seasonName(v)} · ${v}`);
bindRange('zoom', 'zoom', 'oZoom', (v) => fmtDist(zoomToDist(v)));
bindRange('blocky', 'blocky', 'oBlocky', undefined, () => makeWorld());
bindRange('treeDist', 'treeDist', 'oTreeDist', (v) => Math.round(v * 100) + '%'); // applied in step (a rebuilt forest takes it too)
bindRange('fog', 'fog', 'oFog');
bindRange('wind', 'wind', 'oWind', (v) => v.toFixed(1) + ' m/s');
bindRange('fstop', 'fstop', 'oFstop', (v) => 'f/' + v.toFixed(1));
$('bNotes').addEventListener('click', () => $('panel').classList.toggle('compact'));
if (innerWidth < 640) $('panel').classList.add('compact');
function segment(id, key, on) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    for (const x of el.querySelectorAll('button')) x.classList.toggle('on', x === b);
    state[key] = b.dataset.v; on && on();
  });
}
segment('segSource', 'source', () => { if (state.source !== 'wild') { cam.fx = 0; cam.fz = 0; } else { const s = findStart(); cam.fx = s.x; cam.fz = s.z; } makeWorld(); });
segment('segQ', 'quality', () => makeWorld());
segment('segWeather', 'weather');
// ---- the water's controls (after Ultra-Water's panel): the sea state and the surf, read by the world each frame. The
// wind's direction follows the weather until its slider is moved; the surf follows the swell until one of its sliders
// is moved ('from the swell' gives it back)
const WCTL = {};
{
  const rows = [
    ['Waves'],
    ['windDir', 'Wind dir', -180, 180, 1, (v) => (v === null ? 'weather' : v.toFixed(0) + '°')],
    ['fetchKm', 'Fetch', 1, 1000, 1, (v) => v.toFixed(0) + ' km'],
    ['waveScale', 'Wave scale', 0, 3, 0.01],
    ['spread', 'Spread', 0, 1, 0.01],
    ['swellScale', 'Swell', 0, 3, 0.01],
    ['swellDir', 'Swell dir', -180, 180, 1, (v) => v.toFixed(0) + '° off wind'],
    ['chop', 'Choppiness', 0, 2, 0.01],
    ['timeScale', 'Time scale', 0, 3, 0.01],
    ['Shore waves'],
    ['amplitude', 'Amplitude', 0, 1.5, 0.01, (v) => v.toFixed(2) + ' m'],
    ['wavelength', 'Wavelength', 8, 60, 0.5, (v) => v.toFixed(1) + ' m'],
    ['speed', 'Speed', 0.3, 2, 0.01],
    ['steepness', 'Steepness', 0, 1.5, 0.01],
    ['foam', 'Foam charge', 0, 2, 0.01],
    ['shoreLead', 'Shore water lead', -1, 1.5, 0.01, (v) => v.toFixed(2) + ' s'],
    ['foamSize', 'Foam size', 0.02, 4, 0.01],
    ['foamAmount', 'Foam amount', 0, 1, 0.01],
    ['linger', 'Foam linger', 0.2, 15, 0.1, (v) => v.toFixed(1) + ' s'],
    ['lace', 'Lace scale', 0.05, 4, 0.01],
    ['laceVar', 'Lace variation', 0, 1, 0.01],
    ['patches', 'Foam patches', 0, 1, 0.01],
    ['Water'],
    ['clarity', 'Clarity', 0.2, 4, 0.01],
    ['roughness', 'Roughness', 0, 0.2, 0.001, (v) => v.toFixed(3)],
    ['refraction', 'Refraction', 0, 0.2, 0.001, (v) => v.toFixed(3)],
    ['sssPeak', 'Crest glow', 0, 6, 0.01],
    ['sssView', 'Glow to view', 0, 0.5, 0.001, (v) => v.toFixed(3)],
    ['foamBias', 'Whitecap bias', -0.5, 1.5, 0.01],
    ['foamScale', 'Whitecap scale', 0, 6, 0.01],
    ['shoreBand', 'Shore foam band', 0, 2, 0.01],
    ['caustics', 'Caustics', 0, 2, 0.01],
    ['glitter', 'Glitter', 0, 1, 0.01],
  ];
  const shoreKeys = ['amplitude', 'wavelength', 'speed', 'steepness'], outs = {}, ins = {};
  const box = document.createElement('div'); box.style.display = 'grid'; box.style.gap = '8px';
  for (const r of rows) {
    if (r.length === 1) { const h = document.createElement('div'); h.className = 'hint'; h.style.cssText = 'color: var(--yellow); letter-spacing: .12em; text-transform: uppercase; font-size: 10px; margin-top: 4px'; h.textContent = r[0]; box.appendChild(h); continue; }
    const [key, label, lo, hi, step, fmt = (v) => v.toFixed(2)] = r;
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label for="w_${key}">${label}</label><input id="w_${key}" type="range" min="${lo}" max="${hi}" step="${step}"><output id="ow_${key}"></output>`;
    box.appendChild(row);
    const el = row.querySelector('input'); ins[key] = el; outs[key] = [row.querySelector('output'), fmt];
    el.addEventListener('input', () => { WCTL[key] = parseFloat(el.value); if (shoreKeys.includes(key)) WCTL.shoreAuto = false; });
  }
  const bt = document.createElement('div'); bt.className = 'seg';
  bt.innerHTML = '<button id="wWindAuto">Wind dir from weather</button><button id="wShoreAuto">Surf from the swell</button>';
  box.appendChild(bt);
  const ps = document.createElement('div'); ps.className = 'seg'; ps.id = 'wPreset';
  ps.innerHTML = ['ours', 'clear', 'tropical', 'toxic green', 'purple', 'rust orange', 'murky brown'].map((p) => `<button data-v="${p}"${p === 'ours' ? ' class="on"' : ''}>${p}</button>`).join('');
  box.appendChild(ps);
  ps.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; for (const x of ps.querySelectorAll('button')) x.classList.toggle('on', x === b); WCTL.preset = b.dataset.v; });
  const note = document.createElement('p'); note.className = 'note';
  note.textContent = 'Foam size and amount: the breakers\' puffs and streaks. Water: the colour preset, clarity (absorption divided by it), roughness, refraction, the glow through steep crests, whitecaps where the surface folds, the width of the shore\'s foam line, caustics, glitter. The sea state: fetch is the open water the wind has blown over (a lake uses its own width), the swell comes from weather far away, choppiness pinches the crests, time scale runs the water faster or slower. The surf: its first train, by its wavelength in deep water, its speed and its steepness; it follows the swell until a slider here is moved.';
  box.appendChild(note);
  $('segQ').before(box);
  // the view: tilt it by dragging up and down; inverted at will; level again
  const lk = document.createElement('div'); lk.className = 'seg';
  lk.innerHTML = '<label style="display:flex;gap:6px;align-items:center;color:var(--muted);font-size:10px;letter-spacing:.08em;text-transform:uppercase"><input type="checkbox" id="wInvert"> Invert pitch</label><button id="wLevel">Level view</button>';
  $('segQ').before(lk);
  $('wInvert').addEventListener('change', (e) => { cam.invert = e.target.checked; });
  $('wLevel').addEventListener('click', () => { cam.look = 0; });
  $('wWindAuto').addEventListener('click', () => { WCTL.windDir = null; });
  $('wShoreAuto').addEventListener('click', () => { WCTL.shoreAuto = true; });
  // the panel follows the values (the weather's and the swell's set some of them)
  setInterval(() => {
    for (const k in outs) {
      const v = WCTL[k]; if (v === undefined) continue;
      const [o, fmt] = outs[k]; o.textContent = fmt(v);
      if (v !== null && document.activeElement !== ins[k]) ins[k].value = v;
    }
  }, 300);
}
// ---- tours: a continuous zoom from the whole region down into the grass and back, turning slowly
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function tween(from, to, secs, onDone) {
  if (reduceMotion) secs = Math.min(secs, 0.01); // jump instead of flying
  let t = 0;
  cam.tour = (dt) => {
    t = Math.min(1, t + dt / secs);
    const k = t * t * (3 - 2 * t);
    setZoom(from + (to - from) * k);
    cam.yaw += dt * 0.05;
    if (t >= 1) { cam.tour = null; onDone && onDone(); }
  };
}
$('bTour').addEventListener('click', () => { tween(0.96, 0.14, 28, () => tween(0.14, 0.7, 14)); });
$('bDive').addEventListener('click', () => tween(state.zoom, 0.14, 6));
let uiHidden = false;
function hideUI(on) { uiHidden = on; for (const el of document.querySelectorAll('.hud, #panel')) el.style.visibility = on ? 'hidden' : ''; }
$('bShot').addEventListener('click', (e) => { e.stopPropagation(); hideUI(true); });
addEventListener('keydown', () => { if (uiHidden) hideUI(false); });
canvas.addEventListener('click', () => { if (uiHidden) hideUI(false); });
// double-click: march the view ray against the ground and make that point the focus
canvas.addEventListener('dblclick', (e) => {
  if (!world) return;
  const r = canvas.getBoundingClientRect(), ndc = new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  let t = 0, step = Math.max(0.05, cam.dist * 0.01), hit = null;
  for (let i = 0; i < 600 && t < 30000; i++) {
    const p = o.clone().addScaledVector(d, t);
    if (p.y < world.surfaceAt(p.x, p.z)) { hit = p; break; }
    t += step; step *= 1.02;
  }
  if (hit) { cam.fx = hit.x; cam.fz = hit.z; tween(state.zoom, Math.max(0.2, state.zoom - 0.25), 3); }
});
$('bPanel').addEventListener('click', () => { $('panel').classList.toggle('closed'); $('bPanel').textContent = $('panel').classList.contains('closed') ? 'show' : 'hide'; });

// ------------------------------------------------------------ the map's pins: places scanned from the source, projected each frame
let places = null; const pinEls = []; let cardPlace = null;
function updatePins(dt) {
  const m = cam.map, layer = $('pins');
  if (!places || places.src !== src) { places = new Places(src, { cell: 220, radius: 6000 }); }
  if (m > 0.02) places.scan(cam.fx, cam.fz, 2);
  const on = m > 0.15 && !uiHidden, W = innerWidth, H = innerHeight, V = new THREE.Vector3();
  // project, then cluster: a pin within 34 px of an earlier one joins it (its count shows)
  const shown = [];
  if (on) {
    const list = [{ kind: 'you', name: 'you', x: cam.fx, z: cam.fz }, ...places.list];
    for (const p of list) {
      V.set(p.x, world.surfaceAt(p.x, p.z), p.z).project(camera);
      if (V.z > 1 || Math.abs(V.x) > 1.05 || Math.abs(V.y) > 1.05) continue;
      const sx = (V.x * 0.5 + 0.5) * W, sy = (-V.y * 0.5 + 0.5) * H;
      const near = shown.find((q) => q.kind === p.kind && Math.hypot(q.sx - sx, q.sy - sy) < 34);
      if (near && p.kind !== 'you') { near.n++; continue; }
      shown.push({ p, sx, sy, n: 1, kind: p.kind });
      if (shown.length > 60) break;
    }
  }
  while (pinEls.length < shown.length) { const e = document.createElement('div'); e.className = 'pin'; e.addEventListener('click', () => openCard(e._p)); layer.appendChild(e); pinEls.push(e); }
  pinEls.forEach((e, i) => {
    const s = shown[i];
    if (!s) { e.classList.remove('on'); return; }
    e._p = s.p; e.className = 'pin on ' + s.kind; e.style.left = s.sx + 'px'; e.style.top = s.sy + 'px';
    e.innerHTML = s.p.name + (s.n > 1 ? `<span class="n">+${s.n - 1}</span>` : '');
  });
}
function openCard(p) {
  cardPlace = p;
  const c = placeCard(p, { x: cam.fx, z: cam.fz }, seasonAt(state.day));
  $('card').querySelector('.t').textContent = c.title; $('card').querySelector('.k').textContent = `${c.kind} · ${c.sub || ''} · ${c.dist} away`;
  $('card').querySelector('.b').innerHTML = c.lines.map((l) => `<div>${l}</div>`).join('');
  $('card').hidden = false;
}
$('bCardX').addEventListener('click', () => { $('card').hidden = true; });
$('bCardGo').addEventListener('click', () => { if (cardPlace) { cam.fx = cardPlace.x; cam.fz = cardPlace.z; tween(state.zoom, 0.3, 4); } $('card').hidden = true; });

// ------------------------------------------------------------ boot
function findStart() { // a meadow near the water, looking along the shore
  const s = wildSource({ seed: state.seed });
  let best = null;
  // a meadow by the sea, with open water for a few hundred metres in front of it (the fjord view)
  for (let r = 0; r < 12000 && !best; r += 60) for (let a = 0; a < 6.283; a += 0.3) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r, o = s.sample(x, z);
    if (o[0] > 2 && o[0] < 7 && o[2] < 0.3 && o[4] <= s.sea) { let ok = true; for (let k = 1; k <= 5 && ok; k++) { const w = s.sample(x + 60 * k * Math.cos(a), z + 60 * k * Math.sin(a)); ok = w[0] < s.sea - 1; } if (ok) { best = { x, z }; break; } }
  }
  return best || { x: 0, z: 0 };
}
const st = findStart(); cam.fx = st.x; cam.fz = st.z;
setZoom(state.zoom);
makeWorld().then(() => { $('boot').classList.add('gone'); }, (e) => { $('bootMsg').textContent = 'The world failed to build: ' + e.message; console.error(e); });
requestAnimationFrame(frame);

window.__w2 = {
  THREE, renderer, scene, camera, cam, state, get world() { return world; },
  set(o) { Object.assign(state, o); if ('zoom' in o) setZoom(o.zoom); if (o.rebuild) makeWorld(); },
  async frames(n) { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); },
  manual(on) { manual = on; if (!on) { last = performance.now(); requestAnimationFrame(frame); } },
  // step the world n times at dt seconds without drawing, then draw once; returns the draw's milliseconds
  render(n = 1, dt = 1 / 30) { for (let i = 0; i < n; i++) step(dt); const t0 = performance.now(); world.render(); renderer.getContext().finish(); return performance.now() - t0; },
  // draw once and read the canvas back in the same task (the drawing buffer is still there)
  shot() { const t0 = performance.now(); world.render(); const url = canvas.toDataURL('image/png'); return { ms: performance.now() - t0, url }; },
  // the ground as the clipmap draws it at (x, z), read back from the GPU, next to the source's own sample
  probe(pts) {
    const n = pts.length, data = new Float32Array(n * 4); pts.forEach((p, i) => { data[i * 4] = p[0]; data[i * 4 + 1] = p[1]; });
    const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.FloatType); tex.needsUpdate = true;
    const rt = new THREE.WebGLRenderTarget(n, 1, { type: THREE.FloatType, depthBuffer: false });
    const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { ...world.clip.uniforms, uP: { value: tex } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'precision highp float; precision highp int;\n' + world.clip.glsl() + '\nuniform highp sampler2D uP; out vec4 o; void main() { vec2 p = texelFetch(uP, ivec2(gl_FragCoord.xy), 0).xy; int l = clipFinest(p); o = vec4(clipAt(p).x, float(l), clipLevel(l, p).x, clipLevel(0, p).x); }' });
    const sc = new THREE.Scene(), q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m); q.frustumCulled = false; sc.add(q);
    renderer.setRenderTarget(rt); renderer.render(sc, new THREE.Camera()); const px = new Float32Array(n * 4); renderer.readRenderTargetPixels(rt, 0, 0, n, 1, px); renderer.setRenderTarget(null);
    return pts.map((p, i) => ({ x: p[0], z: p[1], src: +src.height(p[0], p[1]).toFixed(3), drawn: +px[i * 4].toFixed(3), level: px[i * 4 + 1], lvlH: +px[i * 4 + 2].toFixed(3), l0: +px[i * 4 + 3].toFixed(3) }));
  },
  stats() { const i = world ? world.frameInfo || {} : {}; return { calls: i.calls, tris: i.tris, fps, sharp: world && world.clip.sharpness(), clipMs: world && world.clip.stats.ms, forest: world && world.forest.stats, samplers: world && world.post.samplers, shore: world && world.shore && world.shore.stats }; },
};
