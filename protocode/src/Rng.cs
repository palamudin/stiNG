// --- file: Rng.cs
namespace Sting.Core
{
    public enum RngDomain : ulong
    {
        WorldGen = 1, HumanTraits = 2, HumanSchedule = 3, Clothing = 4,
        Flight = 5, Colony = 6, Ecology = 7, Weather = 8, Bees = 9,
    }

    /// Every random value is a pure function of its inputs (R-05).
    public static class Rng
    {
        static ulong Mix(ulong z)
        {
            // SplitMix64 finalizer
            z += 0x9E3779B97F4A7C15UL;
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
            return z ^ (z >> 31);
        }

        public static ulong Hash(ulong seed, RngDomain domain, ulong a, ulong b = 0, ulong c = 0)
        {
            ulong h = Mix(seed);
            h = Mix(h ^ (ulong)domain);
            h = Mix(h ^ a);
            h = Mix(h ^ b);
            h = Mix(h ^ c);
            return h;
        }

        /// Uniform Fix64 in [0, 1).
        public static Fix64 Unit(ulong hash) => Fix64.FromRaw((long)(hash >> 32));

        /// Uniform Fix64 in [lo, hi).
        public static Fix64 Range(ulong hash, Fix64 lo, Fix64 hi) => lo + (hi - lo) * Unit(hash);

        /// Uniform int in [lo, hi). Span must be below 2^32.
        public static int RangeInt(ulong hash, int lo, int hi)
        {
            ulong span = (ulong)(hi - lo);
            return lo + (int)(((hash >> 32) * span) >> 32);
        }
    }
}
