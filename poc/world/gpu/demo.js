// The WebGPU spike (WEBGPU.md, step 1): the wild land on three.js's WebGPURenderer: the clipmap filled by compute,
// the ground from it, and the woods placed, culled and sorted into levels on the GPU, drawn indirectly. The same
// controls as the template (world.html): drag to look, WASD to move, the wheel to zoom; P a player cube.
import * as THREE from 'three/webgpu';
import { wildSource } from '../sources/wild.js';
import { GpuClip } from './clip.js';
import { gpuTerrain } from './terrain.js';
import { GpuForest } from './forest.js';

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
scene.background = new THREE.Color(0.55, 0.7, 0.9);
scene.fog = new THREE.Fog(0xa9c3dc, 600, 4500);
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 20000);
const sun = new THREE.DirectionalLight(0xfff1dc, 3.2), hemi = new THREE.HemisphereLight(0xbcd4f0, 0x4a4630, 1.1);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
const SH = 70; Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 600 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target, hemi);
const sunDir = new THREE.Vector3(0.45, 0.62, 0.3).normalize();

const state = { seed: 7, treeDist: 1, wind: 4 };
let src, clip, terrain, forest;
function build() {
  if (terrain) { scene.remove(terrain, forest.group); }
  src = wildSource({ seed: state.seed });
  clip = new GpuClip(renderer, src);
  terrain = gpuTerrain(clip, { sea: src.sea });
  forest = new GpuForest(renderer, clip, src, { range: 1 });
  if (!q.has('noterrain')) scene.add(terrain);
  if (!q.has('noforest')) scene.add(forest.group);
  clip.build(cam.fx, cam.fz);
}

// the camera: an orbit round a focus on the ground, as the template's
const cam = { fx: 0, fz: 0, yaw: 0.8, look: 0, dist: 60 };
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
  // the sun's shadow box follows the eye
  const f = player.on ? player.pos : new THREE.Vector3(cam.fx, ground(cam.fx, cam.fz), cam.fz);
  sun.target.position.copy(f); sun.position.copy(f).addScaledVector(sunDir, 300);
  clip.update(camera.position.x, camera.position.z, dt);
  if (forest.rangeK !== state.treeDist) forest.setRange(state.treeDist);
  if (!q.has('noforest')) forest.update(camera, dt, [state.wind * 0.94, state.wind * 0.35]);
}

function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
$('treeDist').addEventListener('input', (e) => { state.treeDist = parseFloat(e.target.value); $('oTreeDist').textContent = Math.round(state.treeDist * 100) + '%'; });
$('oTreeDist').textContent = '100%';
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
    const trees = counts ? counts.reduce((a, b) => a + b, 0) : 0, byL = counts ? [0, 1, 2].map((l) => counts.filter((_, i) => i % 3 === l).reduce((a, b) => a + b, 0)) : [0, 0, 0];
    $('stats').textContent = `${backend} · ${fps.toFixed(0)} fps · gpu ${gpuMs ? gpuMs.toFixed(2) + ' ms' : '…'} · ${renderer.info.render.drawCalls} draws · ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris\ntrees drawn ${trees} (near ${byL[0]}, mid ${byL[1]}, far ${byL[2]}) of ${forest.stats.cells} cached cells culled on the GPU · ${forest.stats.tiles} tiles placed once · reach ${forest.R.toFixed(0)} m` + (player.on ? `\nplayer (P off) · ${player.fp ? 'first person' : 'third person'} (right button)` : '');
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
window.__gpu = { snap, draw, renderer, scene, camera, cam, state, player, get forest() { return forest; }, get clip() { return clip; }, manual(on) { manual = on; if (!on) { last = performance.now(); requestAnimationFrame(frame); } }, step, async counts() { return forest.counts(); }, render() { draw(); } };
