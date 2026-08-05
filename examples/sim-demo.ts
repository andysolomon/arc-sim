/**
 * Minimal CLI demo — two sample high-school-ish rosters, full v2 sim.
 *
 *   pnpm demo
 */
import {
  simulateGameLog,
  deriveStatLines,
  seedFor,
  type TeamSimProfile,
  type PlayerSimProfile,
} from "../src/index";

function roster(
  teamId: string,
  strength: number,
  bump: number,
): TeamSimProfile {
  const mk = (
    id: string,
    position: string,
    overall: number,
  ): PlayerSimProfile => ({
    playerId: `${teamId}-${id}`,
    position,
    overall: Math.min(99, overall + bump),
    depthRank: 1,
  });

  return {
    teamId,
    strength,
    discipline: strength,
    coach: { aggression: 55 },
    players: [
      mk("qb1", "QB", 78),
      mk("rb1", "RB", 74),
      mk("rb2", "RB", 68),
      mk("wr1", "WR", 76),
      mk("wr2", "WR", 72),
      mk("wr3", "WR", 69),
      mk("te1", "TE", 70),
      mk("de1", "DE", 73),
      mk("dt1", "DT", 71),
      mk("lb1", "LB", 74),
      mk("lb2", "LB", 70),
      mk("cb1", "CB", 73),
      mk("cb2", "CB", 70),
      mk("s1", "S", 71),
      mk("k1", "K", 68),
      mk("p1", "P", 65),
    ],
  };
}

const home = roster("eagles", 74, 2);
const away = roster("hawks", 68, 0);

const seed = seedFor("pbp", "arc-sim-demo", "week-1");
const log = simulateGameLog({
  home,
  away,
  seed,
  decisive: false,
  flavor: "balanced",
  features: {
    scoringV2: true,
    penalties: true,
    situational: true,
    balance: true,
    injuries: true,
    schemes: true,
  },
});

const stats = deriveStatLines(log);
const playCount = log.drives.reduce((n, d) => n + d.plays.length, 0);

console.log("═══ arc-sim demo ═══");
console.log(`Seed:        ${seed}`);
console.log(`Final:       Eagles ${log.homeScore} – ${log.awayScore} Hawks`);
console.log(`Drives:      ${log.drives.length}`);
console.log(`Plays:       ${playCount}`);
console.log(`Injuries:    ${log.injuries?.length ?? 0}`);
console.log(`Stat lines:  ${stats.length}`);
console.log();

const topPasser = stats
  .filter((s) => (s.statLine.passing?.att ?? 0) > 0)
  .sort(
    (a, b) => (b.statLine.passing?.yards ?? 0) - (a.statLine.passing?.yards ?? 0),
  )[0];

if (topPasser?.statLine.passing) {
  const p = topPasser.statLine.passing;
  console.log(
    `Top passer:  ${topPasser.playerId}  ${p.comp}/${p.att}, ${p.yards} yds, ${p.td} TD, ${p.int} INT`,
  );
}

const sample = log.drives[0]?.plays.slice(0, 5) ?? [];
console.log("\nOpening drive plays:");
for (const play of sample) {
  console.log(
    `  Q${play.quarter} ${play.clockSeconds}s  ${play.playType.padEnd(16)} ${play.yardsGained >= 0 ? "+" : ""}${play.yardsGained} yd` +
      (play.isScoring ? `  ★ ${play.pointsScored} pts` : ""),
  );
}
