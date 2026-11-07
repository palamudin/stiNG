// The water on WebGPU (WEBGPU.md, water step 2): water3/surface.js's mesh and optics, first pass. A polar grid round
// the camera (the same rings: 6 cm at the lens growing to square cells, out to 4 km, a skirt at 60 km), scaled with
// the eye's height over the water, lifted to the water's level from the GPU clipmap (the sea or a lake's own) and
// displaced by the wave field's cascades (gpu/waves.js), each faded where the grid's spacing can no longer carry it.
// Drawn after the scene with the depth test, so the waterline is where the mesh and the ground meet.
// The optics: the scene under the water read along the bent ray, attenuated per channel over the path through the
// water (Beer-Lambert, from the clipmap's depth) with the water's own scattering added; the sky reflected by Fresnel
// with the sun's highlight; whitecaps where the cascades fold (their Jacobian), and a thin wash at the edge.
// Still to come over from surface.js: the shore table's coastal swell and swash, the foam fields and lace, the
// screen-space reflection and the mirror, glints, rain rings, caustics.
import * as THREE from 'three/webgpu';
import { Fn, If, float, int, vec2, vec3, vec4, uniform, uniformArray, texture, positionLocal, positionWorld, cameraPosition, screenUV, viewportSharedTexture, abs, max, min, mix, clamp, smoothstep, pow, exp, length, normalize, dot, reflect, select, varyingProperty, wgslFn, wgsl, Discard } from 'three/tsl';
import { COAST_WGSL } from './coast.wgsl.js';
import { bakeFoamTexture } from './foamtex.js';

// the coast (water3/swash.js, converted): entries taking the shore table's answer at the point
const coastCode = wgsl(COAST_WGSL);
const cVert = wgslFn('fn wCoastVert(xz: vec2<f32>, sh: vec4<f32>, know: f32, depth: f32, cell: f32, fl: f32, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> mat4x4<f32> { return coastVert(xz, sh, know, depth, cell, fl, surf, surfX, t, swDir); }', [coastCode]);
const cEdge = wgslFn('fn wCoastEdge(xz: vec2<f32>, level: f32, bed: f32, py: f32, grad: vec2<f32>, fl: f32, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> f32 { return coastEdgeY(xz, level, bed, py, grad, fl, surf, surfX, t, swDir); }', [coastCode]);
const nz = wgslFn('fn wNoise(p: vec2<f32>, s: i32) -> f32 { return w2noise(p, s); }', [coastCode]);
const cFoam = wgslFn('fn wCoastFoam(xz: vec2<f32>, depth: f32, grad: vec2<f32>, wave: f32, fl: f32, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> vec4<f32> { return coastShoreFoam(xz, depth, grad, wave, fl, surf, surfX, t, swDir); }', [coastCode]);

export const GSURF = { segments: 256, inner: 0.0625, innerGrow: 1.12, reach: 4000, skirt: 60000 };

function polarGrid() {
  const S = GSURF.segments, radii = [0];
  for (let r = GSURF.inner; r < 1; r *= GSURF.innerGrow) radii.push(r);
  const g = 1 + (2 * Math.PI) / S;
  for (let r = 1; r < GSURF.reach; r *= g) radii.push(r);
  radii.push(GSURF.reach);
  const R = radii.length, pos = new Float32Array((R * S + S) * 3), idx = [];
  let p = 0;
  for (let i = 0; i < R; i++) for (let j = 0; j < S; j++) { const a = (j / S) * 2 * Math.PI; pos[p++] = Math.cos(a) * radii[i]; pos[p++] = 0; pos[p++] = Math.sin(a) * radii[i]; }
  for (let j = 0; j < S; j++) { const a = (j / S) * 2 * Math.PI; pos[p++] = Math.cos(a); pos[p++] = 1; pos[p++] = Math.sin(a); } // the skirt (y = 1 marks it)
  for (let i = 0; i < R; i++) for (let j = 0; j < S; j++) {
    const a = i * S + j, b = i * S + ((j + 1) % S), c = (i + 1) * S + j, d = (i + 1) * S + ((j + 1) % S);
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return { geo, cellStep: g - 1 };
}

// the surf's uniforms, shared by the water and the sand (its wetness)
export function surfUniforms(sea = 0) {
  return { uSurf: uniform(new THREE.Vector4(0.8, 30, 1, 1)), uSurfX: uniform(new THREE.Vector4(1.6, 0.3, 0, 0)), uWTime: uniform(0), uSwDir: uniform(new THREE.Vector2(1, 0)), uSea: uniform(sea) };
}
// the sand's wetness (water3/swash.js sw3Wet): (darkness, gloss, covered) where the swash has been over it in its last
// waves, drying from then
export const coastWet = wgslFn('fn wCoastWet(xz: vec2<f32>, hgt: f32, grad: vec2<f32>, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> vec3<f32> { return coastWet(xz, hgt, grad, surf, surfX, t, swDir); }', [coastCode]);

export function gpuWater(clip, waves, opts = {}) {
  const { geo, cellStep } = polarGrid();
  const C = waves.C, N = waves.N, Ls = waves.cascades;
  const uScale = uniform(1), uSunDir = opts.sunDir || uniform(new THREE.Vector3(0.45, 0.62, 0.3).normalize()), uSunColor = opts.sunColor || uniform(new THREE.Color(1, 0.95, 0.86).multiplyScalar(3));
  const uSkyUp = opts.skyUp || uniform(new THREE.Color(0.24, 0.42, 0.75)), uSkyHz = opts.skyHz || uniform(new THREE.Color(0.62, 0.74, 0.88));
  const uChop = uniform(1);
  // the surf (water3/swash.js): uSurf (amplitude, wavelength, speed, steepness), uSurfX (foam charge, the shoreline's
  // lead), the water's clock, the swell's direction, the sea's level (a lake has no surf)
  const SU = opts.surfU || surfUniforms(opts.sea ?? 0), { uSurf, uSurfX, uWTime, uSwDir, uSea } = SU;
  const RV = clip.reads('WV'), RF = clip.reads('WF');
  const shV = opts.shore ? opts.shore.reader() : null;
  // the foam's lace (surface.js laceTap, lacePat, laceD): the baked texture read twice, the second rotated and shifted,
  // blended by a slow noise; two scales blended in patches; three sizes crossfaded by the depth
  const foamRT = opts.renderer ? bakeFoamTexture(opts.renderer) : null, tFoam = foamRT ? foamRT.texture : null;
  const uLace = uniform(new THREE.Vector4(0.9, 0.6, 0.5, 0)), uTime = uniform(0);
  const laceQ = (s) => 2048 / (5 * Math.max(1, Math.floor(2048 / (5 * s) + 0.5)));
  const laceTap = (p, pw) => {
    const q = vec2(p.x.mul(0.8).sub(p.y.mul(0.6)), p.x.mul(0.6).add(p.y.mul(0.8))).add(vec2(0.37, 0.71));
    const w = smoothstep(-0.35, 0.35, nz({ p: pw.mul(0.37), s: int(840) }));
    return mix(texture(tFoam, p).r, texture(tFoam, q).r, w);
  };
  const lacePat = (x, s, drift) => {
    const v = nz({ p: x.div(11 * s), s: int(841) }).mul(0.5).add(0.5).mul(uLace.y), s1 = laceQ(s), s2 = laceQ(1.7 * s);
    return mix(laceTap(x.div(s1).add(drift), x.div(s)), laceTap(x.div(s2).add(drift.mul(0.6)).add(0.43), x.div(1.7 * s)), v);
  };
  const laceD = (x, t, s, drift) => { // t: 0 the shallows .. 1 from about 3 m
    const a = lacePat(x, 0.25 * s, drift), b = lacePat(x, 0.8 * s, drift), c = lacePat(x, 2.5 * s, drift), t2 = t.mul(2);
    return select(t2.lessThan(1), mix(a, b, t2), mix(b, c, t2.sub(1)));
  };
  const surfArgs = { surf: uSurf, surfX: uSurfX, t: uWTime, swDir: uSwDir };
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: true, side: THREE.DoubleSide });
  mat.blending = THREE.NoBlending;
  // each cascade's share where the grid can carry it: its tile over the grid's spacing at this distance
  const share = (c, dist) => smoothstep(Ls[c] / N * 2.5, Ls[c] / N * 1.2, dist.mul(cellStep).add(0.001));
  const vCoast = varyingProperty('vec4', 'vCoast'), vCoastF = varyingProperty('vec2', 'vCoastF'); // set in the vertex stage, read in the fragment
  mat.positionNode = Fn(() => {
    const skirt = positionLocal.y.greaterThan(0.5);
    const xz = select(skirt, positionLocal.xz.mul(GSURF.skirt), positionLocal.xz.mul(uScale)).add(cameraPosition.xz).toVar();
    const level = RV.clipWater(xz).toVar(), bed = RV.clipAt(xz).x.toVar(), depth = level.sub(bed).toVar();
    const dist = length(xz.sub(cameraPosition.xz)), cell = max(length(positionLocal.xz), 1).mul(cellStep).mul(uScale);
    // the coast's trains near a sea shore (none on a lake): their displacement, slope and foam; the open sea's long
    // swell (the first cascade) fades out where they carry it
    const cd = vec3(0).toVar(), near = float(0).toVar(), shift = float(1).toVar(), isCoast = float(0).toVar();
    vCoast.assign(vec4(0)); vCoastF.assign(vec2(0));
    if (shV) If(skirt.not().and(depth.greaterThan(-3)).and(level.lessThanEqual(uSea.add(0.5))).and(dist.lessThan(600)), () => {
      const sh = shV(xz);
      const m = cVert({ xz, sh: sh.v, know: sh.know, depth, cell, fl: float(0), ...surfArgs }).toVar();
      isCoast.assign(m.element(3).x); cd.assign(m.element(0).xyz); near.assign(m.element(0).w); shift.assign(select(isCoast.greaterThan(0.5), m.element(2).y, float(1)));
      vCoast.assign(m.element(1)); vCoastF.assign(vec2(m.element(2).x, m.element(0).w));
    });
    const D = vec3(0).toVar();
    for (let c = 0; c < C; c++) {
      const d = texture(waves.disp[c], xz.div(Ls[c])).level(0);
      D.addAssign(vec3(d.x, d.y, d.z).mul(share(c, dist)).mul(c === 0 ? float(1).sub(near) : 1));
    }
    const k = smoothstep(0, 4, depth.max(0)).mul(uChop);
    D.assign(D.mul(k).add(cd));
    D.x.mulAssign(shift); D.z.mulAssign(shift); // near the line the waves only lift and lower the water
    const y = level.add(D.y).max(min(bed.add(0.04), level)).toVar(); // the trough held over the floor
    // the shoreline: over the sand a sheet at the swash's height, thin at its tip; in the last half metre of water lifted
    // to the same sheet
    if (shV) If(skirt.not().and(depth.lessThan(0.5)).and(depth.greaterThan(-3)).and(level.lessThanEqual(uSea.add(0.5))).and(dist.lessThan(600)), () => {
      const e = max(cell, 0.25);
      const grad = vec2(RV.clipAt(xz.add(vec2(e, 0))).x.sub(RV.clipAt(xz.sub(vec2(e, 0))).x), RV.clipAt(xz.add(vec2(0, e))).x.sub(RV.clipAt(xz.sub(vec2(0, e))).x)).div(e.mul(2));
      // on the sand the mesh lies just over it wherever the swash may reach; each pixel then finds whether the water is
      // over it now (no triangle steps along the line)
      // (raised a little more with the distance: the ground's mesh and this one are interpolated over different
      // triangles, and a sheet just over one dips under the other in triangles)
      y.assign(select(depth.lessThan(0), bed.add(0.012).add(dist.mul(0.004)), cEdge({ xz, level, bed, py: y, grad, fl: float(0), ...surfArgs })));
    });
    return RV.bind(vec3(xz.x.add(D.x), y, xz.y.add(D.z)));
  })();
  mat.colorNode = Fn(() => {
    const P = positionWorld.xz, Vv = normalize(positionWorld.sub(cameraPosition)).toVar(), dist = length(positionWorld.sub(cameraPosition));
    // the slopes and the fold, summed over the cascades the distance still shows
    const sl = vec2(0).toVar(), J = float(1).toVar();
    for (let c = 0; c < C; c++) {
      const s = texture(waves.slope[c], P.div(Ls[c])), d = texture(waves.disp[c], P.div(Ls[c])), w = share(c, dist.mul(0.5));
      sl.addAssign(s.xy.mul(w)); if (c >= 1) J.addAssign(d.w.sub(1).mul(w));
    }
    const level = RF.clipWater(P), ground = RF.clipAtSmooth(P).x, still = level.sub(ground).toVar(); // bilinear: the line along a contour, not a sawtooth
    // the shoreline here (water3/swash.js): its foam, and the water over the floor with it (th); over the sand a pixel
    // the swash is not over now is not water
    const coastFoam = float(0).toVar(), th = still.toVar();
    if (shV) If(still.lessThan(0.8).and(still.greaterThan(-3)).and(level.lessThanEqual(uSea.add(0.5))), () => {
      const e = max(float(0.35), RF.cellAt(P).mul(1.5)); // the beach's slope over more than a texel: the clipmap's triangles are flat, and the swash's reach steps with them
      const grad = vec2(RF.clipAtSmooth(P.add(vec2(e, 0))).x.sub(RF.clipAtSmooth(P.sub(vec2(e, 0))).x), RF.clipAtSmooth(P.add(vec2(0, e))).x.sub(RF.clipAtSmooth(P.sub(vec2(0, e))).x)).div(e.mul(2));
      const sf = cFoam({ xz: P, depth: still, grad, wave: vCoast.z, fl: float(0), ...surfArgs }).toVar();
      coastFoam.assign(sf.x); th.assign(sf.y);
    });
    Discard(still.lessThan(0).and(th.lessThanEqual(0)));
    const depth = max(still, th).max(0).toVar();
    const calm = smoothstep(0, 2, depth);
    sl.mulAssign(calm); sl.addAssign(vCoast.xy);
    const n = normalize(vec3(sl.x.negate(), 1, sl.y.negate())).toVar();
    // under: the scene behind, along the bent ray, through depth / cos of the path, absorbed per channel
    const cosV = max(Vv.y.negate(), 0.08);
    const path = depth.div(cosV).min(80);
    const uvR = screenUV.add(n.xz.mul(0.04).mul(smoothstep(0, 1.5, depth)));
    const under = viewportSharedTexture(uvR).rgb;
    const ext = exp(vec3(0.45, 0.09, 0.055).mul(path).negate());
    const scat = vec3(0.012, 0.05, 0.06).mul(uSkyUp.mul(0.6).add(uSunColor.mul(max(uSunDir.y, 0)).mul(0.25)));
    const body = under.mul(ext).add(scat.mul(float(1).sub(ext.g)));
    // above: the sky by Fresnel (Schlick, water n = 1.33) and the sun's highlight
    const R = reflect(Vv, n), cosI = max(dot(Vv.negate(), n), 0);
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(cosI), 5)));
    const sky = mix(uSkyHz, uSkyUp, smoothstep(0, 0.45, R.y.max(0)));
    const spec = pow(max(dot(R, uSunDir), 0), float(700)).mul(uSunColor).mul(6).add(pow(max(dot(R, uSunDir), 0), float(60)).mul(uSunColor).mul(0.15));
    const col = mix(body, sky, F).add(spec.mul(smoothstep(0, 0.3, depth))).toVar();
    const cap = smoothstep(0.55, 0.15, J).mul(calm);
    // ---- foam (surface.js): whitecaps where the surface folds, the open water's sloshing lace now and then, the
    // breakers' white and lace, the surf zone's bed of bubbles, the swash's lace; one baked pattern covered to a share
    // set by each foam's strength (no foam field yet: what the waves made does not linger)
    const ls = 0.9, lt = smoothstep(0, 3, depth).toVar();
    const fpatch = mix(float(1), nz({ p: P.div(9 * ls).add(vec2(uTime.mul(0.01), 0)), s: int(842) }).mul(0.5).add(0.5).mul(1.1).add(0.45), uLace.z).toVar();
    const fm = float(0).toVar();
    if (tFoam) {
      fm.assign(J.mul(-1).add(0.65).mul(1.3).clamp(0, 1).mul(smoothstep(0.25, 0.6, laceD(P, lt, 1.4 * ls, vec2(0)).add(0.2))).mul(fpatch).mul(calm));
      const pn = smoothstep(0.6, 0.85, nz({ p: P.div(23).add(vec2(uTime.mul(0.07), uTime.mul(-0.05))), s: int(851) }).mul(0.5).add(0.5)).mul(smoothstep(0.5, 0.8, nz({ p: P.div(61).sub(vec2(uTime.mul(0.03), uTime.mul(0.04))), s: int(852) }).mul(0.5).add(0.5)));
      const slosh = pn.mul(smoothstep(1.03, 0.88, J)).mul(smoothstep(0.8, 2.5, depth));
      fm.assign(max(fm, slosh.mul(smoothstep(0.3, 0.65, laceD(P, lt, 1.6 * ls, vec2(uTime.mul(0.02), uTime.mul(0.013))).add(0.15))).mul(0.6).mul(fpatch)));
      const pat = laceD(P, lt, 3.1 * ls, vec2(uTime.mul(0.011), uTime.mul(-0.007))).mul(0.62).add(laceD(P, lt, 1.17 * ls, vec2(uTime.mul(-0.017), uTime.mul(-0.005))).mul(0.38)).add(0.12).toVar();
      const wf = vCoast.z.clamp(0, 1), lc = vCoast.w.clamp(0, 1);
      fm.assign(max(fm, smoothstep(float(1).sub(wf.mul(0.6)), float(1.12).sub(wf.mul(0.6)), pat).mul(wf.mul(0.4).add(0.6))));
      fm.assign(max(fm, smoothstep(float(1).sub(lc.mul(0.5)), float(1.1).sub(lc.mul(0.5)), pat).mul(0.45)));
      const spf = laceD(P, lt, 5.3 * ls, vec2(uTime.mul(0.006), uTime.mul(-0.004))).mul(0.55).add(laceD(P, lt, 1.9 * ls, vec2(uTime.mul(-0.012), 0)).mul(0.45)).add(0.15);
      const sfz = vCoastF.x.clamp(0, 1);
      fm.assign(max(fm, smoothstep(float(0.98).sub(sfz.mul(0.3)), float(1.08).sub(sfz.mul(0.3)), spf).mul(smoothstep(-0.35, 0.45, nz({ p: P.div(0.22).add(uTime.mul(0.05)), s: int(629) }))).mul(sfz.mul(0.25).add(0.15))));
      fm.assign(max(fm, smoothstep(float(1).sub(coastFoam.mul(0.7)), float(1.12).sub(coastFoam.mul(0.7)), pat).mul(0.85).mul(coastFoam)));
    } else fm.assign(max(cap, coastFoam));
    const foamCol = uSkyUp.mul(0.8).add(uSunColor.mul(max(uSunDir.y, 0.05)).mul(0.55)).mul(0.92);
    col.assign(mix(col, foamCol, fm.clamp(0, 1).mul(0.85)));
    // the edge: the water fades to nothing as it thins, so the line is the sand seen through no water
    return RF.bind(vec4(mix(under, col, smoothstep(0, 0.05, depth)), 1));
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 10; mesh.name = 'gpu-water';
  mesh.onBeforeRender = (r, s, cam) => {
    const above = Math.max(0, cam.position.y - (opts.waterAt ? opts.waterAt(cam.position.x, cam.position.z) : 0));
    uScale.value = Math.max(1, above / 2);
  };
  mesh.onAfterRender = () => {};
  return { mesh, U: { uLace, uTime, uScale, uSunDir, uSunColor, uSkyUp, uSkyHz, uChop, uSurf, uSurfX, uWTime, uSwDir, uSea } };
}
