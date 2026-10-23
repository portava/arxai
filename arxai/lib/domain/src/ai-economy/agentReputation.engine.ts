// ═══════════════════════════════════════════════════════════════════════════
// Agent Reputation — re-export of the canonical reputation engine, scoped
// to agents. Brief asks for a separate file; agent reputation is the
// existing reputation.engine.ts implementation (EMA on graded outcomes).
// ═══════════════════════════════════════════════════════════════════════════

export {
  ReputationEventSchema as AgentReputationEventSchema,
  type ReputationEvent as AgentReputationEvent,
  ReputationStateSchema as AgentReputationStateSchema,
  type ReputationState as AgentReputationState,
  REPUTATION_TUNING as AGENT_REPUTATION_TUNING,
  type ReputationUpdateResult as AgentReputationUpdateResult,
  updateReputation as updateAgentReputation,
  seedReputation as seedAgentReputation,
} from "./reputation.engine";
