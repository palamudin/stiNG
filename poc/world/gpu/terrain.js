// The ground on WebGPU: every clipmap level an instance of the same 64 x 64 grid (clipmap.js clipGrid), lifted in
// the vertex stage from the GPU clipmap (gpu/clip.js), morphing into its parent near its edge and sunk out of sight
// where a finer level covers it, as terrain.js. Lit by three.js's standard node material (the sun's shadow map,
// the sky light). The shading is the palette of terrain.js in short: grass by moisture, the forest floor, trails,
// sand and mud at the water, stone on steep ground, snow up high; the rest of terrain.js (the heightfield shadow,
// the canopy painted far off, the swash's wet sand, the close detail) comes over as the port goes on.
import * as THREE from 'three/webgpu';
import { Fn, float, int, vec2, vec3, vec4, attribute, positionLocal, positionWorld, cameraPosition, cameraViewMatrix, uniform, abs, max, min, mix, smoothstep, step, pow, length, normalize, dot, clamp, floor, fract, fwidth, If, wgslFn, select, texture, mat4, sin } from 'three/tsl';
import { MAP } from '../map.js';
import { clipGrid } from '../clipmap.js';
import { coastWet } from './water.js';
import { makeRunup } from './runup.js';
import { bakeGroundAtlas, TILE } from './atlas.js';

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

// The ground's substrate at the water and its fine relief (centimetres, near the eye): what the shore is made of,
// from the place itself: rock where the ground is steep, earth and mud where it is wet and wooded, shingle and pebbles
// in patches and on steeper beaches, sand on the open gentle ones (mixed at their edges); and each one's own small
// relief (wind and swash ripples in sand, rounded stones, lumpy earth, broken rock), lighting it through its normal and
// deciding where the water lingers: the troughs stay wet and shine after the swash has left the crests dry.
// subst: (sand, pebbles, earth, rock) weights; micro: the relief's height (m)
const subst = (P, slope, TD) => {
  const n1 = vnoise({ p: P.div(37) }), n2 = vnoise({ p: P.div(11).add(5.3) });
  const rock = smoothstep(0.16, 0.32, slope.add(n1.mul(0.06)));
  const earth = smoothstep(0.45, 0.8, TD.y.add(TD.z.mul(0.6)).add(n2.mul(0.25))).mul(float(1).sub(rock));
  const peb = smoothstep(0.55, 0.8, n1.mul(0.5).add(0.5).add(slope.mul(2.5))).mul(float(1).sub(rock)).mul(float(1).sub(earth));
  return vec4(max(float(1).sub(rock).sub(earth).sub(peb), 0), peb, earth, rock);
};
const micro = (P, w) => {
  const d = vec2(0.8, 0.6), ph = P.dot(d).div(0.11).mul(6.2832).add(vnoise({ p: P.div(0.9) }).mul(2.5));
  const hs = ph.sin().mul(0.5).add(0.5).pow(1.6).mul(0.007).add(vnoise({ p: P.div(0.5) }).mul(0.002));
  const hp = smoothstep(0.15, 0.85, vnoise({ p: P.div(0.07) }).mul(0.5).add(0.5)).mul(0.022);
  const he = vnoise({ p: P.div(0.35) }).mul(0.008).add(vnoise({ p: P.div(0.11) }).mul(0.005));
  const hr = vnoise({ p: P.div(0.6) }).mul(0.05).add(vnoise({ p: P.div(0.17) }).mul(0.02));
  return w.x.mul(hs).add(w.y.mul(hp)).add(w.z.mul(he)).add(w.w.mul(hr));
};

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
  // the ground's atlas (gpu/atlas.js): per pixel, each layer's weight (the shore's substrate in its band, the land's
  // grass soil, forest floor, rock and snow beyond), sharpened by the layers' own heights (stones stand out of the sand,
  // the sand fills between them), then the layers read: albedo, height, normal, roughness, cavity
  const [tA, tB] = opts.atlas || (opts.atlas = bakeGroundAtlas());
  const AT = Fn(() => {
    const slope = float(1).sub(TN.y), hg = TD.x.sub(RF.clipWater(P)), s = shoreW(hg), sw = subst(P, slope, TD).mul(s);
    const fk = smoothstep(0.35, 0.75, TD.z), rk = smoothstep(0.28, 0.45, slope).mul(float(1).sub(s));
    const snowK = smoothstep(uSnowLine, uSnowLine.add(40), TD.x.sub(uSea)).mul(float(1).sub(smoothstep(0.35, 0.6, slope)));
    const land = float(1).sub(s).sub(rk).max(0);
    const w = [sw.x, sw.y, sw.z, sw.w.add(rk), land.mul(float(1).sub(fk)), land.mul(fk), float(0)].map((x) => x.mul(float(1).sub(snowK)));
    w[6] = snowK;
    const alb = vec3(0).toVar(), h = float(0).toVar(), nx = vec2(0).toVar(), rough = float(0).toVar(), cav = float(0).toVar(), tot = float(1e-4).toVar();
    // the tiles' grid broken by a slow drift of each layer's origin (tens of metres: the same small patch nowhere repeats
    // in a row; a shift only, so the normals stay the tile's)
    const drift = (l) => vec2(sin(P.y.mul(0.043).add(l)).add(sin(P.x.mul(0.031).add(l * 1.7))), sin(P.x.mul(0.047).add(l * 2.3)).add(sin(P.y.mul(0.029).add(l * 0.6)))).mul(0.6);
    for (let l = 0; l < 7; l++) {
      const uv = P.div(TILE[l]).add(drift(l)), a = texture(tA, uv).depth(l), b = texture(tB, uv).depth(l);
      const hw = w[l].mul(a.w.add(0.35).pow(4)); // height-sharpened
      alb.addAssign(a.rgb.pow(2.2).mul(hw)); h.addAssign(a.w.mul(hw)); nx.addAssign(b.xy.mul(2).sub(1).mul(hw)); rough.addAssign(b.z.mul(hw)); cav.addAssign(b.w.mul(hw)); tot.addAssign(hw);
    }
    return mat4(vec4(alb.div(tot), h.div(tot)), vec4(nx.div(tot), rough.div(tot), cav.div(tot)), vec4(0), vec4(0));
  })().toVar();
  const atAlb = AT.element(0).xyz, atH = AT.element(0).w, atN = AT.element(1).xy, atRough = AT.element(1).z, atCav = AT.element(1).w;
  // the normal: the clipmap's, tilted by the atlas's relief (faded far off, where the mips have averaged it away)
  const shoreW = (hg) => float(1).sub(smoothstep(0.6, 2.4, hg)); // the shore's band (and everything under water)
  mat.normalNode = Fn(() => {
    const n = TN.toVar(), dist = length(cameraPosition.sub(positionWorld));
    n.assign(normalize(n.add(vec3(atN.x, 0, atN.y).mul(smoothstep(150, 20, dist)))));
    return cameraViewMatrix.mul(vec4(n, 0)).xyz.normalize();
  })();
  // the sand the swash has wetted (water3/swash.js sw3Wet): darker while the water fills its pores, a shine just after
  // the water leaves it, drying from the top down; on a sea beach only. (darkness, gloss, covered)
  // (with the swell field: the run-up's own wetting, gpu/runup.js: wet where the waves that arrive have been, draining
  // since; under the tide's water wet)
  const RUN = opts.swell ? makeRunup(opts.swell.reader(), opts.tide ? opts.tide.reader() : null, RF, opts.wtime, uniform(opts.sea ?? 0)) : null;
  const wetN = RUN ? Fn(() => {
    const P = positionWorld.xz, w = vec3(0).toVar(), hs = RF.clipAtSmooth(P).x.sub(RF.clipWater(P));
    If(hs.lessThan(4).and(RF.clipWater(P).lessThanEqual(float(opts.sea ?? 0).add(0.5))), () => {
      const r = RUN(P);
      w.assign(vec3(r.y, r.y.mul(float(1).sub(r.y)).mul(4).max(select(r.x.greaterThan(0), float(0.8), float(0))), select(r.x.greaterThan(0), float(1), float(0))));
    });
    return w;
  })() : opts.surf ? Fn(() => {
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
    // the shore's substrate (subst): sand, shingle, earth and mud, rock, mixed by the place
    // the land's broad colour (the palette above) takes the atlas's detail (its brightness about the layer's mean); the
    // shore's band is the atlas's own albedo (sand, shingle, earth, rock as they are)
    col.mulAssign(mix(float(1), atAlb.dot(vec3(0.3, 0.6, 0.1)).div(0.22).clamp(0.4, 1.8), smoothstep(400, 40, dist).mul(0.7)));
    col.assign(mix(col, atAlb, sand.mul(smoothstep(900, 200, dist).mul(0.6).add(0.4))));      // the shore at the water
    col.mulAssign(atCav.mul(0.35).add(0.65));
    const trough = smoothstep(0.55, 0.3, atH).mul(smoothstep(60, 10, dist)); // the atlas's hollows: the water lingers in them
    // wet: the sand the swash has wetted, and all the ground under the water (its pores full: darker and a little
    // deeper in colour, the same wet sand as the swash's, the water's refraction and absorption on top of it)
    const wet = max(wetN.x.mul(trough.mul(0.5).add(0.75)).clamp(0, 1), smoothstep(0.03, -0.04, hgt)); // (the troughs hold the water longer)
    col.assign(mix(col, col.mul(col).mul(1.15).add(col.mul(0.25)), wet.mul(0.6)).mul(mix(float(1), float(0.62), wet)));
    col.assign(mix(col, lin(0.36, 0.33, 0.25), float(1).sub(smoothstep(-3.5, -1.5, hgt)).mul(0.6)));   // deeper: finer, darker silt over the sand
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
  mat.roughnessNode = Fn(() => { const hg = TD.x.sub(RF.clipWater(P)); const tr = smoothstep(0.55, 0.3, atH); return mix(atRough, mix(float(0.3), float(0.06), tr), wetN.y.mul(smoothstep(-0.05, 0.0, hg))); })(); // the atlas's roughness; the shine of ground the water has just left, the hollows' films brightest (none under the water)
  // the map (map.js MAP_GLSL): zooming out, the ground turns into one, from the same clipmap: a hypsometric palette,
  // hillshade from the north-west, dotted forests, dashed trails, contours every 20 m, water flat blue by depth and a
  // dark coast line. Unlit (emissive, scaled by uMapK to show at its own colours whatever the exposure), the lit
  // picture fading out under it as uMap goes 0 to 1
  if (opts.map) {
    const uMap = opts.map.uMap, uMapK = opts.map.uMapK;
    const mapCol = Fn(() => {
      const T = TD, W = RF.clipWater(P), h = T.x.sub(uSea), depth = W.sub(T.x);
      const c = lin(0.62, 0.78, 0.42).toVar();
      c.assign(mix(c, lin(0.74, 0.76, 0.46), smoothstep(40, 160, h))); c.assign(mix(c, lin(0.78, 0.68, 0.5), smoothstep(160, 360, h)));
      c.assign(mix(c, lin(0.66, 0.6, 0.56), smoothstep(360, 560, h))); c.assign(mix(c, lin(0.95, 0.95, 0.97), smoothstep(uSnowLine.sub(40), uSnowLine.add(40), h)));
      c.assign(mix(c, c.mul(vec3(0.72, 0.84, 0.66)), smoothstep(0.3, 0.7, T.z).mul(0.8)));
      c.mulAssign(clamp(dot(TN, normalize(vec3(-0.5, 0.75, -0.5))), 0, 1).mul(0.6).add(0.55)); // hillshade
      const inDot = float(1).sub(step(0.55, length(fract(P.div(9)).sub(0.5)).mul(2)));
      c.mulAssign(mix(float(1), float(0.78), smoothstep(0.35, 0.7, T.z).mul(inDot)));
      c.assign(mix(c, lin(0.45, 0.3, 0.18), smoothstep(0.3, 0.6, T.w).mul(step(0.5, fract(P.x.add(P.y).div(6))))));
      const cf = fract(h.div(MAP.contour)), cw = max(fwidth(h.div(MAP.contour)).mul(1.2), 1e-3);
      c.mulAssign(float(1).sub(float(1).sub(smoothstep(0, cw, min(cf, float(1).sub(cf)))).mul(0.28).mul(float(1).sub(smoothstep(1, 3, cw)))));
      const wc = mix(lin(0.55, 0.78, 0.9), lin(0.2, 0.45, 0.75), smoothstep(0, 14, depth));
      const out = mix(c, wc, step(0, depth)).toVar();
      const e = max(fwidth(depth).mul(1.5), 1e-3);
      out.assign(mix(out, lin(0.12, 0.2, 0.3), float(1).sub(smoothstep(0, e, abs(depth))).mul(0.85))); // the coast line
      return out;
    })();
    const lit = mat.colorNode;
    mat.colorNode = vec4(lit.rgb.mul(float(1).sub(uMap)), 1);
    mat.emissiveNode = mapCol.mul(uMap).mul(uMapK);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
  mesh.name = 'gpu-terrain';
  mesh.uSnowLine = uSnowLine; // the season's snow line (seasons.js snowLine)
  return mesh;
}
