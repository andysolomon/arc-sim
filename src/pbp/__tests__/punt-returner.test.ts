/*
 * Nobody is the returner on a punt nobody returned.
 *
 * `puntReturns` decides whether a punt was fair caught, touched back or downed,
 * and the play's `participants` were built before that decision ran — so 43%
 * of punts named a returner who never touched the ball. The box score had
 * already stopped counting him; this gate stops the log recording him, which
 * is what stops `applyAttrition` charging him a snap and letting him be the
 * one injured on a play he was not part of.
 *
 * The property, not the count. Six players in 600 games were hurt this way,
 * and a count that small is a coin flip under any later gate that shifts the
 * PRNG stream — see the notes at the top of `games()` in
 * `kicking-game.test.ts`. So the assertions are over a thousand games and say
 * "never", not "six".
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

/**
 * A roster with a receiver room, so the fatigue channel is live: a phantom
 * snap charged to the top receiver can change who `substitutionCandidate`
 * sends out on a later play, which a one-receiver roster can never show.
 */
function team(id: string, strength: number): TeamSimProfile {
  const p = (position: string, overall: number, depthRank?: number): PlayerSimProfile => ({
    playerId: `${id}-${position}${depthRank ?? ""}`,
    position,
    overall,
    ...(depthRank !== undefined ? { depthRank } : {}),
  });
  return {
    teamId: id,
    strength,
    discipline: strength,
    coach: { aggression: 62 },
    players: [
      p("QB", strength),
      p("RB", strength - 2, 1),
      p("RB", strength - 6, 2),
      p("WR", strength - 1, 1),
      p("WR", strength - 4, 2),
      p("WR", strength - 7, 3),
      p("WR", strength - 10, 4),
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

function games(
  features: PbpFeatureGates,
  { count, label }: { count: number; label: string },
): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "punt-returner", label, String(i)),
      features,
    }),
  );
}

const plays = (log: PbpGameLog): PbpPlay[] => log.drives.flatMap((d) => d.plays);
const punts = (log: PbpGameLog): PbpPlay[] =>
  plays(log).filter((p) => p.playType === "punt");
const returnerOn = (p: PbpPlay) => p.participants.find((x) => x.role === "returner");

/**
 * The log with `participants` removed from every play, so only outcomes
 * compare. The recorded gate set goes too — it is the one field that is
 * supposed to differ.
 */
function outcomesOnly(log: PbpGameLog): unknown {
  const { features, ...rest } = log;
  void features;
  return {
    ...rest,
    drives: log.drives.map((d) => ({
      ...d,
      plays: d.plays.map(({ participants, ...rest }) => {
        void participants;
        return rest;
      }),
    })),
  };
}

const QUIET = { ...RECOMMENDED_FEATURES, injuries: false };

describe("who is named on a punt", () => {
  const on = games(QUIET, { count: 1000, label: "named" });
  const off = games({ ...QUIET, puntReturner: false }, { count: 1000, label: "named" });

  it("has enough unreturned punts to say anything about", () => {
    const all = on.flatMap(punts);
    const unreturned = all.filter((p) => p.returnYards === 0);
    expect(all.length).toBeGreaterThan(5000);
    // Roughly four punts in ten are fair caught, downed or touched back.
    expect(unreturned.length / all.length).toBeGreaterThan(0.3);
    expect(unreturned.length / all.length).toBeLessThan(0.55);
  });

  it("names nobody the returner when nobody returned it", () => {
    for (const log of on) {
      for (const p of punts(log)) {
        if (p.returnYards === 0) expect(returnerOn(p)).toBeUndefined();
      }
    }
  });

  it("names exactly the men it named before when somebody did", () => {
    /*
     * With `injuries` off the two logs agree play for play, so each punt can
     * be paired with itself: same players, same order, when there was a
     * return to record.
     */
    for (const [i, log] of on.entries()) {
      const before = punts(off[i]);
      const after = punts(log);
      expect(after.length).toBe(before.length);
      for (const [j, p] of after.entries()) {
        if ((p.returnYards ?? 0) > 0) {
          expect(p.participants).toEqual(before[j].participants);
        } else {
          expect(p.participants).toEqual(
            before[j].participants.filter((x) => x.role !== "returner"),
          );
        }
      }
    }
  });

  it("still spends the draw on selecting him", () => {
    /*
     * The criterion that proves the selection was kept. Skipping it on an
     * unreturned punt would save a draw and shift every play after — turning
     * a change that touches who is written down into one that touches every
     * game. Stripped of `participants`, the logs are the same game.
     */
    for (const [i, log] of on.entries()) {
      expect(outcomesOnly(log)).toEqual(outcomesOnly(off[i]));
    }
  });

  it("leaves the box score exactly where the reducer already had it", () => {
    for (const [i, log] of on.entries()) {
      expect(deriveStatLines(log)).toEqual(deriveStatLines(off[i]));
      const returned = punts(log).filter(
        (p) => !p.penalty?.negatesPlay && (p.returnYards ?? 0) > 0,
      ).length;
      const credited = deriveStatLines(log).reduce(
        (sum, l) => sum + (l.statLine.returns?.prCount ?? 0),
        0,
      );
      expect(credited).toBe(returned);
    }
  });
});

describe("who gets hurt on a punt", () => {
  const on = games(RECOMMENDED_FEATURES, { count: 1000, label: "hurt" });

  it("never injures a man who was not on the play", () => {
    let onPunts = 0;
    for (const log of on) {
      for (const p of punts(log)) {
        if (!p.injury) continue;
        onPunts += 1;
        expect(p.participants.map((x) => x.playerId)).toContain(p.injury.playerId);
      }
    }
    expect(onPunts).toBeGreaterThan(0);
  });

  it("can only reach the punter on a punt nobody returned", () => {
    let unreturned = 0;
    for (const log of on) {
      for (const p of punts(log)) {
        if (!p.injury || p.returnYards !== 0) continue;
        unreturned += 1;
        const punter = p.participants.find((x) => x.role === "kicker");
        expect(p.injury.playerId).toBe(punter?.playerId);
        expect(p.injury.teamId).toBe(p.offenseTeamId);
      }
    }
    // Rare — about one every forty games — but the roll is still taken.
    expect(unreturned).toBeGreaterThan(0);
  });

  it("charges no snap to a receiver for a punt he watched", () => {
    /*
     * Read through the injury ledger's own consequence rather than the ledger,
     * which is internal: a receiver who is never named on a punt can never be
     * the one hurt on it. The same games without the gate DO hurt receivers
     * on unreturned punts, which is what this gate exists to stop.
     */
    const off = games(
      { ...RECOMMENDED_FEATURES, puntReturner: false },
      { count: 1000, label: "hurt" },
    );
    const receiversHurtWatching = (logs: PbpGameLog[]) =>
      logs
        .flatMap(punts)
        .filter((p) => p.injury && p.returnYards === 0 && p.injury.teamId === p.defenseTeamId)
        .length;
    expect(receiversHurtWatching(off)).toBeGreaterThan(0);
    expect(receiversHurtWatching(on)).toBe(0);
  });
});

describe("with the gate off", () => {
  it("changes nothing, under any combination of the others", () => {
    /*
     * The fullest configuration has `injuries` on, because that is the one
     * that would have caught this: the draw count is unchanged either way, so
     * only a comparison with the injury roll live can see the victim move.
     */
    const configurations: PbpFeatureGates[] = [
      {},
      { scoringV2: true },
      { scoringV2: true, puntReturns: true },
      { scoringV2: true, puntReturns: true, injuries: true },
      { ...RECOMMENDED_FEATURES, puntReturner: false },
    ];
    for (const [c, features] of configurations.entries()) {
      for (let i = 0; i < 5; i++) {
        const input = {
          home: team("home", 72),
          away: team("away", 68),
          seed: seedFor("pbp", "punt-returner", "inert", String(c), String(i)),
        };
        expect(
          simulateGameLog({ ...input, features: { ...features, puntReturner: false } }),
        ).toEqual(simulateGameLog({ ...input, features }));
      }
    }
  });

  it("is inert without puntReturns, which is the only place it is read", () => {
    // The log records the gate as on either way; only the game is compared.
    const sansFeatures = ({ features, ...rest }: PbpGameLog) => {
      void features;
      return rest;
    };
    for (let i = 0; i < 20; i++) {
      const input = {
        home: team("home", 72),
        away: team("away", 68),
        seed: seedFor("pbp", "punt-returner", "no-punt-returns", String(i)),
      };
      expect(
        sansFeatures(
          simulateGameLog({
            ...input,
            features: { scoringV2: true, returnStats: true, injuries: true, puntReturner: true },
          }),
        ),
      ).toEqual(
        sansFeatures(
          simulateGameLog({
            ...input,
            features: { scoringV2: true, returnStats: true, injuries: true },
          }),
        ),
      );
    }
  });
});

describe("what a renderer sees", () => {
  const drawn = games({ ...RECOMMENDED_FEATURES, timeline: true }, { count: 20, label: "timeline" });

  it("puts nobody under a punt nobody fielded", () => {
    const unreturned = drawn.flatMap(punts).filter((p) => p.returnYards === 0);
    expect(unreturned.length).toBeGreaterThan(20);
    for (const play of unreturned) {
      const result = play.events?.find((e) => e.type === "kick_result");
      expect(result).toBeDefined();
      expect(result!.playerId).toBeUndefined();
      // The ball is still dead where the next drive starts.
      expect(result!.spot).toBe(play.fieldPosition + play.yardsGained);
    }
  });
});
