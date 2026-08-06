/*
 * Log → box score.
 *
 * This is the half of the public API a consuming app actually renders, and it
 * had one shallow test. The golden fixture does not cover it either: that
 * hashes the log, so invariant 1's second clause — "and identical derived
 * stats" — was a claim nobody checked.
 *
 * Most of what follows is reconciliation rather than example-based assertion.
 * A box score is a reduction, so every total in it has a counterpart in the
 * plays it came from, and the interesting bugs are the ones where those two
 * numbers drift apart: a reception counted twice, a sack credited to the wrong
 * side, a wiped play still paying out.
 */
import { describe, expect, it } from "vitest";
import {
  deriveStatLines,
  simulateGameLog,
  seedFor,
  sumTeamStatGroup,
  type DerivedPlayerStatLine,
  type PbpGameLog,
  type PbpPlay,
  type PlayerSimProfile,
  type TeamSimProfile,
} from "../../index.js";
import { emptyLine, pruneLine } from "../derive-stats.js";

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

function game(label: string): PbpGameLog {
  return simulateGameLog({
    home: team("home", 76),
    away: team("away", 64),
    seed: seedFor("pbp", "derive", label),
    features: {
      scoringV2: true,
      penalties: true,
      situational: true,
      balance: true,
      injuries: true,
      schemes: true,
      goalLineYards: true,
      goalLineConversion: true,
    },
  });
}

/** Several games, so the rare play types are actually present. */
const LOGS = Array.from({ length: 10 }, (_, i) => game(String(i)));
const plays = (log: PbpGameLog): PbpPlay[] => log.drives.flatMap((d) => d.plays);
/** The plays that officially happened — a flag can erase one. */
const counted = (log: PbpGameLog) => plays(log).filter((p) => !p.penalty?.negatesPlay);

function total(
  lines: DerivedPlayerStatLine[],
  group: keyof DerivedPlayerStatLine["statLine"],
  field: string,
): number {
  return lines.reduce((sum, l) => {
    const g = l.statLine[group] as Record<string, number> | undefined;
    return sum + (g?.[field] ?? 0);
  }, 0);
}

describe("deriveStatLines reconciles with the log", () => {
  it("counts one completion per completed pass, and one attempt per throw", () => {
    for (const log of LOGS) {
      const lines = deriveStatLines(log);
      const thrown = counted(log).filter((p) =>
        ["pass_complete", "pass_incomplete", "sack", "interception"].includes(p.playType),
      );
      const completed = counted(log).filter((p) => p.playType === "pass_complete");
      expect(total(lines, "passing", "att")).toBe(thrown.length);
      expect(total(lines, "passing", "comp")).toBe(completed.length);
    }
  });

  it("gives every interception a thrower and a catcher", () => {
    // Two independent counters over the same event: if either drifts, the box
    // score contradicts itself in a way no single-sided test would show.
    for (const log of LOGS) {
      const lines = deriveStatLines(log);
      const picks = counted(log).filter((p) => p.playType === "interception");
      expect(total(lines, "passing", "int")).toBe(picks.length);
      expect(total(lines, "defense", "int")).toBe(picks.length);
    }
  });

  it("adds rushing yards up to what the rushes gained", () => {
    for (const log of LOGS) {
      const lines = deriveStatLines(log);
      const carries = counted(log).filter(
        (p) => p.playType === "rush" || p.playType === "kneel",
      );
      expect(total(lines, "rushing", "carries")).toBe(carries.length);
      expect(total(lines, "rushing", "yards")).toBe(
        carries.reduce((sum, p) => sum + p.yardsGained, 0),
      );
    }
  });

  it("adds receiving yards up to what the completions gained", () => {
    for (const log of LOGS) {
      const lines = deriveStatLines(log);
      const catches = counted(log).filter((p) => p.playType === "pass_complete");
      expect(total(lines, "receiving", "rec")).toBe(catches.length);
      expect(total(lines, "receiving", "yards")).toBe(
        catches.reduce((sum, p) => sum + p.yardsGained, 0),
      );
    }
  });

  it("counts every kick that was attempted, made or missed", () => {
    for (const log of LOGS) {
      const lines = deriveStatLines(log);
      const of = (...types: string[]) =>
        counted(log).filter((p) => types.includes(p.playType)).length;
      expect(total(lines, "kicking", "fgAtt")).toBe(of("field_goal", "field_goal_miss"));
      expect(total(lines, "kicking", "fgMade")).toBe(of("field_goal"));
      expect(total(lines, "kicking", "xpAtt")).toBe(of("extra_point", "extra_point_miss"));
      expect(total(lines, "kicking", "xpMade")).toBe(of("extra_point"));
      expect(total(lines, "punting", "punts")).toBe(of("punt"));
    }
  });

  it("matches touchdowns in the box score to touchdowns in the log", () => {
    /*
     * The reconciliation that matters most: scores are the one number a reader
     * will check by hand. A passing touchdown must appear once as the passer's
     * and once as the receiver's, and never on a play the engine did not score.
     */
    for (const log of LOGS) {
      const lines = deriveStatLines(log);
      const scoring = (type: string) =>
        counted(log).filter((p) => p.playType === type && p.isScoring).length;
      expect(total(lines, "passing", "td")).toBe(scoring("pass_complete"));
      expect(total(lines, "receiving", "td")).toBe(scoring("pass_complete"));
      expect(total(lines, "rushing", "td")).toBe(scoring("rush"));
    }
  });

  it("counts one kick return per kick returned", () => {
    /*
     * Counts only, deliberately. `prYards` is NOT asserted here because it is
     * not derivable from the log: the engine folds the punt return into the net
     * (`net = gross - rand()*8`) and never records it, so the reducer's
     * `net * 0.25` is a fabricated number roughly 2.5x the return that was
     * actually simulated. Pinning it would cement the invention as correct.
     */
    for (const log of LOGS) {
      const lines = deriveStatLines(log);
      const of = (type: string) => counted(log).filter((p) => p.playType === type).length;
      expect(total(lines, "returns", "krCount")).toBe(of("kickoff"));
      expect(total(lines, "returns", "prCount")).toBe(of("punt"));
    }
  });

  it("never credits a longest gain nobody actually had", () => {
    for (const log of LOGS) {
      const best = (type: string) =>
        Math.max(0, ...counted(log).filter((p) => p.playType === type).map((p) => p.yardsGained));
      for (const line of deriveStatLines(log)) {
        expect(line.statLine.rushing?.long ?? 0).toBeLessThanOrEqual(best("rush"));
        expect(line.statLine.receiving?.long ?? 0).toBeLessThanOrEqual(
          best("pass_complete"),
        );
      }
    }
  });
});

describe("a flag that erases a play erases the stats too", () => {
  it("credits nobody for a play that officially did not happen", () => {
    /*
     * The documented promise: a 40-yard run negated by holding must not appear
     * in a rushing total. The log keeps the play so a drive chart can show what
     * the flag erased, which is exactly why the reducer has to skip it.
     */
    const withFlags = LOGS.filter((log) =>
      plays(log).some((p) => p.penalty?.negatesPlay),
    );
    expect(withFlags.length).toBeGreaterThan(0);

    for (const log of withFlags) {
      const negated = plays(log).filter((p) => p.penalty?.negatesPlay);
      const derived = total(deriveStatLines(log), "rushing", "yards");

      // Deriving from a log with the wiped plays physically removed must give
      // the same answer as skipping them in place.
      const scrubbed: PbpGameLog = {
        ...log,
        drives: log.drives.map((d) => ({
          ...d,
          plays: d.plays.filter((p) => !p.penalty?.negatesPlay),
        })),
      };
      expect(derived).toBe(total(deriveStatLines(scrubbed), "rushing", "yards"));
      expect(negated.length).toBeGreaterThan(0);
    }
  });

  it("still counts a flag that did not wipe the play", () => {
    // Declined, or accepted without negating: the play stood, so the stats do.
    const log = LOGS.find((l) =>
      plays(l).some((p) => p.penalty && !p.penalty.negatesPlay && p.playType === "rush"),
    );
    if (!log) return;
    const kept = counted(log).filter((p) => p.playType === "rush" || p.playType === "kneel");
    expect(total(deriveStatLines(log), "rushing", "carries")).toBe(kept.length);
  });
});

describe("shape of the output", () => {
  it("is deterministic, which is half of invariant 1", () => {
    // The golden fixture hashes the log, not this. Same seed has to mean the
    // same box score too, or a record book built on it drifts.
    for (const label of ["a", "b", "c"]) {
      expect(deriveStatLines(game(label))).toEqual(deriveStatLines(game(label)));
    }
  });

  it("omits a group a player has no activity in", () => {
    /*
     * Honest absence again. A kicker carrying `rushing: { carries: 0, ... }`
     * invites a UI to render a rushing line for him; absent means absent.
     */
    for (const line of deriveStatLines(LOGS[0])) {
      for (const [group, values] of Object.entries(line.statLine)) {
        expect(
          Object.values(values as Record<string, number>).some((v) => v !== 0),
          `${line.playerId} has an all-zero ${group}`,
        ).toBe(true);
      }
      expect(Object.keys(line.statLine).length).toBeGreaterThan(0);
    }
  });

  it("prunes an untouched line to nothing at all", () => {
    expect(pruneLine(emptyLine())).toEqual({});
  });

  it("puts every player on the team he played for", () => {
    for (const log of LOGS) {
      const teams = new Map<string, string>();
      for (const play of counted(log)) {
        for (const p of play.participants) teams.set(p.playerId, p.teamId);
      }
      for (const line of deriveStatLines(log)) {
        expect(line.teamId).toBe(teams.get(line.playerId));
      }
    }
  });

  it("lists a player once, however many plays he was in", () => {
    for (const log of LOGS) {
      const ids = deriveStatLines(log).map((l) => l.playerId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("sumTeamStatGroup", () => {
  it("adds up one team's contribution and ignores the other's", () => {
    const log = LOGS[0];
    const lines = deriveStatLines(log);
    const home = sumTeamStatGroup(lines, log.homeTeamId, "rushing", "yards");
    const away = sumTeamStatGroup(lines, log.awayTeamId, "rushing", "yards");
    expect(home + away).toBe(total(lines, "rushing", "yards"));
    expect(home).not.toBe(0);
  });

  it("reads an absent group as nothing, not as a crash", () => {
    const lines = deriveStatLines(LOGS[0]);
    expect(sumTeamStatGroup(lines, "nobody", "passing", "yards")).toBe(0);
    expect(sumTeamStatGroup(lines, LOGS[0].homeTeamId, "passing", "notAField")).toBe(0);
  });
});
