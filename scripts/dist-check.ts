/**
 * Checks the built package the way a consumer meets it.
 *
 * `tsc` type-checks source; it says nothing about whether the thing in `dist/`
 * can actually be imported. That gap is not hypothetical — this package shipped
 * for its whole life emitting extensionless relative imports, which every
 * bundler resolves and Node's ESM resolver refuses. The build was green and
 * `import("@arc-sim/core")` threw ERR_MODULE_NOT_FOUND, in the one environment
 * a headless simulation engine exists to run in.
 *
 * So the checks below read the emitted output rather than the source, and the
 * last of them boots a real game out of `dist/`.
 *
 *   pnpm build && pnpm dist-check
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** Every relative specifier in a compiled file, `.js` and `.d.ts` alike. */
function relativeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']*)["']/g;
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) found.push(m[1]);
  return found;
}

/** Bare specifiers — the package's real runtime dependencies. */
function externalSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^."'][^"']*)["']/g;
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) found.push(m[1]);
  return found;
}

function walk(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

/**
 * Follow the emitted import graph from an entry point. Returns the files
 * reached and the bare specifiers they pull in — which is how we assert that
 * importing the engine never drags Three.js in behind it.
 */
function moduleGraph(entry: string): { files: string[]; externals: Set<string> } {
  const files: string[] = [];
  const externals = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) throw new Error(`missing module: ${relative(root, file)}`);
    files.push(file);

    const source = readFileSync(file, "utf8");
    for (const spec of externalSpecifiers(source)) {
      if (!spec.startsWith("node:")) externals.add(spec);
    }
    for (const spec of relativeSpecifiers(source)) {
      queue.push(resolve(dirname(file), spec));
    }
  }
  return { files, externals };
}

type Check = { name: string; run: () => Promise<void> | void };

const ENTRY_POINTS = [
  { name: ".", js: join(dist, "index.js"), types: join(dist, "index.d.ts") },
  { name: "./render", js: join(dist, "render/index.js"), types: join(dist, "render/index.d.ts") },
];

const checks: Check[] = [
  {
    name: "every package.json export exists on disk",
    run: () => {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      const missing: string[] = [];
      for (const [name, entry] of Object.entries<Record<string, string>>(pkg.exports)) {
        for (const path of Object.values(entry)) {
          if (!existsSync(join(root, path))) missing.push(`${name} → ${path}`);
        }
      }
      if (missing.length) {
        throw new Error(`declared but not built:\n    ${missing.join("\n    ")}`);
      }
    },
  },
  {
    name: "emitted imports carry file extensions",
    run: () => {
      /*
       * The regression this whole script was written for. Node's ESM resolver
       * does not guess `.js`, so `from "./pbp/index"` in emitted output is a
       * broken package that compiles cleanly. `moduleResolution: nodenext`
       * makes the compiler reject it at the source; this proves it about the
       * artifact actually being published, including the `.d.ts` files, which
       * break consumers the same way and are easy to forget.
       */
      const offenders: string[] = [];
      for (const ext of [".js", ".d.ts"]) {
        for (const file of walk(dist, ext)) {
          for (const spec of relativeSpecifiers(readFileSync(file, "utf8"))) {
            if (!/\.js$/.test(spec)) {
              offenders.push(`${relative(root, file)}: "${spec}" has no extension`);
            } else if (!existsSync(resolve(dirname(file), spec))) {
              offenders.push(`${relative(root, file)}: "${spec}" resolves to nothing`);
            }
          }
        }
      }
      if (offenders.length) throw new Error(offenders.join("\n    "));
    },
  },
  {
    name: "the engine entry pulls in no dependencies",
    run: () => {
      // The headline claim in the README: `src/index.ts` is dependency-free, so
      // it runs anywhere. Checked against the emitted graph rather than trusted.
      const { externals, files } = moduleGraph(ENTRY_POINTS[0].js);
      if (externals.size) {
        throw new Error(`engine reached ${[...externals].join(", ")} across ${files.length} modules`);
      }
    },
  },
  {
    name: "the render entry pulls in nothing but three",
    run: () => {
      const { externals } = moduleGraph(ENTRY_POINTS[1].js);
      const unexpected = [...externals].filter((s) => s !== "three" && !s.startsWith("three/"));
      if (unexpected.length) throw new Error(`unexpected: ${unexpected.join(", ")}`);
      if (!externals.size) throw new Error("expected the render entry to import three");
    },
  },
  {
    name: "bare node can import every entry point",
    run: () => {
      /*
       * Deliberately a subprocess, and deliberately not this one. `tsx` installs
       * a loader that happily resolves the extensionless imports Node rejects —
       * so an in-process `await import()` here would have passed against the
       * exact broken build this script was written to catch. NODE_OPTIONS is
       * stripped so the child does not inherit that loader.
       */
      const { NODE_OPTIONS: _drop, ...env } = process.env;
      for (const entry of ENTRY_POINTS) {
        const url = pathToFileURL(entry.js).href;
        const result = spawnSync(
          process.execPath,
          ["-e", `import(${JSON.stringify(url)}).then(m=>{if(!Object.keys(m).length)throw new Error("no exports")})`],
          { env, encoding: "utf8" },
        );
        if (result.status !== 0) {
          throw new Error(`${entry.name}: ${result.stderr.trim().split("\n")[0]}`);
        }
      }
    },
  },
  {
    name: "the built engine simulates a deterministic game",
    run: async () => {
      const url = pathToFileURL(ENTRY_POINTS[0].js).href;
      const { simulateGameLog, deriveStatLines, seedFor } = (await import(url)) as any;

      const roster = ["QB", "RB", "WR", "TE", "DE", "LB", "CB", "S", "K", "P"];
      const team = (teamId: string, strength: number) => ({
        teamId,
        strength,
        players: roster.map((position, i) => ({
          playerId: `${teamId}-${position}`,
          position,
          overall: strength - i,
        })),
      });
      const input = {
        home: team("home", 78),
        away: team("away", 64),
        seed: seedFor("pbp", "dist-check"),
        features: { scoringV2: true, penalties: true, situational: true, timeline: true },
      };

      const log = simulateGameLog(input);
      const plays = log.drives.flatMap((d: any) => d.plays);
      if (plays.length < 50) throw new Error(`only ${plays.length} plays`);

      /*
       * Invariant 2: the score is the sum of the scoring plays, never invented.
       * Points reach a team two ways — the offense scoring, and the defense
       * being awarded a safety or a return touchdown — so both ledgers count.
       *
       * Penalty-negated plays are excluded, and leaving them in is the trap:
       * a touchdown wiped by holding stays in the log still marked
       * `isScoring` with its six points, because the drive chart has to be able
       * to show what the flag erased. The scoreboard never counted it. This
       * check passed only because the gates enabled here rarely produce one.
       */
      const scored = (teamId: string) =>
        plays
          .filter((p: any) => !p.penalty?.negatesPlay)
          .reduce((sum: number, p: any) => {
          const offense = p.isScoring && p.offenseTeamId === teamId ? p.pointsScored : 0;
          const defense = p.defenseTeamId === teamId ? (p.defensivePoints ?? 0) : 0;
          return sum + offense + defense;
        }, 0);
      if (scored(log.homeTeamId) !== log.homeScore || scored(log.awayTeamId) !== log.awayScore) {
        throw new Error(
          `score ${log.homeScore}-${log.awayScore} but plays sum to ` +
            `${scored(log.homeTeamId)}-${scored(log.awayTeamId)}`,
        );
      }

      // Invariant 1: same seed, same game.
      if (JSON.stringify(simulateGameLog(input)) !== JSON.stringify(log)) {
        throw new Error("same seed produced a different log");
      }

      if (!deriveStatLines(log).length) throw new Error("derived no stat lines");
      if (!plays.some((p: any) => p.events?.length)) throw new Error("timeline gate emitted nothing");
    },
  },
];

if (!existsSync(dist)) {
  console.error("dist/ does not exist — run `pnpm build` first.");
  process.exit(1);
}

let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`  ✓ ${check.name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${check.name}\n    ${(error as Error).message}`);
  }
}

console.log(
  failed ? `\ndist-check FAILED (${failed}/${checks.length})` : `\ndist-check OK (${checks.length} checks)`,
);
process.exit(failed ? 1 : 0);
