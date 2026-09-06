import { mulberry32 } from "../rng/index.js";
import {
  DEFAULT_SIMULATION_FLAVOR,
  normalizeSimulationFlavor,
  weightsForFlavor,
} from "../flavor/index.js";
import { acceptOrDecline, meanAwareness, rollPenalty } from "./penalties.js";
import {
  chargeSnap,
  effectiveOverall,
  snapCost,
  staminaDecay,
  staminaFor,
  substitutionCandidate,
  type SnapLedger,
} from "./fatigue.js";
import { contactFactor, rollInjury } from "./injuries.js";
import {
  NEUTRAL_AGGRESSION,
  clockStrategy,
  fourthDownDecision,
  runoffSeconds,
  secondsLeftInGame,
  secondsLeftInHalf,
  shouldOnside,
  shouldSpike,
  shouldUseTimeout,
  type ClockStrategy,
} from "./situational.js";
import { homeFieldEdge as crowdHomeFieldEdge } from "./crowd.js";
import {
  NEUTRAL_SCHEME_MODIFIERS,
  layerSchemeModifiers,
  schemeModifiers,
  type SchemeModifiers,
} from "./schemes.js";
import {
  gameplanModifiers,
  isGameplanFocus,
} from "../schemes/gameplan.js";
import {
  NEUTRAL_MODIFIERS,
  weatherModifiers,
  type WeatherModifiers,
} from "./weather.js";
import { kickReturnSpot, playTimeline } from "./timeline.js";
import type {
  GameInjury,
  PbpFeatureGates,
  PbpDrive,
  PbpDriveEndReason,
  PbpGameInput,
  PbpGameLog,
  PbpParticipant,
  PbpParticipantRole,
  PbpPlay,
  PbpPlayType,
  PlayerSimProfile,
  SimPositionGroup,
  TeamSimProfile,
} from "./types.js";

const QUARTER_SECONDS = 720;
const OT_SECONDS = 300;
const HOME_FIELD_EDGE = 2.5;
/*
 * Recalibrated home-field weight (A3, gated by `features.balance`; issue #642).
 *
 * The 2.5 above is not "2.5 points" — it is a strength bonus that flows into
 * `matchupEdge`, which then biases explosive-play rate, yardage, touchdown
 * probability, completion rate, sack rate, interception rate, field-goal
 * accuracy, kick returns and punt distance. Eight channels, every play. The
 * measured result was a 6.2-point average margin and a 67.3% home win rate for
 * two identical rosters, which is not a nudge, it is a decision.
 *
 * The constant is scaled down until the OUTPUT matches what the input claims.
 * `scripts/dist-check.ts` is the instrument; re-run it if you touch this.
 */
const HOME_FIELD_EDGE_V2 = 0.75;
const BASELINE_STRENGTH = 50;

/** HS overtime: one timeout per period, not the three a half carries. */
const TIMEOUTS_PER_HALF = 3;
const TIMEOUTS_PER_OVERTIME = 1;

const POSITION_TO_GROUP: Record<string, SimPositionGroup> = {
  QB: "QB",
  HB: "RB",
  RB: "RB",
  FB: "RB",
  WR: "WR",
  TE: "TE",
  OL: "OL",
  OT: "OL",
  OG: "OL",
  C: "OL",
  G: "OL",
  T: "OL",
  LT: "OL",
  LG: "OL",
  RG: "OL",
  RT: "OL",
  DE: "DL",
  DT: "DL",
  NT: "DL",
  EDGE: "DL",
  DL: "DL",
  OLB: "LB",
  MLB: "LB",
  ILB: "LB",
  LB: "LB",
  CB: "DB",
  S: "DB",
  FS: "DB",
  SS: "DB",
  NB: "DB",
  DB: "DB",
  K: "K",
  P: "P",
};

interface GameState {
  rand: () => number;
  /*
   * v2 mechanics (Epic A). EVERY branch guarded by one of these must consume
   * ZERO random draws when the gate is off — the PRNG is a sequence, so one
   * stray `rand()` shifts every later draw and the log diverges from v1. The
   * golden-parity test exists to catch exactly that.
   */
  features: Required<PbpFeatureGates>;
  /** Accumulated snap cost per player for this game (A4). */
  snaps: SnapLedger;
  /** Players whose game ended through injury (A4). */
  unavailable: Set<string>;
  /** Injuries sustained in this game, in order (A4). */
  injuries: GameInjury[];
  /** League severity dial, 0 disables injuries entirely (A4). */
  injurySeverityScale: number;
  home: TeamSimProfile;
  away: TeamSimProfile;
  strengthWeight: number;
  edgeScale: number;
  /** `HOME_FIELD_EDGE`, or the recalibrated value under `features.balance`. */
  homeFieldEdge: number;
  /**
   * Weather multipliers (A5), or `NEUTRAL_MODIFIERS` when the gate is off.
   *
   * Held as resolved multipliers rather than as the `Weather` itself so the
   * play functions multiply unconditionally instead of branching. Every neutral
   * value is exactly 1, and multiplying by 1 is exact in floating point, so the
   * gate-off path is bit-identical to v1 without a single `if`.
   */
  weatherMods: WeatherModifiers;
  /**
   * Scheme multipliers (A6), one per possession side.
   *
   * TWO of them, unlike weather: a matchup is asymmetric. When the home team
   * has the ball the modifiers come from the home offense against the away
   * defense, and vice versa — so a team can run an Air Raid and a 46 without
   * the two interfering.
   *
   * Resolved once at kickoff and, like `weatherMods`, held as multipliers so
   * the play functions apply them unconditionally. Every neutral value is
   * exactly 1 (or 0 for the additive term), so the gate-off path is bit-
   * identical to pre-A6 without a branch.
   */
  homeSchemeMods: SchemeModifiers;
  awaySchemeMods: SchemeModifiers;
  decisive: boolean;
  quarter: number;
  clockSeconds: number;
  possession: "home" | "away";
  down: number;
  distance: number;
  fieldPosition: number;
  homeScore: number;
  awayScore: number;
  drives: PbpDrive[];
  currentDrivePlays: PbpPlay[];
  currentDriveTeamId: string | null;
  driveStartQuarter: number;
  driveStartClock: number;
  driveStartField: number;
  driveId: number;
  playId: number;
  inOvertime: boolean;
  otPeriod: number;
  gameOver: boolean;
  openingKickDone: boolean;
  secondHalfKickPending: boolean;
  /*
   * ── A3 clock and timeout state ──────────────────────────────────────────
   *
   * Only read inside `features.situational` branches. They are always present
   * on the state (rather than optional) so the type stays simple; when the gate
   * is off nothing reads them and nothing writes them except the resets.
   */
  homeTimeouts: number;
  awayTimeouts: number;
  /**
   * Did the last play leave the clock stopped?
   *
   * This is what makes a timeout physical rather than a resource dump: you can
   * only spend one while the clock is actually running, so a team cannot burn
   * all three between two snaps.
   */
  clockStopped: boolean;
  /**
   * Tempo to stamp on the next recorded play, or null.
   *
   * Set just before a play runs rather than patched on afterwards, because a
   * scoring play calls `endDrive` and moves itself out of `currentDrivePlays` —
   * so there is no reliable index to write back to once the play has happened.
   */
  pendingTempo: "hurry_up" | "burn" | null;
}

function positionGroup(position: string): SimPositionGroup | null {
  return POSITION_TO_GROUP[position.trim().toUpperCase()] ?? null;
}

function offenseTeam(state: GameState): TeamSimProfile {
  return state.possession === "home" ? state.home : state.away;
}

function defenseTeam(state: GameState): TeamSimProfile {
  return state.possession === "home" ? state.away : state.home;
}

/** Scheme modifiers for whoever currently has the ball (A6). */
function schemeMods(state: GameState): SchemeModifiers {
  return state.possession === "home"
    ? state.homeSchemeMods
    : state.awaySchemeMods;
}

function possessionSchemeModifiers(
  offense: TeamSimProfile,
  defense: TeamSimProfile,
  schemesEnabled: boolean,
): SchemeModifiers {
  if (!schemesEnabled) return NEUTRAL_SCHEME_MODIFIERS;
  const base = schemeModifiers(offense.scheme, defense.scheme);
  const focus = offense.gameplan;
  if (!focus || !isGameplanFocus(focus)) return base;
  const weekly = gameplanModifiers(focus, {
    defenseScheme: defense.scheme?.defense,
  });
  return layerSchemeModifiers(base, weekly);
}

function offenseTeamId(state: GameState): string {
  return offenseTeam(state).teamId;
}

function defenseTeamId(state: GameState): string {
  return defenseTeam(state).teamId;
}

function effectiveStrength(
  team: TeamSimProfile,
  isHome: boolean,
  oppStrength: number,
  strengthWeight: number,
  homeFieldEdge: number,
): number {
  const homeEdge = isHome ? homeFieldEdge / strengthWeight : 0;
  return team.strength + (team.strength - oppStrength) * 0.15 + homeEdge;
}

/**
 * The strength differential, signed from `side`'s point of view.
 *
 * Named separately from `matchupEdge` because a kickoff has no offense in the
 * sense the rest of the engine means: `state.possession` at that moment is
 * whoever had the ball last, which is the kicking team after a score and the
 * RECEIVING team at the start of a half. v1 read `matchupEdge` there anyway, so
 * the sign of the return bonus flipped depending on how the kickoff came about
 * — harmless in v1 only because nobody looked. Anything new asks for the side
 * it means.
 */
function edgeFrom(state: GameState, side: "home" | "away"): number {
  const us = side === "home" ? state.home : state.away;
  const them = side === "home" ? state.away : state.home;
  const usIsHome = side === "home";
  const usEff = effectiveStrength(
    us,
    usIsHome,
    them.strength,
    state.strengthWeight,
    state.homeFieldEdge,
  );
  const themEff = effectiveStrength(
    them,
    !usIsHome,
    us.strength,
    state.strengthWeight,
    state.homeFieldEdge,
  );
  return ((usEff - themEff) / 99) * state.edgeScale;
}

function matchupEdge(state: GameState): number {
  return edgeFrom(state, state.possession);
}

/*
 * ── A3 situational helpers ──────────────────────────────────────────────────
 */

/** Score from the possessing team's point of view. */
function offenseScoreDiff(state: GameState): number {
  return state.possession === "home"
    ? state.homeScore - state.awayScore
    : state.awayScore - state.homeScore;
}

function coachAggression(team: TeamSimProfile): number {
  const value = team.coach?.aggression;
  return typeof value === "number" ? value : NEUTRAL_AGGRESSION;
}

function timeoutsFor(state: GameState, side: "home" | "away"): number {
  return side === "home" ? state.homeTimeouts : state.awayTimeouts;
}

function spendTimeout(state: GameState, side: "home" | "away"): void {
  if (side === "home") state.homeTimeouts = Math.max(0, state.homeTimeouts - 1);
  else state.awayTimeouts = Math.max(0, state.awayTimeouts - 1);
}

function currentClockStrategy(state: GameState): ClockStrategy {
  return clockStrategy({
    scoreDiff: offenseScoreDiff(state),
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    isOvertime: state.inOvertime,
  });
}

/**
 * Charge the clock for a single play.
 *
 * With the gate off this is v1 verbatim — one draw, same expression, same
 * range — so parity is untouched. With it on, the SAME single draw becomes the
 * snap-to-whistle duration only, and the huddle and play clock that follow are
 * charged separately (and skipped entirely when the clock stops). Keeping the
 * draw count identical either way means enabling `situational` changes how long
 * plays take without changing which plays happen for a given sequence position.
 */
function tickPlayClock(
  state: GameState,
  base: number,
  spread: number,
  stopsClock: boolean,
): void {
  const roll = state.rand();
  if (!state.features.situational) {
    tickClock(state, Math.round(base + roll * spread));
    return;
  }
  state.clockStopped = stopsClock;
  tickClock(state, Math.round(4 + roll * 5));
}

/** Clock charge for a play with no random component (kicks, kneels). */
function tickFixedClock(
  state: GameState,
  v1Seconds: number,
  v2Seconds: number,
  stopsClock: boolean,
): void {
  if (!state.features.situational) {
    tickClock(state, v1Seconds);
    return;
  }
  state.clockStopped = stopsClock;
  tickClock(state, v2Seconds);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function weightedPick(
  players: PlayerSimProfile[],
  rand: () => number,
): PlayerSimProfile {
  const weights = players.map((p) => Math.max(1, p.overall));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < players.length; i++) {
    r -= weights[i];
    if (r <= 0) return players[i];
  }
  return players[players.length - 1];
}

function playersInGroup(
  team: TeamSimProfile,
  group: SimPositionGroup,
  unavailable?: ReadonlySet<string>,
): PlayerSimProfile[] {
  return team.players
    .filter((p) => positionGroup(p.position) === group)
    // A player whose game ended cannot take another snap (A4).
    .filter((p) => !unavailable?.has(p.playerId))
    .sort((a, b) => {
      const da = a.depthRank ?? 99;
      const db = b.depthRank ?? 99;
      if (da !== db) return da - db;
      return b.overall - a.overall;
    });
}

/**
 * Stand-ins for a position group the roster does not carry.
 *
 * `selectPlayer` has always invented a 50-overall nobody when a group is
 * empty, so a roster with no punter still punts. The `matchups` gate is the
 * first thing to READ a selected player's rating against another's, and a
 * stand-in must not be read: a roster with no offensive line has not fielded
 * a bad one, it has said nothing, and the matchup is neutral. Tracked here
 * rather than by a marker field, so the stand-in stays a plain profile.
 */
const PLACEHOLDERS = new WeakSet<PlayerSimProfile>();

function isPlaceholder(player: PlayerSimProfile): boolean {
  return PLACEHOLDERS.has(player);
}

/*
 * Takes the whole `state`, not just `rand` (A4).
 *
 * Selection now depends on who is still standing and how tired they are, both
 * of which live on the state. Threading them as extra optional arguments left
 * every existing call site silently opting out — which is exactly what happened
 * on the first attempt, and injured players kept taking snaps.
 */
function selectPlayer(
  team: TeamSimProfile,
  group: SimPositionGroup,
  state: GameState,
  distribute = false,
): PlayerSimProfile {
  const rand = state.rand;
  const candidates = playersInGroup(team, group, state.unavailable);
  if (candidates.length === 0) {
    const stand = {
      playerId: `${team.teamId}-unknown-${group}`,
      position: group,
      overall: BASELINE_STRENGTH,
    };
    PLACEHOLDERS.add(stand);
    return stand;
  }
  if (distribute && candidates.length > 1) {
    return weightedPick(candidates.slice(0, Math.min(4, candidates.length)), rand);
  }

  /*
   * A tired starter gets spelled — but only by someone who is actually better
   * right now (A4). `substitutionCandidate` returns null when the bench is
   * worse, so a team with no depth plays its exhausted starter, which is the
   * consequence this mechanic exists to create.
   *
   * Consumes no randomness, so it cannot shift the draw sequence.
   */
  if (state.features.injuries) {
    const relief = substitutionCandidate(candidates, (player) =>
      staminaFor(state.snaps, player),
    );
    if (relief) return relief;
  }
  return candidates[0];
}

function selectDefender(
  team: TeamSimProfile,
  state: GameState,
  kind: "tackle" | "sack" | "coverage",
): PlayerSimProfile {
  const weights =
    kind === "sack"
      ? { DL: 0.55, LB: 0.3, DB: 0.15 }
      : kind === "coverage"
        ? { DL: 0.1, LB: 0.25, DB: 0.65 }
        : { DL: 0.35, LB: 0.35, DB: 0.3 };
  const r = state.rand();
  let group: SimPositionGroup = "LB";
  if (r < weights.DL) group = "DL";
  else if (r < weights.DL + weights.LB) group = "LB";
  else group = "DB";
  return selectPlayer(team, group, state, true);
}

function participant(
  player: PlayerSimProfile,
  teamId: string,
  role: PbpParticipantRole,
): PbpParticipant {
  return { playerId: player.playerId, teamId, role };
}

function startDrive(
  state: GameState,
  teamId: string,
  fieldPosition: number,
): void {
  state.currentDriveTeamId = teamId;
  state.currentDrivePlays = [];
  state.driveStartQuarter = state.quarter;
  state.driveStartClock = state.clockSeconds;
  state.driveStartField = fieldPosition;
  state.down = 1;
  state.distance = 10;
  state.fieldPosition = fieldPosition;
}

function endDrive(state: GameState, reason: PbpDriveEndReason): void {
  if (state.currentDriveTeamId === null) return;
  state.drives.push({
    driveId: state.driveId,
    teamId: state.currentDriveTeamId,
    startQuarter: state.driveStartQuarter,
    startClockSeconds: state.driveStartClock,
    startFieldPosition: state.driveStartField,
    endReason: reason,
    plays: state.currentDrivePlays,
  });
  state.driveId += 1;
  state.currentDriveTeamId = null;
  state.currentDrivePlays = [];
}

/*
 * Fatigue and injury both hang off `recordPlay` (A4).
 *
 * It is the one choke point every play passes through, so charging snaps here
 * means no play type can be forgotten. The PRNG cost is a function of the play
 * TYPE only — three draws on a contact play, none otherwise — so the number of
 * draws depends on the sequence of plays and never on their outcomes. A roll
 * that cost draws only when someone got hurt would make every later play
 * depend on whether anyone did.
 */
function applyAttrition(state: GameState, play: PbpPlay): void {
  if (!state.features.injuries) return;

  const cost = snapCost(play.playType);
  for (const participant of play.participants) {
    chargeSnap(state.snaps, participant.playerId, cost);
  }

  if (contactFactor(play.playType) <= 0) return;
  if (play.participants.length === 0) return;

  const whoRoll = state.rand();
  const whetherRoll = state.rand();
  const severityRoll = state.rand();

  const victim =
    play.participants[
      Math.min(
        play.participants.length - 1,
        Math.floor(whoRoll * play.participants.length),
      )
    ];
  const profile = profileFor(state, victim.teamId, victim.playerId);

  const outcome = rollInjury({
    playType: play.playType,
    stamina: staminaDecay(
      state.snaps.get(victim.playerId) ?? 0,
      profile?.endurance,
    ),
    severityScale: state.injurySeverityScale,
    rolls: [whetherRoll, severityRoll],
  });
  if (!outcome) return;

  play.injury = {
    playerId: victim.playerId,
    teamId: victim.teamId,
    severity: outcome.severity,
    gamesOut: outcome.gamesOut,
    label: outcome.label,
  };
  state.injuries.push({
    playerId: victim.playerId,
    teamId: victim.teamId,
    severity: outcome.severity,
    gamesOut: outcome.gamesOut,
    label: outcome.label,
    quarter: play.quarter,
  });

  /*
   * Anything worse than a knock ends this player's game. That is what forces
   * the next man up and makes roster depth matter WITHIN a game, not only in
   * the weeks after it. A `minor` injury does not — he is shaken up and returns.
   */
  if (outcome.gamesOut > 0) state.unavailable.add(victim.playerId);
}

function profileFor(
  state: GameState,
  teamId: string,
  playerId: string,
): PlayerSimProfile | undefined {
  const team = state.home.teamId === teamId ? state.home : state.away;
  return team.players.find((p) => p.playerId === playerId);
}

function recordPlay(state: GameState, play: PbpPlay): void {
  /*
   * The scoreboard as this play began (A7).
   *
   * Written here rather than in each play function because `recordPlay` is the
   * one choke point every play passes through — and because it runs BEFORE the
   * result is applied, which is what makes the number "before" rather than
   * "after". The two plays that used to bank their points ahead of this call
   * (the two-point try and the safety) now bank them after it, for exactly
   * that reason. Costs no random draw.
   */
  if (state.features.timeline) {
    play.preSnap = {
      homeScore: state.homeScore,
      awayScore: state.awayScore,
      ...(state.features.situational
        ? { homeTimeouts: state.homeTimeouts, awayTimeouts: state.awayTimeouts }
        : {}),
    };
  }
  if (state.pendingTempo) {
    play.tempo = state.pendingTempo;
    // Stamp the snap itself, not the extra point and kickoff that a touchdown
    // pulls in behind it.
    state.pendingTempo = null;
  }
  applyAttrition(state, play);
  state.currentDrivePlays.push(play);
  state.playId += 1;
}

function tickClock(state: GameState, seconds: number): void {
  state.clockSeconds = Math.max(0, state.clockSeconds - seconds);
}

function flipPossession(state: GameState): void {
  state.possession = state.possession === "home" ? "away" : "home";
}

function yardsToGoal(state: GameState): number {
  return 100 - state.fieldPosition;
}

function shouldKneel(state: GameState): boolean {
  const winning =
    (state.possession === "home" && state.homeScore > state.awayScore) ||
    (state.possession === "away" && state.awayScore > state.homeScore);
  return winning && state.clockSeconds <= 120 && state.quarter >= 4;
}

/**
 * Refill timeouts.
 *
 * Called at the start of each half and each overtime period. It ASSIGNS rather
 * than adds, so unspent timeouts do not carry over — which is both the rule and
 * what keeps the per-half count exactly 3.
 */
function resetTimeouts(state: GameState, count: number): void {
  state.homeTimeouts = count;
  state.awayTimeouts = count;
}

function advanceQuarter(state: GameState): void {
  if (state.inOvertime) {
    state.otPeriod += 1;
    state.clockSeconds = OT_SECONDS;
    resetTimeouts(state, TIMEOUTS_PER_OVERTIME);
    return;
  }
  if (state.quarter === 2) {
    state.secondHalfKickPending = true;
    resetTimeouts(state, TIMEOUTS_PER_HALF);
  }
  state.quarter += 1;
  state.clockSeconds = QUARTER_SECONDS;
}

/**
 * Does the possession survive this period boundary (`quarterBreak` gate)?
 *
 * Only two boundaries in a football game leave the ball with the team that
 * had it: the ends of the first and third quarters. Everywhere else a kickoff
 * follows — halftime, overtime, and the end of the game, where nothing
 * follows at all — so the drive is genuinely over and the record should say so.
 *
 * With the gate off this is never asked, and the clock running out ends the
 * drive at every boundary alike, which is the v1 behavior: a new drive opens
 * at the same spot through `startDrive`, taking a fresh `down` and `distance`
 * with it.
 */
function quarterBreakContinues(state: GameState): boolean {
  if (!state.features.quarterBreak) return false;
  if (state.inOvertime) return false;
  return state.quarter === 1 || state.quarter === 3;
}

function checkPeriodEnd(state: GameState): void {
  if (state.clockSeconds > 0) return;

  /*
   * A drive left open here is one that continues into the next quarter. The
   * loop only calls `startDrive` when there is no drive in progress, so the
   * down, the distance and the drive record all carry over by NOT acting —
   * which is why this is one branch rather than a resume path.
   */
  if (
    state.currentDriveTeamId !== null &&
    state.currentDrivePlays.length > 0 &&
    !quarterBreakContinues(state)
  ) {
    endDrive(state, state.quarter === 4 && !state.inOvertime ? "end_of_game" : "end_of_half");
  }

  if (state.inOvertime) {
    if (!state.decisive || state.homeScore !== state.awayScore) {
      state.gameOver = true;
      return;
    }
    advanceQuarter(state);
    doKickoff(state, state.possession === "home" ? "away" : "home");
    return;
  }

  if (state.quarter >= 4) {
    if (state.decisive && state.homeScore === state.awayScore) {
      state.inOvertime = true;
      state.otPeriod = 1;
      state.quarter = 5;
      state.clockSeconds = OT_SECONDS;
      resetTimeouts(state, TIMEOUTS_PER_OVERTIME);
      doKickoff(state, state.possession === "home" ? "away" : "home");
      return;
    }
    state.gameOver = true;
    return;
  }

  advanceQuarter(state);
  if (state.secondHalfKickPending) {
    state.secondHalfKickPending = false;
    doKickoff(state, state.possession === "home" ? "away" : "home");
  }
}

/**
 * Onside kick (A3). Recovered, the kicking team keeps the ball at its own 45;
 * failed, the receiving team takes over there — a real cost, which is why
 * `shouldOnside` only says yes when giving the ball back loses anyway.
 */
function doOnsideKick(state: GameState, kicking: "home" | "away"): void {
  const kickingTeam = kicking === "home" ? state.home : state.away;
  const receiving = kicking === "home" ? state.away : state.home;
  const kicker = selectPlayer(kickingTeam, "K", state);
  const recovered = state.rand() < 0.15;

  startDrive(state, kickingTeam.teamId, 35);
  recordPlay(state, {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: kickingTeam.teamId,
    defenseTeamId: receiving.teamId,
    playType: "onside_kick",
    down: 0,
    distance: 0,
    fieldPosition: 35,
    yardsGained: 10,
    isScoring: false,
    pointsScored: 0,
    // A recovery means possession did NOT change hands, which is the whole
    // point of the play.
    isTurnover: !recovered,
    participants: [participant(kicker, kickingTeam.teamId, "kicker")],
  });
  tickFixedClock(state, 6, 6, true);
  endDrive(state, "turnover");

  if (recovered) {
    state.possession = kicking;
    startDrive(state, kickingTeam.teamId, 45);
  } else {
    state.possession = kicking === "home" ? "away" : "home";
    startDrive(state, receiving.teamId, 55);
  }
  state.openingKickDone = true;
}

/*
 * ── Kickoffs (`kickReturns` gate) ─────────────────────────────────────────
 *
 * v1 resolved the whole play with one roll. `18 + rand()*22 + edge*8`, clamped
 * to the 15-40, became BOTH the yard line the receiving team started on and
 * the yardage credited to the returner — so every kick was fielded, every one
 * was returned, nobody was ever pinned at the 6 or handed a touchback, and the
 * returner's box-score line was read off the drive's starting spot rather than
 * off anything he did. `isScoring` was written `false` unconditionally, which
 * made `krTd` unreachable.
 *
 * That is `returnStats` and `puntReturns` again, on the other kick. What
 * follows models the three facts separately: how far the kick carried, whether
 * it was brought out, and what the return got.
 */

/** Where a kickoff is spotted, in the kicking team's own frame. */
const KICKOFF_SPOT = 35;
/** ...and therefore how far the goal line is from the tee. */
const KICKOFF_TO_GOAL = 100 - KICKOFF_SPOT;
/** A kick that reaches the end zone comes out here, as a punt's does. */
const TOUCHBACK_SPOT = 20;

/**
 * How far a varsity kickoff carries.
 *
 * Uniform, like the punt's gross, and centred so that the goal line is at the
 * top of the range rather than the middle of it: a high-school leg reaches the
 * end zone sometimes, not usually, which is exactly why the return is still a
 * live play at this level and largely a formality in the professional game.
 */
const KICKOFF_BASE = 46;
const KICKOFF_SPAN = 23;

/**
 * A kick into the end zone that the returner brings out anyway.
 *
 * The kickoff's version of the fair-catch decision, and it cuts the opposite
 * way: a knee is worth the 20, so bringing it out is the aggressive choice and
 * it starts him on the goal line. Most returners take the 20, which is why the
 * rate is low — and why the choice only exists in the end zone. A ball that
 * comes down in the field of play is returned, because there is nothing else
 * to do with it.
 */
const BRING_OUT_RATE = 0.25;

/**
 * A return that gets past the last man.
 *
 * Its own branch rather than the tail of the yardage curve, for the reason the
 * punt gate gives: a return either gets bottled up or it is gone, and one
 * distribution stretched across both produces a drizzle of sixty-yard returns
 * that die at the 8. About one kickoff in 150 returns.
 */
const KICK_BREAKAWAY_RATE = 0.007;

/**
 * Ordinary return yardage.
 *
 * Less skewed than a punt return and with a much higher floor, because the
 * plays are not alike: a kick returner catches it running with the whole field
 * in front of him, where a punt returner catches it standing still with the
 * coverage already on top of him. A ten-yard kick return is a bad one; a
 * ten-yard punt return is a good one.
 */
const KICK_RETURN_FLOOR = 9;
const KICK_RETURN_SKEW = 1.7;
const KICK_RETURN_SPAN = 33;

function kickReturnDistance(
  state: GameState,
  edge: number,
  cap: number,
): number {
  const yards = Math.round(
    KICK_RETURN_FLOOR +
      Math.pow(state.rand(), KICK_RETURN_SKEW) * KICK_RETURN_SPAN +
      edge * 5,
  );
  // A fielded kick gains at least a yard: zero is not a short return, it is a
  // different event, and counting it as a return is what dragged the punt
  // gate's own numbers out of shape before its floor went in.
  return Math.min(cap, Math.max(1, yards));
}

function doKickoffWithReturn(state: GameState, kicking: "home" | "away"): void {
  const receivingSide = kicking === "home" ? "away" : "home";
  const kickingTeam = kicking === "home" ? state.home : state.away;
  const receiving = kicking === "home" ? state.away : state.home;
  const kicker = selectPlayer(kickingTeam, "K", state);
  const returner = selectPlayer(receiving, "RB", state, true);

  // Under `kickingGame` the leg moves the kick a few yards either way; the
  // matchup term is left as it was so the gate is additive, not a rewrite.
  const legYards = state.features.kickingGame ? leg(kicker) * 5 : 0;
  const carry = Math.round(
    (KICKOFF_BASE + state.rand() * KICKOFF_SPAN + edgeFrom(state, kicking) * 8 + legYards) *
      state.weatherMods.kickDistance,
  );
  /*
   * Where it comes down, in the RECEIVING team's frame — their own yard line.
   * Zero or less is the end zone. Everything after the kick reads more easily
   * from that side, because the ball is theirs now.
   */
  const catchSpot = KICKOFF_TO_GOAL - carry;

  /*
   * In the end zone he chooses; in the field of play he is returning it. A
   * touchback is therefore the only way a kickoff goes un-returned, which is
   * what lets `returnYards === 0` mean exactly one thing to every reader.
   */
  const inEndZone = catchSpot <= 0;
  const returning = !inEndZone || state.rand() < BRING_OUT_RATE;

  let returnYards = 0;
  let startSpot = TOUCHBACK_SPOT;
  if (returning) {
    // Out of the end zone he starts on the goal line, not at the spot the ball
    // came down — those yards are behind him and nobody is credited with them.
    const from = Math.max(0, catchSpot);
    returnYards =
      state.rand() < KICK_BREAKAWAY_RATE
        ? 100 - from
        : kickReturnDistance(state, edgeFrom(state, receivingSide), 100 - from);
    startSpot = from + returnYards;
  }
  const isReturnTd = startSpot >= 100;

  startDrive(state, kickingTeam.teamId, KICKOFF_SPOT);
  const play: PbpPlay = {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: kickingTeam.teamId,
    defenseTeamId: receiving.teamId,
    playType: "kickoff",
    down: 0,
    distance: 0,
    fieldPosition: KICKOFF_SPOT,
    /*
     * The NET the kick moved the ball, which is what `yardsGained` already
     * means on a punt — v1's number here was the raw return roll, a quantity
     * that answered no question anyone asks of a kickoff. Negative on a return
     * taken to the house, because the ball did finish behind where it started.
     */
    yardsGained: 100 - startSpot - KICKOFF_SPOT,
    returnYards,
    isScoring: false,
    pointsScored: 0,
    isTurnover: true,
    /*
     * Nobody is the returner on a touchback. v1 named one on every kickoff,
     * which is how a box score came to credit returns that were never made —
     * honest absence is the rule everywhere else in this log and there is no
     * reason for the kickoff to be the exception.
     */
    participants: [
      participant(kicker, kickingTeam.teamId, "kicker"),
      ...(returnYards > 0
        ? [participant(returner, receiving.teamId, "returner")]
        : []),
    ],
  };

  if (isReturnTd) {
    play.isReturnTd = true;
    play.defensivePoints = 6;
    recordPlay(state, play);
    /*
     * The returning team is this play's DEFENSE, so the scoreboard, the try and
     * the kickoff back all have to read from a possession that names the
     * KICKING team. Set after `recordPlay`, which stamps the pre-snap score.
     */
    state.possession = kicking;
    awardDefensivePoints(state, 6);
    tickFixedClock(state, 6, 6, true);
    if (state.features.defensivePat) doDefensivePat(state);
    endDrive(state, "turnover");
    state.openingKickDone = true;
    // The team that just scored kicks off to the team that just kicked to it.
    if (!state.gameOver) doKickoff(state, receivingSide);
    return;
  }

  recordPlay(state, play);
  tickFixedClock(state, 6, 6, true);
  endDrive(state, "turnover");

  state.possession = receivingSide;
  startDrive(state, receiving.teamId, clamp(startSpot, 1, 99));
  state.openingKickDone = true;
}

function doKickoff(state: GameState, kicking: "home" | "away"): void {
  if (state.features.situational) {
    const kickingScore =
      kicking === "home"
        ? state.homeScore - state.awayScore
        : state.awayScore - state.homeScore;
    if (
      shouldOnside({
        scoreDiff: kickingScore,
        quarter: state.quarter,
        clockSeconds: state.clockSeconds,
        isOvertime: state.inOvertime,
      })
    ) {
      doOnsideKick(state, kicking);
      return;
    }
  }

  if (state.features.kickReturns) {
    doKickoffWithReturn(state, kicking);
    return;
  }

  const kickingTeam = kicking === "home" ? state.home : state.away;
  const receiving = kicking === "home" ? state.away : state.home;
  const kicker = selectPlayer(kickingTeam, "K", state);
  const returner = selectPlayer(receiving, "RB", state, true);
  const edge = matchupEdge(state);
  const returnYards = Math.round(18 + state.rand() * 22 + edge * 8);
  /*
   * The clamp lives in `timeline.ts` so the renderer can apply the same one.
   * `yardsGained` records the RAW roll, so a timeline built from the play alone
   * has to know where the returner was actually stopped, and two copies of the
   * bound would drift apart. Identical to the old `clamp(returnYards, 15, 40)`.
   */
  const startField = kickReturnSpot(returnYards);

  startDrive(state, kickingTeam.teamId, KICKOFF_SPOT);
  const play: PbpPlay = {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: kickingTeam.teamId,
    defenseTeamId: receiving.teamId,
    playType: "kickoff",
    down: 0,
    distance: 0,
    fieldPosition: KICKOFF_SPOT,
    yardsGained: returnYards,
    isScoring: false,
    pointsScored: 0,
    isTurnover: true,
    participants: [
      participant(kicker, kickingTeam.teamId, "kicker"),
      participant(returner, receiving.teamId, "returner"),
    ],
  };
  recordPlay(state, play);
  tickFixedClock(state, 6, 6, true);
  endDrive(state, "turnover");

  state.possession = kicking === "home" ? "away" : "home";
  startDrive(state, receiving.teamId, startField);
  state.openingKickDone = true;
}

/*
 * ── The kicking game (`kickingGame` gate) ─────────────────────────────────
 *
 * Every kick below named its kicker as a participant and then read nothing
 * from him. Under the gate his `overall` is a leg, signed so that the roster's
 * ordinary kicker is about neutral: a 40 is the worst leg in the league and a
 * 90 the best, and the rating a dynasty spent a recruiting class on finally
 * shows up on the scoreboard.
 */
const LEG_NEUTRAL = 65;
const LEG_SCALE = 25;

function leg(kicker: PlayerSimProfile): number {
  return clamp((kicker.overall - LEG_NEUTRAL) / LEG_SCALE, -1, 1);
}

/**
 * How far out a coach will send this kicker, in yards to the goal line.
 *
 * A neutral leg is trusted to about 44 yards, the best to 50 and the worst to
 * the mid-30s — against the flat 52 the chart assumes when it knows nothing.
 */
function fieldGoalRangeFor(kicker: PlayerSimProfile): number {
  return Math.round(27 + leg(kicker) * 7);
}

/**
 * A varsity field goal. Steeper than the professional curve and steeper
 * again past 35 yards, because that is where a high-school leg runs out: a
 * 20-yarder is routine, a 40-yarder is a coin flip and a 50-yarder is news.
 */
function varsityFieldGoalProb(
  distance: number,
  kicker: PlayerSimProfile,
  edge: number,
): number {
  const base = 0.92 - (distance - 18) * 0.012 - Math.max(0, distance - 35) * 0.025;
  return clamp(base + leg(kicker) * 0.1 + edge * 0.04, 0.05, 0.95);
}

/** A varsity extra point: closer to six in seven than to automatic. */
function varsityExtraPointProb(kicker: PlayerSimProfile, edge: number): number {
  return clamp(0.86 + leg(kicker) * 0.06 + edge * 0.02, 0.7, 0.97);
}

function doExtraPoint(state: GameState): void {
  const off = offenseTeam(state);
  const def = defenseTeam(state);
  const kicker = selectPlayer(off, "K", state);
  const edge = matchupEdge(state);
  const makeProb = state.features.kickingGame
    ? varsityExtraPointProb(kicker, edge)
    : clamp(0.94 + edge * 0.03, 0.88, 0.99);
  const made = state.rand() < makeProb;
  const playType: PbpPlayType = made ? "extra_point" : "extra_point_miss";

  const play: PbpPlay = {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: off.teamId,
    defenseTeamId: def.teamId,
    playType,
    down: 0,
    distance: 0,
    fieldPosition: 98,
    yardsGained: 0,
    isScoring: made,
    pointsScored: made ? 1 : 0,
    isTurnover: false,
    participants: [participant(kicker, off.teamId, "kicker")],
  };
  recordPlay(state, play);
  if (made) {
    if (state.possession === "home") state.homeScore += 1;
    else state.awayScore += 1;
    if (state.inOvertime) state.gameOver = true;
  }
  tickFixedClock(state, 4, 4, true);
}

/**
 * The try after a defensive touchdown (`defensivePat` gate).
 *
 * A pick-six and a punt returned to the house are worth six and then a kick,
 * exactly like any other touchdown — but the team that scored is the one
 * without the ball, so `doExtraPoint` cannot be reused: it reads the kicker,
 * the matchup edge and the scoreboard from `state.possession`, all of which
 * point at the team that just conceded.
 *
 * Everything here is that same play with the sides swapped. The scoring team is
 * recorded as this play's offense, because on a try it is, which also keeps the
 * ordinary "sum `pointsScored` by `offenseTeamId`" reconciliation correct
 * without teaching it a special case.
 *
 * Always a kick. Real football allows a two-point try here and teams almost
 * never take one, so modelling the choice would add a decision that is wrong
 * more often than it is right.
 */
function doDefensivePat(state: GameState): void {
  const scoring = defenseTeam(state);
  const conceding = offenseTeam(state);
  const kicker = selectPlayer(scoring, "K", state);
  // `matchupEdge` is signed from the offense's point of view, and the offense
  // here is the team that just gave up six.
  const edge = -matchupEdge(state);
  const made =
    state.rand() <
    (state.features.kickingGame
      ? varsityExtraPointProb(kicker, edge)
      : clamp(0.94 + edge * 0.03, 0.88, 0.99));

  const play: PbpPlay = {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: scoring.teamId,
    defenseTeamId: conceding.teamId,
    playType: made ? "extra_point" : "extra_point_miss",
    down: 0,
    distance: 0,
    fieldPosition: 98,
    yardsGained: 0,
    isScoring: made,
    pointsScored: made ? 1 : 0,
    isTurnover: false,
    participants: [participant(kicker, scoring.teamId, "kicker")],
  };
  recordPlay(state, play);
  if (made) {
    // The scorer is whoever does NOT have the ball, which is what this awards.
    awardDefensivePoints(state, 1);
    if (state.inOvertime) state.gameOver = true;
  }
  tickFixedClock(state, 4, 4, true);
}

function doFieldGoalAttempt(state: GameState): void {
  const off = offenseTeam(state);
  const def = defenseTeam(state);
  const kicker = selectPlayer(off, "K", state);
  const dist = yardsToGoal(state) + 17;
  const edge = matchupEdge(state);
  /*
   * Wind and wet do not move the uprights, they shorten the leg — so a 40-yard
   * try into a gale is modelled as a longer kick rather than as a flat accuracy
   * penalty. Dividing by a neutral 1 is exact, so v1 is untouched.
   */
  const effectiveDist = dist / state.weatherMods.kickDistance;
  const makeProb = state.features.kickingGame
    ? varsityFieldGoalProb(effectiveDist, kicker, edge)
    : clamp(0.92 - (effectiveDist - 30) * 0.02 + edge * 0.08, 0.35, 0.95);
  const made = state.rand() < makeProb;
  const playType: PbpPlayType = made ? "field_goal" : "field_goal_miss";

  const play: PbpPlay = {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: off.teamId,
    defenseTeamId: def.teamId,
    playType,
    down: state.down,
    distance: state.distance,
    fieldPosition: state.fieldPosition,
    yardsGained: 0,
    isScoring: made,
    pointsScored: made ? 3 : 0,
    isTurnover: !made,
    participants: [participant(kicker, off.teamId, "kicker")],
  };
  recordPlay(state, play);
  tickFixedClock(state, 5, 5, true);

  if (made) {
    if (state.possession === "home") state.homeScore += 3;
    else state.awayScore += 3;
    endDrive(state, "field_goal");
    if (state.inOvertime) {
      state.gameOver = true;
      return;
    }
    doKickoff(state, state.possession);
  } else {
    endDrive(state, "missed_field_goal");
    flipPossession(state);
    const spot = clamp(100 - state.fieldPosition, 20, 80);
    startDrive(state, offenseTeamId(state), spot);
  }
}

function doPunt(state: GameState): void {
  const off = offenseTeam(state);
  const def = defenseTeam(state);
  const punter = selectPlayer(off, "P", state);
  const returner = selectPlayer(def, "WR", state, true);
  /*
   * A varsity punt travels about 35 yards, not the 44 v1 averaged, and it is
   * the punter's leg that decides it rather than the matchup. One draw in
   * either branch, so the sequence is unchanged.
   */
  const gross = Math.round(
    (state.features.kickingGame
      ? 31 + state.rand() * 11 + leg(punter) * 6
      : 38 + state.rand() * 12 - matchupEdge(state) * 10) *
      state.weatherMods.kickDistance,
  );
  if (state.features.puntReturns) {
    doPuntWithReturn(state, off, def, punter, returner, gross);
    return;
  }

  const net = clamp(gross - Math.round(state.rand() * 8), 25, 55);
  /*
   * What the returner actually brought it back, as the recorded net implies.
   *
   * Derived from `gross - net` rather than from the raw deduction above,
   * because the clamp is part of the answer: when it bites, the return the
   * drive was built on is not the one that was rolled, and crediting the roll
   * would put a number in the box score that contradicts the field position.
   *
   * Consumes no draw — the roll already happened — which is what lets this sit
   * behind a gate without touching v1's sequence.
   */
  const returned = Math.max(0, gross - net);
  /*
   * Where the receiving team starts (v2 widens the floor).
   *
   * v1 clamped this to the 15, which meant a team could never be pinned deep —
   * and therefore a safety was geometrically impossible no matter how the rest
   * of the engine behaved. Real punts are downed inside the 5 regularly, so v2
   * lowers the floor to the 1. Costs no random draw, so v1 parity is unaffected.
   */
  const pinFloor = state.features.scoringV2 ? 1 : 15;
  const newField = clamp(100 - (state.fieldPosition + net), pinFloor, 75);

  const play: PbpPlay = {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: off.teamId,
    defenseTeamId: def.teamId,
    playType: "punt",
    down: state.down,
    distance: state.distance,
    fieldPosition: state.fieldPosition,
    yardsGained: net,
    isScoring: false,
    pointsScored: 0,
    isTurnover: true,
    participants: [
      participant(punter, off.teamId, "kicker"),
      participant(returner, def.teamId, "returner"),
    ],
    ...(state.features.returnStats ? { returnYards: returned } : {}),
  };
  recordPlay(state, play);
  tickFixedClock(state, 7, 7, true);
  endDrive(state, "punt");
  flipPossession(state);
  startDrive(state, offenseTeamId(state), newField);
}

/*
 * ── Punt returns (`puntReturns` gate) ─────────────────────────────────────
 *
 * v1 gave every punt the same treatment: subtract 0–8 yards and spot the ball.
 * No fair catch, no touchback, no punt downed at the 3, and no return that ever
 * broke — which removes one of the few plays in the sport that turns a game in
 * six seconds, and makes a punt the most predictable snap on the field.
 *
 * What follows keeps the punt itself alone and models what happens after it
 * lands, because that is where the variance actually lives.
 */

/** Fair catch, or the coverage team getting there first. */
const FAIR_CATCH_RATE = 0.24;
const DOWNED_RATE = 0.1;
/** Inside this line the coverage team usually downs it rather than risk a TD. */
const PIN_ZONE = 10;
const PIN_DOWNED_RATE = 0.55;
/**
 * A return that breaks containment goes the distance.
 *
 * About 1% of returns, which lands near one punt-return touchdown per 185
 * punts — roughly the real rate. Modelled as its own branch rather than as the
 * tail of the yardage curve: a return either gets bottled up in traffic or it
 * gets past the last man, and stretching one distribution across both produces
 * a steady drizzle of 60-yard returns that die at the 8.
 */
const BREAKAWAY_RATE = 0.01;

/**
 * Ordinary return yardage: mostly short, occasionally worth watching.
 *
 * Skewed rather than flat, so most returns die in traffic and a few get to the
 * second level — a uniform roll makes every return look like every other one.
 *
 * The `1 +` floor matters more than it looks. Without it the curve rounds a
 * quarter of its mass to zero, which is not a short return but a different
 * event entirely: a man who fielded it and was hit immediately reads in the
 * data as a fair catch, and both the return rate and the average return come
 * out wrong. A fielded punt gains at least a yard.
 */
function returnDistance(state: GameState, cap: number): number {
  return Math.min(cap, Math.round(1 + Math.pow(state.rand(), 2.8) * 30));
}

function doPuntWithReturn(
  state: GameState,
  off: TeamSimProfile,
  def: TeamSimProfile,
  punter: PlayerSimProfile,
  returner: PlayerSimProfile,
  gross: number,
): void {
  /*
   * Where the ball comes down, in the RECEIVING team's frame — their own yard
   * line. Everything after the kick is easier to reason about from that side,
   * because that is the team the ball now belongs to.
   */
  const catchSpot = 100 - (state.fieldPosition + gross);
  const touchback = catchSpot <= 0;

  let returned = 0;
  if (!touchback) {
    const roll = state.rand();
    if (catchSpot <= PIN_ZONE) {
      // Pinned deep. Fielding it is the risk; most of these are let go or
      // downed, and the few that come out do not come out far.
      if (roll >= PIN_DOWNED_RATE) returned = returnDistance(state, catchSpot + 25);
    } else if (roll >= FAIR_CATCH_RATE + DOWNED_RATE) {
      returned = state.rand() < BREAKAWAY_RATE
        ? 100 - catchSpot
        : returnDistance(state, 100 - catchSpot);
    }
  }

  const startSpot = touchback ? 20 : catchSpot + returned;
  const isReturnTd = startSpot >= 100;

  /*
   * Nobody is the returner on a punt nobody returned (`puntReturner` gate).
   *
   * The kickoff already says so: a touchback names no returner. This array
   * used to be built before the fair-catch, touchback and downed branches ran,
   * so 43% of punts named a man who stood and watched — or, on a touchback,
   * was not on the field — and `applyAttrition` then charged him a snap and
   * let him be the one hurt. Six players in 600 games injured on a play they
   * were not part of.
   *
   * Gated, and the reason is not the draw count: it is unchanged. The victim
   * of an injury is `participants[floor(roll * length)]`, so one fewer name
   * lands the same roll on the punter instead, and from there the log
   * diverges. A league with stored logs and `injuries` on would find an
   * injury history rewritten underneath it.
   *
   * The returner is still SELECTED above whether or not he is written down —
   * `selectPlayer` draws, and skipping it on an unreturned punt would shift
   * every play after. The gate changes what the play records, never how much
   * randomness the punt spends.
   */
  const participants: PbpParticipant[] = [
    participant(punter, off.teamId, "kicker"),
    ...(returned > 0 || !state.features.puntReturner
      ? [participant(returner, def.teamId, "returner")]
      : []),
  ];

  const play: PbpPlay = {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: off.teamId,
    defenseTeamId: def.teamId,
    playType: "punt",
    down: state.down,
    distance: state.distance,
    fieldPosition: state.fieldPosition,
    // Still the net, so every existing reader keeps working: how far the punt
    // moved the ball, after the return took some of it back.
    yardsGained: touchback
      ? 100 - state.fieldPosition - 20
      : gross - returned,
    returnYards: returned,
    isScoring: false,
    pointsScored: 0,
    isTurnover: true,
    participants,
  };

  if (isReturnTd) {
    play.isReturnTd = true;
    play.defensivePoints = 6;
    awardDefensivePoints(state, 6);
    recordPlay(state, play);
    tickFixedClock(state, 7, 7, true);
    if (state.features.defensivePat) doDefensivePat(state);
    endDrive(state, "punt");
    // The team that just scored kicks off to the team that punted.
    doKickoff(state, state.possession === "home" ? "away" : "home");
    return;
  }

  recordPlay(state, play);
  tickFixedClock(state, 7, 7, true);
  endDrive(state, "punt");
  flipPossession(state);
  startDrive(state, offenseTeamId(state), clamp(startSpot, 1, 99));
}

/*
 * ── Carry yardage (`rushDistribution` gate) ───────────────────────────────
 *
 * v1 drew a carry from `2 + rand()*5 + edge*4`, which has a floor of two yards
 * before the edge is added. There is no arithmetic path through it to being
 * stopped, so across five thousand carries not one run lost a yard and only 2%
 * gained nothing — against roughly 9% and 19% in the real sport.
 *
 * That is not only a texture problem. It made `tfl` dead code for runs (every
 * tackle for loss in a game was a sack), it pushed rushing to 135 yards a team
 * a game against a real 115, and because a carry could never be stuffed it
 * reached the goal line as readily as a pass did — which is what left the
 * touchdown split at 49% rushing against a real 35-40%.
 *
 * A carry is really three outcomes, not one curve: the defense wins at the
 * line, the run grinds out what is blocked for it, or it breaks. Modelling
 * them separately is what produces football's shape — a left tail that exists,
 * a low median, and a mean dragged up by a thin right tail.
 */

/** Carries stopped at or behind the line. Real football: about a fifth. */
const STUFF_RATE = 0.19;
/** Of those, roughly half are no gain and half are an actual loss. */
const STUFF_LOSS_SKEW = 3.6;
/** The grind: blocked for a few yards, occasionally more. */
const CARRY_SKEW = 2.2;
const CARRY_SPAN = 10;
/** A run that breaks the second level. */
const BREAK_SKEW = 4.2;
const BREAK_SPAN = 50;

function carryYards(
  state: GameState,
  edge: number,
  scheme: SchemeModifiers,
): number {
  /*
   * A stouter run defence stuffs more, rather than merely shaving a yard off
   * every carry. `scheme.rushYards` is a yardage multiplier below 1 when the
   * box is stacked, so it inverts into a stuff rate — and a better offense is
   * stopped less often.
   */
  const stuffRate = clamp(STUFF_RATE / Math.max(0.6, scheme.rushYards) - edge * 0.02, 0.06, 0.4);
  if (state.rand() < stuffRate) {
    /*
     * Met at or behind the line. Skewed hard toward zero: most stuffs are no
     * gain, and the scheme multiplier deliberately does NOT apply — a stacked
     * box should produce more losses, not smaller ones, and multiplying a
     * negative by a number below 1 would do exactly the wrong thing.
     */
    return -Math.round(Math.pow(state.rand(), STUFF_LOSS_SKEW) * 5);
  }

  const broke =
    state.rand() <
    (0.19 + edge * 0.05) * state.weatherMods.explosiveRate * scheme.explosiveRate;
  if (broke) {
    return Math.round(
      (9 + Math.pow(state.rand(), BREAK_SKEW) * BREAK_SPAN) * scheme.rushYards,
    );
  }
  return Math.round(
    (1 + Math.pow(state.rand(), CARRY_SKEW) * CARRY_SPAN + edge * 1.2) *
      scheme.rushYards,
  );
}

/**
 * A carry or a catch whose yardage reaches the goal line. Was he stopped short?
 *
 * One rule for both, which is the entire point. v1 asked the question twice and
 * answered it differently: a rush rolled a 2–15% chance of *scoring*, while a
 * completion scored automatically. Measured over 300 games that produced 7.8%
 * conversion on the ground against 92.9% through the air, and left just 8.9% of
 * all touchdowns to the run — a football in which nobody scores by rushing.
 *
 * Framed as a *stop* rather than a score, because that is the event actually in
 * doubt: the ball got there, and the question is whether the defense held. A
 * breakaway is discounted hard — a back who broke a 20-yard run was not caught
 * from behind at the one.
 *
 * Under `redZone` the stand also reads HOW FAR past the line the play would
 * have gone. The yardage draw says where the carrier would have been tackled
 * on an open field; a play that would have ended at the line is the one in
 * doubt at the pylon, and one that would have ended three yards deep in the
 * end zone was not stopped at the one by anybody. The flat stand applied the
 * full rate to both, which is why 38% of red-zone trips contained a play that
 * reached the goal line and was turned back — a goal-line stand on four
 * drives in ten. Plays from the 1–3 converted at 45%, which is the real rate
 * from the 3, not from the 1.
 *
 * Costs exactly one draw, the same one `doRush` already spent here, which is
 * why the rush path stays draw-for-draw identical when the gate is off.
 */
function stoppedAtGoalLine(state: GameState, yards: number, edge: number): boolean {
  const stand = clamp(0.38 - edge * 0.04, 0.1, 0.55);
  const atTheLine = yards >= 15 ? stand * 0.35 : stand;
  if (!state.features.redZone) return state.rand() < atTheLine;
  // `fieldPosition` is still pre-snap here; the result has not been applied.
  const margin = state.fieldPosition + yards - 100;
  return state.rand() < atTheLine * Math.max(0, 1 - margin / GOAL_LINE_MARGIN);
}

/**
 * Yards past the goal line at which a play is no longer in doubt (`redZone`).
 *
 * The stand decays linearly from its full rate at the line to nothing here.
 * Three is the length of a tackle: a carrier who would have been brought down
 * three yards deep was across before anyone reached him. Tuned against the
 * per-play conversion from the 1–3, which lands at 61% on the ground and 53%
 * through the air — the real figures from the one are about 58% and 45%.
 */
const GOAL_LINE_MARGIN = 3;

function doRush(state: GameState): void {
  const off = offenseTeam(state);
  const def = defenseTeam(state);
  const rusher = selectPlayer(off, "RB", state, true);
  const edge = matchupEdge(state);
  const scheme = schemeMods(state);
  const fumbleProb =
    clamp(0.01 - edge * 0.003, 0.003, 0.015) *
    state.weatherMods.fumbleRate *
    scheme.fumbleRate;
  const tdProb = clamp(0.055 + edge * 0.08, 0.02, 0.15);
  let yards: number;
  if (state.features.rushDistribution) {
    yards = carryYards(state, edge, scheme);
  } else {
    const explosive =
      state.rand() <
      (0.08 + edge * 0.05) *
        state.weatherMods.explosiveRate *
        scheme.explosiveRate;
    yards = explosive
      ? Math.round((12 + state.rand() * 18) * scheme.rushYards)
      : Math.round((2 + state.rand() * 5 + edge * 4) * scheme.rushYards);
    yards = Math.max(-3, yards);
  }

  const participants: PbpParticipant[] = [
    participant(rusher, off.teamId, "rusher"),
  ];
  const tackler = selectDefender(def, state, "tackle");
  participants.push(participant(tackler, def.teamId, "tackler_solo"));
  if (state.rand() < 0.35) {
    const ast = selectDefender(def, state, "tackle");
    participants.push(participant(ast, def.teamId, "tackler_ast"));
  }

  let isTurnover = false;
  let isScoring = false;
  let points = 0;

  if (state.rand() < fumbleProb) {
    isTurnover = true;
    yards = 0;
    const fumbler = rusher;
    const recoverer = selectDefender(def, state, "tackle");
    participants.push(participant(fumbler, off.teamId, "fumbler"));
    participants.push(participant(recoverer, def.teamId, "recoverer"));
  } else if (state.fieldPosition + yards >= 100) {
    /*
     * The carry reached the goal line; whether he got in is a separate roll.
     * The draw stays nested here rather than in the condition above so it is
     * taken in exactly the circumstances it always was — hoisting it would
     * shift every subsequent number in the sequence and divorce the log from v1.
     *
     * Both branches spend exactly one draw, so the two models differ in what
     * they decide, never in how much randomness they consume.
     */
    const scored = state.features.goalLineConversion
      ? !stoppedAtGoalLine(state, yards, edge)
      : state.rand() < tdProb + (yards >= 15 ? 0.15 : 0);
    if (scored) {
      yards = 100 - state.fieldPosition;
      isScoring = true;
      points = 6;
    } else if (state.features.goalLineYards || state.features.goalLineConversion) {
      // Stopped short. He got to the 1, so that is what he is credited with —
      // and, at goal-to-go, that is short of the line to gain (see the gate).
      yards = 99 - state.fieldPosition;
    }
  }

  const play: PbpPlay = {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: off.teamId,
    defenseTeamId: def.teamId,
    playType: "rush",
    down: state.down,
    distance: state.distance,
    fieldPosition: state.fieldPosition,
    yardsGained: yards,
    isScoring,
    pointsScored: points,
    isTurnover,
    participants,
  };
  recordPlay(state, play);
  tickPlayClock(state, 22, 18, isTurnover || isScoring);
  applyPlayResult(state, yards, isScoring, points, isTurnover, play);
}

/*
 * ── Individual matchups (`matchups` gate) ──────────────────────────────────
 *
 * The engine resolves a pass with a handful of rolls against the team edge
 * and picks participants by position weight afterwards. The interceptor is
 * chosen after the interception has been decided; the sacker after the sack.
 * Nobody blocks anybody, no receiver is covered by a particular corner, and
 * no rating on the field is read by anything except the kicker's leg. A 90
 * receiver against a 60 corner completed passes at exactly the rate the
 * reverse did.
 *
 * Under the gate the three men who decide a dropback are selected BEFORE the
 * outcome — the man in coverage on the target, the pass rusher, and the
 * lineman blocking him — and the outcome reads the difference between them.
 * Every term is linear and centred on zero, so a matchup of equals plays the
 * game the team edge already priced, and only a mismatch moves anything.
 */

/** Rating points between two men that count as a full mismatch. */
const MATCHUP_SCALE = 30;
/** A full mismatch in coverage moves the completion rate this much. */
const COVER_COMPLETION_SWING = 0.08;
/** ...and multiplies the explosive rate by up to this much either way. */
const COVER_EXPLOSIVE_SWING = 0.5;
/** ...and the interception rate, the other way. */
const COVER_PICK_SWING = 0.4;
/** ...and adds this many yards after the catch on an ordinary completion. */
const COVER_YAC_YARDS = 3;
/** A full mismatch at the line multiplies the sack rate by up to this much. */
const RUSH_SACK_SWING = 0.5;

interface PassMatchups {
  cover: PlayerSimProfile;
  rusher: PlayerSimProfile;
  blocker: PlayerSimProfile;
  /** Signed for the receiver: positive when he has the corner beaten. */
  coverage: number;
  /** Signed for the rusher: positive when he has the lineman beaten. */
  rush: number;
}

/**
 * The rating the matchup reads. Under `injuries` it is the fatigued one, so
 * a corner who has been on the field all night gets beaten — the link that
 * makes riding a starter cost something on the field rather than only in
 * the substitution logic. Draws nothing.
 */
function matchupRating(state: GameState, player: PlayerSimProfile): number {
  return state.features.injuries
    ? effectiveOverall(player.overall, staminaFor(state.snaps, player))
    : player.overall;
}

/**
 * How badly `a` has `b` beaten, in [-1, 1].
 *
 * Zero when either is a stand-in for a group the roster does not carry: a
 * roster with no offensive line has not fielded a bad one, it has said
 * nothing, and the matchup must not read a 50 it invented.
 */
function matchup(
  state: GameState,
  a: PlayerSimProfile,
  b: PlayerSimProfile,
): number {
  if (isPlaceholder(a) || isPlaceholder(b)) return 0;
  return clamp(
    (matchupRating(state, a) - matchupRating(state, b)) / MATCHUP_SCALE,
    -1,
    1,
  );
}

/**
 * Who is on whom for this dropback. Three selections, every one a draw the
 * gate-off engine does not make, which is why the gate is RNG-shifting.
 */
function passMatchups(
  state: GameState,
  off: TeamSimProfile,
  def: TeamSimProfile,
  receiver: PlayerSimProfile,
): PassMatchups {
  const cover = selectDefender(def, state, "coverage");
  const rusher = selectDefender(def, state, "sack");
  const blocker = selectPlayer(off, "OL", state, true);
  return {
    cover,
    rusher,
    blocker,
    coverage: matchup(state, receiver, cover),
    rush: matchup(state, rusher, blocker),
  };
}

/** The matchup men, named on the play — stand-ins excepted, as nobody was there. */
function matchupParticipants(
  duel: PassMatchups | null,
  def: TeamSimProfile,
  off: TeamSimProfile,
): PbpParticipant[] {
  if (!duel) return [];
  const named: PbpParticipant[] = [];
  if (!isPlaceholder(duel.cover)) named.push(participant(duel.cover, def.teamId, "coverage"));
  if (!isPlaceholder(duel.rusher)) named.push(participant(duel.rusher, def.teamId, "pass_rusher"));
  if (!isPlaceholder(duel.blocker)) named.push(participant(duel.blocker, off.teamId, "blocker"));
  return named;
}

function doPass(state: GameState): void {
  const off = offenseTeam(state);
  const def = defenseTeam(state);
  const passer = selectPlayer(off, "QB", state);
  const receiver = selectPlayer(off, "WR", state, true);
  const edge = matchupEdge(state);
  const scheme = schemeMods(state);
  /*
   * Who is on whom, decided before anything else is (`matchups` gate). Null
   * with the gate off, and every read below then falls back to the team edge
   * alone — the arithmetic is `+ 0` and `* 1`, exact in floating point, so
   * the gate-off path is bit-identical without a branch at each site.
   */
  const duel = state.features.matchups ? passMatchups(state, off, def, receiver) : null;
  const coverage = duel?.coverage ?? 0;
  const rush = duel?.rush ?? 0;
  const matchupMen = matchupParticipants(duel, def, off);
  /*
   * A varsity dropback is more dangerous than a professional one, in both
   * directions. The 7% sack rate and 2.5% interception rate here are NFL
   * figures, and they left a game with 1.3 sacks and 0.4 picks a team against
   * roughly 2 and 1.
   *
   * High-school lines hold up less well and high-school quarterbacks throw far
   * more interceptions — a 6% pick rate would be catastrophic in the pros and
   * is ordinary on a Friday night. The interception clamp has to open up too:
   * its old ceiling of 0.04 sat below the rate the sport actually produces, so
   * raising the baseline alone would have been silently capped.
   */
  const sackProb =
    (state.features.passingGame
      ? clamp(0.105 - edge * 0.04, 0.05, 0.17)
      : clamp(0.07 - edge * 0.03, 0.03, 0.12)) *
    scheme.sackRate *
    // The rusher against the man blocking him (`matchups`).
    (1 + rush * RUSH_SACK_SWING);
  const intProb =
    (state.features.passingGame
      ? clamp(0.058 - edge * 0.022, 0.02, 0.095)
      : clamp(0.025 - edge * 0.01, 0.008, 0.04)) *
    scheme.interceptionRate *
    // A receiver with the corner beaten is not the one throwing it to him.
    (1 - coverage * COVER_PICK_SWING);

  if (state.rand() < sackProb) {
    // Under `matchups` the sack belongs to the man who was coming.
    const sacker = duel?.rusher ?? selectDefender(def, state, "sack");
    const yards = -Math.round(3 + state.rand() * 6);
    const play: PbpPlay = {
      playId: state.playId,
      driveId: state.driveId,
      quarter: state.quarter,
      clockSeconds: state.clockSeconds,
      offenseTeamId: off.teamId,
      defenseTeamId: def.teamId,
      playType: "sack",
      down: state.down,
      distance: state.distance,
      fieldPosition: state.fieldPosition,
      yardsGained: yards,
      isScoring: false,
      pointsScored: 0,
      isTurnover: false,
      participants: [
        participant(passer, off.teamId, "passer"),
        participant(sacker, def.teamId, "sacker"),
        ...matchupMen,
      ],
    };

    /*
     * Strip-sack (v2). v1 modelled fumbles on rushes only, so a quarterback
     * could never lose the ball while being sacked — the single most common
     * non-rush fumble in the sport. Gated, and the draw happens ONLY inside
     * the gate so v1's PRNG sequence is untouched.
     */
    if (
      state.features.scoringV2 &&
      state.rand() < 0.12 * state.weatherMods.fumbleRate
    ) {
      const recoverer = selectDefender(def, state, "tackle");
      play.isTurnover = true;
      play.participants.push(participant(passer, off.teamId, "fumbler"));
      play.participants.push(participant(recoverer, def.teamId, "recoverer"));
      recordPlay(state, play);
      tickPlayClock(state, 24, 12, true);
      applyPlayResult(state, yards, false, 0, true, play);
      return;
    }

    recordPlay(state, play);
    tickPlayClock(state, 24, 12, false);
    applyPlayResult(state, yards, false, 0, false, play);
    return;
  }

  if (state.rand() < intProb) {
    // Under `matchups` the pick belongs to the man who was covering him.
    const interceptor = duel?.cover ?? selectDefender(def, state, "coverage");
    const returnYards = Math.round(state.rand() * 20);
    const play: PbpPlay = {
      playId: state.playId,
      driveId: state.driveId,
      quarter: state.quarter,
      clockSeconds: state.clockSeconds,
      offenseTeamId: off.teamId,
      defenseTeamId: def.teamId,
      playType: "interception",
      down: state.down,
      distance: state.distance,
      fieldPosition: state.fieldPosition,
      yardsGained: returnYards,
      isScoring: false,
      pointsScored: 0,
      isTurnover: true,
      participants: [
        participant(passer, off.teamId, "passer"),
        participant(receiver, off.teamId, "receiver"),
        participant(interceptor, def.teamId, "interceptor"),
        ...matchupMen,
      ],
    };
    /*
     * Pick-six (v2). v1 always spotted the ball after an interception, so a
     * defense could never score. The return distance already exists; this only
     * decides whether it reached the end zone.
     */
    if (state.features.scoringV2 && rollReturnTouchdown(state, 0.06)) {
      play.returnYards = returnYards;
      play.isReturnTd = true;
      play.defensivePoints = 6;
      awardDefensivePoints(state, 6);
      recordPlay(state, play);
      tickPlayClock(state, 20, 10, true);
      if (state.features.defensivePat) doDefensivePat(state);
      endDrive(state, "turnover");
      // The scoring defense now kicks off to the team that threw it.
      doKickoff(state, state.possession === "home" ? "away" : "home");
      return;
    }

    if (state.features.scoringV2) play.returnYards = returnYards;
    recordPlay(state, play);
    tickPlayClock(state, 20, 10, true);
    endDrive(state, "turnover");
    flipPossession(state);
    const spot = clamp(100 - state.fieldPosition + returnYards, 15, 85);
    startDrive(state, offenseTeamId(state), spot);
    return;
  }

  /*
   * Weather is applied AFTER the clamp on purpose. The 0.45 floor is a v1
   * balance guard, not a law of physics — a sleet game should be allowed to
   * push completion percentage below it.
   */
  /*
   * A varsity quarterback completes half his throws, not two thirds. The 0.6
   * baseline landed at 57% after weather and scheme — a professional figure in
   * an engine that plays twelve-minute quarters.
   *
   * This is per-throw accuracy, and it is not the completion percentage: the
   * roll only happens on a throw that was not intercepted, so raising the pick
   * rate to a varsity 6% pulls the reported percentage down with it. The
   * baseline sits above the number it is aiming at for exactly that reason.
   */
  const completeProb =
    (state.features.passingGame
      ? clamp(0.575 + edge * 0.14 + coverage * COVER_COMPLETION_SWING, 0.43, 0.77)
      : clamp(0.6 + edge * 0.14 + coverage * COVER_COMPLETION_SWING, 0.45, 0.8)) *
    state.weatherMods.passAccuracy *
    scheme.passAccuracy;
  const complete = state.rand() < completeProb;
  if (!complete) {
    // A ball broken up was broken up by the man in coverage (`matchups`); the
    // one-in-eight that is a breakup rather than a miss is the roll it was.
    const pd =
      state.rand() < 0.12 ? (duel?.cover ?? selectDefender(def, state, "coverage")) : null;
    const participants: PbpParticipant[] = [
      participant(passer, off.teamId, "passer"),
      participant(receiver, off.teamId, "receiver"),
    ];
    if (pd) participants.push(participant(pd, def.teamId, "pass_defender"));
    participants.push(...matchupMen);
    const play: PbpPlay = {
      playId: state.playId,
      driveId: state.driveId,
      quarter: state.quarter,
      clockSeconds: state.clockSeconds,
      offenseTeamId: off.teamId,
      defenseTeamId: def.teamId,
      playType: "pass_incomplete",
      down: state.down,
      distance: state.distance,
      fieldPosition: state.fieldPosition,
      yardsGained: 0,
      isScoring: false,
      pointsScored: 0,
      isTurnover: false,
      participants,
    };
    recordPlay(state, play);
    tickPlayClock(state, 18, 10, true);
    applyPlayResult(state, 0, false, 0, false);
    return;
  }

  const explosive =
    state.rand() <
    (state.features.passingGame ? 0.17 : 0.1) * (1 + edge * 0.6) *
      state.weatherMods.explosiveRate *
      scheme.explosiveRate *
      // The explosive play is the mismatch, not the average (`matchups`).
      (1 + coverage * COVER_EXPLOSIVE_SWING);
  /*
   * A high-school completion travels further than a professional one.
   *
   * Not because the passing is better — it is worse, and the completion rate
   * stays where it is — but because the throws are different. Varsity offenses
   * throw fewer, deeper balls against defenses that cannot cover as long, so
   * the yards arrive per completion rather than per attempt. Modelling it as a
   * pro-style 4-13 checkdown game left passing at 97 yards a team against a
   * varsity 110-150, on a realistic number of attempts.
   */
  let yards = explosive
    ? Math.round(15 + state.rand() * 25)
    : Math.round(
        4 +
          state.rand() * (state.features.passingGame ? 15 : 9) +
          edge * 5 +
          // Yards after the catch belong to the man who beat his corner.
          coverage * COVER_YAC_YARDS,
      );
  let isScoring = false;
  let points = 0;
  const participants: PbpParticipant[] = [
    participant(passer, off.teamId, "passer"),
    participant(receiver, off.teamId, "receiver"),
  ];
  const tackler = selectDefender(def, state, "tackle");
  participants.push(participant(tackler, def.teamId, "tackler_solo"));
  if (state.rand() < 0.3) {
    participants.push(
      participant(selectDefender(def, state, "tackle"), def.teamId, "tackler_ast"),
    );
  }
  participants.push(...matchupMen);

  if (state.fieldPosition + yards >= 100) {
    /*
     * v1 scored here unconditionally — a completion that reached the goal line
     * was always six, with no roll and no way to be stopped at the one. That is
     * the mirror image of the rush path's flaw, and between them they left 91%
     * of touchdowns to the pass. Under the gate both ask the same question.
     *
     * Draws nothing when the gate is off, so v1 keeps its exact sequence.
     */
    if (state.features.goalLineConversion && stoppedAtGoalLine(state, yards, edge)) {
      yards = 99 - state.fieldPosition;
    } else {
      yards = 100 - state.fieldPosition;
      isScoring = true;
      points = 6;
    }
  }

  const play: PbpPlay = {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: off.teamId,
    defenseTeamId: def.teamId,
    playType: "pass_complete",
    down: state.down,
    distance: state.distance,
    fieldPosition: state.fieldPosition,
    yardsGained: yards,
    isScoring,
    pointsScored: points,
    isTurnover: false,
    participants,
  };
  recordPlay(state, play);
  tickPlayClock(state, 20, 18, isScoring);
  applyPlayResult(state, yards, isScoring, points, false, play);
}

function doKneel(state: GameState): void {
  const off = offenseTeam(state);
  const def = defenseTeam(state);
  const rusher = selectPlayer(off, "QB", state);
  const play: PbpPlay = {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: off.teamId,
    defenseTeamId: def.teamId,
    playType: "kneel",
    down: state.down,
    distance: state.distance,
    fieldPosition: state.fieldPosition,
    yardsGained: -1,
    isScoring: false,
    pointsScored: 0,
    isTurnover: false,
    participants: [participant(rusher, off.teamId, "rusher")],
  };
  recordPlay(state, play);
  tickFixedClock(state, 38, 2, false);
  applyPlayResult(state, -1, false, 0, false);
}


/*
 * ── v2 scoring plays (Epic A1) ────────────────────────────────────────────
 * Reached only when `features.scoringV2` is on, so v1 logs are untouched.
 */

/** Points the DEFENSE just scored go to the other side of the ledger. */
function awardDefensivePoints(state: GameState, points: number): void {
  if (state.possession === "home") state.awayScore += points;
  else state.homeScore += points;
}

/**
 * Tackled in your own end zone: two points to the defense, then a free kick
 * from the 20 by the team that conceded.
 */
function doSafety(state: GameState): void {
  const off = offenseTeam(state);
  const def = defenseTeam(state);
  const tackler = selectDefender(def, state, "tackle");

  recordPlay(state, {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: off.teamId,
    defenseTeamId: def.teamId,
    playType: "safety",
    down: state.down,
    distance: state.distance,
    fieldPosition: state.fieldPosition,
    yardsGained: 0,
    // The scoring side is the DEFENSE, so `pointsScored` (an offense-relative
    // field in v1) stays 0 and `defensivePoints` carries the 2. Readers that
    // sum `pointsScored` for a team must add `defensivePoints` for the other.
    isScoring: false,
    pointsScored: 0,
    defensivePoints: 2,
    isTurnover: true,
    participants: [participant(tackler, def.teamId, "tackler_solo")],
  });
  // After `recordPlay`, so the snapshot it takes reads the score the safety
  // was conceded AT rather than the score it produced (A7).
  awardDefensivePoints(state, 2);

  tickFixedClock(state, 6, 6, true);
  endDrive(state, "turnover");
  // The conceding team free-kicks, so possession passes to the scoring side.
  flipPossession(state);
  startDrive(state, offenseTeamId(state), 35);
}

/**
 * Whether to go for two rather than kick.
 *
 * Deliberately deterministic — no random draw. The classic chart: down 2, 5 or
 * 8 late, a two-point try changes the number of scores needed. Anything else
 * kicks. A3 can widen this once it owns situational decisions.
 */
function shouldGoForTwo(state: GameState): boolean {
  if (state.quarter < 4 && !state.inOvertime) return false;
  const scoring = state.possession === "home" ? state.homeScore : state.awayScore;
  const opposing = state.possession === "home" ? state.awayScore : state.homeScore;
  const deficit = opposing - scoring;
  return deficit === 2 || deficit === 5 || deficit === 8;
}

/** Two-point try from the 2. Succeeds a shade under half the time. */
function doTwoPointConversion(state: GameState): void {
  const off = offenseTeam(state);
  const def = defenseTeam(state);
  const passer = selectPlayer(off, "QB", state);
  const target = selectPlayer(off, "WR", state, true);
  const edge = matchupEdge(state);
  const success = state.rand() < clamp(0.45 + edge * 0.1, 0.3, 0.62);

  recordPlay(state, {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: off.teamId,
    defenseTeamId: def.teamId,
    playType: success ? "two_point_convert" : "two_point_fail",
    down: 0,
    distance: 2,
    fieldPosition: 98,
    yardsGained: success ? 2 : 0,
    isScoring: success,
    pointsScored: success ? 2 : 0,
    isTurnover: false,
    participants: [
      participant(passer, off.teamId, "passer"),
      participant(target, off.teamId, "receiver"),
    ],
  });
  // Banked after the play is recorded, so its pre-snap snapshot shows the score
  // the team was trying to convert FROM (A7). Nothing between reads the score,
  // so the ordering is otherwise invisible.
  if (success) {
    if (state.possession === "home") state.homeScore += 2;
    else state.awayScore += 2;
  }
  tickFixedClock(state, 5, 5, true);
}

/**
 * Did a return reach the end zone?
 *
 * Called ONLY inside a `scoringV2` branch — it draws, so calling it while the
 * gate is off would desynchronize the PRNG.
 */
function rollReturnTouchdown(state: GameState, baseProb: number): boolean {
  return state.rand() < baseProb;
}


/*
 * ── Penalties (Epic A2) ───────────────────────────────────────────────────
 */

/** Mean roster awareness, or `strength` when no attribute data exists. */
function teamDiscipline(team: TeamSimProfile): number {
  if (typeof team.discipline === "number") return team.discipline;
  return meanAwareness(team.players, team.strength);
}

/**
 * Roll a flag for the play just built, and apply the accept/decline outcome.
 *
 * Returns the yardage adjustment to apply INSTEAD of the play result when the
 * penalty is accepted and negates the play, or `null` when the play stands.
 *
 * Draws from the PRNG, so it is called ONLY inside the `penalties` gate — a
 * draw while disabled would desynchronize every later play.
 */
function applyPenalty(
  state: GameState,
  play: PbpPlay,
  context: { playYards: number; isScoring: boolean; isTurnover: boolean },
): { negated: boolean; penaltyYards: number } | null {
  const rolled = rollPenalty({
    rand: state.rand,
    playType: play.playType,
    offenseDiscipline: teamDiscipline(offenseTeam(state)),
    defenseDiscipline: teamDiscipline(defenseTeam(state)),
  });
  if (!rolled) return null;

  const decision = acceptOrDecline({
    penalty: rolled.def,
    playYards: context.playYards,
    playIsScoring: context.isScoring,
    playIsTurnover: context.isTurnover,
    distance: state.distance,
  });

  play.penalty = {
    code: rolled.def.code,
    label: rolled.def.label,
    yards: rolled.yards,
    onOffense: rolled.def.onOffense,
    accepted: decision.accepted,
    negatesPlay: decision.accepted && rolled.def.negatesPlay,
    reason: decision.reason,
  };

  // Declined: the flag is recorded for the play-by-play, but nothing changes.
  if (!decision.accepted) return null;

  // Accepted but not play-negating (defensive holding, PI): the play is wiped
  // and the ball moves by the penalty yardage from the previous spot.
  const signed = rolled.def.onOffense ? -rolled.yards : rolled.yards;
  return {
    negated: rolled.def.negatesPlay || !rolled.def.onOffense,
    penaltyYards: signed,
  };
}

function applyPlayResult(
  state: GameState,
  yards: number,
  isScoring: boolean,
  points: number,
  isTurnover: boolean,
  /*
   * The play just recorded, passed explicitly so the penalty roll can attach
   * its flag to it. Optional because non-scrimmage plays (kickoff, punt, field
   * goal) do not draw flags in A2.
   */
  play?: PbpPlay,
): void {
  if (state.features.penalties && play) {
    const outcome = applyPenalty(state, play, {
      playYards: yards,
      isScoring,
      isTurnover,
    });
    if (outcome) {
      /*
       * An accepted flag replaces the play entirely: yardage is assessed from
       * the previous spot and the down replays (or resets on an automatic
       * first down). The play stays in the log so the drive chart can show
       * what was wiped, but `negatesPlay` keeps it out of the stat lines.
       */
      state.fieldPosition = clamp(
        state.fieldPosition + outcome.penaltyYards,
        1,
        99,
      );
      // A flag stops the clock, so the next snap pays no huddle runoff (A3).
      state.clockStopped = true;
      const auto = !play.penalty?.onOffense && outcome.penaltyYards > 0;
      if (auto) {
        state.down = 1;
        state.distance = Math.min(10, 100 - state.fieldPosition) || 1;
      } else {
        state.distance = Math.max(1, state.distance - outcome.penaltyYards);
      }
      return;
    }
  }

  if (isTurnover) {
    endDrive(state, "turnover");
    flipPossession(state);
    const spot = clamp(100 - state.fieldPosition, 20, 80);
    startDrive(state, offenseTeamId(state), spot);
    return;
  }

  /*
   * Safety (v2). v1 clamped field position to a floor of 1, so being tackled
   * in your own end zone was silently impossible. Detect it BEFORE the clamp.
   *
   * Costs no random draw — it is pure geometry — but it is still gated,
   * because emitting the play at all would change the log.
   */
  if (state.features.scoringV2 && !isScoring && state.fieldPosition + yards <= 0) {
    doSafety(state);
    return;
  }

  state.fieldPosition = clamp(state.fieldPosition + yards, 1, 99);

  if (isScoring) {
    if (state.possession === "home") state.homeScore += points;
    else state.awayScore += points;
    if (points === 6) {
      if (state.features.scoringV2 && shouldGoForTwo(state)) {
        doTwoPointConversion(state);
      } else {
        doExtraPoint(state);
      }
    }
    endDrive(state, points === 6 ? "touchdown" : "field_goal");
    if (state.inOvertime && points === 6) {
      if (!state.gameOver) doKickoff(state, state.possession);
      return;
    }
    if (state.inOvertime) return;
    doKickoff(state, state.possession);
    return;
  }

  if (yards >= state.distance) {
    state.down = 1;
    state.distance = Math.min(10, 100 - state.fieldPosition);
    if (state.distance <= 0) state.distance = 1;
  } else {
    state.down += 1;
    state.distance -= yards;
    if (state.down > 4) {
      endDrive(state, "downs");
      flipPossession(state);
      startDrive(state, offenseTeamId(state), clamp(100 - state.fieldPosition, 20, 80));
    }
  }
}

/*
 * ── Clock management plays (Epic A3) ──────────────────────────────────────
 * Reached only when `features.situational` is on.
 */

/** A play that stops the clock and nothing else. Costs no random draw. */
function emitClockPlay(
  state: GameState,
  playType: "spike" | "timeout",
  extra: Partial<PbpPlay> = {},
): void {
  recordPlay(state, {
    playId: state.playId,
    driveId: state.driveId,
    quarter: state.quarter,
    clockSeconds: state.clockSeconds,
    offenseTeamId: offenseTeamId(state),
    defenseTeamId: defenseTeamId(state),
    playType,
    down: state.down,
    distance: state.distance,
    fieldPosition: state.fieldPosition,
    yardsGained: 0,
    isScoring: false,
    pointsScored: 0,
    isTurnover: false,
    participants: [],
    ...extra,
  });
  state.clockStopped = true;
}

/** Spend a timeout. Bounded by `spendTimeout`, so the count cannot go negative. */
function doTimeout(state: GameState, side: "home" | "away"): void {
  spendTimeout(state, side);
  emitClockPlay(state, "timeout", {
    timeoutTeamId: side === "home" ? state.home.teamId : state.away.teamId,
  });
  // A timeout consumes no game clock at all — that is the entire point of one.
}

/** Throw it at the turf. Stops the clock, costs a down. */
function doSpike(state: GameState): void {
  emitClockPlay(state, "spike", { tempo: "hurry_up" });
  tickClock(state, 2);
  state.down += 1;
  if (state.down > 4) {
    endDrive(state, "downs");
    flipPossession(state);
    startDrive(state, offenseTeamId(state), clamp(100 - state.fieldPosition, 20, 80));
  }
}

/**
 * v1's 4th-down logic: two hardcoded distance bands and a coin flip.
 *
 * Kept verbatim, and reached whenever `features.situational` is off, so the
 * golden fixture still reproduces byte-for-byte.
 */
function runFourthDownV1(state: GameState): void {
  const ytg = yardsToGoal(state);
  if (ytg <= 35 && ytg >= 18) {
    doFieldGoalAttempt(state);
    return;
  }
  if (ytg > 45 || (ytg > 35 && state.rand() < 0.75)) {
    doPunt(state);
    return;
  }
  if (state.rand() < 0.35 + matchupEdge(state) * 0.2) {
    if (state.rand() < 0.45) doRush(state);
    else doPass(state);
    return;
  }
  doPunt(state);
}

function runNormalDownPlay(state: GameState, tempo: ClockStrategy): void {
  const edge = matchupEdge(state);
  /*
   * High school is a running sport, and this engine is a high-school engine —
   * twelve-minute quarters, one overtime timeout, a 52-yard field goal at the
   * edge of plausible. A 52% baseline is a professional split; it had teams
   * throwing 25 times and handing off 25, where varsity football runs it 35 to
   * 40 times and throws it 15 to 20.
   *
   * The down adjustment grows too. A pro offense on 2nd-and-8 is still likely
   * to throw; a high-school offense is likely to run it again.
   */
  let passRate = state.features.playCalling
    ? clamp(0.31 + edge * 0.1 - (state.down === 1 ? 0 : 0.04), 0.18, 0.58)
    : clamp(0.52 + edge * 0.1 - (state.down === 1 ? 0 : 0.08), 0.38, 0.68);
  /*
   * Scheme moves the split (A6), and it needs a wider band than the baseline
   * clamp allows — a Flexbone that still throws it 38% of the time is not a
   * Flexbone. Guarded on a non-zero delta rather than folded into the
   * expression above so the neutral path keeps the original clamp exactly.
   */
  const schemeDelta = schemeMods(state).passRateDelta;
  if (schemeDelta !== 0) {
    passRate = clamp(passRate + schemeDelta, 0.12, 0.9);
  }
  if (state.features.situational) {
    /*
     * Tempo changes what you call, not just how fast you snap it. A hurry-up
     * offense throws because an incompletion stops the clock; a team protecting
     * a lead runs because a handoff does not.
     */
    if (tempo === "hurry_up") passRate = clamp(passRate + 0.25, 0.38, 0.92);
    else if (tempo === "burn") passRate = clamp(passRate - 0.25, 0.08, 0.68);
  }
  if (state.features.downAndDistance) {
    passRate = clamp(passRate + distanceLean(state), 0.08, 0.92);
  }
  if (state.rand() < passRate) doPass(state);
  else doRush(state);
}

/**
 * How far the call leans toward the pass on this down and distance
 * (`downAndDistance` gate).
 *
 * The play-caller read the down and nothing else. Measured over 400 games it
 * ran the ball on 3rd-and-11+ seven times in ten, where a carry converted 7%
 * and a throw 23%, and threw on 3rd-and-1 a third of the time, where a throw
 * converted 53% and a carry 77%. No coach calls it that way; the distance is
 * the first thing he looks at.
 *
 * Short is a run, long is a pass, and the neutral downs run a little MORE so
 * the split over a game stays where `playCalling` put it — the lean moves
 * attempts from the downs where a throw is wasted to the ones where it is
 * needed, it does not add any. Over 400 games: carries 36 → 35, attempts
 * 16 → 18, third-down conversion 36% → 38%.
 */
function distanceLean(state: GameState): number {
  const { down, distance } = state;
  if (distance <= 2) return -LEAN_SHORT;
  if (down === 1) return -LEAN_NEUTRAL;
  if (distance >= 10) return LEAN_LONG;
  if (distance >= 7) return LEAN_MEDIUM;
  return -LEAN_NEUTRAL;
}

/** 1st-and-10, or anything-and-3-to-6: a little more run than the flat split. */
const LEAN_NEUTRAL = 0.08;
/** Two yards or fewer to go: hand it off. */
const LEAN_SHORT = 0.15;
/** Seven to nine: lean to the throw. */
const LEAN_MEDIUM = 0.15;
/** Ten or more on second down or later: throw it. */
const LEAN_LONG = 0.4;

/**
 * Going for it on fourth down: run or pass?
 *
 * v1 flipped a coin weighted 45% to the run whatever the distance, so
 * 4th-and-1 was a throw more often than not — 52% conversion against 81% on
 * the ground. Under `downAndDistance` the distance decides, with the same one
 * draw the coin used.
 */
function fourthDownGoRushRate(state: GameState): number {
  if (!state.features.downAndDistance) return 0.45;
  if (state.distance <= 2) return 0.8;
  if (state.distance <= 5) return 0.5;
  return 0.2;
}

function runScrimmagePlay(state: GameState): void {
  if (!state.features.situational) {
    if (shouldKneel(state)) {
      doKneel(state);
      return;
    }
    if (state.down === 4) {
      runFourthDownV1(state);
      return;
    }
    runNormalDownPlay(state, "normal");
    return;
  }

  /*
   * ── A3 path ─────────────────────────────────────────────────────────────
   *
   * Order matters and mirrors the real sequence between snaps: the clock is
   * running, somebody may stop it, and only then does a play happen.
   */
  const tempo = currentClockStrategy(state);
  const offenseSide = state.possession;
  const defenseSide = offenseSide === "home" ? "away" : "home";
  const halfLeft = secondsLeftInHalf(
    state.quarter,
    state.clockSeconds,
    state.inOvertime,
  );
  const gameLeft = secondsLeftInGame(
    state.quarter,
    state.clockSeconds,
    state.inOvertime,
  );
  const scoreDiff = offenseScoreDiff(state);

  // The trailing DEFENSE stops the clock to get the ball back at all.
  if (
    shouldUseTimeout({
      isOffense: false,
      scoreDiff: -scoreDiff,
      secondsLeftInHalf: halfLeft,
      secondsLeftInGame: gameLeft,
      quarter: state.quarter,
      timeoutsRemaining: timeoutsFor(state, defenseSide),
      clockStopped: state.clockStopped,
    })
  ) {
    doTimeout(state, defenseSide);
    return;
  }

  if (
    shouldUseTimeout({
      isOffense: true,
      scoreDiff,
      secondsLeftInHalf: halfLeft,
      secondsLeftInGame: gameLeft,
      quarter: state.quarter,
      timeoutsRemaining: timeoutsFor(state, offenseSide),
      clockStopped: state.clockStopped,
    })
  ) {
    doTimeout(state, offenseSide);
    return;
  }

  if (
    shouldSpike({
      strategy: tempo,
      secondsLeftInHalf: halfLeft,
      down: state.down,
      timeoutsRemaining: timeoutsFor(state, offenseSide),
      clockStopped: state.clockStopped,
    })
  ) {
    doSpike(state);
    return;
  }

  /*
   * The huddle and play clock between snaps. v1 folded this into each play's
   * duration and therefore charged it even to incompletions, which is what
   * capped a game at ~96 scrimmage plays.
   */
  /*
   * Scheme tempo scales the HUDDLE, not the play (A6) — which is what tempo
   * physically is. It therefore only has anything to scale when `situational`
   * is on, because the v1 clock model folded the huddle into each play's
   * duration and had no separate runoff to speed up.
   */
  tickClock(
    state,
    Math.round(runoffSeconds(tempo, state.clockStopped) * schemeMods(state).tempo),
  );
  state.clockStopped = false;
  if (state.clockSeconds <= 0) return;

  if (shouldKneel(state)) {
    doKneel(state);
    return;
  }

  if (state.down === 4) {
    const call = fourthDownDecision({
      yardsToGo: state.distance,
      yardsToGoal: yardsToGoal(state),
      scoreDiff,
      quarter: state.quarter,
      clockSeconds: state.clockSeconds,
      isOvertime: state.inOvertime,
      aggression: coachAggression(offenseTeam(state)),
      // Selecting the kicker draws nothing, so asking who he is costs nothing.
      fieldGoalRange: state.features.kickingGame
        ? fieldGoalRangeFor(selectPlayer(offenseTeam(state), "K", state))
        : undefined,
    });
    if (call === "field_goal") {
      doFieldGoalAttempt(state);
      return;
    }
    if (call === "punt") {
      doPunt(state);
      return;
    }
    // Going for it: the chart chose to go, a draw only picks run or pass.
    if (state.rand() < fourthDownGoRushRate(state)) doRush(state);
    else doPass(state);
    return;
  }

  state.pendingTempo = tempo === "normal" ? null : tempo;
  runNormalDownPlay(state, tempo);
  state.pendingTempo = null;
}

function simulateGameLog(input: PbpGameInput): PbpGameLog {
  const weights = weightsForFlavor(
    normalizeSimulationFlavor(input.flavor ?? DEFAULT_SIMULATION_FLAVOR),
  );
  const rand = mulberry32(input.seed >>> 0);
  const state: GameState = {
    rand,
    features: {
      scoringV2: input.features?.scoringV2 === true,
      penalties: input.features?.penalties === true,
      situational: input.features?.situational === true,
      balance: input.features?.balance === true,
      weather: input.features?.weather === true,
      injuries: input.features?.injuries === true,
      schemes: input.features?.schemes === true,
      timeline: input.features?.timeline === true,
      goalLineYards: input.features?.goalLineYards === true,
      goalLineConversion: input.features?.goalLineConversion === true,
      /*
       * `puntReturns` implies `returnStats`, and the implication is resolved
       * here rather than left to the reader. Its punts record a real return, so
       * a log that reported otherwise would tell a UI to distrust a number that
       * is in fact the good one.
       */
      returnStats:
        input.features?.returnStats === true || input.features?.puntReturns === true,
      puntReturns: input.features?.puntReturns === true,
      kickReturns: input.features?.kickReturns === true,
      defensivePat: input.features?.defensivePat === true,
      rushDistribution: input.features?.rushDistribution === true,
      playCalling: input.features?.playCalling === true,
      passingGame: input.features?.passingGame === true,
      kickingGame: input.features?.kickingGame === true,
      redZone: input.features?.redZone === true,
      downAndDistance: input.features?.downAndDistance === true,
      quarterBreak: input.features?.quarterBreak === true,
      puntReturner: input.features?.puntReturner === true,
      matchups: input.features?.matchups === true,
    },
    snaps: new Map(),
    unavailable: new Set(),
    injuries: [],
    /*
     * Default 1 (normal) rather than 0. A caller that enabled the gate but did
     * not pass a dial wants injuries at the usual rate — reading absence as
     * "off" would make the gate silently do nothing.
     */
    injurySeverityScale: input.injurySeverityScale ?? 1,
    home: input.home,
    away: input.away,
    strengthWeight: weights.strengthWeight,
    edgeScale: weights.edgeScale,
    /*
     * Crowd blending is a no-op with neutral inputs: `crowdHomeFieldEdge`
     * multiplies by exactly 1 when prestige is 50 and rivalry is 0, which is
     * every matchup nobody has configured.
     */
    homeFieldEdge:
      input.features?.weather === true
        ? crowdHomeFieldEdge({
            base:
              input.features?.balance === true
                ? HOME_FIELD_EDGE_V2
                : HOME_FIELD_EDGE,
            venuePrestige: input.venuePrestige,
            rivalryIntensity: input.rivalryIntensity,
          })
        : input.features?.balance === true
          ? HOME_FIELD_EDGE_V2
          : HOME_FIELD_EDGE,
    weatherMods:
      input.features?.weather === true && input.weather
        ? weatherModifiers(input.weather)
        : NEUTRAL_MODIFIERS,
    /*
     * Resolved once per game, not per play: a scheme is what a program runs,
     * and re-deriving it 120 times would be the same answer at 120x the cost.
     * Note the argument order — the modifiers describe the OFFENSE, so the
     * home-possession set is built from the home team's offense against the
     * away team's defense.
     */
    homeSchemeMods:
      input.features?.schemes === true
        ? possessionSchemeModifiers(input.home, input.away, true)
        : NEUTRAL_SCHEME_MODIFIERS,
    awaySchemeMods:
      input.features?.schemes === true
        ? possessionSchemeModifiers(input.away, input.home, true)
        : NEUTRAL_SCHEME_MODIFIERS,
    decisive: input.decisive ?? false,
    quarter: 1,
    clockSeconds: QUARTER_SECONDS,
    possession: "home",
    down: 1,
    distance: 10,
    fieldPosition: 25,
    homeScore: 0,
    awayScore: 0,
    drives: [],
    currentDrivePlays: [],
    currentDriveTeamId: null,
    driveStartQuarter: 1,
    driveStartClock: QUARTER_SECONDS,
    driveStartField: 25,
    driveId: 1,
    playId: 1,
    inOvertime: false,
    otPeriod: 0,
    gameOver: false,
    openingKickDone: false,
    secondHalfKickPending: false,
    homeTimeouts: TIMEOUTS_PER_HALF,
    awayTimeouts: TIMEOUTS_PER_HALF,
    clockStopped: true,
    pendingTempo: null,
  };

  doKickoff(state, "away");

  let safety = 0;
  while (!state.gameOver && safety < 500) {
    safety += 1;
    if (state.clockSeconds <= 0) {
      checkPeriodEnd(state);
      continue;
    }
    if (state.currentDriveTeamId === null) {
      startDrive(state, offenseTeamId(state), state.fieldPosition);
    }
    runScrimmagePlay(state);
    if (state.clockSeconds <= 0) checkPeriodEnd(state);
  }

  if (state.currentDriveTeamId !== null && state.currentDrivePlays.length > 0) {
    endDrive(state, state.gameOver ? "end_of_game" : "turnover");
  }

  /*
   * Timelines are attached in one pass at the end (A7), not inside
   * `recordPlay`, because a play is not finished when it is recorded: an
   * accepted flag is written onto it afterwards by `applyPlayResult`, and a
   * timeline built before that would be missing the beat the flag caused.
   *
   * Safe to run last because `playTimeline` is pure — it reads the play and
   * nothing else, and draws no randomness. Enabling this gate therefore adds
   * fields to a log without moving a single outcome in it.
   */
  if (state.features.timeline) {
    for (const drive of state.drives) {
      for (const play of drive.plays) {
        play.events = playTimeline(play);
      }
    }
  }

  return {
    seed: input.seed,
    decisive: state.decisive,
    homeTeamId: input.home.teamId,
    awayTeamId: input.away.teamId,
    homeScore: state.homeScore,
    awayScore: state.awayScore,
    drives: state.drives,
    /*
     * Record the conditions the game was ACTUALLY played under — only when the
     * gate was on. Absence means "not modelled", and a reader must not fill it
     * in from the derived forecast: the forecast is what a scheduled game shows,
     * not evidence about a game that has already happened.
     */
    ...(state.features.weather && input.weather
      ? { weather: input.weather }
      : {}),
    /*
     * Record which gates were live, so a reader never has to infer it from the
     * engine version. Omitted entirely when nothing was on — that absence is
     * what keeps a fully-gated-off log byte-identical to v1, which the golden
     * parity fixture pins.
     */
    ...(activeFeatures(state.features) ?? {}),
    /*
     * An empty array is not the same as absence here: it says injuries WERE
     * modelled and nobody got hurt, which a reader must be able to distinguish
     * from a game that never rolled for them.
     */
    ...(state.features.injuries ? { injuries: state.injuries } : {}),
  };
}

/**
 * `{ features }` when at least one gate is on, otherwise `null`.
 *
 * Only the gates that were ON are recorded. Writing `penalties: false` would
 * claim the engine considered penalties and declined, which is indistinguishable
 * in the data from a build that never had them — and Epic D's record book would
 * later read that claim as history.
 */
function activeFeatures(
  features: Required<PbpFeatureGates>,
): { features: PbpFeatureGates } | null {
  const active: PbpFeatureGates = {};
  for (const [key, value] of Object.entries(features)) {
    if (value === true) active[key as keyof PbpFeatureGates] = true;
  }
  return Object.keys(active).length > 0 ? { features: active } : null;
}

export { simulateGameLog, positionGroup, POSITION_TO_GROUP };
