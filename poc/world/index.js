// World v2: the drawing of the ground, forests, grass, water and sky, as one system with one entry point, so the game
// can switch to it from its own ground (view/rings.js) without the sim knowing. Presentation only (GDD 12): reads a
// source (the sim's world or the standalone wild world), never writes to the sim.
//
//   const world = new World(renderer, scene, camera, source, { quality: 'high' });
//   world.set({ hour: 16.5, haze: 1, mist: 1, wet: 0, wind: [0.8, 0.3] })
//   each frame: world.update(dt, eye, focusDist)   eye = the camera's position; focusDist = metres to the subject
//               world.render()                     scene -> post chain -> screen
//   world.heightAt(x, z)                            the ground (CPU, the source's exact height)
//   world.liftGLSL / world.uniforms                 for lifting the game's own objects onto the ground (WORLD.md)
//
// See WORLD.md for the source contract, the quality tiers and how game.js switches over.
import * as THREE from 'three';
import { Clipmap } from './clipmap.js';
import { makeTerrain } from './terrain.js';
import { Sky } from './sky.js';
import { Clouds, CLOUDS, CLOUD_SHADOW_GLSL } from './clouds.js';
import { Post } from './post.js';
import { Forest } from './trees.js';
import { Grass } from './grass.js';
import { WaveField } from './wavegpu.js';
import { ShoreField, SHORE } from './shorefield.js';
import { Caustics } from './caustics.js';
import { WATER } from './water.js';
import { WAVES, swellState } from './waves.js';
import { weatherAt, seasonAt } from './seasons.js';
import { Rain } from './rain.js';
import { GpuTimer } from './gputimer.js';
import { hash01 } from './noise.js';

// waveN: the wave grid per cascade; caustics: [texture size, grid] for the sea's caustics, 0 for none; clouds: the
// volumetric clouds (0 off); far: the impostor forest's reach [from, to] in metres, false for none
export const QUALITY = {
  low:    { levels: 10, scale: 0.7,  shadow: 1024, grass: 0.35, trees: 0.5,  post: true,  dof: false, rays: false, msaa: 0, clouds: 0,  waveN: 64,  caustics: 0, far: false },
  medium: { levels: 11, scale: 0.85, shadow: 2048, grass: 0.6,  trees: 0.75, post: true,  dof: true,  rays: true,  msaa: 0, clouds: 56, waveN: 128, caustics: [256, 192], far: [1200, 3500] },
  high:   { levels: 12, scale: 1.0,  shadow: 2048, grass: 1.0,  trees: 1.0,  post: true,  dof: true,  rays: true,  msaa: 4, clouds: 64, waveN: 128, caustics: [512, 384], far: [1200, 6000] },
  ultra:  { levels: 13, scale: 1.0,  shadow: 4096, grass: 1.4,  trees: 1.3,  post: true,  dof: true,  rays: true,  msaa: 4, clouds: 80, waveN: 256, caustics: [1024, 640], far: [1500, 9000] },
};

// the sun's direction from the hour (6 rises, 18 sets), on a fixed track across the sky
export function sunAt(hour, out = new THREE.Vector3()) {
  const a = (hour - 6) / 12 * Math.PI, el = Math.sin(a) * 1.05, az = 2.2 + a * 0.9;
  return out.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
}
// the sun by the clock and the season (W3): the real track at latitude 50 for a declination dec (seasons.js), so the
// days are long in summer and short in winter; the game keeps the fixed track above (its day is mapped onto it)
export function sunAtSeason(hour, dec, out = new THREE.Vector3()) {
  const lat = 50 * Math.PI / 180, H = (hour - 12) / 24 * Math.PI * 2;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H), el = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
  const cosAz = (Math.sin(dec) - Math.sin(lat) * sinEl) / (Math.cos(lat) * Math.cos(el) + 1e-6);
  let az = Math.acos(THREE.MathUtils.clamp(cosAz, -1, 1)); if (H > 0) az = Math.PI * 2 - az; // from north, clockwise
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

export class World {
  constructor(renderer, scene, camera, source, opts = {}) {
    this.renderer = renderer; this.scene = scene; this.camera = camera; this.source = source;
    this.q = { ...QUALITY[opts.quality || 'high'] };
    if (opts.grass) this.q.grass = opts.grass; // the caller's grass density, over the tier's
    if (opts.dof === false) this.q.dof = false; // a game camera that has to read the scene, not a macro lens
    this.shadowMin = opts.shadowBox ?? 3; // the shadow box's least half-width (the game wants the people round the wasp)
    this.time = 0;
    // day: the day of the year (0 is the first of spring); auto: the weather and season follow the clock (seasons.js)
    this.env = { hour: 16.5, day: 100, auto: false, haze: 1, mist: 1, wet: 0, wind: [0.8, 0.3], cloud: 0.35, cloudDens: 1, rain: 0, snow: 0, flash: 0 }; // auto is the template's; the game keeps its own weather
    this.season = seasonAt(100); this.weather = null;
    this.clip = new Clipmap(renderer, source, { levels: this.q.levels, ...(opts.clip || {}) });
    const wet = source.sea > -1e5; // a source without water: no beaches, no mud, no snow line; heights count from 0
    // the shore table (shorefield.js): baked from the clipmap when its levels move; the water and the beach read it
    const floatRT = renderer.capabilities.isWebGL2 && !!renderer.extensions.get('EXT_color_buffer_float');
    this.shore = wet && floatRT ? new ShoreField(renderer, this.clip, { levels: SHORE.levels.filter((l) => l < this.q.levels) }) : null;
    this.uShoreWave = { value: new THREE.Vector4(0, 8, 0, 8) }; // the swell's and the wind sea's (Hs, Tp): set from the wave field each frame
    this.uShoreSea = { value: source.sea };
    this.terrain = makeTerrain(this.clip, { sea: wet ? source.sea : 0, paving: source.kind === 'sting', shore: wet ? 1 : 0, snowLine: wet ? 215 : 1e9, shoreField: this.shore, uShoreWave: this.uShoreWave, uShoreSea: this.uShoreSea });
    this.group = new THREE.Group(); this.group.name = 'world2';
    this.group.add(this.terrain.mesh);
    this.uniforms = this.terrain.uniforms;
    this.liftGLSL = this.clip.glsl();
    // light: the sun and the sky, owned here unless the caller hands its own
    this.sun = opts.sun || new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    this.sun.shadow.bias = -0.00015; this.sun.shadow.normalBias = 0.02;
    this.hemi = opts.hemi || new THREE.HemisphereLight(0xffffff, 0x404030, 1);
    if (!opts.sun) this.group.add(this.sun, this.sun.target);
    if (!opts.hemi) this.group.add(this.hemi);
    this.sky = new Sky(renderer);
    this.clouds = new Clouds(renderer, this.sky);
    this.uniforms.tCloudShadow.value = this.clouds.rtShadow.texture; this.uniforms.uCloudRect = this.clouds.U.uShadowRect;
    this.forest = new Forest(this, { range: this.q.trees, far: this.q.far });
    this.group.add(this.forest.group);
    this.uniforms.uTreeFar.value = this.forest.farOn ? this.forest.cfg.far[1] : this.forest.bands[3];
    // decorative flowers only in the wild world: in the game's world flowers are nectar, and the sim places them
    this.grass = new Grass(this, { density: this.q.grass, flowers: source.kind !== 'sting' });
    this.group.add(this.grass.group);
    this.rain = new Rain(this); this.group.add(this.rain.mesh);
    this.post = new Post(renderer, this.sky, { msaa: this.q.msaa, scale: this.q.scale });
    this.post.U.uSea.value = source.sea; this.post.U.uShoreWave = this.uShoreWave; this.post.U.uShoreSea = this.uShoreSea;
    if (opts.lens) { const L = opts.lens, U = this.post.U; if (L.fstop) U.uFstop.value = L.fstop; if (L.maxCoc) U.uMaxCoc.value = L.maxCoc; if (L.focal) U.uFocal.value = L.focal; if (L.sensor) U.uSensor.value = L.sensor; }
    if (source.sea < -1e5) this.post.U.uWaterOn.value = 0;
    this._water();
    scene.add(this.group);
    this._mark();
    this.timer = new GpuTimer(renderer); // per-pass GPU milliseconds, where the browser gives timer queries
    this.sunDir = sunAt(this.env.hour);
    this.eye = new THREE.Vector3();
    this.focusDist = 10;
  }
  heightAt(x, z) { return this.source.height(x, z); }
  waterAt(x, z) { return this.source.waterAt ? this.source.waterAt(x, z) : this.source.sea; } // the water level there (W3)
  surfaceAt(x, z) { return Math.max(this.heightAt(x, z), this.waterAt(x, z)); }
  // the wave field and the sea's caustics for this source (source.water: fetch and cascades), or none
  _water() {
    const W = this.source.water, gl = this.renderer;
    if (this.waves) { this.waves.dispose(); this.waves = null; }
    if (this.caustics) { this.caustics.dispose(); this.caustics = null; }
    if (W) {
      const float = gl.extensions.has('EXT_color_buffer_float');
      this.waves = new WaveField(gl, { cascades: W.cascades, fetch: W.fetch, N: this.q.waveN, salt: this.source.cosmetic | 0, float });
      if (this.source.sea > -1e5 && this.q.caustics) this.caustics = new Caustics(gl, this.waves, this.clip.glsl(), this.clip.uniforms, { res: this.q.caustics[0], grid: this.q.caustics[1], msaa: this.q.msaa ? 4 : 0 });
    }
    this.post.setWater(this.waves, this.caustics, this.source.sea > -1e5 ? this.clip : null, this.shore);
    // the shore reads the first two cascades for its swash (terrain.js)
    const TU = this.terrain.uniforms;
    if (this.waves && this.source.sea > -1e5) {
      TU.tWave0.value = this.waves.disp[0].texture; TU.tWave1.value = this.waves.disp[Math.min(1, this.waves.C - 1)].texture;
      TU.uWaveL.value.set(this.waves.cascades[0], this.waves.cascades[Math.min(1, this.waves.C - 1)]);
    } else TU.uRun.value.set(0, 0);
    this.drawsWater = !!(this.waves && this.source.waters); // the caller can stop drawing its own water bodies
    this._dtAvg = 1 / 60;
  }
  // the water bodies the source has round the eye (the game's birdbaths, fountains and puddles), nearest first, as
  // discs on the plane of the ground under them
  _bodies(eye) {
    const U = this.post.U, src = this.source;
    if (!src.waters) { U.uBodies.value = 0; return; }
    // the list changes only as the eye moves or the puddles come and go: looked up again after a metre or half a second
    const B = this._bodyMemo || (this._bodyMemo = { x: 1e9, z: 1e9, t: -1, slopes: new Map() });
    if (Math.abs(eye.x - B.x) < 1 && Math.abs(eye.z - B.z) < 1 && this.time - B.t < 0.5) return;
    B.x = eye.x; B.z = eye.z; B.t = this.time;
    const CS = src.chunkSize || 64, ci = Math.floor(eye.x / CS), cj = Math.floor(eye.z / CS), all = [];
    for (let j = cj - 2; j <= cj + 2; j++) for (let i = ci - 2; i <= ci + 2; i++) for (const b of src.waters(i, j)) all.push(b); // two chunks out: a pond shows from across the park
    for (const b of all) b.d = Math.hypot(b.x - eye.x, b.z - eye.z) - b.r;
    all.sort((a, b) => a.d - b.d);
    const n = Math.min(all.length, WATER.bodies);
    for (let k = 0; k < n; k++) {
      const b = all[k], key = b.x * 7919 + b.z; // a body's plane never changes: worked out once, kept in a table
      let pl = B.slopes.get(key);
      if (!pl) {
        const e = Math.max(0.1, b.r * 0.5), h = (x, z) => src.height(x, z);
        pl = { gx: (h(b.x + e, b.z) - h(b.x - e, b.z)) / (2 * e), gz: (h(b.x, b.z + e) - h(b.x, b.z - e)) / (2 * e), h: h(b.x, b.z) };
        if (B.slopes.size > 4096) B.slopes.clear();
        B.slopes.set(key, pl);
      }
      U.uBody.value[k].set(b.x, b.z, b.r, pl.h + b.top);
      U.uBodyB.value[k].set(pl.gx, pl.gz, b.depth, b.kind);
      U.uBodyC.value[k].set(b.lobes ? b.lobes[0] : 0, b.lobes ? b.lobes[1] : 0, b.lobes ? 1 : 0, 0);
    }
    U.uBodies.value = n;
  }
  // A new world in the same session (the game's newWorld): the clipmap keeps its uniforms, the forest is rebuilt.
  setSource(source, x = 0, z = 0) {
    this.source = source;
    this._bodyMemo = null; // a new world: its water bodies afresh
    this.clip.setSource(source); if (this.shore) this.shore.rebake();
    this.post.U.uSea.value = source.sea; this.post.U.uWaterOn.value = source.sea < -1e5 ? 0 : 1; this.uShoreSea.value = source.sea;
    this._water();
    this.group.remove(this.forest.group);
    this.forest = new Forest(this, { range: this.q.trees, far: this.q.far });
    this.group.add(this.forest.group);
    this._mark();
    this.build(x, z);
  }
  // every World v2 object says so, so the game's own terrain patching (terrApply) leaves it alone and never lifts it
  // twice; userData.ring is the flag game.js already skips
  _mark() { this.group.traverse((o) => { o.userData.ring = true; o.userData.world2 = true; }); }
  set(o) { Object.assign(this.env, o); }
  build(x, z) { this.clip.build(x, z); if (this.shore) this.shore.update(); }
  update(dt, eye, focusDist = 10) {
    const E = this.env, U = this.post.U;
    this.time += dt;
    this.eye.copy(eye); this.focusDist = focusDist;
    this.clip.update(eye.x, eye.z, dt, this.source.glsl ? 0 : 3);
    if (this.shore) { this.timer.begin('shore'); this.shore.update(); this.timer.end(); }
    // the weather and the season from the clock (the template); the game sets these fields itself (auto: false)
    const S = this.season = seasonAt(E.day ?? 100);
    if (E.auto) {
      const w = this.weather = weatherAt(this.source.params.seed | 0, Math.floor(E.day ?? 100), E.hour);
      E.haze = w.haze; E.mist = w.mist; E.wet = w.wet; E.cloud = w.cover; E.cloudDens = w.cloudDens; E.wind10 = w.wind; E.wind = [w.wind[0] * 0.35, w.wind[1] * 0.35];
      E.rain = w.rain; E.snow = w.snow > 0 ? 1 : 0; E.storm = w.storm;
      // lightning: in a storm, a flash now and then (a hash of the half second), gone in a few frames
      const sec = Math.floor(this.time * 2), hit = w.storm > 0.3 && hash01(sec, 7, this.source.params.seed | 0) < 0.08 * w.storm;
      E.flash = hit ? 1 : Math.max(0, (E.flash || 0) - dt * 6);
    }
    // the season's look: the leaves, the snow line, the grass, the flowers, the ice
    const FU = this.forest.uniforms; FU.uLeafTint.value.set(...S.leafTint); FU.uAutumn.value = S.autumn; FU.uLeafGone.value = S.leafGone; FU.uSnowOn.value = S.snow;
    if (this.source.sea > -1e5) this.uniforms.uSnowLine.value = S.snowLine + this.source.sea;
    this.uniforms.uGrassTint.value.set(...S.grassTint); this.uniforms.uSnowOn.value = S.snow;
    this.grass.season(S.bloom, S.grassTint, S.snow);
    U.uIce.value = this.source.sea > -1e5 ? S.freeze : 0;
    U.uMap.value = E.map || 0; U.uSnowLine.value = this.uniforms.uSnowLine.value - (this.source.sea > -1e5 ? this.source.sea : 0);
    // sun, sky and the light they give
    if (E.day !== undefined) sunAtSeason(E.hour, S.dec, this.sunDir); else sunAt(E.hour, this.sunDir); // a caller with a calendar gets the real track
    // the camera's height above sea level for the air: a source without water counts from 0 (its sea is a sentinel)
    const camH = Math.max(1, eye.y - (this.source.sea > -1e5 ? this.source.sea : 0));
    this.sky.update(this.sunDir, camH, E.haze);
    this.uniforms.uSunDir.value.copy(this.sunDir);
    // the clouds overhead take the sun's light (their shadow on the ground is the map; this is the average under cover)
    const cover = E.cloud ?? 0, through = 1 - 0.85 * THREE.MathUtils.smoothstep(cover, 0.3, 0.95);
    this.sky.sunColor.multiplyScalar(through); this.sky.skyUp.multiplyScalar(1 - 0.3 * cover); this.sky.skyHorizon.multiplyScalar(1 - 0.3 * cover); this.sky.uniforms.uSunColor.value.copy(this.sky.sunColor);
    this.sun.color.copy(this.sky.sunColor); this.sun.intensity = 1 + 6 * (E.flash || 0);
    this.hemi.color.copy(this.sky.skyUp); this.hemi.intensity = 1 + 4 * (E.flash || 0);
    // what the ground sends back up: the sun and sky on an average ground (albedo 0.18)
    const g = Math.max(0, this.sunDir.y);
    this.hemi.groundColor.setRGB(0.18 * (this.sky.sunColor.r * g + this.sky.skyUp.r), 0.18 * (this.sky.sunColor.g * g + this.sky.skyUp.g), 0.15 * (this.sky.sunColor.b * g + this.sky.skyUp.b));
    // the shadow box follows the view: centimetres for a wasp, hills for the map
    const box = THREE.MathUtils.clamp(focusDist * 1.8 + 2, this.shadowMin, 2500);
    const SC = this.sun.shadow.camera;
    Object.assign(SC, { left: -box, right: box, top: box, bottom: -box, near: 0.05, far: box * 8 });
    SC.updateProjectionMatrix();
    const fx = eye.x + (this.camera.getWorldDirection(TMPV).x) * focusDist, fz = eye.z + TMPV.z * focusDist;
    const fy = this.heightAt(fx, fz);
    // snap the shadow box to its texels so shadows do not crawl as the camera moves
    const texel = (2 * box) / this.q.shadow;
    this.sun.target.position.set(Math.round(fx / texel) * texel, fy, Math.round(fz / texel) * texel);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, box * 4);
    this.uniforms.uShadowFar.value = box;
    this.uniforms.uWet.value = E.wet;
    this.uniforms.uTime.value = this.time; // the grass and the trees sway on this clock (the post chain has its own)
    this.forest.update(eye, dt);
    this.grass.update(eye, Math.max(this.heightAt(eye.x, eye.z), this.waterAt(eye.x, eye.z)));
    this.rain.update(this.time, eye, this.camera, E.wind10 || [E.wind[0] * 8, E.wind[1] * 8], E.rain || 0, E.snow, this.sky.skyUp);
    this.uniforms.uGrassR.value = this.grass.reach;
    // clouds: the weather's cover, drifting with the wind
    this.clouds.set(E.cloud ?? 0.35, E.cloudDens ?? 1, this.time, E.wind);
    // post
    U.uTime.value = this.time; U.uWet.value = E.wet; U.uWind.value.set(E.wind[0], E.wind[1]); U.uFlash.value = E.flash || 0;
    // water: the wind at 10 m (the game's own, else the drawing wind scaled to a breeze), waves past the frame rate faded
    this.timer.begin('waves');
    if (this.waves) {
      this._dtAvg += (Math.min(Math.max(dt, 1 / 240), 0.2) - this._dtAvg) * 0.05;
      const w10 = E.wind10 || [E.wind[0] * 8, E.wind[1] * 8];
      this.waves.update(this.time, w10, Math.PI / this._dtAvg);
      const st = this.waves.state;
      // the run-up's sea state: significant height H0 and the deep-water wavelength L0 of the peak period (2 pi g / w^2)
      if (this.source.sea > -1e5) {
        const wp = Math.sqrt(9.81 * st.kp + WAVES.T * st.kp ** 3); this.terrain.uniforms.uRun.value.set(this.waves.stats.Hs * 2 * Math.PI * 9.81 / (wp * wp), this.waves.stats.Hs);
        // the shore waves (shorefield.js): the sea's swell from the long fetch, a lake's from the local wind sea
        const sw = swellState(st.U10, this.source.water.swellFetch || this.source.water.fetch);
        this.uShoreWave.value.set(sw.Hs, Math.max(1.5, sw.Tp), this.waves.stats.Hs, Math.max(1.5, 2 * Math.PI / wp));
      }
      U.uWLost.value = this.waves.lostSlope; U.uWPeak.value = Math.min(2 * Math.PI / WAVES.km, 2 * Math.PI / st.kp); // the ripples at the gravity-capillary minimum, or the peak if shorter
      if (this.caustics) {
        const fx2 = eye.x + TMPV.x * focusDist, fz2 = eye.z + TMPV.z * focusDist, size = THREE.MathUtils.clamp(focusDist * 2.2, 6, 96);
        this.caustics.update(fx2, fz2, size, this.source.sea, this.sunDir);
        U.uCaus.value.set(this.caustics.U.uCenter.value.x, this.caustics.U.uCenter.value.y, size, this.caustics.on ? 1 : 0);
      }
      this._bodies(eye);
    }
    this.timer.end();
    U.uMist.value = 0.0012 * E.mist; U.uMistH.value = 40;
    U.uSkyUp.value.copy(this.sky.skyUp); U.uSkyHz.value.copy(this.sky.skyHorizon);
    U.uFocus.value = focusDist;
    U.uBlurIn.value = (1 - this.clip.sharpness()) * 3.0; // the picture comes into focus as the ground's detail arrives
    // exposure follows the light: a fixed EV for day, opening up at dusk
    const g2 = Math.max(0, this.sunDir.y), lum = 0.2126 * (this.sky.sunColor.r * g2 + this.sky.skyUp.r) + 0.7152 * (this.sky.sunColor.g * g2 + this.sky.skyUp.g) + 0.0722 * (this.sky.sunColor.b * g2 + this.sky.skyUp.b);
    // a grey card (18%) facing up maps to scene-linear 0.18 when exposure = pi / E (E: the light on level ground)
    U.uExposure.value = THREE.MathUtils.clamp(Math.PI / Math.max(lum, 0.05), 0.02, 40) * (E.exposure ?? 1);
  }
  render() {
    // count the whole frame (shadows, scene, post), not just its last pass
    const info = this.renderer.info; info.autoReset = false; info.reset();
    if (this.q.post) this.post.render(this.scene, this.camera, { dof: this.q.dof, rays: this.q.rays, clouds: this.q.clouds ? this.clouds : null, skyUp: this.sky.skyUp, timer: this.timer });
    else this.renderer.render(this.scene, this.camera);
    this.timer.frame();
    this.frameInfo = { calls: info.render.calls, tris: info.render.triangles };
  }
}
const TMPV = new THREE.Vector3();
