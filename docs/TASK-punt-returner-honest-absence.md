# Task: nobody is the returner on a punt nobody returned

**Goal.** Make the play log stop naming a punt returner on a punt that was fair
caught, touched back or downed. Behind a gate, because it changes who gets
hurt.

**Species.** The rule the kickoff already states (`engine.ts`, in
`doKickoffWithReturn`):

> Nobody is the returner on a touchback. v1 named one on every kickoff, which is
> how a box score came to credit returns that were never made — honest absence
> is the rule everywhere else in this log and there is no reason for the
> kickoff to be the exception.

The punt is the exception. `docs/ENGINE.md` names this as the one defect left
behind on purpose after the box-score attribution work ("What was left behind"),
and the reducer's comment at `derive-stats.ts:152` says the same thing: the box
score no longer *counts* the phantom return, but the log still records a man
who was not on the play, and the engine still charges him for it.

**Scope.** `src/pbp/engine.ts` (`doPuntWithReturn`), a new gate in
`src/pbp/types.ts` and all three presets, `docs/ENGINE.md`. The reducer already
reads the return rather than the name and needs no change. The kickoff is the
model; do not touch it.

---

## The evidence

600 games, `RECOMMENDED_FEATURES`, the ten-man test roster from
`box-score-attribution.test.ts`:

| | over 600 games |
| --- | --- |
| punts | 4,401 (7.3 a game) |
| never returned — touchback, fair catch or downed | **1,906 (43%)** |
| of those, naming a returner anyway | **1,906 — every one** |
| touchbacks | 486 |
| fair caught or downed in coverage | 1,420 |
| phantom returners per game | 3.2 |

What the phantom costs him. `applyAttrition` reads `play.participants` twice:

1. **A snap.** `snapCost("punt")` is 0.6, charged to every participant. The
   returner is drawn from the top of the receiver depth chart
   (`selectPlayer(def, "WR", state, true)`), so a team's best receiver is
   charged about **1.9 stamina a game** against a budget of 46 — roughly 4% of
   his legs — for plays on which he stood and watched, or in the case of a
   touchback was not on the field at all. Stamina feeds `substitutionCandidate`
   (who starts the next snap) and the injury roll.
2. **The injury roll.** `victim = participants[floor(whoRoll * participants.length)]`.
   With two names on the play, the returner takes half of every punt's injury
   exposure at `contactFactor("punt") = 0.9`, whether or not anybody touched
   him.

| injuries, over 600 games | |
| --- | --- |
| total | 1,001 |
| on a punt | 31 |
| on a punt nobody returned | 15 |
| **to the man named returner on a punt nobody returned** | **6** |

Six players in 600 games hurt on a play they were not part of — one every
hundred games. Rare, and wrong in the way the six-point pick-six was wrong:
it produces a thing football cannot produce, a receiver injured fielding a
punt that was touched back.

**Why it has to be a gate.** A prototype that drops the name when
`returned === 0` — nothing else — was run against the same 600 seeds, with
`participants` stripped from both logs before hashing so only *outcomes* were
compared:

| | games that diverge |
| --- | --- |
| `injuries` off | **0** of 600 |
| `injuries` on | **6** of 600 — exactly the six above |

The draw count is unchanged in both, which is what makes this invisible to the
usual test for a gate that leaks: the sequence does not shift, the outcome
does. With one fewer name the same `whoRoll` lands on the punter instead, and
he has a different stamina, so the same `whetherRoll` can go the other way —
and from there every later play is different. A league with stored logs and
`injuries` on would find a receiver's injury history rewritten underneath it.

Note the roster: it carries one receiver, so the substitution channel —
phantom fatigue causing a different man to be *selected* on a later snap — is
unexercised here. A real roster with depth at receiver may diverge in more than
six games. Measure it with a deep roster before writing the number down.

---

## The defect, precisely

`doPuntWithReturn`, `engine.ts` (search for the function; it begins by building
`participants`):

```ts
const participants: PbpParticipant[] = [
  participant(punter, off.teamId, "kicker"),
  participant(returner, def.teamId, "returner"),   // ← before any branch runs
];
```

The fair-catch, touchback and downed branches come after, and `returned` is
known before the play object is built. The kickoff builds its array at the end
instead:

```ts
participants: [
  participant(kicker, kickingTeam.teamId, "kicker"),
  ...(returnYards > 0
    ? [participant(returner, receiving.teamId, "returner")]
    : []),
],
```

That is the whole change to the engine, gated. One caution that is easy to
get wrong: **`selectPlayer` for the returner draws randomness** (`weightedPick`
under `distribute`) and it must keep being called exactly where it is, gate on
or off. Skipping the selection on a punt nobody returned would save a draw
and shift every play after it — which would turn a change that touches six
games in 600 into one that touches all of them, and make the gate impossible to
verify as "identical except for who is hurt". The gate changes what is
*written down* on the play, never how much randomness the punt spends — the
same discipline `downAndDistance` states as invariant 13.

---

## Acceptance criteria

1. Under the gate, a punt with `returnYards === 0` names no participant with
   role `returner`. Invariant 10's promise, made for punts.
2. Under the gate, a punt with `returnYards > 0` has exactly the participants
   it had before — same players, same order.
3. With the gate off, every log is byte-identical in every configuration,
   including all of `RECOMMENDED_FEATURES` with `injuries` on. The
   five-configuration inert test from `kick-returns.test.ts` is the shape.
4. Gate on, `injuries` off: logs are identical to gate-off logs after
   `participants` is stripped from both. This is the criterion that proves the
   selection draw was kept.
5. Gate on, `injuries` on: nobody is ever injured on a punt he was not named
   on; the victim of an injury on an unreturned punt is the punter.
6. `deriveStatLines` is unchanged and `prCount` still equals the number of
   punts with `returnYards > 0` — the reducer already reads the return.
7. `puntEvents` in `timeline.ts` already tolerates an absent returner
   (`returner?.playerId`, `teamId: returner ? … : undefined`). Pin it: the
   `kick_result` event on an unreturned punt carries no `playerId`.
8. The gate is in all three presets: `false` in `V1_FEATURES`, `true` in the
   other two. "Twenty-one" becomes "twenty-two" in `presets.ts`, `README.md`
   and `docs/ENGINE.md` — all three say it.
9. `pnpm gen:golden` leaves the v1 fixture byte-for-byte identical.
10. `pnpm sim --games 600` reports the same aggregates it did before.

Add the invariant to `docs/ENGINE.md`:

> **16.** Under `puntReturner`, `returnYards === 0` on a punt means nobody is
> named the returner, no snap is charged to him and no injury can reach him —
> the promise invariant 10 already makes for the kickoff.

And remove the first bullet of "What was left behind (on purpose)", which this
closes.

---

## Decisions the implementer has to make

**Gate name.** `puntReturner` is the working name — it sits beside
`puntReturns` and `kickReturns` and says what it governs. Rename if something
reads better in the gate table, but keep it out of `puntReturns` itself:
folding it in would silently change injury outcomes for every league already
running that gate.

**Who takes the roll when the returner is gone.** With one name on the play
the punter takes 100% of an unreturned punt's injury exposure at
`contactFactor("punt") = 0.9`, which over-exposes a man who kicked the ball
and jogged off. The kickoff has the same asymmetry on a touchback and accepted
it — the kicker alone, at 1.6. Follow the kickoff. From the numbers above the
punter's share of unreturned-punt injuries goes from about half of 15 to all
of about 15 per 600 games, one every forty games; measure it and put the
number in the section. If it looks wrong, the fix is to `contactFactor` on a
non-contact punt, and it is a separate change because it removes three draws.

**`logModels`.** Add `puntReturner` to `MECHANIC_GATE` in `migrate-log.ts`.
Under `puntReturns` alone a reader has to check `returnYards` to know whether a
named returner did anything; under this gate the absence itself is the signal,
and a UI drawing the play needs to know which log it is reading.

**The reducer's comment.** `derive-stats.ts:152-165` explains why the reducer
reads the return instead of the name and says honest absence "is still owed".
It is now paid; rewrite the comment to say where.

**The test that asserts the defect.** `box-score-attribution.test.ts`,
"credits nobody on a fair catch, a touchback or a downed ball", asserts
`namedOnEveryPunt === true` and explains why. Under the new gate that is
false. Keep the assertion for logs *without* the gate and add its mirror for
logs with it; do not delete it, because it is what documents that the reducer
does not depend on the name.

---

## Tests

New file `src/pbp/__tests__/punt-returner.test.ts`, in the shape of
`kick-returns.test.ts`.

- Criterion 1 and 2 over a thousand games.
- The five-configuration inert test (criterion 3), with `injuries: true` in the
  fullest configuration — that is the one that would have caught this.
- Criterion 4: strip `participants`, deep-equal gate-on to gate-off, `injuries`
  off, a few hundred games.
- Criterion 5: over a thousand games with `injuries` on, every `play.injury`
  on a punt names a participant of that play; on an unreturned punt it is the
  punter.
- Criterion 7 against a timeline-on log.
- Use a roster with three or four receivers for at least one of these, so the
  substitution channel is exercised.

**On sample sizes:** six events in 600 games. Assert the *property* (no injury
to a non-participant) over a thousand games rather than a count, and see the
comments at the top of `games()` in `kicking-game.test.ts` and
`red-zone.test.ts` for why.

---

## Verification

```bash
pnpm verify            # type-check + test + build + dist-check
pnpm gen:golden        # then: git diff must be empty
pnpm sim --games 600   # every varsity aggregate must stay in band
```

---

## Conventions

- Read `docs/ENGINE.md` first. State the measurement, the mechanism and what it
  cost, not the intention.
- Commits: `feat(pbp): ...`, lowercase, in football terms. **No AI
  attribution** — no `Co-Authored-By`, `Generated-by` or similar trailers.
- Update `docs/ENGINE.md`: a section for the gate, the gate table, the preset
  count, invariant 16, and the "left behind" list.
- Work on `main`; this repo pushes directly.

## Out of scope

- Skipping the injury roll on a non-contact punt (`contactFactor`). Removes
  draws; its own gate.
- The punt timeline. `puntEvents` still stages a punt as one net number even
  when `returnYards` is recorded — the kickoff's layout got the
  `returnYards`-aware treatment and the punt did not. It reads the log and
  draws nothing, so it needs no gate, but it is renderer work and not this.
- Anything about *which* receiver is the returner. He is drawn from the top of
  the depth chart with no returner slot; a dynasty that wants to name one is a
  roster-shape question.
