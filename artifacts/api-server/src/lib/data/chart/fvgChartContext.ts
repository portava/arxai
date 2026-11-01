import { resolveArxMarket } from "@workspace/domain/market";
import type { TruthReadEvidence } from "@workspace/domain/truth";
import { getChartCandles } from "./chartDataService.js";
import { capturedAnalysisCandles } from "./capturedAnalysisCandles.js";

/** Separate qualified observations for the existing FVG child. A primary FULL
 * read cannot qualify another interval or source. No new freshness policy or
 * execution permission is introduced; use the normalized feed verdicts. */
export async function captureFvgChartInputs(
  symbol: string,
  primary: Pick<TruthReadEvidence, "symbol" | "source" | "venueIdentity"> | null,
  load: typeof getChartCandles = getChartCandles,
) {
  primary = primary ? { ...primary } : null;
  const canonical = resolveArxMarket(symbol)?.canonicalSymbol;
  const required = ["H4", "H1", "M5"] as const;
  const observations = await Promise.allSettled(required.map(async tf =>
    structuredClone(await load(symbol, tf, tf === "M5" ? 100 : 220)),
  ));
  const staleTimeframes: string[] = [];
  const unconfirmedTimeframes: string[] = [];
  const candles = observations.map((observation, i) => {
    const tf = required[i];
    if (observation.status !== "fulfilled") {
      unconfirmedTimeframes.push(tf);
      return [];
    }
    const response = observation.value;
    const evidence = response.marketEvidence;
    const closed = response.candles.filter(c => c.isComplete === true && !c.isForming);
    if (response.feedStatus?.stale === true) staleTimeframes.push(tf);
    if (response.aiUsable !== true || response.feedStatus?.aiUsable !== true
      || response.feedStatus?.stale !== false
      || response.symbol !== symbol || response.timeframe !== tf
      || closed.some(c => c.timeBasisEvidence?.kind !== "original_utc"
        || c.timeBasisEvidence.basis !== "UTC" || !c.timeBasisEvidence.authority
        || c.timeBasisEvidence.reason != null)
      || !canonical || !primary || primary.symbol !== canonical
      || !evidence || evidence.symbol !== canonical || evidence.timeframe !== tf
      || !evidence.venueIdentity || evidence.venueIdentity !== primary.venueIdentity
      || !evidence.source || evidence.source !== primary.source
      || evidence.source !== response.source || evidence.source !== response.feedStatus?.source
      || evidence.lastClosedCandleAt !== closed.at(-1)?.closeTime) {
      unconfirmedTimeframes.push(tf);
    }
    // Retain closed history counts for honest missing-vs-unconfirmed diagnostics.
    // The engine refuses analysis whenever any interval is unconfirmed or stale.
    return capturedAnalysisCandles(closed);
  });
  return { h4Candles: candles[0], h1Candles: candles[1], m5Candles: candles[2], staleTimeframes, unconfirmedTimeframes };
}
