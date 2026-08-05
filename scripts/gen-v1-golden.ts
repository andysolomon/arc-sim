/*
 * Regenerates the v1 golden-log fixture.
 *
 *   pnpm gen:golden
 *
 * Ported from the sprtsmng generator that originally captured it, so the
 * fixture stays reproducible rather than a mystery blob. The inputs live in
 * `src/pbp/__tests__/fixtures/v1-golden-cases.ts`, shared with the test that
 * asserts the fixture still holds — one definition, so the two cannot drift.
 *
 * Run this ONLY when a change to v1 behavior is intended. The fixture exists to
 * make such a change loud: every v2 mechanic is gated on the promise that
 * switching it off leaves existing leagues simulating exactly as before, and
 * regenerating without meaning to is how that promise gets lost quietly.
 *
 * Against an unchanged engine this rewrites the file byte-for-byte identically,
 * so `git diff` after running it is the check that nothing moved.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulateGameLog } from "../src/index.js";
import { GOLDEN_CASES, digest } from "../src/pbp/__tests__/fixtures/v1-golden-cases.js";

const NOTE =
  "Captured from the v1 engine before Epic A. Every A slice must reproduce " +
  "these logs byte-for-byte with v2 features disabled. Regenerate with " +
  "scripts/gen-v1-golden.ts ONLY when a v1 behavior change is intended.";

const fixture = {
  engineVersion: "1.0.0",
  note: NOTE,
  cases: GOLDEN_CASES.map((c, index) => {
    const log = simulateGameLog(c.input);
    return {
      name: c.name,
      seed: c.input.seed,
      decisive: c.input.decisive ?? false,
      flavor: c.input.flavor ?? "balanced",
      homeStrength: c.input.home.strength,
      awayStrength: c.input.away.strength,
      homeScore: log.homeScore,
      awayScore: log.awayScore,
      driveCount: log.drives.length,
      playCount: log.drives.reduce((n, d) => n + d.plays.length, 0),
      sha256: digest(log),
      /*
       * Only the first case carries its full log — four would be ~470KB of JSON
       * in git. It is there so a regression shows a readable deep-equal diff
       * instead of two hex strings; the rest are pinned by hash alone.
       */
      log: index === 0 ? log : undefined,
    };
  }),
};

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "pbp",
  "__tests__",
  "fixtures",
  "v1-golden-logs.json",
);
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);

console.log(`wrote ${fixture.cases.length} cases to ${out}`);
for (const c of fixture.cases) {
  console.log(
    `  ${c.name}: ${c.homeScore}-${c.awayScore}, ${c.driveCount} drives, ` +
      `${c.playCount} plays, sha=${c.sha256.slice(0, 12)}`,
  );
}
