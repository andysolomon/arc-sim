import type { PbpPlay } from "../pbp/types.js";
import type { Vec3 } from "./animation.js";

/*
 * Engine coordinates → world coordinates (A8).
 *
 * The engine speaks in one number: yards from the OFFENSE's own goal line,
 * 0–100. That frame flips every time the ball changes hands, which is exactly
 * the sort of thing a renderer should convert ONCE, in one file, rather than
 * reason about at every keyframe.
 *
 * World space:
 *   +x  downfield, 0 at midfield, ±50 at the goal lines, ±60 at the end lines
 *   +y  up
 *   +z  across the field, ±26.67 at the sidelines
 *
 * Midfield sits at the origin so the camera has something sane to orbit and so
 * the two halves are symmetric.
 */

export const FIELD_LENGTH = 100;
export const END_ZONE_DEPTH = 10;
export const FIELD_WIDTH = 53 + 1 / 3;
export const HALF_WIDTH = FIELD_WIDTH / 2;
/** Distance from the goal line to the uprights. */
export const UPRIGHT_DEPTH = 10;

/**
 * Which way the offense is attacking: +1 toward +x, -1 toward -x.
 *
 * The home team attacks +x all game. Real teams swap ends every quarter; not
 * doing so is a deliberate simplification, because the only thing it costs is
 * which way the camera looks, and the thing it buys is that a viewer never has
 * to re-learn which end is which mid-drive.
 */
export function driveDirection(play: PbpPlay, homeTeamId: string): 1 | -1 {
  return play.offenseTeamId === homeTeamId ? 1 : -1;
}

/** An engine spot (0–100, offense's own goal line at 0) on the world x axis. */
export function worldX(spot: number, direction: 1 | -1): number {
  const absolute = direction === 1 ? spot : FIELD_LENGTH - spot;
  return absolute - FIELD_LENGTH / 2;
}

/**
 * A point on the field.
 *
 * `lateral` is offense-relative — positive is the offense's right — so a route
 * written once works in both directions. It flips with `direction` for the same
 * reason `worldX` does.
 */
export function fieldPoint(
  spot: number,
  lateral: number,
  direction: 1 | -1,
  height = 0,
): Vec3 {
  return {
    x: worldX(spot, direction),
    y: height,
    z: clampLateral(lateral * direction),
  };
}

/** Keep a body inbounds — a yard shy of the paint, where a sideline tackle is. */
export function clampLateral(z: number): number {
  const edge = HALF_WIDTH - 1;
  return Math.max(-edge, Math.min(edge, z));
}
