/*
 * Injuries.
 *
 * The module takes its random draws as an argument rather than drawing them,
 * and that is the whole design: the engine shares one PRNG sequence, so a
 * mechanic that quietly consumed a variable number of values would make every
 * later play depend on whether somebody got hurt. Two draws per roll, always,
 * injured or not — which also makes the thing testable without a PRNG at all.
 *
 * So these are exact tests, not distribution tests. The draws are chosen, and
 * the outcome is a function of them.
 */
import { describe, expect, it } from "vitest";
import {
  INJURY_TABLE,
  contactFactor,
  isAvailable,
  projectedReturnWeek,
  rollInjury,
  type InjurySeverity,
} from "../injuries.js";
import type { PbpPlayType } from "../types.js";

/** A roll that always injures, paired with a chosen severity draw. */
const hurt = (severityRoll: number) => [0, severityRoll] as const;

function roll(
  playType: PbpPlayType,
  stamina: number,
  severityScale: number,
  rolls: readonly [number, number],
) {
  return rollInjury({ playType, stamina, severityScale, rolls });
}

describe("contactFactor", () => {
  it("scales with how violent the play is", () => {
    // A sack is the most dangerous snap in football; a kneel is barely a play.
    expect(contactFactor("sack")).toBeGreaterThan(contactFactor("rush"));
    expect(contactFactor("rush")).toBeGreaterThan(contactFactor("pass_complete"));
    expect(contactFactor("pass_complete")).toBeGreaterThan(
      contactFactor("pass_incomplete"),
    );
    expect(contactFactor("kneel")).toBeLessThan(contactFactor("field_goal"));
  });

  it("returns zero for a play with no snap to be hurt on", () => {
    /*
     * Absent from the table means zero, not "average". A timeout that could
     * injure somebody would be a genuinely baffling line in a Gamecast.
     */
    for (const playType of ["timeout", "penalty", "safety"] as PbpPlayType[]) {
      expect(contactFactor(playType)).toBe(0);
    }
  });
});

describe("rollInjury", () => {
  it("is a pure function of the draws it was handed", () => {
    const input = {
      playType: "rush" as PbpPlayType,
      stamina: 0.4,
      severityScale: 1,
      rolls: [0.001, 0.5] as const,
    };
    expect(rollInjury(input)).toEqual(rollInjury(input));
  });

  it("cannot hurt anyone when the league dial is off", () => {
    /*
     * The knob has to be a true off switch, not a rare-events mode — a league
     * that disabled injuries and still lost a quarterback would rightly call it
     * a bug. Checked with the most dangerous play and a draw that always
     * injures.
     */
    for (const scale of [0, -1]) {
      expect(roll("sack", 0, scale, hurt(0.99))).toBeNull();
    }
  });

  it("cannot hurt anyone on a play with no contact", () => {
    expect(roll("timeout", 0, 2, hurt(0.99))).toBeNull();
  });

  it("hurts somebody when the draw is below the chance, and not when above", () => {
    // The boundary is the whole of the first draw's job.
    expect(roll("sack", 0, 2, [0, 0.5])).not.toBeNull();
    expect(roll("sack", 0, 2, [0.999, 0.5])).toBeNull();
  });

  it("hurts tired players more often than fresh ones", () => {
    /*
     * The link that makes fatigue worth modelling at all: without it, running a
     * back into the ground costs a few rating points and nothing else. Found by
     * bisecting the threshold rather than asserting a constant, so the test
     * survives a retune of the base rate.
     */
    const threshold = (stamina: number) => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (roll("rush", stamina, 1, [mid, 0.5])) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    expect(threshold(0)).toBeGreaterThan(threshold(1));
  });

  it("keeps every injury inside the band its severity promises", () => {
    const seen = new Set<InjurySeverity>();
    for (let i = 0; i < 400; i++) {
      const outcome = roll("sack", 0.5, 1, hurt(i / 400));
      if (!outcome) continue;
      seen.add(outcome.severity);
      const spec = INJURY_TABLE[outcome.severity];
      expect(outcome.gamesOut).toBeGreaterThanOrEqual(spec.minGames);
      expect(outcome.gamesOut).toBeLessThanOrEqual(spec.maxGames);
      expect(outcome.label).toBe(spec.label);
    }
    // The sweep has to actually reach more than one band, or the assertion
    // above is checking a single row of the table.
    expect(seen.size).toBeGreaterThan(2);
  });

  it("lets a knock cost nothing at all", () => {
    // `minor` is zero games on purpose: shaken up, back next week. It exists so
    // a news feed has something to report that is not a catastrophe.
    expect(INJURY_TABLE.minor.minGames).toBe(0);
    expect(INJURY_TABLE.minor.maxGames).toBe(0);
  });

  it("weights a normal league toward knocks, not catastrophes", () => {
    /*
     * A flat distribution would retire half a roster by Week 8. Counted across
     * the severity draw's whole range, which is exactly what that draw selects
     * from.
     */
    const counts = new Map<InjurySeverity, number>();
    for (let i = 0; i < 1000; i++) {
      const outcome = roll("sack", 0.5, 1, hurt(i / 1000));
      if (outcome) counts.set(outcome.severity, (counts.get(outcome.severity) ?? 0) + 1);
    }
    const minor = counts.get("minor") ?? 0;
    const severe = counts.get("severe") ?? 0;
    expect(minor).toBeGreaterThan(severe * 5);
  });

  it("makes a brutal league brutal, not merely busier", () => {
    /*
     * `severityScale` 2 shifts weight toward the top of the table rather than
     * only raising the rate — otherwise "brutal" would mean "more day-to-day
     * knocks", which nobody would notice.
     */
    const worstShare = (scale: number) => {
      let bad = 0;
      let total = 0;
      for (let i = 0; i < 1000; i++) {
        const outcome = roll("sack", 0.5, scale, hurt(i / 1000));
        if (!outcome) continue;
        total++;
        if (outcome.severity === "major" || outcome.severity === "severe") bad++;
      }
      return bad / total;
    };
    expect(worstShare(2)).toBeGreaterThan(worstShare(1));
    expect(worstShare(1)).toBeGreaterThan(worstShare(0.5));
  });

  it("spends the severity draw twice without wasting a third", () => {
    /*
     * `gamesOut` comes out of the SAME draw that chose the band, so an injury
     * check costs two numbers whether or not anybody is hurt. A third draw
     * would make every subsequent play depend on the outcome — the exact class
     * of bug the golden-log fixture exists to catch, found here instead.
     *
     * The reuse has to actually spread: if both choices moved together, every
     * `moderate` would be the same length.
     */
    const lengths = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const outcome = roll("sack", 0.5, 1, hurt(i / 500));
      if (outcome?.severity === "major") lengths.add(outcome.gamesOut);
    }
    expect(lengths.size).toBeGreaterThan(2);
  });
});

describe("availability", () => {
  it("treats an uninjured player as available", () => {
    expect(isAvailable(null)).toBe(true);
    expect(isAvailable(undefined)).toBe(true);
  });

  it("only benches a player whose status is out", () => {
    // A player carrying a questionable tag still plays; the countdown is what
    // decides, and it only applies to "out".
    expect(isAvailable({ gamesOut: 3, status: "questionable" })).toBe(true);
    expect(isAvailable({ gamesOut: 3, status: "out" })).toBe(false);
  });

  it("counts games down to zero, then plays him", () => {
    expect(isAvailable({ gamesOut: 1, status: "out" })).toBe(false);
    expect(isAvailable({ gamesOut: 0, status: "out" })).toBe(true);
    expect(isAvailable({ gamesOut: -1, status: "out" })).toBe(true);
  });
});

describe("projectedReturnWeek", () => {
  it("is a forecast, and says so by ignoring byes", () => {
    /*
     * Availability counts GAMES; this counts WEEKS, and the two only agree on a
     * schedule without byes. Nothing decides availability from it — it is the
     * "back after Week 9" line in the UI, not the rule.
     */
    expect(projectedReturnWeek(5, 3)).toBe(8);
    expect(projectedReturnWeek(5, 0)).toBe(5);
  });

  it("never projects a return in the past", () => {
    expect(projectedReturnWeek(5, -4)).toBe(5);
  });
});
