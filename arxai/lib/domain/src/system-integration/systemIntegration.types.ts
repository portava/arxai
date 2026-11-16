import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// System Integration — TYPES
// Self-contained subdomain that wires the 7 upgrade layers (execution-
// microstructure, attention, complexity-governor, explainability, resilience,
// cognitive, stress-lab) into the main AI Trading OS pipeline.
//
// Self-contained: every input shape is duplicated here using its OWN
// SymbolId / StrategyId / AgentId / etc. Engines never import from sibling
// subdomains. Pure functions; IO is the caller's responsibility.
// ═══════════════════════════════════════════════════════════════════════════

export const SymbolIdSchema = z.string().min(1).brand<"SymbolId">();
export type SymbolId = z.infer<typeof SymbolIdSchema>;

export const StrategyIdSchema = z.string().min(1).brand<"StrategyId">();
export type StrategyId = z.infer<typeof StrategyIdSchema>;

export const AgentIdSchema = z.string().min(1).brand<"AgentId">();
export type AgentId = z.infer<typeof AgentIdSchema>;

export const TradeIntentIdSchema = z.string().min(1).brand<"TradeIntentId">();
export type TradeIntentId = z.infer<typeof TradeIntentIdSchema>;

// System modes — superset across resilience + cognitive + control tower.
export const SystemModeSchema = z.enum([
  "NORMAL", "REDUCED", "DEGRADED_MODE", "COOLDOWN",
  "RECOVERY_MODE", "LOCKDOWN", "SAFE_SHUTDOWN",
]);
export type SystemMode = z.infer<typeof SystemModeSchema>;

// Mode priority (higher = more restrictive; wins ties).
export const SYSTEM_MODE_PRIORITY: Record<SystemMode, number> = {
  NORMAL: 0, REDUCED: 1, COOLDOWN: 2, DEGRADED_MODE: 3,
  RECOVERY_MODE: 4, LOCKDOWN: 5, SAFE_SHUTDOWN: 6,
};

export const SeveritySchema = z.enum(["INFO", "WARN", "DANGER", "CRITICAL"]);
export type Severity = z.infer<typeof SeveritySchema>;

// Score in [0, 1] — 0 = safe, 1 = max risk.
export const Score01Schema = z.number().min(0).max(1);
export type Score01 = z.infer<typeof Score01Schema>;

// Common reasons[]/blockers[] payload shape used across this subdomain.
export const ReasonsSchema = z.array(z.string());
export const BlockersSchema = z.array(z.string());

// Black Box Vault event kinds emitted by integration engines.
export const VaultEventKindSchema = z.enum([
  "MICROSTRUCTURE_WARNING",
  "RESILIENCE_EVENT",
  "COGNITIVE_RISK_EVENT",
  "COMPLEXITY_EVENT",
  "STRESS_TEST_RESULT",
  "EXPLANATION_NARRATIVE",
  "ATTENTION_PRIORITY_DECISION",
]);
export type VaultEventKind = z.infer<typeof VaultEventKindSchema>;

export const VaultEventSchema = z.object({
  kind: VaultEventKindSchema,
  severity: SeveritySchema,
  generatedAtIso: z.string(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type VaultEvent = z.infer<typeof VaultEventSchema>;
