# Working on STING from more than one thread

Several Claude threads work on this repository at once. Today there are two:
- the **game thread**: the sim, `game.js`, the C# core and the docs;
- the **world thread**: World v2, the world drawing in `poc/world/`.

The repository is the single place they meet. Everything goes through commits and pull requests, so the history shows who did what and why.

## Rules

1. **`main` always works.** All three JS suites and both C# builds pass on every commit to `main` (README, PoC tests).
2. **Each thread works on its own branch** and opens a pull request into `main`:
   - `world/<topic>` for the world thread (for example `world/grass-wear`);
   - `game/<topic>` for the game thread.
   - Small fixes to docs may go straight to `main`.
3. **Ownership.** The world thread owns `poc/world/` and `poc/world.html`. The game thread owns `poc/sim/`, `poc/game.js`, `poc/view/`, `core/` and `docs/`. A change in the other thread's area goes in a pull request whose description says why.
4. **The seam is GDD 20.4.** World v2 reads the sim through its source (`poc/world/sources/sting.js`) and never writes to it. A new thing the world needs from the sim (a channel, a list of places) is asked for in an issue or pull request, and the game thread adds it to the sim with its C# twin.
5. **Start from `main`.** Fetch and branch from the latest `main` before starting work, and rebase before opening the pull request.
6. **Commit messages** say what changed and name the GDD section, and end with the thread's attribution lines.

## Open asks

- **World v3: adopt the render origin (GDD 18.93).** The classic look draws everything from a floating origin RO (snapped to 12,288 m, moved when the camera is 9,216 m from it), so it draws 10,000 km from home as it does at home. World v3 still draws in absolute 32-bit coordinates, so the game holds RO at 0 when it runs. To adopt it, World v3 would add `world.setOrigin(x, z)`, put its clipmap and terrain centres in from RO (each level's texel phase stays whole, since RO is a multiple of every window), and read grass, trees, water and post patterns from the offset, as the lace foam already does. The game then calls `setOrigin` and drops the `W2on` guard in `originFrame`.

## A thread that cannot push

A claude.ai chat may only have read access to GitHub. It then hands its work over as files: an artifact, or a zip attached in the chat. The game thread, which can push, commits those files unchanged on a `world/<topic>` branch. It names the source chat and artifact in the commit message, and opens the pull request. Its own changes go on top as separate commits, so the history keeps the world thread's work and the game thread's integration apart.

To get push access instead, start the world work as a Claude Code session on this repository.
