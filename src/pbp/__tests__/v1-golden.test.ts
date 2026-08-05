/*
 * Invariant 6: with every gate off, the engine reproduces the v1 logs
 * byte-for-byte.
 *
 * This is the load-bearing test of the whole gate design. Every v2 mechanic is
 * built on the promise that switching it off leaves existing leagues simulating
 * exactly as they did — and the only way a gate can break that promise silently
 * is by consuming a random draw it should not have, which shifts the PRNG
 * sequence and changes every play after it. No unit test of the mechanic itself
 * would notice; this one fails immediately.
 *
 * The fixture was captured from the v1 engine before any v2 work. Regenerate it
 * with `pnpm gen:golden` ONLY when a v1 behavior change is intended — the point
 * is that it is hard to change by accident.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { simulateGameLog } from "../../index.js";
import { GOLDEN_CASES, digest } from "./fixtures/v1-golden-cases.js";

type GoldenCase = {
  name: string;
  seed: number;
  decisive: boolean;
  flavor: string;
  homeStrength: number;
  awayStrength: number;
  homeScore: number;
  awayScore: number;
  driveCount: number;
  playCount: number;
  sha256: string;
  log?: unknown;
};

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "v1-golden-logs.json"), "utf8"),
) as { engineVersion: string; note: string; cases: GoldenCase[] };

describe("v1 golden logs", () => {
  it("covers the cases the fixture recorded", () => {
    // Guards the pairing itself: if someone adds a case to one side only, the
    // per-case assertions below would quietly stop checking it.
    expect(GOLDEN_CASES.map((c) => c.name)).toEqual(fixture.cases.map((c) => c.name));
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const [index, expected] of fixture.cases.entries()) {
    it(`reproduces ${expected.name} with every gate off`, () => {
      const log = simulateGameLog(GOLDEN_CASES[index].input);

      /*
       * Cheap assertions first, purely so a failure is readable. A hash
       * mismatch tells you nothing; "31-0 became 28-0" tells you where to look.
       */
      expect(log.homeScore).toBe(expected.homeScore);
      expect(log.awayScore).toBe(expected.awayScore);
      expect(log.drives.length).toBe(expected.driveCount);
      expect(log.drives.reduce((n, d) => n + d.plays.length, 0)).toBe(expected.playCount);

      // The real assertion — every field of every play, in order.
      expect(digest(log)).toBe(expected.sha256);
    });
  }

  it("deep-equals the one case that stored its full log", () => {
    // Only the first case carries its log (four would be ~470KB of JSON). It
    // exists so a regression has a readable diff instead of two hex strings.
    const stored = fixture.cases.findIndex((c) => c.log !== undefined);
    expect(stored).toBeGreaterThanOrEqual(0);
    expect(simulateGameLog(GOLDEN_CASES[stored].input)).toEqual(fixture.cases[stored].log);
  });

  it("still reproduces v1 when a v2 gate is switched on and off again", () => {
    /*
     * The failure mode this catches: a gate that draws randomness while
     * disabled. Simulating with gates on is expected to differ — what must not
     * differ is the same input with them off, run after the engine has been
     * asked to do something else entirely.
     */
    const input = GOLDEN_CASES[0].input;
    simulateGameLog({ ...input, features: { scoringV2: true, penalties: true, situational: true } });
    expect(digest(simulateGameLog(input))).toBe(fixture.cases[0].sha256);

    for (const gate of [
      "scoringV2",
      "penalties",
      "situational",
      "balance",
      "weather",
      "injuries",
      "schemes",
      "goalLineYards",
    ] as const) {
      // Explicitly false is the same claim as absent, and a gate that reads its
      // own flag wrongly would diverge here.
      const off = simulateGameLog({ ...input, features: { [gate]: false } });
      expect(digest(off)).toBe(fixture.cases[0].sha256);
    }
  });
});
