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
import { Fn, If, float, int, vec2, vec3, vec4, uniform, uniformArray, texture, positionLocal, positionWorld, cameraPosition, screenUV, viewportSharedTexture, abs, max, min, mix, clamp, smoothstep, pow, exp, sqrt, log2, floor, length, normalize, dot, reflect, select, varyingProperty, wgslFn, wgsl, Discard, Loop, Break, cross, dFdx, dFdy, cameraProjectionMatrix, cameraViewMatrix, cameraNear, cameraFar, viewportDepthTexture, perspectiveDepthToViewZ } from 'three/tsl';
import { COAST_WGSL } from './coast.wgsl.js';
import { bakeFoamTexture } from './foamtex.js';
import { bakeBreaker } from './breaker.js';

// the coast (water3/swash.js, converted): entries taking the shore table's answer at the point
const coastCode = wgsl(COAST_WGSL);
const cVert = wgslFn('fn wCoastVert(xz: vec2<f32>, sh: vec4<f32>, know: f32, depth: f32, cell: f32, fl: f32, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> mat4x4<f32> { return coastVert(xz, sh, know, depth, cell, fl, surf, surfX, t, swDir); }', [coastCode]);
const cEdge = wgslFn('fn wCoastEdge(xz: vec2<f32>, level: f32, bed: f32, py: f32, grad: vec2<f32>, fl: f32, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> f32 { return coastEdgeY(xz, level, bed, py, grad, fl, surf, surfX, t, swDir); }', [coastCode]);
const nz = wgslFn('fn wNoise(p: vec2<f32>, s: i32) -> f32 { return w2noise(p, s); }', [coastCode]);
const cFoam = wgslFn('fn wCoastFoam(xz: vec2<f32>, depth: f32, grad: vec2<f32>, wave: f32, fl: f32, surf: vec4<f32>, surfX: vec4<f32>, t: f32, swDir: vec2<f32>) -> vec4<f32> { return coastShoreFoam(xz, depth, grad, wave, fl, surf, surfX, t, swDir); }', [coastCode]);

const lin3 = (r, g, b) => vec3(r ** 2.2, g ** 2.2, b ** 2.2);

// the water's colour presets (water.js WATER_PRESETS, the panel's 'Water'): absorption per metre (the channel absorbed
// least is the colour seen through shallow water) and scattering per metre (the deep water's glow); 'ours' is the
// world's lake water, the rest the reference pack's, and a milky glacial one
export const GWATER_PRESETS = {
  ours: { absorb: [0.45, 0.075, 0.035], scatter: [0.025, 0.04, 0.045] },
  clear: { absorb: [0.40, 0.062, 0.032], scatter: [0.0, 0.05, 0.08] },
  tropical: { absorb: [0.36, 0.045, 0.06], scatter: [0.0, 0.085, 0.085] },
  glacial: { absorb: [0.42, 0.07, 0.06], scatter: [0.06, 0.12, 0.12] },
  'algae green': { absorb: [0.45, 0.1, 0.5], scatter: [0.03, 0.08, 0.02] },
  'toxic green': { absorb: [0.45, 0.1, 1.1], scatter: [0.05, 0.1, 0.004] },
  purple: { absorb: [0.22, 0.85, 0.1], scatter: [0.05, 0.0, 0.09] },
  'rust orange': { absorb: [0.1, 0.34, 1.2], scatter: [0.11, 0.035, 0.004] },
  'murky brown': { absorb: [0.55, 0.62, 0.9], scatter: [0.045, 0.045, 0.022] },
};
// the silt a stirred bed or a flood puts in the water: absorption and scattering per metre at full load (a yellow-brown,
// scattering a lot: milky where it is thick)
export const SILT = { absorb: [0.22, 0.32, 0.55], scatter: [0.55, 0.48, 0.32] };
// the look's controls and their defaults (the panel's 'Water', index.js waterCtl): see water look in gpuWater
export const GLOOK = { preset: 'ours', clarity: 1, murk: 1, roughness: 0, refraction: 0.06, sssPeak: 1.6, sssView: 0.06, foamBias: 0.05, foamScale: 1.3, linger: 4, sediment: 0.05, stir: 0.6, riverSilt: 0.5, caustics: 1, lip: 1, spray: 1, bubbles: 1 };
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
  // the look (the panel's 'Water'): uAbs, uSca the preset's absorption and scattering; uLook (clarity: absorption over
  // it, murk: scattering times it, roughness, refraction); uLook2 (crest glow, glow toward the view, whitecap bias,
  // whitecap scale); uSed (silt everywhere, stirred by the surf, carried by rivers, 0); uHs the waves' height
  const uAbs = uniform(new THREE.Vector3(...GWATER_PRESETS.ours.absorb)), uSca = uniform(new THREE.Vector3(...GWATER_PRESETS.ours.scatter));
  const uLook = uniform(new THREE.Vector4(1, 1, 0, 0.06)), uLook2 = uniform(new THREE.Vector4(1.6, 0.06, 0.05, 1.3)), uSed = uniform(new THREE.Vector4(0.05, 0.6, 0.5, 1)), uHs = uniform(0.5);
  // the surf (water3/swash.js): uSurf (amplitude, wavelength, speed, steepness), uSurfX (foam charge, the shoreline's
  // lead), the water's clock, the swell's direction, the sea's level (a lake has no surf)
  const SU = opts.surfU || surfUniforms(opts.sea ?? 0), { uSurf, uSurfX, uWTime, uSwDir, uSea } = SU;
  const RV = clip.reads('WV'), RF = clip.reads('WF');
  const shV = opts.shore ? opts.shore.reader() : null;
  // the swell field (gpu/swellfield.js): the trains shaped by the ground under them, and the wind's fetch; a reader per
  // stage (the vertex's for the surface, the fragment's for the whitecaps and the silt)
  const SWv = opts.swell ? opts.swell.reader() : null, SWf = opts.swell ? opts.swell.reader() : null;
  // the bulk flow (gpu/swe.js): the tide's rise and the flow's slope on the water's level, per stage
  const BFv = opts.swe ? opts.swe.reader() : null, BFf = opts.swe ? opts.swe.reader() : null;
  const uField = uniform(opts.swell ? 1 : 0), uWind = uniform(5);
  // the wind sea's share at a fetch (JONSWAP's fetch laws): its height grows as the square root of the fetch up to the
  // fully developed sea (about 2.2e4 U^2 / g), and its longest waves (the peak, omega_p = 22 (g^2 / (U F))^(1/3)) cut
  // off each cascade whose waves are longer: a pond's surface only ripples, a lake's chops, the open sea runs
  const fetchShare = (F, c) => {
    const U = max(uWind, 1), Fi = U.mul(U).mul(2.2e4 / 9.81), h = F.div(Fi).clamp(0, 1).sqrt();
    const wp = float(22).mul(float(9.81 * 9.81).div(U.mul(max(F, 1))).pow(1 / 3)), lp = float(2 * Math.PI * 9.81).div(wp.mul(wp));
    return h.mul(smoothstep(0.1, 0.5, lp.div(Ls[c])));
  };
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
  const vH = varyingProperty('float', 'vH'); // the waves' lift here (the crests' glow)
  const vRest = varyingProperty('vec2', 'vRest'); // the water's own place before the waves moved it: patterns ride the surface, not the screen's
  const vCurl = varyingProperty('float', 'vCurl');
  const vBed = varyingProperty('float', 'vBed'); // the swell's velocity at the bed (the silt it stirs)
  const tBrk = bakeBreaker(); // the breaker's event (gpu/breaker.js), computed once; vCurl: how much of a breaking lip this is (its normal and its white)
  const uLip = uniform(1); // the lip's strength (the panel)
  const uUnder = uniform(0); // the eye under the water (the fish's view)
  mat.positionNode = Fn(() => {
    const skirt = positionLocal.y.greaterThan(0.5);
    const xz = select(skirt, positionLocal.xz.mul(GSURF.skirt), positionLocal.xz.mul(uScale)).add(cameraPosition.xz).toVar();
    const levelS = RV.clipWater(xz).toVar(), level = levelS.add(BFv ? BFv(xz).x.mul(select(levelS.lessThanEqual(uSea.add(0.5)), float(1), float(0))) : 0).toVar(), bed = RV.clipAt(xz).x.toVar(), depth = level.sub(bed).toVar();
    const dist = length(xz.sub(cameraPosition.xz)), cell = max(length(positionLocal.xz), 1).mul(cellStep).mul(uScale);
    // the coast's trains near a sea shore (none on a lake): their displacement, slope and foam; the open sea's long
    // swell (the first cascade) fades out where they carry it
    const cd = vec3(0).toVar(), near = float(0).toVar(), shift = float(1).toVar(), isCoast = float(0).toVar();
    vCoast.assign(vec4(0)); vCoastF.assign(vec2(0)); vH.assign(0); vCurl.assign(0); vBed.assign(0); vRest.assign(vec2(0));
    const lipPsi = float(0).toVar(), lipB = float(0).toVar(), lipA = float(0).toVar(), lipDir = vec2(0).toVar(), lipU = float(-1).toVar(); vRest.assign(xz);
    const lipPh = float(0).toVar(), lipK = float(1).toVar(), l1Psi = float(0).toVar(), l1A = float(0).toVar(), l1Dir = vec2(1, 0).toVar(), l1U = float(-1).toVar(), l1Ph = float(0).toVar(), l1K = float(1).toVar();
    if (shV) If(skirt.not().and(depth.greaterThan(-3)).and(levelS.lessThanEqual(uSea.add(0.5))).and(dist.lessThan(600)), () => {
      const sh = shV(xz);
      const m = cVert({ xz, sh: sh.v, know: sh.know, depth, cell, fl: float(0), ...surfArgs }).toVar();
      isCoast.assign(m.element(3).x); cd.assign(m.element(0).xyz); near.assign(m.element(0).w); shift.assign(select(isCoast.greaterThan(0.5), m.element(2).y, float(1)));
      vCoast.assign(m.element(1)); vCoastF.assign(vec2(m.element(2).x, m.element(0).w));
      lipPsi.assign(m.element(2).z); lipB.assign(m.element(2).w); lipA.assign(m.element(3).y); lipDir.assign(m.element(3).zw);
    });
    // the swell field: where its trains feel the floor (k d under about 2) they carry the swell, and the open sea's
    // long cascade gives way to them; the ground alone shapes them (gpu/swellfield.js)
    const fd = vec3(0).toVar(), wF = float(0).toVar(), Fch = float(1e5).toVar(), ub = float(0).toVar();
    if (SWv) If(skirt.not().and(uField.greaterThan(0.5)).and(depth.greaterThan(-0.5)), () => {
      const sw = SWv.swell(xz);
      Fch.assign(SWv.fetch(xz));
      const tr = (A, B, amp, wi, dir0) => {
        const perp = vec2(dir0.y.negate(), dir0.x);
        const ph = A.x.sub(wi.mul(uWTime)), a = A.y.mul(amp), k = A.w, th = A.z;
        const dirW = dir0.mul(th.cos()).add(perp.mul(th.sin()));
        // rounded crests, flatter troughs as the wave steepens and shoals (a Stokes second harmonic, its share from the
        // steepness and how near breaking), no points; the sideways sway of a Gerstner wave
        const s2 = k.mul(a).mul(0.5).add(B.x.mul(0.25)).clamp(0, 0.45), cph = ph.cos(), sph = ph.sin();
        const eta = a.mul(cph.add(s2.mul(ph.mul(2).cos().sub(0.5).mul(1.0))));
        const q = min(k.mul(a).mul(1.3), float(0.7));
        const fine = smoothstep(Math.PI * 2 / 3, Math.PI * 2 / 8, k.mul(cell)); // carried only where the grid holds the wave
        return { d: vec3(dirW.x.mul(q.div(max(k, 1e-3))).mul(sph).negate(), eta, dirW.y.mul(q.div(max(k, 1e-3))).mul(sph).negate()).mul(fine), sl: dirW.mul(a.mul(k).mul(sph.add(s2.mul(ph.mul(2).sin()).mul(2))).negate()).mul(fine), ph, a, dirW, k };
      };
      // the swell, and the wind sea's longest waves on their own grid
      const t0 = tr(sw.A0, sw.B0, SWv.amp.x, SWv.omega.x, SWv.dir), t1 = tr(sw.A1, sw.B1, SWv.amp.y, SWv.omega.y, SWv.dir1);
      wF.assign(sw.inside.mul(float(1).sub(smoothstep(0.7, 2.2, sw.A0.w.mul(depth.max(0))))));
      const wF1 = sw.inside1.mul(float(1).sub(smoothstep(0.7, 2.2, sw.A1.w.mul(depth.max(0)))));
      fd.assign(t0.d.mul(wF).add(t1.d.mul(wF1)));
      vCoast.xy.assign(t0.sl.mul(wF).add(t1.sl.mul(wF1)));
      // breaking: the first train's unheld ratio (near 1: the lip), whether it has broken on its way (the bore's
      // whitewater on the crest's front and the lace it leaves); its bed velocity stirs the silt
      const psi = t0.ph.add(Math.PI).mod(2 * Math.PI).sub(Math.PI).negate().toVar(); // < 0 ahead of the crest
      lipPsi.assign(psi); lipB.assign(smoothstep(0.7, 1.0, sw.B0.x).mul(wF)); lipA.assign(t0.a); lipDir.assign(t0.dirW);
      lipU.assign(select(sw.B0.y.greaterThan(0.5), sw.B0.z.div(max(float(6.2832).div(max(t0.k, 1e-3)).mul(0.3), 2)), float(-1)));
      lipPh.assign(t0.ph); lipK.assign(t0.k); lipA.assign(t0.a.mul(wF));
      // the wind sea's crests break by the same event, smaller
      l1Psi.assign(t1.ph.add(Math.PI).mod(2 * Math.PI).sub(Math.PI).negate()); l1A.assign(t1.a.mul(wF1)); l1Dir.assign(t1.dirW); l1Ph.assign(t1.ph); l1K.assign(t1.k);
      l1U.assign(select(sw.B1.y.greaterThan(0.5), sw.B1.z.div(max(float(6.2832).div(max(t1.k, 1e-3)).mul(0.3), 1)), float(-1))); // the breaker's stage: 0 the break .. 1 the lip in the trough
      const brk = max(smoothstep(0.0, 0.04, sw.B0.w), sw.B0.y.mul(0.35)).mul(wF); // the white where the wave loses its energy (gpu/swellfield.js), a little over every bore
      vCoast.z.assign(brk.mul(smoothstep(-0.9, -0.1, psi)).mul(exp(psi.max(0).mul(-0.9))).mul(smoothstep(0.05, 0.3, t0.a)));
      vCoast.w.assign(brk.mul(0.35).mul(smoothstep(0.05, 0.3, t0.a)));
      ub.assign(t0.a.mul(SWv.omega.x).div(max(t0.k.mul(depth.max(0.05)).mul(2).exp().sub(t0.k.mul(depth.max(0.05)).mul(-2).exp()).mul(0.5), 1e-3)).mul(wF));
      near.assign(wF); cd.assign(vec3(0)); // (the field replaces the coast's own trains)
    });
    vBed.assign(ub);
    const D = vec3(0).toVar();
    for (let c = 0; c < C; c++) {
      const d = texture(waves.disp[c], xz.div(Ls[c])).level(0);
      D.addAssign(vec3(d.x, d.y, d.z).mul(share(c, dist)).mul(c === 0 ? float(1).sub(near) : 1).mul(fetchShare(Fch, c)));
    }
    // the wind sea felt by the floor: each cascade's waves shrink where the water is shallower than about a quarter of
    // their length (here as one factor on the sum, the shortest cascade's length setting the start)
    const k = smoothstep(0, 4, depth.max(0)).mul(uChop);
    D.assign(D.mul(k).add(cd).add(fd)); vH.assign(D.y);
    D.x.mulAssign(shift); D.z.mulAssign(shift); // near the line the waves only lift and lower the water
    // the breaker, replayed (gpu/breaker.js): wherever a train has broken, its baked event at the wave's stage (how far
    // it has run since it broke) and its place across the wave, scaled to its height; each crest, and each stretch of
    // it, a little faster or slower and stronger or weaker (a seed from the crest's number and the place along it: the
    // break peels along the crest instead of the whole line going at once); only where the grid carries it
    if (SWv) {
      const replay = (psi, a, dir, st, ph, kk, strength) => {
        const L = float(6.2832).div(max(kk, 1e-3)), cyc = floor(ph.add(Math.PI).div(6.2832)), along = xz.dot(vec2(dir.y.negate(), dir.x)).div(L.mul(1.3));
        const n1 = nz({ p: vec2(along, cyc.mul(7.31)), s: int(901) }), n2 = nz({ p: vec2(along.mul(0.7).add(3.1), cyc.mul(5.17)), s: int(902) });
        const sv = st.mul(n1.mul(0.2).add(1)).add(n2.mul(0.12));
        const T = texture(tBrk, vec2(psi.div(6.2832).add(0.5), sv.clamp(0, 1))).level(0);
        const k3 = select(st.greaterThanEqual(0).and(sv.lessThan(1.05)), float(1), float(0)).mul(strength).mul(n1.mul(0.25).add(0.85))
          .mul(smoothstep(a.mul(2.5), a.mul(0.8), cell)).mul(smoothstep(0.03, 0.15, a));
        return { d: vec3(dir.x.mul(T.x), T.y, dir.y.mul(T.x)).mul(a).mul(k3), white: T.z.mul(k3), slide: dir.mul(T.w.mul(a).mul(k3)) };
      };
      const b0 = replay(lipPsi, lipA, lipDir, lipU, lipPh, lipK, uLip), b1 = replay(l1Psi, l1A, l1Dir, l1U, l1Ph, l1K, uLip.mul(0.8));
      D.addAssign(b0.d.add(b1.d));
      vCurl.assign(max(b0.white, b1.white));
      vRest.assign(xz.add(b0.slide).add(b1.slide)); // (the patterns keep their size over the fold)
    }
    const y = level.add(D.y).max(min(bed.add(0.04), level)).toVar(); // the trough held over the floor
    // the shoreline: over the sand a sheet at the swash's height, thin at its tip; in the last half metre of water lifted
    // to the same sheet
    if (shV) If(skirt.not().and(depth.lessThan(0.5)).and(depth.greaterThan(-3)).and(levelS.lessThanEqual(uSea.add(0.5))).and(dist.lessThan(600)), () => {
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
    const P = positionWorld.xz, PT = vRest, Vv = normalize(positionWorld.sub(cameraPosition)).toVar(), dist = length(positionWorld.sub(cameraPosition));
    const cs = opts.clouds && opts.clouds.shadowAt ? opts.clouds.shadowAt(positionWorld).toVar() : float(1); // the clouds' shadow on the sun
    // the slopes and the fold, summed over the cascades the distance still shows
    // the slope over the pixel's footprint (LEAN, as surface.js): each cascade's mipmapped mean and its variance (the
    // table holds the slope and its square), so far off the ripples become a broader, dimmer sheen instead of aliasing
    // into swirls; the fold (whitecaps) from the cascades the distance still shows
    const sl = vec2(0).toVar(), sv = vec2(0).toVar(), J = float(1).toVar(), FchF = (SWf ? SWf.fetch(P) : float(1e5)).toVar();
    for (let c = 0; c < C; c++) {
      const d = texture(waves.disp[c], PT.div(Ls[c])), w = share(c, dist.mul(0.5));
      let s = texture(waves.slope[c], PT.div(Ls[c]));
      if (c >= 1) { // detiled (as surface.js): a second read, turned and shifted, blended in by a slow noise, the blend
        // keeping the slope's spread (no repeat of the tile across the sea)
        const an = 1.7 + 0.9 * c, ca = Math.cos(an), sa = Math.sin(an), u = PT.div(Ls[c]);
        const s2 = texture(waves.slope[c], vec2(u.x.mul(ca).sub(u.y.mul(sa)), u.x.mul(sa).add(u.y.mul(ca))).add(vec2(0.37 * c, 0.61 * c)));
        const sxy = vec2(s2.x.mul(ca).add(s2.y.mul(sa)), s2.x.mul(-sa).add(s2.y.mul(ca))), szw = vec2(s2.z.add(s2.w).mul(0.5));
        const bw = smoothstep(-0.45, 0.45, nz({ p: PT.div(Ls[c] * 1.9), s: int(860 + c) })), n2 = float(1).sub(bw).pow(2).add(bw.mul(bw));
        s = vec4(s.xy.mul(float(1).sub(bw)).add(sxy.mul(bw)).div(n2.sqrt()), s.zw.mul(float(1).sub(bw).pow(2)).add(szw.mul(bw.mul(bw))).div(n2));
      }
      const fs = fetchShare(FchF, c);
      sl.addAssign(s.xy.mul(fs)); sv.addAssign(max(s.zw.sub(s.xy.mul(s.xy)), vec2(0)).mul(fs.mul(fs))); if (c >= 1) J.addAssign(d.w.sub(1).mul(w).mul(fs));
    }
    const levelS = RF.clipWater(P), level = levelS.add(BFf ? BFf(P).x.mul(select(levelS.lessThanEqual(uSea.add(0.5)), float(1), float(0))) : 0), ground = RF.clipAtSmooth(P).x, still = level.sub(ground).toVar(); // bilinear: the line along a contour, not a sawtooth
    // the shoreline here (water3/swash.js): its foam, and the water over the floor with it (th); over the sand a pixel
    // the swash is not over now is not water
    const coastFoam = float(0).toVar(), th = still.toVar();
    if (shV) If(still.lessThan(0.8).and(still.greaterThan(-3)).and(levelS.lessThanEqual(uSea.add(0.5))), () => {
      const e = max(float(0.35), RF.cellAt(P).mul(1.5)); // the beach's slope over more than a texel: the clipmap's triangles are flat, and the swash's reach steps with them
      const grad = vec2(RF.clipAtSmooth(P.add(vec2(e, 0))).x.sub(RF.clipAtSmooth(P.sub(vec2(e, 0))).x), RF.clipAtSmooth(P.add(vec2(0, e))).x.sub(RF.clipAtSmooth(P.sub(vec2(0, e))).x)).div(e.mul(2));
      const sf = cFoam({ xz: P, depth: still, grad, wave: vCoast.z, fl: float(0), ...surfArgs }).toVar();
      coastFoam.assign(sf.x); th.assign(sf.y);
    });
    Discard(still.lessThan(0).and(th.lessThanEqual(0)));
    const depth = max(still, th).max(0).toVar();
    const calm = smoothstep(0, 2, depth);
    sl.mulAssign(calm);
    // the swell field's trains' slope per pixel (not a vertex's, interpolated across a triangle: the jagged faces), at
    // the water's own place, and as a Gerstner surface's: the slope over the moved surface, dh / dX = -a k sin /
    // (1 - q cos), so a crest's face is as steep as the shape the vertices drew
    if (SWf) {
      const sw = SWf.swell(PT), d0 = SWf.dir, d1 = SWf.dir1;
      const slopeOf = (A, amp, w, dir, inside) => {
        const ph = A.x.sub(w.mul(uWTime)), a = A.y.mul(amp), k = A.w, th = A.z, q = min(k.mul(a).mul(1.3), float(0.7));
        const dirW = dir.mul(th.cos()).add(vec2(dir.y.negate(), dir.x).mul(th.sin()));
        const s2 = k.mul(a).mul(0.5).clamp(0, 0.45);
        const dh = a.mul(k).mul(ph.sin().add(s2.mul(ph.mul(2).sin()).mul(2))).negate().div(max(float(1).sub(q.mul(ph.cos())), 0.25));
        const wf = inside.mul(float(1).sub(smoothstep(0.7, 2.2, k.mul(still.max(0)))));
        return dirW.mul(dh).mul(wf);
      };
      sl.addAssign(slopeOf(sw.A0, SWf.amp.x, SWf.omega.x, d0, sw.inside).add(slopeOf(sw.A1, SWf.amp.y, SWf.omega.y, d1, sw.inside1)));
    } else sl.addAssign(vCoast.xy);
    const n = normalize(vec3(sl.x.negate(), 1, sl.y.negate())).toVar();
    // on a plunging lip the analytic slope does not know the fold: the surface's own facet (turned to the eye) instead
    // (derivatives outside any branch: WGSL wants them in uniform control flow)
    { const ng0 = normalize(cross(dFdx(positionWorld), dFdy(positionWorld))), ng = select(dot(ng0, Vv).greaterThan(0), ng0.negate(), ng0);
      n.assign(normalize(mix(n, ng, smoothstep(0.02, 0.35, vCurl).mul(float(1).sub(smoothstep(0.2, 0.7, ng.y))).mul(0.8)))); } // (the facet only where the lip truly overhangs: no faceted face)
    // under: the scene behind, along the bent ray, through depth / cos of the path, absorbed per channel
    const cosV = max(Vv.y.negate(), 0.08);
    const path = depth.div(cosV).min(80);
    const uvR = screenUV.add(n.xz.mul(uLook.w.mul(0.67)).mul(smoothstep(0, 1.5, depth)));
    const under = viewportSharedTexture(uvR).rgb;
    // the water's body: the preset's absorption over the clarity, its scattering times the murk, and the silt: some
    // everywhere (the weather's and the season's), more where the surf stirs the bed and where a river carries it
    const wa = RF.clipWaterAll(P), river = wa.y.clamp(0, 1);
    // (the silt: a little lifted off a shallow floor, more where the swell's motion reaches the bed and moves it (its
    // velocity there, a omega / sinh(k d)) or the surf churns it, carried by a river; the deep middle stays clear unless
    // the weather muddies it all: uSed.x's own share past the shallows is the runoff's, set by the caller)
    const sedK = uSed.x.mul(smoothstep(8, 1, depth)).add(uSed.y.mul(max(smoothstep(0.12, 0.7, vBed), vCoastF.x.clamp(0, 1).mul(0.6)))).add(uSed.z.mul(river)).clamp(0, 1.5).toVar();
    // and the air the breakers drive under: a cloud of bubbles under the white (it scatters, it hardly absorbs), so the
    // surf zone is milky turquoise under thin foam instead of solid white on top
    const bub = max(vCoast.z.clamp(0, 1), max(vCoastF.x.clamp(0, 1).mul(0.6), coastFoam.mul(0.5))).mul(smoothstep(5, 0.3, depth)).mul(uSed.w).toVar();
    const sa = uAbs.div(max(uLook.x, 0.05)).add(vec3(...SILT.absorb).mul(sedK)), sb = uSca.mul(uLook.y).add(vec3(...SILT.scatter).mul(sedK)).add(vec3(1.6, 1.75, 1.75).mul(bub));
    const sig = sa.add(sb), alb = sb.div(max(sig, vec3(1e-4)));
    const ext = exp(sig.mul(path).negate());
    // its light: the sky's from above and the sun's through the surface, scattered back up (single scattering over a deep
    // column: the albedo's share), the sun's more toward the view looking into it (a forward lobe)
    const fwd = pow(max(dot(Vv, uSunDir), 0), float(4)).mul(1.6).add(0.4);
    const scat = alb.mul(uSkyUp.mul(0.5).add(uSunColor.mul(cs).mul(max(uSunDir.y, 0)).mul(fwd).mul(0.25))).div(Math.PI);
    const body = under.mul(ext).add(scat.mul(float(1).sub(ext)));
    // above: the sky by Fresnel (Schlick, water n = 1.33) and the sun's highlight
    const R = reflect(Vv, n), cosI = max(dot(Vv.negate(), n), 0);
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(cosI), 5)));
    // the sky in the water: the sky-view table (gpu/sky.js) by the reflected direction, held above the horizon, with the
    // night's moon and stars, blurred by the ripples, and the clouds where the reflected direction falls on the screen
    const Ru = normalize(vec3(R.x, R.y.max(0.02), R.z));
    // the sky and the clouds by the reflected direction from their map (gpu/clouds.js envMap: whatever the screen
    // shows), blurred by the footprint's roughness; without it, the sky's table alone
    const env = opts.clouds && opts.sky ? opts.clouds.envMap(opts.sky) : null;
    const skyC = (env ? texture(env, opts.clouds.envUV(Ru)).level(log2(float(1).add(sv.x.add(sv.y).mul(calm).mul(900))).add(0.3).clamp(0, 6)).rgb : opts.sky ? opts.sky.skyAt(Ru).add(opts.sky.night(Ru, 0.004)) : mix(uSkyHz, uSkyUp, smoothstep(0, 0.45, R.y.max(0)))).toVar();
    // the scene in the water (post.js's screen-space march): along the reflected ray in growing steps, each projected
    // and tested against the scene's depth; a crossing refined by halving; faded at the screen's edges
    const hitC = vec3(0).toVar(), hitK = float(0).toVar();
    if (opts.ssr !== false) {
      const VP = cameraProjectionMatrix.mul(cameraViewMatrix), P0 = positionWorld.add(vec3(0, 0.02, 0));
      const t = float(0.4).toVar(), tPrev = float(0).toVar(), found = float(0).toVar();
      const proj = (P) => { const c = VP.mul(vec4(P, 1)); return vec3(c.x.div(c.w).mul(0.5).add(0.5), float(0.5).sub(c.y.div(c.w).mul(0.5)), c.w); };
      const sceneZ = (uv) => perspectiveDepthToViewZ(viewportDepthTexture(uv).x, cameraNear, cameraFar).negate();
      Loop(28, () => {
        const q = proj(P0.add(Ru.mul(t))).toVar(); // (the reflected ray held above the horizon: one dipping into the water finds the floor under it)
        If(q.x.lessThan(0).or(q.x.greaterThan(1)).or(q.y.lessThan(0)).or(q.y.greaterThan(1)).or(q.z.lessThan(0)), () => { Break(); });
        const dz = q.z.sub(sceneZ(q.xy));
        If(dz.greaterThan(0).and(dz.lessThan(t.sub(tPrev).mul(1.5).add(0.3))), () => {
          // refine between the last step and this one
          const lo = tPrev.toVar(), hi = t.toVar();
          Loop(6, () => { const m = lo.add(hi).mul(0.5), qm = proj(P0.add(Ru.mul(m))); If(qm.z.sub(sceneZ(qm.xy)).greaterThan(0), () => { hi.assign(m); }).Else(() => { lo.assign(m); }); });
          const qh = proj(P0.add(Ru.mul(hi)));
          const edge = smoothstep(0, 0.08, qh.x).mul(smoothstep(1, 0.92, qh.x)).mul(smoothstep(0, 0.08, qh.y)).mul(smoothstep(1, 0.92, qh.y));
          hitC.assign(viewportSharedTexture(qh.xy).rgb); hitK.assign(edge); found.assign(1); Break();
        });
        tPrev.assign(t); t.mulAssign(1.32);
      });
    }

    // the sun's highlight: tight on a still surface, broader and dimmer with the roughness
    // the sun's highlight: a Beckmann lobe on the footprint's slope variance (plus the panel's roughness): a sharp glint
    // near, a broad sheen far, its energy kept
    const s2 = sv.x.add(sv.y).mul(0.5).mul(calm).add(uLook.z.mul(uLook.z)).add(0.00025).toVar();
    const Hh = normalize(uSunDir.sub(Vv)), nh = max(dot(n, Hh), 0.05), t2 = float(1).sub(nh.mul(nh)).div(nh.mul(nh));
    const Dm = exp(t2.div(s2.mul(2)).negate()).div(s2.mul(6.2832).mul(nh.mul(nh).mul(nh).mul(nh)));
    const Fh = float(0.02).add(float(0.98).mul(pow(float(1).sub(max(dot(Vv.negate(), Hh), 0)), 5)));
    const spec = uSunColor.mul(cs).mul(Dm.mul(Fh).mul(0.25).div(max(cosI, 0.15))).mul(smoothstep(-0.02, 0.05, uSunDir.y));
    hitK.mulAssign(smoothstep(0.03, 0.006, s2)); // a rough far surface reflects the sky's average, not a sharp scene
    // a face turned so far that its reflection points down or level sees water, not sky: the sea's own darker body
    // toward the horizon (what the face of a wave mirrors: the water in front of it)
    const below = smoothstep(0.03, -0.25, R.y);
    skyC.assign(mix(skyC, mix(uSkyHz.mul(0.25), body.mul(1.1), 0.6), below));
    hitK.mulAssign(float(1).sub(below));
    const sky = mix(skyC, hitC, hitK);
    const col = mix(body, sky, F).add(spec.mul(smoothstep(0, 0.3, depth)).mul(float(1).sub(hitK))).toVar();
    // the crests' glow (surface.js): the sun through a thin steep crest, toward a view into the light; a little always
    { const crest = vH.div(max(uHs.mul(0.5), 0.05)).clamp(0, 1), steep = length(sl).mul(3).clamp(0, 1);
      const hv = normalize(vec2(Vv.x, Vv.z).add(1e-5)), hs = normalize(vec2(uSunDir.x, uSunDir.z).add(1e-5)), back = pow(max(dot(hv, hs), 0), float(3));
      const tint = mix(vec3(0.04, 0.42, 0.3), vec3(0.28, 0.3, 0.12), sedK.clamp(0, 1)).mul(vCurl.mul(2.5).add(1)); // a lip is thin water: it glows
      col.addAssign(tint.mul(uSunColor.mul(cs).mul(max(uSunDir.y, 0)).mul(0.5).add(uSkyUp.mul(0.35))).mul(crest).mul(crest.mul(steep).mul(back).mul(uLook2.x).div(1.6).add(uLook2.y.div(0.06).mul(0.08))).mul(calm).mul(float(1).sub(F))); }
    const cap = smoothstep(0.55, 0.15, J).mul(calm);
    // ---- foam (surface.js): whitecaps where the surface folds, the open water's sloshing lace now and then, the
    // breakers' white and lace, the surf zone's bed of bubbles, the swash's lace; one baked pattern covered to a share
    // set by each foam's strength (no foam field yet: what the waves made does not linger)
    const ls = 0.9, lt = smoothstep(0, 3, depth).toVar();
    const fpatch = mix(float(1), nz({ p: PT.div(9 * ls).add(vec2(uTime.mul(0.01), 0)), s: int(842) }).mul(0.5).add(0.5).mul(1.1).add(0.45), uLace.z).toVar();
    const fm = float(0).toVar();
    // the foam field (gpu/foamfield.js): what the whitecaps and breakers made, carried in and lingering; past its window
    // the folds' own whitecaps, this frame's
    const ff = float(0).toVar(), inField = float(0).toVar();
    if (opts.fields) for (const fr of opts.fields.map((f) => f.read())) { const q = fr(P); ff.assign(mix(ff, q.v, q.k)); inField.assign(max(inField, q.k)); }
    ff.assign(ff.clamp(0, 1).mul(fpatch));
    if (tFoam) {
      fm.assign(float(0.6).add(uLook2.z).sub(J).mul(uLook2.w).clamp(0, 1).mul(smoothstep(0.25, 0.6, laceD(PT, lt, 1.4 * ls, vec2(0)).add(0.2))).mul(fpatch).mul(calm).mul(float(1).sub(inField)));
      const pn = smoothstep(0.6, 0.85, nz({ p: PT.div(23).add(vec2(uTime.mul(0.07), uTime.mul(-0.05))), s: int(851) }).mul(0.5).add(0.5)).mul(smoothstep(0.5, 0.8, nz({ p: PT.div(61).sub(vec2(uTime.mul(0.03), uTime.mul(0.04))), s: int(852) }).mul(0.5).add(0.5)));
      const slosh = pn.mul(smoothstep(1.03, 0.88, J)).mul(smoothstep(0.8, 2.5, depth));
      fm.assign(max(fm, slosh.mul(smoothstep(0.3, 0.65, laceD(PT, lt, 1.6 * ls, vec2(uTime.mul(0.02), uTime.mul(0.013))).add(0.15))).mul(0.6).mul(fpatch)));
      const pat = laceD(PT, lt, 3.1 * ls, vec2(uTime.mul(0.011), uTime.mul(-0.007))).mul(0.62).add(laceD(PT, lt, 1.17 * ls, vec2(uTime.mul(-0.017), uTime.mul(-0.005))).mul(0.38)).add(0.12).toVar();
      const wf = vCoast.z.clamp(0, 1), lc = vCoast.w.clamp(0, 1).mul(float(1).sub(inField.mul(0.6)));
      fm.assign(max(fm, smoothstep(float(1).sub(ff.mul(0.55)), float(1.08).sub(ff.mul(0.55)), pat).mul(ff.mul(0.5).add(0.3)).mul(smoothstep(0, 0.02, ff)))); // the field's foam: thick where fresh, eroding into lace as it fades
      fm.assign(max(fm, smoothstep(float(1).sub(wf.mul(0.5)), float(1.1).sub(wf.mul(0.5)), pat).mul(wf.mul(0.35).add(0.45))));
      fm.assign(max(fm, smoothstep(float(1).sub(lc.mul(0.5)), float(1.1).sub(lc.mul(0.5)), pat).mul(0.45)));
      const spf = laceD(PT, lt, 5.3 * ls, vec2(uTime.mul(0.006), uTime.mul(-0.004))).mul(0.55).add(laceD(PT, lt, 1.9 * ls, vec2(uTime.mul(-0.012), 0)).mul(0.45)).add(0.15);
      const sfz = vCoastF.x.clamp(0, 1);
      fm.assign(max(fm, smoothstep(float(0.98).sub(sfz.mul(0.3)), float(1.08).sub(sfz.mul(0.3)), spf).mul(smoothstep(-0.35, 0.45, nz({ p: PT.div(0.22).add(uTime.mul(0.05)), s: int(629) }))).mul(sfz.mul(0.25).add(0.15))));
      fm.assign(max(fm, smoothstep(float(1).sub(coastFoam.mul(0.55)), float(1.1).sub(coastFoam.mul(0.55)), pat).mul(0.75).mul(coastFoam).mul(float(1).sub(inField)))); // (where a foam field is, the shoreline's foam is its: one linger, carried with the swash)
      // the lip's tip tearing into white as it throws
      const tip = smoothstep(0.45, 0.9, vCurl).mul(0.7);
      fm.assign(max(fm, smoothstep(float(1).sub(tip.mul(0.6)), float(1.1).sub(tip.mul(0.6)), pat.add(nz({ p: PT.div(0.35).add(uTime.mul(0.4)), s: int(631) }).mul(0.15))).mul(tip)));
    } else fm.assign(max(cap, coastFoam));
    const foamCol = uSkyUp.mul(0.8).add(uSunColor.mul(cs).mul(max(uSunDir.y, 0.05)).mul(0.55)).mul(0.92);
    col.assign(mix(col, foamCol, fm.clamp(0, 1).mul(0.85)));
    // the edge: only the last millimetres fade (a hairline, no seam); a thin sheet still mirrors the sky as any water
    // does (the reflection does not thin with the depth: only the body's colour does, through its absorption)
    const outc = mix(under, col, smoothstep(0, 0.006, depth)).toVar();
    // from below (the eye under the water, looking up at the surface): Snell's window: inside the critical angle
    // (48.6 degrees from straight up) the sky and the clouds bent through the surface (the whole hemisphere squeezed
    // into the cone, the sun in it), outside it the surface a mirror (total internal reflection) of the water's own
    // dim body; between them Fresnel. The water between the eye and the surface is the fog's (demo.js)
    If(uUnder.greaterThan(0.5).and(Vv.y.greaterThan(0)), () => {
      const nb = n.negate(), ci = max(dot(Vv.negate(), nb), 0); // the normal turned to the eye below
      const st2 = float(1.333 * 1.333).mul(float(1).sub(ci.mul(ci))); // sin^2 of the bent ray in the air
      const tir = st2.greaterThanEqual(1);
      const ct = sqrt(max(float(1).sub(st2), 0)), td = normalize(Vv.mul(1.333).add(nb.mul(ci.mul(1.333).sub(ct)))); // the bent ray (refract, water to air)
      const rs = ci.mul(1.333).sub(ct).div(ci.mul(1.333).add(ct)), rp = ci.sub(ct.mul(1.333)).div(ci.add(ct.mul(1.333)));
      const Fu = select(tir, float(1), rs.mul(rs).add(rp.mul(rp)).mul(0.5));
      const airC = (env ? texture(env, opts.clouds.envUV(vec3(td.x, td.y.max(0.004), td.z))).level(0.5).rgb : uSkyUp).add(uSunColor.mul(pow(max(dot(td, uSunDir), 0), float(900)).mul(30)));
      const mirror = scat.mul(0.6); // the water's body seen in the surface's mirror
      outc.assign(mix(airC, mirror, Fu));
    });
    // the map (map.js): flat blue by depth, the coast line drawn by the ground under it
    if (opts.map) outc.assign(mix(outc, mix(lin3(0.55, 0.78, 0.9), lin3(0.2, 0.45, 0.75), smoothstep(0, 14, still)).mul(opts.map.uMapK), opts.map.uMap));
    return RF.bind(vec4(outc, 1));
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 10; mesh.name = 'gpu-water';
  mesh.onBeforeRender = (r, s, cam) => {
    const above = Math.max(0, cam.position.y - (opts.waterAt ? opts.waterAt(cam.position.x, cam.position.z) : 0));
    uScale.value = Math.max(1, above / 2);
  };
  mesh.onAfterRender = () => {};
  return { mesh, look: { uAbs, uSca, uLook, uLook2, uSed, uHs, uLip, uField, uWind }, U: { uUnder, uLace, uTime, uScale, uSunDir, uSunColor, uSkyUp, uSkyHz, uChop, uSurf, uSurfX, uWTime, uSwDir, uSea } };
}
