import type { MarketCandlesResult, MarketQuoteResult } from "../../data/marketDataRouter.js";
import { normalizeCandles } from "../../data/chart/candleNormalization.js";
import { scannerSourceIdentity } from "../../scannerInputIntegrity.js";
import type { TruthReadEvidence } from "@workspace/domain/truth";
import { timeframeMs, type ChartTimeframe } from "../../data/chart/timeframes.js";

export const NOW = Date.now();
export function marketFixture(options: { now?: number; timeframe?: ChartTimeframe; source?: string; symbol?: string; count?: number; ageMs?: number; bridge?: number | null; forming?: boolean } = {}) {
  const { now = NOW, timeframe = "M15", source = "mt5_broker", symbol = "EURUSD", count = 80, ageMs = 0, bridge = null, forming = false } = options;
  const interval = timeframeMs(timeframe);
  const end = Math.floor(now / interval) * interval - ageMs;
  const result: MarketCandlesResult = {
    ok: true, symbol, assetClass: ["V50", "R_50"].includes(symbol) ? "synthetic" : "forex", primaryProvider: source, attempts: [], userMessage: "", adminDetail: "",
    candles: Array.from({ length: count + (forming ? 1 : 0) }, (_, i) => {
      const open = 1.09 + i * 0.0001;
      return { time: new Date(end - (count - i) * interval + (source.startsWith("assistant_real") ? interval : 0)).toISOString(), open, high: open + 0.0008, low: open - 0.0004, close: open + 0.0002, volume: 100 };
    }),
    provenance: { providerId: source.startsWith("assistant_real") ? "assistant_real" : source, subProviderId: source.startsWith("assistant_real:") ? source.split(":")[1]! : null, brokerCode: source === "mt5_broker" ? "mt5" : source.startsWith("deriv") ? "deriv" : "third_party", source: "DERIVED", sourceId: `${source}:${symbol}:${timeframe}`, bridgeConnectionId: bridge, userId: bridge == null ? null : 1, brokerSymbol: null, environment: "unknown", receivedAt: new Date(now).toISOString(), delayed: false },
  };
  const quote: MarketQuoteResult = { ...result, quote: { symbol, bid: 1.0979, ask: 1.0981, last: 1.098, spread: 0.0002, timestamp: new Date(now - ageMs).toISOString() }, tickTimeObserved: true, provenance: { ...result.provenance!, source: "LIVE_TICK", sourceId: `${source}:${symbol}` } };
  const evidence: TruthReadEvidence = { symbol, timeframe, source, sourceIdentity: scannerSourceIdentity(result), lastClosedCandleAt: new Date(end).toISOString() };
  const candles = normalizeCandles(result.candles, { symbol, displaySymbol: symbol, timeframe, source, now }).candles;
  const chart = { symbol, displaySymbol: symbol, timeframe, source, candles, marketEvidence: evidence, feedStatus: { symbol, source, isLive: ageMs === 0, stale: ageMs > 0, quality: ageMs === 0 ? "clean" : "stale", lastCandleTime: candles.at(-1)?.closeTime ?? null, lastTickTime: quote.quote?.timestamp ?? null } };
  return { result, quote, evidence, chart };
}
