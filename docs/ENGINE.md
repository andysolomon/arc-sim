# Play-by-Play Simulation Engine

Architecture and design notes for `@arc-sim/core`, ported from Sports Management
Dynasty Mode (`sprtsmng` → `apps/web/src/lib/pbp/`).

## Two simulators, one product history

### 1. Score-draw model (legacy)

`simulateScore` draws a final score from team strength with a seeded PRNG:

- Baseline ~21 points per team
- Strength differential ± home-field bump
- Flavor knobs: `chalk` (favorites win more) / `balanced` / `upsets`

Useful for quick schedule fills. **Does not produce plays or player stats.**

### 2. Play-by-play engine (canonical)

`simulateGameLog(input) → PbpGameLog` runs a full football game:

- Quarters of 720 seconds (OT 300)
- Possession, down/distance, field position (0–100 offense perspective)
- Drives group plays; scores come only from scoring plays
- Participant selection prefers depth chart, else highest overall in position group
- Defense credit (tackles, sacks, INTs, …) distributed by position weights

**Invariant:** same seed ⇒ identical log and identical derived stats.

## Inputs

```ts
type PlayerSimProfile = {
  playerId: string;
  position: string;   // QB, RB/HB/FB, WR, TE, OL, DL/DT/DE, LB, CB/S, K, P
  overall: number;    // 0–99
  positionSlot?: string;
  depthRank?: number;
  endurance?: number; // fatigue
  awareness?: number; // penalty discipline
};

type TeamSimProfile = {
  teamId: string;
  strength: number;
  players: PlayerSimProfile[];
  discipline?: number;
  coach?: { aggression?: number };
  scheme?: TeamSchemeProfile;
  gameplan?: string;
};

type PbpGameInput = {
  home: TeamSimProfile;
  away: TeamSimProfile;
  seed: number;
  decisive?: boolean;           // playoff: OT until untied
  flavor?: SimulationFlavor;
  features?: PbpFeatureGates;   // all-off = v1 parity
  weather?: Weather;
  venuePrestige?: number;
  rivalryIntensity?: number;
  injurySeverityScale?: number;
};
```

The engine does **no I/O**. Callers build profiles and pass plain objects.

## Play types

**v1:** `kickoff`, `rush`, `pass_complete`, `pass_incomplete`, `sack`,
`interception`, `punt`, `field_goal`, `field_goal_miss`, `extra_point`,
`extra_point_miss`, `kneel`

**v2:** `two_point_convert`, `two_point_fail`, `safety`, `onside_kick`,
`penalty`, `spike`, `timeout`

## Feature gates (v2)

Every v2 mechanic is opt-in. When a gate is off it must consume **zero** RNG
draws — otherwise the PRNG sequence shifts and the log diverges from v1.

| Gate | What it adds |
| --- | --- |
| `scoringV2` | Safeties, 2PT, return TDs, extra fumble paths |
| `penalties` | Flags + accept/decline |
| `situational` | 4th-down chart, timeouts, spike, onside, realistic clock |
| `balance` | Recalibrated home-field / scoring constants |
| `injuries` | Fatigue snaps + injury rolls |
| `weather` | Wind/precip modifiers + crowd/rivalry edge |
| `schemes` | Offense/defense scheme + weekly gameplan modifiers |

## Module map

| Module | Responsibility |
| --- | --- |
| `pbp/engine.ts` | State machine, play outcomes, `simulateGameLog` |
| `pbp/derive-stats.ts` | Log → `PlayerGameStatLine` box scores |
| `pbp/situational.ts` | 4th-down / clock / onside / spike (deterministic, no RNG) |
| `pbp/penalties.ts` | Flag rolls + accept/decline |
| `pbp/fatigue.ts` | Snap ledger + stamina decay |
| `pbp/injuries.ts` | Contact injury rolls |
| `pbp/weather.ts` | Conditions → multipliers |
| `pbp/crowd.ts` | Home-field × prestige × rivalry |
| `pbp/schemes.ts` | Tendency vectors → engine multipliers |
| `schemes/catalog.ts` | Air Raid, Flexbone, 4-3, 46, … |
| `schemes/gameplan.ts` | Weekly emphasis (establish run, tempo, …) |
| `rng/` | mulberry32 + `seedFor(domain, …parts)` |
| `flavor/` | Strength weight / variance / edge scale |

## Matchup edge

Team strength differential flows into per-play success:

- Explosive rate, yardage, TD probability
- Completion / sack / INT rates
- FG accuracy, kick returns, punt distance

Home field is a strength bonus into that edge (v1: 2.5; v2 balance: 0.75),
not a flat points award.

## Situational AI (highlights)

4th-down chart by field zone (not expected points), shifted by score, time, and
coach aggression. Clock management separates huddle runoff from play duration
so incompletions no longer burn a full ~30s cycle.

## Stat derivation

`deriveStatLines(log)` reduces plays into:

`passing` · `rushing` · `receiving` · `defense` · `kicking` · `punting` ·
`returns` · `ballSecurity`

Plays with `penalty.negatesPlay` grant zero stat credit.

## Invariants

1. Same seed → identical `PbpGameLog` and derived stats
2. Final score = sum of scoring plays
3. Team TD / FG / XP totals match scoring plays
4. `decisive: true` never ties
5. Clock/quarter monotonic; drives alternate except turnovers/scores
6. With all gates off, v1 golden logs reproduce byte-for-byte

## What was left behind (on purpose)

- Convex persistence (`gamePlayLogs`, injuries, rivalries tables)
- Gamecast / schedule UI
- Dynasty progression, recruiting, offseason
- Host-app feature flags and league config kill switches

Wire those in the host application; keep this package simulation-only.
