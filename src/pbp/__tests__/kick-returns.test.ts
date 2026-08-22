/*
 * What happens to a kickoff after it comes down.
 *
 * v1 resolved the entire play with one roll and then used the answer twice: as
 * the yard line the receiving team started on, and as the yardage credited to
 * the returner. So every kick was fielded, every one was returned, nobody was
 * ever handed a touchback, and a returner's box-score line was read off the
 * drive's starting spot rather than off anything he did — the same invented
 * statistic the `returnStats` gate removed from the punt, on the other kick.
 *
 * Distributions, not examples. One kickoff says nothing about whether a model
 * is right; the shape over three thousand of them is the whole claim.
 */
import { describe, expect, it } from "vitest";
import {
  deriveStatLines,
  simulateGameLog,
  seedFor,
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

const GATES = {
  scoringV2: true,
  penalties: true,
  situational: true,
  balance: true,
  defensivePat: true,
};

function games(kickReturns: boolean, count = 60): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "kickoffs", String(i)),
      features: { ...GATES, kickReturns },
    }),
  );
}

const kickoffs = (logs: PbpGameLog[]): PbpPlay[] =>
  logs
    .flatMap((l) => l.drives.flatMap((d) => d.plays))
    .filter((p) => p.playType === "kickoff" && !p.penalty?.negatesPlay);

const V2_LOGS = games(true);
const V1_LOGS = games(false);
const V2 = kickoffs(V2_LOGS);
const V1 = kickoffs(V1_LOGS);
const returns = V2.map((p) => p.returnYards ?? 0).filter((y) => y > 0);

describe("the shape of a kickoff", () => {
  it("has enough of them to say anything about", () => {
    expect(V2.length).toBeGreaterThan(400);
  });

  it("reaches the end zone sometimes, which v1 never did", () => {
    /*
     * A varsity leg gets there occasionally, not routinely — which is exactly
     * why the return is still a live play at this level. v1 could not produce a
     * touchback at all: its single roll had a floor of 18 and was clamped to
     * the 15, so the ball was always brought out from somewhere.
     */
    const touchbacks = V2.filter((p) => p.returnYards === 0).length;
    const rate = touchbacks / V2.length;
    expect(rate).toBeGreaterThan(0.05);
    expect(rate).toBeLessThan(0.3);

    expect(V1.every((p) => p.returnYards === undefined)).toBe(true);
  });

  it("averages a plausible return, with the typical one shorter", () => {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const sorted = [...returns].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // A varsity kick return runs about 18-22 yards.
    expect(mean).toBeGreaterThan(16);
    expect(mean).toBeLessThan(25);
    expect(median).toBeLessThan(mean);
    // Higher floor and less skew than a punt return, because the plays are not
    // alike: he catches this one running, with the field in front of him.
    expect(Math.min(...returns)).toBeGreaterThan(0);
    expect(median).toBeGreaterThan(12);
  });

  it("occasionally takes one all the way", () => {
    const houseCalls = V2.filter((p) => p.isReturnTd);
    expect(houseCalls.length).toBeGreaterThan(0);
    // A highlight, not a play call.
    expect(houseCalls.length / returns.length).toBeLessThan(0.02);
    for (const td of houseCalls) {
      expect(td.defensivePoints).toBe(6);
      // The RECEIVING team scored, and on this play it is the defense.
      expect(td.isScoring).toBe(false);
      expect(td.returnYards).toBeGreaterThan(50);
    }
  });

  it("could not take one back at all in v1", () => {
    // `doKickoff` wrote `isScoring: false` unconditionally, so this was not a
    // rare event — it was unreachable code.
    expect(V1.some((p) => p.isReturnTd)).toBe(false);
    expect(V1.some((p) => (p.defensivePoints ?? 0) > 0 && p.playType === "kickoff")).toBe(false);
  });
});

describe("the arithmetic of the play", () => {
  it("puts the receiving team where the net says it does", () => {
    for (const [i, log] of V2_LOGS.entries()) {
      void i;
      const drives = log.drives;
      for (let d = 0; d < drives.length - 1; d++) {
        const last = drives[d].plays.at(-1);
        if (last?.playType !== "kickoff" || last.isReturnTd) continue;
        /*
         * Only when the receiving team's drive is the one that follows. A
         * kickoff on the last tick of a half leaves an empty drive that the
         * next kickoff overwrites before anything is recorded to it — v1
         * behaviour, unrelated to this gate, and not what is being checked.
         */
        if (drives[d + 1].teamId !== last.defenseTeamId) continue;
        // `yardsGained` is the NET the kick moved the ball, as it already is on
        // a punt — so the next drive's start is derivable from the play alone.
        const implied = 100 - (last.fieldPosition + last.yardsGained);
        expect(drives[d + 1].startFieldPosition).toBe(implied);
      }
    }
  });

  it("never returns one from a yard line that does not exist", () => {
    for (const play of V2) {
      const startSpot = 100 - (play.fieldPosition + play.yardsGained);
      const caught = startSpot - (play.returnYards ?? 0);
      // Where he caught it is his own goal line at the deepest — a kick fielded
      // in the end zone is returned from the 0, not from behind it.
      expect(caught).toBeGreaterThanOrEqual(0);
      expect(caught).toBeLessThan(100);
    }
  });

  it("keeps every drive it starts on the field", () => {
    for (const log of V2_LOGS) {
      for (const drive of log.drives) {
        expect(drive.startFieldPosition).toBeGreaterThanOrEqual(1);
        expect(drive.startFieldPosition).toBeLessThanOrEqual(99);
      }
    }
  });

  it("does not quietly move field position, which would be a balance change", () => {
    /*
     * The point of the gate is variance and honest bookkeeping, not a better or
     * worse starting spot. If the mean drive start after a kickoff moved, this
     * would be a scoring change wearing a bug fix's clothes — and the eleven
     * calibrated aggregates would shift underneath a league that only wanted
     * its box scores fixed.
     */
    const meanStart = (logs: PbpGameLog[]) => {
      let total = 0;
      let count = 0;
      for (const log of logs) {
        for (let d = 0; d < log.drives.length - 1; d++) {
          const last = log.drives[d].plays.at(-1);
          if (last?.playType !== "kickoff" || last.isReturnTd) continue;
          if (log.drives[d + 1].teamId !== last.defenseTeamId) continue;
          total += log.drives[d + 1].startFieldPosition;
          count += 1;
        }
      }
      return total / count;
    };
    expect(Math.abs(meanStart(V2_LOGS) - meanStart(V1_LOGS))).toBeLessThan(2);
  });
});

describe("the box score", () => {
  const krTotals = (logs: PbpGameLog[]) => {
    let count = 0;
    let yards = 0;
    let td = 0;
    for (const log of logs) {
      for (const { statLine } of deriveStatLines(log)) {
        count += statLine.returns?.krCount ?? 0;
        yards += statLine.returns?.krYards ?? 0;
        td += statLine.returns?.krTd ?? 0;
      }
    }
    return { count, yards, td };
  };

  it("credits exactly what the engine simulated", () => {
    /*
     * The reconciliation the punt gate established: the box-score total is the
     * engine's total, not a number derived from a different number.
     */
    const kept = V2.filter((p) => !p.penalty?.negatesPlay);
    const simulated = kept.reduce((sum, p) => sum + (p.returnYards ?? 0), 0);
    expect(krTotals(V2_LOGS).yards).toBe(simulated);
  });

  it("counts a return only when there was one", () => {
    const returned = V2.filter((p) => (p.returnYards ?? 0) > 0).length;
    expect(krTotals(V2_LOGS).count).toBe(returned);
    // Nobody is the returner on a touchback, so nobody is credited with one.
    expect(krTotals(V2_LOGS).count).toBeLessThan(V2.length);
  });

  it("credits the touchdowns that v1 could not count", () => {
    expect(krTotals(V2_LOGS).td).toBe(V2.filter((p) => p.isReturnTd).length);
    expect(krTotals(V2_LOGS).td).toBeGreaterThan(0);
    expect(krTotals(V1_LOGS).td).toBe(0);
  });

  it("was reading the drive's starting spot before", () => {
    /*
     * The bug in one number. v1 credited the returner with `yardsGained`, which
     * WAS the yard line the drive started on — so a returner who was handed the
     * ball at his own 28 and tackled immediately went in the book for a 28-yard
     * return. It comes out near 29 a return against a simulated ~21.
     */
    const v1Mean = krTotals(V1_LOGS).yards / krTotals(V1_LOGS).count;
    const v2Mean = krTotals(V2_LOGS).yards / krTotals(V2_LOGS).count;
    expect(v1Mean).toBeGreaterThan(27);
    expect(v2Mean).toBeLessThan(v1Mean - 4);
  });
});

describe("the score still adds up", () => {
  it("counts a return touchdown once, to the team that scored it", () => {
    for (const log of V2_LOGS) {
      const kept = log.drives
        .flatMap((d) => d.plays)
        .filter((p) => !p.penalty?.negatesPlay);
      const scored = (teamId: string) =>
        kept.reduce(
          (sum, p) =>
            sum +
            (p.isScoring && p.offenseTeamId === teamId ? p.pointsScored : 0) +
            (p.defenseTeamId === teamId ? (p.defensivePoints ?? 0) : 0),
          0,
        );
      expect(scored(log.homeTeamId)).toBe(log.homeScore);
      expect(scored(log.awayTeamId)).toBe(log.awayScore);
    }
  });

  it("kicks the point after one, and gives it to the right team", () => {
    /*
     * The same trap `defensivePat` was built for, reached by a new path: after
     * a kick return touchdown the team with the ball is the one that just
     * conceded, so a naive reuse of `doExtraPoint` hands the point backwards.
     */
    let tries = 0;
    for (const log of V2_LOGS) {
      const kept = log.drives
        .flatMap((d) => d.plays)
        .filter((p) => !p.penalty?.negatesPlay);
      kept.forEach((p, i) => {
        if (p.playType !== "kickoff" || !p.isReturnTd) return;
        tries += 1;
        const next = kept[i + 1];
        expect(next?.playType).toMatch(/^extra_point/);
        expect(next!.offenseTeamId).toBe(p.defenseTeamId);
      });
    }
    expect(tries).toBeGreaterThan(0);
  });

  it("kicks off again to the team that had just kicked", () => {
    for (const log of V2_LOGS) {
      const kept = log.drives.flatMap((d) => d.plays);
      kept.forEach((p, i) => {
        if (p.playType !== "kickoff" || !p.isReturnTd) return;
        // Try, then the restart — the scoring team is kicking this one.
        const restart = kept.slice(i + 1).find((q) => q.playType === "kickoff");
        if (!restart) return; // The touchdown ended the game.
        expect(restart.offenseTeamId).toBe(p.defenseTeamId);
      });
    }
  });

  it("does not blow up scoring", () => {
    const points = (logs: PbpGameLog[]) =>
      logs.reduce((s, l) => s + l.homeScore + l.awayScore, 0) / logs.length;
    // Return touchdowns are rare enough that the band barely moves.
    expect(Math.abs(points(V2_LOGS) - points(V1_LOGS))).toBeLessThan(4);
  });
});

describe("with the gate off", () => {
  it("changes nothing, under any combination of the others", () => {
    /*
     * The load-bearing property of the whole gate design, checked here rather
     * than only against the v1 fixture: a gate that draws randomness while
     * switched off shifts the PRNG and rewrites every play after it. The golden
     * test catches that with everything else off; this catches it with
     * everything else on, where the new branch actually sits next to live code.
     */
    const configurations = [
      {},
      { scoringV2: true },
      { scoringV2: true, situational: true, balance: true },
      { scoringV2: true, puntReturns: true, defensivePat: true },
      {
        scoringV2: true,
        penalties: true,
        situational: true,
        balance: true,
        weather: true,
        injuries: true,
        schemes: true,
        goalLineYards: true,
        goalLineConversion: true,
        returnStats: true,
        puntReturns: true,
        defensivePat: true,
        rushDistribution: true,
        playCalling: true,
        passingGame: true,
      },
    ];
    for (const [c, features] of configurations.entries()) {
      for (let i = 0; i < 5; i++) {
        const input = {
          home: team("home", 72),
          away: team("away", 68),
          seed: seedFor("pbp", "inert", String(c), String(i)),
        };
        expect(
          simulateGameLog({ ...input, features: { ...features, kickReturns: false } }),
        ).toEqual(simulateGameLog({ ...input, features }));
      }
    }
  });
});

describe("what a renderer sees", () => {
  const drawn = simulateGameLog({
    home: team("home", 74),
    away: team("away", 66),
    seed: seedFor("pbp", "kickoffs", "timeline"),
    features: { ...GATES, kickReturns: true, timeline: true },
  });
  const laid = drawn.drives
    .flatMap((d) => d.plays)
    .filter((p) => p.playType === "kickoff");

  it("lays out a return from where it was caught to where it ended", () => {
    const returned = laid.filter((p) => (p.returnYards ?? 0) > 0);
    expect(returned.length).toBeGreaterThan(0);
    for (const play of returned) {
      const events = play.events ?? [];
      const start = events.find((e) => e.type === "return_start");
      // The whistle carries no spot, so the last SPOTTED beat is the stop.
      const end = [...events].reverse().find((e) => e.spot !== undefined);
      expect(start).toBeDefined();
      // Spots are in the KICKING team's frame, so the returner runs downward.
      expect(start!.spot).toBeGreaterThan(end!.spot!);
      // Where the engine actually spotted it, not where the layout guessed.
      expect(end!.spot).toBe(play.fieldPosition + play.yardsGained);
    }
  });

  it("does not stage a return nobody made", () => {
    const touchbacks = laid.filter((p) => p.returnYards === 0);
    expect(touchbacks.length).toBeGreaterThan(0);
    for (const play of touchbacks) {
      const events = play.events ?? [];
      expect(events.some((e) => e.type === "return_start")).toBe(false);
      const end = [...events].reverse().find((e) => e.spot !== undefined);
      expect(end!.spot).toBe(play.fieldPosition + play.yardsGained);
    }
  });
});
