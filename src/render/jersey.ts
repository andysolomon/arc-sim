/*
 * Jersey numbers.
 *
 * Pure and deterministic, like everything else that decides what a play looks
 * like: the same slot wears the same number all game, and a replay is the same
 * replay. Deriving it from a draw would make a player's number change between
 * viewings of one recorded game, which is the sort of detail nobody articulates
 * and everybody notices.
 *
 * Numbers follow the ranges football actually uses, because a lineman wearing 7
 * reads as a bug even to someone who could not tell you the rule.
 */

/** Number ranges by position, longest prefix wins. */
const RANGES: ReadonlyArray<readonly [string, number, number]> = [
  // Longest first, so MLB beats LB and NT beats N.
  ["MLB", 50, 59],
  ["OLB", 40, 59],
  ["QB", 1, 19],
  ["RB", 20, 49],
  ["HB", 20, 49],
  ["FB", 40, 49],
  ["WR", 80, 89],
  ["TE", 80, 89],
  ["DE", 90, 99],
  ["DT", 90, 99],
  ["NT", 90, 99],
  ["DL", 90, 99],
  ["LB", 40, 59],
  ["CB", 20, 39],
  ["DB", 20, 39],
  ["OL", 50, 79],
  ["G", 60, 79],
  ["T", 70, 79],
  ["C", 50, 79],
  ["S", 20, 39],
  ["K", 1, 19],
  ["P", 1, 19],
  ["H", 20, 49],
  ["F", 40, 89],
];

/** Anything unrecognised — a coverage slot, say — gets a plausible spread. */
const FALLBACK: readonly [number, number] = [20, 89];

/**
 * Stable hash of a label.
 *
 * Same shape as the choreographer's: arbitrary but reproducible choices are
 * hashed rather than drawn, so nothing about how a play looks depends on when
 * it was drawn.
 */
function hash(label: string): number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The number this slot wears.
 *
 * Keyed off the slot label rather than the player, because the slots are what
 * persist: `WR2` is `WR2` all game even as the engine casts different people
 * into it, and a number that changed hands mid-drive would be worse than one
 * that is merely arbitrary.
 */
export function jerseyNumber(label: string): number {
  const upper = label.toUpperCase();
  const match = RANGES.find(([prefix]) => upper.startsWith(prefix));
  const [, low, high] = match ?? ["", ...FALLBACK] as const;
  return low + (hash(upper) % (high - low + 1));
}
