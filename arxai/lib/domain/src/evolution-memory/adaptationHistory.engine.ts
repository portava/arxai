import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Adaptation History — record of successful regime adaptations. Used to
// score adaptation capacity per strategy (does this lineage actually learn?).
// ═══════════════════════════════════════════════════════════════════════════

export const AdaptationEntrySchema = z.object({
  strategyId: z.string().min(1),
  regimeFromId: z.string().min(1),
  regimeToId: z.string().min(1),
  successful: z.boolean(),
  observedAtIso: z.string(),
});
export type AdaptationEntry = z.infer<typeof AdaptationEntrySchema>;

export const AdaptationSummaryInputsSchema = z.object({
  strategyId: z.string().min(1),
  history: z.array(AdaptationEntrySchema),
});
export type AdaptationSummaryInputs = z.infer<typeof AdaptationSummaryInputsSchema>;

export interface AdaptationSummary {
  strategyId: string;
  attempts: number;
  successes: number;
  successRate01: number;
  uniqueRegimePairs: number;
  reasons: string[];
}

export function summarizeAdaptation(i: AdaptationSummaryInputs): AdaptationSummary {
  const own = i.history.filter((e) => e.strategyId === i.strategyId);
  const successes = own.filter((e) => e.successful).length;
  const pairs = new Set(own.map((e) => `${e.regimeFromId}->${e.regimeToId}`));
  const successRate01 = own.length === 0 ? 0 : successes / own.length;
  return {
    strategyId: i.strategyId,
    attempts: own.length,
    successes,
    successRate01,
    uniqueRegimePairs: pairs.size,
    reasons: [`${successes}/${own.length} successful adaptations across ${pairs.size} regime pair(s)`],
  };
}
