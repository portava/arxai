// Opportunity Spine (#17/#18/#19) — pure barrel.
// Owning per-setup lifecycle state machine + thesis-similarity deduplication +
// validated-rule opposite-direction conflict resolution. No IO here.

export {
  OPPORTUNITY_ACTIVE_STATES,
  OPPORTUNITY_TERMINAL_STATES,
  OPPORTUNITY_EVENT_TYPES,
  HORIZON_CLASSES,
  isTerminalOpportunityState,
  initialOpportunitySnapshot,
  applyOpportunityEvent,
  replayOpportunity,
  timeframeHorizonClass,
  buildOpportunityKey,
  opportunityKeyFromParts,
} from "./opportunityStateMachine.js";
export type {
  OpportunityActiveState,
  OpportunityTerminalState,
  OpportunityState,
  OpportunityEventType,
  OpportunityEvent,
  OpportunitySnapshot,
  TransitionResult,
  HorizonClass,
  OpportunityIdentity,
} from "./opportunityStateMachine.js";

export { deriveOpportunityObservation } from "./opportunityObservation.js";
export type { OpportunityObservation } from "./opportunityObservation.js";

export {
  DUPLICATE_SIMILARITY_THRESHOLD,
  evaluateThesisSimilarity,
  clusterDuplicates,
  candidateDedupId,
} from "./opportunityDedup.js";
export type {
  ThesisSimilarity,
  DedupJournalEntry,
  DedupCluster,
  DedupResult,
} from "./opportunityDedup.js";

export {
  classifyOppositeConflict,
  resolveOppositeConflict,
} from "./oppositeConflict.js";
export type {
  OppositeConflictClass,
  OppositeRuleVerdict,
  OppositeConflictVerdict,
} from "./oppositeConflict.js";
