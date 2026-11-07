// Water 3: the foam texture, baked once (after Ultra-Water's bakeTextures, MIT, Humpalumps; the pack is the user's own):
// tileable, mipmapped, 512 x 512. R: lace (Voronoi cell edges at three scales and bubbles; coverage erodes from it),
// G: the whitewater's billow height (cauliflower: every cell domed, creased where cells meet), BA: its gradient. Read
// by the surface's foam and by the billows and streaks over it (surffoam.js) instead of noise summed per pixel.
import * as THREE from 'three';

export const FOAM = /* glsl */ `precision highp float;
out vec4 oColor;
uniform float uSize;
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
// tileable Voronoi: the cell ids wrap at the period; (nearest, second nearest)
vec2 voronoi(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p); float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y), o = hash22(mod(i + g, period)); float d = length(g + o - f);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return vec2(f1, f2);
}
float billow(vec2 uv) {
  vec2 a = voronoi(uv * 7.0 + 0.3, 7.0), b = voronoi(uv * 17.0 + 0.7, 17.0), c = voronoi(uv * 41.0 + 0.1, 41.0);
  return 0.5 * sqrt(clamp((a.y - a.x) * 2.2, 0.0, 1.0)) + 0.32 * sqrt(clamp((b.y - b.x) * 2.2, 0.0, 1.0)) + 0.18 * sqrt(clamp((c.y - c.x) * 2.2, 0.0, 1.0));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 a = voronoi(uv * 9.0, 9.0), b = voronoi(uv * 23.0 + 0.5, 23.0), c = voronoi(uv * 61.0, 61.0);
  float lace = 1.0 - smoothstep(0.0, 0.22, a.y - a.x), fine = 1.0 - smoothstep(0.0, 0.16, b.y - b.x), bubbles = smoothstep(0.55, 0.15, c.x);
  float v = lace * 0.55 + fine * 0.3 + bubbles * 0.25 + (1.0 - a.x) * 0.25;
  float e = 1.0 / uSize;
  vec2 g = vec2(billow(uv + vec2(e, 0.0)) - billow(uv - vec2(e, 0.0)), billow(uv + vec2(0.0, e)) - billow(uv - vec2(0.0, e))) / (2.0 * e);
  oColor = vec4(clamp(v * 0.85, 0.0, 1.0), billow(uv), clamp(0.5 + g / 64.0, 0.0, 1.0));
}`;

export function bakeFoamTexture(renderer, size = 512) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true, depthBuffer: false, anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
  });
  const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { uSize: { value: size } }, vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: FOAM, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); quad.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(quad);
  const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.render(scene, new THREE.Camera()); renderer.setRenderTarget(prev);
  mat.dispose(); quad.geometry.dispose();
  return rt; // keep it: its texture is read every frame (dispose the target with the water)
}
