// Water 3: the coast's clock. The surf's two trains near a shore (after Ultra-Water's shore waves, MIT, Humpalumps:
// a train is set by its wavelength in deep water, its speed and its steepness; its phase runs on the shore table's
// travel time, so its crests slow and bend round the bathymetry), and the shoreline's height, one function read by
// the water's mesh (its surface over the sand), the water's pixels (no water where this height is under the sand)
// and the sand (wet only where and since this height was over it).
//
// Everything is read at the point itself; nothing looks up a nearest point on the shore (that jumped where two
// stretches of shore were equally near: the zigzag along the line), and nothing on or above the line reads the table's
// per-texel direction (it steps there: the teeth).
import { SHORE } from '../shorefield.js';

export const SWASH = {
  coast: [180, 420],   // metres from the shore: the coast's trains carry the swell within the first, none past the second
  lee: 0.55,           // the share of the surf a coast in the swell's lee gets
  second: [0.61, 0.45], // the second train: its wavelength and amplitude against the first's
  up: 0.3,             // the share of the period the shoreline climbs; it drains over the rest, at the line as the next crest arrives
  memory: 7,           // waves the sand remembers
  gloss: 1.5, dark: 45, // seconds: the shine of sand the water has just left, and its darkness
};

// The uniforms: uSurf = (amplitude m, wavelength m, speed, steepness) of the first train (the panel's 'Shore waves'),
// uSurfX = (foam charge, the shoreline's lead in seconds, -, -), uWTime the water's clock (its time scale), uSwDir the far swell's direction.
// Needs NOISE_GLSL (w2noise) and the shore table's glsl (shoreAt, gShoreKnow).
export const SWASH_GLSL = /* glsl */ `
uniform vec4 uSurf, uSurfX; uniform float uWTime; uniform vec2 uSwDir;
const float SW3_LEE = ${SWASH.lee.toFixed(2)};
// the coast here: gNear the share of the swell the coast's trains carry, gExpo the coast's exposure to the swell,
// gDir toward the shore, gPn the phase noise, gTau the travel time; false where no table knows the point
float gNear = 0.0, gExpo = 1.0, gPn = 0.0, gTau = 0.0, gShoreD = 1e4; vec2 gDir = vec2(0.0);
float sw3Noise(vec2 p) { return w2noise(p / 240.0, 611) * 5.0 + w2noise(p / 70.0, 612) * 1.6; }
bool sw3Ctx(vec2 p) {
  gNear = 0.0;
  vec4 sh = shoreAt(p); float coh = gShoreKnow > 0.0 ? length(sh.yz) : 0.0;
  if (gShoreKnow <= 0.0 || abs(sh.x) > 9.0e3) return false;
  // nothing here may switch on or off from one texel to the next (the coherence does, near the line): the trains'
  // share fades with the distance only, the direction and the exposure are weighted by the coherence, so where it is
  // weak they fade instead of stepping
  gDir = coh > 1e-4 ? sh.yz / coh : vec2(0.0); gTau = sh.w; gShoreD = sh.x;
  gNear = gShoreKnow * (1.0 - smoothstep(${SWASH.coast[0].toFixed(1)}, ${SWASH.coast[1].toFixed(1)}, -sh.x));
  gExpo = mix(SW3_LEE, 1.0, smoothstep(-0.3, 0.7, dot(uSwDir, sh.yz)));
  gPn = sw3Noise(p);
  return gNear > 0.0;
}
// train i: its angular frequency (from its deep-water wavelength, times the speed) and phase at travel time tau
float sw3Omega(int i) { return sqrt(9.81 * 6.2831853 / (uSurf.y * (i == 0 ? 1.0 : ${SWASH.second[0].toFixed(2)}))) * uSurf.z; }
float sw3Phase(int i, float t, float tau, float pn) { return sw3Omega(i) * (t + tau) + pn * (i == 0 ? 1.0 : 1.37) + float(i) * 2.1; }
float sw3Period() { return 6.2831853 / sw3Omega(0); }
// the sets: slowly drifting groups of bigger waves along the coast
float sw3Group(vec2 p, float t) { return 0.45 + 0.55 * (0.5 + 0.5 * w2noise(p / 250.0 + vec2(t * 0.021, -t * 0.017), 613)); }
// ---- the shoreline (the swash). Every sea beach; exposure from the way the sand faces (grad: the ground's uphill
// gradient), the clock's noise from the point itself, the crest of the first train reaching the line (its phase at
// travel time 0) starting each climb
const float SW3_UP = ${SWASH.up.toFixed(2)};
#define SW3_EARLY uSurfX.y // seconds: the shoreline's climb starts this much sooner still (the panel's 'Shore water lead')
const float SW3_LEAD = 0.58; // radians: the bore (the crest's foam charge, running ahead of it) reaches the line this much before the crest
void sw3Beach(vec2 p, vec2 grad) {
  gNear = 1.0;
  float gl = length(grad); vec2 up = gl > 1e-4 ? grad / gl : vec2(0.0);
  gExpo = mix(SW3_LEE, 1.0, smoothstep(-0.3, 0.7, dot(uSwDir, up)));
  gPn = sw3Noise(p);
}
// the run-up limit (Stockdon et al. 2006) on slope tb for wave height H and period T, held to the crest's height:
// higher on a gentle beach for the same climb time, so the water runs further and faster the flatter the sand
float sw3Runup(float tb, float H, float T) { float HL = H * 9.81 * T * T / 6.2831853; return min(1.1 * (0.35 * tb * sqrt(HL) + 0.5 * sqrt(HL * (0.563 * tb * tb + 0.004))), 0.575 * H); }
// the reach of the wave whose crest reached the line at tc (cycle cyc): the set it came in, fingers along the shore
float sw3Reach(vec2 p, float tb, float tc, float cyc) {
  float fing = 0.85 + 0.3 * w2noise(p / 1.6 + vec2(cyc * 7.3, cyc * 3.1), 621) + 0.08 * w2noise(p / 0.5 + vec2(cyc * 1.7, -cyc * 2.9), 625);
  return sw3Runup(tb, 2.0 * uSurf.x * gExpo * sw3Group(p, tc), sw3Period()) * fing;
}
// the shoreline's climb and drain over one wave (s: the fraction of the period since the crest reached the line)
float sw3Shape(float s) { return s < SW3_UP ? sin(s / SW3_UP * 1.5707963) : cos((s - SW3_UP) / (1.0 - SW3_UP) * 1.5707963); }
// the shoreline's height over the still water at p now, and s
float sw3Shore(vec2 p, float tb, float t, out float s) {
  float T0 = sw3Period(), f = (sw3Omega(0) * (t + SW3_EARLY) + gPn + SW3_LEAD) / 6.2831853, cyc = floor(f); s = f - cyc;
  return sw3Reach(p, tb, t - s * T0, cyc) * sw3Shape(s);
}
// the sand at p, hgt over the still water: (darkness 0..1, gloss 0..1, covered 0/1): wet from when the shoreline rose
// past it (never before) to when it fell back past it, in each of the last waves; drying from then
vec3 sw3Wet(vec2 p, float hgt, float tb, float t) {
  if (hgt <= 0.0) return vec3(1.0, 1.0, 1.0);
  float T0 = sw3Period(), f = (sw3Omega(0) * (t + SW3_EARLY) + gPn + SW3_LEAD) / 6.2831853, cyc = floor(f), s = f - cyc;
  vec3 o = vec3(0.0);
  for (int k = 0; k < ${SWASH.memory}; k++) {
    float R = sw3Reach(p, tb, t - (s + float(k)) * T0, cyc - float(k));
    if (hgt >= R) continue;
    float q = hgt / R, sa = SW3_UP * asin(q) / 1.5707963, sl = SW3_UP + (1.0 - SW3_UP) * acos(q) / 1.5707963;
    float now = s + float(k); // this wave's clock, in periods since its crest reached the line
    if (now < sa) continue;                        // its water has not reached the point yet
    if (now <= sl) return vec3(1.0, 1.0, 1.0);     // under it now
    float age = (now - sl) * T0;
    o.x = max(o.x, exp(-age / ${SWASH.dark.toFixed(1)})); o.y = max(o.y, exp(-age / ${SWASH.gloss.toFixed(2)}));
  }
  return o;
}
// ---- the water's surface near the shore: one height for the water's mesh (water3/surface.js) and test/shorelab.
// py: the surface's height from the waves at xz; grad: the floor's uphill gradient; fl: a river's share. Over the
// sand, a sheet at the shoreline's height (thin at its tip, under the sand past it); in the last half metre of water
// the surface is lifted to the same thin sheet where the waves would leave less. The mesh is never raised further:
// the water and the swash merge per pixel (water3/surface.js: the water near the line where the swash is up is drawn
// as a thin sheet, not faded out)
float sw3EdgeY(vec2 xz, float level, float bed, float py, vec2 grad, float t, float fl) {
  float depth = level - bed;
  if (depth >= 0.5 || depth <= -3.0) return py;
  sw3Beach(xz, grad); gExpo *= 1.0 - fl; // no swash up a river's banks
  float s, th = level + sw3Shore(xz, length(grad), t, s) - bed;
  float sheet = bed + (th > 0.0 ? min(0.12, 0.012 + 0.3 * th) : max(th, -0.15));
  return depth < 0.0 ? sheet : max(py, sheet);
}
// the shoreline's own foam (the water's surface, and the foam field, so it lasts as long as the water's own foam):
// the bore's foam handed over at the line, up the sand with the swash (from the line to the tip), back down with it
// as it drains, then on down into the water as far as it has drained back, the shore side going first; thinner where
// the incoming bore's foam is. depth: of the still water (< 0 on the sand); th: the water over the floor with the
// shoreline; s: the swash's clock (sw3Shore); wave: the bore's own foam here
float sw3ShoreFoam(float depth, float th, float s, float wave) {
  if (th <= 0.0) return 0.0;
  float zeta = th - depth, p = s < SW3_UP ? 0.0 : (s - SW3_UP) / (1.0 - SW3_UP);
  float top = zeta - 0.75 * smoothstep(0.3, 1.0, p), reach = 0.75 * smoothstep(0.15, 1.0, p);
  // soft edges both ways (the foam field holds it in half-metre texels: a hard edge drew their steps), and only thinned
  // where the bore's own foam is, not cut out, so the two overlap and join instead of leaving a line between them
  return smoothstep(0.0, 0.12, top + depth) * (1.0 - smoothstep(0.35 * reach, reach + 0.1, depth)) * smoothstep(0.0, 0.06, s)
       * (s < SW3_UP ? 0.9 : mix(0.85, 0.5, p)) * (1.0 - 0.4 * clamp(wave, 0.0, 1.0));
}
// the waves' sideways shift near the line, faded out: a trough must not pull the water's edge back off the sand
float sw3EdgeShift(float depth) { return smoothstep(0.4, 2.0, depth); }
`;

// The surf's trains on the water (water3/surface.js, vertex): after Ultra-Water's shoreWaves (MIT, Humpalumps).
// Two trains (the second at 0.61 of the wavelength, 0.45 of the height); phase w (tau + t) with the local wavenumber
// w / sqrt(g depth); Green's law shoaling; the height held to 0.42 of the depth; a breaking crest leans forward before
// it collapses (the lean and the trains' Gerstner pinch share one budget, so the surface never folds over), hands up to
// half its height to a foam charge running ahead, then leaves backwash and the residual foam of the last breakers
// (a deterministic memory of four, so it builds over a set); each train fades where it is only a few grid cells long.
// Returns the displacement; gCoastSlope its slope, gCoastFoam (whitewater, lace, the surf zone's churn).
export const SURF_GLSL = /* glsl */ `
vec2 gCoastSlope = vec2(0.0); vec3 gCoastFoam = vec3(0.0);
vec3 w3Coast(vec2 p, float depth, float cell) {
  gCoastSlope = vec2(0.0); gCoastFoam = vec3(0.0);
  if (uSurf.x <= 0.0) return vec3(0.0);
  float env = gNear * gExpo * smoothstep(-0.9, 0.5, depth);
  float shoal = pow(clamp(max(depth, 0.6) / ${SHORE.dMax.toFixed(1)}, 0.04, 1.0), -0.25);
  float cel = sqrt(9.81 * clamp(depth, ${SHORE.dMin.toFixed(2)}, ${SHORE.dMax.toFixed(1)}));
  float amax = 0.42 * max(depth, 0.0) + 0.02;
  float group = sw3Group(p, uWTime), pinch = 0.85;
  vec3 d = vec3(0.0); vec2 sl = vec2(0.0); float foam = 0.0, charge = 0.0, backwash = 0.0, residual = 0.0;
  for (int i = 0; i < 2; i++) {
    float w = sw3Omega(i), k = w / cel;
    float a0 = uSurf.x * (i == 0 ? 1.0 : ${SWASH.second[1].toFixed(2)}) * env * shoal * group; // the wave's own height, before the depth holds it
    float a = min(a0, amax * (i == 0 ? 1.0 : 0.5));
    float ph = sw3Phase(i, uWTime, gTau, gPn);
    float psi = mod(ph + 3.14159265, 6.2831853) - 3.14159265;
    float c = 0.5 + 0.5 * cos(ph), s = sin(ph);
    float cp = pow(max(c, 0.0), 0.6); // P - 1, P = 1.6: sharper crests, wider troughs
    // breaking and its foam are judged on the wave's own height (a0), not the height the depth leaves it: once broken a
    // wave stays broken, and its white runs on into the swash instead of dying in the last half metre of water
    float rel = a / max(depth, 0.05), rel0 = a0 / max(depth, 0.05);
    float cyc = floor((ph + 3.14159265) / 6.2831853);
    float early = 0.5 + 0.5 * w2noise(p / 33.0 + vec2(cyc * 7.3, cyc * 3.1 + float(i) * 31.0), 614);
    float energy = smoothstep(0.03, 0.2, a0);
    float breaking = smoothstep(0.30 + 0.09 * early, 0.39 + 0.09 * early, rel0) * energy; // the breaking limit: height 0.78 of the depth (amplitude 0.39), early or late along the crest
    // the lip leans furthest just before it collapses; over the next half radian the crest gives up to 48% of its
    // height to the whitewater running ahead
    float collapse = breaking * smoothstep(-0.75, -0.12, psi) * (1.0 - smoothstep(0.05, 0.7, psi));
    float body = 1.0 - (i == 0 ? 0.48 : 0.12) * collapse;
    float pitch = i == 0 ? 2.0 * uSurf.w * a * smoothstep(0.16, 0.28, rel) * (1.0 - smoothstep(0.4, 0.6, rel)) : 0.0;
    pitch = min(pitch, 0.35 / (1.08 * k));
    pitch *= 1.0 - smoothstep(0.03, 0.1, k * cell / 6.2831853);
    pitch *= 1.0 - 0.65 * smoothstep(-0.05, 0.55, psi);
    pinch -= 1.08 * pitch * k;
    float qak = max(min(pinch, uSurf.w * a * k * 8.0), 0.0);
    pinch -= qak;
    float c5 = c * c * c * c * c;
    float bl = 1.0 - smoothstep(0.1, 0.3, k * cell / 6.2831853);
    d.y += bl * a * body * (2.0 * cp * c - 0.78);
    d.xz += bl * gDir * ((qak / k) * s + pitch * c5 * c);
    sl += bl * gDir * (a * body * k * 1.6 * cp * s / max(1.0 - qak * cos(ph) + 3.0 * pitch * k * c5 * s, 0.2));
    // the crest's whitewater and its tail
    float big = smoothstep(0.2, 0.5, a);
    float tail = max(exp(-max(psi, 0.0) * mix(0.45, 1.0, big)), 0.65 * smoothstep(0.3, 0.55, rel) * smoothstep(2.4, 0.3, psi));
    foam += breaking * smoothstep(mix(-0.7, -0.35, big), 0.0, psi) * tail * mix(0.32, 0.58, big);
    if (i == 0) {
      // the charge: the collapsed crest's foam, leading the water front shoreward, with a burst where it hands over
      float adv = (psi + 0.58) / 0.58, pl = (psi + 0.08) / 0.28;
      charge = breaking * (1.25 * exp(-adv * adv) + 0.45 * exp(-pl * pl)) * (0.65 + 0.35 * smoothstep(0.15, 0.5, rel)) * uSurfX.x;
      backwash = energy * smoothstep(0.25, 1.1, psi) * exp(-max(psi, 0.0) * 0.42) * smoothstep(3.0, 0.15, depth);
      // the last four breakers' foam, each lasting 3.5 to 10 s by how hard it broke
      float since = mod(ph, 6.2831853) / w, period = 6.2831853 / w, mem = 0.0;
      for (int j = 0; j < 4; j++) {
        float cid = floor(ph / 6.2831853) - float(j);
        float age = since + float(j) * period;
        mem += (0.55 + 0.65 * (0.5 + 0.5 * w2noise(p / 40.0 + vec2(cid * 7.3, cid * 3.1), 615))) * exp(-age / mix(3.5, 10.0, breaking)) * smoothstep(0.0, 1.0, age); // grown in over its first second, never whole in one frame
      }
      residual = clamp(mem * breaking * smoothstep(7.0, 0.25, depth) * smoothstep(-0.7, 0.15, depth) * 0.42, 0.0, 1.0);
    }
  }
  gCoastSlope = sl;
  float sand = clamp((charge * 0.12 + backwash * 0.9 + residual * 0.3) * smoothstep(3.0, 0.15, depth), 0.0, 1.0);
  gCoastFoam = vec3(clamp(foam + charge, 0.0, 1.0), clamp(residual + 0.5 * backwash, 0.0, 1.0), max(sand, residual * 0.6));
  return d;
}
`;
