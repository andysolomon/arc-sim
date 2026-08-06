/*
 * Reading a stored log back.
 *
 * `gamePlayLogs` rows are immutable: a game simulated under engine 1.0.0 keeps
 * its 1.0.0 log forever, because the log is the evidence for the box score
 * derived from it at the time. So compatibility happens on read, and this is
 * the module every consumer goes through.
 *
 * Two contracts, and they pull against each other. It must be TOLERANT — a
 * corrupt row should degrade one game's Gamecast, not take down the page that
 * lists it — and it must not INVENT. A v1 log has no penalties because the v1
 * engine did not model them, not because there were none, and defaulting that
 * to zero turns "unknown" into a factual claim a record book will later repeat.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_FEATURES,
  logModels,
  normalizeGameLog,
  normalizedPlays,
  simulateGameLog,
  seedFor,
  V1_FEATURES,
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

const real = (features = ALL_FEATURES) =>
  simulateGameLog({
    home: team("home", 74),
    away: team("away", 66),
    seed: seedFor("pbp", "migrate"),
    features,
  });

describe("a corrupt row degrades one game, not the page", () => {
  const RUBBISH = [
    null,
    undefined,
    0,
    1,
    "",
    "not a log",
    true,
    false,
    NaN,
    [],
    [1, 2, 3],
    Symbol("x"),
  ];

  it("never throws, whatever it is handed", () => {
    for (const raw of RUBBISH) {
      expect(() => normalizeGameLog(raw), String(String(raw))).not.toThrow();
    }
  });

  it("yields an empty log that is still a valid one", () => {
    /*
     * The point of the fallback: a caller can render it. Returning a partial
     * object, or null, would push the same crash one layer up into a component
     * that has no idea the row was bad.
     */
    for (const raw of RUBBISH) {
      const log = normalizeGameLog(raw);
      expect(log.drives).toEqual([]);
      expect(log.homeScore).toBe(0);
      expect(log.awayScore).toBe(0);
      expect(typeof log.homeTeamId).toBe("string");
      expect(typeof log.seed).toBe("number");
      expect(normalizedPlays(log)).toEqual([]);
    }
  });

  it("survives corruption inside the drives, not just around them", () => {
    /*
     * The tolerance used to be exactly one level deep. `normalizeGameLog`
     * survived anything, then cast the drives array straight through — so a
     * single `null` drive threw a TypeError out of `normalizedPlays`, crashing
     * the page that lists games on precisely the corrupt row this module is
     * supposed to contain. The guarantee is worth nothing if a caller has to
     * wrap the call anyway.
     */
    const corrupt = [
      { drives: [null] },
      { drives: [1, 2] },
      { drives: ["nope"] },
      { drives: [{}] },
      { drives: [{ plays: null }] },
      { drives: [{ plays: "nope" }] },
      { drives: [{ plays: [null, 3, "x"] }] },
    ];
    for (const raw of corrupt) {
      const log = normalizeGameLog(raw);
      expect(() => normalizedPlays(log), JSON.stringify(raw)).not.toThrow();
      expect(normalizedPlays(log)).toEqual([]);
    }
  });

  it("turns a junk drive into an empty one rather than dropping it", () => {
    // The drive chart keeps its shape, so a gap is visible instead of quietly
    // closing up and making a 12-drive game look like an 11-drive game.
    const log = normalizeGameLog({ drives: [{ driveId: 4 }, { plays: [{ playId: 9 }] }] });
    expect(log.drives).toHaveLength(2);
    expect(log.drives[0].plays).toEqual([]);
    expect(normalizedPlays(log)).toHaveLength(1);
  });

  it("keeps whatever fields a half-written row does have", () => {
    // Partial is not the same as unusable: a row missing its drives can still
    // tell you who played and what the score was.
    const log = normalizeGameLog({ homeTeamId: "eagles", homeScore: 21 });
    expect(log.homeTeamId).toBe("eagles");
    expect(log.homeScore).toBe(21);
    expect(log.awayTeamId).toBe("");
    expect(log.drives).toEqual([]);
  });

  it("refuses fields of the wrong type rather than passing them through", () => {
    const log = normalizeGameLog({
      seed: "12345",
      homeScore: "21",
      homeTeamId: 7,
      drives: "lots",
      decisive: "yes",
    });
    expect(log.seed).toBe(0);
    expect(log.homeScore).toBe(0);
    expect(log.homeTeamId).toBe("");
    expect(log.drives).toEqual([]);
    // Only a real `true` is true — "yes" is not a boolean anyone stored on purpose.
    expect(log.decisive).toBe(false);
  });
});

describe("it does not invent what the engine did not model", () => {
  it("leaves a v1 log's v2 fields absent, not zero", () => {
    /*
     * The distinction the whole module exists to preserve. Zero penalties and
     * unknown penalties look identical once someone writes a 0, and a box score
     * has to be able to render "—".
     */
    const v1 = normalizeGameLog({
      seed: 1,
      homeTeamId: "a",
      awayTeamId: "b",
      drives: [
        {
          plays: [
            {
              playId: 1,
              playType: "rush",
              yardsGained: 4,
              isScoring: false,
              pointsScored: 0,
              isTurnover: false,
              participants: [],
            },
          ],
        },
      ],
    });
    const play = normalizedPlays(v1)[0];
    expect(play.penalty).toBeUndefined();
    expect(play.returnYards).toBeUndefined();
    expect(play.injury).toBeUndefined();
    expect(v1.features).toBeUndefined();
  });

  it("passes real drives through untouched", () => {
    // A v1 play already satisfies the current type, because every v2 addition
    // is optional. There is nothing to fill in, and filling anything in
    // would be a lie.
    const log = real();
    expect(normalizeGameLog(log).drives).toEqual(log.drives);
    expect(normalizedPlays(normalizeGameLog(log))).toEqual(
      log.drives.flatMap((d) => d.plays),
    );
  });

  it("reads an unrecognisable features blob as nothing modelled", () => {
    // The conservative direction: claiming a mechanic was off is safe, claiming
    // it was on is not.
    for (const features of ["all", 3, null, []]) {
      expect(normalizeGameLog({ features }).features).toBeUndefined();
    }
  });
});

describe("engineVersion and upconverted", () => {
  it("assumes the oldest engine when a row predates the field", () => {
    const log = normalizeGameLog({});
    expect(log.engineVersion).toBe("1.0.0");
    expect(log.upconverted).toBe(true);
  });

  it("reports a current log as current", () => {
    expect(normalizeGameLog({}, "2.0.0").upconverted).toBe(false);
    expect(normalizeGameLog({}, "2.0.0").engineVersion).toBe("2.0.0");
  });

  it("treats an unknown version as older, not as current", () => {
    // The safe reading: a version this build does not recognise gets the
    // conservative treatment rather than being assumed up to date.
    expect(normalizeGameLog({}, "3.0.0").upconverted).toBe(true);
  });
});

describe("logModels", () => {
  it("says no to everything for a log that recorded no gates", () => {
    const v1 = normalizeGameLog(real(V1_FEATURES));
    for (const mechanic of [
      "penalties",
      "safeties",
      "weather",
      "schemes",
      "timeline",
      "goalLineYards",
      "puntReturns",
      "defensivePat",
    ] as const) {
      expect(logModels(v1, mechanic), mechanic).toBe(false);
    }
  });

  it("says yes only to what the log actually recorded", () => {
    const log = normalizeGameLog(
      real({ ...V1_FEATURES, penalties: true, scoringV2: true }),
    );
    expect(logModels(log, "penalties")).toBe(true);
    expect(logModels(log, "safeties")).toBe(true); // rides on scoringV2
    expect(logModels(log, "weather")).toBe(false);
    expect(logModels(log, "puntReturns")).toBe(false);
  });

  it("answers from the gates, not from the engine version", () => {
    /*
     * The same build writes games with penalties on and games with them off,
     * depending on what the league had configured that week — so a version
     * number cannot answer this, and a league that adopts a mechanic mid-season
     * ends up with both in one season.
     */
    const modern = normalizeGameLog(real(V1_FEATURES), "2.0.0");
    expect(modern.engineVersion).toBe("2.0.0");
    expect(logModels(modern, "penalties")).toBe(false);
  });

  it("is safe to ask about a garbage row", () => {
    const broken = normalizeGameLog("nonsense");
    expect(logModels(broken, "penalties")).toBe(false);
  });
});

describe("normalizedPlays", () => {
  it("flattens the drives in order", () => {
    const log = normalizeGameLog(real());
    const plays = normalizedPlays(log);
    expect(plays.length).toBeGreaterThan(50);
    for (let i = 1; i < plays.length; i++) {
      expect(plays[i].playId).toBeGreaterThan(plays[i - 1].playId);
    }
  });
});
