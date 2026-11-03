# World v2

The drawing of the ground, forests, grass, sky and air, as one system with one entry point. Presentation only: it reads a
source and never writes to the sim. Design notes and how the game uses it: GDD 20.4 and 20.5.

```js
const world = new World(renderer, scene, camera, source, { quality: 'medium', clip: { levels: 11 }, sun, hemi, shadowBox: 18, lens: { fstop: 8 } });
world.build(x, z);                                   // a full fill at (x, z), behind a loading screen
// each frame
world.set({ hour, haze, mist, wet, wind: [x, z] });
world.update(dt, cameraPosition, focusDistance);
world.render();                                      // scene -> post chain -> screen
world.heightAt(x, z);                                // the source's exact height
world.setSource(source, x, z);                       // a new world into the same World (its uniforms stay the same objects)
```

**A source** is `{ kind, params, sea, sample(x, z, out) -> [height, moisture, forest, paving], height(x, z), glsl, uniforms,
objects?(cx, cz), trunks?, grassHeight }`. `glsl` (a `wildSample(vec2)` returning the same four channels) lets the clipmap
fill on the GPU; without it the clipmap fills on the CPU within a budget. `objects` hands the forest a chunk's own trees
(`x, z, r, h, cr, shade`), one tree each; `trunks: false` leaves the trunks to the caller.

- `sources/sting.js`: the game's world (the sim's `groundAt`, land use, `pavingOf`, and the chunk's trees, no trunks).
- `sources/wild.js`: a standalone wild world with water, for the template page `../world.html`.

**Lifting other objects.** `clipLiftGLSL({ levels })` (clipmap.js) is GLSL with `clipHeight` and a `ringHeightAt` answered
by it, so materials that call `ringHeightAt` stand on this ground. Put `world.clip.uniforms` into their uniforms. World v2's
own objects carry `userData.ring` and `userData.world2`, so the game's patching leaves them alone.

**Tiers** (`QUALITY` in index.js): low, medium, high, ultra: clipmap levels, render scale, shadow size, grass and tree
distances, depth of field, god rays, MSAA, cloud steps.

Tests with no browser: `node test/view.test.mjs` in `poc/`.
