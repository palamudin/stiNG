// The composite source (W3): the game's settled world set down in the wild one, so a start can be urban, semi-urban
// or wild by how far the settled area reaches. Inside `radius` everything is the sim's (sources/sting.js: its
// ground, land use, paving, ponds, trees), lifted by one constant so the town stands on a site of the wild land above
// the sea; over the band outside, the ground and the land channels blend into the wild generator (sources/wild.js),
// evaluated with the site's offset so the town lands where the wild land is flat and dry. Beyond the band it is the
// wild world: forests, lakes, the coast, the mountains.
//
// The seam (GDD 20.4) holds: inside the settled area the sim's groundAt is the drawn ground up to the constant lift
// (the sim works in height above the ground, so nothing in play changes); nothing here writes to the sim. Gameplay
// beyond the settled area would need the wild height in the sim with a C# twin: that is the game thread's call, and
// until then the wild land is scenery a wasp can fly over but the sim does not know.
import { wildSource, wildSample } from './wild.js';
import { smoothstep } from '../noise.js';

// a site for the town: a flat, dry lowland on the wild map, searched outward from the wild origin
export function findSite(wild, opts = {}) {
  const P = wild.params, o = [0, 0, 0, 0, 0], want = opts.radius || 300, minH = (opts.minH ?? 10) + P.sea;
  let best = null;
  for (let r = 0; r < 20000 && !best; r += 150) for (let a = 0; a < 6.283 && !best; a += 0.25) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    let ok = true, hs = 0, n = 0;
    for (let k = 0; k < 9 && ok; k++) { // nine samples over the settled area: all land, gently sloped, above the sea
      const px = x + (k % 3 - 1) * want * 0.7, pz = z + (Math.floor(k / 3) - 1) * want * 0.7;
      wildSample(P, px, pz, o); if (o[0] < minH || o[0] > P.sea + 90) ok = false; hs += o[0]; n++;
    }
    if (!ok) continue;
    const hm = hs / n; let spread = 0;
    for (let k = 0; k < 9; k++) { const px = x + (k % 3 - 1) * want * 0.7, pz = z + (Math.floor(k / 3) - 1) * want * 0.7; wildSample(P, px, pz, o); spread = Math.max(spread, Math.abs(o[0] - hm)); }
    if (spread < 18) best = { x, z, h: hm };
  }
  return best || { x: 0, z: 0, h: Math.max(minH, wildSample(P, 0, 0, o)[0]) };
}

// sting: the game's source; wild: a wild source; radius: the settled area's radius in metres (0: wild only);
// band: the blend's width; site: { x, z, h } on the wild map (findSite)
export function compositeSource(sting, wild, opts = {}) {
  const R0 = opts.radius ?? 400, B = opts.band ?? 160, R1 = R0 + B, site = opts.site || findSite(wild, { radius: R0 });
  // simHeight (the game, GDD 21.6): the sim's ground is already the settled area on the wild land and the wild land
  // beyond (sim/wild.js), so the height is the sim's everywhere and only the other channels blend here
  const ox = site.x, oz = site.z, lift = opts.simHeight ? 0 : site.h, P = wild.params, simH = !!opts.simHeight;
  const ws = [0, 0, 0, 0, 0], ss = [0, 0, 0, 0, 0];
  function sample(x, z, out = [0, 0, 0, 0, 0], texel) {
    const r = Math.hypot(x, z);
    if (r >= R1) { wildSample(P, x + ox, z + oz, out); if (simH) out[0] = sting.height(x, z); return out; }
    sting.sample(x, z, ss, texel); ss[0] += lift;
    if (r <= R0) { out[0] = ss[0]; out[1] = ss[1]; out[2] = ss[2]; out[3] = ss[3]; out[4] = -1e6; return out; }
    const k = smoothstep(R0, R1, r);
    wildSample(P, x + ox, z + oz, ws);
    out[0] = simH ? ss[0] : ss[0] + (ws[0] - ss[0]) * k; out[1] = ss[1] + (ws[1] - ss[1]) * k; out[2] = ss[2] + (ws[2] - ss[2]) * k; out[3] = ss[3] * (1 - k) + ws[3] * k;
    out[4] = k > 0.5 ? ws[4] : -1e6; // the wild water level only where the wild ground has the say
    return out;
  }
  const height = (x, z) => sample(x, z, ws)[0];
  return {
    kind: 'sting',
    params: { ...sting.params, seed: sting.params.seed, wildSeed: P.seed },
    cosmetic: sting.cosmetic,
    sea: P.sea,
    sample, height,
    waterAt: (x, z) => sample(x, z, ws)[4],
    lakeAt: (x, z) => (Math.hypot(x, z) < R1 ? null : wild.lakeAt(x + ox, z + oz)),
    glsl: null, uniforms: {},
    chunkSize: sting.chunkSize,
    objects: (cx, cz) => sting.objects(cx, cz), // the sim's chunks; the scatter plants the wild forest beyond wildFrom
    trunks: false,
    wildFrom: R1,
    simTrees: simH, // the game: the sim plants the near wild trees, the ones a wasp hits (GDD 21.6); the far cards follow the forest channel
    waters: (cx, cz) => sting.waters(cx, cz),
    grassHeight: sting.grassHeight, grassWood: sting.grassWood,
    wildGrass: wild.grassHeight,
    water: wild.water,
    trailIsPaving: true,
    site, lift,
  };
}
