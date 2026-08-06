/*
 * Flags, and the choice to take them or wave them off.
 *
 * `acceptOrDecline` is deterministic, so every call it makes is either right or
 * wrong — there is no luck to hide behind. It is also the function most likely
 * to be quietly wrong in a way a full-game log would never reveal: declining a
 * penalty you should have taken just looks like a play that happened.
 */
import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../rng/index.js";
import {
  PENALTY_TABLE,
  acceptOrDecline,
  disciplineMultiplier,
  meanAwareness,
  rollPenalty,
  type PenaltyDef,
} from "../penalties.js";

function penalty(overrides: Partial<PenaltyDef> = {}): PenaltyDef {
  return {
    ...PENALTY_TABLE[0],
    ...overrides,
  };
}

describe("disciplineMultiplier", () => {
  it("leaves an average roster at the base rate", () => {
    expect(disciplineMultiplier(50)).toBe(1);
  });

  it("rewards awareness and punishes its absence", () => {
    expect(disciplineMultiplier(90)).toBeLessThan(1);
    expect(disciplineMultiplier(20)).toBeGreaterThan(1);
  });

  it("keeps every roster playable at both extremes", () => {
    // No team is penalty-proof, and none is unplayable.
    for (const awareness of [0, 25, 50, 75, 99, 150, -50]) {
      const m = disciplineMultiplier(awareness);
      expect(m).toBeGreaterThanOrEqual(0.55);
      expect(m).toBeLessThanOrEqual(1.6);
    }
  });
});

describe("rollPenalty", () => {
  it("returns nothing on the overwhelming majority of plays", () => {
    const rand = mulberry32(42);
    let flags = 0;
    const plays = 4000;
    for (let i = 0; i < plays; i++) {
      if (rollPenalty({ rand, playType: "rush", offenseDiscipline: 50, defenseDiscipline: 50 })) {
        flags++;
      }
    }
    // Base rate is 8.5% per play; a wide band, since this is a sanity check on
    // the rate rather than a re-derivation of it.
    expect(flags / plays).toBeGreaterThan(0.05);
    expect(flags / plays).toBeLessThan(0.13);
  });

  it("flags a sloppy team more often than a disciplined one", () => {
    const count = (discipline: number) => {
      const rand = mulberry32(7);
      let flags = 0;
      for (let i = 0; i < 4000; i++) {
        if (
          rollPenalty({
            rand,
            playType: "pass_complete",
            offenseDiscipline: discipline,
            defenseDiscipline: discipline,
          })
        ) {
          flags++;
        }
      }
      return flags;
    };
    expect(count(20)).toBeGreaterThan(count(90));
  });

  it("never flags a play that cannot carry one", () => {
    const rand = mulberry32(1);
    for (const playType of ["timeout", "penalty", "kneel", "spike"] as const) {
      for (let i = 0; i < 200; i++) {
        expect(
          rollPenalty({ rand, playType, offenseDiscipline: 30, defenseDiscipline: 30 }),
        ).toBeNull();
      }
    }
  });

  it("costs exactly one draw when there is no flag", () => {
    /*
     * The property the whole gate design leans on. A clean play must consume a
     * fixed number of draws no matter how large the penalty table grows, or
     * tuning the table would silently change every later play.
     */
    let draws = 0;
    const rand = () => {
      draws++;
      return 0.99; // Always above the flag rate.
    };
    rollPenalty({ rand, playType: "rush", offenseDiscipline: 50, defenseDiscipline: 50 });
    expect(draws).toBe(1);
  });

  it("always names a penalty once it has decided to throw one", () => {
    // The floating-point tail: a rolled flag must never be silently dropped.
    const rand = () => 0; // Flag, then land on the very first table entry.
    const rolled = rollPenalty({
      rand,
      playType: "rush",
      offenseDiscipline: 50,
      defenseDiscipline: 50,
    });
    expect(rolled).not.toBeNull();
    expect(rolled!.def.label.length).toBeGreaterThan(0);
  });
});

describe("acceptOrDecline", () => {
  const play = {
    playYards: 5,
    playIsScoring: false,
    playIsTurnover: false,
    distance: 10,
  };

  it("takes a pre-snap flag, because nothing has happened yet", () => {
    const decision = acceptOrDecline({
      ...play,
      penalty: penalty({ preSnap: true, onOffense: true, yards: -5 }),
    });
    expect(decision.accepted).toBe(true);
  });

  describe("a foul on the offense — the defense chooses", () => {
    // `yards` is an unsigned magnitude on both sides of the ball; the engine
    // applies the direction. Writing -10 here would invert every comparison.
    const offensiveFoul = penalty({ onOffense: true, preSnap: false, yards: 10 });

    it("never gives back a takeaway for ten yards", () => {
      const decision = acceptOrDecline({
        ...play,
        penalty: offensiveFoul,
        playIsTurnover: true,
      });
      expect(decision.accepted).toBe(false);
      expect(decision.reason).toMatch(/turnover/);
    });

    it("wipes out a touchdown", () => {
      expect(
        acceptOrDecline({ ...play, penalty: offensiveFoul, playIsScoring: true }).accepted,
      ).toBe(true);
    });

    it("declines when the play already lost more than the flag is worth", () => {
      expect(
        acceptOrDecline({ ...play, penalty: offensiveFoul, playYards: -12 }).accepted,
      ).toBe(false);
    });

    it("erases an ordinary gain", () => {
      expect(acceptOrDecline({ ...play, penalty: offensiveFoul }).accepted).toBe(true);
    });
  });

  describe("a foul on the defense — the offense chooses", () => {
    const defensiveFoul = penalty({ onOffense: false, preSnap: false, yards: 5 });

    it("keeps its own touchdown", () => {
      expect(
        acceptOrDecline({ ...play, penalty: defensiveFoul, playIsScoring: true }).accepted,
      ).toBe(false);
    });

    it("erases its own turnover", () => {
      expect(
        acceptOrDecline({ ...play, penalty: defensiveFoul, playIsTurnover: true })
          .accepted,
      ).toBe(true);
    });

    it("declines an automatic first down it already earned by more", () => {
      /*
       * The subtle case the module calls out. Defensive holding carries an
       * automatic first down, so it looks like a free yes — but a 20-yard gain
       * on 3rd-and-10 also produced a first down, fifteen yards further along.
       * Taking the flag there hands yards back for nothing.
       */
      const holding = penalty({
        onOffense: false,
        preSnap: false,
        yards: 5,
        automaticFirstDown: true,
      });
      const decision = acceptOrDecline({
        ...play,
        penalty: holding,
        playYards: 20,
        distance: 10,
      });
      // Both options move the chains, so it comes down to yardage — and 20 beats
      // 5. What matters is that the automatic first down did not force a yes.
      expect(decision.accepted).toBe(false);
    });

    it("declines a flag that would undo a first down it just earned", () => {
      // No automatic first down, 5 yards on offer, and a 20-yard gain on
      // 3rd-and-10: taking it would move the chains back fifteen yards.
      const decision = acceptOrDecline({
        ...play,
        penalty: defensiveFoul,
        playYards: 20,
        distance: 10,
      });
      expect(decision.accepted).toBe(false);
      expect(decision.reason).toMatch(/made the line/);
    });

    it("takes the automatic first down when the play fell short", () => {
      const holding = penalty({
        onOffense: false,
        preSnap: false,
        yards: 5,
        automaticFirstDown: true,
      });
      expect(
        acceptOrDecline({ ...play, penalty: holding, playYards: 2, distance: 10 })
          .accepted,
      ).toBe(true);
    });

    it("takes the better field position when both move the chains, or neither", () => {
      // Neither: a 2-yard gain against a 5-yard flag on 3rd-and-10.
      expect(
        acceptOrDecline({ ...play, penalty: defensiveFoul, playYards: 2 }).accepted,
      ).toBe(true);
      // Play gained more than the flag is worth.
      expect(
        acceptOrDecline({ ...play, penalty: defensiveFoul, playYards: 9 }).accepted,
      ).toBe(false);
    });
  });

  it("always explains itself", () => {
    // The reason string is what makes a surprising call debuggable.
    for (const onOffense of [true, false]) {
      for (const playYards of [-12, 0, 5, 25]) {
        const decision = acceptOrDecline({
          ...play,
          playYards,
          penalty: penalty({ onOffense, preSnap: false, yards: 10 }),
        });
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("meanAwareness", () => {
  it("falls back when there is no roster to read", () => {
    expect(meanAwareness([], 61)).toBe(61);
  });

  it("stands in overall for a player with no awareness rating", () => {
    // Honest absence: an unrated player is average-for-himself, not zero.
    expect(meanAwareness([{ overall: 80 }], 50)).toBe(80);
    expect(meanAwareness([{ overall: 80, awareness: 40 }], 50)).toBe(40);
  });

  it("averages across the roster", () => {
    expect(meanAwareness([{ overall: 60 }, { overall: 80 }], 0)).toBe(70);
  });
});
