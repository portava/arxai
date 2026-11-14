import { normalizeCandles, type NormalizedChartCandle } from "../data/chart/candleNormalization.js";
import type { CandleHistoryResult } from "../data/candleHistoryService.js";
import type { ForecastFeed } from "./service.js";

/** Compose existing deep-history and current-truth services; never mix sources. */
export function assembleForecastFeed(symbol: string, history: CandleHistoryResult, current: {
  candles: NormalizedChartCandle[]; source: string | null; aiUsable: boolean;
  quality: string; warning: string | null;
}, now: number): ForecastFeed {
  const historical = normalizeCandles(history.candles, { symbol, displaySymbol: symbol,
    timeframe: "M1", source: history.source, now, receivedAt: history.fetchedAt }).candles;
  const sameSource = history.ok && history.source != null && history.source === current.source;
  // The latest verified chart candle wins over a stale cache copy at the same time.
  const byTime = new Map(historical.map(b => [b.openTime, b]));
  if (sameSource) for (const b of current.candles) byTime.set(b.openTime, b);
  const closed = [...byTime.values()].filter(b => b.isFinal && b.isComplete)
    .sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime)).slice(-5000);
  const known = closed.length > 0 && closed.every(b => b.source === history.source
    && (b.sourceMode === "live" || b.sourceMode === "demo"));
  return { bars: closed.map(b => ({ openTime: Date.parse(b.openTime), closeTime: Date.parse(b.closeTime),
    open: b.open, high: b.high, low: b.low, close: b.close, isFinal: b.isFinal })),
    origin: { symbol, provider: history.source ?? "unknown", fetchedAt: new Date(now).toISOString(),
      kind: "BROKER_HISTORY", historicalArrivalTimesKnown: false },
    ready: sameSource && known && current.aiUsable && current.quality === "clean",
    // Refusals are stable codes: a free-text chart warning was masked by the
    // route as a generic failure, hiding why the forecast was withheld.
    reason: !sameSource ? "HISTORY_SOURCE_MISMATCH" : !known ? "UNKNOWN_DATA_PROVENANCE"
      : !current.aiUsable || current.quality !== "clean" ? "LIVE_CHART_NOT_VERIFIED_CLEAN" : null };
}
