/*
 * The red zone.
 *
 * `goalLineConversion` turned back a play that reached the goal line at a flat
 * rate, no matter how far past the line the play would have gone. A carry that
 * would have ended three yards deep in the end zone was stopped at the one as
 * often as one that would have ended at the line. Under `redZone` the stand
 * reads the margin: full at the line, gone three yards past it.
 *
 * Distributions, not examples — the claim is about which plays get stopped over
 * a few hundred games, not about any one of them.
 */
import { describe, expect, it } from "vitest";
import {
  RECOMMENDED_FEATURES,
  simulateGameLog,
  seedFor,
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

/*
 * 600, not 150. Every one of these is a claim about a distribution, and the
 * effect the gate has on a red-zone trip is a few points wide — at 150 games
 * the ON/OFF gap sat within noise of the 0.02 floor asserted below, so any
 * later gate that shifts the PRNG stream resampled it into a failure that
 * said nothing about the red zone. The sample is the fix; the thresholds are
 * the claim and stay where they are.
 */
function games(redZone: boolean, count = 600): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "red-zone", String(i)),
      features: { ...RECOMMENDED_FEATURES, redZone },
    }),
  );
}

function plays(logs: PbpGameLog[]): PbpPlay[] {
  return logs.flatMap((l) => l.drives.flatMap((d) => d.plays));
}

const SCRIMMAGE = new Set(["rush", "pass_complete"]);

/** A play that reached the goal line and was turned back — credited to the 99. */
function stoppedAtTheOne(p: PbpPlay): boolean {
  return (
    SCRIMMAGE.has(p.playType) &&
    !p.isScoring &&
    !p.isTurnover &&
    p.fieldPosition + p.yardsGained === 99
  );
}

/** Drives that ran a scrimmage play inside the 20, and which of them scored six. */
function redZoneTrips(logs: PbpGameLog[]): { trips: number; touchdowns: number } {
  let trips = 0;
  let touchdowns = 0;
  for (const drive of logs.flatMap((l) => l.drives)) {
    if (!drive.plays.some((p) => SCRIMMAGE.has(p.playType) && p.fieldPosition >= 80)) continue;
    trips++;
    if (drive.endReason === "touchdown") touchdowns++;
  }
  return { trips, touchdowns };
}

describe("redZone gate", () => {
  const OFF = games(false);
  const ON = games(true);

  it("still stops a play at the one when it only just got there", () => {
    /*
     * A margin of zero keeps the full stand. A play that would have ended at
     * the line is exactly the play in doubt at the pylon, and removing that
     * doubt would be a scoring multiplier dressed as physics.
     */
    expect(plays(ON).filter(stoppedAtTheOne).length).toBeGreaterThan(20);
  });

  it("stops fewer plays at the one, per trip, than the flat stand did", () => {
    const perTrip = (logs: PbpGameLog[]) =>
      plays(logs).filter(stoppedAtTheOne).length / redZoneTrips(logs).trips;
    // The flat stand turned back a play on roughly four trips in ten.
    expect(perTrip(OFF)).toBeGreaterThan(0.3);
    expect(perTrip(ON)).toBeLessThan(perTrip(OFF) * 0.6);
  });

  it("converts more red-zone trips into touchdowns", () => {
    const rate = (logs: PbpGameLog[]) => {
      const { trips, touchdowns } = redZoneTrips(logs);
      expect(trips).toBeGreaterThan(300);
      return touchdowns / trips;
    };
    expect(rate(ON)).toBeGreaterThan(rate(OFF) + 0.02);
    // More, not all: a drive still dies there on downs, a pick, a missed kick.
    expect(rate(ON)).toBeLessThan(0.7);
  });

  it("judges a run and a pass by the same rule", () => {
    // The whole point of `goalLineConversion`, and this gate must not undo it.
    const reached = (type: string) => {
      let got = 0;
      let scored = 0;
      for (const p of plays(ON)) {
        if (p.playType !== type || p.isTurnover) continue;
        if (p.isScoring) {
          got++;
          scored++;
        } else if (p.fieldPosition + p.yardsGained === 99) {
          got++;
        }
      }
      return scored / got;
    };
    expect(Math.abs(reached("rush") - reached("pass_complete"))).toBeLessThan(0.15);
  });

  it("leaves the rushing share of touchdowns in band", () => {
    const scoring = plays(ON).filter(
      (p) => p.isScoring && p.pointsScored === 6 && SCRIMMAGE.has(p.playType) && !p.penalty?.negatesPlay,
    );
    const rush = scoring.filter((p) => p.playType === "rush").length / scoring.length;
    expect(rush).toBeGreaterThan(0.5);
    expect(rush).toBeLessThan(0.7);
  });

  it("changes nothing until a play reaches the goal line", () => {
    /*
     * It replaces the stand's own roll rather than adding one, so the two logs
     * agree play for play up to the first play that reached the line and was
     * then decided differently.
     */
    let checked = 0;
    for (let i = 0; i < OFF.length; i++) {
      const off = plays([OFF[i]]);
      const on = plays([ON[i]]);
      for (let k = 0; k < Math.min(off.length, on.length); k++) {
        const a = off[k];
        const b = on[k];
        if (a.yardsGained !== b.yardsGained || a.isScoring !== b.isScoring) {
          // The first divergence must be a play that reached the line.
          expect(a.fieldPosition).toBe(b.fieldPosition);
          expect(a.fieldPosition + Math.max(a.yardsGained, b.yardsGained)).toBeGreaterThanOrEqual(99);
          checked++;
          break;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});
