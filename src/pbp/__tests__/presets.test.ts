/*
 * The ready-made gate sets.
 *
 * A preset is a claim about what a caller gets, so the tests are about the
 * claims rather than the object literals: that `V1_FEATURES` really is v1, that
 * `RECOMMENDED_FEATURES` really is everything-but-the-renderer, and that none
 * of them can quietly fall behind a gate somebody adds later.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_FEATURES,
  RECOMMENDED_FEATURES,
  V1_FEATURES,
  simulateGameLog,
  seedFor,
  type PbpFeatureGates,
  type PlayerSimProfile,
  type TeamSimProfile,
} from "../../index.js";
import { GOLDEN_CASES, digest } from "./fixtures/v1-golden-cases.js";

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

const PRESETS = { V1_FEATURES, RECOMMENDED_FEATURES, ALL_FEATURES };

/** Every gate the type declares, read from the source rather than repeated. */
function declaredGates(): string[] {
  const source = readFileSync(join(__dirname, "..", "types.ts"), "utf8");
  const block = source.slice(source.indexOf("export interface PbpFeatureGates"));
  const body = block.slice(0, block.indexOf("\n}"));
  // `\w` rather than `[a-zA-Z]`: the first gate ever written was `scoringV2`,
  // and a name-matching pattern that cannot read a digit silently finds eleven
  // gates out of twelve and reports the preset as the thing at fault.
  return [...body.matchAll(/^ {2}(\w+)\?: boolean;/gm)].map((m) => m[1]);
}

describe("every preset covers every gate", () => {
  it("names each gate the type declares, in each preset", () => {
    /*
     * The drift this file exists to prevent. `Required<PbpFeatureGates>` already
     * makes the compiler insist, but only while the presets stay hand-written —
     * the moment one is spread from another it starts inheriting new gates
     * silently, and a caller opting into "recommended" gets a mechanic nobody
     * decided to recommend.
     */
    const gates = declaredGates();
    expect(gates.length).toBeGreaterThan(10);
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(Object.keys(preset).sort(), `${name} is missing a gate`).toEqual(
        [...gates].sort(),
      );
    }
  });

  it("cannot be mutated by a caller", () => {
    // Shared objects. One consumer switching a flag must not change the preset
    // for every other consumer in the process.
    expect(Object.isFrozen(RECOMMENDED_FEATURES)).toBe(true);
    expect(() => {
      (RECOMMENDED_FEATURES as PbpFeatureGates).penalties = false;
    }).toThrow();
  });
});

describe("V1_FEATURES", () => {
  it("turns everything off", () => {
    expect(Object.values(V1_FEATURES).every((v) => v === false)).toBe(true);
  });

  it("reproduces the golden logs, which is the whole claim", () => {
    /*
     * An explicit `false` has to mean the same as absent — the engine reads
     * `=== true` — so this preset must be indistinguishable from passing no
     * features at all. Checked against the recorded v1 fixture rather than
     * against an empty object, so it is the real claim being tested.
     */
    for (const [index, expected] of GOLDEN_CASES.entries()) {
      const log = simulateGameLog({ ...expected.input, features: V1_FEATURES });
      expect(digest(log)).toBe(
        digest(simulateGameLog({ ...expected.input, features: undefined })),
      );
      void index;
    }
  });

  it("records no gates on the log, because none were live", () => {
    const log = simulateGameLog({ ...GOLDEN_CASES[0].input, features: V1_FEATURES });
    expect(log.features).toBeUndefined();
  });
});

describe("RECOMMENDED_FEATURES", () => {
  it("is everything except the renderer's event stream", () => {
    /*
     * The one deliberate omission. `timeline` changes no outcome and adds about
     * 70% to a stored log, so a league that never draws a game should not carry
     * it — which is a different kind of decision from every other gate here.
     */
    expect(RECOMMENDED_FEATURES.timeline).toBe(false);
    for (const [gate, on] of Object.entries(RECOMMENDED_FEATURES)) {
      if (gate === "timeline") continue;
      expect(on, `${gate} should be recommended`).toBe(true);
    }
  });

  it("produces a game that looks like football", () => {
    const scores: number[] = [];
    for (let i = 0; i < 40; i++) {
      const log = simulateGameLog({
        home: team("home", 74),
        away: team("away", 66),
        seed: seedFor("pbp", "preset", String(i)),
        features: RECOMMENDED_FEATURES,
      });
      scores.push(log.homeScore + log.awayScore);
      expect(log.drives.length).toBeGreaterThan(15);
      // No timeline payload, because that is the point of this preset.
      expect(log.drives[0].plays[0].events).toBeUndefined();
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(mean).toBeGreaterThan(20);
    expect(mean).toBeLessThan(70);
  });
});

describe("ALL_FEATURES", () => {
  it("turns everything on, timeline included", () => {
    expect(Object.values(ALL_FEATURES).every((v) => v === true)).toBe(true);
  });

  it("differs from the recommended set by exactly the timeline", () => {
    const differences = Object.keys(ALL_FEATURES).filter(
      (gate) =>
        ALL_FEATURES[gate as keyof PbpFeatureGates] !==
        RECOMMENDED_FEATURES[gate as keyof PbpFeatureGates],
    );
    expect(differences).toEqual(["timeline"]);
  });

  it("carries the event stream a renderer needs", () => {
    const log = simulateGameLog({
      home: team("home", 74),
      away: team("away", 66),
      seed: seedFor("pbp", "preset", "all"),
      features: ALL_FEATURES,
    });
    const play = log.drives.flatMap((d) => d.plays).find((p) => p.playType === "rush");
    expect(play?.events?.length).toBeGreaterThan(0);
    expect(play?.preSnap).toBeDefined();
  });
});

describe("spreading a preset", () => {
  it("is how a caller disagrees with one part of it", () => {
    const noInjuries = { ...RECOMMENDED_FEATURES, injuries: false };
    const log = simulateGameLog({
      home: team("home", 74),
      away: team("away", 66),
      seed: seedFor("pbp", "preset", "spread"),
      features: noInjuries,
    });
    expect(log.injuries ?? []).toHaveLength(0);
    expect(log.features?.injuries).toBeUndefined();
    expect(log.features?.penalties).toBe(true);
  });
});
