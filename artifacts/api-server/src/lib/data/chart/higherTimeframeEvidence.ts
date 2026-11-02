import { resolveArxMarket } from "@workspace/domain/market";
import type { TruthReadEvidence } from "@workspace/domain/truth";
import type { ChartCandlesResponse } from "./chartDataService.js";
import { closedAnalysisWindowIdentity } from "./capturedAnalysisCandles.js";

/** Qualify a separately captured interval before it can influence primary-chart
 * bias. Matching provenance is not an atomic capture or execution permission. */
export function higherTimeframeMatchesPrimary(
  symbol: string,
  timeframe: string | null,
  primary: TruthReadEvidence | null,
  higher: ChartCandlesResponse | null,
): boolean {
  const canonical = resolveArxMarket(symbol)?.canonicalSymbol;
  const evidence = higher?.marketEvidence;
  if (!canonical || !timeframe || !primary || primary.symbol !== canonical
    || !higher || !evidence || higher.aiUsable !== true
    || higher.feedStatus.aiUsable !== true || higher.feedStatus.stale !== false
    || resolveArxMarket(higher.symbol)?.canonicalSymbol !== canonical || higher.timeframe !== timeframe
    || evidence.symbol !== canonical || evidence.timeframe !== timeframe
    || !primary.venueIdentity || evidence.venueIdentity !== primary.venueIdentity
    || !primary.source || evidence.source !== primary.source
    || higher.source !== evidence.source || higher.feedStatus.source !== evidence.source) return false;

  const closed = higher.candles.filter(c => c.isComplete === true && !c.isForming);
  if (!closed.length || closed.some(c => resolveArxMarket(c.symbol)?.canonicalSymbol !== canonical
    || c.timeframe !== timeframe || c.timeBasisEvidence?.kind !== "original_utc"
    || c.timeBasisEvidence.basis !== "UTC" || !c.timeBasisEvidence.authority
    || c.timeBasisEvidence.reason != null)
    || evidence.lastClosedCandleAt !== closed.at(-1)?.closeTime) return false;
  const identity = closedAnalysisWindowIdentity(closed);
  return identity !== null && identity === evidence.closedWindowIdentity;
}
