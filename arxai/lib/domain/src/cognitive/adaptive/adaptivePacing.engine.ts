// ═══════════════════════════════════════════════════════════════════════════
// Adaptive Pacing
//
// Recommends a target inter-trade gap (minutes) and per-session trade cap
// based on the trader's current cognitive load + behavior risk + recent
// pacing. Pure. Evidence-based.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const AdaptivePacingSchema = z.object({
  targetGapMinutes:        z.number().nonnegative(),
  maxTradesPerSession:     z.number().int().nonnegative(),
  oneCandleDelay:          z.boolean(),
  reasons:                 z.array(z.string()),
});
export type AdaptivePacing = z.infer<typeof AdaptivePacingSchema>;

export function recommendAdaptivePacing(input: {
  cognitiveLoad01:    number;
  behaviorRisk01:     number;
  recentMedianGapMin: number;
  baselineGapMin:     number;
}): AdaptivePacing {
  const reasons: string[] = [];
  const severity = Math.max(input.cognitiveLoad01, input.behaviorRisk01);
  let target = Math.max(input.baselineGapMin, input.recentMedianGapMin);
  if      (severity >= 0.85) { target = Math.max(target * 3.0, 30); reasons.push("severity ≥0.85 → 3× pacing or 30m floor"); }
  else if (severity >= 0.65) { target = Math.max(target * 2.0, 15); reasons.push("severity ≥0.65 → 2× pacing or 15m floor"); }
  else if (severity >= 0.50) { target = Math.max(target * 1.5, 10); reasons.push("severity ≥0.50 → 1.5× pacing or 10m floor"); }
  else if (severity >= 0.35) { target = Math.max(target * 1.25, 5); reasons.push("severity ≥0.35 → 1.25× pacing or 5m floor"); }
  else                       { reasons.push("pacing within tolerance"); }
  const maxTrades = severity >= 0.85 ? 0 : severity >= 0.65 ? 3 : severity >= 0.50 ? 5 : severity >= 0.35 ? 10 : 25;
  const oneCandleDelay = severity >= 0.35;
  return {
    targetGapMinutes: round2(target),
    maxTradesPerSession: maxTrades,
    oneCandleDelay, reasons,
  };
}
function round2(n: number) { return Math.round(n * 100) / 100; }
