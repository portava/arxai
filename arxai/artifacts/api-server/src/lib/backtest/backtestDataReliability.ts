// ── DATA-SUFFICIENCY TRUTH (Phase 2, PART B) — backtest reliability (pure) ───
//
// The PURE, DB-free composition behind the backtest data-reliability badge.
// Composes (never re-derives) the shared `evaluateMarketDataSufficiency` engine
// over a completed run's historical candle DEPTH so the dashboard can show how
// trustworthy the sample size is.
//
// A backtest runs on settled, fully-closed candles, so the live freshness axis
// is N/A — we feed "LIVE" to evaluate the DEPTH + APPROVAL axes only and key the
// badge off the returned status.
//
// SAFETY: read-only display. This NEVER blocks a run, alters metrics, or touches
// the live trade path. The verdict can only DESCRIBE reliability, never grant.
//
// Kept in its own pure module (imports only the pure domain engine, no DB) so it
// is unit-testable without pulling in the DB-bound route module.

import { evaluateMarketDataSufficiency } from "@workspace/domain/market";

export interface BacktestDataReliability {
  status: ReturnType<typeof evaluateMarketDataSufficiency>["status"];
  availableClosedCandles: number;
  minimumRequiredCandles: number;
  /** True exactly when the depth axis is `sufficient` (display affordance only). */
  reliable: boolean;
}

/**
 * Exact closed-candle count for a backtest window. The generator anchors
 * `endTime = startTime + (n-1)·tfMs`, so `(endTime − startTime)/tfMs + 1` is the
 * run's exact candle count. Returns 0 for a non-positive timeframe.
 */
export function backtestClosedCandleCount(
  timeframeMsValue: number,
  startMs: number,
  endMs: number,
): number {
  if (!(timeframeMsValue > 0)) return 0;
  return Math.max(0, Math.round((endMs - startMs) / timeframeMsValue) + 1);
}

/**
 * Reliability verdict for a completed backtest. DISPLAY-ONLY: composes the
 * shared engine on the DEPTH + APPROVAL axes (freshness forced "LIVE" — settled
 * history). `reliable` mirrors `canShowTradeSetup`; it can only describe, never
 * grant or block.
 */
export function evaluateBacktestDataReliability(args: {
  symbol: string;
  timeframe: string;
  availableClosedCandles: number;
}): BacktestDataReliability {
  const verdict = evaluateMarketDataSufficiency({
    symbol: args.symbol,
    timeframe: args.timeframe,
    freshnessVerdict: "LIVE",
    availableClosedCandles: args.availableClosedCandles,
  });
  return {
    status: verdict.status,
    availableClosedCandles: verdict.availableClosedCandles,
    minimumRequiredCandles: verdict.minimumRequiredCandles,
    reliable: verdict.canShowTradeSetup,
  };
}
