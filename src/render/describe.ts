import type { PbpPlay } from "../pbp/types.js";
import { kickReturnSpot } from "../pbp/timeline.js";

/*
 * Plays → English (A8).
 *
 * The engine writes no prose. That is the right call — a log is evidence, and
 * evidence in one language is a localization problem nobody asked for — so the
 * sentence is built here, at the point of display, from the fields that ARE
 * recorded.
 *
 * Useful well beyond the 3D scene: this is the whole of a text play-by-play
 * feed, which is a playable interface on its own.
 */

function yards(n: number): string {
  return `${n} yard${Math.abs(n) === 1 ? "" : "s"}`;
}

/** `2nd & 7 at the 34` — the situation a play began in. */
/**
 * An engine spot (0–100 from the offense's own goal line) as the yard line a
 * scoreboard would print. Yard lines count up to midfield and back down again,
 * so there is no 58 — the offense's 58 is the defense's 42.
 */
export function yardLine(spot: number): number {
  const clamped = Math.max(0, Math.min(100, Math.round(spot)));
  return clamped <= 50 ? clamped : 100 - clamped;
}

export function describeSituation(play: PbpPlay): string {
  if (play.down === 0) return `at the ${yardLine(play.fieldPosition)}`;
  const ordinal = ["", "1st", "2nd", "3rd", "4th"][play.down] ?? `${play.down}th`;
  const toGo =
    play.fieldPosition + play.distance >= 100 ? "goal" : String(play.distance);
  return `${ordinal} & ${toGo} at the ${yardLine(play.fieldPosition)}`;
}

/** One sentence for what happened. */
export function describePlay(play: PbpPlay): string {
  const gained = play.yardsGained;

  switch (play.playType) {
    case "kickoff":
      // `yardsGained` is the raw return roll; where the returner was actually
      // stopped is that number through the engine's own clamp.
      // Always its own half — the engine clamps a return to the 15–40.
      return `Kickoff, returned to the ${kickReturnSpot(gained)}.`;
    case "onside_kick":
      return play.isTurnover
        ? "Onside kick — recovered by the receiving team."
        : "Onside kick — RECOVERED by the kicking team!";
    case "rush":
      if (play.isScoring) return `${yards(gained)} — TOUCHDOWN!`;
      if (play.isTurnover) return `Run for ${gained} — FUMBLE, lost.`;
      return gained >= 0
        ? `Run for ${yards(gained)}.`
        : `Run stuffed for a loss of ${yards(-gained)}.`;
    case "pass_complete":
      if (play.isScoring) return `${yards(gained)} through the air — TOUCHDOWN!`;
      return `Pass complete for ${yards(gained)}.`;
    case "pass_incomplete":
      return "Pass incomplete.";
    case "sack":
      return play.isTurnover
        ? `Sacked for ${yards(-gained)} — STRIP SACK, defense recovers.`
        : `Sacked for a loss of ${yards(-gained)}.`;
    case "interception":
      return play.isReturnTd
        ? "INTERCEPTED — returned for a touchdown!"
        : `INTERCEPTED, returned ${yards(play.returnYards ?? gained)}.`;
    case "punt":
      return `Punt, ${yards(gained)} net.`;
    case "field_goal":
      return `${100 - play.fieldPosition + 17}-yard field goal is GOOD.`;
    case "field_goal_miss":
      return `${100 - play.fieldPosition + 17}-yard field goal is NO GOOD.`;
    case "extra_point":
      return "Extra point is good.";
    case "extra_point_miss":
      return "Extra point is NO GOOD.";
    case "two_point_convert":
      return "Two-point conversion is GOOD.";
    case "two_point_fail":
      return "Two-point conversion fails.";
    case "safety":
      return "Tackled in the end zone — SAFETY.";
    case "kneel":
      return "Quarterback kneels.";
    case "spike":
      return "Spiked to stop the clock.";
    case "timeout":
      return "Timeout.";
    case "penalty":
      return "Flag on the play.";
  }
}

/** `Holding — 10 yards, accepted` — or null when there was no flag. */
export function describePenalty(play: PbpPlay): string | null {
  const flag = play.penalty;
  if (!flag) return null;
  if (!flag.accepted) return `${flag.label} — declined.`;
  return `${flag.label}, ${yards(flag.yards)}${flag.negatesPlay ? " — play does not count." : "."}`;
}
