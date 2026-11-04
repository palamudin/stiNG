// Weather and seasons (W3). Pure functions of the world's seed and clock, so every machine sees the same sky.
//
// A year is YEAR.days days. The day of the year sets the season (spring from day 0): the sun's track (declination),
// the leaves (fresh in spring, deep in summer, yellow to red in autumn, gone in winter), the flowers (in bloom from
// late spring to late summer), the grass (yellowing in autumn, under snow in winter), the snow line (down to the sea
// in deep winter, up the mountains in summer) and the lakes (frozen in deep winter).
//
// Each day has a weather, drawn from a hash of the day with the season's odds: clear, fair, overcast, rain, storm or
// fog. The state at any moment blends the day's weather with the next day's over the last hours of the night, a storm
// builds through the afternoon and breaks in the evening, fog lies in the morning and lifts by noon. The presentation
// reads: cloud cover and density, haze and mist, wet, rain (or snow when it is cold), wind at 10 m, lightning.
//
// This is the template's own clock. In the game the sim's day and weather are the authority (dayWeather,
// isRaining, windAt): the game maps them onto the same fields (WORLD.md, "Weather in the game").
import { hash01, smoothstep, mix, clamp } from './noise.js';

export const YEAR = { days: 360 };
const KINDS = ['clear', 'fair', 'overcast', 'rain', 'storm', 'fog'];
// the odds of each kind by season (spring, summer, autumn, winter), in order of KINDS
const ODDS = [
  [0.22, 0.3, 0.2, 0.2, 0.04, 0.04],
  [0.35, 0.3, 0.1, 0.1, 0.12, 0.03],
  [0.15, 0.25, 0.25, 0.22, 0.03, 0.1],
  [0.15, 0.2, 0.35, 0.22, 0.0, 0.08],
];
// the season as four weights that sum to 1, from the day of the year (0 is the first day of spring)
export function seasonWeights(dayOfYear) {
  const t = ((dayOfYear % YEAR.days) + YEAR.days) % YEAR.days / YEAR.days * 4; // 0..4
  const w = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) { const c = i + 0.5, d = Math.min(Math.abs(t - c), Math.abs(t - c - 4), Math.abs(t - c + 4)); w[i] = Math.max(0, 1 - d); } // each season peaks at its middle (the quarter from i to i + 1)
  const s = w.reduce((a, b) => a + b, 0); return w.map((v) => v / s);
}
// the weather of one day
export function dayWeather(seed, day) {
  const doy = ((day % YEAR.days) + YEAR.days) % YEAR.days, sw = seasonWeights(doy);
  const H = (k) => hash01(day | 0, k, (seed | 0) ^ 0x5ea50);
  let r = H(1), kind = 0, acc = 0;
  for (let k = 0; k < KINDS.length; k++) { let p = 0; for (let s = 0; s < 4; s++) p += ODDS[s][k] * sw[s]; acc += p; if (r < acc) { kind = k; break; } }
  const name = KINDS[kind];
  const base = { clear: 0.08, fair: 0.4, overcast: 0.9, rain: 0.95, storm: 0.98, fog: 0.6 }[name];
  const cover = clamp(base + (H(2) - 0.5) * 0.2, 0, 1);
  const wind = { clear: 2.5, fair: 3.5, overcast: 4, rain: 6, storm: 13, fog: 1 }[name] * (0.7 + 0.6 * H(3));
  const rain = name === 'rain' ? 0.5 + 0.5 * H(4) : name === 'storm' ? 1 : 0;
  const fog = name === 'fog' ? 0.7 + 0.3 * H(5) : name === 'overcast' ? 0.2 : 0.05;
  // temperature: the season's mean with a daily swing, in degrees (winter nights freeze the lakes)
  const temp = 10 + 13 * Math.cos((doy / YEAR.days - 0.4) * 6.283) + (H(6) - 0.5) * 8;
  return { kind: name, cover, wind, windDir: H(7) * 6.283, rain, fog, temp, dayOfYear: doy };
}
// the state at (day, hour): the fields the world draws, blended over the night into the next day
export function weatherAt(seed, day, hour) {
  const a = dayWeather(seed, day), b = dayWeather(seed, day + 1);
  const k = smoothstep(21, 29, hour + (hour < 5 ? 24 : 0)); // 21:00 to 05:00 next day: a goes over into b
  const L = (f) => mix(a[f], b[f], k);
  const cover = L('cover'), fog = L('fog') * (1 - 0.8 * smoothstep(8, 12, hour)) * (1 + 0.6 * (1 - smoothstep(5, 9, hour)));
  const storm = a.kind === 'storm' ? smoothstep(13, 17, hour) * (1 - smoothstep(21, 24, hour)) : 0;
  const rain = L('rain') * (a.kind === 'storm' ? storm : 1) * (a.kind === 'rain' ? 0.6 + 0.4 * Math.sin(hour * 1.7 + day) * 0.5 + 0.2 : 1);
  const wind = L('wind') * (0.6 + 0.4 * Math.max(0, Math.sin((hour - 3) / 24 * 6.283))) * (1 + storm * 0.8);
  const dir = a.windDir + (hour / 24) * 0.4;
  const temp = L('temp') + 4 * Math.sin((hour - 9) / 24 * 6.283);
  return { kind: a.kind, cover, cloudDens: 0.6 + 0.6 * cover + storm * 0.8, haze: 0.7 + 1.2 * cover + fog * 2, mist: 0.6 + fog * 6 + rain * 1.5, wet: clamp(rain * 1.2, 0, 1), rain, snow: temp < 1 ? rain : 0, wind: [Math.sin(dir) * wind, Math.cos(dir) * wind], storm, temp, fog, dayOfYear: a.dayOfYear };
}
// the season's look at a day of the year. t is 0 at the first day of spring: summer begins at 0.25, autumn at 0.5,
// winter at 0.75, and the peaks are a quarter season later
export function seasonAt(dayOfYear) {
  const sw = seasonWeights(dayOfYear), t = ((dayOfYear % YEAR.days) + YEAR.days) % YEAR.days / YEAR.days;
  const [spring, summer, autumn, winter] = sw;
  const wrap = (a, b, x) => smoothstep(a, b, x); // helpers on the year's circle are written out below
  const fresh = wrap(0.02, 0.08, t) * (1 - wrap(0.14, 0.26, t));                                   // young leaves
  const leafTint = [mix(1, 1.15, fresh), mix(1, 1.08, fresh), mix(1, 0.72, fresh)];
  const autumnK = wrap(0.55, 0.66, t) * (1 - wrap(0.74, 0.82, t));                                 // the colours
  const leafGone = clamp(wrap(0.7, 0.82, t) * (1 - wrap(0.985, 1.0, t)) + (1 - wrap(0.0, 0.08, t)) * (t < 0.5 ? 1 : 0), 0, 1);
  const snow = clamp(wrap(0.76, 0.86, t) * (1 - wrap(0.97, 1.0, t)) + (1 - wrap(0.0, 0.06, t)) * (t < 0.5 ? 1 : 0), 0, 1);
  const snowLine = mix(mix(520, 860, summer), -50, snow);                                           // metres above the sea
  const bloom = wrap(0.12, 0.2, t) * (1 - wrap(0.5, 0.58, t));
  const yellow = wrap(0.55, 0.75, t) * (1 - wrap(0.98, 1.0, t)) + (1 - wrap(0.0, 0.1, t)) * (t < 0.5 ? 1 : 0);
  const grassTint = [mix(1, 1.12, yellow), mix(1, 0.9, yellow), mix(1, 0.58, yellow)];
  const freeze = clamp(wrap(0.8, 0.88, t) * (1 - wrap(0.98, 1.0, t)) + (1 - wrap(0.0, 0.05, t)) * (t < 0.5 ? 1 : 0), 0, 1);
  const dec = 0.41 * Math.cos((t - 0.375) * 6.283); // the sun's declination: +0.41 rad at midsummer, -0.41 at midwinter
  return { t, spring, summer, autumn, winter, leafTint, autumn: autumnK, leafGone, snow, snowLine, bloom, grassTint, freeze, dec };
}
export const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter'];
export function seasonName(dayOfYear) { const w = seasonWeights(dayOfYear); let b = 0; for (let i = 1; i < 4; i++) if (w[i] > w[b]) b = i; return SEASON_NAMES[b]; }
