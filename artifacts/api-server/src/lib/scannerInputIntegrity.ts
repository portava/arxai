import { createHash } from "node:crypto";
import { resolveArxMarket } from "@workspace/domain/market";
import type { MarketCandlesResult, MarketQuoteResult } from "./data/marketDataRouter.js";
import type { Candle } from "./data/types.js";
import { normalizeCandles, sourceModeFromProvider } from "./data/chart/candleNormalization.js";
import { normalizeChartTimeframe, timeframeMs } from "./data/chart/timeframes.js";
import { classifyQuoteFreshness } from "./data/freshness.js";

// Symbol properties survive object-spread decorators, while JSON.stringify
// omits them. The value is an opaque digest, never raw account/bridge IDs.
const sourceBinding: unique symbol = Symbol("scannerSourceBinding");
type SourceBound = { [sourceBinding]?: string };

export function scannerSourceIdentity(result: Pick<MarketCandlesResult, "primaryProvider" | "provenance">): string {
  const p = result.provenance;
  return createHash("sha256").update(JSON.stringify([result.primaryProvider,
    p?.providerId ?? null, p?.subProviderId ?? null, p?.sourceId ?? null,
    p?.bridgeConnectionId ?? null, p?.userId ?? null, p?.environment ?? "unknown", p?.brokerSymbol ?? null,
  ])).digest("hex");
}

export function bindScannerSource<T extends object>(row: T, identity: string): T {
  Object.defineProperty(row, sourceBinding, { value: identity, enumerable: true });
  return row;
}

export function scannerRowSourceIdentity(row: object): string | null {
  return (row as SourceBound)[sourceBinding] ?? null;
}

function sameSymbol(a: string, b: string): boolean {
  const left = resolveArxMarket(a)?.canonicalSymbol;
  return !!left && left === resolveArxMarket(b)?.canonicalSymbol;
}

/** Use the chart's provider-specific open/close convention. No bar is invented
 * or repaired. Invalid/conflicting bars refuse the whole read; forming bars
 * are excluded before sufficiency, regime, features or scoring can see them. */
export function prepareScannerCandles(
  result: MarketCandlesResult, symbol: string, timeframe: string, now: number,
): { rawClosed: Candle[]; openClosed: Candle[]; trailingIntervals: number | null } | null {
  const tf = normalizeChartTimeframe(timeframe);
  const source = result.primaryProvider;
  if (!Number.isFinite(now) || !tf || !result.ok || !sameSymbol(result.symbol, symbol) || !source) return null;
  if (!["live", "demo"].includes(sourceModeFromProvider(source))) return null;
  const provenance = result.provenance;
  if (provenance && (provenance.providerId !== (source.startsWith("assistant_real:") ? "assistant_real" : source) || provenance.source !== "DERIVED" ||
      provenance.sourceId !== `${source}:${symbol.trim().toUpperCase()}:${tf}`)) return null;
  const seen = new Map<string, Candle>();
  for (const candle of result.candles) {
    if (![candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)) return null;
    const key = String(Date.parse(candle.time));
    const prior = seen.get(key);
    if (prior && ["open", "high", "low", "close", "volume"].some((field) =>
      prior[field as keyof Candle] !== candle[field as keyof Candle])) return null;
    seen.set(key, candle);
  }
  const normalized = normalizeCandles(result.candles, {
    symbol, displaySymbol: symbol, timeframe: tf, source, now,
  });
  if (normalized.anomalies.invalidOhlcCount > 0) return null;
  let closed = normalized.candles.filter((bar) => bar.isComplete && !bar.isForming);
  const interval = timeframeMs(tf);
  let lastGap = -1;
  for (let i = 1; i < closed.length; i++) {
    const gap = Date.parse(closed[i]!.openTime) - Date.parse(closed[i - 1]!.openTime);
    // A denser series cannot be relabeled as this requested timeframe.
    if (gap < interval * 0.95) return null;
    if (gap > interval * 1.5) lastGap = i;
  }
  // On continuously traded markets a missing bar breaks the analysis window.
  // Session instruments can have genuine overnight/weekend gaps; without an
  // authoritative calendar this layer must not fabricate or bridge new bars.
  if ((result.assetClass === "synthetic" || result.assetClass === "crypto") && lastGap >= 0) {
    closed = closed.slice(lastGap);
  }
  const toCandle = (bar: (typeof closed)[number], time: string): Candle => ({
    time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
  });
  return {
    rawClosed: closed.map((bar) => toCandle(bar, source.startsWith("assistant_real") ? bar.closeTime : bar.openTime)),
    openClosed: closed.map((bar) => toCandle(bar, bar.openTime)),
    // Anchor to the actual accepted provider bar, including session opens such
    // as :30. UTC flooring can falsely age an H1 bar before its next bar closes.
    // A newly closed bar trails by one interval under the shared freshness
    // policy. Forming/future/invalid tails never contribute to this measure.
    trailingIntervals: closed.length ? Math.floor((now - Date.parse(closed[closed.length - 1]!.openTime)) / interval) : null,
  };
}

/** A live quote must belong to the same feed and instrument as the bars.
 * An independent router fallback must never silently price a different venue's
 * setup. Unknown quote facts produce no usable quote, not a zero-spread fill. */
export function scannerQuoteFor(
  candles: MarketCandlesResult, quote: MarketQuoteResult, symbol: string, now: number,
): { mid: number; spread: number | null } | null {
  const q = quote.quote;
  if (!quote.ok || !q || !sameSymbol(quote.symbol, symbol) || !sameSymbol(q.symbol, symbol) ||
      !candles.primaryProvider || candles.primaryProvider !== quote.primaryProvider) return null;
  if (!classifyQuoteFreshness(now - Date.parse(q.timestamp)).fresh) return null;
  const cp = candles.provenance, qp = quote.provenance;
  if (cp?.delayed === true || qp?.delayed === true) return null;
  if (qp && (qp.source !== "LIVE_TICK" || qp.sourceId !== `${quote.primaryProvider}:${symbol.trim().toUpperCase()}` ||
      qp.providerId !== (quote.primaryProvider?.startsWith("assistant_real:") ? "assistant_real" : quote.primaryProvider))) return null;
  if (cp && qp) {
    for (const key of ["bridgeConnectionId", "userId", "brokerSymbol", "environment"] as const) {
      if (cp[key] != null && qp[key] != null && cp[key] !== "unknown" && qp[key] !== "unknown" && cp[key] !== qp[key]) return null;
    }
  }
  if (q.bid != null && q.ask != null && (!Number.isFinite(q.bid) || !Number.isFinite(q.ask) || q.bid <= 0 || q.ask < q.bid)) return null;
  const mid = q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : q.last;
  if (mid == null || !Number.isFinite(mid) || mid <= 0) return null;
  const observedSpread = q.bid != null && q.ask != null ? q.ask - q.bid : q.spread;
  const spread = observedSpread != null && Number.isFinite(observedSpread) && observedSpread > 0 ? observedSpread : null;
  if (spread == null) return null;
  return { mid, spread };
}
