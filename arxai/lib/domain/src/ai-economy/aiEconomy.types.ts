import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// AI Economy — shared type contracts. Keeps individual engines concise and
// makes route bodies easy to validate.
//
// PROJECT INVARIANTS:
//   • Trust / reputation / authority are SOFT signals. Risk Governor and
//     Control Tower outrank every output here.
//   • All numeric scores are 0..1 unless suffixed otherwise.
// ═══════════════════════════════════════════════════════════════════════════

// `AgentIdSchema` / `AgentId` already exported from economy.engine.ts.
// We deliberately do not redeclare them here; downstream code imports from
// the same `@workspace/domain/ai-economy` barrel.

export const Phase10StrategyIdSchema = z.string().min(1);
export type Phase10StrategyId = z.infer<typeof Phase10StrategyIdSchema>;

// A single graded performance event — the only currency of reputation.
// Used both by agent and strategy reputation engines.
export const GradedOutcomeSchema = z.object({
  pnlR: z.number(),
  withinRiskPolicy: z.boolean(),
  calibrationErrorPct: z.number().min(0),
  drawdownContributionPct: z.number().min(0),
  observedAtIso: z.string(),
});
export type GradedOutcome = z.infer<typeof GradedOutcomeSchema>;

export const ResourcePrioritySchema = z.object({
  requesterId: z.string().min(1),
  priority01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type ResourcePriority = z.infer<typeof ResourcePrioritySchema>;

export const StrategyTrustReportSchema = z.object({
  strategyId: Phase10StrategyIdSchema,
  trustScore01: z.number().min(0).max(1),
  reputation01: z.number().min(0).max(1),
  survivalQuality01: z.number().min(0).max(1),
  validationCredit01: z.number().min(0).max(1),
  executionQuality01: z.number().min(0).max(1),
  decisionQuality01: z.number().min(0).max(1),
  sampleCount: z.int().nonnegative(),
  reasons: z.array(z.string()),
});
export type StrategyTrustReport = z.infer<typeof StrategyTrustReportSchema>;

// A small advisory wrapper used by routes — every economy / lifecycle /
// evolution endpoint returns this envelope so the front-end and tests can
// rely on the same shape.
export const AdvisoryEnvelopeSchema = z.object({
  canPlaceTrades: z.literal(false),
  mode: z.enum([
    "AI_ECONOMY_PIPELINE",
    "LIFECYCLE_PIPELINE",
    "EVOLUTION_PIPELINE",
    "RESOURCE_PIPELINE",
  ]),
  generatedAtIso: z.string(),
});
export type AdvisoryEnvelope = z.infer<typeof AdvisoryEnvelopeSchema>;
