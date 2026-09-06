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
| `kickReturns` | Touchbacks, real kickoff return yardage, and returns taken back |
| `defensivePat` | A defensive touchdown attempts the extra point that follows it |
| `rushDistribution` | A carry can be stuffed at or behind the line |
| `playCalling` | Run-pass split matched to high school, not the pros |
| `passingGame` | A completion travels a varsity distance, not a pro checkdown |
| `kickingGame` | The kicker's rating decides the kick, at a varsity rate |
| `redZone` | A play that would have ended deep in the end zone is not stopped at the one |
| `downAndDistance` | The play-caller reads the distance: short is a run, long is a pass |
| `quarterBreak` | A quarter ending is not a drive ending: the offense keeps its down |
| `puntReturner` | A punt nobody returned names no returner, so nobody is charged or hurt for it |
| `matchups` | A target is thrown at a covered man and a dropback is blocked by somebody: the outcome reads the two men |
| `sackStats` | A sack is booked as a carry for a loss, not a pass attempt (reducer only) |
| `interceptionReturns` | A pick return is skewed like a punt return, with a lower ceiling |

### Presets

Twenty-five gates is a question most callers should not have to answer. Three
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
path as a pick-six — and, under `defensivePat`, kicks the try that follows it.

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

## The other kick (`kickReturns` gate)

`puntReturns` made the punt a real play. The kickoff was still v1's, and v1
resolved the whole thing with one roll:

```
returnYards = round(18 + rand()*22 + edge*8)
startField  = clamp(returnYards, 15, 40)
play.yardsGained = returnYards          // ← and this is the returner's stat line
```

One number, used twice. It was the yard line the receiving team started on
*and* the yardage credited to the returner, which means a man handed the ball at
his own 28 and tackled where he stood went into the book for a 28-yard return.
It is the punt's invented statistic again — a figure read off a final position
rather than off the thing it names — and it came with three more consequences:

- **No kick ever reached the end zone.** The roll had a floor of 18 and a clamp
  at the 15, so a touchback was not rare, it was unreachable. Every kickoff in
  every game was fielded and returned.
- **`krTd` was dead code.** `doKickoff` wrote `isScoring: false` unconditionally,
  so the box-score field existed and nothing could ever increment it — the same
  species of bug as `tfl` before `rushDistribution`.
- **The most predictable snap in football.** Clamped to a 25-yard window, with
  no touchback below it and no house call above it.

Under the gate the play is three facts rather than one. How far the kick
carried, whether it came out of the end zone, and what the return got:

| over 800 games | v1 | `kickReturns` | real varsity |
| --- | --- | --- | --- |
| returned | 100% | **86%** | ~85% |
| touchbacks | **impossible** | 14% | 10-20% |
| mean return | 29.2 | **21.7** | 18-22 |
| median / p90 | 29 / 38 | **19 / 37** | skewed |
| longest | 41 | **99** | house calls happen |
| return TDs | **impossible** | 1 per 144 returns | ~1 per 100-200 |

Three decisions worth keeping:

**The choice belongs in the end zone, and nowhere else.** A kick that comes down
in the field of play is returned, because there is nothing else to do with it; a
kick that reaches the end zone is a decision, and it is the mirror of the punt's
fair catch — a knee is worth the 20, so *bringing it out* is the aggressive
option, and it starts him on the goal line rather than where the ball landed.
Because a touchback is then the only way a kickoff goes un-returned,
`returnYards === 0` means exactly one thing to every reader.

**A kick return is not a long punt return.** It gets a higher floor and less
skew, because the plays are not alike: a kick returner catches it running with
the field in front of him, where a punt returner catches it standing still with
the coverage on top of him. A ten-yard kick return is a bad one and a ten-yard
punt return is a good one, and one curve cannot say both.

**Field position does not move.** Mean drive start after a kickoff is 29.0
against v1's 29.2. That is deliberate and it is pinned by a test: the gate is a
bookkeeping and variance change, and a league that turns it on to get honest
box scores must not silently get a different scoring environment with them. The
eleven calibrated aggregates are unmoved; combined points rise 34.6 → 35.0,
which is the return touchdowns and nothing else.

`yardsGained` becomes the NET the kick moved the ball — what `yardsGained`
already means on a punt — and the play carries `returnYards` beside it, so the
reducer reads the return instead of the spot. Over 800 games the box-score
kick-return total equals the engine's total exactly. With the gate off both
readings stay as they were, so an existing league's box scores do not shift
underneath it, and `logModels(log, "kickReturns")` is how a UI tells the real
number from the legacy one.

A return taken to the house pays the receiving team through `defensivePoints`
and kicks its try through `doDefensivePat`, the same paths a punt return
touchdown already used — reached here from a new direction, because on a
kickoff the scoring team is the play's *defense* and `state.possession` at that
moment is neither side reliably. Nobody is named the returner on a touchback,
so no box score credits a return that was never made.

Verified inert when off across five gate configurations including everything
else on, and the v1 golden fixture regenerates byte-for-byte.

## Who kicks the ball (`kickingGame` gate)

Every kick named a kicker or a punter as a participant and then read nothing
from him. A field goal went in at `0.92 - (distance - 30) * 0.02 + edge * 0.08`,
an extra point at `0.94 + edge * 0.03`, a punt travelled `38 + rand() * 12`:
team strength and the matchup all the way down. Measured over 200 games, a
**40-overall kicker made 78.6%** of his field goals and a **99-overall made
78.1%**. The rating was decoration — which is a problem for a dynasty that
spends a recruiting class on one and expects to see the difference.

And the rates it ignored him in favour of were professional ones, in an engine
whose every other constant is varsity. `situational.ts` calls a 52-yard try
"the edge of plausible for HS"; the make curve gave that exact kick a 48%
chance. Over 400 games, home team, neutral 70-overall kicker and 65 punter:

| | v1 | `kickingGame` | real varsity |
| --- | --- | --- | --- |
| field goals, under 30 | 90% | **85%** | 85-90% |
| 30-39 | 80% | **64%** | 60-70% |
| 40-49 | 66% | **45%** | 35-45% |
| 50 and longer | 34% of 50 tries | **never tried** | rarely tried |
| extra points | 94% | **89%** | 85-90% |
| punt gross | 40.9 | **33.8** | 33-37 |
| kickoff touchbacks | 16% | 21% | 10-20% |

Under the gate the kicker's `overall` is a **leg**, centred so that an ordinary
roster's kicker is about neutral — a 40 is the worst leg in the league, a 90
the best — and the leg decides three things. How far out the coach will send
him: a neutral leg is trusted to about 44 yards, the best to 50, the worst to
the mid-30s, against the flat 52 the chart assumed when it knew nothing. How
often it goes through, on a curve that is steeper than the professional one and
steeper again past 35 yards, because that is where a high-school leg runs out.
And, when `kickReturns` is modelling where a kickoff comes down, a few yards of
carry either way. The punter's `overall` sets his gross the same way. The
rating now shows up where it should:

| home specialists rated | extra points | longest try | punt gross | touchbacks |
| --- | --- | --- | --- | --- |
| 40 | 80% | 37 yards | 27.8 | 1% |
| 70 / 65 | 89% | 44 | 33.8 | 21% |
| 95 | 91% | 52 | 39.7 | 32% |

Two things worth saying about the scoring environment. The gate takes **34.1 →
32.9** combined points, a point and not the eight a 20-point drop in field-goal
accuracy might suggest, because the shorter punt hands back most of what the
harder kick takes away — a varsity offense starts closer. And the overall
field-goal rate reads *higher* than the per-band rates imply (65%, against 73%
before) because the coach stopped sending the kicker out from where he cannot
reach, so the attempts got shorter as the kicks got harder. Both are the sport.

The chart learns the leg through an optional `fieldGoalRange` on
`fourthDownDecision`; absent, it assumes the 35 yards-to-goal it always did,
so the situational tests are untouched. Every branch replaces a draw the engine
already spent rather than adding one, so the gate costs nothing extra — but it
changes every kick's odds, so it is opt-in. Verified inert when off beside
every other gate, and the v1 golden fixture regenerates byte-for-byte.

## What happens in the red zone (`redZone` gate)

With thirteen of fourteen varsity aggregates in band and combined scoring nine
points light, `kickingGame` showed the points were not in the kicks — making
the kicking worse cost one. That localized the shortfall to touchdowns, and
measuring red-zone trips over 400 games localized it again, to the goal line:

| per red-zone trip | flat stand |
| --- | --- |
| trips per team per game | 3.27 |
| ended in a touchdown | 54% |
| contained a play stopped at the one | **0.39** |
| per-play conversion from the 1–3, rushing | 45% |
| per-play conversion from the 1–3, passing | 39% |

A goal-line stand on four drives in ten. The `goalLineConversion` stand asked
the right question — the ball got there, did the defense hold — but asked it at
a flat rate no matter how far past the line the play would have gone. The
yardage draw says where the carrier would have been tackled on an open field,
and a play that would have ended *at* the line is the one in doubt at the
pylon; one that would have ended three yards deep was across before anyone
reached him. Treating both the same is what made a play from the one convert at
the real rate from the three.

Under the gate the stand reads the margin: full at the line, decaying linearly
to nothing three yards past it — the length of a tackle. The breakaway discount
stays. That is the whole change: no multiplier, no new draw. It replaces the
stand's own roll, so a log with the gate on agrees play for play with one
without it until the first play that reached the line and was decided
differently — verified over 150 game pairs.

| per red-zone trip | flat stand | `redZone` | real |
| --- | --- | --- | --- |
| ended in a touchdown | 54% | 59% | 55–65% |
| contained a play stopped at the one | 0.39 | 0.16 | — |
| reached inside the 5 and scored | 74% | 80% | ~80–85% |
| per-play conversion from the 1–3, rushing | 45% | 61% | ~58% from the 1 |
| per-play conversion from the 1–3, passing | 39% | 53% | ~45% from the 1 |

Combined scoring moves **32.7 → 34.9** over 600 games, the rushing share of
touchdowns 61 → 62%, and nothing else leaves its band. Two points of the nine,
and the rest is not here — see the calibration notes for where it is.

## What the coach calls (`downAndDistance` gate)

`redZone` closed what happened inside the 20 and left the rest of the gap in
how often a drive got there: 35% of drives, a professional figure, against the
~37% a 42-point game needs at varsity conversion. A drive gets there by
converting, so the next measurement was conversion by down, distance, and
call, over 400 games:

| | called | converted |
| --- | --- | --- |
| 3rd-and-1, run | 68% | 77% |
| 3rd-and-1, pass | 32% | 53% |
| 3rd-and-11+, run | **70%** | 7% |
| 3rd-and-11+, pass | 30% | 23% |
| 4th-and-1 go, run | 43% | 81% |
| 4th-and-1 go, pass | **57%** | 52% |

The play-caller read the down and nothing else. `playCalling` set the split a
high-school offense uses over a game, and the caller applied it to every snap
alike — a run on 3rd-and-12, a throw on 4th-and-inches — and the fourth-down go
flipped a flat 45% coin for the run whatever the distance. No coach calls it
that way; the distance is the first thing he looks at.

Under the gate short is a run, long is a pass, and the neutral downs — 1st-and-
10, anything-and-3-to-6 — run a little *more*, so the split over a game stays
where `playCalling` put it. The lean moves attempts from the downs where a
throw is wasted to the ones where it is needed; it adds none. The fourth-down
go reads the distance the same way. Same draws, so it changes what is called
and never how much randomness a play spends.

| per team per game | flat | `downAndDistance` | varsity |
| --- | --- | --- | --- |
| 3rd-and-11+ pass rate | 30% | 70% | — |
| 4th-and-short go, run | 43% | 78% | — |
| third-down conversion | 36% | 38.5% | 35–40% |
| drives reaching the red zone | 35% | 37.5% | — |
| carries | 36 | 35 | 35–40 |
| pass attempts | 16 | 18 | 15–20 |
| passing yards | 113 | 128 | 110–150 |
| rushing share of TDs | 62% | 64% | 55–65% |
| combined points | 34.9 | **38.0** | ~42 |

Three more points, and everything else stays in band — carries and the rushing
share now sit at the edge of theirs, which is where the next lever would have
to take something out.

## What a quarter ends (`quarterBreak` gate)

`downAndDistance` was measured against how often a drive reached the red zone,
which is a statement about drives — so the drive records were worth reading
before leaning on them again. They were wrong twice a game.

`checkPeriodEnd` closed the drive whenever the clock hit zero, at **every**
period boundary, and the main loop then opened a fresh one at the same spot
through `startDrive` — which sets `down = 1` and `distance = 10`. A quarter
ending is not a change of possession, so over 300 games:

| | flat |
| --- | --- |
| drives cut off by the end of Q1 or Q3 | 1.87 per game |
| of those, resumed by the same team with no kickoff between | all of them |
| resumed on first and ten | all of them |
| **first downs nobody earned** | **1.26 per game** |
| …handed to an offense that had just failed on third down | 63 in 300 games |
| …handed to an offense that had just failed on **fourth** | 1 in 300 games |

The bookkeeping was wrong in the same breath. One continuous drive was written
down as two, and both were stamped `end_of_half` — which at the end of the
first and third quarters is not what happened. That inflated drives per game by
about 8% and put 555 phantom drives into the population every 300 games, each
starting at the *previous* drive's field position, which is to say near
midfield. It is those, and not the kickoff, that the "drives start at their own
35" note was measuring:

| mean drive start, by what preceded it | flat |
| --- | --- |
| kickoff | own 27.9 |
| punt | own 30.8 |
| missed field goal | own 23.5 |
| turnover | own 55.9 |
| **the end of a quarter** | **own 55.0** |

Under the gate the drive simply stays open across Q1→Q2 and Q3→Q4: down,
distance, field position and the drive record all carry over. Halftime, the end
of regulation and every overtime period still end it, because there a kickoff
follows and the possession really is over — so `end_of_half` again means a half
ended. There is no resume path and no special case at the boundary; the boundary
stopped being an event, which is the whole change.

| | flat | `quarterBreak` |
| --- | --- | --- |
| free first downs per game | 1.26 | **0** |
| drives recorded per game | 30.8 | **29.4** |
| mean drive start | own 36.7 | **own 34.8** |
| drives reaching the red zone | 36.9% | 37.4% |
| combined points | 38.6 | 38.5 |

**It does not move the scoreboard**, and that is worth stating carefully rather
than claiming a win. Removing 1.26 free first downs a game ought to cost
points; across 1,000-game replicas the change came out −0.68, −0.61, +0.44,
−0.44 and +0.11 — a sign that will not settle, which is what an effect smaller
than its own noise looks like. A free first down late in a quarter mostly
extends a drive that still has a long way to travel. Every varsity aggregate
stays in band.

Costs no random draw in either position: it is a control-flow branch, not a
roll. Gated anyway, because it changes outcomes — a drive that used to be
revived by the clock now has to convert — so the sequence diverges at the first
quarter that expires with someone in possession.

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

Scoring closed part of the way and then stopped, which is worth stating
precisely. Raising the explosive-play rate — high-school football's own answer
to a stalled drive — took combined scoring from 31.0 to 34.3, and a later pass
at the run-pass split and the huddle runoff left it near 34.

Where the offense sits now, over 600 games:

| per team per game | now | varsity |
| --- | --- | --- |
| scrimmage plays | 55 | 50–55 |
| carries | 35 | 35–40 |
| rushing yards | 169 | 150–180 |
| yards per carry | 4.9 | 4.5–5.5 |
| pass attempts | 18 | 15–20 |
| completion rate | 53% | 50–55% |
| passing yards | 128 | 110–150 |
| rushing share of TDs | 63% | 55–65% |
| sacks | 2.1 | ~2 |
| interceptions | 1.1 | ~1 |
| field goal rate | 67% | 55–70% |
| extra point rate | 86% | 85–90% |
| punt average | 33.7 | 33–37 |
| combined points | 37.7 | ~42 |

A varsity dropback is more dangerous than a professional one in both
directions, and the sack and interception rates were NFL figures — 7% and 2.5%.
High-school lines hold up less well and high-school quarterbacks throw far more
interceptions: a 6% pick rate would be catastrophic in the pros and is ordinary
on a Friday night. The interception clamp had to open up as well, because its
old ceiling of 0.04 sat below the rate the sport produces and would have
silently capped the new baseline.

Raising the pick rate lowers the completion PERCENTAGE without touching
accuracy, because the completion roll only happens on a throw that was not
intercepted. The per-throw baseline therefore sits above the percentage it aims
at, and the two were tuned together rather than one at a time.

Getting carries there needed a lever that was not the play-caller. At 50 plays a
game, 36 carries and 17 attempts do not both fit — the split alone can only
trade one for the other, which is why lowering the pass rate kept pushing
passing yardage out of band as fast as it pulled carries in. The binding
constraint was the huddle: a 30-second runoff between snaps capped a game at
about 50 plays, and 26 seconds lifts it to 54. Both numbers describe the same
varsity offense; the shorter one simply leaves room for the play counts the
sport actually produces.

The remaining gap does not belong to any one rule. Third-down conversion is
38.5% under `downAndDistance`, against a real 35–40%. Drives start at their own
34.8 under `quarterBreak`, still a shade better than real football — and note
that `kickReturns` deliberately did **not** touch that, because the kickoff
already spots them at the 29 and moving it would have been a scoring change
smuggled in behind a bookkeeping fix. What was left of that number above the
kickoff's turned out not to be field position at all: see the quarter-break
gate, which took 1.9 phantom drives a game out of the population and moved the
mean from the 36.7 to the 34.8 without changing where anybody actually started.
Red-zone conversion is 59%
under `redZone`, inside the 55–65% band. **Thirteen of the fourteen measures
above are now in band**, and the aggregate is still about four points light —
which means closing it requires taking something OUT of band. A trade, not a
fix.

`kickingGame` is the instructive case. It made the kicking worse, as the sport's
is, and cost about a point — so the missing points were never in the kicks.
Real varsity reaches 42 with *this* kicking, which localized the shortfall to
touchdowns: drives that reach the red zone and what happens to them there.

`redZone` took the second half of that: a goal-line stand on four trips in
ten, a flat stop rate that did not ask how far past the line the play would
have gone, worth two points. `downAndDistance` took the first half: a
play-caller that ran on 3rd-and-12 and threw on 4th-and-inches, worth three.
Both are mechanisms a coach would recognise, neither is a multiplier, and the
table above is measured with both on.

What is left, about four points, has no such mechanism behind it that the
evidence supports. Per-play conversion at the goal line sits at the real rate
from the one; third down sits in the upper half of its band; carries and the
rushing share of touchdowns sit at the *edge* of theirs, so leaning the call
further toward the pass would push them out. The remaining trips would have to
come from yards per play, and every yardage distribution is in band. That is
where the evidence stops, and this document stops with it.

That the last one is scoring is not a coincidence. Points are the most derived
quantity here: every play-level distribution feeds it, so it is the measure with
the least freedom left once the others are pinned. Moving it now means
un-pinning something that is currently correct.

## Stat derivation

`deriveStatLines(log)` reduces plays into:

`passing` · `rushing` · `receiving` · `defense` · `kicking` · `punting` ·
`returns` · `ballSecurity`

Plays with `penalty.negatesPlay` grant zero stat credit.

`attributedPoints(lines)` sums the points those lines account for — invariant 15
in executable form, and the check the section below exists to describe.

## Every point on the scoreboard belongs to somebody

The box score accounted for 97.1% of the points the engine scored. Reconciling
the scoreboard against the derived lines over 600 games with
`RECOMMENDED_FEATURES`:

```
scoreboard points: 23208    box-score points: 22534    unaccounted: 674  (2.9%)
```

1.1 points a game with no home in any stat line. It did not decay gracefully —
it decomposed exactly, into four plays the reducer never credited:

| what scored | over 600 games | why it was missed |
| --- | --- | --- |
| pick-six | 70 TDs, 420 pts | `defense.defTd` was declared in `emptyLine` and incremented by nothing |
| punt return TD | 23 TDs, 138 pts | `prTd` was guarded on `isScoring`, which is `false` on every one of them |
| two-point conversion | 40, 80 pts | the reducer had no `case` for either play type |
| safety | 18, 36 pts | the tackler the engine named got nothing |

420 + 138 + 80 + 36 = 674. The kickoff return touchdown was the one return score
already credited, which is what marks the other three as oversights rather than
a decision: someone fixed `isScoring` → `isReturnTd` for the kickoff, wrote the
reason in a comment, and left the identical line in the punt case one block
below.

Three more of the same species, found alongside — a quantity the engine
simulates that the box score throws away:

| | over 600 games |
| --- | --- |
| interception return yardage no field could hold | 1,327 picks, mean **10.0 yards** |
| punts credited as a return that was a fair catch, touchback or downed ball | **1,788 phantom returns**, 3 a game |
| strip-sacks whose fumbler and recoverer nobody read | **294**, one every other game |

**What the fix is.** Six new fields — `defense.intYards`, `defense.safeties`,
and `twoPtAtt` / `twoPtConv` on `passing` and `receiving` — and one structural
change: `creditDefense` and `creditFumble` now run from the reduction itself
rather than from inside two of its cases. Being wired up case by case is how
they came to be missing; the man who made a safety got no tackle, and a
strip-sack named a fumbler that no stat line ever heard about.

The try is kept out of the passing and receiving lines rather than folded into
them, which is both how a real box score reports it and the narrower claim: a
two-point conversion has no down and no distance, and counting it as an attempt
would move completion percentage on a play that is not a scrimmage down.

Interception return yardage gets no fallback. A log without `scoringV2` never
wrote `returnYards` on a pick and contains nothing to derive it from — inventing
one from a final figure is the defect `returnStats` was written to remove, not a
precedent to follow. Absent stays absent.

**A punt nobody returned is not a return.** `doPuntWithReturn` builds
`participants` with a returner before the fair-catch, touchback and downed
branches run, so the reducer counted a return on every punt: 4,252 recorded
where 2,464 happened, dragging the reported average from a true 9.6 yards to
5.6. The yardage was always right — `returnStats` had made that total match the
engine's exactly — only the denominator was counting men who stood and watched.

The reducer now reads the return instead of the name, gated on `puntReturns`,
because the same recorded zero means two different things. Under the gate a zero
is a decision the engine made. Without it, v1 returned every punt and a zero
only means the net clamp bit, so reading it as a fair catch would credit an
event that was never simulated and would move a count underneath logs a league
has already stored.

**Honest absence in the log was not free, and it was paid separately.** The
rule the kickoff already states —

> Nobody is the returner on a touchback. v1 named one on every kickoff, which is
> how a box score came to credit returns that were never made.

— reads as though the punt should simply follow it, one conditional in
`doPuntWithReturn`, changing the play's `participants` array and nothing else.
It does not. `applyAttrition` reads `play.participants`: once to charge each man
a snap, and again as `floor(roll * participants.length)` to choose who got hurt.
Dropping a name from a punt therefore changes **which player is injured on it**,
and every play after. The draw count is unchanged, which is what makes it
invisible to the usual test for a gate that leaks — the sequence does not
shift, the outcome does. So it went behind its own gate, `puntReturner`, in
the section that follows; the reducer reads the return rather than the name so
that it is right on both kinds of log.

**No gate on the rest, and the reason is not that it was convenient.** Every
field this change added reads `isReturnTd`, `defensivePoints`, a v2 play type or
`returnYards`, none of which a v1 log contains — so a v1 log's derived stats
cannot move, which is measured rather than assumed
(`box-score-attribution.test.ts`). That is what makes it different from
`returnStats`, which replaced a wrong non-zero number with a different one and
had to be opt-in. Nothing here overwrites a credit; it finishes a reduction that
stopped early.

Verified over 1,800 games in three preset configurations: every game reconciles
to the point, on both sides of the ledger; `pnpm sim --games 600` reports the
same aggregates it did before, field for field; and `pnpm gen:golden` leaves the
v1 fixture byte-for-byte identical. No game changes.

## Nobody is the returner on a punt nobody returned (`puntReturner` gate)

The one defect the attribution work left behind on purpose. `doPuntWithReturn`
built the play's `participants` before the fair-catch, touchback and downed
branches ran, so the log named a returner on every punt. Over 600 games with
`RECOMMENDED_FEATURES` and the CLI's 25-man roster:

| | over 600 games |
| --- | --- |
| punts | 4,439 (7.4 a game) |
| never returned — fair caught, downed or touched back | **1,962 (44%)** |
| of those, naming a returner anyway | **1,962 — every one** |

The box score had already stopped counting him, because the reducer reads the
return rather than the name. The engine had not. `applyAttrition` reads
`play.participants` twice — once to charge every man a snap, and again as
`floor(roll * participants.length)` to choose who got hurt — so the top of the
receiver depth chart was charged about 1.9 stamina a game for punts he stood
and watched, and took half of every unreturned punt's injury exposure:

| injuries, over 600 games | gate off | `puntReturner` |
| --- | --- | --- |
| on a punt | 36 | 36 |
| on a punt nobody returned | 7 | 7 |
| …to the returner named on it | **5** | **0** |
| …to the punter | 2 | 7 |

Five players in 600 games hurt fielding a punt that was touched back or fair
caught — a thing football cannot produce. Under the gate the array is built
after the return is known, the way the kickoff's is, and a punt with
`returnYards === 0` names the punter alone.

**Why it is a gate.** The draw count is unchanged, which is what makes this
invisible to the usual test for a gate that leaks: the sequence does not shift,
the outcome does. With one fewer name the same `whoRoll` lands on the punter,
who has a different stamina, so the same `whetherRoll` can go the other way —
and from there every later play is different. Measured over the same 600
seeds with `participants` stripped from both logs before comparing: with
`injuries` off, **0** games diverge; with it on, **6** — the ones where the
victim moved. A league with stored logs and `injuries` on would find a
receiver's injury history rewritten underneath it.

**What it must not do.** The returner is still *selected* on every punt,
because `selectPlayer` draws, and skipping the selection on a punt nobody
returned would save a draw and turn a change that touches six games in 600
into one that touches all of them. The gate changes what the play records and
never how much randomness the punt spends — invariant 13's discipline, applied
to a participant list. Pinned by stripping `participants` and deep-comparing
gate-on to gate-off over a thousand games with `injuries` off: identical.

**Who takes the roll now.** With one name on the play the punter takes all of
an unreturned punt's injury exposure at `contactFactor("punt")`, which
over-exposes a man who kicked and jogged off — the kickoff has the same
asymmetry on a touchback and accepted it. Punter injuries on unreturned punts
go from 2 to 7 per 600 games, one every eighty-five. If that ever looks wrong
the fix is to `contactFactor` on a non-contact punt, and it is a separate
change because it removes three draws.

The aggregate table does not move: carries 34.50 → 34.50 (which prints as 35
or 34 depending on the third decimal), completion 52.9% both ways, combined
points 37.70 → 37.72. `logModels(log, "puntReturner")` is how a reader knows
that an absent returner means nobody fielded it, rather than a log that names
one on every punt. Verified inert when off across five gate configurations
including everything else on, and the v1 fixture regenerates byte-for-byte.

## Who is on whom (`matchups` gate)

The engine resolved a play with a handful of rolls against the team edge and
picked participants by position weight afterwards. `selectDefender(def, state,
"coverage")` chose the interceptor *after* the interception had been decided;
the sacker was chosen after the sack. Nobody blocked anybody, no receiver was
covered by a particular corner, and no rating on the field was read by
anything except the kicker's leg — a 90 receiver against a 60 corner completed
passes at exactly the rate the reverse did, and the offensive line was a
position group that never touched a play. The ceiling was the same on both
axes: the aggregate table could not find its last four points because there
was no mechanism under the curves for them to come from, and the renderer
could not show a corner beaten on a post because the engine did not know one
was.

Under the gate the three men who decide a dropback are selected **before** the
outcome — the man in coverage on the target, the pass rusher, and the lineman
blocking him — and the outcome reads the difference between them:

| the matchup | reads | a full mismatch (30 rating points) |
| --- | --- | --- |
| receiver against the man covering him | completion | ±8 points |
| | explosive rate | ×1.5 / ×0.5 |
| | interception rate | ×0.6 / ×1.4 |
| | yards after the catch | ±3 |
| rusher against the man blocking him | sack rate | ×1.5 / ×0.5 |

Every term is linear and centred on zero. The sacker is the man who was
coming, the interceptor is the man who was covering, and all three are named
on the play as `coverage`, `pass_rusher` and `blocker` whether or not anything
came of it. Under `injuries` the rating read is the fatigued one, so a corner
who has been on the field all night gets beaten — the link that makes riding a
starter cost something on the field rather than only in the substitution
logic. A roster that carries no linemen has not fielded a bad line, it has said
nothing: the stand-in `selectPlayer` invents for an empty group is never named
and never read, and the matchup is neutral.

Measured over 300 games a league, both teams rated 70 so the team edge is zero,
the home offense against the away defense:

| | completion | explosive | picks | sacks | passing yards |
| --- | --- | --- | --- | --- | --- |
| everyone rated alike | 53.9% | 39.8% | 5.8% | 10.1% | 143 |
| **receivers 90, corners 60** | **61.3%** | **56.3%** | **3.3%** | 9.4% | **181** |
| **receivers 60, corners 90** | **46.6%** | **25.1%** | **7.9%** | 10.5% | **100** |
| **line 60, front 90** | 52.3% | 34.8% | 6.3% | **14.8%** | 120 |
| **line 90, front 60** | 55.9% | 43.2% | 5.5% | **5.7%** | 155 |

A 90 receiver on a 60 corner is the explosive play; the reverse is the pick.
The front rows move the passing numbers a little too, because a quarter of the
men named in coverage are linebackers and the front is rated with them —
which is the roster, not the gate. With the gate off the two coverage rosters
produce the same game to the play, because nothing reads the men; the test
pins that as a deep-equality of the rates.

**What it must not do.** A league that turns this on to see its corners
matter must not silently get a different scoring environment, so the
property pinned is the one `schemes.test.ts` pins for the catalog, turned
around: a mismatch produces more than a match does, in both directions, and
a roster whose groups are rated alike plays the game it played before. Over
500 balanced games the gate moves completion 52.7 → 53.7%, explosives
39.0 → 38.5%, picks 5.9 → 5.7%, sacks 10.3 → 10.0%, passing yards 130 → 132
and combined points 38.2 → 38.0. The one point of completion is fatigue and
not a lever: with `injuries` off it is 52.9 → 53.1%. A secondary tackles as
well as covers, so by the fourth quarter it is the more tired group, and the
gate is the first thing to read that.

**The reference roster was lying, and the gate found it.** The CLI's 25-man
roster rated every player a little lower than the one listed before him, and
the defense was typed in after the offense — so its secondary sat nine points
below its receivers by an accident of listing order, invisible for as long as
no rating was read against another. On that roster the gate threw for 145
yards a game at 55% and put three points on the board, which is the game that
talent implies and not the game a "72 everywhere" claims. The roster is now
rated by position: the starter at the team rating, each man behind him three
lower. With the gate off that reproduces the aggregate table to the decimal,
because only the kicker's rating was ever read; with it on:

| per team per game | before | `matchups` | varsity |
| --- | --- | --- | --- |
| completion rate | 52.9% | 52.6% | 50–55% |
| passing yards | 128 | 129 | 110–150 |
| sacks | 2.11 | 2.13 | ~2 |
| interceptions | 1.09 | 1.08 | ~1 |
| rushing share of TDs | 63% | 65% | 55–65% |
| combined points | 37.72 | 37.84 | ~42 |

Every aggregate stays in band. The rushing share reads at the top of its band,
which is the draw stream shifting under a different sequence of selections
rather than anything the gate reads — it sat at 62% on the old roster with the
gate on — and combined scoring moves a tenth of a point, which is to say it
does not move. That was the design: the four points were closed as a tuning
question and this does not reopen it.

**What it unlocks.** A recruiting class spent on a corner shows up in the box
score, as fewer completions and more interceptions against *him*. Explosives
concentrate on mismatches instead of spreading evenly. And the choreographer
gets three facts it can draw rather than invent: `coverage` is cast onto the
defensive back nearest the target and runs the target's route with him a
yard and a half off with inside leverage; `pass_rusher` is cast onto the
front and `blocker` onto the lineman across from him, and the two meet in the
pocket — the first visual-fidelity gain that is not invention.

**Cost.** Three selections on every dropback that did not happen before, and
two that used to happen afterwards no longer do, so it is RNG-shifting and
opt-in. Verified inert when off across five gate configurations including
everything else on, and the v1 fixture regenerates byte-for-byte.

## Two small debts, paid (`sackStats` and `interceptionReturns` gates)

Both found while writing up the box-score attribution work, both real, and
both small enough to land beside the matchups gate rather than ahead of it.

**A sack is not a pass attempt (`sackStats`, reducer only).** The reducer
booked a sack as an attempt with the yards lost charged to the passing line —
so a quarterback sacked twice in eighteen dropbacks read 9 of 18 where the
sport reads 9 of 16, and completion percentage moved on a play with no ball
thrown in it. The varsity book (the NCAA statisticians' manual, which the NFHS
follows) charges a sack as a rushing attempt with the yardage lost and leaves
the passing line alone. Under the gate that is what `deriveStatLines` does:
`sacked` still counts it, the passer takes a carry for the loss, and `att`
counts throws. Over 600 games the box-score completion percentage reads
**52.5%** against **46.9%** with the sacks in the denominator — the old
number was five and a half points low, and it was the number a dynasty shows
on the quarterback's card.

Gated the way `returnStats` was, because it replaces a wrong non-zero number
that a league may already have published; `logModels(log, "sackStats")` tells
the two apart, and a stored log with no gates books the old way. The engine
reads nothing from it — the log is byte-identical apart from recording the
gate, which the test pins — and `pnpm sim` is unmoved because it counts play
types rather than stat lines.

**A pick return has a shape (`interceptionReturns`).** `doPass` drew the
return on an interception as `rand() * 20`: every length from nothing to
twenty equally likely, mean ten, which gets the average about right and the
shape entirely wrong. Under the gate it is a punt return's curve with a lower
ceiling and no floor, because a pick can be made at the sideline or on the
ground and returned nowhere. One draw either way, so the sequence is unchanged
until the yardage differs. Over 600 games:

| pick returns | flat | `interceptionReturns` |
| --- | --- | --- |
| mean | 10.2 | **8.9** |
| median / p90 | 10 / 18 | **7 / 22** |
| longest | 20 | **26** |
| returned nowhere | 2.3% | **14.9%** |
| under five yards | 23% | **42%** |
| fifteen or more | 31% | 28% |
| mean drive start after a pick | own 58.1 | own 57.1 |
| combined points | 37.84 | 37.94 |

Most die a few yards from the catch when the pursuit turns, a few reach the
second level, and one in a while goes — which is what a return looks like.
The reducer already read `returnYards` into `defense.intYards`, so the box
score credits the new number without a change. Verified inert when off across
five gate configurations including `matchups`, and the v1 fixture regenerates
byte-for-byte.

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

**The punt on screen.** `puntEvents` laid every punt out as one net number,
even after `puntReturns` began recording `returnYards` — the kickoff got the
return-aware layout and the punt did not, so a punt returned to the house was
drawn as a ball landing in the end zone. It now reads the same two numbers the
kickoff does: the gross is `net + returnYards`, the ball is caught there, and
the return runs back to where the net says the next drive starts, ending in a
tackle nobody is credited with (the engine names no tackler on a punt) or a
touchdown at the punting team's goal line. A punt that recorded no return —
a v1 punt, a fair catch, a touchback, a ball downed in coverage — is still the
ball dead where the next drive starts, and under `puntReturner` the beat names
nobody, because nobody fielded it; the choreographer then moves nobody, and a
returner who did signal a fair catch comes to the ball and stays on his feet
rather than being drawn tackled. The caption says the same thing: "Punt, 41
yards, returned 9." Reads the log, draws nothing, needs no gate.

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
| `render/jersey.ts` | Slot label → the number he wears (pure, no Three) |
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
10. Under `kickReturns`, `returnYards === 0` means a touchback and nothing else,
    nobody is named the returner on one, and the box-score kick-return total
    equals the sum of what the engine simulated
11. Under `kickingGame`, a better-rated kicker makes more of his kicks and is
    sent out from further; with it off, the rating is read by nobody
12. Under `redZone`, a play that would have ended three or more yards past the
    goal line is never stopped at the one; a play that would have ended at the
    line is stopped exactly as often as `goalLineConversion` stopped it
13. Under `downAndDistance`, a play spends the same draws it did without it —
    the gate changes what is called, never how much randomness a snap consumes
14. Under `quarterBreak`, no drive ends because a quarter did: `end_of_half`
    appears only at halftime and at the end of an overtime period, the offense
    keeps its down and distance across Q1→Q2 and Q3→Q4, and no snap is ever
    handed a first down it did not earn
15. Points attributable to players in `deriveStatLines` equal the final score —
    for each team, not only in total. Invariants 2 and 3 stop at the play level;
    this one is the same promise carried through to the derived stats, and it is
    the assertion that catches a scoring play the reducer forgot to read
16. Under `puntReturner`, `returnYards === 0` on a punt means nobody is named
    the returner, no snap is charged to him and no injury can reach him — the
    promise invariant 10 already makes for the kickoff
17. Under `matchups`, a mismatch produces more than a match does in both
    directions — a receiver with the corner beaten completes more, breaks more
    and is picked less, a rusher with the lineman beaten gets home more — and
    a roster whose groups are rated alike plays the game it played without
    the gate, within noise. The gate redistributes; it never adds
18. Under `sackStats`, `passing.att` counts throws and nothing else; a sack
    is one `sacked` and one carry for the yards lost, the passing line is
    untouched by it, and the points the box score attributes do not move
19. Under `interceptionReturns`, a pick return is never longer than 26 yards,
    zero is a length it can have, the median sits below the mean, and the
    box-score interception-return total equals the sum the engine simulated

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
