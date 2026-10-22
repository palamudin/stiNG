// --- file: ChunkAuthority.cs
namespace Sting.Core
{
    public static class ChunkAuthority
    {
        public static ulong ChunkKey(int cx, int cz) => ((ulong)(uint)cx << 32) | (uint)cz;

        /// Highest-random-weight pick: the peer with the smallest hash owns the chunk.
        /// Peers added or removed only move the chunks they win or lose.
        public static ulong Elect(ulong worldSeed, int cx, int cz, ulong[] interestedPeerIds)
        {
            ulong key = ChunkKey(cx, cz);
            ulong best = 0, bestScore = ulong.MaxValue;
            for (int i = 0; i < interestedPeerIds.Length; i++)
            {
                ulong score = Rng.Hash(worldSeed, RngDomain.WorldGen, key, interestedPeerIds[i], 0xA11CE);
                if (score < bestScore || (score == bestScore && interestedPeerIds[i] < best))
                { bestScore = score; best = interestedPeerIds[i]; }
            }
            return best;
        }
    }
}
