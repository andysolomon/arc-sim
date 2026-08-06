import * as THREE from "three";
import {
  sampleTrack,
  type ActorClip,
  type ActorSample,
  type PlayAnimation,
} from "./animation.js";
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH, UPRIGHT_DEPTH } from "./field.js";
import { PlayerRig, disposeRigGeometries, type RigTier } from "./rig.js";

/*
 * The scene (A8) — with `rig.ts`, one of the two files in this package that
 * know Three.js exists.
 *
 * Everything above it is numbers: the engine decides the game, `timeline.ts`
 * decides the beats, `choreographer.ts` decides the motion. This file just
 * draws it — and because the split held, replacing the placeholder capsules
 * with the voxel / medium / hero rigs changed `PlayerActor` and nothing else.
 *
 * Playback is decoupled from simulation on purpose. The engine finishes a game
 * in milliseconds; the scene replays it at whatever speed the viewer wants —
 * `speed = 0` skips the animation entirely and just applies the result, which
 * is the same code path as watching, not a second implementation of it.
 */

export interface TeamAppearance {
  /** Jersey. */
  primary: number;
  /** Helmet and trim. */
  secondary: number;
}

export interface FootballSceneOptions {
  canvas?: HTMLCanvasElement;
  width?: number;
  height?: number;
  home?: TeamAppearance;
  away?: TeamAppearance;
  /** Which side each animation's offense belongs to, for colouring. */
  homeTeamId: string;
}

/** Broadcast camera geometry: elevation and how far off the sideline it sits. */
const CAMERA_HEIGHT = 30;
const CAMERA_SIDELINE = 46;
/** Aim past the ball, across the field, so grass fills the frame not sky. */
const CAMERA_LOOK_ACROSS = 8;

const DEFAULT_HOME: TeamAppearance = { primary: 0x1d3f8f, secondary: 0xf2f4f8 };
const DEFAULT_AWAY: TeamAppearance = { primary: 0xb3272d, secondary: 0x1b1b1f };

const ACTOR_IDS = [
  ...Array.from({ length: 11 }, (_, i) => `OFF_${i}`),
  ...Array.from({ length: 11 }, (_, i) => `DEF_${i}`),
];

/**
 * Distances at which a player drops a level of detail.
 *
 * Calibrated against where the camera actually is, which is the whole trick.
 * It sits `CAMERA_HEIGHT` up and `CAMERA_SIDELINE` across, so it is never close
 * to anybody: the nearest a player ever gets is about 37 yards (near sideline,
 * level with the ball) and the far sideline is about 77. Thresholds picked by
 * eye — 26 and 52, say — put the whole field beyond the near band, and every
 * player renders at the middle tier forever while the code reads as though
 * three tiers were in use.
 *
 *   near sideline, at the ball  ~37
 *   midfield, at the ball       ~55
 *   far sideline                ~77
 */
const TIER_NEAR = 50;
const TIER_FAR = 66;

/** How fast the legs turn over, in radians of gait per yard travelled. */
const GAIT_PER_YARD = 2.2;

/**
 * One player.
 *
 * Owns a `PlayerRig` and the state a rig has no business knowing: where the man
 * is, which way he faces, how far he has run and therefore where his legs are
 * in their cycle. Everything upstream addresses actors by `actorId` and asks
 * for a clip by name, so none of it changes when the rig does.
 */
export class PlayerActor {
  readonly group = new THREE.Group();
  private readonly rig: PlayerRig;
  private clip: ActorClip = "stance";
  private phase = 0;
  private readonly last = new THREE.Vector3();
  private placed = false;

  constructor(appearance: TeamAppearance) {
    this.rig = new PlayerRig(appearance, "medium");
    this.group.add(this.rig.group);
  }

  setAppearance(appearance: TeamAppearance): void {
    this.rig.setColors(appearance);
  }

  /**
   * Move him, and advance his gait by how far he actually travelled.
   *
   * Tying the cycle to distance rather than to the clock is what stops
   * twenty-two men jogging on the spot between snaps — and it makes the gait
   * automatically correct at 6× speed, where a clock-driven one would sprint.
   */
  place(x: number, y: number, z: number, heading: number): void {
    if (this.placed) {
      this.phase += this.last.distanceTo(TEMP.set(x, y, z)) * GAIT_PER_YARD;
    }
    this.last.set(x, y, z);
    this.placed = true;
    this.group.position.set(x, y, z);
    this.group.rotation.y = heading;
  }

  setClip(clip: ActorClip): void {
    this.clip = clip;
  }

  /** Apply the current clip and gait. Called once per frame, after `place`. */
  refresh(): void {
    this.rig.pose(this.clip, this.phase);
  }

  /**
   * Level of detail for this player, by distance from the camera.
   *
   * Tier selection lives here rather than in the choreographer, which does not
   * know a camera exists — and must not, or the layout would depend on where
   * someone was looking and replays would stop being reproducible.
   */
  updateTier(cameraPosition: THREE.Vector3): void {
    const distance = cameraPosition.distanceTo(this.group.position);
    this.rig.setTier(
      distance < TIER_NEAR ? "hero" : distance < TIER_FAR ? "medium" : "low",
    );
  }

  tier(): RigTier {
    return this.rig.currentTier();
  }

  triangleCount(): number {
    return this.rig.triangleCount();
  }

  dispose(): void {
    this.rig.dispose();
  }
}

/** Scratch vector, so `place` allocates nothing on the hot path. */
const TEMP = new THREE.Vector3();

export class FootballScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  /** 1 = real time, 4 = fast, 0 = skip animation and apply the result. */
  speed = 1;
  onCaption?: (text: string) => void;
  onPlayStart?: (animation: PlayAnimation) => void;
  onPlayEnd?: (animation: PlayAnimation) => void;

  private readonly actors = new Map<string, PlayerActor>();
  private readonly ball: THREE.Mesh;
  private readonly home: TeamAppearance;
  private readonly away: TeamAppearance;
  private readonly homeTeamId: string;
  private readonly queue: PlayAnimation[] = [];
  private current: PlayAnimation | null = null;
  private elapsed = 0;
  private readonly cameraTarget = new THREE.Vector3();
  private readonly ballWorld = new THREE.Vector3();

  constructor(options: FootballSceneOptions) {
    this.home = options.home ?? DEFAULT_HOME;
    this.away = options.away ?? DEFAULT_AWAY;
    this.homeTeamId = options.homeTeamId;

    const width = options.width ?? 1280;
    const height = options.height ?? 720;

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
    });
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));

    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.5, 600);
    this.camera.position.set(0, CAMERA_HEIGHT, CAMERA_SIDELINE);

    this.scene.background = new THREE.Color(0x8fb7d9);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3d5a3d, 2.1));
    const sun = new THREE.DirectionalLight(0xfff6e5, 1.1);
    sun.position.set(-40, 70, 30);
    this.scene.add(sun);

    this.scene.add(buildField());
    this.scene.add(buildGoalposts(1), buildGoalposts(-1));

    for (const id of ACTOR_IDS) {
      const actor = new PlayerActor(id.startsWith("OFF") ? this.home : this.away);
      this.actors.set(id, actor);
      this.scene.add(actor.group);
    }

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 8),
      new THREE.MeshLambertMaterial({ color: 0x6b3410 }),
    );
    this.ball.scale.set(1, 1, 1.75);
    this.scene.add(this.ball);
  }

  enqueue(animation: PlayAnimation | PlayAnimation[]): void {
    if (Array.isArray(animation)) this.queue.push(...animation);
    else this.queue.push(animation);
  }

  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  clearQueue(): void {
    this.queue.length = 0;
  }

  /**
   * Advance playback by `dt` seconds. Returns true when nothing is playing —
   * the signal for a caller to feed the next play, or to stop.
   */
  update(dt: number): boolean {
    if (!this.current) {
      const next = this.queue.shift();
      if (!next) {
        this.followBall(dt, 1);
        return true;
      }
      this.current = next;
      this.elapsed = 0;
      this.applyAppearances(next);
      this.onPlayStart?.(next);
    }

    const play = this.current;
    const from = this.elapsed;
    /*
     * At speed 0 the play still HAPPENS — it is applied in one step, captions
     * and all, and the field snaps to the finished position. That is what makes
     * "sim to end" the same code as "watch": one flag, not two pipelines.
     */
    this.elapsed = this.speed === 0 ? play.duration : this.elapsed + dt * this.speed;

    for (const track of play.tracks) {
      const sample = sampleTrack(track, this.elapsed);
      if (track.actorId === "BALL") {
        this.ball.position.set(sample.pos.x, sample.pos.y, sample.pos.z);
        this.ball.rotation.y = sample.heading;
        continue;
      }
      const actor = this.actors.get(track.actorId);
      if (actor) applySample(actor, sample);
    }

    for (const caption of play.captions) {
      if (caption.t > from && caption.t <= this.elapsed) this.onCaption?.(caption.text);
    }

    this.followBall(dt, this.speed === 0 ? 1 : 0.06);
    // After the camera moves, so a player is tiered by where the camera ended
    // up rather than where it was a frame ago.
    for (const actor of this.actors.values()) {
      actor.updateTier(this.camera.position);
      actor.refresh();
    }

    if (this.elapsed >= play.duration) {
      this.current = null;
      this.onPlayEnd?.(play);
    }
    return false;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Update and draw. The usual body of a `requestAnimationFrame` loop. */
  frame(dt: number): boolean {
    const idle = this.update(Math.min(dt, 0.1));
    this.render();
    return idle;
  }

  setSize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  dispose(): void {
    for (const actor of this.actors.values()) actor.dispose();
    // The box geometries are shared across every actor, so they are released
    // once here rather than twenty-two times above.
    disposeRigGeometries();
    this.ball.geometry.dispose();
    (this.ball.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  /**
   * Which capsules wear which colours.
   *
   * Re-applied every play because the slots are sides, not teams: `OFF_*` is
   * whoever has the ball, and that changes hands.
   */
  private applyAppearances(animation: PlayAnimation): void {
    for (const track of animation.tracks) {
      const actor = this.actors.get(track.actorId);
      if (!actor) continue;
      actor.setAppearance(track.teamId === this.homeTeamId ? this.home : this.away);
    }
  }

  /**
   * Broadcast camera: high on the sideline, tracking the ball down the field.
   *
   * The eye and the look-at point share the same x, deliberately. Offsetting
   * one from the other — leading the ball, say — skews the view axis, and a
   * skewed axis makes the yard lines run diagonally across the frame, which
   * reads as a tilted field rather than as a camera angle.
   */
  private followBall(dt: number, responsiveness: number): void {
    this.ballWorld.copy(this.ball.position);
    this.cameraTarget.set(this.ballWorld.x, CAMERA_HEIGHT, CAMERA_SIDELINE);
    // Frame-rate independent smoothing: `responsiveness` is the fraction of the
    // gap closed per 1/60s, so the camera behaves the same at 30fps and 144.
    const alpha =
      responsiveness >= 1 ? 1 : 1 - Math.pow(1 - responsiveness, Math.max(dt, 0) * 60);
    this.camera.position.lerp(this.cameraTarget, alpha);
    this.camera.lookAt(
      this.ballWorld.x,
      1,
      this.ballWorld.z * 0.35 - CAMERA_LOOK_ACROSS,
    );
  }
}

function applySample(actor: PlayerActor, sample: ActorSample): void {
  actor.place(sample.pos.x, sample.pos.y, sample.pos.z, sample.heading);
  actor.setClip(sample.clip);
}

/**
 * The field, as one textured plane.
 *
 * Yard lines are painted into a canvas rather than built as geometry: it is one
 * draw call instead of a hundred, and at this camera distance nothing is lost.
 */
function buildField(): THREE.Mesh {
  const totalLength = FIELD_LENGTH + END_ZONE_DEPTH * 2;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(totalLength, FIELD_WIDTH),
    new THREE.MeshLambertMaterial({ color: 0xffffff, map: buildFieldTexture() }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function buildFieldTexture(): THREE.Texture | null {
  // Node has no canvas. Returning null leaves a plain green field rather than
  // throwing, so importing this module in a test does not require a DOM.
  if (typeof document === "undefined") return null;

  const yardPx = 16;
  const totalLength = FIELD_LENGTH + END_ZONE_DEPTH * 2;
  const canvas = document.createElement("canvas");
  canvas.width = totalLength * yardPx;
  canvas.height = Math.round(FIELD_WIDTH * yardPx);
  const g = canvas.getContext("2d");
  if (!g) return null;

  const x = (yardLine: number) => (yardLine + END_ZONE_DEPTH) * yardPx;

  g.fillStyle = "#2f7d3a";
  g.fillRect(0, 0, canvas.width, canvas.height);

  // Mown stripes, every five yards.
  g.fillStyle = "#2a7134";
  for (let yard = 0; yard < FIELD_LENGTH; yard += 10) {
    g.fillRect(x(yard), 0, 5 * yardPx, canvas.height);
  }

  g.fillStyle = "#1e5a2a";
  g.fillRect(0, 0, END_ZONE_DEPTH * yardPx, canvas.height);
  g.fillRect(x(FIELD_LENGTH), 0, END_ZONE_DEPTH * yardPx, canvas.height);

  g.strokeStyle = "rgba(255,255,255,0.92)";
  g.lineWidth = 2;
  for (let yard = 0; yard <= FIELD_LENGTH; yard += 5) {
    g.beginPath();
    g.moveTo(x(yard), 0);
    g.lineTo(x(yard), canvas.height);
    g.stroke();
  }

  // Hash marks: two rows, every yard.
  const hashRows = [canvas.height * 0.36, canvas.height * 0.64];
  g.lineWidth = 1.5;
  for (let yard = 1; yard < FIELD_LENGTH; yard++) {
    for (const row of hashRows) {
      g.beginPath();
      g.moveTo(x(yard), row - 5);
      g.lineTo(x(yard), row + 5);
      g.stroke();
    }
  }

  // Yard numbers, mirrored from each side the way a real field paints them.
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.font = `bold ${yardPx * 3}px system-ui, sans-serif`;
  g.textAlign = "center";
  for (let yard = 10; yard <= 90; yard += 10) {
    const label = String(yard <= 50 ? yard : 100 - yard);
    g.save();
    g.translate(x(yard), canvas.height * 0.17);
    g.fillText(label, 0, 0);
    g.restore();
    g.save();
    g.translate(x(yard), canvas.height * 0.86);
    g.rotate(Math.PI);
    g.fillText(label, 0, 0);
    g.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Uprights at one end. `side` is +1 for the +x end zone. */
function buildGoalposts(side: 1 | -1): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ color: 0xf2c53d });
  const post = (h: number) => new THREE.CylinderGeometry(0.12, 0.12, h, 6);

  const base = new THREE.Mesh(post(3), material);
  base.position.y = 1.5;
  const crossbar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 6.2, 6), material);
  crossbar.rotation.x = Math.PI / 2;
  crossbar.position.y = 3;

  const left = new THREE.Mesh(post(9), material);
  left.position.set(0, 7.5, -3.1);
  const right = new THREE.Mesh(post(9), material);
  right.position.set(0, 7.5, 3.1);

  group.add(base, crossbar, left, right);
  group.position.x = side * (FIELD_LENGTH / 2 + UPRIGHT_DEPTH);
  return group;
}
