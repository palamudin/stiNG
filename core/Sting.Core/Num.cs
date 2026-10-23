// The sim's number type (GDD 3.5, R-04). Every quantity in Sting.Core is a Num.
//
// Two builds of the same sources:
//   default        Num wraps an IEEE double. Bit-identical to the JS PoC, which the parity harness proves.
//   STING_FIXED    Num is Q32.32 fixed point on a long. Integer arithmetic only, so a peer on any CPU, compiler
//                  or backend (IL2CPP on ARM64 may fuse a*b+c into one rounding; integers cannot drift) gets
//                  the same bits. Build with: dotnet build -p:StingFixed=true
//
// Both builds evaluate the same expression trees in the same order. Literals in sim code are double constants,
// converted to Num where they meet a Num: exactly in the double build, by correct rounding in the fixed build.
// Sim code never does arithmetic on runtime doubles.
using System;
#pragma warning disable IDE1006
namespace Sting.Core
{
#if STING_FIXED
    public readonly struct Num : IEquatable<Num>, IComparable<Num>
    {
        public const int FracBits = 32;
        const double ONE = 4294967296.0;
        public readonly long raw;
        Num(long raw) { this.raw = raw; }
        public static Num FromRaw(long raw) => new Num(raw);

        public static readonly Num Zero = new Num(0), One = new Num(1L << FracBits), Half = new Num(1L << (FracBits - 1));
        public static readonly Num MaxValue = new Num(long.MaxValue), MinValue = new Num(long.MinValue);
        /// No NaN in fixed point; the one place the JS reads past an array (a quirk kept for parity) gets zero here
        public static readonly Num NaN = Zero;
        public bool IsNaN => false;
        public const bool Fixed = true;

        public static implicit operator Num(double d)
        {
            if (double.IsNaN(d)) return Zero;
            double s = d * ONE;
            if (s >= 9.2233720368547758e18) return MaxValue;
            if (s <= -9.2233720368547758e18) return MinValue;
            return new Num((long)Math.Round(s, MidpointRounding.ToEven));
        }
        public static implicit operator Num(int i) => new Num((long)i << FracBits);
        public static implicit operator Num(long l) => l >= (1L << 31) ? MaxValue : l < -(1L << 31) ? MinValue : new Num(l << FracBits);
        public static explicit operator double(Num n) => n.raw / ONE;
        /// Truncates toward zero, like a double cast
        public static explicit operator long(Num n) => n.raw >= 0 ? n.raw >> FracBits : -((-n.raw) >> FracBits);
        public static explicit operator int(Num n) => (int)(long)n;

        /// Saturating: a sum past the range sticks at the end of it instead of wrapping to the other sign
        public static Num operator +(Num a, Num b) { long r = unchecked(a.raw + b.raw); return ((a.raw ^ r) & (b.raw ^ r)) < 0 ? (a.raw < 0 ? MinValue : MaxValue) : new Num(r); }
        public static Num operator -(Num a, Num b) { long r = unchecked(a.raw - b.raw); return ((a.raw ^ b.raw) & (a.raw ^ r)) < 0 ? (a.raw < 0 ? MinValue : MaxValue) : new Num(r); }
        public static Num operator -(Num a) => a.raw == long.MinValue ? MaxValue : new Num(-a.raw);
        public static Num operator *(Num a, int k) => new Num(a.raw * k);
        public static Num operator *(int k, Num a) => new Num(a.raw * k);
        public static Num operator /(Num a, int k) => k == 0 ? DivZero(a) : new Num(a.raw / k);
        public static Num operator ++(Num a) => new Num(a.raw + (1L << FracBits));
        public static Num operator --(Num a) => new Num(a.raw - (1L << FracBits));
        /// Remainder with the sign of the dividend, like fmod (exact in both builds)
        public static Num operator %(Num a, Num b) => b.raw == 0 ? Zero : new Num(a.raw % b.raw);

        /// 64x64 -> 128 product by 32-bit halves, keeping the middle 64 bits; saturates
        public static Num operator *(Num a, Num b)
        {
            long x = a.raw, y = b.raw;
            bool neg = (x < 0) ^ (y < 0);
            ulong ux = x < 0 ? (ulong)(-x) : (ulong)x, uy = y < 0 ? (ulong)(-y) : (ulong)y;
            ulong xl = ux & 0xFFFFFFFFUL, xh = ux >> 32, yl = uy & 0xFFFFFFFFUL, yh = uy >> 32;
            ulong ll = xl * yl, lh = xl * yh, hl = xh * yl, hh = xh * yh;
            ulong mid = (ll >> 32) + (lh & 0xFFFFFFFFUL) + (hl & 0xFFFFFFFFUL);
            ulong hi = hh + (lh >> 32) + (hl >> 32) + (mid >> 32);
            ulong lo = mid & 0xFFFFFFFFUL;
            if ((hi >> 31) != 0) return neg ? MinValue : MaxValue;
            ulong r = (hi << 32) | lo;
            return new Num(neg ? -(long)r : (long)r);
        }

        /// (|a| << 32) / |b| by long division on magnitudes; saturates; x/0 saturates to the sign of x
        public static Num operator /(Num a, Num b)
        {
            if (b.raw == 0) return DivZero(a);
            bool neg = (a.raw < 0) ^ (b.raw < 0);
            ulong n = a.raw < 0 ? (ulong)(-a.raw) : (ulong)a.raw, d = b.raw < 0 ? (ulong)(-b.raw) : (ulong)b.raw;
            ulong q = n / d, rem = n % d;
            if (q >= (1UL << 31)) return neg ? MinValue : MaxValue;
            for (int i = 0; i < FracBits; i++)
            {
                bool carry = (rem >> 63) != 0;
                rem <<= 1; q <<= 1;
                if (carry || rem >= d) { rem -= d; q |= 1; }
            }
            return new Num(neg ? -(long)q : (long)q);
        }
        static Num DivZero(Num a) => a.raw > 0 ? MaxValue : a.raw < 0 ? MinValue : Zero;

        public static bool operator <(Num a, Num b) => a.raw < b.raw;
        public static bool operator >(Num a, Num b) => a.raw > b.raw;
        public static bool operator <=(Num a, Num b) => a.raw <= b.raw;
        public static bool operator >=(Num a, Num b) => a.raw >= b.raw;
        public static bool operator ==(Num a, Num b) => a.raw == b.raw;
        public static bool operator !=(Num a, Num b) => a.raw != b.raw;

        public static Num Floor(Num a) => new Num(a.raw & ~((1L << FracBits) - 1));
        public static Num Ceil(Num a) { var f = Floor(a); return f.raw == a.raw ? f : new Num(f.raw + (1L << FracBits)); }
        public static Num Abs(Num a) => a.raw < 0 ? new Num(-a.raw) : a;
        public static Num Min(Num a, Num b) => a.raw < b.raw ? a : b;
        public static Num Max(Num a, Num b) => a.raw > b.raw ? a : b;

        /// Square root: isqrt of the 96-bit value raw << 32, two bits per step
        public static Num Sqrt(Num a)
        {
            if (a.raw <= 0) return Zero;
            ulong nHi = (ulong)a.raw >> 32, nLo = (ulong)a.raw << 32; // the 128-bit radicand, high and low words
            ulong rem = 0, root = 0;
            for (int i = 0; i < 64; i++)
            {
                // bring down the next two bits of the radicand
                ulong top = nHi >> 62;
                nHi = (nHi << 2) | (nLo >> 62); nLo <<= 2;
                rem = (rem << 2) | top;
                root <<= 1;
                ulong trial = (root << 1) | 1;
                if (rem >= trial) { rem -= trial; root |= 1; }
            }
            return new Num((long)root);
        }

        public long Bits => raw;
        public static Num FromBits(long b) => new Num(b);
        public bool Equals(Num o) => raw == o.raw;
        public override bool Equals(object obj) => obj is Num o && o.raw == raw;
        public override int GetHashCode() => raw.GetHashCode();
        public int CompareTo(Num o) => raw.CompareTo(o.raw);
        public override string ToString() => ((decimal)raw / 4294967296m).ToString("0.#########", System.Globalization.CultureInfo.InvariantCulture);
    }
#else
    public readonly struct Num : IEquatable<Num>, IComparable<Num>
    {
        public readonly double v;
        Num(double v) { this.v = v; }

        public static readonly Num Zero = new Num(0), One = new Num(1), Half = new Num(0.5);
        public static readonly Num MaxValue = new Num(double.PositiveInfinity), MinValue = new Num(double.NegativeInfinity);
        public static readonly Num NaN = new Num(double.NaN);
        public bool IsNaN => double.IsNaN(v);
        public const bool Fixed = false;

        public static implicit operator Num(double d) => new Num(d);
        public static implicit operator Num(int i) => new Num(i);
        public static implicit operator Num(long l) => new Num(l);
        public static explicit operator double(Num n) => n.v;
        public static explicit operator long(Num n) => (long)n.v;
        public static explicit operator int(Num n) => (int)n.v;

        public static Num operator +(Num a, Num b) => new Num(a.v + b.v);
        public static Num operator -(Num a, Num b) => new Num(a.v - b.v);
        public static Num operator -(Num a) => new Num(-a.v);
        public static Num operator *(Num a, Num b) => new Num(a.v * b.v);
        public static Num operator *(Num a, int k) => new Num(a.v * k);
        public static Num operator *(int k, Num a) => new Num(k * a.v);
        public static Num operator /(Num a, Num b) => new Num(a.v / b.v);
        public static Num operator /(Num a, int k) => new Num(a.v / k);
        public static Num operator ++(Num a) => new Num(a.v + 1);
        public static Num operator --(Num a) => new Num(a.v - 1);
        public static Num operator %(Num a, Num b) => new Num(a.v % b.v);

        public static bool operator <(Num a, Num b) => a.v < b.v;
        public static bool operator >(Num a, Num b) => a.v > b.v;
        public static bool operator <=(Num a, Num b) => a.v <= b.v;
        public static bool operator >=(Num a, Num b) => a.v >= b.v;
        public static bool operator ==(Num a, Num b) => a.v == b.v;
        public static bool operator !=(Num a, Num b) => a.v != b.v;

        public static Num Floor(Num a) => new Num(Math.Floor(a.v));
        public static Num Ceil(Num a) => new Num(Math.Ceiling(a.v));
        public static Num Abs(Num a) => new Num(Math.Abs(a.v));
        /// JS Math.min/max semantics: NaN wins, -0 < +0
        public static Num Min(Num a, Num b) => new Num(Math.Min(a.v, b.v));
        public static Num Max(Num a, Num b) => new Num(Math.Max(a.v, b.v));
        public static Num Sqrt(Num a) => new Num(Math.Sqrt(a.v));

        public long Bits => BitConverter.DoubleToInt64Bits(v);
        public static Num FromBits(long b) => new Num(BitConverter.Int64BitsToDouble(b));
        public bool Equals(Num o) => v.Equals(o.v);
        public override bool Equals(object obj) => obj is Num o && o.v.Equals(v);
        public override int GetHashCode() => v.GetHashCode();
        public int CompareTo(Num o) => v.CompareTo(o.v);
        public override string ToString() => v.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
    }
#endif
}
