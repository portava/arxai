// The price the paper venue marks an open paper order at, as pure reads.
//
// paperVenue.markToMarket values (and, for a simulator-priced order, settles)
// every open order at this price. The Risk Governor's paper risk count
// (paperExecution/paperOpenRisk.ts) values open positions at the same price
// without settling or writing anything, so the two never read different
// marks. No db, no network, no wall clock: the caller passes the time.

import { generateDeterministicCandles } from "../backtestStrategyRegistry.js";

/**
 * strategyId tag of a confirmed SIMULATED open (owner decision 13), booked at
 * a real market quote. Like Build EE orders, mark-to-market never settles it
 * at the synthetic simulator price; its stop/target are settled by the Build
 * EE monitor from real market data.
 */
export const MARKET_PRICED_SIMULATED_OPEN = "market_priced_simulated_open";

/** strategyId tag of a Build EE paper execution, booked and valued at a real market quote. */
const EE_PAPER_EXECUTION = "build_ee_paper_execution";

/** Quote source the paper venue gives a simulator price it hands the governor (never a market quote). */
export const PAPER_SIMULATOR_PRICE_SOURCE = "paper_simulator_price";

/** Orders booked at a real market quote; every other order is opened and valued at the simulator's synthetic price. */
export function isMarketPricedPaperOrder(o: { strategyId?: string | null }): boolean {
  return o.strategyId === EE_PAPER_EXECUTION || o.strategyId === MARKET_PRICED_SIMULATED_OPEN;
}

// ── Synthetic mark-to-market price ─────────────────────────────────────────
// Uses the same deterministic candle generator as the backtest engine so the
// "current" price is reproducible per (symbol, second-bucket) and never
// requires a real broker quote. Bucket = 60s so prices feel live but stay
// reproducible within the bucket.
export function getMockPrice(symbol: string, atMs: number): number {
  const bucket = Math.floor(atMs / 60_000) * 60_000;
  const candles = generateDeterministicCandles({
    symbol, count: 1, timeframe: "M1",
    seed: `paper-mtm|${bucket}`, baseTimeMs: bucket,
  });
  return candles[0]?.close ?? 1;
}

/**
 * The stop or target a simulator-priced order's mark crossed, which
 * markToMarket settles it at (the order's own level), else null.
 */
export function simulatorExitLevel(
  o: { direction: string; stopLoss: number; takeProfit?: number | null },
  px: number,
): { level: number; hit: "SL" | "TP" } | null {
  const tp = o.takeProfit ?? null;
  if (o.direction === "BUY") {
    if (px <= o.stopLoss) return { level: o.stopLoss, hit: "SL" };
    if (tp != null && px >= tp) return { level: tp, hit: "TP" };
  } else {
    if (px >= o.stopLoss) return { level: o.stopLoss, hit: "SL" };
    if (tp != null && px <= tp) return { level: tp, hit: "TP" };
  }
  return null;
}
