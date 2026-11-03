// Water at the sea level of the source (lakes, rivers, the sea), drawn in the composite pass where the view ray meets
// the plane before anything else. No mesh: the surface is the plane y = sea, its relief lives only in the normal.
//
// The optics are physical where it is cheap enough to be:
//   - waves: six directional trains with deep-water dispersion (speed sqrt(g lambda / 2 pi)), plus two layers of
//     capillary ripple, plus rain rings when it rains; trains smaller than about two pixels are faded out and their
//     slope variance moved into the roughness of the sun's glint (LEAN-style), so distance does not shimmer;
//   - reflection: Fresnel (Schlick, n = 1.333), screen-space reflection of the scene, the sky table where that misses,
//     and the sun as a GGX highlight;
//   - refraction: the floor is looked up along the refracted ray (Snell), offset by the surface normal, only from
//     pixels that are really under water;
//   - absorption and scattering: Beer-Lambert over the refracted path length to the floor (red goes first), plus
//     single-scattered sky and sun light from the water itself;
//   - caustics: the sun refracted by the large waves, focused onto the floor: the brightness is the inverse of the
//     area change of a small patch of light from the surface to the floor (the Jacobian of the refracted map),
//     computed per pixel from the same wave field, fading with depth;
//   - foam where the water is a few centimetres deep at the shore.
export const WATER = {
  absorb: [0.45, 0.075, 0.035], // per metre: a clear lake with a little dissolved matter
  scatter: [0.025, 0.04, 0.045],
  n: 1.333,
  waves: [ // wavelength m, amplitude m, direction (radians from the wind), phase
    [5.1, 0.045, 0.0, 0.0], [3.2, 0.028, 0.6, 1.3], [2.1, 0.018, -0.5, 2.9],
    [1.25, 0.010, 0.9, 4.1], [0.74, 0.006, -1.1, 5.6], [0.43, 0.0035, 0.3, 0.7],
  ],
};

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

// wave functions only; waterShade (below) is placed after the composite's helpers
export const WATER_GLSL = /* glsl */ `
uniform vec2 uWind; // direction (unit) * strength 0..1
const float W_N = ${f(WATER.n)};
const vec3 W_ABS = vec3(${WATER.absorb.map(f).join(', ')});
const vec3 W_SCA = vec3(${WATER.scatter.map(f).join(', ')});
// slope (dh/dx, dh/dz) of the wave trains at p, time t; fp = pixel footprint in metres; returns faded-out variance in .z
vec3 wSlope(vec2 p, float t, float fp, bool bigOnly) {
  vec2 wd = length(uWind) > 0.001 ? normalize(uWind) : vec2(1.0, 0.0); float ws = 0.35 + 0.65 * length(uWind);
  vec2 s = vec2(0.0); float lost = 0.0;
  ${WATER.waves.map(([L, A, D, P], i) => `{
    float ang = ${f(D)}; vec2 dir = vec2(wd.x * cos(ang) - wd.y * sin(ang), wd.x * sin(ang) + wd.y * cos(ang));
    float k = 6.2831853 / ${f(L)}, w = sqrt(9.81 * k);
    float vis = 1.0 - smoothstep(${f(L)} * 0.12, ${f(L)} * 0.35, fp);
    float a = ${f(A)} * ws * k; // slope amplitude
    ${i >= 4 ? 'if (!bigOnly) {' : '{'}
      s += dir * a * cos(k * dot(dir, p) - w * t + ${f(P)}) * vis;
      lost += a * a * 0.5 * (1.0 - vis);
    }
  }`).join('\n  ')}
  if (!bigOnly) {
    float vc = 1.0 - smoothstep(0.012, 0.04, fp);
    vec3 n1 = w2noised(p / 0.11 + wd * t * 0.9, 91); vec3 n2 = w2noised(p / 0.045 - wd.yx * t * 1.4, 92);
    vec2 cap = (n1.yz / 0.11 * 0.0035 + n2.yz / 0.045 * 0.0012) * ws;
    s += cap * vc; lost += dot(cap, cap) * (1.0 - vc) * 0.5;
  }
  return vec3(s, lost);
}
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
    float ring = sin((r - r0 * 1.6) * 28.0) * exp(-pow((r - r0 * 1.6) * 6.0, 2.0)) * (1.0 - r0);
    s += r > 1e-3 ? d / r * ring * 0.25 : vec2(0.0);
  }
  return s;
}
// floor brightness from the refracted sun focused by the big waves: 1 / |det J| of x -> x + D * offset(n(x))
float wCaustic(vec2 p, float depth, float t, vec3 sun) {
  if (depth <= 0.0) return 1.0;
  float e = 0.06;
  vec2 s0 = wSlope(p, t, 0.0, true).xy, sx = wSlope(p + vec2(e, 0.0), t, 0.0, true).xy, sz = wSlope(p + vec2(0.0, e), t, 0.0, true).xy;
  vec3 L = -sun;
  vec3 r0 = refract(L, normalize(vec3(-s0.x, 1.0, -s0.y)), 1.0 / W_N), rx = refract(L, normalize(vec3(-sx.x, 1.0, -sx.y)), 1.0 / W_N), rz = refract(L, normalize(vec3(-sz.x, 1.0, -sz.y)), 1.0 / W_N);
  vec2 o0 = r0.xz / -r0.y * depth, ox = rx.xz / -rx.y * depth, oz = rz.xz / -rz.y * depth;
  mat2 J = mat2(1.0 + (ox.x - o0.x) / e, (ox.y - o0.y) / e, (oz.x - o0.x) / e, 1.0 + (oz.y - o0.y) / e);
  float a = abs(determinant(J));
  return clamp(1.0 / max(a, 0.05), 0.0, 6.0);
}
`;

export const WATER_SHADE_GLSL = /* glsl */ `
float wD_GGX(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (3.14159265 * d * d); }
// screen-space reflection: march the reflected ray, compare with the depth buffer; 0 alpha when it misses
vec4 wSSR(vec3 P, vec3 R) {
  float t = 0.4 + 0.02 * length(P - uCamPos); vec3 q;
  for (int i = 0; i < 20; i++) {
    q = P + R * t;
    vec4 c = uViewProj * vec4(q, 1.0); if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5; if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) break;
    float d = texture(tDepth, uv).r; if (d >= 1.0) { t *= 1.35; continue; }
    float sd = rayDist(uv, d), qd = length(q - uCamPos);
    vec3 S = uCamPos + viewRay(uv) * sd;
    // a hit: the ray has just gone behind something that stands above the water, within a thickness that grows
    // slowly with the step (a thin shell), never on the water's own floor or on ground far behind
    if (qd > sd && qd - sd < 0.04 * t + 0.08 && S.y > uSea + 0.01) {
      float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
      return vec4(texture(tColor, uv).rgb, smoothstep(0.0, 0.08, edge));
    }
    t *= 1.35;
  }
  return vec4(0.0);
}
vec3 waterShade(vec2 uv, vec3 v, float tw, float dist, vec3 sceneCol) {
  vec3 P = uCamPos + v * tw;
  float fp = tw * 2.0 / (uRes.y * abs(v.y) + 1e-3) * 0.8; // footprint of a pixel on the plane, roughly
  vec3 sl = wSlope(P.xz, uTime, fp, false);
  vec2 rs = wRain(P.xz, uTime, uWet) * (1.0 - smoothstep(0.02, 0.08, fp));
  vec3 n = normalize(vec3(-sl.x - rs.x, 1.0, -sl.y - rs.y));
  float rough = clamp(sqrt(0.004 + sl.z * 2.0), 0.03, 0.6);
  vec3 V = -v;
  float nv = max(dot(n, V), 1e-3);
  float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  // refraction: the floor along the refracted ray, from under-water pixels only
  vec3 T = refract(v, n, 1.0 / W_N);
  vec2 ruv = clamp(uv + (n.xz) * 0.06 * clamp((dist - tw) * 0.25, 0.0, 1.0) * vec2(1.0, uRes.x / uRes.y) * 0.5, vec2(0.001), vec2(0.999));
  float rd = texture(tDepth, ruv).r; float rdist = rd >= 1.0 ? 1e9 : rayDist(ruv, rd);
  vec3 rv = viewRay(ruv);
  vec3 Pb = uCamPos + rv * min(rdist, tw + 400.0);
  if (Pb.y > uSea - 0.002) { ruv = uv; Pb = uCamPos + v * min(dist, tw + 400.0); }
  vec3 floorCol = texture(tColor, ruv).rgb;
  float D = max(uSea - Pb.y, 0.0);              // vertical depth of the floor below the surface
  float pathL = D / max(-T.y, 0.05);            // the refracted path through the water
  // caustics on the floor, lit by the sun through the surface
  float sunUp = max(uSun.y, 0.0);
  float cz = wCaustic(Pb.xz, D, uTime, uSun);
  float cfade = exp(-D * 0.35) * smoothstep(0.0, 0.06, D) * (1.0 - smoothstep(30.0, 120.0, tw));
  floorCol *= mix(1.0, cz, cfade * smoothstep(0.0, 0.15, sunUp));
  // through the water: absorbed on the way up, plus light scattered by the water toward the eye
  vec3 ext = W_ABS + W_SCA;
  vec3 Tw = exp(-ext * pathL);
  vec3 amb = uSkyUp / 3.14159 * 0.8 + uSunColor * sunUp / 3.14159 * 0.6;
  vec3 inW = W_SCA / ext * (1.0 - Tw) * amb;
  vec3 under = floorCol * Tw + inW;
  // reflection: the scene where SSR finds it, else the sky; the sun as a GGX highlight
  vec3 R = reflect(v, n); R.y = abs(R.y);
  vec4 ss = wSSR(P, R);
  vec3 refl = mix(skyAt(R), ss.rgb, ss.a);
  vec3 H = normalize(V + uSun);
  float nl = max(dot(n, uSun), 0.0), nh = max(dot(n, H), 0.0);
  vec3 spec = uSunColor * wD_GGX(nh, rough) * F * nl / (4.0 * nv * max(nl, 1e-3)) * nl;
  vec3 col = mix(under, refl, F) + spec;
  // foam at the very edge
  float fz = 1.0 - smoothstep(0.0, 0.05 + 0.04 * w2noise(P.xz / 0.4 + uTime * 0.1, 97), D);
  float fm = fz * smoothstep(-0.2, 0.6, w2noise(P.xz / 0.12 - uTime * 0.05, 98));
  col = mix(col, amb * 0.9 + uSunColor * sunUp * 0.25, fm * 0.7);
  if (uDebug > 1.5) col = vec3(D / 3.0, F, ss.a) * 2.0;
  if (uDebug > 2.5) col = vec3(clamp(pathL / 5.0, 0.0, 1.0), Tw.r, cz / 3.0) * 2.0;
  return col;
}
`;
