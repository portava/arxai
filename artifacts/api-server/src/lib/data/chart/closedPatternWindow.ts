import { partitionCandleContinuity } from "@workspace/domain/chart-patterns";
import type { Candle } from "../types.js";
import { normalizeCandles, type NormalizedChartCandle } from "./candleNormalization.js";
import { isChartTimeframe } from "./timeframes.js";
import { z } from "zod/v4";
const OBSERVATION_TIME = z.iso.datetime({ offset: true });

/** Shared evidence boundary for current server pattern/trendline assessments.
 * Normalization is a display repair, not permission to erase conflicting input.
 * Only the latest closed uninterrupted segment may describe a current pattern;
 * historical segments remain available in the chart's explicitly scoped reader. */
export function currentClosedPatternWindow(input: {
  symbol: string; displaySymbol?: string; timeframe: string;
  rawCandles: Candle[]; source?: string | null;
}): NormalizedChartCandle[] | null {
  if (!isChartTimeframe(input.timeframe) || input.timeframe === "W1" || input.timeframe === "MN1"
    || !Array.isArray(input.rawCandles) || input.rawCandles.length === 0) return null;
  if (input.rawCandles.some(candle=>!OBSERVATION_TIME.safeParse(candle.time).success)) return null;
  const { candles, anomalies } = normalizeCandles(input.rawCandles, {
    symbol: input.symbol, displaySymbol: input.displaySymbol ?? input.symbol,
    timeframe: input.timeframe, source: input.source ?? null,
  });
  if (anomalies.invalidOhlcCount || anomalies.duplicateCount || anomalies.outOfOrderCount) return null;
  for (const [index, candle] of candles.entries()) {
    if (![candle.open,candle.high,candle.low,candle.close].every(value=>Number.isFinite(value)&&value>0)) return null;
    if (!candle.isComplete || !candle.isFinal || candle.isForming) {
      // Normalized raw observations may have one unfinished tail; it supplies
      // no confirmation. Never skip an unfinished interior observation.
      if (index !== candles.length - 1) return null;
      continue;
    }
  }
  // Partition before discarding the unfinished tip. A new segment containing
  // only that tip must not make the old closed segment appear current.
  const segments = partitionCandleContinuity(candles, candle => ({
    open: Date.parse(candle.openTime)/1000, close: Date.parse(candle.closeTime)/1000,
  }));
  const closed = segments?.at(-1)?.filter(candle=>candle.isComplete&&candle.isFinal&&!candle.isForming);
  return closed?.length ? closed : null;
}
