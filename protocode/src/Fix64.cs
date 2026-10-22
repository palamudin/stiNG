// --- file: Fix64.cs
namespace Sting.Core
{
    /// Q32.32 signed fixed point. All sim math uses this type.
    public readonly struct Fix64 : System.IEquatable<Fix64>, System.IComparable<Fix64>
    {
        public const int FracBits = 32;
        public readonly long Raw;

        public static readonly Fix64 Zero = new Fix64(0L);
        public static readonly Fix64 One = new Fix64(1L << FracBits);
        public static readonly Fix64 Half = new Fix64(1L << (FracBits - 1));
        public static readonly Fix64 MaxValue = new Fix64(long.MaxValue);
        public static readonly Fix64 MinValue = new Fix64(long.MinValue);

        private Fix64(long raw) { Raw = raw; }
        public static Fix64 FromRaw(long raw) => new Fix64(raw);
        public static Fix64 FromInt(int v) => new Fix64((long)v << FracBits);

        /// Exact rational constructor for tuning constants: FromRatio(183, 1000) = 0.183.
        public static Fix64 FromRatio(int num, int den) => FromInt(num) / FromInt(den);

        public int FloorToInt() => (int)(Raw >> FracBits);

        public static Fix64 operator +(Fix64 a, Fix64 b) => new Fix64(a.Raw + b.Raw);
        public static Fix64 operator -(Fix64 a, Fix64 b) => new Fix64(a.Raw - b.Raw);
        public static Fix64 operator -(Fix64 a) => new Fix64(-a.Raw);

        /// 64x64 -> 128 product by 32-bit halves, then take the middle 64 bits.
        public static Fix64 operator *(Fix64 a, Fix64 b)
        {
            long x = a.Raw, y = b.Raw;
            bool neg = (x < 0) ^ (y < 0);
            ulong ux = x < 0 ? (ulong)(-x) : (ulong)x;
            ulong uy = y < 0 ? (ulong)(-y) : (ulong)y;

            ulong xl = ux & 0xFFFFFFFFUL, xh = ux >> 32;
            ulong yl = uy & 0xFFFFFFFFUL, yh = uy >> 32;

            ulong ll = xl * yl;
            ulong lh = xl * yh;
            ulong hl = xh * yl;
            ulong hh = xh * yh;

            // result = (hh << 64) + ((lh + hl) << 32) + ll, shifted right by 32
            ulong mid = (ll >> 32) + (lh & 0xFFFFFFFFUL) + (hl & 0xFFFFFFFFUL);
            ulong hi = hh + (lh >> 32) + (hl >> 32) + (mid >> 32);
            ulong lo = (mid << 32) >> 32; // bits 32..63 of the full product

            if ((hi >> 31) != 0) return neg ? MinValue : MaxValue; // saturate
            ulong r = (hi << 32) | lo;
            return new Fix64(neg ? -(long)r : (long)r);
        }

        /// Long division on magnitudes: (|a| << 32) / |b| without 128-bit types.
        public static Fix64 operator /(Fix64 a, Fix64 b)
        {
            if (b.Raw == 0) throw new System.DivideByZeroException();
            bool neg = (a.Raw < 0) ^ (b.Raw < 0);
            ulong n = a.Raw < 0 ? (ulong)(-a.Raw) : (ulong)a.Raw;
            ulong d = b.Raw < 0 ? (ulong)(-b.Raw) : (ulong)b.Raw;

            ulong q = n / d, rem = n % d;
            if (q >= (1UL << 31)) return neg ? MinValue : MaxValue;
            for (int i = 0; i < FracBits; i++)
            {
                // Shift remainder left by one bit; track overflow out of 64 bits.
                bool carry = (rem >> 63) != 0;
                rem <<= 1;
                q <<= 1;
                if (carry || rem >= d) { rem -= d; q |= 1; }
            }
            return new Fix64(neg ? -(long)q : (long)q);
        }

        public static bool operator <(Fix64 a, Fix64 b) => a.Raw < b.Raw;
        public static bool operator >(Fix64 a, Fix64 b) => a.Raw > b.Raw;
        public static bool operator <=(Fix64 a, Fix64 b) => a.Raw <= b.Raw;
        public static bool operator >=(Fix64 a, Fix64 b) => a.Raw >= b.Raw;
        public static bool operator ==(Fix64 a, Fix64 b) => a.Raw == b.Raw;
        public static bool operator !=(Fix64 a, Fix64 b) => a.Raw != b.Raw;

        public static Fix64 Min(Fix64 a, Fix64 b) => a.Raw < b.Raw ? a : b;
        public static Fix64 Max(Fix64 a, Fix64 b) => a.Raw > b.Raw ? a : b;
        public static Fix64 Clamp(Fix64 v, Fix64 lo, Fix64 hi) => Min(Max(v, lo), hi);
        public static Fix64 Clamp01(Fix64 v) => Clamp(v, Zero, One);

        public bool Equals(Fix64 o) => Raw == o.Raw;
        public override bool Equals(object obj) => obj is Fix64 o && o.Raw == Raw;
        public override int GetHashCode() => Raw.GetHashCode();
        public int CompareTo(Fix64 o) => Raw.CompareTo(o.Raw);

        /// Debug display only. Never used by sim logic.
        public override string ToString() => ((decimal)Raw / 4294967296m).ToString("0.######", System.Globalization.CultureInfo.InvariantCulture);
    }

    public readonly struct Vec3F
    {
        public readonly Fix64 X, Y, Z;
        public Vec3F(Fix64 x, Fix64 y, Fix64 z) { X = x; Y = y; Z = z; }
        public static Vec3F operator +(Vec3F a, Vec3F b) => new Vec3F(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
        public static Vec3F operator -(Vec3F a, Vec3F b) => new Vec3F(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
        public static Vec3F operator *(Vec3F a, Fix64 s) => new Vec3F(a.X * s, a.Y * s, a.Z * s);
        public Fix64 LengthSq() => X * X + Y * Y + Z * Z;
    }
}
