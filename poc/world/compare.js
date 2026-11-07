// The V switch: the old water (world.html, WebGL) and the new (world-gpu.html, WebGPU) at the same place, time and
// weather, for side-by-side shots. V in either page opens the other with the view's state in the address; the camera
// arrives frozen at exactly the same pose (until a key, a drag or the wheel moves it), the water's clock and the clouds'
// clock the same (the wave field is the same deterministic spectrum on both, so the same waves stand in the same place).
// Fields: fx, fz, yaw, dist, look (the orbit), hour, day, wind, cover (-1: the day's own weather), wt (the water's
// clock), ct (the clouds' clock), pose (position x y z, quaternion x y z w, fov).
export function compareURL(page, s) {
  const r = (v, d = 3) => +(+v).toFixed(d);
  const q = new URLSearchParams();
  q.set('cmp', '1'); q.set('at', [r(s.fx, 2), r(s.fz, 2), r(s.yaw, 4)].join(','));
  for (const k of ['dist', 'look', 'hour', 'day', 'wind', 'cover', 'wt', 'ct']) if (s[k] !== undefined && s[k] !== null) q.set(k, String(r(s[k], 4)));
  if (s.pose) q.set('pose', s.pose.map((v) => r(v, 5)).join(','));
  return `${page}?${q.toString()}`;
}
// the state from the address, or null; frozen: the pose holds until the user moves
export function readCompare() {
  const q = new URLSearchParams(location.search);
  if (!q.has('cmp')) return null;
  const at = (q.get('at') || '').split(',').map(Number), num = (k) => (q.has(k) ? +q.get(k) : undefined);
  const c = { fx: at[0], fz: at[1], yaw: at[2], dist: num('dist'), look: num('look'), hour: num('hour'), day: num('day'), wind: num('wind'), cover: num('cover'), wt: num('wt'), ct: num('ct'), pose: q.has('pose') ? q.get('pose').split(',').map(Number) : null, frozen: q.has('pose'), timeSet: false };
  const thaw = () => { c.frozen = false; };
  addEventListener('keydown', (e) => { if (e.code !== 'KeyV') thaw(); }); addEventListener('pointerdown', thaw); addEventListener('wheel', thaw);
  return c;
}
// the camera's pose as the switch carries it
export function poseOf(camera) { const p = camera.position, o = camera.quaternion; return [p.x, p.y, p.z, o.x, o.y, o.z, o.w, camera.fov]; }
export function applyPose(camera, pose) { camera.position.set(pose[0], pose[1], pose[2]); camera.quaternion.set(pose[3], pose[4], pose[5], pose[6]); camera.fov = pose[7]; camera.updateProjectionMatrix(); camera.updateMatrixWorld(); }
