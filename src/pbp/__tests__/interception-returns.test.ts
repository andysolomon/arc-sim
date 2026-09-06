/*
 * A pick return has a shape.
 *
 * v1 drew it flat — `rand() * 20`, every length from nothing to twenty equally
 * likely — which gets the mean about right and the shape entirely wrong: no
 * pile of short returns where the pursuit turned, no tail. Under
 * `interceptionReturns` it is a punt return's curve with a lower ceiling.
 *
 * Distributions, not examples, over a few thousand picks.
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

function games(features: PbpFeatureGates, count = 400): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "int-returns", String(i)),
      features,
    }),
  );
}

const picks = (logs: PbpGameLog[]): PbpPlay[] =>
  logs
    .flatMap((l) => l.drives.flatMap((d) => d.plays))
    .filter((p) => p.playType === "interception" && !p.penalty?.negatesPlay);

const ON_LOGS = games(RECOMMENDED_FEATURES);
const OFF_LOGS = games({ ...RECOMMENDED_FEATURES, interceptionReturns: false });
const ON = picks(ON_LOGS).map((p) => p.returnYards ?? 0);
const OFF = picks(OFF_LOGS).map((p) => p.returnYards ?? 0);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)];

describe("the shape of a pick return", () => {
  it("has enough of them to say anything about", () => {
    // About one a team a game.
    expect(ON.length).toBeGreaterThan(600);
    expect(OFF.length).toBeGreaterThan(600);
  });

  it("was flat before: the median sat on the mean and nothing was rare", () => {
    expect(Math.abs(quantile(OFF, 0.5) - mean(OFF))).toBeLessThan(1.5);
    expect(Math.max(...OFF)).toBeLessThanOrEqual(20);
    // A flat draw puts as many returns in the teens as under five.
    const teens = OFF.filter((y) => y >= 15).length;
    const short = OFF.filter((y) => y < 5).length;
    expect(teens / short).toBeGreaterThan(0.7);
  });

  it("is skewed now: most die short, a few get to the second level", () => {
    const median = quantile(ON, 0.5);
    expect(median).toBeLessThan(mean(ON) - 1.5);
    expect(mean(ON)).toBeGreaterThan(6);
    expect(mean(ON)).toBeLessThan(11);
    // The flat draw put more returns in the teens than under five; the curve
    // puts about six under five for every four in the teens.
    const teens = ON.filter((y) => y >= 15).length;
    const short = ON.filter((y) => y < 5).length;
    const flatTeens = OFF.filter((y) => y >= 15).length;
    const flatShort = OFF.filter((y) => y < 5).length;
    expect(teens / short).toBeLessThan(0.85);
    expect(teens / short).toBeLessThan((flatTeens / flatShort) * 0.7);
    // Zero is a length a pick can have; the flat draw had it too.
    expect(ON.some((y) => y === 0)).toBe(true);
  });

  it("has a lower ceiling than a punt return, and reaches it", () => {
    expect(Math.max(...ON)).toBeGreaterThan(20);
    expect(Math.max(...ON)).toBeLessThanOrEqual(26);
  });

  it("spends the same draw the flat one did", () => {
    // Same seeds, same number of picks: the curve replaces a roll rather
    // than adding one, so the sequence only differs in the yardage.
    expect(ON.length).toBeGreaterThan(OFF.length * 0.9);
    expect(ON.length).toBeLessThan(OFF.length * 1.1);
  });
});

describe("the box score", () => {
  it("credits the return the engine simulated, to the man who made it", () => {
    for (const log of ON_LOGS) {
      const simulated = picks([log]).reduce((s, p) => s + (p.returnYards ?? 0), 0);
      const credited = deriveStatLines(log).reduce(
        (s, l) => s + (l.statLine.defense?.intYards ?? 0),
        0,
      );
      expect(credited).toBe(simulated);
    }
  });
});

describe("with the gate off", () => {
  it("changes nothing, under any combination of the others", () => {
    const configurations: PbpFeatureGates[] = [
      {},
      { scoringV2: true },
      { scoringV2: true, passingGame: true, defensivePat: true },
      { scoringV2: true, injuries: true, matchups: true },
      { ...RECOMMENDED_FEATURES, interceptionReturns: false },
    ];
    for (const [c, features] of configurations.entries()) {
      for (let i = 0; i < 5; i++) {
        const input = {
          home: team("home", 72),
          away: team("away", 68),
          seed: seedFor("pbp", "int-returns", "inert", String(c), String(i)),
        };
        expect(
          simulateGameLog({ ...input, features: { ...features, interceptionReturns: false } }),
        ).toEqual(simulateGameLog({ ...input, features }));
      }
    }
  });
});
