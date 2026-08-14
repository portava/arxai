// ═══════════════════════════════════════════════════════════════════════════
// Survival Replay
//
// Re-scores a sequence of replayed outcomes with a survival-first
// weighting:
//   • drawdown control (peak-to-trough cumulative R)
//   • max consecutive losses
//   • left-tail (worst-trade R)
//   • discipline consistency (variance of R)
//   • expectancy (mean R)
//
// Survival-first means a path with 5R total but a -3R worst trade scores
// LOWER than a path with 3R total and a -0.8R worst trade.
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const SurvivalReplayInputSchema = z.object({
  rMultiples: z.array(z.number()),
  maxAllowedDrawdownR: z.number().positive().default(5),
  maxAllowedConsecutiveLosses: z.number().int().positive().default(4),
}).strict();
export type SurvivalReplayInput = z.infer<typeof SurvivalReplayInputSchema>;

export interface SurvivalReplayReport {
  sample: number;
  cumulativeR: number;
  meanR: number;
  worstR: number;
  bestR: number;
  maxDrawdownR: number;
  maxConsecutiveLosses: number;
  consistencyScore01: number;     // 1 - normalized stddev
  drawdownControl01:  number;
  tailControl01:      number;
  consecutiveLossControl01: number;
  expectancyScore01:  number;
  survivalScore01:    number;
  classification: "ROBUST" | "ACCEPTABLE" | "FRAGILE" | "RUINED";
  reasons: string[];
}

export function scoreSurvivalReplay(input: SurvivalReplayInput): SurvivalReplayReport {
  const rs = input.rMultiples;
  if (!rs.length) {
    return {
      sample: 0, cumulativeR: 0, meanR: 0, worstR: 0, bestR: 0,
      maxDrawdownR: 0, maxConsecutiveLosses: 0,
      consistencyScore01: 0.5, drawdownControl01: 0.5, tailControl01: 0.5,
      consecutiveLossControl01: 0.5, expectancyScore01: 0.5,
      survivalScore01: 0.5, classification: "ACCEPTABLE",
      reasons: ["no trades — neutral baseline"],
    };
  }

  let cum = 0, peak = 0, maxDD = 0;
  let consec = 0, maxConsec = 0;
  for (const r of rs) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    if (r < 0) { consec += 1; maxConsec = Math.max(maxConsec, consec); }
    else        { consec = 0; }
  }
  const meanR  = cum / rs.length;
  const worstR = Math.min(...rs);
  const bestR  = Math.max(...rs);
  const variance = rs.reduce((a, b) => a + (b - meanR) ** 2, 0) / Math.max(1, rs.length - 1);
  const sd = Math.sqrt(variance);

  // Sub-scores (higher = better)
  const drawdownControl01 = clamp01(1 - maxDD / Math.max(0.1, input.maxAllowedDrawdownR));
  const consecutiveLossControl01 =
    clamp01(1 - maxConsec / Math.max(1, input.maxAllowedConsecutiveLosses));
  const tailControl01 = clamp01(1 - Math.max(0, -worstR) / 3); // -3R = full tail penalty
  const consistencyScore01 = clamp01(1 - sd / 2);              // sd=2R → fully inconsistent
  const expectancyScore01  = clamp01(0.5 + meanR / 2);          // mean +1R → 1.0

  // Survival-first composite
  const survivalScore01 = clamp01(
    drawdownControl01          * 0.30 +
    consecutiveLossControl01   * 0.20 +
    tailControl01              * 0.20 +
    consistencyScore01         * 0.15 +
    expectancyScore01          * 0.15,
  );

  let classification: SurvivalReplayReport["classification"];
  const reasons: string[] = [];
  if (maxDD >= input.maxAllowedDrawdownR) {
    classification = "RUINED";
    reasons.push(`max drawdown ${round2(maxDD)}R >= ${input.maxAllowedDrawdownR}R limit`);
  } else if (survivalScore01 >= 0.70) {
    classification = "ROBUST";   reasons.push("survival-first composite ≥ 0.70");
  } else if (survivalScore01 >= 0.50) {
    classification = "ACCEPTABLE"; reasons.push("survival-first composite in [0.50, 0.70)");
  } else {
    classification = "FRAGILE";  reasons.push("survival-first composite < 0.50");
  }
  if (maxConsec >= input.maxAllowedConsecutiveLosses) {
    reasons.push(`consecutive losses ${maxConsec} >= ${input.maxAllowedConsecutiveLosses} limit`);
  }

  return {
    sample: rs.length,
    cumulativeR: round2(cum), meanR: round2(meanR),
    worstR: round2(worstR), bestR: round2(bestR),
    maxDrawdownR: round2(maxDD), maxConsecutiveLosses: maxConsec,
    consistencyScore01: round2(consistencyScore01),
    drawdownControl01:  round2(drawdownControl01),
    tailControl01:      round2(tailControl01),
    consecutiveLossControl01: round2(consecutiveLossControl01),
    expectancyScore01:  round2(expectancyScore01),
    survivalScore01:    round2(survivalScore01),
    classification, reasons,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }
