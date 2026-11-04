// Water 3: the coast's clock: the three swell trains near a shore (their phase, their sets).
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
`;
