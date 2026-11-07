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
import { GpuSky } from './sky.js';
import { WAVES, swellState } from '../waves.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const renderer = new THREE.WebGPURenderer({ antialias: !q.has('noaa'), trackTimestamp: !q.has('nots'), forceWebGL: q.has('webgl') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);
await renderer.init();
const backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2 (fallback)';

const scene = new THREE.Scene();
// the sky (gpu/sky.js): the background, the aerial perspective, the sun's and the sky's light
const sky = new GpuSky(renderer);
scene.backgroundNode = sky.background(); scene.fogNode = sky.fog();
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 20000);
const sun = new THREE.DirectionalLight(0xfff1dc, 3.2), hemi = new THREE.HemisphereLight(0xbcd4f0, 0x4a4630, 1.1);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
const SH = 70; Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 600 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target, hemi);
const sunDir = new THREE.Vector3(0.45, 0.62, 0.3).normalize();
// the sun by the hour (a plain arc: up at 6, highest at 12 at 55 degrees, down at 18)
const keyDir = new THREE.Vector3();
function sunAt(hour) { const a = (hour - 6) / 12 * Math.PI, el = Math.sin(a) * 0.96 - 0.04, az = 1.9 + (hour - 12) / 12 * Math.PI; sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize(); }

const state = { seed: 7, treeDist: 1, wind: 4, hour: +(q.get('hour') || 11) };
let src, clip, terrain, forest, waves, water, shore, fields, grass, wtime = 0;
function build() {
  if (terrain) { scene.remove(terrain, forest.group, water.mesh); if (grass) scene.remove(grass.group); }
  src = wildSource({ seed: state.seed });
  clip = new GpuClip(renderer, src);
  forest = new GpuForest(renderer, clip, src, { range: 1 });
  const surfU = surfUniforms(src.sea);
  terrain = gpuTerrain(clip, { sea: src.sea, bands: forest.uBands, surf: q.has('noshore') ? null : surfU });
  waves = new GpuWaves(renderer, { cascades: src.water.cascades, fetch: src.water.fetch, salt: src.cosmetic | 0 });
  shore = q.has('noshore') ? null : new GpuShore(renderer, src);
  fields = q.has('nofield') ? null : [GFOAM.far, GFOAM.near].map((level) => new GpuFoamField(renderer, { clip, waves, shore, surfU, level }));
  water = gpuWater(clip, waves, { sunColor: sky.uSunColor, skyUp: sky.uSkyUp, skyHz: sky.uSkyHz, waterAt: (x, z) => src.waterAt(x, z), shore, sea: src.sea, renderer, surfU, fields, debug: +(q.get('wdebug') || 0) });
  if (!q.has('nowater')) scene.add(water.mesh);
  if (!q.has('noterrain')) scene.add(terrain);
  grass = q.has('nograss') ? null : new GpuGrass(renderer, { clip, source: src, sunDir: water.U.uSunDir, sunColor: sky.uSunColor }); if (grass) scene.add(grass.group);
  if (!q.has('noforest')) scene.add(forest.group);
  clip.build(cam.fx, cam.fz);
}

// the camera: an orbit round a focus on the ground, as the template's
const cam = { fx: 0, fz: 0, yaw: 0.8, look: 0, dist: 60 };
// ?at=x,z[,yaw]: start there (?at=coast: a beach of seed 7, facing the sea)
{ const a = q.get('at'); if (a === 'coast') Object.assign(cam, { fx: -1438, fz: 1317, yaw: 2.31, dist: 40, look: 0.1 }); else if (a) { const [x, z, y] = a.split(',').map(Number); cam.fx = x || 0; cam.fz = z || 0; if (Number.isFinite(y)) cam.yaw = y; } }
const keys = new Set();
addEventListener('keydown', (e) => keys.add(e.code)); addEventListener('keyup', (e) => keys.delete(e.code));
let drag = null;
const cv = renderer.domElement;
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => { if (e.button === 2) { if (player.on) player.fp = !player.fp; return; } drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, look: cam.look, id: e.pointerId }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => { if (drag && drag.id === e.pointerId) { cam.yaw = drag.yaw - (e.clientX - drag.x) * 0.005; cam.look = THREE.MathUtils.clamp(drag.look - (e.clientY - drag.y) * 0.005, -1.45, 1.45); } });
cv.addEventListener('pointerup', () => { drag = null; });
cv.addEventListener('wheel', (e) => { e.preventDefault(); if (player.on) player.d = THREE.MathUtils.clamp(player.d * (1 + e.deltaY * 0.001), 1.2, 40); else cam.dist = THREE.MathUtils.clamp(cam.dist * (1 + e.deltaY * 0.0012), 0.5, 6000); }, { passive: false });
addEventListener('keydown', (e) => { if (e.code === 'KeyP' && !e.repeat) setPlayer(!player.on); });

// the player cube (P), as the template's: third person, the right button for first person
const player = { on: false, fp: false, d: 4, pos: new THREE.Vector3(), mesh: null };
function setPlayer(on) {
  player.on = on;
  if (on && !player.mesh) {
    const g = new THREE.BoxGeometry(0.5, 0.5, 0.5).toNonIndexed(), cols = [[0.9, 0.15, 0.1], [0.1, 0.7, 0.2], [0.95, 0.85, 0.1], [0.2, 0.3, 0.9], [0.9, 0.9, 0.9], [0.8, 0.2, 0.8]], c = [];
    for (let f = 0; f < 6; f++) for (let v = 0; v < 6; v++) c.push(...cols[f]);
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    player.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 })); player.mesh.castShadow = true;
    scene.add(player.mesh);
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
    player.pos.y = Math.max(player.pos.y + up * sp * dt, ground(player.pos.x, player.pos.z) + 0.3);
    player.mesh.position.copy(player.pos); player.mesh.rotation.set(0, cam.yaw, 0); player.mesh.visible = !player.fp;
    if (player.fp) { camera.position.copy(player.pos).y += 0.1; camera.lookAt(camera.position.clone().add(dir)); }
    else { camera.position.copy(player.pos).addScaledVector(dir, -player.d); camera.position.y = Math.max(camera.position.y + 0.4, ground(camera.position.x, camera.position.z) + 0.15); camera.lookAt(player.pos.x, player.pos.y + 0.3, player.pos.z); }
    cam.fx = player.pos.x; cam.fz = player.pos.z;
  } else {
    const sp = Math.max(0.4, cam.dist * 0.6) * fast;
    cam.fx += (-Math.sin(cam.yaw) * fwd + Math.cos(cam.yaw) * side) * sp * dt;
    cam.fz += (-Math.cos(cam.yaw) * fwd - Math.sin(cam.yaw) * side) * sp * dt;
    const gy = ground(cam.fx, cam.fz), pitch = 0.12 + 0.9 * THREE.MathUtils.smoothstep(Math.log10(cam.dist), 0, 3.5);
    camera.position.set(cam.fx + Math.sin(cam.yaw) * Math.cos(pitch) * cam.dist, gy + Math.sin(pitch) * cam.dist, cam.fz + Math.cos(cam.yaw) * Math.cos(pitch) * cam.dist);
    camera.position.y = Math.max(camera.position.y, ground(camera.position.x, camera.position.z) + 0.3);
    camera.lookAt(cam.fx, gy, cam.fz); if (cam.look) camera.rotateX(cam.look);
  }
  camera.near = THREE.MathUtils.clamp(cam.dist * 0.01, 0.03, 5); camera.updateProjectionMatrix();
  // the sun, the sky's tables and the light they give; the exposure follows the light (index.js: a grey card facing up
  // maps to 0.18 when exposure = pi / E)
  sunAt(state.hour);
  sky.update(sunDir, Math.max(1, camera.position.y - (src.sea ?? 0)), 1); sky.uSea.value = src.sea ?? 0;
  // the key light: the sun by day, the moon by night (its light and its shadows), crossing at dusk
  const mc = sky.uMoonColor.value, night = 1 - THREE.MathUtils.smoothstep(sunDir.y, -0.1, 0.05), md = sky.uMoonDir.value;
  keyDir.copy(sunDir).lerp(md, night).normalize();
  sun.color.copy(sky.sunColor).add(mc); sun.intensity = 1; hemi.color.setRGB(sky.skyUp.r + 0.25 * mc.r, sky.skyUp.g + 0.25 * mc.g, sky.skyUp.b + 0.25 * mc.b); hemi.groundColor.copy(hemi.color).multiplyScalar(0.25); hemi.intensity = 1;
  { const g2 = Math.max(0, sunDir.y), c = sky.sunColor, u = sky.skyUp, lum = 0.2126 * (c.r * g2 + u.r) + 0.7152 * (c.g * g2 + u.g) + 0.0722 * (c.b * g2 + u.b), lumM = (0.2126 * mc.r + 0.7152 * mc.g + 0.0722 * mc.b) * Math.max(0, md.y);
    renderer.toneMappingExposure = THREE.MathUtils.clamp(Math.PI / Math.max(lum + lumM, 0.05), 0.02, 40); }
  // the sun's shadow box follows the eye
  const f = player.on ? player.pos : new THREE.Vector3(cam.fx, ground(cam.fx, cam.fz), cam.fz);
  sun.target.position.copy(f); sun.position.copy(f).addScaledVector(keyDir, 300);
  clip.update(camera.position.x, camera.position.z, dt);
  if (forest.rangeK !== state.treeDist) forest.setRange(state.treeDist);
  if (!q.has('noforest')) forest.update(camera, dt, [state.wind * 0.94, state.wind * 0.35]);
  // the swell (index.js): from a long fetch at the wind (never under the sea's minimum), and the surf it drives
  wtime += dt;
  const w10 = [Math.max(state.wind, 1.5) * 0.94, Math.max(state.wind, 1.5) * 0.35];
  const sw = swellState(Math.max(Math.hypot(w10[0], w10[1]), WAVES.swellMin), src.water.swellFetch || src.water.fetch);
  const swell = { Hs: Math.max(WAVES.swellHmin, sw.Hs), T: Math.min(10.5, Math.max(WAVES.swellT - 1, WAVES.swellT - 1 + 2.5 * sw.Hs)) };
  waves.update(wtime, w10, Math.PI * 60, swell);
  water.U.uSurf.value.set(Math.min(1.5, Math.max(0.2, 0.35 + 0.55 * swell.Hs)), Math.min(60, Math.max(12, 0.45 * 9.81 * swell.T * swell.T / (2 * Math.PI))), 1, 1);
  water.U.uWTime.value = wtime; water.U.uTime.value = wtime; water.U.uSwDir.value.copy(waves.U.swDir.value);
  if (shore) shore.update(camera.position, !shore._built); if (shore) shore._built = true;
  if (fields) for (const f of fields) f.update(dt, camera, w10, 4);
  if (grass) grass.update(camera, ground(camera.position.x, camera.position.z), w10, dt);
  water.U.uSunDir.value.copy(sunDir);
}

function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
$('treeDist').addEventListener('input', (e) => { state.treeDist = parseFloat(e.target.value); $('oTreeDist').textContent = Math.round(state.treeDist * 100) + '%'; });
$('oTreeDist').textContent = '100%';
$('hour').value = state.hour; const showHour = () => { const h = Math.floor(state.hour), m = Math.round((state.hour - h) * 60); $('oHour').textContent = `${h}:${String(m).padStart(2, '0')}`; }; showHour();
$('hour').addEventListener('input', (e) => { state.hour = parseFloat(e.target.value); showHour(); });
build();

let last = performance.now(), fps = 0, frames = 0, ft = 0, gpuMs = 0, counts = null, countT = 0, manual = false;
async function frame(now) {
  if (manual) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  step(dt);
  draw();
  frames++; ft += dt;
  if (ft > 0.5) {
    fps = frames / ft; frames = 0; ft = 0;
    try { await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER); await renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE); gpuMs = (renderer.info.render.timestamp || 0) + (renderer.info.compute.timestamp || 0); } catch (e) { gpuMs = 0; }
    if (now - countT > 1000) { countT = now; forest.counts().then((c) => { counts = c; }); }
    const ml = forest.lists, trees = counts ? counts.reduce((a, b) => a + b, 0) : 0, byL = counts ? [0, 1, 2].map((l) => counts.filter((_, i) => i < ml && i % 3 === l).reduce((a, b) => a + b, 0)).concat([counts.slice(ml).reduce((a, b) => a + b, 0)]) : [0, 0, 0, 0];
    $('stats').textContent = `${backend} · ${fps.toFixed(0)} fps · gpu ${gpuMs ? gpuMs.toFixed(2) + ' ms' : '…'} · ${renderer.info.render.drawCalls} draws · ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris\ntrees drawn ${trees} (near ${byL[0]}, mid ${byL[1]}, far ${byL[2]}, cards ${byL[3]}) of ${forest.stats.cells} cached cells culled on the GPU · ${forest.stats.tiles} tiles placed once · reach ${forest.R.toFixed(0)} m` + (player.on ? `\nplayer (P off) · ${player.fp ? 'first person' : 'third person'} (right button)` : '');
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// tests (headless): ?offscreen draws into a target instead of the canvas (a headless browser's WebGPU may not
// present), and snap() reads it back tone-mapped (ACES, sRGB) as a PNG data URL
const off = q.has('offscreen') ? new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType }) : null;
function draw() { if (off) { const w = innerWidth, h = innerHeight; if (off.width !== w || off.height !== h) off.setSize(w, h); renderer.setRenderTarget(off); renderer.render(scene, camera); renderer.setRenderTarget(null); } else renderer.render(scene, camera); }
async function snap() {
  const w = off.width, h = off.height, px = await renderer.readRenderTargetPixelsAsync(off, 0, 0, w, h), cv2 = document.createElement('canvas'); cv2.width = w; cv2.height = h;
  const c2 = cv2.getContext('2d'), im = c2.createImageData(w, h), toF = THREE.DataUtils.fromHalfFloat, aces = (x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))), srgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, o = i; /* WebGPU reads back top row first */ for (let c = 0; c < 3; c++) im.data[o + c] = 255 * srgb(aces(toF(px[i + c]) * 0.6 * renderer.toneMappingExposure)); im.data[o + 3] = 255; }
  c2.putImageData(im, 0, 0); return cv2.toDataURL('image/png');
}
window.__gpu = { snap, draw, renderer, scene, camera, cam, state, player, get forest() { return forest; }, get grass() { return grass; }, sky, get clip() { return clip; }, manual(on) { manual = on; if (!on) { last = performance.now(); requestAnimationFrame(frame); } }, step, async counts() { return forest.counts(); }, render() { draw(); } };
