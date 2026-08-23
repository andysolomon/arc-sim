/*
 * Down and distance.
 *
 * The play-caller read the down and nothing else: it ran on 3rd-and-11+ seven
 * times in ten and threw on 3rd-and-1 a third of the time, and on a fourth-down
 * go it flipped a flat 45% coin for the run. Under `downAndDistance` the
 * distance decides — short is a run, long is a pass — and the neutral downs run
 * a little more so the split over a game stays where `playCalling` put it.
 *
 * Distributions, not examples — the claim is about what gets called over a few
 * hundred games, not about any one snap.
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

function games(downAndDistance: boolean, count = 150): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "down-and-distance", String(i)),
      features: { ...RECOMMENDED_FEATURES, downAndDistance },
    }),
  );
}

const DROPBACK = new Set(["pass_complete", "pass_incomplete", "sack", "interception"]);
const SCRIMMAGE = new Set(["rush", ...DROPBACK]);

function scrimmage(logs: PbpGameLog[]): PbpPlay[] {
  return logs
    .flatMap((l) => l.drives.flatMap((d) => d.plays))
    .filter((p) => SCRIMMAGE.has(p.playType) && !p.penalty?.negatesPlay);
}

/** Share of plays matching `where` that were dropbacks. */
function passRate(plays: PbpPlay[], where: (p: PbpPlay) => boolean): number {
  const here = plays.filter(where);
  expect(here.length).toBeGreaterThan(100);
  return here.filter((p) => DROPBACK.has(p.playType)).length / here.length;
}

function converted(p: PbpPlay): boolean {
  return p.isScoring || p.yardsGained >= p.distance;
}

describe("downAndDistance gate", () => {
  const OFF = scrimmage(games(false));
  const ON = scrimmage(games(true));

  it("runs when it is short and throws when it is long", () => {
    const short = (p: PbpPlay) => p.down >= 2 && p.distance <= 2;
    const long = (p: PbpPlay) => p.down >= 2 && p.distance >= 10;
    // The flat caller was within a few points of the same split in both spots.
    expect(Math.abs(passRate(OFF, short) - passRate(OFF, long))).toBeLessThan(0.1);
    expect(passRate(ON, short)).toBeLessThan(0.25);
    expect(passRate(ON, long)).toBeGreaterThan(0.6);
  });

  it("hands it off on a fourth-and-short go", () => {
    const go = (p: PbpPlay) => p.down === 4 && p.distance <= 2;
    expect(passRate(OFF, go)).toBeGreaterThan(0.5);
    expect(passRate(ON, go)).toBeLessThan(0.3);
  });

  it("moves attempts between downs rather than adding them", () => {
    // The lean is a redistribution. Carries and attempts over a game stay in
    // the bands `playCalling` put them in.
    const perGame = (plays: PbpPlay[]) => ({
      attempts: plays.filter((p) => DROPBACK.has(p.playType)).length / 300,
      carries: plays.filter((p) => p.playType === "rush").length / 300,
    });
    const on = perGame(ON);
    expect(on.carries).toBeGreaterThan(33);
    expect(on.attempts).toBeGreaterThan(15);
    expect(on.attempts).toBeLessThan(21);
  });

  it("converts more third downs", () => {
    const rate = (plays: PbpPlay[]) => {
      const thirds = plays.filter((p) => p.down === 3);
      return thirds.filter(converted).length / thirds.length;
    };
    expect(rate(ON)).toBeGreaterThan(rate(OFF) + 0.01);
    // Into the band, not through it.
    expect(rate(ON)).toBeLessThan(0.42);
  });

  it("reaches the red zone on more drives", () => {
    const trips = (logs: PbpGameLog[]) => {
      let drives = 0;
      let reached = 0;
      for (const d of logs.flatMap((l) => l.drives)) {
        const plays = d.plays.filter((p) => SCRIMMAGE.has(p.playType));
        if (!plays.length) continue;
        drives++;
        if (plays.some((p) => p.fieldPosition + Math.max(0, p.yardsGained) >= 80)) reached++;
      }
      return reached / drives;
    };
    expect(trips(games(true))).toBeGreaterThan(trips(games(false)) + 0.01);
  });
});
