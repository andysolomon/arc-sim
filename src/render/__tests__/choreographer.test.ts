import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  simulateGameLog,
  seedFor,
  type PbpGameLog,
  type PbpPlay,
  type PlayerSimProfile,
  type TeamSimProfile,
} from "../../index.js";
import { choreograph, choreographLog } from "../choreographer.js";
import { sampleTrack, type ActorTrack, type PlayAnimation } from "../animation.js";
import { describePlay, describeSituation, yardLine } from "../describe.js";
import { HALF_WIDTH } from "../field.js";

function team(id: string, strength: number): TeamSimProfile {
  const p = (pid: string, position: string, overall: number): PlayerSimProfile => ({
    playerId: `${id}-${pid}`,
    position,
    overall,
  });
  return {
    teamId: id,
    strength,
    discipline: strength,
    coach: { aggression: 70 },
    players: [
      p("qb", "QB", strength),
      p("rb", "RB", strength - 2),
      p("wr", "WR", strength - 1),
      p("te", "TE", strength - 4),
      p("de", "DE", strength - 3),
      p("lb", "LB", strength - 2),
      p("cb", "CB", strength - 2),
      p("s", "S", strength - 3),
      p("k", "K", 70),
      p("p", "P", 65),
    ],
  };
}

function game(label: string, timeline = true): PbpGameLog {
  return simulateGameLog({
    home: team("home", 78),
    away: team("away", 62),
    seed: seedFor("pbp", "render", label),
    features: {
      scoringV2: true,
      penalties: true,
      situational: true,
      balance: true,
      injuries: true,
      schemes: true,
      timeline,
    },
  });
}

const log = game("main");
const context = { homeTeamId: log.homeTeamId };
const plays = log.drives.flatMap((d) => d.plays);
const animations = choreographLog(log);

/** World x back to an engine spot, for checking the ball finished correctly. */
function spotOf(x: number, play: PbpPlay): number {
  const absolute = x + 50;
  return play.offenseTeamId === log.homeTeamId ? absolute : 100 - absolute;
}

function trackOf(animation: PlayAnimation, actorId: string): ActorTrack {
  return animation.tracks.find((t) => t.actorId === actorId)!;
}

describe("layering", () => {
  it("keeps Three.js out of the engine", () => {
    /*
     * The rule the whole architecture rests on: the engine is headless, so it
     * can run ten thousand games in a test. A stray import here would not fail
     * anything visibly — it would just quietly make the simulation core
     * unusable in Node, months before anyone noticed.
     */
    const offenders: string[] = [];
    for (const dir of ["pbp", "rng", "flavor", "schemes", "stats"]) {
      for (const file of walk(join(__dirname, "..", "..", dir))) {
        const source = readFileSync(file, "utf8");
        if (/from\s+"three"|require\(["']three["']\)/.test(source)) {
          offenders.push(`${file}: imports three`);
        }
        if (/from\s+"[^"]*\/render\//.test(source)) {
          offenders.push(`${file}: imports the render layer`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps Three.js out of the choreographer too", () => {
    /*
     * Only the drawing files may import it. Everything else under `render/` is
     * plain numbers, which is what makes the interesting half of the renderer
     * testable in Node — as this very file demonstrates.
     *
     * An allowlist rather than "only scene.ts": the rule is about which layer a
     * file belongs to, not how many files the graphics layer is allowed to be.
     */
    const DRAWS = ["scene.ts", "rig.ts"];
    const offenders: string[] = [];
    for (const file of walk(join(__dirname, ".."))) {
      // Tests are not shipped — `tsconfig.build.json` excludes them — and a
      // test for the drawing layer has to import what it is testing.
      if (file.includes("__tests__")) continue;
      if (DRAWS.some((name) => file.endsWith(name))) continue;
      if (/from\s+"three"/.test(readFileSync(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("choreograph", () => {
  it("puts twenty-two players and a ball on the field for every play", () => {
    expect(animations.length).toBe(plays.length);
    for (const animation of animations) {
      expect(animation.tracks).toHaveLength(23);
      expect(animation.tracks.filter((t) => t.side === "offense")).toHaveLength(11);
      expect(animation.tracks.filter((t) => t.side === "defense")).toHaveLength(11);
      expect(animation.tracks.filter((t) => t.side === "ball")).toHaveLength(1);
      expect(animation.duration).toBeGreaterThan(0);
    }
  });

  it("is deterministic", () => {
    // Same play, same performance — otherwise a replay is not a replay and a
    // visual bug cannot be reproduced.
    for (const play of plays.slice(0, 40)) {
      expect(choreograph(play, context)).toEqual(choreograph(play, context));
    }
  });

  it("orders every track's keyframes", () => {
    for (const animation of animations) {
      for (const track of animation.tracks) {
        for (let i = 1; i < track.keys.length; i++) {
          expect(track.keys[i].t).toBeGreaterThanOrEqual(track.keys[i - 1].t);
        }
      }
    }
  });

  it("keeps everyone on the planet", () => {
    for (const animation of animations) {
      for (const track of animation.tracks) {
        for (const key of track.keys) {
          expect(Number.isFinite(key.pos.x)).toBe(true);
          // The ball may leave the field of play — a made kick clears the
          // uprights ten yards deep — but nothing may leave the stadium, and
          // players are held inside the end lines.
          const limit = track.side === "ball" ? 61 : 56;
          expect(Math.abs(key.pos.x)).toBeLessThanOrEqual(limit);
          expect(Math.abs(key.pos.z)).toBeLessThanOrEqual(HALF_WIDTH);
          expect(key.pos.y).toBeGreaterThanOrEqual(0);
          expect(key.pos.y).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  it("finishes the ball where the engine finished the play", () => {
    /*
     * The contract: choreography may invent HOW, never WHAT. If a run gained
     * six, the ball has to be six yards downfield when the whistle blows.
     */
    const carries = plays.filter(
      (p) =>
        (p.playType === "rush" || p.playType === "pass_complete") &&
        !p.isScoring &&
        !p.isTurnover &&
        !p.penalty,
    );
    expect(carries.length).toBeGreaterThan(20);

    for (const play of carries) {
      const animation = choreograph(play, context);
      const ball = sampleTrack(trackOf(animation, "BALL"), animation.duration);
      const expected = Math.min(play.fieldPosition + play.yardsGained, 99);
      expect(spotOf(ball.pos.x, play)).toBeCloseTo(expected, 1);
    }
  });

  it("carries the ball into the end zone on a touchdown", () => {
    const tds = plays.filter((p) => p.isScoring && p.pointsScored === 6);
    expect(tds.length).toBeGreaterThan(0);
    for (const play of tds) {
      const animation = choreograph(play, context);
      const ball = sampleTrack(trackOf(animation, "BALL"), animation.duration);
      expect(spotOf(ball.pos.x, play)).toBeGreaterThan(100);
    }
  });

  it("puts the tackler on the ball carrier", () => {
    // The one place the invention has to line up with the engine's naming: the
    // man credited with the tackle must be at the tackle.
    let checked = 0;
    for (const play of plays) {
      const tackle = play.events?.find((e) => e.type === "tackle");
      const tacklerId = play.participants.find((p) => p.role === "tackler_solo")?.playerId;
      if (!tackle || !tacklerId) continue;
      const animation = choreograph(play, context);
      const track = animation.tracks.find((t) => t.playerId === tacklerId);
      if (!track) continue;
      const at = sampleTrack(track, tackle.t);
      const ball = sampleTrack(trackOf(animation, "BALL"), tackle.t);
      const gap = Math.hypot(at.pos.x - ball.pos.x, at.pos.z - ball.pos.z);
      expect(gap).toBeLessThan(2.5);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("casts the players the engine named", () => {
    for (const play of plays) {
      const animation = choreograph(play, context);
      const cast = new Set(
        animation.tracks.map((t) => t.playerId).filter((id): id is string => !!id),
      );
      for (const role of ["passer", "rusher", "kicker", "returner"] as const) {
        const named = play.participants.find((p) => p.role === role)?.playerId;
        if (named) expect(cast.has(named)).toBe(true);
      }
    }
  });

  it("works on a log that has no timelines of its own", () => {
    // A stored v1 game, rendered years later: the choreographer lays it out via
    // `playTimeline` rather than refusing to draw it.
    const stored = game("stored", false);
    const first = stored.drives.flatMap((d) => d.plays)[0];
    expect(first.events).toBeUndefined();
    const animation = choreograph(first, { homeTeamId: stored.homeTeamId });
    expect(animation.tracks).toHaveLength(23);
    expect(animation.duration).toBeGreaterThan(0);
  });

  it("survives every play type across many games", () => {
    /*
     * The rare paths — a safety, an onside kick, a strip sack, a pick six — are
     * where a renderer breaks, and they are exactly the plays a viewer is
     * watching for. One game does not contain them.
     */
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const sweep = game(`sweep-${i}`);
      const ctx = { homeTeamId: sweep.homeTeamId };
      for (const play of sweep.drives.flatMap((d) => d.plays)) {
        seen.add(play.playType);
        const animation = choreograph(play, ctx);
        expect(animation.tracks).toHaveLength(23);
        expect(animation.duration).toBeGreaterThan(0);
        expect(Number.isFinite(animation.duration)).toBe(true);
        for (const track of animation.tracks) {
          expect(track.keys.length).toBeGreaterThan(0);
          for (const key of track.keys) {
            expect(Number.isFinite(key.pos.x)).toBe(true);
            expect(Number.isFinite(key.pos.y)).toBe(true);
            expect(Number.isFinite(key.pos.z)).toBe(true);
            expect(key.t).toBeGreaterThanOrEqual(0);
          }
        }
        // Nobody is in two places at once.
        const named = animation.tracks
          .map((t) => t.playerId)
          .filter((id): id is string => !!id);
        expect(new Set(named).size).toBe(named.length);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(15);
    // Twenty-five games is ~3,500 plays choreographed, which is genuinely slow
    // rather than hung: ~3s on a laptop but ~10s on a shared CI runner, so
    // vitest's 5s default failed here and nowhere else. Raised rather than
    // trimmed — the rare play types are the whole point of the sweep — but not
    // raised globally, so a real hang in a fast test still fails fast.
  }, 60_000);

  it("captions every play", () => {
    for (const animation of animations) {
      expect(animation.captions.length).toBeGreaterThan(0);
      for (const caption of animation.captions) {
        expect(caption.text.length).toBeGreaterThan(0);
        expect(caption.t).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("sampleTrack", () => {
  const track: ActorTrack = {
    actorId: "OFF_0",
    side: "offense",
    label: "QB",
    keys: [
      { t: 0, pos: { x: 0, y: 0, z: 0 }, clip: "stance" },
      { t: 1, pos: { x: 10, y: 0, z: 0 }, clip: "run" },
      { t: 2, pos: { x: 10, y: 0, z: 0 }, clip: "tackled" },
    ],
  };

  it("holds the pose before the first key and after the last", () => {
    expect(sampleTrack(track, -5).pos.x).toBe(0);
    expect(sampleTrack(track, -5).clip).toBe("stance");
    expect(sampleTrack(track, 99).pos.x).toBe(10);
    expect(sampleTrack(track, 99).clip).toBe("tackled");
  });

  it("eases between keys and never overshoots", () => {
    const mid = sampleTrack(track, 0.5).pos.x;
    expect(mid).toBeCloseTo(5, 5);
    for (let t = 0; t <= 1; t += 0.05) {
      const x = sampleTrack(track, t).pos.x;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(10);
    }
  });

  it("keeps facing where it was going once it stops", () => {
    const moving = sampleTrack(track, 0.5).heading;
    const stopped = sampleTrack(track, 1.5).heading;
    expect(stopped).toBe(moving);
  });
});

describe("describe", () => {
  it("writes a sentence for every play in a game", () => {
    for (const play of plays) {
      expect(describePlay(play).length).toBeGreaterThan(3);
      expect(describeSituation(play).length).toBeGreaterThan(3);
    }
  });

  it("counts yard lines back down from midfield", () => {
    // There is no 58-yard line. The engine's frame runs 0–100 from the
    // offense's own goal line; a scoreboard mirrors it at the 50.
    expect(yardLine(25)).toBe(25);
    expect(yardLine(50)).toBe(50);
    expect(yardLine(58)).toBe(42);
    expect(yardLine(99)).toBe(1);
    for (const play of plays) {
      const line = Number(describeSituation(play).match(/at the (\d+)/)?.[1]);
      expect(line).toBeGreaterThanOrEqual(0);
      expect(line).toBeLessThanOrEqual(50);
    }
  });

  it("says goal rather than a distance inside the ten", () => {
    const goalToGo = plays.find(
      (p) => p.down > 0 && p.fieldPosition + p.distance >= 100,
    );
    if (goalToGo) expect(describeSituation(goalToGo)).toContain("goal");
  });
});
