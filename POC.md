# STING — three.js proof of concept

Tier-0 slice of the GDD (v0.2), built to be moved to Unity. Two layers, same split as the GDD:

| File | Role | Unity counterpart |
|---|---|---|
| `sim.js` | Simulation core. No three.js, no DOM, no wall clock. Owns every outcome. | `Sting.Core` (C#, Fix64) |
| `game.js` | Presentation: rendering, animation, camera, input, HUD, lab overlay. Reads sim state and events only. | Unity scene, Animator/IK, UI |
| `index.html` | Page shell and HUD markup | UI Toolkit / Canvas |
| `test/sim.test.mjs` | Headless tests (`node test/sim.test.mjs`) | `Sting.Core.Tests` |

## Tier-0 features (iteration 1)

| # | Feature | GDD | Status |
|---|---|---|---|
| 1 | Fixed 60 Hz tick, humans at 20 Hz, deterministic iteration order | 3.2, 3.3 | done |
| 2 | Counter-based RNG, bit-identical to the C# protocode | 3.5, A.2 | done, tested against C# |
| 3 | Own polynomial sin/cos so sim math is identical across browsers | 3.4, R-04 | done |
| 4 | Chunks generated on demand from seed, frozen on discovery (records keep the content and a hash) | 4.3, 4.4 | done |
| 5 | Park world: trees, picnic tables with seated people, standing groups, flowers, soda cans, nest | 4.3 | done |
| 6 | Humans: traits from ID (same as C# HumanFactory), clothing per day, two postures | 8.1, 8.8 | done |
| 7 | Body = capsules in body frame; renderer draws exactly the sim capsules | 8.3, 12 | done |
| 8 | 17 zones classified from contact point and surface normal, including the acnestis | 8.3 | done |
| 9 | Reach formula, response policies, `resolveSting` pure function, helper swats | 8.4–8.6, A.5–A.6 | done |
| 10 | Swat check: sphere in the stung human's body frame, active window, kill or stun | 8.7, A.7 | done |
| 11 | Thick clothing blocks stings | 8.8 | done |
| 12 | Panic gain, contagion, flee, walk back, sit down | 8.9 | done |
| 13 | Wasp flight: steered kinematic, accel-limited, burst, climb, gravity when crop is empty, swept-ish collision (3 substeps) | 7.2 | done |
| 14 | Hold to sting, release to pull out; jab vs full | 7.4 | done (see deviations) |
| 15 | Venom and crop; feeding on flowers and soda | 6.2, 7.1 | done |
| 16 | Worker death, respawn at nest, line extinct, restart | 2.3, 6.7 | done (worker counter only) |
| 17 | Counter: unique humans stung / 8,200,000,000 | 8.11 | done |
| 18 | Swat animations: two-bone IK lands the hand on the impact point at the impact tick; contort, brush, flail, freeze, flinch, run cycle | 12 | done, cosmetic only |
| 19 | Lab overlay: state hash, contact zone, reach, predicted swats with timings, nearest human's traits, event log | 14 | done |
| 20 | Body zone map: every vertex colored by what that person does if stung there | 8.3–8.5 | done |
| 21 | Determinism check: replays all recorded input from a fresh sim and compares state hash | 14 | done |
| 22 | Minimap of discovered and active chunks | 10.3 | done |

## Verified

- `node test/sim.test.mjs`: trait and hash parity with the compiled C# protocode, trig accuracy (max error 6.6e-10), consequence-window invariant over 3,000 humans × 17 zones, two runs and a replay give identical hashes, a full-sting-and-linger bot dies and respawns, a jab-and-run bot survives, discovered chunks stay frozen.
- Headless Chromium render: start screen, flight, a sting on a forearm, the slap landing at 467 ms, death screen, lab and zone map. The in-page determinism check matches on unmodified play and correctly reports a mismatch when the test harness teleports the wasp outside the input path.

## Deviations from the GDD (to fold back in)

1. **Sting mode.** GDD 7.4 picks jab or full at contact. The PoC uses hold-to-sting: the `Sting` event fires at contact as a jab, and a `Deepen` event at 30 ticks adds the full-sting pain. Swat timing still starts at contact, so the consequence window is unchanged.
2. **Numbers are doubles, not Fix64.** Determinism holds within JS because the sim only uses IEEE-exact operations and its own trig. The Unity port switches to Fix64 with the same structure.
3. **Panic contagion** is scaled by both sociability and panic susceptibility.
4. **Helpers** must be idle (not fleeing) to swat.
5. **Posture change while attached** knocks the wasp off.
6. **Colony** is a worker counter only. Economy, brood and castes are a later tier.

## Controls

Mouse look · WASD fly · Space / C up and down · Shift burst · hold LMB or F to sting, release to pull out · Tab lab · Arrows look without a mouse · Esc pause.

## Next tier-0 candidates

- Under-clothing entry and trapped-wasp compression (GDD 8.8)
- Escalation levels per neighborhood with covered food and sprays (8.10)
- Alarm pheromone near the nest (7.6)
- Colony economy step and nest view (6.2–6.4, A.4)
- Bees and a hive with balling (9.2)
- Day and weather (5.3)
- Landing and gripping on surfaces (7.2)
