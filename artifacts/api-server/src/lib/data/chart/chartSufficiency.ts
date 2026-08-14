// ── ONE DATA-SUFFICIENCY TRUTH — chart-state adapter ────────────────────────
//
// The SINGLE place that turns a built `ChartIntelligenceState` into the shared
// pure `evaluateMarketDataSufficiency` verdict. Ruby's chart context, the live
// ENTRY gate, and the backtest reliability badge all derive their freshness +
// closed-bar inputs THROUGH this adapter so they can never drift in HOW they
// read the chart state. The actual decision still belongs entirely to the pure
// engine in `@workspace/domain/market`; this module only maps state → inputs.
//
// SAFETY: read-only. Mirrors the long-standing rubyChartContext derivation
// EXACTLY — `state.aiUsable && !state.stale ? LIVE : (delayed + recent deriv
// tick) ? LIVE_DELAYED : AWAITING`, closed bars = `state.candleStats.barsAnalyzed`.
// It can only feed a BLOCK / DOWNGRADE verdict; it never grants one.

import {
  evaluateMarketDataSufficiency,
  type MarketDataSufficiencyVerdict,
} from "@workspace/domain/market";
import type { SymbolFeedVerdict } from "@workspace/domain/safety-contracts/syntheticLiveFloor";
import { hasRecentDerivTickFor } from "../providers/derivProvider.js";
import type { ChartIntelligenceState } from "./chartIntelligence.js";
import type { ChartTimeframe } from "./timeframes.js";

/**
 * Derive the shared freshness verdict from a built chart-intelligence state.
 *
 * Identical to the rubyChartContext derivation so every surface that reads the
 * same state agrees on LIVE / LIVE_DELAYED / AWAITING. Freshness comes from the
 * chart truth layer (which recognizes the `mt5_broker` feed), NOT from the
 * Deriv-tick-gated `resolveSymbolFeedVerdictForSymbol` — a Deriv-only freshness
 * source would wrongly mark a live MT5-broker symbol as AWAITING.
 */
export function deriveFreshnessVerdictFromChartState(
  state: ChartIntelligenceState,
): SymbolFeedVerdict {
  if (state.aiUsable && !state.stale) return "LIVE";
  const liveDelayed =
    state.truthState.quality === "delayed" && hasRecentDerivTickFor(state.symbol);
  return liveDelayed ? "LIVE_DELAYED" : "AWAITING";
}

/**
 * Evaluate the ONE shared data-sufficiency verdict for a built chart state.
 *
 * Pure composition over the domain engine: same state ⇒ same verdict, so the
 * scanner, Ruby, the live ENTRY gate, and the backtest badge can never
 * contradict each other for the same symbol + timeframe.
 */
export function evaluateSufficiencyFromChartState(
  state: ChartIntelligenceState,
  timeframe: ChartTimeframe,
  opts?: { minimumRequiredCandles?: number },
): MarketDataSufficiencyVerdict {
  return evaluateMarketDataSufficiency({
    symbol: state.symbol,
    timeframe,
    freshnessVerdict: deriveFreshnessVerdictFromChartState(state),
    availableClosedCandles: state.candleStats.barsAnalyzed,
    minimumRequiredCandles: opts?.minimumRequiredCandles,
  });
}
