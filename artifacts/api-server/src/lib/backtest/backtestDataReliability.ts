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
  /**
   * True only when the depth axis is `sufficient` AND the bars were observed
   * market history. A generated-price run is never reliable: its bar count is
   * the length of a generated series, not real data depth (display only).
   */
  reliable: boolean;
  /** What the counted bars were: generated prices or stored broker history. */
  basis: "generated_prices" | "broker_history" | "unknown";
  /** Plain-English limit of this verdict, or null when there is none to state. */
  note: string | null;
}

export const GENERATED_PRICES_RELIABILITY_NOTE =
  "Prices were generated, not observed market history, so this bar count says nothing about real data depth.";

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
 * history). `reliable` mirrors `canShowTradeSetup` for observed broker history
 * and is always false for generated prices; it can only describe, never grant
 * or block.
 */
export function evaluateBacktestDataReliability(args: {
  symbol: string;
  timeframe: string;
  availableClosedCandles: number;
  /**
   * The run's stored data source. "synthetic" = generated prices (never
   * reliable); "broker" = stored broker history. Omitted means the caller is
   * counting observed closed bars itself. Any other value is an unknown source
   * and is never reliable.
   */
  dataSource?: unknown;
}): BacktestDataReliability {
  const verdict = evaluateMarketDataSufficiency({
    symbol: args.symbol,
    timeframe: args.timeframe,
    freshnessVerdict: "LIVE",
    availableClosedCandles: args.availableClosedCandles,
  });
  const basis = args.dataSource === "synthetic" ? "generated_prices"
    : args.dataSource === "broker" || args.dataSource === undefined ? "broker_history" : "unknown";
  return {
    status: verdict.status,
    availableClosedCandles: verdict.availableClosedCandles,
    minimumRequiredCandles: verdict.minimumRequiredCandles,
    // Fail closed: only observed broker bars can make a depth verdict reliable.
    reliable: basis === "broker_history" && verdict.canShowTradeSetup,
    basis,
    note: basis === "generated_prices" ? GENERATED_PRICES_RELIABILITY_NOTE
      : basis === "unknown" ? "The run's price source is unknown, so its bar count is not treated as reliable data depth."
        : null,
  };
}
