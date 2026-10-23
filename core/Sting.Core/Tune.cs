// Tuning as data (GDD 13, T1-22): the reader of tuning/sting.tune, a port of poc/sim/tunefile.js. Own code only.
// The file sets the static fields of T by path (wasp.radius -> T.wasp.radius, alloc.0.name -> T.alloc[0].name),
// so the rest of the core keeps reading T as before. Every key must land on a field of the same kind.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text;

namespace Sting.Core
{
    public static class Tune
    {
        /// The hash of the tuning the sim runs with ("built-in" until a file is applied); worlds and peers carry it
        public static string Hash = "built-in";

        // ------------------------------------------------------------ reading

        static object ParseValue(string s, string at)
        {
            int i = 0;
            void Ws() { while (i < s.Length && (s[i] == ' ' || s[i] == '\t')) i++; }
            Exception Fail(string why) => new FormatException($"tuning {at}: {why}");
            object Value()
            {
                Ws();
                if (i < s.Length && s[i] == '[')
                {
                    i++; var list = new List<object>(); Ws();
                    if (i < s.Length && s[i] == ']') { i++; return list; }
                    for (;;)
                    {
                        list.Add(Value()); Ws();
                        if (i < s.Length && s[i] == ',') { i++; continue; }
                        if (i < s.Length && s[i] == ']') { i++; return list; }
                        throw Fail("expected , or ]");
                    }
                }
                if (i < s.Length && s[i] == '"')
                {
                    int j = s.IndexOf('"', i + 1);
                    if (j < 0) throw Fail("unterminated string");
                    string str = s.Substring(i + 1, j - i - 1); i = j + 1; return str;
                }
                int k = i;
                while (k < s.Length && (char.IsLetterOrDigit(s[k]) || s[k] == '+' || s[k] == '-' || s[k] == '.')) k++;
                string tok = s.Substring(i, k - i); i = k;
                if (tok == "true") return true;
                if (tok == "false") return false;
                if (!IsNumber(tok)) throw Fail($"not a value: \"{tok}\"");
                return double.Parse(tok, NumberStyles.Float, CultureInfo.InvariantCulture);
            }
            var v = Value(); Ws();
            if (i != s.Length) throw Fail("trailing text");
            return v;
        }

        // ^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$ without a regex engine
        static bool IsNumber(string t)
        {
            int i = 0, n = t.Length;
            if (i < n && (t[i] == '+' || t[i] == '-')) i++;
            int d0 = i; while (i < n && char.IsDigit(t[i])) i++;
            bool intPart = i > d0;
            if (i < n && t[i] == '.') { i++; int f0 = i; while (i < n && char.IsDigit(t[i])) i++; if (!intPart && i == f0) return false; }
            else if (!intPart) return false;
            if (i < n && (t[i] == 'e' || t[i] == 'E'))
            {
                i++; if (i < n && (t[i] == '+' || t[i] == '-')) i++;
                int e0 = i; while (i < n && char.IsDigit(t[i])) i++;
                if (i == e0) return false;
            }
            return i == n;
        }

        /// text -> (path, value) in file order; values are double, bool, string or List&lt;object&gt;
        public static List<(string path, object value)> Parse(string text)
        {
            var o = new List<(string, object)>();
            string section = "";
            var lines = text.Replace("\r", "").Split('\n');
            for (int n = 0; n < lines.Length; n++)
            {
                string at = $"line {n + 1}";
                var sb = new StringBuilder(); bool inStr = false;
                foreach (char ch in lines[n]) { if (ch == '"') inStr = !inStr; if (ch == '#' && !inStr) break; sb.Append(ch); }
                string line = sb.ToString().Trim();
                if (line.Length == 0) continue;
                if (line[0] == '[' && line[line.Length - 1] == ']' && line.IndexOf('=') < 0) { section = line.Substring(1, line.Length - 2).Trim(); continue; }
                int eq = line.IndexOf('=');
                if (eq < 0) throw new FormatException($"tuning {at}: expected key = value");
                string key = line.Substring(0, eq).Trim();
                foreach (char ch in key) if (!(char.IsLetterOrDigit(ch) || ch == '_')) throw new FormatException($"tuning {at}: bad key \"{key}\"");
                o.Add((section.Length > 0 ? section + "." + key : key, ParseValue(line.Substring(eq + 1).Trim(), at)));
            }
            return o;
        }

        // ------------------------------------------------------------ the leaves of T

        static bool Tunable(FieldInfo f) => f.IsPublic && !f.IsLiteral && !f.IsInitOnly;
        static bool LeafType(Type t) => t == typeof(Num) || t == typeof(int) || t == typeof(long) || t == typeof(bool) || t == typeof(string)
            || (t.IsArray && LeafType(t.GetElementType()));

        /// every tunable value of T as a path, in declaration order
        public static List<string> Keys()
        {
            var o = new List<string>();
            void Obj(object x, Type t, string p)
            {
                foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance)) Val(f.GetValue(x), f.FieldType, p + "." + f.Name);
            }
            void Val(object v, Type t, string p)
            {
                if (LeafType(t)) { o.Add(p); return; }
                if (t.IsArray) { var a = (Array)v; for (int i = 0; i < a.Length; i++) Val(a.GetValue(i), t.GetElementType(), p + "." + i); return; }
                Obj(v, t, p);
            }
            void Cls(Type t, string p)
            {
                foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Static)) if (Tunable(f)) Val(f.GetValue(null), f.FieldType, p.Length > 0 ? p + "." + f.Name : f.Name);
                foreach (var n in t.GetNestedTypes(BindingFlags.Public)) if (n.IsAbstract && n.IsSealed) Cls(n, p.Length > 0 ? p + "." + n.Name : n.Name);
            }
            Cls(typeof(T), "");
            return o;
        }

        // ------------------------------------------------------------ applying

        static object Convert(object v, Type t, string path)
        {
            Exception Bad() => new FormatException($"tuning {path}: a {t.Name} cannot be {v}");
            if (t == typeof(Num)) return v is double d ? (Num)d : throw Bad();
            if (t == typeof(int)) return v is double di && di == Math.Floor(di) ? (int)di : throw Bad();
            if (t == typeof(long)) return v is double dl && dl == Math.Floor(dl) ? (long)dl : throw Bad();
            if (t == typeof(bool)) return v is bool b ? b : throw Bad();
            if (t == typeof(string)) return v is string s ? s : throw Bad();
            if (t.IsArray && v is List<object> list)
            {
                var et = t.GetElementType(); var a = Array.CreateInstance(et, list.Count);
                for (int i = 0; i < list.Count; i++) a.SetValue(Convert(list[i], et, path), i);
                return a;
            }
            throw Bad();
        }

        /// Apply a tuning file to T. Returns the keys of the file T has no place for and the keys of T the file does
        /// not set, so callers can insist on an exact match.
        public static (List<string> unknown, List<string> missing) Apply(string text)
        {
            var unknown = new List<string>(); var set = new HashSet<string>();
            foreach (var (path, value) in Parse(text))
            {
                if (path == "version") continue;
                if (Set(path, value)) set.Add(path); else unknown.Add(path);
            }
            var missing = new List<string>();
            foreach (var k in Keys()) if (!set.Contains(k)) missing.Add(k);
            Hash = HashOf(text);
            return (unknown, missing);
        }

        /// keys the world format fixes: the chunk grid is baked into every world
        static readonly HashSet<string> Fixed = new HashSet<string> { "chunk.size" };

        static bool Set(string path, object value)
        {
            if (Fixed.Contains(path) && !(value is double fd && (Num)fd == T.chunk.size)) throw new FormatException($"tuning {path}: fixed by the world format");
            var segs = path.Split('.');
            Type cls = typeof(T); object inst = null; Type instType = null;
            for (int i = 0; i < segs.Length; i++)
            {
                string s = segs[i]; bool last = i == segs.Length - 1;
                if (inst == null)
                {
                    // inside a static class: a nested class or a static field
                    var nested = cls.GetNestedType(s, BindingFlags.Public);
                    if (!last && nested != null && nested.IsAbstract && nested.IsSealed) { cls = nested; continue; }
                    var f = cls.GetField(s, BindingFlags.Public | BindingFlags.Static);
                    if (f == null || !Tunable(f)) return false;
                    if (last) { if (!LeafType(f.FieldType)) return false; f.SetValue(null, Convert(value, f.FieldType, path)); return true; }
                    inst = f.GetValue(null); instType = f.FieldType;
                    continue;
                }
                if (instType.IsArray)
                {
                    if (!int.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out int idx)) return false;
                    var a = (Array)inst; if (idx >= a.Length) return false;
                    var et = instType.GetElementType();
                    if (last) { if (!LeafType(et)) return false; a.SetValue(Convert(value, et, path), idx); return true; }
                    inst = a.GetValue(idx); instType = et;
                    continue;
                }
                var fi = instType.GetField(s, BindingFlags.Public | BindingFlags.Instance);
                if (fi == null) return false;
                if (last) { if (!LeafType(fi.FieldType)) return false; fi.SetValue(inst, Convert(value, fi.FieldType, path)); return true; }
                inst = fi.GetValue(inst); instType = fi.FieldType;
            }
            return false;
        }

        /// FNV-1a over the UTF-8 bytes of the file with carriage returns dropped: the same number in JS and C#
        public static string HashOf(string text)
        {
            uint h = 0x811c9dc5;
            foreach (byte b in Encoding.UTF8.GetBytes(text.Replace("\r", ""))) { h ^= b; h = unchecked(h * 0x01000193); }
            return h.ToString("x8");
        }
    }
}
