// ═══════════════════════════════════════════════════════════════════════════
// Market Snapshot Replay
//
// Reconstructs market context surrounding a snapshot. Pure.
// Returns a normalized view used by scoring/lesson stages.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { Candle, MarketSnapshot } from "./replay.types";

export const MarketReplayViewSchema = z.object({
  symbol: z.string(),
  ts: z.string(),
  regime: z.string(),
  volatilityBand: z.string(),
  realizedVolPct: z.number().nonnegative(),
  spreadPips: z.number().nonnegative(),
  newsFlag: z.boolean(),
  liquidityScore01: z.number().min(0).max(1),
  candleCount: z.number().int().nonnegative(),
  meanCandleRange: z.number().nonnegative(),
  notes: z.array(z.string()),
});
export type MarketReplayView = z.infer<typeof MarketReplayViewSchema>;

export function replayMarketSnapshot(market: MarketSnapshot, candles: Candle[]): MarketReplayView {
  const ranges = candles.map(c => Math.max(0, c.high - c.low));
  const meanRange = ranges.length ? ranges.reduce((a,b)=>a+b,0) / ranges.length : 0;
  const notes: string[] = [];
  if (market.newsFlag) notes.push("news flag active");
  if (market.volatilityBand === "EXTREME") notes.push("extreme volatility band");
  if (market.liquidityScore01 < 0.4) notes.push("liquidity below 0.4");
  return {
    symbol: market.symbol, ts: market.ts,
    regime: market.regime, volatilityBand: market.volatilityBand,
    realizedVolPct: market.realizedVolPct, spreadPips: market.spreadPips,
    newsFlag: market.newsFlag, liquidityScore01: market.liquidityScore01,
    candleCount: candles.length, meanCandleRange: round4(meanRange),
    notes,
  };
}
function round4(n: number) { return Math.round(n * 10000) / 10000; }
