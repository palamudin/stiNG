// The shore lab: the water's edge on its own, on one straight beach, nothing else (no terrain, no sky, no table).
// A space-time chart: across the shore left to right (sea to sand), time upward. Each pixel asks what the water's
// mesh would put over that spot of the floor at that moment, through the same GLSL the water uses (water3/swash.js:
// the surf's trains, the swash, the edge's height), with the floor and the shore table replaced by a plane coast with
// the world's surf platform (sources/wild.js). Left half: the edge as it was; right half: as it is now.
//   blue: water (darker deeper); orange: a film the water's pixels fade out (reads as dry); red: the floor bare under the still water
//   (a dry strip between waters: must never happen); tan: sand; white: the swash's shoreline; yellow: a crest.
// ?t0=0&t1=30&x0=-40&x1=10&m=0.033 ; window.labDone is set when drawn.
import * as THREE from 'three';
import { NOISE_GLSL } from '../noise.js';
import { SWASH_GLSL, SURF_GLSL } from '../water3/swash.js';
import { SHORE } from '../shorefield.js';

const q = new URLSearchParams(location.search), num = (k, v) => (q.has(k) ? +q.get(k) : v);
const W = num('w', 360), H = num('h', 480);
const R = { t0: num('t0', 0), t1: num('t1', 30), x0: num('x0', -40), x1: num('x1', 10), m: num('m', 0.033) };
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), preserveDrawingBuffer: true });
renderer.setSize(W * 2 + 8, H);

const STUB = /* glsl */ `
uniform float uM; // the coast's slope (rise over run)
float gShoreKnow = 1.0;
// the floor: x across the shore, land positive; the line at 0; the sand gentler near the line, the surf platform
// under the water (sources/wild.js: the first 6 m of depth at 0.3 of the slope, then rejoining it)
float labFloor(float x) {
  float e = uM * x;
  if (e >= 0.0) return e * (0.3 + 0.7 * smoothstep(0.0, 2.5, e));
  float d = -e, K = 0.3, q1 = d - 6.0, q0 = -6.0;
  return -(K * d + (1.0 - K) * (0.5 * (q1 + sqrt(q1 * q1 + 4.0)) - 0.5 * (q0 + sqrt(q0 * q0 + 4.0))));
}
float clipHeight(vec2 p) { return labFloor(p.x); }
float clipWater(vec2 p) { return 0.0; }
vec3 clipNormal(vec2 p) { float g = (labFloor(p.x + 0.1) - labFloor(p.x - 0.1)) / 0.2; return normalize(vec3(-g, 1.0, 0.0)); }
// the shore table: distance along x, toward +x, travel time by the eikonal along x (the depth's speed)
vec4 shoreAt(vec2 p) {
  if (p.x >= 0.0) return vec4(p.x, 1.0, 0.0, -p.x / sqrt(9.81 * ${SHORE.dMin.toFixed(2)}));
  float tau = 0.0, dx = -p.x / 48.0;
  for (int i = 0; i < 48; i++) { float x = p.x + (float(i) + 0.5) * dx; tau += dx / sqrt(9.81 * clamp(-labFloor(x), ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)})); }
  return vec4(p.x, 1.0, 0.0, tau);
}
`;
const swash = SWASH_GLSL.replace('uniform float uWTime;', 'float uWTime = 0.0;'); // the chart's time is per pixel
const frag = /* glsl */ `precision highp float; precision highp int;
${NOISE_GLSL}
${STUB}
${swash}
${SURF_GLSL}
uniform vec4 uR; uniform vec2 uRes; uniform float uT0, uT1;
out vec4 oColor;
// what the water's vertex at x0 does (water3/surface.js), old or new edge
vec3 surfAt(float x0, bool newEdge) {
  vec2 xz = vec2(x0, 0.0); float level = 0.0, bed = clipHeight(xz), depth = level - bed;
  vec3 d = vec3(0.0);
  if (depth > 0.0 && sw3Ctx(xz)) d = w3Coast(xz, depth, 0.25);
  if (newEdge) d.xz *= sw3EdgeShift(depth);
  float y = max(level + d.y, min(bed + 0.004, level));
  if (depth < 2.0 && depth > -3.0) {
    vec2 grad = vec2((clipHeight(xz + vec2(0.25, 0.0)) - clipHeight(xz - vec2(0.25, 0.0))) / 0.5, 0.0);
    if (newEdge) y = sw3EdgeY(xz, level, bed, y, grad, uWTime, 0.0);
    else if (depth < 0.5) { sw3Beach(xz, grad); float s, th = level + sw3Shore(xz, length(grad), uWTime, s) - bed; float sheet = bed + (th > 0.0 ? min(0.12, 0.012 + 0.3 * th) : max(th, -0.15)); y = depth < 0.0 ? sheet : max(y, sheet); }
  }
  return vec3(x0 + d.x, y, 0.0);
}
void main() {
  bool right = gl_FragCoord.x > uRes.x + 8.0;
  if (!right && gl_FragCoord.x > uRes.x) { oColor = vec4(0.1, 0.1, 0.1, 1.0); return; }
  vec2 uv = (gl_FragCoord.xy - vec2(right ? uRes.x + 8.0 : 0.0, 0.0)) / uRes;
  float x = mix(uR.x, uR.y, uv.x); uWTime = mix(uT0, uT1, uv.y);
  float bedX = clipHeight(vec2(x, 0.0));
  // the surface over x: the mesh's points near x, moved by the waves, the highest segment over x
  float best = -1e9, px = 0.0, py = 0.0;
  for (int i = 0; i <= 40; i++) {
    vec3 P = surfAt(x - 3.0 + 6.0 * float(i) / 40.0, right);
    if (i > 0 && ((px <= x && P.x >= x) || (P.x <= x && px >= x))) best = max(best, mix(py, P.y, (x - px) / (P.x - px + 1e-6)));
    px = P.x; py = P.y;
  }
  // the water's pixel test (water3/surface.js): none on the sand above the shoreline
  vec2 g2 = vec2((clipHeight(vec2(x + 0.25, 0.0)) - clipHeight(vec2(x - 0.25, 0.0))) / 0.5, 0.0);
  sw3Beach(vec2(x, 0.0), g2); float s, zeta = sw3Shore(vec2(x, 0.0), length(g2), uWTime, s);
  if (bedX > 0.0 && zeta - bedX <= 0.0) best = -1e9;
  float D = best - bedX;
  vec3 c = bedX > 0.0 ? vec3(0.76, 0.66, 0.46) : vec3(0.85, 0.1, 0.1); // sand, or the floor bare under the still water
  float thin = (right && -bedX < 0.3 && zeta - bedX > 0.0) || bedX > 0.0 ? 0.015 : 0.06; // as the water's pixels draw it
  if (D > thin) c = mix(vec3(0.35, 0.65, 0.95), vec3(0.05, 0.2, 0.5), smoothstep(0.0, 3.0, D));
  else if (D > 0.0) c = vec3(1.0, 0.6, 0.1); // a film drawn see-through: reads as dry
  // the swash's shoreline, and the first train's crest
  if (abs(zeta - bedX) < 0.01 && bedX > -0.05) c = vec3(1.0);
  if (bedX < 0.0 && sw3Ctx(vec2(x, 0.0))) { float ph = sw3Phase(0, uWTime, gTau, gPn), psi = mod(ph + 3.14159265, 6.2831853) - 3.14159265; if (abs(psi) < 0.06) c = mix(c, vec3(1.0, 0.95, 0.2), 0.8); }
  if (abs(x) < 0.06) c *= 0.6; // the still-water line
  oColor = vec4(c, 1.0);
}`;
const U = {
  uSurf: { value: new THREE.Vector4(num('a', 0.8), num('l', 30), 1, 1) }, uSurfX: { value: new THREE.Vector4(1.6, 0, 0, 0) },
  uSwDir: { value: new THREE.Vector2(1, 0) }, uM: { value: R.m }, uR: { value: new THREE.Vector4(R.x0, R.x1, 0, 0) },
  uRes: { value: new THREE.Vector2(W, H) }, uT0: { value: R.t0 }, uT1: { value: R.t1 },
};
const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: U, vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: frag });
const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
const t0 = performance.now(); renderer.render(scene, new THREE.Camera());
const gl = renderer.getContext(), px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
document.getElementById('k').textContent = `left: the edge as it was · right: now · x ${R.x0}..${R.x1} m (sea to sand), t ${R.t0}..${R.t1} s upward · slope ${R.m} · ${(performance.now() - t0).toFixed(0)} ms`;
window.labDone = true;
