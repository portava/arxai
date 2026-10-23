// agentOutputValidator — strict structural validation for AgentOutputContract.
// Refuses any output that breaks the contract; the caller MUST log
// AGENT_OUTPUT_INVALID and downgrade the offending agent to a safe NEUTRAL
// vote before the council acts on it.

import { z } from "zod/v4";
import { AGENT_DATA_SOURCE_IDS, type AgentOutputContract, type ContractValidation } from "./agentContract.types";

const VoteSchema = z.enum(["STRONG_FOR", "FOR", "NEUTRAL", "AGAINST", "STRONG_AGAINST"]);
const AuthoritySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

/** Canonical strict Zod schema for AgentOutputContract. Exported so routes
 *  and other consumers can validate inputs without needing force-casts to
 *  the domain type — the inferred type is structurally identical to
 *  AgentOutputContract. `.strict()` rejects unknown keys. */
export const AgentOutputContractSchema = z.object({
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  agentVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver"),
  authorityLevel: AuthoritySchema,
  vote: VoteSchema,
  confidence01: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  warnings: z.array(z.string()),
  blockers: z.array(z.string()),
  expiresAtIso: z.string().refine(s => !Number.isNaN(Date.parse(s)), "must be ISO date"),
  dataSourcesUsed: z.array(z.enum(AGENT_DATA_SOURCE_IDS)).min(1, "must cite ≥1 data source"),
  uncertaintyReason: z.string().nullable(),
}).strict();

export function validateAgentOutput(c: AgentOutputContract): ContractValidation {
  const result = AgentOutputContractSchema.safeParse(c);
  if (result.success) {
    return {
      agentId: c.agentId, agentName: c.agentName,
      valid: true, errors: [], agentVersion: c.agentVersion,
    };
  }
  const errors = result.error.issues.map(i => `${i.path.join(".") || "<root>"}: ${i.message}`);
  return {
    agentId: c.agentId ?? "<unknown>",
    agentName: c.agentName ?? "<unknown>",
    valid: false, errors,
    agentVersion: typeof c.agentVersion === "string" ? c.agentVersion : null,
  };
}

/** Convert a rejected output into a SAFE NEUTRAL vote so the council never
 *  acts on invalid agent data. */
export function neutralizeContract(c: AgentOutputContract, reason: string): AgentOutputContract {
  return {
    ...c,
    vote: "NEUTRAL",
    confidence01: 0,
    blockers: [],
    warnings: [...c.warnings, `[neutralized] ${reason}`],
    uncertaintyReason: reason,
  };
}
