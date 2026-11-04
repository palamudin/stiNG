// Water 3: the coast's clock: the three swell trains near a shore (their phase, their sets), and the shoreline's
// height, one function read by the water's mesh (its surface over the sand), the water's pixels (the edge: no water
// where this height is under the sand) and the sand (wet only where and since this height was over it).
//
// Everything is read at the point itself; nothing looks up a nearest point on the shore (the nearest-point clock of
// W3.1 jumped where two stretches of shore are equally near: the zigzag along the line). The trains' phase at a point
// is w (t + tau) + the phase noise, tau the shore table's travel time (0 on the line), so at the line the crest of
// the main train arrives when w t + noise passes a whole turn, and the noise (hundreds of metres across) bends the
// arrival smoothly along the coast.
//
import { SHORE } from '../shorefield.js';

export const SWASH = {
  coast: [180, 420],   // metres from the shore: the coast's trains carry the swell within the first, none past the second
  lee: 0.45,           // the share of the swell a coast in its lee gets
  periods: [1.0, 0.93, 1.08], phaseMul: [1.0, 1.37, 0.71],
  up: 0.3,             // the share of the period the shoreline climbs; it drains over the rest, at the line as the next crest arrives
  memory: 7,           // waves the sand remembers
  gloss: 1.5, dark: 45, // seconds: the shine of sand the water has just left, and its darkness
};

// needs: NOISE_GLSL (w2noise), the shore table's glsl (shoreAt, gShoreKnow), uniform vec4 uShoreWave (declared by the
// reader: x swell Hs, y its period), uTime
export const SWASH_GLSL = /* glsl */ `
uniform vec2 uSwDir; // the far swell's direction
const float SW3_LEE = ${SWASH.lee.toFixed(2)};
// the coast here: gNear the share of the swell the coast's trains carry, gExpo the coast's exposure to the swell,
// gDir toward the shore, gPn the phase noise, gTau the travel time; false where no table knows the point
float gNear = 0.0, gExpo = 1.0, gPn = 0.0, gTau = 0.0, gShoreD = 1e4; vec2 gDir = vec2(0.0);
bool sw3Ctx(vec2 p) {
  gNear = 0.0;
  vec4 sh = shoreAt(p); float coh = gShoreKnow > 0.0 ? length(sh.yz) : 0.0;
  if (gShoreKnow <= 0.0 || abs(sh.x) > 9.0e3) return false;
  // nothing here may switch on or off from one texel to the next (the coherence does, near the line): the trains'
  // share fades with the distance only, the direction and the exposure are weighted by the coherence, so where it is
  // weak they fade instead of stepping
  gDir = coh > 1e-4 ? sh.yz / coh : vec2(0.0); gTau = sh.w; gShoreD = sh.x;
  gNear = gShoreKnow * (1.0 - smoothstep(${SWASH.coast[0].toFixed(1)}, ${SWASH.coast[1].toFixed(1)}, -sh.x));
  gExpo = mix(SW3_LEE, 1.0, smoothstep(-0.4, 0.6, dot(uSwDir, sh.yz)));
  gPn = w2noise(p / 240.0, 611) * 5.0 + w2noise(p / 70.0, 612) * 1.6;
  return gNear > 0.0;
}
float sw3Period(int i) { return uShoreWave.y * (i == 0 ? ${SWASH.periods[0].toFixed(2)} : i == 1 ? ${SWASH.periods[1].toFixed(2)} : ${SWASH.periods[2].toFixed(2)}); }
float sw3Phase(int i, float t, float tau, float pn) { return 6.2831853 / sw3Period(i) * (t + tau) + pn * (i == 0 ? ${SWASH.phaseMul[0].toFixed(2)} : i == 1 ? ${SWASH.phaseMul[1].toFixed(2)} : ${SWASH.phaseMul[2].toFixed(2)}) + float(i) * 2.1; }
// the set: the three trains' sum against its peak (0..1) at travel time tau, time t
float sw3Set(float t, float tau, float pn) { vec2 s = vec2(0.0); for (int i = 0; i < 3; i++) { float ph = sw3Phase(i, t, tau, pn); s += vec2(cos(ph), sin(ph)); } return length(s) / 3.0; }
// ---- the shoreline (the swash). Every sea beach; nothing from the shore table (its values step from texel to texel
// on the land side of the line). Exposure from the way the sand faces (grad: the ground's uphill gradient), the clock's
// noise from the point itself, the crest of the main train reaching the line (its phase at travel time 0) starting
// each climb
const float SW3_UP = ${SWASH.up.toFixed(2)};
void sw3Beach(vec2 p, vec2 grad) {
  gNear = 1.0;
  float gl = length(grad); vec2 up = gl > 1e-4 ? grad / gl : vec2(0.0);
  gExpo = mix(SW3_LEE, 1.0, smoothstep(-0.4, 0.6, dot(uSwDir, up)));
  gPn = w2noise(p / 240.0, 611) * 5.0 + w2noise(p / 70.0, 612) * 1.6;
}
// the run-up limit (Stockdon et al. 2006) on slope tb for swell height H and period T, held to the crest's height:
// higher on a gentle beach for the same climb time, so the water runs further and faster the flatter the sand
float sw3Runup(float tb, float H, float T) { float HL = H * 9.81 * T * T / 6.2831853; return min(1.1 * (0.35 * tb * sqrt(HL) + 0.5 * sqrt(HL * (0.563 * tb * tb + 0.004))), 0.575 * H); }
// the reach of the wave whose crest reached the line at tc (cycle cyc): the set it came in, fingers along the shore
float sw3Reach(vec2 p, float tb, float tc, float cyc) {
  float set = sw3Set(tc, 0.0, gPn);
  float fing = 0.85 + 0.3 * w2noise(p / 1.6 + vec2(cyc * 7.3, cyc * 3.1), 621) + 0.08 * w2noise(p / 0.5 + vec2(cyc * 1.7, -cyc * 2.9), 625);
  return sw3Runup(tb, uShoreWave.x, uShoreWave.y) * gExpo * (0.35 + 0.65 * set) * fing;
}
// the shoreline's climb and drain over one wave (s: the fraction of the period since the crest reached the line)
float sw3Shape(float s) { return s < SW3_UP ? sin(s / SW3_UP * 1.5707963) : cos((s - SW3_UP) / (1.0 - SW3_UP) * 1.5707963); }
// the shoreline's height over the still water at p now, and s
float sw3Shore(vec2 p, float tb, float t, out float s) {
  float T0 = uShoreWave.y, f = (6.2831853 / T0 * t + gPn) / 6.2831853, cyc = floor(f); s = f - cyc;
  return sw3Reach(p, tb, t - s * T0, cyc) * sw3Shape(s);
}
// the sand at p, hgt over the still water: (darkness 0..1, gloss 0..1, covered 0/1): wet from when the shoreline rose
// past it (never before) to when it fell back past it, in each of the last waves; drying from then
vec3 sw3Wet(vec2 p, float hgt, float tb, float t) {
  if (hgt <= 0.0) return vec3(1.0, 1.0, 1.0);
  float T0 = uShoreWave.y, f = (6.2831853 / T0 * t + gPn) / 6.2831853, cyc = floor(f), s = f - cyc;
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
`;
