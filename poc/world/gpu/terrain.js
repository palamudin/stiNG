// The ground on WebGPU: every clipmap level an instance of the same 64 x 64 grid (clipmap.js clipGrid), lifted in
// the vertex stage from the GPU clipmap (gpu/clip.js), morphing into its parent near its edge and sunk out of sight
// where a finer level covers it, as terrain.js. Lit by three.js's standard node material (the sun's shadow map,
// the sky light). The shading is the palette of terrain.js in short: grass by moisture, the forest floor, trails,
// sand and mud at the water, stone on steep ground, snow up high; the rest of terrain.js (the heightfield shadow,
// the canopy painted far off, the swash's wet sand, the close detail) comes over as the port goes on.
import * as THREE from 'three/webgpu';
import { Fn, float, int, vec2, vec3, vec4, attribute, positionLocal, positionWorld, cameraPosition, cameraViewMatrix, uniform, abs, max, mix, smoothstep, pow, length, If, wgslFn } from 'three/tsl';
import { clipGrid } from '../clipmap.js';
import { coastWet } from './water.js';

const lin = (r, g, b) => vec3(r ** 2.2, g ** 2.2, b ** 2.2);
const hash2 = wgslFn(`fn tHash(p: vec2<f32>) -> f32 {
  var h = (u32(i32(floor(p.x))) * 2376512323u) ^ (u32(i32(floor(p.y))) * 3625334849u);
  h ^= h >> 16u; h *= 2146121005u; h ^= h >> 15u; h *= 2221713035u; h ^= h >> 16u;
  return f32(h) * 2.3283064e-10;
}`);
// value noise for the patches (smooth, cheap)
const vnoise = wgslFn(`fn tNoise(p: vec2<f32>) -> f32 {
  let i = floor(p); let f = p - i; let u = f * f * (3.0 - 2.0 * f);
  let a = tHash(i); let b = tHash(i + vec2<f32>(1.0, 0.0)); let c = tHash(i + vec2<f32>(0.0, 1.0)); let d = tHash(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}`, [hash2]);

export function gpuTerrain(clip, opts = {}) {
  const C = clip.cfg, g = clipGrid(C.cells);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
  geo.setIndex(new THREE.BufferAttribute(g.idx, 1));
  geo.setAttribute('aLevel', new THREE.InstancedBufferAttribute(new Float32Array(C.levels).map((_, i) => i), 1));
  geo.instanceCount = C.levels;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const uSea = uniform(opts.sea ?? 0), uSnowLine = uniform(opts.snowLine ?? 215);

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  const RV = clip.reads('V'), RF = clip.reads('F'); // the vertex stage's reads and the fragment stage's
  // the vertex: the level's grid at its own cell size round its snapped centre, lifted; a finer level's area sunk
  mat.positionNode = Fn(() => {
    const lvl = int(attribute('aLevel', 'float')), LV = clip.uLv.element(lvl);
    const pp = LV.xy.add(positionLocal.xz.mul(LV.z));
    const hh = RV.clipSurface(lvl, pp).x.toVar();
    If(lvl.greaterThan(0), () => {
      const F = clip.uLv.element(lvl.sub(1)), q = abs(pp.sub(F.xy));
      If(max(q.x, q.y).lessThanEqual(F.w.sub(LV.z.mul(2))), () => { hh.subAssign(LV.w.mul(30)); });
    });
    return vec3(pp.x, hh, pp.y);
  })();
  // the fragment: the clipmap's own data at this point, so a coarse far level shades like the fine one it stands for
  const P = positionWorld.xz;
  const TD = RF.clipAt(P), TN = RF.clipNormal(P);
  mat.normalNode = cameraViewMatrix.mul(vec4(TN, 0)).xyz.normalize(); // the clipmap's normal (world), in view space as the node material wants it
  // the sand the swash has wetted (water3/swash.js sw3Wet): darker while the water fills its pores, a shine just after
  // the water leaves it, drying from the top down; on a sea beach only. (darkness, gloss, covered)
  const wetN = opts.surf ? Fn(() => {
    const S = opts.surf, P = positionWorld.xz, w = vec3(0).toVar(), TW = RF.clipWater(P), hs = RF.clipAtSmooth(P).x.sub(TW);
    If(hs.greaterThan(0).and(hs.lessThan(3)).and(TW.lessThanEqual(S.uSea.add(0.5))), () => {
      const e = max(float(0.35), RF.cellAt(P).mul(1.5));
      const grad = vec2(RF.clipAtSmooth(P.add(vec2(e, 0))).x.sub(RF.clipAtSmooth(P.sub(vec2(e, 0))).x), RF.clipAtSmooth(P.add(vec2(0, e))).x.sub(RF.clipAtSmooth(P.sub(vec2(0, e))).x)).div(e.mul(2));
      w.assign(coastWet({ xz: P, hgt: hs, grad, surf: S.uSurf, surfX: S.uSurfX, t: S.uWTime, swDir: S.uSwDir }));
    });
    return w;
  })() : vec3(0);
  mat.colorNode = Fn(() => {
    const dist = length(cameraPosition.sub(positionWorld));
    const slope = float(1).sub(TN.y);
    const TW = RF.clipWater(P), hgt = TD.x.sub(TW), alt = TD.x.sub(uSea);
    const pa = vnoise({ p: P.div(9) }).mul(0.5).add(vnoise({ p: P.div(2.1) }).mul(0.25));
    const col = mix(lin(0.66, 0.66, 0.34), lin(0.45, 0.66, 0.22), smoothstep(0.1, 0.42, TD.y.add(pa.mul(0.25)))).toVar();
    col.assign(mix(col, lin(0.32, 0.56, 0.16), smoothstep(0.65, 0.95, TD.y.add(pa.mul(0.15)))));
    col.mulAssign(float(1).add(vnoise({ p: P.div(0.7) }).mul(0.2).mul(float(1).sub(smoothstep(20, 80, dist)))));
    col.assign(mix(col, lin(0.30, 0.33, 0.17), smoothstep(0.35, 0.75, TD.z)));            // forest floor
    col.assign(mix(col, lin(0.55, 0.42, 0.28), smoothstep(0.2, 0.6, TD.w)));              // trails
    const sand = float(1).sub(smoothstep(0.6, 1.8, hgt.add(pa.mul(0.4))));
    col.assign(mix(col, lin(0.86, 0.78, 0.56), sand));                                       // sand at the water
    col.mulAssign(mix(float(1), float(0.55), wetN.x.mul(sand))); // the sand the swash has wetted, darker
    col.assign(mix(col, lin(0.42, 0.37, 0.27), float(1).sub(smoothstep(-1.2, -0.2, hgt))));   // under it: mud
    const rock = smoothstep(0.28, 0.45, slope.add(pa.mul(0.05)));
    const rc = mix(lin(0.52, 0.50, 0.47), lin(0.40, 0.38, 0.36), smoothstep(-0.3, 0.3, vnoise({ p: P.div(3.3) })));
    col.assign(mix(col, rc, rock));                                                          // stone on steep ground
    // the canopy painted into the ground (terrain.js uTreeFar): under the far cards it fills the gaps between them, and
    // beyond the cards' reach it is the forest itself
    if (opts.bands) {
      const B = opts.bands, fk = smoothstep(0.35, 0.75, TD.z.add(pa.mul(0.1)));
      const can = lin(0.17, 0.32, 0.10).mul(float(0.8).add(vnoise({ p: P.div(23) }).mul(0.25)));
      col.assign(mix(col, can, fk.mul(max(smoothstep(B.z.mul(0.9), B.z.mul(1.2), dist).mul(0.6), smoothstep(B.w.mul(0.85), B.w, dist)))));
    }
    const snow = smoothstep(uSnowLine, uSnowLine.add(40), alt.add(pa.mul(25))).mul(float(1).sub(smoothstep(0.35, 0.6, slope)));
    col.assign(mix(col, lin(0.95, 0.96, 0.98), snow));
    return vec4(col, 1);
  })();
  if (opts.surf) mat.roughnessNode = mix(float(0.92), float(0.3), wetN.y); // the shine of sand the water has just left
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
  mesh.name = 'gpu-terrain';
  return mesh;
}
