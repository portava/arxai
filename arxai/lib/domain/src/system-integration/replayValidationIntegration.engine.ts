import { z } from "zod/v4";
import {
  StrategyIdSchema, SymbolIdSchema, Score01Schema, SystemModeSchema,
  type StrategyId,
} from "./systemIntegration.types";

// ═══════════════════════════════════════════════════════════════════════════
// Replay + Validation Integration
// Bundles the per-cycle conditions that Replay Lab must reproduce when
// re-running a candidate strategy, and provides a Validation Pipeline gate
// that requires those replays to pass before promotion.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const ReplayConditionsSchema = z.object({
  generatedAtIso: z.string(),
  symbol: SymbolIdSchema,
  // Execution conditions
  spreadPips: z.number().nonnegative(),
  expectedSlippagePips: z.number().nonnegative(),
  fillProbability01: Score01Schema,
  liquidity01: Score01Schema,
  // Cognitive state
  cognitiveFatigue01: Score01Schema,
  cognitiveStress01: Score01Schema,
  cognitivePerformance01: Score01Schema,
  // Resilience status
  resilienceMode: SystemModeSchema,
  dataIntegrity01: Score01Schema,
  // Attention priority
  attentionPriority01: Score01Schema,
  attentionDanger: z.boolean(),
  // Stress outcomes
  stressWorstShockPctMove: z.number(),
  stressPeakSpreadPips: z.number().nonnegative(),
  stressIsSimulationOnly: z.literal(true),
});
export type ReplayConditions = z.infer<typeof ReplayConditionsSchema>;

export const ReplayBundleSchema = z.object({
  generatedAtIso: z.string(),
  strategyId: StrategyIdSchema,
  conditions: z.array(ReplayConditionsSchema),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ReplayBundle = z.infer<typeof ReplayBundleSchema>;

export function buildReplayBundle(input: {
  generatedAtIso: string;
  strategyId: StrategyId;
  conditions: ReadonlyArray<ReplayConditions>;
}): ReplayBundle {
  const reasons: string[] = [`bundled ${input.conditions.length} replay condition snapshot(s)`];
  const blockers: string[] = [];
  if (input.conditions.length === 0) {
    blockers.push("no replay conditions supplied — cannot reproduce execution context");
  }
  return {
    generatedAtIso: input.generatedAtIso,
    strategyId: input.strategyId,
    conditions: [...input.conditions],
    reasons, blockers,
  };
}

// ─── Validation gate ───────────────────────────────────────────────────────

export const ReplayResultSchema = z.object({
  passed: z.boolean(),
  pnlPct: z.number(),
  maxDrawdownPct: z.number(),
  notes: z.array(z.string()).default([]),
});
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export const ValidationGateInputSchema = z.object({
  generatedAtIso: z.string(),
  strategyId: StrategyIdSchema,
  replayResults: z.array(ReplayResultSchema),
  cognitiveOk: z.boolean(),
  resilienceOk: z.boolean(),
  attentionOk: z.boolean(),
  stressOk: z.boolean(),
  microOk: z.boolean(),
  minPassRate01: Score01Schema,
});
export type ValidationGateInput = z.infer<typeof ValidationGateInputSchema>;

export const ValidationGateVerdictSchema = z.object({
  generatedAtIso: z.string(),
  strategyId: StrategyIdSchema,
  passRate01: Score01Schema,
  promote: z.boolean(),
  failedChecks: z.array(z.string()),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ValidationGateVerdict = z.infer<typeof ValidationGateVerdictSchema>;

export function runValidationGate(input: ValidationGateInput): ValidationGateVerdict {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const failed: string[] = [];

  const total = input.replayResults.length;
  const passed = input.replayResults.filter((r) => r.passed).length;
  const passRate = total > 0 ? passed / total : 0;

  if (total === 0) blockers.push("no replay results — cannot validate strategy");
  if (passRate < (input.minPassRate01 as unknown as number)) {
    failed.push(`replay pass rate ${(passRate*100).toFixed(0)}% < required ${((input.minPassRate01 as unknown as number)*100).toFixed(0)}%`);
  }
  if (!input.cognitiveOk)  failed.push("cognitive replay check failed");
  if (!input.resilienceOk) failed.push("resilience replay check failed");
  if (!input.attentionOk)  failed.push("attention replay check failed");
  if (!input.stressOk)     failed.push("stress replay check failed");
  if (!input.microOk)      failed.push("execution-microstructure replay check failed");

  const promote = blockers.length === 0 && failed.length === 0;
  if (promote)         reasons.push("all upgrade-layer replay checks passed — promotion approved");
  else                 blockers.push(...failed);

  return {
    generatedAtIso: input.generatedAtIso,
    strategyId: input.strategyId,
    passRate01: passRate as unknown as ValidationGateVerdict["passRate01"],
    promote, failedChecks: failed, reasons, blockers,
  };
}
