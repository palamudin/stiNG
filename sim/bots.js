// Scripted pilots. They produce input commands exactly like a player would, so runs stay replayable.
// Used by tests and by the network lab's second player.
import { toWorld } from './body.js';
import { T } from './tuning.js';

export const idleCmd = (o = {}) => ({ mx: 0, my: 0, mz: 0, burst: 0, sting: 0, yawQ: 9800, pitchQ: 0, act: 0, alloc: 0, ...o });

// Flies to a seated human's forearm, stings, gets out. plan: 'jab' (release fast) or 'full' (hold and linger).
// pick(sim) filters candidate humans; default: seated in the origin chunk.
export function stingBot({ plan = 'jab', pick = (h) => h.chunk === '0,0', rest = 120 } = {}) {
  let phase = 'approach', target = null, k = 0, idx = 0;
  return (sim) => {
    const w = sim.wasp;
    const cmd = idleCmd({ yawQ: Math.round((w && w.yaw || 0) * 1e4) });
    if (!w || w.state === 'dead' || !sim._driven()) { phase = 'approach'; target = null; return cmd; }
    if (!target || target.hm.state !== 'idle' || target.hm.posture !== 'sit') {
      const seated = sim.active.filter((h) => h.posture === 'sit' && h.state === 'idle' && !h.special && pick(h));
      if (!seated.length) return cmd;
      const hm = seated[idx++ % seated.length];
      const part = hm.parts.sit.find((p) => p.name === 'ForearmR');
      target = { hm, mid: { x: (part.a.x + part.b.x) / 2, y: (part.a.y + part.b.y) / 2 + part.r + 0.012, z: (part.a.z + part.b.z) / 2 } };
      phase = 'approach';
    }
    const tp = toWorld(target.hm, target.mid);
    const dx = tp.x - w.x, dy = tp.y - w.y, dz = tp.z - w.z, d = Math.hypot(dx, dy, dz);
    const yaw = Math.atan2(dx, dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    if (phase === 'approach') {
      cmd.yawQ = Math.round(yaw * 1e4); cmd.pitchQ = Math.round(pitch * 1e4);
      cmd.mz = Math.max(6, Math.min(100, Math.round(Math.sqrt(2 * T.wasp.accel * d) * 0.7 / T.wasp.cruise * 100)));
      if (d < 0.1) cmd.sting = 1;
      if (w.state === 'attached') { phase = 'sting'; k = 0; }
    }
    if (phase === 'sting') {
      cmd.sting = 1; k++;
      if (plan === 'jab' && k >= T.sting.jabTicks + 1) cmd.sting = 0;
      if (w.state === 'fly' && k > 2) { phase = plan === 'full' ? 'linger' : 'escape'; k = 0; }
    }
    if (phase === 'linger') { if (++k > 25) { phase = 'escape'; k = 0; } }
    if (phase === 'escape') {
      cmd.yawQ = Math.round((yaw + Math.PI) * 1e4); cmd.pitchQ = 3000; cmd.mz = 100; cmd.burst = 1;
      if (++k > rest) { phase = 'approach'; target = null; }
    }
    return cmd;
  };
}
