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

        public static Num Unit(ulong h)
        {
#if STING_FIXED
            return Num.FromRaw((long)(h >> 32));
#else
            return (double)(h >> 32) / 4294967296.0;
#endif
        }
        public static Num Range(ulong h, Num lo, Num hi) => lo + (hi - lo) * Unit(h);
        public static int RangeInt(ulong h, int lo, int hi) => lo + (int)(((h >> 32) * (ulong)(hi - lo)) >> 32);
        /// BigInt.asUintN(64, n) for a JS integer
        public static ulong U64(long n) => unchecked((ulong)n);

        /// JS ToInt32 for the integer-valued numbers the sim passes: truncate, keep the low 32 bits
        public static int I32(Num x) => unchecked((int)(long)x);

        /// Small 32-bit hash for per-tick decisions (rng.js h32). Returns [0, 1).
        public static Num H32(long a, long b = 0, long c = 0, long d = 0)
        {
            unchecked
            {
                int h = (int)0x9e3779b9 ^ (int)a;
                h = (int)((uint)(h ^ (int)((uint)h >> 16)) * 0x85ebca6bu) ^ (int)b;
                h = (int)((uint)(h ^ (int)((uint)h >> 13)) * 0xc2b2ae35u) ^ (int)c;
                h = (int)((uint)(h ^ (int)((uint)h >> 16)) * 0x27d4eb2fu) ^ (int)d;
                h ^= (int)((uint)h >> 15);
                h = (int)((uint)h * 0x2c1b3c6du);
                h ^= (int)((uint)h >> 12);
#if STING_FIXED
                return Num.FromRaw((long)(uint)h);
#else
                return (uint)h / 4294967296.0;
#endif
            }
        }
        public static Num H32(Num a, Num b, Num c = default, Num d = default) => H32(I32(a), I32(b), I32(c), I32(d));

        public static Num DSin(Num x)
        {
            x = x - TAU * Floor((x + PI) / TAU);
            if (x > HALF_PI) x = PI - x;
            else if (x < -HALF_PI) x = -PI - x;
            Num x2 = x * x;
            return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110 * (1 - x2 / 156))))));
        }
        public static Num DCos(Num x) => DSin(x + HALF_PI);

        public static Num Sq(Num x) => x * x;
        /// Round half up (rng.js rnd), never Math.Round
        public static Num Rnd(Num x) => Floor(x + 0.5);
        public static int RndI(Num x) => (int)Floor(x + 0.5);

        public static Num DAtan2(Num y, Num x)
        {
            if (x == 0 && y == 0) return 0;
            Num ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
            bool swap = ay > ax;
            Num t = swap ? ax / ay : ay / ax;
            const double SQ3 = 1.7320508075688772;
            bool big = t > 0.2679491924311227;
            Num u = big ? (t * SQ3 - 1) / (t + SQ3) : t, u2 = u * u;
            Num r = u * (1 - u2 * (1.0 / 3 - u2 * (1.0 / 5 - u2 * (1.0 / 7 - u2 * (1.0 / 9 - u2 * (1.0 / 11 - u2 * (1.0 / 13 - u2 / 15)))))));
            if (big) r += PI / 6;
            if (swap) r = HALF_PI - r;
            if (x < 0) r = PI - r;
            return y < 0 ? -r : r;
        }

        public static Num Clamp(Num v, Num lo, Num hi) => v < lo ? lo : v > hi ? hi : v;
        public static Num Clamp01(Num v) => v < 0 ? 0 : v > 1 ? 1 : v;
        public static Num Sqrt(Num v) => Num.Sqrt(v);
        public static Num Floor(Num v) => Num.Floor(v);
        public static Num Ceil(Num v) => Num.Ceil(v);
        public static Num Abs(Num v) => Num.Abs(v);
        public static Num Min(Num a, Num b) => Num.Min(a, b);
        public static Num Max(Num a, Num b) => Num.Max(a, b);

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
