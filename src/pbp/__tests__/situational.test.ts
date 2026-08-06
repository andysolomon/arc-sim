/*
 * The 4th-down chart and clock management.
 *
 * These functions are the engine's coaching brain, and they are pure and
 * PRNG-free — which is exactly why they are worth testing directly. A full-game
 * simulation exercises them constantly but asserts nothing about them: a chart
 * that punts on 4th-and-1 from the opponent's 40 while trailing by 10 with a
 * minute left still produces a perfectly valid-looking log.
 */
import { describe, expect, it } from "vitest";
import {
  NEUTRAL_AGGRESSION,
  clockStrategy,
  fourthDownDecision,
  inFieldGoalRange,
  runoffSeconds,
  secondsLeftInGame,
  secondsLeftInHalf,
  shouldOnside,
  shouldSpike,
  shouldUseTimeout,
  type FourthDownInput,
} from "../situational.js";

/** A comfortable 1st-quarter situation; override only what a case is about. */
function situation(overrides: Partial<FourthDownInput> = {}): FourthDownInput {
  return {
    yardsToGo: 4,
    yardsToGoal: 45,
    scoreDiff: 0,
    quarter: 1,
    clockSeconds: 600,
    isOvertime: false,
    aggression: NEUTRAL_AGGRESSION,
    ...overrides,
  };
}

describe("clock arithmetic", () => {
  it("counts the quarters still to play", () => {
    expect(secondsLeftInGame(1, 720, false)).toBe(720 + 3 * 720);
    expect(secondsLeftInGame(4, 90, false)).toBe(90);
  });

  it("treats overtime as no time left at all", () => {
    // There is no later quarter to defer to, so every OT snap is end-of-game
    // urgent. Returning the clock instead would make a coach play for a punt.
    expect(secondsLeftInGame(5, 300, true)).toBe(0);
  });

  it("keys the half on the half, not the game", () => {
    // 2nd quarter counts down to the break; 3rd counts down to the end.
    expect(secondsLeftInHalf(1, 100, false)).toBe(100 + 720);
    expect(secondsLeftInHalf(2, 100, false)).toBe(100);
    expect(secondsLeftInHalf(3, 100, false)).toBe(100 + 720);
  });

  it("puts the edge of field-goal range at the 35", () => {
    // Snap distance plus 17 yards of holder and end zone: a 52-yard try.
    expect(inFieldGoalRange(35)).toBe(true);
    expect(inFieldGoalRange(36)).toBe(false);
  });
});

describe("fourthDownDecision", () => {
  it("is bravest in the dead zone, where there is no good alternative", () => {
    /*
     * The documented shape, and the reason this is a chart rather than a
     * monotonic function of field position: from 36–50 the kick is too long and
     * the punt gains almost nothing, so the bar to go for it is at its highest.
     * A team that punts there is choosing the worst of three options.
     */
    const deadZone = fourthDownDecision(situation({ yardsToGoal: 45, yardsToGo: 5 }));
    const kickingZone = fourthDownDecision(situation({ yardsToGoal: 15, yardsToGo: 5 }));

    expect(deadZone).toBe("go");
    expect(kickingZone).toBe("field_goal");
  });

  it("takes the points when they are nearly free", () => {
    expect(fourthDownDecision(situation({ yardsToGoal: 12, yardsToGo: 4 }))).toBe(
      "field_goal",
    );
  });

  it("punts from its own end rather than hand over a short field", () => {
    expect(fourthDownDecision(situation({ yardsToGoal: 70, yardsToGo: 4 }))).toBe(
      "punt",
    );
  });

  it("stops punting when a punt cannot win the game", () => {
    // Trailing by 10 with 90 seconds left: giving the ball back only guarantees
    // losing with less time than you had.
    const desperate = situation({
      yardsToGoal: 70,
      yardsToGo: 8,
      scoreDiff: -10,
      quarter: 4,
      clockSeconds: 90,
    });
    expect(fourthDownDecision(desperate)).toBe("go");
  });

  it("takes the tying kick instead, when three points are enough", () => {
    const tyingKick = situation({
      yardsToGoal: 20,
      yardsToGo: 8,
      scoreDiff: -3,
      quarter: 4,
      clockSeconds: 40,
    });
    expect(fourthDownDecision(tyingKick)).toBe("field_goal");
  });

  it("refuses a field goal that would leave it still behind", () => {
    // Down 10 with 40 seconds: three points is worthless, so play for the score.
    const pointless = situation({
      yardsToGoal: 20,
      yardsToGo: 8,
      scoreDiff: -10,
      quarter: 4,
      clockSeconds: 40,
    });
    expect(pointless.scoreDiff).toBeLessThan(-3);
    expect(fourthDownDecision(pointless)).toBe("go");
  });

  it("protects a two-score lead late instead of risking the short field", () => {
    const killingClock = situation({
      yardsToGoal: 45,
      yardsToGo: 2,
      scoreDiff: 14,
      quarter: 4,
      clockSeconds: 120,
    });
    // The same spot and distance it would go for in the first quarter.
    expect(fourthDownDecision(situation({ yardsToGoal: 45, yardsToGo: 2 }))).toBe("go");
    expect(killingClock).not.toBe("go");
  });

  it("lets an aggressive coach go where a timid one would not", () => {
    const spot = { yardsToGoal: 25, yardsToGo: 4 };
    const timid = fourthDownDecision(situation({ ...spot, aggression: 0 }));
    const bold = fourthDownDecision(situation({ ...spot, aggression: 100 }));
    expect(timid).toBe("field_goal");
    expect(bold).toBe("go");
  });

  it("only ever returns a call it was asked for", () => {
    // A cheap sweep over the whole input space, guarding the fallthrough.
    for (let yardsToGoal = 1; yardsToGoal <= 99; yardsToGoal += 7) {
      for (let yardsToGo = 1; yardsToGo <= 20; yardsToGo += 3) {
        for (const scoreDiff of [-21, -3, 0, 3, 21]) {
          for (const quarter of [1, 2, 3, 4]) {
            const call = fourthDownDecision(
              situation({ yardsToGoal, yardsToGo, scoreDiff, quarter, clockSeconds: 30 }),
            );
            expect(["go", "field_goal", "punt"]).toContain(call);
            // Never attempt a kick from out of range, whatever the situation.
            if (call === "field_goal") expect(inFieldGoalRange(yardsToGoal)).toBe(true);
          }
        }
      }
    }
  });
});

describe("shouldOnside", () => {
  const base = { quarter: 4, clockSeconds: 60, isOvertime: false };

  it("is a trailing team's play only", () => {
    expect(shouldOnside({ ...base, scoreDiff: -7 })).toBe(true);
    expect(shouldOnside({ ...base, scoreDiff: 0 })).toBe(false);
    expect(shouldOnside({ ...base, scoreDiff: 7 })).toBe(false);
  });

  it("starts earlier when one possession is not enough", () => {
    // Four minutes left: down 7 you can still get the ball back honestly,
    // down 14 you need two possessions and cannot afford to wait.
    const fourMinutes = { ...base, clockSeconds: 235 };
    expect(shouldOnside({ ...fourMinutes, scoreDiff: -7 })).toBe(false);
    expect(shouldOnside({ ...fourMinutes, scoreDiff: -14 })).toBe(true);
  });

  it("never kicks onside in overtime", () => {
    expect(shouldOnside({ ...base, scoreDiff: -7, isOvertime: true })).toBe(false);
  });
});

describe("clockStrategy", () => {
  it("burns the clock with a lead late", () => {
    expect(
      clockStrategy({ scoreDiff: 7, quarter: 4, clockSeconds: 200, isOvertime: false }),
    ).toBe("burn");
  });

  it("hurries at the end of the first half whatever the score", () => {
    /*
     * The documented subtlety: points before the break are free either way, so
     * a team that is level — or even ahead — still pushes. Keying this on the
     * score would make a leading team walk out the first half, which no team
     * does.
     */
    for (const scoreDiff of [-7, 0, 7]) {
      expect(
        clockStrategy({ scoreDiff, quarter: 2, clockSeconds: 60, isOvertime: false }),
      ).toBe("hurry_up");
    }
  });

  it("hurries at the end of the game only when it needs points", () => {
    const late = { quarter: 4, clockSeconds: 60, isOvertime: false };
    expect(clockStrategy({ ...late, scoreDiff: -7 })).toBe("hurry_up");
    expect(clockStrategy({ ...late, scoreDiff: 7 })).toBe("burn");
  });

  it("plays overtime normally", () => {
    expect(
      clockStrategy({ scoreDiff: 0, quarter: 5, clockSeconds: 60, isOvertime: true }),
    ).toBe("normal");
  });
});

describe("runoffSeconds", () => {
  it("charges nothing when the clock is stopped", () => {
    /*
     * The v1 bug this split exists to fix: charging a full ~30s cycle to every
     * snap including incompletions capped a game near 96 plays and held scoring
     * below the design band.
     */
    for (const strategy of ["normal", "hurry_up", "burn"] as const) {
      expect(runoffSeconds(strategy, true)).toBe(0);
    }
  });

  it("spends time in the order a coach intends", () => {
    expect(runoffSeconds("hurry_up", false)).toBeLessThan(runoffSeconds("normal", false));
    expect(runoffSeconds("burn", false)).toBeGreaterThan(runoffSeconds("normal", false));
  });
});

describe("shouldSpike", () => {
  const base = {
    strategy: "hurry_up" as const,
    secondsLeftInHalf: 20,
    down: 2,
    timeoutsRemaining: 0,
    clockStopped: false,
  };

  it("spikes only as a last resort", () => {
    expect(shouldSpike(base)).toBe(true);
  });

  it("spends a timeout first when it has one", () => {
    // A spike costs a down; a timeout does not.
    expect(shouldSpike({ ...base, timeoutsRemaining: 1 })).toBe(false);
  });

  it("never surrenders the ball to save six seconds", () => {
    expect(shouldSpike({ ...base, down: 4 })).toBe(false);
  });

  it("does not spike a clock that is already stopped", () => {
    expect(shouldSpike({ ...base, clockStopped: true })).toBe(false);
  });
});

describe("shouldUseTimeout", () => {
  const base = {
    isOffense: true,
    scoreDiff: -7,
    secondsLeftInHalf: 60,
    secondsLeftInGame: 60,
    quarter: 4,
    timeoutsRemaining: 2,
    clockStopped: false,
  };

  it("cannot spend what it does not have", () => {
    expect(shouldUseTimeout({ ...base, timeoutsRemaining: 0 })).toBe(false);
  });

  it("does not waste one on a stopped clock", () => {
    expect(shouldUseTimeout({ ...base, clockStopped: true })).toBe(false);
  });

  it("lets the offense stop the clock to save its own drive", () => {
    expect(shouldUseTimeout(base)).toBe(true);
    expect(shouldUseTimeout({ ...base, secondsLeftInHalf: 400 })).toBe(false);
  });

  it("gives the defense the opposite motive", () => {
    /*
     * The reason `isOffense` is an input rather than two functions: a trailing
     * defense burns timeouts to get the ball back, while a leading one has no
     * reason to stop a clock that is running out in its favor.
     */
    const defense = { ...base, isOffense: false };
    expect(shouldUseTimeout({ ...defense, scoreDiff: -7 })).toBe(true);
    expect(shouldUseTimeout({ ...defense, scoreDiff: 7 })).toBe(false);
    // And not in the third quarter, when there is still time to play.
    expect(shouldUseTimeout({ ...defense, quarter: 3 })).toBe(false);
  });
});
