// Falling rain and snow (W3): one quad, instanced a few thousand times in a box round the camera, moved entirely in
// the vertex shader. A raindrop is a streak along its own velocity (the fall at 7 m/s plus the wind), a flake a small
// square that drifts and tumbles at 1 m/s. Each instance has its own place from a hash, wraps when it leaves the box,
// and the box rides with the camera, so there is always weather round the eye and nothing is spawned in JS.
import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

const _vr = new THREE.Matrix4();
export const RAIN = { count: 6000, box: [14, 10, 14], fall: 7, snowFall: 1.0, streak: 0.12 };

export class Rain {
  constructor(world) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ids = new Float32Array(RAIN.count); for (let i = 0; i < RAIN.count; i++) ids[i] = i;
    geo.setAttribute('aId', new THREE.InstancedBufferAttribute(ids, 1));
    geo.instanceCount = RAIN.count; geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.U = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uCamB: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2() }, uAmount: { value: 0 }, uSnow: { value: 0 }, uSkyUp: { value: new THREE.Color() }, uSunColor: world.sky.uniforms.uSunColor, uVP: { value: new THREE.Matrix4() }, uCamR: { value: new THREE.Vector3() }, uCamU: { value: new THREE.Vector3() } };
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.U, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `${NOISE_GLSL}
in float aId;
uniform float uTime, uAmount, uSnow; uniform vec3 uCam, uCamR, uCamU, uCamB; uniform vec2 uWind; uniform mat4 uVP; // uCamB: the eye mod the box (doubles)
out float vA;
void main() {
  int i = int(aId);
  float share = w2hash01(i, 1, 501);
  if (share > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
  vec3 B = vec3(${RAIN.box.map((v) => v.toFixed(1)).join(', ')});
  float fall = mix(${RAIN.fall.toFixed(1)}, ${RAIN.snowFall.toFixed(1)}, uSnow) * (0.8 + 0.4 * w2hash01(i, 2, 501));
  vec3 vel = vec3(uWind.x * mix(0.7, 0.9, uSnow), -fall, uWind.y * mix(0.7, 0.9, uSnow));
  // the drop's place: a hash start, moved by its velocity, wrapped into the box round the camera
  vec3 p0 = vec3(w2hash01(i, 3, 501), w2hash01(i, 4, 501), w2hash01(i, 5, 501)) * B;
  vec3 p = p0 + vel * uTime;
  if (uSnow > 0.5) p.xz += vec2(sin(uTime * 1.3 + float(i)), cos(uTime * 1.1 + float(i) * 0.7)) * 0.4; // flakes wander
  p = mod(p - uCamB + B * 0.5, B) - B * 0.5; // from the eye, wrapped into the box round it: never absolute (GDD 18.95)
  // a streak along the velocity (rain), or a flake facing the eye (snow)
  float len = mix(${RAIN.streak.toFixed(2)} * length(vel) / ${RAIN.fall.toFixed(1)}, 0.0, uSnow), w = mix(0.0025, 0.012, uSnow);
  vec3 up = mix(normalize(-vel), uCamU, uSnow), right = mix(normalize(cross(up, normalize(-p))), uCamR, uSnow);
  vec3 P = p + right * position.x * w + up * (position.y - 0.5) * (len + w * 2.0 * uSnow);
  vA = mix(0.35, 0.9, uSnow);
  gl_Position = uVP * vec4(P, 1.0);
}`,
      fragmentShader: `precision highp float;
uniform vec3 uSkyUp, uSunColor; uniform float uSnow;
in float vA; out vec4 oColor;
void main() { vec3 c = mix(uSkyUp * 0.9 + uSunColor * 0.04, uSkyUp * 1.6 + uSunColor * 0.15, uSnow); oColor = vec4(c, vA); }`,
    });
    this.mesh = new THREE.Mesh(geo, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 10;
    this.mesh.userData = { ring: true, world2: true };
  }
  update(time, eye, camera, wind, amount, snow, skyUp) {
    const U = this.U;
    U.uTime.value = time; U.uCam.value.copy(eye); U.uWind.value.set(wind[0], wind[1]); U.uAmount.value = amount; U.uSnow.value = snow ? 1 : 0; U.uSkyUp.value.copy(skyUp);
    U.uVP.value.multiplyMatrices(camera.projectionMatrix, _vr.copy(camera.matrixWorldInverse).setPosition(0, 0, 0)); // the view's rotation: drops go in from the eye
    const b = RAIN.box; U.uCamB.value.set(eye.x - Math.floor(eye.x / b[0]) * b[0], eye.y - Math.floor(eye.y / b[1]) * b[1], eye.z - Math.floor(eye.z / b[2]) * b[2]);
    U.uCamR.value.setFromMatrixColumn(camera.matrixWorld, 0); U.uCamU.value.setFromMatrixColumn(camera.matrixWorld, 1);
    this.mesh.visible = amount > 0.01;
  }
}
