# STING — Game Design Document

| | |
|---|---|
| Working title | STING (from the "Sting 7 billion people" meme) |
| Version | 0.4 — feature tiers and stack compatibility (Section 19) |
| Date | 2026-10-27 |
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
| Meta | season to season | Get mated queens through winter, continue the line next spring, keep the discovered world, grow the line's tree; at the turn of a full year, wake as hornets or try bees (6.8) |

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
- **Line extinct:** no living queen and no living gyne or hibernating queen in the player's line. With several colonies held (6.8, multi-colony play), the game is over only when every one of the player's lines is extinct; until then control moves to a surviving colony. Game over. Start a new line, in the same world (if it still exists) or a new one.

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
- Which species a line may play, and how it gets there, is a world setting (6.8): Main earns it, an offshoot's host chooses, a personal world can open everything.

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
- species progression: earned, open or fixed to one species (6.8)

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
- Extreme weather (built, 18.38): heatwaves and cold snaps run for days; storms are afternoon downpours in a gale.

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
| Water (H₂O) *(tier 2, built: 18.37)* | Puddles after rain, birdbaths | Nest cooling in heat |

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
| Male | Mates and dies. Does not sting (built as a wasp: 18.39) |

- **Role allocation:** the player sets target ratios; the colony assigns idle workers to fill them.
- **Default allocation by age:** young workers nurse and build inside; older workers forage; the oldest guard the entrance *(bio-inspired)*.

### 6.6 Nest **[T0]**

- Nest sites: underground cavity, wall cavity, attic, shed, hollow tree, open branch.
- Each site type has: exposure to weather, thermal stability, human discovery chance, flood risk and maximum size.
- Nest growth: builders turn pulp into cells and envelope layers. Size caps the colony.

A nest can be **warm**: inside a house, or in the hollow of a giant tree. A warm colony can winter through (18.50), and one in a house that grows too big is found by the household.

### 6.7 Succession and the line **[D] D-05** **[T0] [T2]** (lineage colonies as real AI colonies T2)

- Gynes leave in autumn, mate with males present in the mating area, then search for a hibernation site. As built (18.39): the mating area is the crown of a tall tree near the nest, and the males present are the colony's own and the neighbourhood's.
- Winter mortality per hibernating queen depends on site quality *(tune)*.
- In spring the player picks which surviving queen continues as the controlled colony. The other surviving queens found **lineage colonies** run by AI. **[Q] Q-10** As built (18.40): up to five are real colonies on trunks near where they wintered.
- **The line** is the player's founding queen and all colonies descended from her. Game over when the line is extinct.

### 6.8 The growth tree and the three species **[P] D-23** **[T0] [T2]** (the species built, 18.47; XP, skills and the year's turn at T0, 18.48; multi-colony play and the player gauge at T0, 18.49)

The line earns experience, and experience grows a tree. A line that runs a whole year reaches a turning point in spring. With enough experience, the queen it wakes is a hornet queen, and the player plays hornets from then on. With too few stings and too little experience, the game offers the line a try at a honeybee colony. Both are expansion by reuse: a hornet and a honeybee run on the systems already built for wasps and bees, with their own tables.

**Experience** *(tune)*
- Belongs to the line, not to a wasp. The founding queen starts at zero; experience winters with the queens and passes to the one the player wakes.
- Is a deterministic sum over events the sim already emits: humans stung, prey caught, loads brought home (sugar, protein, pulp, water), hives robbed, rivals and raiders killed, gynes mated, queens wintered, escalation levels survived. It is colony state, in the save and the snapshot, so every peer computes the same figure.
- **Stabs** are the stings that move the counter (8.11). They are tracked apart from experience because the counter is the game's spine. A line can be rich in experience and still fail the stab bar.
- Line extinct, everything is lost: the next line starts from a single queen at zero (P4).

**The tree**
- Three branches on systems that exist:
  - **Nest:** cell building, brood speed, nest insulation, guard strength.
  - **Flight:** the driven wasp's Reflex cue (7.8), swoop recovery, lock-on range, assisted-flight reach.
  - **Line:** gyne output, winter survival by site, how many lineage colonies found.
- Points come from experience, a few per season; the tree is spent in the colony view.
- In shared worlds a node that changes an outcome is a colony parameter: data in the colony record that every peer reads, inside ranges the plausibility checks know (11.8). Presentation-only nodes, like the Reflex cue, are free. The ranges stay small. An old line is better, not untouchable.

**The year's turn**
- A line has run a year when it has founded in spring, raised gynes, wintered at least one queen and woken her the next spring. The test runs at the spring choice (6.7, 18.24), before the queen is woken.
- **Hornet bar met** (experience and stabs both over their thresholds): the player may wake the chosen queen as a hornet queen. The line becomes a hornet line. The player can decline and stay wasps. The line's other wintered queens still wake as wasps and found AI-run lineage colonies (18.40), as they would in any spring.
- **Short of both** (stabs and experience under a lower bar): the game offers the line a try as a honeybee colony.
  - Accepting takes over a feral hive in the world (18.28).
  - The wasp line's other wintered queens found AI-run lineage colonies (18.40) instead of ending, so the wasp line is not lost (Q-20, settled).
  - Declining continues as wasps.
- **In between:** the line continues as wasps.
- The change happens only at a generation boundary: a new queen in spring, never a living wasp mid-season.

**Multi-colony play** (agreed 2026-10-27). Taking a new species never closes the old line: the colonies the player is not driving are managed automatically by the colony AI that already runs lineage and sister colonies (18.40). A player who wants the challenge can run several at once, a wasp line and a bee colony in the same world, or a hornet line beside the wasp line it came from.
- **One at a time in hand, the rest on AI.** The player drives wasps of one colony and manages one colony view at a time; switching colony is a colony-view choice, with the same relay rules as switching wasps far away (Q-03). Colonies not in hand run on the AI with the player's last role ratios and tree.
- **Each line keeps its own** experience, stabs, tree and year's turn.
- **The player gauge** (agreed 2026-10-27). An auto-managed colony progresses on its own, at the player's level and never above it. Good play pays off in every colony the player holds; the AI can neither grow beasts nor be farmed for a hornet queen.
  - **The gauge is measured, not chosen.** While a colony is in hand, the sim keeps the player's rates per in-game day of play: experience earned, stabs, prey and loads brought home, wasps lost, brood raised. A rolling window over recent in-hand play *(tune)* gives the **player gauge**: numbers, one per rate, not a single rank.
  - **AI colonies run at the gauge.** A colony on AI earns experience and stabs at no more than the gauge's rates, scaled to its size and the season. Its management follows the same numbers: how hard it forages, how much it risks, how many it loses. A sharp player's colonies prosper while they are away; a careless player's colonies drift along as that player would.
  - **Level is capped at the player's.** A colony on AI uses its tree only up to the level of the colony the player has in hand, and never past its own. Lineage and sister colonies follow the same cap.
  - **No gauge, no growth.** Until there is enough in-hand play to measure *(tune)*, AI colonies earn at a low floor. A burst of good play followed by idling does not hold the gauge up, because the window rolls and only in-hand time feeds it. AI colonies never feed the gauge.
  - **The year's turn** tests every colony the same way. An AI colony that reaches the hornet bar at the gauge's rates got there at the player's pace, which is the reward for playing well.
  - **Switching does not launder.** Experience belongs to the colony that earned it. Switching moves the player, never experience; the level cap follows the player at once.
  - The gauge, who is in hand and since which tick are colony state built from events, so every peer computes the same gauge and caps and audits a line's claimed experience against its events (11.8).
- **They can meet.** The player's own colonies are not friends by default across species: the bees still ball a raiding wasp, and the hornets will hunt the player's own yellowjackets unless the player marks them kin. Same species, same line: never fight, as lineage colonies today.
- **Load.** Every colony held is a colony the owner's machine simulates in full near its player and at the relevance tiers further out (11.12). The number held is a world setting *(tune)*; on Main, colonies of an offline player run at the abstract tier (Q-15).
- **Ownership.** Every colony held is owned by the player's peer and published like any other (D-19); peers audit each one separately.

**Pillar P1.** No wasp turns into a hornet. Like balling on *Vespula* (9.2), this is a game license: the change is the player's progression, applied when a new queen is woken. The world itself stays nature as is. Hornets and bees behave as their biology says; none gains a face or a voice.

**The three species**, on one code path (D-22): the wasp code, with a species table read from tuning (18.29).

| | Common wasp (*Vespula*) | European hornet (*Vespa crabro*) | Honeybee (*Apis mellifera*) |
|---|---|---|---|
| Body *(bio)* | worker 12–17 mm | worker up to 25 mm, queen up to 35 mm | smaller and lighter than a wasp *(tune)* |
| Peak colony *(bio)* | thousands | 200–400 workers, large nests up to 1,000 | 2,000–60,000 workers |
| Year | annual; mated queens winter | annual; mated queens winter under bark or in wall voids | perennial; the colony winters as a cluster on its honey and pollen |
| New colonies | gynes and males, mating flights | the same | swarming: the old queen leaves with up to 60% of the workers; a daughter queen keeps the nest |
| Food | prey for the larvae, sugar for adults, human food | hunts flies, grasshoppers and yellowjackets, sometimes honeybees; fallen fruit, sap from stripped bark | nectar and pollen only; no prey |
| Sting | many times | many times; heavier *(tune)* | a worker that stings a person dies (barbed sting); the queen stings many times |
| Hours | day | day and night; drawn to porch lights | day |
| In the US setting | the meme | established in the eastern US since the 1840s | everywhere: beekeepers' boxes and feral hives |

**What each species plays like**
- **Hornets:** fewer, heavier insects, and each one counts, so the game is in the driven wasp.
  - Rival wasp colonies become prey: hunting yellowjackets at their nest, picking bees off a hive entrance.
  - Night flight under porch lights adds a night loop. Beer gardens already keep evening hours (18.43).
  - People react harder to a hornet *(tune)*.
  - Bees still ball them. The balling research is about hornets (Appendix C), so this is the matchup the data describes.
- **Bees:** the inversion.
  - Every sting on a person kills the bee that made it, so each stab is a sacrifice and the counter climbs slowly.
  - Foraging, stores and defence are the game. The player is now the hive that balls raiders, including other players' wasps and hornets (Q-07).
  - Winter is a stores problem (enough honey for the cluster), not a hibernation-site problem.
  - The line continues by swarms, not by gynes.

**Reuse map**

| Needed | Already built | New |
|---|---|---|
| Species bodies and flight | one wasp code path (D-22), tuning as data (18.29) | a species table that overrides wasp values; species in the colony record and saves |
| Hornet hunting | prey catching, raids on nests (18.43), robbing hives (18.28) | yellowjackets as prey at rival and AI nests |
| Night | the clock, evening hours (18.43) | porch lights as light sources and attractors; night flight |
| Bee colony | feral hives (18.28), AI bees, balling (9.2), the colony economy (A.4) | a honey economy with no larval protein; the winter cluster; swarming in place of gyne flights; the barbed sting |
| The line across species | succession (6.7), lineage colonies (18.40), the spring choice (18.24) | the year's turn and its offer |

**World setting: progression.** How far a line can go is part of the world, not the client. It is a feature modifier in the world record (4.8, D-14), so the experience thresholds are tuning values inside the world's tuning hash.

| Setting | Meaning | Where |
|---|---|---|
| `earned` | Wasps at the start; hornets and bees through the year's turn | Main (always), offshoot default |
| `open` | All three species selectable when a line is founded | Personal worlds, test builds, the PoC and network lab |
| `fixed:<species>` | One species only (a hornet server, a bee server) | Offshoot host choice |

For testing, the PoC and the core run `open`: all three species can be picked on the start screen from the start. In a shared world, players' lines can be different species. A hornet player hunting a wasp player's foragers is the rivalry working as intended (Q-07). Every species' stabs count on the one counter (Q-09).

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
- **A skill.** As built (18.48), Reflex is a unit skill the line learns; Focus, an activated slowdown on Z, follows it.
- **Tuning.** The Flight branch of the growth tree (6.8) can scale the cue (earlier warning, longer slow-motion in solo, the predicted swat volume shown), never the outcome. The consequence window (7.4, minimum 11 ticks) stays as it is.


### 7.9 Lock-on, assisted flight and the swoop **[T1]** (built, 18.45, 18.46, 18.52, 18.53)

The player directs the wasp; the wasp flies. A wasp is a few centimetres long and a flower head two, and landing on one by hand is a test of input precision the animal itself never faces, so the assistance stands in for what the wasp has by instinct.

- **Lock on** (V, the middle mouse button, R3). On a person it takes the spot on the body the aim passes nearest, as a part, a place along it and its outward side, so it follows the person as they move, sit or stand. Otherwise it takes whatever lies closest to the aim within a narrow cone (prey, a flower, a drink, water, the nest, a hazard); with nothing under the aim, the nearest prey or hazard. Locked, the camera faces the target: W closes in (slowing as it gets near something that stays put; matching the pace of something moving, so prey or a walker can be reached, 18.53), S backs off, A and D circle it.
- **Assisted flight** (E while locked on something the wasp can go to, with nothing to act on right here). The wasp flies itself there: in from above to a flower, a drink or water, along the outward side to a spot on a person. It lands, perches, or catches its prey. Standing somewhere else, it takes off first. It goes round a trunk, over a fence or up past an eave rather than into them (18.52). Any move key takes the controls back.
- **The swoop** (X, d-pad up). A movement move, not a lock-on feature: a short dash of about 9 m/s for a third of a second, steered at speed, costing a little energy, once every two thirds of a second. Whatever the dash reaches, it slams onto. Prey is caught, a surface flown into (not grazed) is landed on, a person is perched on and feels it at once (a notice, a startle that can send them running). Anyone close to a slam is startled too. With a lock it is dynamic: it homes on the target and does what the target calls for. It snatches prey, dives onto a flower, a drink or water (an escape from the air), slams onto the locked spot on a person, makes for the nest, and dashes away from a danger.
- **Turn to the gaze** (G, L3). In the eye view (hold RMB) a tap turns the wasp to where the player is looking, and the gaze stays where it was. Held for a second it toggles auto turn, which brings the wasp round after the gaze once the player has looked away for a second.
- **Later: automatic focus.** With the Reflex slowdown (7.8), a perilous moment (a swat about to land, a bird diving) can lock on to the danger by itself.

All of it only builds the driven wasp's commands from the sim's state, so an assisted flight is recorded and replayed like any other input, and peers see only the wasp's flight.

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
- As built (T1-11, 18.35): besides people at tables and in groups, the generator places strollers (round the block on the sidewalks, round the park, across the mall lot, through the woods), gardeners working the beds in a backyard and sunbathers on lawns and in the park. The day's weather picks who comes out: nobody strolls, gardens or sunbathes in rain, gardeners need a mild day and sunbathers a warm one and lie out only through the warm hours.

### 8.3 Body zones **[T0] [T1]** (walk and lie postures)

The sim body is a set of zone capsules in a body frame, scaled by height and girth, in one of a few postures: stand, sit, walk, lie. The rendered skeleton is presentation; the zone capsules are the truth.

As built (T1-11): walking is the standing body moving (the gait is drawn, not simulated). Lying is the standing body turned onto its back by the body frame itself: the same capsules, zones and garments, head toward the facing, front to the sky, 0.18 m above the grass. Everything that works in the body frame (perching, stinging, crawling under clothing, swats) works on a sunbather unchanged.

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
- A line can be offered a bee colony to play (6.8). The hives, the bees and balling are then the player's own: the same systems, from the other side.

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
- As built (18.32, 18.43): contested pickups and late-event corrections in the lab; chunk deltas are not on the authority yet.

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

As built (18.36): speed is checked on state packets for drawing only; contact distance, venom rate, the event window, carry limits, positions inside solids and pickups and sips against what they took are checked on events, by every peer alike.

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
| D-23 | The line grows a tree from experience; at a year's turn it may wake as hornets (experience and stabs high) or be offered bees (both low); progression is a world setting (earned, open, fixed); all three species are open in test builds; colonies not in hand are auto-managed, so a player can hold several at once; auto-managed colonies progress at the player gauge (the player's measured rates) and are capped at the player's level | proposed |

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
| Q-18 | What earns experience, how events are weighted, and where the hornet and bee bars sit; does a stab count every sting or only unique humans? | Start from events the sim already emits (6.8), earned in hand, and by AI colonies at the player gauge's rates; stabs follow the counter (unique humans); tune the bars, the gauge window and its floor on play data |
| Q-19 | Is the change of species one-way? Can a hornet line go back, or a bee line earn its way back to wasps or on to hornets? | Proposal: hornets are one-way; a bee line that runs a strong year is offered wasps again |
| Q-20 | When a line takes the bee offer, what happens to its wasp queens? | Settled 2026-10-27: they found AI-run lineage colonies (18.40); the player can hold several colonies at once and switch between them, the rest auto-managed (6.8, multi-colony play) |

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

Because human state changes only on agreed ticks and from data inside the events, every peer computes identical humans. In the two-peer lab, human state matched on every check (300 of 300 per link) over links from LAN to 16±6 ticks one-way with 10% loss, with no late events. The commit window is a tuning value: it must exceed the worst one-way delay plus one redundancy interval. 500 ms leaves room for about 370 ms one-way. Past it, an event can arrive after its commit tick; the chunk's authority then corrects the chunk (18.43).

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

`core/Sting.Core` is the whole PoC simulation in C#: world generation, weather, bodies and the sting resolver, colony economy, the `Sim` itself (wasps, humans, bees, hunters, rivals, the exterminator, pest control, the yearly cycle, the AI), the network lab with its wire format and plausibility checks, and saves. It is bit-identical to the JS reference: `core/fixtures/parity.txt` holds 29 digests written by `poc/test/parity.mjs` (world, bodies, colony, eleven whole-game scenarios (three of them the species of 18.47, one the skills of 18.48, one multi-colony play of 18.49, one a nest wintering in, 18.50), a save and restore mid-run, two-peer labs on good and awful links and one well past the window with late-event corrections, a late joiner, a cheater, and a three-peer mesh where the host rules), and the C# runner reproduces every one. The scenario digests cover every sim event and the state and human hashes once a second, so a single differing bit anywhere fails the run.

Two rules made the port mechanical: the JS sim may use only operations that are exact in IEEE doubles (its own sine, arctangent and rounding, no `Math.round`, `hypot` or `atan2`), and every map whose order can change a result is an insertion-ordered map in C# (`OrderedMap`), every sort is stable, every string sort is ordinal.

Every quantity in the core is a `Num`, and the same sources build two ways. The default build makes `Num` an IEEE double, which is what the parity harness proves against the JS. The fixed build (`-p:StingFixed=true`) makes `Num` Q32.32 fixed point on a long, which is what R-04 asks for: integer arithmetic only, so no CPU, compiler or backend can change a bit (IL2CPP on ARM64 may fuse `a*b+c` into one rounding; integers cannot). Both builds evaluate the same expression trees in the same order; sim code never does arithmetic on runtime doubles, only on `Num` and on double constants that meet a `Num`.

The fixed build cannot match the JS bit for bit, so it is held to properties and to its own record instead: a save restored mid-run carries on exactly like the run that was never saved; two peers on good and awful links, a late joiner, a cheater's victim and a three-peer mesh agree on every human at every check; and `core/fixtures/fixed.txt` locks its digests so any later change shows. Against the double build it plays the same game: over the five scenarios the first difference is one deposit landing a tick later after 14 seconds, positions until then agree within 0.003 mm, and every end figure (stings, deaths, prey caught, deposits, adults to 0.1, brood, seasons) is identical. It costs about twice what doubles cost: a busy world (ten wasps out, forty humans, the player stinging) takes 95 µs per tick in fixed point and 47 µs in doubles, under 1% of one core at 60 Hz. Most of that came from one rule the world generator keeps and a test checks: everything a chunk holds lies within 34 m of its centre, so every scan for things near a wasp skips chunks out of reach.

The C# save is binary and exact (each number as its 8 bytes, a double's or a fixed point's); it is not interchangeable with the PoC's JSON saves, and does not need to be.

The PoC's 105 headless sim checks are ported too (`Behaviour.cs`), and so are the network checks the lab digests do not already cover (`NetBehaviour.cs`: peers far apart, rival fights and a raid across peers, pest control across peers, the wire format). All 117 pass in both builds: under clothing, perching, bees, webs, birds and dragonflies, landing and walking, rivals and raids, the exterminator, pest control, spills, fruit, nest sites, seasons, switching, saves and world modifiers. In the fixed build they are the proof that every mechanic still works in Q32.32.

Porting found three bugs, fixed in both: a line that went extinct kept ticking its colony and could come back the next autumn, alarm pheromone kept relaunching attacks on a human who had gone home; and the small per-decision hash reads four inputs, so calls that passed five or six (burrow positions, branch sites, fruit, bait stations) silently ignored the rest: both coordinates of a burrow came from the same number, every fruit of a tree fell on the same day, and only early in the windfall weeks. Such calls now chain two rounds of the hash.

### 18.19 Weather and bodies as built (T1-1 to T1-5)

**Wind.** Each day's weather now also draws a wind strength (0–3 m/s, ×1.4 on rainy days) and direction. Through the day it runs from 35% of that at dawn to full strength mid-afternoon, and gusts by up to 40%. A wasp in the air flies in it: 70% of the day's wind (the air at a wasp's size, among grass and leaves), scaled by height up to full at 3 m. Revised after play (2026-10-26): its airspeed is capped at its top speed and the wind adds to it, so flat out it is faster downwind and slower upwind (on a 1.6 m/s day at 3 m: 4.2 m/s downwind, 1.6 m/s upwind, cruise 3). With no input it leans into the wind and holds its place, so precise moves stay precise; that costs energy by airspeed, like flying (about 1.5× hovering in still air on that day). A wind stronger than its top speed (a gusty rainy afternoon, high up) carries it off. A wasp hugging the grass is barely touched. AI wasps fly the same model. Falling wasps are carried with the air. Wind is a pure function of seed and clock, so peers agree without sending it.

**Body temperature.** Flight is now gated by the wasp's own temperature, not the air's (POC.md design change 8). Body temperature relaxes toward a target over about five seconds: the air plus 12 °C in powered flight, 31 °C on human skin or under clothing, the ball's heat inside a bee ball, and otherwise the air, plus 8 °C when the wasp shivers. Shivering costs half the sugar of hovering and only works above 8 °C of air. Take-off needs 18 °C. Below 8 °C the wasp is torpid; 90 s of torpor kills it ("cold"), and it recovers if it warms first. The season adds its own swing to the daily weather: springs start up to 6 °C colder (fading out over the first quarter of the season) and autumns cool by up to 7 °C over the last fifth. Body temperature is part of the state hash and the save.

**Drowning in a drink.** Feeding at an open can carries a 3% chance per second of slipping in. The wasp has 4 s; each press of Space or Shift climbs 30% of the way, and an AI wasp gets out with a small chance each tick. Climbing out puts it over the rim and down the outside of the cup on the side it faces, stunned for half a second and slightly fuller (it used to come out over the middle of the cup and fall straight back in). Cans are lidded from alert level 2, which also ends this risk.

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

Every can on a table is a hollow cup: a 3 mm wall, open at the top, holding a drink between a third and nearly full (by hash, so every peer sees the same levels). The walls stop a wasp from the side; it gets in over the rim. It feeds anywhere within reach of the drink's surface: hovering just above it, or gripping the inner wall nearby. Touching the drink pulls it in (flying too low, or walking down the wall into it), and a feeding wasp can still slip in; mash Space or Shift to climb out over the rim. Someone within a metre who notices a wasp inside their cup puts a hand over it (a committed event, so every peer covers the same cup on the same tick) for ten seconds, and a wasp shut in a covered cup drowns in five. At level 2 the cups are lidded, which keeps wasps out and drowns any already inside. AI foragers go in from above and hover just over the drink. Resting on a flower head feeds as at a cup, and the HUD shows it.

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

**Limits.** A wasp that deposits its load at the nest before a denial arrives (it would need to be within a few hundred milliseconds of home) keeps it. Honey eaten during a lost robbery stays eaten; only the brood goes back. Chunk deltas do not go through the authority yet; late-event corrections do (18.43).

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

**Found on the way (T1-12).** An event that reached a peer on its commit tick, after that tick's commits were applied, was applied one tick late without being counted as late; it is now counted (and the late-event log no longer overwrote its own type). Past the commit window (the awful link) such an event can still make the peers' humans diverge from that tick on; correcting it is the chunk authority's job (11.6) and not built. The test bot that stings anyone seated now has to get past houses and fences, so the behaviour checks aim it at the home park.

### 18.35 Human days as built (T1-11)

**Who is out.** The chunk generator places people with something to do alongside the people at tables (8.2). A chunk slot now carries an activity and, for walkers, a path (pairs of points), so where they go is part of the frozen chunk and every peer has it. In yards chunks: a gardener in 30% of backyards, working three spots (the bed along the back fence, the lawn, the patio edge); a sunbather in 25%, lying in the backyard; a couple out for a walk round the block on the sidewalks, one each way. In the park strip (not the home chunk, which plays as before): a stroller on a square loop and up to three sunbathers on the grass. At the mall: a shopper crossing the lot to the doors and back. In the forest: now and then a hiker on a path through it. In the home region that is 53 stroller, 62 gardener and 25 sunbather slots. The generator version is 5.

**The weather picks.** Each activity narrows the person's arrival window (8.2) by the day's weather: a rainy day keeps all three indoors, gardeners need 12 °C at 1 pm, sunbathers 23 °C and lie out only between 10:00 and 17:30 (at least an hour or they stay in). The window is a pure function of seed, person and day, so a peer that loads the chunk at any time agrees on who is there.

**Walking and working.** A stroller walks its loop at 1 m/s, slower with age; a gardener walks to each spot, works it for 20–45 game minutes (a hash of person, day and spot) and moves to the next. Both notice wasps as they go (the same annoyance rules as at a table), and a sting, a sting that goes deep or a ripped shirt sends them running exactly as it does a seated person; when they calm down they walk back to the start of their path and carry on. Their state (the next point, when the gardener moves on, whether they are on their feet) is saved, and goes into the human hash the peers compare.

**Lying.** A sunbather lies on a towel: the standing body turned onto its back in the body frame (8.3), head toward the facing. The frame maps the standing capsules to the world and back, so a wasp can perch on a sunbather, sting one, crawl under a shirt or be swatted by one with no new code; the hands reach as they do standing. A stung sunbather gets up and runs, then comes back and lies down again.

**Checks.** JS and C# check the slots in the home region, the lying frame (to the world and back, the front faces the sky, a body lies full length a hand above the grass), the weather rules, strollers walking their loops (the same distances to the metre in both), gardeners stopping at their beds, sunbathers lying still with skin to sting, a stung stroller running and walking on, and a walk surviving save and restore. The parity digests now cover the slots' activities and paths, the lying frame, and the stroll and garden states in the human hash (the cook's states were missing from it and are now in).

### 18.36 The remaining plausibility checks as built (T1-20)

These complete 11.8. Like the earlier checks, each reads only the event and the frozen world (chunk content is a pure function of the seed, so a peer that has not discovered the chunk generates it to check), never live state that peers may hold differently, so every honest peer reaches the same verdict, and only the host rules on a peer (11.11).

**Chunk deltas match their cause.** Every pickup (a fly, caterpillar, carrion, meat, a bee, honey, a load of pulp), whether taken directly or claimed through the chunk authority (18.32), now carries the wasp and where it was. Every peer checks that the thing exists (a fly or caterpillar of that index in that chunk, carrion on that day there, a grill at that table, a bee of that hive, a wooden box) and that the wasp was within 30 cm of it at that tick: flies and bees move by pure functions of time, so their positions at the event's tick are exact. A sip from a flower carries the wasp and where it last drank; the flower must be there and within reach, the sip at most 0.12, and one wasp cannot drink more than a wasp's rate allows over two seconds. A forged pickup is dropped before it touches the world and counts a strike.

**Carry limits.** A wasp carries one load. Every peer keeps a ledger of which of the other peers' wasps hold a load they took in view of everyone; a second pickup by the same wasp before it lets go is rejected. When a wasp lets go of such a load (delivered at the nest, taken back by a denied claim, or lost any other way) its owner publishes a `drop` (once per load, from a sweep at the end of each tick), and a death clears it too. The ledger is saved with the world. Building it found that a player's wasp could catch a fly while already holding one, the second replacing the first; that is no longer possible, for players or AI.

**Positions inside solid geometry.** No pickup or sip may come from more than 8 cm inside a house, shed, table, mall, trunk or grill, or below the ground; a wasp robs a bee box from its entrance, so bee boxes are left out. A player's own wasp in a state packet is not drawn where it is deep inside something solid, like a wasp that moved too fast (display only, so it cannot desync). The other wasps of a colony are not checked there: far from their owner they fly where that peer does not collide them.

**Checks.** JS and C# run two minutes of honest two-peer play (14 of A's pickups and 84 sips checked on B, none rejected on either peer, the same counts in both), and forged events: a second pickup without letting go, a pickup after a drop, a fly taken from 5 m away, a claim on a caterpillar that does not exist, pulp chewed from inside a shed wall and from outside it, an oversized sip, a sip from 3 m away, a wasp drinking too fast, a forged pickup that strikes and changes nothing, and a player's wasp reported inside a house. The save format is 17 (the ledger and recent sips, and whether a wasp holds a load it must say it let go of).

**Limits.** Fences and table tops are thinner than the 8 cm margin, so a position inside one is not caught; a player's wasp reported going straight through one between two packets is (18.43). A cheat that takes things within reach and only within its own carry limit (honest-looking play with an aimbot) is not something these checks can see.

### 18.37 Water as built (T2-1)

**Sources.** Birdbaths stand in about a third of backyards, now and then in a park, and one in the home park: a stone basin on a pedestal, water to the brim at 72 cm, solid for collision and never wood. On a rainy day puddles lie on a chunk's streets and parking lots (on open ground where it has none, never under anything), from 20 minutes after the rain starts until six hours after it stops, which can run past midnight. Both are pure functions of the seed and the clock, so every peer has the same water. The generator version is 6.

**Carrying water.** A wasp over the water (hovering just above it, or standing on it) holds E for a second to take a load, which it carries home like pulp; delivered, it goes into the colony's water store, capped at 2 loads plus 0.06 per adult. Water loads are not contested and leave no chunk delta.

**Cooling.** Wasps cool the comb on hot days by spreading water and fanning it. The nest's heat is how far the air at the nest (the weather, plus the sun on an attic roof) is past 31 °C, through the site's insulation. A hot nest uses up to six loads a day at full heat. While the store covers the need, the heat no longer slows the brood (the T1-14 slowdown goes away); short of water it slows as before. The comb itself warms from 30 °C by the insulated share of the outside heat; past 34 °C the brood the water does not save starts to cook, more the hotter it gets (at 38 °C with no water, about half of it a day).

**Who fetches it.** A hot nest with a low store diverts up to 40% of its abstract foragers from food to water, so a heat spell costs sugar and protein even when the comb is saved. Workers launched near the player become water carriers in the same proportion: they go to the nearest bath or puddle within 45 m of the nest, drink a load and bring it home. A player who brings water frees foragers for food.

**Checks.** JS and C# check the birdbaths in the home region, the puddle window and placement, taking a load at a bath and delivering it, a day of lethal heat with and without water (with water no brood is lost; dry, about half the brood cooks), the forager diversion, and an AI water carrier's round trip. The colony digest has a fifth run with a nest that runs hot every afternoon, and the state hash now includes the water store and the cooling. The save format is 18.

**Limits.** In ordinary summer weather the abstract foragers keep up, so water matters mostly in attics and on the hottest afternoons; heatwaves (T2-2) are where it decides things.

### 18.38 Extreme weather as built (T2-2)

**Spells.** The day's weather (still a pure function of seed and day) can belong to a spell. A heatwave starts on a day with a 2.5% chance and runs 3 to 6 days: 7 °C on the day's base temperature, no rain, the wind down to 60%. A cold snap starts with a 3% chance and runs 2 to 4 days, 9 °C colder. A spell runs its length and a new one can start only on a day no spell covers, so they never cut each other short; they are computed day by day from day 1 and memoized per seed, and day 0 is always ordinary. In 600 days of the reference world there are 11 heatwaves and 12 cold snaps. Spells ignore the season, so a heatwave can come in spring; the season's own chill still applies on top.

**Storms.** On a day outside a spell, a storm comes with a 5% chance: an afternoon downpour (from between 13:00 and 17:00, for 45 minutes to two and a quarter hours) in a 6 to 9 m/s gale that gusts more than twice as hard as ordinary wind. A storm's rain is three times as heavy: it floods a burrow nest three times as fast and leaves twice as many puddles (T2-1). In the downpour a wasp flying in the open is knocked out of the air now and then (0.4 times a second, stunned for three quarters of a second); under a table, a roof or a tree crown it is sheltered. The gale is stronger than a wasp flies, so a wasp that tries to hold its place in the open is carried off (15 m in three seconds in the test).

**Heat.** Flying above 32 °C costs 5% more sugar per degree, so a heatwave afternoon at 37 °C costs a quarter more. On a heatwave afternoon an attic comb goes past the lethal 34 °C and its brood cooks unless the colony has water (18.37); a hollow tree stays cool.

**Shown.** The HUD's weather line names the spell and its day ("heatwave 2/4"), and a downpour; the colony view forecasts today and tomorrow, so a heatwave coming is the time to bring water in. A storm darkens the sky, slants the rain with the wind, and flashes lightning with thunder (presentation only).

**Checks.** JS and C# check that spells run their length and day 0 is ordinary, that heatwaves are dry and storms are afternoon gales, a downpour knocking a wasp down in the open but not under a table, the gale carrying off a hovering wasp, the extra cost of flying in heat, and an attic against a hollow tree on a heatwave afternoon. The weather digest now covers 240 days so it sees spells.

### 18.39 Males and mating flights as built (T2-3)

**Who a young queen meets.** A gyne's chance to mate now depends on the males about: her own colony's males plus the neighbourhood's, which rise with the breeding season (30 at its height). With 20 or more about every gyne that flies out finds one; early in the breeding season, with no brothers yet, fewer than one in ten does. So a colony that raises males early mates its queens early.

**The mating spot.** The tree near the nest with the best height for its distance (within 40 m) is where males wait: over its crown, 60 cm above the top. It is a pure function of the nest and the frozen chunks.

**Males and gynes in the air.** Near the nest in the breeding season on a fair day, up to four males and two young queens fly out at a time, taken from the colony's counts and returned to them if they come home. Males circle the crown; at dusk, in rain or when tired they go home. A young queen circles the spot; a male of the line within 25 cm mates with her, or she meets one of the neighbourhood's males now and then (2% a second at the height of the season). She leaves to winter (counted as mated), and the male, who mates once, dies. A gyne who finds no one in a minute goes home.

**A male's body.** No sting and no venom: he cannot sting or press a sting, and does no work (no prey, pulp, water, robbing or crawling under clothes; he can perch, and feeds at flowers like anyone). He flies 10% faster than a worker and lives about three days of season time. He is drawn with a seventh abdominal segment, no stinger and long antennae; a young queen is drawn at queen size.

**Playing as a male.** The player can switch to a male (never to a young queen). The HUD says where the mating spot is; flying into a young queen there mates with her, and his life ends there (the player then takes a worker, as after any death).

**On the wire.** State and swarm packets carry the male and young-queen castes in spare bits, so other players see them as such.

**Checks.** JS and C# check the mating chance with and without males, the spot over a crown near the nest, males patrolling and young queens mating (three matings with males of the line in the same run in both), a male unable to sting or catch prey, and a player's male mating with a young queen. The save format is 19.

### 18.40 Lineage colonies as built (T2-4)

**Founding.** In spring, after the player picks a queen, the line's other surviving queens found colonies, up to five as real ones. Each takes the nearest free trunk within 40 m of where it wintered (at least 8 m from every other nest of the line and from where the player's queen woke) and builds its nest there, facing the site. Queens beyond the five, or with no free tree, stay a count of queens elsewhere, which survives the winter by the old abstract rate as before.

**Running them.** A sister colony is stepped like the player's (the same colony model, brood speed and heat for its site, water, the season, the forage the season offers). Its founding queen, alone, brings in a little food a day by herself; once workers emerge, they forage abstractly. When the player is near a sister nest in daylight, up to three of its workers fly out and forage from it (the same forager brain as rival colonies' workers, with their own nest as home). A colony that collapses is gone. Sister colonies are not rivals: their workers never fight the player's, the player's guards leave them be, and rival colonies fight them as they fight the player's.

**The line goes on.** At the end of the season each sister colony's mated queens winter by its nest; they are offered in the spring choice with the player's own (as sites "in a sister nest"), so the player can wake as a queen of any colony of the line. If the player's own colony is lost mid-season while sister colonies live, the player takes over the strongest of them (adults plus brood) instead of going to winter early: its nest and colony become the player's, and the player flies on as one of its workers.

**Shown.** Sister nests are drawn like the player's; the colony view lists each sister colony (adults, brood, distance) and the count of queens elsewhere; foundings, losses and a takeover are announced.

**Checks.** JS and C# check founding from wintering sites (four colonies from four queens, at least 8 m apart), a sister queen raising her first workers alone (one adult and 24 cells by day 3 in both), her workers flying near the player and not fighting the player's wasp, her mated queens offered in spring (6, 6, 6, 6 queens in both), save and restore, and taking over the strongest sister (29 adults in both). The save format is 20.

**Limits.** The exterminator who comes for a sister nest is abstract: he is drawn only for the player's own (18.43).

### 18.41 Town centres and beer gardens as built (T2-5)

**Where.** Every region has one town centre: a 2x2 block of chunks laid over yards. The region layout scans for it from a hashed start and takes the first 2x2 block that is all yards, never beside the home chunk. In 50 regions over two seeds every one has a town. One quarter of each block, chosen by the region hash, is the beer garden; the quarter diagonally across from it has the fountain.

**What is in it.** Each quarter is paved over with no street through it. It has three shops on its outer edges (7 to 11 m tall, solid, not wood) and up to two trees. The beer garden quarter has six picnic tables, every seat taken (36 drinkers), each table with its usual drinks plus a round of three beers, under string lights. The other quarters have groups of people standing about and flower planters. The fountain is a wide, low basin (1.1 m across, water at 0.55 m) that counts as water like a birdbath (T2-1). Most quarters have someone walking across the square. After rain, puddles lie on the paving as they do on streets and lots.

**Shown.** Paving with joints, shops with windows, awnings and upper floors, beer glasses on the tables, string lights on posts over the garden, the fountain with its jet. On the minimap a town is its own colour.

**Checks.** JS and C# check that every region has its 2x2 town, never next to home; that the beer garden has 6 full tables, 36 drinkers and 18 beers among 26 drinks (identical in both); that every quarter has its paving, three shops and no road; that there is one fountain, outside the garden; that a wasp over the fountain can take water and that inside a shop is solid; and that puddles after rain lie on the square, never inside a shop. The chunk digests now cover plazas, shops, gardens, the shop flag on boxes and the fountain flag on baths. The generator version is 7.

**Limits.** Shops are closed boxes: there is no going inside, and no shop sells anything to wasps. The beer garden's drinkers stay into the night (18.43).


### 18.42 Feature modifiers as built (T2-6)

**The modifiers.** Four feature modifiers are chosen on the start screen with the other world settings. *Woods*: no forest, one 2x2 forest corner per region (the standard), or wooded, two 3x3 corners diagonally across. *Towns*: none, one town centre per region (the standard), or two, which never touch. *Water*: dry (half the birdbaths and puddles), normal, or wet (twice as many birdbaths and puddles). *Beehives*: none, few, normal or many (x0, x0.5, x1, x2 the chance of a hive in a park or a backyard; with none, the hive by the home park is gone too).

**How they act.** They act at generation: the region layout and every chunk are generated with the world's modifiers, so the defaults produce exactly the standard world. They are rules, so they go into the rules hash peers compare, into the world tag ("wooded · no towns · dry · hives ×2"), and into saves; a restored world regenerates its chunks with them. They are set when a world is made and do not change during play, so the question of live changes to undiscovered land (4.8) does not come up yet.

**Checks.** JS and C# count over 9 regions with seed 1234: forest chunks 0, 35 and 136 for no woods, normal and wooded; town chunks 0, 36 and 72 for none, one and two a region, and two towns never touch; birdbaths in the home region 23, 49 and 73 for dry, normal and wet; beehives 0, 10 and 12 for none, normal and many. Identical in both. A world made with modifiers generates every chunk with them and keeps them through a save; a dry world leaves 2 puddles in a chunk where a normal one leaves 5. The C# save format is 21.

**Terrain** came after the known limits were closed (18.44).


### 18.43 Known limits closed (polish before terrain)

Agreed 2026-10-27: the PoC's known limits are worked through before terrain is tried.

**Pitched roofs.** Shed and house roofs now collide as they are drawn: a prism on the walls, its ridge along the long side (1.9 m high on a house, 0.55 m on a shed), overhanging 0.12 m at the eaves and 0.1 m at the gables. A wasp is pushed out onto the slope, lands on it at its tilt and walks on it; inside a roof is solid for the plausibility checks; under the eaves is dry in the rain. The drawn slabs' top faces lie on the solid slope (world.js `shedRoof`, used by both). A shed's wood is chewed from its wall now, since its top is under the roof.

**Strollers and gardeners.** One who ran from a sting walks back to the nearest point of their round and carries on from the waypoint after it, rather than going back to where the round starts. The point is worked out afresh each step, so nothing new is saved.

**Beer gardens.** The drinkers come from 16:00 to 19:00 and leave from 21:30 to 23:30 (rain still sends them home). `T.days` holds the hours; the chunk digest covers which seats keep evening hours.

**The landed eye view** (hold RMB) now looks along the wasp's own heading on whatever it stands on, with the surface's up as up, so on a trunk or under a table it turns with the wasp.

**Other players' wasps on the minimap.** Near and mid-tier remote wasps are blue dots; far-tier traffic is a cluster of dots per chunk, with the count when it is over nine, or a tick at the edge of the map pointing at a chunk off it.

**Through thin solids.** A player's own wasp reported in a state packet is not drawn where it went straight through a fence, a table top or a bench seat since the last packet, crossing it more than half the distance a wasp could fly in that time from the face's edges (so an honest turn round the end of a fence is never taken for one). Display only, like the speed and solid checks.

**Sister colonies, rounded out.** Near the player a sister colony now does what the player's does: once it has 25 mature adults it posts two guards at its entrance, who go for rivals and other players' wasps there (never for the player's); in the breeding season its males and young queens fly to its own mating spot over the tallest crown near it, and its queens mate with any male of the line, the player's or a sister colony's (the player's young queens likewise). Males and queens that go home are back in their own colony's counts. Pest control's bait poisons a sister colony in a campaign's area as it does the player's. When a sister nest's neighbourhood reaches the exterminator's level he is called to it: he comes the next morning (or in two hours, before mid-afternoon) and destroys it unless the neighbourhood calms down first. He is abstract there; only the player's own nest gets the exterminator in person. The C# save format is 22 (when he is due at each sister nest).

**Late-event corrections.** An event that reaches a peer after its commit tick is still counted and applied late, and now that peer asks for a correction (an immediate `fixReq` naming the chunk the event lands in: its human's, or the chunk it names), or queues one itself if it is that chunk's authority. The authority publishes a `fix`: the chunk's humans (all their state) and the chunk's shared state, as it has them. A correction commits 120 ticks after it is sent, a longer window than an event's 30, so it reaches every peer in time on a slow link; on its commit tick every peer, the authority too, takes that state as it stands, so they agree from then on. Only the chunk's authority at the commit tick can correct it; a chunk is corrected at most once every 30 ticks. What happened to those humans between sending and committing is lost on every peer alike. The lab has a link well past the window (24±6 ticks one-way, 10% loss) to show it: 2 late events, 2 corrections, 297 of 300 checks agree and the peers agree again after each; with the corrections switched off they drift apart (238 of 300). Its run is a new parity digest (`net.over`), identical in JS and C#. The lab panel counts corrections.

**Colony against colony.** Each peer says where its nest is (an immediate `nest` event) when it moves or dies, and every ten seconds so a peer that joins hears it; other players' live nests are blue rings on the minimap. At another player's nest entrance (not where the player's own nest is: players can share the home tree) E steals a larva, as from a rival's nest: the thief carries it home as protein, and the owner's colony loses a larva and its guards go after the thief (the `praid` event). Every peer that knows where that nest is checks that the raid was made at its entrance, so a raid claimed from off the nest is rejected with a strike. The player's own wasp raids; AI workers raid neither rival nests nor other players'.

**Checks.** JS and C# agree on all of it: the stroller is back on its round 15.0 m from where it ran (the round starts 46.6 m away); 630 evenings out in 30 days at the beer garden; a wasp pushed out of a house roof ends 1.44 m above the eaves on the slope; a fence crossing in the middle is caught, over the top or round the end is not; a sister colony of 40 posts 2 guards who go for a rival at its entrance; 2 of its males and 1 of its young queens fly to its mating spot and mate; the exterminator destroys a sister nest whose neighbourhood calls him; pest control poisons 0.89 adults of a sister colony in its area over 20 colony ticks; a raid takes a larva from the other player's nest (45 to 44) and one claimed 3 m off it is rejected.


### 18.44 Terrain as built (T2-6)

**The choice.** A fifth feature modifier, Ground: flat (the standard), rolling or hilly. The ground's height is a smooth value-noise field in two octaves (36 m and 11 m cells, the second at 0.3 of the first), 2.5 m per step of the modifier. The ground is level within 14 m of the home tree, rising to full height over the next 24 m. Land use damps it, blended smoothly between chunk centres: a town square at 0.1 and a mall at 0.12 are near level, yards at 0.45 are graded gently, parks and woods roll freely. Around a town block's middle the steepest slope is 0.04; in a hilly park it is 0.53. A flat world is height 0 everywhere and generates and plays exactly as before.

**How it is built.** The sim works in height above the ground. Collision, landing, walking, humans, reach and every placed object are unchanged, so the cost in the sim is nothing measurable (0.38–0.41 ms a tick with or without hills). The ground's height is drawn: every vertex of everything is lifted by the height where it stands, read in the vertex shader from a 128 by 128 height map (4 m texels, 512 m across) round the camera, and the camera and the sun go with it. The map takes about 30 ms to rebuild, once the wasp has flown 64 m from its middle. Large buildings lean slightly with the ground they stand on, which is why built-up land is damped. Flat worlds never patch a material.

**What hills do.** A rise between two people blocks their sight line (checked every 4 m along it between their eye heights): on a hilly world 53 of 140 open sight lines across a park are blocked. Rain settles in hollows: on open ground a puddle takes the lowest of three spots (0.30 m against 0.98 m). The wind is stronger on a rise, by 5% a metre (0.516 against 0.429 m/s at the foot). Terrain is in the rules hash, the world tag ("rolling", "hilly") and saves (C# format 23). The height field is part of the `motion` parity digest, and JS and C# agree on every check.

**Limits.** Flight does not feel the slope: a wasp flying level stays at the same height above the ground and climbs a hill without effort. Hills are not solid to sight lines between a wasp and a person, only between people. A building does not sit level on a slope; it leans with the ground.


### 18.45 Lock-on, assisted flight and feeding as built (7.9)

**Feeding no longer stops for resting.** A wasp hovering to feed at a flower used to settle, when it stopped moving, on whatever was nearest, often the stalk, the grass or the underside of the head, where it could no longer feed. Now a wasp standing anywhere on a flower head feeds from it, and a feeding wasp only settles on the flower or the drink it feeds from. What remains is the flower itself: a full flower is drunk dry in about four seconds and refills over the day (T1-8), so the HUD says "Flower drained · try the next" instead of "Resting".

**Lock-on and the pilot.** `sim/assist.js` (and `Assist.cs`): `pickTarget` (a spot on a person by the aim line against the body capsules; else the nearest to the aim within about 8°; else the nearest prey or hazard within 8 m), `targetPos` (where a target is now, or null when it is caught, drained, gone), and `assistPilot` (one tick of commands: heading and pitch to the next waypoint, a speed falling with distance, from above for landables and along the outward side for a person; still at the goal so the wasp settles or perches; pressing E in pulses on prey; a take-off first when standing elsewhere). The game wires the keys, faces the camera to the target, draws a ring and a label on it, and hands control back on any move key.

**Checks.** JS and C# agree: the lock picks the aimed flower; aimed at the sky it takes the nearest danger (a bee); the pilot lands the wasp on a flower from 1.6 m in 3.5 s and it feeds; from that flower it takes off and lands on the next in 4.0 s; aimed at a seated person it locks the torso and perches on that spot in 3.2 s; locked on a caterpillar it catches it in 1.3 s; a wasp landed under a flower head feeds; a wasp hovering to feed never settles on the stalk or the grass.

**Limits.** The pilot flies straight at its waypoints and slides off whatever is in the way; it does not plan round trees or houses (since 18.52 it steers round what is close ahead). It does not dodge: a swat or a bird during an assisted flight is the player's to answer with a move key.

### 18.46 The swoop as built (7.9)

**The move.** `Act.Swoop` (X, d-pad up) starts a dash: `T.swoop` speed 9 m/s held for 18 ticks with 60 m/s² of steering, 0.012 energy, ready again after 40 ticks. With no input the dash runs along the heading; with input it goes where it is steered. The wasp cannot settle gently during the dash. Each substep checks what it has reached within `reach` (5 cm):
- prey, which is caught;
- a person, who is perched on, given a `notice` (the swat a touch earns) and a `startle` of `panic` 0.3;
- a surface met head on (at least `minInto` of the speed toward it), which is landed on.

Any slam startles the people within `scareR` (1.5 m) by `nearPanic`. A `startle` is a committed event like a notice, checked for its range (11.8), so peers agree on the panic.

**Dynamic with a lock.** `swoopPilot` (`assist.js`, `Assist.cs`) builds the commands. It homes on the target's goal (the flower top, the outward side of the body spot), easing off as it closes so it does not overshoot, and it turns away from a hazard. It reports how the swoop ended (caught, landed, perched, spent) so the game can toast it.

**Checks.** JS and C# agree: with nothing locked, the dash peaks at 9.5 m/s, covers 5.1 m in a second and is back to cruising after; a second swoop waits for the first to recover; skimming the grass does not land; locked on a flower it lands in 0.28 s; locked on a seated person it slams on and their panic goes 0.00 to 0.27 with a notice; locked on a caterpillar it catches it in 0.27 s; locked on a web it dashes from 0.8 to 2.8 m away.

### 18.47 The three species as built (6.8, T2-9 to T2-11)

**One code path.** `T.species` holds a row per species: multipliers over the wasp's values and flags for what differs in kind. Every wasp carries `sp`; the player's line is `settings.species`, picked on the start screen ("Play as"). The PoC runs `progression: 'open'`, so all three can be picked from the start. `progression` is a world rule, in the rules hash and the world tag. `species` is the player's choice inside it, so it is not in the hash. The neighbourhood's rival colonies stay yellowjackets. A colony of the line keeps its species. Saves keep the line's species (C# save version 25); old saves load as wasps.

**Hornets** (*Vespa crabro*, Appendix C).
- **Body:** 1.7 times the size and a swat radius 6 mm larger. 15% faster, 30% more energy per second of flight, and they feel 65% of the wind.
- **Colony:** starts at 0.35 of a wasp colony, lays at 0.3, and sends half as many workers out at once.
- **Sting:** pain is 1.8. A hornet's sting scales the panic it adds and the alert points it earns; the plausibility checks reject any `pain` over 2. People notice a buzzing hornet 1.6 times sooner.
- **Night:** hornets forage after dark (rain still grounds them). Each house has a porch light on one long wall, derived from the frozen houses, so old worlds have them too. Lights burn from dusk to dawn with three moths circling each.
  - A hornet takes a moth for 1 protein; it is back 40 seconds later.
  - AI hornets smell a lit porch from afar.
  - Flies settle for the night for every species.
- **Wasps as prey:** E at a rival yellowjacket in the air kills it and carries it home (2 protein, death cause "taken by a hornet"). AI hornets hunt them by sight. In a wrestle a hornet adds 1.5 to its score and keeps the loser.

**Honeybees** (*Apis mellifera*).
- **Colony:** starts 2.5 times larger, with room for 2.5 times the cells. Lays 1.5 times as fast and keeps ten times the sugar (honey). Cells are wax, built from honey while the store is over 30% of its cap.
- **Food:** protein is pollen. A worker standing on a flower in bloom packs a load in 4 seconds; AI pollen foragers wait at the flower until it is packed. Bees take no prey and chew no pulp. They raid no wasp nest and take no bait. Robbing a feral hive takes honey only.
- **Barbed sting:** a worker that stings a person, in the open or under clothing, leaves the sting in. On release it pumps in the rest (a full sting's pain), and the bee dies ("left its sting in a person"). The queen can sting again. Bees are noticed later (0.6) and hurt a little less (0.9). Five guards keep the entrance.
- **The year:** the colony does not collapse in autumn and its queen does not die.
  - Between 15% and 50% of the season a crowded colony (120 bees or more) raises 8% of its eggs as queens and drones.
  - With a daughter queen out, it swarms: the old queen leaves with 60% of the workers and 30% of the honey and founds a colony of the line on a nearby tree, run by the AI. The daughter keeps the hive.
  - At the season's end every colony of the line clusters on its honey: 0.05 sugar per bee per day of winter. What the store covers lives, less 30%. A cluster under 15 dies.
  - Spring goes on in the same hive. If yours died, the player takes the strongest of the line's.
- **Defence:** another colony's wasp that touches one of the line's bees is balled.
  - Bees within 5 cm, and guards that reach it, heat it 0.5 °C per bee per second until it cooks at 46 °C.
  - An AI wasp breaks out at 0.08% a tick; the player's presses work as at a feral hive (9.2).
  - Rival foragers rob the player's hive, by its scent or by memory (30% of a rival nest's foragers within 120 m, on any day). Each robber takes 1 honey and a larva and sends the guards after it.

**Network.** Nest events carry the species, so other players' wasps are drawn as theirs. Fight events carry the hornet's weight. Sting and deepen events carry their pain, which the checks bound. State packets know the new loads (moth, pollen, wasp).

**Game.** Hornets are red-brown and larger, with the chase camera further back, and build tan paper nests. Bees are built differently, not recoloured: no waist, a furry thorax, a stout rounded abdomen in amber and dark brown with pale hair bands, big eyes on the sides of the head, elbowed antennae, and broad hind legs that show orange pollen pellets when loaded. Wasps and hornets show their thin waist. Bee comb is wax-coloured. Lamps glow on houses at night, the nearest one lights its yard, and moths circle. Toasts tell pollen, swarms and robbers. The HUD names the species' workers, drones and pollen foragers.

**Checks.** JS and C# agree on every figure:
- **Starting colonies:** 30 wasps, 10.5 hornets, 75 bees.
- **Cruise speed:** 3.67, 3.37 and 3.16 m/s.
- **Stings:** a hornet's jab counts 1.80 alert points to a wasp's 1.00. A bee's jab becomes a full sting and the bee dies. A sting claiming pain 3 is rejected.
- **Hornets at night:** an average of 4.0 hornets out against 0.6 wasps; they take moths at the lights. At 22:00, E at a moth takes it, and E at a rival yellowjacket in the air takes that.
- **Bees:**
  - They take no prey.
  - In a minute of play (twelve in-game hours), 26 pollen loads bring 26 protein home.
  - A rival wasp sent to the hive robs it, is balled and is cooked.
  - A ten-day bee season swarms once, winters twice and goes on in the same hive.
  - A save keeps the species.
- **Parity:** three new digests (a hornet night, a bee season, bee stings) match bit for bit: 26 in all. 346 properties hold in both builds, and the wasp digests did not move.

### 18.48 Progression as built: XP, skills, the year's turn (6.8, T0 of T2-12 and T2-13)

**Two pools of XP** (`T.xp`), kept per line in `sim.prog` and in saves (C# save version 26). A player who joins a world starts at zero.
- **Unit XP** comes from what the insect the player flies does: a sting on a person (4, plus 6 when nobody had stung them), a sting driven home (2), prey caught (3), a load brought home (1), a hive robbed (4), a quick release (2).
- **Hive XP** comes from what the colony does, counted each colony tick: 0.1 per adult emerged, 0.05 per load unit brought home by anyone, 2 per young queen raised. A colony taken over from the line counts only what it does after.
- **Stabs** are the line's stings on people nobody had stung: the stings that move the counter.

**Skills** (`T.skills`) are the line's know-how, so every insect of it has them. The insect does the work, assisted or on its own; the player directs. They are learned in the colony view (N, Skills). Learning travels as input, a negative `pick` in the command, so it replays and peers see the same line.
- **Unlocks** (unit XP):
  - Dash, the swoop of 18.46 (40).
  - Assisted flight: E with a lock flies there and lands, perches or grabs (40).
  - Reflex: time slows when a hand comes for you, solo only (30).
  - Focus: Z slows time for 3 s and is ready again after 15 s, solo only; it needs Reflex (50).
  - Quick release (60): an insect of the line stinging a person pulls out and away, at 2.5 m/s off the hand, when a swat is due to land within 8 ticks and would reach it. A bee still dies of its barb.
- **Ranked unit skills** (three ranks; 30, 60, 90 unit XP):
  - Landing reach: +40% a rank to the distance a still wasp settles from, and to the lock-on ranges.
  - Feeding reach: +20% a rank.
  - Grab reach: +20% a rank.
  - Flight speed: +5% a rank.
- **Hive skills** (three ranks; 40, 80, 120 hive XP), multipliers on the player's colony only:
  - Foraging yield: +8% a rank to every load.
  - Brood growth: +8% a rank to development.
  - Population: +10% a rank to laying.
  - Comb building: +10% a rank to cells per load.
- A new line has none of them. The world setting `skills: 'all'` unlocks every unlock from the start for testing; it is a world rule, in the rules hash and the tag. Lock-on (V) and the eye turn (G) stay free.

**The year's turn.** At the end of a wasp line's season the sim makes an offer:
- 600 XP in all and 25 stabs: wake as hornets.
- Under 150 XP and under 5 stabs: try honeybees.
- Anything between: no offer.
- A `fixed:` world never offers.

The winter screen shows the offer as a box to tick. A pick of 1001 and up wakes the chosen queen as the offered species. A hornet queen founds alone, as a wasp queen does. A honeybee queen comes with a swarm of 60. The line's other queens wake as they were and found colonies of the old species. Declining goes on as wasps. XP and skills carry over.

**Checks.** JS and C# agree on every figure:
- **XP and learning:** the dash does nothing until learned. A first sting earns 10 unit XP and a stab. Focus needs Reflex. Learning costs what it says and is refused without the XP.
- **Ranked skills:** speed rank 3 is 13% faster (3.37 to 3.81 m/s). Grab rank 2 catches a caterpillar a quarter further off.
- **Hive skills:** foraging and brood at rank 3 raise 39.1 adults against 30.4 in two days. A colony earns about 1.6 hive XP a minute of play.
- **Quick release:** a lingering sting is swatted dead without it; with it the wasp pulls out first.
- **The year's turn:**
  - The offers fall where they should.
  - A strong line wakes as a hornet queen, with three wasp colonies of the line beside it, and a save keeps it.
  - A weak line can take a bee swarm of 60.
  - Declining stays wasp.
- **Parity:** a new digest (all unlocks, a lingering sting bot that fires 18 quick releases, ranked skills learned every 25 s with the XP the bot earns, and the XP pools and ranks digested once a second) matches bit for bit: 27 digests. 362 properties hold in both builds.

### 18.49 Multi-colony play and the player gauge as built (6.8, T0)

**Colonies of the line.** Every colony of the line can be taken in hand from the colony view ("Colonies of the line"). The command is a pick of -1000 minus the colony's id, so it replays.
- The colony you leave becomes a colony of the line under the AI.
- You fly a fresh worker from the new nest, and the line's species follows the colony in hand.
- A founding queen without a nest cannot hand it over.
- After a year's turn to hornets, the wasp colonies of the line are there to go back to. A honeybee colony beside wasp colonies is the "multi game" of 6.8.

**Mixed lines through the winter.** A honeybee colony of a wasp line winters as a cluster on its honey and is still there in spring, beside the colonies the new queens found. If no queen survives but a hive does, the line goes on in the hive. When the colony in hand is the honeybee hive, the line's wasp colonies die with the autumn and their queens add to the line's count elsewhere.

**The gauge** (`T.gauge`) measures how well the player plays:
- **What it counts:** only XP earned in hand, meaning unit XP and the hive XP of the colony in hand.
- **How it is smoothed:** a running rate per in-game day, over a three-day window. Idling lets it fall.
- **The gauge:** the rate over 40 a day, between a floor of 0.25 and 1. It stays at the floor until a day of play is measured.

Every colony on the AI works at the gauge:
- It earns hive XP for the line times the gauge.
- It uses the line's hive skills scaled by the gauge, so never more than the player has learned.
- It forages at 80% to 100% of full, by the gauge.

A good player's colonies prosper while they are away. Nothing the AI does feeds the gauge, so it cannot be farmed.

**Checks.** JS and C# agree on every figure:
- **The gauge:** 0.25 until measured, 0.95 after nine days at full rate, 0.35 after three idle days.
- **AI colonies:** one on the AI earns 0.65 hive XP in a minute at full gauge against 0.16 at the floor, and brings in more.
- **Switching:** taking a bee colony in hand flies a bee from its hive while the wasp colony goes on under the AI, and back again. A founding queen is refused.
- **Mixed winters:** a bee colony of a wasp line winters from 75 to 53 bees and is there in spring beside the new wasp colonies. A save keeps the line and the gauge (C# save version 27).
- **Parity:** a new digest (a bee season with a swarm, switching colony every 2000 ticks, the line's colonies and the gauge digested once a second) matches bit for bit: 28 digests. 369 properties hold in both builds.

### 18.50 Wintering in somewhere warm as built (6.6, 6.7, 6.8)

**Agreed 2026-10-28.** A colony of any species can come through the winter if its nest is warm: inside a house, or the hollow of a giant tree. A house comes with a danger: grow too big there and the people living in it find the nest. Biology: in the southern US a small share of yellowjacket nests survive the winter as perennial nests and grow very large (Appendix C). The game turns that into shelter.

**Warm nests** (`T.warm`).
- A nest founded in the wall or attic of a house (not a garden shed), or in the hollow of a tree with a trunk radius of 0.32 m or more, is warm. These are the thickest trunks in the generator, about one in ten.
- A warm wasp or hornet colony keeps its queen past the autumn and does not collapse. It raises at most half its autumn eggs as queens and males, so it keeps workers to winter with.
- At the year's end it loses 35% of its adults and goes on if 20 are left. Its young queens still mate and winter as usual.
- A honeybee colony still winters on its honey anywhere, but an exposed one loses up to 25% more, by how little its site insulates.
- The colony panel says whether the nest can winter through.

**The spring choice.**
- When the nest the player holds wintered in, the winter screen offers to stay in it: the same colony, its queen, a worker in hand. All the young queens found colonies of the line.
- Left alone, the screen keeps the nest.
- Waking as a young queen instead leaves the wintered nest to the AI as a colony of the line.
- If no queen survived but the nest did, the line goes on in it.
- Warm colonies of the line winter in the same way.

**The household.** A colony in a house that reaches 150 adults is found by the people living there, whatever the stings. They call the exterminator, show him the nest (he does not search) and do not forget it, even if the colony shrinks. A sister colony in a house is found the same way.

**Checks.** JS and C# agree on every figure:
- **Warm sites:** a nest in a house is warm; one in a garden shed or an ordinary hollow is not.
- **Autumn:** in a warm nest the queen outlives the autumn, with 36 adults left against 17.
- **Winter:** a warm nest of 120 comes through with 78, the queen alive, and three colonies of the line beside it. The screen keeps the nest by default; waking a young queen leaves it to the AI. An exposed nest dies as before.
- **The household:** a colony of 150 in a house books the exterminator with no one stung, and he is shown the nest and destroys it.
- **Bees:** an exposed honeybee colony winters to 41 against 53 in a warm one.
- **Parity:** a new digest (a fed colony in a house through two winters, staying in each spring) matches bit for bit: 29 digests. 379 properties hold in both builds (C# save version 28).

### 18.51 Chasing moving prey; a colony view you can click (7.9, 10.3)

**Found in play (2026-10-28).** Locked on a fly or a bee, the wasp could not catch it. Closing in under a lock eased the throttle down near the target (down to 12% within the last 0.6 m), and the pilots braked the same way, so the wasp settled at the prey's pace a hand's width behind. Flies drift at 0.5 to 1.3 m/s; commuting forager bees fly at up to 5.8 m/s, against the wasp's 3 m/s cruise and 6 m/s burst.

**The fix.** `targetVel` gives a target's velocity. Prey positions are functions of the tick, so it is exact: next tick's position less this one's, or the hunter's own velocity for a bird or dragonfly on the hunt.
- **By hand under a lock:** W is never eased below the prey's pace plus 35% of cruising (replaced in 18.53).
- **Assisted flight:** it aims where the prey will be (lead up to half a second) and flies at its pace plus at least 1 m/s of closing speed, with burst when that is past cruising. It grabs by distance to the prey itself, not the led point.
- **The locked swoop:** it leads the target too, and its braking keeps the prey's pace on top.
- Targets that stay put (flowers, drinks, people at rest, caterpillars) are flown to exactly as before.

**The colony view (N).**
- It frees the mouse: a cursor to click with, and the panel scrolls. Closing it, with N or Esc, takes the mouse back; a click on the game does too.
- Clicks on the game while it is open do not sting.
- The panel is twice as wide, with the skills in two columns.
- The colony-view time speed moved to the pause menu (Esc).

**Checks.** JS and C# agree: locked on a fly drifting at 0.47 m/s, assisted flight catches it in 0.55 s. Locked on a forager bee commuting at 3.8 m/s, it runs it down with burst in 2.15 s. The static-target timings of 18.45 are unchanged. 381 properties hold in both builds, and the 29 digests are unchanged.

### 18.52 Obstacle avoidance in assisted flight (7.9)

**Found in play.** Assisted flight went straight at its waypoint and slid along whatever was in the way. Locked on the nest from the far side of the home tree, the wasp scraped round the trunk. Locked on a flower behind a garden fence, it pressed into the fence and never arrived.

**The fix.** `avoidHeading` in `sim/assist.js` (and `Assist.AvoidHeading`) runs before the pilot sets its heading.
- **Look ahead.** It checks the way to the waypoint for a short distance: 0.3 m at rest, up to 1 m at speed, stopping short of the goal itself. A point is in the way if it is within the wasp's radius plus 3 cm of a box (fences, tables, walls), a cylinder (trunks, birdbaths, grills) or a pitched roof. The ground is not an obstacle.
- **A fan of turns.** If the way is blocked, it tries turns in order: up, the sides, up and to the sides, then wider. It scores each by how far it turns, and a little by how far it leaves the way the wasp is already going, so it does not flip between sides.
- **Getting somewhere.** A turn whose end still has no clear line to the goal scores worse. Without that, a long fence kept the wasp running along it, both ways in turn. With it, the wasp climbs straight up, or back and up, and over the top.
- **Boxed in.** If no turn is clear, it takes the one that stays clear longest. A turn keeps at least half throttle, so the wasp does not stall at the obstacle.
- Targets with nothing in the way are flown to exactly as before.

**Checks.** JS and both C# builds agree:
- Locked on the nest from 1.2 m behind the home tree, the wasp goes round the trunk without touching it. It arrives in 2.52 s and comes no nearer than 0.149 m. Before, it arrived in 2.33 s, scraping the trunk for 17 ticks.
- Locked on a flower behind a 1.5 m fence from 0.8 m on the other side, it climbs over and lands in 3.43 s. Before, it never arrived.
- The timings of 18.45 and 18.51 are unchanged. 383 properties hold in both builds, and the 29 digests are unchanged.

**Limits.** It looks at most 1 m ahead and plans no route. A hedge or a house wall longer than it can see past still needs the player.

### 18.53 Reaching what moves: walkers and prey under a lock (7.9)

**Found in play (2026-10-28).** Locked on a person walking slowly, or on a bee going about its business, the wasp could not reach it, however much faster it was. Closing in, it was slowed down at about the same distance every time. There were three causes:
- **People had no pace.** `targetVel` gave nothing for a person, so a walker counted as standing still. W eased off within 0.6 m to as little as 12% of cruising, which is slower than a stroll. The emulated lock stalled 27 cm behind a walker at 0.85 m/s.
- **Aiming at where it is.** Pointing the wasp at the target's position, or a guess at its future position, with the speed added on, does not close the gap from the side.
- **Landing meant stopping dead.** Landing on a person needed the wasp under 0.25 m/s against the ground, so it could never settle on someone walking. A walker also moves in 20 Hz steps of a few centimetres, so touching them flickered on and off.

**The fix.**
- **A person's pace.** Each human step records how fast the person went (`vx`, `vz`, in saves; C# save version 29). A jump, such as arriving or sitting down, does not count as a pace. `targetVel` returns it for a person.
- **Flying the target's velocity.** Assisted flight and W under a lock both fly the target's velocity plus a closing speed toward it, steering by the sum. That closes the gap whichever way the target goes and matches its pace on arrival.
  - Prey is run down: at least 2 m/s of closing speed, with burst when the total is past cruising.
  - A person is come up to gently, slower the nearer the wasp gets.
  - W slows near targets that stay put (flowers, drinks, people at rest) as before. It never slows for a moving one. A and D still circle.
- **Settling at their pace.** Landing on a person compares the wasp's speed with theirs. Touching is measured with the slack of one step of their walk. Letting go of the controls against a walker settles the wasp on them, and so does assisted flight.

**Checks.** JS and both C# builds agree:
- Locked on a person strolling at 0.85 m/s, assisted flight settles on them from behind in 1.45 s, and from the side in 1.55 s. Before, it never did.
- Assisted flight catches a drifting fly in 0.62 s (0.55 s before) and runs down a commuting forager bee in 1.12 s (2.15 s before).
- The emulated lock by hand reaches a walker and settles on them in 1.67 s, letting go of W on touching. It reaches a bee at 1.35 m/s in 0.93 s, and one at 3.8 m/s with Shift in 1.65 s.
- Four digests changed (AI wasps now settle on and sting walkers), and the others did not. 385 properties hold in both builds.

---

## 19. Feature tiers and the current stack

The current stack is the three.js PoC (playable, `poc/`) plus the C# core (`core/`), kept bit-identical by the parity harness. There is no Unity project yet and no server. The PoC is where features are built and played; each feature is then ported to the core and proven against the PoC's digests.

### 19.1 Tier 0: built

Everything in `POC.md` (104 features) and its C# port (18.18), including the Tier 1 items built so far: T1-1 wind, T1-2 cold, T1-3 drowning in a drink, T1-4 clothing by temperature, T1-5 shake and flail (18.19), T1-17 panic by line of sight and T1-18 memory by recency and place (18.20), T1-14 hollow trees and nest thermals and T1-23 solo time (18.21), T1-6 fetching spray and T1-7 the exterminator's search (18.22), T1-13 worker ages and guards (18.23), T1-15 winter with choices (18.24), T1-8 seasonal ecology (18.27), T1-9 feral hives and robbing (18.28), T1-22 tuning as data (18.29), T1-16 senses for AI wasps (18.30), T1-10 barbecues (18.31), T1-19 chunk authority and contested pickups (18.32), T1-21 relevance tiers (18.33), T1-12 regions (18.34), T1-11 human days (18.35), T1-20 the remaining plausibility checks (18.36), and from Tier 2: T2-1 water (18.37), T2-2 extreme weather (18.38), T2-3 males (18.39), T2-4 lineage colonies (18.40), T2-5 town centres and beer gardens (18.41), T2-6 feature modifiers for woods, towns, water and hives (18.42), the polish of known limits (18.43), terrain (18.44), lock-on with assisted flight (18.45), the swoop (18.46), the three species (18.47): T2-9 species as data, T2-10 the hornet line, T2-11 the honeybee colony; the T0 of progression (18.48): XP, unit and hive skills, the year's turn; multi-colony play with the player gauge (18.49); wintering in somewhere warm (18.50); chasing moving prey with a lock, with a colony view you can click (18.51); obstacle avoidance in assisted flight (18.52); and reaching what moves under a lock (18.53). In short: the 60 Hz deterministic sim, chunked world frozen on discovery, humans with traits, zones, reach, swats, panic, clothing and garments, the colony economy and yearly cycle, every wasp on one code path, stinging, perching, walking, under-clothing play, escalation levels 0–5 with the exterminator and pest control, bees, webs, birds, dragonflies, rival colonies, nest sites, fruit, spills, saves, world modifiers, and peer-to-peer play in the lab with committed events, owner authority, plausibility checks and host rulings.

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
| T1-11 | **Built (18.35).** Human days: walk and lie postures, people strolling on paths, sunbathers lying on the grass, gardeners; the schedule picks the activity by weather and traits | 8.2, 8.3 | L | Q-06 for the paths |
| T1-12 | **Built (18.34).** Regions: an 8×8 chunk layout pass (park, gardens, houses with fences, farmland, forest edge) under the chunk pass, with pulp from fences that runs out (a chunk delta) | 4.2, 4.3, 4.5 | L | Q-06 |
| T1-13 | **Built (18.23).** Worker ages and guards: young workers stay in, older ones forage, the oldest guard the entrance and attack intruders (rivals, raiders, other players' wasps) | 6.5 | M | Q-07 for players |
| T1-14 | **Built (18.21).** Hollow-tree nest site and nest thermals: site insulation sets how cold snaps and heat slow the brood | 6.6 | S | |
| T1-15 | **Built (18.24).** Winter with choices: gynes pick hibernation sites whose quality sets winter survival; in spring the player chooses which surviving queen to continue | 6.7 | M | |
| T1-16 | **Built (18.30).** Senses for AI wasps: scent fields (sugar, protein, alarm) as decaying point sources and a vision cone, replacing the AI's perfect knowledge of every food source | 7.3 | M | |
| T1-17 | **Built (18.20).** Line of sight for panic: contagion only between humans who can see each other | 8.9 | S | |
| T1-18 | **Built (18.20).** Per-human memory: recency and place, so a person stung at this table is jumpy here and calmer elsewhere | 8.10 | S | |
| T1-19 | **Built (18.32).** Chunk authority and contested pickups in the lab: rendezvous hashing picks one peer per chunk to settle two wasps grabbing the same caterpillar | 11.6 | M | |
| T1-20 | **Built (18.36).** Remaining plausibility checks: carry limits, positions inside solid geometry, chunk deltas consistent with their cause | 11.8 | S | T1-12 for deltas |
| T1-21 | **Built (18.33).** Relevance tiers in the lab: near, mid and far wasps at different rates, swarm packets; measure bandwidth with a 200-worker colony | 11.12 | M | |
| T1-22 | **Built (18.29).** Tuning as data: the tuning tables as versioned plain-text files read by own parsers in JS and C#, and the tuning hash in the world record | 13 | M | |
| T1-23 | **Built (18.21).** Solo time: accelerate time in the colony view, and the Reflex slowdown as a solo option | 5.1, 7.8 | S | |

Sizes: S a day or less, M a few days, L a week or more. Order agreed 2026-10-23: the small mechanics first (T1-1 to T1-5, then the other S items: T1-14, T1-17, T1-18, T1-23, all done; T1-20 waits on regions), then the M items (T1-6 to T1-10, T1-12, T1-13, T1-15, T1-16, T1-19, T1-21 and T1-22 done, then T1-11 human days and T1-20; Tier 1 is complete); each batch is built in the PoC and then ported to the core with parity.

### 19.3 Tier 2: next, ordered by how cleanly each ports to Unity

Agreed 2026-10-27: Tier 2 is built on the current stack in the order that survives a straight conversion to Unity. Sim systems that live in the C# core come first; items that are mostly presentation, UI or engine performance wait for the Unity move. Multiplayer over a real network also waits for Unity and dedicated hardware (11.13).

| # | Feature | GDD | Size | Notes |
|---|---|---|---|---|
| T2-1 | **Built (18.37).** Water as a resource: birdbaths and rain puddles, water loads carried home, a hot nest cooled by water, brood that cooks without it | 6.2, 6.6 | M | sim and generator |
| T2-2 | **Built (18.38).** Extreme weather: heatwaves, storms (gusts and downpours), cold snaps | 5.3 | M | sim; makes T2-1 matter |
| T2-3 | **Built (18.39).** Males as wasps: drones fly physically late in the season, no sting, mating flights with gynes | 6.5, 6.7 | M | sim |
| T2-4 | **Built (18.40).** Lineage colonies as real AI colonies: the queens the player did not wake found colonies of the line, run by AI | 6.7 | L | sim |
| T2-5 | **Built (18.41).** Town centers and beer gardens: a new land use with dense outdoor seating and drinks | 4.1, 4.3 | M | generator and sim; new art |
| T2-6 | **Built (18.42, 18.44).** Feature modifiers that need the bigger generator: biome mix, town density, terrain | 4.8 | L | terrain touches all collision |
| T2-7 | The Reflex skill tree; now the Flight branch of the growth tree (T2-13) | 7.8 | M | mostly UI and progression: after the Unity move |
| T2-8 | Colonies of thousands of wasps out at once | 11.12 | L | engine performance: after the Unity move |
| T2-9 | **Built (18.47).** Species as data: a species table over the one wasp code path, species in the colony record and saves, the `progression` world setting with `open` in test builds and a species pick on the start screen | 6.8 | M | sim; first, everything below needs it |
| T2-10 | **Built (18.47).** The hornet line: a heavier body, a small colony, yellowjackets and bees as prey, night flight with porch lights | 6.8 | L | sim and generator |
| T2-11 | **Built (18.47).** The honeybee colony: a perennial colony, honey stores and the winter cluster, swarming, the barbed sting, balling as the player's defence | 6.8, 9.1, 9.2 | L | sim; reuses hives and balling |
| T2-12 | **T0 built (18.48, 18.49): XP, stabs, the bars and the spring offer; multi-colony play and the player gauge.** Experience and the year's turn: experience and stabs from sim events, the bars, the spring offer; multi-colony play (several colonies held, the rest on AI, switching in the colony view) with the player gauge: the player's measured rates set how AI colonies earn and play, capped at the player's level | 6.8 | L | sim; lineage-colony AI does the managing |
| T2-13 | **T0 built (18.48): unit and hive skills learned in the colony view.** The growth tree: branches, node effects as colony parameters, the colony-view screen (takes in T2-7) | 6.8, 7.8 | M | node effects sim; the screen after the Unity move |

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
| Experience | What a line has done, summed from sim events; spent on the growth tree and tested at the year's turn |
| Growth tree | The line's progression: Nest, Flight and Line branches |
| Gyne | An unmated new queen |
| Line | A founding queen and every colony descended from her |
| Player gauge | The player's measured rates from in-hand play; sets how auto-managed colonies earn and play |
| Progression | The world setting for which species a line may play: earned, open or fixed |
| Reaction plan | The deterministic list of swats and effects produced by a sting |
| Stab | A sting that moves the counter |
| Sugar deficit | Share of the colony's adult sugar need not covered by larval secretion |
| Swarm | A honeybee colony's way of reproducing: the old queen leaves with part of the workers |
| Year's turn | The spring test of a line that has run a whole year: hornets, wasps or the bee offer |

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
| European hornet in North America | introduced from central Europe, first detected in the 1840s; established across the eastern US | Penn State Extension, *European Hornet* |
| Hornet size | workers up to about 25 mm, queens up to about 35 mm | same |
| Hornet colony | peaks mid-September at 200–400 workers, large nests up to 1,000; yellowjacket nests hold 3,000–5,000 | same |
| Hornet habits | nests in hollow trees and wall voids; nocturnal, drawn to porch lights; hunts grasshoppers, flies and yellowjackets, sometimes honeybees; fallen fruit and bark sap in fall; annual, mated queens winter under bark or in walls | same |
| Honeybee colony | 2,000–60,000 workers, 0–500 drones in spring and summer | University of Georgia Honey Bee Program, *Honey Bee Biology* |
| Honeybee year | stores honey and pollen in autumn; winters as a tight cluster eating the stores | same |
| Swarming | crowded colonies rear daughter queens; the old queen leaves with up to 60% of the workers and moves into a new site within 24 hours | same |
| Honeybee worker ages | cleaning, fanning, feeding larvae, receiving loads, guarding, then foraging | same |
| Barbed sting | a worker cannot pull its barbed sting out of a person and dies; the queen stings many times, drones have no sting | UC ANR Bug Squad, *Why Do Honey Bees Die When They Sting?* |
| Perennial yellowjacket nests | in the south a small share of southern yellowjacket nests survive the winter as perennial nests, which can grow very large; most die at the first freeze | Mississippi State University Extension, *Southern Yellowjackets* (Bug's Eye View, vol. 2 no. 32) |

Sources:
- https://en.wikipedia.org/wiki/Vespula_vulgaris
- https://pubmed.ncbi.nlm.nih.gov/22233493/
- https://extension.psu.edu/european-hornet
- https://bees.caes.uga.edu/beekeeping-resources/getting-started-topics/getting-started-honey-bee-biology.html
- https://ucanr.edu/blog/bug-squad/article/why-do-honey-bees-die-when-they-sting
- https://extension.msstate.edu/taxonomy/term/4171/2016/southern-yellowjackets-vol-2-no-32
