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
| `timeline` | Per-play event timelines + pre-snap scoreboard (no outcome change) |
| `goalLineYards` | A carry stopped at the goal line is credited to the 99, not past it |

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
| `pbp/timeline.ts` | Play → ordered `PbpSimEvent[]` for renderers (pure, no RNG) |
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

## Goal-line yardage (`goalLineYards` gate)

`doRush` decides two things separately: whether the carry reached the end zone,
and whether it was ruled a touchdown. A run can clear the goal line and then
fail the touchdown roll — and v1 left the yardage where it landed. The ball was
clamped to the 99 regardless, so the field position was always right; only the
yardage was wrong.

It is not merely cosmetic, because `yards` also decides the first down:

```
2nd & goal from the 5, carry gains 8, touchdown roll fails
  v1:                ball at the 99, credited 8 yards, 1st & goal  ← never earned
  goalLineYards on:  ball at the 99, credited 4 yards, 3rd & goal
```

Measured over 400 games with the other v2 gates on: **4.05 carries per game**
were credited past the 99, **22.8 phantom yards per game** (about 8% of all
rushing yardage), and 1,344 of those carries were awarded a first down they had
not gained.

Gated rather than simply fixed, because correcting it produces a different game
and v1 logs have to keep reproducing byte-for-byte. It costs no random draw in
either position — the touchdown roll is taken in exactly the circumstances it
always was, and the gate only rewrites `yards` afterwards. Verified by
simulating 800 games with the gate off against the pre-change engine: zero
divergence.

## Stat derivation

`deriveStatLines(log)` reduces plays into:

`passing` · `rushing` · `receiving` · `defense` · `kicking` · `punting` ·
`returns` · `ballSecurity`

Plays with `penalty.negatesPlay` grant zero stat credit.

## Rendering seam (`timeline` gate)

The engine stays headless. A renderer subscribes to what it produced.

`PbpPlay` already carries its own **pre-snap** situation — `down`, `distance`,
`fieldPosition`, `quarter` and `clockSeconds` are recorded before the result is
applied — so a consumer never reverse-engineers the snap spot. The `timeline`
gate adds the two things that were missing:

```ts
play.preSnap  // { homeScore, awayScore, homeTimeouts?, awayTimeouts? }
play.events   // ordered PbpSimEvent[]: snap → handoff → tackle → whistle
```

```ts
const log = simulateGameLog({ home, away, seed, features: { ...gates, timeline: true } });

for (const event of play.events ?? []) {
  event.t;        // seconds from the snap; the whistle is the play's duration
  event.type;     // snap | handoff | pass_release | catch | tackle | …
  event.playerId; // when the engine named someone
  event.spot;     // yards from the OFFENSE's own goal line, same frame as fieldPosition
}
```

Three properties make this safe to switch on:

1. **It changes no outcome.** `playTimeline` draws no randomness, on or off, so
   the same seed yields the same game either way — verified by simulating with
   the gate on, stripping `events`/`preSnap`, and deep-comparing to the gate-off
   log.
2. **It works on history.** `playTimeline(play)` is pure, so a stored v1 log can
   be laid out on read without re-simulating it.
3. **It is description, not simulation.** The engine does not model a dropback
   or a ball in flight. Timings are a plausible schedule and the air/YAC split
   on a completion is a drawing convention (see `timeline.ts`). Nothing derives
   a statistic from an event — `deriveStatLines` reads plays only.

Cost: roughly +70% on a serialized log, which is why it is opt-in.

## Graphics layer (`@arc-sim/core/render`)

A separate entry point, so importing the engine never pulls in Three.js.

```
engine          → PbpGameLog        what happened
pbp/timeline.ts → PbpSimEvent[]     in what order        (pure)
render/         → PlayAnimation     who moved where      (pure, no Three)
render/scene.ts → pixels            the only Three file
```

| Module | Responsibility |
| --- | --- |
| `render/field.ts` | Engine spots (offense-relative 0–100) → world yards |
| `render/formations.ts` | Where 22 players line up, per play type |
| `render/choreographer.ts` | Play + events → 23 keyframed tracks |
| `render/animation.ts` | Track/keyframe types + sampling |
| `render/describe.ts` | Play → English (also a text play-by-play feed) |
| `render/scene.ts` | Three.js field, actors, playback, broadcast camera |

**The contract.** Choreography may invent *how*, never *what*. Every position
that matters comes from `PbpSimEvent.spot`; only lanes, routes, pursuit angles
and who-blocks-whom are invented. A test pins the consequence: the ball is where
the engine said it ended, and the man credited with the tackle is at the tackle.

**Deterministic.** No `Math.random()` — arbitrary choices are hashed from
`playId`, so a replay is the same play. The engine earns its determinism the
hard way; throwing it away at the last step would make visual bugs
unreproducible.

**Casting.** The engine names a handful of participants; they are cast onto
slots once, and every beat reads that casting rather than re-deriving it. One
body per player, even when the engine credits the same man with a solo tackle
and an assist.

```bash
pnpm demo:render   # simulate a game headlessly, then watch it
```

## Invariants

1. Same seed → identical `PbpGameLog` and derived stats
2. Final score = sum of scoring plays
3. Team TD / FG / XP totals match scoring plays
4. `decisive: true` never ties
5. Clock/quarter monotonic; drives alternate except turnovers/scores
6. With all gates off, v1 golden logs reproduce byte-for-byte
7. `timeline` on/off produces the same game; it only adds `events` / `preSnap`
8. Under `goalLineYards`, a non-scoring carry never ends past the 99 — and at
   goal-to-go, never gains the first down it did not score on

## What was left behind (on purpose)

- Convex persistence (`gamePlayLogs`, injuries, rivalries tables)
- Gamecast / schedule UI
- Dynasty progression, recruiting, offseason
- Host-app feature flags and league config kill switches

Wire those in the host application; keep this package simulation-only.
