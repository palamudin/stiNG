# World v2

The drawing of the ground, forests, grass, sky and air, as one system with one entry point. Presentation only: it reads a
source and never writes to the sim. Design notes and how the game uses it: GDD 20.4 and 20.5.

```js
const world = new World(renderer, scene, camera, source, { quality: 'medium', clip: { levels: 11 }, sun, hemi, shadowBox: 18, lens: { fstop: 8 } });
world.build(x, z);                                   // a full fill at (x, z), behind a loading screen
// each frame
world.set({ hour, haze, mist, wet, wind: [x, z], wind10: [x, z] }); // wind10: m/s at 10 m, for the waves (optional)
world.update(dt, cameraPosition, focusDistance);
world.render();                                      // scene -> post chain -> screen
world.heightAt(x, z);                                // the source's exact height
world.setSource(source, x, z);                       // a new world into the same World (its uniforms stay the same objects)
```

**A source** is `{ kind, params, sea, sample(x, z, out) -> [height, moisture, forest, paving], height(x, z), glsl, uniforms,
objects?(cx, cz), trunks?, grassHeight, cosmetic?, water?, waters?(cx, cz) }`. `glsl` (a `wildSample(vec2)` returning the same four channels) lets the clipmap
fill on the GPU; without it the clipmap fills on the CPU within a budget. `objects` hands the forest a chunk's own trees
(`x, z, r, h, cr, shade`), one tree each; `trunks: false` leaves the trunks to the caller.

`cosmetic` is decoration's salt (the game's: `hash(seed, Domain.Cosmetic, 0)`, GDD 20.4 point 3). `water` is
`{ fetch, cascades }` for the wave field; `waters(cx, cz)` lists a chunk's water bodies as `{ x, z, r, top, depth, kind }`
(`top` above the ground; `kind` 1 a bowl, 2 a flat basin, 3 the ground itself, a puddle).

- `sources/sting.js`: the game's world (the sim's `groundAt`, land use, `pavingOf`, the chunk's trees with no trunks, and
  its birdbaths, fountains and the sim's puddles while the ground is wet).
- `sources/wild.js`: a standalone wild world with water, for the template page `../world.html`.

**Lifting other objects.** `clipLiftGLSL({ levels })` (clipmap.js) is GLSL with `clipHeight` and a `ringHeightAt` answered
by it, so materials that call `ringHeightAt` stand on this ground. Put `world.clip.uniforms` into their uniforms. World v2's
own objects carry `userData.ring` and `userData.world2`, so the game's patching leaves them alone.

**Tiers** (`QUALITY` in index.js): low, medium, high, ultra: clipmap levels, render scale, shadow size, grass and tree
distances, depth of field, god rays, MSAA, cloud steps, the wave grid (64, 128, 128, 256) and the sea's caustics (off,
256/192, 512/384, 1024/640: texture and grid).

## Water (W2)

One wave field drives every water surface: the lakes of the wild world and the game's birdbaths, fountains and puddles.

**The waves** (`waves.js`, the math; `wavegpu.js`, the GPU side).
- **Spectrum.** Elfouhaily et al. (1997), which runs from gravity waves through capillary ripples in one formula. Its
  inputs are the wind at 10 m and the fetch. A 600 m lake under 6.8 m/s gets chop with a 1.9 m peak. A birdbath
  (0.8 m fetch) under 2.5 m/s gets 1.6 cm ripples.
- **Dispersion** is capillary-gravity, `w^2 = g k + (sigma/rho) k^3`.
- **No ripples in still air.** Below a friction velocity of 2 cm/s there are no waves (Kahma and Donelan 1988, JFM 192).
- **Direction.** Each direction's energy is split downwind and upwind by `(1 + cos)^2 / (2 + 2 cos^2)` (our choice;
  Elfouhaily's spreading is symmetric).
- **Chop** sharpens crests for gravity waves and troughs for capillary ripples (Crapper 1957). It changes over at 1.7 cm.
- **The loop.** Frequencies are rounded so the sea repeats every 256 s with no float drift.
- **The frame rate.** Waves faster than it can show are faded, and their slope variance goes to roughness.
- **The FFT.** An inverse FFT on the GPU as radix-2 Stockham passes (no bit reversal). All cascades sit in one float
  atlas, with four real fields packed into two complex ones.
- **Outputs** per cascade, each tiling and mip-mapped:
  - displacement and fold, `(Dx, h, Dz, J)`;
  - slope moments, `(sx, sz, sx^2, sz^2)`.
- **Cascades.** The wild world uses 48, 6.9, 1.0 and 0.14 m. The game's world uses 0.6 and 0.085 m.

**The surface** (`water.js`, drawn in the composite pass, `post.js`).
- **The sea.** The plane y = sea, iterated onto the displaced surface near the camera.
- **Bodies.** Discs on the plane of the ground under them, at the sim's own height above the ground, so a drinking wasp
  stands on the water as drawn. The 8 nearest are drawn.
- **Filtering.** Slopes are filtered to the pixel's footprint (anisotropic) as a mean and a variance (LEAN mapping).
  Waves too small to see become the roughness of the sun's highlight, so nothing shimmers.
- **Light.**
  - Exact unpolarised Fresnel.
  - The sun through the pixel's Gaussian slope distribution, widened by the sun's disc, with Smith masking.
  - Screen-space reflection (a hit needs the ray to cross the scene within a step), with the sky behind it.
  - Snell refraction. A basin the game draws solid gets a bowl or a flat floor, lit by the basin top as drawn.
  - Beer-Lambert on the way down and back up, and in-scattering.
  - Foam where the surface folds and at the shore.
- **Glints.** The highlight is a countable number of mirror facets, about the size of the ripples at the
  gravity-capillary minimum (our estimate).
  - Each world-anchored cell draws a Poisson count. The cell sizes are the two powers of two round the footprint,
    blended by the fraction between them.
  - Each cell redraws about three times a second and fades between draws.
  - `WATER.glint` (0.75) softens the spread toward the smooth highlight. That is a choice for the look; the mean
    brightness is exact at any setting.
- **Caustics, the sea** (`caustics.js`).
  - A grid over the water round the view is refracted at the displaced surface and run down to the floor as drawn.
  - It is splatted where it lands, adding the ratio of its flat-water area to its new area, both faces, so focusing
    and the folds past a focus are exact.
  - Slopes come from a mip as wide as a grid cell.
- **Caustics, bodies.** 1/|det J| of the refracted-sun map, linearised, from the slope field's curvature. This is valid
  short of the ripples' focus, which a few centimetres of birdbath is.

**Checks** (run from `poc/`; the browser pages headless, software WebGL):

| Check | Result |
|---|---|
| `node world/test/world.test.mjs` (wave part) | The Stockham passes equal a plain inverse DFT (1.5e-11). The grids hold the spectrum's height variance (8.4 against 8.5 cm). Lake Hs is within 15% of the JONSWAP fetch law at 3–12 m/s: 8.5 against 8.5 cm at 6.8 m/s over 600 m. A birdbath peaks at 1.6 cm. The water is glassy below u* = 2 cm/s. The chop compresses crests. The slowest ripple is 1.71 cm, at 23.1 cm/s. |
| `world/test/waves-gpu.html` | The GPU field against a direct double-precision sum over every wave vector. Lake: height within 2.7e-5 m of 4 cm, slope within 1.1e-4 of 0.17. Birdbath: 1.1e-5 m of 0.64 mm (fp32 phase on the fastest ripples). Realised Hs against the spectrum: 8.6 / 8.4 cm, 0.97 / 0.96 mm. |
| `world/test/caustics.html` | Still water: every pixel 1. Under waves (Hs 3.6–15 cm, floor 2 m down): the mean over the floor is 1.00–1.04. It was 0.88 before both faces of the light sheet were drawn. |

**Not verified.** Frame times on a real GPU (the passes per frame: 1 spectrum, 2 log2 N FFT, 2 per cascade, mips,
the caustic grid). Phones. The look of glints in motion.

**Known limits.**
- At grazing angles the screen-space reflection steps in bands at low resolution.
- Floor caustics are also drawn in the shade of a tree (the composite cannot tell shade from a dark floor).
- The camera under water is not handled.
- The birdbath bowl is our shape (4 cm deep; the game draws a solid basin).
