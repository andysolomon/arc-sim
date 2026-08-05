import { describe, expect, it } from "vitest";
import {
  simulateGameLog,
  deriveStatLines,
  seedFor,
  type TeamSimProfile,
  type PlayerSimProfile,
} from "../../index.js";

function team(id: string, strength: number): TeamSimProfile {
  const p = (pid: string, position: string, overall: number): PlayerSimProfile => ({
    playerId: `${id}-${pid}`,
    position,
    overall,
  });
  return {
    teamId: id,
    strength,
    players: [
      p("qb", "QB", strength),
      p("rb", "RB", strength - 2),
      p("wr", "WR", strength - 1),
      p("te", "TE", strength - 4),
      p("de", "DE", strength - 3),
      p("lb", "LB", strength - 2),
      p("cb", "CB", strength - 2),
      p("s", "S", strength - 3),
      p("k", "K", 70),
      p("p", "P", 65),
    ],
  };
}

describe("simulateGameLog", () => {
  it("is deterministic for the same seed", () => {
    const input = {
      home: team("home", 70),
      away: team("away", 65),
      seed: seedFor("pbp", "determinism"),
    };
    const a = simulateGameLog(input);
    const b = simulateGameLog(input);
    expect(a).toEqual(b);
  });

  it("produces matching scores from scoring plays", () => {
    const log = simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "score-check"),
      features: { scoringV2: true, situational: true, balance: true },
    });

    let home = 0;
    let away = 0;
    for (const drive of log.drives) {
      for (const play of drive.plays) {
        if (play.isScoring && play.pointsScored > 0) {
          if (play.offenseTeamId === log.homeTeamId) home += play.pointsScored;
          else away += play.pointsScored;
        }
        if (play.defensivePoints && play.defensivePoints > 0) {
          if (play.defenseTeamId === log.homeTeamId) home += play.defensivePoints;
          else away += play.defensivePoints;
        }
      }
    }

    expect(log.homeScore).toBe(home);
    expect(log.awayScore).toBe(away);
  });

  it("never ties when decisive", () => {
    for (let i = 0; i < 20; i++) {
      const log = simulateGameLog({
        home: team("home", 70),
        away: team("away", 70),
        seed: seedFor("pbp", "decisive", String(i)),
        decisive: true,
      });
      expect(log.homeScore).not.toBe(log.awayScore);
    }
  });

  it("derives player stat lines from the log", () => {
    const log = simulateGameLog({
      home: team("home", 75),
      away: team("away", 60),
      seed: seedFor("pbp", "stats"),
      features: { scoringV2: true, situational: true },
    });
    const lines = deriveStatLines(log);
    expect(lines.length).toBeGreaterThan(0);
    const withPassing = lines.filter((l) => (l.statLine.passing?.att ?? 0) > 0);
    expect(withPassing.length).toBeGreaterThan(0);
  });
});

describe("goalLineYards gate", () => {
  const BASE = {
    scoringV2: true,
    penalties: true,
    situational: true,
    balance: true,
    schemes: true,
  };

  function carries(goalLineYards: boolean) {
    return Array.from({ length: 12 }, (_, i) =>
      simulateGameLog({
        home: team("home", 74),
        away: team("away", 66),
        seed: seedFor("pbp", "goal-line", String(i)),
        features: { ...BASE, goalLineYards },
      }),
    )
      .flatMap((log) => log.drives.flatMap((drive) => drive.plays))
      .filter((p) => p.playType === "rush" && !p.isScoring && !p.isTurnover);
  }

  it("credits a carry stopped at the goal line to the 99, not past it", () => {
    for (const play of carries(true)) {
      expect(play.fieldPosition + play.yardsGained).toBeLessThanOrEqual(99);
    }
  });

  it("stops awarding a first down for being stopped short", () => {
    /*
     * At goal-to-go the line to gain IS the goal line, so a carry that did not
     * score cannot have reached it. This is the half of the fix that changes
     * the game rather than the bookkeeping.
     */
    for (const play of carries(true)) {
      if (play.down > 0 && play.fieldPosition + play.distance >= 100) {
        expect(play.yardsGained).toBeLessThan(play.distance);
      }
    }
  });

  it("leaves the v1 behaviour alone when off", () => {
    // Also proves the sweep above actually exercises the path — a green test
    // over games where no carry ever reached the goal line would prove nothing.
    const overruns = carries(false).filter(
      (p) => p.fieldPosition + p.yardsGained > 99,
    );
    expect(overruns.length).toBeGreaterThan(0);
  });
});

describe("goalLineConversion gate", () => {
  const GATES = {
    scoringV2: true,
    penalties: true,
    situational: true,
    balance: true,
    schemes: true,
  };

  function games(goalLineConversion: boolean) {
    return Array.from({ length: 30 }, (_, i) =>
      simulateGameLog({
        home: team("home", 74),
        away: team("away", 66),
        seed: seedFor("pbp", "goal-line-conversion", String(i)),
        features: { ...GATES, goalLineConversion },
      }),
    );
  }

  /** Plays that reached the goal line, and how many of them scored. */
  function conversion(logs: ReturnType<typeof games>, playType: string) {
    let reached = 0;
    let scored = 0;
    for (const play of logs.flatMap((l) => l.drives.flatMap((d) => d.plays))) {
      if (play.playType !== playType || play.isTurnover) continue;
      if (play.isScoring) {
        reached++;
        scored++;
      } else if (play.fieldPosition + play.yardsGained >= 99) {
        reached++;
      }
    }
    return { reached, rate: scored / reached };
  }

  it("judges a run and a pass at the goal line by the same rule", () => {
    /*
     * The defect: v1 rolled a 2–15% chance of scoring on a carry and gave a
     * completion a touchdown for free. Both reach the goal line about equally
     * often, so answering differently is what buried the running game.
     */
    const logs = games(true);
    const rush = conversion(logs, "rush");
    const pass = conversion(logs, "pass_complete");

    expect(rush.reached).toBeGreaterThan(50);
    expect(pass.reached).toBeGreaterThan(50);
    // Not identical — the breakaway discount applies to different yardage
    // distributions — but the same order, which v1 was nowhere near.
    expect(Math.abs(rush.rate - pass.rate)).toBeLessThan(0.15);
  });

  it("stops a completion at the one instead of always scoring", () => {
    const stopped = games(true)
      .flatMap((l) => l.drives.flatMap((d) => d.plays))
      .filter(
        (p) =>
          p.playType === "pass_complete" &&
          !p.isScoring &&
          !p.isTurnover &&
          p.fieldPosition + p.yardsGained === 99,
      );
    // v1 could not produce this play at all.
    expect(stopped.length).toBeGreaterThan(0);
  });

  it("never credits a stopped play past the 99, on either path", () => {
    for (const play of games(true).flatMap((l) => l.drives.flatMap((d) => d.plays))) {
      if (play.isScoring || play.isTurnover) continue;
      if (play.playType !== "rush" && play.playType !== "pass_complete") continue;
      expect(play.fieldPosition + play.yardsGained).toBeLessThanOrEqual(99);
    }
  });

  it("leaves the lopsided v1 split in place when off", () => {
    // Pins the defect itself, so this test fails if someone "fixes" it
    // ungated — which would break v1 parity silently.
    const logs = games(false);
    expect(conversion(logs, "rush").rate).toBeLessThan(0.25);
    expect(conversion(logs, "pass_complete").rate).toBeGreaterThan(0.85);
  });
});
