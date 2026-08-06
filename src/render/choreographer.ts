import type { PbpGameLog, PbpParticipantRole, PbpPlay } from "../pbp/types.js";
import type { PbpSimEvent } from "../pbp/timeline.js";
import { playTimeline } from "../pbp/timeline.js";
import { driveDirection, fieldPoint, UPRIGHT_DEPTH } from "./field.js";
import {
  DEFENSE_FORMATIONS,
  OFFENSE_FORMATIONS,
  formationsFor,
  type SlotSpec,
} from "./formations.js";
import type {
  ActorClip,
  ActorKeyframe,
  ActorTrack,
  PlayAnimation,
  PlayCaption,
  Vec3,
} from "./animation.js";
import { describePenalty, describePlay } from "./describe.js";

/*
 * The choreographer (A8) — an engine play becomes twenty-three moving bodies.
 *
 * ## The contract
 *
 * It is theatre, and it is theatre with one hard rule: **the performance must
 * agree with the result.** The engine already decided that this was a 6-yard
 * run tackled by a linebacker. The choreographer decides which gap he hit and
 * when the linebacker arrived — never whether he got the six.
 *
 * So every position that MATTERS comes from `PbpSimEvent.spot`, which the
 * engine's own timeline produced, and only the parts nobody can contradict —
 * lanes, routes, pursuit angles, who blocks whom — are invented here.
 *
 * ## Deterministic
 *
 * No `Math.random()`. Where a choice is arbitrary (which gap, which side the
 * receiver aligns to) it is drawn from a hash of `playId`, so watching a game
 * twice shows the same game twice, and a replay of one play is that play. The
 * engine earns its determinism the hard way; a renderer that threw it away at
 * the last step would make every bug in it unreproducible.
 *
 * ## Three-free
 *
 * Plain numbers out. `scene.ts` turns them into meshes.
 */

export interface ChoreographyContext {
  /** Which team attacks +x. The renderer's only piece of game-level context. */
  homeTeamId: string;
}

/** Ball height, in yards, in the various states of its life. */
const BALL_ON_GROUND = 0.14;
const BALL_CARRIED = 1;
const BALL_IN_HAND = 1.55;
const PASS_APEX = 4.5;
const DEEP_PASS_APEX = 7.5;
const KICK_APEX = 17;

const PLAYER_ON_FEET = 0;

/**
 * A deterministic 0–1 from an integer.
 *
 * Same play id, same choreography, forever. See the module header.
 */
function hash01(n: number, salt = 0): number {
  let x = Math.imul((n + 1) ^ (salt * 0x9e3779b9), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * Hold a player between the end lines.
 *
 * Two things push people off the field if you let them. Formations: a safety
 * lined up thirteen yards deep is standing in the parking lot when the ball is
 * on the opponent's one. And pursuit: everyone chases where the ball finished,
 * and the ball is allowed to leave — a made kick clears the uprights ten yards
 * past the goal line — while a linebacker following it is a bug every time.
 */
function onField(spot: number): number {
  return Math.max(-5, Math.min(105, spot));
}

/** A slot on the field: its spec, its track, and where it lined up. */
interface Slot {
  spec: SlotSpec;
  track: ActorTrack;
  base: { depth: number; lateral: number };
}

class Choreography {
  readonly play: PbpPlay;
  readonly direction: 1 | -1;
  readonly los: number;
  readonly offense: Slot[] = [];
  readonly defense: Slot[] = [];
  readonly ball: ActorTrack;
  readonly captions: PlayCaption[] = [];
  /**
   * Which body is playing which engine role, decided once.
   *
   * The single source of truth for casting. Every beat reads it rather than
   * working out for itself who the tackler was, so the man credited with the
   * tackle and the man who arrives at the ball cannot be different people.
   */
  readonly cast = new Map<PbpParticipantRole, Slot>();

  /** Who is holding the ball, so the next beat knows what to move. */
  carrier: Slot | null = null;
  /** The carrier's lateral position, carried between beats. */
  lane = 0;

  constructor(play: PbpPlay, context: ChoreographyContext) {
    this.play = play;
    this.direction = driveDirection(play, context.homeTeamId);
    this.los = play.fieldPosition;

    const sets = formationsFor(play);
    OFFENSE_FORMATIONS[sets.offense].forEach((spec, i) => {
      this.offense.push(this.makeSlot(`OFF_${i}`, "offense", spec, play.offenseTeamId));
    });
    DEFENSE_FORMATIONS[sets.defense].forEach((spec, i) => {
      this.defense.push(this.makeSlot(`DEF_${i}`, "defense", spec, play.defenseTeamId));
    });

    this.ball = {
      actorId: "BALL",
      side: "ball",
      label: "BALL",
      keys: [{ t: 0, pos: this.point(this.los, 0, BALL_ON_GROUND) }],
    };
  }

  private makeSlot(
    actorId: string,
    side: "offense" | "defense",
    spec: SlotSpec,
    teamId: string,
  ): Slot {
    const base = { depth: spec.depth, lateral: spec.lateral };
    return {
      spec,
      base,
      track: {
        actorId,
        side,
        label: spec.label,
        teamId,
        keys: [
          {
            t: 0,
            pos: this.point(onField(this.los + spec.depth), spec.lateral, PLAYER_ON_FEET),
            clip: "stance",
          },
        ],
      },
    };
  }

  /** An engine spot plus an offense-relative lateral, in world space. */
  point(spot: number, lateral: number, height = 0): Vec3 {
    return fieldPoint(spot, lateral, this.direction, height);
  }

  find(side: Slot[], label: string): Slot | undefined {
    return side.find((s) => s.spec.label === label);
  }

  /** Move a player. Spots are clamped by `onField`. */
  key(slot: Slot, t: number, spot: number, lateral: number, clip?: ActorClip): void {
    slot.track.keys.push({ t, pos: this.point(onField(spot), lateral), clip });
  }

  ballKey(t: number, spot: number, lateral: number, height: number): void {
    this.ball.keys.push({ t, pos: this.point(spot, lateral, height) });
  }

  /** The ball in flight: a mid keyframe is what makes the arc an arc. */
  ballFlight(
    from: { t: number; spot: number; lateral: number; height: number },
    to: { t: number; spot: number; lateral: number; height: number },
    apex: number,
  ): void {
    this.ballKey(from.t, from.spot, from.lateral, from.height);
    this.ballKey(
      (from.t + to.t) / 2,
      (from.spot + to.spot) / 2,
      (from.lateral + to.lateral) / 2,
      apex,
    );
    this.ballKey(to.t, to.spot, to.lateral, to.height);
  }

  /** The last position an actor was written to, for continuing a path. */
  lastOf(slot: Slot): ActorKeyframe {
    return slot.track.keys[slot.track.keys.length - 1];
  }
}

/**
 * One play, choreographed.
 *
 * Works on any play from any log: when `play.events` is absent — a v1 log, or
 * one simulated with the `timeline` gate off — it lays the play out on the spot
 * with `playTimeline`, which is pure and produces the same beats the engine
 * would have written.
 */
export function choreograph(
  play: PbpPlay,
  context: ChoreographyContext,
): PlayAnimation {
  const c = new Choreography(play, context);
  const events = play.events?.length ? play.events : playTimeline(play);

  // A timeout: everyone stands. Rendering nothing at all would drop the
  // scoreboard beat a viewer is actually there for, so the field holds.
  if (events.length === 0) {
    return {
      playId: play.playId,
      duration: 0.8,
      tracks: [...c.offense.map((s) => s.track), ...c.defense.map((s) => s.track), c.ball],
      captions: [{ t: 0, text: describePlay(play) }],
    };
  }

  assignParticipants(c);
  const duration = walkEvents(c, events);
  fillAmbientMotion(c, duration);
  addCaptions(c, events, duration);

  const tracks = [
    ...c.offense.map((s) => s.track),
    ...c.defense.map((s) => s.track),
    c.ball,
  ];
  // Keyframes are written in beat order, but ambient motion is appended after
  // the fact and lands mid-play. Sorting is stable, so simultaneous keys keep
  // the order the choreography stated them in.
  for (const track of tracks) track.keys.sort((a, b) => a.t - b.t);
  standUp(tracks, duration);

  return { playId: play.playId, duration, tracks, captions: c.captions };
}

/** How long a man takes to push up off the turf and be standing again. */
const GETUP_SECONDS = 0.34;
/**
 * How long he is on his feet before the play ends.
 *
 * Not zero, and that is the whole subtlety: `sampleTrack` holds the clip of the
 * keyframe it is moving FROM, so a pose placed exactly at `duration` is never
 * the pose in force. Landing "stance" on the last frame would leave every
 * tackled player frozen halfway up — a worse artefact than lying still, and one
 * that looks deliberate.
 */
const GETUP_HOLD = 0.1;
/** Below this much dead time after the tackle, he simply stays down. */
const GETUP_ROOM = 0.55;

/**
 * Put anyone still face-down back on his feet before the play ends.
 *
 * Plays run back-to-back — the next snap begins the frame after this one ends —
 * so a man left prone at the whistle does not lie there, he teleports upright
 * into the next formation. The pop is what reads as wrong, and it is worst on
 * exactly the plays a viewer is watching closely.
 *
 * This costs no extra time. The whistle already leaves about a second of tail
 * in which a tackled player is lying still, so the rise fits in dead air that
 * was being spent on nothing. Plays whose tackle lands too near the end are
 * left alone rather than being stretched: a slightly longer play would desync
 * the animation from the clock the engine actually charged.
 */
function standUp(tracks: ActorTrack[], duration: number): void {
  for (const track of tracks) {
    const last = track.keys[track.keys.length - 1];
    if (!last || last.clip !== "tackled") continue;
    if (duration - last.t < GETUP_ROOM) continue;

    // Same spot he was tackled on — getting up is not a change of position.
    const upright = duration - GETUP_HOLD;
    track.keys.push({
      t: upright - GETUP_SECONDS,
      pos: { ...last.pos },
      clip: "getup",
    });
    track.keys.push({ t: upright, pos: { ...last.pos }, clip: "stance" });
  }
}

/** Every play in a log, in order. */
export function choreographLog(log: PbpGameLog): PlayAnimation[] {
  const context = { homeTeamId: log.homeTeamId };
  return log.drives.flatMap((drive) =>
    drive.plays.map((play) => choreograph(play, context)),
  );
}

/*
 * ── Casting ───────────────────────────────────────────────────────────────
 *
 * The engine names a handful of players per play. Those names go on the slots
 * that plausibly did the job; the rest of the field stays anonymous, which is
 * the honest rendering of a model that never claimed to know who the right
 * guard was.
 */
function assignParticipants(c: Choreography): void {
  const { play } = c;

  /**
   * Give a role the first slot on its preference list that is still free, and
   * remember it.
   *
   * Two rules, both learned the hard way:
   *
   * 1. **One body per player.** The engine can name the same man twice — a
   *    thin roster gets the same linebacker credited with the solo tackle AND
   *    the assist — and casting him twice would put one player in two places
   *    on the field. When a name is already out there, the second role points
   *    at the same body.
   * 2. **Beats read the cast; they never re-derive it.** Every later beat asks
   *    `c.slotFor(role)`. Recomputing "who was the tackler" at the moment of
   *    the tackle is how the tackler ends up fourteen yards from the ball.
   */
  const claim = (role: PbpParticipantRole, preferences: (Slot | undefined)[]) => {
    const named = play.participants.find((p) => p.role === role);
    if (!named) return;

    const already = [...c.offense, ...c.defense].find(
      (s) => s.track.playerId === named.playerId,
    );
    if (already) {
      c.cast.set(role, already);
      return;
    }

    const slot = preferences.find((s): s is Slot => s !== undefined && !s.track.playerId);
    if (!slot) return;
    slot.track.playerId = named.playerId;
    c.cast.set(role, slot);
  };

  claim("passer", [c.find(c.offense, "QB")]);
  claim("rusher", [
    // A kneel's rusher IS the quarterback, and the victory formation has him
    // under center — putting him in the backfield would look like a handoff
    // that never happened.
    play.playType === "kneel" ? c.find(c.offense, "QB") : c.find(c.offense, "RB"),
    c.find(c.offense, "RB2"),
    c.find(c.offense, "QB"),
  ]);
  claim("kicker", [c.find(c.offense, "K"), c.find(c.offense, "P")]);
  claim("receiver", [targetSlot(c), ...receiverSlots(c)]);
  claim("returner", [c.find(c.defense, "RET")]);
  claim("sacker", [...rushSlots(c)]);
  claim("interceptor", [...coverageSlots(c)]);
  claim("pass_defender", [...coverageSlots(c)]);
  claim("fumbler", [c.find(c.offense, "RB"), c.find(c.offense, "QB")]);
  claim("tackler_solo", [...pursuitSlots(c)]);
  claim("recoverer", [...pursuitSlots(c)]);
  claim("tackler_ast", [...pursuitSlots(c)]);
}

function receiverSlots(c: Choreography): Slot[] {
  return ["WR1", "WR2", "WR3", "TE", "RB"]
    .map((label) => c.find(c.offense, label))
    .filter((s): s is Slot => s !== undefined);
}

/** Which receiver the pass went to — arbitrary, so drawn from the play id. */
function targetSlot(c: Choreography): Slot | undefined {
  const cast = c.cast.get("receiver");
  if (cast) return cast;
  const options = receiverSlots(c).filter((s) => s.spec.label !== "RB");
  if (options.length === 0) return undefined;
  return options[Math.floor(hash01(c.play.playId, 1) * options.length)];
}

/** Pass rushers, in a deterministic order. */
function rushSlots(c: Choreography): Slot[] {
  const rushers = ["DE1", "DE2", "DT1", "DT2", "NT"]
    .map((label) => c.find(c.defense, label))
    .filter((s): s is Slot => s !== undefined);
  const start = Math.floor(hash01(c.play.playId, 2) * Math.max(1, rushers.length));
  return [...rushers.slice(start), ...rushers.slice(0, start)];
}

/** Defensive backs, nearest the target first. */
function coverageSlots(c: Choreography): Slot[] {
  const lane = targetSlot(c)?.base.lateral ?? 0;
  return c.defense
    .filter((s) => /^(CB|S)/.test(s.spec.label))
    .sort((a, b) => Math.abs(a.base.lateral - lane) - Math.abs(b.base.lateral - lane));
}

/** Everyone who could make the tackle, nearest the play's lane first. */
function pursuitSlots(c: Choreography): Slot[] {
  const lane = endLane(c);
  return c.defense
    .filter((s) => s.spec.label !== "RET")
    .sort((a, b) => Math.abs(a.base.lateral - lane) - Math.abs(b.base.lateral - lane));
}

/** The slot a beat should move for a role, cast or not. */
function actorFor(
  c: Choreography,
  role: PbpParticipantRole,
  fallback: Slot | undefined,
): Slot | undefined {
  return c.cast.get(role) ?? fallback;
}

/** The lane the play finished in — the gap a run hit, the side a pass went. */
function endLane(c: Choreography): number {
  const spread = c.play.playType === "rush" ? 7 : 14;
  return (hash01(c.play.playId, 4) * 2 - 1) * spread;
}

/*
 * ── The event walk ────────────────────────────────────────────────────────
 *
 * One pass over the engine's beats. Each one moves the ball and whoever is
 * touching it; everybody else is filled in afterwards.
 */
function walkEvents(c: Choreography, events: readonly PbpSimEvent[]): number {
  const lane = endLane(c);
  const qb = c.find(c.offense, "QB");
  const kicker = c.find(c.offense, "K") ?? c.find(c.offense, "P");
  let flightFrom: { t: number; spot: number; lateral: number; height: number } | null =
    null;
  let duration = 1;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const spot = ev.spot ?? c.los;
    const next = events[i + 1];

    switch (ev.type) {
      case "snap": {
        const center = c.find(c.offense, "C");
        if (center) c.key(center, 0.15, c.los, center.base.lateral, "block");
        c.ballKey(0, c.los, 0, BALL_ON_GROUND);
        if (qb) {
          const catchSnap = qb.base.depth < -3 ? 0.35 : 0.12;
          c.ballKey(catchSnap, c.los + qb.base.depth, qb.base.lateral, BALL_IN_HAND);
          c.carrier = qb;
          c.lane = qb.base.lateral;
        }
        break;
      }

      case "handoff": {
        const back = c.find(c.offense, "RB");
        if (!back) break;
        // The exchange happens in the backfield, then the back works to his
        // gap before he gets downhill.
        c.key(back, ev.t - 0.35, c.los - 3.5, back.base.lateral * 0.5, "run");
        c.key(back, ev.t, spot, 0, "run");
        /*
         * Reaching the hole has to happen BEFORE the play ends. A one-yard run
         * is over 0.35s after the handoff, and a fixed 0.45s cut would be the
         * last keyframe on the ball — leaving it at the line of scrimmage after
         * a gain the engine had already awarded.
         */
        const toGap = next ? Math.min(ev.t + 0.45, next.t - 0.08) : ev.t + 0.45;
        if (toGap > ev.t) {
          c.key(back, toGap, c.los - 0.5, lane * 0.7, "run");
          c.ballKey(toGap, c.los - 0.5, lane * 0.7, BALL_CARRIED);
        }
        c.ballKey(ev.t, spot, 0, BALL_CARRIED);
        c.carrier = back;
        c.lane = lane * 0.7;
        break;
      }

      case "pass_release": {
        if (qb) {
          c.key(qb, ev.t - 0.45, spot, 0, "backpedal");
          c.key(qb, ev.t, spot, 0, "throw");
        }
        flightFrom = { t: ev.t, spot, lateral: 0, height: BALL_IN_HAND };
        c.ballKey(ev.t, spot, 0, BALL_IN_HAND);
        c.carrier = null;
        break;
      }

      case "catch": {
        const target = actorFor(c, "receiver", targetSlot(c));
        const routeLane = target ? routeLateral(target) : lane;
        if (target) {
          c.key(target, ev.t - 0.6, (c.los + spot) / 2, target.base.lateral, "run");
          c.key(target, ev.t, spot, routeLane, "catch");
        }
        landPass(c, flightFrom, ev.t, spot, routeLane, BALL_IN_HAND);
        flightFrom = null;
        c.carrier = target ?? null;
        c.lane = routeLane;
        break;
      }

      case "incompletion": {
        const target = actorFor(c, "receiver", targetSlot(c));
        const routeLane = target ? routeLateral(target) : lane;
        if (target) c.key(target, ev.t, spot, routeLane, "run");
        landPass(c, flightFrom, ev.t, spot, routeLane, BALL_IN_HAND * 0.6);
        // And onto the turf, which is the beat that reads as "incomplete".
        c.ballKey(ev.t + 0.35, spot + 1, routeLane, BALL_ON_GROUND);
        flightFrom = null;
        c.carrier = null;
        break;
      }

      case "interception": {
        const defender = actorFor(c, "interceptor", coverageSlots(c)[0]);
        const target = targetSlot(c);
        const routeLane = target ? routeLateral(target) : lane;
        if (defender) c.key(defender, ev.t, spot, routeLane, "catch");
        landPass(c, flightFrom, ev.t, spot, routeLane, BALL_IN_HAND);
        flightFrom = null;
        c.carrier = defender ?? null;
        c.lane = routeLane;
        break;
      }

      case "sack": {
        const rusher = actorFor(c, "sacker", rushSlots(c)[0]);
        const lateral = lane * 0.3;
        if (qb) {
          c.key(qb, ev.t - 0.5, spot + 1.5, lateral * 0.5, "backpedal");
          c.key(qb, ev.t, spot, lateral, "tackled");
        }
        if (rusher) {
          c.key(rusher, ev.t - 0.5, c.los - 2, rusher.base.lateral * 0.6, "run");
          c.key(rusher, ev.t, spot - 0.6, lateral, "tackle");
        }
        c.ballKey(ev.t, spot, lateral, BALL_CARRIED);
        c.lane = lateral;
        break;
      }

      case "fumble": {
        // Loose and bouncing: up out of the carrier's hands, then down.
        c.ballKey(ev.t, spot, c.lane, BALL_IN_HAND);
        c.ballKey(ev.t + 0.25, spot + 1.5, c.lane + 1, 2.1);
        c.ballKey(ev.t + 0.5, spot + 2.5, c.lane + 1.5, BALL_ON_GROUND);
        if (c.carrier) c.key(c.carrier, ev.t + 0.2, spot, c.lane, "tackled");
        c.carrier = null;
        break;
      }

      case "recovery": {
        const recoverer =
          ev.teamId === c.play.defenseTeamId
            ? actorFor(c, "recoverer", pursuitSlots(c)[0])
            : actorFor(c, "rusher", c.find(c.offense, "RB"));
        if (recoverer) {
          c.key(recoverer, ev.t - 0.4, spot + 3, c.lane + 2, "run");
          c.key(recoverer, ev.t, spot, c.lane + 1.5, "tackle");
        }
        c.ballKey(ev.t, spot, c.lane + 1.5, BALL_ON_GROUND);
        c.carrier = recoverer ?? null;
        break;
      }

      case "kick": {
        if (kicker) c.key(kicker, ev.t, spot, kicker.base.lateral, "kick");
        // The snap travels back to the kicker before he hits it.
        c.ballKey(Math.max(0.05, ev.t - 0.7), c.los, 0, BALL_ON_GROUND);
        c.ballKey(ev.t - 0.1, spot, kicker?.base.lateral ?? 0, 0.6);
        flightFrom = {
          t: ev.t,
          spot,
          lateral: kicker?.base.lateral ?? 0,
          height: 0.6,
        };
        c.carrier = null;
        break;
      }

      case "kick_result": {
        const target = placekickTarget(c, spot);
        if (flightFrom) {
          c.ballFlight(
            flightFrom,
            { t: ev.t, spot: target.spot, lateral: target.lateral, height: target.height },
            KICK_APEX,
          );
        }
        flightFrom = null;
        // A punt's net spot is where the ball is dead, so somebody is standing
        // there — the engine named the returner even though it resolved the
        // return as one number.
        const returner = actorFor(c, "returner", c.find(c.defense, "RET"));
        if (returner && isPunt(c)) {
          c.key(returner, ev.t - 0.8, spot + 6, 0, "run");
          c.key(returner, ev.t, spot, 0, "catch");
          c.key(returner, ev.t + 0.4, spot, 0, "tackled");
        }
        break;
      }

      case "return_start": {
        const returner =
          actorFor(c, "returner", c.find(c.defense, "RET")) ??
          actorFor(c, "interceptor", coverageSlots(c)[0]);
        if (returner) {
          c.key(returner, ev.t - 0.3, spot + 2, 0, "run");
          c.key(returner, ev.t, spot, 0, "catch");
        }
        if (flightFrom) {
          c.ballFlight(
            flightFrom,
            { t: ev.t, spot, lateral: 0, height: BALL_CARRIED },
            KICK_APEX,
          );
          flightFrom = null;
        } else {
          c.ballKey(ev.t, spot, c.lane, BALL_CARRIED);
        }
        c.carrier = returner ?? null;
        c.lane = 0;
        break;
      }

      case "tackle": {
        const returnLane = c.carrier?.track.side === "defense" ? lane * 0.5 : c.lane;
        if (c.carrier) c.key(c.carrier, ev.t, spot, returnLane, "tackled");
        const tackler = actorFor(c, "tackler_solo", pursuitSlots(c)[0]);
        // On a return the tackler is a coverage man, not the front seven.
        const cover = c.carrier?.track.side === "defense" ? coverageManFor(c) : tackler;
        if (cover && cover !== c.carrier) {
          c.key(cover, ev.t - 0.5, spot + 4, returnLane + 2, "run");
          c.key(cover, ev.t, spot + 0.7, returnLane, "tackle");
        }
        c.ballKey(ev.t, spot, returnLane, BALL_CARRIED);
        c.lane = returnLane;
        break;
      }

      case "touchdown": {
        const scorer = c.carrier;
        const endLateral = c.carrier?.track.side === "defense" ? lane * 0.5 : c.lane;
        // Through the goal line, not stopped on it.
        const through = spot === 0 ? -3 : spot + 3;
        if (scorer) {
          c.key(scorer, ev.t, spot, endLateral, "run");
          c.key(scorer, ev.t + 0.5, through, endLateral, "celebrate");
        }
        c.ballKey(ev.t, spot, endLateral, BALL_CARRIED);
        c.ballKey(ev.t + 0.5, through, endLateral, BALL_CARRIED);
        break;
      }

      case "safety": {
        const tackler = actorFor(c, "tackler_solo", pursuitSlots(c)[0]);
        if (tackler) c.key(tackler, ev.t, 1, 0, "tackle");
        c.ballKey(ev.t, 0.5, 0, BALL_CARRIED);
        break;
      }

      case "injury": {
        const hurt = [...c.offense, ...c.defense].find(
          (s) => s.track.playerId === ev.playerId,
        );
        if (hurt) {
          const last = c.lastOf(hurt);
          hurt.track.keys.push({ t: ev.t, pos: { ...last.pos }, clip: "tackled" });
        }
        break;
      }

      case "flag":
        // Nothing moves for a flag; it is a caption and a whistle.
        break;

      case "whistle":
        duration = ev.t + 0.4;
        break;
    }

    if (next === undefined) duration = Math.max(duration, ev.t + 0.6);
  }

  return duration;
}

function isPunt(c: Choreography): boolean {
  return c.play.playType === "punt";
}

/** Where a placekick actually finishes: through the uprights, or wide. */
function placekickTarget(
  c: Choreography,
  spot: number,
): { spot: number; lateral: number; height: number } {
  const type = c.play.playType;
  const good = type === "field_goal" || type === "extra_point";
  const missed = type === "field_goal_miss" || type === "extra_point_miss";
  if (!good && !missed) return { spot, lateral: 0, height: BALL_ON_GROUND };

  // The engine's event stops at the goal line because that is as far as its
  // coordinate system goes. The ball does not.
  const beyond = 100 + UPRIGHT_DEPTH;
  if (good) return { spot: beyond, lateral: 0, height: 5.2 };
  // Wide, and which way is arbitrary — so it is hashed rather than always left.
  const side = hash01(c.play.playId, 5) < 0.5 ? -1 : 1;
  return { spot: beyond, lateral: side * 7.5, height: 4.4 };
}

/** Land a pass that is already in flight; a no-op if nothing was thrown. */
function landPass(
  c: Choreography,
  from: { t: number; spot: number; lateral: number; height: number } | null,
  t: number,
  spot: number,
  lateral: number,
  height: number,
): void {
  if (!from) {
    c.ballKey(t, spot, lateral, height);
    return;
  }
  const air = Math.abs(spot - from.spot);
  c.ballFlight(
    from,
    { t, spot, lateral, height },
    air > 18 ? DEEP_PASS_APEX : PASS_APEX,
  );
}

/** Where a receiver ends up laterally — his split, pulled toward the ball. */
function routeLateral(target: Slot): number {
  return target.base.lateral * 0.65;
}

/** A coverage player to run down a returner. */
function coverageManFor(c: Choreography): Slot | undefined {
  const cover = c.offense.filter((s) => /^(C\d|G\d|W\d)/.test(s.spec.label));
  if (cover.length === 0) return c.find(c.offense, "K");
  return cover[Math.floor(hash01(c.play.playId, 6) * cover.length)];
}

/*
 * ── Everyone else ─────────────────────────────────────────────────────────
 *
 * Eighteen players the engine never mentioned still have to look like they are
 * playing football. This is pure invention and it is the right kind: a viewer
 * cannot be misled about an outcome by a left guard's footwork, and a field
 * where only three people move reads as broken.
 */
function fillAmbientMotion(c: Choreography, duration: number): void {
  const lane = endLane(c);
  const finalSpot = ballFinalSpot(c);

  for (const slot of c.offense) {
    if (slot.track.keys.length > 1) continue;
    const label = slot.spec.label;

    if (/^(LT|LG|C|RG|RT)$/.test(label)) {
      // Fire out, then stalemate — a yard and a half of push over two seconds.
      c.key(slot, 0.2, c.los + 0.4, slot.base.lateral, "block");
      c.key(slot, Math.min(2.2, duration), c.los + 1.6, slot.base.lateral * 1.15, "block");
      continue;
    }

    if (/^(WR|TE)/.test(label)) {
      runRoute(c, slot, duration);
      continue;
    }

    if (/^(C\d|G\d)/.test(label)) {
      // Kick coverage: sprint, then break down around the returner.
      c.key(slot, 0.4, c.los + 4, slot.base.lateral, "run");
      c.key(slot, duration * 0.85, finalSpot - 3, slot.base.lateral * 0.55, "run");
      continue;
    }

    if (label === "H" || label === "PP" || /^W\d/.test(label)) {
      c.key(slot, 0.6, c.los + slot.base.depth * 0.6, slot.base.lateral, "block");
      continue;
    }

    // Backs and quarterbacks with nothing to do: a step, so they are not statues.
    c.key(slot, 0.8, c.los + slot.base.depth - 1, slot.base.lateral, "run");
  }

  for (const slot of c.defense) {
    if (slot.track.keys.length > 1) continue;
    const label = slot.spec.label;

    if (/^(DE|DT|NT)/.test(label)) {
      c.key(slot, 0.2, c.los + 0.6, slot.base.lateral * 0.9, "run");
      c.key(slot, Math.min(2.4, duration), c.los - 1.4, slot.base.lateral * 0.7, "run");
      continue;
    }

    if (label === "RET") {
      // He fielded nothing this play; hold him where he was.
      continue;
    }

    /*
     * Pursuit. They converge on the ball but stop short of it by a hashed
     * amount, so eleven defenders do not stack on one pixel — and the man the
     * engine DID name is already there, ahead of them, which is what sells the
     * tackle as his.
     */
    const stand = 2 + hash01(c.play.playId, slot.base.lateral + 20) * 6;
    c.key(
      slot,
      duration * 0.9,
      finalSpot + stand * (c.play.yardsGained >= 0 ? 1 : -1),
      slot.base.lateral * 0.45 + lane * 0.3,
      "run",
    );
  }
}

/** Where the ball ended up, for everyone else to run at. */
function ballFinalSpot(c: Choreography): number {
  const last = c.ball.keys[c.ball.keys.length - 1];
  // Back out of world space rather than re-deriving from the play, so pursuit
  // agrees with wherever the beats actually put the ball.
  const absolute = last.pos.x + 50;
  return c.direction === 1 ? absolute : 100 - absolute;
}

function runRoute(c: Choreography, slot: Slot, duration: number): void {
  const depth = 6 + hash01(c.play.playId, slot.base.lateral) * 12;
  const breakIn = hash01(c.play.playId, slot.base.lateral + 7) < 0.5 ? -1 : 1;
  const stem = Math.min(duration * 0.55, 2.2);
  c.key(slot, 0.25, c.los + 1.5, slot.base.lateral, "run");
  c.key(slot, stem, c.los + depth, slot.base.lateral * 0.95, "run");
  c.key(
    slot,
    Math.min(duration, stem + 1.1),
    c.los + depth + 3,
    slot.base.lateral * 0.95 + breakIn * 4,
    "run",
  );
}

function addCaptions(
  c: Choreography,
  events: readonly PbpSimEvent[],
  duration: number,
): void {
  const flag = events.find((e) => e.type === "flag");
  const penalty = describePenalty(c.play);
  if (flag && penalty) c.captions.push({ t: flag.t, text: penalty });
  c.captions.push({ t: Math.max(0, duration - 0.5), text: describePlay(c.play) });
}
