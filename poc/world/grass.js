// Grass and wild flowers round the camera, placed entirely on the GPU. Each instance is a grid cell round the
// camera, snapped to the cell size so nothing swims; the vertex shader jitters it by a hash, reads the ground as drawn
// (clipmap: height, moisture, forest, trail), decides from those whether anything grows there (not on stone, sand,
// water, trails, paving or under a dense canopy), and builds the clump: blades that taper, curve, lean and bend with
// the wind (a gust field that travels across the ground). No CPU work per blade.
//
// Five rings: thousands of blades a square metre round the camera (a lawn is green because it is solid grass), fewer
// and broader further out, each thinning over the band where the next thickens, clumps growing in rather than popping; the ground under them is the lawn's own dark thatch (terrain.js),
// so a gap between blades reads as more grass, not as painted ground. When the camera rises the rings grow with its
// height above the ground in whole steps (x1, x2, x4, x8), so every clump stays where it grew while the camera moves;
// between two steps the coarser rings dissolve in over the last part of the range and the finer ones out, clump by
// clump, nothing sliding. Past a few tens of metres the grass gives way to the ground's colour.
// At a wasp's height a blade is a wall; from a person's height it is a lawn.
//
// Wear (the fourth channel below 0.3, sources/sting.js): where people sit, stand and walk the lawn is shorter and the
// earth shows through in patches that open as the wear grows (w2bare, shared with the ground's shading, so the bare
// earth is where the blades are missing). In woods the grass grows long and thin.
import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

export const GRASS = {
  // Five rings, each about 1.7 times the last, overlapping by half: a ring thins out over the outer half of its radius
  // while the next thickens over the same band, so the density changes gently with distance and never in a step.
  // A blade's height belongs to its place (the same blade is as tall from 2 m as from 20 m); only its width grows with
  // distance, as a pixel covers more ground (bladeW), so far blades cover like near ones without changing the lawn.
  rings: [
    { spacing: 0.045, radius: 2.5, blades: 6, segs: 3 },
    { spacing: 0.065, radius: 5, blades: 5, segs: 3 },
    { spacing: 0.1, radius: 9, blades: 5, segs: 2 },
    { spacing: 0.16, radius: 15, blades: 5, segs: 2 },
    { spacing: 0.26, radius: 26, blades: 4, segs: 2 },
  ],
  bladeW: { root: 0.0065, from: 1.5, power: 0.7 }, // width = root * max(1, distance / from) ^ power
  band: 0.5,  // a ring thins over the outer (1 - band) of its radius; the next thickens over the same metres
  growIn: 0.25, // a clump grows in (and shrinks out) over this share of the density, never popping
  flowers: { spacing: 0.55, radius: 18 },
  // the share of the next scale step's clumps in, over the last 30% of a step (log2 of the scale)
  dissolve: (t) => { const k = Math.min(1, Math.max(0, (t - 0.7) / 0.3)); return k * k * (3 - 2 * k); },
};
// The ground's wear, read the same way by the grass and the ground under it
export const WEAR_GLSL = /* glsl */ `
float w2wear(float w) { return w < 0.3 ? clamp(w / 0.2, 0.0, 1.0) : 0.0; } // 0 untouched .. 1 trodden
float w2bare(vec2 p, float wear) { // bare earth in patches that open as the wear grows
  // ragged at every scale: trodden ground breaks up into tufts and bald spots, never a clean-edged decal
  float n = 0.5 + 0.28 * w2noise(p / 1.1, 207) + 0.16 * w2noise(p / 0.3, 208) + 0.12 * w2noise(p / 0.09, 209);
  return smoothstep(n - 0.05, n + 0.05, wear * 0.92);
}
`;

function clumpGeometry(blades, segs, seed) {
  // per vertex: aT (0 root .. 1 tip), aSide (-1, 1), aB (angle, offset x, offset z, random)
  const n = blades * (segs + 1) * 2, T = new Float32Array(n), S = new Float32Array(n), B = new Float32Array(n * 4), P = new Float32Array(n * 3), idx = [];
  let v = 0;
  const r = (i) => { const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return x - Math.floor(x); };
  for (let b = 0; b < blades; b++) {
    const ang = r(b * 3 + 1) * 6.283, ox = (r(b * 3 + 2) - 0.5), oz = (r(b * 3 + 3) - 0.5), rnd = r(b * 7 + 9);
    const v0 = v;
    for (let s = 0; s <= segs; s++) for (const side of [-1, 1]) { T[v] = s / segs; S[v] = side; B.set([ang, ox, oz, rnd], v * 4); v++; }
    for (let s = 0; s < segs; s++) { const a = v0 + s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('aT', new THREE.BufferAttribute(T, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(S, 1));
  g.setAttribute('aB', new THREE.BufferAttribute(B, 4));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

const GRASS_VERT_HEAD = /* glsl */ `
attribute float aT, aSide; attribute vec4 aB; attribute vec2 aCell;
uniform float uSpacing, uRadius, uInner, uScale, uFade, uTime, uSea, uDensity, uFlower, uAlt, uShore, uSnowLine, uWoodH; uniform vec2 uGrassH; uniform vec2 uWind; uniform vec3 uCamG;
varying float vT, vCol, vRootK; varying vec3 vGW; varying vec3 vTint; varying float vKill;
vec3 gPos; vec3 gNor;
`;
// everything is computed in the normal stage (it comes first in three's vertex shader) and reused for the position
const GRASS_BAND = GRASS.band.toFixed(3), GRASS_GROW = GRASS.growIn.toFixed(3);
const GRASS_W = { root: GRASS.bladeW.root.toFixed(4), from: GRASS.bladeW.from.toFixed(2), power: GRASS.bladeW.power.toFixed(3) };
const GRASS_BUILD = /* glsl */ `
  float sp = uSpacing * uScale;
  vec2 org = floor(uCamG.xz / sp) * sp;
  vec2 cw = org + aCell * sp;
  ivec2 ci = ivec2(floor(cw / sp + 0.5));
  vec2 base = cw + (vec2(w2hash01(ci.x, ci.y, 201), w2hash01(ci.x, ci.y, 202)) - 0.5) * sp;
  float dist = length(base - uCamG.xz);
  float R = uRadius * uScale, Ri = uInner * uScale;
  vec4 gd = clipAt(base); vec3 gn = clipNormal(base);
  float hgt = gd.x - uSea, slope = 1.0 - gn.y;
  // what grows here: meadow full, under trees thin, nothing on stone, sand, water, trails or paving
  float dens = (1.0 - smoothstep(0.32, 0.45, slope)) * mix(1.0, smoothstep(1.3, 2.2, hgt), uShore) * (1.0 - smoothstep(0.3, 0.45, gd.w)) * mix(1.0, 0.35, smoothstep(0.4, 0.8, gd.z));
  dens *= uDensity * (1.0 - smoothstep(uSnowLine - 10.0, uSnowLine + 10.0, hgt));
  float wr = w2wear(gd.w);
  dens *= 1.0 - w2bare(base, wr); // trodden: bare in patches
  if (uFlower > 0.5) dens *= smoothstep(0.1, 0.6, w2noise(base / 9.0, 211) + 0.35 * (gd.y - 0.5)) * (1.0 - smoothstep(0.3, 0.6, gd.z));
  // the share of clumps this ring grows here: it thins over the outer half of its radius as the next ring thickens over
  // the same band (complementary, so the lawn's density is continuous), and between two altitude steps the outgoing
  // step's clumps shrink away as the incoming step's grow (uFade)
  float edge = 1.0 - smoothstep(R * ${GRASS_BAND}, R, dist);
  float inner = uInner > 0.0 ? smoothstep(Ri * ${GRASS_BAND}, Ri, dist) : 1.0;
  float keep = dens * edge * inner * (1.0 - smoothstep(8.0, 30.0, uAlt)) * (uFade >= 0.0 ? 1.0 - uFade : -uFade);
  // each clump has its own threshold: below it the clump is not there, just past it the clump is short, and it reaches
  // its full height a little further on. Moving the camera makes far clumps grow and shrink a little, never pop.
  float grow = clamp((keep * (1.0 + ${GRASS_GROW}) - w2hash01(ci.x, ci.y, 203)) / ${GRASS_GROW}, 0.0, 1.0);
  vKill = grow <= 0.0 ? 1.0 : 0.0;
  float rnd = w2hash01(ci.x, ci.y, 204);
  float H = mix(uGrassH.x, uGrassH.y, gd.y) * (0.55 + 0.9 * aB.w) * (0.75 + 0.5 * rnd) * (uFlower > 0.5 ? 1.3 : 1.0);
  H *= mix(1.0, uWoodH, smoothstep(0.85, 1.0, gd.z)); // long in the woods, where nobody mows
  H *= mix(1.0, 0.45, wr); // short where it is walked on
  H *= grow; // growing in or shrinking out
  float pxd = max(dist, uAlt * 1.5); // how much ground a pixel covers here, roughly
  float W = (uFlower > 0.5 ? 0.006 : ${GRASS_W.root} * pow(max(1.0, pxd / ${GRASS_W.from}), ${GRASS_W.power})) * (0.8 + 0.5 * aB.w);
  // blade frame: it faces its own way and leans away from the clump centre
  float ang = aB.x + rnd * 6.283;
  vec2 fdir = vec2(cos(ang), sin(ang)), side = vec2(-fdir.y, fdir.x);
  vec2 off = aB.yz * sp * (uFlower > 0.5 ? 0.4 : 0.9);
  float t = aT;
  float lean = (0.25 + 0.35 * aB.w) * H;
  // wind: a gust field travelling with the wind, bending blades toward the tip
  float ws = length(uWind); vec2 wd = ws > 0.001 ? uWind / ws : vec2(1.0, 0.0);
  float gust = 0.55 + 0.45 * sin(dot(base, wd) * 0.6 - uTime * 2.2 + w2noise(base / 6.0, 205) * 3.0) + 0.25 * sin(uTime * 4.1 + rnd * 6.283);
  vec2 bend = fdir * lean * t * t + wd * ws * gust * H * 0.55 * t * t;
  float drop = (dot(bend, bend) / max(H, 1e-3)) * 0.45; // a bent blade is shorter
  vec2 xz = base + off + side * aSide * W * (1.0 - t * 0.85) + bend;
  gPos = vec3(xz.x, gd.x + t * H - drop * t, xz.y);
  vec3 tangent = normalize(vec3(bend.x * 2.0 * t + 1e-4, H, bend.y * 2.0 * t + 1e-4));
  gNor = normalize(cross(vec3(side.x, 0.0, side.y), tangent));
  // rounded: toward the sky, more so with distance and height, so far blades shade like the ground they cover
  float roundK = mix(0.45, 0.92, smoothstep(2.0, 18.0, max(dist, uAlt * 2.0)));
  gNor = normalize(mix(gNor * sign(dot(gNor, vec3(fdir.x, 0.0, fdir.y)) + 1e-3), vec3(0.0, 1.0, 0.0), roundK));
  vT = t; vCol = rnd; vGW = gPos;
  // colour: dark at the root, light and drier at the tip, by moisture
  vec3 root = vec3(0.08, 0.17, 0.03), tip = mix(vec3(0.44, 0.42, 0.13), vec3(0.2, 0.45, 0.06), smoothstep(0.25, 0.7, gd.y));
  // a dense lawn hides its roots: up close each blade darkens toward its root, from further off the roots are hidden
  // by the blades in front, so the darkening fades with distance and height
  vRootK = 1.0 - smoothstep(3.0, 16.0, max(dist, uAlt * 2.0));
  vTint = mix(root, tip, mix(1.0, smoothstep(0.0, 0.8, t), vRootK)) * (0.8 + 0.4 * rnd);
  if (uFlower > 0.5 && t > 0.85) {
    float k = floor(w2hash01(int(floor(base.x / 9.0)), int(floor(base.y / 9.0)), 212) * 5.0);
    vTint = k < 1.0 ? vec3(0.9, 0.7, 0.05) : k < 2.0 ? vec3(0.85, 0.85, 0.8) : k < 3.0 ? vec3(0.45, 0.15, 0.6) : k < 4.0 ? vec3(0.8, 0.12, 0.08) : vec3(0.18, 0.3, 0.8);
  }
`;

export class Grass {
  constructor(world, opts = {}) {
    this.world = world;
    this.density = opts.density ?? 1;
    this.group = new THREE.Group(); this.group.name = 'world2-grass';
    const clip = world.clip.glsl();
    this.meshes = [];
    const mk = (spacing, radius, inner, flower, blades, segs) => {
      const geo = clumpGeometry(blades, segs, spacing * 1000);
      const n = Math.ceil(radius / spacing), cells = [];
      for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) { const d = Math.hypot(i, j) * spacing; if (d <= radius && d >= inner * GRASS.band - spacing) cells.push(i, j); }
      geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cells), 2));
      geo.instanceCount = cells.length / 2;
      const U = {
        ...world.clip.uniforms, uTime: world.uniforms.uTime, uSea: { value: world.source.sea }, uShore: world.uniforms.uShore, uSnowLine: world.uniforms.uSnowLine, uSunDir: world.uniforms.uSunDir, uSunColor: world.sky.uniforms.uSunColor,
        uSpacing: { value: spacing }, uRadius: { value: radius }, uInner: { value: inner }, uScale: { value: 1 }, uFade: { value: 0 }, uDensity: { value: this.density }, uFlower: { value: flower ? 1 : 0 },
        uWoodH: { value: world.source.grassWood ?? 1 },
        uWind: { value: new THREE.Vector2(0.8, 0.3) }, uCamG: { value: new THREE.Vector3() }, uAlt: { value: 0 },
        uGrassH: { value: new THREE.Vector2(...(world.source.grassHeight || [0.1, 0.42])) }, // metres, dry to wet ground
      };
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, U);
        sh.vertexShader = `${clip}\n${NOISE_GLSL}\n${WEAR_GLSL}\n${GRASS_VERT_HEAD}\n` + sh.vertexShader
          .replace('#include <beginnormal_vertex>', GRASS_BUILD + '\n  vec3 objectNormal = gNor;')
          .replace('#include <begin_vertex>', 'vec3 transformed = gPos;')
          .replace('#include <project_vertex>', '#include <project_vertex>\n  if (vKill > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);');
        sh.fragmentShader = `uniform vec3 uSunDir, uSunColor; varying float vT, vCol, vRootK; varying vec3 vGW, vTint; varying float vKill;\n` + sh.fragmentShader
          .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = vTint;')
          // both faces of a blade use its rounded normal: three.js flips it on back faces, which points a sky-leaning
          // normal into the ground and turns every blade seen from behind dark
          .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize(vNormal);')
          .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
  { // the sun through the blade, toward the tip, strongest looking into the light; the root sits in its neighbours' shade
    vec3 V = normalize(vGW - cameraPosition);
    float back = pow(clamp(dot(V, uSunDir), 0.0, 1.0), 3.0);
    reflectedLight.directDiffuse += uSunColor * diffuseColor.rgb * back * 0.5 * vT;
    reflectedLight.indirectDiffuse *= mix(1.0, 0.55 + 0.45 * vT, vRootK);
    reflectedLight.directDiffuse *= mix(1.0, 0.7 + 0.3 * vT, vRootK);
  }`);
      };
      mat.customProgramCacheKey = () => 'w2grass' + (flower ? 'f' : '') + world.clip.cfg.levels; // the clipmap's level count is in the code
      // two meshes share the clumps' geometry and program: this step of scale, and the next one while it dissolves in
      for (const next of [false, true]) {
        const Um = next ? { ...U, uScale: { value: 2 }, uFade: { value: 0 }, uCamG: U.uCamG, uAlt: U.uAlt, uWind: U.uWind } : U;
        const m = next ? mat.clone() : mat;
        if (next) { m.onBeforeCompile = (sh) => { mat.onBeforeCompile(sh); Object.assign(sh.uniforms, Um); }; m.customProgramCacheKey = mat.customProgramCacheKey; }
        const mesh = new THREE.Mesh(geo, m);
        mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
        mesh.userData.U = Um; mesh.userData.next = next; mesh.userData.instances = cells.length / 2;
        mesh.visible = !next;
        this.group.add(mesh); this.meshes.push(mesh);
      }
    };
    const d = Math.sqrt(this.density);
    let inner = 0;
    for (const R of GRASS.rings) { mk(R.spacing / d, R.radius, inner, false, R.blades, R.segs); inner = R.radius; }
    if (opts.flowers !== false) mk(GRASS.flowers.spacing / d, GRASS.flowers.radius, 0, true, 3, 3);
    this.reach = 0; // how far the blades go this frame (0 when hidden): the ground lays thatch under them
  }
  update(eye, ground) {
    const alt = Math.max(0.05, eye.y - ground);
    // the rings' scale in whole steps of two, from the height over the ground: within a step nothing moves; over the last
    // 30% of a step the next one dissolves in (a clump's own hash decides when), so the change is spread, not a jump
    const lv = Math.log2(Math.min(8, Math.max(1, alt / 2.0))), L = Math.min(3, Math.floor(lv)), f = L >= 3 ? 0 : GRASS.dissolve(lv - L);
    for (const m of this.meshes) {
      const U = m.userData.U;
      U.uCamG.value.copy(eye); U.uAlt.value = alt;
      U.uWind.value.set(...this.world.env.wind);
      if (m.userData.next) { U.uScale.value = 2 ** (L + 1); U.uFade.value = -f; m.visible = f > 0; }
      else { U.uScale.value = 2 ** L; U.uFade.value = f; }
    }
    this.group.visible = alt < 30;
    // the thatch under the blades follows the height smoothly (not in the rings' steps), so its edge never jumps
    this.reach = this.group.visible ? GRASS.rings[GRASS.rings.length - 1].radius * Math.min(8, Math.max(1, alt / 2.0)) * (1 - Math.min(1, Math.max(0, (alt - 8) / 22))) : 0;
  }
  get instances() { return this.meshes.reduce((a, m) => a + (m.visible ? m.userData.instances : 0), 0); }
}
