import * as THREE from "three";
import {
  sampleTrack,
  type ActorClip,
  type ActorSample,
  type PlayAnimation,
} from "./animation.js";
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH, UPRIGHT_DEPTH } from "./field.js";

/*
 * The scene (A8) — the only file in this package that knows Three.js exists.
 *
 * Everything above it is numbers: the engine decides the game, `timeline.ts`
 * decides the beats, `choreographer.ts` decides the motion. This file just
 * draws it, which is why swapping the placeholder capsules for the voxel /
 * medium / hero rigs later touches nothing but `PlayerActor`.
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
 * One player.
 *
 * A capsule and a helmet — roughly 200 triangles, which is under the voxel tier
 * and deliberately so: this is a placeholder that proves the seam, not the art.
 * `setTier` is where the LOD ladder lands. Swapping in a `SkinnedMesh` per tier
 * changes this class and nothing else, because everything upstream addresses
 * actors by `actorId` and asks them for a clip by name.
 */
export class PlayerActor {
  readonly group = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly helmet: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private clip: ActorClip = "stance";

  constructor(appearance: TeamAppearance) {
    this.body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.42, 1.05, 3, 8),
      new THREE.MeshLambertMaterial({ color: appearance.primary }),
    );
    this.body.position.y = 1.05;

    this.helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.33, 10, 8),
      new THREE.MeshLambertMaterial({ color: appearance.secondary }),
    );
    this.helmet.position.y = 1.9;

    // A blob under each player. Cheaper than a shadow map by orders of
    // magnitude and, at broadcast distance, the only cue that actually reads:
    // without it twenty-two capsules look like they are hovering.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 12),
      new THREE.MeshBasicMaterial({
        color: 0x0a1a0a,
        transparent: true,
        opacity: 0.28,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;

    this.group.add(this.body, this.helmet, this.shadow);
  }

  setAppearance(appearance: TeamAppearance): void {
    (this.body.material as THREE.MeshLambertMaterial).color.setHex(appearance.primary);
    (this.helmet.material as THREE.MeshLambertMaterial).color.setHex(
      appearance.secondary,
    );
  }

  /**
   * Pose for a named clip.
   *
   * Placeholder poses, not animation: a capsule has no skeleton to drive. They
   * exist so the clip channel is visibly WIRED — if the choreographer says a
   * man is down, he is on the ground — and so the day a rig arrives, the only
   * thing that changes here is what a clip name does.
   */
  setClip(clip: ActorClip): void {
    if (clip === this.clip) return;
    this.clip = clip;
    const down = clip === "tackled";
    const crouch = clip === "stance" || clip === "block" || clip === "kneel";

    this.body.rotation.z = down ? Math.PI / 2 : 0;
    this.body.position.y = down ? 0.45 : crouch ? 0.92 : 1.05;
    this.helmet.position.y = down ? 0.5 : crouch ? 1.72 : 1.9;
    this.helmet.position.x = down ? 0.75 : 0;
    this.group.scale.y = clip === "celebrate" ? 1.12 : 1;
  }

  /**
   * LOD seam (not yet implemented).
   *
   * The plan this package is built for is three rigs on one skeleton — voxel
   * for everyone, medium in the action bubble, hero for replays. Nothing above
   * this class needs to know which is loaded, so tier selection belongs here
   * and the choreographer never learns about it.
   */
  setTier(_tier: "low" | "medium" | "hero"): void {
    // No-op until the GLBs exist. Documented rather than silently absent so the
    // next person knows where it goes.
  }

  dispose(): void {
    for (const mesh of [this.body, this.helmet, this.shadow]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}

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
  actor.group.position.set(sample.pos.x, sample.pos.y, sample.pos.z);
  actor.group.rotation.y = sample.heading;
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
