// Legacy data-layer entry point — delegates to the unified
// `marketDataRouter` so all callers get asset-class-aware routing with a
// proper provider fallback chain and honest "no feed" only when the chain
// is exhausted. The previous MT5 → twelve_data_shim → alphaVantage →
// mock cascade is gone (the shim was always isConnected:false and
// nothing pushed ticks into mt5Provider, so every non-synthetic call
// fell silently to mock — that's the "no feed / simulator" symptom
// users reported).
//
// Existing callers (`/api/data`, `/api/watchlists`, `/api/multi-timeframe`)
// keep their function signatures.

import type { Candle, MarketQuote, SeriesProvenance } from "./types.js";
import { routeCandles, routeQuote, getRouterDiagnostics } from "./marketDataRouter.js";
import { isValidOhlc } from "./chart/candleNormalization.js";

export interface MarketDataWithProvenance {
  candles: Candle[];
  /**
   * Structured origin of the served series. `null` ONLY when no provider
   * served (honest empty) — a served series always names its source, and an
   * empty result never fabricates one. The envelope stays series-level: bars
   * in `candles` keep the bare legacy `Candle` shape.
   */
  provenance: SeriesProvenance | null;
}

/**
 * Envelope-preserving accessor (audit-marketdata S1): same OHLC-validated
 * candle array as `getMarketData`, WITHOUT discarding the router's provenance
 * envelope. Callers that must know which venue produced the bars (execution
 * previews, decision surfaces) opt in here.
 */
export async function getMarketDataWithProvenance(symbol: string, timeframe = "1m", limit = 250): Promise<MarketDataWithProvenance> {
  const r = await routeCandles(symbol, timeframe, limit);
  // OHLC integrity gate: never hand the raw `routeCandles().candles` reference
  // back to callers/legacy routes. Drop bars that fail the shared candle-truth
  // validity check (non-finite/negative values, high<low, body outside range)
  // and return a fresh, validated array. This is timeframe-agnostic on purpose
  // — the interval-dependent normalization (gap/staleness, bar-open alignment)
  // lives in `runCandleTruth` and is only safe with a canonical ChartTimeframe,
  // which this legacy accessor does not require of its callers.
  const candles = r.candles
    .filter((c) => isValidOhlc(c))
    .map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  return { candles, provenance: r.provenance ?? null };
}

// Legacy bare-array accessor — signature and returned shape must stay exactly
// as-is (routes/data, routes/watchlists, routes/multiTimeframe, routes/
// meAssistant, rubyChartContext, rubyQuality, historicalAnalysis all consume
// it). It shares the validated array with the envelope-preserving accessor so
// the two paths can never drift.
export async function getMarketData(symbol: string, timeframe = "1m", limit = 250): Promise<Candle[]> {
  return (await getMarketDataWithProvenance(symbol, timeframe, limit)).candles;
}

/** A routed quote plus what its timestamp means and who served it. */
export type LatestQuote = MarketQuote & {
  /**
   * True only when `timestamp` is the producer's own tick time (the router's
   * tickTimeObserved). False when it is a receive-time stamp or its origin is
   * unknown, so a caller must not treat it as the market tick time.
   */
  tickTimeObserved: boolean;
  /** Provider that served the quote, or null when not reported. */
  source: string | null;
};

/**
 * The routed quote, or null when no provider served one. A failed lookup never
 * comes back stamped with the current time (that read as an observation made
 * "now"). Callers judge the quote's age with quoteObservationFreshness.
 */
export async function getLatestQuote(symbol: string): Promise<LatestQuote | null> {
  const r = await routeQuote(symbol);
  if (!r.ok || !r.quote) return null;
  return {
    ...r.quote,
    tickTimeObserved: r.tickTimeObserved === true,
    source: r.provenance?.providerId ?? r.primaryProvider ?? null,
  };
}

export async function getProviderStatus() {
  const snap = getRouterDiagnostics();
  return snap.providers.map((p) => ({
    name: p.id,
    connected: p.connected,
    active: p.connected,
  }));
}
