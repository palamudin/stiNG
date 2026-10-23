# STING — three.js proof of concept

The tier-0 slice of the GDD, built in the browser so it can move to Unity. Same split as the GDD: a simulation core that owns every outcome, and a presentation layer that only draws.

| Path | Role | Unity counterpart |
|---|---|---|
| `sim/rng.js` | Counter-based RNG, own sin/cos/atan2 and rounding, hashes | `core/Sting.Core/Rng.cs` (ported) |
| `sim/tuning.js` | Every tuning number, with biology notes | `core/Sting.Core/Tuning.cs` (ported); data files later (GDD 13) |
| `sim/body.js` | Traits, clothing, body capsules, 17 zones, reach, `resolveSting`, garment graphs | `core/Sting.Core/Body.cs` (ported) |
| `sim/world.js` | Chunk generation, clock, weather, schedules, pure motion of flies and bees | `core/Sting.Core/World.cs` (ported) |
| `sim/colony.js` | Colony economy and the yearly cycle | `core/Sting.Core/Colony.cs` (ported) |
| `sim/sim.js` | The sim: wasps, humans, swats, bees, escalation, exterminator, networking | `core/Sting.Core/Sim*.cs` (ported) |
| `sim/net.js` | Simulated link, the two-peer lab and an N-peer mesh lab | `core/Sting.Core/Net.cs` (ported); real transport later |
| `sim/persist.js` | Exact snapshot and restore, replay from a snapshot, joining a world in progress | `core/Sting.Core/Persist.cs` (ported, binary) |
| `sim/bots.js` | Scripted pilots that produce ordinary input commands | `core/Sting.Core/Bots.cs` (ported) |
| `game.js` | three.js rendering, animation, camera, input, HUD, sound | Unity scene, Animator, UI |
| `index.html` | Page shell, HUD markup and styles | UI Toolkit |
| `test/sim.test.mjs` | 106 headless sim checks | `Sting.Core.Tests` |
| `test/net.test.mjs` | 31 network checks | `Sting.Net.Tests` |

| `test/parity.mjs` | Writes `core/fixtures/parity.txt`: 22 digests the C# core must reproduce bit for bit | `core/Sting.Core.Tests` |

Run the tests from this folder with `node test/sim.test.mjs` and `node test/net.test.mjs` (Node 18+, no packages). Play locally with `node serve.mjs`. Any change to `sim/` that changes behaviour must be made in `core/` too: rerun `node test/parity.mjs`, then `dotnet run -c Release` in `core/Sting.Core.Tests`.

## Feature list

| # | Feature | GDD | Iteration |
|---|---|---|---|
| 1 | Fixed 60 Hz tick; humans at 20 Hz; colony at 1 Hz; deterministic order | 3.2, 3.3 | 1 |
| 2 | Counter-based RNG bit-identical to the C# protocode; own polynomial sin/cos | 3.4, 3.5 | 1 |
| 3 | Chunks generated from seed on demand, frozen on discovery | 4.3, 4.4 | 1 |
| 4 | Park world: trees, picnic tables, groups, flowers, cans, nest, beehives | 4.3 | 1–2 |
| 5 | Humans: traits from ID, clothing per day, sit and stand, body = capsules | 8.1, 8.3 | 1 |
| 6 | 17 zones from contact point and normal, reach formula, response policies | 8.3–8.5 | 1 |
| 7 | `resolveSting`: own swat, helpers from companions, panic, flight | 8.6 | 1 |
| 8 | Swat volumes in the stung body's frame, active window, kill or stun | 8.7 | 1 |
| 9 | Hold to sting; release to pull out; full sting after 0.5 s | 7.4 | 1 |
| 10 | Every wasp, driven or AI, runs the same flight, contact, sting and swat code | 7, 7.7 | 2 |
| 11 | Possession: Q takes over the nearest worker within 30 m | 7.7 | 2 |
| 12 | Colony economy: protein, sugar, pulp, cells, brood pipeline, sugar deficit, foraging presets | 6.2–6.5, A.4 | 2 |
| 13 | AI workers: forage sugar, catch prey, chew pulp, deposit, go home at dusk | 6.5 | 2 |
| 14 | Prey: flies on deterministic paths, caterpillars on flowers, bees as protein | 9.4 | 2 |
| 15 | Escalation ladder per chunk: swatting, covered food and citronella, sprays and sugar traps, exterminator | 8.10 | 2 |
| 16 | Alarm pheromone: a worker killed by a human sends nearby workers after that human | 7.6 | 2 |
| 17 | Under clothing: openings, garment graph, crawl between nodes, compression, shirt torn off | 8.8 | 2 |
| 18 | Exterminator: booked at level 4, finds the nest (by flight lines since 73), treats it; stopped only by stings under his collar | 8.10 | 2 |
| 19 | Beehives: guards and foragers on pure paths, alarm and pursuit, heat ball, mash to escape | 9.1, 9.2 | 2 |
| 20 | Day and night, temperature, rain days, human arrival and departure schedules, rest until morning | 5, 8.2 | 2 |
| 21 | Yearly cycle: queen cells, young queens mate and leave, autumn collapse, winter survival, sister nests | 2.2, 5.2, 6.7 | 3 |
| 22 | Spring founding: you drive the queen, build cells from pulp, feed the first brood alone | 6.1, 6.7 | 3 |
| 23 | World modifiers on the start screen: day length, season length, people, bees | 4.8 | 2–3 |
| 24 | Procedural sound: wings, other wasps, bees, slaps, yelps, birds, crickets, rain, spray | — | 3 |
| 25 | Networking: committed world events, owner authority, remote dead reckoning, simulated link | 11 | 4 |
| 26 | Network lab: a bot second player over a chosen link; live agreement check on every human | 11.5 | 4 |
| 27 | Lab overlay: state hash, replay check, predicted swats, body zone map, traits, event log | 14 | 1–4 |
| 28 | Spider webs by trees: stuck wasps are eaten unless they mash free | 9.3 | 5 |
| 29 | Birds on patrol dive at wasps in open air; low flight and tree cover save you | 9.3 | 5 |
| 30 | Landing: a still wasp rests on ground or wood at no sugar cost; people swat wasps resting by their food | 7.2 | 5 |
| 31 | Rival colonies: their workers forage, guard and hunt raiders; touching wasps grapple and one dies; raid their nest for larvae | 9.3 | 5 |
| 32 | Interest windows commit like events; humans are simulated over the union of all peers' windows | 11, Q-16 | 5 |
| 33 | Founding queens pick their nest tree (E at a trunk); old nests stay as abandoned paper | 6.6 | 6 |
| 34 | Gamepad: sticks fly and look, triggers sting and burst, face buttons act, switch, rest | 10.4 | 6 |
| 35 | Graphics quality (shadows, resolution) and a hardcore HUD | 10.2 | 6 |
| 36 | Binary state packets: chunk-relative 16-bit positions, 19 bytes per wasp; bandwidth shown in the lab | 11.12 | 6 |
| 37 | Perch on people and crawl over their body (camera-relative, look up or down to climb); a tickle meter fills by zone and clothing, then they or a friend swat where they feel you | 7.2, 8.3 | 7 |
| 38 | Jumpy humans: each sting a person has had makes their swats faster and their panic sharper | 8.10 | 7 |
| 39 | Save and continue a personal world: exact snapshot (34 KB), chunks regenerated from the seed and checked against their content hash, autosave each dawn and on pause | 4.3, 12.4 | 8 |
| 40 | Late join: a second peer builds its world from a snapshot of the first and agrees on every human from its first tick | 11.10 | 8 |
| 41 | Walk on surfaces: camera-relative on tables, benches and the ground; trunks block, edges drop you into flight, walking into a person climbs onto them; six legs with a tripod gait | 7.2 | 9 |
| 42 | Sugar and protein stores capped at a few days of need (adults' sugar, larvae's protein), so stores drain in autumn and protein runs short when queen larvae arrive | 6.3 | 9 |
| 43 | Death screen says why: lingered after a sting, felt crawling, hovered at a face, caught in a swat meant for another wasp, bird, web, ball, trap, spray | 8.2 | 9 |
| 44 | Rival fights across peers: the rival's owner starts the fight (or the other peer asks, when its wasp touches a rival on its own screen); each peer decides only its own wasp from the same published scores | 9.3, 11.6 | 10 |
| 45 | Late join in the lab: "Bot joins after 1 min" builds player 2 from a snapshot mid-game | 11.10 | 10 |
| 46 | The stare: hovering in front of a face pulls in letterbox bars, narrows the lens to a close-up and drops the soundscape to a low drone (presentation only) | 12 | 10 |
| 47 | Rival guards across peers: they hunt any player's wasp near their nest, and a raid by another player sends them after the thief | 9.3 | 10 |
| 48 | Esc menu: volume, mouse sensitivity, invert look up/down (mouse and gamepad), return, save, quit to title; settings kept per browser | 10.1 | 11 |
| 49 | Camera carried by the wasp (no lag or pull from flight). Hold the right mouse button to look out of the wasp's own eyes, freely all the way round, while it keeps its heading; let go and the view blends back to the chase camera behind the direction of travel | 10.1 | 11 |
| 50 | Escalation level 5, municipal pest control: a chunk at 40 points baits the 3×3 area for 3 days. Stations on the trees hold poisoned meat; carried home it kills larvae and workers, and abstract foragers bring poison in proportion to how hard the colony hunts protein. Afterwards the area's escalation halves | 8.10 | 12 |
| 51 | Panic feeds the wasps: a sitter who jumps up may knock their drink over; the can lies empty and the puddle is a rich sugar source for four hours. Lidded drinks (level 2+) never spill. Part of the shared human state, so peers agree | 8.9 | 12 |
| 52 | Plausibility checks on received traffic: commit ticks, order, future ticks, swat count and timing, panic range, sting reach from the human, sting rate. Three strikes quarantine the peer. A peer that delays the slaps aimed at its wasps is cut off within a minute; honest traffic on every link is never rejected | 11.8 | 12 |
| 53 | World modifiers: humans react fast/normal/slow, neighborhoods easygoing/normal/touchy, and exterminators, pest control, birds and rival colonies switchable. A short tag names the world ("slow humans · bees ×1.5 · no exterminators") and a rules hash lets peers confirm they play the same world; both survive saves | 4.8 | 12 |
| 54 | Nest sites: a founding queen picks a trunk (up to 3,500 cells), an old burrow in the grass (5,000 cells, floods in rain, people notice it 1.6× faster) or a branch in the canopy (1,800 cells, twice as cold in rain, half as noticeable). Burrows are always visible; branch points show while choosing | 6.6 | 12 |
| 55 | Windfall fruit: about a third of trees are fruit trees; from 55% of the season their fruit drops into the grass on hashed days and lies for six days, feeding wasps and drawing sugar foragers away from the picnic | 9.4 | 12 |
| 56 | Scent cues: three small markers around the crosshair point toward the nearest sugar (yellow), prey (orange) and alarm (red: crushed nestmates, alarmed hives), brighter when closer; hidden in hardcore and in the eye view | 10.2 | 12 |
| 57 | Switching limits (Q-03): any worker within 30 m is instant; otherwise the colony relays you in 4 s to the nearest worker anywhere, or to a worker coming out of the nest. Q again cancels | 7.7 | 12 |
| 58 | Old age: the worker you drive lives as long as her sisters (about 22 bio-days, scaled to the season, ±20%), shown as an age bar; the queen does not age out | 7.5 | 12 |
| 59 | Dragonflies patrol low over open ground and dart at wasps flying under 2.5 m; faster than a burst but worse at turning, so break hard, land or get under a tree. Birds and dragonflies share one hunter code path | 9.3 | 13 |
| 60 | Garden sheds (about a third of chunks): solid wood to chew and land on, and two nest sites, a crack in a wall (4,000 cells) and a gap under the eaves (6,000 cells, best shelter). World generator 3; older saves are refused with a message | 6.6 | 13 |
| 61 | Colony view workers list: the nest panel lists the workers that are out, nearest first, with role, what she is doing, what she carries and how far; Drive switches to her (instant within 30 m, relayed beyond). The pick travels as a recorded command, so replays stay exact | 10.3 | 13 |
| 62 | Host rulings: every peer drops implausible events, but only the host quarantines, as a committed event; all honest peers cut the cheater off on the same tick, purge its uncommitted events and drop its interest window. Proven with a three-peer mesh lab (host, honest, cheater) on a bad link | 11.8, 11.11 | 13 |
| 63 | Wind (T1-1): one direction and strength per day from the weather hash (0–3 m/s, stronger on rainy days), calm at dawn and strongest mid-afternoon, gusting. A flying wasp drifts with about a third of it, falling off toward the ground, so low flight is sheltered; tree crowns sway with it; the weather line shows it | 5.3, 7.2 | 14 |
| 64 | Cold (T1-2): every wasp has a body temperature. Flight muscles keep a flying wasp 12 °C above the air, a resting one shivers (burning sugar) to stay ready, human skin holds it at 31 °C. Take-off needs 18 °C; below 8 °C it goes torpid and dies after 90 s unless it finds warmth. Springs start 6 °C colder and autumns cool by 7 °C, so founding queens and late workers feel it. Body bar on the HUD | 7.1, 7.5, 10.2, 5.3 | 14 |
| 65 | Drowning in a drink (T1-3): a wasp feeding at an open can may slip in (about 3% per second of feeding) and has 4 s to climb out by mashing burst; AI wasps sometimes make it. Lidded drinks at alert level 2 are safe and closed anyway | 7.5 | 14 |
| 66 | Clothing by temperature (T1-4): the day's clothes follow the day's weather. Cool days put a third of people in jackets and most in jeans; hot days bring tank tops and shorts, and more bare skin to sting | 8.8 | 14 |
| 67 | Shake and flail (T1-5): flailers and runners stung on the scalp or face shake their head, which dislodges and stuns but never kills; a runner who flees also flails on the way out, a wide late sweep that stuns | 8.5 | 14 |
| 68 | Panic by line of sight (T1-17): contagion only between people who can see each other; sheds and tree trunks block it | 8.9 | 14 |
| 69 | Memory by recency and place (T1-18): people remember their last stings with time and spot; they react faster and panic more where it happened, less elsewhere, and calm down over two days | 8.10 | 14 |
| 70 | Hollow trees and nest thermals (T1-14): a third of thick trunks have a hollow a queen can nest in (4,500 cells, well hidden). Each site lets in more or less of the weather: cold snaps slow the brood most in an open branch nest, least in a hollow or a burrow, and an attic bakes on sunny afternoons. Brood speed in the colony view | 6.6 | 14 |
| 71 | Solo time (T1-23): the colony view runs time at 1×, 4× or 16× (T cycles), dropping to 1× when anything comes for your wasp; Reflex slows the clock to a quarter for a moment when a hand is coming (pause menu option). Presentation only: replays and saves are unaffected | 5.1, 7.8 | 14 |
| 72 | Fetching spray (T1-6): at level 3 nobody has a can on them. A stung person with it in them goes indoors for one and comes back with six sprays, a green can in hand | 8.6, 8.10 | 14 |
| 73 | The exterminator searches (T1-7): he parks where people were stung and walks the flight lines he sees toward the nest; traffic, the site and distance set how fast. He gives up at dusk and resumes from his last line. A new foraging preset, Lie low, sends out a third of the foragers to buy time | 8.10 | 14 |
| 74 | Worker ages and guards (T1-13): new workers stay in a few days before they forage; once the colony has 25 mature workers, two guards circle the entrance, chase off rival wasps and other players' wasps (fights across the link), and sting the exterminator at the nest. The colony view shows the young and the guards | 6.5 | 14 |

## Verified

- **Sim:** traits and hash match the compiled C# protocode; trig error 6.6e-10; no swat or press lands inside the consequence window; fed colonies grow and starved larvae die; the yearly cycle raises and mates young queens and collapses in autumn; winter and spring hand the line to a founding queen; two runs and a replay give the same hash; lingering kills, jab-and-run survives; AI workers launch and deposit; covered food, traps, preemptive slaps, compression under a shirt, crawling to the acnestis, bee balls and escape, the exterminator destroying an unguarded nest and aborting when stung under his collar, the day cycle, possession, frozen chunks, and a restored snapshot that stays bit-identical to the original for 6000 more ticks and replays the input recorded after it.
- **Network:** two peers sting the same humans over four links, from LAN up to 16±6 ticks one-way with 10% loss. Human state is identical on both peers at every check (300/300 per link) and no event arrives after its commit tick. With the peers two chunks apart, all 63 shared humans still agree at every check. A peer that joins 50 s in from a snapshot agrees on every check after joining (200/200). A remote player's wasp fought A's rivals 62 times over good and bad links, and both peers agreed on every winner. State packets round-trip within 0.4 mm; a colony with 22 wasps out sends about 4.8 KB/s upstream.
- **Rendering:** headless Chromium screenshots of every system. The software renderer runs at under 1 fps, so frame rate on real GPUs is not measured.

## Design changes found by building (fold into the GDD)

1. **Hold to sting.** The press arms the stinger, first contact stings, release pulls out. Swat timing still starts at contact.
2. **Two-part events.** A sting's swats run as soon as a peer has the event; its effect on the human (panic, flight, counters, alert points) commits 30 ticks (500 ms) after contact on every peer. This replaces "fast-forward the plan when late" (GDD 11.5) and holds up to roughly 370 ms one-way.
3. **Owner decides about its own wasps.** Preemptive swats, sprays, presses under clothing and bee alarms are decided by the peer that owns the wasp and published as events. Swat volumes are checked only against the checker's own wasps.
4. **No live wasp positions in shared decisions.** Fleeing humans run from the stinger's position recorded in the event, not from wherever a wasp is now.
5. **Biological time scales with season length.** `bio = seasonDays / 200`. A 40-day season runs brood development and worker lifespans five times faster than nature, so a season fits in about an hour of play.
6. **Founding queens build their own cells** directly from pulp they deliver.
7. **Doubles in the PoC, fixed point in the core.** The JS sim is deterministic because it uses only IEEE-exact operations and its own trig. The C# core is written against one number type that builds as a double (bit-identical to the JS) or as Q32.32 fixed point (GDD 18.18).
8. **Flight is gated by body temperature, not air temperature.** A warm wasp flies on a cool day; a cold one on a warm morning must warm up first. The colony still sends foragers out only when the air is warm enough.

## Known limits

- The colony economy is tuned against one simulated season with an idle player; it needs real play data.
- Shed roofs are drawn pitched but collide as a flat top.
- Walking is on horizontal surfaces only; tree trunks and walls are obstacles, not surfaces.
- Two players' colonies never fight each other yet. Q-07 is settled (rivals by default, co-op opt-in); guards that attack other players' wasps come with T1-13.

## Controls

Mouse look · hold RMB look from the wasp's eyes · WASD fly · Space / C up and down · Shift burst, mash to break free · hold LMB or F to sting · E catch, chew, crawl under clothes · Q take over nearest worker · R rest at night · N nest panel (T speeds up time there, solo) · Tab lab · M sound · Arrows look · WASD walk when landed · Esc pause (Save world is on the pause screen; Continue appears on the start screen once a save exists).
