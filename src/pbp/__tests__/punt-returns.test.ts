/*
 * What happens to a punt after it lands.
 *
 * v1 gave every punt the same treatment — subtract 0-8 yards and spot the ball
 * — so a punt was the most predictable snap in the game: never fair caught,
 * never downed at the 3, never taken back. The `puntReturns` gate models the
 * part where the variance actually lives and leaves the kick itself alone.
 *
 * Distributions, not examples. A single punt tells you nothing about whether a
 * model is right; the shape over a thousand of them is the whole claim.
 */
import { describe, expect, it } from "vitest";
import {
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
  // On for BOTH sides of every comparison below. Without it a v1 punt records
  // no return at all, so the old model would read as "never returned" — which
  // flatters the new one by comparing it against a blank rather than against
  // what v1 actually did.
  returnStats: true,
};

function games(puntReturns: boolean, count = 60): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "punts", String(i)),
      features: { ...GATES, puntReturns },
    }),
  );
}

const punts = (logs: PbpGameLog[]): PbpPlay[] =>
  logs
    .flatMap((l) => l.drives.flatMap((d) => d.plays))
    .filter((p) => p.playType === "punt" && !p.penalty?.negatesPlay);

const V2 = punts(games(true));
const V1 = punts(games(false));

describe("the shape of a punt return", () => {
  it("has enough punts to say anything about", () => {
    expect(V2.length).toBeGreaterThan(200);
  });

  it("returns roughly half of them, and lets the rest die where they land", () => {
    /*
     * v1 returned essentially every punt, which is why its returns had to be
     * tiny to keep field position sane. Real football fair catches or downs
     * about as many as it brings back.
     */
    const returned = V2.filter((p) => (p.returnYards ?? 0) > 0).length;
    const rate = returned / V2.length;
    expect(rate).toBeGreaterThan(0.4);
    expect(rate).toBeLessThan(0.7);

    const v1Rate = V1.filter((p) => (p.returnYards ?? 0) > 0).length / V1.length;
    expect(v1Rate).toBeGreaterThan(0.85);
  });

  it("averages a plausible return, with most of them short", () => {
    const back = V2.map((p) => p.returnYards ?? 0).filter((y) => y > 0).sort((a, b) => a - b);
    const mean = back.reduce((a, b) => a + b, 0) / back.length;
    const median = back[Math.floor(back.length / 2)];

    // Real football sits near 8-9 yards a return.
    expect(mean).toBeGreaterThan(6);
    expect(mean).toBeLessThan(13);
    // Skewed, not flat: the typical return is well under the average.
    expect(median).toBeLessThan(mean);
  });

  it("keeps a long tail without living in it", () => {
    const back = V2.map((p) => p.returnYards ?? 0).filter((y) => y > 0);
    const long = back.filter((y) => y >= 30).length / back.length;
    expect(Math.max(...back)).toBeGreaterThan(30);
    // A steady drizzle of thirty-yard returns would be its own kind of wrong.
    expect(long).toBeLessThan(0.15);
  });

  it("occasionally takes one all the way", () => {
    const houseCalls = V2.filter((p) => p.isReturnTd);
    expect(houseCalls.length).toBeGreaterThan(0);
    // Rare — this is a highlight, not a play call.
    expect(houseCalls.length / V2.length).toBeLessThan(0.02);
    for (const td of houseCalls) {
      expect(td.defensivePoints).toBe(6);
      expect(td.isScoring).toBe(false); // The RETURNING team scored, not the offense.
    }
  });

  it("never returned one in v1", () => {
    // The thing the gate exists to add.
    expect(V1.some((p) => p.isReturnTd)).toBe(false);
  });
});

describe("where the ball ends up", () => {
  it("pins a team deep sometimes, which v1 could never do often", () => {
    const deep = (logs: PbpGameLog[]) =>
      logs.flatMap((l) => l.drives).filter((d) => d.startFieldPosition <= 5).length;
    expect(deep(games(true))).toBeGreaterThan(0);
  });

  it("keeps every drive it starts on the field", () => {
    for (const log of games(true)) {
      for (const drive of log.drives) {
        expect(drive.startFieldPosition).toBeGreaterThanOrEqual(1);
        expect(drive.startFieldPosition).toBeLessThanOrEqual(99);
      }
    }
  });

  it("never credits a return longer than the field left in front of him", () => {
    for (const punt of V2) {
      const caught = 100 - (punt.fieldPosition + punt.yardsGained + (punt.returnYards ?? 0));
      // Where he caught it, in his own frame, has to be a real yard line.
      expect(caught).toBeGreaterThanOrEqual(-1);
      expect(caught).toBeLessThanOrEqual(100);
      expect(punt.returnYards).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the score still adds up", () => {
  it("counts a return touchdown once, to the team that scored it", () => {
    /*
     * A punt return touchdown is the receiving team scoring on a play its
     * opponent ran, so it lands in `defensivePoints`. Getting that backwards
     * would award six points to the punting team, which no other test would
     * notice — the final score would still look like a football score.
     */
    for (const log of games(true)) {
      const counted = log.drives
        .flatMap((d) => d.plays)
        .filter((p) => !p.penalty?.negatesPlay);
      const scored = (teamId: string) =>
        counted.reduce(
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

  it("does not blow up scoring", () => {
    const points = (logs: PbpGameLog[]) =>
      logs.reduce((s, l) => s + l.homeScore + l.awayScore, 0) / logs.length;
    const withReturns = points(games(true));
    const without = points(games(false));
    // Return touchdowns are rare enough that the scoring band barely moves.
    expect(Math.abs(withReturns - without)).toBeLessThan(4);
  });
});

describe("the try after a defensive touchdown", () => {
  const withPat = (defensivePat: boolean) =>
    Array.from({ length: 120 }, (_, i) =>
      simulateGameLog({
        home: team("home", 72),
        away: team("away", 68),
        seed: seedFor("pbp", "pat", String(i)),
        features: { ...GATES, puntReturns: true, defensivePat },
      }),
    );

  /** Every defensive touchdown, paired with whatever play followed it. */
  function scoresAndNext(logs: PbpGameLog[]) {
    const out: Array<{ td: PbpPlay; next?: PbpPlay }> = [];
    for (const log of logs) {
      const kept = log.drives.flatMap((d) => d.plays).filter((p) => !p.penalty?.negatesPlay);
      kept.forEach((p, i) => {
        if ((p.defensivePoints ?? 0) === 6) out.push({ td: p, next: kept[i + 1] });
      });
    }
    return out;
  }

  it("was worth exactly six before, which football is not", () => {
    const scores = scoresAndNext(withPat(false));
    expect(scores.length).toBeGreaterThan(5);
    for (const { next } of scores) {
      expect(next?.playType).not.toMatch(/^extra_point/);
    }
  });

  it("now kicks the point, like every other touchdown", () => {
    const scores = scoresAndNext(withPat(true));
    expect(scores.length).toBeGreaterThan(5);
    for (const { next } of scores) {
      expect(next?.playType).toMatch(/^extra_point/);
    }
  });

  it("gives the point to the team that scored the touchdown", () => {
    /*
     * The easy thing to get backwards. `doExtraPoint` reads everything from
     * whoever has the ball, and after a defensive score that is the team which
     * just conceded — so a naive reuse hands the point to the wrong side and
     * the final score still looks like a football score.
     */
    for (const { td, next } of scoresAndNext(withPat(true))) {
      expect(next!.offenseTeamId).toBe(td.defenseTeamId);
      expect(next!.participants[0].teamId).toBe(td.defenseTeamId);
    }
  });

  it("keeps the scoreboard reconciled with the plays", () => {
    for (const log of withPat(true)) {
      const kept = log.drives.flatMap((d) => d.plays).filter((p) => !p.penalty?.negatesPlay);
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

  it("makes it nearly always, and misses sometimes", () => {
    const kicks = scoresAndNext(withPat(true)).map(({ next }) => next!.playType);
    const made = kicks.filter((t) => t === "extra_point").length;
    expect(made / kicks.length).toBeGreaterThan(0.85);
    expect(made / kicks.length).toBeLessThanOrEqual(1);
  });
});
