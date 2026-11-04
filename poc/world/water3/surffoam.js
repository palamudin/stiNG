// Water 3: the breakers' whitewater as geometry over the water, after Ultra-Water's SurfFoam (MIT, Humpalumps).
//   - billows: puffs of foam that burst up where a crest crashes, ride shoreward at the bore's speed, ground on the sand
//     and ride the swash's sheet up the sand and back down to the line with it, until the next bore, eroding as they age;
//   - streaks: the backwash's foam and stirred sand drawn out seaward over the beach and the shallows.
// Fixed cost: a pool of instanced quads, each a deterministic function of the coast's clock (water3/swash.js); nothing
// is allocated or simulated while it runs. The pack picks its sites once from its island's shore bake; our world has
// no end, so the sites are the cells of a world-anchored grid round the camera (a cell keeps its seeds wherever the
// camera goes), and each cell's quad decides on the GPU whether it stands in the surf: sea water 0.22 to 4.2 m deep,
// 1 to 52 m from the line, where the shore table knows the direction to the shore. Others are moved out of sight.
import * as THREE from 'three';
import { NOISE_GLSL } from '../noise.js';
import { SHORE } from '../shorefield.js';
import { SWASH_GLSL } from './swash.js';

export const SURF_FOAM = {
  billows: { n: 80, cell: 1.6, per: 4 }, // the pool; the panel's foam amount draws a share of it // a grid n x n of cells this size round the camera, this many billows a cell
  streaks: { n: 64, cell: 2.0, per: 1 },
};

function pool(n, per) {
  const base = new THREE.PlaneGeometry(1, 1), g = new THREE.InstancedBufferGeometry();
  g.setIndex(base.index); g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
  g.instanceCount = n * n * per;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

export class SurfFoam {
  // world: the World (clipmap, shore table, wave field, the water's uniforms); surface: the WaterSurface
  constructor(world, surface) {
    const shore = world.shore, field = world.waves;
    const U = this.U = {
      ...world.clip.uniforms, ...shore.uniforms,
      uSurf: world.uSurf, uSurfX: world.uSurfX, uWTime: world.uWTime, uSwDir: world.uSwDir,
      uCam: surface.U.uCam, uSeaLevel: surface.U.uSeaLevel, uWL: surface.U.uWL,
      tWD1: { value: field.disp[1].texture }, tWD2: { value: field.disp[2].texture },
      tFoam: surface.U.tFoam, uLook3: world.uLook3, uSun: world.sky.uniforms.uSun, uSunColor: world.sky.uniforms.uSunColor, uSkyUp: surface.U.uSkyUp,
    };
    const head = /* glsl */ `precision highp float; precision highp int;
#include <common>
#include <logdepthbuf_pars_vertex>
${NOISE_GLSL}
${world.clip.glsl()}
${shore.glsl()}
${SWASH_GLSL}
uniform vec3 uCam; uniform float uSeaLevel; uniform vec4 uWL, uLook3; uniform sampler2D tWD1, tWD2; // uLook3: (caustics, foam size, foam amount, -)
// the cell this instance stands in (world-anchored round the camera) and its seeds
vec2 foamAnchor(int n, float cell, int per, out vec4 seed) {
  int id = gl_InstanceID / per, sub = gl_InstanceID - id * per;
  ivec2 c = ivec2(floor(uCam.xz / cell)) - n / 2 + ivec2(id % n, id / n);
  int s = 801 + sub * 17;
  seed = vec4(w2hash01(c.x, c.y, s), w2hash01(c.x, c.y, s + 1), w2hash01(c.x, c.y, s + 2), w2hash01(c.x, c.y, s + 3));
  return (vec2(c) + vec2(w2hash01(c.x, c.y, s + 4), w2hash01(c.x, c.y, s + 5))) * cell;
}
// the breaker over an anchor and the life of its foam (the pack's foamState, on our coast's clock)
struct FoamState { bool ok; vec2 dir, center; float level, age, life, breaking, backAge, bed, speed, strand, waveHeight, hitT, swashS; };
FoamState foamState(vec2 anchor, vec4 seed) {
  FoamState o; o.ok = false;
  o.level = clipWater(anchor);
  if (o.level > uSeaLevel + 0.5 || uSurf.x <= 0.0) return o;
  float depth = o.level - clipHeight(anchor);
  if (depth < 0.22 || depth > 4.2 || !sw3Ctx(anchor)) return o;
  float sdf = -gShoreD; // metres from the line
  if (sdf < 1.0 || sdf > 52.0 || dot(gDir, gDir) < 0.25) return o;
  o.dir = gDir;
  float env = gNear * gExpo * smoothstep(-0.9, 0.5, depth);
  float shoal = pow(clamp(max(depth, 0.6) / ${SHORE.dMax.toFixed(1)}, 0.04, 1.0), -0.25);
  float a0 = uSurf.x * env * shoal * sw3Group(anchor, uWTime), a = min(a0, 0.42 * depth + 0.02);
  float w = sw3Omega(0), ph = sw3Phase(0, uWTime, gTau, gPn);
  float cyc = floor((ph + 3.14159265) / 6.2831853);
  float early = 0.5 + 0.5 * w2noise(anchor / 33.0 + vec2(cyc * 7.3, cyc * 3.1), 614);
  float energy = smoothstep(0.03, 0.2, a0); // as the surface's: by the wave's own height (swash.js)
  o.breaking = smoothstep(0.12 + 0.14 * early, 0.3 + 0.2 * early, a0 / max(depth, 0.05)) * energy;
  float psi = mod(ph + 3.14159265, 6.2831853) - 3.14159265;
  float c = 0.5 + 0.5 * cos(ph), cp = pow(max(c, 0.0), 0.6);
  float collapse = o.breaking * smoothstep(-0.75, -0.12, psi) * (1.0 - smoothstep(0.05, 0.7, psi));
  o.waveHeight = a * (1.0 - 0.48 * collapse) * (2.0 * cp * c - 0.78);
  float period = 6.2831853 / w;
  float generation = step(0.7, seed.y); // seven in ten from this breaker, the rest left by the one before
  o.age = mod(ph, 6.2831853) / w + generation * period + seed.x * 0.22;
  // a piece lives until the next bore has come (and the older generation one wave more): the foam the swash carries up
  // the sand comes back down with it and is still there when the next one arrives, round and round
  o.life = period * (1.0 + generation) + 0.4;
  o.speed = sqrt(9.81 * clamp(depth, 0.3, 14.0)) * (1.04 + 0.2 * o.breaking);
  o.hitT = clamp((sdf + 1.0) / o.speed, 0.25, 3.0);
  o.backAge = max(o.age - o.hitT, 0.0);
  o.strand = 0.0;
  vec2 tangent = vec2(-o.dir.y, o.dir.x);
  vec2 jitter = tangent * (seed.w - 0.5) * 5.0 + o.dir * (seed.z - 0.5) * 2.0;
  // in with the bore at its speed until it meets the swash; from there it rides the swash's sheet: up the sand as the
  // shoreline climbs, back down to the line as it drains (water3/swash.js sw3Shore at the line in front of it), each
  // piece at its own share of the sheet's width
  vec2 lp = anchor + o.dir * sdf; vec3 ln = clipNormal(lp); vec2 lg = -ln.xz / max(ln.y, 0.05); float tb = max(length(lg), 0.012);
  sw3Beach(lp, lg); float ss, zeta = sw3Shore(lp, tb, uWTime, ss);
  o.swashS = ss;
  float onSheet = sdf + min((0.3 + 0.7 * seed.w) * zeta / tb, 40.0);
  float travel = min(o.speed * o.age, onSheet);
  o.center = anchor + jitter + o.dir * travel + tangent * sin(seed.x * 17.0 + o.backAge * 1.7) * min(o.backAge, 3.0) * 0.12;
  o.bed = clipHeight(o.center) - o.level; // over the still water: > 0 on the sand
  o.ok = true;
  return o;
}
// the water's height under a point, coarse (the cascades the foam rides, at a blurred mip)
float foamWaterY(vec2 xz, float level, float bed) {
  float depth = -bed, h = textureLod(tWD1, xz / uWL.y, 3.0).y * smoothstep(0.6, 5.0, depth) + textureLod(tWD2, xz / uWL.z, 3.0).y * smoothstep(0.2, 2.0, depth);
  return level + max(h, bed + 0.04);
}
// a piece is drawn when its breaker breaks hard enough for its seed, and when it falls in the panel's share of the pool
float foamPop(FoamState o, vec4 seed) { float th = seed.z * 0.45; return smoothstep(th, th + 0.2, o.breaking) * uSurfX.x * step(fract(seed.y * 7.13 + seed.w * 3.71), uLook3.z); }
`;
    const B = SURF_FOAM.billows, S = SURF_FOAM.streaks;
    const billowVert = /* glsl */ `${head}
out vec2 vUv; out float vAlpha, vSand, vSeed, vPlunge, vGrounded;
void main() {
  vec4 seed; vec2 anchor = foamAnchor(${B.n}, ${B.cell.toFixed(2)}, ${B.per}, seed);
  FoamState o = foamState(anchor, seed);
  vUv = uv; vAlpha = 0.0; vSand = 0.0; vSeed = seed.x * 17.0 + seed.w * 9.0; vPlunge = 0.0; vGrounded = 0.0;
  if (!o.ok || o.age >= o.life) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float fade = smoothstep(0.0, 0.13, o.age) * (1.0 - smoothstep(o.life * 0.8, o.life, o.age)) * mix(1.0, 0.45, smoothstep(1.0, 6.0, o.age)); // eroding as it ages
  float crash = exp(-o.age * 1.5) * o.breaking;
  float dry = 1.0 - smoothstep(0.75, 1.3, o.bed);
  vAlpha = foamPop(o, seed) * fade * dry * (0.48 + 0.72 * o.breaking);
  vSand = clamp(smoothstep(0.0, 0.8, o.backAge) * (0.25 + 0.65 * o.breaking) * smoothstep(-1.8, 0.35, o.bed), 0.0, 0.85);
  vPlunge = crash;
  // small puffs, a wasp's scale: 10 to 60 cm, a little bigger in the crash
  float size = (0.1 + 0.26 * o.breaking) * mix(0.7, 1.7, seed.w) * (1.0 + 0.1 * o.age) * uLook3.y;
  size *= mix(1.0, 0.65, smoothstep(1.0, 4.0, o.age)) * (1.0 + 0.6 * crash);
  float waterY = foamWaterY(o.center, o.level, o.bed) + o.waveHeight * (1.0 - smoothstep(0.5, 3.0, o.age));
  vec3 C = vec3(o.center.x, o.bed > 0.0 ? o.level + o.bed + 0.045 : waterY + 0.065, o.center.y);
  C.y += crash * (0.1 + 0.35 * seed.y);                                      // thrown up where it crashes
  C.y += exp(-o.backAge * 2.0) * smoothstep(0.0, 0.3, o.backAge) * 0.12;    // the bore's surge onto the sand
  // a puff faces the camera while it flies; grounded, it lies on the water or the sand, drawn out along the shore
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float g = smoothstep(0.0, 0.55, o.backAge); vGrounded = g;
  vec3 right = normalize(mix(camR, vec3(-o.dir.y, 0.0, o.dir.x), g)), up = normalize(mix(camU, vec3(o.dir.x, 0.0, o.dir.y), g));
  float stretch = mix(mix(1.25, 0.82, smoothstep(0.05, 1.3, o.age)), 1.4, g);
  vAlpha *= mix(1.0, 0.42, g);
  if (vAlpha <= 0.001) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  vec3 P = C + right * position.x * size + up * position.y * size * stretch;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
  #include <logdepthbuf_vertex>
}`;
    const lightGLSL = /* glsl */ `uniform vec3 uSun, uSunColor, uSkyUp; uniform sampler2D tFoam;
vec3 foamLight() { return uSkyUp * 0.8 + uSunColor * max(uSun.y, 0.0) * 0.5; }`;
    const billowFrag = /* glsl */ `precision highp float; precision highp int;
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
${lightGLSL}
in vec2 vUv; in float vAlpha, vSand, vSeed, vPlunge, vGrounded; out vec4 oColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = (vUv - 0.5) * 2.0; float radial = max(0.0, 1.0 - dot(p, p));
  // the puff's texture: cauliflower lumps at two scales
  vec4 ft = texture(tFoam, vUv * 0.92 + vec2(vSeed, vSeed * 0.371)); float t = ft.r; // the baked lace; ft.g its billow height
  float a = min(0.88, vAlpha * radial * radial * (0.45 + 1.25 * t));
  if (a < 0.008) discard;
  vec3 white = mix(vec3(0.9, 0.96, 0.95), vec3(1.15, 1.13, 1.06), clamp(vPlunge * 2.0, 0.0, 1.0));
  vec3 col = mix(white, vec3(0.58, 0.405, 0.22), vSand * vGrounded * (0.25 + 0.55 * t)) * foamLight() * (0.78 + 0.3 * ft.g); // the billow's lumps lit a little
  oColor = vec4(col * a, a);
}`;
    const streakVert = /* glsl */ `${head}
out vec2 vUv; out float vAlpha, vSand, vSeed;
void main() {
  vec4 seed; vec2 anchor = foamAnchor(${S.n}, ${S.cell.toFixed(2)}, ${S.per}, seed);
  FoamState o = foamState(anchor, seed);
  vUv = uv; vAlpha = 0.0; vSand = 0.0; vSeed = seed.x * 19.0 + seed.z * 7.0;
  float age = o.backAge, life = o.life - o.hitT;
  if (!o.ok || age <= 0.0 || age >= life) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float fade = smoothstep(0.0, 0.18, age) * (1.0 - smoothstep(life * 0.42, life, age));
  vAlpha = foamPop(o, seed) * fade * (0.22 + 0.58 * o.breaking) * (1.0 - smoothstep(0.9, 1.5, o.bed));
  vSand = clamp((0.3 + 0.6 * o.breaking) * exp(-age * 0.16) * smoothstep(-2.2, 0.3, o.bed), 0.0, 0.9);
  if (vAlpha <= 0.001) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  vec2 tangent = vec2(-o.dir.y, o.dir.x);
  vec2 jitter = tangent * (seed.w - 0.5) * 5.0 + o.dir * (seed.z - 0.5) * 2.0;
  vec2 ctr = o.center; // on the swash's sheet with the billows: up with it, back down with it
  float len = min(2.0, (0.25 + 1.1 * o.breaking) * (0.35 + age * 0.55)) * uLook3.y, wid = (0.03 + 0.08 * o.breaking) * mix(0.6, 1.5, seed.z) * uLook3.y;
  vec2 xz = ctr - o.dir * position.y * len + tangent * position.x * wid;
  float bed = clipHeight(xz) - o.level;
  float y = bed > 0.0 ? o.level + bed + 0.04 : foamWaterY(xz, o.level, bed) + 0.04;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, y, xz.y, 1.0);
  #include <logdepthbuf_vertex>
}`;
    const streakFrag = /* glsl */ `precision highp float; precision highp int;
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
${lightGLSL}
in vec2 vUv; in float vAlpha, vSand, vSeed; out vec4 oColor;
void main() {
  #include <logdepthbuf_fragment>
  float sides = smoothstep(0.5, 0.08, abs(vUv.x - 0.5)), ends = smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.72, vUv.y);
  vec2 fuv = vec2(vUv.x * 0.22 + vSeed, vUv.y * 0.045 - vSeed * 0.31);
  float lace = texture(tFoam, fuv).r * 0.7 + texture(tFoam, fuv * vec2(2.3, 1.7) + 0.31).r * 0.3;
  float a = vAlpha * sides * ends * smoothstep(0.22, 0.76, lace + sides * 0.3);
  if (a < 0.006) discard;
  vec3 col = mix(vec3(0.88, 0.95, 0.93), vec3(0.56, 0.39, 0.2), vSand * (0.4 + 0.6 * lace)) * foamLight() * 0.9;
  oColor = vec4(col * a, a);
}`;
    const common = {
      glslVersion: THREE.GLSL3, uniforms: U, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    };
    this.billows = new THREE.Mesh(pool(B.n, B.per), new THREE.ShaderMaterial({ ...common, vertexShader: billowVert, fragmentShader: billowFrag }));
    this.streaks = new THREE.Mesh(pool(S.n, S.per), new THREE.ShaderMaterial({ ...common, vertexShader: streakVert, fragmentShader: streakFrag, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    for (const m of [this.billows, this.streaks]) m.frustumCulled = false;
    this.streaks.renderOrder = 3; this.billows.renderOrder = 4;
    this.stats = { billows: B.n * B.n * B.per, streaks: S.n * S.n * S.per };
  }
  dispose() { for (const m of [this.billows, this.streaks]) { m.geometry.dispose(); m.material.dispose(); } }
}
