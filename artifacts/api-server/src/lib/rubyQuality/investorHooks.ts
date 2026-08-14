// Task #199 — Ruby Quality: investor-reporting hooks (read-only, sanitized).
//
// SAFETY / SCOPE:
//   - READ-ONLY. Returns a SANITIZED, aggregate-only summary suitable for
//     investor reporting. It NEVER exposes per-user rows, admin-only review
//     detail, internal enum tokens, tuning knobs, or any execution surface.
//   - No guaranteed / fixed / risk-free wording. Past performance only.

import { computeQualityMetrics, type QualityFilter } from "./aggregator.js";

export interface InvestorQualitySummary {
  /** Plain-language, aggregate-only signal-quality snapshot. */
  signalsTracked: number;
  signalsGraded: number;
  winRatePct: number | null;
  avoidedBadTrades: number;
  disclaimer: string;
}

/**
 * Aggregate signal-quality summary for investor reporting. Scope to a window via
 * the filter; defaults to all-time. Numbers are rounded; no row-level detail.
 */
export async function buildInvestorQualitySummary(
  filter: QualityFilter = {},
): Promise<InvestorQualitySummary> {
  const m = await computeQualityMetrics(filter);
  return {
    signalsTracked: m.totals.tracked,
    signalsGraded: m.totals.graded,
    winRatePct: m.totals.graded > 0 ? Math.round(m.rates.winRate * 1000) / 10 : null,
    avoidedBadTrades: m.avoidedBadTrades,
    disclaimer:
      "Signal-quality metrics describe past observed performance only and are not a forecast or guarantee of future results.",
  };
}
