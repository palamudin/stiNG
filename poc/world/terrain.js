// The ground as one draw call: every clipmap level is an instance of the same 64 x 64 grid, lifted in the vertex
// shader from the clipmap (clipmap.js), morphing into its parent near its edge, sunk out of sight where a finer
// level covers it. Shading is per pixel from the clipmap itself (normal, moisture, forest, trail), so a coarse
// level far away lights like the fine one it stands for.
//
// The look: a naive palette (grass by moisture, dry tops, forest floor, dirt trails, sand at the water, stone on
// steep ground cut into soft blocks, snow on the peaks), lit by three.js's standard PBR lights so it takes the sun's
// shadow map like everything else, plus:
//   - a heightfield sun shadow marched through the clipmap for ground beyond the shadow map (hills shade valleys at
//     km scale);
//   - far forests drawn into the ground as a lumpy canopy past the trees' draw distance;
//   - a little close-range detail (stone cells, soil speckle) that fades with distance;
//   - the shore (W2): the swash runs up and down the beach with the waves, a thin film of water with a line of foam at
//     its edge, to a run-up limit from the sea state and the beach's own slope (Stockdon et al. 2006, the height the top
//     2% of run-ups reach); the sand is wet up to that limit and damp a little above it (capillary rise in the sand; the
//     4 cm is our estimate), darker because water fills the pores, and glossy under the film. A small lake's waves run
//     up a few centimetres, so its wet band is narrow.
import * as THREE from 'three';
import { clipGrid } from './clipmap.js';
import { NOISE_GLSL } from './noise.js';
import { WEAR_GLSL } from './grass.js';
import { CLOUD_SHADOW_GLSL } from './clouds.js';

export const TERRAIN_SHADE_GLSL = /* glsl */ `
// the palette: sRGB picks, made linear by L()
#define L(r, g, b) pow(vec3(r, g, b), vec3(2.2))
const vec3 T_GRASS_WET = L(0.32, 0.56, 0.16);
const vec3 T_GRASS = L(0.45, 0.66, 0.22);
const vec3 T_GRASS_DRY = L(0.66, 0.66, 0.34);
const vec3 T_FLOOR = L(0.30, 0.33, 0.17);
const vec3 T_DIRT = L(0.55, 0.42, 0.28);
const vec3 T_SAND = L(0.86, 0.78, 0.56);
const vec3 T_MUD = L(0.42, 0.37, 0.27);
const vec3 T_ROCK = L(0.52, 0.50, 0.47);
const vec3 T_ROCK2 = L(0.40, 0.38, 0.36);
const vec3 T_SNOW = L(0.95, 0.96, 0.98);
const vec3 T_CANOPY = L(0.17, 0.32, 0.10);
const vec3 T_ASPHALT = L(0.29, 0.29, 0.30);
const vec3 T_WALK = L(0.66, 0.64, 0.60);
const vec3 T_THATCH = L(0.30, 0.44, 0.13); // under the blades of a lawn: more blades, in their own shade
const vec3 T_EARTH = L(0.47, 0.40, 0.31);  // trodden earth, dry and packed
`;

const ZERO = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType); ZERO.needsUpdate = true;

export function makeTerrain(clip, opts = {}) {
  const C = clip.cfg, g = clipGrid(C.cells);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(g.pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(new THREE.BufferAttribute(g.idx, 1));
  const lv = new Float32Array(C.levels); for (let l = 0; l < C.levels; l++) lv[l] = l;
  geo.setAttribute('aLevel', new THREE.InstancedBufferAttribute(lv, 1));
  geo.instanceCount = C.levels;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const U = {
    ...clip.uniforms,
    uSea: { value: opts.sea ?? 0 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
    uShadowFar: { value: 30 },     // where the shadow map gives way to the heightfield shadow
    uTreeFar: { value: 400 },      // where instanced trees end and the canopy is painted into the ground
    uPaving: { value: opts.paving ? 1 : 0 },
    uTime: { value: 0 },
    uWet: { value: 0 },
    uShore: { value: opts.shore ?? 1 },       // 1: the source has water, so beaches and mud
    uSnowLine: { value: opts.snowLine ?? 215 }, // metres above the water where snow starts
    uGrassR: { value: 0 },  // how far the grass blades reach round the camera (grass.js); the lawn's thatch lies under them
    tCloudShadow: { value: null }, uCloudRect: { value: new THREE.Vector4(0, 0, 1, 0) }, // the clouds' shadow map round the camera (clouds.js)
    uGrassTint: { value: new THREE.Vector3(1, 1, 1) }, uSnowOn: { value: 0 }, // the season's grass colour and snow (seasons.js)
    // the waves at the shore (World._water fills these from the wave field): the first two cascades' displacement, their
    // tile sizes, and the sea state for the run-up: (H0 L0, Hs) with H0 the significant height, L0 the deep-water
    // wavelength of the peak period
    tWave0: { value: ZERO }, tWave1: { value: ZERO }, uWaveL: { value: new THREE.Vector2(1, 1) }, uRun: { value: new THREE.Vector2(0, 0) },
  };
  const CLIP = clip.glsl() + CLOUD_SHADOW_GLSL;
  const VERT_HEAD = `${CLIP}\nattribute float aLevel;\nvarying vec3 vW;\n`;
  const VERT_BODY = /* glsl */ `
  int lvl = int(aLevel);
  vec4 LV = uClipLv[lvl];
  vec2 pp = LV.xy + position.xz * LV.z;
  float hh = clipSurface(lvl, pp).x;
  if (lvl > 0) { vec4 F = uClipLv[lvl - 1]; vec2 q = abs(pp - F.xy); if (max(q.x, q.y) <= F.w - 2.0 * LV.z) hh -= 30.0 * LV.w; }
  vec3 transformed = vec3(pp.x, hh, pp.y);
  vW = transformed;
`;

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = VERT_HEAD + sh.vertexShader.replace('#include <begin_vertex>', VERT_BODY);
    sh.fragmentShader = `${CLIP}\n${NOISE_GLSL}\n${WEAR_GLSL}\n${TERRAIN_SHADE_GLSL}
uniform float uSea, uShadowFar, uTreeFar, uPaving, uTime, uWet, uShore, uSnowLine, uGrassR, uSnowOn; uniform vec3 uSunDir, uGrassTint;
uniform sampler2D tWave0, tWave1; uniform vec2 uWaveL, uRun;
varying vec3 vW;
float hfShadow(vec2 p, float h0, float dist) {
  // march toward the sun through the clipmap; soft by the closest miss (Quilez's penumbra trick)
  int l0 = clipFinest(p); float t = 2.0 * uClipLv[l0].z + 0.02 * dist; float res = 1.0;
  for (int i = 0; i < 18; i++) {
    vec3 q = vec3(p.x, h0, p.y) + uSunDir * t;
    float th = clipHeight(q.xz);
    res = min(res, 10.0 * (q.y - th) / t);
    if (res < 0.0) break;
    t *= 1.45;
  }
  return clamp(res, 0.0, 1.0);
}
` + sh.fragmentShader
      .replace('#include <color_fragment>', /* glsl */ `
  vec2 P = vW.xz;
  int TL = clipFinest(P);
  vec4 TD = clipSurface(TL, P);
  vec3 TN = clipNormal(P);
  float dist = length(cameraPosition - vW);
  float fp = length(fwidth(P)) + 1e-4; // metres of ground under this pixel
  #define NF(S) (1.0 - smoothstep(0.2 * (S), 0.55 * (S), fp))
  float near = 1.0 - smoothstep(6.0, 60.0, dist);
  float slope = 1.0 - TN.y;
  float TW = clipWater(P);      // the water level here: the sea, or a lake's own (W3)
  float hgt = TD.x - TW;        // height above the water line, for the shore
  float alt = TD.x - uSea;      // height above the sea, for the snow
  // grass by moisture, broken up in patches
  float pa = w2noise(P / 9.0, 71) * 0.5 * NF(9.0) + w2noise(P / 2.1, 72) * 0.25 * NF(2.1);
  vec3 col = mix(T_GRASS_DRY, T_GRASS, smoothstep(0.1, 0.42, TD.y + pa * 0.25));
  col = mix(col, T_GRASS_WET, smoothstep(0.65, 0.95, TD.y + pa * 0.15));
  col *= uGrassTint;
  col *= 1.0 + 0.2 * w2noise(P / 0.7, 73) * NF(0.7);
  // under the blades near the camera the lawn's ground is its own dark thatch, so gaps read as more grass
  float under = (1.0 - smoothstep(uGrassR * 0.5, uGrassR, dist)) * step(0.01, uGrassR);
  col = mix(col, T_THATCH * (0.85 + 0.3 * w2noise(P / 0.5, 82) * NF(0.5)), under);
  // forest floor under the trees
  col = mix(col, T_FLOOR, smoothstep(0.35, 0.75, TD.z));
  // a pond's bed and its muddy margin (moisture past 1, sources/sting.js): the water is drawn over it (post.js)
  col = mix(col, T_MUD * (0.75 + 0.2 * w2noise(P / 0.6, 83) * NF(0.6)), smoothstep(0.98, 1.06, TD.y));
  // trodden ground: earth in the patches where the grass is gone (the same patches as grass.js); far off, their share
  float wr = w2wear(TD.w), br = mix(wr * 0.6, w2bare(P, wr), NF(0.6));
  col = mix(col, T_EARTH * (0.9 + 0.2 * w2noise(P / 0.4, 81) * NF(0.4)), br);
  // far forest: the canopy painted in where the trees end
  float canopy = smoothstep(0.3, 0.6, TD.z) * smoothstep(uTreeFar * 0.45, uTreeFar, dist);
  float bump = w2noise(P / 7.0, 74) * 0.6 * NF(7.0) + w2noise(P / 3.0, 75) * 0.4 * NF(3.0);
  col = mix(col, T_CANOPY * (0.8 + 0.45 * bump), canopy);
  // trails (or paving in the game's world)
  vec3 trailCol = uPaving > 0.5 ? mix(T_WALK, T_ASPHALT, smoothstep(0.75, 0.95, TD.w)) : T_DIRT * (0.95 + 0.25 * w2noise(P / 0.5, 76) * NF(0.5));
  if (uPaving > 0.5) { // the game's paving, drawn from world coordinates: asphalt grain and mended patches; sidewalk slabs;
    // a town square's pavers (fourth channel 1, 0.5, 0.9)
    float asph = smoothstep(0.75, 0.95, TD.w), square = 1.0 - smoothstep(0.02, 0.06, abs(TD.w - 0.9));
    vec2 sq = P / 1.5, sj = abs(fract(sq) - 0.5), pq = P / 0.4, pj = abs(fract(pq) - 0.5);
    float slab = (0.93 + 0.1 * w2hash01(int(floor(sq.x)), int(floor(sq.y)), 84)) * (1.0 - 0.3 * smoothstep(0.47, 0.495, max(sj.x, sj.y)) * NF(0.1));
    float paver = (0.86 + 0.24 * w2hash01(int(floor(pq.x)), int(floor(pq.y)), 85)) * (1.0 - 0.35 * smoothstep(0.44, 0.49, max(pj.x, pj.y)) * NF(0.05));
    float tar = (0.92 + 0.16 * w2noise(P * 9.0, 86) * NF(0.11)) * (0.9 + 0.12 * w2noise(P * 0.35, 87)) * (1.0 - 0.12 * step(0.44, w2noise(P * 0.13, 88)));
    trailCol *= mix(mix(slab, mix(1.0, paver, NF(0.4)), square), tar, asph * (1.0 - square));
  }
  // a trail is about 1.5 m wide: once a pixel covers much more, it is a fraction of the pixel, not a dash
  col = mix(col, trailCol, smoothstep(0.25, 0.6, TD.w) * (uPaving > 0.5 ? 1.0 : 1.0 - smoothstep(0.8, 3.0, fp)));
  // the shore: sand above the water, mud under it
  float shore = uShore * (1.0 - smoothstep(0.6, 1.6 + 0.5 * pa, hgt));
  col = mix(col, T_SAND * (0.97 + 0.12 * w2noise(P / 0.9, 77) * NF(0.9)), shore * (1.0 - smoothstep(0.35, 0.6, slope)));
  col = mix(col, T_MUD, uShore * (1.0 - smoothstep(-0.3, -0.03, hgt)));
  // the swash: run-up limit R2 on this slope (Stockdon et al. 2006); the edge now follows the incident waves at this
  // stretch of shore, so it runs up when a crest arrives and drains back after it
  float film = 0.0, wetB = 0.0, damp = 0.0, fl = 0.0;
  if (uShore > 0.5 && uRun.x > 1e-5 && hgt > -0.1 && hgt < 0.6) {
    float tb = sqrt(max(1.0 - TN.y * TN.y, 0.0)) / max(TN.y, 0.05), HL = uRun.x;
    float R2 = 1.1 * (0.35 * tb * sqrt(HL) + 0.5 * sqrt(HL * (0.563 * tb * tb + 0.004)));
    // the incident waves where this cross-shore line meets the water (straight downhill by hgt / slope), so the edge
    // runs along the shore as one line
    vec2 Ps = P + (length(TN.xz) > 1e-4 ? normalize(TN.xz) : vec2(0.0)) * clamp(hgt / max(tb, 0.01), 0.0, 20.0);
    float hw = texture(tWave0, Ps / uWaveL.x).y + texture(tWave1, Ps / uWaveL.y).y;
    float sEdge = R2 * clamp(0.45 + 0.55 * hw / max(0.5 * uRun.y, 1e-4), 0.0, 1.0);
    float aa = max(fwidth(hgt), 0.002), above = smoothstep(-0.05, 0.0, hgt);
    film = (1.0 - smoothstep(sEdge - aa, sEdge + aa, hgt)) * smoothstep(-0.03, 0.0, hgt);
    wetB = (1.0 - smoothstep(R2, R2 + aa, hgt)) * above;
    damp = (1.0 - smoothstep(R2, R2 + 0.04 + aa, hgt)) * (1.0 - wetB) * above;
    col *= (1.0 - 0.4 * wetB) * (1.0 - 0.2 * damp) * (1.0 - 0.15 * film); // wet sand: water in the pores roughly halves what the grains send back
    // foam at the swash's leading edge, broken into bubbles
    fl = (1.0 - smoothstep(0.0, aa * 2.0 + 0.003, abs(hgt - sEdge))) * film * step(0.004, sEdge) * smoothstep(-0.1, 0.5, w2noise(P / 0.07 + uTime * 0.3, 214) * NF(0.07) + 0.2);
    col = mix(col, vec3(0.75), fl * 0.8);
  }
  // stone on steep ground, in soft blocks
  vec2 bc = floor(P / 0.75);
  float block = w2hash01(int(bc.x), int(bc.y), 78);
  vec3 rock = mix(mix(T_ROCK2, T_ROCK, 0.5), mix(T_ROCK2, T_ROCK, block), NF(0.75)) * (0.97 + 0.15 * w2noise(P / 3.5, 79) * NF(3.5));
  float rk = smoothstep(0.32, 0.5, slope + 0.08 * pa) * (1.0 - smoothstep(0.85, 1.0, TD.w));
  col = mix(col, rock, rk);
  // snow on the peaks, not on cliffs
  float snow = smoothstep(uSnowLine - 10.0, uSnowLine + 20.0, alt + 25.0 * pa) * (1.0 - smoothstep(0.45, 0.65, slope));
  col = mix(col, T_SNOW, snow);
  col *= 1.0 - 0.35 * uWet * (1.0 - snow);
  diffuseColor.rgb = col;
  float TROUGH = mix(mix(mix(0.95, 0.75, rk) * (1.0 - 0.5 * uWet), 0.45, wetB), 0.16, film * (1.0 - fl)); // the film is rippled and bubbly, not a mirror
`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = TROUGH;')
      .replace('#include <normal_fragment_begin>', /* glsl */ `#include <normal_fragment_begin>
  vec3 TNd = TN;
  float cell = smoothstep(0.32, 0.5, slope);
  if (near > 0.0) { // close detail: lumps on stone, soil speckle elsewhere
    vec3 dn = w2noised(P / mix(0.6, 0.4, cell), 80) * NF(0.5);
    TNd = normalize(TN + vec3(-dn.y, 0.0, -dn.z) * mix(0.05, 0.22, cell) * near);
  }
  if (canopy > 0.0) { vec3 cn = w2noised(P / 7.0, 74) * NF(7.0); TNd = normalize(mix(TNd, normalize(vec3(-cn.y * 1.2, 1.0, -cn.z * 1.2)), canopy)); }
  normal = normalize((viewMatrix * vec4(TNd, 0.0)).xyz);
`)
      .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
  float hs = 1.0;
  if (dist > uShadowFar * 0.6) hs = mix(1.0, hfShadow(P, TD.x + 0.05 + 0.0005 * dist, dist), smoothstep(uShadowFar * 0.6, uShadowFar, dist));
  hs *= cloudShadow(P);
  reflectedLight.directDiffuse *= hs; reflectedLight.directSpecular *= hs;
  reflectedLight.indirectDiffuse *= mix(1.0, 0.7, canopy);
`);
  };
  mat.customProgramCacheKey = () => 'w2terrain' + C.levels; // the clipmap's level count is in the code

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = VERT_HEAD + sh.vertexShader.replace('#include <begin_vertex>', VERT_BODY);
  };
  depth.customProgramCacheKey = () => 'w2terrain-depth' + C.levels;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.customDepthMaterial = depth;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'world2-terrain';
  return { mesh, uniforms: U, material: mat };
}
