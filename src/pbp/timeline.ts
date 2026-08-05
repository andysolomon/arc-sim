import type { PbpParticipant, PbpParticipantRole, PbpPlay } from "./types.js";

/*
 * Per-play event timeline (A7) — the seam a renderer consumes.
 *
 * ## What this is
 *
 * `PbpPlay` says WHAT happened: a 6-yard rush, tackled by the Mike. A renderer
 * needs WHEN, in order, so it can choreograph four seconds of motion. This
 * module turns one play into that ordered timeline.
 *
 * ## What this is NOT
 *
 * It is not more simulation. The engine does not model a dropback, a route, or
 * a ball in flight, and this module does not add one — it lays out a plausible
 * sequence that is CONSISTENT with the outcome the engine already produced.
 * Two consequences, both load-bearing:
 *
 * 1. **It draws no randomness.** `playTimeline` is a pure function of the play,
 *    so enabling `features.timeline` adds data to a log without changing a
 *    single outcome in it. That is stronger than the usual gate contract (no
 *    draws when OFF) and it is what makes the events safe to attach to a game
 *    that has already been played: same seed, same game, plus events.
 *
 * 2. **Derived sub-play detail is an estimate, and is marked as one.** Air
 *    yards versus yards after catch is the clearest case: the engine produces
 *    one number for a completion, so the split here is a presentation choice
 *    (see `completionAirYards`). Do not derive a stat from it. `deriveStatLines`
 *    reads plays, never events, and it should stay that way.
 *
 * ## Frame of reference
 *
 * Every `spot` is yards from the OFFENSE's own goal line, 0–100 — the same
 * frame as `PbpPlay.fieldPosition`, so a renderer converts once. On a kickoff
 * or punt the "offense" is the kicking team, which is how `PbpPlay` already
 * labels those.
 */

export type PbpSimEventType =
  /** The ball is snapped. `t: 0` on every scrimmage play. */
  | "snap"
  /** Handed off to the ball carrier. */
  | "handoff"
  /** The ball leaves the passer's hand. */
  | "pass_release"
  /** Caught. On a two-point try this is the conversion itself. */
  | "catch"
  /** The pass hit the turf. Also a spike. */
  | "incompletion"
  /** Picked off, at the spot the defender caught it. */
  | "interception"
  /** The passer went down behind the line. */
  | "sack"
  /** The ball came loose. */
  | "fumble"
  /** A loose ball was secured — by either side; read `teamId`. */
  | "recovery"
  /** A returner has the ball and is heading the other way. */
  | "return_start"
  /** The ball leaves the kicker's foot. */
  | "kick"
  /**
   * The kick is resolved: through the uprights, or the ball dead at `spot`.
   * Whether it was good is on `PbpPlay.playType`, not here.
   */
  | "kick_result"
  /** The carrier is down. `playerId` is the tackler when the engine named one. */
  | "tackle"
  /** Six points, at the goal line the scoring team was attacking. */
  | "touchdown"
  /** Two points to the defense. */
  | "safety"
  /** A flag is on the ground. Its disposition is on `PbpPlay.penalty`. */
  | "flag"
  /** A player is hurt. Details are on `PbpPlay.injury`. */
  | "injury"
  /** The play is over. Always the last event, and defines the play's duration. */
  | "whistle";

export interface PbpSimEvent {
  /**
   * Seconds from the snap. Non-decreasing across a play's events.
   *
   * Synthetic — see the module header. It is a plausible schedule, not a
   * measurement, and a renderer is free to scale it.
   */
  t: number;
  type: PbpSimEventType;
  /**
   * Who this happened to or by, when the engine named someone.
   *
   * Absent means the engine did not model a player for this beat — an
   * interception return has no named tackler, for instance. It does NOT mean
   * nobody was involved, so render it as unattributed rather than inventing a
   * name.
   */
  playerId?: string;
  teamId?: string;
  /**
   * Where the ball is, in yards from the offense's own goal line (0–100).
   *
   * Absent on beats that are not about a location (a flag, an injury).
   */
  spot?: number;
}

/*
 * ── Timing model ──────────────────────────────────────────────────────────
 *
 * Speeds and delays, in yards per second and seconds. These are the only
 * "physics" in the package and they exist purely so the beats land in a
 * believable order. Tuning them changes how a play LOOKS and nothing else.
 */
const CARRIER_SPEED = 8;
const PASS_SPEED = 25;
const PLACEKICK_SPEED = 30;
const SNAP_TO_HANDOFF = 0.9;
const SNAP_TO_KICK = 1.3;
const RELEASE_BASE = 1.4;
const RELEASE_PER_AIR_YARD = 0.045;
const SACK_TIME = 2.2;
const CATCH_TO_RUN = 0.25;
const RECOVERY_DELAY = 0.6;
const KICKOFF_HANG = 2.6;
const PUNT_HANG_BASE = 2;
const FLAG_TIME = 0.5;
const WHISTLE_TAIL = 0.6;
/** How deep the passer holds the ball, and how far back a kick is spotted. */
const POCKET_DEPTH = 5;
const KICK_SPOT_DEPTH = 7;
/** Where a kickoff is fielded, in the RECEIVING team's frame. */
const KICKOFF_FIELDED_AT = 3;

/*
 * The engine's kickoff spot clamp, shared rather than duplicated.
 *
 * `doKickoff` rolls a raw return number and clamps it to a starting yard line;
 * the raw number is what lands in `yardsGained`, so a timeline built from the
 * play alone has to apply the same clamp to know where the returner was
 * stopped. Two copies of that bound would drift, and the drift would show up as
 * a returner running through the tackler.
 */
export const KICK_RETURN_SPOT_MIN = 15;
export const KICK_RETURN_SPOT_MAX = 40;

/** Where a kickoff return ends, in the RECEIVING team's frame. */
export function kickReturnSpot(rawReturnYards: number): number {
  return Math.max(
    KICK_RETURN_SPOT_MIN,
    Math.min(KICK_RETURN_SPOT_MAX, rawReturnYards),
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Two decimals, so a serialized log stays compact and stable. */
function at(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

/** One decimal, and never off the field. */
function spotAt(yardLine: number): number {
  return Math.round(clamp(yardLine, 0, 100) * 10) / 10;
}

function find(
  play: PbpPlay,
  role: PbpParticipantRole,
): PbpParticipant | undefined {
  return play.participants.find((p) => p.role === role);
}

/**
 * How far the ball travelled in the air on a completion. **Estimated.**
 *
 * The engine produces one number for a completed pass; the air/YAC split it
 * implies does not exist upstream. 70% air is a flat convention chosen because
 * it keeps short completions in front of the sticks and puts a chunk of an
 * explosive play in the receiver's hands, which is what the two look like. It
 * is a drawing instruction, not a statistic.
 */
function completionAirYards(play: PbpPlay): number {
  const gained = play.yardsGained;
  // A screen or a checkdown behind the line: all of it is air, none is YAC.
  if (gained <= 0) return gained;
  return Math.min(gained, Math.max(1, Math.round(gained * 0.7)));
}

/**
 * How far downfield an unsuccessful attempt was thrown. **Estimated.**
 *
 * Nothing survives an incompletion or an interception to say where it was
 * aimed, so this reads the situation instead: you throw past the sticks. Only
 * ever used to place the ball for the renderer.
 */
function attemptAirYards(play: PbpPlay): number {
  const toGoal = 100 - play.fieldPosition;
  return clamp(play.distance + 3, 3, Math.max(3, toGoal));
}

function carryTime(yards: number): number {
  return Math.max(0.35, Math.abs(yards) / CARRIER_SPEED);
}

/**
 * The ordered beats of one play.
 *
 * Pure: same play in, same events out, no randomness, nothing read from the
 * game around it. That is what lets it run over a stored log years later.
 *
 * Returns `[]` for a play with nothing to show — a timeout is a stoppage, and
 * an empty timeline says so honestly rather than inventing a beat for it.
 */
export function playTimeline(play: PbpPlay): PbpSimEvent[] {
  const events = coreEvents(play);
  if (events.length === 0) return [];

  if (play.penalty) {
    const last = events[events.length - 1].t;
    events.push({
      t: at(Math.min(FLAG_TIME, last)),
      type: "flag",
      teamId: play.penalty.onOffense ? play.offenseTeamId : play.defenseTeamId,
    });
  }

  // Stable by specification (ES2019), so beats sharing a `t` keep the order
  // they were built in — a fumble stays ahead of the recovery that follows it.
  events.sort((a, b) => a.t - b.t);

  const lastT = events[events.length - 1].t;

  if (play.injury) {
    events.push({
      t: lastT,
      type: "injury",
      playerId: play.injury.playerId,
      teamId: play.injury.teamId,
    });
  }

  events.push({ t: at(lastT + WHISTLE_TAIL), type: "whistle" });
  return events;
}

function coreEvents(play: PbpPlay): PbpSimEvent[] {
  const los = play.fieldPosition;
  const offense = play.offenseTeamId;
  const defense = play.defenseTeamId;
  const snap: PbpSimEvent = { t: 0, type: "snap", spot: spotAt(los) };

  switch (play.playType) {
    case "rush":
      return rushEvents(play, snap);

    case "pass_complete":
      return completionEvents(play, snap);

    case "pass_incomplete": {
      const air = attemptAirYards(play);
      const release = at(RELEASE_BASE + air * RELEASE_PER_AIR_YARD);
      const target = find(play, "receiver");
      return [
        snap,
        {
          t: release,
          type: "pass_release",
          playerId: find(play, "passer")?.playerId,
          teamId: offense,
          spot: spotAt(los - POCKET_DEPTH),
        },
        {
          t: at(release + Math.max(0.3, air / PASS_SPEED)),
          type: "incompletion",
          // The intended target, not the defender who broke it up — the ball
          // goes where it was thrown either way, and the defender is on
          // `participants` for anyone who needs him.
          playerId: target?.playerId,
          teamId: target ? offense : undefined,
          spot: spotAt(los + air),
        },
      ];
    }

    case "sack":
      return sackEvents(play, snap);

    case "interception":
      return interceptionEvents(play, snap);

    case "kickoff":
      return kickoffEvents(play);

    case "onside_kick": {
      const kick = at(SNAP_TO_KICK);
      return [
        {
          t: kick,
          type: "kick",
          playerId: find(play, "kicker")?.playerId,
          teamId: offense,
          spot: spotAt(los),
        },
        {
          t: at(kick + 1.4),
          type: "recovery",
          // `isTurnover` is false exactly when the kicking team got it back,
          // which is the whole point of trying one.
          teamId: play.isTurnover ? defense : offense,
          spot: spotAt(los + play.yardsGained),
        },
      ];
    }

    case "punt":
      return puntEvents(play, snap);

    case "field_goal":
    case "field_goal_miss":
    case "extra_point":
    case "extra_point_miss":
      return placekickEvents(play, snap);

    case "two_point_convert":
    case "two_point_fail": {
      const release = at(RELEASE_BASE);
      return [
        snap,
        {
          t: release,
          type: "pass_release",
          playerId: find(play, "passer")?.playerId,
          teamId: offense,
          spot: spotAt(los - POCKET_DEPTH),
        },
        {
          t: at(release + 0.5),
          type: play.playType === "two_point_convert" ? "catch" : "incompletion",
          playerId: find(play, "receiver")?.playerId,
          teamId: offense,
          spot: 100,
        },
      ];
    }

    case "kneel": {
      const kneeler = find(play, "rusher");
      return [
        { ...snap, playerId: kneeler?.playerId, teamId: offense },
        {
          t: 1.2,
          type: "tackle",
          playerId: kneeler?.playerId,
          teamId: offense,
          spot: spotAt(los + play.yardsGained),
        },
      ];
    }

    case "spike":
      return [
        snap,
        { t: 0.9, type: "incompletion", teamId: offense, spot: spotAt(los) },
      ];

    case "safety":
      /*
       * The safety is its own play, emitted after the snap that caused it, so
       * it has no snap of its own — the tackle already happened on the previous
       * play. One beat, at the goal line.
       */
      return [
        {
          t: 0,
          type: "safety",
          playerId: find(play, "tackler_solo")?.playerId,
          teamId: defense,
          spot: 0,
        },
      ];

    case "penalty":
      // A standalone flag: the engine attaches penalties to the play they
      // happened on, so this is only reached by a log that recorded one on its
      // own. `playTimeline` adds the flag beat itself.
      return [snap];

    case "timeout":
      return [];
  }
}

function rushEvents(play: PbpPlay, snap: PbpSimEvent): PbpSimEvent[] {
  const los = play.fieldPosition;
  const carrier = find(play, "rusher");
  const handoff = at(SNAP_TO_HANDOFF);
  const end = at(SNAP_TO_HANDOFF + carryTime(play.yardsGained));
  const endSpot = spotAt(los + play.yardsGained);

  const events: PbpSimEvent[] = [
    snap,
    {
      t: handoff,
      type: "handoff",
      playerId: carrier?.playerId,
      teamId: play.offenseTeamId,
      spot: spotAt(los - 3),
    },
  ];

  const fumbler = find(play, "fumbler");
  if (fumbler) {
    const recoverer = find(play, "recoverer");
    events.push({
      t: end,
      type: "fumble",
      playerId: fumbler.playerId,
      teamId: fumbler.teamId,
      spot: endSpot,
    });
    events.push({
      t: at(end + RECOVERY_DELAY),
      type: "recovery",
      playerId: recoverer?.playerId,
      teamId: recoverer?.teamId,
      spot: endSpot,
    });
    return events;
  }

  events.push(endOfCarry(play, end, endSpot));
  return events;
}

function completionEvents(play: PbpPlay, snap: PbpSimEvent): PbpSimEvent[] {
  const los = play.fieldPosition;
  const air = completionAirYards(play);
  const release = at(RELEASE_BASE + Math.max(0, air) * RELEASE_PER_AIR_YARD);
  const catchAt = at(release + Math.max(0.3, Math.abs(air) / PASS_SPEED));
  const catchSpot = spotAt(los + air);
  const receiver = find(play, "receiver");
  const yac = play.yardsGained - air;
  const end = at(catchAt + (yac > 0 ? CATCH_TO_RUN + carryTime(yac) : 0.2));
  const endSpot = spotAt(los + play.yardsGained);

  return [
    snap,
    {
      t: release,
      type: "pass_release",
      playerId: find(play, "passer")?.playerId,
      teamId: play.offenseTeamId,
      spot: spotAt(los - POCKET_DEPTH),
    },
    {
      t: catchAt,
      type: "catch",
      playerId: receiver?.playerId,
      teamId: play.offenseTeamId,
      spot: catchSpot,
    },
    endOfCarry(play, end, endSpot),
  ];
}

function sackEvents(play: PbpPlay, snap: PbpSimEvent): PbpSimEvent[] {
  const sacker = find(play, "sacker");
  const endSpot = spotAt(play.fieldPosition + play.yardsGained);
  const events: PbpSimEvent[] = [
    snap,
    {
      t: SACK_TIME,
      type: "sack",
      playerId: sacker?.playerId,
      teamId: play.defenseTeamId,
      spot: endSpot,
    },
  ];

  // Strip-sack: the passer is also listed as the fumbler (`scoringV2`).
  const fumbler = find(play, "fumbler");
  if (fumbler) {
    const recoverer = find(play, "recoverer");
    events.push({
      t: at(SACK_TIME + 0.1),
      type: "fumble",
      playerId: fumbler.playerId,
      teamId: fumbler.teamId,
      spot: endSpot,
    });
    events.push({
      t: at(SACK_TIME + 0.1 + RECOVERY_DELAY),
      type: "recovery",
      playerId: recoverer?.playerId,
      teamId: recoverer?.teamId,
      spot: endSpot,
    });
  }
  return events;
}

function interceptionEvents(play: PbpPlay, snap: PbpSimEvent): PbpSimEvent[] {
  const los = play.fieldPosition;
  const air = attemptAirYards(play);
  const release = at(RELEASE_BASE + air * RELEASE_PER_AIR_YARD);
  const caught = at(release + Math.max(0.3, air / PASS_SPEED));
  const catchSpot = spotAt(los + air);
  const interceptor = find(play, "interceptor");
  /*
   * `returnYards` is only written under `scoringV2`; on a gated-off log the
   * same number is in `yardsGained`, which is where v1 put it. Reading both
   * means the timeline works on either.
   */
  const returned = play.returnYards ?? play.yardsGained;
  const end = at(caught + 0.3 + carryTime(returned));
  // The defense runs the other way, so the ball moves back toward the
  // offense's own goal line — down in this frame, not up.
  const endSpot = spotAt(catchSpot - returned);

  const events: PbpSimEvent[] = [
    snap,
    {
      t: release,
      type: "pass_release",
      playerId: find(play, "passer")?.playerId,
      teamId: play.offenseTeamId,
      spot: spotAt(los - POCKET_DEPTH),
    },
    {
      t: caught,
      type: "interception",
      playerId: interceptor?.playerId,
      teamId: play.defenseTeamId,
      spot: catchSpot,
    },
    {
      t: at(caught + 0.3),
      type: "return_start",
      playerId: interceptor?.playerId,
      teamId: play.defenseTeamId,
      spot: catchSpot,
    },
  ];

  if (play.isReturnTd) {
    events.push({
      t: end,
      type: "touchdown",
      playerId: interceptor?.playerId,
      teamId: play.defenseTeamId,
      // The defense scores at the goal line the offense was defending.
      spot: 0,
    });
  } else {
    events.push({
      t: end,
      // Nobody is credited with this tackle — the engine names no tackler on an
      // interception, and guessing one would put a name in a box score that
      // never earned it.
      type: "tackle",
      spot: endSpot,
    });
  }
  return events;
}

function kickoffEvents(play: PbpPlay): PbpSimEvent[] {
  const los = play.fieldPosition;
  const fielded = spotAt(100 - KICKOFF_FIELDED_AT);
  const endSpot = spotAt(100 - kickReturnSpot(play.yardsGained));
  const landed = at(SNAP_TO_KICK + KICKOFF_HANG);
  const returner = find(play, "returner");

  return [
    {
      t: at(SNAP_TO_KICK),
      type: "kick",
      playerId: find(play, "kicker")?.playerId,
      teamId: play.offenseTeamId,
      spot: spotAt(los),
    },
    {
      t: landed,
      type: "return_start",
      playerId: returner?.playerId,
      teamId: play.defenseTeamId,
      spot: fielded,
    },
    {
      t: at(landed + carryTime(fielded - endSpot)),
      type: "tackle",
      teamId: play.offenseTeamId,
      spot: endSpot,
    },
  ];
}

function puntEvents(play: PbpPlay, snap: PbpSimEvent): PbpSimEvent[] {
  const net = play.yardsGained;
  const landing = spotAt(play.fieldPosition + net);
  const kick = at(SNAP_TO_KICK);
  const returner = find(play, "returner");

  /*
   * The engine models a punt as NET yards — gross minus a return, resolved in
   * one number. So the timeline shows the ball arriving where the next drive
   * starts rather than staging a hang-and-return the engine never simulated.
   * The returner is still named, because he is named on the play.
   */
  return [
    snap,
    {
      t: kick,
      type: "kick",
      playerId: find(play, "kicker")?.playerId,
      teamId: play.offenseTeamId,
      spot: spotAt(play.fieldPosition - KICK_SPOT_DEPTH),
    },
    {
      t: at(kick + PUNT_HANG_BASE + Math.abs(net) / PASS_SPEED),
      type: "kick_result",
      playerId: returner?.playerId,
      teamId: returner ? play.defenseTeamId : undefined,
      spot: landing,
    },
  ];
}

function placekickEvents(play: PbpPlay, snap: PbpSimEvent): PbpSimEvent[] {
  const kicker = find(play, "kicker");
  const kick = at(SNAP_TO_KICK);
  // Uprights sit 17 yards behind the goal line: 10 of end zone, 7 of snap.
  const flight = 100 - play.fieldPosition + 17;

  return [
    snap,
    {
      t: kick,
      type: "kick",
      playerId: kicker?.playerId,
      teamId: play.offenseTeamId,
      spot: spotAt(play.fieldPosition - KICK_SPOT_DEPTH),
    },
    {
      t: at(kick + flight / PLACEKICK_SPEED),
      type: "kick_result",
      playerId: kicker?.playerId,
      teamId: play.offenseTeamId,
      spot: 100,
    },
  ];
}

/** How a carry finished: in the end zone, or on the ground. */
function endOfCarry(play: PbpPlay, t: number, endSpot: number): PbpSimEvent {
  if (play.isScoring && play.pointsScored === 6) {
    const scorer = find(play, "receiver") ?? find(play, "rusher");
    return {
      t,
      type: "touchdown",
      playerId: scorer?.playerId,
      teamId: play.offenseTeamId,
      spot: 100,
    };
  }
  const tackler = find(play, "tackler_solo");
  return {
    t,
    type: "tackle",
    playerId: tackler?.playerId,
    teamId: tackler?.teamId,
    /*
     * Capped at the 99, because that is where the engine actually spots it.
     * A rush can gain past the goal line WITHOUT scoring — `doRush` rolls for
     * the touchdown separately and `applyPlayResult` then clamps the ball to
     * the 99 — so a timeline that took `yardsGained` at face value would walk
     * the carrier into an end zone he never reached and leave him there while
     * the next snap happens a yard outside it.
     */
    spot: spotAt(Math.min(endSpot, 99)),
  };
}
