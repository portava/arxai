import { z } from "zod/v4";
import { Score01Schema, TradeIntentIdSchema, SymbolIdSchema, type SymbolId, type TradeIntentId } from "./systemIntegration.types";

// ═══════════════════════════════════════════════════════════════════════════
// Risk Governor Integration
// Hard gate before any trade leaves the OS. Consumes 5 risk scores in [0,1]:
//   - executionRisk      (from execution-microstructure)
//   - cognitiveRisk      (from cognitive)
//   - marketStressRisk   (from stress-lab calibrations / live stress index)
//   - dataIntegrityRisk  (from resilience.dataIntegrity)
//   - liquidityRisk      (from execution-microstructure.liquidityDepth)
//
// Composite risk + per-source thresholds. Hard-block whenever any single
// score crosses its hard threshold OR composite crosses globalHardThreshold.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const RiskScoresSchema = z.object({
  executionRisk:     Score01Schema,
  cognitiveRisk:     Score01Schema,
  marketStressRisk:  Score01Schema,
  dataIntegrityRisk: Score01Schema,
  liquidityRisk:     Score01Schema,
});
export type RiskScores = z.infer<typeof RiskScoresSchema>;

export const RiskWeightsSchema = z.object({
  executionRisk:     z.number().min(0).max(1),
  cognitiveRisk:     z.number().min(0).max(1),
  marketStressRisk:  z.number().min(0).max(1),
  dataIntegrityRisk: z.number().min(0).max(1),
  liquidityRisk:     z.number().min(0).max(1),
});
export type RiskWeights = z.infer<typeof RiskWeightsSchema>;

export const DEFAULT_RISK_WEIGHTS: RiskWeights = {
  executionRisk: 0.25, cognitiveRisk: 0.20, marketStressRisk: 0.20,
  dataIntegrityRisk: 0.20, liquidityRisk: 0.15,
};

export const RiskThresholdsSchema = z.object({
  perSourceHard:     Score01Schema,    // any single source crossing → hard block
  globalHardThreshold: Score01Schema,  // composite crossing → hard block
  globalSoftThreshold: Score01Schema,  // composite crossing → reduce-only
});
export type RiskThresholds = z.infer<typeof RiskThresholdsSchema>;

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  perSourceHard: 0.85 as unknown as RiskThresholds["perSourceHard"],
  globalHardThreshold: 0.75 as unknown as RiskThresholds["globalHardThreshold"],
  globalSoftThreshold: 0.55 as unknown as RiskThresholds["globalSoftThreshold"],
};

export const RiskGovernorInputSchema = z.object({
  intentId: TradeIntentIdSchema,
  symbol: SymbolIdSchema,
  scores: RiskScoresSchema,
  weights: RiskWeightsSchema.optional(),
  thresholds: RiskThresholdsSchema.optional(),
  generatedAtIso: z.string(),
});
export type RiskGovernorInput = z.infer<typeof RiskGovernorInputSchema>;

export const RiskGovernorVerdictSchema = z.object({
  generatedAtIso: z.string(),
  intentId: TradeIntentIdSchema,
  symbol: SymbolIdSchema,
  compositeRisk: Score01Schema,
  decision: z.enum(["APPROVED", "REDUCE_ONLY", "HARD_BLOCK"]),
  hardBlock: z.boolean(),
  triggeredSources: z.array(z.string()),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type RiskGovernorVerdict = z.infer<typeof RiskGovernorVerdictSchema>;

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

export function runRiskGovernorIntegration(input: RiskGovernorInput): RiskGovernorVerdict {
  const w = input.weights ?? DEFAULT_RISK_WEIGHTS;
  const t = input.thresholds ?? DEFAULT_RISK_THRESHOLDS;
  const reasons: string[] = [];
  const blockers: string[] = [];
  const triggered: string[] = [];

  const wSum = w.executionRisk + w.cognitiveRisk + w.marketStressRisk + w.dataIntegrityRisk + w.liquidityRisk;
  const wsafe = wSum > 0 ? wSum : 1;
  const composite = clamp01(
    (input.scores.executionRisk     * w.executionRisk +
     input.scores.cognitiveRisk     * w.cognitiveRisk +
     input.scores.marketStressRisk  * w.marketStressRisk +
     input.scores.dataIntegrityRisk * w.dataIntegrityRisk +
     input.scores.liquidityRisk     * w.liquidityRisk) / wsafe,
  );

  const checkHard = (name: string, v: number) => {
    if (v >= (t.perSourceHard as unknown as number)) {
      triggered.push(name);
      blockers.push(`${name} ${(v*100).toFixed(0)}% ≥ hard threshold`);
    }
  };
  checkHard("executionRisk",     input.scores.executionRisk);
  checkHard("cognitiveRisk",     input.scores.cognitiveRisk);
  checkHard("marketStressRisk",  input.scores.marketStressRisk);
  checkHard("dataIntegrityRisk", input.scores.dataIntegrityRisk);
  checkHard("liquidityRisk",     input.scores.liquidityRisk);

  let decision: "APPROVED" | "REDUCE_ONLY" | "HARD_BLOCK" = "APPROVED";
  if (blockers.length > 0 || composite >= (t.globalHardThreshold as unknown as number)) {
    decision = "HARD_BLOCK";
    if (composite >= (t.globalHardThreshold as unknown as number)) {
      blockers.push(`composite risk ${(composite*100).toFixed(0)}% ≥ global hard threshold`);
    }
  } else if (composite >= (t.globalSoftThreshold as unknown as number)) {
    decision = "REDUCE_ONLY";
    reasons.push(`composite risk ${(composite*100).toFixed(0)}% ≥ soft threshold — size reduction recommended`);
  } else {
    reasons.push(`composite risk ${(composite*100).toFixed(0)}% within tolerance`);
  }

  return {
    generatedAtIso: input.generatedAtIso,
    intentId: input.intentId, symbol: input.symbol,
    compositeRisk: composite as unknown as RiskGovernorVerdict["compositeRisk"],
    decision, hardBlock: decision === "HARD_BLOCK",
    triggeredSources: triggered, reasons, blockers,
  };
}
