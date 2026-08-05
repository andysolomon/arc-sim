/**
 * @arc-sim/core — deterministic American football play-by-play simulation.
 *
 * Extracted from the Sports Management (sprtsmng) Dynasty Mode engine.
 * Pure TypeScript: no I/O, no database, no UI.
 */

export {
  PBP_ENGINE_VERSION,
  PBP_ENGINE_VERSION_V1,
  simulateGameLog,
  normalizeGameLog,
  normalizedPlays,
  logModels,
  deriveStatLines,
  allPlays,
  sumTeamStatGroup,
  deriveWeather,
  weatherModifiers,
  CLEAR_WEATHER,
  rivalryPairKey,
  normalizeIntensity,
  homeFieldEdge,
  isRivalry,
  playTimeline,
  kickReturnSpot,
  type PbpSimEvent,
  type PbpSimEventType,
  type PbpDrive,
  type PbpDriveEndReason,
  type PbpGameInput,
  type PbpGameLog,
  type PbpParticipant,
  type PbpParticipantRole,
  type PbpPlay,
  type PbpPlayType,
  type PbpFeatureGates,
  type PlayerSimProfile,
  type SimPositionGroup,
  type TeamSimProfile,
  type GameInjury,
  type NormalizedGameLog,
  type DerivedPlayerStatLine,
  type Weather,
  type WeatherModifiers,
} from "./pbp/index.js";

export {
  mulberry32,
  seedFromString,
  seedFor,
  rngFor,
  type SeedDomain,
} from "./rng/index.js";

export {
  DEFAULT_SIMULATION_FLAVOR,
  SIMULATION_FLAVORS,
  normalizeSimulationFlavor,
  weightsForFlavor,
  BASE_STRENGTH_WEIGHT,
  BASE_VARIANCE,
  type SimulationFlavor,
  type SimulationWeights,
} from "./flavor/index.js";

export {
  OFFENSE_SCHEMES,
  DEFENSE_SCHEMES,
  NEUTRAL_OFFENSE_TENDENCIES,
  NEUTRAL_DEFENSE_TENDENCIES,
  offenseTendencies,
  defenseTendencies,
  gameplanModifiers,
  isGameplanFocus,
  GAMEPLAN_FOCUS_OPTIONS,
  NEUTRAL_GAMEPLAN_MODIFIERS,
  type OffenseSchemeId,
  type DefenseSchemeId,
  type OffenseTendencies,
  type DefenseTendencies,
  type OffenseSchemeSpec,
  type DefenseSchemeSpec,
  type GameplanFocus,
  type GameplanModifiers,
} from "./schemes/index.js";

export type {
  PlayerGameStatLine,
  StatPassing,
  StatRushing,
  StatReceiving,
  StatDefense,
  StatKicking,
  StatPunting,
  StatReturns,
  StatBallSecurity,
} from "./stats/types.js";
