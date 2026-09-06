/*
 * Individual matchups: a target is thrown at a covered man, and a dropback is
 * blocked by somebody.
 *
 * The engine resolved a pass against the team edge and named the defenders
 * afterwards by position weight, so no rating on the field was read by
 * anything but the kicker's leg. Under `matchups` the man in coverage, the
 * pass rusher and the lineman on him are chosen first, and the outcome reads
 * the difference between them.
 *
 * Two properties, and they pull against each other, which is why both are
 * pinned. A mismatch produces more than a match does, in both directions —
 * a 90 receiver on a 60 corner is the explosive play, the reverse is the pick.
 * And a roster whose receivers and corners are rated ALIKE plays the game it
 * played before: the gate is a redistribution, not a scoring lever, and a
 * league that turns it on to see its corners matter must not silently get a
 * different scoring environment. Distributions over hundreds of games, because
 * one pass says nothing about either.
 */
import { describe, expect, it } from "vitest";
import {
  RECOMMENDED_FEATURES,
  deriveStatLines,
  simulateGameLog,
  seedFor,
  type PbpFeatureGates,
  type PbpGameLog,
  type PbpPlay,
  type PlayerSimProfile,
  type TeamSimProfile,
} from "../../index.js";

interface Talent {
  /** Receivers and tight end. */
  wr?: number;
  /** Corners and safeties. */
  db?: number;
  /** The line. Omit it entirely to field a roster with no linemen. */
  ol?: number | null;
  /** The front: ends, tackles, linebackers. */
  dl?: number;
}

/** A full two-deep, every group rated at the team unless `talent` says otherwise. */
function team(id: string, strength: number, talent: Talent = {}): TeamSimProfile {
  const p = (position: string, overall: number, depthRank: number): PlayerSimProfile => ({
    playerId: `${id}-${position}${depthRank}`,
    position,
    overall,
    depthRank,
  });
  const wr = talent.wr ?? strength;
  const db = talent.db ?? strength;
  const dl = talent.dl ?? strength;
  const ol = talent.ol === undefined ? strength : talent.ol;
  const line = ol === null ? [] : [1, 2, 3, 4, 5].map((i) => p("OL", ol - (i > 3 ? 3 : 0), i));
  return {
    teamId: id,
    strength,
    discipline: strength,
    coach: { aggression: 62 },
    players: [
      p("QB", strength, 1),
      p("RB", strength, 1),
      p("RB", strength - 3, 2),
      p("WR", wr, 1),
      p("WR", wr, 2),
      p("WR", wr - 3, 3),
      p("TE", wr - 3, 1),
      ...line,
      p("DE", dl, 1),
      p("DE", dl, 2),
      p("DT", dl - 3, 1),
      p("LB", dl, 1),
      p("LB", dl - 3, 2),
      p("CB", db, 1),
      p("CB", db, 2),
      p("S", db - 3, 1),
      p("S", db - 3, 2),
      p("K", 70, 1),
      p("P", 65, 1),
    ],
  };
}

function games(
  label: string,
  features: PbpFeatureGates,
  { count = 300, home = team("home", 70), away = team("away", 70) } = {},
): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home,
      away,
      seed: seedFor("pbp", "matchups", label, String(i)),
      features,
    }),
  );
}

const plays = (logs: PbpGameLog[]): PbpPlay[] =>
  logs.flatMap((l) => l.drives.flatMap((d) => d.plays)).filter((p) => !p.penalty?.negatesPlay);
const dropbacks = (logs: PbpGameLog[]) =>
  plays(logs).filter((p) =>
    ["pass_complete", "pass_incomplete", "interception", "sack"].includes(p.playType),
  );
const role = (p: PbpPlay, r: string) => p.participants.find((x) => x.role === r);

/** The rates the gate is allowed to move, per dropback and per game. */
function rates(logs: PbpGameLog[], side?: string) {
  const all = dropbacks(logs).filter((p) => !side || p.offenseTeamId === side);
  const thrown = all.filter((p) => p.playType !== "sack");
  const complete = all.filter((p) => p.playType === "pass_complete");
  const n = logs.length * (side ? 1 : 2);
  return {
    completion: complete.length / thrown.length,
    explosive: complete.filter((p) => p.yardsGained >= 15).length / complete.length,
    interception: all.filter((p) => p.playType === "interception").length / thrown.length,
    sack: all.filter((p) => p.playType === "sack").length / all.length,
    passYards: complete.reduce((s, p) => s + p.yardsGained, 0) / n,
    points: logs.reduce((s, l) => s + l.homeScore + l.awayScore, 0) / logs.length,
  };
}

const OFF = { ...RECOMMENDED_FEATURES, matchups: false };

describe("who is named on a dropback", () => {
  const on = games("named", RECOMMENDED_FEATURES, { count: 40 });

  it("names the man in coverage, the rusher and his blocker on every one", () => {
    const all = dropbacks(on);
    expect(all.length).toBeGreaterThan(1000);
    for (const p of all) {
      const cover = role(p, "coverage");
      const rusher = role(p, "pass_rusher");
      const blocker = role(p, "blocker");
      expect(cover?.teamId).toBe(p.defenseTeamId);
      expect(rusher?.teamId).toBe(p.defenseTeamId);
      expect(blocker?.teamId).toBe(p.offenseTeamId);
      expect(blocker?.playerId).toMatch(/-OL\d$/);
    }
  });

  it("gives the sack to the man who was coming and the pick to the man in coverage", () => {
    let sacks = 0;
    let picks = 0;
    let breakups = 0;
    for (const p of dropbacks(on)) {
      if (p.playType === "sack") {
        sacks += 1;
        expect(role(p, "sacker")?.playerId).toBe(role(p, "pass_rusher")?.playerId);
      }
      if (p.playType === "interception") {
        picks += 1;
        expect(role(p, "interceptor")?.playerId).toBe(role(p, "coverage")?.playerId);
      }
      const pd = role(p, "pass_defender");
      if (pd) {
        breakups += 1;
        expect(pd.playerId).toBe(role(p, "coverage")?.playerId);
      }
    }
    expect(sacks).toBeGreaterThan(50);
    expect(picks).toBeGreaterThan(20);
    expect(breakups).toBeGreaterThan(20);
  });

  it("names no blocker for a roster that carries no line, and reads it as neutral", () => {
    /*
     * A roster with no offensive line has not fielded a bad one; it has said
     * nothing. The stand-in `selectPlayer` invents for an empty group must not
     * be named on the play or read against the rusher.
     */
    const bare = games("no-line", RECOMMENDED_FEATURES, {
      count: 200,
      home: team("home", 70, { ol: null }),
      away: team("away", 70, { ol: null }),
    });
    for (const p of dropbacks(bare)) {
      expect(role(p, "blocker")).toBeUndefined();
      // The stand-in has always been allowed to PLAY — a one-quarterback
      // roster whose quarterback is hurt still snaps the ball — but the
      // matchup roles are the ones that read a rating, and they name nobody.
      for (const r of ["coverage", "pass_rusher", "blocker"]) {
        expect(role(p, r)?.playerId ?? "").not.toContain("-unknown-");
      }
    }
    const lined = games("no-line", RECOMMENDED_FEATURES, { count: 200 });
    expect(Math.abs(rates(bare).sack - rates(lined).sack)).toBeLessThan(0.015);
  });

  it("credits none of the three with a statistic", () => {
    /*
     * They say who played, not what he did. A lineman who blocked all game and
     * a corner who covered all game and touched nothing have no line at all —
     * the honest-absence rule the box score already follows.
     */
    for (const log of on.slice(0, 10)) {
      const credited = new Set(deriveStatLines(log).map((l) => l.playerId));
      const outcomeRoles = new Set(
        plays([log]).flatMap((p) =>
          p.participants
            .filter((x) => !["coverage", "pass_rusher", "blocker"].includes(x.role))
            .map((x) => x.playerId),
        ),
      );
      for (const id of credited) expect(outcomeRoles.has(id)).toBe(true);
    }
  });
});

describe("a mismatch produces more than a match does", () => {
  /*
   * Same team strength on both sides, so the team edge is zero and the only
   * thing that differs between the three leagues is who is on whom. The home
   * side is the one measured; the away side is rated flat.
   */
  const even = rates(games("even", RECOMMENDED_FEATURES), "home");
  const receiversWin = rates(
    games("receivers", RECOMMENDED_FEATURES, {
      home: team("home", 70, { wr: 90 }),
      away: team("away", 70, { db: 60 }),
    }),
    "home",
  );
  const cornersWin = rates(
    games("corners", RECOMMENDED_FEATURES, {
      home: team("home", 70, { wr: 60 }),
      away: team("away", 70, { db: 90 }),
    }),
    "home",
  );

  it("completes more to a receiver who has the corner beaten, and less the other way", () => {
    expect(receiversWin.completion).toBeGreaterThan(even.completion + 0.03);
    expect(cornersWin.completion).toBeLessThan(even.completion - 0.03);
  });

  it("concentrates the explosive plays on the mismatch", () => {
    expect(receiversWin.explosive).toBeGreaterThan(even.explosive + 0.05);
    expect(cornersWin.explosive).toBeLessThan(even.explosive - 0.05);
  });

  it("throws the pick to the corner who has the receiver beaten", () => {
    expect(cornersWin.interception).toBeGreaterThan(even.interception * 1.15);
    expect(receiversWin.interception).toBeLessThan(even.interception * 0.85);
  });

  it("gets the rusher home more often against a lineman he has beaten", () => {
    const rushWins = rates(
      games("rush", RECOMMENDED_FEATURES, {
        home: team("home", 70, { ol: 60 }),
        away: team("away", 70, { dl: 90 }),
      }),
      "home",
    );
    const lineWins = rates(
      games("line", RECOMMENDED_FEATURES, {
        home: team("home", 70, { ol: 90 }),
        away: team("away", 70, { dl: 60 }),
      }),
      "home",
    );
    expect(rushWins.sack).toBeGreaterThan(even.sack * 1.2);
    expect(lineWins.sack).toBeLessThan(even.sack * 0.8);
  });

  it("does not read a rating with the gate off", () => {
    // The same mismatched rosters, the gate off: the outcomes cannot tell the
    // two leagues apart, because nothing reads the men.
    const a = rates(
      games("blind", OFF, { home: team("home", 70, { wr: 90 }), away: team("away", 70, { db: 60 }) }),
      "home",
    );
    const b = rates(
      games("blind", OFF, { home: team("home", 70, { wr: 60 }), away: team("away", 70, { db: 90 }) }),
      "home",
    );
    // Identical seeds and identical strengths draw the identical game; only the
    // player ids differ, and no rate is derived from those.
    expect(a).toEqual(b);
  });
});

describe("a matchup of equals plays the game the team edge already priced", () => {
  /*
   * The property that keeps this a fidelity gate rather than a balance one.
   * With every group rated at the team, the mean mismatch over a season is
   * zero and every rate should sit where it sat — within the noise of
   * different draws, which is what the tolerances are sized to. If this fails
   * the gate has grown a scoring lever, and that is a tuning question this
   * repo has closed.
   */
  const on = rates(games("balanced", RECOMMENDED_FEATURES, { count: 500 }));
  const off = rates(games("balanced", OFF, { count: 500 }));

  it("leaves the completion rate, the explosive rate and the picks where they were", () => {
    expect(Math.abs(on.completion - off.completion)).toBeLessThan(0.015);
    expect(Math.abs(on.explosive - off.explosive)).toBeLessThan(0.03);
    expect(Math.abs(on.interception - off.interception)).toBeLessThan(0.01);
  });

  it("leaves the sack rate where it was", () => {
    expect(Math.abs(on.sack - off.sack)).toBeLessThan(0.01);
  });

  it("does not move the scoreboard", () => {
    expect(Math.abs(on.passYards - off.passYards)).toBeLessThan(6);
    expect(Math.abs(on.points - off.points)).toBeLessThan(2);
  });
});

describe("with the gate off", () => {
  it("changes nothing, under any combination of the others", () => {
    const configurations: PbpFeatureGates[] = [
      {},
      { scoringV2: true },
      { scoringV2: true, passingGame: true },
      { scoringV2: true, injuries: true, passingGame: true, schemes: true },
      { ...RECOMMENDED_FEATURES, matchups: false },
    ];
    for (const [c, features] of configurations.entries()) {
      for (let i = 0; i < 5; i++) {
        const input = {
          home: team("home", 72, { wr: 85, db: 60 }),
          away: team("away", 68),
          seed: seedFor("pbp", "matchups", "inert", String(c), String(i)),
        };
        expect(
          simulateGameLog({ ...input, features: { ...features, matchups: false } }),
        ).toEqual(simulateGameLog({ ...input, features }));
      }
    }
  });
});
