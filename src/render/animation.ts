/*
 * Animation primitives — the language the choreographer speaks (A8).
 *
 * Deliberately free of Three.js, and of any renderer at all. A `PlayAnimation`
 * is 23 tracks of keyframes in plain numbers: it can be sampled in a Node test,
 * diffed in a fixture, or fed to something that is not WebGL. `scene.ts` is the
 * only file in the package that imports Three.
 *
 * The split matters more than it looks. Choreography is the part with judgment
 * in it — where a back cuts, when a safety arrives — and judgment is what you
 * want under test. Meshes and materials are not.
 */

/** World space: +x downfield, +y up, +z across. Units are yards. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Named motions an actor can be playing.
 *
 * A deliberately small vocabulary: eleven clips cover a football game at
 * gameplay camera distance, and every one of them is something a low-tier
 * voxel rig can express. The renderer decides what a clip LOOKS like — the
 * choreographer only says which one is running.
 */
export type ActorClip =
  | "stance"
  | "run"
  | "backpedal"
  | "block"
  | "throw"
  | "catch"
  | "kick"
  | "tackle"
  | "tackled"
  | "celebrate"
  | "kneel";

export interface ActorKeyframe {
  /** Seconds from the start of the play. */
  t: number;
  pos: Vec3;
  /**
   * The clip to start here, if it changes. Absent means "keep playing whatever
   * was running" — so a track states its motion at the moments it changes and
   * says nothing the rest of the time.
   */
  clip?: ActorClip;
}

export type ActorSide = "offense" | "defense" | "ball";

export interface ActorTrack {
  /**
   * Stable across every play: `OFF_0…OFF_10`, `DEF_0…DEF_10`, `BALL`.
   *
   * Stable so the renderer can keep one mesh per slot for the whole game and
   * move it, rather than building 22 actors every snap. What the slot IS
   * changes play to play — `OFF_9` is a receiver on a pass and a gunner on a
   * punt — which is what `label` is for.
   */
  actorId: string;
  side: ActorSide;
  /** What this slot is playing on THIS play: `QB`, `LT`, `CB1`, `K`, `RET`. */
  label: string;
  /**
   * The engine's player, when this slot is someone the engine named.
   *
   * Absent for the other twenty-odd bodies on the field, and honestly so: the
   * engine models a handful of participants per play and invents nobody to
   * fill the rest. A renderer can put a name over the ball carrier's head and
   * must leave the left guard anonymous.
   */
  playerId?: string;
  teamId?: string;
  keys: ActorKeyframe[];
}

export interface PlayCaption {
  t: number;
  text: string;
}

export interface PlayAnimation {
  playId: number;
  /** Seconds. The renderer is free to scale it; the beats hold their spacing. */
  duration: number;
  tracks: ActorTrack[];
  captions: PlayCaption[];
}

export interface ActorSample {
  pos: Vec3;
  clip: ActorClip;
  /**
   * Direction of travel in radians, ready for `object.rotation.y` on a model
   * whose rest pose faces +z (the glTF convention).
   *
   * Holds the last direction of travel while an actor is stationary, so a
   * player who stops does not snap back to facing downfield.
   */
  heading: number;
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** Ease in and out, so an actor accelerates rather than teleporting. */
function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

function headingOf(from: Vec3, to: Vec3, fallback: number): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return fallback;
  return Math.atan2(dx, dz);
}

/**
 * Where an actor is at time `t`, and what it is doing.
 *
 * Clamps at both ends: before the first keyframe an actor is in its stance,
 * after the last it holds its final pose. That is what lets the renderer run a
 * play out past the whistle without special-casing the tail.
 */
export function sampleTrack(track: ActorTrack, t: number): ActorSample {
  const keys = track.keys;
  if (keys.length === 0) {
    return { pos: { x: 0, y: 0, z: 0 }, clip: "stance", heading: 0 };
  }

  // The clip in force is the most recent one declared at or before `t`, which
  // is why a keyframe may leave `clip` unset.
  let clip: ActorClip = keys[0].clip ?? "stance";
  let heading = 0;
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1];
    const next = keys[i];
    const moved = headingOf(prev.pos, next.pos, Number.NaN);
    if (t >= prev.t && !Number.isNaN(moved)) heading = moved;
    if (t <= next.t) {
      if (t >= prev.t) {
        const span = next.t - prev.t;
        const u = span <= 1e-6 ? 1 : smoothstep((t - prev.t) / span);
        return {
          pos: {
            x: lerp(prev.pos.x, next.pos.x, u),
            y: lerp(prev.pos.y, next.pos.y, u),
            z: lerp(prev.pos.z, next.pos.z, u),
          },
          clip,
          heading,
        };
      }
      break;
    }
    if (next.clip) clip = next.clip;
  }

  const first = keys[0];
  if (t <= first.t) {
    return { pos: { ...first.pos }, clip: first.clip ?? "stance", heading: 0 };
  }
  const last = keys[keys.length - 1];
  return { pos: { ...last.pos }, clip, heading };
}

/** Every actor's state at `t`, keyed by `actorId`. */
export function sampleAnimation(
  animation: PlayAnimation,
  t: number,
): Map<string, ActorSample> {
  const out = new Map<string, ActorSample>();
  for (const track of animation.tracks) out.set(track.actorId, sampleTrack(track, t));
  return out;
}

/** The captions that fall inside `(from, to]` — one frame's worth. */
export function captionsBetween(
  animation: PlayAnimation,
  from: number,
  to: number,
): PlayCaption[] {
  return animation.captions.filter((c) => c.t > from && c.t <= to);
}
