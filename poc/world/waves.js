// Waves (World v2, W2): a statistical sea surface from a measured spectrum, evolved and transformed on the GPU.
//
// The spectrum is Elfouhaily et al. (1997, JGR 102 C7), the "unified" directional spectrum that runs from gravity
// waves through the capillary range with one formula, because this world has both: wind waves on a lake and the
// ripples on a birdbath a wasp drinks from. Its inputs are the wind at 10 m (U10) and the fetch (how far the wind has
// blown over the water), so a 0.4 m birdbath under a breeze gets centimetre ripples and a 600 m lake gets
// metre-long chop from the same code.
//   - Dispersion is capillary-gravity, deep water: w^2 = g k + (sigma / rho) k^3. Below a wavelength of 1.7 cm surface
//     tension is the restoring force and short ripples run faster than long ones.
//   - No wind, no waves: below a friction velocity of about 2 cm/s the surface stays glassy (Kahma and Donelan 1988,
//     JFM 192, found inception at u* = 2 cm/s, the first wavelets about 10 micrometres high).
//   - Elfouhaily's spreading (1 + D(k) cos 2phi) does not say which way along a direction a wave runs. We keep its
//     energy per direction and send the share f = (1 + cos phi)^2 / (2 + 2 cos^2 phi) downwind, 1 - f upwind (our choice).
//   - Horizontal displacement (choppiness) sharpens crests for gravity waves (Stokes) and troughs for capillary waves
//     (Crapper 1957); the sign goes over with the ratio of the two restoring forces, (g k - T k^3) / (g k + T k^3).
//   - Frequencies are rounded to multiples of 2 pi / loop, so the surface repeats exactly after `loop` seconds and the
//     phase is taken from fract(m t / loop) in single precision without drift.
//   - Waves faster than the frame rate can show (w > pi * fps) are faded out of the field; their slope variance is
//     counted here on the CPU and handed to the shading as roughness, so the energy stays in the picture.
//
// The field is h(x) = sum_k h(k, t) e^{i k.x} over an N x N grid of wave vectors per cascade; cascades are tiles of
// different sizes L, each keeping the band of wavenumbers the one before cannot resolve. The GPU does the inverse FFT
// as radix-2 Stockham passes (natural order in and out, no bit reversal), all cascades side by side in one atlas, two
// complex fields per texel. Outputs per cascade, tiling with repeat and mip-mapped:
//   disp:  (Dx, h, Dz, J)            J = det of the horizontal Jacobian (< 0 where the surface folds)
//   slope: (sx, sz, sx^2, sz^2)      first and second slope moments: their mips filter to a mean slope and a
//                                    variance (LEAN, Olano and Baker 2010), which the shading turns into roughness
// This file is the math (no three.js, so the tests run it); wavegpu.js is the GPU side.
import { hash3 } from './noise.js';

export const WAVES = {
  g: 9.81,
  T: 7.28e-5,   // surface tension over density, m^3/s^2 (clean water, 20 C)
  km: 370,      // Elfouhaily's wavenumber of the gravity-capillary minimum phase speed, rad/m
  cm: 0.23,     // that minimum phase speed, m/s
  N: 128,       // grid per cascade
  loop: 256,    // s
  chop: 0.85,
  onset: [0.02, 0.04], // friction velocity: no waves below, the full spectrum above (m/s)
};

const TAU = Math.PI * 2;
export function omega(k) { return Math.sqrt(WAVES.g * k + WAVES.T * k * k * k); }
export function phaseSpeed(k) { return Math.sqrt(WAVES.g / k * (1 + (k / WAVES.km) ** 2)); }
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The swell that reaches a coast from a long fetch (W3.1): the open sea's significant height and peak period for a wind
// U10 over a fetch, from the JONSWAP fetch relations (Hasselmann et al. 1973: Hs = 1.6e-3 X^1/2 U^2/g, Tp = 0.286 X^1/3
// U/g, X = g F/U^2), held under the fully developed limits (Pierson and Moskowitz 1964: Hs = 0.21 U^2/g, Tp = 7.14 U/g).
// The wave field itself (wavegpu.js) holds the local chop; the shore waves of the table ride this.
export function swellState(U10, fetch) {
  const g = WAVES.g, U = Math.max(U10, 0.05), X = g * fetch / (U * U);
  const Hs = Math.min(1.6e-3 * Math.sqrt(X) * U * U / g, 0.21 * U * U / g);
  const Tp = Math.min(0.286 * Math.cbrt(X) * U / g, 7.14 * U / g);
  return { Hs, Tp };
}
// Everything of the spectrum that depends on the wind and fetch only
export function seaState(U10, fetch) {
  const g = WAVES.g, U = Math.max(U10, 0.05);
  const ustar = Math.sqrt((0.8 + 0.065 * U) * 1e-3) * U; // Wu (1982) drag coefficient
  const X = g * fetch / (U * U);
  const Om = Math.min(25, 0.84 * Math.pow(Math.tanh(Math.pow(X / 2.2e4, 0.4)), -0.75)); // inverse wave age, fetch-limited
  const kp = g * Om * Om / (U * U), cp = phaseSpeed(kp);
  const Og = Math.min(5, Math.max(0.84, Om)); // gamma and sigma are fitted for 0.84..5
  const gamma = Og < 1 ? 1.7 : 1.7 + 6 * Math.log10(Og), sigma = 0.08 * (1 + 4 * Og ** -3);
  const ap = 6e-3 * Math.sqrt(Om);
  const r = ustar / WAVES.cm, am = Math.max(0, r < 1 ? 0.01 * (1 + Math.log(r)) : 0.01 * (1 + 3 * Math.log(r)));
  const onset = smooth(WAVES.onset[0], WAVES.onset[1], ustar);
  return { U10: U, fetch, ustar, Om, kp, cp, gamma, sigma, ap, am, onset, a_m: 0.13 * ustar / WAVES.cm };
}
// omnidirectional curvature spectrum B(k) (S(k) = B / k^3, integral of S dk = height variance) and spreading D(k)
export function curvature(k, P) {
  const c = phaseSpeed(k), sk = Math.sqrt(k / P.kp);
  const Lpm = Math.exp(-1.25 * (P.kp / k) ** 2);
  const Jp = Math.pow(P.gamma, Math.exp(-((sk - 1) ** 2) / (2 * P.sigma * P.sigma)));
  const Fp = Lpm * Jp * Math.exp(-P.Om / Math.sqrt(10) * (sk - 1));
  const Bl = 0.5 * P.ap * (P.cp / c) * Fp;
  const Fm = Lpm * Jp * Math.exp(-0.25 * (k / WAVES.km - 1) ** 2);
  const Bh = 0.5 * P.am * (WAVES.cm / c) * Fm;
  return (Bl + Bh) * P.onset;
}
export function spreading(k, P) {
  const c = phaseSpeed(k);
  return Math.tanh(Math.log(2) / 4 + 4 * (c / P.cp) ** 2.5 + P.a_m * (WAVES.cm / c) ** 2.5);
}
export const downwindShare = (cphi) => (1 + cphi) * (1 + cphi) / (2 + 2 * cphi * cphi);
// Cartesian directional spectrum per unit kx kz, symmetric in k and -k (Elfouhaily): S(k) / k * (1 + D cos 2phi) / 2pi
export function psiSym(kx, kz, P, wd) {
  const k = Math.hypot(kx, kz); if (k <= 0) return 0;
  const cphi = (kx * wd[0] + kz * wd[1]) / k, c2 = 2 * cphi * cphi - 1;
  return curvature(k, P) / (k * k * k) / k * (1 + spreading(k, P) * c2) / TAU;
}
// the band each cascade keeps: from the previous cascade's limit to 0.9 of its own Nyquist (the first from 0)
export function bands(cascades, N = WAVES.N) {
  const out = []; let lo = 0;
  for (const L of cascades) { const hi = 0.9 * Math.PI * N / L; out.push([lo, hi]); lo = hi; }
  return out;
}
// height and slope variance of the discrete field (what the GPU will make), with the share lost to the frame-rate fade
export function fieldStats(P, cascades, wd, omegaMax = Infinity, N = WAVES.N) {
  const B = bands(cascades, N); let vh = 0, vs = 0, lost = 0;
  cascades.forEach((L, c) => {
    const dk = TAU / L;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const kx = (j - N / 2) * dk, kz = (i - N / 2) * dk, k = Math.hypot(kx, kz);
      if (k < B[c][0] || k >= B[c][1] || k === 0) continue;
      const e = psiSym(kx, kz, P, wd) * dk * dk; // A+^2 + A-^2 = psi dk^2 (see the GPU pass)
      const w = omega(k), fd = omegaMax === Infinity ? 1 : 1 - smooth(0.7 * omegaMax, omegaMax, w);
      vh += e * fd * fd; vs += e * k * k * fd * fd; lost += e * k * k * (1 - fd * fd);
    }
  });
  return { varH: vh, varS: vs, lostS: lost, Hs: 4 * Math.sqrt(vh) };
}
// the 1D integral of S(k) for comparison
export function integralVar(P, k0, k1, n = 20000) {
  let s = 0; const a = Math.log(k0), b = Math.log(k1);
  for (let i = 0; i < n; i++) { const k = Math.exp(a + (b - a) * (i + 0.5) / n); s += curvature(k, P) / (k * k * k) * k * (b - a) / n; }
  return s;
}

// a complex normal number with E|xi|^2 = 1 (two independent normals of variance 1/2, Box-Muller) from the hash, per
// cascade and wave vector: the same sea on every machine
export function gauss2(i, j, s) {
  const u1 = (hash3(i, j, s) + 1) / 4294967297, u2 = hash3(i, j, s + 1) / 4294967296;
  const r = Math.sqrt(-Math.log(u1));
  return [r * Math.cos(TAU * u2), r * Math.sin(TAU * u2)];
}

// The CPU reference of the GPU inverse FFT: the same Stockham passes (tests compare it with a plain DFT)
export function ifftStockham(re, im) {
  const N = re.length; let r = Float64Array.from(re), q = Float64Array.from(im);
  for (let Ns = 2; Ns <= N; Ns *= 2) {
    const nr = new Float64Array(N), nq = new Float64Array(N), hs = Ns / 2;
    for (let idx = 0; idx < N; idx++) {
      const ev = Math.floor(idx / Ns) * hs + (idx % hs), od = ev + N / 2, a = TAU * (idx % Ns) / Ns, wr = Math.cos(a), wi = Math.sin(a);
      nr[idx] = r[ev] + wr * r[od] - wi * q[od]; nq[idx] = q[ev] + wr * q[od] + wi * r[od];
    }
    r = nr; q = nq;
  }
  return [r, q];
}


// The field at points by direct summation over every wave vector, in double precision: the GPU test's reference.
// Same spectrum, noise, frequencies and phases as the GPU pass. Returns [Dx, h, Dz, sx, sz] per point.
export function fieldAtCPU(P, cascades, wd, time, pts, salt = 0, N = WAVES.N, omegaMax = Infinity, only = -1) {
  const B = bands(cascades, N), out = pts.map(() => [0, 0, 0, 0, 0]), w0 = TAU / WAVES.loop, t = time % WAVES.loop;
  cascades.forEach((L, c) => {
    if (only >= 0 && c !== only) return;
    const dk = TAU / L;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const kx = (j - N / 2) * dk, kz = (i - N / 2) * dk, k = Math.hypot(kx, kz);
      if (k <= 0 || k < B[c][0] || k >= B[c][1]) continue;
      const a = gauss2(j, i, 4001 + c * 16 + salt), b = gauss2((N - j) % N, (N - i) % N, 4001 + c * 16 + salt);
      const cphi = (kx * wd[0] + kz * wd[1]) / k, psi = psiSym(kx, kz, P, wd), fw = downwindShare(cphi);
      const ap = dk * Math.sqrt(Math.max(0, psi * fw)), am = dk * Math.sqrt(Math.max(0, psi * (1 - fw)));
      const w = omega(k), m = Math.round(w / w0), ph = TAU * ((m * t / WAVES.loop) % 1), fd = omegaMax === Infinity ? 1 : 1 - smooth(0.7 * omegaMax, omegaMax, w);
      const er = Math.cos(ph), ei = Math.sin(ph);
      // A+ xi(k) e^{-i ph} + conj(A- xi(-k)) e^{+i ph}
      const hr = fd * (ap * (a[0] * er + a[1] * ei) + am * (b[0] * er + b[1] * ei));
      const hi = fd * (ap * (a[1] * er - a[0] * ei) + am * (-b[1] * er + b[0] * ei));
      const gk = WAVES.g * k, tk = WAVES.T * k * k * k, lam = WAVES.chop * (gk - tk) / (gk + tk);
      pts.forEach(([x, z], p) => {
        const th = kx * x + kz * z, cr = Math.cos(th), ci = Math.sin(th);
        const re = hr * cr - hi * ci, im = hr * ci + hi * cr; // h(k) e^{i k.x}
        const o = out[p];
        o[1] += re;
        o[0] += -lam * kx / k * im; o[2] += -lam * kz / k * im; // Re(i lam khat h e^{ikx})
        o[3] += -kx * im; o[4] += -kz * im;                      // Re(i k h e^{ikx})
      });
    }
  });
  return out;
}
