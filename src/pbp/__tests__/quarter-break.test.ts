/*
 * The quarter break.
 *
 * The clock running out ended the drive at EVERY period boundary, and the loop
 * opened a fresh one at the same spot through `startDrive` — which sets
 * `down = 1` and `distance = 10`. A team in possession when the first or third
 * quarter expired was handed a new set of downs, and one continuous drive was
 * written down as two, both stamped `end_of_half`.
 *
 * Under `quarterBreak` the drive stays open across Q1→Q2 and Q3→Q4. Halftime,
 * the end of regulation and every overtime period still end it, because there
 * a kickoff follows and the possession really is over.
 */
import { describe, expect, it } from "vitest";
import {
  RECOMMENDED_FEATURES,
  simulateGameLog,
  seedFor,
  type PbpDrive,
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

function games(quarterBreak: boolean, count = 300): PbpGameLog[] {
  return Array.from({ length: count }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "quarter-break", String(i)),
      features: { ...RECOMMENDED_FEATURES, quarterBreak },
    }),
  );
}

const ON = games(true);
const OFF = games(false);
const GAMES = 300;

const SCRIMMAGE = new Set(["rush", "pass_complete", "pass_incomplete", "sack", "interception"]);

/** The quarter the drive's last play was run in. */
const endedIn = (d: PbpDrive): number => d.plays.at(-1)?.quarter ?? 0;

/** Drives cut off by the clock at the end of the first or third quarter. */
function cutAtAQuarter(logs: PbpGameLog[]): PbpDrive[] {
  return logs
    .flatMap((l) => l.drives)
    .filter((d) => d.endReason === "end_of_half" && (endedIn(d) === 1 || endedIn(d) === 3));
}

/**
 * A drive resumed after a period boundary that did not earn its first down.
 *
 * The successor has to be the same team with no kickoff between, which is the
 * shape of a possession that never actually changed hands.
 */
function freeFirstDowns(logs: PbpGameLog[]): PbpPlay[] {
  const free: PbpPlay[] = [];
  for (const log of logs) {
    log.drives.forEach((d, i) => {
      if (d.endReason !== "end_of_half") return;
      const next = log.drives[i + 1];
      if (!next || next.teamId !== d.teamId) return;
      if (next.plays.some((p) => p.playType === "kickoff")) return;
      const last = d.plays.at(-1);
      if (!last || last.down === 0) return;
      if (last.yardsGained >= last.distance) return; // he earned it
      free.push(last);
    });
  }
  return free;
}

describe("a quarter ending is not a drive ending", () => {
  it("left the drive open across the first and third quarters", () => {
    expect(cutAtAQuarter(ON)).toHaveLength(0);
    // ...where it used to close about twice a game.
    expect(cutAtAQuarter(OFF).length / GAMES).toBeGreaterThan(1.5);
  });

  it("stops handing the offense a set of downs it did not earn", () => {
    /*
     * The free first down is the part that is not bookkeeping. About a sixth
     * of them followed a failed third down, so the next snap should have been
     * fourth and long and the clock made it first and ten instead.
     */
    const free = freeFirstDowns(OFF);
    expect(free.length / GAMES).toBeGreaterThan(1);
    expect(free.filter((p) => p.down >= 3).length).toBeGreaterThan(GAMES * 0.1);
    expect(freeFirstDowns(ON)).toHaveLength(0);
  });

  it("carries the down and distance into the next quarter", () => {
    /*
     * The positive form of the same claim: find the snaps that straddle a
     * quarter inside one drive and check the series continued. A play that
     * fell short is followed by the next down; one that converted starts a
     * new set. Nothing here is special-cased for the boundary — that is the
     * point, the boundary stopped being an event.
     */
    let straddles = 0;
    for (const drive of ON.flatMap((l) => l.drives)) {
      const snaps = drive.plays.filter((p) => SCRIMMAGE.has(p.playType) && p.down > 0);
      for (let i = 1; i < snaps.length; i++) {
        const before = snaps[i - 1]!;
        const after = snaps[i]!;
        if (after.quarter === before.quarter) continue;
        if (before.penalty) continue; // a flag rewrites the series on its own
        straddles++;
        if (before.yardsGained >= before.distance) {
          expect(after.down).toBe(1);
        } else {
          expect(after.down).toBe(before.down + 1);
          expect(after.distance).toBe(before.distance - before.yardsGained);
        }
      }
    }
    expect(straddles).toBeGreaterThan(GAMES);
  });

  it("writes one drive down where it used to write two", () => {
    const perGame = (logs: PbpGameLog[]) => logs.flatMap((l) => l.drives).length / GAMES;
    expect(perGame(ON)).toBeLessThan(perGame(OFF) - 1);
  });
});

describe("the boundaries that really are drive endings", () => {
  it("still ends the drive at halftime, and kicks off to start the second half", () => {
    let halves = 0;
    for (const log of ON) {
      log.drives.forEach((d, i) => {
        if (d.endReason !== "end_of_half" || endedIn(d) !== 2) return;
        halves++;
        const next = log.drives[i + 1];
        expect(next?.plays.some((p) => p.playType === "kickoff")).toBe(true);
      });
    }
    // Not every game has a drive in progress when the half expires, but most do.
    expect(halves).toBeGreaterThan(GAMES * 0.5);
  });

  it("still ends the drive when regulation does", () => {
    const ended = ON.flatMap((l) => l.drives).filter((d) => d.endReason === "end_of_game");
    expect(ended.length).toBeGreaterThan(GAMES * 0.5);
    for (const d of ended) expect(endedIn(d)).toBeGreaterThanOrEqual(4);
  });

  it("leaves `end_of_half` meaning a half ended", () => {
    for (const d of ON.flatMap((l) => l.drives)) {
      if (d.endReason !== "end_of_half") continue;
      // Q2 is halftime; anything past regulation is an overtime period, which
      // is also followed by a kickoff.
      expect(endedIn(d) === 2 || endedIn(d) > 4).toBe(true);
    }
  });
});

describe("what it costs", () => {
  it("does not move the scoreboard it was never about", () => {
    /*
     * Worth stating as a bound rather than a direction. Removing 1.26 free
     * first downs a game ought to cost points, and over 1,000-game replicas
     * the measured change came out −0.68, −0.61, +0.44, −0.44 and +0.11 — a
     * sign that will not settle, which means the effect is smaller than the
     * noise around it. A free first down late in a quarter mostly extends a
     * drive that still has a long way to travel.
     *
     * So the claim here is the one the evidence supports: combined scoring
     * stays where the calibration notes left it. A gate that moved it would
     * be a scoring change smuggled in behind a bookkeeping fix.
     */
    const perGame = (logs: PbpGameLog[]) =>
      logs.reduce((n, l) => n + l.homeScore + l.awayScore, 0) / GAMES;
    expect(Math.abs(perGame(ON) - perGame(OFF))).toBeLessThan(2);
    expect(perGame(ON)).toBeGreaterThan(35);
    expect(perGame(ON)).toBeLessThan(41);
  });

  it("moves no yardage distribution out of band", () => {
    const per = (logs: PbpGameLog[]) => {
      const snaps = logs
        .flatMap((l) => l.drives.flatMap((d) => d.plays))
        .filter((p) => SCRIMMAGE.has(p.playType) && !p.penalty?.negatesPlay);
      const rushes = snaps.filter((p) => p.playType === "rush");
      return {
        plays: snaps.length / GAMES / 2,
        carries: rushes.length / GAMES / 2,
        rushYards: rushes.reduce((n, p) => n + p.yardsGained, 0) / GAMES / 2,
      };
    };
    const on = per(ON);
    expect(on.plays).toBeGreaterThan(50);
    expect(on.plays).toBeLessThan(56);
    expect(on.carries).toBeGreaterThan(33);
    expect(on.carries).toBeLessThan(40);
    expect(on.rushYards).toBeGreaterThan(150);
    expect(on.rushYards).toBeLessThan(185);
  });
});

describe("with the gate off", () => {
  it("declining it reads the same as never mentioning it", () => {
    /*
     * The failure this exists to catch is a gate that spends a draw while
     * switched off, which shifts the PRNG sequence and changes every play
     * after it. The whole-engine form of that claim is the v1 golden fixture;
     * this is the narrower one — an explicit `false` is the same game as the
     * absent key — checked beside the other gates, where the branch actually
     * sits, rather than only in isolation.
     */
    const { quarterBreak: _recommended, ...RECOMMENDED_WITHOUT } = RECOMMENDED_FEATURES;
    const configurations = [
      {},
      { scoringV2: true },
      { scoringV2: true, situational: true, balance: true },
      { situational: true, balance: true, penalties: true, injuries: true },
      RECOMMENDED_WITHOUT,
    ];
    for (const [c, features] of configurations.entries()) {
      for (let i = 0; i < 5; i++) {
        const input = {
          home: team("home", 72),
          away: team("away", 68),
          seed: seedFor("pbp", "quarter-break-inert", String(c), String(i)),
        };
        expect(
          simulateGameLog({ ...input, features: { ...features, quarterBreak: false } }),
        ).toEqual(simulateGameLog({ ...input, features }));
      }
    }
  });

  it("is the old behavior, free first down and all", () => {
    // The gate is opt-in precisely because turning it off has to keep giving a
    // league the game it already has, wrong drive records included.
    expect(cutAtAQuarter(OFF).length).toBeGreaterThan(0);
    for (const d of cutAtAQuarter(OFF)) {
      expect(d.endReason).toBe("end_of_half");
    }
  });
});
