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
| `goalLineConversion` | One rule decides whether a run *or* a pass that reached the goal line scored |
| `returnStats` | Punt returns record the yardage they actually gained |
| `puntReturns` | Fair catches, touchbacks, punts downed deep, and returns that break |
| `defensivePat` | A defensive touchdown attempts the extra point that follows it |
| `rushDistribution` | A carry can be stuffed at or behind the line |
| `playCalling` | Run-pass split matched to high school, not the pros |
| `passingGame` | A completion travels a varsity distance, not a pro checkdown |

### Presets

A dozen gates is a question most callers should not have to answer. Three
ready-made sets are exported — `V1_FEATURES` (nothing on, the original engine),
`RECOMMENDED_FEATURES` (everything that makes it more like football), and
`ALL_FEATURES` (that plus `timeline`, for rendering). Spread one to disagree
with a part of it: `{ ...RECOMMENDED_FEATURES, injuries: false }`.

`timeline` is the sole omission from the recommended set, and for a different
reason than any other gate: it changes no outcome, it only costs about 70% of
the log's size, so it is worth carrying only when something will draw the game.

Each preset is written out longhand and typed `Required<PbpFeatureGates>` rather
than spread from its neighbour. Adding a gate then fails the build until someone
decides where it belongs in all three — a derived preset would inherit it
silently, and a caller asking for "recommended" would get a mechanic nobody
recommended.

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

## Who scores at the goal line (`goalLineConversion` gate)

v1 asked the same question in two places and answered it differently. A carry
that reached the goal line rolled a 2–15% chance of *scoring*; a completion that
reached it scored automatically. Measured over 300 games:

| | reached the goal line | scored | TDs/game |
| --- | --- | --- | --- |
| rush | 1,306 | **7.8%** | 0.34 |
| pass | 1,126 | **92.9%** | 3.49 |

Both paths get there about equally often, so answering differently did not shade
the balance — it decided it. **8.9% of all touchdowns were rushing**, against
roughly 35–40% in the real sport. Nobody scored on the ground.

Under the gate both call `stoppedAtGoalLine`, which asks the question actually
in doubt — the ball got there, did the defense hold — and discounts a breakaway,
because a back who broke a 20-yard run was not caught from behind at the one.
The same 300 games then give:

| | scored | TDs/game |
| --- | --- | --- |
| rush | 60.6% | 2.17 |
| pass | 63.4% | 2.27 |

**48.9% of touchdowns rushing**, and combined scoring moves 29.5 → 33.6 points
per game. Still run-leaning against the real 35–40%, because the rush yardage
model reaches the goal line as readily as the pass does; closing that gap is a
balance question about yardage distributions, not about this rule.

The gate implies `goalLineYards` — a play stopped short must be credited to the
99 whichever way it got there. It costs no extra draw on a rush (it replaces the
roll v1 already spent) and one new draw on a completion, which is why it changes
the sequence and has to be opt-in. Verified inert when off across 1,250 games in
five gate configurations: zero divergence.

## Punt returns (`returnStats` gate)

The engine folds a punt return into the net — `net = clamp(gross - roll, 25, 55)`
— and v1 never wrote the return down. `deriveStatLines` needed a number anyway,
so it reconstructed one as `net * 0.25`.

That number corresponds to nothing. Measured over 124 punts it credited a mean
**10.2 return yards against a simulated ~4**, and it was computed from the
punt's length rather than from the return at all — a statistic invented from a
final figure, which is the one thing this engine exists not to do.

Under the gate the play records `returnYards = gross - net`, derived from the
recorded net rather than the raw roll, because the clamp is part of the answer:
when it bites, the return the drive was built on is not the one that was rolled.
The reducer then reads it. Same 30 games: **mean 3.6, and the box-score total
equals the engine's total exactly.**

With the gate off the reconstruction stands, so an existing league's box scores
do not shift underneath it, and `logModels(log, "returnStats")` is how a UI
tells a real number from the legacy one. Costs no random draw — the roll already
happened; this only writes down what it produced. Verified inert across 1,250
games in five gate configurations: zero divergence in the logs **and** zero in
the derived stats.

## What happens after the punt lands (`puntReturns` gate)

`returnStats` made the punt return honest. It was still boring: v1 subtracted
0–8 yards from every punt and spotted the ball, so a punt was the most
predictable snap on the field — never fair caught, never downed at the 3, and
never taken back. This models the part where the variance lives and leaves the
kick itself alone.

| over 400 games | v1 | `puntReturns` | real football |
| --- | --- | --- | --- |
| returned | 94% | **54%** | ~55% |
| mean return | 4.2 | **9.5** | 8–9 |
| median / p90 | 4 / 7 | **6 / 25** | skewed |
| longest | 8 | **85** | house calls happen |
| return TDs | none possible | **1 per ~200 punts** | ~1 per 150–200 |

Two shape decisions worth keeping:

**The breakaway is its own branch, not the tail of the yardage curve.** A return
either gets bottled up in traffic or it gets past the last man. Stretching one
distribution across both produces a steady drizzle of sixty-yard returns that
die at the 8, which is not a thing that happens.

**A fielded punt gains at least a yard.** The skew curve rounded a quarter of
its mass to zero, and a zero-yard return is not a short return — it is a fair
catch. That one omission dragged the return rate down to 38% and pushed the
average return up to 14, because the shortest returns were being counted as
non-returns. The `1 +` floor fixed both numbers at once.

A return touchdown pays the receiving team through `defensivePoints`, the same
path as a pick-six, including that path's existing simplification: defensive
scores are worth six and attempt no extra point.

Verified inert when off across 1,250 games in five gate configurations — zero
divergence in the logs and zero in the derived stats.

## The try after a defensive touchdown (`defensivePat` gate)

A pick-six and a punt returned to the house were worth exactly six, never seven,
because the extra point was skipped. `doExtraPoint` cannot simply be reused:
it reads the kicker, the matchup edge and the scoreboard from whoever has the
ball, and after a defensive score that is the team which just conceded.

Rare — about **one defensive touchdown every twelve games** — but wrong in a way
that shows. It produces scorelines football cannot produce, a game ending 6–0
where it should read 7–0, and a kicker whose extra-point total does not match his
team's touchdowns.

`doDefensivePat` is that same play with the sides swapped. The scoring team is
recorded as the try's offense, because on a try it is, which also keeps the
ordinary "sum `pointsScored` by `offenseTeamId`" reconciliation working without
teaching it a special case. Always a kick: real football allows a two-point try
here and teams almost never take one, so modelling the choice would add a
decision that is wrong more often than right.

Measured over 400 games: 35 defensive touchdowns, 35 tries, 34 made. The gate
draws nothing outside that branch — of 400 games, exactly the 34 containing a
defensive touchdown diverged, and the other 366 were identical play for play.

## What a carry gains (`rushDistribution` gate)

v1 drew rushing yardage from `2 + rand()*5 + edge*4`. That expression has a
floor of two yards before the edge is added, so there is no arithmetic path
through it to being stopped. Over ten thousand carries:

| | v1 | `rushDistribution` | real football |
| --- | --- | --- | --- |
| mean | 5.49 | **4.23** | ~4.3 |
| median | 5 | **3** | 3 |
| lost yards | **0.0%** | **9.4%** | ~9% |
| no gain or worse | 2.2% | **20.9%** | ~19% |
| 10+ | 7.5% | **10.9%** | ~11% |
| 20+ | 3.9% | 2.5% | ~3% |
| longest | 30 | **58** | house calls happen |

A carry is three outcomes, not one curve: the defense wins at the line, the run
grinds out what is blocked, or it breaks. Modelling them separately is what
produces football's shape — a left tail that exists at all, a low median, and a
mean dragged up by a thin right tail.

Two consequences beyond texture. **`tfl` was dead code**: `isNegativePlay`
requires a rush with negative yardage, so every tackle for loss in a v1 game was
a sack. And a carry that could never be stopped reached the goal line as readily
as a pass, which is most of what left the touchdown split at 51% rushing.

The scheme multiplier deliberately does not apply to a stuff. `scheme.rushYards`
drops below 1 when the box is stacked, and multiplying a *negative* by it would
make a good run defense produce **smaller** losses. A stouter front raises the
stuff rate instead, which is the thing it should actually change.

## Calibrated for high school, not the pros

This engine plays twelve-minute quarters, allows one overtime timeout, and puts
a 52-yard field goal at the edge of plausible. It models **varsity high school
football**, and every constant should be read that way — a fact worth stating
plainly here, because it is easy to miss and expensive to miss.

Calibrating against professional numbers produces a game that is wrong in a way
every aggregate agrees on. Rushing was tuned to a 4.3-yard NFL carry when a
varsity back averages nearer five; the run-pass split sat at 52% pass, a
professional figure, when high school runs it 35 to 40 times and throws 15 to
20; and a completion was modelled as a pro checkdown when varsity passing is
fewer, deeper balls against defenses that cannot cover as long.

`playCalling` and `passingGame` fix the second and third. With all three on:

| per team per game | v1 | now | varsity |
| --- | --- | --- | --- |
| plays | 53 | 50 | 50-55 |
| carries | 25 | 31 | 35-40 |
| rushing yards | 139 | 158 | 150-180 |
| pass attempts | 26 | 18 | 15-20 |
| completion rate | 58% | 57% | 50-55% |
| passing yards | 144 | 115 | 110-150 |
| TD split | 53% rush | 61% rush | 55-65% |
| combined points | 33 | 31.5 | ~42+ |

Scoring is the one that has not landed. Offenses reach the red zone 2.9 times a
game and convert 51% of those into touchdowns — the conversion is right, the
volume is not, because drives stall around the opponent's 40. Pushing the split
further toward the run makes it worse rather than better: passing is the more
efficient play here, so a more authentic play mix costs points. That tension is
unresolved and is the next thing worth working on.

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
| `render/rig.ts` | The player: box geometry, a pivot skeleton, poses, LOD |
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

**The players are built, not loaded.** Voxel art is boxes, so `rig.ts` makes
them rather than fetching a GLB. That keeps the package free of binary assets, a
loader, a decode step and a CDN, and it draws the same offline as online — a
model file would have to be versioned, licensed and kept in sync with the clip
names, and twenty lines of `BoxGeometry` do not.

Parts hang off pivots at the shoulder and hip, so a pose is a rotation rather
than a teleport, and a running gait is possible at all. The gait advances with
**distance travelled, not time** — which is why players stand still between
snaps instead of jogging on the spot, and why the legs stay right at 6× speed.

**Tackled players get up.** Plays run back-to-back, so a man left prone at the
whistle does not lie there — he teleports upright into the next formation, and
the pop is worst on exactly the plays a viewer is watching closely. The
choreographer sends him through `tackled → getup → stance` in the second of
dead air the whistle already leaves, so nothing gets longer: stretching a play
would desync the animation from the clock the engine charged.

The final `stance` lands slightly *before* `duration`, which is not a detail to
tidy away. `sampleTrack` holds the clip it is moving **from**, so a pose written
exactly at `duration` is never the pose in force — put it there and every
tackled player freezes halfway up, which looks deliberate and is worse than
leaving them down.

Three tiers, chosen per player per frame by distance from the camera:

| tier | triangles | when |
| --- | --- | --- |
| `low` | 96 | beyond 66 yards — the far sideline |
| `medium` | 156 | 50–66 — midfield |
| `hero` | 252 | inside 50 — the near sideline, where the camera is |

The thresholds are calibrated against where the camera actually sits, which is
the only part that is easy to get wrong: it is thirty yards up and forty-six
across, so the closest a player ever comes is about 37 yards. Round numbers
picked by eye — 26 and 52 — leave the entire field outside the near band, and
every player draws at one tier forever while the code reads as though three were
in use.

Tier selection lives with the actor, never the choreographer: the choreographer
does not know a camera exists, and must not, or the layout would depend on where
someone was looking and a replay would stop reproducing.

```bash
pnpm demo:render   # simulate a game headlessly, then watch it
```

## Invariants

1. Same seed → identical `PbpGameLog` and derived stats
2. Final score = sum of scoring plays
3. Team TD / FG / XP totals match scoring plays
4. `decisive: true` never ties
5. Clock/quarter monotonic; drives alternate except turnovers/scores
6. With all gates off, v1 golden logs reproduce byte-for-byte — pinned by
   `v1-golden.test.ts` against four recorded games (see below)
7. `timeline` on/off produces the same game; it only adds `events` / `preSnap`
8. Under `goalLineYards`, a non-scoring carry never ends past the 99 — and at
   goal-to-go, never gains the first down it did not score on
9. No scheme dominates another: every scheme is beaten by some other scheme on
   some axis, so the catalog is a set of choices rather than a ranking

## No free lunch in the scheme catalog

A scheme that is at least as good as another on every axis at once is not a
choice — it is the answer, and the rest of the catalog is decoration.

The 46 was exactly that. `blitz` and `runFit` are both pure upside, and its
coverage read **+0.2**, so it beat `balanced`, the 4-3 and the 3-4 on sacks,
explosives allowed, interceptions, opponent accuracy and run defense
simultaneously. In simulation it conceded fewer points than the 4-3 against
*every* offense in the catalog, by up to 2.54 points a game. Nothing punished
it, which is the opposite of what its own blurb promises.

Coverage is the famine, so it has to be negative: the 46 brings everyone and
leaves its secondary in man with no help. At **-0.4** — the deliberate mirror of
the 4-2-5's +0.4 — the matchup table reads the way the blurb does:

| the 46 faces | vs the 4-3 |
| --- | --- |
| Flexbone, Wing-T, Pro Style, Spread | better by 0.05–0.73 |
| **Air Raid** | **worse by 1.27** |

Feast against the run, famine against four verticals. Across all five defenses
the spread from best to worst is 1.34 points per game, so no scheme is broken —
they are simply different bets.

`schemes.test.ts` pins the general property, not the one value: it compares
every defense against every other on all five axes and fails naming any pair
where one dominates.

Catalog values are read only under the `schemes` gate, so this changes nothing
for a league that has not opted in, and the v1 golden fixture is untouched. It
does change results for a league already running the 46.

## The v1 golden fixture

Invariant 6 is the promise the whole gate design rests on, so it is pinned
rather than asserted. `src/pbp/__tests__/fixtures/v1-golden-logs.json` holds
four games captured from the v1 engine before any v2 work — an even matchup, a
mismatch, a playoff game that cannot tie, and each flavor — recorded as a
SHA-256 per game, plus the first game's full log so a failure shows a readable
diff instead of two hex strings.

The failure mode it exists to catch is specific: **a gate that consumes a random
draw while switched off.** That shifts the PRNG sequence and changes every play
after it, and no unit test of the mechanic itself would notice. This one fails
on the next play.

```bash
pnpm gen:golden   # regenerate — ONLY when a v1 behavior change is intended
```

Inputs live in `fixtures/v1-golden-cases.ts`, shared by the test and the
generator so the two cannot drift. Against an unchanged engine the generator
rewrites the file byte-for-byte, so an empty `git diff` afterwards is itself the
check that nothing moved.

## What was left behind (on purpose)

- Convex persistence (`gamePlayLogs`, injuries, rivalries tables)
- Gamecast / schedule UI
- Dynasty progression, recruiting, offseason
- Host-app feature flags and league config kill switches

Wire those in the host application; keep this package simulation-only.
