// Water 3: the foam field. Foam that lasts and travels, the way breaking water makes it: a grid of foam amounts round
// the camera (world-anchored: it is read and written by world position, so it stays put as the camera moves and what
// leaves the window is dropped), updated once a frame on the GPU:
//   - carried: each texel takes the foam from upstream (semi-Lagrangian): shoreward at the bore's speed in the surf
//     zone (sqrt(g depth) along the shore table's direction), drifting with the wind elsewhere;
//   - lingering: it fades over the panel's 'foam linger' seconds;
//   - made: where the open sea's surface folds (the cascades' Jacobian under the panel's whitecap bias: whitecaps),
//     and where the surf breaks (the crest's whitewater and the foam charge it throws ahead: water3/swash.js w3Coast),
//     by how hard: a bigger wave breaking makes more foam, a small one less.
// The surface reads it for the foam's coverage (its texture: water3/foamtex.js), so a crash leaves foam that rides in and
// meets the shore's own (the swash's lace and white) instead of foam that exists only where the breaker is this frame.
import * as THREE from 'three';
import { NOISE_GLSL } from '../noise.js';
import { SWASH_GLSL, SURF_GLSL } from './swash.js';
import { CURL_EVENT_GLSL } from './curl.js';

export const FOAM_FIELD = { near: { n: 256, texel: 0.5 }, far: { n: 256, texel: 8.0 } }; // 128 m and 2 km round the camera

export class FoamField {
  // world: the World; surface: the WaterSurface (its uniforms); level: FOAM_FIELD.near or .far; names: what the surface
  // reads it as [texture, window]
  constructor(world, surface, level = FOAM_FIELD.near, names = ['tFoamField', 'uFoamWin']) {
    const C = this.C = level, n = C.n, W = n * C.texel, shore = world.shore, field = world.waves;
    const rt = () => new THREE.WebGLRenderTarget(n, n, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
    this.a = rt(); this.b = rt(); this.world = world; this.W = W;
    this.U = {
      ...world.clip.uniforms, ...(shore ? shore.uniforms : {}),
      uSurf: world.uSurf, uSurfX: world.uSurfX, uWTime: world.uWTime, uSwDir: world.uSwDir, uLook2: world.uLook2, uLook3: world.uLook3,
      uSeaLevel: surface.U.uSeaLevel, uWL: surface.U.uWL,
      tWD1: { value: field.disp[1].texture }, tWD2: { value: field.disp[2].texture },
      tPrev: { value: null }, uOrigin: { value: new THREE.Vector2() }, uPrevOrigin: { value: new THREE.Vector2() }, uDt: { value: 0 }, uLinger: { value: 4 }, uDrift: { value: new THREE.Vector2() },
    };
    // what the surface reads: the field, its window's corner and size
    this.names = names; this.read = { [names[0]]: { value: this.a.texture }, [names[1]]: { value: new THREE.Vector3(0, 0, W) } };
    const coast = shore ? `${shore.glsl()}\n#define FF_COAST\n${SWASH_GLSL}\n${SURF_GLSL}\n${CURL_EVENT_GLSL}` : '';
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.U, depthTest: false, depthWrite: false,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `precision highp float; precision highp int;
${NOISE_GLSL}
${world.clip.glsl()}
${coast}
uniform sampler2D tPrev, tWD1, tWD2; uniform vec2 uOrigin, uPrevOrigin, uDrift; uniform float uDt, uLinger, uSeaLevel; uniform vec4 uWL, uLook2, uLook3;
out vec4 oColor;
const float N = ${n}.0, TX = ${C.texel.toFixed(3)}, W = ${W.toFixed(1)};
float prevAt(vec2 p) { vec2 uv = (p - uPrevOrigin) / W; if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0; return texture(tPrev, uv).r; }
void main() {
  vec2 p = uOrigin + (gl_FragCoord.xy) * TX; // the texel's centre (gl_FragCoord is at .5)
  float level = clipWater(p), bed = clipHeight(p), depth = level - bed;
  if (depth <= 0.0) { oColor = vec4(0.0); return; } // the sand's foam is the swash's own
  vec2 v = uDrift; float make = 0.0;
  // whitecaps: the open water folding (the 85 m and 12 m cascades' Jacobian), by the panel's bias and scale
  float lod1 = max(0.0, log2(TX * ${field.N}.0 / uWL.y)), lod2 = max(0.0, log2(TX * ${field.N}.0 / uWL.z)); // the folds the texel can hold
  float J = 1.0 + (textureLod(tWD1, p / uWL.y, lod1).w - 1.0) * smoothstep(0.6, 5.0, depth) + (textureLod(tWD2, p / uWL.z, lod2).w - 1.0) * smoothstep(0.2, 2.0, depth);
  make = clamp((0.6 + uLook2.y - J) * uLook2.z, 0.0, 1.0) * 0.5;
#ifdef FF_COAST
  // the surf: its crest's whitewater and the charge it throws ahead, made in proportion to the wave that broke; the
  // foam behind carried shoreward at the bore's speed
  if (level <= uSeaLevel + 0.5 && uSurf.x > 0.0 && sw3Ctx(p)) {
    w3Coast(p, depth, TX);
    float big = smoothstep(0.1, 0.9, uSurf.x * gNear * gExpo);
    make = max(make, gCoastFoam.x * mix(0.55, 1.0, big));
    // foam left behind stays where it was made and only drifts in slowly; the bore's own white is made afresh at its
    // front each frame (the crest's whitewater and charge), so it keeps up with the wave without the field dragging
    v += gDir * 0.25 * gNear;
    // the curl's landing (water3/curl.js, the same event): white where the lip comes down on the face and the splash
    // ahead of it, then along the lip as it drops into the bore, by how big the wave is; what it leaves is the lace
    if (uLook3.w > 0.0) {
      curlEvent(p, level, depth);
      float Lt = max(gcH0 * uLook3.w * gcXs * 1.64, 0.1), xa = -gcPsi / gcK / Lt; // this texel ahead of its crest, in the lip's reach
      float land = smoothstep(0.4, 0.55, gcEv) * smoothstep(0.75, 0.95, xa) * (1.0 - smoothstep(1.3, 1.9, xa));
      float drop = gcFall * smoothstep(0.1, 0.4, xa) * (1.0 - smoothstep(1.2, 1.6, xa));
      make = max(make, gcShow * max(land, drop) * smoothstep(0.05, 0.4, gcA0) * 1.2);
    }
  }
#endif
  float prev = prevAt(p - v * uDt); // carried from upstream
  // foam builds up where breaking goes on (a surf beach stays foamed), fading over the linger time where it stops
  float f = min(prev * exp(-uDt / max(uLinger, 0.05)) + make * uDt * 2.0, 1.0);
  oColor = vec4(f, 0.0, 0.0, 1.0);
}`,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat); this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad); this.cam = new THREE.Camera();
    this._init = false;
  }
  // once a frame, after the wave field: dt in seconds of the water's clock, the camera, the wind (m/s), linger (s)
  update(renderer, dt, camera, wind, linger) {
    const U = this.U, C = this.C, half = this.W / 2;
    U.uPrevOrigin.value.copy(U.uOrigin.value);
    U.uOrigin.value.set(Math.floor((camera.position.x - half) / C.texel) * C.texel, Math.floor((camera.position.z - half) / C.texel) * C.texel);
    if (!this._init) { U.uPrevOrigin.value.copy(U.uOrigin.value); this._init = true; }
    U.uDt.value = Math.min(Math.max(dt, 0), 0.1); U.uLinger.value = linger;
    U.uDrift.value.set(wind[0] * 0.03, wind[1] * 0.03);
    U.tPrev.value = this.a.texture;
    const prev = renderer.getRenderTarget(); renderer.setRenderTarget(this.b); renderer.render(this.scene, this.cam); renderer.setRenderTarget(prev);
    [this.a, this.b] = [this.b, this.a];
    // the foam pieces' splats (water3/surffoam.js), added into the new state
    if (this.splat) {
      const SU = this.splat.U; SU.uFieldWin.value.set(U.uOrigin.value.x, U.uOrigin.value.y, this.W); SU.uSplatK.value = U.uDt.value * 1.5;
      const ac = renderer.autoClear; renderer.autoClear = false; renderer.setRenderTarget(this.a); renderer.render(this.splat.splats, this.cam); renderer.setRenderTarget(prev); renderer.autoClear = ac;
    }
    this.read[this.names[0]].value = this.a.texture; this.read[this.names[1]].value.set(U.uOrigin.value.x, U.uOrigin.value.y, this.W);
  }
  dispose() { this.a.dispose(); this.b.dispose(); this.mat.dispose(); this.quad.geometry.dispose(); }
}
