// Water (W2): the surface the view ray meets first, drawn in the composite pass from the wave field (wavegpu.js).
// Two kinds of water share the optics:
//   - the sea of a source (lakes, rivers, the sea of the wild world): the plane y = sea, displaced by the waves near
//     the camera (the ray is iterated onto the displaced surface), with caustics splatted onto the floor (caustics.js);
//   - water bodies (the game's birdbaths, fountains and puddles): discs on the plane the ground has under them, as the
//     sim puts them (its heights are above the ground), with a bowl for a floor where the game draws a solid basin,
//     and caustics from the ripples' curvature (shallow basins are short of the ripples' focus, where that holds).
//
// The optics, per pixel:
//   - the slope field is filtered to the pixel's footprint (anisotropic, from the ray's own footprint on the plane)
//     as first and second moments, so the waves too small to see become the roughness of the sun's highlight
//     (LEAN mapping, Olano and Baker 2010) and nothing shimmers; waves faded for the frame rate add their variance;
//   - reflection: exact Fresnel for unpolarised light (n = 1.333), the scene by screen-space reflection, the sky table
//     where that misses; the sun through the Gaussian slope distribution of the pixel (mean and variance), widened by
//     the sun's own disc, so a calm birdbath mirrors a sun of the right size;
//   - glints: the sun's highlight is carried by a countable number of mirror facets; where few are expected in a cell
//     of the footprint's size, the cell draws a Poisson-distributed count of them (n / expected times the smooth
//     highlight, mean unchanged), so close water sparkles and far water is smooth. Facets are the size of the ripples
//     at the gravity-capillary minimum (half of 1.7 cm), or the footprint if smaller (at least 2 mm): our estimate;
//   - refraction: the floor along the refracted ray (Snell) from under-water pixels only; Beer-Lambert over the path;
//     the floor's sunlight loses the surface's Fresnel reflection and the water on its way down, and is focused or
//     spread by the caustics;
//   - single scattering from the water itself, foam where the surface folds and at the very edge, rain rings.
import { WAVES } from './waves.js';

export const WATER = {
  absorb: [0.45, 0.075, 0.035], // per metre: a clear lake with a little dissolved matter
  scatter: [0.025, 0.04, 0.045],
  n: 1.333,
  bodies: 8,                    // water bodies drawn at once (the nearest)
  // How far glints spread from the smooth highlight: 1 is the full Poisson spread of the facet count, 0 the smooth
  // highlight. The facet size is our estimate, so the spread is softened by default; this is a choice for the look,
  // and the mean brightness is the same at any setting.
  glint: 0.75,
};

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

// The glints' Poisson table (W3.1): count = the inverse distribution function at u for the mean of the row, rows on a
// square-root scale of the mean (small means, where a cell draws none or one, get the fine rows), columns over u.
// Built once; the GPU reads a texel instead of summing the series per cell per pixel. 512 rows: the row's mean is
// within 0.1% of the pixel's past a mean of 1, columns of u at 1/512.
export const POISSON = { rows: 256, cols: 1024, lamMax: 12 };
export function poissonTableData() {
  const { rows, cols, lamMax } = POISSON, data = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const lam = lamMax * (r / (rows - 1)) ** 2;
    let p = Math.exp(-lam), c = p, n = 0;
    for (let k = 0; k < cols; k++) {
      const u = (k + 0.5) / cols; // the column's midpoint, so u never reaches 1 (the series would run on)
      while (u > c && n < 60) { n += 1; p *= lam / n; c += p; }
      data[r * cols + k] = n;
    }
  }
  return data; // rows x cols, row-major; post.js makes the texture
}

// C: cascades; B: bodies
export function waterGLSL(C, B = WATER.bodies) {
  const cs = [...Array(C).keys()];
  return /* glsl */ `
uniform vec2 uWind; uniform float uWLost, uWPeak, uGlint, uIce;
uniform vec4 uWL; // tile sizes of the cascades
${cs.map((c) => `uniform sampler2D tWD${c}, tWS${c};`).join(' ')}
uniform vec4 uBody[${B}];  // centre x, z, radius, water level at the centre
uniform vec4 uBodyB[${B}]; // ground gradient x, z, floor depth (0: the floor is drawn), kind (0 none, 1 bowl, 2 flat)
uniform vec4 uBodyC[${B}]; // a pond's lobes: phases a, b, and 1 when it has them (sources/sting.js pondEdge)
uniform int uBodies;
// a body's edge at a point's bearing: lobed for a pond, its radius otherwise
float wBodyR(vec4 b, vec4 l, vec2 d) { if (l.z < 0.5) return b.z; float a = atan(d.y, d.x); return b.z * (0.86 + 0.08 * sin(2.0 * a + l.x) + 0.06 * sin(3.0 * a + l.y)); }
const float W_N = ${f(WATER.n)};
const vec3 W_ABS = vec3(${WATER.absorb.map(f).join(', ')});
const vec3 W_SCA = vec3(${WATER.scatter.map(f).join(', ')});
// shallow water (W3.1): the open water's waves fade as the floor comes up, the long ones first (a swell cannot live
// in a metre of water; the chop reaches the beach), and the shore waves of the table take over. wDamp is set per
// pixel before the field is read (wShallow), 1 on deep water and on bodies
vec4 wDamp = vec4(1.0);
void wShallow(float depth) {
  float swell = smoothstep(1.5, 8.0, depth), mid = smoothstep(0.3, 3.0, depth), chop = smoothstep(-0.2, 1.0, depth);
  wDamp = vec4(swell, mid, chop, chop);
}
// the displacement (Dx, h, Dz) and fold (J) summed over cascades, filtered to the footprint (gx, gy: metres per pixel)
vec4 wDisp(vec2 x, vec2 gx, vec2 gy) {
  vec4 d = vec4(0.0, 0.0, 0.0, 1.0);
  ${cs.map((c) => `{ vec4 s = textureGrad(tWD${c}, x / uWL[${c}], gx / uWL[${c}], gy / uWL[${c}]); d.xyz += s.xyz * wDamp[${Math.min(c, 3)}]; d.w += (s.w - 1.0) * wDamp[${Math.min(c, 3)}]; }`).join('\n  ')}
  return d;
}
// mean slope and slope variance (x, z) of the footprint
void wSlope(vec2 x, vec2 gx, vec2 gy, out vec2 m, out vec2 v) {
  m = vec2(0.0); v = vec2(0.0);
  ${cs.map((c) => `{ vec4 s = textureGrad(tWS${c}, x / uWL[${c}], gx / uWL[${c}], gy / uWL[${c}]); float k = wDamp[${Math.min(c, 3)}]; m += s.xy * k; v += max(s.zw - s.xy * s.xy, 0.0) * k * k; }`).join('\n  ')}
  v += vec2(uWLost * 0.5);
}
// slope at a point, finest detail (for curvature)
vec2 wSlopeAt(vec2 x) { vec2 s = vec2(0.0); ${cs.map((c) => `s += textureLod(tWS${c}, x / uWL[${c}], 0.0).xy;`).join(' ')} return s; }
// rain: expanding rings in 0.3 m cells, each with its own time and place, fading as they spread
vec2 wRain(vec2 p, float t, float amt) {
  if (amt <= 0.0) return vec2(0.0);
  vec2 g = p / 0.3; vec2 c0 = floor(g); vec2 s = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = c0 + vec2(i, j); int ci = int(c.x), cj = int(c.y);
    float ph = w2hash01(ci, cj, 93), r0 = fract(t * 0.9 + ph);
    if (w2hash01(ci, cj, 94 + int(floor(t * 0.9 + ph))) > amt) continue;
    vec2 ctr = c + vec2(w2hash01(ci, cj, 95), w2hash01(ci, cj, 96));
    vec2 d = g - ctr; float r = length(d);
    float rr = (r - r0 * 1.6) * 6.0; float ring = sin((r - r0 * 1.6) * 28.0) * exp(-rr * rr) * (1.0 - r0); // squared by hand: pow of a negative base is undefined
    s += r > 1e-3 ? d / r * ring * 0.25 : vec2(0.0);
  }
  return s;
}
// Fresnel reflectance, unpolarised, from air into water
float wFresnel(float ci) {
  ci = clamp(ci, 0.0, 1.0); float st2 = (1.0 - ci * ci) / (W_N * W_N); if (st2 >= 1.0) return 1.0;
  float ct = sqrt(1.0 - st2), rs = (ci - W_N * ct) / (ci + W_N * ct), rp = (W_N * ci - ct) / (W_N * ci + ct);
  return 0.5 * (rs * rs + rp * rp);
}
// Smith's masking for a Gaussian (Beckmann) slope distribution of variance s2 along the direction (Walter et al. 2007)
float wLambda(float cosT, float s2) {
  float a = cosT / max(sqrt(max(1.0 - cosT * cosT, 1e-6)) * sqrt(2.0 * s2), 1e-6);
  return a < 1.6 ? (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a) : 0.0;
}
// a Poisson count with mean lam from a uniform number u: a table (poissonTableData below: the inverse of the
// distribution, rows by the mean on a square-root scale, columns by u) up to a mean of ${POISSON.lamMax}, the normal
// approximation past it. The table is computed once and rides in a layer of the shore table (shorefield.js); a pixel
// reads one texel where it summed a series. Without the shore table (W_SHORE undefined) the series is summed
float wPoisson(float lam, float u, float u2) {
  if (lam > ${POISSON.lamMax.toFixed(1)}) { float g = sqrt(-2.0 * log(max(u, 1e-7))) * cos(6.2831853 * u2); return max(0.0, floor(lam + sqrt(lam) * g + 0.5)); }
#ifdef W_SHORE
  int r = int(sqrt(lam / ${POISSON.lamMax.toFixed(1)}) * ${(POISSON.rows - 1).toFixed(1)} + 0.5), c = min(int(u * ${POISSON.cols.toFixed(1)}), ${POISSON.cols - 1});
  return shorePoisson(r, c);
#else
  float p = exp(-lam), c = p, n = 0.0;
  for (int i = 0; i < 40; i++) { if (u <= c) break; n += 1.0; p *= lam / n; c += p; }
  return n;
#endif
}
`;
}

// placed after the composite's helpers (viewRay, rayDist, skyAt, uViewProj, tColor, tDepth, uSun, ...)
export const WATER_SHADE_GLSL = /* glsl */ `
uniform sampler2D tCaus; uniform vec4 uCaus; // centre x, z, size, on
// screen-space reflection: march the reflected ray, compare with the depth buffer; 0 alpha when it misses
vec4 wSSR(vec3 P, vec3 R, float yb) {
  float t = min(0.4 + 0.02 * length(P - uCamPos), 0.02 + 0.05 * length(P - uCamPos)), tp = 0.0; vec3 q; bool front = true;
  for (int i = 0; i < 24; i++) {
    q = P + R * t;
    vec4 c = uViewProj * vec4(q, 1.0); if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5; if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) break;
    float d = texture(tDepth, uv).r; if (d >= 1.0) { front = true; tp = t; t *= 1.35; continue; }
    float sd = rayDist(uv, d), qd = length(q - uCamPos);
    vec3 S = uCamPos + viewRay(uv) * sd;
    // a hit: the ray has gone from in front of the scene to behind it since the last step, by no more than that step
    // (so it passed through the surface there, not behind a thin thing far in front), on something above the water
    if (qd > sd && front && qd - sd < (t - tp) * 1.5 + 0.02 && S.y > yb + 0.002) {
      float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
      return vec4(texture(tColor, uv).rgb, smoothstep(0.0, 0.08, edge));
    }
    front = qd <= sd; tp = t; t *= 1.35;
  }
  return vec4(0.0);
}
// the point where a view ray through pixel uv meets the plane y = y0 + g.(x - c)
vec3 wPlaneHit(vec2 uv, vec3 c, vec2 g) {
  vec3 v = viewRay(uv); vec3 n = vec3(-g.x, 1.0, -g.y);
  float t = dot(c - uCamPos, n) / dot(v, n); return uCamPos + v * t;
}
#ifdef W_SHORE
// the shore wave at an undisplaced point of the open water (the table's travel time and direction, the clipmap's
// depth), and the cascades' damping for that depth, set as a side effect
ShoreWave wShoreAt(vec2 x0, float fp) {
  float lv = clipWater(x0), dep = lv - clipHeight(x0); wShallow(dep); vec4 sh = shoreAt(x0); vec2 st = shoreState(lv);
  ShoreWave sw = shoreWaves(x0, sh, dep, uTime, fp, st);
  // the sea's edge is the tongue's foot: over the last decimetres of depth the surface takes the tongue's level at
  // the line, so sea and sheet are one surface on one clock
#if SHORE_BEACH
  if (dep < 0.35) { vec3 nG = clipNormal(x0); float tb = sqrt(max(1.0 - nG.y * nG.y, 0.0)) / max(nG.y, 0.05); float lift = shoreEdgeLift(x0, sh, uTime, st, tb); float k = 1.0 - smoothstep(0.0, 0.35, dep); sw.y = mix(sw.y, lift, k); }
#endif
  return sw;
}
ShoreWave gSW; vec4 gDampSea = vec4(1.0); // the sea hit's shore wave and damping, kept for the shading of the same pixel
vec3 gSheet = vec3(0.0); // the swash sheet under a sand pixel (shoreSheet), set by the composite before it shades the sheet as water
#endif
// light under the water: what the floor sends back through it, plus the water's own scattering; D = depth of the
// floor below the surface where the refracted ray meets it, L = the path's length through the water
vec3 wUnder(vec3 floorCol, float D, float L, float cz) {
  float sunUp = max(uSun.y, 0.0);
  // the floor's light split into sun and sky by the light that reaches level ground
  float es = dot(uSunColor, vec3(0.2126, 0.7152, 0.0722)) * sunUp, ek = dot(uSkyUp, vec3(0.2126, 0.7152, 0.0722));
  float share = es / max(es + ek, 1e-6);
  vec3 Ts = refract(-uSun, vec3(0.0, 1.0, 0.0), 1.0 / W_N);
  vec3 ext = W_ABS + W_SCA;
  vec3 sunDown = exp(-ext * D / max(-Ts.y, 0.1)) * (1.0 - wFresnel(sunUp)) * cz;
  vec3 skyDown = exp(-ext * D * 1.2) * 0.934;
  vec3 lit = floorCol * (share * sunDown + (1.0 - share) * skyDown);
  vec3 Tw = exp(-ext * L);
  vec3 amb = uSkyUp / 3.14159 * 0.8 + uSunColor * sunUp / 3.14159 * 0.6;
  return lit * Tw + W_SCA / ext * (1.0 - Tw) * amb;
}
// v: the view ray; P: the point on the surface; x0: the same point before the waves moved it sideways; g: the plane's
// gradient; yb: the water level at P; gx, gy: the footprint; dist: the scene's distance along v
// bodyK: 0 the sea (floor from the scene), 1 bowl, 2 flat basin, 3 a puddle (floor from the scene); bodyD: basin depth
vec3 waterShade(vec2 uv, vec3 v, vec3 P, vec2 x0, vec2 g, vec2 gx, vec2 gy, float dist, vec3 sceneCol, float bodyK, float bodyD, vec3 bodyC, float bodyR) {
  vec3 V = -v; float tw = length(P - uCamPos);
  float fp = sqrt(max(length(gx) * length(gy), 1e-12));
  wDamp = vec4(1.0); float swFoam = 0.0, swLace = 0.0, cloud = 1.0; vec2 swSlope = vec2(0.0);
#ifdef W_SHORE
  if (bodyK == 0.0) { wDamp = gDampSea; swSlope = gSW.slope; swFoam = gSW.foam; swLace = gSW.lace; }
  if (bodyK == 3.0) wDamp = gDampSea; // the swash sheet: glassy, the chop damped for its thickness
  cloud = shoreCloud(P.xz); // the clouds' shadow: the sun's share of the light here
#endif
  vec2 m, sv; wSlope(x0, gx, gy, m, sv);
  vec2 rs = wRain(P.xz, uTime, uRain) * (1.0 - smoothstep(0.02, 0.08, fp)); // rings while rain falls (uRain), not while the ground is still wet (uWet)
  m += rs + g + swSlope; // the plane's own tilt and the shore wave's are part of the mean slope
  vec3 n = normalize(vec3(-m.x, 1.0, -m.y));
  float nv = max(dot(n, V), 1e-3);
  float F = wFresnel(nv);
  // ---- refraction: the floor
  vec3 T = refract(v, n, 1.0 / W_N);
  vec3 floorCol; float D, L; vec3 Pb;
  if (bodyK == 1.0 || bodyK == 2.0) {
    // a basin the game draws solid: its floor is a bowl (1) or flat with a rounded edge (2) under the water level
    float t = bodyD / max(-T.y, 0.05);
    for (int i = 0; i < 4; i++) {
      vec3 q = P + T * t; float r = length(q.xz - bodyC.xz) / bodyR;
      float d = bodyK == 1.0 ? bodyD * max(1.0 - r * r, 0.0) : bodyD * (1.0 - smoothstep(0.82, 1.0, r));
      float yq = bodyC.y + dot(g, q.xz - bodyC.xz) - d; // the floor follows the ground's plane like the water
      t += (q.y - yq) / max(-T.y, 0.05) * 0.9;
    }
    t = max(t, 0.0); Pb = P + T * t; D = max(P.y - Pb.y, 0.0); L = t;
    // the floor's colour and light: the basin's drawn top under that point
    vec4 c = uViewProj * vec4(Pb.x, P.y - 0.006, Pb.z, 1.0); vec2 fuv = clamp(c.xy / c.w * 0.5 + 0.5, vec2(0.001), vec2(0.999));
    floorCol = texture(tColor, fuv).rgb;
    float fd = texture(tDepth, fuv).r; if (fd >= 1.0 || abs(rayDist(fuv, fd) - length(vec3(Pb.x, P.y - 0.006, Pb.z) - uCamPos)) > 0.03 + 0.01 * tw) floorCol = sceneCol;
  } else {
    vec2 ruv = clamp(uv + n.xz * 0.06 * clamp((dist - tw) * 0.25, 0.0, 1.0) * vec2(1.0, uRes.x / uRes.y) * 0.5, vec2(0.001), vec2(0.999));
    float rd = texture(tDepth, ruv).r; float rdist = rd >= 1.0 ? 1e9 : rayDist(ruv, rd);
    Pb = uCamPos + viewRay(ruv) * min(rdist, tw + 400.0);
    float yAt = P.y + dot(g, Pb.xz - P.xz);
    if (Pb.y > yAt - 0.0005) { ruv = uv; Pb = uCamPos + v * min(dist, tw + 400.0); }
    floorCol = texture(tColor, ruv).rgb;
    D = max(P.y + dot(g, Pb.xz - P.xz) - Pb.y, 0.0); L = D / max(-T.y, 0.05);
#ifdef W_SHORE
    if (bodyK == 3.0) { D = gSheet.x; L = D / max(-T.y, 0.05); } // the sheet's thickness is known exactly; the depth buffer's would step
#endif
  }
  // ---- caustics: splatted for the sea, from the ripples' curvature for bodies
  float cz = 1.0;
  if (bodyK == 0.0) {
    // the splat round the focus, faded out radially over its outer third; past it, the ripples' curvature stands in
    // (the analytic caustic below, held to the first 1.5 m of depth), so the splat's region has no edge to see
    vec2 cu = (Pb.xz - uCaus.xy) / uCaus.z + 0.5;
    float rr = length(cu - 0.5) * 2.0, inSplat = uCaus.w > 0.5 ? 1.0 - smoothstep(0.62, 0.95, rr) : 0.0;
    float splat = inSplat > 0.0 ? min(texture(tCaus, clamp(cu, vec2(0.001), vec2(0.999))).r, 400.0) : 1.0; // a focus can sum past half-float range
    float an = 1.0;
    if (inSplat < 1.0 && D > 0.0005) {
      vec2 q = Pb.xz; float e = 0.02;
      vec2 s0 = wSlopeAt(q), sxp = wSlopeAt(q + vec2(e, 0.0)), szp = wSlopeAt(q + vec2(0.0, e));
      mat2 H = mat2((sxp - s0) / e, (szp - s0) / e);
      vec3 L0 = -uSun; float de = 0.01;
      vec3 r0 = refract(L0, normalize(vec3(-s0.x, 1.0, -s0.y)), 1.0 / W_N), rx = refract(L0, normalize(vec3(-s0.x - de, 1.0, -s0.y)), 1.0 / W_N), rz = refract(L0, normalize(vec3(-s0.x, 1.0, -s0.y - de)), 1.0 / W_N);
      vec2 o0 = r0.xz / -r0.y, ox = rx.xz / -rx.y, oz = rz.xz / -rz.y;
      mat2 M = mat2((ox - o0) / de, (oz - o0) / de);
      mat2 J = mat2(1.0) + min(D, 1.5) * M * H;
      an = mix(1.0, clamp(1.0 / max(abs(determinant(J)), 0.35), 0.0, 2.5), exp(-tw * 0.02) * smoothstep(0.0, 0.3, D));
    }
    cz = mix(an, splat, inSplat);
  } else if (D > 0.0005) {
    // the sun's refracted offset on the floor as a function of slope, linearised; with the slope's derivative (the
    // curvature) this is the Jacobian of the map from the surface to the floor; brightness = 1 / |det J|
    vec2 q = Pb.xz; float e = 0.004;
    vec2 s0 = wSlopeAt(q), sxp = wSlopeAt(q + vec2(e, 0.0)), szp = wSlopeAt(q + vec2(0.0, e));
    mat2 H = mat2((sxp - s0) / e, (szp - s0) / e);
    vec3 L0 = -uSun; float de = 0.01;
    vec3 r0 = refract(L0, normalize(vec3(-s0.x, 1.0, -s0.y)), 1.0 / W_N), rx = refract(L0, normalize(vec3(-s0.x - de, 1.0, -s0.y)), 1.0 / W_N), rz = refract(L0, normalize(vec3(-s0.x, 1.0, -s0.y - de)), 1.0 / W_N);
    vec2 o0 = r0.xz / -r0.y, ox = rx.xz / -rx.y, oz = rz.xz / -rz.y;
    mat2 M = mat2((ox - o0) / de, (oz - o0) / de);
    // held to the first 12 cm of depth and to 2.5x: past that the focus is finer than a pixel and reads as glitter; and
    // faded with distance, where a pixel spans many ripples and sees only their average
    mat2 J = mat2(1.0) + min(D, 0.12) * M * H;
    cz = mix(1.0, clamp(1.0 / max(abs(determinant(J)), 0.35), 0.0, 2.5), exp(-tw * 0.2));
  }
  vec3 under = wUnder(floorCol, D, L, cz * cloud);
  // ---- reflection: the scene where SSR finds it, else the sky
  vec3 R = reflect(v, n); R.y = abs(R.y);
  vec4 ss = wSSR(P, R, P.y);
  vec3 refl = mix(skyAt(R), ss.rgb, ss.a);
  // ---- the sun: the slope distribution of the footprint (mean m, variance sv), widened by the sun's disc
  vec3 Lsun = uSun; float sunOn = step(0.0, Lsun.y);
  vec3 Hh = normalize(V + Lsun);
  vec2 sh = vec2(-Hh.x, -Hh.z) / max(Hh.y, 1e-3) - m;
  vec2 s2 = sv + vec2(${((0.00465 / 2) ** 2 / 4).toExponential(3)}) + vec2(1e-7); // the sun's disc, radius 0.00465 rad: half that in half-vector slope
  float P22 = exp(-0.5 * (sh.x * sh.x / s2.x + sh.y * sh.y / s2.y)) / (6.2831853 * sqrt(s2.x * s2.y));
  float ch = max(Hh.y, 1e-3), Dm = P22 / (ch * ch * ch * ch);
  float sav = 0.5 * (s2.x + s2.y);
  float G = 1.0 / (1.0 + wLambda(max(V.y, 1e-3), sav) + wLambda(max(Lsun.y, 1e-3), sav));
  float Fh = wFresnel(dot(V, Hh));
  vec3 spec = uSunColor * Fh * Dm * G / (4.0 * max(V.y, 1e-3)) * sunOn * cloud;
  // glints: facets of size l (the short ripples that carry most of the curvature) in square cells anchored to the
  // world, at the two power-of-two sizes round the footprint, blended by the fraction between them; each cell redraws
  // its Poisson count about three times a second from its own start, fading between draws, so it twinkles; uGlint
  // softens the spread toward the smooth highlight (1: the full spread; the mean is exact at any setting)
  float l = clamp(fp, 0.002, 0.5 * uWPeak);
  float pc = P22 * ${(Math.PI * (0.00465 / 2) ** 2).toExponential(4)} / (ch * ch * ch) / (l * l); // per square metre: facets times the share in the sun's cone
  float lf = log2(max(fp, l)), l0 = floor(lf), gm = 0.0;
  if (uGlint > 0.0 && pc * exp2(2.0 * l0) < 60.0) {
    for (int j = 0; j < 2; j++) {
      float sz = exp2(l0 + float(j)), lam = max(pc * sz * sz, 1e-6);
      vec2 cell = floor(x0 / sz); int cx = int(cell.x), cz2 = int(cell.y), lv = int(l0) + j + 64;
      float tt = uTime * 3.0 + w2hash01(cx, cz2, 403 + lv) * 64.0, it = floor(tt);
      float n0 = wPoisson(lam, w2hash01(cx, cz2, 410 + lv * 977 + int(it)), w2hash01(cx, cz2, 411 + lv * 977 + int(it)));
      float n1 = wPoisson(lam, w2hash01(cx, cz2, 410 + lv * 977 + int(it) + 1), w2hash01(cx, cz2, 411 + lv * 977 + int(it) + 1));
      gm += (j == 0 ? 1.0 - (lf - l0) : lf - l0) * mix(n0, n1, smoothstep(0.0, 1.0, tt - it)) / lam;
    }
    spec *= mix(1.0, gm, uGlint);
  }
  vec3 col = mix(under, refl, F) + spec;
  // ice (W3, deep winter): a pale, rough sheet over the water, the sky softly in it, no glints, no floor
  if (uIce > 0.0) { float ic = smoothstep(0.0, 0.6, uIce) * (1.0 - 0.5 * step(0.5, bodyK) * step(bodyK, 2.5)); vec3 iceCol = vec3(0.72, 0.8, 0.88) * (uSkyUp * 0.7 + uSunColor * max(uSun.y, 0.0) * 0.25) * (0.9 + 0.1 * w2noise(x0 / 1.5, 302)); col = mix(col, iceCol + skyAt(R) * 0.08, ic); }
  // ---- foam: where the surface folds, and at the very edge of the sea
  vec4 dsp = wDisp(x0, gx, gy);
  float fold = 1.0 - smoothstep(0.15, 0.55, dsp.w);
  float sunUp = max(uSun.y, 0.0);
  vec3 amb = uSkyUp / 3.14159 * 0.8 + uSunColor * sunUp / 3.14159 * 0.6;
  float fm = fold * smoothstep(-0.2, 0.6, w2noise(x0 / 0.3, 99));
#ifdef W_SHORE
  if (bodyK == 3.0) { fm = max(fm, max(gSheet.y, gSheet.z)); } // the swash sheet: its lace edge, the white behind it
#endif
  if (bodyK == 0.0) {
    // whitewater on the breakers' faces and the lace they leave behind: one pattern of three scales, covered to a
    // share set by the foam's strength (a crest nearly solid, the surf zone behind it in patches, the lace sparse)
    float pat = 0.5 + 0.5 * (w2noise(x0 / 0.7, 615) * 0.45 + w2noise(x0 / 3.0 + uTime * 0.03, 616) * 0.35 + w2noise(x0 / 0.18 - uTime * 0.1, 619) * 0.2);
    float wf = clamp(swFoam, 0.0, 1.0), lf = clamp(swLace, 0.0, 1.0);
    fm = max(fm, smoothstep(1.0 - 0.75 * wf, 1.15 - 0.75 * wf, pat) * (0.6 + 0.4 * wf));
    fm = max(fm, smoothstep(1.0 - 0.5 * lf, 1.1 - 0.5 * lf, pat) * 0.45);
  }
  col = mix(col, amb * 0.9 + uSunColor * sunUp * 0.25 * cloud, fm * 0.7);
  if (uDebug > 1.5 && uDebug < 5.5) col = vec3(D / 3.0, F, ss.a) * 2.0;
#ifdef W_SHORE
  if (uDebug > 3.5 && uDebug < 5.5) { vec4 shd = shoreAt(x0); col = vec3(fract(-shd.x / 10.0) * 0.8, clamp(swFoam, 0.0, 1.0), 0.5 + 2.0 * swSlope.x); }
#endif
  if (uDebug > 2.5 && uDebug < 5.5) col = vec3(clamp(L / 5.0, 0.0, 1.0), sqrt(sv.x + sv.y) * 4.0, cz / 3.0) * 2.0;
  return col;
}
// the sea: the plane hit, then iterated onto the displaced surface (near the camera, where the waves are larger than
// a pixel); returns the distance along v, the undisplaced point in x0
float wSeaHit(vec2 uv, vec3 v, float yb, out vec2 x0, out vec2 gx, out vec2 gy) {
  vec3 P = wPlaneHit(uv, vec3(0.0, yb, 0.0), vec2(0.0));
  float t = length(P - uCamPos);
  gx = wPlaneHit(uv + vec2(1.0 / uRes.x, 0.0), vec3(0.0, yb, 0.0), vec2(0.0)).xz - P.xz;
  gy = wPlaneHit(uv + vec2(0.0, 1.0 / uRes.y), vec3(0.0, yb, 0.0), vec2(0.0)).xz - P.xz;
  gx = clamp(gx, vec2(-50.0), vec2(50.0)); gy = clamp(gy, vec2(-50.0), vec2(50.0));
  x0 = P.xz;
  float near = 1.0 - smoothstep(0.08, 0.6, sqrt(length(gx) * length(gy)) / max(uWL.x, 1e-3) * 8.0);
  float swY = 0.0;
#ifdef W_SHORE
  gSW = wShoreAt(P.xz, sqrt(length(gx) * length(gy))); gDampSea = wDamp; swY = gSW.y; // the breakers lift the surface; the damping is set for this depth
#else
  wDamp = vec4(1.0);
#endif
  if (near > 0.0 || abs(swY) > 0.005) {
    for (int i = 0; i < 4; i++) {
      vec3 q = uCamPos + v * t;
      vec4 d = wDisp(x0, gx, gy); x0 = q.xz - d.xz * near; d = wDisp(x0, gx, gy);
      float f = q.y - (yb + d.y * near + swY);
      t += clamp(f / max(-v.y, 0.02), -2.0, 2.0) * 0.85;
    }
  }
  return t;
}
`;
