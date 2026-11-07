# World v3 on WebGPU (branch world/webgpu)

Decided 2026-11-07: the world layer moves from three.js `WebGLRenderer` (r160) to three.js `WebGPURenderer`
(0.186.1), with TSL node materials and WGSL kernels. WebGPU is the default; the same renderer falls back to WebGL 2
by itself where a browser has no WebGPU, so nothing goes dark. No renderer of our own and no Unity dependency.

What WebGL 2 could not do and this is for:
- compute passes: the clipmap filled by a compute kernel into a storage texture array (no draws into render targets);
  the shore table, foam fields, wave spectrum, swash and river flow as compute;
- GPU-driven culling: every tree tested against the view (later a depth pyramid) in a compute pass, the survivors and
  their counts written on the GPU and drawn indirectly; no CPU tiles, no thinning, nothing popping on a turn;
- storage buffers and texture arrays instead of a sampler per table (the 16-unit limit that kept the mirror off);
- GPU timestamps for the overlay.

Tested headless here (Chrome 153, SwiftShader's WebGPU adapter): the WebGPU backend starts, a compute pass with an
atomic counter reads back correctly, `timestamp-query` and `indirect-first-instance` are available.

## Order
1. Spike: three.js 0.186.1 beside r160 (its own page, `world-gpu.html`); noise and the wild source in WGSL; the
   clipmap filled by compute; the terrain; the trees with GPU culling and indirect draws. Measured against the WebGL
   build on the same view.
2. Water: the wave cascades, the shore table, foam fields, swash, surface.
3. Sky, clouds, post chain (TSL post-processing; `EffectComposer` is not supported there).
4. Grass, rain, caustics, the mirror.
5. The game (game.js) switches renderer: agreed with the main STING thread through the repo, since game.js shares the
   renderer and patches materials with `onBeforeCompile` (not supported by node materials).

## Porting rule
GLSL functions go to WGSL (naga converts most of them; checked by hand), wrapped with `wgslFn` and wired with TSL.
The JS twins (wild.js, scatter.js) stay as they are: placement and the sim read the same numbers.
