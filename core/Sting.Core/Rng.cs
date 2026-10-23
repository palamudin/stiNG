// Counter-based RNG and deterministic math (GDD 3.4, 3.5, A.2). Port of poc/sim/rng.js, bit for bit.
// Sim code may only use + - * / sqrt floor abs min max and the functions in this file.
namespace Sting.Core
{
    public static class Domain
    {
        public const ulong WorldGen = 1, HumanTraits = 2, HumanSchedule = 3, Clothing = 4,
            Flight = 5, Colony = 6, Ecology = 7, Weather = 8, Bees = 9, Cosmetic = 10;
    }

    public static class R
    {
        public const double PI = 3.141592653589793, TAU = 2 * PI, HALF_PI = PI / 2;

        static ulong Mix(ulong z)
        {
            unchecked
            {
                z += 0x9E3779B97F4A7C15UL;
                z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
                z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
                return z ^ (z >> 31);
            }
        }

        public static ulong Hash(ulong seed, ulong domain, ulong a, ulong b = 0, ulong c = 0)
        {
            ulong h = Mix(seed);
            h = Mix(h ^ domain);
            h = Mix(h ^ a);
            h = Mix(h ^ b);
            h = Mix(h ^ c);
            return h;
        }

        public static double Unit(ulong h) => (double)(h >> 32) / 4294967296.0;
        public static double Range(ulong h, double lo, double hi) => lo + (hi - lo) * Unit(h);
        public static int RangeInt(ulong h, int lo, int hi) => lo + (int)(((h >> 32) * (ulong)(hi - lo)) >> 32);
        /// BigInt.asUintN(64, n) for a JS integer
        public static ulong U64(long n) => unchecked((ulong)n);

        /// JS ToInt32 for the integer-valued doubles the sim passes
        public static int I32(double x) => unchecked((int)(long)x);

        /// Small 32-bit hash for per-tick decisions (rng.js h32). Returns [0, 1).
        public static double H32(double a, double b = 0, double c = 0, double d = 0)
        {
            unchecked
            {
                int h = (int)0x9e3779b9 ^ I32(a);
                h = (int)((uint)(h ^ (int)((uint)h >> 16)) * 0x85ebca6bu) ^ I32(b);
                h = (int)((uint)(h ^ (int)((uint)h >> 13)) * 0xc2b2ae35u) ^ I32(c);
                h = (int)((uint)(h ^ (int)((uint)h >> 16)) * 0x27d4eb2fu) ^ I32(d);
                h ^= (int)((uint)h >> 15);
                h = (int)((uint)h * 0x2c1b3c6du);
                h ^= (int)((uint)h >> 12);
                return (uint)h / 4294967296.0;
            }
        }

        public static double DSin(double x)
        {
            x = x - TAU * System.Math.Floor((x + PI) / TAU);
            if (x > HALF_PI) x = PI - x;
            else if (x < -HALF_PI) x = -PI - x;
            double x2 = x * x;
            return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110 * (1 - x2 / 156))))));
        }
        public static double DCos(double x) => DSin(x + HALF_PI);

        public static double Sq(double x) => x * x;
        /// Round half up (rng.js rnd), never Math.Round
        public static double Rnd(double x) => System.Math.Floor(x + 0.5);
        public static int RndI(double x) => (int)System.Math.Floor(x + 0.5);

        public static double DAtan2(double y, double x)
        {
            if (x == 0 && y == 0) return 0;
            double ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
            bool swap = ay > ax;
            double t = swap ? ax / ay : ay / ax;
            const double SQ3 = 1.7320508075688772;
            bool big = t > 0.2679491924311227;
            double u = big ? (t * SQ3 - 1) / (t + SQ3) : t, u2 = u * u;
            double r = u * (1 - u2 * (1.0 / 3 - u2 * (1.0 / 5 - u2 * (1.0 / 7 - u2 * (1.0 / 9 - u2 * (1.0 / 11 - u2 * (1.0 / 13 - u2 / 15)))))));
            if (big) r += PI / 6;
            if (swap) r = HALF_PI - r;
            if (x < 0) r = PI - r;
            return y < 0 ? -r : r;
        }

        public static double Clamp(double v, double lo, double hi) => v < lo ? lo : v > hi ? hi : v;
        public static double Clamp01(double v) => v < 0 ? 0 : v > 1 ? 1 : v;
        public static double Sqrt(double v) => System.Math.Sqrt(v);
        public static double Floor(double v) => System.Math.Floor(v);
        public static double Abs(double v) => System.Math.Abs(v);
        /// JS Math.min/max semantics: NaN wins, -0 < +0
        public static double Min(double a, double b) => System.Math.Min(a, b);
        public static double Max(double a, double b) => System.Math.Max(a, b);

        public static uint Fnv32(string s)
        {
            unchecked
            {
                uint h = 0x811c9dc5;
                for (int i = 0; i < s.Length; i++) { h ^= s[i]; h *= 0x01000193; }
                return h;
            }
        }

        public static string Hex64(ulong v) => v.ToString("x16");
    }
}
