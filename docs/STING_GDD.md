# STING — Game Design Document

| | |
|---|---|
| Working title | STING (from the "Sting 7 billion people" meme) |
| Version | 0.4 — feature tiers and stack compatibility (Section 19) |
| Date | 2026-10-23 |
| Engine | Unity (presentation), engine-agnostic C# core (simulation) |
| Status | Draft for review. Decisions marked **[D]**, proposals marked **[P]**, open questions marked **[Q]** |

### Conventions

- **MUST / SHOULD / MAY** are requirements in the RFC 2119 sense. Every MUST is meant to become a test.
- **D-xx** decisions, **Q-xx** open questions, **R-xx** architecture rules. Section 16 and 17 list them all.
- Numbers tagged *(tune)* are starting values for tuning, not commitments. Numbers tagged *(bio)* come from real biology and are the reference the tuning starts from.
- Protocode is C# 9 targeting the .NET Standard 2.1 API surface (what Unity compiles). Appendix A is compile-checked; it is a specification, not the production code.
- Time is in sim ticks. 1 tick = 1/60 s. "11 ticks" ≈ 183 ms.
- **Feature tiers** (Section 19) are marked on headings: **[T0]** built in the PoC and the C# core, **[T1]** next, buildable on the current stack, **[T2]** later. **[Unity]** needs the engine, **[Infra]** needs servers or a real network. A heading with two marks is partly built.

---

## Table of contents

1. Vision and pillars
2. Player experience and loops
3. Simulation architecture
4. World: generation, discovery, persistence
5. Time, seasons, weather
6. The colony
7. The wasp
8. Humans
9. Bees and ecology
10. Player control and UI
11. Multiplayer
12. Presentation contract (Unity)
13. Data and tuning
14. Testing and verification
15. Technical constraints
16. Decisions log
17. Open questions
18. Findings from the proof of concept
19. Feature tiers and the current stack
- Appendix A — Protocode
- Appendix B — Glossary
- Appendix C — Biology reference

---

## 1. Vision and pillars

**One line.** An open-world, multiplayer colony simulator in which you run a wasp colony through its yearly cycle and drive individual wasps into a world of humans whose reactions are fully determined, and bees who will kill you.

There is no story, no quest, no win state. A counter in the corner reads `stung: 0 / 8,200,000,000`. Nobody congratulates you when it goes up.

### Pillars

- **P1 — Nature as is.** No narrative, no anthropomorphism, no redemption arc, no ending. Behavior comes from biology, tuned for play. The wasp has no face to emote with and no voice.
- **P2 — Determined outcome, animated playout.** The simulation decides what happens and when. The engine decides only how it looks. Same input, same outcome, on every machine.
- **P3 — Consequence through ecology.** There is no morality system. Consequences are bees, humans escalating, seasons, starvation and death.
- **P4 — The colony is the character.** Individual wasps are expendable. The game ends only when the colony line perishes, and then you start again from a single queen.
- **P5 — Built to work.** Every system is specified so it can be run and tested headless, without Unity, before anything is drawn.

### Non-goals

- Story, dialogue, quests, characters with names.
- A win condition or credits.
- Human death. Stings cause pain, panic and escalation, never death or medical events **[P] D-08**. It keeps the tone slapstick and the sim honest about what it models.
- Gore.
- Monetization design (out of scope for this document).

### Target

PC (Steam), Windows first, Linux and Steam Deck desirable. English. Unity front end, own-code simulation core.

---

## 2. Player experience and loops

### 2.1 Loops

| Loop | Time scale | What the player does |
|---|---|---|
| Micro | seconds | Fly, pick a target, approach, sting, get out before the swat lands, return |
| Meso | minutes | A foraging run, a scouting run, defending the entrance, raiding a hive |
| Macro | in-game weeks | Allocate workers to roles, grow the nest, run the brood pipeline, choose the nest site, decide when to raise reproductives |
| Meta | season to season | Get mated queens through winter, continue the line next spring, keep the discovered world |

### 2.2 The shape of a season

| Phase | Player feel | Main threats |
|---|---|---|
| Founding (spring) | Alone as the queen. Slow, tense, every mistake can end the line | Cold, rain, birds, starvation, rival queens |
| Growth (early summer) | First workers arrive. Switch between colony view and driving workers | Spiders, birds, bees when foraging near hives |
| Peak (late summer) | Thousands of workers, brood winding down, sugar crisis, human conflict peaks | Escalating humans, sprays, traps, exterminators, bees |
| Collapse (autumn) | Raise and protect the new queens and get them mated and hidden | Everything, plus the colony is dying anyway |
| Hibernation (winter) | The line survives only in hibernating queens | Winter mortality by site quality |

Even a perfect season ends with the colony dying. "Survival" means passing the line on.

### 2.3 Death states

- **Wasp death:** the wasp is gone. Control returns to colony view; pick another wasp.
- **Queen death mid-season:** the colony is doomed unless it already has mated gynes. Workers keep working.
- **Line extinct:** no living queen and no living gyne or hibernating queen in the player's line. Game over. Start a new line, in the same world (if it still exists) or a new one.

---

## 3. Simulation architecture

### 3.1 Two layers

- **Sim (`Sting.Core`):** a plain C# assembly with no reference to `UnityEngine`. It owns all game state and all decisions. It compiles in Unity and as a standalone .NET library for the headless runner and tests. **[P] D-11**
- **Presentation (Unity):** reads sim state and sim events, renders, animates, plays audio, collects input. It never decides an outcome.

### 3.2 Architecture rules

- **R-01** The sim MUST NOT read anything from the presentation layer except player input commands.
- **R-02** Anything that can change gameplay state MUST be computed by the sim.
- **R-03** Animation, particles, ragdolls and audio MAY differ between peers and MUST NOT feed back into the sim.
- **R-04** Sim state and sim decisions MUST use fixed-point math. `float` and `double` are forbidden in `Sting.Core` except in offline tools that generate data tables. As built (18.18): the core is written against `Num`, which is Q32.32 in the shipping build and a double only in the build that proves parity with the PoC.
- **R-05** All randomness MUST come from the counter-based RNG (3.5) keyed by (world seed, domain, entity, tick, salt). No stateful global RNG, no `System.Random`.
- **R-06** Iteration order MUST be deterministic: entities in ascending `EntityId` order. Never depend on `Dictionary` or `HashSet` enumeration order. Never use an unstable sort without a total-order tiebreak.
- **R-07** The sim MUST NOT read wall-clock time. Only ticks.
- **R-08** If a subsystem is multithreaded, work MUST be partitioned deterministically and merged in fixed order.
- **R-09** No third-party code in `Sting.Core`. Only the base class library.

### 3.3 Tick **[T0]**

- Base tick: 60 Hz.
- Subsystems run on divisors of the base tick:

| Subsystem | Rate | Reason |
|---|---|---|
| Wasp flight and collision | 60 Hz | Small fast bodies; at 6 m/s a wasp moves 10 cm per tick, more than six body lengths |
| Human reaction plans and swat checks | 60 Hz | Swat windows are a few ticks wide |
| Human movement, panic | 20 Hz | Slower bodies |
| Bees, predators | 20 Hz | |
| Colony economy | 1 Hz | Bulk flows |
| Ecology (regrowth, spawning) | 0.2 Hz | |
| Weather, season | once per in-game hour | |

- Subsystem order inside a tick is fixed and documented in code (Appendix A.3).

### 3.4 Numbers **[T0]** (sine is a polynomial, not a table: 19.4)

- `Fix64`: signed Q32.32 in a `long`. Range about ±2.1 × 10⁹, resolution about 2.3 × 10⁻¹⁰. One unit = 1 meter for distances.
- A whole world fits with sub-micron precision, so there is no floating origin in the sim.
- Multiplication uses a 64×64→128-bit product, written by hand (Appendix A.1).
- Square root uses an integer algorithm. Sine and cosine use a quarter-wave lookup table generated once by an offline tool and committed as constants. The table is data; generating it with `double` is allowed because the output is frozen (R-04).
- `Vec3F`: three `Fix64`.
- Overflow policy: debug builds assert, release builds saturate.

### 3.5 Randomness **[T0]**

Counter-based: every random value is a pure hash of its inputs, so any peer can compute "the random value for entity X at tick T" without having generated the values before it. This is what makes on-demand chunk generation and "same human, same traits everywhere" possible.

```
value = Hash(worldSeed, domain, a, b, c)
```

Domains: `WorldGen`, `HumanTraits`, `HumanSchedule`, `Clothing`, `Flight`, `Colony`, `Ecology`, `Weather`, `Bees`.

Mixer: the SplitMix64 finalizer applied to the inputs in sequence. Implementation in Appendix A.2.

### 3.6 Entities **[T0] [T2]** (type bits and struct-of-arrays storage not adopted: 19.4)

- `EntityId` is a `ulong`. Top 8 bits: entity type. Remaining bits: a hash.
- World-generated entities (humans, trees, hives, picnic tables): `id = Hash(worldSeed, WorldGen, chunkX, chunkZ, slot)`. Every peer derives the same ID without talking.
- Runtime-born entities (brood, wasps): `id = Hash(colonyId, birthTick, sequence)`. Born only by the colony's owner peer, then announced.
- Storage: struct-of-arrays per entity type, kept sorted by `EntityId` (R-06).

### 3.7 Events **[T0]**

- `SimEvent { Tick, Type, Source, Target, Payload }`.
- Total order: (Tick, Type priority, Source, Sequence). Ties are impossible by construction.
- Events are the unit of networking for anything that changes non-owned entities (Section 11).
- Examples: `Sting`, `SwatAttempt`, `WaspKilled`, `ObjectKnockedOver`, `PickUp`, `NestFounded`, `NestDestroyed`, `ChunkDiscovered`.

### 3.8 State hashing **[T0]**

- Every subsystem can produce a 64-bit hash of its state.
- The headless runner records hash streams. Peers exchange hashes of shared deterministic state (ambient humans, chunk deltas) every N seconds to detect desync.

### 3.9 Serialization **[T0]**

Own binary format, little-endian, explicit field order, version byte per record. No reflection-based serialization.

---

## 4. World: generation, discovery, persistence

### 4.1 Setting

Temperate world: suburbs with gardens, parks, picnic areas, beer gardens, farmland, forest edge, small town centers. Setting style **settled (Q-06): American suburbia**: lawns and fenced backyards, cul-de-sacs, park strips, a strip-mall edge.

### 4.2 Chunks **[T0] [T1]** (regions)

- Chunk: 64 m × 64 m columns, keyed by integer (cx, cz).
- Region: 8 × 8 chunks (512 m), used for large-scale layout (where the town is, where the farm is).
- Wasp foraging range is on the order of hundreds of meters *(tune)*, so a colony's working area is roughly a region.
- As built (18.34): each region lays out a park strip, a strip-mall edge, a forest corner and suburban yards; chunks read their land use from it.

### 4.3 Generation **[T0] [T1]**

- `Generate(worldSeed, genVersion, cx, cz) → ChunkBase` is a pure function (Appendix A.11).
- Two passes: region layout (land use, roads, water) then chunk content.
- Chunk content:
  - terrain heightfield and surface materials
  - static objects: trees, fences, walls, houses, sheds, tables, benches, bins
  - resource nodes: flowers (nectar), fruit trees, prey spawn zones, pulp sources (untreated wood)
  - human anchors: homes, workplaces, seats, picnic spots, grills
  - hazards: spider web spots, bird perches
  - bee hives: managed boxes and feral hives

### 4.4 Discovery and freeze **[D] D-02** **[T0]**

- A chunk becomes **discovered** when any player-owned wasp comes within the discovery radius (2 chunks *(tune)*).
- On discovery the chunk's base content is generated and **stored as a snapshot** with its generator version and content hash. **[P] D-10**
- Rationale: generators will change through development. Storing only (seed, version) would force the game to carry every generator version forever. A snapshot lets old generators be deleted. Undiscovered chunks always use the current generator.
- Simultaneous discovery by two peers is harmless: both generate from the same seed and the same `genVersion` (pinned in the world record), so the records are identical and writes are idempotent.

### 4.5 Delta log **[T0] [T1]**

Everything living things do to a discovered chunk is a delta on top of the frozen base:

| Delta | Example |
|---|---|
| `ObjectRemoved` / `ObjectAdded` | A trap hung, a table moved |
| `PropertyChanged` | A fence section stripped of pulp, a fruit tree harvested |
| `NestFounded` / `NestDestroyed` | |
| `ResourceSpawned` | Spilled soda from a knocked-over table |
| `AreaMemory` | Humans now consider this spot wasp-risky (Section 8.10) |

Compaction: the persistence holder periodically folds old deltas into a new base revision of the chunk.

### 4.6 Persistence **[T0] [Infra]** (local saves built; persistence node needs a server)

- `IWorldStore` interface with two implementations:
  - `LocalWorldStore`: files on disk, for solo play and for a peer acting as world holder.
  - `PersistenceNode`: a headless process that stores and validates world records and deltas but runs no gameplay.
- World record: world seed, `genVersion`, tuning hash, epoch, population figure, list of discovered chunks.
- All peers in a world MUST run the same build: same `genVersion` and same tuning hash. Connection is refused otherwise.

### 4.7 World tiers **[D] D-13** **[Infra]** (Personal built)

Worlds are separate, not one unified universe, in the way Valheim and Minecraft worlds are. There are three tiers:

| Tier | Comparable to | Hosted by | Scale | Rules | Counter |
|---|---|---|---|---|---|
| **Main** | A PlanetSide 2 continent | Official infrastructure | As many players and wasps as the tech carries | Canonical, fixed modifiers | The canonical counter |
| **Offshoot** | A Valheim or Minecraft dedicated server | Community or rented host | Set by the host | Host-chosen modifiers | Its own, labeled with its modifier set |
| **Personal** | A single-player or friends world | The player's machine | One player or a small group | Everything adjustable, including time acceleration and pause | Its own |

- **Main** is where maximum stinging happens: the biggest population, the most wasps, the canonical ruleset.
- **Offshoots** are what make servers different from each other (4.8).
- **Personal** worlds give full control over the environment.
- An offshoot can be founded from a fresh seed, from Main's seed (same geography, undiscovered), or from a snapshot of an existing world (records and deltas copied) **[Q] Q-13**.
- A colony line belongs to the world it was founded in **[Q] Q-14**.

### 4.8 World modifiers **[P] D-14** **[T0] [T1] [T2]**

Every world carries a modifier set that makes it recognizably itself.

**Tuning modifiers** scale values in the tuning tables:
- human density, reaction speed range, panic contagion
- escalation rate and decay, exterminator frequency
- bee aggression and balling strength, predator density
- resource abundance, prey spawning
- day length, season length, winter length
- colony size cap, rival-colony fighting on or off
- population figure for the counter
- HUD rules (hardcore)

**Feature modifiers** change world generation and which systems run:
- setting style, biome mix, town density, water, terrain roughness, hive density
- system toggles: exterminators, bees, birds, extreme weather

Rules:
- Modifiers are **data, not code**. They live in the world record, and the effective tuning hash is the hash of base tuning plus modifiers, so every peer computes the same values.
- Feature modifiers act at chunk generation. Discovered chunks are frozen (4.4), so changing a feature modifier mid-world changes only undiscovered land. The world's history stays visible in its geography.
- Some modifiers are locked at world creation (seed, setting style). Others can change live; every change is logged with its tick.
- A world's modifier set is summarized as a short tag in the server browser, so a player can tell Main from "bees ×2, slow humans, long summers" at a glance.
- Scripted code mods are out of scope for now **[Q] Q-12**. They would break the determinism guarantee and open a security hole.

---

## 5. Time, seasons, weather

### 5.1 Clock **[T0]**

- World time = ticks since the world epoch.
- In-game day length: 2 real minutes by default, chosen when the world is created (2, 6 or 12) *(tune)* **[Q] Q-02 settled for day length**. Seasons are 20–200 days, also chosen at creation; the default 40-day season is about 80 minutes of play.
- Solo play MAY accelerate time in colony view. A multiplayer world clock MUST NOT accelerate.

### 5.2 Season phases *(tune, bio)* **[T0]**

| Phase | Northern-temperate calendar | Colony state |
|---|---|---|
| Hibernation | Nov – Mar | Only mated queens, dormant |
| Founding | Apr – May | Queen alone builds 20–30 cells, then lays |
| Growth | Jun – Jul | First workers, rapid expansion |
| Peak | Aug – Sep | Thousands of workers, queen cells, males, brood winding down |
| Collapse | Sep – Oct | Reproductives leave, workers die |

### 5.3 Temperature and weather **[T0] [T1]** (cloud)

- Daily weather is a pure function: `Hash(worldSeed, Weather, dayIndex)` drives temperature offset, cloud, rain and wind.
- Temperature affects: whether wasps can fly and forage, human outdoor density (picnics need warm dry days), resource availability and nest thermals.
- Rain grounds flight. Wind is a force field in flight (Section 7.2).
- Day and night: wasps are diurnal and return to the nest at dusk. Humans follow routines (Section 8.2).

---

## 6. The colony

### 6.1 Biology baseline *(bio)* **[T0]**

Model species: *Vespula* (common wasp and German wasp, the yellowjackets in the meme). See Appendix C for sources and numbers.

- Annual colony founded alone by an overwintered queen.
- Paper nest built from chewed wood pulp.
- Larvae eat protein: insects and spiders caught and chewed by workers.
- Adults eat carbohydrate: nectar, fruit, and whatever sugar humans leave out.
- Workers collect sugary secretions from the larvae.
- Workers live about two weeks on average, can sting multiple times, and switch to guarding the entrance late in life.
- Peak colonies run to thousands of workers.
- Late in the season only queen cells are built; new queens and males emerge, mate, and the old colony collapses.

### 6.2 Resources **[T0] [T2]** (water)

| Resource | Source | Spent on |
|---|---|---|
| Protein (P) | Prey: caterpillars, flies, spiders, bees; carrion; meat at barbecues | Feeding larvae |
| Sugar (S) | Nectar, ripe and fallen fruit, human food and drink, larval secretion | Adult energy, flight fuel |
| Pulp (W) | Untreated wood: fences, sheds, dead branches | Nest cells and envelope |
| Water (H₂O) *(tier 2)* | Puddles, birdbaths, drips | Nest cooling in heat |

### 6.3 The sugar crisis **[T0]**

This is the central late-season mechanic, and it emerges from colony state rather than a script.

- While brood is being raised, larval secretion supplies part of the workers' sugar.
- When the queen stops laying worker brood, larval count falls, secretion falls, and workers must find sugar elsewhere.
- The colony's **sugar deficit** raises AI workers' attraction to human food, which raises sting events, which raises human escalation (8.10).

Economy step in Appendix A.4.

### 6.4 Brood pipeline *(bio, tune)* **[T0]**

| Stage | Duration |
|---|---|
| Egg | 5–7 days |
| Larva | food-dependent; first adult about 23 days after hatching |
| Pupa | remainder of about 30 days total |

- Queen laying rate at peak: about 200–300 eggs per day *(bio)*.
- Cells are a hard cap: no free cell, no egg.
- Larvae with insufficient protein develop more slowly; starved larvae die.
- Cell type decides caste: worker cells all season, queen cells late season.

### 6.5 Castes and roles **[T0]**

| Caste | Notes |
|---|---|
| Queen | Founds the nest alone, then lays. Her death dooms the colony |
| Worker | Sterile female. Roles: protein forager, sugar forager, pulp forager, builder, nurse, guard |
| Gyne | Unmated new queen. Leaves to mate, then hibernates |
| Male | Mates and dies. Does not sting |

- **Role allocation:** the player sets target ratios; the colony assigns idle workers to fill them.
- **Default allocation by age:** young workers nurse and build inside; older workers forage; the oldest guard the entrance *(bio-inspired)*.

### 6.6 Nest **[T0]**

- Nest sites: underground cavity, wall cavity, attic, shed, hollow tree, open branch.
- Each site type has: exposure to weather, thermal stability, human discovery chance, flood risk and maximum size.
- Nest growth: builders turn pulp into cells and envelope layers. Size caps the colony.

### 6.7 Succession and the line **[D] D-05** **[T0] [T2]** (lineage colonies as real AI colonies T2)

- Gynes leave in autumn, mate with males present in the mating area, then search for a hibernation site.
- Winter mortality per hibernating queen depends on site quality *(tune)*.
- In spring the player picks which surviving queen continues as the controlled colony. The other surviving queens found **lineage colonies** run by AI. **[Q] Q-10**
- **The line** is the player's founding queen and all colonies descended from her. Game over when the line is extinct.

---

## 7. The wasp

### 7.1 Body *(bio, tune)* **[T0]**

| Parameter | Worker | Queen |
|---|---|---|
| Length | 12–17 mm *(bio)* | about 20 mm *(bio)* |
| Collision radius | 7 mm | 9 mm |
| Cruise speed | 3 m/s *(tune)* | 2.5 m/s |
| Burst speed | 6 m/s *(tune)* | 4.5 m/s |
| Carry capacity | one prey load or crop full of sugar | |
| Venom reserve | 3 full stings, regenerates *(tune)* | |

- Energy: crop sugar burns with flight effort; empty crop means forced landing.
- Temperature: below the flight threshold the wasp cannot take off *(tune)*.
- Health: a single solid hit (swat, crush) kills. Grazes stun.

### 7.2 Flight **[T0]**

- A steered kinematic model in fixed-point: desired velocity from input, limited by max acceleration and turn rate, plus wind and gravity when not producing lift.
- Collision is **swept** against world geometry every tick (at burst speed a wasp crosses a thin twig in one tick). Uses the deterministic collision developed in the Tarmac Lab pilot.
- Landing and gripping on any surface, at any angle, is a state, not a physics outcome (as built: 18.25). Only climb or burst leave a surface; a sting from a surface reaches a person within a few centimetres.

### 7.3 Senses (AI wasps) **[T1]**

- Scent fields: sugar, protein, alarm pheromone. Each is a decaying point source; strength at a point is a pure function of sources and time.
- Vision cone for movement.
- The driven wasp gets the same information as UI cues (Section 10).
- As built (18.30): scent reach by source and wind, sight for flies, a spiral search when nothing is in reach, site fidelity, and the scent of food brought home.

### 7.4 Stinging **[T0]**

- A sting requires contact with an exposed or thinly covered zone of a target (Section 8.3).
- **Pain onset is the contact tick.** The `Sting` event is emitted at that tick.
- Two sting modes *(tune)*:

| Mode | Contact time | Pain | Effect |
|---|---|---|---|
| Jab | 6 ticks | low | Counts as stung; small panic |
| Full | 30 ticks | high | Larger panic, more escalation, more memory |

- Both count toward the counter. Full stings are a risk/reward choice: the human's swat clock starts at contact, not at withdrawal.

### 7.5 Death causes **[T0]**

Swat, crush under clothing, insecticide spray, bee balling, bird, spider web, drowning in a drink or a trap, cold, starvation, old age, rival wasps.

### 7.6 Alarm pheromone *(bio-inspired)* **[T0]**

- A wasp crushed near its nest releases alarm pheromone. Nearby workers of that colony switch to attack for a duration *(tune)*.
- Consequence chain: a human swats a wasp near the nest → many stings → that neighborhood escalates fast → exterminator. The colony defends itself into danger.

### 7.7 Possession **[T0]**

- Any adult of the player's own colony can be driven.
- When released, the wasp resumes its assigned role under AI.
- Switching limits are **[Q] Q-03**. Proposed: switch freely to any wasp inside the nest or within 30 m of the current one; switching to distant wasps costs a delay.

---

### 7.8 Reflex (skill tree, later) **[T0] [T2]** (solo slowdown built; skill tree T2)

A slowdown on detection in the manner of Metal Gear Solid V's Reflex mode, unlocked through wasp progression. It triggers when a swat, spray or press is scheduled against your driven wasp (a `preSwat`, `notice`, `press` or own-sting swat), because that is the moment the sim already knows the hand is coming and exactly when it lands.

The determinism and netcode rules decide how it can work:

- **Personal instances, solo.** Real slowdown. The sim keeps its 60 Hz tick but the wall clock advances it at a fraction of real time (for example 0.25× for one real second). Outcomes are unchanged because the sim never sees wall time; only the player gets more real time to act per tick.
- **Shared worlds (personal with friends, offshoot, Main).** No sim slowdown. Peers run free against the wall clock and events commit 30 ticks after they happen (18.2); a peer that slowed itself would fall behind and its events would arrive past their commit tick. Reflex is presentation-only here: a short slow-motion of the *render* of the incoming hand while input stays live, plus the swat's known landing point and tick drawn as a warning. The sim's swat start and volume are already known when the swat is scheduled, so the cue is exact, not a guess.
- **Tuning.** A skill tree can scale the cue (earlier warning, longer slow-motion in solo, the predicted swat volume shown), never the outcome. The consequence window (7.4, minimum 11 ticks) stays as it is.


## 8. Humans

Humans are the most important system in the game, and they are the most deterministic one.

### 8.1 Identity and traits **[T0]**

- `HumanId = Hash(worldSeed, WorldGen, homeChunkX, homeChunkZ, slot)`.
- Every trait is derived from `Hash(worldSeed, HumanTraits, HumanId, traitIndex)`. Same human, same traits, on every machine, without syncing anything.

| Trait | Range *(tune)* | Used for |
|---|---|---|
| Height | 1.50 – 1.95 m | Zone positions, reach |
| Arm ratio | 0.92 – 1.08 of nominal | Reach |
| Flexibility | 0 – 1 | Reach on the back |
| Girth | 0 – 1 | Reach on the back and belly |
| Age band | young adult, adult, older | Reaction speed, flexibility |
| Reaction delay | 11 – 42 ticks (183 – 700 ms) | Swat window start |
| Swat style | Precise, Flailer, Brusher, Freezer, Runner | Shape and width of swat |
| Swat accuracy | 0 – 1 | Swat volume radius |
| Panic susceptibility | 0 – 1 | Panic gain per sting |
| Sociability | 0 – 1 | Group size, willingness to help |
| Escalation tendency | 0 – 1 | Buys spray, sets traps, calls exterminator |

Humans in the world are adults only.

### 8.2 Schedules **[T0] [T1]**

- Each human's day is a pure function of (traits, day index, weather): sleep, commute, work, errands, leisure (picnic, barbecue, beer garden, gardening).
- Position at any tick is computed from the schedule, not simulated forward. A peer that loads a chunk at any time places every human correctly without asking anyone.
- Deviations (fleeing, avoiding, fetching spray) come only from events, and events are synced (Section 11). So a human's full state is a function of (seed, time, event history).

### 8.3 Body zones **[T0] [T1]** (walk and lie postures)

The sim body is a set of zone capsules in a body frame, scaled by height and girth, in one of a few postures: stand, sit, walk, lie. The rendered skeleton is presentation; the zone capsules are the truth.

| Zone | Base self-reach | Response policy | Helper may swat |
|---|---|---|---|
| Scalp | 0.90 | Slap or shake | yes |
| Face (eyes, nose, lips) | 1.00 | Brush or shake, never full slap | no |
| Ears | 0.95 | Brush | yes |
| Neck, front | 0.95 | Slap | yes |
| Neck, back | 0.85 | Slap | yes |
| Shoulders | 0.85 | Slap | yes |
| Upper back | 0.35 | Contort | yes |
| Acnestis (between shoulder blades) | 0.10 | Contort | yes |
| Lower back | 0.55 | Contort or slap | yes |
| Chest | 0.95 | Cover and swipe | no |
| Belly | 0.95 | Slap | yes |
| Groin | 0.95 | Cover and swipe, pure panic | no |
| Buttocks | 0.70 | Slap | no |
| Upper arms | 0.85 | Slap with opposite hand | yes |
| Forearms, hands | 0.95 | Slap with opposite hand | yes |
| Thighs | 0.95 | Slap | yes |
| Shins, ankles | 0.85 | Slap or kick-shake | yes |

All values *(tune)*. The acnestis is the real anatomical name for the patch of back you can't reach.

### 8.4 Reach **[T0]**

Self-reach for a zone is a number from 0 to 1:

```
reach = base
      + armCoef  × (armRatio − 1)
      + flexCoef × (flexibility − 0.5)  × zone.backSensitivity
      − girthCoef × girth               × zone.girthSensitivity
      − clothingStiffness               × zone.stiffnessSensitivity
      − ageCoef  × ageStiffness         × zone.backSensitivity
clamped to [0, 1]
```

Below `minReachToSwat` *(tune 0.25)* the human cannot strike that zone and contorts instead. Appendix A.5.

### 8.5 Response styles **[T0]**

| Style | Force | Volume radius | Window | Notes |
|---|---|---|---|---|
| Slap | full | 4 cm (precise) to 10 cm (flailer) | 4 ticks | Most dangerous |
| Brush | low, stuns rather than kills | 8 cm | 6 ticks | Face and ears |
| Shake | none on the wasp, dislodges | — | 10 ticks | Head and hair |
| Cover | medium | 12 cm | 8 ticks | Chest, groin |
| Contort | low | 15 cm, large delay | 10 ticks | Back zones; mostly comedy |
| Freeze | none | — | — | The human goes rigid; panic builds |
| Run | none | — | — | Flees, with a flailing swat on the way out |

### 8.6 Sting resolution — the core function **[T0]**

`ResolveSting(StingEvent, HumanTraits, HumanContext) → ReactionPlan` is a pure function. Given the same inputs it MUST return the same plan on every machine. Appendix A.6.

Inputs:
- the event: tick, wasp, human, zone, contact point in body frame, sting mode
- the human's traits
- context: posture, clothing, current panic, nearby companions (derived from schedules, sorted by ID)

Output: a fixed-size plan of scheduled sub-events:
- **Flinch** at contact (cosmetic only).
- **Swat attempt** at `contactTick + delay`, with a volume in body frame and an active window.
- **Helper swats** from companions within 2 m for zones where helping is allowed, each with its own delay.
- **Panic gain** and **memory** entries.
- Follow-ups: flee, fetch spray, area memory.

The skill the game teaches falls straight out of this: sting, and be gone before that person's swat lands. A slow older man gives you time to linger. A twitchy young adult gives you almost nothing. An isolated human cannot touch their own acnestis. A human with friends can.

### 8.7 Swat check **[T0]**

During each tick of a swat window, the volume is transformed from body frame to world frame and tested against the wasp's position (sphere vs sphere, swept over the tick). A hit kills (slap, cover) or stuns (brush, contort). Authority for this check is covered in Section 11.5. Appendix A.7.

### 8.8 Clothing **[T0]**

| Cover | Effect |
|---|---|
| None | Full sting |
| Thin (T-shirt, dress) | Sting passes through |
| Thick (jeans, jacket) | Sting blocked |
| Opening (sleeve, collar, hem, loose waistband) | Entry point to the space under clothing |

- A wasp under clothing is **trapped**: it can sting freely, but the human's response becomes compression (pressing the clothing against the body), with a much larger kill chance. High reward, high risk.
- The day's clothing comes from `Hash(seed, Clothing, HumanId, day)` filtered by temperature.

### 8.9 Panic **[T0]**

- Panic level 0–1 per human, updated at 20 Hz.
- Gain from stings: zone sensitivity × sting mode pain × panic susceptibility.
- Contagion: panicked humans raise panic in nearby humans who can see them, scaled by sociability.
- Thresholds: flinch, then swat, then flee or scatter.
- Panic can knock over tables and drinks. Those are sim events that write chunk deltas, and a spilled drink is a new sugar node. Panic feeds the wasps.

### 8.10 Memory and escalation **[T0]**

- Each human remembers stings: count, recency, place.
- Each neighborhood has an **escalation level** from accumulated memory, decaying over time *(tune)*:

| Level | Human behavior |
|---|---|
| 0 | Normal |
| 1 | Swatting, waving |
| 2 | Food covered, drinks lidded, citronella |
| 3 | Insecticide sprays, sugar-bottle traps (a drowning hazard) |
| 4 | Nest search by watching wasp traffic, exterminator called |
| 5 | Municipal pest control across the area |

- **Exterminator:** a special human who locates nests by observing wasp flight lines and destroys them by treating the entrance. The main external threat to the colony.

### 8.11 The counter **[T0] [Infra]** (canonical Main counter)

- Counts **unique humans stung** in this world, by all players **[P] Q-09**. Only Main's counter is canonical; every other world's counter is shown with its modifier tag (4.8).
- Display: `stung: N / <population figure>`. The figure is a world setting, default 8,200,000,000.
- Storage: a set of `HumanId`s per world, kept by the world holder.

---

## 9. Bees and ecology

### 9.1 Honeybee hives **[T0]**

- Managed hives (beekeepers' boxes in gardens) and feral hives (tree hollows, walls).
- Bees forage flowers and compete with wasps for nectar.
- Wasps can prey on bees and rob hives: a large protein and sugar reward at high risk.

### 9.2 Hive defense **[T0]**

- Guards at the entrance detect intruders. Alarm recruits more bees.
- **Balling:** when enough bees engage one intruder, they form a ball and heat it with their flight muscles.
  - Ball core temperature rises per tick with the number of bees.
  - The wasp dies when core temperature passes its lethal threshold; bees tolerate a few degrees more.
  - Reference: in documented Japanese honeybee defense against hornets, ball temperature reached 46 °C within five minutes, and hornets died at 44–46 °C *(bio)*. Real balls take minutes. The game compresses this to tens of seconds *(tune)*.
  - Escape: each tick the wasp can break out with a chance based on its strength against ball size. A queen is stronger than a worker but caught queens usually die.
- Design license: the research is on hornets and Asian honeybees. Applying balling to *Vespula* and to all bees in the game is a deliberate choice **[P]**, with balling strength as a per-hive parameter.

### 9.3 Predators and hazards **[T0]**

Birds (perch and hunt flying insects), spiders (static webs), dragonflies, rival wasp colonies (AI and other players) fighting over food and nest sites.

### 9.4 Prey and resources **[T0]**

- Prey spawns by biome and season: caterpillars, flies, aphid-tending insects, carrion.
- Flowers bloom in season. Fruit ripens and falls late summer.
- Regrowth runs in the ecology tick.

---

## 10. Player control and UI

### 10.1 Modes **[T0]**

- **Drive:** you are one wasp.
- **Colony:** the nest cutaway and the map.

### 10.2 Drive HUD **[T0]**

- Crop sugar, venom, health, body temperature.
- Scent cues: sugar, protein, alarm.
- Threat cues come from the world, not numbers: the flinch, the hand coming up. Reaction delays are learned, not displayed. A hardcore option removes the HUD entirely.
- Counter in the corner.

### 10.3 Colony view **[T0]**

- Resource stocks and flows, sugar deficit indicator.
- Brood pipeline by stage and caste.
- Role allocation targets.
- Nest size and cell use.
- Map of discovered chunks, with resource nodes found and an escalation overlay per neighborhood.
- List of adults with role and location, for picking a wasp to drive.

### 10.4 Input (drive) **[T0]**

Flight (pitch, yaw, climb, throttle), land and grip, sting (tap for jab, hold for full), pick up and carry, chew pulp, release control.

### 10.5 Pause **[T0]**

Solo only. Multiplayer never pauses.

---

## 11. Multiplayer

### 11.1 Model **[D] D-01** **[T0]**

- Peer-to-peer. Each peer is the authority over the entities it owns: its possessed wasp and its colony.
- No rollback. Each player plays as-is on their own screen. Remote entities are extrapolated from their last known state.
- No server simulates individual entities. Infrastructure depends on the world tier (11.11): rendezvous and relay (connections), persistence nodes (storage), and on Main, cell servers that route, audit and persist but do not simulate entities.

### 11.2 What travels **[T0]**

| Data | Channel | Rate | Notes |
|---|---|---|---|
| Owned entity state (position, velocity, heading, flags) | unreliable, sequenced | 20–30 Hz | Absolute world coordinates, so errors never accumulate |
| Events (`Sting`, `PickUp`, `ObjectKnockedOver`, …) | reliable, ordered per sender | as they happen | Tick-stamped |
| Chunk records and deltas | reliable | as they happen | Via the chunk authority or persistence node |
| Ambient humans, fauna, weather, world generation | not sent | — | Computed locally from seed and time |

### 11.3 The shared state table **[T0]**

- Key: `EntityId`. Row: entity state.
- **Single writer per row:** only the owner writes it. Everyone else reads. Conflict-free by construction.
- Rows replicate only to interested peers (Section 11.7).

### 11.4 Remote entity display **[T0]**

- On a state packet `(tick, position, velocity)`: predicted position = position + velocity × (now − tick).
- Displayed position moves toward the prediction by a blend factor each frame; above a snap distance it jumps.
- This is presentation code and MAY use floats. Appendix A.8.

### 11.5 The consequence window **[T0]**

This is the property that makes rollback unnecessary for humans.

- A sting's first gameplay consequence, the swat, happens at `contactTick + reactionDelay`.
- The minimum reaction delay is 11 ticks (183 ms). Typical one-way latency is under that.
- So the `Sting` event usually reaches every interested peer **before** the swat happens. Every peer resolves the same plan from the same inputs, and nothing needs correcting.
- If an event arrives late, the peer fast-forwards only that human's reaction plan to the current tick, skipping the cosmetic part. That is catching up a deterministic local plan, not rolling back the world.
- Biology pays the network budget: human reaction time is the latency allowance.

**Swat hit authority [Q] Q-04.** Proposed: the wasp's owner evaluates whether its own wasp was inside the swat volume during the window, since it has the exact position and the volume is deterministic, and reports `WaspKilled` or nothing. Other peers audit with the states they received; a disagreement beyond tolerance is flagged as a plausibility violation (11.6).

### 11.6 Contested objects and chunk authority **[T1]**

- Some things can't be resolved by events alone: two wasps grabbing the same caterpillar, the same soda can.
- Each chunk has one **chunk authority** among the peers interested in it, chosen by rendezvous hashing: the peer with the smallest `Hash(chunkKey, peerId)` wins. Membership changes move as few chunks as possible. Appendix A.9.
- The chunk authority resolves contested pickups, writes chunk deltas, and sends late-event corrections.
- As built (18.32): contested pickups in the lab; deltas and late-event corrections are not on the authority yet.

### 11.7 Topology and interest **[T0] [Infra]** (rendezvous, hole punching, relay)

- Peers connect only to peers whose entities are within the interest radius (3 chunks *(tune)*). The mesh is local and reshapes as players move. A full mesh across the world is never formed.
- Rendezvous service: peer discovery and UDP hole punching. Relay fallback for peers whose NAT won't punch. Self-hostable.

### 11.8 Plausibility checks **[T0] [T1]**

Owner authority means anyone can claim anything, so every peer checks what it receives:

- maximum speed and acceleration per caste
- sting needs contact distance; sting rate limited by venom
- carry limits
- no positions inside solid geometry
- event ticks inside the accepted window (not from the far past or future)
- chunk deltas consistent with the actions that caused them

Violations: drop the update, quarantine the peer, and report to the world holder, which can remove it. The persistence node applies the same checks to deltas before storing them.

### 11.9 Clock sync **[Infra]**

- World tick = (synchronized time − epoch) / tick length.
- Peers estimate clock offsets from ping exchanges. Peers MUST agree on the current tick within a few ticks; schedules and consequence windows depend on it.

### 11.10 Joining a world in progress **[T0]**

A joining peer receives:
1. world record (seed, `genVersion`, tuning hash, epoch, population figure)
2. discovered chunk records and delta logs for its interest area
3. current rows of owned entities nearby
4. the live rows of humans nearby, pending committed events and committed interest windows (revised by the PoC, 18.10: this replaces rebuilding panic from recent events)

### 11.11 Network topology by world tier **[D] D-13, [P] D-15** **[Infra]**

Gameplay authority is the same in every tier: owners decide about what they own, and humans are resolved deterministically on every client. What changes is how data travels and who stores it.

| Tier | Topology | World holder | Chunk authority |
|---|---|---|---|
| Personal | Local, or direct P2P with friends | The host player's machine | The host |
| Offshoot | P2P mesh with a dedicated host process for rendezvous, relay, persistence and plausibility checks | The host process | Elected among peers (11.6) |
| Main | Clients connect only to cell servers, never to each other | Cell servers | The cell server |

**Main runs on cell servers.** A P2P mesh can't carry thousands of players, so Main replaces it with a grid of cell servers, each covering a region with overlap at the edges:

- A client sends its owned state and events once, to its cell server.
- The cell server forwards each update only to clients that need it, at a rate set by relevance (11.12).
- It runs the plausibility checks (11.8) on everything, acts as trusted chunk authority, and persists the world.
- It does not simulate entities. Authority stays with owners, as in the other tiers.
- Players crossing a boundary hand off between cells; the overlap zone gets updates from both.
- Clients never see each other's IP addresses, which settles Q-05 for Main.

There is precedent for this split. PlanetSide 2 is known for keeping hit detection on clients and spending server effort on routing relevant updates, and it set a Guinness record with 1,158 players in one battle in 2015 ([Guinness World Records](https://www.guinnessworldrecords.com/news/2015/01/planetside-2-gamers-aiming-for-fps-battle-world-record-this-weekend-370414)). STING's harder problem isn't players but wasps, which is what 11.12 handles.

### 11.12 Relevance tiers (scale) **[T0] [T1] [Infra]**

On Main the entity count is dominated by AI wasps: one player's colony can hold thousands of workers. Nothing at that count can be replicated at full rate, so every wasp sits in a relevance tier, judged per receiving client:

| Tier | Which wasps | Simulated as | Replication to that client |
|---|---|---|---|
| Driven | Wasps a player is driving | Full flight, owner side | 30 Hz, full state |
| Near | AI wasps within 50 m of the client's wasp *(tune)* | Full flight, owner side | 10 Hz, quantized |
| Mid | AI wasps inside the interest radius | Full flight, owner side | 2–5 Hz, batched in swarm packets |
| Far | Beyond the interest radius | Colony statistics, owner side | Traffic density per chunk only |
| Abstract | Inside the nest or out of the world | Colony economy | 1 Hz colony summary to the cell server |

- **Quantization:** positions relative to the chunk origin, 16 bits per axis. 64 m ÷ 65,536 ≈ 1 mm, so 6 bytes per position.
- **Swarm packets:** one header per chunk, then a run of quantized positions and state bits for many wasps.
- **Rough downstream budget per client** *(tune)*: 50 driven wasps at 30 Hz × 20 bytes ≈ 30 KB/s; 500 near wasps at 10 Hz × 10 bytes ≈ 50 KB/s; 5,000 mid wasps at 2 Hz × 6 bytes ≈ 60 KB/s. About 140 KB/s, or 1.1 Mbit/s, for a crowded spot.
- Offshoot and Personal worlds use the same tiers, with caps set by modifiers (4.8).
- As built in the lab (18.33): driven 20 Hz, near 10 Hz, mid 3 Hz in swarm packets of 9 bytes a wasp, far as counts per chunk once a second; measured with 143 to 200 workers out.

**Offline players on Main [Q] Q-15.** Seasons keep running on Main when a player logs off, but an offline player's colony has no owner to simulate it. Proposed: the cell server runs offline colonies at the abstract tier only (economy and statistical foraging risk, no individual wasps). This is a deliberate, narrow exception to "servers don't simulate."

### 11.13 Transport **[Q] Q-05** **[Infra]**

- Own UDP protocol: header with protocol version, peer ID, sequence, ack and ack bitfield; an unreliable state channel and a reliable ordered event channel. Redundancy: each state packet MAY repeat the previous state for loss resilience.
- **Cryptography is not hand-rolled.** Use the runtime's primitives or a platform transport.
- Plain P2P exposes every player's IP address to the others, which invites denial-of-service attacks on players. A relay such as Steam's networking relay hides addresses and handles NAT traversal and encryption.
- Proposed: the transport sits behind an interface. Own UDP for development and LAN; a relay-backed transport for the public release. This is the one place where a platform dependency is likely worth it.

---

## 12. Presentation contract (Unity) **[Unity]**

- **Reads:** sim state each frame (interpolated between ticks for display) and sim events (to trigger animation and audio).
- **Writes:** player input commands only.
- **Conversion:** `Fix64` → `float` happens only at this boundary.
- **Human animation:** reaction plans give the presentation an impact point in body frame and an impact tick. The animator MUST bring the hand to that point at that tick, using IK and time-warped clips. Flailing versus precise is a choice of clip, purely cosmetic.
- **Unity physics:** not used for anything that affects gameplay. A table knocked over is a sim event with a final state; Unity animates the tumble to that state.
- **Wasps:** rendered from sim transforms; wing animation is cosmetic.
- **Body zones:** the rendered skeleton is fitted to the sim zone capsules, not the other way round.
- **Key art and title direction:** the Italo-western and kung-fu standoff, the "death stare". Extreme close-ups cut between the wasp's compound eyes and a human's eyes, letterboxed wide, high contrast, sun-bleached palette (bone, ochre, black, wasp yellow), long silence before the strike. The title card and promo use the same grammar. Type stays the game's own: Big Shoulders Display for the title (STI with a yellow NG) and IBM Plex Mono for small text; a red brush seal reading 螫 ("sting") is the one ornament. The stare face is the main carrier; the split-frame standoff is the promo. In-game, the camera's tight framing on a perch or before a sting can borrow it, but the HUD stays plain (P1: nothing emotes; the stare is framing, not a face).

---

## 13. Data and tuning **[T1]**

- All tuning lives in versioned plain-text data files read by own parser code. No JSON library.
- Tables: `HumanTraitRanges`, `BodyZones`, `ResponseStyles`, `ClothingMaterials`, `WaspCasteStats`, `BroodTimings`, `ResourceRates`, `SeasonCurve`, `EscalationLadder`, `BeeDefense`, `ChunkGen`.
- Tuning values are parsed into fixed-point at load. The parser MUST be deterministic (no culture-dependent number parsing).
- The tuning hash goes into the world record (4.6).
- As built (18.29): one file, `tuning/sting.tune`, holds every table; the PoC and both core builds read it at start and refuse saves, input logs and peers made with a different file.

---

## 14. Testing and verification **[T0]**

- **Headless runner:** a console application that loads a world seed and a scripted event list, runs N ticks, and writes state hash streams. As built: `core/Sting.Headless` (`sting-headless run | replay | resume | compare`); an input log holds the settings and every tick's command and replays in either number build.
- **Determinism:** same seed and script MUST give identical hash streams across runs, processes, and machines (Windows x64, Linux x64, ARM).
- **Golden tests:** fixed human, zone and event → an exact expected `ReactionPlan`.
- **Property tests:** reach is always in [0, 1]; swat start is always at least the minimum consequence window after contact; generation is identical for the same inputs.
- **Network harness:** several peers in one process over a simulated link with latency, jitter and loss. Assert that all peers converge to identical human states and that remote display error stays bounded.
- **Own test runner:** no NuGet test frameworks. A small attribute-and-reflection runner written for the project, which keeps the supply chain at zero.

---

## 15. Technical constraints **[T0] [Unity]**

- Unity version to be fixed at project start. The core targets the C# 9 language level and the .NET Standard 2.1 API surface, so it compiles both in Unity and in the standalone .NET SDK.
- `Sting.Core`: base class library only (R-09).
- Unity side: Unity built-in packages only, unless a decision says otherwise (Q-05).
- Build toolchain for headless tests: .NET SDK from the OS vendor's signed archive.

---

## 16. Decisions log

| ID | Decision | Status |
|---|---|---|
| D-01 | No rollback. Owner-authoritative state sync; humans resolved deterministically from events | decided |
| D-02 | Map generated on the fly, frozen on discovery | decided |
| D-03 | Outcomes deterministic, playout cosmetic | decided |
| D-04 | No narrative, no ending, no anthropomorphism, no redemption | decided |
| D-05 | Game over only when the colony line perishes; then start again | decided |
| D-06 | Colony management plus driving individual wasps | decided |
| D-07 | Bees are a lethal counterforce | decided |
| D-08 | Humans never die from stings | proposed |
| D-09 | Fixed-point Q32.32 for all sim math | proposed |
| D-10 | Discovered chunks stored as base snapshots | proposed |
| D-11 | Engine-agnostic core assembly; Unity is presentation only | proposed |
| D-12 | No third-party code in the core | decided |
| D-13 | Three world tiers: Main, Offshoot, Personal; not one unified universe | decided |
| D-14 | World modifiers are data in the world record, never code | proposed |
| D-15 | Main runs on cell servers that route, audit and persist; no direct P2P on Main | proposed |
| D-16 | Hold to sting: press arms, first contact stings, release pulls out; full sting after 30 ticks | decided (PoC) |
| D-17 | World events have two parts: immediate (swats, sprays) and committed (human state) on an agreed tick | decided (PoC) |
| D-18 | Commit window 30 ticks (500 ms), separate from the 11-tick minimum reaction | proposed |
| D-19 | Owner decides everything about its own wasps, including swats aimed at them, and publishes it | decided (PoC) |
| D-20 | Shared decisions never read live wasp positions; events carry the positions they need | decided (PoC) |
| D-21 | Biological durations scale with season length (bio = seasonDays / 200) | proposed |
| D-22 | Every wasp, driven or AI, runs the same flight, contact, sting and swat code | decided (PoC) |

---

## 17. Open questions

| ID | Question | Proposal |
|---|---|---|
| Q-01 | Shared universe or instanced worlds? | Settled by D-13 |
| Q-02 | Real minutes per in-game day? What do players do during winter in multiplayer? | Day length settled 2026-10-23: 2-minute days by default, selectable at world creation (2/6/12), like season length (20–200 days). Winter in multiplayer still open |
| Q-03 | Limits on switching which wasp you drive | Settled in the PoC: free within 30 m; otherwise a 4 s relay to the nearest worker anywhere, or to a worker coming out of the nest |
| Q-04 | Who decides whether a swat hit a wasp? | Settled by D-19: the wasp's owner; peers audit |
| Q-05 | Own UDP vs a relay-backed platform transport | Both behind an interface; relay for release (11.13) |
| Q-06 | Setting: generic temperate, American suburbia, or real places imported from map data | Settled 2026-10-23: American suburbia. Lawns, fenced backyards, cul-de-sacs, park strips, a strip-mall edge; fits the yellowjacket meme and the US market |
| Q-07 | Multiplayer relationships: co-op inside one colony, rival colonies, or both | Settled 2026-10-23: rivals by default (separate colonies that fight over food and nest sites); co-op is opt-in, friends sharing one colony in a personal world |
| Q-08 | Target maximum players per world | Main: as many as the cell servers carry. Offshoot: host setting. Personal: small group |
| Q-09 | Counter semantics | Unique humans stung per world, all players combined; only Main's counter is canonical |
| Q-12 | Scripted code mods | Out of scope until the core is stable; data modifiers only |
| Q-13 | How offshoots are founded | Fresh seed, Main's seed, or a copied world snapshot |
| Q-14 | Can a colony line move between worlds? | No; a line belongs to its world |
| Q-15 | What happens to an offline player's colony on Main | Cell server runs it at the abstract tier (11.12) |
| Q-10 | Do lineage colonies count toward keeping the line alive? | Yes; implemented as sister nests in the PoC |
| Q-11 | Art scope for thousands of distinct humans | Open; modular bodies and clothing driven by traits. For the Unity port, consider licensed low-poly modular human packs (assets, not code; check licenses) over the PoC's capsule figures |
| Q-16 | Humans outside a peer's interest | Settled (18.9): committed interest windows; humans simulated over the union |
| Q-17 | Should the colony economy balance stores late in the season (sugar piles up)? | Settled (18.11): stores are capped at a few days of need |

---

## 18. Findings from the proof of concept (v0.3)

A three.js proof of concept implements most of this document as a browser game with a separate simulation core and headless tests (`POC.md` lists every feature and test). Building it settled several questions and changed some designs. This section records what changed; where it conflicts with an earlier section, this section wins.

### 18.1 Stinging is hold to sting (D-16)

The press arms the stinger. The first contact while the button is held stings. Releasing pulls out; holding past 30 ticks deepens the sting into a full sting (more pain, more alert points, more venom). The consequence window still starts at contact. Players learn the rhythm quickly: approach armed, touch, release.

### 18.2 World events have two parts (D-17, D-18)

Section 11.5 proposed fast-forwarding a human's plan when an event arrives late. The PoC replaces that with a simpler rule:

| Part | Contents | When it runs |
|---|---|---|
| Immediate | Swat volumes, sprays, presses under clothing, cosmetic reactions | As soon as a peer has the event |
| Committed | Panic, flight, sting counters, alert points, torn clothing | On the commit tick: event tick + 30 (500 ms), on every peer, in (commit, peer, sequence) order |

Because human state changes only on agreed ticks and from data inside the events, every peer computes identical humans. In the two-peer lab, human state matched on every check (300 of 300 per link) over links from LAN to 16±6 ticks one-way with 10% loss, with no late events. The commit window is a tuning value: it must exceed the worst one-way delay plus one redundancy interval. 500 ms leaves room for about 370 ms one-way.

### 18.3 The owner decides about its own wasps (D-19)

Preemptive swats, sprays, presses under clothing and bee alarms are decided by the peer that owns the wasp involved, then published as events. Every peer checks swat volumes only against its own wasps. A peer never decides the fate of a wasp it does not own.

### 18.4 No live wasp positions in shared decisions (D-20)

Anything that changes shared state uses positions carried in an event, never wherever a wasp happens to be on one peer's screen. Example: a fleeing human runs away from the stinger's position recorded in the sting event; contagious panic runs from the chunk's last recorded sting.

### 18.5 One code path for every wasp (D-22)

Driven and AI wasps share flight, collision, contact, stinging, feeding, carrying and death. AI workers only replace the input command. This made possession (7.7) trivial and keeps AI wasps subject to the same humans and bees as the player.

### 18.6 Colony economy as built

- Compartment model stepped once per sim second: eggs, larvae, pupae for workers and for queens; protein feeds larvae, fed larvae return sugar secretion, adults burn sugar. Sugar deficit is the unmet share of adult sugar need, smoothed.
- Abstract foragers bring income in daylight by preset (balanced, protein, sugar, build). Physical AI workers forage, catch prey, chew pulp and deposit at the nest.
- Founding queens build cells directly from pulp they deliver (8 cells per load).
- The late-summer sugar crisis emerges as designed: when the queen switches to queen cells, worker larvae disappear, secretion falls, deficit rises to 1, and AI workers turn to cans on picnic tables.

### 18.7 The yearly cycle as built (D-21)

- Biological durations scale with season length: `bio = seasonDays / 200`. A 40-day season runs brood and lifespans five times faster than nature, so a season is about an hour of play with 2-minute days.
- Queen cells from 55% of the season, all new eggs are queen cells by 72%. Young queens fly out to mate on fair days. Adult mortality climbs from 82%; the old queen dies at 95%.
- Winter: 3% of mated queens survive; 30% of sister nests survive. One survivor becomes the player's founding queen; the rest become sister nests of the line. The line ends when none survive.

### 18.8 Escalation as built

| Level | Points | What changes |
|---|---|---|
| 1 | 3 | Wasps hovering over heads or at cans get slapped (12 ticks after the decision) |
| 2 | 8 | Cans covered, citronella on tables (crop drains faster within 1.5 m), panic gain ×1.3 |
| 3 | 15 | People with high escalation trait spray; sugar-bottle traps hang from tables and drown feeding wasps |
| 4 | 25 | Within one chunk of the nest: the exterminator is booked |
| 5 | 40 | Municipal pest control: the 3×3 chunks around the hot chunk are baited for 3 days, then the area's points halve and it cannot be baited again for 4 days |

**Level 5 as built.** Bait stations hang on tree trunks at chest height (three per chunk, picked by hash). Each holds poisoned meat: a wasp that takes it carries a full protein load, and depositing it kills 8% of larvae and 3% of adults per unit instead of feeding anyone. Abstract foragers in a baited nest area bring poison home at 18% of the inside adults per day, scaled by the protein share of the colony's foraging allocation, so switching to sugar or building during a campaign is the counter-play. The campaign reads only shared state (chunk escalation and the clock), so every peer starts and ends it on the same tick; the lab confirms it on a bad link with humans agreeing at every check.

Points: sting 1, full sting +1, wasp killed by a human 0.3, swat at a hovering wasp 0.15. Points decay 25% per day. The exterminator wears a bee suit: every zone is thick except the collar on his first visit. Stinging under his collar until his panic reaches 0.8 makes him give up for the day. He returns the next morning with the collar taped. The booking is cancelled if the nest area calms below level 3.

### 18.9 Humans over the union of interest (Q-16 settled)

Each peer's interest window (the 3×3 chunks around its wasp) is itself a committed event. Every peer simulates the humans in the union of all committed windows, adds and removes them on the same tick, and freezes humans outside the union identically. In the lab, two peers working picnics two chunks apart agreed on all 63 shared humans at every check (300 of 300). Humans that leave every window stop on every peer; when a window reaches them again they catch up to their schedule deterministically.

### 18.10 Saves and joining use the same snapshot (11.10 revised)

A snapshot holds the world record, the chunk records (seed, `genVersion`, content hash) and their deltas, every live human row, the escalation state per chunk, the pending committed events, the committed interest windows and the colony. Chunk content is not stored: it is regenerated from the seed on load and checked against the stored content hash, so a generator change is caught instead of silently producing a different world. In the PoC a full save is 34 KB, and a restored world stays bit-identical to the original for 6000 more ticks of the same input.

Joining a world in progress uses the same snapshot instead of the event replay listed in 11.10 item 4. Sending the live human rows is smaller and exact, while rebuilding panic from recent events depends on events that may already have been trimmed. The joiner takes the shared part of the snapshot and starts its own colony. In the lab a peer that joined 50 s in agreed on every human at every check after joining (200 of 200). On Main the cell server sends the rows for the joiner's interest area only.

### 18.11 Stores are capped (Q-17 settled)

Vespula keep little in the nest: sugar goes to adults and prey goes straight to larvae. Uncapped, a simulated season ended with 444 units of sugar banked. The stores are now capped: sugar at 2.5 days of adult need, protein at 2 days of larval need (queen larvae count at their higher rate), each plus a small base. Anything over the cap is not collected. In the same idle season, protein now runs out when queen larvae arrive (about 70% of the season), which is when the player's hunting matters most, and the colony still raised and mated about 190 young queens.

### 18.12 Spills as built (8.9)

A seated human who starts to flee rolls once (60%) to knock over the nearest drink within 0.75 m. The can goes down for four in-game hours: it gives nothing, and a puddle beside it feeds at 1.6× a can's rate. Sugar foragers seek puddles out. The roll is a hash of the human and the tick, and spills are stored in chunk state and included in the human hash, so every peer spills the same can and the lab checks it. Lidded drinks at alert level 2 and above never spill.

### 18.13 Plausibility checks as built (11.8)

A check that drops a shared event must give the same verdict on every honest peer, or the peers diverge. So event checks read only the event and shared human state: the commit tick must equal the event tick plus the window; sequence numbers must rise; no event from more than 2 s in the future; at most four swats, each starting between the consequence window and 4 s after contact; panic gain within 0–1; the stinger within 1.6 m of the stung human, plus 3 m/s of drift for the event's age; at most six stings per wasp in 2 s. Margins are generous so honest traffic always passes; in the lab no honest event was rejected on any link. Three strikes quarantine a peer: everything from it is dropped and its wasps disappear. Live wasp positions are checked only to decide what to draw (an impossible jump is not drawn, and after four in a row the new position is accepted), which can never cause a divergence. Every peer drops implausible events, but only the host (the lowest peer id in a personal world; the host process on Offshoot; the cell server on Main) rules on a peer. Its verdict is a committed event, so all honest peers cut the cheater off on the same tick, purge its uncommitted events and drop its interest window; a verdict from anyone but the host is itself implausible. In a three-peer lab (host, honest peer, cheater) on a bad link, both honest peers cut the cheater off on the same tick and agreed on every human before and after (334/334).

### 18.14 World modifiers as built (4.8)

Modifiers live in the world's settings: day length, season length, people density, human reaction speed (scales every trait's reaction ticks, never below the consequence window), escalation rate (scales alert points), bee aggression, and switches for exterminators, pest control, birds and rival colonies. The rules hash is FNV-32 over the generator version and those settings in a fixed order, independent of the seed; the lab shows both peers' hashes side by side. The tag lists only what differs from the standard rules, so an unmodified world reads "Standard rules" and others read like "slow humans · bees ×1.5 · no exterminators". Human traits are rebuilt through the same modifier path on load, so a modified world restores exactly.

### 18.15 Nest sites as built (6.6)

Five of the six site types exist (generator 3 added garden sheds with a wall crack and an eave gap; wall 4,000 cells, discovery ×1.2; attic 6,000 cells, discovery ×0.8, best shelter). Separate shed nests (inside, not in the wall) are folded into the attic. Burrows (two per chunk) and branch points (one per tree, under the crown) are derived from the seed and the chunk's frozen content, so they cost nothing to store and every peer sees the same ones.

| Site | Max cells | Rain | Discovery |
|---|---|---|---|
| Trunk | 3,500 | adults die at the base rate (6% of those inside per rainy day) | ×1 |
| Burrow | 5,000 | 25% of brood lost per rainy day; adults ×0.4 | ×1.6 alert points in the nest's chunk |
| Branch | 1,800 | adults ×2 | ×0.5 |

The choice is the founding queen's main decision: a burrow grows the biggest colony and gets found fastest, a branch hides best and stays small. If she has not chosen by 3% into the season, she settles where the last nest was, keeping its site type.

### 18.16 Windfall fruit as built (9.4)

30% of trees (by hash) bear fruit. From 55% of the season, each drops six fruits, each on a day picked by hash across the rest of the season, scattered up to 1.6 m beyond the trunk; a fruit lies for six days and feeds at 0.8× a can's rate. Like burrows and branch points, fruit is a pure function of the seed, the chunk and the day, so it needs no storage or network traffic. Late in the season this gives sugar foragers somewhere to go other than people's drinks.

### 18.17 Dragonflies as built (9.3)

A dragonfly patrols a low loop (0.6–1.4 m) in about half the chunks. It darts at a wasp flying in the open below 2.5 m within 2.5 m of it, at 7.5 m/s (faster than a wasp's 6 m/s burst) but with only 14 m/s² of steering, so a hard turn breaks the chase; landed, perched or canopy-covered wasps are ignored. After 1.5 s it gives up and cools off for 7 s. Birds and dragonflies run through one hunter routine with different parameters, so together they make the air layered: high and open belongs to birds, low and open to dragonflies, and cover is safe from both.

### 18.18 The C# core, ported (D-11, R-04)

`core/Sting.Core` is the whole PoC simulation in C#: world generation, weather, bodies and the sting resolver, colony economy, the `Sim` itself (wasps, humans, bees, hunters, rivals, the exterminator, pest control, the yearly cycle, the AI), the network lab with its wire format and plausibility checks, and saves. It is bit-identical to the JS reference: `core/fixtures/parity.txt` holds 22 digests written by `poc/test/parity.mjs` (world, bodies, colony, five whole-game scenarios, a save and restore mid-run, two-peer labs on good and awful links, a late joiner, a cheater, and a three-peer mesh where the host rules), and the C# runner reproduces every one. The scenario digests cover every sim event and the state and human hashes once a second, so a single differing bit anywhere fails the run.

Two rules made the port mechanical: the JS sim may use only operations that are exact in IEEE doubles (its own sine, arctangent and rounding, no `Math.round`, `hypot` or `atan2`), and every map whose order can change a result is an insertion-ordered map in C# (`OrderedMap`), every sort is stable, every string sort is ordinal.

Every quantity in the core is a `Num`, and the same sources build two ways. The default build makes `Num` an IEEE double, which is what the parity harness proves against the JS. The fixed build (`-p:StingFixed=true`) makes `Num` Q32.32 fixed point on a long, which is what R-04 asks for: integer arithmetic only, so no CPU, compiler or backend can change a bit (IL2CPP on ARM64 may fuse `a*b+c` into one rounding; integers cannot). Both builds evaluate the same expression trees in the same order; sim code never does arithmetic on runtime doubles, only on `Num` and on double constants that meet a `Num`.

The fixed build cannot match the JS bit for bit, so it is held to properties and to its own record instead: a save restored mid-run carries on exactly like the run that was never saved; two peers on good and awful links, a late joiner, a cheater's victim and a three-peer mesh agree on every human at every check; and `core/fixtures/fixed.txt` locks its digests so any later change shows. Against the double build it plays the same game: over the five scenarios the first difference is one deposit landing a tick later after 14 seconds, positions until then agree within 0.003 mm, and every end figure (stings, deaths, prey caught, deposits, adults to 0.1, brood, seasons) is identical. It costs about twice what doubles cost: a busy world (ten wasps out, forty humans, the player stinging) takes 95 µs per tick in fixed point and 47 µs in doubles, under 1% of one core at 60 Hz. Most of that came from one rule the world generator keeps and a test checks: everything a chunk holds lies within 34 m of its centre, so every scan for things near a wasp skips chunks out of reach.

The C# save is binary and exact (each number as its 8 bytes, a double's or a fixed point's); it is not interchangeable with the PoC's JSON saves, and does not need to be.

The PoC's 105 headless sim checks are ported too (`Behaviour.cs`), and so are the network checks the lab digests do not already cover (`NetBehaviour.cs`: peers far apart, rival fights and a raid across peers, pest control across peers, the wire format). All 117 pass in both builds: under clothing, perching, bees, webs, birds and dragonflies, landing and walking, rivals and raids, the exterminator, pest control, spills, fruit, nest sites, seasons, switching, saves and world modifiers. In the fixed build they are the proof that every mechanic still works in Q32.32.

Porting found three bugs, fixed in both: a line that went extinct kept ticking its colony and could come back the next autumn, alarm pheromone kept relaunching attacks on a human who had gone home; and the small per-decision hash reads four inputs, so calls that passed five or six (burrow positions, branch sites, fruit, bait stations) silently ignored the rest: both coordinates of a burrow came from the same number, every fruit of a tree fell on the same day, and only early in the windfall weeks. Such calls now chain two rounds of the hash.

### 18.19 Weather and bodies as built (T1-1 to T1-5)

**Wind.** Each day's weather now also draws a wind strength (0–3 m/s, ×1.4 on rainy days) and direction. Through the day it runs from 35% of that at dawn to full strength mid-afternoon, and gusts by up to 40%. A wasp in the air flies in it: 70% of the day's wind (the air at a wasp's size, among grass and leaves), scaled by height up to full at 3 m. Revised after play (2026-10-26): its airspeed is capped at its top speed and the wind adds to it, so flat out it is faster downwind and slower upwind (on a 1.6 m/s day at 3 m: 4.2 m/s downwind, 1.6 m/s upwind, cruise 3). With no input it leans into the wind and holds its place, so precise moves stay precise; that costs energy by airspeed, like flying (about 1.5× hovering in still air on that day). A wind stronger than its top speed (a gusty rainy afternoon, high up) carries it off. A wasp hugging the grass is barely touched. AI wasps fly the same model. Falling wasps are carried with the air. Wind is a pure function of seed and clock, so peers agree without sending it.

**Body temperature.** Flight is now gated by the wasp's own temperature, not the air's (POC.md design change 8). Body temperature relaxes toward a target over about five seconds: the air plus 12 °C in powered flight, 31 °C on human skin or under clothing, the ball's heat inside a bee ball, and otherwise the air, plus 8 °C when the wasp shivers. Shivering costs half the sugar of hovering and only works above 8 °C of air. Take-off needs 18 °C. Below 8 °C the wasp is torpid; 90 s of torpor kills it ("cold"), and it recovers if it warms first. The season adds its own swing to the daily weather: springs start up to 6 °C colder (fading out over the first quarter of the season) and autumns cool by up to 7 °C over the last fifth. Body temperature is part of the state hash and the save.

**Drowning in a drink.** Feeding at an open can carries a 3% chance per second of slipping in. The wasp has 4 s; each burst press climbs 30% of the way, and an AI wasp gets out with a small chance each tick. Climbing out leaves it stunned and slightly fuller. Cans are lidded from alert level 2, which also ends this risk.

**Clothing by temperature.** The day's base temperature picks the mix: on cool days (below 20 °C) 35% jackets and 65% jeans; on hot days (25 °C and up) 3% jackets, 50% tank tops and 55% shorts; between, the old mix. Still `Hash(seed, Clothing, id, day)`, now read through the day's weather, so every peer dresses everyone the same.

**Shake and flail.** A new swat kind, Shake: 16 cm around the contact point, a 10-tick window, stuns and never kills. Flailers and runners shake where others brush (face) or slap (scalp). A runner who flees also flails: a 20 cm sweep 8 ticks after the first swat, 12 ticks long, that stuns. Both are part of the pure resolver, so the plan stays identical on every peer.

All five are in the C# core with parity: the 22 JS digests still match in the double build, the fixed-point build's lock is regenerated, and 130 properties hold in both (13 new).

### 18.20 Sight and memory as built (T1-17, T1-18)

**Panic by line of sight.** Contagion now passes only between people who can see each other: anything taller than 1.3 m (sheds) and tree trunks block the line between them. The check reads chunk content as a pure function of seed and coordinates, generating a chunk it has not discovered rather than skipping it, because peers discover different chunks and must still agree on every human.

**Memory by recency and place.** Each person keeps their last eight stings with the minute and the spot. How wary they are is the sum over those stings of a weight that falls linearly to zero over two days, counted in full within 4 m of where it happened and at 35% elsewhere. The sting resolver reads that wariness where it used to read the plain sting count, so the hand comes faster and the panic higher at the table where they were stung, and less on the far side of the park or two days later. Remembered stings are shared human state: they are written at the sting's commit tick on every peer, and they travel in saves (save version 4).

### 18.21 Hollow trees, nest thermals and solo time as built (T1-14, T1-23)

**Hollow trees.** About a third of trunks at least 22 cm thick have a hollow 0.7–1.9 m up, derived from the seed like burrows and branch points, so it costs nothing to store and every peer sees the same ones. A queen founds a nest in one with E: up to 4,500 cells, little exposure to rain, rarely noticed (discovery ×0.7). The PoC draws hollows as dark knot-holes on the trunk.

**Nest thermals.** Every site has an insulation value (branch 0.15, trunk 0.4, attic 0.55, wall 0.6, burrow 0.8, hollow 0.85). Brood develops at full speed between 18 and 31 °C; below, it slows by up to the whole share over 12 °C, above by up to 70% over 8 °C, scaled by how much of the weather the site lets in, with a floor of 15% speed. An attic gains up to 7 °C under a sunny afternoon roof, so the biggest site is also the one that bakes. A wasp nest regulates its own temperature, so this is a slowdown of the brood rather than a death: cold springs hold a founding queen back, hot spells cost an attic colony. The colony view shows brood speed. When the player rests through the night, each skipped step uses that step's temperature.

**Solo time.** In a solo world the colony view (N) runs time at 1×, 4× or 16× (T cycles). Anything aimed at the driven wasp (a swat, a web, bees, a bird, a drink, a fight) drops it back to 1×. Reflex, an option in the pause menu and on by default, runs the wall clock at a quarter for 0.9 s when a hand is scheduled against the driven wasp, or when its own sting sets swats coming. Both change only how fast the wall clock feeds ticks to the sim: recorded input, replays and saves are untouched, and shared worlds never change speed (7.8).

### 18.22 Fetching spray and the exterminator's search as built (T1-6, T1-7)

**Fetching spray.** Nobody has insecticide on them. At level 3, a person with a high escalation trait who gets stung goes for a can once things calm down: they finish fleeing, sit back down, then get up, walk off to where they came from, are out of sight for 15 s, and come back with a can good for six sprays. Only then do they spray a wasp hovering in front of them. A green can in the hand shows who is armed. The decision to spray is local to each peer, as swats are; the can empties when the spray event commits, so every peer counts the same sprays.

**The exterminator searches.** He no longer walks straight to the nest. He parks near where people were stung most around the nest (or where his last flight line took him on an earlier visit, or the edge of the area) and watches. Flight lines come at a rate set by the colony's foragers in the air (scaled down by a well hidden site, and zero at night, in rain and in cold), and by distance: lines radiate from the nest, so the closer he stands the more cross his view. Any of the colony's wasps flying within 8 m where he can see it is a line of its own. Each line he sees, he walks 7 m along it toward the nest, landing up to a third of the remaining distance off to one side. Within 4 m, the next line shows him the entrance and he treats the nest as before. At dusk he gives up for the day and comes back the next morning to his last line; the escalation decay can cancel the booking in between. A nest he has found once he walks straight to on the next visit.

**Lying low.** A fifth foraging preset, *Lie low*, keeps all three income shares but sends out only 35% of the foragers: income, physical AI foragers, bait taken home during a pest control campaign and the lines the exterminator sees all drop with it. With a large colony at 2-minute days, an unopposed exterminator finds the nest on the second or third visit; lying low, he gives up twice and the booking lapses.

**The exterminator is one colony's business.** His search reads that colony's traffic and wasps, so peers sharing a neighbourhood can see different exterminators doing different things. The lab therefore leaves him out of the agreement check on shared humans, his panic does not spread to shared humans, and the human step runs over a snapshot of the list so his leaving mid-step cannot shift anyone else's step. A shared exterminator, called by the neighbourhood and searching for every colony in it, is a question for the multiplayer design (Q-07).

### 18.23 Worker ages and guards as built (T1-13)

**Young workers.** The colony keeps a count of young workers: every worker that emerges joins it, and it drains at one part in four days (bio-scaled), so a new worker spends her first days inside nursing and building. Only workers past that age forage, in the abstract economy and as physical AI foragers. A burst of emergence therefore shows up as foraging income a few days later, and an exterminator counting flight lines sees the mature foragers only.

**Guards.** Once a colony has at least 25 mature workers, the first two physical wasps it sends out while the player is near the nest are guards. They circle a few centimetres outside the entrance, refuel there, and go in at night like the others. A rival wasp, or another player's wasp, within 0.6 m of the entrance is chased (up to 2.5 m out, for 5 s) and grappled on contact with the existing fight rules: a rival on the same peer fights locally; another player's wasp fights through the remote fight exchange, which the guard's peer starts and both peers resolve identically. Guards also go for the exterminator when he comes within 1.5 m of the entrance, stinging him with the same attack AI as alarm pheromone. Guards do not count against the cap on physical foragers. Other players' wasps are fair game because Q-07 makes separate colonies rivals by default; co-op colonies (opt-in) will exempt each other when co-op exists.

### 18.24 Winter with choices as built (T1-15)

**Hibernation sites.** Around the nest (its 3×3 chunks, within 40 m) the world offers four kinds of winter shelter, all derived from the seed: a crack in a shed wall (shelter 85%), a hollow tree (75%), loose bark low on a thick trunk (50%) and the leaf litter at burrow spots (30%).

**Scouting.** From the mating season on (once the colony has gynes or mated queens), a worker pressing E at one of these sites scouts it. At the season's end 60% of the mated gynes winter there; the rest spread evenly over five other sites picked by hash. Each site wakes `mated × share × 6% × shelter` queens, rounded with a seeded fraction, so a scouted hollow tree wakes several times as many as the leaf litter.

**Waking.** When the season ends the colony sleeps: the wasps go, and the game shows one choice per site that woke a queen (how many, what kind of shelter, how far from the old nest, and whether it is the scouted one). The choice is sent as an ordinary recorded command, so replays and saves keep it; a world saved in winter restores asleep. Left alone (bots, the lab), the site with most survivors wakes after 30 s. The chosen queen wakes at her site, which is where the next season starts, with sugar reserves scaled by her site's shelter (×0.5 to ×1.35). The other survivors found sister nests as before. If no own queen survived but sister nests did, you wake in one of them. A queen who never founds a nest settles in the nearest tree to where she wintered.

### 18.25 Landing on any surface as built

A slow wasp with no input settles on the nearest static surface within 12 mm of its body, whatever its orientation: the ground, any face of a box (table tops and their undersides, bench sides, sheds, hive boxes), tree trunks (side and top), flower stalks and heads, and the colony's own hanging paper nest. The surface is found by a nearest-point query on the frozen chunk geometry, like perching on a person uses the body's capsules, so every peer agrees; branches will join as capsules when the world has them.

On a surface the wasp keeps its own heading along it. Mouse left and right turn it about the surface normal, exactly as yaw turns it on flat ground, whatever the surface's angle; W and S walk along the heading, A and D across it; the camera's up follows the surface, so a trunk or the underside of a table plays like the ground. Landing takes the camera's direction laid on the surface; walking onto a surface at another angle carries the heading over by the smallest rotation between the two normals; taking off hands the heading back to the flight camera. After each step the wasp is put back on the nearest surface, so it follows round the edge of a table onto its side and underside, climbs a trunk it walks into, and never falls off. Only Space (climb) or Shift (burst) take off, pushing away along the surface normal, with half a second before it can settle again. A sting while landed reaches a person whose body is within 4 cm (a leg beside the bench, an arm on the table) and starts the sting there; with nobody in reach it does nothing. Landing at the nest entrance delivers the load as flying in does. The wasp's body and the chase camera follow the surface normal, on surfaces and on people alike.

### 18.26 Hollow cups as built

Every can on a table is a hollow cup: a 3 mm wall, open at the top, holding a drink between a third and nearly full (by hash, so every peer sees the same levels). The walls stop a wasp from the side; it gets in over the rim. It feeds anywhere within reach of the drink's surface: hovering just above it, or gripping the inner wall nearby. Touching the drink pulls it in (flying too low, or walking down the wall into it), and a feeding wasp can still slip in; mash Shift to climb out over the rim. Someone within a metre who notices a wasp inside their cup puts a hand over it (a committed event, so every peer covers the same cup on the same tick) for ten seconds, and a wasp shut in a covered cup drowns in five. At level 2 the cups are lidded, which keeps wasps out and drowns any already inside. AI foragers go in from above and hover just over the drink. Resting on a flower head feeds as at a cup, and the HUD shows it.

### 18.27 Seasonal ecology as built (T1-8)

**Flowers.** Each of the five flower kinds blooms in its own part of the season (from the first fifth to just before the end, overlapping), each flower a few days either side by hash. Out of bloom a flower gives nothing: a green bud before, a brown head after.

**Nectar.** A flower in bloom starts full, a sip takes a quarter of it per second, and it regrows at three fills a day, less 1.5 a day for each forager bee whose round includes it; flowers near a hive are drained to nothing. The ecology tick of 3.3 is evaluated lazily: a flower's level is the level at its last sip plus the net regrowth since, so nothing runs for flowers nobody visits and every peer computes the same level from the same sips. Sips by another player's wasps arrive as immediate `sip` events in tenths. AI sugar foragers skip flowers out of bloom or nearly dry.

**Prey.** Caterpillars are about from early to mid summer (each a few days either side by hash); flies are fewer early and commoner late, each one present on a given day by hash. Carrion turns up in a chunk on about one day in five, lies three days, and gives four loads of meat (1.5 protein each) to E or to AI hunters.

**The abstract colony.** Abstract foraging income follows the same calendar: sugar ×(0.5 + 0.9 × share of flower kinds in bloom, + 0.35 once fruit falls), protein ×(0.5 + 0.35 while caterpillars are about + 0.4 × the fly share). Averaged over the season both are about 1; late in the season both drop, which is when real colonies turn to people's food. The colony view shows the current multipliers.

### 18.28 Feral hives and robbing as built (T1-9)

**Wild colonies.** One hollow tree in five and one shed-wall crack in four hold a wild honeybee colony, derived from the seed at the sim level like the nest sites (the chunk generator and old worlds are unchanged). A wild hive behaves like a managed box: six guards circle the entrance, ten foragers work the chunk's flowers (and drain them, 18.27), and anything at the entrance rouses it. A hollow or crack the bees hold is not a nest site or a winter site. The PoC marks a wild entrance with a smear of amber comb.

**Robbing.** E at any hive entrance, wild or managed, takes the wasp inside and rouses the whole hive. The grab fills over three seconds, a twentieth faster for each sting press; every second inside there is a 15% chance the bees inside kill it ("stung inside a hive"). Space or Shift bails out with nothing. Done, the wasp comes out with a full crop of honey (sugar for the colony on deposit) and a bee larva (2 protein), into a hive whose guards are already in the air, so the balling of 9.2 is the price of getting home. A hive gives three loads a day (shared between peers through the `caught` event). AI sugar foragers rob only when the colony is short of sugar; a wasp inside a hive cannot be balled until it comes out.

### 18.29 Tuning as data as built (T1-22)

**One file.** Every tuning value of the sim, about 450 of them from wasp radius to the escalation ladder, the allocation presets, the nest site types and the bloom windows, lives in `tuning/sting.tune` at the root of the repository. The format is the plainest that does the job: `# comments`, `[section.sub]` headers, and `key = value` lines where a value is a number, `true` or `false`, a `"string"` or a `[list]` (lists nest). A number in a path indexes a table of tables (`[alloc.0]`). Numbers are written the way JS prints doubles (shortest round trip), so JS and C# read back the same bits; C# parses with the invariant culture, and the fixed-point build converts the doubles to Q32.32 as it always did for its built-in values.

**Own parsers.** `poc/sim/tunefile.js` and its port `core/Sting.Core/Tune.cs` read the file with no library. The code keeps its tables in the same shape as before (`T.wasp.radius` in both), so nothing else in the sim changed: the parser walks the path and sets the value. JS checks each value against the kind of the default it replaces; C# finds the field by reflection and converts to its type (`Num`, `int`, `long`, `bool`, `string`, arrays). Both report the keys the file has that the code does not and the keys the code has that the file does not set, and the tests insist on none of either; a malformed line or a value of the wrong kind is refused. The C# tables became plain statics (they were read-only) and a few were reshaped so the two sides have the same keys: bird and dragonfly hunters split into their own tables, winter site names joined the data.

**Fixed by the world format.** The chunk size is baked into every world record and captured when the modules load, so the file may restate it but not change it.

**The hash.** The tuning hash is FNV-1a over the file's UTF-8 bytes with carriage returns dropped (so a Windows checkout gives the same hash), the same function in both languages. It joins the rules hash peers compare, so two players with different files do not match rules (4.6); JS saves and the core's binary saves (format 12) record it and will not load under a different file; the headless runner's input logs (format 2) record it and a replay under a different file is refused. The pause screen shows it.

**Who reads it.** The browser game fetches it from beside the page before anything uses the tables and falls back to the built-in values if it is missing; `serve.mjs` serves the repo's `tuning/` folder there. The JS tests, the parity writer, the C# test runner and `sting-headless` (which looks up from its working folder, or takes `--tune file`) all read the same file, so the 22 parity digests and the fixed-point lock are unchanged by the move.

**Tuning in practice.** Change a value in the file and rerun: the PoC picks it up on reload, the tests and parity run against it, and the hash tells every save and peer that the rules changed. The built-in values stay in `tuning.js` and `Tuning.cs` as the reference the file was generated from; the file wins when present.

### 18.30 Senses for AI wasps as built (T1-16)

**No more perfect knowledge.** Before, an AI forager picked the nearest food anywhere in the nine active chunks. Now it knows only what it can sense from where it is, what it remembers, and what nestmates bring home. Pulp foragers still know the wooden boxes round the nest (landmarks, not food).

**Scent.** Every food source has a scent strength, and a scent of strength 1 reaches 8 m in still air. Wind stretches it: a wasp straight downwind smells it up to 60% further, one upwind 60% less (at 2 m/s, scaled by the day's wind). Strengths: an open drink 1.6, a flower 1 times its nectar (so drained and faded flowers do not call), a spill 2 fading as it dries, fallen fruit 1.2, a trap 2, a hive's honey 1.2, a caterpillar 0.5, carrion 1.5 plus 0.5 a day as it ripens, a bait station 4. A covered or knocked-over can and traps that are not out (below level 3) have no scent. Each is a point source whose strength is a pure function of the source and the clock (3.3), so every peer computes the same field. Alarm pheromone is a scent too: it reaches the full 6 m when fresh, half that as it fades, further downwind.

**Sight.** Flies move, so they are seen, not smelled: within 5 m inside the forward cone (about 60° either side of the direction of flight) or within 0.5 m in any direction. A hovering wasp sees only what is close.

**Choosing.** Of what it senses, a forager takes the source with the lowest distance over reach, plus a per-wasp, per-day jitter so foragers spread out. The AI's choices stay as before: drinks, traps and hives only when the colony is short of sugar, no drinks once people put lids on (level 2).

**Searching.** A forager that senses nothing searches: it flies a widening spiral round its nest at 2.2 m/s and 1.2 m up, the rings 5 m apart, sniffing every quarter second, and goes home after 30 s or 45 m out. A searching wasp zigzags, so the exterminator gets no flight line from it (8.10, T1-7). Rival workers search round their own nest the same way.

**Memory and the scent brought home.** A forager that gets food home remembers the source and goes back to it while it still pays (site fidelity); a hunter remembers the table where flies gather, not the fly. Its load also carries the scent to the nest: for the next minute of play (half a game day at the default two-minute day), a forager of the same kind leaving the nest heads for that source. *(bio: Vespula return to profitable sites and learn the odour of food that nestmates bring home; Jandt & Jeanne 2005.)*

**The player's nose.** The scent markers round the crosshair (10.2) now come from the same function: the strongest sugar and meat scent in reach and which way it lies, carried by the wind, plus alarm pheromone and roused hives. Flies are not on it; you see them.

**Effect.** With an idle player over ten minutes of play, foragers bring home about the same sugar (seed 1234: 29 against 32) and about half the protein (57 against 110, which was well above what the brood needs), and they stay within about 15 m of the nest instead of crossing the map; a fifth to a third of forager time is spent searching. All of it is tuning in `tuning/sting.tune` (`[sense]`).

### 18.31 Barbecues as built (T1-10)

**Grills.** About a third of picnic tables have a kettle grill 1.1 m past one end (the end away from the sugar trap), unless a tree or a box is in the way. Like the nest sites and feral hives, grills are derived from the seed at the sim level, so the chunk generator, its version and old worlds are unchanged. A grill is a solid drum to the grate (0.82 m), so wasps bump into it and can land on it.

**The day.** On a warm (19 °C at 1 pm), dry day, half the grills have a barbecue, cooked by the first person seated at that table, if they are in the park that day. It is lit at lunchtime, or once the cook has had time to walk in and sit down if that is later, for up to three hours, and goes out 20 minutes before the cook leaves; a day that leaves less than an hour has none. People walk in real time while the clock runs fast (at the default two-minute day the walk in from the path takes four game hours), so the timing follows the cook's own day. Rain puts it out while it falls.

**The cook.** While it is lit the cook leaves the seat, walks to a spot behind the grill and stands facing it, and goes back to the seat when it goes out. Panic sends the cook running like anyone else; calm again, they sit down and then go back to the grill. Every peer computes the same from the clock, so no events are needed.

**Meat.** While it is lit there are four loads of meat on the grate; 40 minutes after it is lit a plate with six loads goes on the table, and stays until an hour after the grill goes out, or until people put things away at level 2. E within 4 cm takes a load (1.5 protein), shared between peers through the `caught` event like carrion; loads reset each day. AI hunters smell it from far off (scent 3, 18.30) and go for it like any prey.

**The conflict.** People guard the meat from the first visit: a wasp within 30 cm of the grate or the plate gets slapped at a little sooner than over a drink (reaction ×0.8), and it is a slap that kills, even at alert level 0, where elsewhere people only brush. The grate burns on contact ("burned on a grill"). The air over a lit grill is hot (70 °C at the grate, cooling to the air temperature 60 cm up, within 35 cm of its centre): body temperature climbs within a second or two, and at 46 °C the wasp is "cooked over a grill". Taking from the grate means diving in, grabbing, and getting out. The HUD shows the body temperature in red and "Over the grill" while it is hot.

**In the PoC.** A black bowl on three legs with a wire grate; glowing coals and smoke that drifts with the wind while lit; sausages on the grate and on a white plate, one for each load left.

**Effect.** Over three days with an idle player, seed 7 (two grills) had three barbecues, ten loads of meat taken, six slaps at wasps by the meat and a wasp or two lost to the grill; seed 1234 (one grill) had two. All of it is tuning in `[bbq]`.

### 18.32 Chunk authority and contested pickups as built (T1-19)

**The election.** For each chunk, the peers whose committed interest is within the active window of it (one chunk either way) are candidates, and the one with the smallest `Hash(seed, WorldGen, chunk, peer, 0xA11CE)` is its authority (A.9; ties go to the lower peer id). Interest is committed state, so every peer elects the same authority without messages, JS and C# agree, and a peer arriving or leaving moves only the chunks it wins or loses. Quarantined peers are never elected.

**What is contested.** Anything only one wasp can have: a fly (until it respawns), a caterpillar, a bee, and a load of carrion, barbecue meat or hive honey. Flowers, fruit, spills and bait are not; everyone can feed at once.

**Claims.** A pickup happens at once on the picker's screen, so there is no lag in play. On the authority's peer it is final and is published as before (`caught`). Elsewhere it is also a `claim` addressed to the authority. The authority checks its own state: if the thing is still there it applies the pickup and publishes `caught` for everyone, marked as granting that claim; if not, it publishes `denied`. First to reach the authority wins, and the authority's own wasps reach it first. On `denied` the claimant undoes its share of a load count, and its wasp lets go if it still holds the item ("Another player's wasp got the caterpillar first"); an AI wasp goes back to choosing. A claim that gets no answer in two seconds (the authority left) stands. Claims are not saved; a joining peer starts with none.

**Checked.** Two peers whose wasps take the same caterpillar on the same tick both see it taken; the authority's wasp keeps it, the other lets go, and both peers have it gone. With one load of carrion left, one wasp gets it and both peers count it taken once. The five network parity runs now include claims and rulings, and the C# port reproduces them bit for bit. The lab panel shows who rules the chunk you are in and any claims waiting.

**Limits.** A wasp that deposits its load at the nest before a denial arrives (it would need to be within a few hundred milliseconds of home) keeps it. Honey eaten during a lost robbery stays eaten; only the brood goes back. Chunk deltas and late-event corrections do not go through the authority yet.

### 18.33 Relevance tiers as built (T1-21)

**Per receiver.** Each peer decides, for every other peer, how often that peer hears about each of its wasps, judged from where the other peer's own wasp is (from the driven wasp id it announces in its state packets, or the middle of its interest chunk until it has one). Every packet carries a recipient; the labs route by it.

| Tier | Which of my wasps | How often | Packet |
|---|---|---|---|
| Driven | the one I drive | 20 Hz (every 3 ticks) | state: 19 bytes, position, velocity, state, carry |
| Near | AI wasps within 50 m of the other player's wasp | 10 Hz | state, as above |
| Mid | AI wasps within 3 chunks of it | 3 Hz | swarm: per chunk a 9-byte header (chunk, base id, count), then 9 bytes a wasp (id offset, position, state, queen, rival) |
| Far | the rest | 1 Hz | traffic: 6 bytes per chunk with the number of my wasps out there |

The driven wasp stays at the rate the lab tuned the remote view against (20 Hz rather than the 30 in the table above). State packets also list the sender's driven wasp and the wasps that are gone since the last one, so a receiver drops those at once; a wasp missing from a packet may only have changed tier, and goes after its tier's timeout (0.75 s for state, 1.25 s for swarm). A receiver works out a swarm wasp's velocity from its last two positions, so it is still drawn moving between packets. Traffic counts are kept per peer for the presentation (not drawn yet).

**Nothing shared depends on it.** Shared decisions never read live remote positions (11.5), so the tiers change only what each player sees and what local AI reacts to (guards at the entrance react to wasps near them, which are near-tier for whoever drives them). Humans agree on both peers in every run, and the C# port reproduces the five network parity runs bit for bit with the tiers in place.

**Measured.** A colony of 600 with 200 foragers sent out at once (143 still out after a minute), over the good link, peer A's upstream:

| Where player 2 is | Every wasp at 20 Hz | With tiers |
|---|---|---|
| At the nest, among them (137 near, 6 mid) | 51.2 KB/s | 25.4 KB/s |
| 150 m off (all mid) | 51.2 KB/s | 5.2 KB/s |
| 400 m off (all far) | 51.2 KB/s | 1.4 KB/s, of which 1.1 is the driven wasp |

The ordinary lab colony (23 wasps) now sends 2.8 KB/s instead of 4.8. Two players among each other's foragers is the expensive case; there the near rate is the lever (5 Hz would halve it again).

### 18.34 Regions as built (T1-12)

**The layout pass.** A region is 8×8 chunks, laid out from the seed before any chunk in it (Q-06: American suburbia). One row of chunks is a park strip; in the home region it is the row through the home chunk, so the home park and the parks east and west of it play as before. Three chunks along one edge are a strip mall. A 2×2 corner is forest edge. Everything else is suburban yards. In the home region that is 49 yards, 8 park, 3 mall and 4 forest chunks. `landUse(seed, cx, cz)` is a pure function, so a chunk can ask about its neighbours (a street ends in a cul-de-sac where the next chunk is not yards). The generator version is now 4, so worlds saved before this do not load.

**Yards.** A street (with sidewalks) runs east–west through the chunk. Two lots on each side, each with a house set back from the sidewalk (5–6.5 m tall, its door to the street), and a fenced backyard: cedar fences 1.5 m high along the back and the sides, in sections of up to 4 m. A backyard may hold a patio table with people at it (and so drinks, a trap at level 3, and a grill on a barbecue day, 18.31), a flower bed along the back fence, a garden shed in a corner, a yard tree, a bee box, and people chatting on the front lawn. On average a yards chunk has 3.6 houses, 2.3 patio tables, 9 people, 21 flowers and a tree.

**Houses** are sheds at a larger size and not wood: their walls and eaves are nest sites (wall and attic), wild bees can take a wall, and young queens can winter in them, exactly as with garden sheds. They block sight (8.9), and so do the 1.5 m fences, so people in one backyard do not see a wasp in the next.

**Strip malls** are a long low building on the region's edge facing in (storefront glass, a red fascia), a lined parking lot in front, and two picnic tables of outdoor seating by the doors with drinks and people. **Forest edge** is 16–26 trees, a few flower patches and no people: good for caterpillars, hollows and webs.

**Pulp runs out.** Every wooden box (fence section, table, bench, garden shed) holds 1.5 loads of pulp per metre of its longest side, at least two; a 4 m fence section holds six. Each load taken is a chunk delta (`pulp` in the chunk state), saved with the world and claimed through the chunk authority like any pickup (18.32), so two players cannot strip the same board twice. A stripped section is not offered for chewing and pulp foragers go past it to wood that has some left; the PoC draws it greyer as it is stripped. Trees never run out.

**Found on the way.** An event that reached a peer on its commit tick, after that tick's commits were applied, was applied one tick late without being counted as late; it is now counted (and the late-event log no longer overwrote its own type). Past the commit window (the awful link) such an event can still make the peers' humans diverge from that tick on; correcting it is the chunk authority's job (11.6) and not built. The test bot that stings anyone seated now has to get past houses and fences, so the behaviour checks aim it at the home park.

---

## 19. Feature tiers and the current stack

The current stack is the three.js PoC (playable, `poc/`) plus the C# core (`core/`), kept bit-identical by the parity harness. There is no Unity project yet and no server. The PoC is where features are built and played; each feature is then ported to the core and proven against the PoC's digests.

### 19.1 Tier 0: built

Everything in `POC.md` (85 features) and its C# port (18.18), including the Tier 1 items built so far: T1-1 wind, T1-2 cold, T1-3 drowning in a drink, T1-4 clothing by temperature, T1-5 shake and flail (18.19), T1-17 panic by line of sight and T1-18 memory by recency and place (18.20), T1-14 hollow trees and nest thermals and T1-23 solo time (18.21), T1-6 fetching spray and T1-7 the exterminator's search (18.22), T1-13 worker ages and guards (18.23), T1-15 winter with choices (18.24), T1-8 seasonal ecology (18.27), T1-9 feral hives and robbing (18.28), T1-22 tuning as data (18.29), T1-16 senses for AI wasps (18.30), T1-10 barbecues (18.31), T1-19 chunk authority and contested pickups (18.32), T1-21 relevance tiers (18.33), T1-12 regions (18.34). In short: the 60 Hz deterministic sim, chunked world frozen on discovery, humans with traits, zones, reach, swats, panic, clothing and garments, the colony economy and yearly cycle, every wasp on one code path, stinging, perching, walking, under-clothing play, escalation levels 0–5 with the exterminator and pest control, bees, webs, birds, dragonflies, rival colonies, nest sites, fruit, spills, saves, world modifiers, and peer-to-peer play in the lab with committed events, owner authority, plausibility checks and host rulings.

### 19.2 Tier 1: next, on the current stack

| # | Feature | GDD | Size | Depends on |
|---|---|---|---|---|
| T1-1 | **Built (18.19).** Wind: a daily wind field from the weather hash, pushing wasps in flight and swaying trees; calm in the morning, stronger in the afternoon | 5.3, 7.2 | S | |
| T1-2 | **Built (18.19).** Cold: a wasp grounded below the flight temperature away from the nest chills and dies; body temperature on the HUD | 7.1, 7.5, 10.2 | S | |
| T1-3 | **Built (18.19).** Drowning in a drink: a wasp feeding at an open can may fall in and has a few seconds to climb out | 7.5 | S | |
| T1-4 | **Built (18.19).** Clothing by temperature: jackets and jeans on cool days, tank tops and shorts on hot ones | 8.8 | S | |
| T1-5 | **Built (18.19).** Shake and flail: a human stung on the head shakes it (dislodges, no kill); runners swat wildly on the way out | 8.5 | S | |
| T1-6 | **Built (18.22).** Fetching spray: at level 3 a stung human walks off and comes back armed, instead of having spray on hand | 8.6, 8.10 | M | |
| T1-7 | **Built (18.22).** The exterminator searches: at level 4 he walks the area watching wasp traffic and finds the nest from flight lines; a colony that keeps traffic low near people buys time | 8.10 | M | |
| T1-8 | **Built (18.27).** Seasonal ecology: flowers bloom and fade by season, nectar is drawn down by bees and wasps and regrows in an ecology tick (0.2 Hz); prey by season; carrion appears | 9.4, 3.3 | M | |
| T1-9 | **Built (18.28).** Feral hives and robbing: hives in hollow trees and walls; a wasp that gets inside takes honey (sugar) as well as brood | 9.1 | M | |
| T1-10 | **Built (18.31).** Barbecues: grills as human anchors with meat, a protein source at people's tables and a new kind of conflict | 4.3, 6.2 | M | T1-11 helps |
| T1-11 | Human days: walk and lie postures, people strolling on paths, sunbathers lying on the grass, gardeners; the schedule picks the activity by weather and traits | 8.2, 8.3 | L | Q-06 for the paths |
| T1-12 | **Built (18.34).** Regions: an 8×8 chunk layout pass (park, gardens, houses with fences, farmland, forest edge) under the chunk pass, with pulp from fences that runs out (a chunk delta) | 4.2, 4.3, 4.5 | L | Q-06 |
| T1-13 | **Built (18.23).** Worker ages and guards: young workers stay in, older ones forage, the oldest guard the entrance and attack intruders (rivals, raiders, other players' wasps) | 6.5 | M | Q-07 for players |
| T1-14 | **Built (18.21).** Hollow-tree nest site and nest thermals: site insulation sets how cold snaps and heat slow the brood | 6.6 | S | |
| T1-15 | **Built (18.24).** Winter with choices: gynes pick hibernation sites whose quality sets winter survival; in spring the player chooses which surviving queen to continue | 6.7 | M | |
| T1-16 | **Built (18.30).** Senses for AI wasps: scent fields (sugar, protein, alarm) as decaying point sources and a vision cone, replacing the AI's perfect knowledge of every food source | 7.3 | M | |
| T1-17 | **Built (18.20).** Line of sight for panic: contagion only between humans who can see each other | 8.9 | S | |
| T1-18 | **Built (18.20).** Per-human memory: recency and place, so a person stung at this table is jumpy here and calmer elsewhere | 8.10 | S | |
| T1-19 | **Built (18.32).** Chunk authority and contested pickups in the lab: rendezvous hashing picks one peer per chunk to settle two wasps grabbing the same caterpillar | 11.6 | M | |
| T1-20 | Remaining plausibility checks: carry limits, positions inside solid geometry, chunk deltas consistent with their cause | 11.8 | S | T1-12 for deltas |
| T1-21 | **Built (18.33).** Relevance tiers in the lab: near, mid and far wasps at different rates, swarm packets; measure bandwidth with a 200-worker colony | 11.12 | M | |
| T1-22 | **Built (18.29).** Tuning as data: the tuning tables as versioned plain-text files read by own parsers in JS and C#, and the tuning hash in the world record | 13 | M | |
| T1-23 | **Built (18.21).** Solo time: accelerate time in the colony view, and the Reflex slowdown as a solo option | 5.1, 7.8 | S | |

Sizes: S a day or less, M a few days, L a week or more. Order agreed 2026-10-23: the small mechanics first (T1-1 to T1-5, then the other S items: T1-14, T1-17, T1-18, T1-23, all done; T1-20 waits on regions), then the M items (T1-6 to T1-10, T1-12, T1-13, T1-15, T1-16, T1-19, T1-21 and T1-22 done; T1-11 human days and T1-20 remain); each batch is built in the PoC and then ported to the core with parity.

### 19.3 Tier 2: later

Water as a resource (6.2); extreme weather; town centers and beer gardens; lineage colonies played by AI as real colonies (6.7); males as wasps; the Reflex skill tree (7.8); feature modifiers that need the bigger generator (biome mix, town density, terrain); colonies of thousands of wasps out at once.

### 19.4 Not on the current stack

**Needs Unity [Unity].** The presentation contract (12): hands brought to the impact point by IK and time-warped clips, skeletons fitted to the zone capsules, the Unity physics rule, wing animation; the Unity version and packages (15); art scope for thousands of humans (Q-11). The PoC keeps its stand-ins: capsule humans with two-bone arm IK that reaches the impact point at the impact tick.

**Needs servers or a real network [Infra].** The persistence node (4.6), Main and Offshoot hosting (4.7, 11.11), the canonical counter (8.11), rendezvous, hole punching and relay (11.7), clock sync between machines (11.9), the transport (11.13), offline colonies on Main (Q-15). Everything these carry is exercised in the network lab over simulated links. A browser-to-browser test over WebRTC on a LAN is possible without servers and could come before Unity if real latency data is wanted.

**Built differently from the text.** Sine and cosine are a polynomial on exact operations, not a lookup table (3.4); entity IDs carry no type bits and storage is ordinary lists sorted by ID (3.6); collision is three substeps per tick rather than the swept Tarmac Lab collision (7.2); bees and hunters run at 60 Hz rather than 20 Hz (3.3); the test runner is a plain program rather than attribute-driven (14). None of these block anything; each can change when the Unity port needs it.

### 19.5 Open questions that gate Tier 1

- **Q-06 setting**, settled: American suburbia. T1-11 and T1-12 build lawns, fenced backyards, cul-de-sacs, park strips and a strip-mall edge.
- **Q-07 players**, settled: rivals by default, co-op opt-in. Guards (T1-13) attack other players' wasps; friends can share a colony in a personal world.
- **Q-02 default day length**, settled: 2-minute days by default, chosen at world creation.

---

## Appendix A — Protocode

Compile-checked with the .NET 8 SDK at language level C# 9, warnings as errors, zero packages. `Fix64` multiply and divide were checked against exact decimal arithmetic over 200,000 random cases (within one unit of the last place). `StingResolver` was run over 20,000 generated humans to confirm the minimum consequence window holds. Specification-grade: correct in intent and structure, not tuned or optimized. Production code will be written per deliverable.

### A.1 Fix64

```csharp
// --- file: Fix64.cs
namespace Sting.Core
{
    /// Q32.32 signed fixed point. All sim math uses this type.
    public readonly struct Fix64 : System.IEquatable<Fix64>, System.IComparable<Fix64>
    {
        public const int FracBits = 32;
        public readonly long Raw;

        public static readonly Fix64 Zero = new Fix64(0L);
        public static readonly Fix64 One = new Fix64(1L << FracBits);
        public static readonly Fix64 Half = new Fix64(1L << (FracBits - 1));
        public static readonly Fix64 MaxValue = new Fix64(long.MaxValue);
        public static readonly Fix64 MinValue = new Fix64(long.MinValue);

        private Fix64(long raw) { Raw = raw; }
        public static Fix64 FromRaw(long raw) => new Fix64(raw);
        public static Fix64 FromInt(int v) => new Fix64((long)v << FracBits);

        /// Exact rational constructor for tuning constants: FromRatio(183, 1000) = 0.183.
        public static Fix64 FromRatio(int num, int den) => FromInt(num) / FromInt(den);

        public int FloorToInt() => (int)(Raw >> FracBits);

        public static Fix64 operator +(Fix64 a, Fix64 b) => new Fix64(a.Raw + b.Raw);
        public static Fix64 operator -(Fix64 a, Fix64 b) => new Fix64(a.Raw - b.Raw);
        public static Fix64 operator -(Fix64 a) => new Fix64(-a.Raw);

        /// 64x64 -> 128 product by 32-bit halves, then take the middle 64 bits.
        public static Fix64 operator *(Fix64 a, Fix64 b)
        {
            long x = a.Raw, y = b.Raw;
            bool neg = (x < 0) ^ (y < 0);
            ulong ux = x < 0 ? (ulong)(-x) : (ulong)x;
            ulong uy = y < 0 ? (ulong)(-y) : (ulong)y;

            ulong xl = ux & 0xFFFFFFFFUL, xh = ux >> 32;
            ulong yl = uy & 0xFFFFFFFFUL, yh = uy >> 32;

            ulong ll = xl * yl;
            ulong lh = xl * yh;
            ulong hl = xh * yl;
            ulong hh = xh * yh;

            // result = (hh << 64) + ((lh + hl) << 32) + ll, shifted right by 32
            ulong mid = (ll >> 32) + (lh & 0xFFFFFFFFUL) + (hl & 0xFFFFFFFFUL);
            ulong hi = hh + (lh >> 32) + (hl >> 32) + (mid >> 32);
            ulong lo = (mid << 32) >> 32; // bits 32..63 of the full product

            if ((hi >> 31) != 0) return neg ? MinValue : MaxValue; // saturate
            ulong r = (hi << 32) | lo;
            return new Fix64(neg ? -(long)r : (long)r);
        }

        /// Long division on magnitudes: (|a| << 32) / |b| without 128-bit types.
        public static Fix64 operator /(Fix64 a, Fix64 b)
        {
            if (b.Raw == 0) throw new System.DivideByZeroException();
            bool neg = (a.Raw < 0) ^ (b.Raw < 0);
            ulong n = a.Raw < 0 ? (ulong)(-a.Raw) : (ulong)a.Raw;
            ulong d = b.Raw < 0 ? (ulong)(-b.Raw) : (ulong)b.Raw;

            ulong q = n / d, rem = n % d;
            if (q >= (1UL << 31)) return neg ? MinValue : MaxValue;
            for (int i = 0; i < FracBits; i++)
            {
                // Shift remainder left by one bit; track overflow out of 64 bits.
                bool carry = (rem >> 63) != 0;
                rem <<= 1;
                q <<= 1;
                if (carry || rem >= d) { rem -= d; q |= 1; }
            }
            return new Fix64(neg ? -(long)q : (long)q);
        }

        public static bool operator <(Fix64 a, Fix64 b) => a.Raw < b.Raw;
        public static bool operator >(Fix64 a, Fix64 b) => a.Raw > b.Raw;
        public static bool operator <=(Fix64 a, Fix64 b) => a.Raw <= b.Raw;
        public static bool operator >=(Fix64 a, Fix64 b) => a.Raw >= b.Raw;
        public static bool operator ==(Fix64 a, Fix64 b) => a.Raw == b.Raw;
        public static bool operator !=(Fix64 a, Fix64 b) => a.Raw != b.Raw;

        public static Fix64 Min(Fix64 a, Fix64 b) => a.Raw < b.Raw ? a : b;
        public static Fix64 Max(Fix64 a, Fix64 b) => a.Raw > b.Raw ? a : b;
        public static Fix64 Clamp(Fix64 v, Fix64 lo, Fix64 hi) => Min(Max(v, lo), hi);
        public static Fix64 Clamp01(Fix64 v) => Clamp(v, Zero, One);

        public bool Equals(Fix64 o) => Raw == o.Raw;
        public override bool Equals(object obj) => obj is Fix64 o && o.Raw == Raw;
        public override int GetHashCode() => Raw.GetHashCode();
        public int CompareTo(Fix64 o) => Raw.CompareTo(o.Raw);

        /// Debug display only. Never used by sim logic.
        public override string ToString() => ((decimal)Raw / 4294967296m).ToString("0.######", System.Globalization.CultureInfo.InvariantCulture);
    }

    public readonly struct Vec3F
    {
        public readonly Fix64 X, Y, Z;
        public Vec3F(Fix64 x, Fix64 y, Fix64 z) { X = x; Y = y; Z = z; }
        public static Vec3F operator +(Vec3F a, Vec3F b) => new Vec3F(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
        public static Vec3F operator -(Vec3F a, Vec3F b) => new Vec3F(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
        public static Vec3F operator *(Vec3F a, Fix64 s) => new Vec3F(a.X * s, a.Y * s, a.Z * s);
        public Fix64 LengthSq() => X * X + Y * Y + Z * Z;
    }
}
```

### A.2 Counter-based RNG

```csharp
// --- file: Rng.cs
namespace Sting.Core
{
    public enum RngDomain : ulong
    {
        WorldGen = 1, HumanTraits = 2, HumanSchedule = 3, Clothing = 4,
        Flight = 5, Colony = 6, Ecology = 7, Weather = 8, Bees = 9,
    }

    /// Every random value is a pure function of its inputs (R-05).
    public static class Rng
    {
        static ulong Mix(ulong z)
        {
            // SplitMix64 finalizer
            z += 0x9E3779B97F4A7C15UL;
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
            return z ^ (z >> 31);
        }

        public static ulong Hash(ulong seed, RngDomain domain, ulong a, ulong b = 0, ulong c = 0)
        {
            ulong h = Mix(seed);
            h = Mix(h ^ (ulong)domain);
            h = Mix(h ^ a);
            h = Mix(h ^ b);
            h = Mix(h ^ c);
            return h;
        }

        /// Uniform Fix64 in [0, 1).
        public static Fix64 Unit(ulong hash) => Fix64.FromRaw((long)(hash >> 32));

        /// Uniform Fix64 in [lo, hi).
        public static Fix64 Range(ulong hash, Fix64 lo, Fix64 hi) => lo + (hi - lo) * Unit(hash);

        /// Uniform int in [lo, hi). Span must be below 2^32.
        public static int RangeInt(ulong hash, int lo, int hi)
        {
            ulong span = (ulong)(hi - lo);
            return lo + (int)(((hash >> 32) * span) >> 32);
        }
    }
}
```

### A.3 Tick loop

```csharp
// --- file: SimWorld.cs
namespace Sting.Core
{
    public sealed class SimWorld
    {
        public const int TickRate = 60;
        public long Tick { get; private set; }

        // Subsystems, in fixed order. Order is part of the determinism contract.
        public void Step()
        {
            Tick++;
            // 1. Apply player commands for owned entities (input buffer keyed by tick).
            // 2. Apply received events with Tick <= current tick, in total order (3.7).
            // 3. Flight and swept collision            (every tick)
            // 4. Reaction plans: activate swat windows, run swat checks (every tick)
            if (Tick % 3 == 0)
            {
                // 5. Human movement from schedules + deviations, panic, contagion (20 Hz)
                // 6. Bees, predators                                              (20 Hz)
            }
            if (Tick % TickRate == 0)
            {
                // 7. Colony economy (1 Hz)
            }
            if (Tick % (TickRate * 5) == 0)
            {
                // 8. Ecology: regrowth, prey spawning (0.2 Hz)
            }
            // 9. Emit outgoing events and owned-entity state for networking.
        }
    }
}
```

### A.4 Colony economy step (1 Hz)

```csharp
// --- file: ColonyEconomy.cs
namespace Sting.Core
{
    public struct ColonyState
    {
        public Fix64 Protein, Sugar, Pulp;
        public int Adults, Larvae, Eggs, Pupae;
        public int CellsTotal, CellsFree;
        public bool QueenAlive;
        public Fix64 SugarDeficit;   // 0..1, drives AI attraction to human food (6.3)
    }

    public struct EconomyTuning
    {
        public Fix64 AdultSugarPerSec;        // upkeep per adult
        public Fix64 LarvaProteinPerSec;      // need per larva
        public Fix64 LarvaSecretionPerSec;    // sugar returned per fed larva
        public Fix64 DeficitSmoothing;        // 0..1 per step
    }

    public static class ColonyEconomy
    {
        public static void Step(ref ColonyState c, in EconomyTuning t)
        {
            // Larvae are fed protein first; fed larvae return secretion.
            Fix64 proteinNeed = t.LarvaProteinPerSec * Fix64.FromInt(c.Larvae);
            Fix64 proteinFed = Fix64.Min(proteinNeed, c.Protein);
            c.Protein -= proteinFed;

            Fix64 fedFraction = proteinNeed > Fix64.Zero ? proteinFed / proteinNeed : Fix64.Zero;
            Fix64 secretion = t.LarvaSecretionPerSec * Fix64.FromInt(c.Larvae) * fedFraction;

            // Adults burn sugar; secretion covers part of it.
            Fix64 sugarNeed = t.AdultSugarPerSec * Fix64.FromInt(c.Adults);
            Fix64 fromStore = Fix64.Max(Fix64.Zero, sugarNeed - secretion);
            Fix64 paid = Fix64.Min(fromStore, c.Sugar);
            c.Sugar -= paid;

            // Deficit = share of adult need not met by secretion, smoothed.
            Fix64 rawDeficit = sugarNeed > Fix64.Zero
                ? Fix64.Clamp01((sugarNeed - secretion) / sugarNeed)
                : Fix64.Zero;
            c.SugarDeficit += (rawDeficit - c.SugarDeficit) * t.DeficitSmoothing;

            // Starvation, brood stage advance and egg laying are separate steps, omitted here.
        }
    }
}
```

### A.5 Body zones and reach

```csharp
// --- file: Reach.cs
namespace Sting.Core
{
    public enum Zone : byte
    {
        Scalp, Face, Ears, NeckFront, NeckBack, Shoulders, UpperBack, Acnestis, LowerBack,
        Chest, Belly, Groin, Buttocks, UpperArms, Forearms, Shins, Thighs, Count
    }

    public enum ResponsePolicy : byte { Slap, BrushOrShake, Brush, Contort, CoverSwipe, SlapOppositeHand }

    public struct ZoneDef
    {
        public Fix64 BaseReach;
        public Fix64 BackSensitivity;       // how much flexibility/age matter
        public Fix64 GirthSensitivity;
        public Fix64 StiffnessSensitivity;
        public Fix64 Sensitivity;           // pain multiplier
        public ResponsePolicy Policy;
        public bool HelperMaySwat;
        public int ExtraDelayTicks;
    }

    public struct HumanTraits
    {
        public ulong Id;
        public Fix64 HeightM, ArmRatio, Flexibility, Girth, AgeStiffness;
        public int ReactionTicks;           // 11..42
        public SwatStyle Style;
        public Fix64 Accuracy, PanicSusceptibility, Sociability, Escalation;
    }

    public enum SwatStyle : byte { Precise, Flailer, Brusher, Freezer, Runner }

    public struct ReachTuning
    {
        public Fix64 ArmCoef, FlexCoef, GirthCoef, AgeCoef, MinReachToSwat;
    }

    public static class Reach
    {
        public static Fix64 SelfReach(in ZoneDef z, in HumanTraits h, Fix64 clothingStiffness, in ReachTuning t)
        {
            Fix64 r = z.BaseReach
                + t.ArmCoef * (h.ArmRatio - Fix64.One)
                + t.FlexCoef * (h.Flexibility - Fix64.Half) * z.BackSensitivity
                - t.GirthCoef * h.Girth * z.GirthSensitivity
                - clothingStiffness * z.StiffnessSensitivity
                - t.AgeCoef * h.AgeStiffness * z.BackSensitivity;
            return Fix64.Clamp01(r);
        }
    }
}
```

### A.6 Sting resolution

```csharp
// --- file: StingResolver.cs
namespace Sting.Core
{
    public enum StingMode : byte { Jab, Full }

    public struct StingEvent
    {
        public long ContactTick;
        public ulong WaspId, HumanId;
        public Zone Zone;
        public Vec3F ContactPointBody;   // in the human's body frame
        public StingMode Mode;
    }

    public enum SwatKind : byte { Slap, Brush, Cover, Contort }

    public struct SwatAttempt
    {
        public ulong ActorId;            // the stung human or a helper
        public SwatKind Kind;
        public long StartTick;
        public int WindowTicks;
        public Vec3F CenterBody;         // in the stung human's body frame
        public Fix64 Radius;
        public bool Kills;               // false = stun
    }

    public struct Companion { public ulong Id; public Fix64 DistanceM; public int ReactionTicks; public SwatStyle Style; }

    public struct HumanContext
    {
        public Fix64 ClothingStiffness;
        public Fix64 Panic;
        public Companion[] Companions;   // sorted by Id ascending (R-06); may be null
    }

    public struct ReactionPlan
    {
        public const int MaxSwats = 3;
        public SwatAttempt Swat0, Swat1, Swat2;
        public int SwatCount;
        public Fix64 PanicGain;
        public bool Flee;

        public void Add(in SwatAttempt s)
        {
            if (SwatCount == 0) Swat0 = s;
            else if (SwatCount == 1) Swat1 = s;
            else if (SwatCount == 2) Swat2 = s;
            else return;
            SwatCount++;
        }
    }

    public struct ResolveTuning
    {
        public ReachTuning Reach;
        public Fix64 JabPain, FullPain;
        public Fix64 PreciseRadius, FlailerRadius, BrushRadius, CoverRadius, ContortRadius;
        public int ContortExtraTicks, HelperNoticeTicks, MinConsequenceTicks;
        public Fix64 HelperRangeM, HelperReach, FleePanic;
    }

    public static class StingResolver
    {
        /// Pure function (8.6). Same inputs -> same plan on every machine.
        public static ReactionPlan Resolve(in StingEvent e, in HumanTraits h, in ZoneDef z,
                                           in HumanContext ctx, in ResolveTuning t)
        {
            var plan = new ReactionPlan();

            Fix64 pain = (e.Mode == StingMode.Full ? t.FullPain : t.JabPain) * z.Sensitivity;
            plan.PanicGain = pain * h.PanicSusceptibility;
            plan.Flee = ctx.Panic + plan.PanicGain >= t.FleePanic || h.Style == SwatStyle.Runner;

            if (h.Style != SwatStyle.Freezer)
            {
                Fix64 reach = Reach.SelfReach(z, h, ctx.ClothingStiffness, t.Reach);
                SwatKind kind = KindFor(z.Policy, reach, t.Reach.MinReachToSwat);
                int delay = h.ReactionTicks + z.ExtraDelayTicks + (kind == SwatKind.Contort ? t.ContortExtraTicks : 0);
                if (delay < t.MinConsequenceTicks) delay = t.MinConsequenceTicks;   // 11.5 invariant

                plan.Add(new SwatAttempt
                {
                    ActorId = h.Id,
                    Kind = kind,
                    StartTick = e.ContactTick + delay,
                    WindowTicks = WindowFor(kind),
                    CenterBody = e.ContactPointBody,
                    Radius = RadiusFor(kind, h.Style, h.Accuracy, reach, t),
                    Kills = kind == SwatKind.Slap || kind == SwatKind.Cover,
                });
            }

            // Companions help where the zone allows it. They react to the human's reaction.
            if (z.HelperMaySwat && ctx.Companions != null)
            {
                for (int i = 0; i < ctx.Companions.Length && plan.SwatCount < ReactionPlan.MaxSwats; i++)
                {
                    var c = ctx.Companions[i];
                    if (c.DistanceM > t.HelperRangeM || c.Style == SwatStyle.Freezer) continue;
                    plan.Add(new SwatAttempt
                    {
                        ActorId = c.Id,
                        Kind = SwatKind.Slap,
                        StartTick = e.ContactTick + h.ReactionTicks + t.HelperNoticeTicks + c.ReactionTicks,
                        WindowTicks = WindowFor(SwatKind.Slap),
                        CenterBody = e.ContactPointBody,
                        Radius = c.Style == SwatStyle.Precise ? t.PreciseRadius : t.FlailerRadius,
                        Kills = true,
                    });
                }
            }
            return plan;
        }

        static SwatKind KindFor(ResponsePolicy p, Fix64 reach, Fix64 minReach)
        {
            if (reach < minReach) return SwatKind.Contort;
            switch (p)
            {
                case ResponsePolicy.BrushOrShake:
                case ResponsePolicy.Brush: return SwatKind.Brush;
                case ResponsePolicy.CoverSwipe: return SwatKind.Cover;
                case ResponsePolicy.Contort: return SwatKind.Contort;
                default: return SwatKind.Slap;
            }
        }

        static int WindowFor(SwatKind k)
        {
            switch (k)
            {
                case SwatKind.Slap: return 4;
                case SwatKind.Brush: return 6;
                case SwatKind.Cover: return 8;
                default: return 10;
            }
        }

        static Fix64 RadiusFor(SwatKind k, SwatStyle s, Fix64 accuracy, Fix64 reach, in ResolveTuning t)
        {
            switch (k)
            {
                case SwatKind.Brush: return t.BrushRadius;
                case SwatKind.Cover: return t.CoverRadius;
                case SwatKind.Contort: return t.ContortRadius;
            }
            // Slap: interpolate precise..flailer by accuracy; poor reach widens it.
            Fix64 baseR = s == SwatStyle.Precise ? t.PreciseRadius : t.FlailerRadius;
            Fix64 accuracyScale = Fix64.One + (Fix64.One - accuracy) * Fix64.Half;
            Fix64 reachScale = Fix64.One + (Fix64.One - reach) * Fix64.Half;
            return baseR * accuracyScale * reachScale;
        }
    }
}
```

### A.7 Swat check

```csharp
// --- file: SwatCheck.cs
namespace Sting.Core
{
    /// Position and orientation of a human's body frame at a tick (from schedule + deviations).
    public struct BodyFrame
    {
        public Vec3F Origin;
        public Vec3F Right, Up, Forward;   // orthonormal basis in fixed point

        public Vec3F ToWorld(Vec3F p) => Origin + Right * p.X + Up * p.Y + Forward * p.Z;
    }

    public static class SwatCheck
    {
        public static bool IsActive(in SwatAttempt s, long tick) =>
            tick >= s.StartTick && tick < s.StartTick + s.WindowTicks;

        /// Sphere vs sphere at one tick. Production code sweeps the wasp over the tick.
        public static bool Hits(in SwatAttempt s, in BodyFrame frame, Vec3F waspPos, Fix64 waspRadius)
        {
            Vec3F center = frame.ToWorld(s.CenterBody);
            Fix64 r = s.Radius + waspRadius;
            return (waspPos - center).LengthSq() <= r * r;
        }
    }
}
```

### A.8 Remote entity display (presentation, floats allowed)

```csharp
// --- file: RemoteSmoothing.cs (lives in the Unity assembly; shown here for completeness)
namespace Sting.Presentation
{
    public struct RemoteTrack
    {
        public float PX, PY, PZ;     // last received position
        public float VX, VY, VZ;     // last received velocity
        public float StampSec;       // when it was valid
        public float DX, DY, DZ;     // displayed position

        public void Receive(float px, float py, float pz, float vx, float vy, float vz, float stamp)
        { PX = px; PY = py; PZ = pz; VX = vx; VY = vy; VZ = vz; StampSec = stamp; }

        /// Extrapolate from the last state and ease toward it; snap if far off.
        public void Update(float nowSec, float blendPerSec, float dt, float snapDist)
        {
            float age = nowSec - StampSec;
            float tx = PX + VX * age, ty = PY + VY * age, tz = PZ + VZ * age;
            float ex = tx - DX, ey = ty - DY, ez = tz - DZ;
            if (ex * ex + ey * ey + ez * ez > snapDist * snapDist) { DX = tx; DY = ty; DZ = tz; return; }
            float k = blendPerSec * dt; if (k > 1f) k = 1f;
            DX += ex * k; DY += ey * k; DZ += ez * k;
        }
    }
}
```

### A.9 Chunk authority (rendezvous hashing)

```csharp
// --- file: ChunkAuthority.cs
namespace Sting.Core
{
    public static class ChunkAuthority
    {
        public static ulong ChunkKey(int cx, int cz) => ((ulong)(uint)cx << 32) | (uint)cz;

        /// Highest-random-weight pick: the peer with the smallest hash owns the chunk.
        /// Peers added or removed only move the chunks they win or lose.
        public static ulong Elect(ulong worldSeed, int cx, int cz, ulong[] interestedPeerIds)
        {
            ulong key = ChunkKey(cx, cz);
            ulong best = 0, bestScore = ulong.MaxValue;
            for (int i = 0; i < interestedPeerIds.Length; i++)
            {
                ulong score = Rng.Hash(worldSeed, RngDomain.WorldGen, key, interestedPeerIds[i], 0xA11CE);
                if (score < bestScore || (score == bestScore && interestedPeerIds[i] < best))
                { bestScore = score; best = interestedPeerIds[i]; }
            }
            return best;
        }
    }
}
```

### A.10 Human traits from ID

```csharp
// --- file: HumanFactory.cs
namespace Sting.Core
{
    public static class HumanFactory
    {
        public static HumanTraits Traits(ulong seed, ulong humanId)
        {
            ulong H(ulong i) => Rng.Hash(seed, RngDomain.HumanTraits, humanId, i);
            var h = new HumanTraits
            {
                Id = humanId,
                HeightM = Rng.Range(H(0), Fix64.FromRatio(150, 100), Fix64.FromRatio(195, 100)),
                ArmRatio = Rng.Range(H(1), Fix64.FromRatio(92, 100), Fix64.FromRatio(108, 100)),
                Flexibility = Rng.Unit(H(2)),
                Girth = Rng.Unit(H(3)),
                AgeStiffness = Rng.Unit(H(4)),
                ReactionTicks = Rng.RangeInt(H(5), 11, 43),
                Style = (SwatStyle)Rng.RangeInt(H(6), 0, 5),
                Accuracy = Rng.Unit(H(7)),
                PanicSusceptibility = Rng.Unit(H(8)),
                Sociability = Rng.Unit(H(9)),
                Escalation = Rng.Unit(H(10)),
            };
            return h;
        }
    }
}
```

### A.11 Chunk discovery and freeze

```csharp
// --- file: ChunkStore.cs
namespace Sting.Core
{
    public struct ChunkRecord
    {
        public int Cx, Cz;
        public int GenVersion;
        public ulong ContentHash;
        public long DiscoveredTick;
        public byte[] BaseSnapshot;      // serialized ChunkBase, compressed
    }

    public interface IChunkGenerator
    {
        int Version { get; }
        byte[] GenerateSnapshot(ulong worldSeed, int cx, int cz);   // pure function
    }

    public interface IWorldStore
    {
        bool TryGet(int cx, int cz, out ChunkRecord record);
        /// Idempotent: storing an identical record twice is a no-op; a different one is rejected.
        bool Put(in ChunkRecord record);
    }

    public static class Discovery
    {
        public static ChunkRecord GetOrDiscover(IWorldStore store, IChunkGenerator gen,
                                                ulong worldSeed, int cx, int cz, long tick)
        {
            if (store.TryGet(cx, cz, out var existing)) return existing;   // frozen forever
            byte[] snap = gen.GenerateSnapshot(worldSeed, cx, cz);
            var rec = new ChunkRecord
            {
                Cx = cx, Cz = cz, GenVersion = gen.Version, DiscoveredTick = tick,
                BaseSnapshot = snap, ContentHash = HashBytes(snap),
            };
            store.Put(rec);
            return rec;
        }

        static ulong HashBytes(byte[] data)
        {
            ulong h = 0xCBF29CE484222325UL;                 // FNV-1a 64
            for (int i = 0; i < data.Length; i++) { h ^= data[i]; h *= 0x100000001B3UL; }
            return h;
        }
    }
}
```

---

## Appendix B — Glossary

| Term | Meaning |
|---|---|
| Acnestis | The patch of back a person can't reach; the wasp's safest landing zone |
| Body frame | A human's local coordinate system; zones and swat volumes live in it |
| Chunk authority | The one peer that resolves contested objects and writes deltas for a chunk |
| Consequence window | Time between a sting and its first gameplay consequence; covers network latency |
| Delta log | Changes recorded on top of a discovered chunk's frozen base |
| Gyne | An unmated new queen |
| Line | A founding queen and every colony descended from her |
| Reaction plan | The deterministic list of swats and effects produced by a sting |
| Sugar deficit | Share of the colony's adult sugar need not covered by larval secretion |

---

## Appendix C — Biology reference

Values the tuning starts from. They are references, not targets; gameplay compresses time and simplifies.

| Fact | Value | Source |
|---|---|---|
| Egg stage | usually 5 days, sometimes 7 | Wikipedia, *Vespula vulgaris* |
| First adult after hatching | about 23 days | same |
| Brood total | about 30 days | same |
| Worker lifespan | about 14 days on average; workers over 30 days stop foraging and guard | same |
| Colony size | thousands of workers; 3,000–8,000 larvae at peak | same |
| Queen laying at peak | about 200–300 eggs per day | same |
| Nest founding | queen builds 20–30 cells before laying; colonies start in April and degenerate around October | same |
| Worker length and mass | 12–17 mm, about 84 mg | same |
| Queen length | about 20 mm | same |
| Multiple stinging | workers can sting multiple times | same |
| Larval diet | freshly killed insects and spiders | same |
| Adult diet | nectar, sweet fruit | same |
| Larval secretions | workers collect secretions from larvae | same |
| Heat-balling | ball reaches 46 °C within 5 minutes; hornets die at 44–46 °C | Sugahara et al., *Zoological Science* 2012 (PubMed 22233493) |

Sources:
- https://en.wikipedia.org/wiki/Vespula_vulgaris
- https://pubmed.ncbi.nlm.nih.gov/22233493/
