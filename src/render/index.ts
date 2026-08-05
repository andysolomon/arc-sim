/**
 * `@arc-sim/core/render` — the graphics layer.
 *
 * Separate entry point on purpose. The engine has no dependencies and must keep
 * none; importing `@arc-sim/core` never pulls in Three.js, and a headless
 * consumer (a season simulator, a stats job) pays nothing for this existing.
 *
 * The layers, outermost last:
 *
 *   engine        → `PbpGameLog`      what happened
 *   timeline.ts   → `PbpSimEvent[]`   in what order (pure, in the engine)
 *   choreographer → `PlayAnimation`   who moved where (pure, no Three)
 *   scene.ts      → pixels            the only file that imports Three
 *
 * Only the last of those needs a browser, which is why the interesting parts
 * are testable in Node.
 */

export {
  sampleTrack,
  sampleAnimation,
  captionsBetween,
  type ActorClip,
  type ActorKeyframe,
  type ActorSample,
  type ActorSide,
  type ActorTrack,
  type PlayAnimation,
  type PlayCaption,
  type Vec3,
} from "./animation.js";

export {
  FIELD_LENGTH,
  FIELD_WIDTH,
  HALF_WIDTH,
  END_ZONE_DEPTH,
  UPRIGHT_DEPTH,
  driveDirection,
  worldX,
  fieldPoint,
  clampLateral,
} from "./field.js";

export {
  OFFENSE_FORMATIONS,
  DEFENSE_FORMATIONS,
  formationsFor,
  type SlotSpec,
  type OffenseFormation,
  type DefenseFormation,
} from "./formations.js";

export {
  choreograph,
  choreographLog,
  type ChoreographyContext,
} from "./choreographer.js";

export { describePlay, describeSituation, describePenalty, yardLine } from "./describe.js";

export {
  FootballScene,
  PlayerActor,
  type FootballSceneOptions,
  type TeamAppearance,
} from "./scene.js";
