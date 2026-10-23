// agent.types — public facade re-exporting the agent-related types from the
// consolidated agentSystem.types module. Kept as a separate file so the
// import surface matches the Phase 3 architecture (one type file per
// concern). Existing internal modules continue to import from
// agentSystem.types directly without breakage.

export type {
  AgentCategory,
  AgentVerdict,
  HardBlockVerdict,
  DirectionVerdict,
  QualityVerdict,
  AgentSystemSnapshot,
  ProposedSetup,
  PolicyContext,
  TradeDirection,
} from "./agentSystem.types";

export { AgentCategorySchema, TradeDirectionSchema } from "./agentSystem.types";
