/*
 * The kicking game.
 *
 * Every kick named a kicker or a punter as a participant and then read nothing
 * from him: make probability and punt distance came from team strength and the
 * matchup. A 40-overall kicker and a 99-overall kicker made field goals at the
 * same rate, and both made them at a professional rate in an engine whose
 * every other constant is varsity.
 *
 * Distributions, not examples — a kick is a coin, and the claim is about the
 * coin's weight over a few hundred games.
 */
import { describe, expect, it } from "vitest";
import { fourthDownDecision, inFieldGoalRange } from "../situational.js";
import {
  RECOMMENDED_FEATURES,
  simulateGameLog,
  seedFor,
  type PbpGameLog,
  type PbpPlay,
  type PlayerSimProfile,
  type TeamSimProfile,
} from "../../index.js";

function team(id: string, strength: number, kicker = 70, punter = 65): TeamSimProfile {
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
      p("K", kicker),
      p("P", punter),
    ],
  };
}

/*
 * 1200, not 150.
 *
 * Every claim below is about a distribution, and at 150 games two of them
 * were reading noise. The distance bands slice the home team's field goals
 * three ways, leaving the 40–50 band on about forty kicks; and the made-rate
 * gap this gate opens is about five points, which 180 kicks cannot resolve —
 * across seed-shifted replicas the same measurement came out anywhere from
 * 2 to 9. Neither bound was wrong; the sample was too small to test it, so
 * any later gate that shifts the PRNG stream resampled a passing figure into
 * a failing one that said nothing about kicking. Twelve hundred games cost
 * about a second, and the thresholds below stay exactly where they were.
 */
function games(
  kickingGame: boolean,
  { kicker = 70, punter = 65, count = 1200 } = {},
): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72, kicker, punter),
      away: team("away", 68),
      seed: seedFor("pbp", "kicking", String(i)),
      features: { ...RECOMMENDED_FEATURES, kickingGame },
    }),
  );
}

/** Every team's plays of these types, flags excluded. */
function allPlays(logs: PbpGameLog[], ...types: PbpPlay["playType"][]): PbpPlay[] {
  return logs
    .flatMap((l) => l.drives.flatMap((d) => d.plays))
    .filter((p) => types.includes(p.playType) && !p.penalty?.negatesPlay);
}

/** The home team's plays of these types, flags excluded. */
function homePlays(logs: PbpGameLog[], ...types: PbpPlay["playType"][]): PbpPlay[] {
  return logs
    .flatMap((l) => l.drives.flatMap((d) => d.plays))
    .filter(
      (p) =>
        p.offenseTeamId === "home" &&
        types.includes(p.playType) &&
        !p.penalty?.negatesPlay,
    );
}

const rate = (plays: PbpPlay[], made: PbpPlay["playType"]): number =>
  plays.filter((p) => p.playType === made).length / plays.length;

/** Attempt distance: the snap plus 17 yards of holder and end zone. */
const tryDistance = (p: PbpPlay): number => 100 - p.fieldPosition + 17;

const ON = games(true);
const OFF = games(false);

describe("a varsity field goal", () => {
  const fg = (logs: PbpGameLog[]) => homePlays(logs, "field_goal", "field_goal_miss");

  it("goes in less often than a professional one", () => {
    /*
     * Both teams, not just the home one. Every other test here varies the
     * home kicker's rating and has to read his kicks alone; this one asks
     * whether the GATE made the kicking worse, and both teams kick under it
     * with the same 70-rated leg. Pooling doubles the sample for free.
     */
    const kicks = (logs: PbpGameLog[]) => allPlays(logs, "field_goal", "field_goal_miss");
    const v1 = rate(kicks(OFF), "field_goal");
    const now = rate(kicks(ON), "field_goal");
    expect(v1).toBeGreaterThan(0.7);
    expect(now).toBeLessThan(v1 - 0.04);
    expect(now).toBeGreaterThan(0.5);
  });

  it("gets harder with distance, steeply", () => {
    const band = (lo: number, hi: number) =>
      fg(ON).filter((p) => tryDistance(p) >= lo && tryDistance(p) < hi);
    const short = rate(band(0, 30), "field_goal");
    const mid = rate(band(30, 40), "field_goal");
    const long = rate(band(40, 50), "field_goal");
    expect(short).toBeGreaterThan(0.8);
    expect(mid).toBeLessThan(short - 0.1);
    expect(long).toBeLessThan(mid - 0.1);
    expect(long).toBeLessThan(0.55);
  });

  it("is not attempted from where a high-school leg cannot reach", () => {
    // v1 sent everyone out from 52; a neutral leg is trusted to about 44.
    expect(Math.max(...fg(OFF).map(tryDistance))).toBeGreaterThanOrEqual(50);
    expect(Math.max(...fg(ON).map(tryDistance))).toBeLessThanOrEqual(45);
  });
});

describe("the kicker's rating", () => {
  const weak = games(true, { kicker: 40, punter: 40, count: 100 });
  const strong = games(true, { kicker: 95, punter: 95, count: 100 });

  it("decides how often the extra point goes through", () => {
    const xp = (logs: PbpGameLog[]) =>
      rate(homePlays(logs, "extra_point", "extra_point_miss"), "extra_point");
    expect(xp(weak)).toBeLessThan(xp(strong) - 0.05);
    // And the whole thing sits at a varsity rate, not an automatic one.
    expect(xp(ON)).toBeGreaterThan(0.84);
    expect(xp(ON)).toBeLessThan(0.93);
  });

  it("decides how far out the coach will send him", () => {
    const longest = (logs: PbpGameLog[]) =>
      Math.max(...homePlays(logs, "field_goal", "field_goal_miss").map(tryDistance));
    expect(longest(weak)).toBeLessThan(longest(strong) - 8);
  });

  it("did not matter before the gate", () => {
    const xp = (logs: PbpGameLog[]) =>
      rate(homePlays(logs, "extra_point", "extra_point_miss"), "extra_point");
    const weakV1 = games(false, { kicker: 40, count: 100 });
    const strongV1 = games(false, { kicker: 95, count: 100 });
    expect(Math.abs(xp(weakV1) - xp(strongV1))).toBeLessThan(0.03);
  });

  it("moves a kickoff a few yards, so a big leg produces touchbacks", () => {
    const touchbacks = (logs: PbpGameLog[]) => {
      const kicks = homePlays(logs, "kickoff");
      return kicks.filter((p) => p.returnYards === 0).length / kicks.length;
    };
    expect(touchbacks(weak)).toBeLessThan(0.06);
    expect(touchbacks(strong)).toBeGreaterThan(0.25);
  });
});

describe("a varsity punt", () => {
  // Net plus return is how far it actually travelled.
  const gross = (logs: PbpGameLog[]) => {
    const punts = homePlays(logs, "punt");
    return punts.reduce((n, p) => n + p.yardsGained + (p.returnYards ?? 0), 0) / punts.length;
  };

  it("travels about 35 yards, not a professional 44", () => {
    expect(gross(OFF)).toBeGreaterThan(39);
    expect(gross(ON)).toBeGreaterThan(33);
    expect(gross(ON)).toBeLessThan(38);
  });

  it("is the punter's leg", () => {
    const weak = games(true, { punter: 40, count: 80 });
    const strong = games(true, { punter: 95, count: 80 });
    expect(gross(strong)).toBeGreaterThan(gross(weak) + 6);
  });
});

describe("the fourth-down chart", () => {
  it("asks the kicker how far he can reach", () => {
    const base = {
      yardsToGo: 8,
      yardsToGoal: 30,
      scoreDiff: 0,
      quarter: 2,
      clockSeconds: 400,
      isOvertime: false,
      aggression: 50,
    };
    expect(fourthDownDecision(base)).toBe("field_goal");
    expect(fourthDownDecision({ ...base, fieldGoalRange: 25 })).toBe("punt");
    expect(inFieldGoalRange(30)).toBe(true);
    expect(inFieldGoalRange(30, 25)).toBe(false);
  });
});

describe("with the gate off", () => {
  it("is inert beside every other gate", () => {
    // Same draws, same game: the gate replaces thresholds, never adds a roll.
    for (const seed of ["a", "b", "c"]) {
      const input = {
        home: team("home", 72),
        away: team("away", 68),
        seed: seedFor("pbp", "kicking-inert", seed),
      };
      const off = simulateGameLog({ ...input, features: { ...RECOMMENDED_FEATURES, kickingGame: false } });
      const explicit = simulateGameLog({ ...input, features: RECOMMENDED_FEATURES });
      const on = simulateGameLog({ ...input, features: { ...RECOMMENDED_FEATURES, kickingGame: true } });
      expect(on).toEqual(explicit);
      expect(off).not.toEqual(on);
    }
  });
});
