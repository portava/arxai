// ═══════════════════════════════════════════════════════════════════════════
// Market Impact
//
// Market impact = side_signed × (midAfterDelay − midAtSignal), in pips.
// Positive when the market moved against us after we traded — i.e. our
// order pushed the price (permanent impact).
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import type { Side } from "./executionIntelligence.types";

export function computeMarketImpact(
  side: Side,
  midAtSignal: number,
  midAfterDelay: number,
  pipSize: number,
): number {
  const denom = pipSize > 0 ? pipSize : 1e-9;
  const signed = side === "BUY" ? (midAfterDelay - midAtSignal) : (midAtSignal - midAfterDelay);
  return signed / denom;
}
