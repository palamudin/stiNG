// Grass and wild flowers round the camera, placed entirely on the GPU. Each instance is a grid cell round the
// camera, snapped to the cell size so nothing swims; the vertex shader jitters it by a hash, reads the ground as drawn
// (clipmap: height, moisture, forest, trail), decides from those whether anything grows there (not on stone, sand,
// water, trails, paving or under a dense canopy), and builds the clump: blades that taper, curve, lean and bend with
// the wind (a gust field that travels across the ground). No CPU work per blade.
//
// Three rings: thousands of blades a square metre round the camera (a lawn is green because it is solid grass), fewer
// and broader further out, cross-faded by thinning; the ground under them is the lawn's own dark thatch (terrain.js),
// so a gap between blades reads as more grass, not as painted ground. When the camera rises the rings scale with its
// height above the ground, and past a few tens of metres the grass gives way to the ground's colour.
// At a wasp's height a blade is a wall; from a person's height it is a lawn.
//
// Wear (the fourth channel below 0.3, sources/sting.js): where people sit, stand and walk the lawn is shorter and the
// earth shows through in patches that open as the wear grows (w2bare, shared with the ground's shading, so the bare
// earth is where the blades are missing). In woods the grass grows long and thin.
import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

export const GRASS = {
  // spacing: metres between clumps; width: a blade's width at its root; hMul: taller far out, so the far ring still covers
  rings: [
    { spacing: 0.045, radius: 3, blades: 6, segs: 3, width: 0.006, hMul: 1 },
    { spacing: 0.1, radius: 9, blades: 5, segs: 3, width: 0.011, hMul: 1.1 },
    { spacing: 0.28, radius: 24, blades: 5, segs: 2, width: 0.02, hMul: 1.4 },
  ],
  flowers: { spacing: 0.55, radius: 18 },
};
// The ground's wear, read the same way by the grass and the ground under it
export const WEAR_GLSL = /* glsl */ `
float w2wear(float w) { return w < 0.3 ? clamp(w / 0.2, 0.0, 1.0) : 0.0; } // 0 untouched .. 1 trodden
float w2bare(vec2 p, float wear) { // bare earth in patches that open as the wear grows
  float n = 0.5 + 0.32 * w2noise(p / 1.1, 207) + 0.18 * w2noise(p / 0.3, 208);
  return smoothstep(n - 0.07, n + 0.07, wear * 0.97);
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
uniform float uSpacing, uRadius, uInner, uScale, uTime, uSea, uDensity, uFlower, uAlt, uShore, uSnowLine, uBladeW, uHMul, uWoodH; uniform vec2 uGrassH; uniform vec2 uWind; uniform vec3 uCamG;
varying float vT, vCol, vRootK; varying vec3 vGW; varying vec3 vTint; varying float vKill;
vec3 gPos; vec3 gNor;
`;
// everything is computed in the normal stage (it comes first in three's vertex shader) and reused for the position
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
  // thin out toward the edge of the ring (and inside the inner ring, for the outer one), so the rings cross-fade
  float edge = 1.0 - smoothstep(R * 0.65, R, dist);
  float inner = uInner > 0.0 ? smoothstep(Ri * 0.6, Ri, dist) : 1.0;
  float keep = dens * edge * inner * (1.0 - smoothstep(8.0, 30.0, uAlt));
  vKill = w2hash01(ci.x, ci.y, 203) > keep ? 1.0 : 0.0;
  float rnd = w2hash01(ci.x, ci.y, 204);
  float H = mix(uGrassH.x, uGrassH.y, gd.y) * (0.55 + 0.9 * aB.w) * (0.75 + 0.5 * rnd) * uHMul * (uFlower > 0.5 ? 1.3 : 1.0);
  H *= mix(1.0, uWoodH, smoothstep(0.85, 1.0, gd.z)); // long in the woods, where nobody mows
  H *= mix(1.0, 0.45, wr); // short where it is walked on
  H *= 0.4 + 0.6 * smoothstep(0.0, 0.35, keep); // short where it thins
  float W = (uFlower > 0.5 ? 0.006 : uBladeW) * (0.8 + 0.5 * aB.w) * sqrt(uScale);
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
  vec3 root = vec3(0.05, 0.11, 0.015), tip = mix(vec3(0.44, 0.42, 0.13), vec3(0.2, 0.45, 0.06), smoothstep(0.25, 0.7, gd.y));
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
    const mk = (spacing, radius, inner, flower, blades, segs, width, hMul) => {
      const geo = clumpGeometry(blades, segs, spacing * 1000);
      const n = Math.ceil(radius / spacing), cells = [];
      for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) { const d = Math.hypot(i, j) * spacing; if (d <= radius && d >= inner * 0.55) cells.push(i, j); }
      geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cells), 2));
      geo.instanceCount = cells.length / 2;
      const U = {
        ...world.clip.uniforms, uTime: world.uniforms.uTime, uSea: { value: world.source.sea }, uShore: world.uniforms.uShore, uSnowLine: world.uniforms.uSnowLine, uSunDir: world.uniforms.uSunDir, uSunColor: world.sky.uniforms.uSunColor,
        uSpacing: { value: spacing }, uRadius: { value: radius }, uInner: { value: inner }, uScale: { value: 1 }, uDensity: { value: this.density }, uFlower: { value: flower ? 1 : 0 },
        uBladeW: { value: width }, uHMul: { value: hMul }, uWoodH: { value: world.source.grassWood ?? 1 },
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
      mat.customProgramCacheKey = () => 'w2grass' + (flower ? 'f' : '');
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
      mesh.userData.U = U; mesh.userData.instances = cells.length / 2;
      this.group.add(mesh); this.meshes.push(mesh);
      return mesh;
    };
    const d = Math.sqrt(this.density);
    let inner = 0;
    for (const R of GRASS.rings) { mk(R.spacing / d, R.radius, inner, false, R.blades, R.segs, R.width, R.hMul); inner = R.radius; }
    if (opts.flowers !== false) mk(GRASS.flowers.spacing / d, GRASS.flowers.radius, 0, true, 3, 3, 0.006, 1);
    this.reach = 0; // how far the blades go this frame (0 when hidden): the ground lays thatch under them
  }
  update(eye, ground) {
    const alt = Math.max(0.05, eye.y - ground);
    const scale = Math.min(8, Math.max(1, alt / 2.0));
    for (const m of this.meshes) {
      const U = m.userData.U;
      U.uCamG.value.copy(eye); U.uScale.value = scale; U.uAlt.value = alt;
      U.uWind.value.set(...this.world.env.wind);
    }
    this.group.visible = alt < 30;
    this.reach = this.group.visible ? GRASS.rings[GRASS.rings.length - 1].radius * scale * (1 - Math.min(1, Math.max(0, (alt - 8) / 22))) : 0;
  }
  get instances() { return this.meshes.reduce((a, m) => a + m.userData.instances, 0); }
}
