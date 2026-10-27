import type { TruthReadEvidence } from "@workspace/domain/truth";
import { resolveArxMarket } from "@workspace/domain/market";
import type { MarketCandlesResult, MarketQuoteResult } from "../data/marketDataRouter.js";
import {
  prepareScannerCandles, scannerSourceIdentity, scannerQuoteFor, classifyScannerQuoteBinding,
  type ScannerQuoteBinding,
} from "../scannerInputIntegrity.js";
import { normalizeChartTimeframe, timeframeMs } from "../data/chart/timeframes.js";

/** Calculation freshness is bounded separately from the age of an observed bar.
 * This matches the polling UI's 30-second advice horizon; it is not a quote TTL. */
export const COMPONENT_BUILD_TTL_MS = 30_000;

export function prepareMarketRead(
  result: MarketCandlesResult, symbol: string, timeframe: string, now: number,
) {
  const prepared = prepareScannerCandles(result, symbol, timeframe, now);
  const canonical = resolveArxMarket(symbol)?.canonicalSymbol;
  const tf = normalizeChartTimeframe(timeframe);
  if (!prepared || !canonical || !tf || !result.primaryProvider || !result.provenance || result.provenance.delayed) return null;
  const last = prepared.openClosed.at(-1);
  if (!last) return null;
  const closeMs = Date.parse(last.time) + timeframeMs(tf);
  if (!Number.isFinite(closeMs) || closeMs > now) return null;
  const evidence: TruthReadEvidence = {
    symbol: canonical, timeframe: tf, source: result.primaryProvider,
    sourceIdentity: scannerSourceIdentity(result),
    lastClosedCandleAt: new Date(closeMs).toISOString(),
  };
  return { ...prepared, evidence };
}

export function isCurrentBuild(generatedAt: unknown, now: number): boolean {
  const at = typeof generatedAt === "string" ? Date.parse(generatedAt) : NaN;
  return Number.isFinite(at) && at <= now && now - at <= COMPONENT_BUILD_TTL_MS;
}

export function evidenceMatches(
  observed: TruthReadEvidence | null | undefined,
  expected: TruthReadEvidence | null | undefined,
  now: number,
  userId?: number,
): boolean {
  if (!observed || !expected || !Number.isFinite(now)) return false;
  if (userId != null && observed.userId !== userId) return false;
  const closeMs = Date.parse(observed.lastClosedCandleAt);
  const tf = normalizeChartTimeframe(observed.timeframe);
  if (!tf || now - closeMs >= timeframeMs(tf)) return false;
  return Number.isFinite(closeMs) && closeMs <= now &&
    observed.symbol === expected.symbol && observed.timeframe === expected.timeframe &&
    !!observed.source && observed.source === expected.source &&
    !!observed.sourceIdentity && observed.sourceIdentity === expected.sourceIdentity &&
    observed.lastClosedCandleAt === expected.lastClosedCandleAt;
}

/** Quotes are optional context, but a supplied price may never cross observed
 * venue/account/environment boundaries. Unknown attribution must match unknown,
 * rather than silently matching an attributed series. No spread is invented.
 * The quote's timestamp must be the producer-observed tick time: a receive-time
 * stamp (or an older result without the flag) cannot establish freshness. */
function sameAttribution(candles: MarketCandlesResult, quote: MarketQuoteResult): boolean {
  const cp = candles.provenance, qp = quote.provenance;
  if (!cp || !qp || quote.tickTimeObserved !== true) return false;
  for (const key of ["bridgeConnectionId", "userId", "brokerSymbol", "environment", "subProviderId"] as const) {
    if ((cp[key] ?? null) !== (qp[key] ?? null)) return false;
  }
  return true;
}

export function matchedMarketQuote(candles: MarketCandlesResult, quote: MarketQuoteResult, symbol: string, now: number) {
  if (!sameAttribution(candles, quote)) return null;
  return scannerQuoteFor(candles, quote, symbol, now);
}

/** The binding class behind `matchedMarketQuote` (same attribution checks):
 * BOUND exactly when `matchedMarketQuote` returns a quote; LAST_ONLY when a
 * fresh same-feed price exists but no bid/ask spread is observed. Reason-only —
 * it never yields a price. */
export function matchedMarketQuoteBinding(
  candles: MarketCandlesResult, quote: MarketQuoteResult, symbol: string, now: number,
): ScannerQuoteBinding {
  if (!sameAttribution(candles, quote)) return "NONE";
  return classifyScannerQuoteBinding(candles, quote, symbol, now).binding;
}
