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
// Step 2, the optics: drawn after the scene, the surface reads the scene's colour under it (a copy when the scene has
// no MSAA resolve to read) along the refracted ray, attenuates it per channel over the path through the water
// (Beer-Lambert), adds the water's own scattering, and reflects the sky by Fresnel with the sun's highlight from the
// slopes' distribution (mean and variance: LEAN). The floor's sunlight is lost on its way down and focused by the
// caustics. Everything fades as the water thins to nothing at its edge, so the line is the sand seen through no water.
//
// The world's depth buffer is logarithmic, so the shaders carry three.js's log-depth chunks.
import * as THREE from 'three';
import { NOISE_GLSL } from '../noise.js';
import { SKY_GLSL } from '../sky.js';
import { WATER, WATER_CAUSTIC_GLSL } from '../water.js';
import { SHORE } from '../shorefield.js';

export const SURFACE = {
  segments: 256, inner: 0.0625, innerGrow: 1.12, reach: 4000, skirt: 60000,
  floorReach: 600,               // metres: the floor is read for vertices nearer than this
  clear: 0.04,                   // metres the trough is held over the floor
  // detiling: per short cascade, the second read's rotation (radians) and shift (tile units); the blend's noise is
  // this many tiles across
  rot: [0, 1.9, 0.9, 2.5], shift: [[0, 0], [0.31, 0.67], [0.53, 0.19], [0.83, 0.41]], blendTiles: 2.3,
  gust: 38,                      // metres: the chop's patches
  coast: [180, 420],             // metres from the shore: the coast's swell carries it all within the first, none past the second
  lee: 0.45,                     // the share of the swell a coast in its lee gets
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

export class WaterSurface {
  // world: the World (its clipmap, wave field, sky, shore table, caustics)
  constructor(world) {
    this.world = world;
    const field = world.waves, C = field.C, cs = [...Array(C).keys()], S = SURFACE, N = field.N;
    const shore = world.shore && !world.shore.live ? world.shore : null;
    this.coastOn = !!shore;
    const grid = polarGrid();
    this.stats = { verts: grid.verts, tris: grid.geo.index.count / 3 };
    const U = {
      ...world.clip.uniforms, ...world.sky.uniforms, ...(shore ? shore.uniforms : {}),
      uCam: { value: new THREE.Vector3() }, uGridScale: { value: 1 }, uWL: { value: field.U.uL.value }, uTime: { value: 0 }, uDrift: { value: new THREE.Vector2() },
      uSeaLevel: { value: world.source.sea }, uSkyUp: { value: new THREE.Color() }, uWLost: { value: 0 },
      uShoreWave: world.uShoreWave, uSwDir: field.U.uSwDir,
      tScene: { value: null }, uVP: { value: new THREE.Matrix4() },
      tCaus: { value: world.caustics ? world.caustics.rt.texture : null }, uCaus: world.post.U.uCaus,
    };
    cs.forEach((c) => { U['tWD' + c] = { value: field.disp[c].texture }; U['tWS' + c] = { value: field.slope[c].texture }; });
    this.U = U;
    const rot = (c, s) => `vec2(${Math.cos(s * S.rot[c]).toFixed(6)}, ${Math.sin(s * S.rot[c]).toFixed(6)})`;
    const head = /* glsl */ `
${NOISE_GLSL}
${world.clip.glsl()}
${shore ? shore.glsl() + '\n#define W3_COAST' : ''}
uniform vec3 uCam; uniform float uGridScale, uSeaLevel, uTime; uniform vec4 uWL; uniform vec2 uDrift;
${cs.map((c) => `uniform sampler2D tWD${c}, tWS${c};`).join(' ')}
vec2 w3Rot(vec2 v, vec2 cs) { return vec2(cs.x * v.x - cs.y * v.y, cs.y * v.x + cs.x * v.y); }
// the cascades' weights by the depth under the water: the long ones need depth, the chop reaches the beach
// (the first cascade holds the far swell; a lake, above the sea's level, has none)
vec4 w3Damp(float depth, float level) { float sw = smoothstep(1.5, 8.0, depth) * step(level, uSeaLevel + 0.5), mid = smoothstep(0.3, 3.0, depth), ch = smoothstep(-0.2, 1.0, depth); return vec4(sw, mid, ch, ch); }
// the detiling blend's weight for cascade c at p (0: the plain read, 1: the rotated one)
float w3Blend(vec2 p, float L, int c) { return smoothstep(-0.4, 0.4, w2noise(p / (L * ${f(S.blendTiles)}), 700 + c)); }
// the chop's gusts: patches of rougher and calmer water drifting with the wind (cascade 1 a little, 2 and 3 more)
vec2 w3Gust(vec2 p) { float n = w2noise((p - uDrift) / ${f(S.gust)}, 710) + 0.5 * w2noise((p - uDrift * 1.3) / ${f(S.gust * 0.37)}, 711); return vec2(1.0 + 0.25 * n, 1.0 + 0.55 * n); }`;

    // ---- the coast's swell (vertex): displacement, slope, and the share of the swell it carries here
    const coast = /* glsl */ `
#ifdef W3_COAST
uniform vec4 uShoreWave; uniform vec2 uSwDir;
float gNear = 0.0; vec2 gCoastSlope = vec2(0.0);
vec3 w3Coast(vec2 p, float depth, float level, float cell) {
  gNear = 0.0; gCoastSlope = vec2(0.0);
  if (level > uSeaLevel + 0.5 || depth <= 0.0 || uShoreWave.x <= 0.0) return vec3(0.0);
  vec4 sh = shoreAt(p); float coh = gShoreKnow > 0.0 ? length(sh.yz) : 0.0;
  if (coh < 0.05) return vec3(0.0);
  vec2 dir = sh.yz / coh; // toward the shore
  float near = gShoreKnow * smoothstep(0.05, 0.5, coh) * (1.0 - smoothstep(${f(S.coast[0])}, ${f(S.coast[1])}, -sh.x));
  if (near <= 0.0) return vec3(0.0);
  gNear = near;
  float expo = mix(${f(S.lee)}, 1.0, smoothstep(-0.4, 0.6, dot(uSwDir, dir)));
  float cel = sqrt(9.81 * clamp(depth, ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)}));
  float shoal = clamp(pow(max(depth, 0.6) / ${SHORE.dMax.toFixed(1)}, -0.25), 1.0, 2.2);
  // three trains: variance Hs^2 / 16 split three ways (a = Hs / sqrt(24)), the set held under the breaking depth
  float A = uShoreWave.x * 0.2041 * near * expo * shoal;
  A *= min(1.0, 0.39 * depth / max(2.2 * A, 1e-4));
  float pn = w2noise(p / 240.0, 611) * 5.0 + w2noise(p / 70.0, 612) * 1.6; // the crests bend along the shore
  vec3 d = vec3(0.0); float sy = 0.0, sx = 0.0;
  for (int i = 0; i < 3; i++) {
    float T = uShoreWave.y * (i == 0 ? 1.0 : i == 1 ? 0.93 : 1.08), w = 6.2831853 / T, k = w / cel;
    float bl = 1.0 - smoothstep(0.1, 0.3, k * cell / 6.2831853); // a train shorter than a few cells fades instead of aliasing
    float a = A * bl;
    float ph = w * (uTime + sh.w) + pn * (i == 0 ? 1.0 : i == 1 ? 1.37 : 0.71) + float(i) * 2.1;
    // Gerstner: the water rides forward on the crest; steeper as the depth runs out, never looping
    float q = min(0.5 + 2.0 * a / max(depth, 0.1), 0.9 / max(3.0 * a * k, 1e-4));
    float c = cos(ph), s = sin(ph);
    d.y += a * c; d.xz += dir * (q * a * s);
    sy += a * k * s; sx += q * a * k * c;
  }
  gCoastSlope = dir * (sy / max(1.0 - sx, 0.1));
  return d;
}
#endif`;

    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: U, side: THREE.DoubleSide,
      vertexShader: /* glsl */ `precision highp float; precision highp int;
#include <common>
#include <logdepthbuf_pars_vertex>
${head}
${coast}
out vec3 vW; out vec2 vXZ; out float vCell, vNear; out vec2 vCoastSlope;
void main() {
  bool skirt = position.y > 0.5;
  float r = length(position.xz);
  vec2 xz = skirt ? uCam.xz + position.xz * ${S.skirt.toFixed(1)} : uCam.xz + position.xz * uGridScale;
  float level = clipWater(xz);
  float dc = distance(xz, uCam.xz);
  // the floor, read only where it can matter
  float bed = -1e4, depth = 1e4;
  if (dc < ${S.floorReach.toFixed(1)}) { bed = clipHeight(xz); depth = level - bed; }
  vec4 k = w3Damp(depth, level);
  float cell = max(r, 1.0) * ${grid.cellStep.toFixed(5)} * uGridScale;
  vec3 d = vec3(0.0); vNear = 0.0; vCoastSlope = vec2(0.0);
  if (!skirt) {
#ifdef W3_COAST
    if (bed > -1e3) { d += w3Coast(xz, depth, level, cell); vNear = gNear; vCoastSlope = gCoastSlope; k.x *= 1.0 - gNear; }
#endif
    vec2 gu = w3Gust(xz);
    // each cascade at the mip its vertex spacing can carry (+1: a little blurrier than the spacing, so it never shimmers)
    ${cs.map((c) => `{ float lod = max(0.0, log2(cell * ${N}.0 / uWL[${c}]) + 1.0); if (lod < ${Math.log2(N).toFixed(1)}) {
      vec2 u = xz / uWL[${c}]; vec3 a = textureLod(tWD${c}, u, lod).xyz;${c > 0 ? `
      vec3 b = textureLod(tWD${c}, w3Rot(u, ${rot(c, 1)}) + vec2(${S.shift[c].map(f).join(', ')}), lod).xyz; b.xz = w3Rot(b.xz, ${rot(c, -1)});
      float w = w3Blend(xz, uWL[${c}], ${c}); a = (a * (1.0 - w) + b * w) * inversesqrt((1.0 - w) * (1.0 - w) + w * w);` : ''}
      d += a * k[${Math.min(c, 3)}]${c === 1 ? ' * gu.x' : c > 1 ? ' * gu.y' : ''}; } }`).join('\n    ')}
  }
  vec3 P = vec3(xz.x + d.x, level + d.y, xz.y + d.z);
  // the trough held over the floor (the clearance grows with distance for the depth buffer's precision); over land the
  // surface stays at the level and the terrain hides it
  if (bed > -1e3) P.y = max(P.y, min(bed + ${S.clear.toFixed(3)} + 2e-7 * dc * dc, level));
  vW = P; vXZ = xz; vCell = cell;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
  #include <logdepthbuf_vertex>
}`,
      fragmentShader: /* glsl */ `precision highp float; precision highp int;
#include <logdepthbuf_pars_fragment>
${head}
${SKY_GLSL}
uniform vec3 uSun, uSunColor, uSkyUp; uniform sampler2D uSkyView, tScene; uniform mat4 uVP; uniform float uWLost;
in vec3 vW; in vec2 vXZ; in float vCell, vNear; in vec2 vCoastSlope; out vec4 oColor;
const float W_N = ${f(WATER.n)};
const vec3 W_ABS = vec3(${WATER.absorb.map(f).join(', ')}), W_SCA = vec3(${WATER.scatter.map(f).join(', ')});
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
void main() {
  #include <logdepthbuf_fragment>
  // the floor under this point of the surface, and the waves' weights for it (as the vertices had them)
  float lv = clipWater(vW.xz), bed = clipHeight(vW.xz), depth = lv - bed;
  float D = max(vW.y - bed, 0.0); // the water's thickness under the point
  vec4 k = w3Damp(depth, lv); k.x *= 1.0 - vNear;
  vec2 gu = w3Gust(vXZ);
  // ---- the slope: mean and variance over the pixel's footprint (LEAN), each short cascade detiled as the vertices are
  vec2 m = vCoastSlope, sv = vec2(uWLost * 0.5); vec2 gx = dFdx(vXZ), gy = dFdy(vXZ);
  ${cs.map((c) => `{ float L = uWL[${c}], kc = k[${Math.min(c, 3)}]${c === 1 ? ' * gu.x' : c > 1 ? ' * gu.y' : ''}; vec2 u = vXZ / L;
    vec4 a = textureGrad(tWS${c}, u, gx / L, gy / L);${c > 0 ? `
    vec2 R = ${rot(c, 1)}, Ri = ${rot(c, -1)};
    vec4 b = textureGrad(tWS${c}, w3Rot(u, R) + vec2(${S.shift[c].map(f).join(', ')}), w3Rot(gx / L, R), w3Rot(gy / L, R)); b.xy = w3Rot(b.xy, Ri); b.zw = vec2(0.5 * (b.z + b.w));
    float w = w3Blend(vXZ, L, ${c}), n2 = (1.0 - w) * (1.0 - w) + w * w;
    a = vec4((a.xy * (1.0 - w) + b.xy * w) * inversesqrt(n2), (a.zw * (1.0 - w) * (1.0 - w) + b.zw * w * w) / n2);` : ''}
    m += a.xy * kc; sv += max(a.zw - a.xy * a.xy, 0.0) * kc * kc; }`).join('\n  ')}
  vec3 n = normalize(vec3(-m.x, 1.0, -m.y));
  vec3 V = normalize(cameraPosition - vW); float tw = length(cameraPosition - vW);
  vec2 suv = gl_FragCoord.xy / vec2(textureSize(tScene, 0));
  float fp = sqrt(max(length(gx) * length(gy), 1e-12));
  float edge = smoothstep(0.0, 0.06, D); // the water thinning to nothing at its edge
  bool under = cameraPosition.y < vW.y;
  if (under) n = -n;
  vec3 ext = W_ABS + W_SCA;
  float sunUp = max(uSun.y, 0.0);
  vec3 amb = uSkyUp / 3.14159 * 0.8 + uSunColor * sunUp / 3.14159 * 0.6;
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
  vec3 Pf = vW + Tr * min(Lp, 8.0);
  vec4 cf = uVP * vec4(Pf, 1.0); vec2 ruv = cf.w > 0.0 ? clamp(cf.xy / cf.w * 0.5 + 0.5, vec2(0.001), vec2(0.999)) : suv;
  ruv = mix(suv, ruv, edge);
  vec3 floorCol = texture(tScene, ruv).rgb;
  // the floor's light: the sun's share lost to the surface and the water on its way down and focused by the
  // caustics, the sky's share lost to the water; then the path up to the eye (Beer-Lambert) and the water's own glow
  float es = dot(uSunColor, vec3(0.2126, 0.7152, 0.0722)) * sunUp, ek = dot(uSkyUp, vec3(0.2126, 0.7152, 0.0722));
  float share = es / max(es + ek, 1e-6);
  vec3 Ts = refract(-uSun, vec3(0.0, 1.0, 0.0), 1.0 / W_N);
  vec2 Pb = vW.xz + Tr.xz * Lp;
  float cz = wCaustic(Pb, D, fp);
  vec3 lit = floorCol * (share * exp(-ext * D / max(-Ts.y, 0.1)) * (1.0 - wFresnel(sunUp)) * cz + (1.0 - share) * exp(-ext * D * 1.2) * 0.934);
  vec3 Tw = exp(-ext * Lp);
  vec3 body = lit * Tw + W_SCA / ext * (1.0 - Tw) * amb;
  // ---- reflection: the sky (the scene's own reflection comes later), the sun through the slopes' distribution
  vec3 Rv = reflect(-V, n); Rv.y = abs(Rv.y);
  vec3 refl = skyAt(Rv);
  vec3 Hh = normalize(V + uSun);
  vec2 sh = vec2(-Hh.x, -Hh.z) / max(Hh.y, 1e-3) - m;
  vec2 s2 = sv + vec2(${((0.00465 / 2) ** 2 / 4).toExponential(3)}) + vec2(1e-7);
  float P22 = exp(-0.5 * (sh.x * sh.x / s2.x + sh.y * sh.y / s2.y)) / (6.2831853 * sqrt(s2.x * s2.y));
  float ch = max(Hh.y, 1e-3), Dm = P22 / (ch * ch * ch * ch), sav = 0.5 * (s2.x + s2.y);
  float G = 1.0 / (1.0 + wLambda(max(V.y, 1e-3), sav) + wLambda(max(uSun.y, 1e-3), sav));
  float cloud = 1.0;
#ifdef W3_COAST
  cloud = shoreCloud(vW.xz);
#endif
  vec3 spec = uSunColor * wFresnel(dot(V, Hh)) * Dm * G / (4.0 * max(V.y, 1e-3)) * step(0.0, uSun.y) * cloud;
  vec3 c = mix(body, refl, F * edge) + spec * edge;
  oColor = vec4(c, 1.0);
}`,
    });
    this.mesh = new THREE.Mesh(grid.geo, this.mat);
    this.mesh.frustumCulled = false; this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    this.mesh.onBeforeRender = (r, s, cam) => { U.uVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); };
    // drawn on its own after the scene (post.js), reading the scene's colour under it
    this.scene = new THREE.Scene(); this.scene.add(this.mesh);
    this._t = null;
  }
  // once a frame: the camera, the light, the gusts' drift
  update(camera, time, wind) {
    const U = this.U, W = this.world;
    U.uCam.value.copy(camera.position);
    const above = Math.max(0, camera.position.y - W.waterAt(camera.position.x, camera.position.z));
    U.uGridScale.value = Math.max(1, above / 2);
    U.uSkyUp.value.copy(W.sky.skyUp);
    U.uTime.value = time; U.uWLost.value = W.waves.lostSlope || 0;
    const dt = this._t === null ? 0 : Math.min(Math.max(time - this._t, 0), 0.25); this._t = time;
    if (wind) U.uDrift.value.x += wind[0] * 0.6 * dt, U.uDrift.value.y += wind[1] * 0.6 * dt; // gusts run at about the wind's pace
  }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}
