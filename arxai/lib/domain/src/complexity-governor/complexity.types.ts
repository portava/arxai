import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Complexity Governor — TYPES
// Self-contained subdomain. Detects bloat, duplication, latency overruns,
// and proposes simplifications. Can DISABLE non-essential agents.
// ═══════════════════════════════════════════════════════════════════════════

export const AgentIdSchema = z.string().min(1).max(128);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const AgentTierSchema = z.enum(["ESSENTIAL", "RECOMMENDED", "OPTIONAL", "EXPERIMENTAL"]);
export type AgentTier = z.infer<typeof AgentTierSchema>;

export const AgentMetricsSchema = z.object({
  agentId: AgentIdSchema,
  tier: AgentTierSchema,
  cpuMsPerCycle: z.number().nonnegative(),
  memoryMb: z.number().nonnegative(),
  uniqueDecisionsContributed: z.int().nonnegative(),
  decisionsObserved: z.int().nonnegative(),
  errorRate01: z.number().min(0).max(1),
  // Hash/fingerprint of recent outputs for redundancy detection.
  recentOutputFingerprints: z.array(z.string()),
});
export type AgentMetrics = z.infer<typeof AgentMetricsSchema>;

export const AgentEfficiencyReportSchema = z.object({
  agentId: AgentIdSchema,
  efficiency01: z.number().min(0).max(1),
  costScore01: z.number().min(0).max(1),
  contributionScore01: z.number().min(0).max(1),
  recommendDisable: z.boolean(),
  reasons: z.array(z.string()),
});
export type AgentEfficiencyReport = z.infer<typeof AgentEfficiencyReportSchema>;

export const RedundancyClusterSchema = z.object({
  fingerprint: z.string(),
  agentIds: z.array(AgentIdSchema).min(2),
  sampleCount: z.int().positive(),
});
export type RedundancyCluster = z.infer<typeof RedundancyClusterSchema>;

export const RedundancyReportSchema = z.object({
  clusters: z.array(RedundancyClusterSchema),
  redundantAgentIds: z.array(AgentIdSchema),
  reasons: z.array(z.string()),
});
export type RedundancyReport = z.infer<typeof RedundancyReportSchema>;

export const ComputeBudgetReportSchema = z.object({
  totalBudgetMs: z.number().positive(),
  consumedMs: z.number().nonnegative(),
  utilization01: z.number().min(0).max(1),
  overBudget: z.boolean(),
  recommendedDisableAgentIds: z.array(AgentIdSchema),
  reasons: z.array(z.string()),
});
export type ComputeBudgetReport = z.infer<typeof ComputeBudgetReportSchema>;

export const LatencyBudgetReportSchema = z.object({
  budgetMs: z.number().positive(),
  observedP95Ms: z.number().nonnegative(),
  observedP99Ms: z.number().nonnegative(),
  overBudget: z.boolean(),
  recommendDegrade: z.boolean(),
  reasons: z.array(z.string()),
});
export type LatencyBudgetReport = z.infer<typeof LatencyBudgetReportSchema>;

export const SimplificationActionSchema = z.enum([
  "DISABLE_AGENT", "MERGE_AGENTS", "REDUCE_FREQUENCY", "DROP_TIER",
]);
export type SimplificationAction = z.infer<typeof SimplificationActionSchema>;

export const SimplificationProposalSchema = z.object({
  action: SimplificationActionSchema,
  targetAgentIds: z.array(AgentIdSchema),
  expectedSavingsMs: z.number().nonnegative(),
  reasons: z.array(z.string()),
});
export type SimplificationProposal = z.infer<typeof SimplificationProposalSchema>;

export const ComplexityVerdictSchema = z.object({
  generatedAtIso: z.string(),
  efficiency: z.array(AgentEfficiencyReportSchema),
  redundancy: RedundancyReportSchema,
  computeBudget: ComputeBudgetReportSchema,
  latencyBudget: LatencyBudgetReportSchema,
  proposals: z.array(SimplificationProposalSchema),
  forcedDisableAgentIds: z.array(AgentIdSchema),  // hard-disabled (essentials are protected)
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ComplexityVerdict = z.infer<typeof ComplexityVerdictSchema>;

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
