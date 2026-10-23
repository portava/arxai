// Internal re-exports so governance engines have a stable import surface
// for primitives that already live in the broader DI subdomain.
export {
  type AdaptiveAggression,
  type AggressionLevel,
  type ConvictionReport,
  type FatigueState,
  type MarketPersonality,
  type SimulationResult,
  type ExpectancyMetrics,
  type DecisionQualityScore,
} from "../decisionIntelligence.types";
export { LEVEL_MULTIPLIER as LEVEL_MULTIPLIER_PUBLIC } from "../adaptiveAggression.engine";
