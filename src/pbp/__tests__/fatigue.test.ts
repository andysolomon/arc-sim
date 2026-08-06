/*
 * Snap counts, tiredness, and who comes off the field.
 *
 * The consequence this mechanic exists to create is a team with no depth having
 * to play its tired starter. That only works if `substitutionCandidate` refuses
 * to rotate for its own sake — a subtlety a full-game log would never expose,
 * because a slightly worse backup taking snaps looks exactly like a normal game.
 */
import { describe, expect, it } from "vitest";
import type { PlayerSimProfile } from "../types.js";
import {
  chargeSnap,
  effectiveOverall,
  snapCost,
  staminaDecay,
  staminaFor,
  substitutionCandidate,
  type SnapLedger,
} from "../fatigue.js";

const player = (playerId: string, overall: number, endurance?: number): PlayerSimProfile => ({
  playerId,
  position: "RB",
  overall,
  ...(endurance === undefined ? {} : { endurance }),
});

describe("snapCost", () => {
  it("charges nothing for a play that had no snap of its own", () => {
    for (const playType of ["timeout", "penalty", "safety"] as const) {
      expect(snapCost(playType)).toBe(0);
    }
  });

  it("charges something for anything that did", () => {
    for (const playType of ["rush", "pass_complete", "kickoff", "punt"] as const) {
      expect(snapCost(playType)).toBeGreaterThan(0);
    }
  });
});

describe("staminaDecay", () => {
  it("starts full and only ever falls", () => {
    expect(staminaDecay(0)).toBe(1);
    let previous = 1;
    for (let load = 1; load <= 60; load += 3) {
      const stamina = staminaDecay(load);
      expect(stamina).toBeLessThanOrEqual(previous);
      previous = stamina;
    }
  });

  it("stays inside [0, 1] however hard a player is ridden", () => {
    expect(staminaDecay(1000)).toBe(0);
    expect(staminaDecay(-5)).toBe(1);
  });

  it("treats an unrated player as average, never as exhausted", () => {
    /*
     * Honest absence. Reading a missing endurance rating as zero would gas an
     * unrated player on his first carry — the classic cost of defaulting an
     * unknown to a number that happens to be falsy.
     */
    expect(staminaDecay(20)).toBe(staminaDecay(20, 70));
    expect(staminaDecay(20)).toBeGreaterThan(0.3);
  });

  it("lets a fitter player last longer on the same workload", () => {
    expect(staminaDecay(30, 99)).toBeGreaterThan(staminaDecay(30, 40));
  });
});

describe("effectiveOverall", () => {
  it("leaves a fresh player untouched", () => {
    expect(effectiveOverall(80, 1)).toBe(80);
  });

  it("costs a gassed player real ability", () => {
    expect(effectiveOverall(80, 0)).toBeLessThan(80);
  });

  it("never drops a starter below replacement level", () => {
    /*
     * A gassed starter is still a varsity player. Letting this approach zero
     * would make the engine's weighted selection behave as though he had walked
     * off the field.
     */
    expect(effectiveOverall(45, 0)).toBeGreaterThanOrEqual(40);
    expect(effectiveOverall(0, 0)).toBeGreaterThanOrEqual(40);
  });
});

describe("substitutionCandidate", () => {
  const fresh = () => 1;

  it("leaves a starter who is fine alone", () => {
    const roster = [player("starter", 80), player("backup", 78)];
    expect(substitutionCandidate(roster, fresh)).toBeNull();
  });

  it("has nobody to turn to on a one-deep roster", () => {
    expect(substitutionCandidate([player("only", 80)], () => 0)).toBeNull();
    expect(substitutionCandidate([], () => 0)).toBeNull();
  });

  it("brings on a fresh backup who is now the better player", () => {
    const roster = [player("starter", 80), player("backup", 74)];
    const stamina = (p: PlayerSimProfile) => (p.playerId === "starter" ? 0 : 1);
    expect(substitutionCandidate(roster, stamina)?.playerId).toBe("backup");
  });

  it("plays the tired starter rather than a worse body", () => {
    /*
     * The whole consequence of the mechanic. A team with no depth pays for it
     * by leaving a tired star on the field — rotating to a scrub just because
     * the starter dipped below a threshold would erase that cost.
     */
    const roster = [player("star", 95), player("scrub", 55)];
    const stamina = (p: PlayerSimProfile) => (p.playerId === "star" ? 0.2 : 1);
    expect(substitutionCandidate(roster, stamina)).toBeNull();
  });

  it("picks the best available body, not merely the next one", () => {
    const roster = [player("starter", 80), player("second", 70), player("third", 79)];
    const stamina = (p: PlayerSimProfile) => (p.playerId === "starter" ? 0 : 1);
    expect(substitutionCandidate(roster, stamina)?.playerId).toBe("third");
  });
});

describe("the snap ledger", () => {
  it("accumulates a workload and turns it into tiredness", () => {
    const ledger: SnapLedger = new Map();
    const rb = player("rb", 80);
    expect(staminaFor(ledger, rb)).toBe(1);

    for (let i = 0; i < 25; i++) chargeSnap(ledger, rb.playerId, snapCost("rush"));
    const afterCarries = staminaFor(ledger, rb);
    expect(afterCarries).toBeLessThan(1);
    expect(afterCarries).toBeGreaterThan(0);

    for (let i = 0; i < 60; i++) chargeSnap(ledger, rb.playerId, snapCost("rush"));
    expect(staminaFor(ledger, rb)).toBeLessThan(afterCarries);
  });

  it("ignores a charge for a play that cost nothing", () => {
    const ledger: SnapLedger = new Map();
    chargeSnap(ledger, "rb", snapCost("timeout"));
    // Not merely zero — absent, so a player who never played carries no entry.
    expect(ledger.has("rb")).toBe(false);
  });

  it("leaves a player who never took a snap completely fresh", () => {
    expect(staminaFor(new Map(), player("bench", 60))).toBe(1);
  });
});
