/*
 * The command line.
 *
 * `main` returns its exit code rather than calling `process.exit`, which is
 * what makes it testable at all — and the reason the module guards its own
 * invocation, so importing it here does not print a game.
 *
 * Output is captured rather than asserted line by line: the shape of a box
 * score is a thing to change freely, but "it printed a score and did not
 * throw" is not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../cli.js";

function run(...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    return { code: main(argv), out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe("running a game", () => {
  it("prints a final score and succeeds", () => {
    const { code, out } = run("--seed", "test-1");
    expect(code).toBe(0);
    expect(out).toMatch(/Home \d+ — \d+ Away/);
    expect(out).toMatch(/drives/);
  });

  it("uses the team names it was given", () => {
    const { out } = run("--seed", "test-1", "--home", "Ironhawks", "--away", "Voxel City");
    expect(out).toContain("Ironhawks");
    expect(out).toContain("Voxel City");
  });

  it("replays a seed identically", () => {
    // The engine's whole contract, reachable from a terminal.
    expect(run("--seed", "abc", "--json").out).toBe(run("--seed", "abc", "--json").out);
  });

  it("gives different seeds different games", () => {
    // Otherwise the previous test passes for the wrong reason.
    expect(run("--seed", "abc", "--json").out).not.toBe(run("--seed", "xyz", "--json").out);
  });

  it("emits JSON that parses, with the score in it", () => {
    const { out } = run("--seed", "abc", "--json");
    const log = JSON.parse(out);
    expect(typeof log.homeScore).toBe("number");
    expect(Array.isArray(log.drives)).toBe(true);
  });

  it("prints the play-by-play on request", () => {
    const { out } = run("--seed", "abc", "--pbp");
    expect(out).toMatch(/Q[1-4] \d+:\d\d/);
    expect(out).toMatch(/kickoff|rush|pass_/);
  });

  it("reports aggregates over many games", () => {
    const { code, out } = run("--games", "3");
    expect(code).toBe(0);
    expect(out).toContain("3 games");
    expect(out).toMatch(/combined points/);
  });

  it("plays a different game under a different feature set", () => {
    // Proves --features is actually wired to the engine rather than parsed and
    // dropped, which a smoke test alone would not catch.
    const v1 = run("--seed", "same", "--features", "v1", "--json").out;
    const rec = run("--seed", "same", "--features", "recommended", "--json").out;
    expect(v1).not.toBe(rec);
  });
});

describe("refusing bad input", () => {
  it("explains an unknown option and exits non-zero", () => {
    const { code, err } = run("--bogus");
    expect(code).toBe(2);
    expect(err).toContain("unknown option --bogus");
  });

  it("catches a flag whose value was swallowed by the next flag", () => {
    /*
     * `--seed --json` would otherwise seed the game with the literal string
     * "--json" and silently produce the wrong game — the kind of thing nobody
     * notices until two runs that should match do not.
     */
    const { code, err } = run("--seed", "--json");
    expect(code).toBe(2);
    expect(err).toContain("--seed needs a value");
  });

  it("rejects a games count that is not a whole number above zero", () => {
    for (const bad of ["0", "-3", "2.5"]) {
      const { code, err } = run("--games", bad);
      expect(code, bad).toBe(2);
      expect(err, bad).toContain("whole number");
    }
  });

  it("rejects a rating that is not a number", () => {
    const { code, err } = run("--home-rating", "abc");
    expect(code).toBe(2);
    expect(err).toContain("needs a number");
  });

  it("names the valid feature sets when given a bad one", () => {
    const { code, err } = run("--features", "nope");
    expect(code).toBe(2);
    expect(err).toContain("v1, recommended, all");
  });

  it("ignores the -- that pnpm forwards", () => {
    /*
     * `pnpm run sim -- --games 3` hands the `--` straight through, so
     * rejecting it breaks the standard way of passing arguments to a package
     * script — on the very invocation the README documents.
     */
    const { code, out } = run("--", "--games", "3");
    expect(code).toBe(0);
    expect(out).toContain("3 games");
  });

  it("prints usage on --help and succeeds", () => {
    const { code, out } = run("--help");
    expect(code).toBe(0);
    expect(out).toContain("arc-sim");
    expect(out).toContain("--seed");
  });
});
