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
// - Each blade moves in one of eight ways (stiffness, sway rate and phase), so neighbours rarely move alike. The sways
//   are slow (a few seconds each) and wide in a breeze, so the lawn glides rather than jitters.
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
import { CLOUD_SHADOW_GLSL } from './clouds.js';

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
  sectors: 16,       // each ring is drawn in this many slices round the camera; a slice out of view is not drawn
};
// The sway table (computed once): a blade's sway over one cycle of its motion (256 steps), across the wind (red) and
// along it (green), for 8 wind levels from a breath of air to a gale (rows). In a breeze a blade swings smoothly side
// to side; as the wind rises the swing tightens and the nod along the wind turns into a quick dip and a slow return,
// as a blade does when the wind lays it over and lets it up. Each row's swing peaks at 1. The shader reads it at a
// phase and the wind's row, and the texture's filter interpolates between the steps and between the wind states.
export const SWAY = { steps: 256, levels: 8 };
export function swayTable() {
  const N = SWAY.steps, L = SWAY.levels, data = new Uint8Array(N * L * 4);
  for (let j = 0; j < L; j++) {
    const w = j / (L - 1), row = [];
    for (let i = 0; i < N; i++) {
      const p = i / N * Math.PI * 2;
      const across = Math.sin(p) * (1 - 0.3 * w) + 0.3 * w * Math.sin(2 * p + 0.8);
      const dip = Math.sin(p - 0.9 * w * Math.sin(p)); // the nod skews: a quick dip, a slower return
      const along = dip * (1 - 0.25 * w) + 0.25 * w * Math.sin(2 * p);
      row.push([across, along]);
    }
    const mx = Math.max(...row.map((r) => Math.abs(r[0]))), my = Math.max(...row.map((r) => Math.abs(r[1])));
    row.forEach(([a, b], i) => { const o = (j * N + i) * 4; data[o] = Math.round((a / mx * 0.5 + 0.5) * 255); data[o + 1] = Math.round((b / my * 0.5 + 0.5) * 255); data[o + 2] = 128; data[o + 3] = 255; });
  }
  const t = new THREE.DataTexture(data, N, L, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
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
export function clumpGeometry(blades, segs, seed = 45) {
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
uniform int uK; uniform float uS0, uRin, uRout, uNextBlades, uTime, uSea, uDensity, uFlower, uAlt, uShore, uSnowLine, uWoodH, uZ0, uBloom, uSnowCover, uWildFrom; uniform vec3 uGrassTint; uniform vec2 uWildH; uniform vec2 uGrassH; uniform vec2 uWind; uniform vec3 uCamG;
// the sway, tabulated (the sway table below) and driven by phases the CPU integrates (Grass.update): every input that
// moves with time is bounded (a phase in 0..1 per way of moving, the gust's in 0..2 pi, the eddies' drift wrapped), so
// the motion never depends on how long the game has run, and a change of wind changes how fast the phases turn, never
// where they are (it used to jump them, by the whole clock times the change: the grass went wild as the game ran on)
uniform sampler2D tSway; uniform vec2 uPh[8]; uniform float uGustPh, uSwayRow; uniform vec2 uEddy;
varying float vT, vCol, vRootK, vFade, vDith; varying vec3 vGW, vGR; varying vec3 vTint, vPetal; varying float vKill;
vec3 gPos; vec3 gNor; vec3 gRel; // gRel: the vertex from the eye (GDD 18.95)
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
  gPos = vec3(0.0); gNor = vec3(0.0, 1.0, 0.0); vGW = gPos; gRel = vec3(0.0); vGR = gRel;
  // far from home (GDD 18.95) the wind's patterns read the clump from a point snapped to 4096 m near the eye, never
  // from absolute metres (a float holds those to about a centimetre per 100 km, and sin() of a huge angle is noise)
  vec2 bL = base - floor(uCamG.xz / 4096.0) * 4096.0;
  if (de >= uRin && de < uRout) {
  vec4 gd = clipAt(base);
  // outside the view (5% wider than the frame, plus a clump's reach) the clump is dropped here, before its blades
  vec4 cc = projectionMatrix * modelViewMatrix * vec4(base.x, gd.x, base.y, 1.0);
  float mx = 1.05 * cc.w + 1.6 * projectionMatrix[0][0], my = 1.05 * cc.w + 1.6 * projectionMatrix[1][1];
  if (abs(cc.x) <= mx && abs(cc.y) <= my && cc.w > -2.0) {
  vec3 gn = clipNormal(base);
  float hgt = gd.x - clipWater(base), slope = 1.0 - gn.y; // above the water line here (the sea, or a lake's level)
  // what grows here: meadow full, under trees thin, nothing on stone, sand, water, trails or paving (by place: fixed)
  float dens = (1.0 - smoothstep(0.32, 0.45, slope)) * mix(1.0, smoothstep(1.3, 2.2, hgt), uShore) * (1.0 - smoothstep(0.3, 0.45, gd.w)) * mix(1.0, 0.35, smoothstep(0.4, 0.8, gd.z));
  dens *= uDensity * (1.0 - smoothstep(uSnowLine - 10.0, uSnowLine + 10.0, gd.x - uSea));
  dens *= 1.0 - smoothstep(0.97, 1.03, gd.y); // a pond's bed (moisture past 1, sources/sting.js)
  float wr = w2wear(gd.w);
  dens *= 1.0 - w2bare(base, wr); // trodden: bare in patches
  if (uFlower > 0.5) dens *= smoothstep(0.1, 0.6, w2noise(base / 9.0, 211) + 0.35 * (gd.y - 0.5)) * (1.0 - smoothstep(0.3, 0.6, gd.z)) * uBloom; // flowers only in their season
  dens *= 1.0 - 0.92 * uSnowCover; // under snow
  vKill = w2hash01(ci.x, ci.y, 203) > dens ? 1.0 : 0.0;
  float fade = persist ? 1.0 : 1.0 - smoothstep(uRout * ${GRASS_BAND}, uRout, de);
  fade *= 1.0 - smoothstep(8.0, 30.0, uAlt);
  float th = w2hash01(ci.x, ci.y, 213);
  vFade = clamp((fade - th * 0.85) / 0.15, 0.0, 1.0); // this clump dissolves over its own 15% of the band
  vDith = w2hash01(ci.x, ci.y, 214);
  if (vFade <= 0.0) vKill = 1.0;
  float rnd = w2hash01(ci.x, ci.y, 204);
  vec2 GH = uWildFrom > 0.0 ? mix(uGrassH, uWildH, smoothstep(uWildFrom * 0.85, uWildFrom * 1.05, length(base))) : uGrassH; // a town's mown grass, the wild meadow beyond
  float H = mix(GH.x, GH.y, gd.y) * (0.55 + 0.9 * aB.w) * (0.75 + 0.5 * rnd) * (uFlower > 0.5 ? 1.3 : 1.0);
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
  //   the blade: one of eight ways of moving (stiffness, and a slow sway across the wind and along it), picked by the
  //   blade and its clump. Eight is plenty:
  //   neighbours rarely share one, and the gusts and eddies differ from place to place anyway.
  float U10 = length(uWind); vec2 wd = U10 > 0.01 ? uWind / U10 : vec2(0.83, 0.55), wp = vec2(-wd.y, wd.x);
  float Uh = max(U10 * log(max(H, 1.5 * uZ0) / uZ0) / log(10.0 / uZ0), 0.25);
  // Smooth, never jittery: every motion here is a slow sine or a broad noise, so a blade glides from pose to pose.
  // A breeze sways blades wide and slowly; a strong wind lays them over and only then quickens them a little.
  float wk = smoothstep(0.25, 2.0, Uh); // 0 in a breath of air, 1 in a stiff wind
  float gust = 0.6 + 0.4 * sin(1.571 * dot(bL, wd) - uGustPh + 3.0 * w2noise(bL / 7.0, 205)); // 4 m waves, travelling downwind (uGustPh)
  float eddy = 0.5 + 0.5 * w2noise((bL - uEddy) / 1.6, 206); // 0..1, broad and slow, carried downwind (uEddy)
  float mv = floor(fract(aB.w * 7.31 + rnd * 3.7) * 8.0); // which of the eight
  float bph = mv * 2.39996, bk = (mv + 0.5) / 8.0; // phases a golden angle apart
  float stiff = 0.65 + 0.7 * bk; // how far this blade gives
  float rate = (1.7 + 1.4 * bk) * (1.0 + 0.5 * wk); // radians a second: a sway every 2 to 4 s in a breeze
  float ug = Uh * gust * (0.8 + 0.4 * eddy) * stiff / 1.5;
  float lay = min(0.85, 0.05 + ug * ug * 0.35); // 1.5 m/s at the tips lays a blade about a third over
  float amp = mix(0.16, 0.1, wk) * (0.75 + 0.5 * eddy); // a wide, slow sway in a breeze; tighter once laid over
  // the sway from the table: this way of moving's two phases (across the wind, and a slower nod along it), offset by the
  // blade's own, at the wind's row (the table interpolates between its wind states)
  vec2 ph = uPh[int(mv)];
  float sx = texture(tSway, vec2(ph.x + bph / 6.2831853, uSwayRow)).r * 2.0 - 1.0, sy = texture(tSway, vec2(ph.y + bph * 1.7 / 6.2831853, uSwayRow)).g * 2.0 - 1.0;
  vec2 flutter = (wp * sx + wd * 0.5 * sy) * amp;
  vec2 bend = fdir * lean * t * t + (wd * lay + flutter) * H * t * t;
  float drop = (dot(bend, bend) / max(H, 1e-3)) * 0.45; // a bent blade is shorter
  vec2 bw = off + side * aSide * W * (1.0 - t * 0.85) + bend; // the blade's vertex from its clump: millimetres, kept exact
  vec2 xz = base + bw;
  gPos = vec3(xz.x, gd.x + t * H - drop * t, xz.y);
  vec2 rxz = (base - cameraPosition.xz) + bw; // base - eye is exact for points this close
  gRel = vec3(rxz.x, gPos.y - cameraPosition.y, rxz.y);
  vec3 tangent = normalize(vec3(bend.x * 2.0 * t + 1e-4, H, bend.y * 2.0 * t + 1e-4));
  gNor = normalize(cross(vec3(side.x, 0.0, side.y), tangent));
  // rounded: toward the sky, more so with distance and height, so far blades shade like the ground they cover
  float roundK = mix(0.45, 0.92, smoothstep(2.0, 18.0, max(dist, uAlt * 2.0)));
  gNor = normalize(mix(gNor * sign(dot(gNor, vec3(fdir.x, 0.0, fdir.y)) + 1e-3), vec3(0.0, 1.0, 0.0), roundK));
  vT = t; vCol = rnd; vGW = gPos; vGR = gRel;
  // colour: dark at the root, light and drier at the tip, by moisture
  vec3 root = vec3(0.08, 0.17, 0.03), tip = mix(vec3(0.44, 0.42, 0.13), vec3(0.2, 0.45, 0.06), smoothstep(0.25, 0.7, gd.y));
  // a dense lawn hides its roots: up close each blade darkens toward its root, from further off the roots are hidden
  // by the blades in front, so the darkening fades with distance and height
  vRootK = 1.0 - smoothstep(3.0, 16.0, max(dist, uAlt * 2.0));
  vTint = mix(root, tip, mix(1.0, smoothstep(0.0, 0.8, t), vRootK)) * (0.8 + 0.4 * rnd) * uGrassTint; // the season's tint (yellow in autumn)
  vPetal = vec3(-1.0); // a flower's colour is only its head (the fragment shader takes it above 90% of the stem)
  if (uFlower > 0.5) {
    float k = floor(w2hash01(int(floor(base.x / 9.0)), int(floor(base.y / 9.0)), 212) * 5.0);
    vPetal = k < 1.0 ? vec3(0.9, 0.7, 0.05) : k < 2.0 ? vec3(0.85, 0.85, 0.8) : k < 3.0 ? vec3(0.45, 0.15, 0.6) : k < 4.0 ? vec3(0.8, 0.12, 0.08) : vec3(0.18, 0.3, 0.8);
  }
  }
  }
`;

// The clump cache (GDD 18.104): what a clump is (its ground, how tall it grows or that nothing grows, how wet, and the
// wind's gusts and eddies on it) is the same for every vertex of its blades, and every vertex worked it out again: three
// clipmap reads, the ground's normal, five noises, every frame, some 40 times a clump. Now one pass a frame writes it per
// clump into a float texture (a texel a grid cell of the ring, at its cell index), and the blades read one texel. The
// pass is a full-screen triangle over the ring's grid: about 60,000 texels a ring, against 2 million vertices
const GRASS_CELL = /* glsl */ `
uniform int uK, uCacheN; uniform float uS0, uSea, uDensity, uFlower, uShore, uSnowLine, uWoodH, uBloom, uSnowCover, uWildFrom, uGustPh;
uniform vec2 uWildH, uGrassH, uWind, uEddy; uniform vec3 uCamG; out vec4 outCell;
void main() {
  vec2 aCell = vec2(ivec2(gl_FragCoord.xy) - ivec2(uCacheN));
  float sp = uS0 * exp2(float(uK));
  vec2 org = floor(uCamG.xz / sp) * sp, cw = org + aCell * sp;
  ivec2 ci = ivec2(floor(cw / uS0 + 0.5));
  int bits = ci.x | ci.y, lvl = 7;
  for (int b = 0; b < 7; b++) if (((bits >> b) & 1) != 0) { lvl = b; break; }
  vec2 base = vec2(ci) * uS0 + (vec2(w2hash01(ci.x, ci.y, 201), w2hash01(ci.x, ci.y, 202)) - 0.5) * uS0 * exp2(float(min(lvl, ${GRASS.jitterLv})));
  vec2 bL = base - floor(uCamG.xz / 4096.0) * 4096.0;
  vec4 gd = clipAt(base); vec3 gn = clipNormal(base);
  float hgt = gd.x - clipWater(base), slope = 1.0 - gn.y;
  float dens = (1.0 - smoothstep(0.32, 0.45, slope)) * mix(1.0, smoothstep(1.3, 2.2, hgt), uShore) * (1.0 - smoothstep(0.3, 0.45, gd.w)) * mix(1.0, 0.35, smoothstep(0.4, 0.8, gd.z));
  dens *= uDensity * (1.0 - smoothstep(uSnowLine - 10.0, uSnowLine + 10.0, gd.x - uSea));
  dens *= 1.0 - smoothstep(0.97, 1.03, gd.y);
  float wr = w2wear(gd.w);
  dens *= 1.0 - w2bare(base, wr);
  if (uFlower > 0.5) dens *= smoothstep(0.1, 0.6, w2noise(base / 9.0, 211) + 0.35 * (gd.y - 0.5)) * (1.0 - smoothstep(0.3, 0.6, gd.z)) * uBloom;
  dens *= 1.0 - 0.92 * uSnowCover;
  bool kill = w2hash01(ci.x, ci.y, 203) > dens;
  float rnd = w2hash01(ci.x, ci.y, 204);
  vec2 GH = uWildFrom > 0.0 ? mix(uGrassH, uWildH, smoothstep(uWildFrom * 0.85, uWildFrom * 1.05, length(base))) : uGrassH;
  float Hc = mix(GH.x, GH.y, gd.y) * (0.75 + 0.5 * rnd) * (uFlower > 0.5 ? 1.3 : 1.0) * mix(1.0, uWoodH, smoothstep(0.85, 1.0, gd.z)) * mix(1.0, 0.45, wr);
  float U10 = length(uWind); vec2 wd = U10 > 0.01 ? uWind / U10 : vec2(0.83, 0.55);
  float gust = 0.6 + 0.4 * sin(1.571 * dot(bL, wd) - uGustPh + 3.0 * w2noise(bL / 7.0, 205));
  float eddy = 0.5 + 0.5 * w2noise((bL - uEddy) / 1.6, 206);
  outCell = vec4(gd.x, kill ? -1.0 : max(Hc, 1e-4), gd.y, floor(clamp(gust, 0.0, 1.0) * 4095.0) * 4096.0 + floor(clamp(eddy, 0.0, 1.0) * 4095.0));
}`;
// the blades' part, reading the cache (GRASS_BUILD without it is the fallback where float targets are missing)
const GRASS_BUILD_CACHED = GRASS_BUILD
  .replace(/  vec4 gd = clipAt\(base\);[\s\S]*?float rnd = w2hash01\(ci\.x, ci\.y, 204\);\n/, `  vec4 gc = texelFetch(tCache, ivec2(aCell) + ivec2(uCacheN), 0); // the clump: ground, height (nothing grows: < 0), moisture, wind
  vec4 gd = vec4(gc.x, gc.z, 0.0, 0.0);
  vec4 cc = projectionMatrix * modelViewMatrix * vec4(base.x, gd.x, base.y, 1.0);
  float mx = 1.05 * cc.w + 1.6 * projectionMatrix[0][0], my = 1.05 * cc.w + 1.6 * projectionMatrix[1][1];
  if (gc.y > 0.0 && abs(cc.x) <= mx && abs(cc.y) <= my && cc.w > -2.0) {
  vKill = 0.0;
  float fade = persist ? 1.0 : 1.0 - smoothstep(uRout * ${GRASS_BAND}, uRout, de);
  fade *= 1.0 - smoothstep(8.0, 30.0, uAlt);
  float th = w2hash01(ci.x, ci.y, 213);
  vFade = clamp((fade - th * 0.85) / 0.15, 0.0, 1.0);
  vDith = w2hash01(ci.x, ci.y, 214);
  if (vFade <= 0.0) vKill = 1.0;
  float rnd = w2hash01(ci.x, ci.y, 204);
`)
  .replace(/  vec2 GH = uWildFrom[^\n]*\n  float H = [^\n]*\n  H \*= mix\(1\.0, uWoodH[^\n]*\n  H \*= mix\(1\.0, 0\.45, wr\);[^\n]*\n/, '  float H = gc.y * (0.55 + 0.9 * aB.w);\n')
  .replace(/  float gust = 0\.6 \+ 0\.4 \* sin[^\n]*\n  float eddy = [^\n]*\n/, '  float gust = floor(gc.w / 4096.0) / 4095.0, eddy = mod(gc.w, 4096.0) / 4095.0; // from the clump pass\n')
  .replace(/\n  }\n  }\n`;?$/, '\n  }\n  }\n');
if (!GRASS_BUILD_CACHED.includes('texelFetch(tCache') || !GRASS_BUILD_CACHED.includes('from the clump pass') || !GRASS_BUILD_CACHED.includes('gc.y * (0.55')) throw new Error('grass: the cached build did not take');

export class Grass {
  constructor(world, opts = {}) {
    this.world = world;
    this.density = opts.density ?? 1;
    this.group = new THREE.Group(); this.group.name = 'world2-grass';
    const clip = world.clip.glsl();
    this.meshes = [];
    // the clump cache needs float targets (as the clipmap's GPU fill); without them the blades work it out themselves
    const r = world.renderer;
    this.cached = opts.cache !== false && !!r && r.capabilities.isWebGL2 && !!r.extensions.get('EXT_color_buffer_float');
    this.caches = [];
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
      // (the ring is drawn in GRASS.sectors slices round the camera, each its own mesh, so the ones out of view are not
      // drawn at all: by presence, GDD 18.101)
      const U = {
        ...world.clip.uniforms, tCloudShadow: world.uniforms.tCloudShadow, uCloudRect: world.uniforms.uCloudRect, uTime: world.uniforms.uTime, uBloom: { value: 1 }, uSnowCover: { value: 0 }, uGrassTint: { value: new THREE.Vector3(1, 1, 1) }, uWildFrom: { value: world.source.wildFrom || 0 }, uWildH: { value: new THREE.Vector2(...(world.source.wildGrass || world.source.grassHeight || [0.1, 0.42])) }, uSea: { value: world.source.sea }, uShore: world.uniforms.uShore, uSnowLine: world.uniforms.uSnowLine, uSunDir: world.uniforms.uSunDir, uSunColor: world.sky.uniforms.uSunColor,
        uK: { value: k }, uS0: { value: S0 }, uRin: { value: rin }, uRout: { value: rout }, uNextBlades: { value: nextBlades }, uDensity: { value: this.density }, uFlower: { value: flower ? 1 : 0 },
        uWoodH: { value: world.source.grassWood ?? 1 },
        uZ0: { value: 0.1 * ((world.source.grassHeight || [0.1, 0.42])[0] + (world.source.grassHeight || [0.1, 0.42])[1]) / 2 }, // roughness length
        uWind: shared.uWind, uCamG: shared.uCamG, uAlt: shared.uAlt,
        tSway: shared.tSway, uPh: shared.uPh, uGustPh: shared.uGustPh, uSwayRow: shared.uSwayRow, uEddy: shared.uEddy, uGrassMatte: shared.uGrassMatte,
        uGrassH: { value: new THREE.Vector2(...(world.source.grassHeight || [0.1, 0.42])) }, // metres, dry to wet ground
      };
      let cache = null;
      if (this.cached) { // a texel a cell of this ring's grid, (i, j) at (i + n, j + n)
        const N = 2 * n + 1, rt = new THREE.WebGLRenderTarget(N, N, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
        U.tCache = { value: rt.texture }; U.uCacheN = { value: n };
        const cmat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: U, depthTest: false, depthWrite: false,
          vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
          fragmentShader: `precision highp float; precision highp int;\n${clip}\n${NOISE_GLSL}\n${WEAR_GLSL}\n${GRASS_CELL}` });
        cache = { rt, mat: cmat, meshes: [], N };
        this.caches.push(cache);
      }
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, U);
        sh.vertexShader = `${clip}\n${NOISE_GLSL}\n${WEAR_GLSL}\n${GRASS_VERT_HEAD}\n${cache ? 'uniform highp sampler2D tCache; uniform int uCacheN;\n' : ''}` + sh.vertexShader
          .replace('#include <beginnormal_vertex>', (cache ? GRASS_BUILD_CACHED : GRASS_BUILD) + '\n  vec3 objectNormal = gNor;')
          .replace('#include <begin_vertex>', 'vec3 transformed = gPos;')
          // projected from the eye (GDD 18.95): viewMatrix * an absolute position cancels two large 32-bit numbers
          .replace('#include <project_vertex>', 'vec4 mvPosition = vec4(mat3(viewMatrix) * gRel, 1.0); gl_Position = projectionMatrix * mvPosition;\n  if (vKill > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);');
        sh.fragmentShader = `${CLOUD_SHADOW_GLSL}\nuniform vec3 uSunDir, uSunColor; uniform float uGrassMatte; varying float vT, vCol, vRootK, vFade, vDith; varying vec3 vGW, vGR, vTint, vPetal; varying float vKill;
float w2ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); } // interleaved gradient noise\n` + sh.fragmentShader
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vFade < 1.0 && fract(w2ign(gl_FragCoord.xy) + vDith) > vFade) discard; // dissolving, never shrinking')
          .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = vPetal.x >= 0.0 && vT > 0.9 ? vPetal : vTint;')
          // both faces of a blade use its rounded normal: three.js flips it on back faces, which points a sky-leaning
          // normal into the ground and turns every blade seen from behind dark
          .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize(vNormal);')
          .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
  { // the sun through the blade, toward the tip, strongest looking into the light; the root sits in its neighbours' shade
    vec3 V = normalize(vGR); // from the eye (GDD 18.95)
    float back = pow(clamp(dot(V, uSunDir), 0.0, 1.0), 3.0), cs = cloudShadow(vGW.xz);
    reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs;
    if (uGrassMatte > 0.5) {
      // matte and translucent (the switch, World.grassMatte): a blade has no gloss, and light comes through it: the sun
      // on its far side shines through, greener and warmer, more toward the thin tip, most looking into the light
      reflectedLight.directSpecular = vec3(0.0); reflectedLight.indirectSpecular = vec3(0.0);
      vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
      float through = 0.6 * clamp(-dot(nW, uSunDir), 0.0, 1.0) + back;
      reflectedLight.directDiffuse += uSunColor * diffuseColor.rgb * vec3(0.85, 1.15, 0.5) * through * 0.55 * (0.4 + 0.6 * vT) * cs;
    } else reflectedLight.directDiffuse += uSunColor * diffuseColor.rgb * back * 0.5 * vT; // the old look: glossy, a little back light
    reflectedLight.indirectDiffuse *= mix(1.0, 0.55 + 0.45 * vT, vRootK);
    reflectedLight.directDiffuse *= mix(1.0, 0.7 + 0.3 * vT, vRootK);
  }`);
      };
      mat.customProgramCacheKey = () => 'w2grass' + (flower ? 'f' : '') + (cache ? 'c' : '') + world.clip.cfg.levels; // the clipmap's level count is in the code
      const SEC = GRASS.sectors, bySec = Array.from({ length: SEC }, () => []);
      for (const c of list) bySec[Math.floor((Math.atan2(c[2], c[1]) + Math.PI) / (2 * Math.PI) * SEC) % SEC].push(c); // still outermost first
      for (let q = 0; q < SEC; q++) {
        const L = bySec[q]; if (!L.length) continue;
        const g = new THREE.InstancedBufferGeometry();
        for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]); // the clump's blades, shared
        g.setIndex(geo.index);
        const cs = new Float32Array(L.length * 2); L.forEach((c, o) => { cs[o * 2] = c[1]; cs[o * 2 + 1] = c[2]; });
        g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cs, 2)); g.instanceCount = L.length; g.boundingSphere = geo.boundingSphere;
        const mesh = new THREE.Mesh(g, mat);
        mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
        const a0 = -Math.PI + q * 2 * Math.PI / SEC;
        mesh.userData = { U, instances: L.length, radii: L.map((c) => c[0]), rin, slack, rout: rout + slack, a0, a1: a0 + 2 * Math.PI / SEC, sp };
        this.group.add(mesh); this.meshes.push(mesh);
        if (cache) cache.meshes.push(mesh);
      }
    };
    const shared = { uWind: { value: new THREE.Vector2(0.8, 0.3) }, uCamG: { value: new THREE.Vector3() }, uAlt: { value: 0 },
      tSway: { value: swayTable() }, uPh: { value: Array.from({ length: 8 }, () => new THREE.Vector2()) }, uGustPh: { value: 0 }, uSwayRow: { value: 0.5 / SWAY.levels }, uEddy: { value: new THREE.Vector2() },
      uGrassMatte: { value: opts.matte === false ? 0 : 1 } };
    this.sway = { wind: null, gust: 0, eddy: [0, 0], ph: Array.from({ length: 8 }, (_, m) => [m * 0.618 % 1, m * 0.382 % 1]) }; // the phases, integrated here (doubles)
    this.shared = shared;
    GRASS.rings.forEach((R, k) => {
      const next = GRASS.rings[k + 1];
      mk(k, s0, k ? GRASS.r0 * 2 ** (k - 1) : 0, GRASS.r0 * 2 ** k, false, R.blades, R.segs, next ? next.blades : 0);
    });
    this.far = GRASS.r0 * 2 ** (GRASS.rings.length - 1);
    if (opts.flowers !== false) mk(0, GRASS.flowers.spacing / d, 0, GRASS.flowers.radius, true, 3, 3, 0);
    this.reach = 0; // how far the blades go this frame (0 when hidden): the ground lays thatch under them
  }
  // the season (seasons.js): the flowers' share in bloom, the blades' tint, the snow cover
  season(bloom, tint, snow) { for (const m of this.meshes) { const U = m.userData.U; U.uBloom.value = bloom; U.uGrassTint.value.set(...tint); U.uSnowCover.value = snow; } }
  // the switch for the blades' look: matte and translucent (true), or the old glossy one (false), to compare
  set matte(on) { this.shared.uGrassMatte.value = on ? 1 : 0; }
  get matte() { return this.shared.uGrassMatte.value > 0.5; }
  update(eye, ground, dt = 1 / 60) {
    const alt = Math.max(0.05, eye.y - ground), S = this.shared;
    S.uCamG.value.copy(eye); S.uAlt.value = alt; const E = this.world.env, w10 = E.wind10 || [E.wind[0] * 8, E.wind[1] * 8]; // m/s at 10 m (as the waves)
    // the wind the grass moves in eases toward the weather's (a time constant of 1.5 s), so a change of wind blends the
    // blades from one state to the next; the phases then turn at the eased wind's pace, integrated here in doubles and
    // kept bounded, so nothing in the shader grows with the time the game has run
    const W = this.sway; dt = Math.min(Math.max(dt, 0), 0.25);
    if (!W.wind) W.wind = [w10[0], w10[1]];
    const k = 1 - Math.exp(-dt / 1.5); W.wind[0] += (w10[0] - W.wind[0]) * k; W.wind[1] += (w10[1] - W.wind[1]) * k;
    S.uWind.value.set(W.wind[0], W.wind[1]);
    const U10 = Math.hypot(W.wind[0], W.wind[1]), wd = U10 > 0.01 ? [W.wind[0] / U10, W.wind[1] / U10] : [0.83, 0.55];
    const z0 = this.meshes[0].userData.U.uZ0.value, Hm = Math.max(1.5 * z0, 0.75 * (this.meshes[0].userData.U.uGrassH.value.x + this.meshes[0].userData.U.uGrassH.value.y) / 2);
    const Uh = Math.max(U10 * Math.log(Hm / z0) / Math.log(10 / z0), 0.25), t = Math.min(1, Math.max(0, (Uh - 0.25) / 1.75)), wk = t * t * (3 - 2 * t); // the wind at a typical blade's top, and how stiff a wind it is (0..1)
    for (let m = 0; m < 8; m++) { const bk = (m + 0.5) / 8, rate = (1.7 + 1.4 * bk) * (1 + 0.5 * wk) / (Math.PI * 2); W.ph[m][0] = (W.ph[m][0] + dt * rate) % 1; W.ph[m][1] = (W.ph[m][1] + dt * rate * 0.71) % 1; S.uPh.value[m].set(W.ph[m][0], W.ph[m][1]); }
    W.gust = (W.gust + dt * 1.571 * (0.5 + 1.2 * Uh)) % (Math.PI * 2); S.uGustPh.value = W.gust;
    const de = dt * (0.3 + 0.9 * Uh); W.eddy[0] = (W.eddy[0] + wd[0] * de) % 4096; W.eddy[1] = (W.eddy[1] + wd[1] * de) % 4096; S.uEddy.value.set(W.eddy[0], W.eddy[1]);
    S.uSwayRow.value = (wk * (SWAY.levels - 1) + 0.5) / SWAY.levels;
    this.group.visible = alt < 30;
    // each ring draws its cells down to where a clump can still be past the last ring's reach, seen from this height; a
    // slice is drawn only if its wedge (out to the ring's reach, a little wider for the blades' lean, from below the
    // ground to above the tallest blade, and allowing for the hills) meets the view
    const hk = GRASS.altK * alt, cam = this.world.camera, F = this._frustum || (this._frustum = new THREE.Frustum()), B = this._box || (this._box = new THREE.Box3());
    cam.updateMatrixWorld(); this._pm = (this._pm || new THREE.Matrix4()).multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); F.setFromProjectionMatrix(this._pm);
    let drawn = 0;
    for (const m of this.meshes) {
      const u = m.userData, inner = Math.sqrt(Math.max(0, u.rin * u.rin - hk * hk)) - u.slack;
      let lo = 0, hi = u.radii.length; // the first cell (they run outermost first) closer than inner
      while (lo < hi) { const mid = (lo + hi) >> 1; if (u.radii[mid] >= inner) lo = mid + 1; else hi = mid; }
      m.geometry.instanceCount = lo;
      // the wedge itself, not its box (a box round a wedge reaching the eye holds the eye, and every view meets it: looking
      // at the ground, half the slices of every ring were drawn): its corners, at the bottom and the top, each a little
      // wider for the blades' lean; out of view when all of them are behind one of the view's planes
      const r0 = Math.max(0, inner - u.sp), r1 = (u.rout + 1) / Math.cos(Math.PI / GRASS.sectors), am = (u.a0 + u.a1) / 2, dy = 0.25 * r1, w0 = 1 + 2 * u.sp;
      const P = this._pts || (this._pts = Array.from({ length: 12 }, () => new THREE.Vector3())); let q = 0;
      const C = [[r0, u.a0 - w0 / Math.max(r0, 1)], [r0, u.a1 + w0 / Math.max(r0, 1)], [r1, u.a0], [r1, u.a1], [r1, am], [r0 > 0 ? r1 : -w0, am]];
      // the ground's range over the wedge, sampled at its corners and middle (a table per slice, sampled again only once
      // the eye has gone 5% of the slice's reach): the wedge is only as tall as its own ground, not the hills' worst
      let gLo = ground - dy, gHi = ground + dy;
      if (u.rout > 8 && this.world.heightAt) {
        const hc = u.hc || (u.hc = { x: Infinity, z: 0, lo: 0, hi: 0 });
        if (Math.hypot(eye.x - hc.x, eye.z - hc.z) > 0.05 * r1 || hc.r0 !== r0) {
          hc.x = eye.x; hc.z = eye.z; hc.r0 = r0; hc.lo = Infinity; hc.hi = -Infinity;
          for (const [r, a] of [...C, [(r0 + r1) / 2, am], [(r0 + r1) / 2, u.a0], [(r0 + r1) / 2, u.a1]]) { const h = this.world.heightAt(eye.x + r * Math.cos(a), eye.z + r * Math.sin(a)); hc.lo = Math.min(hc.lo, h); hc.hi = Math.max(hc.hi, h); }
        }
        const pad = 0.06 * r1; gLo = Math.min(hc.lo, ground) - pad; gHi = Math.max(hc.hi, ground) + pad;
      }
      for (const [r, a] of C) {
        const x = eye.x + r * Math.cos(a), z = eye.z + r * Math.sin(a);
        P[q++].set(x, gLo - 2, z); P[q++].set(x, gHi + 1.5, z);
      }
      let out = false;
      for (const pl of F.planes) { let all = true; for (let i = 0; i < 12 && all; i++) if (pl.distanceToPoint(P[i]) >= 0) all = false; if (all) { out = true; break; } }
      m.visible = lo > 0 && !out;
      if (m.visible) drawn += lo;
    }
    this.stats = { clumps: drawn, slices: this.meshes.filter((m) => m.visible).length, of: this.meshes.length, cached: this.cached };
    // the clump cache, a pass a ring with a slice in view (after the uniforms above: the same grid the blades will read)
    if (this.cached && this.group.visible) {
      const r = this.world.renderer, prev = r.getRenderTarget();
      if (!this._cq) { this._cq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this._cq.frustumCulled = false; this._cs = new THREE.Scene(); this._cs.add(this._cq); this._cc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); }
      for (const c of this.caches) {
        if (!c.meshes.some((m) => m.visible)) continue;
        this._cq.material = c.mat; r.setRenderTarget(c.rt); r.render(this._cs, this._cc);
      }
      r.setRenderTarget(prev);
    }
    // how far the blades reach on the ground (0 when hidden): the ground lays thatch under them; smooth in the height
    const h = GRASS.altK * alt, far = this.far;
    this.reach = this.group.visible ? Math.sqrt(Math.max(0, far * far - h * h)) * (1 - Math.min(1, Math.max(0, (alt - 8) / 22))) : 0;
  }
  get instances() { return this.meshes.reduce((a, m) => a + m.geometry.instanceCount, 0); }
}
