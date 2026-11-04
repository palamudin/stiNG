// Water 3, step 1: the water surface as a real mesh (after Ultra-Water's design). A polar grid round the camera,
// displaced by the wave field's cascades and drawn into the scene with the depth test, so the waterline is simply where
// the water mesh and the terrain meet, cut by the hardware per pixel and antialiased by the scene's MSAA. Nothing
// computes where the waterline is.
//
// The grid: 256 segments; rings 6 cm apart at the lens growing x1.12 to 1 m, then x(1 + 2 pi / 256) so the cells stay
// square, out to 4 km; one skirt ring at 60 km. The rings round the eye are scaled with the camera's height above the
// water (a wasp sees centimetre cells, a gull metre cells). Each cascade is sampled at the mip its vertex spacing can
// carry, so the grid does not shimmer as it slides with the camera.
//
// Per vertex: the water level from the clipmap (the sea, or a lake's own); the floor's depth under it (within 600 m:
// past that the water is taken as deep and the floor is not read); the cascades damped by that depth (a swell does not
// live in a metre of water, chop reaches the beach); and the trough held 4 cm over the floor (growing with distance for
// the depth buffer's precision) so the surface never crosses the sand. Over land the surface is held at the level and
// the terrain hides it.
//
// Step 1 shades for diagnosis only: the surface's slope lit by the sun and sky, tinted by the depth under it.
import * as THREE from 'three';

export const SURFACE = {
  segments: 256, inner: 0.0625, innerGrow: 1.12, reach: 4000, skirt: 60000,
  floorReach: 600,               // metres: the floor is read for vertices nearer than this
  clear: 0.04,                   // metres the trough is held over the floor
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

export class WaterSurface {
  // world: the World (its clipmap, wave field, sky)
  constructor(world) {
    this.world = world;
    const field = world.waves, C = field.C, cs = [...Array(C).keys()];
    const grid = polarGrid();
    this.stats = { verts: grid.verts, tris: grid.geo.index.count / 3 };
    const U = {
      ...world.clip.uniforms,
      uCam: { value: new THREE.Vector3() }, uGridScale: { value: 1 }, uWL: { value: field.U.uL.value },
      uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() }, uSkyUp: { value: new THREE.Color() },
    };
    cs.forEach((c) => { U['tWD' + c] = { value: field.disp[c].texture }; U['tWS' + c] = { value: field.slope[c].texture }; });
    this.U = U;
    const N = field.N, S = SURFACE;
    const damp = /* glsl */ `
// the cascades' weights by the depth under the water: the long ones need depth, the chop reaches the beach
vec4 w3Damp(float depth) { float sw = smoothstep(1.5, 8.0, depth), mid = smoothstep(0.3, 3.0, depth), ch = smoothstep(-0.2, 1.0, depth); return vec4(sw, mid, ch, ch); }`;
    const head = /* glsl */ `
${world.clip.glsl()}
uniform vec3 uCam; uniform float uGridScale; uniform vec4 uWL;
${cs.map((c) => `uniform sampler2D tWD${c}, tWS${c};`).join(' ')}
${damp}`;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: U, side: THREE.DoubleSide,
      vertexShader: /* glsl */ `precision highp float; precision highp int;
${head}
out vec3 vW; out vec2 vXZ; out float vDepth, vCell;
void main() {
  bool skirt = position.y > 0.5;
  float r = length(position.xz);
  vec2 xz = skirt ? uCam.xz + position.xz * ${S.skirt.toFixed(1)} : uCam.xz + position.xz * uGridScale;
  float level = clipWater(xz);
  float dc = distance(xz, uCam.xz);
  // the floor, read only where it can matter
  float bed = -1e4, depth = 1e4;
  if (dc < ${S.floorReach.toFixed(1)}) { bed = clipHeight(xz); depth = level - bed; }
  vec4 k = w3Damp(depth);
  // each cascade at the mip its vertex spacing can carry (+1: a little blurrier than the spacing, so it never shimmers)
  float cell = max(r, 1.0) * ${grid.cellStep.toFixed(5)} * uGridScale;
  vec3 d = vec3(0.0);
  if (!skirt) {
    ${cs.map((c) => `{ float lod = max(0.0, log2(cell * ${N}.0 / uWL[${c}]) + 1.0); if (lod < ${Math.log2(N).toFixed(1)}) d += textureLod(tWD${c}, xz / uWL[${c}], lod).xyz * k[${Math.min(c, 3)}]; }`).join('\n    ')}
  }
  vec3 P = vec3(xz.x + d.x, level + d.y, xz.y + d.z);
  // the trough held over the floor (the clearance grows with distance for the depth buffer's precision); over land the
  // surface stays at the level and the terrain hides it
  if (bed > -1e3) P.y = max(P.y, min(bed + ${S.clear.toFixed(3)} + 2e-7 * dc * dc, level));
  vW = P; vXZ = xz; vDepth = depth; vCell = cell;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`,
      fragmentShader: /* glsl */ `precision highp float; precision highp int;
${head}
uniform vec3 uSun, uSunColor, uSkyUp;
in vec3 vW; in vec2 vXZ; in float vDepth, vCell; out vec4 oColor;
void main() {
  // the slope, filtered to the pixel's footprint, damped by the depth like the displacement
  float depth = vDepth < 1e3 ? clipWater(vXZ) - clipHeight(vXZ) : 1e4;
  vec4 k = w3Damp(depth);
  vec2 s = vec2(0.0); vec2 gx = dFdx(vXZ), gy = dFdy(vXZ);
  ${cs.map((c) => `s += textureGrad(tWS${c}, vXZ / uWL[${c}], gx / uWL[${c}], gy / uWL[${c}]).xy * k[${Math.min(c, 3)}];`).join('\n  ')}
  vec3 n = normalize(vec3(-s.x, 1.0, -s.y));
  // diagnosis: blue deepening with the depth under it, lit by the sun on the slope and the sky; the waterline is where
  // this mesh meets the terrain
  vec3 base = mix(vec3(0.55, 0.85, 0.8), vec3(0.05, 0.25, 0.45), smoothstep(0.0, 6.0, depth));
  vec3 c = base * (uSkyUp * 0.9 + uSunColor * max(dot(n, uSun), 0.0) * 0.5);
  oColor = vec4(c, 1.0);
}`,
    });
    this.mesh = new THREE.Mesh(grid.geo, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 1; this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    this.mesh.userData = { ring: true, world2: true };
  }
  // once a frame: the camera, the light
  update(camera) {
    const U = this.U, W = this.world;
    U.uCam.value.copy(camera.position);
    const above = Math.max(0, camera.position.y - W.waterAt(camera.position.x, camera.position.z));
    U.uGridScale.value = Math.max(1, above / 2);
    U.uSun.value.copy(W.sunDir); U.uSunColor.value.copy(W.sky.sunColor); U.uSkyUp.value.copy(W.sky.skyUp);
  }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}
