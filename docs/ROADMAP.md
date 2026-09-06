# Where the engine goes next

What is open, in the order it should be done, and why that order. Written
September 2026, after the box-score attribution work closed invariant 15.
`docs/ENGINE.md` is the record of what has been done; this is the record of
what has not, and it should shrink.

## Where it stands

Twenty-one gates, 373 tests, thirteen of fourteen varsity aggregates in band,
every point on the scoreboard attributable to a player, and the v1 fixture
reproducing byte-for-byte. The one aggregate out of band is combined scoring —
37.7 against ~42 — and `ENGINE.md` closes that thread deliberately: every
distribution that feeds it is already in band, so moving it means un-pinning
something that is currently right. Nothing below reopens it as a tuning
question. One item below may move it as a *consequence*, and that is a
different thing.

Nothing has shipped. `package.json` says 0.1.0 and the package is not on npm.
The provenance release pipeline is built and has never fired.

## What "high fidelity" means here

There are two axes, and one ceiling.

**Simulation fidelity** is whether the box score could have come from a real
game. That is what every gate so far has bought, and the instrument is the
aggregate table in `ENGINE.md`.

**Visual fidelity** is whether the renderer's picture of a play looks like
football. The choreographer may invent *how* and never *what* — lanes, routes,
pursuit angles and who-blocks-whom are invented, everything else comes from
`PbpSimEvent.spot`.

The ceiling is the same for both: **the engine resolves a play with a handful
of rolls and picks participants by position weight.** Nobody blocks anybody. No
receiver is covered by a particular corner — `selectDefender(def, state,
"coverage")` picks a back by weight *after* the completion has been decided.
The offensive line is a position group that never touches a play. Ratings feed
a single team-strength edge, except the kicker, who got a real leg in
`kickingGame`. The renderer cannot show a corner beaten on a post because the
engine does not know one was, and the aggregate table cannot find the last
four points because there is no mechanism underneath the curves for them to
come from — only the curves.

So the next real step is the same step on both axes. Not physics, not a
per-frame simulation, and not a departure from the contract: the engine stays
headless, the choreographer stays pure, and every new mechanic stays a gate
that draws nothing when off.

## In order

### 1. Honest absence for the punt returner — `docs/TASK-punt-returner-honest-absence.md`

The one known defect. The log names a returner on 43% of punts that nobody
returned; he is charged a snap and can be the one injured — six players in 600
games hurt on a play they were not part of. Small, fully specified, and it
makes "`participants` is the men who played" true, which everything below
assumes.

### 2. Individual matchups

The fidelity step. Two mechanisms, each its own gate:

- **A target is thrown at a covered man.** On a pass the engine names the
  receiver first and the defender in coverage on him, and the completion,
  interception and yards-after-catch read the *difference* between them rather
  than the team edge. A 90 receiver against a 60 corner is the explosive play;
  the reverse is the pick.
- **A dropback is blocked by somebody.** The sack and pressure rate read a
  pass-rusher against a lineman, which is the first time an offensive
  lineman's rating is read by anyone.

What it costs and what it must not do. It is RNG-shifting, so it is gated. It
must keep the aggregate table where it is — the same discipline `kickReturns`
stated as "field position does not move": a league that turns it on to see
its corners matter must not silently get a different scoring environment. The
property to pin is the one `schemes.test.ts` pins for the catalog: a mismatch
produces more than a match does, in both directions, and the team-level rates
over a season do not move. If combined scoring moves as a consequence, say so
and say by how much; do not tune for it.

What it unlocks. A recruiting class spent on a corner shows up in the box
score. Explosives concentrate on mismatches instead of spreading evenly. And
the choreographer gets a fact it can draw — *this* man was covering *that* one
— which is the first visual-fidelity gain that is not invention.

### 3. Two small correctness debts, alongside

- **A sack counts as a pass attempt** (`derive-stats.ts:207-222`). Real,
  moves completion percentage, reducer-only. Gated the way `returnStats` was,
  because it replaces a wrong non-zero number under stored logs.
- **Interception return yardage is `rand() * 20`** (`engine.ts`, in
  `doPass`). Flat, mean 10, the wrong shape for a pick return — it should look
  like a punt return with a lower ceiling. RNG-shifting, gated, and the
  reducer already reads whatever it writes.

### 4. The punt on screen

`puntEvents` in `timeline.ts` still lays a punt out as one net number, even
when `returnYards` is recorded. The kickoff got the `returnYards`-aware layout
— catch spot, return, tackle or touchdown — and the punt did not, so a
punt-return touchdown is drawn as a ball landing in the end zone. Reads the
log, draws nothing, needs no gate. Renderer work, half a day.

### 5. Publish 0.2.0

Whenever the work should be usable outside this repo. The pipeline is
documented under "Releasing" in the README; the one-time setup is an
`NPM_TOKEN` secret. Publishing is outward-facing and gets confirmed first.

## Not on the list

- **The four points.** Closed in `ENGINE.md`, "Calibrated for high school";
  reopen only with a mechanism the evidence supports.
- **A physics or per-tick simulation.** The engine models outcomes, and the
  renderer's value is that it is honest about that. A ball in flight is a
  drawing convention and stays one.
- **Model files for the renderer.** Players are built from boxes on purpose;
  see "The players are built, not loaded" in `ENGINE.md`.
- **Host-app concerns.** Persistence, Gamecast, dynasty progression and league
  kill switches stay in the host application.
