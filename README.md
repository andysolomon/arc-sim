# arc-sim

[![CI](https://github.com/andysolomon/arc-sim/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/andysolomon/arc-sim/actions/workflows/ci.yml)

Deterministic American football **play-by-play** simulation engine.

Extracted from the [sprtsmng](https://github.com/andysolomon/sprtsmng) Dynasty Mode
simulator (`apps/web/src/lib/pbp/`). Pure TypeScript — no database, no UI, no network.

```bash
pnpm install
pnpm demo          # run a sample game
pnpm test          # unit tests
pnpm type-check
```

## Quick start

```ts
import {
  simulateGameLog,
  deriveStatLines,
  seedFor,
  RECOMMENDED_FEATURES,
  type TeamSimProfile,
} from "@arc-sim/core";

const home: TeamSimProfile = {
  teamId: "home",
  strength: 72,
  players: [
    { playerId: "qb1", position: "QB", overall: 78 },
    { playerId: "rb1", position: "RB", overall: 74 },
    { playerId: "wr1", position: "WR", overall: 76 },
    { playerId: "te1", position: "TE", overall: 70 },
    { playerId: "dl1", position: "DE", overall: 73 },
    { playerId: "lb1", position: "LB", overall: 71 },
    { playerId: "db1", position: "CB", overall: 72 },
    { playerId: "k1", position: "K", overall: 68 },
    { playerId: "p1", position: "P", overall: 65 },
  ],
};

const away = { ...home, teamId: "away", strength: 65 };

const log = simulateGameLog({
  home,
  away,
  seed: seedFor("pbp", "demo-game-1"),
  features: RECOMMENDED_FEATURES,
});

console.log(`${log.homeScore} – ${log.awayScore}`);
console.log(`${log.drives.length} drives`);
console.log(deriveStatLines(log).slice(0, 3));
```

## Which features to turn on

Every v2 mechanic is a gate, so a league can decline any of them. That is a
dozen booleans, and most callers do not want an opinion about all twelve:

| preset | what it is |
| --- | --- |
| `V1_FEATURES` | Nothing on — the original engine, byte-for-byte |
| `RECOMMENDED_FEATURES` | Everything that makes it more like football |
| `ALL_FEATURES` | The above plus `timeline`, for rendering |

`timeline` is the only thing `RECOMMENDED_FEATURES` leaves out. It changes no
outcome and adds roughly 70% to a stored log, so it is worth having only when
something is going to draw the game.

Spread a preset to disagree with one part of it:

```ts
features: { ...RECOMMENDED_FEATURES, injuries: false }
```

## Rendering a game

The engine is headless and stays that way. Graphics subscribe to what it
produced: with the `timeline` gate on, every play carries an ordered event
timeline and the scoreboard it began at.

```ts
for (const event of play.events ?? []) {
  event.t;        // seconds from the snap
  event.type;     // snap | handoff | pass_release | catch | tackle | touchdown | …
  event.playerId; // when the engine named someone
  event.spot;     // yards from the offense's own goal line, 0–100
}
```

Turning it on changes no outcome — the layout draws no randomness, so the same
seed is the same game with or without it — and `playTimeline(play)` is pure, so
a log stored years ago can be laid out on read. See
[docs/ENGINE.md](./docs/ENGINE.md#rendering-seam-timeline-gate).

## Watching it

`@arc-sim/core/render` turns a log into a Three.js broadcast. It is a separate
entry point: importing the engine never pulls in Three.

```bash
pnpm demo:render   # simulate a game headlessly, then watch it play out
```

```ts
import { FootballScene, choreographLog } from "@arc-sim/core/render";

const scene = new FootballScene({ canvas, homeTeamId: log.homeTeamId });
scene.enqueue(choreographLog(log));       // 23 keyframed tracks per play
scene.speed = 1;                          // 1 watch · 6 fast · 0 skip
requestAnimationFrame(function frame(now) {
  scene.frame(dt);
  requestAnimationFrame(frame);
});
```

The choreographer is pure and Three-free — it emits plain numbers, so the half
of the renderer with judgment in it is tested in Node. It may invent *how* a
play looked; it can never contradict *what* the engine decided.

## What this engine is

A **quarter-based state machine** that produces a full game log of drives and plays.
Scores and player stats are **derived from plays**, never invented from a final score.

| Layer | Role |
| --- | --- |
| `simulateGameLog` | Run the game → `PbpGameLog` |
| `deriveStatLines` | Reduce the log → per-player box scores |
| Feature gates | Opt-in v2 mechanics (penalties, clock AI, injuries, …) |
| `playTimeline` | Reduce a play → ordered events for a renderer |
| Seeded RNG | Same seed → byte-identical log |

See [docs/ENGINE.md](./docs/ENGINE.md) for the full architecture and design history.

## Package layout

```
src/
  index.ts          public API (no dependencies)
  pbp/              play-by-play engine (core)
  rng/              mulberry32 + namespaced seeds
  flavor/           chalk / balanced / upsets weighting
  schemes/          offense/defense catalog + weekly gameplan
  stats/            PlayerGameStatLine shape
  render/           graphics layer — @arc-sim/core/render (peer: three)
examples/
  sim-demo.ts       CLI sample game
  render/           browser demo (pnpm demo:render)
scripts/
  dist-check.ts     checks the built package, not the source
  gen-v1-golden.ts  regenerates the v1 parity fixture
docs/
  ENGINE.md         architecture deep-dive
```

`src/render` is the only place Three.js may be imported, and only in the two
files that draw — `scene.ts` and `rig.ts`. A test enforces both, so the
choreographer stays plain numbers and stays testable in Node.

Players are voxel rigs built from box geometry at three levels of detail, not
loaded from a model file: the package ships no binary assets and needs no
loader.

## Provenance

Ported from sprtsmng at engine version **2.0.0**, covering:

- v1 baseline: kickoff / rush / pass / punt / FG / XP / kneel / OT
- v2 Epic A: safeties, two-point, penalties, situational clock AI, fatigue/injuries,
  weather/crowd/rivalry, schemes + gameplan
- Added here: per-play event timelines (`timeline` gate) — the seam a renderer
  consumes, added without touching a single simulated outcome

Host-app concerns (Convex persistence, Gamecast UI, dynasty progression) stay in
sprtsmng. This package is the portable simulation core.

## Releasing

Publishing happens from CI, not from a laptop, so every release carries npm
**provenance** — a signed attestation tying the exact tarball to the commit and
workflow run that built it. A consumer can verify the code on npm is the code in
this repo rather than taking it on trust.

```bash
# 1. bump the version and land it
npm version minor && git push --follow-tags

# 2. cut a GitHub release on that tag — publishing is the release
gh release create v0.2.0 --generate-notes
```

The release job re-runs type-check, tests, build and `dist-check` before
publishing, because "CI was green on this commit" is a claim about a different
job. It then refuses to publish if the tag disagrees with `package.json`, or if
that version already exists on npm — both mistakes are permanent once made.

`workflow_dispatch` runs the same job in dry-run mode, so the pipeline can be
exercised without publishing anything.

**One-time setup:** an npm automation token in the repository's secrets as
`NPM_TOKEN`.

## License

MIT © Andrew Solomon — see [LICENSE](./LICENSE).
