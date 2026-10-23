// Signal Intelligence Core (Ruby Market Edge) — public barrel.
// Pure & deterministic: no IO, no Date.now() inside the engines.

export * from "./signalIntelligence.types.js";
export { readEarlyTrend } from "./earlyTrendRadar.js";
export { classifyRegime, detectFakeout } from "./regimeFakeout.js";
export { classifyLifecycle } from "./lifecycleEngine.js";
export type { LifecycleInput, LifecycleVerdict } from "./lifecycleEngine.js";
export {
  computeFreshness,
  buildEvidence,
  timeframeValiditySeconds,
} from "./freshnessEvidence.js";
export type { FreshnessVerdict, EvidenceInput } from "./freshnessEvidence.js";
export {
  computeLateDetection,
  computeScores,
  confidenceBandFor,
} from "./scoring.js";
export type { LateInput, ScoringInput } from "./scoring.js";
export { diffSignal } from "./marketMemory.js";
export type { CurrentSnapshot } from "./marketMemory.js";
export {
  resolveSession,
  sessionContext,
  playbookWeight,
} from "./sessionIntelligence.js";
export { buildRubyMarketEdge } from "./buildSignal.js";
export { explainMarketRead } from "./explainMarketRead.js";
export {
  categorizeOpportunities,
  compareBestVsSelected,
} from "./categorizeOpportunities.js";
