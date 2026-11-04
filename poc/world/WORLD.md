# World v2

The drawing of the ground, forests, grass, sky and air, as one system with one entry point. Presentation only: it reads a
source and never writes to the sim. Design notes and how the game uses it: GDD 20.4 and 20.5.

```js
const world = new World(renderer, scene, camera, source, { quality: 'medium', clip: { levels: 11 }, sun, hemi, shadowBox: 18, lens: { fstop: 8 } });
world.build(x, z);                                   // a full fill at (x, z), behind a loading screen
// each frame
world.set({ hour, day, auto: true, map: 0 });         // the template: the weather and the season follow the clock (seasons.js)
world.set({ hour, auto: false, haze, mist, wet, wind: [x, z], wind10: [x, z], cloud, rain, snow, storm, flash }); // the game: its own weather
world.update(dt, cameraPosition, focusDistance);
world.render();                                      // scene -> post chain -> screen
world.heightAt(x, z);                                // the source's exact height
world.setSource(source, x, z);                       // a new world into the same World (its uniforms stay the same objects)
```

**A source** is `{ kind, params, sea, sample(x, z, out) -> [height, moisture, forest, paving, waterLevel], height(x, z),
waterAt?(x, z), lakeAt?(x, z), glsl, uniforms, objects?(cx, cz), trunks?, wildFrom?, grassHeight, wildGrass?, cosmetic?,
water?, waters?(cx, cz) }`. `glsl` (a `wildSample(vec2)` returning the first four channels and a `wildWater(vec2)` for the
fifth) lets the clipmap fill on the GPU; without it the clipmap fills on the CPU within a budget. `objects` hands the
forest a chunk's own trees (`x, z, r, h, cr, shade`), one tree each; `trunks: false` leaves their trunks to the caller.
`wildFrom` (metres from the origin) says where the settled area ends and the wild rule plants the forest.

The fifth channel (W3) is the water level there: the sea, or a lake's own level inside its basin. Everything that reads
the shore, the grass line, the caustics and the open water reads it from the clipmap (`clipWater`).

`cosmetic` is decoration's salt (the game's: `hash(seed, Domain.Cosmetic, 0)`, GDD 20.4 point 3). `water` is
`{ fetch, cascades }` for the wave field; `waters(cx, cz)` lists a chunk's water bodies as `{ x, z, r, top, depth, kind }`
(`top` above the ground; `kind` 1 a bowl, 2 a flat basin, 3 the ground itself, a puddle).

- `sources/sting.js`: the game's world (the sim's `groundAt`, land use, `pavingOf`, the chunk's trees with no trunks, and
  its birdbaths, fountains and the sim's puddles while the ground is wet).
- `sources/wild.js`: a standalone wild world with an ocean coast, lakes at their own levels, and mountains to 780 m, for
  the template page `../world.html`.
- `sources/composite.js`: the game's world set down in the wild one: inside `radius` the sim's, blended over a band
  into the wild generator at a site chosen for it (flat, dry, above the sea). A start can be urban, semi-urban or wild
  by that radius. Gameplay beyond the settled area would need the wild height in the sim with a C# twin (the game
  thread's call); until then the wild land is scenery.

**Lifting other objects.** `clipLiftGLSL({ levels })` (clipmap.js) is GLSL with `clipHeight` and a `ringHeightAt` answered
by it, so materials that call `ringHeightAt` stand on this ground. Put `world.clip.uniforms` into their uniforms. World v2's
own objects carry `userData.ring` and `userData.world2`, so the game's patching leaves them alone.

**Tiers** (`QUALITY` in index.js): low, medium, high, ultra: clipmap levels, render scale, shadow size, grass and tree
distances, depth of field, god rays, MSAA, volumetric clouds (off on low), the wave grid (64, 128, 128, 256) and the
sea's caustics (off, 256/192, 512/384, 1024/640: texture and grid).

**GPU timings** (`gputimer.js`): `world.timer.ms` holds the last second's average milliseconds per pass (scene, clouds,
composite, rays, dof, bloom, final, waves) where the browser gives `EXT_disjoint_timer_query_webgl2` (desktop Chrome
and Edge; Firefox and Safari give nothing, and the stats say so). The template shows them.

## W3: the fjord world, forests to a million, clouds, weather, seasons, the map

**Terrain** (`sources/wild.js`). The continental noise now lowers the land toward its low side into an ocean with bays
and headlands, and the ridges (to 780 m) stand on its high side, so the coast is a fjord coast. Lakes: at most one per
2.2 km cell (three in four cells try), a bowl carved into the broad shape with a shore that wanders, its level a few
metres under the lowest of the broad shape at the centre and four rim points, the land round it held above the level
for a third of the radius out. The water level field (channel 5) is the lake's inside and to 0.4 of the rim, the sea
elsewhere; it jumps only where the ground is held above both, so the jump never shows water. Lakes in the sea's reach
or up the mountains are not made. Forests run to the snow line (560 m).

**Forests** (`treecards.js`, `trees.js`, `scatter.js`). Trees are cards: a trunk and branches of low-poly cylinders and
a crown of leaf clusters, three crossed quads each, cut out of a pixel-art leaf atlas drawn from the hash (blocks of
2 x 2 pixels; the Minecraft idea: texture over geometry). Three levels of detail (oak: 624, 164, 24 triangles). Up close
it is cards of chunky leaves; from a few metres a tree. Lighting: the crown's sphere normal on every leaf, so the
crown shades as one mass; occlusion from height and depth into the crown (a smoothstep, cheap); the sun through the
leaves toward the eye. Alpha to coverage on the MSAA target softens the cut-outs.
- **Near** (to 420 m): the meshes, placed per 64 m tile on the CPU (`scatter.js`, deterministic), or the sim's trees
  one for one in the settled area (the trunk hidden per instance where the game draws it as the sim's cylinder).
- **Far** (420 m to 6 km): the same trees as impostors, one quad each, baked at start-up from the level-0 meshes from
  eight sides (albedo and normals, 128 px, two atlases), placed entirely on the GPU: the vertex shader runs
  `scatter.js`'s rule again in GLSL on the clipmap (the same grid, hashes and rules), so the impostors stand where the
  meshes stood, cross-faded by dither. The quad is billboarded about the trunk's foot and tilts toward a high camera.
  Culled against the view in the vertex shader. Beyond 1.2 km one card stands for the four trees of its cell. On the
  high tier that is about 1.16 million cells a frame submitted, most dropped in the vertex shader before a pixel.
- **Beyond** 6 km the canopy is painted into the ground.
- The sun's light on every tree, near or far, takes the clouds' shadow.

**Clouds** (`clouds.js`). A slab from 1000 to 1650 m, marched per pixel at quarter resolution (28 steps, jittered):
coverage patches 3 km across with the weather's cover, eroded by 3D noise read at points snapped to 24 m cells, so the
clouds come out as soft blocks. Lighting: Beer-Lambert toward the sun over two samples, a two-lobe Henyey-Greenstein
phase, a powder term, the sky's light from above. Composited behind anything nearer than the slab. A second pass draws
the clouds' shadow (the sun's transmittance through the column) into a 512 x 512 map over 14 km round the camera,
which the ground, grass, trees, far forest read. The sun's light on everything is also scaled by the cover (the
average under a cloudy sky).

**Weather** (`seasons.js`). Each day's weather is a hash of the day with the season's odds: clear, fair, overcast,
rain, storm or fog. The state at any hour blends the day's into the next day's over the night; a storm builds in the
afternoon and breaks in the evening, with lightning (a hash of the half second: the sky and the light flash); fog
lies in the morning. Rain and snow (`rain.js`) are one quad instanced 6000 times in a box round the camera, moved in
the vertex shader: streaks along the fall plus the wind, or drifting flakes when the day is cold. Rain wets the ground
and rings the water (W2).

**Seasons** (`seasons.js`). The day of the year sets: the sun's track (the real one at latitude 50 for the season's
declination: long days in summer, short in winter), the leaves (fresh and yellow-green in spring, deep in summer,
yellow, orange or red by the tree's variety in autumn, falling leaf by leaf, bare in winter; pines keep theirs), the
flowers (in bloom from late spring to late summer), the grass (yellowing in autumn), the snow line (860 m in summer,
down to the sea in deep winter: the ground, the upper leaves and the far cards whiten), and the lakes and the sea
(frozen over in deep winter: a pale rough sheet).

**The map** (`map.js`). Zooming out from the wasp, the view turns into a map: between 350 m and 2.6 km the camera
tips toward straight down, the lens narrows (backing off to keep the framing) and the view turns north-up, while a
pass after the tone mapping redraws the frame from the clipmap: pixels snapped to a 4 px grid, a hypsometric palette
by height, hillshade from the ground's normal under a north-west light, water flat blue by depth with a dark shore
line, forests dotted, trails dashed, contours every 20 m, snow white. The blend is continuous with the zoom. Pins are
HTML over the canvas, projected each frame and clustered when they crowd; a click opens a card with what the place
offers and how far it is. Places are scanned from the source on the CPU, a few 220 m cells a frame, out to 6 km:
lakes (once, at their centre) and the shore; meadows in bloom and damp fruit woods (food); dense old woods (hollow
trees), crags (crevices) and dry banks (burrows) as nest sites. In the game the sim's own place list (GDD 19.6 T3-2) is
the authority; this scan is the template's stand-in.

**Checks** (run from `poc/`; browser pages headless, software WebGL):

| Check | Result |
|---|---|
| `node world/test/world.test.mjs` (W3 part) | 25 lakes in a 35 km square at their own levels; every point in the inner half of a basin is under its level; the water level field jumps 1,059 times along radial lines and the ground is above both levels at every jump; 40% of a 20 km square is under water. Every card tree kind and variety meshes at three levels with unit normals (oak 624 / 164 / 24 triangles). The atlas is 10.5% leaf pixels. The seasons turn in order; deep winter snow 1.0, ice 0.99, leaves gone 1.0; midsummer bloom 1.0. Six weather kinds over three years, the same for the same day. The composite's inside is the sim's ground plus one lift, its outside the wild ground exactly, and the band changes by less than 3 m a step. A 3 km scan round the wild origin finds water, food and nest sites. |
| `world/test/gpu-parity.html` | The GLSL twin against the JS at 4,096 points per seed, three seeds: height within 1.3 cm (a lake's trigonometry at kilometre coordinates in float32; none over 2 cm), the water level within 1.3e-4 m. |
| `world/test/forest-parity.html` | The GPU placement rule against `scatter.js` over 16 tiles (2,704 cells): 99.85% agree on whether a tree stands (2 cells each way at thresholds, from the clipmap's interpolation), every kind agrees, scales within 1.5e-7. |
| `index.html?world2` | Boots with the card trees and the game's own trunks. |

**Not verified.** Frame times on a real GPU: the template now shows them per pass where the browser gives timer
queries, so the first real numbers come from your machine. Phones. The impostors in motion (the eight views switch
by dither-free snapping; a real GPU will show whether the step reads).

**Known limits (W3).**
- A lake seen from kilometres away is drawn from a coarse clipmap level, where its level field jumps between 512 m
  texels: its edge goes blocky, and on a plateau above low land a sliver of its water can show beyond the rim.
- Clouds do not shadow the game's own objects (people, houses), only what World v3 draws.
- The ice is a sheet over the water's shading, not a surface of its own; nothing walks on it.
- Snow lies by height, not by cover: a snowy day whitens nothing until the season does.
- The map's pins come from a stand-in scan; the sim's place list (T3-2) replaces it in the game.
- The composite's wild land is scenery to the sim: no collision, no places, no weather feedback.
- Tree shadows from the far ring: none (impostors cast none); the ground under a far forest is darkened by its
  forest-floor colour instead.

**The game's weather.** The game sets `auto: false` and the fields itself: `cloud` 0..1 (the sim's weather kind),
`rain`, `snow`, `storm`, `flash`, with `haze`, `mist`, `wet`, `wind` and `wind10` as before, and `day` for the season
if it wants the seasons (the sim has its own season, GDD 6.4: map it to `day`).


## W3.1: the shore, as a table

The water met the sand as a cut: the shore profile pushed the ground away from the water line on both sides (a 1:4
slope at the line, then a 2.4 m shelf drop within two metres of depth), and the water drew its full open-sea waves up
to the line with nothing between. Now:

**The beach profile** (`sources/wild.js`). The height above the water line is scaled by a factor that is `beach`
(0.3) at the line and 1 again 2.5 m above or below it, so the sand crosses the line at a third of the land's slope and
runs on under the water as a shallow shelf where the floor shows through; the drop (`shelf`) begins at 1.5 m of
depth. The scaling keeps the sign, so the water line is exactly where it was and no puddles appear. A lake's bowl is
`(1 - q^2)^2` of its depth, shallow over its outer third. At the template's start: 0.23 m deep 2 m out, 0.42 m at 4 m,
0.98 m at 10 m (a node check).

**The shore table** (`shorefield.js`). The water line is world data (the ground does not move), so everything the
water and the beach need to know about it is baked once per world chunk and kept, like a chunk of the map: three
levels of fixed chunks (128 m at 0.5 m texels, 1 km at 4 m, 4 km at 16 m), each chunk 256 texels a side, holding the
signed distance to the water line, the direction to its nearest point scaled by the front's coherence, and a shallow
water front's travel time from the line (the straight line to the nearest shore point at `sqrt(g depth)`, depth
clamped to 0.3..14 m, 16 steps; positive on the water, negative up the beach at the swash's speed). Baked on the GPU
from the source's own GLSL twin (exact at any point, no view in it; the clipmap for a source without one) by jump
flooding over the chunk plus a margin (32 m, 256 m, 1 km by level), so a point by a chunk's edge finds the same
nearest shore point its neighbour across the edge finds: one continuous field, no seams. A level answers where the
line is within its margin; past that the next level does, blended over the last quarter of the margin. A chunk is
baked when it first comes near (the 3 x 3 round the eye at each level, two a frame; all at a build) and stays in its
slot until the slots run out (32, 12, 6 by level: 37 MB of float texels) and the one used longest ago is let go;
nothing per frame computes a shoreline. The coherence comes from the travel time's gradient over a wide stencil: a
clean front has `|grad tau| = 1 / c`; along the spine of a body, where fronts from two shores meet, the ridge in tau
flattens the wide difference and the trains fade out there instead of folding into each other, so the middle of a
body is the wind sea and the swell alone. Floats, not halves: the travel time is a phase, and a half's step across a
5 s wave is a visible terrace. The precision is the row count: the reader addresses a texel; finer texels cost memory
and bake time, nothing per pixel. The array texture carries two more layers read through the same sampler: the
glints' Poisson table and a copy of the clouds' shadow map each frame, so the sea darkens under a cloud as the ground
does.

**The shore by calculation** (`?shore=live`, `shoreLive`). For the comparison the same four readers exist as live
calculation: every water pixel searches the clipmap for the line itself (16 directions, 6 radii, 192 reads), takes the
distance over the depth under it for the travel time, sums the Poisson series, reads the clouds' own map. Same
function names, same answers in the limit, so the water and the beach run unchanged either way; the stats line says
which is on.

**The water never lies flat** (`waves.js`). The wind sea is raised by at least a 1.5 m/s wind (a residual chop) and
the swell by at least 4.5 m/s over the 40 km fetch (weather elsewhere, 0.2 m at 4 s); the wind adds to these.

**The shore waves** (`SHORE_WAVE_GLSL`, read by `water.js` and `terrain.js`). Two trains (the peak period and 0.62
of it) of narrow-crested shallow-water waves ride the table: phase `w (t + tau)`, wavenumber `w / sqrt(g depth)`, so
crests slow and bunch toward the line; Green's law raises them as the water shoals, a wave higher than 0.78 of the
depth breaks (McCowan 1894) and runs on as a bore; whitewater on a broken crest's face, trailing off behind it, lace in
the surf zone; sets by a slow noise, a phase that wanders along the coast so crests are not rings. The sea gets the
swell of a 40 km fetch (JONSWAP fetch relations, under the fully developed limits, `waves.js swellState`: 1.23 m and
4.9 s at 12 m/s), a lake only what its own wind raised over 600 m (0.15 m); the water's level tells which. The open
water's cascades fade as the floor comes up (the long waves first; the chop reaches the beach). Foam is one pattern of
three scales, covered to a share set by the foam's strength, so a crest is nearly solid and the lace sparse; the thin
water at the very edge foams in patches, more where the waves work.

**The swash** (`terrain.js`). The beach reads the same table and phase: the front that broke out there arrives at the
line and climbs the sand at the table's travel time (1.7 m/s up the beach), sits for half a period and drains from the
top down, its leading edge a line of bubbles; the sand is wet to the run-up limit (Stockdon et al. 2006, as before)
and damp a little above. Without a table (a source without water) the swash reads the waves as in W2.

**The glints' Poisson draw** (`water.js`). The count of mirror facets a cell draws came from summing the Poisson
series per cell per pixel (up to forty terms, twice); it is now a 512 x 512 table of the inverse distribution (rows by
the mean on a square-root scale to 12, columns by the uniform draw), computed once; a pixel reads one texel. Means past
12 keep the normal approximation. The table rides in a layer of the shore table's array texture: the composite is at
the fragment sampler limit of Chrome on Windows (16, ANGLE over D3D11; the eight wave textures take half), and a 17th
sampler failed the pass there with a black frame. `Post.samplerCheck` counts the active samplers of each pass from the
linked program after the first frames and the template shows `samplers 16/16` in its stats line; anything new the
composite reads must share a texture it already has.

**Tables against live calculation** (`world/test/tables-bench.html`). The same two things done both ways over a
1024² pass, timed with GPU timer queries and checked against an exact reference: the glint count by series against
the table, and the shore distance by a 48-tap live search on the clipmap against one table read. Run it on the card
in question; on a software renderer the times are CPU times and the ratios do not carry.

**Checks.** `node world/test/world.test.mjs`: the beach profile, the swell state, the Poisson table (35 checks pass).
`world/test/shore-parity.html`: the fine chunk under the start against a brute-force nearest crossing on the CPU from
the source at the texels' points, over the chunk and its margin: 1,882 texels the level knows (within 32 m of the line) of a 128 x 128 sample, 557 crossings: the distance within 0.3 mm
at the median, 2.7 mm at the 90th percentile, 5.7 cm at worst (the bake is from the same world function); the signs of
distance and travel time agree everywhere; the direction (from the travel time's gradient over a 3 m stencil) within
25 degrees of the exact at 97.6% of texels two or more texels from the line; the travel time within 0.02% of a 64-step
integral at the median, 0.09% at the 90th percentile, 10.7% at worst. `world/test/gpu-parity.html` with the new profile: height
within 1.3 cm (seed 7), 0.1 cm (99), 2.9 cm (1234: one point of 4,096 over 2 cm, the lake trigonometry in float32).
Renders: the beach from the sand, from above, the surf
zone and a storm. Not verified: the timings of the bake on a real GPU (`shore` in the per-pass stats; it runs only
when a window moves), the swash in motion.

**Known limits (W3.1).**
- The travel time is along the straight line to the nearest shore point: fronts do not refract round headlands or
  bars as a solved eikonal would (Ultra-Water sweeps one); on a straight beach it is the same.
- A source filled on the CPU (the composite) has only the sea's water line in its table: its lakes' levels are not
  in the clipmap's water channel there.
- The shore waves lift the water's surface but do not move it sideways (no Gerstner lean): a plunging lip is not
  drawn, the bore is.
- The coarse levels (4 m and 16 m texels) place the line to a few metres: foam lines on a far coast sit within that.
- A source without a GLSL twin (the composite) bakes from the clipmap, so its chunks are as good as the clipmap was
  where and when they were baked; the wild source bakes exactly.
- The chunk cache is bounded (32 fine chunks: a 0.5 km² neighbourhood); a chunk let go is baked again on return,
  identically.
- The caustics are splatted from the open water's cascades, undamped in the shallows.
- The clouds' shadow reaches the sea through a copy of the shadow map (27 m texels): a cloud's edge on the water is
  as soft as on the ground, no softer.

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

**The shore** (`terrain.js`).
- **The swash** runs up and down the beach as a thin film with foam at its edge, driven by the incident waves where
  each cross-shore line meets the water.
- **The run-up limit** is R2 (Stockdon et al. 2006), from the sea state (H0, L0) and the beach's own slope. A 600 m
  lake under 6.8 m/s runs up about 3 cm, so the wet band is a few tens of centimetres of sand, not metres.
- **Damp sand.** A further 4 cm of damp sand from capillary rise (our estimate).

**Grass when the camera moves** (`grass.js`). The rings scale in whole steps (x1, x2, x4, x8) with the height over the
ground, and dissolve clump by clump into the next step over the last 30% of each step. A clump never slides: before
this, a continuous scale moved every clump whenever the camera's height over the ground changed.

**Grass in the wind** (`grass.js`).
- **The wind it feels.** Blades take the wind at 10 m (`env.wind10`). The wind at their tops comes from the log law,
  with roughness a tenth of the grass's height, and never drops below 0.25 m/s: the breath of air the game's minimum
  breeze stands for.
- **The motion.**
  - The bend goes with that wind squared (our calibration).
  - Gust patches 3 m apart travel downwind at 1.8 times the wind at the tops (canopy waves, "honami").
  - Each blade flutters on its own.
- **Flowers.** A flower's colour is only its head.

**Known limits.**
- The swash has no lag between uprush and backwash; its edge follows the incident waves directly.
- At grazing angles the screen-space reflection steps in bands at low resolution.
- Floor caustics are also drawn in the shade of a tree (the composite cannot tell shade from a dark floor).
- The camera under water is not handled.
- The birdbath bowl is our shape (4 cm deep; the game draws a solid basin).
