/*
 * A sack is not a pass attempt.
 *
 * The reducer booked one as an attempt with the yards lost on the passing
 * line, which moved completion percentage on a play where no ball was thrown.
 * The varsity book — the NCAA statisticians' manual, which the NFHS follows —
 * charges it as a rushing attempt with the yardage lost and leaves the passing
 * line alone. `sackStats` books it that way.
 *
 * Reducer-only, and gated the way `returnStats` was: it replaces a wrong
 * non-zero number, so a league with published completion percentages opts
 * into having them change. The engine reads nothing from it, which the
 * inert test pins as byte-identical logs apart from the recorded gate.
 */
import { describe, expect, it } from "vitest";
import {
  RECOMMENDED_FEATURES,
  attributedPoints,
  deriveStatLines,
  logModels,
  normalizeGameLog,
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
      p("OL", strength - 3),
      p("DE", strength - 3),
      p("LB", strength - 2),
      p("CB", strength - 2),
      p("S", strength - 3),
      p("K", 70),
      p("P", 65),
    ],
  };
}

function games(features: PbpFeatureGates, count = 200): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "sack-stats", String(i)),
      features,
    }),
  );
}

const counted = (log: PbpGameLog): PbpPlay[] =>
  log.drives.flatMap((d) => d.plays).filter((p) => !p.penalty?.negatesPlay);
const sum = (log: PbpGameLog, group: string, field: string): number =>
  deriveStatLines(log).reduce((s, l) => {
    const g = (l.statLine as Record<string, Record<string, number> | undefined>)[group];
    return s + (g?.[field] ?? 0);
  }, 0);
const count = (log: PbpGameLog, type: PbpPlay["playType"]) =>
  counted(log).filter((p) => p.playType === type).length;
const yards = (log: PbpGameLog, type: PbpPlay["playType"]) =>
  counted(log).filter((p) => p.playType === type).reduce((s, p) => s + p.yardsGained, 0);

const ON = games(RECOMMENDED_FEATURES);
const OFF = games({ ...RECOMMENDED_FEATURES, sackStats: false });

describe("how a sack is booked", () => {
  it("has sacks to book", () => {
    expect(ON.reduce((s, l) => s + count(l, "sack"), 0)).toBeGreaterThan(500);
  });

  it("is not a pass attempt under the gate, and still is without it", () => {
    for (const log of ON) {
      const thrown =
        count(log, "pass_complete") + count(log, "pass_incomplete") + count(log, "interception");
      expect(sum(log, "passing", "att")).toBe(thrown);
      expect(sum(log, "passing", "sacked")).toBe(count(log, "sack"));
    }
    for (const log of OFF) {
      const thrown =
        count(log, "pass_complete") +
        count(log, "pass_incomplete") +
        count(log, "interception") +
        count(log, "sack");
      expect(sum(log, "passing", "att")).toBe(thrown);
    }
  });

  it("charges the yards lost as a carry, off the passing line", () => {
    for (const log of ON) {
      const carries = count(log, "rush") + count(log, "kneel") + count(log, "sack");
      expect(sum(log, "rushing", "carries")).toBe(carries);
      expect(sum(log, "rushing", "yards")).toBe(
        yards(log, "rush") + yards(log, "kneel") + yards(log, "sack"),
      );
      expect(sum(log, "passing", "yards")).toBe(yards(log, "pass_complete"));
    }
    for (const log of OFF) {
      expect(sum(log, "passing", "yards")).toBe(
        yards(log, "pass_complete") + yards(log, "sack"),
      );
      expect(sum(log, "rushing", "carries")).toBe(count(log, "rush") + count(log, "kneel"));
    }
  });

  it("charges the carry to the quarterback who was sacked", () => {
    const log = ON.find((l) => count(l, "sack") > 0)!;
    const sack = counted(log).find((p) => p.playType === "sack")!;
    const passer = sack.participants.find((x) => x.role === "passer")!;
    const line = deriveStatLines(log).find((l) => l.playerId === passer.playerId)!;
    expect(line.statLine.rushing?.carries).toBeGreaterThanOrEqual(1);
    expect(line.statLine.rushing?.yards).toBeLessThan(0);
    expect(line.statLine.passing?.sacked).toBeGreaterThanOrEqual(1);
  });

  it("raises completion percentage, which is the number that was wrong", () => {
    const pct = (logs: PbpGameLog[]) => {
      let comp = 0;
      let att = 0;
      for (const log of logs) {
        comp += sum(log, "passing", "comp");
        att += sum(log, "passing", "att");
      }
      return comp / att;
    };
    // Every sack was in the denominator before; about a tenth of dropbacks.
    expect(pct(ON)).toBeGreaterThan(pct(OFF) + 0.04);
  });

  it("still credits the sacker, and still counts the loss as a tackle for loss", () => {
    for (const log of ON) {
      expect(sum(log, "defense", "sacks")).toBe(count(log, "sack"));
    }
    expect(ON.reduce((s, l) => s + sum(l, "defense", "tfl"), 0)).toBeGreaterThan(0);
  });

  it("moves no point on the scoreboard", () => {
    for (const log of ON) {
      expect(attributedPoints(deriveStatLines(log))).toBe(log.homeScore + log.awayScore);
    }
  });
});

describe("the log", () => {
  it("is identical with the gate on or off, apart from recording it", () => {
    // Reducer-only: the engine reads nothing from the gate.
    for (const [i, on] of ON.entries()) {
      const { features: a, ...game } = on;
      const { features: b, ...same } = OFF[i];
      expect(game).toEqual(same);
      expect(a?.sackStats).toBe(true);
      expect(b?.sackStats).toBeUndefined();
    }
  });

  it("tells a reader which booking it carries", () => {
    expect(logModels(normalizeGameLog(ON[0], "2.0.0"), "sackStats")).toBe(true);
    expect(logModels(normalizeGameLog(OFF[0], "2.0.0"), "sackStats")).toBe(false);
  });

  it("books a stored log the old way, because that is the way it was published", () => {
    // A v1 log carries no gates, and its box score must not move under it.
    const stored = simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "sack-stats", "stored"),
    });
    const thrown =
      count(stored, "pass_complete") +
      count(stored, "pass_incomplete") +
      count(stored, "interception") +
      count(stored, "sack");
    expect(sum(stored, "passing", "att")).toBe(thrown);
  });
});
