// ═══════════════════════════════════════════════════════════════════════════
// Timing Risk
//
// Timing risk = expected adverse price drift between signal and fill, in pips.
// Modelled as volatilityPipsPerMin × √(latencyMinutes). This is the expected
// half-width of a Brownian price walk over the wait period.
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export function computeTimingRisk(
  recentVolatilityPipsPerMin: number,
  latencyMs: number,
): number {
  const vol = Math.max(0, recentVolatilityPipsPerMin);
  const minutes = Math.max(0, latencyMs) / 60_000;
  return vol * Math.sqrt(minutes);
}
