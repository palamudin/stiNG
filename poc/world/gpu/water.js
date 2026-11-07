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
import { Fn, If, float, int, vec2, vec3, vec4, uniform, uniformArray, texture, positionLocal, positionWorld, cameraPosition, screenUV, viewportSharedTexture, abs, max, min, mix, clamp, smoothstep, pow, exp, length, normalize, dot, reflect, select } from 'three/tsl';

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

export function gpuWater(clip, waves, opts = {}) {
  const { geo, cellStep } = polarGrid();
  const C = waves.C, N = waves.N, Ls = waves.cascades;
  const uScale = uniform(1), uSunDir = opts.sunDir || uniform(new THREE.Vector3(0.45, 0.62, 0.3).normalize()), uSunColor = opts.sunColor || uniform(new THREE.Color(1, 0.95, 0.86).multiplyScalar(3));
  const uSkyUp = opts.skyUp || uniform(new THREE.Color(0.24, 0.42, 0.75)), uSkyHz = opts.skyHz || uniform(new THREE.Color(0.62, 0.74, 0.88));
  const uChop = uniform(1);
  const RV = clip.reads('WV'), RF = clip.reads('WF');
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: true, side: THREE.DoubleSide });
  mat.blending = THREE.NoBlending;
  // each cascade's share where the grid can carry it: its tile over the grid's spacing at this distance
  const share = (c, dist) => smoothstep(Ls[c] / N * 2.5, Ls[c] / N * 1.2, dist.mul(cellStep).add(0.001));
  mat.positionNode = Fn(() => {
    const skirt = positionLocal.y.greaterThan(0.5);
    const xz = select(skirt, positionLocal.xz.mul(GSURF.skirt), positionLocal.xz.mul(uScale)).add(cameraPosition.xz).toVar();
    const level = RV.clipWater(xz).toVar();
    const dist = length(xz.sub(cameraPosition.xz));
    const D = vec3(0).toVar();
    for (let c = 0; c < C; c++) {
      const d = texture(waves.disp[c], xz.div(Ls[c])).level(0);
      D.addAssign(vec3(d.x, d.y, d.z).mul(share(c, dist)));
    }
    // the waves die out in the shallows (no shore swell yet): held under 0.4 of the depth
    const depth = level.sub(RV.clipAt(xz).x).max(0);
    const k = smoothstep(0, 4, depth).mul(uChop);
    return RV.bind(vec3(xz.x.add(D.x.mul(k)), level.add(D.y.mul(k).clamp(depth.mul(-0.4), depth.mul(0.4).add(0.02))), xz.y.add(D.z.mul(k))));
  })();
  mat.colorNode = Fn(() => {
    const P = positionWorld.xz, Vv = normalize(positionWorld.sub(cameraPosition)).toVar(), dist = length(positionWorld.sub(cameraPosition));
    // the slopes and the fold, summed over the cascades the distance still shows
    const sl = vec2(0).toVar(), J = float(1).toVar();
    for (let c = 0; c < C; c++) {
      const s = texture(waves.slope[c], P.div(Ls[c])), d = texture(waves.disp[c], P.div(Ls[c])), w = share(c, dist.mul(0.5));
      sl.addAssign(s.xy.mul(w)); if (c >= 1) J.addAssign(d.w.sub(1).mul(w));
    }
    const level = RF.clipWater(P), ground = RF.clipAt(P).x, depth = level.sub(ground).max(0).toVar();
    const calm = smoothstep(0, 2, depth);
    const n = normalize(vec3(sl.x.negate().mul(calm), 1, sl.y.negate().mul(calm))).toVar();
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
    // whitecaps where the surface folds; a wash of foam where the water thins at the line
    const cap = smoothstep(0.55, 0.15, J).mul(calm);
    const wash = float(1).sub(smoothstep(0.02, 0.35, depth)).mul(0.55);
    col.assign(mix(col, uSkyUp.mul(0.3).add(uSunColor.mul(max(uSunDir.y, 0.05)).mul(0.28)), max(cap, wash).clamp(0, 1)));
    // the edge: the water fades to nothing as it thins, so the line is the sand seen through no water
    return RF.bind(vec4(mix(under, col, smoothstep(0, 0.05, depth)), 1));
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 10; mesh.name = 'gpu-water';
  mesh.onBeforeRender = (r, s, cam) => {
    const above = Math.max(0, cam.position.y - (opts.waterAt ? opts.waterAt(cam.position.x, cam.position.z) : 0));
    uScale.value = Math.max(1, above / 2);
  };
  return { mesh, U: { uScale, uSunDir, uSunColor, uSkyUp, uSkyHz, uChop } };
}
