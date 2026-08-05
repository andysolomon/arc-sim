# arc-sim

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
  features: {
    scoringV2: true,
    penalties: true,
    situational: true,
    balance: true,
    weather: true,
    injuries: true,
    schemes: true,
  },
});

console.log(`${log.homeScore} – ${log.awayScore}`);
console.log(`${log.drives.length} drives`);
console.log(deriveStatLines(log).slice(0, 3));
```

## What this engine is

A **quarter-based state machine** that produces a full game log of drives and plays.
Scores and player stats are **derived from plays**, never invented from a final score.

| Layer | Role |
| --- | --- |
| `simulateGameLog` | Run the game → `PbpGameLog` |
| `deriveStatLines` | Reduce the log → per-player box scores |
| Feature gates | Opt-in v2 mechanics (penalties, clock AI, injuries, …) |
| Seeded RNG | Same seed → byte-identical log |

See [docs/ENGINE.md](./docs/ENGINE.md) for the full architecture and design history.

## Package layout

```
src/
  index.ts          public API
  pbp/              play-by-play engine (core)
  rng/              mulberry32 + namespaced seeds
  flavor/           chalk / balanced / upsets weighting
  schemes/          offense/defense catalog + weekly gameplan
  stats/            PlayerGameStatLine shape
examples/
  sim-demo.ts       CLI sample game
docs/
  ENGINE.md         architecture deep-dive
```

## Provenance

Ported from sprtsmng at engine version **2.0.0**, covering:

- v1 baseline: kickoff / rush / pass / punt / FG / XP / kneel / OT
- v2 Epic A: safeties, two-point, penalties, situational clock AI, fatigue/injuries,
  weather/crowd/rivalry, schemes + gameplan

Host-app concerns (Convex persistence, Gamecast UI, dynasty progression) stay in
sprtsmng. This package is the portable simulation core.
