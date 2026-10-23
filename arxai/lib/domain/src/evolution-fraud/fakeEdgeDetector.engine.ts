import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Fake Edge Detector — was the apparent edge driven by a tiny number of
// outlier trades, by survivorship of the test window, or by data-snooping?
// Returns suspicion01 in [0,1]. >= 0.6 ⇒ recommend block.
// ═══════════════════════════════════════════════════════════════════════════

export const FakeEdgeInputsSchema = z.object({
  strategyId: z.string().min(1),
  sampleCount: z.int().nonnegative(),
  topTradeContributionToPnl01: z.number().min(0).max(1),
  outOfSampleExpectancyR: z.number(),
  inSampleExpectancyR: z.number(),
  windowsTested: z.int().positive(),
  windowsPassed: z.int().nonnegative(),
});
export type FakeEdgeInputs = z.infer<typeof FakeEdgeInputsSchema>;

export interface FakeEdgeResult {
  strategyId: string;
  suspicion01: number;
  block: boolean;
  triggers: string[];
  reasons: string[];
}

export function detectFakeEdge(i: FakeEdgeInputs): FakeEdgeResult {
  const triggers: string[] = [];
  let s = 0;
  // Outlier-driven PnL
  if (i.topTradeContributionToPnl01 > 0.5) {
    s += 0.35;
    triggers.push(`top trades drive ${(i.topTradeContributionToPnl01 * 100).toFixed(1)}% of PnL`);
  }
  // OOS collapse
  const collapse = i.inSampleExpectancyR - i.outOfSampleExpectancyR;
  if (collapse > 0.3) {
    s += 0.30;
    triggers.push(`in-sample expectancy ${i.inSampleExpectancyR.toFixed(3)} vs OOS ${i.outOfSampleExpectancyR.toFixed(3)} (Δ ${collapse.toFixed(3)})`);
  }
  // Tiny sample
  if (i.sampleCount < 100) {
    s += 0.20;
    triggers.push(`sample count ${i.sampleCount} < 100`);
  }
  // Window snooping: only a few windows passed out of many
  const windowPassRate = i.windowsTested === 0 ? 0 : i.windowsPassed / i.windowsTested;
  if (windowPassRate < 0.5) {
    s += 0.15;
    triggers.push(`only ${i.windowsPassed}/${i.windowsTested} windows passed`);
  }
  const suspicion01 = Math.min(1, s);
  const block = suspicion01 >= 0.6;
  return {
    strategyId: i.strategyId,
    suspicion01,
    block,
    triggers,
    reasons: [`fake-edge suspicion=${suspicion01.toFixed(3)} from ${triggers.length} trigger(s); block=${block}`],
  };
}
