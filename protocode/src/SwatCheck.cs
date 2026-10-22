// --- file: SwatCheck.cs
namespace Sting.Core
{
    /// Position and orientation of a human's body frame at a tick (from schedule + deviations).
    public struct BodyFrame
    {
        public Vec3F Origin;
        public Vec3F Right, Up, Forward;   // orthonormal basis in fixed point

        public Vec3F ToWorld(Vec3F p) => Origin + Right * p.X + Up * p.Y + Forward * p.Z;
    }

    public static class SwatCheck
    {
        public static bool IsActive(in SwatAttempt s, long tick) =>
            tick >= s.StartTick && tick < s.StartTick + s.WindowTicks;

        /// Sphere vs sphere at one tick. Production code sweeps the wasp over the tick.
        public static bool Hits(in SwatAttempt s, in BodyFrame frame, Vec3F waspPos, Fix64 waspRadius)
        {
            Vec3F center = frame.ToWorld(s.CenterBody);
            Fix64 r = s.Radius + waspRadius;
            return (waspPos - center).LengthSq() <= r * r;
        }
    }
}
