// The foam texture on WebGPU: water3/foamtex.js's bake (tileable Voronoi lace and bubbles in R, the whitewater's
// billow height in G, its gradient in BA), its shader converted (gen-wgsl.mjs), drawn once into a mipmapped target.
import * as THREE from 'three/webgpu';
import { wgslFn, wgsl, screenUV } from 'three/tsl';
import { FOAM_WGSL } from './foamtex.wgsl.js';

export function bakeFoamTexture(renderer, size = 512) {
  const rt = new THREE.RenderTarget(size, size, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
  rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping; rt.texture.generateMipmaps = true; rt.texture.minFilter = THREE.LinearMipmapLinearFilter; rt.texture.anisotropy = 8;
  const tex = wgslFn('fn foamAt(uv: vec2<f32>) -> vec4<f32> { return foamTexel(uv); }', [wgsl(FOAM_WGSL)]);
  const mat = new THREE.MeshBasicNodeMaterial(); mat.outputNode = tex({ uv: screenUV });
  const quad = new THREE.QuadMesh(mat), prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); quad.render(renderer); renderer.setRenderTarget(prev);
  mat.dispose();
  return rt;
}
