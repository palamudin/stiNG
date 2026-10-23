// Counter-based RNG and deterministic math (GDD 3.4, 3.5, A.2).
// Bit-identical to the C# protocode Rng.Hash. Sim code may only use + - * / sqrt floor abs min max
// and the functions in this file, so results are identical on every machine.

const M64 = (1n << 64n) - 1n;

export const Domain = {
  WorldGen: 1n, HumanTraits: 2n, HumanSchedule: 3n, Clothing: 4n,
  Flight: 5n, Colony: 6n, Ecology: 7n, Weather: 8n, Bees: 9n, Cosmetic: 10n,
};

function mix(z) {
  z = (z + 0x9E3779B97F4A7C15n) & M64;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
  return z ^ (z >> 31n);
}

export function hash(seed, domain, a, b = 0n, c = 0n) {
  let h = mix(seed);
  h = mix(h ^ domain);
  h = mix(h ^ a);
  h = mix(h ^ b);
  h = mix(h ^ c);
  return h;
}

export const unit = (h) => Number(h >> 32n) / 4294967296;
export const range = (h, lo, hi) => lo + (hi - lo) * unit(h);
export const rangeInt = (h, lo, hi) => lo + Number(((h >> 32n) * BigInt(hi - lo)) >> 32n);
export const u64 = (n) => BigInt.asUintN(64, BigInt(n));

// Small, fast 32-bit hash for per-tick decisions that do not need the full 64-bit chain.
// Deterministic (integer ops only). Returns [0, 1).
export function h32(a, b = 0, c = 0, d = 0) {
  let h = 0x9e3779b9 ^ a;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) ^ b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) ^ c;
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2f) ^ d;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

const PI = 3.141592653589793, TAU = 2 * PI, HALF_PI = PI / 2;
export { PI, TAU };

export function dsin(x) {
  x = x - TAU * Math.floor((x + PI) / TAU);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110 * (1 - x2 / 156))))));
}
export const dcos = (x) => dsin(x + HALF_PI);

export const sq = (x) => x * x;

// Round half up. Defined here (not Math.round) so every port rounds identically.
export const rnd = (x) => Math.floor(x + 0.5);

// atan2 from + - * / only (GDD 3.4): octant reduction and a minimax polynomial, error below 1e-9 rad
export function datan2(y, x) {
  if (x === 0 && y === 0) return 0;
  const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
  const swap = ay > ax, t = swap ? ax / ay : ay / ax; // t in [0, 1]
  // reduce to |u| <= tan(pi/12) with atan(t) = pi/6 + atan((t*sqrt3 - 1) / (t + sqrt3))
  const SQ3 = 1.7320508075688772, big = t > 0.2679491924311227;
  const u = big ? (t * SQ3 - 1) / (t + SQ3) : t, u2 = u * u;
  let r = u * (1 - u2 * (1 / 3 - u2 * (1 / 5 - u2 * (1 / 7 - u2 * (1 / 9 - u2 * (1 / 11 - u2 * (1 / 13 - u2 / 15)))))));
  if (big) r += PI / 6;
  if (swap) r = HALF_PI - r;
  if (x < 0) r = PI - r;
  return y < 0 ? -r : r;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// Stable string id for a 64-bit value.
export const hex64 = (v) => v.toString(16).padStart(16, '0');
