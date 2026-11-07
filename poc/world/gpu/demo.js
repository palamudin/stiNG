// The WebGPU spike (WEBGPU.md, step 1): the wild land on three.js's WebGPURenderer: the clipmap filled by compute,
// the ground from it, and the woods placed, culled and sorted into levels on the GPU, drawn indirectly. The same
// controls as the template (world.html): drag to look, WASD to move, the wheel to zoom; P a player cube.
import * as THREE from 'three/webgpu';
import { wildSource } from '../sources/wild.js';
import { GpuClip } from './clip.js';
import { gpuTerrain } from './terrain.js';
import { GpuForest } from './forest.js';
import { GpuWaves } from './waves.js';
import { gpuWater, surfUniforms } from './water.js';
import { GpuShore } from './shore.js';
import { GpuFoamField, GFOAM } from './foamfield.js';
import { GpuGrass } from './grass.js';
import { GpuCaustics } from './caustics.js';
import { buildPanel } from './panel.js';
import { GpuWaterQuery } from './waterquery.js';
import { GpuSpray } from './spray.js';
import { GpuSwellField } from './swellfield.js';
import { GpuCurrents } from './currents.js';
import { GpuTide } from './tide.js';
import { Floaters } from './floaters/floaters.js';
import { GWATER_PRESETS } from './water.js';
import { weatherAt, seasonAt } from '../seasons.js';
import { GpuSky } from './sky.js';
import { GpuClouds } from './clouds.js';
import { MAP, Places, placeCard } from '../map.js';
import { uniform, texture, uv, Fn, float, vec4, length, normalize, select, max, exp, mix, positionWorld, cameraPosition, output } from 'three/tsl';
import { WAVES, swellState } from '../waves.js';

const $ = (id) => document.getElementById(id);
// the loading screen (#boot): each stage named as it starts, so a stall shows where; an error anywhere is shown on it
// (and on a strip at the top once the world runs), never a silent black screen
const bootT0 = performance.now(), bootLog = [];
async function stage(msg) {
  bootLog.push(`${((performance.now() - bootT0) / 1000).toFixed(1)}s  ${msg}`);
  const m = $('bootMsg'), l = $('bootLog'); if (m) m.textContent = msg; if (l) l.textContent = bootLog.slice(-8).join('\n');
  await new Promise((r) => setTimeout(r, 0)); // let the page paint it
}
function bootError(e) {
  const t = String((e && (e.stack || e.message)) || e).slice(0, 1200), b = $('boot');
  if (b && !b.classList.contains('gone')) { $('bootMsg').textContent = 'stuck: ' + String((e && e.message) || e); const l = $('bootLog'); if (l) l.textContent = bootLog.join('\n') + '\n\n' + t; b.classList.add('err'); }
  else { let s = $('errStrip'); if (!s) { s = document.createElement('pre'); s.id = 'errStrip'; document.body.appendChild(s); } s.textContent = t; }
}
addEventListener('error', (e) => bootError(e.error || e.message)); addEventListener('unhandledrejection', (e) => bootError(e.reason));
await stage('starting the renderer');
const q = new URLSearchParams(location.search);
// (the device asked for the adapter's storage-buffer count per stage: the foam's pass reads the clipmap, the shore
// table, the swell field, the currents and the bulk flow at once, past WebGPU's default of 8)
const gpuLimits = await (async () => { try { const ad = navigator.gpu && await navigator.gpu.requestAdapter(); const m = ad ? ad.limits.maxStorageBuffersPerShaderStage : 8; return { maxStorageBuffersPerShaderStage: Math.min(m, 16) }; } catch (e) { return { maxStorageBuffersPerShaderStage: 8 }; } })();
const renderer = new THREE.WebGPURenderer({ antialias: !q.has('noaa'), trackTimestamp: !q.has('nots'), forceWebGL: q.has('webgl'), requiredLimits: gpuLimits });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);
await renderer.init();
await stage(`${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2 (fallback)'}: the sky and the clouds`);
const backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2 (fallback)';

const scene = new THREE.Scene();
// the sky (gpu/sky.js): the background, the aerial perspective, the sun's and the sky's light
const sky = new GpuSky(renderer);
const clouds = new GpuClouds(renderer, sky);
scene.backgroundNode = sky.background(clouds.rt.texture);
// under water (the fish's view): everything is seen through the water between it and the eye: the path in the water
// (the whole distance to a thing under the surface; to the surface along the ray for a thing above it) attenuated per
// channel (Beer-Lambert, the water's own absorption and scattering) with the water's glow in its place, dimmer with the
// depth the daylight has come down through; the air's haze above water. One fog node, the uniform switching
const UW = { on: uniform(0), level: uniform(0), sig: uniform(new THREE.Vector3(0.5, 0.12, 0.08)), alb: uniform(new THREE.Vector3(0.05, 0.3, 0.45)) };
scene.fogNode = Fn(() => {
  const air = sky.fog();
  const d = length(positionWorld.sub(cameraPosition)), v = normalize(positionWorld.sub(cameraPosition));
  const dw = select(positionWorld.y.lessThan(UW.level.add(0.05)), d, UW.level.sub(cameraPosition.y).div(max(v.y, 0.02)).min(d));
  const T = exp(UW.sig.mul(dw).negate());
  const light = sky.uSkyUp.mul(0.5).add(sky.uSunColor.mul(max(sky.uSun.y, 0)).mul(0.35)).mul(exp(UW.sig.mul(max(UW.level.sub(cameraPosition.y), 0)).negate()));
  const glow = UW.alb.mul(light).div(Math.PI);
  return mix(air, vec4(output.rgb.mul(T).add(glow.mul(float(1).sub(T))), output.a), UW.on);
})();
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 20000);
const sun = new THREE.DirectionalLight(0xfff1dc, 3.2), hemi = new THREE.HemisphereLight(0xbcd4f0, 0x4a4630, 1.1);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
const SH = 70; Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 600 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target, hemi);
const sunDir = new THREE.Vector3(0.45, 0.62, 0.3).normalize();
// the sun by the hour (a plain arc: up at 6, highest at 12 at 55 degrees, down at 18)
const keyDir = new THREE.Vector3();
// the sun by the clock and the season (index.js sunAtSeason): the real track at latitude 50 for a declination
function sunAtSeason(hour, dec) {
  const lat = 50 * Math.PI / 180, H = (hour - 12) / 24 * Math.PI * 2;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H), el = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
  const cosAz = (Math.sin(dec) - Math.sin(lat) * sinEl) / (Math.cos(lat) * Math.cos(el) + 1e-6);
  let az = Math.acos(THREE.MathUtils.clamp(cosAz, -1, 1)); if (H > 0) az = Math.PI * 2 - az;
  sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}
function sunAt(hour) { const a = (hour - 6) / 12 * Math.PI, el = Math.sin(a) * 0.96 - 0.04, az = 1.9 + (hour - 12) / 12 * Math.PI; sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize(); }

// the map's blend (0 the picture .. 1 the map) and the scale that shows its colours as they are whatever the exposure
const mapU = { uMap: uniform(0), uMapK: uniform(1) };
const mapFor = (d) => THREE.MathUtils.smoothstep(Math.log(d), Math.log(MAP.from), Math.log(MAP.to));
const pitchFor = (d) => 0.12 + 0.95 * THREE.MathUtils.smoothstep(Math.log10(d), -1.2, 3.7);
const state = { seed: 7, treeDist: 1, wind: 4, hour: +(q.get('hour') || 11), cover: +(q.get('cover') ?? 0.35), cshadow: !q.has('nocshadow'), caustics: !q.has('nocaustics'),
  spray: q.has('spray'), tideAmp: 0.8, tideSpeed: 60, trees: !q.has('notrees'), grass: !q.has('nograss2'), auto: q.has('auto'), day: +(q.get('day') ?? 100), rain: 0, haze: 1, dens: 1, kind: '', windDir: [0.94, 0.35], waterAuto: true, runoff: 0 };
let swe = null, currents = null, swellF = null, caustics, query, floaters, spray, src, clip, terrain, forest, waves, water, shore, fields, grass, wtime = 0;
async function build() {
  if (terrain) { scene.remove(terrain, forest.group, water.mesh); if (grass) scene.remove(grass.group); }
  src = wildSource({ seed: state.seed });
  await stage('the land: the clipmap'); clip = new GpuClip(renderer, src);
  await stage('the woods');   forest = new GpuForest(renderer, clip, src, { range: 1 });
  const surfU = surfUniforms(src.sea);
  terrain = gpuTerrain(clip, { sea: src.sea, bands: forest.uBands, surf: q.has('noshore') ? null : surfU, map: mapU });
  await stage('the waves'); waves = new GpuWaves(renderer, { cascades: src.water.cascades, fetch: src.water.fetch, salt: src.cosmetic | 0 });
  await stage('the shore table'); shore = q.has('noshore') ? null : new GpuShore(renderer, src);
  await stage('the swell field and the currents'); swellF = q.has('noswell') ? null : new GpuSwellField(renderer, src);
  swe = q.has('notide') ? null : new GpuTide(renderer, src); // the tide, baked and replayed (gpu/tide.js)
  currents = swellF && !q.has('nocurrents') ? new GpuCurrents(renderer, src, swellF) : null;
  await stage('the foam, the water'); fields = q.has('nofield') ? null : [GFOAM.far, GFOAM.near].map((level) => new GpuFoamField(renderer, { clip, waves, shore, surfU, level, swell: swellF, currents, swe: gpuLimits.maxStorageBuffersPerShaderStage >= 9 ? swe : null }));
  water = gpuWater(clip, waves, { swe, swell: swellF, sky, clouds, ssr: !q.has('nossr'), sunColor: sky.uSunColor, skyUp: sky.uSkyUp, skyHz: sky.uSkyHz, waterAt: (x, z) => src.waterAt(x, z), shore, sea: src.sea, renderer, surfU, fields, map: mapU, debug: +(q.get('wdebug') || 0) });
  if (!q.has('nowater')) scene.add(water.mesh);
  if (!q.has('noterrain')) scene.add(terrain);
  await stage('the grass'); grass = q.has('nograss') ? null : new GpuGrass(renderer, { clip, source: src, sunDir: water.U.uSunDir, sunColor: sky.uSunColor, clouds }); if (grass) scene.add(grass.group);
  if (!q.has('noforest')) scene.add(forest.group);
  // the clouds' shadow on every lit thing's sun (the water and the grass's translucency take it themselves)
  // and on the ground under water, the waves' caustics
  await stage('caustics, spray, floaters'); caustics = new GpuCaustics(clip, waves, water.U.uSunDir, renderer); caustics.tide = swe; caustics.uOn.value = state.caustics ? 1 : 0;
  clouds.receive(terrain.material, q.has('nocaustics') ? null : caustics.at());
  for (const o of [forest.group, grass && grass.group, player.mesh]) if (o) o.traverse((m) => { if (m.material) clouds.receive(m.material); });
  // the breakers' spray
  if (spray) scene.remove(spray.mesh);
  spray = shore && !q.has('nospray') ? new GpuSpray(renderer, { clip, shore, surfU, sunDir: water.U.uSunDir, sunColor: sky.uSunColor, skyUp: sky.uSkyUp, clouds }) : null; if (spray) scene.add(spray.mesh);
  // buoyancy (the water pack's floaters on the GPU water's heights): B drops a few things in the water ahead
  if (floaters) { floaters.clear(); scene.remove(floaters.scene); }
  query = new GpuWaterQuery(renderer, clip, waves, water.U.uChop);
  floaters = new Floaters({ scene, heightAt: (x, z) => src.height(x, z), patchMaterial: (m) => clouds.receive(m) });
  clip.build(cam.fx, cam.fz);
}

// the camera: an orbit round a focus on the ground, as the template's
const cam = { fx: 0, fz: 0, yaw: 0.8, look: 0, dist: 60 };
// ?at=x,z[,yaw]: start there (?at=coast: a beach of seed 7, facing the sea)
{ const a = q.get('at'); if (a === 'coast') Object.assign(cam, { fx: -1438, fz: 1317, yaw: 2.31, dist: 40, look: 0.1 }); else if (a) { const [x, z, y] = a.split(',').map(Number); cam.fx = x || 0; cam.fz = z || 0; if (Number.isFinite(y)) cam.yaw = y; } }
// no place asked for: a meadow by the sea looking along the shore (as the template's findStart)
if (!q.get('at')) {
  const s = wildSource({ seed: state.seed });
  let best = null;
  for (let r = 0; r < 12000 && !best; r += 60) for (let a = 0; a < 6.283; a += 0.3) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r, o = s.sample(x, z);
    if (o[0] > 2 && o[0] < 7 && o[2] < 0.3 && o[4] <= s.sea) { let ok = true; for (let k = 1; k <= 5 && ok; k++) { const w = s.sample(x + 60 * k * Math.cos(a), z + 60 * k * Math.sin(a)); ok = w[0] < s.sea - 1; } if (ok) { best = { x, z }; break; } }
  }
  if (best) { cam.fx = best.x; cam.fz = best.z; }
}
const keys = new Set();
addEventListener('keydown', (e) => keys.add(e.code)); addEventListener('keyup', (e) => keys.delete(e.code));
let drag = null;
const cv = renderer.domElement;
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => { if (e.button === 2) { if (player.on) player.fp = !player.fp; return; } drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, look: cam.look, id: e.pointerId }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => { if (drag && drag.id === e.pointerId) { cam.yaw = drag.yaw - (e.clientX - drag.x) * 0.005; cam.look = THREE.MathUtils.clamp(drag.look - (e.clientY - drag.y) * 0.005, -1.45, 1.45); } });
cv.addEventListener('pointerup', () => { drag = null; });
cv.addEventListener('wheel', (e) => { e.preventDefault(); if (player.on) player.d = THREE.MathUtils.clamp(player.d * (1 + e.deltaY * 0.001), 1.2, 40); else cam.dist = THREE.MathUtils.clamp(cam.dist * (1 + e.deltaY * 0.0012), 0.5, 6000); }, { passive: false });
addEventListener('keydown', (e) => { if (e.code === 'KeyH' && !e.repeat) $('hud').hidden = !$('hud').hidden; // H: the panel away and back
  if (e.code === 'KeyP' && !e.repeat) setPlayer(!player.on); if (e.code === 'KeyB' && !e.repeat) dropFloaters(); });
// the flotsam: a boat, a buoy, crates and barrels in the water ahead of the eye (or of the player)
function dropFloaters() {
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
  const c = player.on ? player.pos.clone() : new THREE.Vector3(cam.fx, 0, cam.fz);
  floaters.spawn(c, fwd);
  for (const b of floaters.bodies) { const w = Math.max(src.height(b.pos.x, b.pos.z), src.waterAt ? src.waterAt(b.pos.x, b.pos.z) : src.sea); b.pos.y = w + 0.6; b.updateWorld(); }
}

// the player cube (P), as the template's: third person, the right button for first person
const player = { on: false, fp: false, d: 4, pos: new THREE.Vector3(), mesh: null };
function setPlayer(on) {
  player.on = on;
  if (on && !player.mesh) {
    const g = new THREE.BoxGeometry(0.5, 0.5, 0.5).toNonIndexed(), cols = [[0.9, 0.15, 0.1], [0.1, 0.7, 0.2], [0.95, 0.85, 0.1], [0.2, 0.3, 0.9], [0.9, 0.9, 0.9], [0.8, 0.2, 0.8]], c = [];
    for (let f = 0; f < 6; f++) for (let v = 0; v < 6; v++) c.push(...cols[f]);
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    player.mesh = new THREE.Mesh(g, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6 })); player.mesh.castShadow = true;
    clouds.receive(player.mesh.material); scene.add(player.mesh);
  }
  if (on) { player.pos.set(cam.fx, src.height(cam.fx, cam.fz) + 1.2, cam.fz); cam.look = -0.25; }
  if (player.mesh) player.mesh.visible = on;
}
const ground = (x, z) => Math.max(src.height(x, z), src.waterAt ? src.waterAt(x, z) : src.sea);

function step(dt) {
  const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const side = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1;
  const dir = new THREE.Vector3(-Math.sin(cam.yaw) * Math.cos(cam.look), Math.sin(cam.look), -Math.cos(cam.yaw) * Math.cos(cam.look));
  if (player.on) {
    const up = (keys.has('Space') || keys.has('KeyE') ? 1 : 0) - (keys.has('KeyC') || keys.has('KeyQ') ? 1 : 0), sp = 4 * fast;
    player.pos.x += (-Math.sin(cam.yaw) * fwd + Math.cos(cam.yaw) * side) * sp * dt;
    player.pos.z += (-Math.cos(cam.yaw) * fwd - Math.sin(cam.yaw) * side) * sp * dt;
    player.pos.y = Math.max(player.pos.y + up * sp * dt, src.height(player.pos.x, player.pos.z) + 0.3); // (the floor, not the water: it can dive)
    player.mesh.position.copy(player.pos); player.mesh.rotation.set(0, cam.yaw, 0); player.mesh.visible = !player.fp;
    cam.map = 0; camera.fov = 55;
    if (player.fp) { camera.position.copy(player.pos).y += 0.1; camera.lookAt(camera.position.clone().add(dir)); }
    else { camera.position.copy(player.pos).addScaledVector(dir, -player.d); camera.position.y = Math.max(camera.position.y + 0.4, src.height(camera.position.x, camera.position.z) + 0.15); camera.lookAt(player.pos.x, player.pos.y + 0.3, player.pos.z); }
    cam.fx = player.pos.x; cam.fz = player.pos.z;
  } else {
    const sp = Math.max(0.4, cam.dist * 0.6) * fast;
    cam.fx += (-Math.sin(cam.yaw) * fwd + Math.cos(cam.yaw) * side) * sp * dt;
    cam.fz += (-Math.cos(cam.yaw) * fwd - Math.sin(cam.yaw) * side) * sp * dt;
    // into the map (map.js, as the template's): the view tips toward straight down, narrows (backing off to keep the
    // framing) and turns north-up
    const gy = ground(cam.fx, cam.fz), m = cam.map = mapFor(cam.dist), pitch = THREE.MathUtils.lerp(pitchFor(cam.dist), MAP.pitch, m);
    const fov = THREE.MathUtils.lerp(55, MAP.fov, m), back = Math.tan(55 / 2 * Math.PI / 180) / Math.tan(fov / 2 * Math.PI / 180), D = cam.dist * THREE.MathUtils.lerp(1, back, m);
    if (m > 0.5 && !drag) cam.yaw += (0 - cam.yaw) * Math.min(1, dt * 1.5 * (m - 0.5) * 2);
    camera.fov = fov;
    camera.position.set(cam.fx + Math.sin(cam.yaw) * Math.cos(pitch) * D, gy + Math.sin(pitch) * D, cam.fz + Math.cos(cam.yaw) * Math.cos(pitch) * D);
    camera.position.y = Math.max(camera.position.y, ground(camera.position.x, camera.position.z) + 0.3);
    camera.lookAt(cam.fx, gy, cam.fz); if (cam.look) camera.rotateX(cam.look);
  }
  camera.near = THREE.MathUtils.clamp(cam.dist * 0.01, 0.03, 5); camera.updateProjectionMatrix();
  // the sun, the sky's tables and the light they give; the exposure follows the light (index.js: a grey card facing up
  // maps to 0.18 when exposure = pi / E)
  // the weather and the season (seasons.js): by the clock, or the sliders'
  const S = seasonAt(state.day);
  if (state.auto) {
    const E = weatherAt(state.seed, state.day, state.hour), wl = Math.hypot(E.wind[0], E.wind[1]);
    Object.assign(state, { cover: E.cover, wind: wl, rain: E.rain, haze: Math.round(Math.min(E.haze, 3) * 20) / 20, dens: E.cloudDens, kind: E.kind });
    if (wl > 1e-3) state.windDir = [E.wind[0] / wl, E.wind[1] / wl];
    sunAtSeason(state.hour, S.dec);
  } else { state.haze = 1; state.dens = 1; sunAtSeason(state.hour, S.dec); } // the season's track always (as the old water's)
  // the season on the leaves and the grass (seasons.js seasonAt, as index.js)
  if (forest) { forest.uLeafTint.value.set(...S.leafTint); forest.uAutumn.value = S.autumn; forest.uLeafGone.value = S.leafGone; forest.uSnowOn.value = S.snow; }
  if (terrain && terrain.uSnowLine) terrain.uSnowLine.value = (src.sea ?? 0) + S.snowLine;
  if (grass) { grass.uTint.value.set(...S.grassTint); grass.uBloom.value = S.bloom; grass.uSnowCover.value = S.snow; }
  state.runoff += (state.rain - state.runoff) * Math.min(1, dt / 6); // the rivers and the shore muddy as the rain goes on
  sky.update(sunDir, Math.max(1, camera.position.y - (src.sea ?? 0)), state.haze); sky.uSea.value = src.sea ?? 0;
  // the key light: the sun by day, the moon by night (its light and its shadows), crossing at dusk
  const mc = sky.uMoonColor.value, night = 1 - THREE.MathUtils.smoothstep(sunDir.y, -0.1, 0.05), md = sky.uMoonDir.value;
  keyDir.copy(sunDir).lerp(md, night).normalize();
  // the cloud cover's light (index.js): the sun dimmed through the deck (its patches are the shadow's map), the sky's light
  // dimmer and greyer under it; the exposure follows most of the way (an overcast day, or a cloud's shadow, reads a little darker)
  const lumOf = (c, u, g2) => 0.2126 * (c.r * g2 + u.r) + 0.7152 * (c.g * g2 + u.g) + 0.0722 * (c.b * g2 + u.b);
  const clearLum = lumOf(sky.sunColor, sky.skyUp, Math.max(0, sunDir.y));
  if (sky._to) { const cv = state.cover, through = 1 - 0.85 * THREE.MathUtils.smoothstep(cv, 0.3, 0.95), dim = 1 - 0.3 * cv, grey = 0.6 * THREE.MathUtils.smoothstep(cv, 0.2, 0.9);
    // the deck's own light: the sun it stops comes down scattered, a bright grey sky over an overcast day (its diffuse
    // light two or three times a clear blue sky's), so the ground under a cloud is dim, not black
    const sl = (0.2126 * sky.sunColor.r + 0.7152 * sky.sunColor.g + 0.0722 * sky.sunColor.b) * Math.max(0, sunDir.y) * 0.3 * cv * (1 - 0.5 * cv);
    const deck = new THREE.Color().copy(sky.sunColor).lerp(new THREE.Color(1, 1, 1).multiplyScalar(0.2126 * sky.sunColor.r + 0.7152 * sky.sunColor.g + 0.0722 * sky.sunColor.b), 0.7);
    deck.multiplyScalar(sl / Math.max(1e-4, 0.2126 * deck.r + 0.7152 * deck.g + 0.0722 * deck.b));
    sky.sunColor.multiplyScalar(through);
    for (const c of [sky.skyUp, sky.skyHorizon]) { const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; c.lerp(new THREE.Color(l, l, l * 1.03), grey).multiplyScalar(dim); }
    sky.skyUp.add(deck); sky.skyHorizon.add(deck.multiplyScalar(0.6));
    sky.uSunColor.value.copy(sky.sunColor); sky.uSkyUp.value.copy(sky.skyUp); sky.uSkyHz.value.copy(sky.skyHorizon); }
  sun.color.copy(sky.sunColor).add(mc); sun.intensity = 1; hemi.color.setRGB(sky.skyUp.r + 0.25 * mc.r, sky.skyUp.g + 0.25 * mc.g, sky.skyUp.b + 0.25 * mc.b); hemi.groundColor.copy(hemi.color).multiplyScalar(0.25); hemi.intensity = 1;
  // the eye's adaptation: to the light where it looks (the cloud's shadow there, read back from the GPU), eased
  { const fp = player.on ? player.pos : new THREE.Vector3(cam.fx, ground(cam.fx, cam.fz), cam.fz); clouds.probe(fp);
    state.adapt = (state.adapt ?? 1) + ((clouds.light ?? 1) - (state.adapt ?? 1)) * Math.min(1, dt * 1.5); }
  { const lum = Math.pow(clearLum, 0.3) * Math.pow(Math.max(lumOf(sky.sunColor, sky.skyUp, Math.max(0, sunDir.y) * (state.cshadow ? state.adapt : 1)), 1e-4), 0.7), lumM = (0.2126 * mc.r + 0.7152 * mc.g + 0.0722 * mc.b) * Math.max(0, md.y);
    renderer.toneMappingExposure = THREE.MathUtils.clamp(Math.PI / Math.max(lum + lumM, 0.05), 0.02, 40); }
  // the map: its blend, and the woods and grass giving way to it
  mapU.uMap.value = cam.map || 0; mapU.uMapK.value = 0.85 / Math.max(renderer.toneMappingExposure, 1e-3);
  forest.group.visible = !q.has('noforest') && state.trees && (cam.map || 0) < 0.55;
  if (grass) grass.group.visible = state.grass;
  updatePins();
  // the sun's shadow box follows the eye
  const f = player.on ? player.pos : new THREE.Vector3(cam.fx, ground(cam.fx, cam.fz), cam.fz);
  sun.target.position.copy(f); sun.position.copy(f).addScaledVector(keyDir, 300);
  clip.update(camera.position.x, camera.position.z, dt);
  if (forest.rangeK !== state.treeDist) forest.setRange(state.treeDist);
  if (!q.has('noforest') && state.trees) forest.update(camera, dt, [state.wind * state.windDir[0], state.wind * state.windDir[1]]);
  // the swell (index.js): from a long fetch at the wind (never under the sea's minimum), and the surf it drives
  wtime += dt;
  const w10 = [Math.max(state.wind, 1.5) * state.windDir[0], Math.max(state.wind, 1.5) * state.windDir[1]];
  clouds.set(state.cover, state.dens, dt, [w10[0] * 0.35, w10[1] * 0.35]); // (drifting as the old water's: index.js E.wind)
  const sw = swellState(Math.max(Math.hypot(w10[0], w10[1]), WAVES.swellMin), src.water.swellFetch || src.water.fetch);
  const swell = { Hs: Math.max(WAVES.swellHmin, sw.Hs), T: Math.min(10.5, Math.max(WAVES.swellT - 1, WAVES.swellT - 1 + 2.5 * sw.Hs)) };
  waves.update(wtime, w10, Math.PI * 60, swell);
  water.U.uSurf.value.set(Math.min(1.5, Math.max(0.2, 0.35 + 0.55 * swell.Hs)), Math.min(60, Math.max(12, 0.45 * 9.81 * swell.T * swell.T / (2 * Math.PI))), 1, 1);
  if (swellF) { const U = Math.hypot(w10[0], w10[1]); swellF.update(camera.position, waves.U.swDir.value, swell.T, new THREE.Vector2(w10[0], w10[1]).normalize(), water.U.uSurf.value.x, Math.max(2, 0.785 * U), 0.35 * 0.21 * U * U / 9.81); } // (the wind sea's peak: Pierson-Moskowitz)
  if (swe) swe.update(camera.position, dt, state.tideAmp, state.tideSpeed);
  if (currents && swellF) currents.update(camera.position, swellF.key, water.U.uSurf.value.x);
  water.look.uWind.value = Math.hypot(w10[0], w10[1]);
  water.U.uWTime.value = wtime; water.U.uTime.value = wtime; water.U.uSwDir.value.copy(waves.U.swDir.value);
  if (shore) shore.update(camera.position, !shore._built); if (shore) shore._built = true;
  // the water's look: the panel's settings, moved by the weather and the season
  { const L = state.look, pr = GWATER_PRESETS[L.preset] || GWATER_PRESETS.ours, A = state.waterAuto, ro = A ? state.runoff : 0;
    const summer = A ? S.summer : 0, winter = A ? S.winter : 0, spring = A ? S.spring : 0, wk = A ? THREE.MathUtils.clamp((state.wind - 6) * 0.03, -0.08, 0.3) : 0;
    const lk = water.look;
    lk.uAbs.value.set(pr.absorb[0], pr.absorb[1], pr.absorb[2] + 0.25 * summer);
    lk.uSca.value.set(pr.scatter[0], pr.scatter[1] + 0.015 * summer, pr.scatter[2]);
    lk.uLook.value.set(L.clarity * (1 + 0.35 * winter - 0.3 * ro), L.murk * (1 + 1.2 * ro + 0.5 * summer), L.roughness + (A ? 0.03 * state.rain : 0), L.refraction);
    lk.uLook2.value.set(L.sssPeak, L.sssView, L.foamBias + wk, L.foamScale);
    lk.uSed.value.set(L.sediment + 0.35 * ro + 0.12 * spring, L.stir * (1 + ro), L.riverSilt * (1 + 1.5 * ro + 0.6 * spring), L.bubbles ?? 1);
    lk.uHs.value = Math.max(0.1, (waves.stats && waves.stats.Hs) || 0.5);
    if (caustics) caustics.uStrength.value = L.caustics;
    lk.uLip.value = L.lip; if (spray) spray.uRate.value = L.spray * (A ? 1 + 0.08 * Math.max(0, state.wind - 5) : 1);
    if (fields) for (const f of fields) { f.uBias.value = L.foamBias + wk; f.uScale.value = L.foamScale; f.update(dt, camera, w10, L.linger); } }
  if (grass && state.grass) grass.update(camera, ground(camera.position.x, camera.position.z), w10, dt);
  water.U.uSunDir.value.copy(sunDir);
  { const wl = src.waterAt ? src.waterAt(camera.position.x, camera.position.z) : src.sea, isSea = wl <= (src.sea ?? 0) + 0.5;
    const tideNow = swe && isSea ? swe.R.amp.value * Math.cos(swe.R.phase.value) : 0;
    UW.level.value = wl + tideNow; const under = camera.position.y < UW.level.value - 0.03; UW.on.value = under ? 1 : 0; water.U.uUnder.value = UW.on.value;
    const lk = water.look, a = lk.uAbs.value, sc = lk.uSca.value, L = lk.uLook.value;
    UW.sig.value.set(a.x / Math.max(L.x, 0.05) + sc.x * L.y, a.y / Math.max(L.x, 0.05) + sc.y * L.y, a.z / Math.max(L.x, 0.05) + sc.z * L.y);
    UW.alb.value.set(sc.x * L.y / UW.sig.value.x, sc.y * L.y / UW.sig.value.y, sc.z * L.y / UW.sig.value.z); }
  if (caustics) caustics.update(sunDir, state.caustics && !q.has('nocaustics'));
  if (spray) spray.update(camera, dt, w10, state.spray);
  // the floaters: their cells' points to the GPU, last frames' heights back, the bodies stepped
  if (floaters && floaters.bodies.length) { const pts = floaters.collectPoints([]); query.submit(pts, floaters.count, floaters.layout, wtime); floaters.ingest(query, 0); floaters.step(dt); }
}


// the map's pins: places scanned from the source (map.js Places), projected each frame, clustered when they crowd
let places = null, cardPlace = null; const pinEls = [];
function updatePins() {
  const m = cam.map || 0, layer = $('pins');
  if (!places || places.src !== src) places = new Places(src, { cell: 220, radius: 6000 });
  if (m > 0.02) places.scan(cam.fx, cam.fz, 2);
  const on = m > 0.15, W = innerWidth, H = innerHeight, V = new THREE.Vector3(), shown = [];
  if (on) {
    for (const p of [{ kind: 'you', name: 'you', x: cam.fx, z: cam.fz }, ...places.list]) {
      V.set(p.x, ground(p.x, p.z), p.z).project(camera);
      if (V.z > 1 || Math.abs(V.x) > 1.05 || Math.abs(V.y) > 1.05) continue;
      const sx = ((V.x * 0.5 + 0.5) * (1 + 2 * (over ? OVER : 0)) - (over ? OVER : 0)) * W, sy = ((-V.y * 0.5 + 0.5) * (1 + 2 * (over ? OVER : 0)) - (over ? OVER : 0)) * H; // (the guard band's view)
      const near = shown.find((s) => s.kind === p.kind && Math.hypot(s.sx - sx, s.sy - sy) < 34);
      if (near && p.kind !== 'you') { near.n++; continue; }
      shown.push({ p, sx, sy, n: 1, kind: p.kind }); if (shown.length > 60) break;
    }
  }
  while (pinEls.length < shown.length) { const e = document.createElement('div'); e.className = 'pin'; e.addEventListener('click', () => openCard(e._p)); layer.appendChild(e); pinEls.push(e); }
  pinEls.forEach((e, i) => { const s = shown[i]; if (!s) { e.classList.remove('on'); return; } e._p = s.p; e.className = 'pin on ' + s.kind; e.style.left = s.sx + 'px'; e.style.top = s.sy + 'px'; e.innerHTML = s.p.name + (s.n > 1 ? `<span class="n">+${s.n - 1}</span>` : ''); });
}
function openCard(p) {
  if (p.kind === 'you') return;
  cardPlace = p;
  const c = placeCard(p, { x: cam.fx, z: cam.fz }, { bloom: 1, freeze: 0, autumn: 0, t: 0.5 });
  $('card').querySelector('.t').textContent = c.title; $('card').querySelector('.k').textContent = `${c.kind} · ${c.sub || ''} · ${c.dist} away`;
  $('card').querySelector('.b').innerHTML = c.lines.map((l) => `<div>${l}</div>`).join('');
  $('card').hidden = false;
}
$('bCardX').addEventListener('click', () => { $('card').hidden = true; });
$('bCardGo').addEventListener('click', () => { if (cardPlace) { cam.fx = cardPlace.x; cam.fz = cardPlace.z; cam.dist = 60; } $('card').hidden = true; });
// the guard band (OVER of the view on each side): the scene is drawn over a view 10% larger than the screen and the
// screen shows its middle, so the GPU's culling (trees, grass), the reflections and the refraction all see past the
// screen's edges (no reflection starting late at the sides, a turn of the view finds things already drawn)
const OVER = 0.05;
const over = q.has('offscreen') ? null : new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: q.has('noaa') ? 0 : 4 });
const overQuad = over ? new THREE.QuadMesh(Object.assign(new THREE.MeshBasicNodeMaterial(), { colorNode: texture(over.texture, uv().mul(1 / (1 + 2 * OVER)).add(OVER / (1 + 2 * OVER))) })) : null;
function resize() {
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h); camera.aspect = w / h;
  if (over) { camera.setViewOffset(w, h, -OVER * w, -OVER * h, w * (1 + 2 * OVER), h * (1 + 2 * OVER)); const d = renderer.getPixelRatio(); over.setSize(Math.round(w * (1 + 2 * OVER) * d), Math.round(h * (1 + 2 * OVER) * d)); }
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
$('treeDist').addEventListener('input', (e) => { state.treeDist = parseFloat(e.target.value); $('oTreeDist').textContent = Math.round(state.treeDist * 100) + '%'; });
$('oTreeDist').textContent = '100%';
$('cover').value = state.cover; $('oCover').textContent = Math.round(state.cover * 100) + '%';
$('cover').addEventListener('input', (e) => { state.cover = parseFloat(e.target.value); $('oCover').textContent = Math.round(state.cover * 100) + '%'; });
{ const b = $('caustics'); if (b) { b.checked = state.caustics; b.addEventListener('change', () => { state.caustics = b.checked; if (caustics) caustics.uOn.value = b.checked ? 1 : 0; }); } }
{ const b = $('cshadow'); if (b) { b.checked = state.cshadow; b.addEventListener('change', () => { state.cshadow = b.checked; }); } }
const panel = buildPanel($('hud'), state);
$('hour').value = state.hour; const showHour = () => { const h = Math.floor(state.hour), m = Math.round((state.hour - h) * 60); $('oHour').textContent = `${h}:${String(m).padStart(2, '0')}`; }; showHour();
$('hour').addEventListener('input', (e) => { state.hour = parseFloat(e.target.value); showHour(); });
await build();
await stage('the first frame: compiling the shaders (the longest wait)');

let last = performance.now(), fps = 0, frames = 0, ft = 0, gpuMs = 0, counts = null, countT = 0, manual = false;
let bootFrames = 0;
async function frame(now) {
  if (manual) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  step(dt);
  draw();
  if (++bootFrames === 3) { const b = $('boot'); if (b && !b.classList.contains('err')) b.classList.add('gone'); } // the world is running
  frames++; ft += dt;
  if (ft > 0.5) {
    fps = frames / ft; frames = 0; ft = 0;
    try { await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER); await renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE); gpuMs = (renderer.info.render.timestamp || 0) + (renderer.info.compute.timestamp || 0); } catch (e) { gpuMs = 0; }
    if (now - countT > 1000) { countT = now; forest.counts().then((c) => { counts = c; }); }
    const ml = forest.lists, trees = counts ? counts.reduce((a, b) => a + b, 0) : 0, byL = counts ? [0, 1, 2].map((l) => counts.filter((_, i) => i < ml && i % 3 === l).reduce((a, b) => a + b, 0)).concat([counts.slice(ml).reduce((a, b) => a + b, 0)]) : [0, 0, 0, 0];
    panel.refresh(); if (state.auto && document.activeElement !== $('cover')) { $('cover').value = state.cover; $('oCover').textContent = Math.round(state.cover * 100) + '%'; }
    $('stats').textContent = `${backend} · ${fps.toFixed(0)} fps · gpu ${gpuMs ? gpuMs.toFixed(2) + ' ms' : '…'} · ${renderer.info.render.drawCalls} draws · ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris\ntrees drawn ${trees} (near ${byL[0]}, mid ${byL[1]}, far ${byL[2]}, cards ${byL[3]}) of ${forest.stats.cells} cached cells culled on the GPU · ${forest.stats.tiles} tiles placed once · reach ${forest.R.toFixed(0)} m` + (player.on ? `\nplayer (P off) · ${player.fp ? 'first person' : 'third person'} (right button)` : '');
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// tests (headless): ?offscreen draws into a target instead of the canvas (a headless browser's WebGPU may not
// present), and snap() reads it back tone-mapped (ACES, sRGB) as a PNG data URL
const off = q.has('offscreen') ? new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType }) : null;
function draw() { { const sz = renderer.getDrawingBufferSize(new THREE.Vector2()); clouds.render(camera, off ? off.width : over ? over.width : sz.x, off ? off.height : over ? over.height : sz.y); clouds.shadow(camera, sunDir, state.cshadow); clouds.renderEnv(); }
  draw2(); }
function draw2() { if (off) { const w = innerWidth, h = innerHeight; if (off.width !== w || off.height !== h) off.setSize(w, h); renderer.setRenderTarget(off); renderer.render(scene, camera); renderer.setRenderTarget(null); } else { renderer.setRenderTarget(over); renderer.render(scene, camera); renderer.setRenderTarget(null); overQuad.render(renderer); } }
async function snap() {
  const w = off.width, h = off.height, px = await renderer.readRenderTargetPixelsAsync(off, 0, 0, w, h), cv2 = document.createElement('canvas'); cv2.width = w; cv2.height = h;
  const c2 = cv2.getContext('2d'), im = c2.createImageData(w, h), toF = THREE.DataUtils.fromHalfFloat, aces = (x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))), srgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, o = i; /* WebGPU reads back top row first */ for (let c = 0; c < 3; c++) im.data[o + c] = 255 * srgb(aces(toF(px[i + c]) * 0.6 * renderer.toneMappingExposure)); im.data[o + 3] = 255; }
  c2.putImageData(im, 0, 0); return cv2.toDataURL('image/png');
}
window.__gpu = { snap, draw, renderer, scene, camera, cam, state, player, get caustics() { return caustics; }, clouds, drop: () => dropFloaters(), get floaters() { return floaters; }, get query() { return query; }, get spray() { return spray; }, get swellF() { return swellF; }, get currents() { return currents; }, get swe() { return swe; }, setPlayer, get forest() { return forest; }, get grass() { return grass; }, sky, get clip() { return clip; }, manual(on) { manual = on; if (!on) { last = performance.now(); requestAnimationFrame(frame); } }, step, async counts() { return forest.counts(); }, render() { draw(); } };
