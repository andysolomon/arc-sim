/*
 * What a carry gains.
 *
 * Distribution tests, because a carry is only meaningful in aggregate: any
 * single run is plausible at almost any yardage, and the thing that was wrong
 * was the SHAPE. v1 drew from `2 + rand()*5 + edge*4`, whose floor is two yards
 * before the edge, so there was no arithmetic path through it to being stopped.
 * Across ten thousand carries not one lost a yard.
 *
 * The numbers checked below are the real sport's, loosely banded. They are
 * bands rather than points on purpose — this is a game, not a projection, and
 * pinning a mean to two decimals would turn every future tuning pass into a
 * test edit.
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
    // Mean near 4, median below it — the signature of a distribution whose
    // average is carried by a thin right tail rather than by the typical run.
    expect(mean(V2)).toBeGreaterThan(3.4);
    expect(mean(V2)).toBeLessThan(5);
    expect(percentile(V2, 0.5)).toBeLessThan(mean(V2));
  });

  it("breaks a long one occasionally, and a huge one rarely", () => {
    expect(share(V2, (y) => y >= 10)).toBeGreaterThan(0.07);
    expect(share(V2, (y) => y >= 10)).toBeLessThan(0.16);
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

    const after = perTeamGame(games(true, 40));
    expect(after).toBeGreaterThan(80);
    expect(after).toBeLessThan(140);
    // And strictly less than the model that could not be stopped.
    expect(after).toBeLessThan(perTeamGame(games(false, 40)));
  });
});
