// Water 3: the water surface as a real mesh (after Ultra-Water's design). A polar grid round the camera, displaced by
// the wave field's cascades and drawn after the scene with the depth test, so the waterline is simply where the water
// mesh and the terrain meet, cut by the hardware per pixel and antialiased by the scene's MSAA. Nothing computes where
// the waterline is.
//
// The grid: 256 segments; rings 6 cm apart at the lens growing x1.12 to 1 m, then x(1 + 2 pi / 256) so the cells stay
// square, out to 4 km; one skirt ring at 60 km. The rings round the eye are scaled with the camera's height above the
// water (a wasp sees centimetre cells, a gull metre cells). Each cascade is sampled at the mip its vertex spacing can
// carry, so the grid does not shimmer as it slides with the camera.
//
// Step 1c, detiling: each short cascade (12 m, 1 m, 14 cm tiles) is read twice, the second time rotated and shifted,
// and the two blended by a slow noise; the blend is divided by the length of its weights so the waves keep their
// height where the two mix (Heitz and Neyret 2018's variance-preserving blend). The chop's height also varies in
// patches tens of metres wide that drift with the wind (gusts). No tile repeats on a grid any more.
//
// Step 3a, the swell turns to the coast: within a few hundred metres of a shore the far swell of the wave field (its
// first cascade) fades out and the coast's own swell takes over: three trains of the swell's periods whose crests lie
// on the shore table's travel time, so they run straight at the beach at the shallow-water speed sqrt(g depth), the
// same for every wave (shorefield.js: the time comes from an eikonal over the depth). They grow as the water shoals
// (Green's law), steepen (Gerstner), and are held under 0.39 of the depth (a wave breaks at 0.78 of the depth). Their
// periods beat into sets. A coast the swell runs away from gets a share of it (the rest refracted round).
//
// Step 4 (the port): the old water's effects on this surface. Foam on the breakers' faces, the lace they leave, the
// surf zone's standing foam and whitecaps where the surface folds (the cascades' Jacobian); the scene's reflection by
// screen-space marching (with MSAA, where the scene's depth can be read); glints (Poisson-counted facets); rain rings;
// ice in deep winter; the surf zone's churned water. No swash and no wet sand: those must come from the water's own
// movement over the shallows (a solver), not be drawn beside it.
//
// Step 2, the optics: drawn after the scene, the surface reads the scene's colour under it (a copy when the scene has
// no MSAA resolve to read) along the refracted ray, attenuates it per channel over the path through the water
// (Beer-Lambert), adds the water's own scattering, and reflects the sky by Fresnel with the sun's highlight from the
// slopes' distribution (mean and variance: LEAN). The floor's sunlight is lost on its way down and focused by the
// caustics. Everything fades as the water thins to nothing at its edge, so the line is the sand seen through no water.
//
// The world's depth buffer is logarithmic, so the shaders carry three.js's log-depth chunks.
import * as THREE from 'three';
import { NOISE_GLSL } from '../noise.js';
import { SKY_GLSL, NIGHT_GLSL } from '../sky.js';
import { WATER, WATER_CAUSTIC_GLSL, POISSON } from '../water.js';
import { SWASH_GLSL, SURF_GLSL } from './swash.js';
import { SurfFoam } from './surffoam.js';
import { bakeFoamTexture } from './foamtex.js';
import { FoamField, FOAM_FIELD } from './foamfield.js';
import { CurlMesh } from './curl.js';
import { SHORE } from '../shorefield.js';

export const SURFACE = {
  segments: 256, inner: 0.0625, innerGrow: 1.12, reach: 4000, skirt: 60000,
  floorReach: 600,               // metres: the floor is read for vertices nearer than this
  clear: 0.04,                   // metres the trough is held over the floor
  // detiling: per short cascade, the second read's rotation (radians) and shift (tile units); the blend's noise is
  // this many tiles across
  rot: [0, 1.9, 0.9, 2.5], shift: [[0, 0], [0.31, 0.67], [0.53, 0.19], [0.83, 0.41]], blendTiles: 2.3,
  gust: 38,                      // metres: the chop's patches
};

function polarGrid() {
  const S = SURFACE.segments, radii = [0];
  for (let r = SURFACE.inner; r < 1; r *= SURFACE.innerGrow) radii.push(r);
  const g = 1 + (2 * Math.PI) / S;
  for (let r = 1; r < SURFACE.reach; r *= g) radii.push(r);
  radii.push(SURFACE.reach);
  const R = radii.length, pos = new Float32Array((R * S + S) * 3), idx = [];
  let p = 0;
  for (let i = 0; i < R; i++) for (let j = 0; j < S; j++) { const a = (j / S) * 2 * Math.PI; pos[p++] = Math.cos(a) * radii[i]; pos[p++] = 0; pos[p++] = Math.sin(a) * radii[i]; }
  for (let j = 0; j < S; j++) { const a = (j / S) * 2 * Math.PI; pos[p++] = Math.cos(a); pos[p++] = 1; pos[p++] = Math.sin(a); } // the skirt: y = 1 marks it (its radius is set in the shader)
  for (let i = 0; i < R; i++) for (let j = 0; j < S; j++) {
    const a = i * S + j, b = i * S + ((j + 1) % S), c = (i + 1) * S + j, d = (i + 1) * S + ((j + 1) % S);
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return { geo, rings: R, verts: R * S + S, cellStep: g - 1 };
}

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

const _vr = new THREE.Matrix4();
// the mirror's layer (the game's things to reflect; -1: none), its target's size (of the drawing buffer), how high
// above the water the eye may be for it
export const MIRROR = { layer: 5, scale: 0.5, above: 40 };
const _mv2 = new THREE.Vector2(), _md = new THREE.Vector3(), _mu = new THREE.Vector3(), _mq = new THREE.Quaternion(), _mc = new THREE.Color(), _mr = new THREE.Matrix4();

export class WaterSurface {
  // world: the World (its clipmap, wave field, sky, shore table, caustics)
  constructor(world) {
    this.world = world;
    const field = world.waves, C = field.C, cs = [...Array(C).keys()], S = SURFACE, N = field.N;
    const shore = world.shore && !world.shore.live ? world.shore : null;
    this.coastOn = !!shore;
    this.ssr = (world.q.msaa || 0) > 0; // the scene's depth can be read only from the MSAA resolve (post.js)
    const grid = polarGrid();
    this.stats = { verts: grid.verts, tris: grid.geo.index.count / 3 };
    const U = {
      ...world.clip.uniforms, ...world.sky.uniforms, ...(shore ? shore.uniforms : {}),
      uCam: { value: new THREE.Vector3() }, uCamL: { value: new THREE.Vector2() }, uGridScale: { value: 1 }, uWL: { value: field.U.uL.value }, uTime: { value: 0 }, uDrift: { value: new THREE.Vector2() },
      uSeaLevel: { value: world.source.sea }, uSkyUp: { value: new THREE.Color() }, uWLost: { value: 0 },
      uSurf: world.uSurf, uSurfX: world.uSurfX, uWTime: world.uWTime, uSwDir: world.uSwDir,
      uWave: world.uWave, // (the panel's wave scale, the sea's fetch m, -, -)
      tScene: { value: null }, tDepth: { value: null }, uVP: { value: new THREE.Matrix4() }, tFoam: { value: null },
      tMirror: { value: null }, tMirrorMask: { value: null }, uVPM: { value: new THREE.Matrix4() }, uMirrorOff: { value: new THREE.Vector3() }, uMirrorOn: { value: 0 },
      uLook: world.uLook, uLook2: world.uLook2, uLook3: world.uLook3, uLace: world.uLace, uAbs: world.uAbs, uSca: world.uSca, // the panel's 'Water'
      uLogF: world.post.U.uLogF, uDebug: world.post.U.uDebug, uRain: world.post.U.uRain, uIce: world.post.U.uIce, uGlint: world.post.U.uGlint, uWPeak: world.post.U.uWPeak,
      tCaus: { value: world.caustics ? world.caustics.rt.texture : null }, uCaus: world.post.U.uCaus,
    };
    cs.forEach((c) => { U['tWD' + c] = { value: field.disp[c].texture }; U['tWS' + c] = { value: field.slope[c].texture }; });
    this.U = U;
    const rot = (c, s) => `vec2(${Math.cos(s * S.rot[c]).toFixed(6)}, ${Math.sin(s * S.rot[c]).toFixed(6)})`;
    const head = /* glsl */ `
${NOISE_GLSL}
${world.clip.glsl()}
${shore ? shore.glsl() + '\n#define W3_COAST' : ''}
${this.ssr ? '#define W3_SSR' : ''}
uniform vec3 uCam; uniform float uGridScale, uSeaLevel, uTime; uniform vec4 uWL, uWave; uniform vec2 uDrift, uCamL;
// the water's kind, its roughness: the sea's wind sea grows over the sea's fetch; a lake's over its own width (twice
// the distance to its shore, from the shore table), so its long waves are a small share of the sea's and its ripples
// as full (short waves saturate within metres); the panel's wave scale on all of it. Per cascade
vec4 w3Rough(vec2 p, float level) {
  vec4 m = vec4(uWave.x);
  if (level > uSeaLevel + 0.5) {
    float fe = 400.0;
#ifdef W3_COAST
    vec4 sh = shoreAt(p); if (gShoreKnow > 0.0 && abs(sh.x) < 9.0e3) fe = clamp(-2.0 * sh.x, 20.0, uWave.y);
#endif
    float r = sqrt(fe / max(uWave.y, fe));
    m *= vec4(0.0, clamp(3.0 * r, 0.05, 1.0), clamp(10.0 * r, 0.3, 1.0), 1.0);
  }
  return m;
}
${cs.map((c) => `uniform sampler2D tWD${c}, tWS${c};`).join(' ')}
vec2 w3Rot(vec2 v, vec2 cs) { return vec2(cs.x * v.x - cs.y * v.y, cs.y * v.x + cs.x * v.y); }
// the cascades' weights by the depth under the water: the long ones need depth, the chop reaches the beach
// (the first cascade holds the far swell; a lake, above the sea's level, has none)
vec4 w3Damp(float depth, float level) { return vec4(smoothstep(1.5, 8.0, depth) * step(level, uSeaLevel + 0.5), smoothstep(0.6, 5.0, depth), smoothstep(0.2, 2.0, depth), smoothstep(-0.2, 0.6, depth)); } // 600, 85, 12, 2.1 m tiles
// the detiling blend's weight for cascade c at p (0: the plain read, 1: the rotated one)
float w3Blend(vec2 p, float L, int c) { return smoothstep(-0.4, 0.4, w2noise(p / (L * ${f(S.blendTiles)}), 700 + c)); }
// the chop's gusts: patches of rougher and calmer water drifting with the wind (cascade 1 a little, 2 and 3 more)
// flowing water (the water's kinds: the clipmap's water layer holds the river's share and velocity): its ripples carried
// downstream by two phases of a flow map, each restarting while its weight is nothing (Vlachos 2010), the crests
// stretched across the flow; the phase's start offset by a slow noise, so the river does not pulse as one
const float W3_FT = 1.6;
vec3 w3FlowPh(vec2 p) { float f1 = fract(uTime / W3_FT + 0.5 + 0.5 * w2noise(p / 9.0, 720)); return vec3(f1 * W3_FT, fract(f1 + 0.5) * W3_FT, 1.0 - abs(1.0 - 2.0 * f1)); }
mat2 w3FlowM(vec2 v) { return mat2(1.0); } // carried only: a stretch across the flow drew the highlights out into streaks at a river's speed
vec2 w3Gust(vec2 p) { float n = w2noise((p - uDrift) / ${f(S.gust)}, 710) + 0.5 * w2noise((p - uDrift * 1.3) / ${f(S.gust * 0.37)}, 711); return vec2(1.0 + 0.25 * n, 1.0 + 0.55 * n); }`;

    // ---- the coast's swell (vertex): displacement and slope of the three trains, their foam; sw3Ctx has been run
    const coast = /* glsl */ `
#ifdef W3_COAST
${SWASH_GLSL}
${SURF_GLSL}
#endif`;

    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: U, side: THREE.DoubleSide,
      vertexShader: /* glsl */ `precision highp float; precision highp int;
#include <common>
#include <logdepthbuf_pars_vertex>
${head}
${coast}
out vec3 vW, vRel; out vec2 vXZ, vLoc; out float vCell, vNear, vJ; out vec2 vCoastSlope; out vec3 vCoast, vFlow; out vec4 vRough;
void main() {
  bool skirt = position.y > 0.5;
  float r = length(position.xz);
  vec2 off = position.xz * (skirt ? ${S.skirt.toFixed(1)} : uGridScale); // the point from the camera, exact
  vec2 xz = uCam.xz + off;
  float level = clipWater(xz);
  float dc = distance(xz, uCam.xz);
  // the floor, read only where it can matter
  float bed = -1e4, depth = 1e4;
  if (dc < ${S.floorReach.toFixed(1)}) { bed = clipHeight(xz); depth = level - bed; }
  vec4 k = w3Damp(depth, level);
  vRough = skirt ? vec4(uWave.x) : w3Rough(xz, level); k *= vRough;
  float cell = max(r, 1.0) * ${grid.cellStep.toFixed(5)} * uGridScale;
  vec4 d = vec4(0.0); vNear = 0.0; vCoastSlope = vec2(0.0); vCoast = vec3(0.0);
  // the water's kind here: a river's share and velocity (none past the floor's reach)
  vec3 fw = dc < ${S.floorReach.toFixed(1)} ? clipFlow(xz) : vec3(0.0); float fl = clamp(fw.x, 0.0, 1.0); vec2 fv = fw.yz; float sp = length(fv);
  vFlow = vec3(fl, fv);
  bool coast = false;
  if (!skirt) {
#ifdef W3_COAST
    // the coast here (the sea's only: a lake has no swell), read once for the trains and the swash
    if (bed > -1e3 && depth > -3.0 && level <= uSeaLevel + 0.5 && uSurf.x > 0.0) coast = sw3Ctx(xz);
    if (coast && depth > 0.0) { d.xyz += w3Coast(xz, depth, cell) * (1.0 - fl); vNear = gNear; vCoastSlope = gCoastSlope * (1.0 - fl); vCoast = gCoastFoam * (1.0 - fl); k.x *= 1.0 - gNear; }
#endif
    k.x *= 1.0 - fl; // a river carries no swell
    vec3 fph = w3FlowPh(xz); mat2 fM = w3FlowM(fv);
    vec2 gu = w3Gust(xz);
    // each cascade at the mip its vertex spacing can carry (+1: a little blurrier than the spacing, so it never shimmers)
    ${cs.map((c) => `{ float lod = max(0.0, log2(cell * ${N}.0 / uWL[${c}]) + 1.0); if (lod < ${Math.log2(N).toFixed(1)}) {
      vec2 u = xz / uWL[${c}]; vec4 a = textureLod(tWD${c}, u, lod) - vec4(0.0, 0.0, 0.0, 1.0);${c > 0 ? `
      vec4 b = textureLod(tWD${c}, w3Rot(u, ${rot(c, 1)}) + vec2(${S.shift[c].map(f).join(', ')}), lod) - vec4(0.0, 0.0, 0.0, 1.0); b.xz = w3Rot(b.xz, ${rot(c, -1)});
      float w = w3Blend(xz, uWL[${c}], ${c}); a = (a * (1.0 - w) + b * w) * inversesqrt((1.0 - w) * (1.0 - w) + w * w);
      if (fl > 0.01) {
        vec4 fa = textureLod(tWD${c}, fM * (xz - fv * fph.x) / uWL[${c}], lod) - vec4(0.0, 0.0, 0.0, 1.0), fb = textureLod(tWD${c}, fM * (xz - fv * fph.y) / uWL[${c}], lod) - vec4(0.0, 0.0, 0.0, 1.0);
        a = mix(a, (fa * fph.z + fb * (1.0 - fph.z)) * inversesqrt(fph.z * fph.z + (1.0 - fph.z) * (1.0 - fph.z)) * ${c === 1 ? '0.35' : '(0.6 + 0.6 * min(sp / 1.5, 1.0))'}, fl);
      }` : ''}
      d += a * k[${Math.min(c, 3)}]${c === 1 ? ' * gu.x' : c > 1 ? ' * gu.y' : ''}; } }`).join('\n    ')}
  }
#ifdef W3_COAST
  if (coast) d.xz *= sw3EdgeShift(depth); // near the line the waves only lift and lower the water (water3/swash.js)
#endif
  vJ = 1.0 + d.w; // the surface's Jacobian: below about a half it has folded (whitecaps)
  vec3 P = vec3(xz.x + d.x, level + d.y, xz.y + d.z);
  // the trough held over the floor (the clearance grows with distance for the depth buffer's precision); over land the
  // surface stays at the level and the terrain hides it
  if (bed > -1e3) P.y = max(P.y, min(bed + ${S.clear.toFixed(3)} + 2e-7 * dc * dc, level));
#ifdef W3_COAST
  // the shoreline: over the sand the surface is a sheet at the shoreline's height, thin at its tip (1 cm) and
  // thickening behind it, and under the sand past the tip by as much as the sand stands over the shoreline; in the
  // last centimetres of water it is lifted to the same sheet. One height for this, the pixels' edge test and the sand
  if (bed > -1e3 && depth < 0.5 && depth > -3.0 && level <= uSeaLevel + 0.5 && uSurf.x > 0.0) {
    float e = max(cell, 0.25);
    vec2 grad = vec2(clipHeight(xz + vec2(e, 0.0)) - clipHeight(xz - vec2(e, 0.0)), clipHeight(xz + vec2(0.0, e)) - clipHeight(xz - vec2(0.0, e))) / (2.0 * e);
    P.y = sw3EdgeY(xz, level, bed, P.y, grad, uWTime, fl); // the sheet over the sand, the water held up under the swash (water3/swash.js)
  }
#endif
  vW = P; vXZ = xz; vCell = cell;
  vLoc = uCamL + off; // the same point from the snapped origin, exact (the fine patterns read it)
  // GDD 18.94: placed and projected from the eye, never from absolute positions: viewMatrix * P in 32 bits loses
  // centimetres far from home, in depth too, and the shoreline's 1 cm sheet then fought the sand in patches
  vRel = vec3(off.x + d.x, P.y - uCam.y, off.y + d.z); // (P.xz is xz + d.xz; only its height is changed after)
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * vRel, 1.0);
  #include <logdepthbuf_vertex>
}`,
      fragmentShader: /* glsl */ `precision highp float; precision highp int;
#include <logdepthbuf_pars_fragment>
${head}
${coast}
${SKY_GLSL}
uniform vec3 uSun, uSunColor, uSkyUp; uniform sampler2D uSkyView, tScene, tFoam, tFoamField, tFoamFar; uniform vec3 uFoamWin, uFoamFarWin; uniform vec4 uLace;
${NIGHT_GLSL}
// the foam's lace (water3/foamtex.js), never tiled: each read is two of the texture, the second rotated and shifted,
// blended by a slow noise (as the waves' cascades are); its scale varies in patches (two scales blended by a slower
// noise, by the panel's lace variation); uLace = (lace scale, scale variation, patchiness, -)
// p: the texture's coordinates, from the exact local point (vLoc) at a size dividing 2048 m five-fold (laceQ), so it is
// the world's own pattern far from the origin too (the second read's rotation, 3-4-5, keeps it so); pw: the same in the
// world's coordinates, for the slow noise that blends them
float laceQ(float s) { return 2048.0 / (5.0 * max(1.0, floor(2048.0 / (5.0 * s) + 0.5))); }
float laceTap(vec2 p, vec2 pw) {
  vec2 q = vec2(0.8 * p.x - 0.6 * p.y, 0.6 * p.x + 0.8 * p.y) + vec2(0.37, 0.71);
  float w = smoothstep(-0.35, 0.35, w2noise(pw * 0.37, 840));
  return mix(texture(tFoam, p).r, texture(tFoam, q).r, w);
}
float lacePat(vec2 x, vec2 xl, float s, vec2 drift) { // x: the world's point, xl: the exact local one (vLoc)
  float v = (0.5 + 0.5 * w2noise(x / (11.0 * s), 841)) * uLace.y, s1 = laceQ(s), s2 = laceQ(1.7 * s);
  return mix(laceTap(xl / s1 + drift, x / s), laceTap(xl / s2 + drift * 0.6 + 0.43, x / (1.7 * s)), v);
}
// the lace by the water's depth (gLaceT: 0 the shallows .. 1 from about 3 m): crossfaded between 0.25x, 0.8x and 2.5x
float gLaceT = 0.0;
float laceD(vec2 x, vec2 xl, float s, vec2 drift) {
  float t = gLaceT * 2.0;
  return t < 1.0 ? mix(lacePat(x, xl, 0.25 * s, drift), lacePat(x, xl, 0.8 * s, drift), t) : mix(lacePat(x, xl, 0.8 * s, drift), lacePat(x, xl, 2.5 * s, drift), t - 1.0);
} uniform mat4 uVP; uniform float uWLost, uRain, uIce, uGlint, uWPeak;
uniform sampler2D tMirror, tMirrorMask; uniform mat4 uVPM; uniform vec3 uMirrorOff; uniform float uMirrorOn; // the mirror (MIRROR)
in vec3 vW, vRel; in vec2 vXZ, vLoc; in float vCell, vNear, vJ; in vec2 vCoastSlope; in vec3 vCoast, vFlow; in vec4 vRough; out vec4 oColor;
uniform float uDebug;
const float W_N = ${f(WATER.n)};
// the panel's 'Water' (index.js waterCtl): uAbs absorption and uSca scattering per metre (the colour preset), uLook
// (clarity, roughness, refraction, crest glow), uLook2 (crest glow toward the view, whitecap bias, whitecap scale, shore
// foam band), uLook3 (caustics, foam size, foam amount, -)
uniform vec3 uAbs, uSca; uniform vec4 uLook, uLook2, uLook3;
#define W_ABS (uAbs / max(uLook.x, 0.05))
#define W_SCA uSca
${WATER_CAUSTIC_GLSL}
float wFresnel(float ci) {
  ci = clamp(ci, 0.0, 1.0); float st2 = (1.0 - ci * ci) / (W_N * W_N); if (st2 >= 1.0) return 1.0;
  float ct = sqrt(1.0 - st2), rs = (ci - W_N * ct) / (ci + W_N * ct), rp = (W_N * ci - ct) / (W_N * ci + ct);
  return 0.5 * (rs * rs + rp * rp);
}
float wLambda(float cosT, float s2) {
  float a = cosT / max(sqrt(max(1.0 - cosT * cosT, 1e-6)) * sqrt(2.0 * s2), 1e-6);
  return a < 1.6 ? (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a) : 0.0;
}
vec3 skyAt(vec3 v) { return texture(uSkyView, skyUV(v, uSun)).rgb; }
// a Poisson count with mean lam from a uniform number u: the table in the shore table's layer, the series without it
float wPoisson(float lam, float u, float u2) {
  if (lam > ${POISSON.lamMax.toFixed(1)}) { float g = sqrt(-2.0 * log(max(u, 1e-7))) * cos(6.2831853 * u2); return max(0.0, floor(lam + sqrt(lam) * g + 0.5)); }
#ifdef W3_COAST
  int r = int(sqrt(lam / ${POISSON.lamMax.toFixed(1)}) * ${(POISSON.rows - 1).toFixed(1)} + 0.5), c = min(int(u * ${POISSON.cols.toFixed(1)}), ${POISSON.cols - 1});
  return shorePoisson(r, c);
#else
  float p = exp(-lam), c = p, n = 0.0;
  for (int i = 0; i < 40; i++) { if (u <= c) break; n += 1.0; p *= lam / n; c += p; }
  return n;
#endif
}
// rain: expanding rings in 0.3 m cells, each with its own time and place, fading as they spread
vec2 wRain(vec2 p, float t, float amt) {
  if (amt <= 0.0) return vec2(0.0);
  vec2 g = p / 0.3; vec2 c0 = floor(g); vec2 s = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = c0 + vec2(i, j); int ci = int(c.x), cj = int(c.y);
    float ph = w2hash01(ci, cj, 93), r0 = fract(t * 0.9 + ph);
    if (w2hash01(ci, cj, 94 + int(floor(t * 0.9 + ph))) > amt) continue;
    vec2 ctr = c + vec2(w2hash01(ci, cj, 95), w2hash01(ci, cj, 96));
    vec2 d = g - ctr; float r = length(d);
    float rr = (r - r0 * 1.6) * 6.0; float ring = sin((r - r0 * 1.6) * 28.0) * exp(-rr * rr) * (1.0 - r0);
    s += r > 1e-3 ? d / r * ring * 0.25 : vec2(0.0);
  }
  return s;
}
#ifdef W3_SSR
// the scene's reflection: the reflected ray marched against the scene's depth (resolved before the water was drawn);
// 0 alpha where it misses (the sky shows)
uniform sampler2D tDepth; uniform float uLogF;
vec4 wSSR(vec3 P, vec3 R) { // P: from the eye (vRel), as uVP takes it
  float dP = length(P), t = min(0.4 + 0.02 * dP, 0.02 + 0.05 * dP), tp = 0.0; bool front = true;
  for (int i = 0; i < 24; i++) {
    vec3 q = P + R * t;
    vec4 c = uVP * vec4(q, 1.0); if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5; if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) break;
    float d = texture(tDepth, uv).r; if (d >= 1.0) { front = true; tp = t; t *= 1.35; continue; }
    float sw = exp2(d * uLogF) - 1.0;                              // the scene's view depth at that pixel
    vec3 S = q * (sw / c.w);    // the scene's point on the same pixel ray (from the eye)
    // a crossing: the ray went from in front of the scene to behind it within this step, on something above the water.
    // The step grows with distance, so the crossing is found again by halving it, and taken only if the ray is then
    // within a thin shell behind what the pixel shows: a ray passing far behind a thin thing (a wasp, a stem) is not
    // a hit. Taken at the step's end with a step-long allowance, a wasp's reflection was a streak hanging under it,
    // the longer the further the eye (the steps grow with the distance)
    if (c.w > sw && front && S.y > P.y + 0.002) {
      float a = tp, b = t; vec2 hu = uv; float hw = c.w, hs = sw;
      for (int k = 0; k < 6; k++) {
        float m = 0.5 * (a + b); vec4 cm = uVP * vec4(P + R * m, 1.0);
        vec2 um = cm.xy / cm.w * 0.5 + 0.5; float dm = texture(tDepth, um).r, sm = dm >= 1.0 ? 1e9 : exp2(dm * uLogF) - 1.0;
        if (cm.w > sm) { b = m; hu = um; hw = cm.w; hs = sm; } else a = m;
      }
      if (hw - hs < 0.01 + 0.02 * hs) {
        float e = min(min(hu.x, 1.0 - hu.x), min(hu.y, 1.0 - hu.y));
        return vec4(texture(tScene, hu).rgb, smoothstep(0.0, 0.08, e));
      }
    }
    front = c.w <= sw; tp = t; t *= 1.35;
  }
  return vec4(0.0);
}
#endif
void main() {
  #include <logdepthbuf_fragment>
  // the floor under this point of the surface, and the waves' weights for it (as the vertices had them)
  float lv = clipWater(vW.xz), bed = clipHeight(vW.xz), depth = lv - bed;
  float D = max(vW.y - bed, 0.0); // the water's thickness under the point
  vec4 k = w3Damp(depth, lv) * vRough; k.x *= 1.0 - vNear;
  float fl = clamp(vFlow.x, 0.0, 1.0); vec2 fv = vFlow.yz; float sp = length(fv);
  k.x *= 1.0 - fl;
  vec3 fph = w3FlowPh(vXZ); mat2 fM = w3FlowM(fv);
  vec2 gu = w3Gust(vXZ);
  // ---- the slope: mean and variance over the pixel's footprint (LEAN), each short cascade detiled as the vertices are
  vec2 m = vCoastSlope, sv = vec2(uWLost * 0.5 + uLook.y * uLook.y); vec2 gx = dFdx(vXZ), gy = dFdy(vXZ);
  ${cs.map((c) => `{ float L = uWL[${c}], kc = k[${Math.min(c, 3)}]${c === 1 ? ' * gu.x' : c > 1 ? ' * gu.y' : ''}; vec2 u = vXZ / L;
    vec4 a = textureGrad(tWS${c}, u, gx / L, gy / L);${c > 0 ? `
    vec2 R = ${rot(c, 1)}, Ri = ${rot(c, -1)};
    vec4 b = textureGrad(tWS${c}, w3Rot(u, R) + vec2(${S.shift[c].map(f).join(', ')}), w3Rot(gx / L, R), w3Rot(gy / L, R)); b.xy = w3Rot(b.xy, Ri); b.zw = vec2(0.5 * (b.z + b.w));
    float w = w3Blend(vXZ, L, ${c}), n2 = (1.0 - w) * (1.0 - w) + w * w;
    a = vec4((a.xy * (1.0 - w) + b.xy * w) * inversesqrt(n2), (a.zw * (1.0 - w) * (1.0 - w) + b.zw * w * w) / n2);
    if (fl > 0.01) { // the river's ripples carried downstream (two phases), stretched across the flow: the slope back through fM
      vec2 g1 = fM * gx / L, g2 = fM * gy / L;
      vec4 fa = textureGrad(tWS${c}, fM * (vXZ - fv * fph.x) / L, g1, g2), fb = textureGrad(tWS${c}, fM * (vXZ - fv * fph.y) / L, g1, g2);
      float q = fph.z, nq = q * q + (1.0 - q) * (1.0 - q), am = ${c === 1 ? '0.35' : '(0.6 + 0.6 * min(sp / 1.5, 1.0))'};
      vec4 fs = vec4(fM * ((fa.xy * q + fb.xy * (1.0 - q)) * inversesqrt(nq)), (fa.zw * q * q + fb.zw * (1.0 - q) * (1.0 - q)) / nq) * vec4(am, am, am * am, am * am);
      a = mix(a, fs, fl);
    }` : ''}
    m += a.xy * kc; sv += max(a.zw - a.xy * a.xy, 0.0) * kc * kc; }`).join('\n  ')}
  float fp = sqrt(max(length(gx) * length(gy), 1e-12));
  m += wRain(vXZ, uTime, uRain) * (1.0 - smoothstep(0.02, 0.08, fp)); // rings while rain falls
  vec3 n = normalize(vec3(-m.x, 1.0, -m.y));
  vec3 V = normalize(-vRel); float tw = length(vRel); // from the eye, exact far from home
  vec2 suv = gl_FragCoord.xy / vec2(textureSize(tScene, 0));
  // the shoreline, per pixel: no water where its height is under this pixel's sand (the triangles cannot put water on
  // the sand at the wrong moment); its sheet's foam
  float swLace = 0.0, swWhite = 0.0, thin = 0.06;
#ifdef W3_COAST
  if (depth < 0.8 && depth > -3.0 && lv <= uSeaLevel + 0.5 && uSurf.x > 0.0) {
    vec3 cn = clipNormal(vW.xz); vec2 grad = -cn.xz / max(cn.y, 0.05);
    sw3Beach(vW.xz, grad); gExpo *= 1.0 - fl; // no swash up a river's banks
    float s, th = lv + sw3Shore(vW.xz, length(grad), uWTime, s) - bed;
    if (depth < 0.0 && th <= 0.0) discard;
    // a bubbly band behind the tip while it climbs; sparse remnants in the backwash, thinning as it drains; the
    // bore's white over the sheet, fresh as it arrives
    float aa = 0.004 + 4e-5 * tw;
    // the lace along the sheet's edge, up with it and back down with it to the line (thinner as it drains); the bore's
    // white over the sheet thinning as the water goes back, never gone before the next bore (the ebb and flow repeats)
    float band = smoothstep(-aa, aa, th) * (1.0 - smoothstep(0.0, 0.3 * uLook2.w + aa, th));
    swLace = smoothstep(0.0, 0.04, s) * band * (s < SW3_UP ? 1.0 : mix(0.75, 0.4, (s - SW3_UP) / (1.0 - SW3_UP))) * (1.0 - smoothstep(0.0, 0.3, depth));
    swWhite = (s < SW3_UP ? 1.0 - 0.4 * s / SW3_UP : 0.6 - 0.35 * (s - SW3_UP) / (1.0 - SW3_UP)) * smoothstep(0.0, 0.05, s) * smoothstep(0.0, 0.08, th) * (1.0 - smoothstep(0.1, 0.3, depth)); // grown in as the bore arrives, thinning to a quarter as it drains
    float mass = sw3ShoreFoam(depth, th, s, vCoast.x); // (water3/swash.js; the foam field keeps it as long as the water's own)
    swLace = max(swLace, mass);
    if (depth < 0.0 || th > 0.0) thin = 0.015; // the sheet on the sand, and the water by the line while the swash is up: thin, and still water (a mirror), never faded to see-through (it read as a dry strip between the two)
  }
#endif
  float edge = smoothstep(0.0, thin, D); // the water thinning to nothing at its edge
  bool under = vRel.y > 0.0;
  if (under) n = -n;
  vec3 ext = W_ABS + W_SCA;
  float sunUp = max(uSun.y, 0.0);
  vec3 amb = uSkyUp / 3.14159 * 0.8 + uSunColor * sunUp / 3.14159 * 0.6 + uMoonColor * max(uMoonDir.y, 0.0) / 3.14159 * 0.7; // the moon's light too, at night
  if (under) {
    // from below: the world above through the surface, the water between the eye and it
    vec3 Tw = exp(-ext * tw);
    oColor = vec4(texture(tScene, suv).rgb * Tw + W_SCA / ext * (1.0 - Tw) * amb, 1.0);
    return;
  }
  // ---- refraction: the floor along the refracted ray, the offset shrinking to nothing as the water thins
  float nv = max(dot(n, V), 1e-3), F = wFresnel(nv);
  vec3 Tr = refract(-V, n, 1.0 / W_N);
  float Lp = D / max(-Tr.y, 0.15); // the path down to the floor
  vec3 Pf = vRel + Tr * min(Lp, 8.0); // from the eye (uVP takes it so)
  vec4 cf = uVP * vec4(Pf, 1.0); vec2 ruv = cf.w > 0.0 ? clamp(cf.xy / cf.w * 0.5 + 0.5, vec2(0.001), vec2(0.999)) : suv;
  ruv = mix(suv, ruv, edge * uLook.z / 0.06); // the refraction's strength (0.06: as drawn)
  // the scene under the water is read where the bent ray lands; where that pixel shows a thing above the water (the
  // wasp, drawn into the scene in front of the water) it is not the floor: read straight down instead (the mirror's
  // mask: the mirrored things as the eye sees them). Without this the wasp showed in the water as if under it
  if (uMirrorOn > 0.5 && texture(tMirrorMask, ruv).a > 0.02) ruv = suv;
  vec3 floorCol = texture(tScene, ruv).rgb;
  // the floor's light: the sun's share lost to the surface and the water on its way down and focused by the
  // caustics, the sky's share lost to the water; then the path up to the eye (Beer-Lambert) and the water's own glow
  float es = dot(uSunColor, vec3(0.2126, 0.7152, 0.0722)) * sunUp, ek = dot(uSkyUp, vec3(0.2126, 0.7152, 0.0722));
  float share = es / max(es + ek, 1e-6);
  vec3 Ts = refract(-uSun, vec3(0.0, 1.0, 0.0), 1.0 / W_N);
  vec2 Pb = vW.xz + Tr.xz * Lp;
  float cz = mix(1.0, wCaustic(Pb, D, fp), uLook3.x);
  vec3 lit = floorCol * (share * exp(-ext * D / max(-Ts.y, 0.1)) * (1.0 - wFresnel(sunUp)) * cz + (1.0 - share) * exp(-ext * D * 1.2) * 0.934);
  vec3 Tw = exp(-ext * Lp);
  vec3 body = lit * Tw + W_SCA / ext * (1.0 - Tw) * amb;
  float cloud = 1.0;
#ifdef W3_COAST
  cloud = shoreCloud(vW.xz);
#endif
  // the surf zone's water is churned: sand held up in it, lit through the water, by how much the waves work there
  { float tb = clamp(vCoast.z, 0.0, 1.0) * 0.5 * edge; vec3 turb = vec3(0.32, 0.4, 0.27) * (uSkyUp * 0.8 + uSunColor * sunUp * 0.6 * cloud); body = mix(body, turb, tb); }
  // ---- reflection: the scene where the march finds it, else the sky; the sun through the slopes' distribution
  vec3 Rv = reflect(-V, n); Rv.y = abs(Rv.y);
  vec3 refl = skyAt(Rv) + nightSky(Rv, 0.02 + 0.5 * sqrt(sv.x + sv.y)); // the night sky in it: the stars and the moon, blurred by the ripples
#ifdef W3_SSR
  { vec4 ss = wSSR(vRel, Rv); refl = mix(refl, ss.rgb, ss.a); }
#endif
  // the mirror: the game's own things (the wasps) drawn from the eye mirrored in the water's plane, read where this
  // point of the water shows them (the true reflection: in place, at its size, from the thing itself), rippled
  if (uMirrorOn > 0.5) {
    vec4 cm = uVPM * vec4(vRel + uMirrorOff, 1.0);
    if (cm.w > 0.0) { vec2 mu = cm.xy / cm.w * 0.5 + 0.5 + n.xz * 0.012 * edge; vec4 mc = texture(tMirror, mu); refl = refl * (1.0 - clamp(mc.a, 0.0, 1.0)) + mc.rgb; } // drawn over a clear target: premultiplied
  }
  vec3 Hh = normalize(V + uSun);
  vec2 sh = vec2(-Hh.x, -Hh.z) / max(Hh.y, 1e-3) - m;
  vec2 s2 = sv + vec2(${((0.00465 / 2) ** 2 / 4).toExponential(3)}) + vec2(1e-7);
  float P22 = exp(-0.5 * (sh.x * sh.x / s2.x + sh.y * sh.y / s2.y)) / (6.2831853 * sqrt(s2.x * s2.y));
  float ch = max(Hh.y, 1e-3), Dm = P22 / (ch * ch * ch * ch), sav = 0.5 * (s2.x + s2.y);
  float G = 1.0 / (1.0 + wLambda(max(V.y, 1e-3), sav) + wLambda(max(uSun.y, 1e-3), sav));
  vec3 spec = uSunColor * wFresnel(dot(V, Hh)) * Dm * G / (4.0 * max(V.y, 1e-3)) * step(0.0, uSun.y) * cloud;
  // the moon's path on the water: the same highlight from the moon (its disc a little larger than the sun's)
  if (uMoonColor.r > 1e-5) {
    vec3 Hm = normalize(V + uMoonDir); vec2 shm = vec2(-Hm.x, -Hm.z) / max(Hm.y, 1e-3) - m, s2m = s2 + vec2(1.5e-5);
    float Pm = exp(-0.5 * (shm.x * shm.x / s2m.x + shm.y * shm.y / s2m.y)) / (6.2831853 * sqrt(s2m.x * s2m.y)), chm = max(Hm.y, 1e-3);
    float Gm = 1.0 / (1.0 + wLambda(max(V.y, 1e-3), sav) + wLambda(max(uMoonDir.y, 1e-3), sav));
    spec += uMoonColor * 6.0 * wFresnel(dot(V, Hm)) * Pm / (chm * chm * chm * chm) * Gm / (4.0 * max(V.y, 1e-3)) * step(0.0, uMoonDir.y);
  }
  // glints: facets the size of the short ripples in cells anchored to the world, at the two power-of-two sizes round
  // the footprint; each cell redraws its Poisson count about three times a second, so close water sparkles and far
  // water is smooth (the mean is the smooth highlight's)
  float l = clamp(fp, 0.002, 0.5 * uWPeak);
  float pc = P22 * ${(Math.PI * (0.00465 / 2) ** 2).toExponential(4)} / (ch * ch * ch) / (l * l);
  float lf = log2(max(fp, l)), l0 = floor(lf), gm = 0.0;
  if (uGlint > 0.0 && pc * exp2(2.0 * l0) < 60.0) {
    for (int j = 0; j < 2; j++) {
      float sz = exp2(l0 + float(j)), lam = max(pc * sz * sz, 1e-6);
      vec2 cl = floor(vXZ / sz); int cx = int(cl.x), cz2 = int(cl.y), lvi = int(l0) + j + 64;
      float tt = uTime * 3.0 + w2hash01(cx, cz2, 403 + lvi) * 64.0, it = floor(tt);
      float n0 = wPoisson(lam, w2hash01(cx, cz2, 410 + lvi * 977 + int(it)), w2hash01(cx, cz2, 411 + lvi * 977 + int(it)));
      float n1 = wPoisson(lam, w2hash01(cx, cz2, 410 + lvi * 977 + int(it) + 1), w2hash01(cx, cz2, 411 + lvi * 977 + int(it) + 1));
      gm += (j == 0 ? 1.0 - (lf - l0) : lf - l0) * mix(n0, n1, smoothstep(0.0, 1.0, tt - it)) / lam;
    }
    spec *= mix(1.0, gm, uGlint);
  }
  vec3 c = mix(body, refl, F * edge) + spec * edge;
  // light through a steep crest: where a surf wave stands high and its face is steep the water is thin enough for the
  // sun and sky to come through it green, brightest looking toward the sun (the lip before it breaks)
#ifdef W3_COAST
  { float crest = clamp((vW.y - lv) / max(uSurf.x, 0.1), 0.0, 1.5), steep = smoothstep(0.12, 0.45, length(vCoastSlope));
    float back = 0.35 + 0.65 * pow(max(dot(-V, normalize(vec3(uSun.x, 0.0, uSun.z) + vec3(0.0, 0.2, 0.0))), 0.0), 3.0);
    c += vec3(0.04, 0.42, 0.3) * (uSunColor * sunUp * 0.5 + uSkyUp * 0.35) * crest * (crest * steep * back * uLook.w / 1.6 + uLook2.x / 0.06 * 0.08) * edge; }
#endif
  // ice (deep winter): a pale, rough sheet over the water, the sky softly in it
  if (uIce > 0.0) { float ic = smoothstep(0.0, 0.6, uIce) * edge; vec3 iceCol = vec3(0.72, 0.8, 0.88) * (uSkyUp * 0.7 + uSunColor * sunUp * 0.25) * (0.9 + 0.1 * w2noise(vXZ / 1.5, 302)); c = mix(c, iceCol + skyAt(Rv) * 0.08, ic); }
  // ---- foam: where the surface folds (whitecaps), on the breakers' faces, the lace behind them, the surf zone's
  // standing foam, and the swash's lace at its tip and white behind it; one pattern of three scales covered to a
  // share set by each foam's strength
  // whitecaps where the surface folds: the Jacobian under 0.6 + bias, by the scale (defaults 0.05 and 1.3)
  // the foam field (water3/foamfield.js): what the whitecaps and breakers made, carried in and lingering; past its
  // window the folds' own whitecaps, this frame's
  float ff = 0.0, inField = 0.0;
  { vec2 fu = (vXZ - uFoamFarWin.xy) / uFoamFarWin.z; float e = min(min(fu.x, fu.y), min(1.0 - fu.x, 1.0 - fu.y)); if (e > 0.0) { inField = smoothstep(0.0, 0.08, e); ff = texture(tFoamFar, fu).r * inField; } }
  { vec2 fu = (vXZ - uFoamWin.xy) / uFoamWin.z; float e = min(min(fu.x, fu.y), min(1.0 - fu.x, 1.0 - fu.y)); if (e > 0.0) { float k = smoothstep(0.0, 0.08, e); ff = mix(ff, texture(tFoamField, fu).r, k); inField = max(inField, k); } }
  ff = clamp(ff, 0.0, 1.0);
  float ls = max(uLace.x, 0.02); // the panel's lace scale
  // by the water's depth: fine in the shallows (a quarter of it), ten times that from about 3 m deep (the open water's
  // sloshing, dispersed). Drawn at three fixed sizes and crossfaded, not at a size that varies from pixel to pixel
  // (that warps the pattern into stripes)
  gLaceT = smoothstep(0.0, 3.0, depth);
  // the foam's patches: denser here, thinner there, a new arrangement over every few tens of metres
  float fpatch = mix(1.0, 0.45 + 1.1 * (0.5 + 0.5 * w2noise(vXZ / (9.0 * max(ls, 0.3)) + vec2(uTime * 0.01, 0.0), 842)), uLace.z);
  float fm = clamp((0.6 + uLook2.y - vJ) * uLook2.z, 0.0, 1.0) * smoothstep(0.25, 0.6, laceD(vXZ, vLoc, 1.4 * ls, vec2(0.0)) + 0.2) * (1.0 - inField) * fpatch;
  ff *= fpatch;
  // the open water's own lace, now and then: where the sloshing crests heap up (the surface squeezed: its Jacobian
  // under 1) and a slow drifting noise allows, patches of lace form and fade; away from the shallows (their own foam there),
  // on a lake as on the sea
  {
    float pn = smoothstep(0.6, 0.85, 0.5 + 0.5 * w2noise(vXZ / 23.0 + vec2(uTime * 0.07, -uTime * 0.05), 851))
             * smoothstep(0.5, 0.8, 0.5 + 0.5 * w2noise(vXZ / 61.0 - vec2(uTime * 0.03, uTime * 0.04), 852));
    float slosh = pn * smoothstep(1.03, 0.88, vJ) * smoothstep(0.8, 2.5, depth);
    fm = max(fm, slosh * smoothstep(0.3, 0.65, laceD(vXZ, vLoc, 1.6 * ls, vec2(uTime * 0.02, uTime * 0.013)) + 0.15) * 0.6 * fpatch);
  }
  // the foam's pattern: the baked lace (water3/foamtex.js) at two scales, drifting apart slowly so it churns
  float pat = 0.62 * laceD(vXZ, vLoc, 3.1 * ls, vec2(uTime * 0.011, -uTime * 0.007)) + 0.38 * laceD(vXZ, vLoc, 1.17 * ls, -vec2(uTime * 0.017, uTime * 0.005)) + 0.12;
  float wf = clamp(vCoast.x, 0.0, 1.0), lc = clamp(vCoast.y, 0.0, 1.0) * (1.0 - 0.6 * inField);
  // the field's foam: thick and white where fresh, eroding into lace as it fades
  fm = max(fm, smoothstep(1.0 - 0.6 * ff, 1.1 - 0.6 * ff, pat) * (0.3 + 0.55 * ff)); // never solid: even the thickest foam shows its lace
  fm = max(fm, smoothstep(1.0 - 0.6 * wf, 1.12 - 0.6 * wf, pat) * (0.6 + 0.4 * wf)); // the breaker's white, open lace even at its thickest
  fm = max(fm, smoothstep(1.0 - 0.5 * lc, 1.1 - 0.5 * lc, pat) * 0.45);
  float spf = 0.55 * laceD(vXZ, vLoc, 5.3 * ls, vec2(uTime * 0.006, -uTime * 0.004)) + 0.45 * laceD(vXZ, vLoc, 1.9 * ls, -vec2(uTime * 0.012, 0.0)) + 0.15;
  float sf = clamp(vCoast.z, 0.0, 1.0);
  // (patches over a fifth of the zone at most, broken into bubbles: a bed under the crests' own white, not a sheet)
  fm = max(fm, smoothstep(0.98 - 0.3 * sf, 1.08 - 0.3 * sf, spf) * smoothstep(-0.35, 0.45, w2noise(vLoc / 0.22 + uTime * 0.05, 629)) * (0.15 + 0.25 * sf));
  fm = max(fm, smoothstep(1.0 - 0.7 * swLace, 1.12 - 0.7 * swLace, pat) * 0.85 * swLace);
  // a river's foam
  if (fl > 0.01 && sp > 0.02) {
    // white water only where it runs fast over shallows (the Froude number toward 1: rapids), a faint scum elsewhere
    // where it is quick; both the water's own lace, carried downstream by the ripples' two phases (not stretched
    // noise: that drew streaks running down the river)
    float fr = sp / sqrt(9.81 * max(depth, 0.05)), rap = fl * smoothstep(0.7, 1.1, fr), scum = fl * smoothstep(0.5, 1.6, sp) * 0.12;
    float q = fph.z, pf2 = mix(laceTap((vLoc - fv * fph.y) / laceQ(1.3 * ls), (vXZ - fv * fph.y) / (1.3 * ls)), laceTap((vLoc - fv * fph.x) / laceQ(1.3 * ls), (vXZ - fv * fph.x) / (1.3 * ls)), q);
    fm = max(fm, smoothstep(1.0 - 0.6 * rap, 1.1 - 0.6 * rap, pf2 + 0.1) * 0.8 * rap);
    fm = max(fm, smoothstep(0.75, 0.85, pf2) * scum);
  }
  fm = max(fm, smoothstep(1.0 - 0.6 * swWhite, 1.12 - 0.6 * swWhite, spf) * 0.6 * swWhite);
  c = mix(c, (uSkyUp * 0.8 + uSunColor * sunUp * 0.55 * cloud) * 0.92, fm * 0.85); // foam on top: white, lit by the sky and the sun
  // debug 8 (L in water 3): the water's kinds, blue the large water, green a river (by its share), its flow as bands
  // across it moving downstream at its speed
  if (uDebug > 7.5 && uDebug < 8.5) {
    vec3 kc = mix(vec3(0.15, 0.35, 0.95), vec3(0.1, 0.9, 0.3), fl);
    if (sp > 0.01) { vec2 a = fv / sp; float st = fract(dot(vXZ, a) / 3.0 - uTime * sp / 3.0); kc *= 0.45 + 0.55 * smoothstep(0.0, 0.2, st) * (1.0 - smoothstep(0.8, 1.0, st)) + 0.6 * smoothstep(1.5, 2.5, sp); }
    c = kc * (uSkyUp * 0.6 + uSunColor * sunUp * 0.4);
  }
  oColor = vec4(c, 1.0);
}`,
    });
    this.mesh = new THREE.Mesh(grid.geo, this.mat);
    this.mesh.frustumCulled = false; this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    // uVP: the projection of a point given from the eye (the view's rotation only: exact far from home)
    this.mesh.onBeforeRender = (r, s, cam) => { _vr.copy(cam.matrixWorldInverse).setPosition(0, 0, 0); U.uVP.value.multiplyMatrices(cam.projectionMatrix, _vr); };
    // drawn on its own after the scene (post.js), reading the scene's colour under it
    this.scene = new THREE.Scene(); this.scene.add(this.mesh);
    // the breakers' whitewater over it (water3/surffoam.js): where there is a shore table to find the surf with
    this.foamRT = bakeFoamTexture(world.renderer); U.tFoam.value = this.foamRT.texture; // baked once
    this.foam = shore ? new SurfFoam(world, this) : null;
    // the foam that lasts and travels (water3/foamfield.js): made by whitecaps and breakers, carried in, lingering
    this.field = new FoamField(world, this); Object.assign(U, this.field.read); this.field.splat = this.foam;
    this.fieldFar = new FoamField(world, this, FOAM_FIELD.far, ['tFoamFar', 'uFoamFarWin']); Object.assign(U, this.fieldFar.read); // the open sea's whitecaps, 2 km round
    // the breakers' curl over it (water3/curl.js): a mesh of its own, where there is a shore table
    this.curl = shore ? new CurlMesh(world, this) : null;
    if (this.curl) this.scene.add(this.curl.mesh);
    // (the foam pieces are not drawn: they splat into the near foam field, which the surface draws)
    this._t = null;
  }
  // The mirror (GDD 18.105): the things on MIRROR.layer (the game puts its wasps there, with its lights) drawn from the
  // eye mirrored in the water's plane under MIRROR.at (the driven wasp), into a target the surface reads where it
  // shows them; and the same things from the eye, a mask the refraction keeps off. Drawn only while there is water
  // under that point and the eye is within MIRROR.above m of it; a few draws (the camera sees only that layer)
  mirror(scene, camera) {
    const W = this.world, r = W.renderer, U = this.U, at = this.mirrorAt || camera.position, e = camera.position;
    const L = W.waterAt(at.x, at.z), on = MIRROR.layer >= 0 && L > W.heightAt(at.x, at.z) - 0.01 && e.y > L && e.y - L < MIRROR.above;
    U.uMirrorOn.value = on ? 1 : 0;
    if (!on) return;
    const sz = r.getDrawingBufferSize(_mv2), w = Math.max(64, Math.round(sz.x * MIRROR.scale)), h = Math.max(64, Math.round(sz.y * MIRROR.scale));
    if (!this._mir || this._mir.w !== w || this._mir.h !== h) {
      if (this._mir) { this._mir.rt.dispose(); this._mir.mask.dispose(); }
      this._mir = { w, h, rt: new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType }), mask: new THREE.WebGLRenderTarget(w, h), cam: new THREE.PerspectiveCamera(), eye: new THREE.PerspectiveCamera() };
      U.tMirror.value = this._mir.rt.texture; U.tMirrorMask.value = this._mir.mask.texture;
    }
    const M = this._mir, vc = M.cam;
    vc.copy(camera, false); vc.layers.set(MIRROR.layer);
    camera.getWorldDirection(_md); _mu.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(_mq));
    vc.position.set(e.x, 2 * L - e.y, e.z); vc.up.set(_mu.x, -_mu.y, _mu.z); vc.lookAt(vc.position.x + _md.x, vc.position.y - _md.y, vc.position.z + _md.z);
    vc.updateMatrixWorld(); vc.projectionMatrix.copy(camera.projectionMatrix); vc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    M.eye.copy(camera, false); M.eye.layers.set(MIRROR.layer); M.eye.position.copy(e); M.eye.quaternion.copy(camera.getWorldQuaternion(_mq)); M.eye.updateMatrixWorld();
    M.eye.projectionMatrix.copy(camera.projectionMatrix); M.eye.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    const prev = r.getRenderTarget(), bg = scene.background, sm = r.shadowMap.needsUpdate, cc = r.getClearColor(_mc), ca = r.getClearAlpha();
    scene.background = null; r.shadowMap.needsUpdate = false; r.setClearColor(0x000000, 0);
    r.setRenderTarget(M.rt); r.clear(); r.render(scene, vc);
    r.setRenderTarget(M.mask); r.clear(); r.render(scene, M.eye);
    r.setRenderTarget(prev); r.setClearColor(cc, ca); r.shadowMap.needsUpdate = sm; scene.background = bg;
    _mr.copy(vc.matrixWorldInverse).setPosition(0, 0, 0); U.uVPM.value.multiplyMatrices(vc.projectionMatrix, _mr);
    U.uMirrorOff.value.set(0, e.y - vc.position.y, 0); // the eye to the mirrored eye: the water's points are given from the eye
  }
  // once a frame: the camera, the light, the gusts' drift
  update(camera, time, wind) {
    const U = this.U, W = this.world;
    U.uCam.value.copy(camera.position);
    // the camera from a point snapped to 2048 m, in double precision (the fine patterns' coordinates: water3/surface.js
    // vLoc; far from the origin a float holds a world position only to centimetres)
    U.uCamL.value.set(camera.position.x - Math.round(camera.position.x / 2048) * 2048, camera.position.z - Math.round(camera.position.z / 2048) * 2048);
    const above = Math.max(0, camera.position.y - W.waterAt(camera.position.x, camera.position.z));
    U.uGridScale.value = Math.max(1, above / 2);
    U.uSkyUp.value.copy(W.sky.skyUp);
    const wt = W.uWTime.value, wdt = this._wt === undefined ? 0 : wt - this._wt; this._wt = wt;
    this.field.update(W.renderer, wdt, camera, wind || [0, 0], W.waterCtl.linger);
    this.fieldFar.update(W.renderer, wdt, camera, wind || [0, 0], W.waterCtl.linger * 2.0); // open-sea foam lingers longer (the panel's time, doubled)
    U.uTime.value = W.uWTime.value; U.uWLost.value = W.waves.lostSlope || 0;
    const dt = this._t === null ? 0 : Math.min(Math.max(time - this._t, 0), 0.25); this._t = time;
    if (wind) U.uDrift.value.x += wind[0] * 0.6 * dt, U.uDrift.value.y += wind[1] * 0.6 * dt; // gusts run at about the wind's pace
  }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); if (this.foam) this.foam.dispose(); this.foamRT.dispose(); this.field.dispose(); this.fieldFar.dispose(); if (this.curl) this.curl.dispose(); }
}
