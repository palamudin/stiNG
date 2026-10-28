# STING

`stung: 0 / 8,200,000,000`

An open-world, multiplayer wasp colony simulator. You run a colony through its yearly cycle and drive individual wasps into a world of humans whose reactions are fully determined, and bees who will kill you. No story, no quest, no ending. The game ends only when your colony line perishes, and then you start again from a single queen.

**Play the proof of concept:** https://claude.ai/artifact/9vBh3XSLYZ8J8feaZrVyNh

## What is here

| Path | What it is |
|---|---|
| [`docs/STING_GDD.md`](docs/STING_GDD.md) | The game design document: pillars, simulation architecture, world, colony (with the growth tree and the three playable species: wasps, hornets, honeybees), wasp, humans, bees, multiplayer, Unity contract, decisions, open questions, and findings from the PoC |
| [`poc/`](poc/) | The three.js proof of concept. A deterministic simulation core (`poc/sim/`) that owns every outcome, and a presentation layer (`poc/game.js`) that only draws. See [`poc/POC.md`](poc/POC.md) for the feature list and what has been verified |
| [`tuning/`](tuning/) | `sting.tune`: every tuning value of the sim as plain text, read by the PoC and the C# core with their own parsers (GDD 13). Edit it to retune; its hash goes into saves and the rules peers compare |
| [`core/`](core/) | `Sting.Core`, the simulation in C# for the Unity port: the whole PoC sim, network lab and saves. One source, two builds: doubles (bit-identical to the JS, 29 digests) and Q32.32 fixed point (the shipping build, GDD R-04). `Sting.Core.Tests` is the parity and behaviour runner, `Sting.Headless` the headless runner |
| [`protocode/`](protocode/) | C# protocode for the Unity port (`Sting.Core`): Fix64, the counter-based RNG, human traits, the sting resolver, reach, chunk storage and authority, colony economy. Compiles with zero packages |
| [`art/keyart/`](art/keyart/) | Key art sources: the stare, the standoff, the logo lockup and a Steam capsule (Design canvas `.dc.html` files) |

## Running it

Everything runs on stock tooling with no packages installed, on purpose.

**PoC in a browser** (Node 18+):

```sh
cd poc
node serve.mjs          # http://127.0.0.1:8080
```

three.js r160 is the one outside dependency, loaded by exact version from jsDelivr in `poc/index.html`.

**PoC tests** (headless, Node 18+):

```sh
cd poc
node test/sim.test.mjs   # simulation: determinism, replay, colony, humans, swats, bees, seasons, saves
node test/net.test.mjs   # two peers over simulated links: agreement on every human, late join, rival fights
```

**C# core** (.NET 8 SDK):

```sh
cd poc && node test/parity.mjs                          # writes core/fixtures/parity.txt from the JS reference
cd core/Sting.Core.Tests && dotnet run -c Release       # must reproduce every digest bit for bit
dotnet build -c Release -p:StingFixed=true && ./bin-fixed/Release/net8.0/Sting.Core.Tests
                                                        # the fixed-point build: saves, peer agreement, its own
                                                        # locked digests (--update after a deliberate change),
                                                        # and how far it drifts from the double build
```

**Headless runner** (GDD 14): run a world with no window and write a state hash stream, so the same command on different machines can be compared line by line.

```sh
cd core/Sting.Headless && dotnet build -c Release       # add -p:StingFixed=true for the fixed-point build
H=bin/Release/net8.0/sting-headless
$H run --seed 1234 --ticks 36000 --bot full --set escalation=3 --out a.txt --log input.stl
$H replay --log input.stl --out b.txt                  # on another machine, or the other build
$H compare a.txt b.txt                                 # "identical: 602 lines", or the first line that differs
                                                        # reads tuning/sting.tune from above the working folder,
                                                        # or --tune file; logs record its hash
```

An input log carries the world's settings and every tick's command, and replays in either build. Saves (`--save`, `--save-at`, `resume`) hold numbers as their bits, so a save loads only in the build that wrote it.

**C# protocode** (.NET 8 SDK):

```sh
cd protocode/check  && dotnet run -c Release   # Fix64 arithmetic, resolver invariants, chunk authority
cd protocode/parity && dotnet run -c Release   # must match poc/test/cs_parity.txt bit for bit
```

`core/nuget.config` and `protocode/nuget.config` clear every package source, so a build cannot pull anything from the network.

## Ground rules

- **Determinism.** The sim uses only IEEE-exact operations and its own trig in the PoC, and Fix64 in Unity. Same input, same outcome, on every machine. Replays and saves are bit-exact.
- **Sim owns outcomes, the engine owns playout.** A person stung on the back will always try to slap where it hurts. Whether they can reach it is decided by their body; how the slap looks is animation.
- **Multiplayer by design.** No rollback. Events carry positions and commit 30 ticks after they happen; every peer resolves the same humans identically. Owners decide about their own wasps.
- **Own code.** No third-party packages in the sim or tooling. Supply-chain exposure is limited to one pinned rendering library in the PoC.
