import type { PbpPlay } from "../pbp/types.js";

/*
 * Where twenty-two people stand before the ball moves (A8).
 *
 * The engine does not model personnel — it picks a rusher and a tackler and
 * leaves the other eighteen bodies unstated. So formations are the renderer's
 * invention, and they are honest inventions: nobody watching believes the left
 * guard is a specific player, but everybody notices if there is no left guard.
 *
 * Every offset is relative to the line of scrimmage:
 *   `depth`    yards downfield (+) or into the backfield (-)
 *   `lateral`  yards to the offense's right (+) or left (-)
 *
 * Both flip with the drive direction in `fieldPoint`, so a formation is written
 * once and works going either way.
 */

export interface SlotSpec {
  /** What this slot is playing: `QB`, `LT`, `CB1`, `K`, `RET`. */
  label: string;
  depth: number;
  lateral: number;
}

const OL: SlotSpec[] = [
  { label: "LT", depth: 0, lateral: -4.6 },
  { label: "LG", depth: 0, lateral: -2.3 },
  { label: "C", depth: 0, lateral: 0 },
  { label: "RG", depth: 0, lateral: 2.3 },
  { label: "RT", depth: 0, lateral: 4.6 },
];

export type OffenseFormation =
  | "shotgun"
  | "under_center"
  | "victory"
  | "placekick"
  | "punt"
  | "kickoff";

export type DefenseFormation =
  | "base"
  | "pass"
  | "run_stuff"
  | "goal_line"
  | "field_goal_block"
  | "punt_return"
  | "kick_return";

export const OFFENSE_FORMATIONS: Record<OffenseFormation, SlotSpec[]> = {
  // Spread, gun. The default look for a passing down.
  shotgun: [
    { label: "QB", depth: -6, lateral: 0 },
    { label: "RB", depth: -6, lateral: 2.6 },
    ...OL,
    { label: "TE", depth: 0, lateral: 6.6 },
    { label: "WR1", depth: 0, lateral: -21 },
    { label: "WR2", depth: 0, lateral: 21 },
    { label: "WR3", depth: -0.5, lateral: -12 },
  ],
  // Under center with a lead back — a running down.
  under_center: [
    { label: "QB", depth: -1.4, lateral: 0 },
    { label: "RB", depth: -6.5, lateral: 0 },
    ...OL,
    { label: "TE", depth: 0, lateral: 6.6 },
    { label: "WR1", depth: 0, lateral: -19 },
    { label: "WR2", depth: 0, lateral: 19 },
    { label: "FB", depth: -3.6, lateral: 0 },
  ],
  victory: [
    { label: "QB", depth: -1.4, lateral: 0 },
    { label: "RB", depth: -5, lateral: -3 },
    ...OL,
    { label: "TE", depth: 0, lateral: 6.6 },
    { label: "RB2", depth: -5, lateral: 3 },
    { label: "WR1", depth: 0, lateral: -14 },
    { label: "WR2", depth: 0, lateral: 14 },
  ],
  placekick: [
    { label: "K", depth: -9.2, lateral: -1.6 },
    { label: "H", depth: -7, lateral: 0 },
    ...OL,
    { label: "W1", depth: 0, lateral: -6.6 },
    { label: "W2", depth: 0, lateral: 6.6 },
    { label: "W3", depth: 0, lateral: -8.9 },
    { label: "W4", depth: 0, lateral: 8.9 },
  ],
  punt: [
    { label: "P", depth: -14, lateral: 0 },
    { label: "PP", depth: -6, lateral: 0 },
    ...OL,
    { label: "G1", depth: 0, lateral: -14 },
    { label: "G2", depth: 0, lateral: 14 },
    { label: "W1", depth: 0, lateral: -6.6 },
    { label: "W2", depth: 0, lateral: 6.6 },
  ],
  // The kicking team on a kickoff: the engine spots this play at the kicking
  // team's own 35, so the coverage unit is strung across the line of scrimmage.
  kickoff: [
    { label: "K", depth: -7, lateral: 0 },
    { label: "C1", depth: 0, lateral: -22 },
    { label: "C2", depth: 0, lateral: -17 },
    { label: "C3", depth: 0, lateral: -12 },
    { label: "C4", depth: 0, lateral: -7 },
    { label: "C5", depth: 0, lateral: -2.5 },
    { label: "C6", depth: 0, lateral: 2.5 },
    { label: "C7", depth: 0, lateral: 7 },
    { label: "C8", depth: 0, lateral: 12 },
    { label: "C9", depth: 0, lateral: 17 },
    { label: "C10", depth: 0, lateral: 22 },
  ],
};

const FRONT_FOUR: SlotSpec[] = [
  { label: "DE1", depth: 1, lateral: -5.2 },
  { label: "DT1", depth: 1, lateral: -1.9 },
  { label: "DT2", depth: 1, lateral: 1.9 },
  { label: "DE2", depth: 1, lateral: 5.2 },
];

export const DEFENSE_FORMATIONS: Record<DefenseFormation, SlotSpec[]> = {
  base: [
    ...FRONT_FOUR,
    { label: "LB1", depth: 5, lateral: -6 },
    { label: "MLB", depth: 5, lateral: 0 },
    { label: "LB2", depth: 5, lateral: 6 },
    { label: "CB1", depth: 6.5, lateral: -19 },
    { label: "CB2", depth: 6.5, lateral: 19 },
    { label: "S1", depth: 13, lateral: -8 },
    { label: "S2", depth: 13, lateral: 8 },
  ],
  // Nickel-ish: corners off, safeties deep, one linebacker walked out.
  pass: [
    ...FRONT_FOUR,
    { label: "LB1", depth: 5.5, lateral: -5 },
    { label: "MLB", depth: 5.5, lateral: 1 },
    { label: "CB3", depth: 6, lateral: -11.5 },
    { label: "CB1", depth: 7.5, lateral: -20 },
    { label: "CB2", depth: 7.5, lateral: 20 },
    { label: "S1", depth: 16, lateral: -9 },
    { label: "S2", depth: 16, lateral: 9 },
  ],
  run_stuff: [
    ...FRONT_FOUR,
    { label: "LB1", depth: 3.8, lateral: -5 },
    { label: "MLB", depth: 3.8, lateral: 0 },
    { label: "LB2", depth: 3.8, lateral: 5 },
    { label: "CB1", depth: 5, lateral: -18 },
    { label: "CB2", depth: 5, lateral: 18 },
    { label: "S1", depth: 8.5, lateral: -7 },
    { label: "S2", depth: 8.5, lateral: 7 },
  ],
  goal_line: [
    { label: "DE1", depth: 1, lateral: -6.4 },
    { label: "DT1", depth: 1, lateral: -3.2 },
    { label: "NT", depth: 1, lateral: 0 },
    { label: "DT2", depth: 1, lateral: 3.2 },
    { label: "DE2", depth: 1, lateral: 6.4 },
    { label: "LB1", depth: 3, lateral: -4 },
    { label: "MLB", depth: 3, lateral: 0 },
    { label: "LB2", depth: 3, lateral: 4 },
    { label: "CB1", depth: 4, lateral: -12 },
    { label: "CB2", depth: 4, lateral: 12 },
    { label: "S1", depth: 6, lateral: 0 },
  ],
  field_goal_block: [
    { label: "DE1", depth: 1, lateral: -7.5 },
    { label: "DT1", depth: 1, lateral: -4.5 },
    { label: "NT", depth: 1, lateral: -1.5 },
    { label: "DT2", depth: 1, lateral: 1.5 },
    { label: "DE2", depth: 1, lateral: 4.5 },
    { label: "DE3", depth: 1, lateral: 7.5 },
    { label: "LB1", depth: 2.5, lateral: -10 },
    { label: "LB2", depth: 2.5, lateral: 10 },
    { label: "CB1", depth: 3, lateral: -14 },
    { label: "CB2", depth: 3, lateral: 14 },
    { label: "S1", depth: 5, lateral: 0 },
  ],
  punt_return: [
    { label: "R1", depth: 1, lateral: -6 },
    { label: "R2", depth: 1, lateral: -2 },
    { label: "R3", depth: 1, lateral: 2 },
    { label: "R4", depth: 1, lateral: 6 },
    { label: "J1", depth: 2, lateral: -14 },
    { label: "J2", depth: 2, lateral: 14 },
    { label: "H1", depth: 14, lateral: -9 },
    { label: "H2", depth: 14, lateral: 9 },
    { label: "H3", depth: 22, lateral: -4 },
    { label: "H4", depth: 22, lateral: 4 },
    { label: "RET", depth: 42, lateral: 0 },
  ],
  /*
   * The kickoff receiving team. Depths are large because this formation is
   * measured from the kicking team's 35 — the returner standing on his own 3
   * is 62 yards downfield of the spot the engine recorded.
   */
  kick_return: [
    { label: "F1", depth: 10, lateral: -20 },
    { label: "F2", depth: 10, lateral: -12 },
    { label: "F3", depth: 10, lateral: -4 },
    { label: "F4", depth: 10, lateral: 4 },
    { label: "F5", depth: 10, lateral: 12 },
    { label: "F6", depth: 10, lateral: 20 },
    { label: "W1", depth: 25, lateral: -13 },
    { label: "W2", depth: 25, lateral: -4 },
    { label: "W3", depth: 25, lateral: 4 },
    { label: "W4", depth: 25, lateral: 13 },
    { label: "RET", depth: 62, lateral: 0 },
  ],
};

/**
 * What both sides line up in for a given play.
 *
 * Chosen from the play type and the situation, because that is all the engine
 * records — it decides run or pass and never states a personnel grouping. The
 * mapping is a presentation convention, not a claim about what was called.
 */
export function formationsFor(play: PbpPlay): {
  offense: OffenseFormation;
  defense: DefenseFormation;
} {
  const goalToGo = play.fieldPosition >= 95;

  switch (play.playType) {
    case "kickoff":
    case "onside_kick":
      return { offense: "kickoff", defense: "kick_return" };

    case "punt":
      return { offense: "punt", defense: "punt_return" };

    case "field_goal":
    case "field_goal_miss":
    case "extra_point":
    case "extra_point_miss":
      return { offense: "placekick", defense: "field_goal_block" };

    case "kneel":
      return { offense: "victory", defense: "base" };

    case "rush":
      return {
        offense: goalToGo || play.distance <= 2 ? "under_center" : "shotgun",
        defense: goalToGo
          ? "goal_line"
          : play.distance <= 3
            ? "run_stuff"
            : "base",
      };

    case "two_point_convert":
    case "two_point_fail":
      return { offense: "shotgun", defense: "goal_line" };

    default:
      // Everything else is a passing down, or a play with no snap of its own
      // (a safety), where the last look on the field is the right one to hold.
      return {
        offense: "shotgun",
        defense: play.distance >= 7 ? "pass" : "base",
      };
  }
}
