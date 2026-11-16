// agentContract.types — strict, versioned output contract every agent
// must produce. The validator + safety guards refuse to let the council
// pass through any output that doesn't conform. This is the single
// "fact-shape" the rest of the system can rely on.

import type { AuthorityLevel } from "../authority/agentAuthority.types";
import type { AgentVote } from "../agentVote.types";

/** All known sensor families an agent can read. Used in `dataSourcesUsed`
 *  to make data provenance auditable per agent. */
export const AGENT_DATA_SOURCE_IDS = [
  "market", "account", "execution", "behavior", "news", "policy", "setup",
] as const;
export type AgentDataSourceId = typeof AGENT_DATA_SOURCE_IDS[number];

/** The single, strict output shape every agent must satisfy. */
export interface AgentOutputContract {
  agentId: string;
  agentName: string;
  agentVersion: string;          // semver, e.g. "2.0.0"
  authorityLevel: AuthorityLevel;
  vote: AgentVote;
  confidence01: number;
  evidence: string[];            // ≥0 sensor-derived facts the agent cites
  warnings: string[];
  blockers: string[];
  expiresAtIso: string;
  dataSourcesUsed: AgentDataSourceId[];
  uncertaintyReason: string | null;  // why confidence isn't 1.0
}

/** Result of validating one contract against the schema. */
export interface ContractValidation {
  agentId: string;
  agentName: string;
  valid: boolean;
  errors: string[];              // empty when valid
  agentVersion: string | null;   // echoed for vault searchability
}

/** Sensor-family timestamp helper used by confidence-cap + freshness checks. */
export const SENSOR_FRESHNESS_THRESHOLD_MS: Record<AgentDataSourceId, number> = {
  market:    30_000,   // 30s
  account:   60_000,
  execution: 30_000,
  behavior:  60_000,
  news:     300_000,   // 5 min
  policy:   600_000,   // 10 min (mostly static)
  setup:     60_000,
};
