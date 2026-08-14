import { z } from "zod/v4";
import {
  AgentIdSchema, SymbolIdSchema, Score01Schema, SeveritySchema,
  type AgentId, type SymbolId,
} from "./systemIntegration.types";

// ═══════════════════════════════════════════════════════════════════════════
// Agent System Integration
// Bundles the per-cycle context that specialist agents must read before
// producing their proposals: execution microstructure, cognitive state,
// stress lab calibration, explainability summary, attention priority.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const MicroSnapshotSchema = z.object({
  symbol: SymbolIdSchema,
  spreadPips: z.number().nonnegative(),
  expectedSlippagePips: z.number().nonnegative(),
  fillProbability01: Score01Schema,
  liquidity01: Score01Schema,
  worstSeverity: SeveritySchema,
});
export type MicroSnapshot = z.infer<typeof MicroSnapshotSchema>;

export const CognitiveSnapshotSchema = z.object({
  fatigue01: Score01Schema,
  stress01: Score01Schema,
  performance01: Score01Schema,
  recommendedReduction01: Score01Schema,    // 0 = none, 1 = halt
});
export type CognitiveSnapshot = z.infer<typeof CognitiveSnapshotSchema>;

export const StressCalibrationSchema = z.object({
  worstScenarioKind: z.string(),
  expectedShockPctMove: z.number(),
  peakSpreadPips: z.number().nonnegative(),
  isSimulationOnly: z.literal(true),
});
export type StressCalibration = z.infer<typeof StressCalibrationSchema>;

export const ExplainabilitySnapshotSchema = z.object({
  decisionSummary: z.string(),
  confidence01: Score01Schema,
  topReasons: z.array(z.string()),
});
export type ExplainabilitySnapshot = z.infer<typeof ExplainabilitySnapshotSchema>;

export const AttentionPrioritySchema = z.object({
  symbol: SymbolIdSchema,
  priority01: Score01Schema,                // 1 = look here first
  isDanger: z.boolean(),
});
export type AttentionPriority = z.infer<typeof AttentionPrioritySchema>;

export const AgentSystemInputSchema = z.object({
  agents: z.array(AgentIdSchema),
  micro: z.array(MicroSnapshotSchema),
  cognitive: CognitiveSnapshotSchema,
  stress: StressCalibrationSchema,
  explainability: ExplainabilitySnapshotSchema,
  attention: z.array(AttentionPrioritySchema),
  generatedAtIso: z.string(),
});
export type AgentSystemInput = z.infer<typeof AgentSystemInputSchema>;

export const AgentContextSchema = z.object({
  agentId: AgentIdSchema,
  generatedAtIso: z.string(),
  microBySymbol: z.record(z.string(), MicroSnapshotSchema),
  cognitive: CognitiveSnapshotSchema,
  stress: StressCalibrationSchema,
  explainability: ExplainabilitySnapshotSchema,
  attentionRanked: z.array(AttentionPrioritySchema),
  recommendedSizeMultiplier01: Score01Schema,
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;

export const AgentSystemBundleSchema = z.object({
  generatedAtIso: z.string(),
  contexts: z.array(AgentContextSchema),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type AgentSystemBundle = z.infer<typeof AgentSystemBundleSchema>;

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

export function runAgentSystemIntegration(input: AgentSystemInput): AgentSystemBundle {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const microBySymbol: Record<string, MicroSnapshot> = {};
  for (const m of input.micro) microBySymbol[m.symbol as unknown as string] = m;

  const sortedAttention = [...input.attention].sort((a, b) =>
    (b.priority01 as unknown as number) - (a.priority01 as unknown as number));

  const sizeMult = clamp01(
    1
    - (input.cognitive.recommendedReduction01 as unknown as number)
    - (input.stress.peakSpreadPips > 30 ? 0.25 : 0),
  );

  if (sortedAttention.some((a) => a.isDanger)) {
    reasons.push("attention priority: danger detected on at least one symbol");
  }
  if ((input.cognitive.recommendedReduction01 as unknown as number) >= 0.8) {
    blockers.push("cognitive reduction ≥ 80% — agents must produce no new entries this cycle");
  }
  reasons.push(`agent size multiplier set to ${(sizeMult*100).toFixed(0)}%`);

  const contexts: AgentContext[] = input.agents.map((agentId) => ({
    agentId,
    generatedAtIso: input.generatedAtIso,
    microBySymbol,
    cognitive: input.cognitive,
    stress: input.stress,
    explainability: input.explainability,
    attentionRanked: sortedAttention,
    recommendedSizeMultiplier01: sizeMult as unknown as AgentContext["recommendedSizeMultiplier01"],
    reasons: [...reasons],
    blockers: [...blockers],
  }));

  return {
    generatedAtIso: input.generatedAtIso,
    contexts, reasons, blockers,
  };
}
