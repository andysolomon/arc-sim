/*
 * Jersey numbers.
 *
 * Pure, so it is tested in Node like the rest of the layer that decides what a
 * play looks like. The property that matters is stability: the same slot wears
 * the same number every time, forever, because a number that changed between
 * viewings of one recorded game is the sort of detail nobody articulates and
 * everybody notices.
 */
import { describe, expect, it } from "vitest";
import { jerseyNumber } from "../jersey.js";
import { OFFENSE_FORMATIONS, DEFENSE_FORMATIONS } from "../formations.js";

const ALL_LABELS = [
  ...Object.values(OFFENSE_FORMATIONS).flatMap((slots) => slots.map((s) => s.label)),
  ...Object.values(DEFENSE_FORMATIONS).flatMap((slots) => slots.map((s) => s.label)),
];

describe("jerseyNumber", () => {
  it("gives the same slot the same number, every time", () => {
    for (const label of ALL_LABELS) {
      expect(jerseyNumber(label)).toBe(jerseyNumber(label));
    }
  });

  it("puts every number on a jersey that could exist", () => {
    // 0-99, and never a fraction — a player wearing 43.7 is a rendering bug
    // that would only ever be seen at the hero tier and never reported.
    for (const label of ALL_LABELS) {
      const n = jerseyNumber(label);
      expect(Number.isInteger(n), label).toBe(true);
      expect(n, label).toBeGreaterThanOrEqual(0);
      expect(n, label).toBeLessThanOrEqual(99);
    }
  });

  it("dresses each position in the range football uses", () => {
    /*
     * A lineman wearing 7 reads as wrong even to someone who could not quote
     * the rule, which is the whole reason this is a table rather than a hash
     * over the whole range.
     */
    expect(jerseyNumber("QB")).toBeLessThanOrEqual(19);
    expect(jerseyNumber("K")).toBeLessThanOrEqual(19);
    expect(jerseyNumber("P")).toBeLessThanOrEqual(19);
    for (const wr of ["WR1", "WR2", "WR3", "TE1"]) {
      expect(jerseyNumber(wr), wr).toBeGreaterThanOrEqual(80);
    }
    for (const line of ["C", "G1", "G2", "T1", "T2"]) {
      expect(jerseyNumber(line), line).toBeGreaterThanOrEqual(50);
      expect(jerseyNumber(line), line).toBeLessThanOrEqual(79);
    }
    for (const back of ["CB1", "CB2", "S1", "S2"]) {
      expect(jerseyNumber(back), back).toBeGreaterThanOrEqual(20);
      expect(jerseyNumber(back), back).toBeLessThanOrEqual(39);
    }
  });

  it("reads the longer prefix when two could match", () => {
    // MLB is a linebacker, not a middle-something-else, and OLB is not "O".
    expect(jerseyNumber("MLB1")).toBeGreaterThanOrEqual(50);
    expect(jerseyNumber("MLB1")).toBeLessThanOrEqual(59);
    expect(jerseyNumber("OLB1")).toBeGreaterThanOrEqual(40);
    expect(jerseyNumber("OLB1")).toBeLessThanOrEqual(59);
  });

  it("still dresses a slot it has never heard of", () => {
    // Kickoff coverage slots are not positions. They still need a number, and
    // an unrecognised label must not produce NaN on somebody's back.
    for (const odd of ["ZZ9", "", "coverage-3", "??"]) {
      const n = jerseyNumber(odd);
      expect(Number.isInteger(n), odd).toBe(true);
      expect(n, odd).toBeGreaterThanOrEqual(0);
      expect(n, odd).toBeLessThanOrEqual(99);
    }
  });

  it("mostly avoids putting two players in the same number", () => {
    /*
     * Not guaranteed — the numbers are hashed into position ranges rather than
     * assigned by a registry — but a formation where half the line wears 62
     * would look broken up close. Checked per formation, which is the group a
     * viewer ever sees at once.
     */
    for (const [name, slots] of Object.entries(OFFENSE_FORMATIONS)) {
      const numbers = slots.map((s) => jerseyNumber(s.label));
      const distinct = new Set(numbers).size;
      expect(distinct, `${name}: ${numbers.join(",")}`).toBeGreaterThanOrEqual(
        slots.length - 2,
      );
    }
  });
});
