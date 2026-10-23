// ═══════════════════════════════════════════════════════════════════════════
// Realized Spread
//
// Realized spread = 2 × side_signed × (fillPrice − midAfterDelay), in pips.
//   For BUY:  positive when fill > midAfterDelay (we paid above future mid)
//   For SELL: positive when fill < midAfterDelay
// Measures the part of the cost that ISN'T due to permanent market impact —
// i.e., the dealer's profit on top of the new equilibrium.
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import type { Side } from "./executionIntelligence.types";

export function computeRealizedSpread(
  side: Side,
  fillPrice: number,
  midAfterDelay: number,
  pipSize: number,
): number {
  const denom = pipSize > 0 ? pipSize : 1e-9;
  const signed = side === "BUY" ? (fillPrice - midAfterDelay) : (midAfterDelay - fillPrice);
  return (2 * signed) / denom;
}
