// Tests for World v2 that need no browser. Run from poc/: node world/test/world.test.mjs
// The GPU side (the GLSL twin against the JS, the clipmap as drawn against its source) is in gpu-parity.html and
// clip-parity.html, run headless (see WORLD.md, "Verification").
import { readFileSync } from 'node:fs';
import { hash3, hash01, vnoised } from '../noise.js';
import { wildSource, wildSample, wildParams } from '../sources/wild.js';
import { surfaceNets, treeDesign, meshTree, TREE_KINDS } from '../mesh.js';
import { placeTile } from '../scatter.js';
import { T } from '../../sim/tuning.js';
import { applyTuning } from '../../sim/tunefile.js';
import { stingSource } from '../sources/sting.js';
import { u64, DEFAULT_SETTINGS } from '../../sim/index.js';
import { WAVES, omega, seaState, fieldStats, integralVar, ifftStockham, fieldAtCPU, downwindShare } from '../waves.js';
import { lakeAt } from '../sources/wild.js';
import { treeDesign as cardDesign, meshTreeCards, leafAtlas, TREE_KINDS as CARD_KINDS } from '../treecards.js';
import { dayWeather, weatherAt, seasonAt, seasonName, YEAR } from '../seasons.js';
import { compositeSource, findSite } from '../sources/composite.js';
import { Places } from '../map.js';
applyTuning(T, readFileSync(new URL('../../../tuning/sting.tune', import.meta.url), 'utf8'));

let failures = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) failures++; };

// noise: the hash is fixed (these numbers are what the GLSL twin must produce too), and the derivatives are right
{
  const fixed = [hash3(0, 0, 0), hash3(1, 2, 3), hash3(-5, 7, 1234), hash3(2147483647, -2147483648, 99)];
  ok(fixed.join(',') === '0,72785788,87401219,993094244', `hash values are fixed (the GLSL twin is held to the same function in gpu-parity.html): ${fixed.join(', ')}`);
  let worst = 0; const N = [0, 0, 0], e = 1e-5;
  for (let k = 0; k < 2000; k++) {
    const x = (hash01(k, 1, 5) - 0.5) * 2000, y = (hash01(k, 2, 5) - 0.5) * 2000;
    vnoised(x, y, 17, N); const v = N[0], dx = N[1], dy = N[2];
    const fx = (vnoised(x + e, y, 17, [0, 0, 0])[0] - vnoised(x - e, y, 17, [0, 0, 0])[0]) / (2 * e);
    const fy = (vnoised(x, y + e, 17, [0, 0, 0])[0] - vnoised(x, y - e, 17, [0, 0, 0])[0]) / (2 * e);
    worst = Math.max(worst, Math.abs(fx - dx), Math.abs(fy - dy));
    if (Math.abs(v) > 1.0001) worst = 99;
  }
  ok(worst < 1e-4, `value noise stays in -1..1 and its analytic derivatives match finite differences (worst ${worst.toExponential(1)})`);
}

// the wild source: deterministic, sane ranges, shores without puddle plains, cost per sample
{
  const s = wildSource({ seed: 7 }), s2 = wildSource({ seed: 7 });
  let same = true, mn = 1e9, mx = -1e9, water = 0, n = 0;
  const t0 = performance.now();
  for (let z = -6000; z <= 6000; z += 150) for (let x = -6000; x <= 6000; x += 150) {
    const a = s.sample(x, z), b = s2.sample(x, z); if (a.some((v, i) => v !== b[i])) same = false;
    mn = Math.min(mn, a[0]); mx = Math.max(mx, a[0]); if (a[0] < 0) water++; n++;
    if (a[1] < 0 || a[1] > 1 || a[2] < 0 || a[2] > 1 || a[3] < 0 || a[3] > 1) same = false;
  }
  const us = (performance.now() - t0) / (2 * n) * 1000;
  ok(same, 'the same seed gives the same world, sample for sample, and moisture, forest and trail stay in 0..1');
  ok(mn < -10 && mx > 150 && water / n > 0.05 && water / n < 0.4, `relief ${mn.toFixed(0)}..${mx.toFixed(0)} m, ${(100 * water / n).toFixed(0)}% under water`);
  let flips = 0, band = 0;
  for (let z = -2000; z <= 2000; z += 9) for (let x = -2000; x <= 2000; x += 9) {
    const h = s.height(x, z); if (Math.abs(h) > 1.5) continue; band++;
    let same8 = 0; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) if ((s.height(x + dx, z + dz) < 0) === (h < 0)) same8++;
    if (same8 === 0) flips++;
  }
  ok(band > 1000 && flips === 0, `shores: no lone puddles or islets of a metre among ${band} samples near the water line (${flips})`);
  ok(us < 25, `a sample costs ${us.toFixed(1)} µs in JS`);
}

// meshing: watertight, outward, on the surface; every tree design closes and stays within its budget
{
  const r = surfaceNets((x, y, z) => Math.hypot(x, y, z) - 1, [-1.3, -1.3, -1.3], [1.3, 1.3, 1.3], 0.1);
  const p = r.pos; let vol = 0, err = 0;
  for (let i = 0; i < r.idx.length; i += 3) { const a = r.idx[i] * 3, b = r.idx[i + 1] * 3, c = r.idx[i + 2] * 3;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6; }
  for (let i = 0; i < p.length; i += 3) err = Math.max(err, Math.abs(Math.hypot(p[i], p[i + 1], p[i + 2]) - 1));
  const E = new Map(); for (let i = 0; i < r.idx.length; i += 3) for (let e = 0; e < 3; e++) { const a = r.idx[i + e], b = r.idx[i + (e + 1) % 3]; const k = Math.min(a, b) + ',' + Math.max(a, b); E.set(k, (E.get(k) || 0) + 1); }
  let open = 0; for (const v of E.values()) if (v !== 2) open++;
  ok(open === 0 && Math.abs(vol / (4 / 3 * Math.PI) - 1) < 0.03 && err < 0.01, `surface nets on a sphere: closed (${open} open edges), volume ${(vol / (4 / 3 * Math.PI) * 100).toFixed(1)}% of exact, vertices within ${(err * 1000).toFixed(1)} mm`);
  const CELLS = { oak: [0.24, 0.6, 1.4], birch: [0.22, 0.55, 1.3], pine: [0.3, 0.7, 1.6], bush: [0.16, 0.4, 1.0], rock: [0.12, 0.3, 0.7] };
  const BUDGET = [6000, 1500, 400];
  let bad = [], worstMulti = 0;
  for (const k of TREE_KINDS) for (let v = 1; v <= 3; v++) {
    const d = treeDesign(k, v);
    for (let l = 0; l < 3; l++) {
      const m = meshTree(d, CELLS[k][l]);
      // holes (an edge with one face) would show; non-manifold edges (more than two faces, where two sheets of
      // surface pass through one cell, a known property of surface nets) do not, but are counted
      const E2 = new Map(); for (let i = 0; i < m.idx.length; i += 3) for (let e = 0; e < 3; e++) { const a = m.idx[i + e], b = m.idx[i + (e + 1) % 3]; const kk = Math.min(a, b) + ',' + Math.max(a, b); E2.set(kk, (E2.get(kk) || 0) + 1); }
      let holes = 0, multi = 0; for (const c of E2.values()) { if (c === 1) holes++; else if (c > 2) multi++; }
      worstMulti = Math.max(worstMulti, multi / Math.max(1, E2.size));
      if (holes || m.tris > BUDGET[l] || m.tris === 0) bad.push(`${k}${v} L${l}: ${m.tris} tris, ${holes} hole edges`);
    }
  }
  ok(bad.length === 0 && worstMulti < 0.02, `every tree, bush and rock design meshes without holes at all three levels, within ${BUDGET.join(' / ')} triangles (non-manifold edges at most ${(worstMulti * 100).toFixed(2)}%)` + (bad.length ? ': ' + bad.join('; ') : ''));
}

// placement: deterministic per tile, nothing in the water or on trails, the sim's trees one for one
{
  const s = wildSource({ seed: 7 }), kinds = TREE_KINDS, cfg = { tile: 64, variants: 3, grid: 5.2, meadow: 0.012 };
  const design = { oak: treeDesign('oak', 1), birch: treeDesign('birch', 1) };
  let same = true, total = 0, wet = 0, onTrail = 0;
  for (let j = -6; j < 6; j++) for (let i = -6; i < 6; i++) {
    const a = placeTile(s, i, j, kinds, cfg, design), b = placeTile(s, i, j, kinds, cfg, design);
    if (JSON.stringify(a) !== JSON.stringify(b)) same = false;
    for (let k = 0; k < kinds.length; k++) for (const list of a[k]) for (let n = 0; n < list.length; n += 8) {
      const o = s.sample(list[n], list[n + 1]); total++;
      if (o[0] < s.sea - (kinds[k] === 'rock' ? 0.31 : 0)) wet++;
      if (o[3] > 0.31) onTrail++;
    }
  }
  ok(same && total > 200 && wet === 0 && onTrail === 0, `placement is the same every time; ${total} objects in 144 tiles, none in the water (${wet}) or on a trail (${onTrail})`);
  const settings = { ...DEFAULT_SETTINGS, terrain: 2, seed: 1234 }, sim = { seed: u64(1234), settings, records: new Map() };
  const ss = stingSource(sim);
  let simTrees = 0, drawn = 0;
  for (let cz = -3; cz <= 3; cz++) for (let cx = -3; cx <= 3; cx++) {
    simTrees += ss.objects(cx, cz).trees.length;
    const it = placeTile(ss, cx, cz, ['oak', 'birch'], cfg, design);
    for (const k of it) for (const l of k) drawn += l.length / 8;
  }
  ok(simTrees > 0 && simTrees === drawn, `the game's world: ${drawn} trees drawn for the sim's ${simTrees}, one for one`);
  const o = ss.sample(0, 0);
  ok(Math.abs(o[0]) < 1e-9 && o[3] < 0.3, `the game's world: the ground at the home tree is level (the sim flattens it) and unpaved (wear ${o[3].toFixed(2)} at the trunk's foot, under 0.3)`);
}


// waves (W2): the FFT's index math, the spectrum against its own integral and against the fetch law, glassy water in
// still air, and the sign of the chop
{
  const N = 64, re = [], im = [];
  for (let i = 0; i < N; i++) { re.push(Math.sin(i * 1.3) + 0.02 * i * i); im.push(Math.cos(i * 0.7) - 0.5); }
  const [r, q] = ifftStockham(re, im); let worst = 0;
  for (let m = 0; m < N; m++) { let a = 0, b = 0; for (let j = 0; j < N; j++) { const t = 2 * Math.PI * j * m / N; a += re[j] * Math.cos(t) - im[j] * Math.sin(t); b += re[j] * Math.sin(t) + im[j] * Math.cos(t); } worst = Math.max(worst, Math.abs(a - r[m]), Math.abs(b - q[m])); }
  ok(worst < 1e-9, `waves: the Stockham passes the GPU runs equal a plain inverse DFT (worst ${worst.toExponential(1)})`);
  const lakes = [[3, 600], [6.8, 600], [12, 600], [8, 5000]].map(([U, F]) => {
    const P = seaState(U, F), s = fieldStats(P, [48, 6.9, 1.0, 0.14], [1, 0]), iv = integralVar(P, 1e-3, 2e4);
    const Hj = 0.0016 * Math.sqrt(9.81 * F / (U * U)) * U * U / 9.81; // JONSWAP: Hs = 0.0016 sqrt(gF/U^2) U^2/g
    return { U, F, grid: s.Hs, int: 4 * Math.sqrt(iv), jonswap: Hj };
  });
  ok(lakes.every((l) => Math.abs(l.grid / l.int - 1) < 0.03), `waves: the cascades' grids hold the spectrum's height variance (Hs ${lakes.map((l) => `${(l.grid * 100).toFixed(1)}/${(l.int * 100).toFixed(1)} cm`).join(', ')})`);
  ok(lakes.every((l) => Math.abs(l.int / l.jonswap - 1) < 0.15), `waves: Elfouhaily's spectrum gives the JONSWAP fetch law's wave height on a lake within 15% (${lakes.map((l) => `U10 ${l.U} m/s over ${l.F} m: ${(l.int * 100).toFixed(1)} against ${(l.jonswap * 100).toFixed(1)} cm`).join('; ')})`);
  const bath = seaState(2.5, 0.8), still = seaState(0.6, 0.8);
  ok(2 * Math.PI / bath.kp < 0.03 && 2 * Math.PI / bath.kp > 0.005, `waves: a breeze (U10 2.5 m/s) over a birdbath (0.8 m fetch) peaks at ${(2 * Math.PI / bath.kp * 100).toFixed(1)} cm ripples`);
  ok(still.onset === 0 && fieldStats(still, [0.6, 0.085], [1, 0]).varH === 0, `waves: below a friction velocity of 2 cm/s (here ${(still.ustar * 100).toFixed(1)} cm/s) the water is glassy (Kahma and Donelan 1988)`);
  ok(Math.abs(downwindShare(0.3) + downwindShare(-0.3) - 1) < 1e-12 && downwindShare(1) === 1 && downwindShare(0) === 0.5, 'waves: the energy of each direction is split downwind and upwind without loss');
  const lam = (k) => { const gk = WAVES.g * k, tk = WAVES.T * k ** 3; return (gk - tk) / (gk + tk); };
  ok(lam(10) > 0.99 && lam(2000) < -0.9 && Math.abs(lam(Math.sqrt(WAVES.g / WAVES.T))) < 1e-9, 'waves: the chop sharpens crests of gravity waves and troughs of capillary ripples, changing over at 1.7 cm');
  // a crest is compressed: with the chop's sign, the horizontal Jacobian at the highest of many points is under 1
  const P = seaState(6.8, 600), pts = []; for (let i = 0; i < 400; i++) pts.push([i * 0.11, 0.37 * i]);
  const F2 = fieldAtCPU(P, [48], [1, 0], 3.0, pts, 5, 32), F3 = fieldAtCPU(P, [48], [1, 0], 3.0, pts.map(([x, z]) => [x + 0.01, z]), 5, 32);
  let top = 0; F2.forEach((f, i) => { if (f[1] > F2[top][1]) top = i; });
  const jxx = 1 + (F3[top][0] - F2[top][0]) / 0.01;
  ok(jxx < 1, `waves: at the highest crest of a lake the surface is squeezed together (1 + dDx/dx = ${jxx.toFixed(3)})`);
  const w = omega(Math.sqrt(WAVES.g / WAVES.T));
  ok(Math.abs(w / Math.sqrt(WAVES.g / WAVES.T) - Math.sqrt(2 * WAVES.g / Math.sqrt(WAVES.g / WAVES.T))) < 1e-9 && Math.abs(2 * Math.PI / Math.sqrt(WAVES.g / WAVES.T) - 0.0171) < 0.0003, `waves: the slowest ripple is ${(200 * Math.PI / Math.sqrt(WAVES.g / WAVES.T)).toFixed(2)} cm long and runs at ${(w / Math.sqrt(WAVES.g / WAVES.T) * 100).toFixed(1)} cm/s`);
}

// W3: the wild world's water level field, the card trees and their atlas, the seasons and weather, the composite
{
  // lakes: where the water level field jumps from a lake's level to the sea, the ground is above both, so no water
  // shows at the jump; inside the basin the floor is under the level; the shore crosses at a gentle slope
  const src = wildSource({ seed: 7 }), P = src.params, o = [0, 0, 0, 0, 0];
  let lakes = 0, jumps = 0, badJumps = 0, bowl = 0, badBowl = 0, maxSlope = 0;
  for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++) {
    const lk = lakeAt(P, (i + 0.5) * 2200, (j + 0.5) * 2200); if (!lk) continue; lakes++;
    const cx = lk.cx, cz = lk.cz, R = lk.R, level = lk.level;
    for (let a = 0; a < 6.283; a += 0.13) {
      let prevW = null, prevH = null;
      for (let r = 0; r < R * 1.5; r += 4) {
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r; src.sample(x, z, o);
        if (r < R * 0.5) { bowl++; if (o[0] >= o[4]) badBowl++; }
        if (prevW !== null && Math.abs(o[4] - prevW) > 0.5) { jumps++; if (o[0] < Math.max(o[4], prevW) + 0.5 || prevH < Math.max(o[4], prevW) + 0.5) badJumps++; }
        if (prevH !== null && r > R * 0.7 && r < R * 1.05 && o[0] > o[4] && prevH <= prevW) maxSlope = Math.max(maxSlope, (o[0] - prevH) / 4);
        prevW = o[4]; prevH = o[0];
      }
    }
  }
  ok(lakes > 20 && badBowl === 0, `wild world: ${lakes} lakes at their own levels; every point in the inner half of a basin is under its level (${bowl} points)`);
  ok(jumps > 0 && badJumps === 0, `wild world: the water level field jumps ${jumps} times along radial lines and the ground is above both levels at every jump`);
  let sea = 0, n = 0; for (let k = 0; k < 3000; k++) { const x = (hash01(k, 1, 9) - 0.5) * 20000, z = (hash01(k, 2, 9) - 0.5) * 20000; src.sample(x, z, o); n++; if (o[0] < o[4]) sea++; }
  ok(sea / n > 0.25 && sea / n < 0.55, `wild world: ${(100 * sea / n).toFixed(0)}% of a 20 km square is under water (an ocean coast with lakes)`);
  // card trees: every design meshes at three levels, leaves carry the crown's sphere normal, wood the cylinder's
  let worst = '';
  for (const k of CARD_KINDS) { if (k === 'rock') continue; for (let v = 1; v <= 3; v++) { const d = cardDesign(k, v); for (let l = 0; l < 3; l++) { const m = meshTreeCards(d, l); if (m.tris === 0 || m.pos.some((x) => !Number.isFinite(x))) worst = `${k} ${v} level ${l}`; for (let i = 0; i < m.verts; i++) { const nl = Math.hypot(m.nor[i * 3], m.nor[i * 3 + 1], m.nor[i * 3 + 2]); if (Math.abs(nl - 1) > 1e-3) worst = `${k} ${v} level ${l}: normal ${nl}`; } } } }
  const oak = meshTreeCards(cardDesign('oak', 1), 0), oak2 = meshTreeCards(cardDesign('oak', 1), 2);
  ok(!worst && oak.tris > 400 && oak.tris < 900 && oak2.tris < 40, `card trees: every kind and variety meshes at three levels with unit normals; an oak is ${oak.tris} triangles near and ${oak2.tris} far${worst ? ' (bad: ' + worst + ')' : ''}`);
  const A = leafAtlas(); let alpha = 0; for (let i = 3; i < A.data.length; i += 4) alpha += A.data[i] ? 1 : 0;
  ok(alpha / (A.size * A.size) > 0.05 && alpha / (A.size * A.size) < 0.3, `leaf atlas: ${A.size} px, ${(100 * alpha / (A.size * A.size)).toFixed(1)}% leaf pixels, in 2 x 2 blocks`);
  // seasons: the year's turn, the weather's odds, the sun's track
  const names = [45, 135, 225, 315].map(seasonName);
  const W = seasonAt(315), Su = seasonAt(135), Au = seasonAt(230);
  ok(names.join() === 'spring,summer,autumn,winter' && W.snow > 0.9 && W.freeze > 0.9 && W.leafGone > 0.9 && Su.snow === 0 && Su.bloom > 0.9 && Su.leafGone === 0 && Au.autumn > 0.5, `seasons: ${names.join(', ')}; deep winter snow ${W.snow.toFixed(2)}, ice ${W.freeze.toFixed(2)}, leaves gone ${W.leafGone.toFixed(2)}; midsummer bloom ${Su.bloom.toFixed(2)}; autumn colour ${Au.autumn.toFixed(2)}`);
  const kinds = {}; for (let d = 0; d < YEAR.days * 3; d++) { const w = dayWeather(7, d); kinds[w.kind] = (kinds[w.kind] || 0) + 1; }
  const same = JSON.stringify(dayWeather(7, 33)) === JSON.stringify(dayWeather(7, 33)) && dayWeather(7, 33).kind !== undefined;
  ok(same && Object.keys(kinds).length === 6 && kinds.storm > 5 && kinds.clear > 100, `weather: six kinds over three years (${Object.entries(kinds).map(([k, v]) => k + ' ' + v).join(', ')}), the same for the same day`);
  const night = weatherAt(7, 10, 2), noon = weatherAt(7, 10, 12);
  ok(night.wind.length === 2 && noon.cover >= 0 && noon.cover <= 1 && noon.haze > 0 && noon.mist > 0, `weather at an hour: cover ${noon.cover.toFixed(2)}, haze ${noon.haze.toFixed(2)}, wind ${Math.hypot(...noon.wind).toFixed(1)} m/s at noon of day 10`);
  // the composite: inside the settled area the sim's ground plus the lift; beyond the band the wild world; the site is land
  const settings = { ...DEFAULT_SETTINGS, terrain: 2, seed: 1234 }, sim = { seed: u64(1234), settings, records: new Map() };
  const st = stingSource(sim), wd = wildSource({ seed: 1234 }), cs = compositeSource(st, wd, { radius: 300, band: 120 });
  const hIn = cs.height(10, 20), hSt = st.height(10, 20), hOut = cs.height(2000, 0), hW = wd.height(2000 + cs.site.x, cs.site.z);
  ok(Math.abs(hIn - hSt - cs.lift) < 1e-9 && Math.abs(hOut - hW) < 1e-9 && cs.lift > wd.sea + 9, `composite: inside the town the sim's ground lifted by ${cs.lift.toFixed(1)} m (the site at ${cs.site.x.toFixed(0)}, ${cs.site.z.toFixed(0)}); beyond the band the wild ground exactly`);
  let mono = true, prev = cs.height(0, 300); for (let r = 300; r <= 420; r += 2) { const h = cs.height(0, r); if (Math.abs(h - prev) > 3) mono = false; prev = h; }
  ok(mono, 'composite: across the band the ground changes by less than 3 m per 2 m step (no wall at the seam)');
  // the map's places: a scan round the wild start finds water, food and nest sites
  const pl = new Places(wd, { cell: 220, radius: 3000 }); while (pl.scan(0, 0, 1e9)) { /* until done */ }
  const by = {}; for (const p of pl.list) by[p.kind] = (by[p.kind] || 0) + 1;
  ok(pl.list.length > 5 && by.water && by.nest, `map: ${pl.list.length} places within 3 km of the wild origin (${Object.entries(by).map(([k, v]) => k + ' ' + v).join(', ')})`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
