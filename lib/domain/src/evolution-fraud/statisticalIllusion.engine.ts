import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Statistical Illusion — detect "results that look great but are not
// statistically distinguishable from noise". Computes a simple t-stat-like
// signal-to-noise and a p-value-ish proxy. >= 0.6 illusion01 ⇒ block.
// ═══════════════════════════════════════════════════════════════════════════

export const IllusionInputsSchema = z.object({
  strategyId: z.string().min(1),
  sampleCount: z.int().nonnegative(),
  meanReturnR: z.number(),
  stdevReturnR: z.number().min(0),
  benchmarkReturnR: z.number().default(0),
});
export type IllusionInputs = z.infer<typeof IllusionInputsSchema>;

export interface IllusionResult {
  strategyId: string;
  tLike: number;
  illusion01: number;
  block: boolean;
  triggers: string[];
  reasons: string[];
}

export function detectStatisticalIllusion(i: IllusionInputs): IllusionResult {
  const triggers: string[] = [];
  const stderr = i.stdevReturnR / Math.max(1, Math.sqrt(i.sampleCount));
  // t-like: how many stderr above benchmark.
  const tLike = stderr === 0 ? 0 : (i.meanReturnR - i.benchmarkReturnR) / stderr;
  let s = 0;
  if (i.sampleCount < 80) {
    s += 0.30;
    triggers.push(`sample ${i.sampleCount} < 80`);
  }
  if (Math.abs(tLike) < 1.5) {
    s += 0.40;
    triggers.push(`t-like ${tLike.toFixed(2)} below 1.5 (not significant)`);
  }
  if (i.stdevReturnR > Math.abs(i.meanReturnR) * 5 && Math.abs(i.meanReturnR) > 0) {
    s += 0.20;
    triggers.push(`noise ${i.stdevReturnR.toFixed(3)} >> signal ${Math.abs(i.meanReturnR).toFixed(3)}`);
  }
  if (i.meanReturnR > 0 && i.benchmarkReturnR > i.meanReturnR) {
    s += 0.10;
    triggers.push(`benchmark beats strategy`);
  }
  const illusion01 = Math.min(1, s);
  const block = illusion01 >= 0.6;
  return {
    strategyId: i.strategyId,
    tLike,
    illusion01,
    block,
    triggers,
    reasons: [`illusion=${illusion01.toFixed(3)} (t-like ${tLike.toFixed(2)}); block=${block}`],
  };
}
