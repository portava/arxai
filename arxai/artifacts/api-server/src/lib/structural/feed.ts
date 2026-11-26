import { normalizeCandles, type NormalizedChartCandle } from "../data/chart/candleNormalization.js";
import type { CandleHistoryResult } from "../data/candleHistoryService.js";
import { FORECAST_HISTORY_BARS, type ForecastFeed } from "./service.js";
import type { ForecastHorizonPreset } from "@workspace/domain/structural";

/** Compose existing deep-history and current-truth services; never mix sources. */
export function assembleForecastFeed(symbol: string, history: CandleHistoryResult, current: {
  candles: NormalizedChartCandle[]; source: string | null; aiUsable: boolean;
  quality: string; warning: string | null;
}, now: number, horizon: Pick<ForecastHorizonPreset, "timeframe" | "stepMs"> = { timeframe: "M1", stepMs: 60_000 }): ForecastFeed {
  const step = horizon.stepMs;
  const historical = normalizeCandles(history.candles, { symbol, displaySymbol: symbol,
    timeframe: horizon.timeframe, source: history.source, now, receivedAt: history.fetchedAt }).candles;
  const sameSource = history.ok && history.source != null && history.source === current.source;
  // The latest verified chart candle wins over a stale cache copy at the same time.
  const byTime = new Map(historical.map(b => [b.openTime, b]));
  if (sameSource) for (const b of current.candles) byTime.set(b.openTime, b);
  const ordered = [...byTime.values()].filter(b => b.isFinal && b.isComplete)
    .sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime)).slice(-FORECAST_HISTORY_BARS);
  // The model trains on windows of 180 consecutive bars and never bridges a
  // gap, so bars on both sides of a hole are kept: windows that cross it are
  // simply not used (fitWindowCount). The forecast itself needs the newest 120
  // bars unbroken; `closedBars` reports that newest run.
  let start = ordered.length ? ordered.length - 1 : 0;
  while (start > 0 && Date.parse(ordered[start]!.openTime) - Date.parse(ordered[start - 1]!.openTime) === step) start--;
  const closed = ordered.slice(start);
  const known = ordered.length > 0 && ordered.every(b => b.source === history.source
    && (b.sourceMode === "live" || b.sourceMode === "demo"));
  return { bars: ordered.map(b => ({ openTime: Date.parse(b.openTime), closeTime: Date.parse(b.closeTime),
    open: b.open, high: b.high, low: b.low, close: b.close, isFinal: b.isFinal })),
    origin: { symbol, provider: history.source ?? "unknown", fetchedAt: new Date(now).toISOString(),
      kind: "BROKER_HISTORY", historicalArrivalTimesKnown: false },
    ready: sameSource && known && current.aiUsable && current.quality === "clean",
    atiHistoricalSourceVerified: history.ok && history.source === "deriv_public" && known,
    // Refusals are stable codes: a free-text chart warning was masked by the
    // route as a generic failure, hiding why the forecast was withheld.
    reason: current.source == null && current.quality === "unavailable" ? "LIVE_CHART_UNAVAILABLE"
      : !sameSource ? "HISTORY_SOURCE_MISMATCH" : !known ? "UNKNOWN_DATA_PROVENANCE"
      : current.quality !== "clean" ? `LIVE_CHART_${String(current.quality).toUpperCase().replace(/[^A-Z]/g, "_")}`
      : !current.aiUsable ? "LIVE_CHART_NOT_AI_USABLE" : null,
    diagnostics: { historySource: history.source ?? null, historyBars: history.candles.length, chartSource: current.source,
      chartQuality: String(current.quality), chartAiUsable: current.aiUsable, closedBars: closed.length,
      barsBeforeLastGap: ordered.length - closed.length,
      lastCloseAgeSeconds: closed.length ? Math.round((now - Date.parse(closed.at(-1)!.closeTime)) / 1000) : null } };
}
