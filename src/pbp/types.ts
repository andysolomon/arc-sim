/** Position groups used for participant selection (mirrors convex positionToRatingGroup + K/P). */
export type SimPositionGroup =
  | "QB"
  | "RB"
  | "WR"
  | "TE"
  | "DL"
  | "LB"
  | "DB"
  | "K"
  | "P";

export interface PlayerSimProfile {
  playerId: string;
  /** Raw position code (QB, RB/HB/FB, WR, TE, OL, DL/DT/DE, LB/ILB/OLB, CB/S/FS/SS, K, P). */
  position: string;
  /** Resolved rating 0–99 (weightedOverall or Madden fallback). */
  overall: number;
  /** From depthChartEntries/rosterAssignments when available. */
  positionSlot?: string;
  /**
   * Endurance rating, when the player has an attribute snapshot (A4). Absent
   * means average — never zero, which would gas an unrated player instantly.
   */
  endurance?: number;
  depthRank?: number;
  /**
   * Awareness (AWR) 0-99, when the player has an attribute snapshot. Drives
   * penalty discipline (A2); absent falls back to `overall`.
   */
  awareness?: number;
}

export interface TeamSimProfile {
  teamId: string;
  strength: number;
  players: PlayerSimProfile[];
  /**
   * Mean roster awareness 0-99 (A2). Lower means more flags. Absent falls back
   * to `strength`, so a team with no attribute snapshots still simulates.
   */
  discipline?: number;
  /**
   * Coaching tendencies (A3). Absent means a neutral coach, which is why this
   * slice does not depend on Epic C — the `coaches` table simply fills these in
   * later. Do NOT default these to a team's strength: a bad team with a bold
   * coach is a real thing and the model should be able to express it.
   */
  coach?: {
    /** 0-100; 50 neutral. Drives 4th-down and two-point boldness. */
    aggression?: number;
  };
  /**
   * What this team runs (A6). Absent means no stated scheme, which resolves to
   * the identity transform — not to "average", and not to the team's strength.
   *
   * Read only under `features.schemes`.
   */
  scheme?: TeamSchemeProfile;
  /**
   * Weekly emphasis for this fixture (C3). Absent means no gameplan was set.
   * Read only under `features.schemes`.
   */
  gameplan?: string;
}

import type { SimulationFlavor } from "../flavor/index.js";
import type { Weather } from "./weather.js";
import type { TeamSchemeProfile } from "./schemes.js";
import type { PbpSimEvent } from "./timeline.js";

export interface PbpGameInput {
  home: TeamSimProfile;
  away: TeamSimProfile;
  /** Same seed => byte-identical log. */
  seed: number;
  /** Playoff: overtime until no tie. */
  decisive?: boolean;
  /** Season simulation flavor; `balanced` preserves legacy weighting. */
  flavor?: SimulationFlavor;
  /**
   * v2 mechanics to enable. Omitted or all-false reproduces the v1 engine
   * byte-for-byte for the same seed — see `PbpFeatureGates`.
   */
  features?: PbpFeatureGates;
  /**
   * Conditions this game is played in (A5), derived by the caller from season,
   * week and venue. The engine does not compute it, because the engine does not
   * know what week it is.
   *
   * Read only under `features.weather`. Passing it with the gate off changes
   * nothing — which is what lets a caller derive conditions for display without
   * committing to simulating under them.
   */
  weather?: Weather;
  /**
   * Crowd context (A5). Both fields optional and neutral by default, so a
   * league that has declared no rivalries and has no program data behaves
   * exactly as it did before this slice.
   */
  venuePrestige?: number;
  rivalryIntensity?: number;
  /**
   * League injury dial (A4), 0–2. Read only under `features.injuries`.
   * Defaults to 1 (normal) when the gate is on and this is absent — a caller
   * that enabled injuries wants them at the usual rate.
   */
  injurySeverityScale?: number;
}

/** An injury sustained during a simulated game (A4). */
export interface GameInjury {
  playerId: string;
  teamId: string;
  severity: string;
  gamesOut: number;
  label: string;
  quarter: number;
}

export type PbpPlayType =
  // ── v1 (engine 1.0.0) ──────────────────────────────────────────────────
  | "kickoff"
  | "rush"
  | "pass_complete"
  | "pass_incomplete"
  | "sack"
  | "interception"
  | "punt"
  | "field_goal"
  | "field_goal_miss"
  | "extra_point"
  | "extra_point_miss"
  | "kneel"
  /*
   * ── v2 (engine 2.0.0, Epic A) ─────────────────────────────────────────
   *
   * Additive only. A stored v1 log contains none of these, which is exactly
   * why every consumer must widen rather than assume: `normalizeGameLog` in
   * `migrate-log.ts` up-converts old logs on read, and stored rows are never
   * rewritten.
   */
  | "two_point_convert"
  | "two_point_fail"
  | "safety"
  | "onside_kick"
  // A2 (penalties) and A3 (clock management) emit these; the type is declared
  // in A1 so the log format has a single version bump rather than three.
  | "penalty"
  | "spike"
  | "timeout";

export type PbpParticipantRole =
  | "kicker"
  | "returner"
  | "passer"
  | "rusher"
  | "receiver"
  | "tackler_solo"
  | "tackler_ast"
  | "sacker"
  | "interceptor"
  | "pass_defender"
  | "fumbler"
  | "recoverer";

export interface PbpParticipant {
  playerId: string;
  teamId: string;
  role: PbpParticipantRole;
}

export type PbpDriveEndReason =
  | "touchdown"
  | "field_goal"
  | "punt"
  | "turnover"
  | "end_of_half"
  | "end_of_game"
  | "downs"
  | "missed_field_goal";

export interface PbpPlay {
  playId: number;
  driveId: number;
  quarter: number;
  /** Seconds remaining in the quarter (monotonic decreasing within quarter). */
  clockSeconds: number;
  offenseTeamId: string;
  defenseTeamId: string;
  playType: PbpPlayType;
  down: number;
  distance: number;
  /** Yards from offense own goal line (0–100). */
  fieldPosition: number;
  yardsGained: number;
  isScoring: boolean;
  pointsScored: number;
  isTurnover: boolean;
  participants: PbpParticipant[];

  /*
   * ── v2 additions (engine 2.0.0) ───────────────────────────────────────
   *
   * ALL optional. A v1 log has none of them, and `normalizeGameLog` does not
   * invent values — absent means "this engine did not model it", which is
   * different from zero. Readers must treat `undefined` as unknown.
   */

  /** Yards gained on a kickoff, punt, interception or fumble return. */
  returnYards?: number;
  /** The return itself reached the end zone (A1). */
  isReturnTd?: boolean;
  /** Points scored by the DEFENSE on this play — a safety, or a return TD. */
  defensivePoints?: number;

  /**
   * Someone was hurt on this play (A4).
   *
   * Absent means nobody was — which, on a log whose `features.injuries` is
   * unset, is indistinguishable from "this engine did not model injuries". The
   * recorded gate is what tells those apart.
   */
  injury?: {
    playerId: string;
    teamId: string;
    severity: string;
    gamesOut: number;
    label: string;
  };

  /**
   * The flag on this play (A2), if any.
   *
   * A play carrying `negatesPlay: true` is KEPT in the log — you want to see
   * the run that holding wiped out — but `deriveStatLines` skips it, so no
   * player is credited for a play that officially did not happen.
   */
  penalty?: {
    code: string;
    label: string;
    yards: number;
    onOffense: boolean;
    accepted: boolean;
    negatesPlay: boolean;
    reason: string;
  };

  /**
   * How the offense was treating the clock on this play (A3).
   *
   * Present only under the `situational` gate, and only when the tempo was not
   * `normal` — so its absence means either "v1 log" or "nothing notable", which
   * is fine here because tempo has no stat consequences. Anything a reader must
   * distinguish absence from zero for gets its own honest-absence treatment
   * (see `returnYards`).
   */
  tempo?: "hurry_up" | "burn";

  /**
   * Which team called this timeout (A3), for `playType === "timeout"` only.
   *
   * Needed because either side can call one: `offenseTeamId` identifies who has
   * the ball, not who spent the timeout, and a defensive timeout late in a game
   * is exactly the interesting case.
   */
  timeoutTeamId?: string;

  /**
   * The ordered beats of this play (A7), for a renderer to choreograph.
   *
   * Present only under `features.timeline`. An EMPTY array is different from
   * absence and meaningful: the play was laid out and has nothing to show,
   * which is what a timeout is.
   *
   * Synthetic — see `timeline.ts`. The engine does not simulate a dropback or a
   * ball in flight; these beats are consistent with the outcome rather than
   * evidence about it, so nothing derives a statistic from them.
   */
  events?: PbpSimEvent[];

  /**
   * The scoreboard as this play began (A7).
   *
   * Everything else a renderer needs pre-snap is already on the play — `down`,
   * `distance`, `fieldPosition`, `quarter` and `clockSeconds` are all recorded
   * BEFORE the result is applied. The score was not, and reconstructing it
   * means re-summing every scoring play that came first, which is exactly the
   * kind of reverse-engineering a consumer should never have to do.
   *
   * Present only under `features.timeline`. Named for the common case; on a
   * play that has no snap of its own (a kickoff, a safety) it means "as the
   * play began".
   */
  preSnap?: {
    homeScore: number;
    awayScore: number;
    /**
     * Timeouts in hand. Present only when `features.situational` was ALSO on —
     * with clock management off the engine never spends one, and reporting a
     * full three would claim nobody used a timeout when in truth nobody could.
     */
    homeTimeouts?: number;
    awayTimeouts?: number;
  };
}

export interface PbpDrive {
  driveId: number;
  teamId: string;
  startQuarter: number;
  startClockSeconds: number;
  startFieldPosition: number;
  endReason: PbpDriveEndReason;
  plays: PbpPlay[];
}

export interface PbpGameLog {
  seed: number;
  decisive: boolean;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  drives: PbpDrive[];

  /**
   * Conditions the game was actually played in (A5).
   *
   * Written only when the `weather` gate was on. Its ABSENCE means the game was
   * not simulated under modelled conditions — which is not the same as fair
   * weather, and a reader must not substitute the derived forecast for it. The
   * forecast is what the schedule shows for a game nobody has played; this is
   * what history reads.
   */
  weather?: Weather;

  /**
   * The gates this game was ACTUALLY simulated under.
   *
   * The engine version alone cannot answer "were penalties modelled here?" —
   * two games written by the same engine build differ if a commissioner turned
   * penalties off between them, and a league that adopts a mechanic mid-season
   * has both kinds of log in one season (#646).
   *
   * Absence means no v2 mechanic was active, which is what keeps a fully-gated-
   * off game byte-identical to its v1 log. Written only when at least one gate
   * is on; never defaulted to `{}`.
   */
  features?: PbpFeatureGates;

  /**
   * Everyone hurt in this game (A4), in the order it happened.
   *
   * Absent when the gate was off. An EMPTY array is different and meaningful:
   * injuries were modelled and nobody got hurt.
   */
  injuries?: GameInjury[];

  /*
   * ── v2 additions (engine 2.0.0) ───────────────────────────────────────
   *
   * `version` is absent on every v1 log, which is how `normalizeGameLog`
   * recognizes one. Do not default it at write time — its absence is the
   * signal.
   */
  version?: 2;
}

/*
 * Engine feature gates (Epic A).
 *
 * Every v2 mechanic is opt-in and, when disabled, must consume ZERO random
 * draws. The PRNG is a sequence: a disabled feature that calls `rand()` even
 * once shifts every subsequent draw and the whole log diverges from v1. That
 * is what makes byte-for-byte golden parity testable at all, so treat "no
 * draws when off" as a hard rule, not an optimization.
 */
export interface PbpFeatureGates {
  /**
   * A1 — safeties, two-point conversions, return touchdowns, and fumbles on
   * plays other than a rush.
   */
  scoringV2?: boolean;
  /** A2 — penalties, with accept/decline. */
  penalties?: boolean;
  /**
   * A4 — fatigue, durability and injuries.
   *
   * One gate for both halves on purpose: fatigue with no injury risk is a
   * rating tweak nobody would notice, and injuries with no fatigue lose the
   * link that makes riding a starter cost something.
   */
  injuries?: boolean;
  /**
   * A5 — weather, venue prestige and rivalry.
   *
   * Maps to `dynastyConfig.weatherEnabled` once the gates are wired. With it
   * off the engine ignores `PbpGameInput.weather` entirely and consumes no
   * extra draws, so the pre-A5 log reproduces byte-for-byte.
   */
  weather?: boolean;
  /**
   * A3 — situational decisions and clock management: a 4th-down chart in place
   * of a coin flip, timeouts, the two-minute drill, spikes and onside kicks.
   *
   * Also carries the realistic clock model. v1 charged a full ~30-second cycle
   * to every snap including incompletions, which capped a game at roughly 96
   * scrimmage plays and is the main reason scoring sat below the design band.
   */
  situational?: boolean;
  /**
   * A3 — the balance recalibration filed as #642.
   *
   * Separate from `situational` on purpose. That gate adds *mechanics*; this
   * one only retunes constants that were already there. Keeping them apart
   * means a league can adopt clock management without adopting the new
   * home-field weighting, and it means the distribution report can attribute
   * each change independently.
   */
  balance?: boolean;
  /**
   * A6 — team schemes and coach tendencies shape play calling and outcomes.
   *
   * With this off the engine holds `NEUTRAL_SCHEME_MODIFIERS` and never reads a
   * team's `scheme`, so a league that has assigned schemes and then switched
   * the mechanic off plays exactly as it did before A6 — the assignment becomes
   * a preference nobody is acting on rather than a hidden effect.
   */
  schemes?: boolean;
  /**
   * A7 — per-play event timelines and the pre-snap scoreboard, for renderers.
   *
   * The odd one out, and deliberately so: it adds no mechanic and changes no
   * outcome. It draws no randomness whether it is on or OFF, so a game
   * simulated with it on is the SAME game — same seed, same plays, same derived
   * stats — carrying extra description. Everything it writes is derived from
   * plays the engine had already decided (see `timeline.ts`).
   *
   * It is a gate rather than an always-on field because the events add about
   * 70% to a stored log, and a league that never renders a game should not pay
   * for that.
   */
  timeline?: boolean;
  /**
   * A carry that reaches the goal line but is not ruled a touchdown is credited
   * to the 99, not past it.
   *
   * A correction rather than a mechanic. `doRush` decides reaching the end zone
   * and scoring separately: the carry can gain enough to cross the goal line and
   * then fail the touchdown roll, and v1 left the yardage where it was. The ball
   * was clamped to the 99 either way, so the field was right and only the
   * bookkeeping was wrong — a back credited with 8 yards from the opponent's 5,
   * and a rushing title inflated by the difference.
   *
   * It is gated rather than simply fixed because it changes the game, not just
   * the record. `yards` decides the first down (`yards >= distance`), so with
   * this off, a runner stopped at the 1 on 2nd-and-goal from the 5 is awarded a
   * fresh set of downs he did not earn. Correcting that is right, and it is
   * still a different game — so v1 logs keep reproducing byte-for-byte until a
   * league opts in.
   *
   * Costs no random draw in either position: the touchdown roll is taken in
   * exactly the same circumstances as before, and this only rewrites `yards`
   * afterwards.
   */
  goalLineYards?: boolean;
  /**
   * One rule decides whether a play that reached the goal line scored, for the
   * run and the pass alike.
   *
   * v1 asked the question in both places and answered it differently. A carry
   * rolled a 2–15% chance of *scoring*; a completion scored automatically. Over
   * 300 games that came out as 7.8% conversion on the ground against 92.9%
   * through the air, and left **8.9% of all touchdowns to the run** — a sport
   * in which nobody scores by rushing, from an engine whose stated invariant is
   * that stats are derived from plays rather than invented.
   *
   * Under this gate both paths call `stoppedAtGoalLine`, which asks the
   * question that is actually in doubt — the ball got there, did the defense
   * hold — and discounts a breakaway, since a back who broke a 20-yard run was
   * not caught from behind at the one.
   *
   * Implies `goalLineYards`: a play stopped short has to be credited to the 99
   * whichever way it got there, or the correction reintroduces the bookkeeping
   * bug it was built beside.
   *
   * Costs no extra draw on a rush — it replaces the roll v1 already spent — and
   * one new draw on a completion, which is why it changes the sequence and has
   * to be opt-in.
   */
  goalLineConversion?: boolean;
  /**
   * Record what a returner actually brought a punt back, instead of leaving the
   * box score to guess.
   *
   * The engine folds the return into the punt's net (`net = gross - roll`) and
   * v1 never wrote the return down, so `deriveStatLines` reconstructed one as
   * `net * 0.25`. That number corresponds to nothing: measured over 124 punts
   * it credited a mean 10.2 return yards against a simulated ~4, computed from
   * the punt's length rather than from the return at all — a statistic invented
   * from a final number, which is the exact thing this engine exists not to do.
   *
   * With the gate on, `PbpPlay.returnYards` carries `gross - net`, and the
   * reducer reads it. With it off, the reconstruction stands, so an existing
   * league's box scores do not silently change under it.
   *
   * Costs no random draw: the roll already happened, and this only writes down
   * what it produced.
   */
  returnStats?: boolean;
  /**
   * What happens to a punt after it lands: fair catches, touchbacks, punts
   * downed inside the 10, and returns that occasionally break.
   *
   * v1 treated every punt identically — subtract 0–8 yards and spot the ball —
   * so a punt was the most predictable snap in the game and the receiving team
   * could neither be pinned at its own 3 nor take one back. This models the
   * part where the variance actually lives, and leaves the kick itself alone.
   *
   * Implies `returnStats`: the return is written down, because under this gate
   * there is a real return to write.
   */
  puntReturns?: boolean;
}
