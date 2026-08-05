/*
 * The inputs behind `v1-golden-logs.json`.
 *
 * Shared by the test that asserts the fixture still reproduces and by
 * `scripts/gen-v1-golden.ts`, which regenerates it. They have to build the
 * rosters identically or the comparison is meaningless — one module rather than
 * two copies is the only way to guarantee that.
 *
 * Ported verbatim from the sprtsmng generator that captured the fixture. Do not
 * "tidy" the roster shape or the jitter formula: the recorded logs depend on
 * every player's exact `overall`, and changing one would make the whole fixture
 * unreproducible with nothing to compare against.
 */
import { createHash } from "node:crypto";
import type { PbpGameInput, PlayerSimProfile, TeamSimProfile } from "../../types.js";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function buildRoster(teamId: string, strength: number): PlayerSimProfile[] {
  const specs: Array<[string, number]> = [
    ["QB", 2],
    ["RB", 3],
    ["WR", 5],
    ["TE", 2],
    ["DE", 2],
    ["DT", 2],
    ["OLB", 2],
    ["MLB", 2],
    ["CB", 3],
    ["S", 2],
    ["K", 1],
    ["P", 1],
  ];
  const players: PlayerSimProfile[] = [];
  for (const [pos, count] of specs) {
    for (let i = 1; i <= count; i++) {
      const jitter = ((i * 7 + strength) % 11) - 5;
      players.push({
        playerId: `${teamId}-${pos}-${i}`,
        position: pos,
        overall: clamp(strength + jitter, 40, 99),
        depthRank: i,
        positionSlot: pos,
      });
    }
  }
  return players;
}

function buildTeam(teamId: string, strength: number): TeamSimProfile {
  return { teamId, strength, players: buildRoster(teamId, strength) };
}

/**
 * A deliberate spread: an even matchup, a mismatch, a playoff game that cannot
 * tie, and each simulation flavor — so the fixture pins more than one path.
 *
 * No `features`, on purpose. All gates off is the v1 baseline, and that is
 * exactly what the fixture recorded.
 */
export const GOLDEN_CASES: Array<{ name: string; input: PbpGameInput }> = [
  {
    name: "even-balanced",
    input: {
      home: buildTeam("home", 70),
      away: buildTeam("away", 70),
      seed: 123456,
      flavor: "balanced",
    },
  },
  {
    name: "mismatch-chalk",
    input: {
      home: buildTeam("home", 85),
      away: buildTeam("away", 55),
      seed: 987654,
      flavor: "chalk",
    },
  },
  {
    name: "upsets-flavor",
    input: {
      home: buildTeam("home", 60),
      away: buildTeam("away", 75),
      seed: 246810,
      flavor: "upsets",
    },
  },
  {
    name: "decisive-playoff",
    input: {
      home: buildTeam("home", 68),
      away: buildTeam("away", 68),
      seed: 555001,
      decisive: true,
      flavor: "balanced",
    },
  },
];

/**
 * The fixture's hash function. Must stay identical on both sides, which is the
 * other reason this module exists.
 *
 * `node:crypto` is fine here: `__tests__` is excluded from `tsconfig.build.json`,
 * so nothing in this file is emitted and the shipped engine keeps its promise of
 * having no dependencies at all.
 */
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
