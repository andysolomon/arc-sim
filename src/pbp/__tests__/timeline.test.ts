import { describe, expect, it } from "vitest";
import {
  simulateGameLog,
  playTimeline,
  seedFor,
  type PbpFeatureGates,
  type PbpGameLog,
  type PbpPlay,
  type PbpPlayType,
  type PlayerSimProfile,
  type TeamSimProfile,
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
    discipline: strength,
    coach: { aggression: 60 },
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

const V2: PbpFeatureGates = {
  scoringV2: true,
  penalties: true,
  situational: true,
  balance: true,
  weather: true,
  injuries: true,
  schemes: true,
};

function sim(label: string, features: PbpFeatureGates): PbpGameLog {
  return simulateGameLog({
    home: team("home", 74),
    away: team("away", 66),
    seed: seedFor("pbp", "timeline", label),
    features,
  });
}

function plays(log: PbpGameLog): PbpPlay[] {
  return log.drives.flatMap((d) => d.plays);
}

/**
 * The recorded gates, minus this one — dropped entirely when it was the only
 * gate on, because the engine records nothing rather than `{}` in that case.
 */
function stripGate(features: PbpFeatureGates | undefined) {
  if (!features) return undefined;
  const rest = Object.entries(features).filter(([key]) => key !== "timeline");
  return rest.length > 0 ? Object.fromEntries(rest) : undefined;
}

/** A log with everything the timeline gate adds removed again. */
function stripTimeline(log: PbpGameLog): PbpGameLog {
  return {
    ...log,
    features: stripGate(log.features),
    drives: log.drives.map((drive) => ({
      ...drive,
      plays: drive.plays.map((play) => {
        const { events, preSnap, ...rest } = play;
        return rest;
      }),
    })),
  };
}

describe("timeline gate", () => {
  it("changes nothing about the game it is enabled on", () => {
    /*
     * The property that matters most. `playTimeline` draws no randomness, so a
     * game simulated with the gate on must be the SAME game — every play, every
     * yard, the final score — with description added. Anything else would mean
     * a league could not turn rendering on mid-season without rewriting history.
     */
    for (let i = 0; i < 25; i++) {
      const label = `parity-${i}`;
      const without = sim(label, V2);
      const with_ = sim(label, { ...V2, timeline: true });
      expect(stripTimeline(with_)).toEqual(without);
    }
  });

  it("leaves a v1 log alone in both directions", () => {
    const v1 = sim("v1-parity", {});
    const v1Timeline = sim("v1-parity", { timeline: true });
    expect(stripTimeline(v1Timeline)).toEqual(v1);
    // No gate on means no gates recorded; the timeline gate is recorded because
    // a reader must be able to tell "no events" from "events not modelled".
    expect(v1.features).toBeUndefined();
    expect(v1Timeline.features).toEqual({ timeline: true });
  });

  it("writes nothing when the gate is off", () => {
    for (const play of plays(sim("gate-off", V2))) {
      expect(play.events).toBeUndefined();
      expect(play.preSnap).toBeUndefined();
    }
  });

  it("lays out every play in the log", () => {
    const log = sim("coverage", { ...V2, timeline: true });
    const all = plays(log);
    expect(all.length).toBeGreaterThan(50);
    for (const play of all) {
      expect(play.events).toBeDefined();
      expect(play.preSnap).toBeDefined();
    }
  });
});

describe("playTimeline", () => {
  const log = sim("events", { ...V2, timeline: true });
  const all = plays(log);

  it("is pure — same play in, same events out", () => {
    for (const play of all) {
      expect(playTimeline(play)).toEqual(play.events);
      expect(playTimeline(play)).toEqual(playTimeline(play));
    }
  });

  it("runs time forward and ends on a whistle", () => {
    for (const play of all) {
      const events = play.events!;
      if (play.playType === "timeout") {
        // A stoppage has nothing to show, and says so.
        expect(events).toEqual([]);
        continue;
      }
      expect(events.length).toBeGreaterThan(1);
      for (let i = 1; i < events.length; i++) {
        expect(events[i].t).toBeGreaterThanOrEqual(events[i - 1].t);
      }
      // A kickoff has no snap to anchor to — it opens with the kick itself.
      expect(events[0].t).toBeGreaterThanOrEqual(0);
      expect(events[events.length - 1].type).toBe("whistle");
      // Nothing takes a minute; the whistle defines the play's duration.
      expect(events[events.length - 1].t).toBeLessThan(20);
      // Exactly one whistle, and only at the end.
      expect(events.filter((e) => e.type === "whistle")).toHaveLength(1);
    }
  });

  it("keeps every spot on the field", () => {
    for (const play of all) {
      for (const event of play.events!) {
        if (event.spot === undefined) continue;
        expect(event.spot).toBeGreaterThanOrEqual(0);
        expect(event.spot).toBeLessThanOrEqual(100);
      }
    }
  });

  it("starts a scrimmage play at the line of scrimmage", () => {
    const fromScrimmage: PbpPlayType[] = [
      "rush",
      "pass_complete",
      "pass_incomplete",
      "sack",
      "interception",
      "punt",
      "field_goal",
      "field_goal_miss",
    ];
    const checked = all.filter((p) => fromScrimmage.includes(p.playType));
    expect(checked.length).toBeGreaterThan(30);
    for (const play of checked) {
      const snap = play.events![0];
      expect(snap.type).toBe("snap");
      expect(snap.spot).toBe(play.fieldPosition);
    }
  });

  it("ends a run or a catch where the play ended", () => {
    const carries = all.filter(
      (p) =>
        (p.playType === "rush" || p.playType === "pass_complete") &&
        !p.isTurnover &&
        !p.isScoring,
    );
    expect(carries.length).toBeGreaterThan(20);
    for (const play of carries) {
      const tackle = play.events!.find((e) => e.type === "tackle");
      // Capped at the 99: a rush can gain past the goal line without scoring,
      // and the engine spots that ball at the 99 rather than in the end zone.
      expect(tackle?.spot).toBe(
        Math.min(play.fieldPosition + play.yardsGained, 99),
      );
      // The engine named a tackler, so the timeline must attribute it.
      expect(tackle?.playerId).toBe(
        play.participants.find((p) => p.role === "tackler_solo")?.playerId,
      );
    }
  });

  it("puts every touchdown in the end zone", () => {
    const tds = all.filter((p) => p.isScoring && p.pointsScored === 6);
    expect(tds.length).toBeGreaterThan(0);
    for (const play of tds) {
      const td = play.events!.find((e) => e.type === "touchdown");
      expect(td).toBeDefined();
      expect(td!.spot).toBe(100);
      expect(td!.teamId).toBe(play.offenseTeamId);
    }
  });

  it("turns a pick around", () => {
    const picks = all.filter((p) => p.playType === "interception");
    expect(picks.length).toBeGreaterThan(0);
    for (const play of picks) {
      const events = play.events!;
      const caught = events.find((e) => e.type === "interception")!;
      const end = events.find(
        (e) => e.type === "tackle" || e.type === "touchdown",
      )!;
      expect(caught.teamId).toBe(play.defenseTeamId);
      // The defense runs back toward the offense's own goal line, so the ball
      // moves DOWN the field in the offense-relative frame.
      expect(end.spot!).toBeLessThanOrEqual(caught.spot!);
    }
  });

  it("flags the play a penalty happened on", () => {
    const flagged = all.filter((p) => p.penalty);
    expect(flagged.length).toBeGreaterThan(0);
    for (const play of flagged) {
      const flag = play.events!.find((e) => e.type === "flag");
      expect(flag).toBeDefined();
      expect(flag!.teamId).toBe(
        play.penalty!.onOffense ? play.offenseTeamId : play.defenseTeamId,
      );
      // Thrown during the play, never after the whistle.
      expect(flag!.t).toBeLessThan(play.events![play.events!.length - 1].t);
    }
  });

  it("holds up across every play type the engine emits", () => {
    /*
     * One game does not contain a safety, an onside kick or a two-point try.
     * A mismatched pair of aggressive coaches over many seeds does, and those
     * rare paths are exactly the ones a renderer would crash on in front of a
     * user rather than in CI.
     */
    const seen = new Set<PbpPlayType>();
    for (let i = 0; i < 60; i++) {
      const wide = simulateGameLog({
        home: team("home", 82),
        away: team("away", 54),
        seed: seedFor("pbp", "timeline", "sweep", String(i)),
        decisive: i % 3 === 0,
        features: { ...V2, timeline: true },
      });
      for (const play of plays(wide)) {
        seen.add(play.playType);
        const events = play.events!;
        if (play.playType === "timeout") {
          expect(events).toEqual([]);
          continue;
        }
        expect(events[events.length - 1].type).toBe("whistle");
        for (let e = 1; e < events.length; e++) {
          expect(events[e].t).toBeGreaterThanOrEqual(events[e - 1].t);
        }
        if (play.isScoring && play.pointsScored === 6) {
          expect(events.some((e) => e.type === "touchdown")).toBe(true);
        }
        if (play.injury) {
          expect(events.some((e) => e.type === "injury")).toBe(true);
        }
      }
    }

    // Everything the engine can emit except a standalone `penalty` play, which
    // it never does — flags attach to the play they happened on.
    for (const type of [
      "kickoff", "onside_kick", "rush", "pass_complete", "pass_incomplete",
      "sack", "interception", "punt", "field_goal", "field_goal_miss",
      "extra_point", "extra_point_miss", "two_point_convert", "two_point_fail",
      "safety", "kneel", "spike", "timeout",
    ] as PbpPlayType[]) {
      expect(seen.has(type), `${type} never simulated`).toBe(true);
    }
  });

  it("reads a stored play that has no events of its own", () => {
    // The renderer path for history: a v1 log, laid out on read years later.
    const stored = plays(sim("stored", {}));
    for (const play of stored) {
      const events = playTimeline(play);
      expect(Array.isArray(events)).toBe(true);
      if (play.playType !== "timeout") {
        expect(events[events.length - 1].type).toBe("whistle");
      }
    }
  });
});

describe("preSnap", () => {
  it("shows the score the play began at", () => {
    const log = sim("scoreboard", { ...V2, timeline: true });
    let home = 0;
    let away = 0;

    for (const play of plays(log)) {
      expect(play.preSnap).toEqual({
        homeScore: home,
        awayScore: away,
        homeTimeouts: play.preSnap!.homeTimeouts,
        awayTimeouts: play.preSnap!.awayTimeouts,
      });

      /*
       * A play wiped by a penalty stays in the log exactly as it happened —
       * `isScoring: true`, points and all — with the flag recording that it
       * did not count. Anything reconstructing a score has to skip it, and
       * this accumulator did not: a seed where a touchdown came back for
       * holding made it run six points ahead of `preSnap`, which was right.
       *
       * The third place in this repo to trip over the same footgun, after
       * `dist-check` and a throwaway validation script.
       */
      if (play.isScoring && play.pointsScored > 0 && !play.penalty?.negatesPlay) {
        if (play.offenseTeamId === log.homeTeamId) home += play.pointsScored;
        else away += play.pointsScored;
      }
      if (play.defensivePoints) {
        if (play.defenseTeamId === log.homeTeamId) home += play.defensivePoints;
        else away += play.defensivePoints;
      }
    }

    expect(home).toBe(log.homeScore);
    expect(away).toBe(log.awayScore);
  });

  it("reports timeouts only when clock management was modelled", () => {
    const withClock = plays(sim("timeouts-on", { situational: true, timeline: true }));
    for (const play of withClock) {
      expect(play.preSnap!.homeTimeouts).toBeGreaterThanOrEqual(0);
      expect(play.preSnap!.homeTimeouts).toBeLessThanOrEqual(3);
    }
    // Timeouts a team could never spend are unknown, not three.
    for (const play of plays(sim("timeouts-off", { timeline: true }))) {
      expect(play.preSnap!.homeTimeouts).toBeUndefined();
      expect(play.preSnap!.awayTimeouts).toBeUndefined();
    }
  });
});
