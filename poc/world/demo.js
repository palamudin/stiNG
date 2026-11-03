// World v2 template page: the world drawn with no game on top, for looking at, tuning and testing.
// A camera that zooms continuously from kilometres up to a wasp's few centimetres over the grass, a switch between
// the wild world and the game's own world, and the controls the world exposes. window.__w2 is the test hook.
import * as THREE from 'three';
import { World } from './index.js';
import { wildSource } from './sources/wild.js';

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

const state = { source: 'wild', seed: 7, tod: 16.6, zoom: 0.42, blocky: 0.6, fog: 1, wet: 0, wind: 0.85, fstop: 2.8, quality: 'high', ui: true };
let world = null, src = null;

// ------------------------------------------------------------ camera: orbit a focus point on the ground
// zoom 0..1 maps the distance from the focus logarithmically from 6 cm to 9 km. Pitch flattens as you come down, so
// the far view is a map and the near view looks along the grass.
const cam = { fx: 0, fz: 0, yaw: 0.8, pitch: 0.5, dist: 120, target: null, tour: null };
const zoomToDist = (z) => 0.06 * Math.pow(9000 / 0.06, z);
const distToZoom = (d) => Math.log(d / 0.06) / Math.log(9000 / 0.06);
function pitchFor(d) { return 0.12 + 0.95 * THREE.MathUtils.smoothstep(Math.log10(d), -1.2, 3.7); }

let stingMod = null, simMod = null;
async function makeWorld() {
  if (world) { scene.remove(world.group); world = null; }
  if (state.source === 'wild') src = wildSource({ seed: state.seed, blocky: state.blocky });
  else {
    // the game's own world: the sim's generator with hilly ground, its land use, paving and trees
    simMod = simMod || await import('../sim/index.js');
    stingMod = stingMod || await import('./sources/sting.js');
    const settings = { ...simMod.DEFAULT_SETTINGS, terrain: 2, seed: state.seed };
    src = stingMod.stingSource({ seed: simMod.u64(state.seed), settings, records: new Map() }); // the sim's seed is a u64 (BigInt)
  }
  world = new World(renderer, scene, camera, src, { quality: state.quality });
  world.build(cam.fx, cam.fz);
  standIns();
}
// In the game's world the game draws the birdbaths and fountains (World v2 draws their water). Here, with no game, the
// same basins are stood in, at the game's sizes, so the water has its floor and rim.
let stands = null;
function standIns() {
  if (stands) { scene.remove(stands); stands.traverse((o) => o.geometry && o.geometry.dispose()); stands = null; }
  if (state.source !== 'sting') return;
  stands = new THREE.Group(); stands.userData.ring = true;
  const stone = new THREE.MeshStandardMaterial({ color: new THREE.Color('#bdb8ad'), roughness: 0.9 }), dark = new THREE.MeshStandardMaterial({ color: new THREE.Color('#a9a49a'), roughness: 0.9 });
  for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) for (const b of src.objects(i, j).baths || []) {
    const y = src.height(b.x, b.z), add = (geo, m, yy) => { const o = new THREE.Mesh(geo, m); o.position.set(b.x, y + yy, b.z); o.castShadow = o.receiveShadow = true; stands.add(o); };
    if (b.fountain) add(new THREE.CylinderGeometry(b.r + 0.15, b.r + 0.2, b.h - 0.02, 28), stone, (b.h - 0.02) / 2);
    else { add(new THREE.CylinderGeometry(0.07, 0.11, b.h - 0.08, 10), dark, (b.h - 0.08) / 2); add(new THREE.CylinderGeometry(b.r + 0.03, b.r * 0.55, 0.1, 18), stone, b.h - 0.055); }
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
function step(dt) {
  if (!world) return;
  // move
  const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1) * Math.max(0.4, cam.dist * 0.6);
  const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const side = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  cam.fx += (-Math.sin(cam.yaw) * fwd + Math.cos(cam.yaw) * side) * sp * dt;
  cam.fz += (-Math.cos(cam.yaw) * fwd - Math.sin(cam.yaw) * side) * sp * dt;
  if (cam.tour) cam.tour(dt);
  cam.dist += (zoomToDist(state.zoom) - cam.dist) * Math.min(1, dt * 6);
  const gy = cam.fy ?? Math.max(world.heightAt(cam.fx, cam.fz), src.sea); // cam.fy: a focus height of its own (tests)
  focus.set(cam.fx, gy, cam.fz);
  const pitch = cam.pitchOverride ?? pitchFor(cam.dist);
  const cx = cam.fx + Math.sin(cam.yaw) * Math.cos(pitch) * cam.dist, cz = cam.fz + Math.cos(cam.yaw) * Math.cos(pitch) * cam.dist;
  let cy = gy + Math.sin(pitch) * cam.dist;
  cy = Math.max(cy, Math.max(world.heightAt(cx, cz), src.sea) + Math.min(0.02 + cam.dist * 0.15, 2));
  camera.position.set(cx, cy, cz);
  camera.lookAt(focus);
  camera.near = THREE.MathUtils.clamp(cam.dist * 0.02, 0.003, 20);
  camera.far = 60000;
  camera.updateProjectionMatrix();
  world.set({ hour: state.tod, haze: state.fog, mist: state.fog, wet: state.wet, wind: [state.wind * 0.94, state.wind * 0.35] });
  world.post.U.uFstop.value = state.fstop;
  world.update(dt, camera.position, cam.dist);
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
  $('stats').textContent = `${fps.toFixed(0)} fps · ${i.calls} draws · ${(i.triangles / 1000).toFixed(0)}k tris\nview ${ds} · sharp ${(world.clip.sharpness() * 100).toFixed(0)}% · ${world.forest.stats.trees} near trees`;
}

// ------------------------------------------------------------ input
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, id: e.pointerId }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (drag && drag.id === e.pointerId) { cam.yaw = drag.yaw - (e.clientX - drag.x) * 0.005; } });
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(state.zoom + e.deltaY * 0.0006); }, { passive: false });
addEventListener('keydown', (e) => keys.add(e.code));
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
bindRange('zoom', 'zoom', 'oZoom', (v) => fmtDist(zoomToDist(v)));
bindRange('blocky', 'blocky', 'oBlocky', undefined, () => makeWorld());
bindRange('fog', 'fog', 'oFog');
bindRange('wet', 'wet', 'oWet');
bindRange('wind', 'wind', 'oWind');
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
segment('segSource', 'source', () => { if (state.source === 'sting') { cam.fx = 0; cam.fz = 0; } else { const s = findStart(); cam.fx = s.x; cam.fz = s.z; } makeWorld(); });
segment('segQ', 'quality', () => makeWorld());
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
    if (p.y < Math.max(world.heightAt(p.x, p.z), src.sea)) { hit = p; break; }
    t += step; step *= 1.02;
  }
  if (hit) { cam.fx = hit.x; cam.fz = hit.z; tween(state.zoom, Math.max(0.2, state.zoom - 0.25), 3); }
});
$('bPanel').addEventListener('click', () => { $('panel').classList.toggle('closed'); $('bPanel').textContent = $('panel').classList.contains('closed') ? 'show' : 'hide'; });

// ------------------------------------------------------------ boot
function findStart() { // a meadow near the water, looking along the shore
  const s = wildSource({ seed: state.seed });
  let best = null;
  for (let r = 0; r < 4000 && !best; r += 40) for (let a = 0; a < 6.283; a += 0.35) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r, o = s.sample(x, z);
    if (o[0] > 2 && o[0] < 6 && o[2] < 0.3) { const w = s.sample(x + 30, z); if (w[0] < 0) { best = { x, z }; break; } }
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
  stats() { const i = world ? world.frameInfo || {} : {}; return { calls: i.calls, tris: i.tris, fps, sharp: world && world.clip.sharpness(), clipMs: world && world.clip.stats.ms, forest: world && world.forest.stats }; },
};
