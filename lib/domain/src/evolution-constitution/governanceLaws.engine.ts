import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Governance Laws — IMMUTABLE rules of the system. They cannot be overridden
// by any agent, vote, or evolution. They are the constitution's preamble.
// All Phase 11 governance logic must reference these by id.
// ═══════════════════════════════════════════════════════════════════════════

export const GovernanceLawSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  category: z.enum(["RISK", "EXECUTION", "EVOLUTION", "AUTHORITY", "MEMORY"]),
  immutable: z.literal(true),
});
export type GovernanceLaw = z.infer<typeof GovernanceLawSchema>;

export const GOVERNANCE_LAWS: readonly GovernanceLaw[] = Object.freeze([
  { id: "L_RISK_GOVERNOR_FINAL",  text: "Risk Governor has final authority over capital allocation.",  category: "RISK",       immutable: true },
  { id: "L_KILL_SWITCH_OVERRIDE", text: "Kill switch overrides every other authority.",                category: "RISK",       immutable: true },
  { id: "L_SANDBOX_ONLY_EVO",     text: "Mutation and evolution may only occur in the sandbox.",      category: "EVOLUTION",  immutable: true },
  { id: "L_NO_VALIDATION_SKIP",   text: "No mutated strategy may bypass validation stages.",          category: "EVOLUTION",  immutable: true },
  { id: "L_FORBIDDEN_NEVER",      text: "Forbidden mutation patterns can never be promoted.",         category: "EVOLUTION",  immutable: true },
  { id: "L_AUTHORITY_EARNED",     text: "Authority is earned by ecosystem contribution, not profit.", category: "AUTHORITY",  immutable: true },
  { id: "L_VAULT_AUDIT",          text: "All governance and evolution outcomes must be vault-logged.", category: "MEMORY",    immutable: true },
  { id: "L_MEMORY_FORBIDS",       text: "Past collapses convert their root mutation patterns into forbidden patterns.", category: "MEMORY", immutable: true },
] as const);

export function findLaw(id: string): GovernanceLaw | undefined {
  return GOVERNANCE_LAWS.find((l) => l.id === id);
}

export function listLaws(): readonly GovernanceLaw[] {
  return GOVERNANCE_LAWS;
}
