// World v2 noise: one integer hash and value noise with analytic derivatives, written twice, in JS and in GLSL, so the
// CPU (placement, ground clamp, the sim adapter) and the GPU (terrain tiles, grass, shading) read the same numbers.
// Presentation only: none of this feeds the sim. The hash is lowbias32 (Chris Wellons) on 32-bit integers; JS uses
// Math.imul and >>> 0, GLSL uses uint arithmetic, which wraps the same way. Floats differ only past the 24th bit.

export function hash3(x, y, s) {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(s | 0, 0xcb1ab31f)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
export const hash01 = (x, y, s) => hash3(x, y, s) / 4294967296;

// value noise in -1..1 with derivatives (quintic fade). Writes [v, dx, dy] into out.
export function vnoised(x, y, s, out) {
  const px = Math.floor(x), py = Math.floor(y), fx = x - px, fy = y - py;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = hash01(px, py, s) * 2 - 1, b = hash01(px + 1, py, s) * 2 - 1, c = hash01(px, py + 1, s) * 2 - 1, d = hash01(px + 1, py + 1, s) * 2 - 1;
  const k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  out[0] = a + k1 * ux + k2 * uy + k4 * ux * uy; out[1] = dux * (k1 + k4 * uy); out[2] = duy * (k2 + k4 * ux);
  return out;
}
const T3 = [0, 0, 0];
export const vnoise = (x, y, s) => vnoised(x, y, s, T3)[0];

export const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const mix = (a, b, t) => a + (b - a) * t;

export const NOISE_GLSL = /* glsl */ `
uint w2hash3(int x, int y, int s) {
  uint h = (uint(x) * 0x8da6b343u) ^ (uint(y) * 0xd8163841u) ^ (uint(s) * 0xcb1ab31fu);
  h ^= h >> 16u; h *= 0x7feb352du;
  h ^= h >> 15u; h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}
float w2hash01(int x, int y, int s) { return float(w2hash3(x, y, s)) * (1.0 / 4294967296.0); }
vec3 w2noised(vec2 p, int s) {
  vec2 i0 = floor(p); vec2 f = p - i0; ivec2 i = ivec2(i0);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = w2hash01(i.x, i.y, s) * 2.0 - 1.0, b = w2hash01(i.x + 1, i.y, s) * 2.0 - 1.0;
  float c = w2hash01(i.x, i.y + 1, s) * 2.0 - 1.0, d = w2hash01(i.x + 1, i.y + 1, s) * 2.0 - 1.0;
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du.x * (k1 + k4 * u.y), du.y * (k2 + k4 * u.x));
}
float w2noise(vec2 p, int s) { return w2noised(p, s).x; }
`;
