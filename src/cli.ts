#!/usr/bin/env node
/*
 * arc-sim — simulate football from a terminal.
 *
 * The engine is a library first, but a library you cannot poke at without
 * writing a file is a library you cannot get a feel for. This exists so that
 * `npx @arc-sim/core --seed 7` prints a game.
 *
 * Two modes, because there are two questions people ask. One game answers "what
 * happened" — a box score, or the play-by-play. Many games answer "is this
 * right" — the aggregate rates you would otherwise write a throwaway script to
 * measure, which is exactly what this package's own tuning kept needing.
 *
 * No argument-parsing dependency. The engine has none, and a CLI is not a
 * reason to acquire the first one.
 */
import { pathToFileURL } from "node:url";
import {
  ALL_FEATURES,
  RECOMMENDED_FEATURES,
  V1_FEATURES,
  deriveStatLines,
  seedFor,
  simulateGameLog,
  type PbpFeatureGates,
  type PbpGameLog,
  type TeamSimProfile,
} from "./index.js";

const USAGE = `arc-sim — deterministic high-school football simulation

  arc-sim [options]

Options
  --home NAME          home team name          (default "Home")
  --away NAME          away team name          (default "Away")
  --home-rating N      home team rating 0-99   (default 72)
  --away-rating N      away team rating 0-99   (default 68)
  --seed VALUE         any string or number; the same seed always replays
  --games N            simulate N games and report aggregates instead of one
  --features SET       v1 | recommended | all   (default recommended)
  --pbp                print the play-by-play instead of the box score
  --json               print the raw game log as JSON (one game) or the
                       aggregate table as JSON (--games)
  --help               this

Examples
  arc-sim --seed week1 --home Ironhawks --away "Voxel City"
  arc-sim --seed week1 --pbp
  arc-sim --games 500                 # measure the engine's rates
  arc-sim --seed 12 --json | jq .homeScore
`;

type Args = {
  home: string;
  away: string;
  homeRating: number;
  awayRating: number;
  seed: string;
  games: number;
  features: PbpFeatureGates;
  pbp: boolean;
  json: boolean;
  help: boolean;
};

const FEATURE_SETS: Record<string, PbpFeatureGates> = {
  v1: V1_FEATURES,
  recommended: RECOMMENDED_FEATURES,
  all: ALL_FEATURES,
};

class UsageError extends Error {}

function parse(argv: readonly string[]): Args {
  const args: Args = {
    home: "Home",
    away: "Away",
    homeRating: 72,
    awayRating: 68,
    seed: "arc-sim",
    games: 1,
    features: RECOMMENDED_FEATURES,
    pbp: false,
    json: false,
    help: false,
  };

  // A flag that takes a value must actually have been given one. `--seed`
  // followed by `--json` would otherwise silently seed the game with "--json".
  const value = (flag: string, next: string | undefined): string => {
    if (next === undefined || next.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    return next;
  };
  const number = (flag: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new UsageError(`${flag} needs a number, got "${raw}"`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      /*
       * The POSIX end-of-options marker. Nothing here takes positional
       * arguments, so there is nothing to separate — but `pnpm run sim --
       * --games 500` forwards the `--` verbatim, and rejecting it means the
       * standard way to pass arguments to a package script fails on the
       * documented invocation.
       */
      case "--":
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--pbp":
        args.pbp = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--home":
        args.home = value(flag, argv[++i]);
        break;
      case "--away":
        args.away = value(flag, argv[++i]);
        break;
      case "--home-rating":
        args.homeRating = number(flag, value(flag, argv[++i]));
        break;
      case "--away-rating":
        args.awayRating = number(flag, value(flag, argv[++i]));
        break;
      case "--seed":
        args.seed = value(flag, argv[++i]);
        break;
      case "--games": {
        const n = number(flag, value(flag, argv[++i]));
        if (n < 1 || !Number.isInteger(n)) {
          throw new UsageError(`--games needs a whole number of at least 1`);
        }
        args.games = n;
        break;
      }
      case "--features": {
        const name = value(flag, argv[++i]);
        const set = FEATURE_SETS[name];
        if (!set) {
          throw new UsageError(
            `--features must be one of ${Object.keys(FEATURE_SETS).join(", ")}, got "${name}"`,
          );
        }
        args.features = set;
        break;
      }
      default:
        throw new UsageError(`unknown option ${flag}`);
    }
  }
  return args;
}

/**
 * A roster good enough to play a game.
 *
 * The engine casts by position and falls back to the best available, so this is
 * the shape of a depth chart rather than a real one. Ratings step down from the
 * team rating so that a stronger team is stronger everywhere, which is what
 * `--home-rating` is expected to mean.
 */
function roster(teamId: string, rating: number): TeamSimProfile {
  const positions = [
    "QB", "RB", "RB", "WR", "WR", "WR", "TE", "OL", "OL", "OL", "OL", "OL",
    "DE", "DE", "DT", "DT", "LB", "LB", "LB", "CB", "CB", "S", "S", "K", "P",
  ];
  const seen = new Map<string, number>();
  return {
    teamId,
    strength: rating,
    discipline: rating,
    players: positions.map((position, i) => {
      const depth = (seen.get(position) ?? 0) + 1;
      seen.set(position, depth);
      return {
        playerId: `${teamId}-${position.toLowerCase()}${depth}`,
        position,
        depthRank: depth,
        overall: Math.max(40, Math.round(rating - i * 0.6 - (depth - 1) * 3)),
      };
    }),
  };
}

const pad = (s: string, n: number) => s.padEnd(n);
const num = (n: number, w: number) => String(n).padStart(w);

function printBoxScore(log: PbpGameLog, args: Args): void {
  console.log(`\n  ${args.home} ${log.homeScore} — ${log.awayScore} ${args.away}`);
  console.log(
    `  ${log.drives.length} drives · ${log.drives.flatMap((d) => d.plays).length} plays · seed ${log.seed}\n`,
  );

  for (const teamId of ["home", "away"]) {
    const name = teamId === "home" ? args.home : args.away;
    const lines = deriveStatLines(log).filter((l) => l.teamId === teamId);
    const rows: string[] = [];
    for (const { playerId, statLine } of lines) {
      const { passing: p, rushing: r, receiving: c, defense: d, kicking: k } = statLine;
      if (p?.att) rows.push(`    ${pad(playerId, 18)} ${p.comp}/${p.att} ${num(p.yards ?? 0, 4)} yds ${p.td} TD ${p.int} INT`);
      if (r?.carries) rows.push(`    ${pad(playerId, 18)} ${num(r.carries, 3)} car ${num(r.yards ?? 0, 4)} yds ${r.td} TD (long ${r.long})`);
      if (c?.rec) rows.push(`    ${pad(playerId, 18)} ${num(c.rec, 3)} rec ${num(c.yards ?? 0, 4)} yds ${c.td} TD`);
      if (k?.fgAtt) rows.push(`    ${pad(playerId, 18)} FG ${k.fgMade}/${k.fgAtt}  XP ${k.xpMade}/${k.xpAtt}`);
      if (d?.sacks || d?.int || d?.tfl) {
        rows.push(`    ${pad(playerId, 18)} ${d.tacklesSolo} tkl, ${d.sacks} sk, ${d.tfl} tfl, ${d.int} int`);
      }
    }
    if (rows.length) {
      console.log(`  ${name}`);
      console.log(rows.join("\n"));
      console.log();
    }
  }
}

function printPlayByPlay(log: PbpGameLog, args: Args): void {
  console.log(`\n  ${args.home} ${log.homeScore} — ${log.awayScore} ${args.away}  (seed ${log.seed})\n`);
  for (const drive of log.drives) {
    const side = drive.teamId === "home" ? args.home : args.away;
    console.log(`  ── ${side}, from the ${drive.startFieldPosition} → ${drive.endReason}`);
    for (const play of drive.plays) {
      const clock = `Q${play.quarter} ${Math.floor(play.clockSeconds / 60)}:${String(play.clockSeconds % 60).padStart(2, "0")}`;
      const flag = play.penalty ? (play.penalty.negatesPlay ? "  [FLAG, no play]" : "  [flag]") : "";
      const score = play.isScoring ? `  ***  ${play.pointsScored} points` : "";
      console.log(
        `     ${pad(clock, 9)} ${pad(play.playType, 17)} ${num(play.yardsGained, 4)} yd${flag}${score}`,
      );
    }
  }
  console.log();
}

/** Rates worth knowing, and the varsity numbers they are trying to be. */
function printAggregate(args: Args): void {
  let pts = 0, plays = 0, carries = 0, rushYds = 0, att = 0, comp = 0, passYds = 0;
  let rushTd = 0, passTd = 0, sacks = 0, ints = 0, drives = 0;
  for (let i = 0; i < args.games; i++) {
    const log = simulateGameLog({
      home: roster("home", args.homeRating),
      away: roster("away", args.awayRating),
      seed: seedFor("pbp", args.seed, String(i)),
      features: args.features,
    });
    pts += log.homeScore + log.awayScore;
    drives += log.drives.length;
    for (const play of log.drives.flatMap((d) => d.plays)) {
      if (play.penalty?.negatesPlay) continue;
      switch (play.playType) {
        case "rush": carries++; rushYds += play.yardsGained; plays++; if (play.isScoring) rushTd++; break;
        case "pass_complete": att++; comp++; passYds += play.yardsGained; plays++; if (play.isScoring) passTd++; break;
        case "pass_incomplete": att++; plays++; break;
        case "interception": att++; ints++; plays++; break;
        case "sack": sacks++; plays++; break;
      }
    }
  }
  const t = 2 * args.games;
  const rows: Array<[string, string, string]> = [
    ["scrimmage plays", (plays / t).toFixed(0), "50–55"],
    ["carries", (carries / t).toFixed(0), "35–40"],
    ["rushing yards", (rushYds / t).toFixed(0), "150–180"],
    ["yards per carry", (rushYds / carries).toFixed(1), "4.5–5.5"],
    ["pass attempts", (att / t).toFixed(0), "15–20"],
    ["completion rate", `${((100 * comp) / att).toFixed(0)}%`, "50–55%"],
    ["passing yards", (passYds / t).toFixed(0), "110–150"],
    ["sacks", (sacks / t).toFixed(1), "~2"],
    ["interceptions", (ints / t).toFixed(1), "~1"],
    ["rushing share of TDs", `${((100 * rushTd) / (rushTd + passTd)).toFixed(0)}%`, "55–65%"],
    ["combined points", (pts / args.games).toFixed(1), "~42"],
  ];
  if (args.json) {
    console.log(JSON.stringify(Object.fromEntries(rows.map(([k, v]) => [k, v])), null, 2));
    return;
  }
  console.log(`\n  ${args.games} games, per team per game\n`);
  console.log(`    ${pad("", 22)}${pad("this engine", 14)}varsity`);
  for (const [label, actual, target] of rows) {
    console.log(`    ${pad(label, 22)}${pad(actual, 14)}${target}`);
  }
  console.log();
}

export function main(argv: readonly string[]): number {
  let args: Args;
  try {
    args = parse(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`arc-sim: ${error.message}\n`);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.games > 1) {
    printAggregate(args);
    return 0;
  }

  const log = simulateGameLog({
    home: roster("home", args.homeRating),
    away: roster("away", args.awayRating),
    seed: seedFor("pbp", args.seed),
    features: args.features,
  });

  if (args.json) console.log(JSON.stringify(log, null, 2));
  else if (args.pbp) printPlayByPlay(log, args);
  else printBoxScore(log, args);
  return 0;
}

/*
 * Only run when this file IS the command, not when something imports it.
 *
 * A bare `process.exitCode = main(...)` at module scope runs on import, which
 * would mean the tests below print a game every time they load the parser, and
 * anyone importing `main` would find their own process exit code rewritten.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
