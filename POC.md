# STING — three.js proof of concept

The tier-0 slice of the GDD, built in the browser so it can move to Unity. Same split as the GDD: a simulation core that owns every outcome, and a presentation layer that only draws.

| Path | Role | Unity counterpart |
|---|---|---|
| `sim/rng.js` | Counter-based RNG (bit-identical to the C# protocode), own sin/cos, hashes | `Sting.Core/Rng.cs`, `Fix64.cs` |
| `sim/tuning.js` | Every tuning number, with biology notes | data files (GDD 13) |
| `sim/body.js` | Traits, clothing, body capsules, 17 zones, reach, `resolveSting`, garment graphs | `Sting.Core/Humans/*` |
| `sim/world.js` | Chunk generation, clock, weather, schedules, pure motion of flies and bees | `Sting.Core/World/*` |
| `sim/colony.js` | Colony economy and the yearly cycle | `Sting.Core/Colony/*` |
| `sim/sim.js` | The sim: wasps, humans, swats, bees, escalation, exterminator, networking | `Sting.Core/Sim.cs` |
| `sim/net.js` | Simulated link and the two-peer lab | `Sting.Net` + transport |
| `sim/persist.js` | Exact snapshot and restore, replay from a snapshot, joining a world in progress | `Sting.Core/Persistence` |
| `sim/bots.js` | Scripted pilots that produce ordinary input commands | test harness |
| `game.js` | three.js rendering, animation, camera, input, HUD, sound | Unity scene, Animator, UI |
| `index.html` | Page shell, HUD markup and styles | UI Toolkit |
| `test/sim.test.mjs` | 66 headless sim checks | `Sting.Core.Tests` |
| `test/net.test.mjs` | 21 network checks | `Sting.Net.Tests` |

Run the tests with `node test/sim.test.mjs` and `node test/net.test.mjs` (Node 18+, no packages).

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
| 18 | Exterminator: booked at level 4, walks to the nest, treats it; stopped only by stings under his collar | 8.10 | 2 |
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

## Verified

- **Sim:** traits and hash match the compiled C# protocode; trig error 6.6e-10; no swat or press lands inside the consequence window; fed colonies grow and starved larvae die; the yearly cycle raises and mates young queens and collapses in autumn; winter and spring hand the line to a founding queen; two runs and a replay give the same hash; lingering kills, jab-and-run survives; AI workers launch and deposit; covered food, traps, preemptive slaps, compression under a shirt, crawling to the acnestis, bee balls and escape, the exterminator destroying an unguarded nest and aborting when stung under his collar, the day cycle, possession, frozen chunks, and a restored snapshot that stays bit-identical to the original for 6000 more ticks and replays the input recorded after it.
- **Network:** two peers sting the same humans over four links, from LAN up to 16±6 ticks one-way with 10% loss. Human state is identical on both peers at every check (300/300 per link) and no event arrives after its commit tick. With the peers two chunks apart, all 63 shared humans still agree at every check. A peer that joins 50 s in from a snapshot agrees on every check after joining (200/200). State packets round-trip within 0.4 mm; a colony with 22 wasps out sends about 4.8 KB/s upstream.
- **Rendering:** headless Chromium screenshots of every system. The software renderer runs at under 1 fps, so frame rate on real GPUs is not measured.

## Design changes found by building (fold into the GDD)

1. **Hold to sting.** The press arms the stinger, first contact stings, release pulls out. Swat timing still starts at contact.
2. **Two-part events.** A sting's swats run as soon as a peer has the event; its effect on the human (panic, flight, counters, alert points) commits 30 ticks (500 ms) after contact on every peer. This replaces "fast-forward the plan when late" (GDD 11.5) and holds up to roughly 370 ms one-way.
3. **Owner decides about its own wasps.** Preemptive swats, sprays, presses under clothing and bee alarms are decided by the peer that owns the wasp and published as events. Swat volumes are checked only against the checker's own wasps.
4. **No live wasp positions in shared decisions.** Fleeing humans run from the stinger's position recorded in the event, not from wherever a wasp is now.
5. **Biological time scales with season length.** `bio = seasonDays / 200`. A 40-day season runs brood development and worker lifespans five times faster than nature, so a season fits in about an hour of play.
6. **Founding queens build their own cells** directly from pulp they deliver.
7. **Doubles in the PoC, Fix64 in Unity.** The JS sim is deterministic because it uses only IEEE-exact operations and its own trig. The C# core switches to Fix64 with the same structure.

## Known limits

- The colony economy is balanced loosely; sugar stores grow large late in the season.
- Wasps land and rest but cannot walk on surfaces.
- Fights between a remote player's wasp and local rivals are not networked yet; rivals live on the first peer only.

## Controls

Mouse look · WASD fly · Space / C up and down · Shift burst, mash to break free · hold LMB or F to sting · E catch, chew, crawl under clothes · Q take over nearest worker · R rest at night · N nest panel · Tab lab · M sound · Arrows look · Esc pause (Save world is on the pause screen; Continue appears on the start screen once a save exists).
