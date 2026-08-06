import type { PbpFeatureGates } from "./types.js";

/*
 * Ready-made gate sets.
 *
 * There are a dozen gates now, every one of them individually justified and
 * collectively a question nobody can answer from the type alone: which do I
 * turn on? A gate exists so a league can decline a mechanic, not so every
 * caller has to have an opinion about all twelve — and a README that has to
 * enumerate thirteen booleans before it can show a realistic game is evidence
 * the default was missing rather than obvious.
 *
 * Each preset is typed `Required<PbpFeatureGates>` on purpose. Listing every
 * gate explicitly is more verbose than spreading one preset into another, and
 * that verbosity is the point: adding a gate to `PbpFeatureGates` fails the
 * build here until somebody decides, in each preset, whether it belongs. A
 * derived preset would inherit the new gate silently, which is exactly the
 * drift this file exists to prevent.
 *
 * Frozen, because they are shared objects. Spread them to adjust:
 *
 *   features: { ...RECOMMENDED_FEATURES, injuries: false }
 */

/**
 * The v1 baseline: no v2 mechanic at all.
 *
 * Byte-for-byte identical to passing nothing, since a gate reads `=== true` and
 * an explicit `false` is the same claim as absent. Named so a caller can say
 * what it means rather than leaving an empty object and hoping the next reader
 * understands it was deliberate.
 */
export const V1_FEATURES: Required<PbpFeatureGates> = Object.freeze({
  scoringV2: false,
  penalties: false,
  injuries: false,
  weather: false,
  situational: false,
  balance: false,
  schemes: false,
  timeline: false,
  goalLineYards: false,
  goalLineConversion: false,
  returnStats: false,
  puntReturns: false,
  defensivePat: false,
});

/**
 * What to use unless you have a reason not to.
 *
 * Every mechanic that makes the simulation more like football, and nothing
 * that only makes it more like a broadcast. `timeline` is the sole omission:
 * it changes no outcome and adds roughly 70% to a stored log, so a league that
 * never renders a game should not be paying for the event stream. Turn it on
 * alongside this when something is going to draw the game.
 *
 * `weather` is included even though most callers pass no conditions — with
 * none supplied the engine plays in clear weather, so the gate costs nothing
 * until a caller has something to say.
 */
export const RECOMMENDED_FEATURES: Required<PbpFeatureGates> = Object.freeze({
  scoringV2: true,
  penalties: true,
  injuries: true,
  weather: true,
  situational: true,
  balance: true,
  schemes: true,
  timeline: false,
  goalLineYards: true,
  goalLineConversion: true,
  returnStats: true,
  puntReturns: true,
  defensivePat: true,
});

/**
 * Everything, including the renderer's event stream.
 *
 * `RECOMMENDED_FEATURES` plus `timeline`. Use it when a game is going to be
 * watched rather than only tabulated.
 */
export const ALL_FEATURES: Required<PbpFeatureGates> = Object.freeze({
  scoringV2: true,
  penalties: true,
  injuries: true,
  weather: true,
  situational: true,
  balance: true,
  schemes: true,
  timeline: true,
  goalLineYards: true,
  goalLineConversion: true,
  returnStats: true,
  puntReturns: true,
  defensivePat: true,
});
