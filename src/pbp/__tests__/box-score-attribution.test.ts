/*
 * Every point on the scoreboard belongs to somebody.
 *
 * `deriveStatLines` accounted for 97.1% of the points the engine scored. The
 * missing 2.9% was not spread thinly: it decomposed exactly into four plays the
 * reducer never credited — a pick-six (`defTd` was declared and incremented by
 * nothing), a punt returned to the house (`prTd` read `isScoring`, which is
 * false on every one of them), a two-point conversion (no `case` at all) and a
 * safety (same). 674 points over 600 games, 1.1 a game, in nobody's line.
 *
 * The headline test is the reconciliation: box-score points equal the final
 * score, every game. That one assertion catches all four holes at once and the
 * next one, which is why it is here rather than four separate examples. The
 * tests after it pin each defect individually so a failure says which.
 *
 * Sample sizes are large on purpose. A safety happens about once every thirty
 * games and a pick-six about once every nine, so a nonzero floor asserted at
 * 150 games is a coin flip that a later gate shifting the PRNG stream turns
 * into a failure that says nothing about the box score — see the comments at
 * the top of `games()` in `kicking-game.test.ts` and `red-zone.test.ts`. Twelve
 * hundred games cost about 200ms.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_FEATURES,
  RECOMMENDED_FEATURES,
  V1_FEATURES,
  attributedPoints,
  deriveStatLines,
  simulateGameLog,
  seedFor,
  type PbpFeatureGates,
  type PbpGameLog,
  type PbpPlay,
  type PlayerSimProfile,
  type TeamSimProfile,
} from "../../index.js";

function team(id: string, strength: number): TeamSimProfile {
  const p = (position: string, overall: number): PlayerSimProfile => ({
    playerId: `${id}-${position}`,
    position,
    overall,
  });
  return {
    teamId: id,
    strength,
    discipline: strength,
    coach: { aggression: 62 },
    players: [
      p("QB", strength),
      p("RB", strength - 2),
      p("WR", strength - 1),
      p("TE", strength - 4),
      p("DE", strength - 3),
      p("LB", strength - 2),
      p("CB", strength - 2),
      p("S", strength - 3),
      p("K", 70),
      p("P", 65),
    ],
  };
}

function games(
  features: Required<PbpFeatureGates> | PbpFeatureGates,
  { count = 1200, label = "attribution" } = {},
): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", label, String(i)),
      features,
    }),
  );
}

const LOGS = games(RECOMMENDED_FEATURES);

/** The plays that officially happened — a flag can erase one. */
const counted = (log: PbpGameLog): PbpPlay[] =>
  log.drives.flatMap((d) => d.plays).filter((p) => !p.penalty?.negatesPlay);

function total(logs: PbpGameLog[], read: (line: PbpGameLog) => number): number {
  return logs.reduce((sum, log) => sum + read(log), 0);
}

/** Sum one field of one group across every player in a game. */
function box(log: PbpGameLog, group: string, field: string): number {
  return deriveStatLines(log).reduce((sum, l) => {
    const g = (l.statLine as Record<string, Record<string, number> | undefined>)[group];
    return sum + (g?.[field] ?? 0);
  }, 0);
}

/** Count plays across every game matching a predicate. */
function plays(logs: PbpGameLog[], match: (p: PbpPlay) => boolean): number {
  return logs.reduce((sum, log) => sum + counted(log).filter(match).length, 0);
}

describe("invariant 15: the box score accounts for the scoreboard", () => {
  /*
   * The reconciliation, and the reason for everything below it. Points reach a
   * team five ways and the box score has to hold all five — a touchdown, a
   * field goal, an extra point, a two-point try and a safety — regardless of
   * which side of the ball scored them.
   */
  for (const [name, features] of [
    ["RECOMMENDED_FEATURES", RECOMMENDED_FEATURES],
    ["ALL_FEATURES", ALL_FEATURES],
    ["V1_FEATURES", V1_FEATURES],
  ] as const) {
    it(`equals the final score in every game under ${name}`, () => {
      const logs = features === RECOMMENDED_FEATURES ? LOGS : games(features);
      const off: string[] = [];
      for (const log of logs) {
        const scoreboard = log.homeScore + log.awayScore;
        const attributed = attributedPoints(deriveStatLines(log));
        if (attributed !== scoreboard) {
          off.push(`seed ${log.seed}: scoreboard ${scoreboard}, box ${attributed}`);
        }
      }
      expect(off, `${off.length}/${logs.length} games do not reconcile`).toEqual([]);
      // And the games actually scored, so an all-zero suite cannot pass this.
      expect(total(logs, (l) => l.homeScore + l.awayScore)).toBeGreaterThan(1000);
    });
  }

  it("holds team by team, not just in aggregate", () => {
    /*
     * A sum over both teams hides a swap: credit the punt-return touchdown to
     * the punting team and the total still matches. Split it.
     */
    for (const log of LOGS.slice(0, 300)) {
      const lines = deriveStatLines(log);
      const forTeam = (teamId: string) =>
        attributedPoints(lines.filter((l) => l.teamId === teamId));
      expect(forTeam(log.homeTeamId)).toBe(log.homeScore);
      expect(forTeam(log.awayTeamId)).toBe(log.awayScore);
    }
  });
});

describe("a pick-six credits the man who took it back", () => {
  it("counts a defensive touchdown for every interception returned to the house", () => {
    const pick6 = plays(LOGS, (p) => p.playType === "interception" && p.isReturnTd === true);
    expect(pick6).toBeGreaterThan(40);
    expect(total(LOGS, (l) => box(l, "defense", "defTd"))).toBe(pick6);
  });

  it("credits the interception too, and to the same player", () => {
    /*
     * `defTd` replaces nothing. A pick-six is still an interception, and the
     * old behavior — credit the pick, stop — has to survive alongside the fix.
     */
    const picks = plays(LOGS, (p) => p.playType === "interception");
    expect(total(LOGS, (l) => box(l, "defense", "int"))).toBe(picks);

    const log = LOGS.find((l) =>
      counted(l).some((p) => p.playType === "interception" && p.isReturnTd),
    )!;
    const play = counted(log).find((p) => p.playType === "interception" && p.isReturnTd)!;
    const interceptor = play.participants.find((p) => p.role === "interceptor")!;
    const line = deriveStatLines(log).find((l) => l.playerId === interceptor.playerId)!;
    expect(line.statLine.defense?.defTd).toBeGreaterThanOrEqual(1);
    expect(line.statLine.defense?.int).toBeGreaterThanOrEqual(1);
    expect(line.teamId).toBe(play.defenseTeamId);
  });

  it("credits nothing on a pick that was merely returned", () => {
    // `defTd` reads `isReturnTd`, not "this player had a long return".
    const ordinary = games(RECOMMENDED_FEATURES, { count: 60, label: "ordinary" }).filter(
      (l) => !counted(l).some((p) => p.isReturnTd),
    );
    expect(ordinary.length).toBeGreaterThan(0);
    for (const log of ordinary) expect(box(log, "defense", "defTd")).toBe(0);
  });
});

describe("a punt returned for a score credits the returner", () => {
  it("counts one prTd per punt-return touchdown", () => {
    /*
     * The defect was one word. A punt-return touchdown is the RECEIVING team
     * scoring on a play its opponent ran, so it sets `isReturnTd` and leaves
     * `isScoring` false — the reducer read `isScoring` and credited nobody,
     * ever, while the kickoff case twenty lines above already read the right
     * flag and carried the reason in a comment.
     */
    const houseCalls = plays(LOGS, (p) => p.playType === "punt" && p.isReturnTd === true);
    expect(houseCalls).toBeGreaterThan(15);
    expect(total(LOGS, (l) => box(l, "returns", "prTd"))).toBe(houseCalls);
  });

  it("gives it to the returner named on the play", () => {
    const log = LOGS.find((l) =>
      counted(l).some((p) => p.playType === "punt" && p.isReturnTd),
    )!;
    const play = counted(log).find((p) => p.playType === "punt" && p.isReturnTd)!;
    const returner = play.participants.find((p) => p.role === "returner")!;
    const line = deriveStatLines(log).find((l) => l.playerId === returner.playerId)!;
    expect(line.statLine.returns?.prTd).toBeGreaterThanOrEqual(1);
    expect(line.teamId).toBe(play.defenseTeamId);
  });

  it("still credits the kickoff return touchdown it never lost", () => {
    const krTd = plays(LOGS, (p) => p.playType === "kickoff" && p.isReturnTd === true);
    expect(krTd).toBeGreaterThan(30);
    expect(total(LOGS, (l) => box(l, "returns", "krTd"))).toBe(krTd);
  });
});

describe("a two-point conversion reaches the box score", () => {
  it("credits the passer and the receiver for the attempt", () => {
    const tries = plays(
      LOGS,
      (p) => p.playType === "two_point_convert" || p.playType === "two_point_fail",
    );
    expect(tries).toBeGreaterThan(60);
    expect(total(LOGS, (l) => box(l, "passing", "twoPtAtt"))).toBe(tries);
    expect(total(LOGS, (l) => box(l, "receiving", "twoPtAtt"))).toBe(tries);
  });

  it("credits the conversion only when it converted", () => {
    const made = plays(LOGS, (p) => p.playType === "two_point_convert");
    expect(made).toBeGreaterThan(25);
    expect(total(LOGS, (l) => box(l, "passing", "twoPtConv"))).toBe(made);
    expect(total(LOGS, (l) => box(l, "receiving", "twoPtConv"))).toBe(made);
  });

  it("keeps the try out of the passing and receiving lines", () => {
    /*
     * How a real box score reports it, and not only convention: a two-point try
     * has no down and no distance, and counting it as an attempt would move
     * completion percentage on a play that is not a scrimmage down.
     *
     * `derive-stats.test.ts` already pins `att` to the throws and `rec` to the
     * completions; this asserts the same boundary from the other side, on the
     * games that actually contain a try.
     */
    const withTries = LOGS.filter((l) =>
      counted(l).some(
        (p) => p.playType === "two_point_convert" || p.playType === "two_point_fail",
      ),
    );
    expect(withTries.length).toBeGreaterThan(30);
    for (const log of withTries) {
      const thrown = counted(log).filter((p) =>
        ["pass_complete", "pass_incomplete", "sack", "interception"].includes(p.playType),
      ).length;
      const caught = counted(log).filter((p) => p.playType === "pass_complete").length;
      expect(box(log, "passing", "att")).toBe(thrown);
      expect(box(log, "receiving", "rec")).toBe(caught);
      // ...and the touchdown totals stay apart from the two points, which is
      // the distinction the separate fields exist to keep.
      expect(box(log, "receiving", "td")).toBe(
        counted(log).filter((p) => p.playType === "pass_complete" && p.isScoring).length,
      );
    }
  });
});

describe("a safety credits the man who made it", () => {
  it("counts one safety per safety", () => {
    const safeties = plays(LOGS, (p) => p.playType === "safety");
    expect(safeties).toBeGreaterThan(10);
    expect(total(LOGS, (l) => box(l, "defense", "safeties"))).toBe(safeties);
  });

  it("credits the tackler the engine named, and his tackle with it", () => {
    /*
     * Two defects meeting on one play: the reducer had no `case "safety"`, and
     * `creditDefense` ran on two play types, so even with a case the tackle
     * would have gone nowhere.
     */
    const log = LOGS.find((l) => counted(l).some((p) => p.playType === "safety"))!;
    const play = counted(log).find((p) => p.playType === "safety")!;
    const tackler = play.participants.find((p) => p.role === "tackler_solo")!;
    const line = deriveStatLines(log).find((l) => l.playerId === tackler.playerId)!;
    expect(line.statLine.defense?.safeties).toBeGreaterThanOrEqual(1);
    expect(line.statLine.defense?.tacklesSolo).toBeGreaterThanOrEqual(1);
    expect(line.teamId).toBe(play.defenseTeamId);
  });
});

describe("interception return yardage has somewhere to go", () => {
  it("equals what the engine simulated, summed over the game", () => {
    /*
     * The standard this repo set for punt returns under `returnStats`: the
     * number in the box score is the number in the log, not a reconstruction
     * from a final figure. The engine has rolled `round(rand() * 20)` on every
     * pick since v1 and spotted the ball with it; there was no field to put it
     * in, so ~10 yards a pick went nowhere.
     */
    for (const log of LOGS.slice(0, 400)) {
      const simulated = counted(log)
        .filter((p) => p.playType === "interception")
        .reduce((sum, p) => sum + (p.returnYards ?? 0), 0);
      expect(box(log, "defense", "intYards")).toBe(simulated);
    }
    const picks = plays(LOGS, (p) => p.playType === "interception");
    const yards = total(LOGS, (l) => box(l, "defense", "intYards"));
    expect(picks).toBeGreaterThan(1000);
    // A flat 0–20 roll, so the mean lands at 10. Bounded loosely: the claim is
    // that the box score reads the roll, not that the roll has this shape.
    expect(yards / picks).toBeGreaterThan(8);
    expect(yards / picks).toBeLessThan(12);
  });

  it("stays absent on a log the engine never wrote it to", () => {
    /*
     * Honest absence, and the reason there is no fallback here. A log without
     * `scoringV2` carries no `returnYards` on a pick, and nothing in it can be
     * turned into one — inventing a number from `yardsGained` is the defect
     * `returnStats` was written to remove, not a precedent to follow.
     */
    const legacy = games(V1_FEATURES, { count: 40, label: "legacy" });
    expect(plays(legacy, (p) => p.playType === "interception")).toBeGreaterThan(20);
    for (const log of legacy) {
      for (const p of counted(log).filter((x) => x.playType === "interception")) {
        expect(p.returnYards).toBeUndefined();
      }
      for (const line of deriveStatLines(log)) {
        expect(line.statLine.defense?.intYards ?? 0).toBe(0);
      }
    }
  });
});

describe("a punt nobody returned is not a return", () => {
  it("counts one return per punt actually returned", () => {
    /*
     * Invariant 10's promise, arrived at late on the other kick. `participants`
     * is built with a returner unconditionally, before the fair catch /
     * touchback / downed branches run, so the reducer credited a return on
     * every punt: 4,252 recorded where 2,464 happened, dragging yards per
     * return from a true 9.6 to a reported 5.6. The yardage was always right.
     */
    const returned = plays(
      LOGS,
      (p) => p.playType === "punt" && (p.returnYards ?? 0) > 0,
    );
    const punts = plays(LOGS, (p) => p.playType === "punt");
    expect(returned).toBeGreaterThan(0);
    expect(returned).toBeLessThan(punts);
    expect(total(LOGS, (l) => box(l, "returns", "prCount"))).toBe(returned);
  });

  it("credits nobody on a fair catch, a touchback or a downed ball", () => {
    /*
     * The log still names a returner on all of them, which is the shape this
     * repo would rather not have — but `applyAttrition` reads
     * `play.participants` for snap cost and to pick who got hurt, so taking a
     * name off a punt changes which player is injured on it and every play
     * after. That is an RNG-shifting change and it is not this one, so the
     * reducer reads the return the engine recorded instead.
     */
    const namedOnEveryPunt = LOGS.slice(0, 400).every((log) =>
      counted(log)
        .filter((p) => p.playType === "punt")
        .every((p) => p.participants.some((x) => x.role === "returner")),
    );
    expect(namedOnEveryPunt).toBe(true);

    // A game whose punts were ALL fair caught, downed or touched back credits
    // no returner at all — the count follows the return, not the name.
    const quiet = LOGS.filter((log) => {
      const punts = counted(log).filter((p) => p.playType === "punt");
      return punts.length > 0 && punts.every((p) => (p.returnYards ?? 0) === 0);
    });
    expect(quiet.length).toBeGreaterThan(0);
    for (const log of quiet) expect(box(log, "returns", "prCount")).toBe(0);
  });

  it("counts the return per game, not just in aggregate", () => {
    for (const log of LOGS.slice(0, 400)) {
      const returned = counted(log).filter(
        (p) => p.playType === "punt" && (p.returnYards ?? 0) > 0,
      ).length;
      expect(box(log, "returns", "prCount")).toBe(returned);
    }
  });

  it("reports a return average a returner would recognize", () => {
    // The count was the whole defect, so this is the number it was distorting.
    const yards = total(LOGS, (l) => box(l, "returns", "prYards"));
    const count = total(LOGS, (l) => box(l, "returns", "prCount"));
    expect(yards / count).toBeGreaterThan(8);
    expect(yards / count).toBeLessThan(11);
  });

  it("reads a recorded zero as a fair catch only under `puntReturns`", () => {
    /*
     * The same number means two different things. Under `puntReturns` a zero is
     * a decision the engine made — fair catch, touchback, downed in coverage.
     * Without it, v1 returned every punt and a zero only means the net clamp
     * bit, so reading it as a fair catch would credit an event that was never
     * simulated and would move a count underneath a league's stored logs — the
     * thing `returnStats` was gated to avoid.
     */
    const legacy = games(
      { ...RECOMMENDED_FEATURES, puntReturns: false },
      { count: 60, label: "stored" },
    );
    const punts = plays(legacy, (p) => p.playType === "punt");
    const zeros = plays(legacy, (p) => p.playType === "punt" && p.returnYards === 0);
    expect(punts).toBeGreaterThan(150);
    // The population this protects: recorded zeros that are not fair catches.
    expect(zeros).toBeGreaterThan(0);
    expect(total(legacy, (l) => box(l, "returns", "prCount"))).toBe(punts);
  });
});

describe("a tackle is credited wherever the engine names a tackler", () => {
  it("matches the box score to the roles in the log, play type by play type", () => {
    /*
     * `creditDefense` was called from `case "rush"` and `case "pass_complete"`
     * and nowhere else, so the man who made a safety got nothing. It now runs
     * from the reduction itself rather than from inside the cases, because
     * being wired up case by case is how it came to be missing.
     */
    const role = (r: string) => (p: PbpPlay) => p.participants.filter((x) => x.role === r).length;
    const named = (r: string) =>
      LOGS.reduce(
        (sum, log) => sum + counted(log).reduce((n, p) => n + role(r)(p), 0),
        0,
      );
    expect(total(LOGS, (l) => box(l, "defense", "tacklesSolo"))).toBe(named("tackler_solo"));
    expect(total(LOGS, (l) => box(l, "defense", "tacklesAst"))).toBe(named("tackler_ast"));
  });

  it("credits the strip-sack the reducer used to drop", () => {
    /*
     * Same species, found alongside: a sack under `scoringV2` can name a
     * `fumbler` and a `recoverer`, and `creditFumble` ran only on a rush, so
     * roughly one strip-sack a game was simulated and recorded and then read by
     * nobody. Running both credit functions on every play fixes it for free.
     */
    const fumbled = LOGS.reduce(
      (sum, log) =>
        sum +
        counted(log).filter((p) => p.participants.some((x) => x.role === "fumbler")).length,
      0,
    );
    const strips = plays(LOGS, (p) => p.playType === "sack" && p.participants.some((x) => x.role === "fumbler"));
    expect(strips).toBeGreaterThan(200);
    expect(total(LOGS, (l) => box(l, "ballSecurity", "fumbles"))).toBe(fumbled);
    expect(total(LOGS, (l) => box(l, "defense", "fr"))).toBe(fumbled);
  });
});

describe("a v1 log gains nothing it did not have", () => {
  it("leaves every new credit at zero", () => {
    /*
     * The gate question, answered by measurement rather than assumed. Every
     * field this change added reads `isReturnTd`, `defensivePoints`, a v2 play
     * type or `returnYards` — none of which a v1 log contains — so its derived
     * stats cannot move and no gate is needed to protect them. That is what
     * makes this different from `returnStats`, which replaced a wrong non-zero
     * number and had to be opt-in.
     */
    for (const log of games(V1_FEATURES, { count: 60, label: "v1-inert" })) {
      for (const field of ["defTd", "intYards", "safeties"]) {
        expect(box(log, "defense", field)).toBe(0);
      }
      expect(box(log, "returns", "prTd")).toBe(0);
      expect(box(log, "returns", "krTd")).toBe(0);
      expect(box(log, "passing", "twoPtAtt")).toBe(0);
      expect(box(log, "receiving", "twoPtConv")).toBe(0);
    }
  });

  it("still omits a group a player has no activity in", () => {
    // Honest absence survives six new fields: a group of zeros is not a line.
    for (const log of [LOGS[0], LOGS[1], ...games(V1_FEATURES, { count: 2, label: "prune" })]) {
      for (const line of deriveStatLines(log)) {
        for (const [group, values] of Object.entries(line.statLine)) {
          expect(
            Object.values(values as Record<string, number>).some((v) => v !== 0),
            `${line.playerId} has an all-zero ${group}`,
          ).toBe(true);
        }
      }
    }
  });
});
