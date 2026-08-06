/*
 * What a carry gains.
 *
 * Distribution tests, because a carry is only meaningful in aggregate: any
 * single run is plausible at almost any yardage, and the thing that was wrong
 * was the SHAPE. v1 drew from `2 + rand()*5 + edge*4`, whose floor is two yards
 * before the edge, so there was no arithmetic path through it to being stopped.
 * Across ten thousand carries not one lost a yard.
 *
 * The numbers checked below are **high school** football's, loosely banded.
 * That matters: this engine plays twelve-minute quarters, allows one overtime
 * timeout and puts a 52-yard field goal at the edge of plausible. Calibrating
 * it against professional numbers — a 4.3-yard carry, a 65% completion rate —
 * produces a game that is wrong in a way every aggregate agrees on, which is a
 * mistake this file exists partly to prevent repeating.
 *
 * Bands rather than points on purpose: this is a game, not a projection, and
 * pinning a mean to two decimals turns every future tuning pass into a test
 * edit.
 */
import { describe, expect, it } from "vitest";
import {
  RECOMMENDED_FEATURES,
  deriveStatLines,
  simulateGameLog,
  seedFor,
  type PbpGameLog,
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

function games(rushDistribution: boolean, count = 120): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "carries", String(i)),
      features: { ...RECOMMENDED_FEATURES, rushDistribution },
    }),
  );
}

const carries = (logs: PbpGameLog[]): number[] =>
  logs
    .flatMap((l) => l.drives.flatMap((d) => d.plays))
    .filter((p) => p.playType === "rush" && !p.penalty?.negatesPlay)
    .map((p) => p.yardsGained);

const V2 = carries(games(true));
const V1 = carries(games(false));

const share = (a: number[], predicate: (y: number) => boolean) =>
  a.filter(predicate).length / a.length;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const percentile = (a: number[], p: number) =>
  [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];

describe("the shape of a carry", () => {
  it("has enough carries to describe a distribution", () => {
    expect(V2.length).toBeGreaterThan(3000);
  });

  it("can be stopped for a loss, which v1 could not", () => {
    /*
     * The defect in one line. Not a rounding problem or a rare path — v1's
     * yardage expression had a floor of two, so a stuffed run was arithmetically
     * impossible and `tfl` was dead code for every rushing play in the game.
     */
    expect(share(V1, (y) => y < 0)).toBe(0);
    expect(share(V2, (y) => y < 0)).toBeGreaterThan(0.05);
    expect(share(V2, (y) => y < 0)).toBeLessThan(0.14);
  });

  it("is stopped at or behind the line about a fifth of the time", () => {
    expect(share(V2, (y) => y <= 0)).toBeGreaterThan(0.14);
    expect(share(V2, (y) => y <= 0)).toBeLessThan(0.26);
  });

  it("averages what a carry averages, and typically less", () => {
    // Varsity backs average around five a carry against defenses that miss more
    // tackles, with the median below the mean — the signature of a distribution
    // carried by a thin right tail rather than by the typical run.
    expect(mean(V2)).toBeGreaterThan(4);
    expect(mean(V2)).toBeLessThan(6.2);
    expect(percentile(V2, 0.5)).toBeLessThan(mean(V2));
  });

  it("breaks a long one occasionally, and a huge one rarely", () => {
    expect(share(V2, (y) => y >= 10)).toBeGreaterThan(0.07);
    expect(share(V2, (y) => y >= 10)).toBeLessThan(0.2);
    expect(share(V2, (y) => y >= 20)).toBeLessThan(0.05);
    // A run that goes the distance has to be possible at all.
    expect(Math.max(...V2)).toBeGreaterThan(35);
  });

  it("was a narrow band before, and is a long-tailed one now", () => {
    // v1's whole distribution lived inside a few yards; this is the difference
    // a viewer would actually notice.
    expect(Math.max(...V1)).toBeLessThan(Math.max(...V2));
    expect(percentile(V1, 0.1)).toBeGreaterThan(percentile(V2, 0.1));
  });
});

describe("what the shape changes downstream", () => {
  it("finally credits a tackle for loss on a run", () => {
    /*
     * The stat existed and was unreachable: every tackle for loss in a v1 game
     * was a sack, because `isNegativePlay` needs a rush with negative yardage
     * and v1 could not produce one.
     */
    const tflAndSacks = (logs: PbpGameLog[]) => {
      let tfl = 0;
      let sacks = 0;
      for (const log of logs) {
        tfl += deriveStatLines(log).reduce(
          (s, l) => s + (l.statLine.defense?.tfl ?? 0),
          0,
        );
        sacks += log.drives
          .flatMap((d) => d.plays)
          .filter((p) => p.playType === "sack" && !p.penalty?.negatesPlay).length;
      }
      return { tfl, sacks };
    };

    const before = tflAndSacks(games(false, 40));
    const after = tflAndSacks(games(true, 40));
    // Before: every single one was a sack.
    expect(before.tfl).toBe(before.sacks);
    // After: strictly more than the sacks, because runs are being stuffed too.
    expect(after.tfl).toBeGreaterThan(after.sacks);
  });

  it("brings rushing yardage back inside a plausible band", () => {
    const perTeamGame = (logs: PbpGameLog[]) =>
      logs.reduce(
        (sum, log) =>
          sum +
          deriveStatLines(log).reduce((s, l) => s + (l.statLine.rushing?.yards ?? 0), 0),
        0,
      ) /
      (logs.length * 2);

    // A varsity team runs for 150-180 on a full workload; these games are
    // measured without the high-school play-calling split, so the band is wide.
    const after = perTeamGame(games(true, 40));
    expect(after).toBeGreaterThan(100);
    expect(after).toBeLessThan(210);
    // And strictly less than the model that could not be stopped at all.
    expect(after).toBeLessThan(perTeamGame(games(false, 40)));
  });
});
