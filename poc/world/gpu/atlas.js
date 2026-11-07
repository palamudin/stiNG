// The atlases: every surface's small detail as layers of an array texture, made once at load from our own recipes
// (tileable noise, cells, ripples), mipmapped, then only read: a pixel finds its material and reads its layer, instead
// of evaluating noise for it every frame. Two textures per atlas, each layer the same tile:
//   A: colour (sRGB-ish albedo, linear in use) and height (0..1: hollows hold water, crests dry first)
//   B: the normal's x and z (0.5 + 0.5 n), roughness, cavity (occlusion)
// The ground's layers (GROUND): sand, shingle, earth and mud, rock, grass soil, forest floor, snow; each tile spans
// its own size in metres (TILE). The water's and the foliage's atlases come the same way.
import * as THREE from 'three/webgpu';

export const GROUND = { sand: 0, shingle: 1, earth: 2, rock: 3, grass: 4, forest: 5, snow: 6, n: 7, size: 256 };
export const TILE = [1.6, 1.2, 2.2, 3.5, 2.0, 2.4, 2.0]; // metres a tile spans, per layer (none a multiple of another)

// tileable value noise over a period of p cells, and its fbm; tileable Worley (the nearest feature point, its id)
function hash(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function vnoise(x, y, p, s) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const m = (a) => ((a % p) + p) % p, h = (a, b) => hash(m(a), m(b), s);
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}
function fbm(x, y, p, s, oct = 4) { let a = 0, w = 0.5, f = 1; for (let o = 0; o < oct; o++) { a += w * vnoise(x * f, y * f, p * f, s + o); w *= 0.5; f *= 2; } return a / (1 - Math.pow(0.5, oct)); }
function worley(x, y, p, s) {
  const i = Math.floor(x), j = Math.floor(y); let d1 = 9, d2 = 9, id = 0;
  for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
    const ci = i + a, cj = j + b, mi = ((ci % p) + p) % p, mj = ((cj % p) + p) % p;
    const px = ci + 0.15 + 0.7 * hash(mi, mj, s), py = cj + 0.15 + 0.7 * hash(mi, mj, s + 7), d = Math.hypot(x - px, y - py);
    if (d < d1) { d2 = d1; d1 = d; id = hash(mi, mj, s + 13); } else if (d < d2) d2 = d;
  }
  return [d1, d2, id];
}
// tileable scatter of rotated, stretched blobs (stones, leaves, blades): the topmost blob over (x, y) on a period of
// p cells, each cell's blob there with probability dens, its angle and size its own: [cover 0..1 (1 at its middle), id]
function scatter(x, y, p, s, dens, elong, rad = 0.4) {
  const i = Math.floor(x), j = Math.floor(y); let best = 0, bid = 0, top = -1;
  for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
    const ci = i + a, cj = j + b, mi = ((ci % p) + p) % p, mj = ((cj % p) + p) % p;
    if (hash(mi, mj, s + 3) > dens) continue;
    const px = ci + hash(mi, mj, s), py = cj + hash(mi, mj, s + 7), an = 6.2832 * hash(mi, mj, s + 11), id = hash(mi, mj, s + 13);
    const dx = x - px, dy = y - py, c = Math.cos(an), sn = Math.sin(an), lx = (dx * c + dy * sn) / elong, ly = -dx * sn + dy * c;
    const r = rad * (0.6 + 0.6 * hash(mi, mj, s + 17)), d = Math.hypot(lx, ly) / r;
    if (d < 1 && id > top) { top = id; best = 1 - d * d; bid = id; }
  }
  return [best, bid];
}
const lin = (c) => Math.pow(c, 2.2);
// each layer: (u, v in 0..1) -> [r, g, b (linear), height, roughness]
const RECIPES = [
  (u, v) => { // sand: wind ripples (an integer wave across the tile, warped), grains
    const w = fbm(u * 4, v * 4, 4, 11), rip = 0.5 + 0.5 * Math.sin(2 * Math.PI * (9 * u + 4 * v) + 3.5 * w), g = hash(Math.floor(u * 256), Math.floor(v * 256), 3);
    const h = 0.75 * Math.pow(rip, 1.4) + 0.25 * fbm(u * 16, v * 16, 16, 12);
    const t = 0.9 + 0.12 * (g - 0.5) + 0.06 * (h - 0.5);
    return [lin(0.86) * t, lin(0.78) * t, lin(0.58) * t * (0.95 + 0.1 * g), h, 0.92];
  },
  (u, v) => { // shingle: rounded, flattened stones lying every way in their sand, each its own grey or brown
    const [s1, i1] = scatter(u * 9, v * 9, 9, 21, 0.9, 1.5, 0.55), [s2, i2] = scatter(u * 17, v * 17, 17, 23, 0.6, 1.3, 0.45);
    const stone = Math.max(s1, s2), id = s1 >= s2 ? i1 : i2, k = stone > 0 ? 1 : 0, c = 0.36 + 0.32 * id, warm = hash(Math.floor(id * 97), 1, 5);
    const sand = [0.7, 0.63, 0.47], st = [c * (1 + 0.15 * warm), c, c * (1 - 0.12 * warm)], sh = 0.85 + 0.15 * fbm(u * 30, v * 30, 30, 22);
    const col = (k ? st : sand).map((x) => lin(x) * sh * (k ? 0.8 + 0.2 * Math.sqrt(stone) : 1));
    return [col[0], col[1], col[2], k ? 0.35 + 0.65 * Math.sqrt(stone) * (0.7 + 0.3 * id) : 0.15 * sh, k ? 0.55 : 0.9];
  },
  (u, v) => { // earth and mud: lumps, crumbs, a few cracks
    const l = fbm(u * 5, v * 5, 5, 31), c = fbm(u * 24, v * 24, 24, 32), [d1, d2] = worley(u * 4, v * 4, 4, 33), crack = Math.min(1, (d2 - d1) * 6);
    const h = 0.6 * l + 0.3 * c + 0.1 * crack, t = 0.75 + 0.35 * l;
    return [lin(0.43) * t, lin(0.34) * t, lin(0.24) * t, h, 0.88];
  },
  (u, v) => { // rock: broken planes, strata, lichen spots
    const f = fbm(u * 3, v * 3, 3, 41, 5), s = 0.5 + 0.5 * Math.sin(2 * Math.PI * (6 * v + 1 * u) + 4 * f), [d1, d2] = worley(u * 5, v * 5, 5, 42);
    const h = 0.55 * f + 0.25 * s + 0.2 * Math.min(1, (d2 - d1) * 3), t = 0.7 + 0.45 * f, li = fbm(u * 12, v * 12, 12, 43) > 0.68 ? 1 : 0;
    return [lin(0.52) * t * (1 - 0.15 * li), lin(0.5) * t * (1 + 0.05 * li), lin(0.46) * t * (1 - 0.2 * li), h, 0.72];
  },
  (u, v) => { // grass soil seen from above: blades leaning every way over soil, denser in clumps, moss between
    const cl = fbm(u * 5, v * 5, 5, 51), [b1, i1] = scatter(u * 48, v * 48, 48, 52, 0.45 + 0.5 * cl, 5, 0.32), [b2, i2] = scatter(u * 31, v * 31, 31, 53, 0.3 + 0.4 * cl, 6, 0.3);
    const blade = Math.max(b1, b2), id = b1 > b2 ? i1 : i2, m = fbm(u * 18, v * 18, 18, 54), k = 0.8 + 0.3 * cl;
    const soil = [0.36 + 0.06 * m, 0.3 + 0.08 * m, 0.18], bl = [0.36 + 0.14 * id, 0.56 + 0.12 * id, 0.2 + 0.06 * id];
    const t = blade > 0 ? 0.55 + 0.45 * blade : 0, c = soil.map((x, n) => x * (1 - t) + bl[n] * t);
    return [lin(c[0]) * k, lin(c[1]) * k, lin(c[2]) * k, 0.3 * cl + 0.15 * m + 0.55 * blade, 0.95];
  },
  (u, v) => { // forest floor: humus, leaves and needles fallen over each other, a twig now and then
    const d = fbm(u * 6, v * 6, 6, 61), [l1, i1] = scatter(u * 22, v * 22, 22, 62, 0.75, 1.7, 0.42), [l2, i2] = scatter(u * 13, v * 13, 13, 63, 0.35, 1.5, 0.4);
    const [nd] = scatter(u * 70, v * 70, 70, 64, 0.6, 6, 0.3), [tw] = scatter(u * 3, v * 3, 3, 65, 0.4, 14, 0.14);
    const leaf = Math.max(l1 > 0 ? 1 : 0, l2 > 0 ? 1 : 0), id = l2 > 0 ? i2 : i1, k = 0.65 + 0.45 * d;
    const hum = [0.2, 0.15, 0.1], lf = [0.4 + 0.25 * id, 0.27 + 0.12 * id, 0.12 + 0.04 * id], ne = [0.42, 0.3, 0.16];
    let c = hum.map((x, n) => x * (1 - 0.6 * (nd > 0 ? 1 : 0)) + ne[n] * 0.6 * (nd > 0 ? 1 : 0));
    if (leaf) c = lf; if (tw > 0) c = [0.25, 0.19, 0.13];
    const h = 0.35 * d + 0.35 * leaf * (0.5 + 0.5 * Math.max(l1, l2)) + 0.15 * (nd > 0 ? 1 : 0) + 0.25 * (tw > 0 ? tw : 0);
    return [lin(c[0]) * k, lin(c[1]) * k, lin(c[2]) * k, Math.min(1, h), leaf ? 0.8 : 0.93];
  },
  (u, v) => { // snow: soft drifts, sparkle in the roughness
    const d = fbm(u * 4, v * 4, 4, 71), sp = hash(Math.floor(u * 256), Math.floor(v * 256), 72) > 0.985 ? 1 : 0;
    return [lin(0.95), lin(0.96), lin(0.99), d, sp ? 0.15 : 0.5];
  },
];

// the ground's atlas, built once: [A, B] DataArrayTextures, mipmapped, repeating
export function bakeGroundAtlas() {
  const S = GROUND.size, N = GROUND.n, A = new Uint8Array(S * S * 4 * N), B = new Uint8Array(S * S * 4 * N), H = new Float32Array(S * S);
  const enc = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  for (let l = 0; l < N; l++) {
    const R = RECIPES[l], base = l * S * S * 4, rough = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const r = R((x + 0.5) / S, (y + 0.5) / S), o = base + (y * S + x) * 4;
      A[o] = enc(Math.pow(r[0], 1 / 2.2)); A[o + 1] = enc(Math.pow(r[1], 1 / 2.2)); A[o + 2] = enc(Math.pow(r[2], 1 / 2.2)); A[o + 3] = enc(r[3]);
      H[y * S + x] = r[3]; rough[y * S + x] = r[4];
    }
    // the normal from the height (wrapping), its relief scaled to the layer's tile; the cavity from the local mean
    const amp = [0.012, 0.03, 0.015, 0.06, 0.012, 0.015, 0.02][l] / (TILE[l] / S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const at = (i, j) => H[((j + S) % S) * S + ((i + S) % S)];
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * amp, dz = (at(x, y + 1) - at(x, y - 1)) * 0.5 * amp, n = Math.hypot(dx, 1, dz);
      const mean = (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2)) * 0.25, cav = Math.max(0, Math.min(1, 1 - (mean - at(x, y)) * 3));
      const o = base + (y * S + x) * 4;
      B[o] = enc(0.5 - 0.5 * dx / n); B[o + 1] = enc(0.5 - 0.5 * dz / n); B[o + 2] = enc(rough[y * S + x]); B[o + 3] = enc(cav);
    }
  }
  const mk = (data) => { const t = new THREE.DataArrayTexture(data, S, S, N); t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true; return t; };
  return [mk(A), mk(B)];
}
