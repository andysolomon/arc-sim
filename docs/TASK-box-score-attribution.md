# Task: every point on the scoreboard belongs to somebody

**Goal.** Make `deriveStatLines` account for 100% of the points the engine
scores. It currently accounts for 96.7%.

**Species.** This is the defect `docs/ENGINE.md` already names twice — the
`returnStats` gate ("a statistic invented from a final figure, which is the one
thing this engine exists not to do") and `tfl` being dead code before
`rushDistribution`. The engine simulates something, and the box score either
throws it away or credits it to nobody.

**Scope.** `src/pbp/derive-stats.ts` and the stat-line shape it fills. The
engine's play log is correct throughout — the scoreboard, `defensivePoints`,
`isReturnTd` and the try after a defensive score all work. Do not change how
any game is simulated.

---

## The evidence

Reconciling the scoreboard against the derived box scores over 600 games with
`RECOMMENDED_FEATURES`:

```
scoreboard points: 22653    box-score points: 21905    unaccounted: 748  (3.3%)
```

1.25 points a game with no home in any stat line. It decomposes exactly —
462 + 162 + 78 + 46 = 748:

| what scored | over 600 games | why it is missed |
| --- | --- | --- |
| pick-six | 77 TDs, 462 pts | `defense.defTd` is never incremented anywhere |
| punt return TD | 27 TDs, 162 pts | `returns.prTd` is guarded on the wrong flag |
| two-point conversion | 39, 78 pts | the reducer has no `case` for it at all |
| safety | 23, 46 pts | the tackler the engine named gets nothing |

Kickoff return touchdowns are the one return score that IS credited (26 of 26),
which is what makes the other three read as oversights rather than a decision.

Two more of the same species, found alongside:

| | over 600 games |
| --- | --- |
| interceptions carrying simulated return yardage no field can hold | 1,322 picks, mean **10.0 yards** |
| punts credited as a "return" that was a fair catch, touchback or downed ball | **1,878 phantom returns** (3.1 a game) |

Reproduce any of this by simulating N games, summing `homeScore + awayScore`,
and summing `6 * (rushing.td + receiving.td + returns.krTd + returns.prTd +
defense.defTd) + 3 * kicking.fgMade + kicking.xpMade` across every stat line.

---

## The defects, precisely

### 1. `returns.prTd` reads the wrong flag — `derive-stats.ts:134`

```ts
if (play.isScoring) line.returns.prTd += 1;   // never true
```

A punt return touchdown is the **receiving** team scoring on a play its opponent
ran, so it sets `isReturnTd: true` and `defensivePoints: 6` and leaves
`isScoring: false` (`engine.ts:1408-1412`). The fix is `play.isReturnTd`.

The kickoff case twenty lines above already does exactly this, and carries the
reason in a comment (`derive-stats.ts:100-105`):

> A kick return touchdown is the RECEIVING team scoring on a play its opponent
> ran, so it lands in `defensivePoints` and not in `isScoring` — which is why
> reading `isScoring` here credited nobody, ever.

Someone fixed this for the kickoff and left the identical line in the punt case
one block below.

### 2. `defense.defTd` is dead — `derive-stats.ts:35`

Declared in `emptyLine()`, never incremented by anything. The interception case
(`derive-stats.ts:223-239`) credits `defense.int` and stops, so a pick-six is a
plain interception in the box score. The interceptor is named on the play, so
the data is there.

Note: today `defTd` can only come from a pick-six — no fumble-return score path
reaches the end zone (measured: 0 in 600 games). Wire it for the general case
anyway; a scoop-and-score is a scoring play the type system already permits.

### 3. A two-point conversion vanishes entirely

`deriveStatLines`' switch has no `case "two_point_convert"` or
`"two_point_fail"`, so `default: break` swallows both. The engine always throws
it (`engine.ts:1985-2012`) and names a `passer` and a `receiver`; neither is
credited with an attempt, a target, a reception or the two points.

### 4. A safety credits nobody

`doSafety` (`engine.ts:1932-1956`) names a `tackler_solo`, and the reducer has
no `case "safety"`. See also defect 6 — `creditDefense` would not run on it even
if the case existed.

### 5. Interception return yardage has nowhere to go — `engine.ts:1715`

```ts
const returnYards = Math.round(state.rand() * 20);
```

Rolled on every pick, used to spot the ball, written to `play.returnYards` under
`scoringV2` — and then discarded, because no stat field holds it. Mean 10.0
yards across 1,322 interceptions.

### 6. `creditDefense` only runs on two play types — `derive-stats.ts:169,191`

It is called from `case "rush"` and `case "pass_complete"` and nowhere else, so
no tackle is credited on a sack, an interception, a punt, a kickoff or a safety.

### 7. A punt names a returner even when nobody returned it — `engine.ts:1355-1358`

`participants` is built with a `returner` unconditionally, before the fair
catch / touchback / downed branches run. The reducer then credits
`prCount += 1` on every punt, so 4,392 returns are recorded where 2,514
happened, dragging yards-per-return from a true 9.4 to a reported 5.4. Punt
return **yardage** is correct — `returnStats` made the total match the engine's
exactly — only the count is inflated.

The kickoff already models this correctly and says why (`engine.ts:925-930`):

> Nobody is the returner on a touchback. v1 named one on every kickoff, which is
> how a box score came to credit returns that were never made — honest absence
> is the rule everywhere else in this log and there is no reason for the kickoff
> to be the exception.

This one is the only defect in the list that touches `engine.ts`. It changes the
play's `participants` array, not any outcome and not any random draw — but it
does change stored log content, so read the gate question below before deciding
how to land it.

---

## Acceptance criteria

1. Points attributable to players in `deriveStatLines` equal the final score,
   for every game, under `RECOMMENDED_FEATURES` and `ALL_FEATURES`.
2. A pick-six credits the interceptor with an interception **and** a defensive
   touchdown.
3. A punt returned for a score credits the returner with `prTd`.
4. A two-point conversion credits the passer and the receiver for the attempt
   and, when it converts, for the two points.
5. A safety credits the defender who made it.
6. Interception return yardage in the box score equals what the engine
   simulated, summed over the game — the standard this repo set for punt returns.
7. `prCount` equals the number of punts actually returned. `returnYards === 0`
   on a punt means fair catch, touchback or downed, and nobody is the returner —
   the promise invariant 10 already makes for kickoffs.
8. Tackles are credited on every play type where the engine names a tackler.
9. No game changes. `pnpm gen:golden` must leave `v1-golden-logs.json`
   byte-for-byte identical (an empty `git diff` is the check).

Add the invariant to `docs/ENGINE.md`, in the family of 2 and 3 — those stop at
the play level and never reach the derived stats:

> **15.** Points attributable to players in `deriveStatLines` equal the final
> score.

That one assertion catches all four scoring holes at once, and the next one.

---

## Decisions the implementer has to make

**Schema.** Defects 3, 4 and 5 need somewhere to put a number that has no field
today: interception return yardage, two-point conversions, and safeties. Follow
the honest-absence rule the package already documents in `README.md` — a stat
group is absent rather than zeroed when a player did nothing in that phase — and
prefer extending an existing group (`defense`, `returns`, `passing`,
`receiving`) over inventing a new one. Two-point conversions are conventionally
kept apart from touchdown totals in a real box score; do not fold them into
`passing.td` / `receiving.td`.

**Gate or no gate.** Probably none is needed, but verify rather than assume:

- `isReturnTd` and `defensivePoints` are only written under `scoringV2`, and
  `defTd` / `prTd` are currently always zero. A v1 log has nothing to read, so
  its derived stats cannot move. That is different from `returnStats`, which
  replaced a wrong non-zero number and had to be opt-in.
- Defect 7 is the one to think hardest about. Removing the phantom returner
  changes `prCount` for logs a league has already stored — a number that is
  currently wrong but non-zero. Compare with how `returnStats` and `kickReturns`
  handled the same situation and be able to defend the choice either way.

If you do add a gate, it must consume **zero** random draws when off, and it
goes in all three presets in `src/pbp/presets.ts` explicitly (that file fails
the build until someone decides, which is deliberate).

---

## Tests

New file `src/pbp/__tests__/box-score-attribution.test.ts`, following the shape
of `red-zone.test.ts` and `quarter-break.test.ts`.

- The reconciliation invariant over a few hundred games — the headline test.
- One test per defect, asserting the specific credit now appears and that its
  count matches what the log contains.
- `prCount` equals punts with `returnYards > 0`; no returner named on the rest.
- Interception return yards: box-score total equals the engine's total exactly.
- Existing `derive-stats.test.ts` must keep passing unchanged.

**On sample sizes:** these events are rare — 77 pick-sixes and 23 safeties in
600 games. Size the sample so the assertion is about behavior and not about
noise. Two tests in this repo were recently found to be reading noise at 150
games; see the comments at the top of `games()` in `kicking-game.test.ts` and
`red-zone.test.ts` for the standard. A thousand games costs about a second.

---

## Verification

```bash
pnpm verify        # type-check + test + build + dist-check
pnpm gen:golden    # then: git diff must be empty
pnpm sim --games 600   # every varsity aggregate must stay in band
```

---

## Conventions

- Read `docs/ENGINE.md` first. The prose standard there is the bar: state the
  measurement, the mechanism and what it cost, not the intention.
- Commits: `feat(pbp): ...` / `fix(pbp): ...`, lowercase, describing what
  changed in football terms. **No AI attribution** — no `Co-Authored-By`,
  `Generated-by` or similar trailers.
- Update `docs/ENGINE.md` (a section for the change, plus invariant 15) and the
  gate table / preset counts if a gate is added.
- Work on `main`; this repo pushes directly.

## Out of scope

- Any change to what the engine simulates, including the interception return
  distribution itself (a flat `rand() * 20` is the wrong shape for a pick
  return, but fixing it is a separate, gated, RNG-shifting change).
- The ~4-point combined-scoring gap. `docs/ENGINE.md` closes that thread
  deliberately: closing it requires taking something out of band, a trade
  rather than a fix.
- Sacks counting as pass attempts (`derive-stats.ts:207-222`). Real, arguable,
  and it would move completion percentage — file it separately.
