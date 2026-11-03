// Grass and wild flowers round the camera, placed entirely on the GPU. Each instance is a grid cell round the
// camera, snapped to the cell size so nothing swims; the vertex shader jitters it by a hash, reads the ground as drawn
// (clipmap: height, moisture, forest, trail), decides from those whether anything grows there (not on stone, sand,
// water, trails, paving or under a dense canopy), and builds the clump: blades that taper, curve, lean and bend with
// the wind (a gust field that travels across the ground). No CPU work per blade.
//
// Wind: uWind is the wind at 10 m in m/s (World.env.wind10; without it, the drawing wind scaled to a breeze). At a
// blade's top it is the log-law wind over the grass, with a roughness length of a tenth of the grass's height (the
// usual rule; 2.6 cm for the wild meadow, 7.8 mm for the game's lawns): about 0.4 of the 10 m wind at 30 cm in the
// meadow, 0.3 at the top of a lawn. Never less than 0.25 m/s there: the breath of air that always moves a lawn a little.
// - Drag bends a blade with roughly the square of that wind: 1.5 m/s at the tips lays it about a third over (our
//   calibration).
// - Gusts cross the grass as patches 3 m apart that travel downwind at 1.8 times the wind at the tops (canopy waves,
//   "honami"; Finnigan 2000), with small eddies carried along in them.
// - Each blade moves in one of eight ways (stiffness, flutter rate and phase), so neighbours rarely move alike.
//
// Five rings on nested grids (GRASS below): thousands of blades a square metre round the camera (a lawn is green
// because it is solid grass), fewer further out. A blade stays where it grew and as tall as it grew whatever the camera
// does: further out, the blades the coarser rings do not have dissolve away, each clump over its own short stretch, and
// the rest carry on unchanged. Only a blade's width grows a little with distance, so far blades still cover. The ground
// under them is the lawn's own thatch (terrain.js), so a gap between blades reads as more grass. The camera's height
// counts toward the distance, so from above the fine rings give way to the coarse ones; past 80 m (or 30 m up) the
// grass gives way to the ground's colour.
// At a wasp's height a blade is a wall; from a person's height it is a lawn.
//
// Wear (the fourth channel below 0.3, sources/sting.js): where people sit, stand and walk the lawn is shorter and the
// earth shows through in patches that open as the wear grows (w2bare, shared with the ground's shading, so the bare
// earth is where the blades are missing). In woods the grass grows long and thin.
import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

export const GRASS = {
  // Nested grids: ring k's clumps sit on a grid of spacing s0 * 2^k, so every clump of a coarser ring is also a clump of
  // every finer ring, at the same place with the same blades (a clump is named by its index on the finest grid, and its
  // jitter, look and blades follow from that name alone). Ring k draws from ring k-1's edge to its own; past its edge the
  // clumps and blades the next ring also has simply carry on, drawn by it, unchanged, and only the rest dissolve away
  // over the ring's outer band, each clump over a short stretch of its own. Nothing is scaled and nothing moves: a
  // blade is where it grew and as tall as it grew, whatever the camera does; further out there are fewer of them.
  s0: 0.045,         // the finest grid's spacing, metres (divided by the square root of the density)
  r0: 5,             // the finest ring's reach; each next ring reaches twice as far (5, 10, 20, 40, 80 m)
  rings: [ { blades: 6, segs: 3 }, { blades: 5, segs: 3 }, { blades: 4, segs: 3 }, { blades: 4, segs: 2 }, { blades: 3, segs: 2 } ],
  band: 0.5,         // the clumps a ring hands on to no one dissolve over the outer (1 - band) of its reach
  jitterLv: 4,       // a clump of level L strays up to half of s0 * 2^min(L, jitterLv) from its grid point
  altK: 1.5,         // the camera's height counts this much toward a clump's distance (a pixel covers more ground from above)
  bladeW: { root: 0.0065, from: 1.5, power: 0.9 }, // a blade's width: root * max(1, distance / from) ^ power, so far blades cover as near ones do
  flowers: { spacing: 0.55, radius: 18 },
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

// A clump's blades: the first n blades are the same whatever n is (a coarser ring's clump is a finer one's, minus blades)
function clumpGeometry(blades, segs, seed = 45) {
  // per vertex: aT (0 root .. 1 tip), aSide (-1, 1), aB (angle, offset x, offset z, random), aBi (the blade's number)
  const n = blades * (segs + 1) * 2, T = new Float32Array(n), S = new Float32Array(n), B = new Float32Array(n * 4), Bi = new Float32Array(n), P = new Float32Array(n * 3), idx = [];
  let v = 0;
  const r = (i) => { const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return x - Math.floor(x); };
  for (let b = 0; b < blades; b++) {
    const ang = r(b * 3 + 1) * 6.283, ox = (r(b * 3 + 2) - 0.5), oz = (r(b * 3 + 3) - 0.5), rnd = r(b * 7 + 9);
    const v0 = v;
    for (let s = 0; s <= segs; s++) for (const side of [-1, 1]) { T[v] = s / segs; S[v] = side; B.set([ang, ox, oz, rnd], v * 4); Bi[v] = b; v++; }
    for (let s = 0; s < segs; s++) { const a = v0 + s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('aT', new THREE.BufferAttribute(T, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(S, 1));
  g.setAttribute('aB', new THREE.BufferAttribute(B, 4));
  g.setAttribute('aBi', new THREE.BufferAttribute(Bi, 1));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

const GRASS_VERT_HEAD = /* glsl */ `
attribute float aT, aSide, aBi; attribute vec4 aB; attribute vec2 aCell;
uniform int uK; uniform float uS0, uRin, uRout, uNextBlades, uTime, uSea, uDensity, uFlower, uAlt, uShore, uSnowLine, uWoodH, uZ0; uniform vec2 uGrassH; uniform vec2 uWind; uniform vec3 uCamG;
varying float vT, vCol, vRootK, vFade, vDith; varying vec3 vGW; varying vec3 vTint, vPetal; varying float vKill;
vec3 gPos; vec3 gNor;
`;
// everything is computed in the normal stage (it comes first in three's vertex shader) and reused for the position
const GRASS_BAND = GRASS.band.toFixed(3), GRASS_ALT = GRASS.altK.toFixed(2);
const GRASS_W = { root: GRASS.bladeW.root.toFixed(4), from: GRASS.bladeW.from.toFixed(2), power: GRASS.bladeW.power.toFixed(3) };
const GRASS_BUILD = /* glsl */ `
  // the ring's grid, snapped to its spacing so nothing swims; the clump is named by its index on the finest grid
  float sp = uS0 * exp2(float(uK));
  vec2 org = floor(uCamG.xz / sp) * sp;
  vec2 cw = org + aCell * sp;
  ivec2 ci = ivec2(floor(cw / uS0 + 0.5));
  // its level: the coarsest grid it still sits on (the trailing zero bits of its index); the rings up to it all have it
  int bits = ci.x | ci.y, lvl = 7;
  for (int b = 0; b < 7; b++) if (((bits >> b) & 1) != 0) { lvl = b; break; }
  vec2 base = vec2(ci) * uS0 + (vec2(w2hash01(ci.x, ci.y, 201), w2hash01(ci.x, ci.y, 202)) - 0.5) * uS0 * exp2(float(min(lvl, ${GRASS.jitterLv})));
  float dist = length(base - uCamG.xz);
  float de = sqrt(dist * dist + ${GRASS_ALT} * ${GRASS_ALT} * uAlt * uAlt); // distance, counting the camera's height
  // this ring draws from the last ring's reach to its own. A clump (and blade) the next ring also has carries on past
  // here unchanged, drawn by it; the rest dissolve over the outer band, each clump over a short stretch of its own
  bool persist = lvl > uK && aBi < uNextBlades;
  vKill = 1.0; vFade = 0.0; vDith = 0.0; vT = 0.0; vCol = 0.0; vRootK = 0.0; vTint = vec3(0.0); vPetal = vec3(-1.0);
  gPos = vec3(0.0); gNor = vec3(0.0, 1.0, 0.0); vGW = gPos;
  if (de >= uRin && de < uRout) {
  vec4 gd = clipAt(base); vec3 gn = clipNormal(base);
  float hgt = gd.x - uSea, slope = 1.0 - gn.y;
  // what grows here: meadow full, under trees thin, nothing on stone, sand, water, trails or paving (by place: fixed)
  float dens = (1.0 - smoothstep(0.32, 0.45, slope)) * mix(1.0, smoothstep(1.3, 2.2, hgt), uShore) * (1.0 - smoothstep(0.3, 0.45, gd.w)) * mix(1.0, 0.35, smoothstep(0.4, 0.8, gd.z));
  dens *= uDensity * (1.0 - smoothstep(uSnowLine - 10.0, uSnowLine + 10.0, hgt));
  float wr = w2wear(gd.w);
  dens *= 1.0 - w2bare(base, wr); // trodden: bare in patches
  if (uFlower > 0.5) dens *= smoothstep(0.1, 0.6, w2noise(base / 9.0, 211) + 0.35 * (gd.y - 0.5)) * (1.0 - smoothstep(0.3, 0.6, gd.z));
  vKill = w2hash01(ci.x, ci.y, 203) > dens ? 1.0 : 0.0;
  float fade = persist ? 1.0 : 1.0 - smoothstep(uRout * ${GRASS_BAND}, uRout, de);
  fade *= 1.0 - smoothstep(8.0, 30.0, uAlt);
  float th = w2hash01(ci.x, ci.y, 213);
  vFade = clamp((fade - th * 0.85) / 0.15, 0.0, 1.0); // this clump dissolves over its own 15% of the band
  vDith = w2hash01(ci.x, ci.y, 214);
  if (vFade <= 0.0) vKill = 1.0;
  float rnd = w2hash01(ci.x, ci.y, 204);
  float H = mix(uGrassH.x, uGrassH.y, gd.y) * (0.55 + 0.9 * aB.w) * (0.75 + 0.5 * rnd) * (uFlower > 0.5 ? 1.3 : 1.0);
  H *= mix(1.0, uWoodH, smoothstep(0.85, 1.0, gd.z)); // long in the woods, where nobody mows
  H *= mix(1.0, 0.45, wr); // short where it is walked on
  float pxd = de; // how much ground a pixel covers here, roughly
  float W = (uFlower > 0.5 ? 0.006 : ${GRASS_W.root} * pow(max(1.0, pxd / ${GRASS_W.from}), ${GRASS_W.power})) * (0.8 + 0.5 * aB.w);
  // blade frame: it faces its own way and leans away from the clump centre
  float ang = aB.x + rnd * 6.283;
  vec2 fdir = vec2(cos(ang), sin(ang)), side = vec2(-fdir.y, fdir.x);
  vec2 off = aB.yz * uS0 * (uFlower > 0.5 ? 0.4 : 0.9); // a tuft the same size in every ring
  float t = aT;
  float lean = (0.25 + 0.35 * aB.w) * H;
  // wind (the head of the file): the 10 m wind brought down to the blade's top by the log law; drag lays a blade over
  // with about the square of it. Three scales, so no two blades move alike:
  //   gusts: patches 3 m apart running downwind at 1.8 times the wind at the tops (canopy waves, honami);
  //   eddies: small turbulence carried along with them (tens of centimetres), patch against patch;
  //   the blade: one of eight ways of moving (stiffness, and flutter across the wind and along it at a rate set by its
  //   length, a short blade quivering fast, a long one swaying), picked by the blade and its clump. Eight is plenty:
  //   neighbours rarely share one, and the gusts and eddies differ from place to place anyway.
  float U10 = length(uWind); vec2 wd = U10 > 0.01 ? uWind / U10 : vec2(0.83, 0.55), wp = vec2(-wd.y, wd.x);
  float Uh = max(U10 * log(max(H, 1.5 * uZ0) / uZ0) / log(10.0 / uZ0), 0.25);
  float gust = 0.6 + 0.4 * sin(2.094 * dot(base, wd) - 2.094 * 1.8 * Uh * uTime + 3.0 * w2noise(base / 6.0, 205));
  float eddy = w2noise((base - wd * uTime * 1.8 * Uh) / 0.7, 206); // -1..1, carried downwind with the gusts
  float mv = floor(fract(aB.w * 7.31 + rnd * 3.7) * 8.0); // which of the eight
  float bph = mv * 2.39996, bk = (mv + 0.5) / 8.0; // phases a golden angle apart
  float stiff = 0.65 + 0.7 * bk; // how far this blade gives
  float rate = (3.2 + 3.5 * bk) * mix(1.4, 0.8, smoothstep(0.03, 0.2, H)); // flutters per second
  float ug = Uh * gust * (0.85 + 0.3 * eddy) * stiff / 1.5;
  float lay = min(0.85, ug * ug * 0.35); // 1.5 m/s at the tips lays a blade about a third over
  float flu = min(Uh, 1.5) / 1.5 * (0.5 + 0.5 * abs(eddy)); // flutter grows with the wind
  vec2 flutter = (wp * 0.13 * sin(uTime * rate + bph) + wd * 0.07 * sin(uTime * rate * 0.63 + bph * 1.7)) * flu;
  vec2 bend = fdir * lean * t * t + (wd * lay + flutter) * H * t * t;
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
  vPetal = vec3(-1.0); // a flower's colour is only its head (the fragment shader takes it above 90% of the stem)
  if (uFlower > 0.5) {
    float k = floor(w2hash01(int(floor(base.x / 9.0)), int(floor(base.y / 9.0)), 212) * 5.0);
    vPetal = k < 1.0 ? vec3(0.9, 0.7, 0.05) : k < 2.0 ? vec3(0.85, 0.85, 0.8) : k < 3.0 ? vec3(0.45, 0.15, 0.6) : k < 4.0 ? vec3(0.8, 0.12, 0.08) : vec3(0.18, 0.3, 0.8);
  }
  }
`;

export class Grass {
  constructor(world, opts = {}) {
    this.world = world;
    this.density = opts.density ?? 1;
    this.group = new THREE.Group(); this.group.name = 'world2-grass';
    const clip = world.clip.glsl();
    this.meshes = [];
    const d = Math.sqrt(this.density), s0 = GRASS.s0 / d;
    const mk = (k, S0, rin, rout, flower, blades, segs, nextBlades) => {
      const geo = clumpGeometry(blades, segs);
      // the grid cells whose clumps can land between rin and rout (a clump strays from its grid point by its jitter)
      const sp = S0 * 2 ** k, slack = 0.5 * S0 * 2 ** GRASS.jitterLv + sp, n = Math.ceil((rout + slack) / sp), cells = [];
      // the whole disc, outermost cells first: on the ground the cells inside the last ring's reach are not drawn (a
      // shorter instance count), but from above a clump right under the camera can be as far as rin, so update() lets
      // the inner cells in as the camera climbs
      const list = [];
      for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) { const r = Math.hypot(i, j) * sp; if (r <= rout + slack) list.push([r, i, j]); }
      list.sort((a, b) => b[0] - a[0]);
      for (const [, i, j] of list) cells.push(i, j);
      const radii = list.map((c) => c[0]);
      geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cells), 2));
      geo.instanceCount = cells.length / 2;
      const U = {
        ...world.clip.uniforms, uTime: world.uniforms.uTime, uSea: { value: world.source.sea }, uShore: world.uniforms.uShore, uSnowLine: world.uniforms.uSnowLine, uSunDir: world.uniforms.uSunDir, uSunColor: world.sky.uniforms.uSunColor,
        uK: { value: k }, uS0: { value: S0 }, uRin: { value: rin }, uRout: { value: rout }, uNextBlades: { value: nextBlades }, uDensity: { value: this.density }, uFlower: { value: flower ? 1 : 0 },
        uWoodH: { value: world.source.grassWood ?? 1 },
        uZ0: { value: 0.1 * ((world.source.grassHeight || [0.1, 0.42])[0] + (world.source.grassHeight || [0.1, 0.42])[1]) / 2 }, // roughness length
        uWind: shared.uWind, uCamG: shared.uCamG, uAlt: shared.uAlt,
        uGrassH: { value: new THREE.Vector2(...(world.source.grassHeight || [0.1, 0.42])) }, // metres, dry to wet ground
      };
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, U);
        sh.vertexShader = `${clip}\n${NOISE_GLSL}\n${WEAR_GLSL}\n${GRASS_VERT_HEAD}\n` + sh.vertexShader
          .replace('#include <beginnormal_vertex>', GRASS_BUILD + '\n  vec3 objectNormal = gNor;')
          .replace('#include <begin_vertex>', 'vec3 transformed = gPos;')
          .replace('#include <project_vertex>', '#include <project_vertex>\n  if (vKill > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);');
        sh.fragmentShader = `uniform vec3 uSunDir, uSunColor; varying float vT, vCol, vRootK, vFade, vDith; varying vec3 vGW, vTint, vPetal; varying float vKill;
float w2ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); } // interleaved gradient noise\n` + sh.fragmentShader
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vFade < 1.0 && fract(w2ign(gl_FragCoord.xy) + vDith) > vFade) discard; // dissolving, never shrinking')
          .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = vPetal.x >= 0.0 && vT > 0.9 ? vPetal : vTint;')
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
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
      mesh.userData.U = U; mesh.userData.instances = cells.length / 2; mesh.userData.radii = radii; mesh.userData.rin = rin; mesh.userData.slack = slack;
      this.group.add(mesh); this.meshes.push(mesh);
    };
    const shared = { uWind: { value: new THREE.Vector2(0.8, 0.3) }, uCamG: { value: new THREE.Vector3() }, uAlt: { value: 0 } };
    this.shared = shared;
    GRASS.rings.forEach((R, k) => {
      const next = GRASS.rings[k + 1];
      mk(k, s0, k ? GRASS.r0 * 2 ** (k - 1) : 0, GRASS.r0 * 2 ** k, false, R.blades, R.segs, next ? next.blades : 0);
    });
    this.far = GRASS.r0 * 2 ** (GRASS.rings.length - 1);
    if (opts.flowers !== false) mk(0, GRASS.flowers.spacing / d, 0, GRASS.flowers.radius, true, 3, 3, 0);
    this.reach = 0; // how far the blades go this frame (0 when hidden): the ground lays thatch under them
  }
  update(eye, ground) {
    const alt = Math.max(0.05, eye.y - ground), S = this.shared;
    S.uCamG.value.copy(eye); S.uAlt.value = alt; const E = this.world.env, w10 = E.wind10 || [E.wind[0] * 8, E.wind[1] * 8]; S.uWind.value.set(w10[0], w10[1]); // m/s at 10 m (as the waves)
    this.group.visible = alt < 30;
    // each ring draws its cells down to where a clump can still be past the last ring's reach, seen from this height
    const hk = GRASS.altK * alt;
    for (const m of this.meshes) {
      const u = m.userData, inner = Math.sqrt(Math.max(0, u.rin * u.rin - hk * hk)) - u.slack;
      let lo = 0, hi = u.radii.length; // the first cell (they run outermost first) closer than inner
      while (lo < hi) { const mid = (lo + hi) >> 1; if (u.radii[mid] >= inner) lo = mid + 1; else hi = mid; }
      m.geometry.instanceCount = lo;
    }
    // how far the blades reach on the ground (0 when hidden): the ground lays thatch under them; smooth in the height
    const h = GRASS.altK * alt, far = this.far;
    this.reach = this.group.visible ? Math.sqrt(Math.max(0, far * far - h * h)) * (1 - Math.min(1, Math.max(0, (alt - 8) / 22))) : 0;
  }
  get instances() { return this.meshes.reduce((a, m) => a + m.geometry.instanceCount, 0); }
}
