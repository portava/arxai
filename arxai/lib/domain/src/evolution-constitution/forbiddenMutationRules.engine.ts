import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Forbidden Mutation Rules — patterns a mutation must NEVER take. These are
// the hard floor under evolution. Any matched pattern blocks promotion
// permanently — no override, no vote, no exception.
// ═══════════════════════════════════════════════════════════════════════════

export const ForbiddenMutationPatternSchema = z.object({
  patternId: z.string().min(1),
  description: z.string().min(1),
  // Predicate inputs; concrete checks done in evaluator.
  rule: z.enum([
    "RISK_PER_TRADE_GT_FLOOR",
    "STOP_LOSS_REMOVED",
    "LEVERAGE_GT_FLOOR",
    "VALIDATION_SKIPPED",
    "NEGATIVE_EXPECTANCY_LIVE",
    "MEMORY_BLACKLISTED",
  ]),
});
export type ForbiddenMutationPattern = z.infer<typeof ForbiddenMutationPatternSchema>;

export const FORBIDDEN_PATTERNS: readonly ForbiddenMutationPattern[] = Object.freeze([
  { patternId: "FP_RISK_OVER_CAP",   description: "Per-trade risk exceeds hard cap (3% of equity).", rule: "RISK_PER_TRADE_GT_FLOOR" },
  { patternId: "FP_NO_STOP",         description: "Stop loss removed or set to zero.",               rule: "STOP_LOSS_REMOVED" },
  { patternId: "FP_LEVERAGE_OVER",   description: "Leverage exceeds 30x.",                           rule: "LEVERAGE_GT_FLOOR" },
  { patternId: "FP_VAL_SKIPPED",     description: "Promoted without all 4 sandbox validation stages.", rule: "VALIDATION_SKIPPED" },
  { patternId: "FP_NEG_EXPECTANCY",  description: "Live with negative expectancy (post-min-samples).", rule: "NEGATIVE_EXPECTANCY_LIVE" },
  { patternId: "FP_MEMORY_KNOWN_BAD", description: "Mutation matches a previously-collapsed pattern.", rule: "MEMORY_BLACKLISTED" },
] as const);

export const ForbiddenCheckInputsSchema = z.object({
  riskPerTradePct: z.number().min(0),
  stopLossPct: z.number().min(0),
  leverage: z.number().min(0),
  passedAllValidationStages: z.boolean(),
  liveSampleCount: z.int().nonnegative(),
  liveExpectancyR: z.number(),
  memoryBlacklistedFingerprints: z.array(z.string()),
  mutationFingerprint: z.string().min(1),
});
export type ForbiddenCheckInputs = z.infer<typeof ForbiddenCheckInputsSchema>;

export interface ForbiddenCheckResult {
  permitted: boolean;
  matchedPatternIds: string[];
  reasons: string[];
}

const RISK_CAP_PCT = 3.0;
const LEVERAGE_CAP = 30;
const MIN_LIVE_SAMPLES_FOR_EXPECTANCY = 80;

export function checkForbiddenMutation(i: ForbiddenCheckInputs): ForbiddenCheckResult {
  const matched: string[] = [];
  const reasons: string[] = [];
  if (i.riskPerTradePct > RISK_CAP_PCT) {
    matched.push("FP_RISK_OVER_CAP");
    reasons.push(`risk per trade ${i.riskPerTradePct.toFixed(2)}% > cap ${RISK_CAP_PCT}%`);
  }
  if (i.stopLossPct <= 0) {
    matched.push("FP_NO_STOP");
    reasons.push(`stop loss is ${i.stopLossPct} — forbidden`);
  }
  if (i.leverage > LEVERAGE_CAP) {
    matched.push("FP_LEVERAGE_OVER");
    reasons.push(`leverage ${i.leverage} > cap ${LEVERAGE_CAP}`);
  }
  if (!i.passedAllValidationStages) {
    matched.push("FP_VAL_SKIPPED");
    reasons.push(`validation stages not all passed`);
  }
  if (i.liveSampleCount >= MIN_LIVE_SAMPLES_FOR_EXPECTANCY && i.liveExpectancyR < 0) {
    matched.push("FP_NEG_EXPECTANCY");
    reasons.push(`live expectancy ${i.liveExpectancyR.toFixed(3)} < 0 with ${i.liveSampleCount} samples`);
  }
  if (i.memoryBlacklistedFingerprints.includes(i.mutationFingerprint)) {
    matched.push("FP_MEMORY_KNOWN_BAD");
    reasons.push(`fingerprint ${i.mutationFingerprint} matches blacklisted memory`);
  }
  const permitted = matched.length === 0;
  if (permitted) reasons.push("no forbidden patterns matched");
  return { permitted, matchedPatternIds: matched, reasons };
}

export function listForbiddenPatterns(): readonly ForbiddenMutationPattern[] {
  return FORBIDDEN_PATTERNS;
}
