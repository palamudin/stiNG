// The wild land round a settled area (GDD 21.6). Port of poc/sim/wild.js, held to it by the parity digest "wild".
using System.Collections.Generic;
using static Sting.Core.R;
#pragma warning disable IDE1006
namespace Sting.Core
{
    public sealed class WildSite { public Num x, z, h; }
    public static class Wild
    {
        static readonly Num cell = 1800, warp = 0.55, hills = 80, lift = 14, mountains = 780, ridgeCell = 3400, roll = 22, rollCell = 520,
            beach = 0.8, shelf = 2.4, contCell = 9000, step = 5, riverCell = 2600, riverW = 7, riverBank = 15, riverDepth = 2.6,
            trailCell = 420, trailW = 0.75, moistCell = 1300, forestCell = 760, ocean = 70,
            lakeCell = 2200, lakeShare = 0.75, lakeR0 = 160, lakeR1 = 560, lakeDrop0 = 2, lakeDrop1 = 6, lakeDepth0 = 4, lakeDepth1 = 14, lakeRim = 0.35, lakeBlend = 0.15,
            sea = 0, relief = 1, blocky = 0.6;
        const int octaves = 10;
        public static readonly Num Edge = 46, Band = 160;

        static uint Hash3(int x, int y, int s)
        {
            unchecked
            {
                uint h = ((uint)x * 0x8da6b343u) ^ ((uint)y * 0xd8163841u) ^ ((uint)s * 0xcb1ab31fu);
                h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
                return h;
            }
        }
        static Num Hash01(int x, int y, int s) => Hash3(x, y, s) / 4294967296.0;
        static void Noised(Num x, Num y, int s, Num[] o)
        {
            Num px = Floor(x), py = Floor(y), fx = x - px, fy = y - py; int ix = (int)px, iy = (int)py;
            Num ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
            Num dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
            Num a = Hash01(ix, iy, s) * 2 - 1, b = Hash01(ix + 1, iy, s) * 2 - 1, c = Hash01(ix, iy + 1, s) * 2 - 1, d = Hash01(ix + 1, iy + 1, s) * 2 - 1;
            Num k1 = b - a, k2 = c - a, k4 = a - b - c + d;
            o[0] = a + k1 * ux + k2 * uy + k4 * ux * uy; o[1] = dux * (k1 + k4 * uy); o[2] = duy * (k2 + k4 * ux);
        }
        static Num SStep(Num a, Num b, Num x) { Num t = Min(1, Max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
        static int Ss(int s, int k) { unchecked { return s * 7919 + k * 104729; } }
        public static int Seed(ulong seed) => (int)(seed & 0x7fffffff);

        static void Broad(int S, Num x, Num z, Num[] o)
        {
            var N = new Num[3];
            Num bx = (0.6 * x - 0.8 * z) / cell, by = (0.8 * x + 0.6 * z) / cell;
            Noised(bx * 0.5 + 3.1, by * 0.5 + 7.7, Ss(S, 1), N); Num w1 = N[0];
            Noised(bx * 0.5 - 5.3, by * 0.5 + 1.9, Ss(S, 2), N); Num w2 = N[0];
            Num px = bx + warp * w1, py = by + warp * w2, a = 0, b = 1, dx = 0, dy = 0, alo = 0;
            for (int i = 0; i < octaves; i++)
            {
                Noised(px, py, Ss(S, 10 + i), N);
                dx += N[1]; dy += N[2];
                a += b * N[0] / (1 + dx * dx + dy * dy);
                if (i == 5) alo = a;
                b *= 0.5;
                Num qx = 0.8 * px - 0.6 * py, qy = 0.6 * px + 0.8 * py; px = qx * 2.03; py = qy * 2.03;
            }
            Num rh = 0, rbb = 1, rdx = 0, rdy = 0, hx = (0.8 * x + 0.6 * z) / rollCell + 1.7 * w2, hz = (-0.6 * x + 0.8 * z) / rollCell - 1.3 * w1;
            for (int i = 0; i < 4; i++)
            {
                Noised(hx, hz, Ss(S, 50 + i), N);
                rdx += N[1]; rdy += N[2];
                rh += rbb * N[0] / (1 + rdx * rdx + rdy * rdy);
                rbb *= 0.45; Num qx = 0.8 * hx - 0.6 * hz, qz = 0.6 * hx + 0.8 * hz; hx = qx * 2.1; hz = qz * 2.1;
            }
            Noised(x / contCell + 0.37, z / contCell - 0.61, Ss(S, 3), N);
            Num cn = N[0], oc = ocean * SStep(0.0, -0.45, cn);
            o[0] = (hills * a + roll * rh + lift) * relief - oc;
            o[1] = (hills * alo + roll * rh + lift) * relief - oc;
            o[2] = w1; o[3] = w2; o[4] = cn;
        }
        sealed class Lake { public Num cx, cz, R, level, depth, d; }
        static readonly int[,] Rim = { { 1, 0 }, { 0, 1 }, { -1, 0 }, { 0, -1 } };
        static Lake LakeAt(int S, Num x, Num z)
        {
            int ci = (int)Floor(x / lakeCell), cj = (int)Floor(z / lakeCell);
            if (Hash01(ci, cj, Ss(S, 70)) > lakeShare) return null;
            Num R = lakeR0 + (lakeR1 - lakeR0) * Hash01(ci, cj, Ss(S, 71));
            Num jit = Max(0, lakeCell / 2 - R * 1.32 * (1 + lakeRim) - 10);
            Num cx = (ci + 0.5) * lakeCell + (Hash01(ci, cj, Ss(S, 72)) * 2 - 1) * jit, cz = (cj + 0.5) * lakeCell + (Hash01(ci, cj, Ss(S, 73)) * 2 - 1) * jit;
            Num a = DAtan2(z - cz, x - cx), R0 = R; var N = new Num[3];
            Noised(1.6 + 1.9 * DCos(a), 2.3 + 1.9 * DSin(a), unchecked(Ss(S, 77) + ci * 31 + cj * 17), N);
            R *= 1 + 0.32 * N[0];
            Num d = Sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
            if (d > R0 * 1.32 * (1 + lakeRim)) return null;
            var B2 = new Num[5]; Broad(S, cx, cz, B2); Num lo = B2[1];
            Num rr = R0 * (1 + 0.4 * lakeRim);
            for (int k = 0; k < 4; k++) { Broad(S, cx + rr * Rim[k, 0], cz + rr * Rim[k, 1], B2); lo = Min(lo, B2[1]); }
            Num level = lo - (lakeDrop0 + (lakeDrop1 - lakeDrop0) * Hash01(ci, cj, Ss(S, 74)));
            if (level < sea + 4 || level > 120) return null;
            return new Lake { cx = cx, cz = cz, R = R, level = level, d = d, depth = lakeDepth0 + (lakeDepth1 - lakeDepth0) * Hash01(ci, cj, Ss(S, 75)) };
        }
        /// the wild land at (x, z) on its own map: height, moisture, forest, trail, water level
        public static Num[] At(int S, Num x, Num z, Num[] o = null)
        {
            o ??= new Num[5]; var B1 = new Num[5]; var N = new Num[3];
            Broad(S, x, z, B1);
            Num h = B1[0], hlo = B1[1], w1 = B1[2], w2 = B1[3];
            var lake = LakeAt(S, x, z);
            Num wl = sea, inLake = 0, band = 0;
            if (lake != null)
            {
                Num R = lake.R, d = lake.d;
                inLake = 1 - SStep(R * (1 - lakeBlend), R, d);
                band = 1 - SStep(R * (1 + 0.6 * lakeRim), R * (1 + lakeRim), d);
                if (d < R * (1 + 0.4 * lakeRim)) wl = lake.level;
            }
            h += (hlo - h) * (1 - SStep(1.5, 5, Abs(hlo - wl)));
            { Num e = h - wl; h += beach * e / Sqrt(e * e + 0.36); if (e < 0) h -= shelf * SStep(0.2, 1.8, -e); }
            Num cont = SStep(-0.2, 0.45, B1[4]) * (1 - inLake);
            Num r = 0, rb = 0.55, rx = (0.6 * x + 0.8 * z + 611 * w1) / ridgeCell, rz = (-0.8 * x + 0.6 * z - 577 * w2) / ridgeCell, prev = 1;
            for (int i = 0; i < 6; i++)
            {
                Noised(rx, rz, Ss(S, 30 + i), N);
                Num k = 1 - Abs(N[0]), kk = k * k * k * prev;
                r += rb * kk; prev = Clamp(kk * 2.2, 0, 1); rb *= 0.48;
                Num qx = 0.8 * rx - 0.6 * rz, qz = 0.6 * rx + 0.8 * rz; rx = qx * 2.07; rz = qz * 2.07;
            }
            Num m = mountains * cont * Sqrt(cont) * r * relief;
            if (blocky > 0 && m > 0) { Num q = m / step, fl = Floor(q), f = q - fl, k = 0.5 * (1 - blocky) + 0.02; m = (fl + SStep(0.5 - k, 0.5 + k, f)) * step; }
            h += m;
            Noised((x + 520 * w2) / riverCell, (z - 480 * w1) / riverCell, Ss(S, 4), N);
            Num rd = Abs(N[0]) / Max(Sqrt(N[1] * N[1] + N[2] * N[2]), 0.08) * riverCell;
            Num low = 1 - SStep(18, 55, h);
            Num river = (1 - SStep(riverW, riverW + riverBank, rd)) * low * (1 - inLake) * (1 - band);
            h += (Min(h, sea - riverDepth * (1 - SStep(0, riverW, rd) * 0.4)) - h) * river;
            if (inLake > 0) { Num q = lake.d / lake.R; Noised(x / 90, z / 90, Ss(S, 76), N); Num bowl = lake.level - lake.depth * (1 - q * q) * (0.85 + 0.15 * N[0]); h += (bowl - h) * inLake; }
            Noised(x / moistCell + 9.1, z / moistCell - 2.3, Ss(S, 5), N);
            Num moist = Clamp(0.5 + 0.45 * N[0] + 0.4 * (1 - SStep(wl, wl + 14, h)) - 0.3 * SStep(300, 600, h - sea), 0, 1);
            Noised((0.8 * x - 0.6 * z + 340 * w1) / forestCell, (0.6 * x + 0.8 * z + 360 * w2) / forestCell, Ss(S, 6), N); Num fo = N[0];
            Noised((0.6 * x + 0.8 * z) / (forestCell * 0.31) + 2.2 * w2, (-0.8 * x + 0.6 * z) / (forestCell * 0.31) - 1.7 * w1, Ss(S, 60), N); fo += 0.45 * N[0];
            Noised(x / (forestCell * 0.09), z / (forestCell * 0.09), Ss(S, 61), N); fo += 0.18 * N[0];
            Num forest = SStep(0.02, 0.3, fo + 0.3 * (moist - 0.5)) * (1 - SStep(420, 560, h - sea)) * SStep(wl + 1.2, wl + 3.5, h) * (1 - river);
            Noised((x - 90 * w2) / trailCell, (z + 70 * w1) / trailCell, Ss(S, 7), N);
            Num td = Abs(N[0]) / Max(Sqrt(N[1] * N[1] + N[2] * N[2]), 0.1) * trailCell;
            Num trail = (1 - SStep(trailW * 0.6, trailW * 1.5, td)) * (1 - SStep(0.35, 0.6, forest)) * SStep(wl + 1.5, wl + 3, h) * (1 - SStep(60, 90, h - sea));
            Noised(x / 2.3 + 0.5, z / 2.3 - 0.5, Ss(S, 8), N); Num micro = 0.12 * N[0];
            Noised(x / 0.83, z / 0.83, Ss(S, 9), N); micro += 0.035 * N[0];
            h += micro * (1 - trail) * SStep(wl + 0.3, wl + 2, h) - 0.07 * trail;
            if (lake != null && band > 0 && inLake < 1) h += (Max(h, lake.level + 1.2) - h) * band * (1 - inLake);
            o[0] = h; o[1] = moist; o[2] = forest; o[3] = trail; o[4] = wl;
            return o;
        }
        static readonly Dictionary<long, WildSite> sites = new Dictionary<long, WildSite>();
        /// the settled area's site: the first flat, dry lowland searching outward from the wild origin (wild.js wildSite)
        public static WildSite Site(int S, int radius)
        {
            long key = (long)S * 65536 + radius;
            lock (sites) { if (sites.TryGetValue(key, out var v)) return v; }
            var o = new Num[5]; Num minH = 10 + sea; WildSite best = null;
            for (int r = 0; r < 20000 && best == null; r += 150)
                for (int k = 0; k < 26 && best == null; k++)
                {
                    Num a = k * (Num)0.25, x = DCos(a) * r, z = DSin(a) * r;
                    bool ok = true; Num hs = 0; var H = new List<Num>();
                    for (int q = 0; q < 9 && ok; q++)
                    {
                        At(S, x + (q % 3 - 1) * radius * (Num)0.7, z + (q / 3 - 1) * radius * (Num)0.7, o);
                        if (o[0] < minH || o[0] > sea + 90) ok = false; hs += o[0]; H.Add(o[0]);
                    }
                    if (!ok) continue;
                    Num hm = hs / 9, spread = 0;
                    foreach (var h in H) spread = Max(spread, Abs(h - hm));
                    if (spread < 18) best = new WildSite { x = x, z = z, h = hm };
                }
            best ??= new WildSite { x = 0, z = 0, h = Max(minH, At(S, 0, 0, o)[0]) };
            lock (sites) { if (sites.Count > 64) sites.Clear(); sites[key] = best; }
            return best;
        }
    }
}
