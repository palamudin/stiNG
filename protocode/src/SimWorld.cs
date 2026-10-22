// --- file: SimWorld.cs
namespace Sting.Core
{
    public sealed class SimWorld
    {
        public const int TickRate = 60;
        public long Tick { get; private set; }

        // Subsystems, in fixed order. Order is part of the determinism contract.
        public void Step()
        {
            Tick++;
            // 1. Apply player commands for owned entities (input buffer keyed by tick).
            // 2. Apply received events with Tick <= current tick, in total order (3.7).
            // 3. Flight and swept collision            (every tick)
            // 4. Reaction plans: activate swat windows, run swat checks (every tick)
            if (Tick % 3 == 0)
            {
                // 5. Human movement from schedules + deviations, panic, contagion (20 Hz)
                // 6. Bees, predators                                              (20 Hz)
            }
            if (Tick % TickRate == 0)
            {
                // 7. Colony economy (1 Hz)
            }
            if (Tick % (TickRate * 5) == 0)
            {
                // 8. Ecology: regrowth, prey spawning (0.2 Hz)
            }
            // 9. Emit outgoing events and owned-entity state for networking.
        }
    }
}
