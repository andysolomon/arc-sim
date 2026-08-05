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
} from "./types";

/** Bump when play model / serialization changes. */
export const PBP_ENGINE_VERSION = "2.0.0";

/** Version every log written before Epic A (v1 baseline) carries. */
export const PBP_ENGINE_VERSION_V1 = "1.0.0";

export { simulateGameLog } from "./engine";
export {
  normalizeGameLog,
  normalizedPlays,
  logModels,
  type NormalizedGameLog,
} from "./migrate-log";
export {
  deriveStatLines,
  allPlays,
  sumTeamStatGroup,
  type DerivedPlayerStatLine,
} from "./derive-stats";
export {
  deriveWeather,
  weatherModifiers,
  CLEAR_WEATHER,
  type Weather,
  type WeatherModifiers,
} from "./weather";
export { rivalryPairKey, normalizeIntensity } from "./rivalries";
export { homeFieldEdge, isRivalry } from "./crowd";
