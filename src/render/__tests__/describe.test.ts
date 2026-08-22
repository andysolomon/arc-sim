/*
 * The English feed.
 *
 * `describePlay` reads a stored play, which means it has to read plays written
 * by more than one engine: the gates change what a field means, and a sentence
 * built on the wrong reading is wrong quietly — it still looks like football.
 */
import { describe, expect, it } from "vitest";
import {
  simulateGameLog,
  seedFor,
  type PbpPlay,
  type PlayerSimProfile,
  type TeamSimProfile,
} from "../../index.js";
import { describePlay } from "../index.js";

function team(id: string, strength: number): TeamSimProfile {
  const p = (position: string, overall: number): PlayerSimProfile => ({
    playerId: `${id}-${position}`,
    position,
    overall,
  });
  return {
    teamId: id,
    strength,
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

function kickoffs(kickReturns: boolean): PbpPlay[] {
  return Array.from({ length: 40 }, (_, i) =>
    simulateGameLog({
      home: team("home", 72),
      away: team("away", 68),
      seed: seedFor("pbp", "describe", String(i)),
      features: { scoringV2: true, situational: true, balance: true, kickReturns },
    }),
  )
    .flatMap((l) => l.drives.flatMap((d) => d.plays))
    .filter((p) => p.playType === "kickoff");
}

describe("a kickoff", () => {
  const v2 = kickoffs(true);
  const v1 = kickoffs(false);

  it("says what happened, under the kickReturns gate", () => {
    const touchback = v2.find((p) => p.returnYards === 0);
    const returned = v2.find((p) => (p.returnYards ?? 0) > 0);
    const houseCall = v2.find((p) => p.isReturnTd);

    expect(touchback && describePlay(touchback)).toBe("Kickoff, touchback.");
    expect(returned && describePlay(returned)).toMatch(
      /^Kickoff, returned \d+ yards? to the \d+\.$/,
    );
    expect(houseCall && describePlay(houseCall)).toMatch(/TOUCHDOWN/);
  });

  it("still reads a v1 log the way v1 meant it", () => {
    /*
     * `yardsGained` is the raw collapsed roll there, not a net, so the sentence
     * has to go through the engine's own clamp to name the spot. Absence of
     * `returnYards` is what tells the two apart — the honest-absence rule the
     * log format is built on.
     */
    expect(v1.every((p) => p.returnYards === undefined)).toBe(true);
    expect(describePlay(v1[0])).toMatch(/^Kickoff, returned to the \d+\.$/);
  });
});
