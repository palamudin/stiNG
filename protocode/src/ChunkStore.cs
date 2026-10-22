// --- file: ChunkStore.cs
namespace Sting.Core
{
    public struct ChunkRecord
    {
        public int Cx, Cz;
        public int GenVersion;
        public ulong ContentHash;
        public long DiscoveredTick;
        public byte[] BaseSnapshot;      // serialized ChunkBase, compressed
    }

    public interface IChunkGenerator
    {
        int Version { get; }
        byte[] GenerateSnapshot(ulong worldSeed, int cx, int cz);   // pure function
    }

    public interface IWorldStore
    {
        bool TryGet(int cx, int cz, out ChunkRecord record);
        /// Idempotent: storing an identical record twice is a no-op; a different one is rejected.
        bool Put(in ChunkRecord record);
    }

    public static class Discovery
    {
        public static ChunkRecord GetOrDiscover(IWorldStore store, IChunkGenerator gen,
                                                ulong worldSeed, int cx, int cz, long tick)
        {
            if (store.TryGet(cx, cz, out var existing)) return existing;   // frozen forever
            byte[] snap = gen.GenerateSnapshot(worldSeed, cx, cz);
            var rec = new ChunkRecord
            {
                Cx = cx, Cz = cz, GenVersion = gen.Version, DiscoveredTick = tick,
                BaseSnapshot = snap, ContentHash = HashBytes(snap),
            };
            store.Put(rec);
            return rec;
        }

        static ulong HashBytes(byte[] data)
        {
            ulong h = 0xCBF29CE484222325UL;                 // FNV-1a 64
            for (int i = 0; i < data.Length; i++) { h ^= data[i]; h *= 0x100000001B3UL; }
            return h;
        }
    }
}
