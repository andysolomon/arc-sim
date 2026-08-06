/*
 * Rivalry identity.
 *
 * Small module, load-bearing property: the pair key is what the database
 * deduplicates rivalries on and what the engine looks a rivalry up by. If the
 * two ever disagreed about ordering, a declared rivalry would simply stop being
 * found at simulation time — no error, no missing row, just a game that quietly
 * plays as though the two teams had never met.
 */
import { describe, expect, it } from "vitest";
import {
  RIVALRY_INTENSITY_DEFAULT,
  RIVALRY_INTENSITY_MAX,
  RIVALRY_INTENSITY_MIN,
  normalizeIntensity,
  rivalryPairKey,
  sortRivalryTeams,
} from "../rivalries.js";

describe("rivalryPairKey", () => {
  it("does not care which team is named first", () => {
    // A rivalry is symmetric; the key has to be too, or home and away fixtures
    // between the same two teams land on different rows.
    expect(rivalryPairKey("eagles", "hawks")).toBe(rivalryPairKey("hawks", "eagles"));
  });

  it("keeps different pairings apart", () => {
    const keys = new Set([
      rivalryPairKey("a", "b"),
      rivalryPairKey("b", "c"),
      rivalryPairKey("a", "c"),
    ]);
    expect(keys.size).toBe(3);
  });

  it("agrees with the order sortRivalryTeams reports", () => {
    /*
     * The two are used together — one to store, one to display — so a caller
     * that renders `sortRivalryTeams` alongside a row found by `rivalryPairKey`
     * must not see them disagree.
     */
    for (const [a, b] of [
      ["hawks", "eagles"],
      ["eagles", "hawks"],
      ["Zebras", "aardvarks"],
    ]) {
      expect(rivalryPairKey(a, b)).toBe(sortRivalryTeams(a, b).join("|"));
    }
  });

  it("survives a team id that contains the separator", () => {
    /*
     * Not a hypothetical worth waving away: ids come from a host application,
     * and unescaped, `("a|b", "c")` and `("a", "b|c")` both key to `a|b|c` —
     * two different rivalries collapsing onto one row in a table that
     * deduplicates on this value.
     */
    expect(rivalryPairKey("a|b", "c")).not.toBe(rivalryPairKey("a", "b|c"));
  });

  it("did not change the key for any id that never had a separator", () => {
    /*
     * The escaping is only safe because it is a no-op for well-formed ids —
     * these keys are STORED, and a format change would orphan every existing
     * rivalry row rather than fix anything. Checked against the original
     * expression rather than against remembered output.
     */
    const original = (a: string, b: string) => [a, b].sort().join("|");
    const ids = ["eagles", "hawks", "j57x8k2mn4p", "Zebras", "team-1", "a.b", "x", ""];
    for (const a of ids) {
      for (const b of ids) {
        expect(rivalryPairKey(a, b), `${a} vs ${b}`).toBe(original(a, b));
      }
    }
  });
});

describe("normalizeIntensity", () => {
  it("never returns zero, because a zero rivalry is not one", () => {
    /*
     * A row that changes nothing is worse than no row: it looks configured.
     * Callers delete rather than zero, and the floor enforces that.
     */
    expect(normalizeIntensity(0)).toBe(RIVALRY_INTENSITY_MIN);
    expect(normalizeIntensity(-50)).toBe(RIVALRY_INTENSITY_MIN);
  });

  it("caps at the top of the range", () => {
    expect(normalizeIntensity(1000)).toBe(RIVALRY_INTENSITY_MAX);
  });

  it("rounds to a whole number", () => {
    expect(normalizeIntensity(61.4)).toBe(61);
    expect(normalizeIntensity(61.6)).toBe(62);
  });

  it("falls back to the default when handed something that is not a number", () => {
    // Honest absence again: NaN is not zero intensity, it is no answer, and
    // the neutral default is the only defensible reading.
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(normalizeIntensity(value)).toBe(RIVALRY_INTENSITY_DEFAULT);
    }
  });

  it("leaves an ordinary value alone", () => {
    expect(normalizeIntensity(60)).toBe(60);
    expect(normalizeIntensity(RIVALRY_INTENSITY_MIN)).toBe(RIVALRY_INTENSITY_MIN);
    expect(normalizeIntensity(RIVALRY_INTENSITY_MAX)).toBe(RIVALRY_INTENSITY_MAX);
  });
});
