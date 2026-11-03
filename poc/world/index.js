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
import { Sky, makeClouds } from './sky.js';
import { Post } from './post.js';
import { Forest } from './trees.js';
import { Grass } from './grass.js';
import { WaveField } from './wavegpu.js';
import { Caustics } from './caustics.js';
import { WATER } from './water.js';
import { WAVES } from './waves.js';

// waveN: the wave grid per cascade; caustics: [texture size, grid] for the sea's caustics, 0 for none
export const QUALITY = {
  low:    { levels: 10, scale: 0.7,  shadow: 1024, grass: 0.35, trees: 0.5,  post: true,  dof: false, rays: false, msaa: 0, clouds: 40, waveN: 64,  caustics: 0 },
  medium: { levels: 11, scale: 0.85, shadow: 2048, grass: 0.6,  trees: 0.75, post: true,  dof: true,  rays: true,  msaa: 0, clouds: 56, waveN: 128, caustics: [256, 192] },
  high:   { levels: 12, scale: 1.0,  shadow: 2048, grass: 1.0,  trees: 1.0,  post: true,  dof: true,  rays: true,  msaa: 4, clouds: 64, waveN: 128, caustics: [512, 384] },
  ultra:  { levels: 13, scale: 1.0,  shadow: 4096, grass: 1.4,  trees: 1.3,  post: true,  dof: true,  rays: true,  msaa: 4, clouds: 80, waveN: 256, caustics: [1024, 640] },
};

// the sun's direction from the hour (6 rises, 18 sets), on a fixed track across the sky
export function sunAt(hour, out = new THREE.Vector3()) {
  const a = (hour - 6) / 12 * Math.PI, el = Math.sin(a) * 1.05, az = 2.2 + a * 0.9;
  return out.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
}

export class World {
  constructor(renderer, scene, camera, source, opts = {}) {
    this.renderer = renderer; this.scene = scene; this.camera = camera; this.source = source;
    this.q = { ...QUALITY[opts.quality || 'high'] };
    if (opts.dof === false) this.q.dof = false; // a game camera that has to read the scene, not a macro lens
    this.shadowMin = opts.shadowBox ?? 3; // the shadow box's least half-width (the game wants the people round the wasp)
    this.time = 0;
    this.env = { hour: 16.5, haze: 1, mist: 1, wet: 0, wind: [0.8, 0.3] };
    this.clip = new Clipmap(renderer, source, { levels: this.q.levels, ...(opts.clip || {}) });
    const wet = source.sea > -1e5; // a source without water: no beaches, no mud, no snow line; heights count from 0
    this.terrain = makeTerrain(this.clip, { sea: wet ? source.sea : 0, paving: source.kind === 'sting', shore: wet ? 1 : 0, snowLine: wet ? 215 : 1e9 });
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
    this.clouds = makeClouds({ radius: this.q.clouds });
    this.group.add(this.clouds.mesh);
    this.forest = new Forest(this, { range: this.q.trees });
    this.group.add(this.forest.group);
    this.uniforms.uTreeFar.value = this.forest.bands[3];
    // decorative flowers only in the wild world: in the game's world flowers are nectar, and the sim places them
    this.grass = new Grass(this, { density: this.q.grass, flowers: source.kind !== 'sting' });
    this.group.add(this.grass.group);
    this.post = new Post(renderer, this.sky, { msaa: this.q.msaa, scale: this.q.scale });
    this.post.U.uSea.value = source.sea;
    if (opts.lens) { const L = opts.lens, U = this.post.U; if (L.fstop) U.uFstop.value = L.fstop; if (L.maxCoc) U.uMaxCoc.value = L.maxCoc; if (L.focal) U.uFocal.value = L.focal; if (L.sensor) U.uSensor.value = L.sensor; }
    if (source.sea < -1e5) this.post.U.uWaterOn.value = 0;
    this._water();
    scene.add(this.group);
    this._mark();
    this.sunDir = sunAt(this.env.hour);
    this.eye = new THREE.Vector3();
    this.focusDist = 10;
  }
  heightAt(x, z) { return this.source.height(x, z); }
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
    this.post.setWater(this.waves, this.caustics);
    this.drawsWater = !!(this.waves && this.source.waters); // the caller can stop drawing its own water bodies
    this._dtAvg = 1 / 60;
  }
  // the water bodies the source has round the eye (the game's birdbaths, fountains and puddles), nearest first, as
  // discs on the plane of the ground under them
  _bodies(eye) {
    const U = this.post.U, src = this.source;
    if (!src.waters) { U.uBodies.value = 0; return; }
    const CS = src.chunkSize || 64, ci = Math.floor(eye.x / CS), cj = Math.floor(eye.z / CS), all = [];
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) for (const b of src.waters(i, j)) all.push(b);
    for (const b of all) b.d = Math.hypot(b.x - eye.x, b.z - eye.z) - b.r;
    all.sort((a, b) => a.d - b.d);
    const n = Math.min(all.length, WATER.bodies);
    for (let k = 0; k < n; k++) {
      const b = all[k], e = Math.max(0.1, b.r * 0.5), h = (x, z) => src.height(x, z);
      const gx = (h(b.x + e, b.z) - h(b.x - e, b.z)) / (2 * e), gz = (h(b.x, b.z + e) - h(b.x, b.z - e)) / (2 * e);
      U.uBody.value[k].set(b.x, b.z, b.r, h(b.x, b.z) + b.top);
      U.uBodyB.value[k].set(gx, gz, b.depth, b.kind);
    }
    U.uBodies.value = n;
  }
  // A new world in the same session (the game's newWorld): the clipmap keeps its uniforms, the forest is rebuilt.
  setSource(source, x = 0, z = 0) {
    this.source = source;
    this.clip.setSource(source);
    this.post.U.uSea.value = source.sea; this.post.U.uWaterOn.value = source.sea < -1e5 ? 0 : 1;
    this._water();
    this.group.remove(this.forest.group);
    this.forest = new Forest(this, { range: this.q.trees });
    this.group.add(this.forest.group);
    this._mark();
    this.build(x, z);
  }
  // every World v2 object says so, so the game's own terrain patching (terrApply) leaves it alone and never lifts it
  // twice; userData.ring is the flag game.js already skips
  _mark() { this.group.traverse((o) => { o.userData.ring = true; o.userData.world2 = true; }); }
  set(o) { Object.assign(this.env, o); }
  build(x, z) { this.clip.build(x, z); }
  update(dt, eye, focusDist = 10) {
    const E = this.env, U = this.post.U;
    this.time += dt;
    this.eye.copy(eye); this.focusDist = focusDist;
    this.clip.update(eye.x, eye.z, dt, this.source.glsl ? 0 : 3);
    // sun, sky and the light they give
    sunAt(E.hour, this.sunDir);
    // the camera's height above sea level for the air: a source without water counts from 0 (its sea is a sentinel)
    const camH = Math.max(1, eye.y - (this.source.sea > -1e5 ? this.source.sea : 0));
    this.sky.update(this.sunDir, camH, E.haze);
    this.uniforms.uSunDir.value.copy(this.sunDir);
    this.sun.color.copy(this.sky.sunColor); this.sun.intensity = 1;
    this.hemi.color.copy(this.sky.skyUp); this.hemi.intensity = 1;
    // what the ground sends back up: the sun and sky on an average ground (albedo 0.18)
    const g = Math.max(0, this.sunDir.y);
    this.hemi.groundColor.setRGB(0.18 * (this.sky.sunColor.r * g + this.sky.skyUp.r), 0.18 * (this.sky.sunColor.g * g + this.sky.skyUp.g), 0.15 * (this.sky.sunColor.b * g + this.sky.skyUp.b));
    // the shadow box follows the view: centimetres for a wasp, hills for the map
    const box = THREE.MathUtils.clamp(focusDist * 1.8 + 2, this.shadowMin, 2500);
    const S = this.sun.shadow.camera;
    Object.assign(S, { left: -box, right: box, top: box, bottom: -box, near: 0.05, far: box * 8 });
    S.updateProjectionMatrix();
    const fx = eye.x + (this.camera.getWorldDirection(TMPV).x) * focusDist, fz = eye.z + TMPV.z * focusDist;
    const fy = this.heightAt(fx, fz);
    // snap the shadow box to its texels so shadows do not crawl as the camera moves
    const texel = (2 * box) / this.q.shadow;
    this.sun.target.position.set(Math.round(fx / texel) * texel, fy, Math.round(fz / texel) * texel);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, box * 4);
    this.uniforms.uShadowFar.value = box;
    this.uniforms.uWet.value = E.wet;
    this.forest.update(eye, dt);
    this.grass.update(eye, Math.max(this.heightAt(eye.x, eye.z), this.source.sea));
    this.uniforms.uGrassR.value = this.grass.reach;
    // clouds
    this.clouds.update(eye.x, eye.z, this.time, [6, 2.4], this.source.params.seed || 1);
    Object.assign(this.clouds.uniforms, {});
    this.clouds.uniforms.uSun.value.copy(this.sunDir); this.clouds.uniforms.uSunColor.value.copy(this.sky.sunColor); this.clouds.uniforms.uSkyUp.value.copy(this.sky.skyUp);
    // post
    U.uTime.value = this.time; U.uWet.value = E.wet; U.uWind.value.set(E.wind[0], E.wind[1]);
    // water: the wind at 10 m (the game's own, else the drawing wind scaled to a breeze), waves past the frame rate faded
    if (this.waves) {
      this._dtAvg += (Math.min(Math.max(dt, 1 / 240), 0.2) - this._dtAvg) * 0.05;
      const w10 = E.wind10 || [E.wind[0] * 8, E.wind[1] * 8];
      this.waves.update(this.time, w10, Math.PI / this._dtAvg);
      const st = this.waves.state;
      U.uWLost.value = this.waves.lostSlope; U.uWPeak.value = Math.min(2 * Math.PI / WAVES.km, 2 * Math.PI / st.kp); // the ripples at the gravity-capillary minimum, or the peak if shorter
      if (this.caustics) {
        const fx2 = eye.x + TMPV.x * focusDist, fz2 = eye.z + TMPV.z * focusDist, size = THREE.MathUtils.clamp(focusDist * 2.2, 6, 96);
        this.caustics.update(fx2, fz2, size, this.source.sea, this.sunDir);
        U.uCaus.value.set(this.caustics.U.uCenter.value.x, this.caustics.U.uCenter.value.y, size, this.caustics.on ? 1 : 0);
      }
      this._bodies(eye);
    }
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
    if (this.q.post) this.post.render(this.scene, this.camera, { dof: this.q.dof, rays: this.q.rays });
    else this.renderer.render(this.scene, this.camera);
    this.frameInfo = { calls: info.render.calls, tris: info.render.triangles };
  }
}
const TMPV = new THREE.Vector3();
