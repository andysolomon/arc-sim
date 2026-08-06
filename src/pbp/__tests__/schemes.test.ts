/*
 * Schemes, and the home crowd.
 *
 * The interaction terms are the design — a blitz that beats a slow offense and
 * loses to a fast one, a rivalry that damps home field instead of amplifying
 * it. Each is one arguable line of arithmetic, and a full-game log averages all
 * of them into a score that would look reasonable no matter which way the signs
 * pointed.
 */
import { describe, expect, it } from "vitest";
import {
  NEUTRAL_SCHEME_MODIFIERS,
  isNeutralScheme,
  layerSchemeModifiers,
  schemeModifiers,
  type SchemeModifiers,
  type TeamSchemeProfile,
} from "../schemes.js";
import { NEUTRAL_PRESTIGE, homeFieldEdge, isRivalry } from "../crowd.js";

const scheme = (profile: TeamSchemeProfile): TeamSchemeProfile => profile;

describe("schemeModifiers", () => {
  it("leaves a league that has declared nothing exactly as it was", () => {
    /*
     * The identity contract the `schemes` gate depends on. A team with no
     * scheme must play precisely as it did before the mechanic existed.
     */
    expect(schemeModifiers(undefined, undefined)).toEqual(NEUTRAL_SCHEME_MODIFIERS);
    expect(isNeutralScheme(schemeModifiers(undefined, undefined))).toBe(true);
    expect(isNeutralScheme(schemeModifiers(scheme({}), scheme({})))).toBe(true);
  });

  it("reads only the offensive half of the offense", () => {
    // A team can run an Air Raid and a 46 at once without the two interfering,
    // which is what lets one profile describe a whole program.
    const airRaidOffense = schemeModifiers(scheme({ offense: "air_raid", defense: "forty_six" }), undefined);
    const airRaidOnly = schemeModifiers(scheme({ offense: "air_raid" }), undefined);
    expect(airRaidOffense).toEqual(airRaidOnly);
  });

  it("makes a pass-first offense throw and a run-first offense run", () => {
    const airRaid = schemeModifiers(scheme({ offense: "air_raid" }), undefined);
    const flexbone = schemeModifiers(scheme({ offense: "flexbone" }), undefined);
    expect(airRaid.passRateDelta).toBeGreaterThan(flexbone.passRateDelta);
    // And the Flexbone blocks its own run game better than the Air Raid does.
    expect(flexbone.rushYards).toBeGreaterThan(airRaid.rushYards);
  });

  it("makes pressure the 46's defining trait", () => {
    const defenses = ["balanced", "four_three", "three_four", "four_two_five", "forty_six"];
    const sackRates = defenses.map((defense) => ({
      defense,
      rate: schemeModifiers(undefined, scheme({ defense })).sackRate,
    }));
    const most = sackRates.reduce((a, b) => (b.rate > a.rate ? b : a));
    expect(most.defense).toBe("forty_six");
    expect(most.rate).toBeGreaterThan(1.2);
  });

  it("gives no defense a free lunch", () => {
    /*
     * A scheme that is at least as good as another on every axis at once is not
     * a choice — it is the answer, and the rest of the catalog is decoration.
     *
     * The 46 was exactly that until it was measured: `blitz` and `runFit` are
     * both pure upside, and its coverage read +0.2, so it beat `balanced`, the
     * 4-3 and the 3-4 on sacks, explosives, interceptions, opponent accuracy
     * and run defense simultaneously. Every scheme has to pay for something.
     */
    const defenses = ["balanced", "four_three", "three_four", "four_two_five", "forty_six"];
    // The defense wants the first two large and the last three small.
    const axes = (m: SchemeModifiers) => [
      m.sackRate,
      m.interceptionRate,
      -m.explosiveRate,
      -m.passAccuracy,
      -m.rushYards,
    ];

    const offenders: string[] = [];
    for (const a of defenses) {
      for (const b of defenses) {
        if (a === b) continue;
        const x = axes(schemeModifiers(undefined, scheme({ defense: a })));
        const y = axes(schemeModifiers(undefined, scheme({ defense: b })));
        if (x.every((v, i) => v >= y[i]) && x.some((v, i) => v > y[i])) {
          offenders.push(`${a} dominates ${b}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("leaves the 46 exposed behind the blitz", () => {
    // Its own blurb promises famine alongside the feast. The famine is coverage.
    const fortySix = schemeModifiers(undefined, scheme({ defense: "forty_six" }));
    expect(fortySix.sackRate).toBeGreaterThan(1.2);
    expect(fortySix.explosiveRate).toBeGreaterThan(1);
    expect(fortySix.interceptionRate).toBeLessThan(1);
  });

  it("pays for coverage with the run, and the run with coverage", () => {
    /*
     * The genuine trade in the catalog: the 4-2-5 takes away the deep ball with
     * a fifth defensive back and is lighter in the box for it, while the 4-3
     * does the reverse. That opposition is what makes the choice a choice.
     */
    const nickel = schemeModifiers(undefined, scheme({ defense: "four_two_five" }));
    const base = schemeModifiers(undefined, scheme({ defense: "four_three" }));
    expect(nickel.explosiveRate).toBeLessThan(base.explosiveRate);
    expect(nickel.interceptionRate).toBeGreaterThan(base.interceptionRate);
    expect(nickel.rushYards).toBeGreaterThan(base.rushYards);
  });

  it("lets tempo beat pressure", () => {
    // Pressure gets home unless the ball comes out fast.
    const blitz = scheme({ defense: "forty_six" });
    const slow = schemeModifiers(scheme({ offense: "pro_style" }), blitz);
    const fast = schemeModifiers(scheme({ offense: "air_raid", tempo: 100 }), blitz);
    expect(fast.sackRate).toBeLessThan(slow.sackRate);
  });

  it("makes throwing deep cost accuracy and invite interceptions", () => {
    const vertical = schemeModifiers(scheme({ offense: "air_raid" }), undefined);
    const lockdown = schemeModifiers(undefined, scheme({ defense: "four_two_five" }));
    expect(vertical.passAccuracy).toBeLessThanOrEqual(1);
    expect(lockdown.interceptionRate).toBeGreaterThanOrEqual(1);
  });

  it("leaves the dials alone when nobody set them", () => {
    /*
     * `withDial` returns the base untouched for an absent dial rather than
     * adding (50 - 50) / 50. Same number, but the guard is what makes the
     * identity above exact rather than approximately exact.
     */
    const noDials = schemeModifiers(scheme({ offense: "spread" }), scheme({ defense: "three_four" }));
    const explicitNeutral = schemeModifiers(
      scheme({ offense: "spread", tempo: 50 }),
      scheme({ defense: "three_four", blitzRate: 50 }),
    );
    expect(noDials).toEqual(explicitNeutral);
  });

  it("lets a dial move a scheme without replacing it", () => {
    const base = schemeModifiers(undefined, scheme({ defense: "four_three" }));
    const blitzHappy = schemeModifiers(undefined, scheme({ defense: "four_three", blitzRate: 100 }));
    expect(blitzHappy.sackRate).toBeGreaterThan(base.sackRate);
  });

  it("keeps every modifier inside a sane band, for any pairing", () => {
    const offenses = ["balanced", "air_raid", "spread", "pro_style", "flexbone", "wing_t"];
    const defenses = ["balanced", "four_three", "three_four", "four_two_five", "forty_six"];
    for (const offense of offenses) {
      for (const defense of defenses) {
        for (const dial of [0, 50, 100]) {
          const m = schemeModifiers(
            scheme({ offense, tempo: dial }),
            scheme({ defense, blitzRate: dial }),
          );
          for (const [key, value] of Object.entries(m)) {
            expect(Number.isFinite(value), `${offense}/${defense} ${key}`).toBe(true);
            if (key === "passRateDelta") {
              expect(Math.abs(value)).toBeLessThanOrEqual(1);
            } else {
              // A multiplier that reached zero would stop the mechanic dead.
              expect(value).toBeGreaterThan(0.4);
              expect(value).toBeLessThan(2);
            }
          }
        }
      }
    }
  });
});

describe("layerSchemeModifiers", () => {
  it("leaves the season scheme alone under a neutral gameplan", () => {
    const base = schemeModifiers(scheme({ offense: "air_raid" }), scheme({ defense: "forty_six" }));
    expect(layerSchemeModifiers(base, { ...NEUTRAL_SCHEME_MODIFIERS })).toEqual(base);
  });

  it("adds the play-calling shift and multiplies the rest", () => {
    /*
     * `passRateDelta` is a shift in a rate, so two sources of it add. The rest
     * are multipliers, so they compound — layering them additively would let a
     * gameplan cancel a scheme out entirely.
     */
    const base: SchemeModifiers = { ...NEUTRAL_SCHEME_MODIFIERS, passRateDelta: 0.1, sackRate: 1.2 };
    const overlay: SchemeModifiers = { ...NEUTRAL_SCHEME_MODIFIERS, passRateDelta: 0.05, sackRate: 1.5 };
    const layered = layerSchemeModifiers(base, overlay);
    expect(layered.passRateDelta).toBeCloseTo(0.15, 10);
    expect(layered.sackRate).toBeCloseTo(1.8, 10);
  });
});

describe("homeFieldEdge", () => {
  it("hands back the engine's own number when nothing is set", () => {
    // This module scales home field; it does not own it.
    expect(homeFieldEdge({ base: 2.5 })).toBeCloseTo(2.5, 10);
    expect(homeFieldEdge({ base: 2.5, venuePrestige: NEUTRAL_PRESTIGE })).toBeCloseTo(2.5, 10);
  });

  it("makes a storied venue worth more than an empty one", () => {
    expect(homeFieldEdge({ base: 2.5, venuePrestige: 95 })).toBeGreaterThan(2.5);
    expect(homeFieldEdge({ base: 2.5, venuePrestige: 5 })).toBeLessThan(2.5);
  });

  it("damps home field in a rivalry rather than amplifying it", () => {
    /*
     * The interesting behavior, and the reason rivalry is not just "more home
     * field": a rivalry game is the one night a year the visitors travel well
     * and nobody is intimidated.
     */
    const ordinary = homeFieldEdge({ base: 2.5 });
    const rivalry = homeFieldEdge({ base: 2.5, rivalryIntensity: 100 });
    expect(rivalry).toBeLessThan(ordinary);
    expect(rivalry).toBeGreaterThan(0);
  });

  it("still leaves the home team ahead in the loudest, bitterest game", () => {
    const extreme = homeFieldEdge({ base: 2.5, venuePrestige: 100, rivalryIntensity: 100 });
    expect(extreme).toBeGreaterThan(0);
    expect(extreme).toBeLessThan(2.5);
  });

  it("treats a badge as a badge, separately from the edge", () => {
    // Worth showing on a fixture even when the intensity barely moves play.
    expect(isRivalry(1)).toBe(true);
    expect(isRivalry(0)).toBe(false);
    expect(isRivalry(undefined)).toBe(false);
  });
});
