export type {
  PbpDrive,
  PbpDriveEndReason,
  PbpGameInput,
  PbpGameLog,
  PbpParticipant,
  PbpParticipantRole,
  PbpPlay,
  PbpPlayType,
  PbpFeatureGates,
  PlayerSimProfile,
  SimPositionGroup,
  TeamSimProfile,
  GameInjury,
} from "./types.js";

/** Bump when play model / serialization changes. */
export const PBP_ENGINE_VERSION = "2.0.0";

/** Version every log written before Epic A (v1 baseline) carries. */
export const PBP_ENGINE_VERSION_V1 = "1.0.0";

export { simulateGameLog } from "./engine.js";
export {
  normalizeGameLog,
  normalizedPlays,
  logModels,
  type NormalizedGameLog,
} from "./migrate-log.js";
export {
  deriveStatLines,
  allPlays,
  sumTeamStatGroup,
  type DerivedPlayerStatLine,
} from "./derive-stats.js";
export {
  deriveWeather,
  weatherModifiers,
  CLEAR_WEATHER,
  type Weather,
  type WeatherModifiers,
} from "./weather.js";
export {
  playTimeline,
  kickReturnSpot,
  type PbpSimEvent,
  type PbpSimEventType,
} from "./timeline.js";
export {
  V1_FEATURES,
  RECOMMENDED_FEATURES,
  ALL_FEATURES,
} from "./presets.js";
export { rivalryPairKey, normalizeIntensity } from "./rivalries.js";
export { homeFieldEdge, isRivalry } from "./crowd.js";
