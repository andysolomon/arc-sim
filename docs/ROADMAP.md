# Where the engine goes next

What is open, in the order it should be done, and why that order. First
written September 2026, after the box-score attribution work closed invariant
15; brought up to date the same month, after the four items it listed landed.
`docs/ENGINE.md` is the record of what has been done; this is the record of
what has not, and it has shrunk.

## Where it stands

Twenty-five gates, 419 tests, every varsity aggregate in band, every point on
the scoreboard attributable to a player, and the v1 fixture reproducing
byte-for-byte. Combined scoring sits at 37.9 against ~42, and `ENGINE.md`
closes that thread deliberately: every distribution that feeds it is already in
band, so moving it means un-pinning something that is currently right.
Nothing below reopens it as a tuning question. The matchups gate was the one
item that might have moved it as a consequence; it moved it a tenth of a point,
which is to say it did not.

Nothing has shipped, and nothing is scheduled to. `package.json` says 0.1.0 and the package is not on npm.
The provenance release pipeline is built and has never fired. CI is green on
every commit to `main`.

## What "high fidelity" means here

There are two axes, and the ceiling that used to cap both has been raised
once.

**Simulation fidelity** is whether the box score could have come from a real
game. That is what every gate so far has bought, and the instrument is the
aggregate table in `ENGINE.md`.

**Visual fidelity** is whether the renderer's picture of a play looks like
football. The choreographer may invent *how* and never *what* — lanes, routes,
pursuit angles and who-blocks-whom are invented, everything else comes from
`PbpSimEvent.spot`.

The ceiling was that **the engine resolved a play with a handful of rolls and
picked participants by position weight.** Nobody blocked anybody, no receiver
was covered by a particular corner, and the offensive line was a position group
that never touched a play. `matchups` moved that ceiling for the dropback: the
man in coverage, the pass rusher and his blocker are chosen before the outcome
and the outcome reads them, and the choreographer draws the three as facts.
The carry is still resolved the old way — nobody blocks for a run, no
linebacker fills a particular gap — and that is the next step on both axes if
one is taken. Not physics, not a per-frame simulation, and not a departure
from the contract: the engine stays headless, the choreographer stays pure,
and every new mechanic stays a gate that draws nothing when off.

## Done since this was written

In the order it listed them. Each has a section in `ENGINE.md`.

1. **Honest absence for the punt returner** — `puntReturner`. A punt nobody
   returned names nobody; the returner is still selected so the draw count
   holds. Six games in 600 diverge with `injuries` on, which are the six
   injuries that moved to the punter. Invariant 16.
2. **Individual matchups** — `matchups`. Coverage and pass rush, each read as
   the difference between two men. A 90 receiver on a 60 corner completes
   61% and breaks 56% of his catches; the reverse completes 47% and is picked
   at 7.9%. A balanced roster plays the game it played before. The CLI's
   reference roster turned out to be rated on listing order, with a secondary
   nine points below its receivers by accident; it is now rated by position
   and reproduces the table with the gate off. Invariant 17.
3. **Two correctness debts** — `sackStats` (reducer-only: a sack is a carry for
   a loss, not an attempt; box-score completion percentage 46.9% → 52.5%) and
   `interceptionReturns` (a pick return is a punt return's curve with a lower
   ceiling; median 7 against a mean of 8.9, longest 26). Invariants 18 and 19.
4. **The punt on screen.** `puntEvents` reads `returnYards` the way the
   kickoff's layout does: caught at the gross, returned to the net, a
   touchdown at the punting team's goal line. No gate.

## In order

Nothing. The list is empty, which is what it was supposed to become. What
comes next is whatever the next measurement says is wrong; the candidates are
below, and none of them is owed.

## Not on the list

- **Publishing.** Not planned. The provenance pipeline is built and documented
  under "Releasing" in the README, and the one-time setup is an `NPM_TOKEN`
  secret the repository does not have. When the work should be usable outside
  this repo, that is the whole of the job; until then the package stays at
  0.1.0 and off npm.
- **The four points.** Closed in `ENGINE.md`, "Calibrated for high school";
  reopen only with a mechanism the evidence supports. `matchups` was the
  candidate and it did not move them, which is the evidence.
- **Matchups on the carry.** The natural next mechanic — a back against a
  linebacker in the gap, a line against a front — and the same shape as the
  dropback's: gated, RNG-shifting, neutral for a balanced roster. Not listed
  because nothing measured is wrong without it; list it when something is.
- **A physics or per-tick simulation.** The engine models outcomes, and the
  renderer's value is that it is honest about that. A ball in flight is a
  drawing convention and stays one.
- **Model files for the renderer.** Players are built from boxes on purpose;
  see "The players are built, not loaded" in `ENGINE.md`.
- **Host-app concerns.** Persistence, Gamecast, dynasty progression and league
  kill switches stay in the host application.
