// Insertion-ordered map with JavaScript Map semantics (iteration in insertion order; delete then set appends).
// The sim iterates maps in places where order changes results, so a plain Dictionary would not be deterministic.
using System.Collections;
using System.Collections.Generic;

namespace Sting.Core
{
    public sealed class OrderedMap<K, V> : IEnumerable<KeyValuePair<K, V>>
    {
        readonly Dictionary<K, LinkedListNode<KeyValuePair<K, V>>> index = new Dictionary<K, LinkedListNode<KeyValuePair<K, V>>>();
        readonly LinkedList<KeyValuePair<K, V>> order = new LinkedList<KeyValuePair<K, V>>();

        public int Count => index.Count;
        public bool Has(K k) => index.ContainsKey(k);
        public V Get(K k) => index.TryGetValue(k, out var n) ? n.Value.Value : default;
        public bool TryGet(K k, out V v) { if (index.TryGetValue(k, out var n)) { v = n.Value.Value; return true; } v = default; return false; }
        public void Set(K k, V v)
        {
            if (index.TryGetValue(k, out var n)) { n.Value = new KeyValuePair<K, V>(k, v); return; }
            index[k] = order.AddLast(new KeyValuePair<K, V>(k, v));
        }
        public bool Delete(K k)
        {
            if (!index.TryGetValue(k, out var n)) return false;
            order.Remove(n); index.Remove(k); return true;
        }
        public void Clear() { index.Clear(); order.Clear(); }
        public IEnumerable<K> Keys { get { foreach (var kv in Snapshot()) yield return kv.Key; } }
        public IEnumerable<V> Values { get { foreach (var kv in Snapshot()) yield return kv.Value; } }
        /// A copy, so callers may delete while iterating (as JS allows for already-visited entries)
        public List<KeyValuePair<K, V>> Snapshot() => new List<KeyValuePair<K, V>>(order);
        public IEnumerator<KeyValuePair<K, V>> GetEnumerator() => Snapshot().GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public static class Stable
    {
        /// Stable sort (JS Array.prototype.sort is stable; List.Sort is not)
        public static void Sort<TItem>(List<TItem> list, System.Comparison<TItem> cmp)
        {
            var idx = new List<KeyValuePair<int, TItem>>(list.Count);
            for (int i = 0; i < list.Count; i++) idx.Add(new KeyValuePair<int, TItem>(i, list[i]));
            idx.Sort((a, b) => { int c = cmp(a.Value, b.Value); return c != 0 ? c : a.Key.CompareTo(b.Key); });
            for (int i = 0; i < list.Count; i++) list[i] = idx[i].Value;
        }
        /// JS-style comparator returning a double (a - b), mapped to an int sign
        public static int Sign(Num d) => d < 0 ? -1 : d > 0 ? 1 : 0;
    }
}
