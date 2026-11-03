// The map (W3): there is no separate map. Zooming out from the wasp, the view turns into one: past a few hundred
// metres the picture is redrawn as a map in the same pass that finishes the frame, from the same clipmap the ground
// stands on. Pixels snap to a coarse grid (tinyrj's pixel-art look), colours go to a map palette by height, hillshade
// comes from the ground's normal under a north-west light, water is flat blue by depth with a dark coast line, forests
// are dotted, trails dashed, contours every 20 m. The blend is continuous with the zoom, so the ground never jumps
// from picture to map. Pins for places of interest (water, food, nest sites) are plain HTML over the canvas, placed
// by projecting their world positions each frame and clustered when they crowd; a click opens a card.
//
// Places come from the source itself (scanned on the CPU in a ring round the wasp, a few cells a frame): lakes and
// the sea, meadows in bloom (food for a wasp: nectar), fruit woods, and nest sites (old hollow trees in dense wood,
// cliff crevices on steep ground, dry banks for burrows). In the game the sim's own place list (GDD 19.6 T3-2) takes
// over: it is the authority on what is where; this scan is the template's stand-in.
import { hash01, smoothstep } from './noise.js';

export const MAP = { from: 350, to: 2600, pixel: 4, contour: 20, pitch: 1.18, fov: 22 };

// the map pass: reads the finished frame, the depth and the clipmap; uMap 0..1 is how far into the map we are
export const MAP_GLSL = /* glsl */ `
uniform sampler2D tColor, tDepth; uniform mat4 uInvProj, uCamWorld; uniform vec3 uCamPos; uniform float uLogF, uMap, uSea, uSnowLine; uniform vec2 uRes;
vec3 viewRayZ(vec2 uv) { vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0); p.xyz /= p.w; return p.xyz / -p.z; }
#define L(r, g, b) pow(vec3(r, g, b), vec3(2.2))
vec3 mapLand(float h, float forest, float moist) {
  // a hypsometric scale: meadow greens low, olive and buff on the hills, grey stone, white snow
  vec3 c = L(0.62, 0.78, 0.42);
  c = mix(c, L(0.74, 0.76, 0.46), smoothstep(40.0, 160.0, h));
  c = mix(c, L(0.78, 0.68, 0.5), smoothstep(160.0, 360.0, h));
  c = mix(c, L(0.66, 0.6, 0.56), smoothstep(360.0, 560.0, h));
  c = mix(c, L(0.95, 0.95, 0.97), smoothstep(uSnowLine - 40.0, uSnowLine + 40.0, h));
  c = mix(c, c * vec3(0.72, 0.84, 0.66), smoothstep(0.3, 0.7, forest) * 0.8);
  return c;
}
vec4 mapColor(vec2 uv) {
  vec2 px = uRes * uv;
  // snap to the map's pixel grid as the map comes in
  float g = mix(1.0, ${MAP.pixel.toFixed(1)}, smoothstep(0.0, 0.6, uMap));
  vec2 suv = (floor(px / g) + 0.5) * g / uRes;
  vec3 photo = texture(tColor, suv).rgb;
  float d = texture(tDepth, suv).r;
  if (d >= 1.0) return vec4(photo, 0.0); // the sky stays
  vec3 vz = viewRayZ(suv); vec3 v = normalize((uCamWorld * vec4(vz, 0.0)).xyz);
  float dist = (exp2(d * uLogF) - 1.0) * length(vz);
  vec3 P = uCamPos + v * dist; vec2 xz = P.xz;
  vec4 T = clipAt(xz); float W = clipWater(xz); vec3 N = clipNormal(xz);
  float h = T.x - uSea, depth = W - T.x;
  bool water = depth > 0.0;
  vec3 col;
  if (water) {
    col = mix(L(0.55, 0.78, 0.9), L(0.2, 0.45, 0.75), smoothstep(0.0, 14.0, depth));
    if (W > uSea + 1.0) col *= vec3(0.92, 0.95, 1.05); // a lake above the sea: a shade lighter
  } else {
    col = mapLand(h, T.z, T.y);
    // hillshade from the north-west, as on a printed map
    float sh = clamp(dot(N, normalize(vec3(-0.5, 0.75, -0.5))), 0.0, 1.0);
    col *= 0.55 + 0.6 * sh;
    // forests: a dot pattern in world space; trails: dashed
    vec2 dc = floor(xz / 9.0); float dot_ = step(0.6, length(fract(xz / 9.0) - 0.5) * 2.0) * w2hash01(int(dc.x), int(dc.y), 777);
    col *= mix(1.0, 0.82, smoothstep(0.35, 0.7, T.z) * (1.0 - dot_) * 0.9);
    float dash = step(0.5, fract((xz.x + xz.y) / 6.0));
    col = mix(col, L(0.45, 0.3, 0.18), smoothstep(0.3, 0.6, T.w) * dash);
    // contours
    float cf = fract(h / ${MAP.contour.toFixed(1)}), cw = fwidth(h / ${MAP.contour.toFixed(1)}) * 1.2;
    float line = 1.0 - smoothstep(0.0, cw, min(cf, 1.0 - cf));
    col *= 1.0 - 0.28 * line * (1.0 - smoothstep(1.0, 3.0, cw));
  }
  // the coast and lake shores: a dark line where the water meets the land (the depth's zero crossing)
  float e = fwidth(depth) * 1.5;
  float shore = 1.0 - smoothstep(0.0, e, abs(depth));
  col = mix(col, L(0.12, 0.2, 0.3), shore * 0.85);
  return vec4(col, 1.0);
}
`;

// ---- places of interest, scanned from the source on the CPU
const SYL = { a: ['Ald', 'Bre', 'Cor', 'Dun', 'Esk', 'Fen', 'Gal', 'Hol', 'Ith', 'Kel', 'Lun', 'Mor', 'Nes', 'Ork', 'Pen', 'Ros', 'Sel', 'Tor', 'Ulv', 'Wen'], b: ['', 'a', 'e', 'i', 'o', 'ar', 'en', 'in', 'or'], c: ['mere', 'water', 'tarn', 'holm', 'fell', 'lea', 'wick', 'ness', 'dale', 'garth', 'brae', 'moss'] };
export function placeName(i, j, seed) { const r = (k) => hash01(i, j, seed * 7 + k); const p = (a, k) => a[Math.floor(r(k) * a.length) % a.length]; return p(SYL.a, 1) + p(SYL.b, 2) + p(SYL.c, 3); }

export class Places {
  // src: the source; cell: metres per scan cell; radius: metres round the centre scanned
  constructor(src, opts = {}) {
    this.src = src; this.cell = opts.cell || 220; this.radius = opts.radius || 6000;
    this.list = []; this.seen = new Set(); this._queue = []; this._c = null;
    this.o = [0, 0, 0, 0, 0];
  }
  // scan a few cells round (x, z) each call; returns true while there is more to do
  scan(x, z, budgetMs = 2) {
    const C = this.cell, ci = Math.round(x / C), cj = Math.round(z / C), n = Math.ceil(this.radius / C);
    if (!this._c || Math.abs(this._c[0] - ci) > 4 || Math.abs(this._c[1] - cj) > 4) {
      this._c = [ci, cj]; this._queue = [];
      for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) { const k = (ci + i) + ',' + (cj + j); if (!this.seen.has(k) && Math.hypot(i, j) <= n) this._queue.push([Math.hypot(i, j), ci + i, cj + j]); }
      this._queue.sort((a, b) => a[0] - b[0]);
      this.list = this.list.filter((p) => Math.hypot(p.x - x, p.z - z) < this.radius * 1.5);
    }
    const t0 = performance.now();
    while (this._queue.length && performance.now() - t0 < budgetMs) {
      const [, i, j] = this._queue.shift(); const k = i + ',' + j; if (this.seen.has(k)) continue; this.seen.add(k);
      this._cell(i, j);
    }
    return this._queue.length > 0;
  }
  _cell(i, j) {
    const C = this.cell, src = this.src, o = this.o, seed = src.params.seed | 0;
    // the cell's lake, once per lake (its centre's cell)
    if (src.lakeAt) {
      const lk = src.lakeAt((i + 0.5) * C, (j + 0.5) * C);
      if (lk && Math.floor(lk.cx / C) === i && Math.floor(lk.cz / C) === j) this.list.push({ kind: 'water', sub: 'lake', x: lk.cx, z: lk.cz, r: lk.R, level: lk.level, name: placeName(i, j, seed) });
    }
    // nine samples: what the cell mostly is
    let water = 0, sea = 0, meadow = 0, wood = 0, steep = 0, dry = 0, hsum = 0, n = 0, wet = 0;
    for (let b = 0; b < 3; b++) for (let a = 0; a < 3; a++) {
      const x = (i + (a + 0.5) / 3) * C, z = (j + (b + 0.5) / 3) * C;
      src.sample(x, z, o); const h = o[0], wl = o[4] ?? src.sea;
      n++;
      if (h < wl) { water++; if (wl <= src.sea + 0.5) sea++; continue; }
      hsum += h - src.sea;
      const sl = Math.abs(src.height(x + 8, z) - h) / 8 + Math.abs(src.height(x, z + 8) - h) / 8;
      if (sl > 0.9) steep++;
      if (o[2] > 0.6) wood++;
      if (o[2] < 0.25 && o[3] < 0.2 && o[1] > 0.45 && sl < 0.35) meadow++;
      if (o[1] < 0.35 && sl > 0.2 && sl < 0.6) dry++;
      wet += o[1];
    }
    const x = (i + 0.5) * C, z = (j + 0.5) * C, land = n - water;
    if (sea >= 2 && land >= 2) this.list.push({ kind: 'water', sub: 'shore', x, z, name: 'the shore' });
    if (land === 0) return;
    const hm = hsum / land;
    if (meadow / land > 0.7 && hash01(i, j, 91) < 0.5) this.list.push({ kind: 'food', sub: 'meadow', x, z, h: hm, name: placeName(i, j, seed + 1) + ' meadow' });
    if (wood / land > 0.75 && hash01(i, j, 92) < 0.14) this.list.push({ kind: 'nest', sub: 'hollow', x, z, h: hm, name: placeName(i, j, seed + 2) + ' wood' });
    if (steep / land > 0.5 && hash01(i, j, 93) < 0.18) this.list.push({ kind: 'nest', sub: 'crevice', x, z, h: hm, name: placeName(i, j, seed + 3) + ' crag' });
    if (dry / land > 0.6 && hash01(i, j, 94) < 0.12) this.list.push({ kind: 'nest', sub: 'burrow', x, z, h: hm, name: placeName(i, j, seed + 4) + ' bank' });
    if (wood / land > 0.5 && wet / land > 0.6 && hash01(i, j, 95) < 0.12) this.list.push({ kind: 'food', sub: 'fruit', x, z, h: hm, name: placeName(i, j, seed + 5) + ' orchard' });
  }
}

// what a card says about a place, with the distance from the wasp and the season
export function placeCard(p, from, season) {
  const d = Math.hypot(p.x - from.x, p.z - from.z), ds = d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km';
  const lines = [];
  if (p.kind === 'water' && p.sub === 'lake') { lines.push(`A lake, ${Math.round(p.r * 2)} m across, ${p.level.toFixed(0)} m above the sea.`); lines.push(season.freeze > 0.5 ? 'Frozen over: no water to drink until the thaw.' : 'Water at the shore, and the swash a wasp can drink from.'); }
  else if (p.kind === 'water') { lines.push('The sea. Salt water: a wasp drinks from the wet sand and the pools behind the beach.'); }
  else if (p.sub === 'meadow') { lines.push('An open meadow.'); lines.push(season.bloom > 0.5 ? 'In bloom: nectar in the flowers, and the insects that come to them.' : season.bloom > 0.05 ? 'Coming into bloom, or going over.' : 'Out of bloom: nothing to feed on here now.'); }
  else if (p.sub === 'fruit') { lines.push('A damp wood with fruit trees.'); lines.push(season.autumn > 0.2 || (season.t > 0.45 && season.t < 0.75) ? 'Windfalls on the ground: sugar in late summer and autumn.' : 'No fruit yet.'); }
  else if (p.sub === 'hollow') { lines.push('Old, dense woodland: hollow trunks and cavities under bark, a nest site out of the weather.'); }
  else if (p.sub === 'crevice') { lines.push('Steep ground with crevices in the rock: a sheltered nest site, hard for a bird to reach.'); }
  else if (p.sub === 'burrow') { lines.push('A dry bank: ground soft enough for a burrow, above the floods.'); }
  if (p.h !== undefined) lines.push(`${Math.round(p.h)} m above the sea.`);
  return { title: p.name, kind: p.kind, sub: p.sub, dist: ds, lines };
}
