// Water 3: the coast's clock, shared by the water surface (its trains, its swash) and the sand (its wetness), so the
// water and the sand it leaves wet run on one clock and cannot drift apart.
//
// Everything is read at the point itself; nothing looks up a nearest point on the shore (the nearest-point clock of
// W3.1 jumped where two stretches of shore are equally near: the zigzag along the line). The trains' phase at a point
// is w (t + tau) + the phase noise, tau the shore table's travel time (0 on the line), so at the line the crest of
// the main train arrives when w t + noise passes a whole turn, and the noise (hundreds of metres across) bends the
// arrival smoothly along the coast.
//
// The swash (Baldock and Holmes's ballistic run-up): a bore arriving at the line sends a tongue up the sand, its tip
// rising as a thrown body does to the run-up limit R (Stockdon et al. 2006 for the beach's slope and the swell, held to
// the crest's own height above the water) and falling back at the same pace: up for Tr, down for Tr, Tr = sqrt(2 R / g)
// / sin(slope), held to 0.42 of the period. A bigger swell: a longer period, a higher reach, a longer splash and a
// longer retreat. R varies with the set (the three trains' sum at the line when the crest arrived) and along the shore
// in fingers, a new pattern each wave.
//
// The sand: wet where a tongue reached in the last seven waves, each wetting starting when the tip passes the point on
// the way up (never before the water is there) and ending when it passes on the way down; from then the gloss goes in
// about a second and a half and the darkness in about 45 s, so the highest sand, left first, dries first.
import { SHORE } from '../shorefield.js';

export const SWASH = {
  coast: [180, 420],   // metres from the shore: the coast's trains carry the swell within the first, none past the second
  lee: 0.45,           // the share of the swell a coast in its lee gets
  periods: [1.0, 0.93, 1.08], phaseMul: [1.0, 1.37, 0.71],
  memory: 7,           // waves the sand remembers
  gloss: 1.5, dark: 45, // seconds: the shine of fresh-left sand, and its darkness
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
// the beach here, for the swash and the sand: nothing from the shore table (its values jump from texel to texel on the
// land side of the line, and a reach scaled by them comes out in teeth the size of a texel). The swell reaches every
// sea beach; its exposure from the way the sand faces (grad: the ground's gradient, uphill), its clock's noise from
// the point itself
void sw3Beach(vec2 p, vec2 grad) {
  gNear = 1.0;
  float gl = length(grad); vec2 up = gl > 1e-4 ? grad / gl : vec2(0.0);
  gExpo = mix(SW3_LEE, 1.0, smoothstep(-0.4, 0.6, dot(uSwDir, up)));
  gPn = w2noise(p / 240.0, 611) * 5.0 + w2noise(p / 70.0, 612) * 1.6;
}
float sw3Period(int i) { return uShoreWave.y * (i == 0 ? ${SWASH.periods[0].toFixed(2)} : i == 1 ? ${SWASH.periods[1].toFixed(2)} : ${SWASH.periods[2].toFixed(2)}); }
float sw3Phase(int i, float t, float tau, float pn) { return 6.2831853 / sw3Period(i) * (t + tau) + pn * (i == 0 ? ${SWASH.phaseMul[0].toFixed(2)} : i == 1 ? ${SWASH.phaseMul[1].toFixed(2)} : ${SWASH.phaseMul[2].toFixed(2)}) + float(i) * 2.1; }
// the set: the three trains' sum against its peak (0..1) at travel time tau, time t
float sw3Set(float t, float tau, float pn) { vec2 s = vec2(0.0); for (int i = 0; i < 3; i++) { float ph = sw3Phase(i, t, tau, pn); s += vec2(cos(ph), sin(ph)); } return length(s) / 3.0; }
// the run-up limit on slope tb (rise over run) for swell height H and period T, held to the crest's height
float sw3Runup(float tb, float H, float T) { float HL = H * 9.81 * T * T / 6.2831853; return min(1.1 * (0.35 * tb * sqrt(HL) + 0.5 * sqrt(HL * (0.563 * tb * tb + 0.004))), 0.575 * H); }
// one wave's tongue at p: its reach R and rise time Tr, for the crest that reached the line at tc (cycle cyc)
void sw3Wave(vec2 p, float tb, float tc, float cyc, out float R, out float Tr) {
  float set = sw3Set(tc, 0.0, gPn);
  float fing = 0.85 + 0.3 * w2noise(p / 1.6 + vec2(cyc * 7.3, cyc * 3.1), 621) + 0.08 * w2noise(p / 0.5 + vec2(cyc * 1.7, -cyc * 2.9), 625);
  R = sw3Runup(tb, uShoreWave.x, uShoreWave.y) * gNear * gExpo * (0.35 + 0.65 * set) * fing;
  float sb = tb / sqrt(1.0 + tb * tb);
  Tr = clamp(sqrt(2.0 * max(R, 1e-3) / 9.81) / max(sb, 0.02), 0.8, 0.42 * uShoreWave.y);
}
// the tongue now at p: its tip's height over the still water (< 0: no tongue), the time since its bore reached the
// line, and its rise time
float sw3Tongue(vec2 p, float tb, float t, out float tp, out float Tr) {
  float T0 = uShoreWave.y, f = (6.2831853 / T0 * t + gPn) / 6.2831853, cyc = floor(f); tp = (f - cyc) * T0;
  float R; sw3Wave(p, tb, t - tp, cyc, R, Tr);
  return tp < 2.0 * Tr ? R * (1.0 - (1.0 - tp / Tr) * (1.0 - tp / Tr)) : -1.0;
}
// the sand at p, hgt over the still water: (darkness 0..1, gloss 0..1, covered 0/1)
vec3 sw3Wet(vec2 p, float hgt, float tb, float t) {
  if (hgt <= 0.0) return vec3(1.0, 1.0, 1.0);
  float T0 = uShoreWave.y, f = (6.2831853 / T0 * t + gPn) / 6.2831853, cyc = floor(f), tp = (f - cyc) * T0;
  vec3 o = vec3(0.0);
  for (int k = 0; k < ${SWASH.memory}; k++) {
    float tc = t - tp - float(k) * T0, R, Tr; sw3Wave(p, tb, tc, cyc - float(k), R, Tr);
    if (hgt >= R) continue;
    float q = sqrt(max(1.0 - hgt / R, 0.0)), ta = tc + Tr * (1.0 - q), tl = tc + Tr * (1.0 + q);
    if (t < ta) continue;                         // this wave's water has not reached the point yet
    if (t <= tl) return vec3(1.0, 1.0, 1.0);      // under it now
    float age = t - tl;
    o.x = max(o.x, exp(-age / ${SWASH.dark.toFixed(1)})); o.y = max(o.y, exp(-age / ${SWASH.gloss.toFixed(2)}));
  }
  return o;
}`;
