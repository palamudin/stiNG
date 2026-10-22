// --- file: RemoteSmoothing.cs (lives in the Unity assembly; shown here for completeness)
namespace Sting.Presentation
{
    public struct RemoteTrack
    {
        public float PX, PY, PZ;     // last received position
        public float VX, VY, VZ;     // last received velocity
        public float StampSec;       // when it was valid
        public float DX, DY, DZ;     // displayed position

        public void Receive(float px, float py, float pz, float vx, float vy, float vz, float stamp)
        { PX = px; PY = py; PZ = pz; VX = vx; VY = vy; VZ = vz; StampSec = stamp; }

        /// Extrapolate from the last state and ease toward it; snap if far off.
        public void Update(float nowSec, float blendPerSec, float dt, float snapDist)
        {
            float age = nowSec - StampSec;
            float tx = PX + VX * age, ty = PY + VY * age, tz = PZ + VZ * age;
            float ex = tx - DX, ey = ty - DY, ez = tz - DZ;
            if (ex * ex + ey * ey + ez * ez > snapDist * snapDist) { DX = tx; DY = ty; DZ = tz; return; }
            float k = blendPerSec * dt; if (k > 1f) k = 1f;
            DX += ex * k; DY += ey * k; DZ += ez * k;
        }
    }
}
