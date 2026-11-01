import { isOriginalTwelveDataStockEvidence, TWELVE_DATA_STOCK_AUTHORITY } from "../assistant/twelveDataCandles.js";
import { isOriginalPolygonEvidence, POLYGON_FX_AUTHORITY, type OriginalCandleContext } from "../assistant/polygonFxCandles.js";
/** Original clock authority, separate from a syntactically valid ISO string.
 * A current broker offset, transport receipt time or appended Z is not a
 * historical UTC conversion. Only reviewed endpoint-specific original evidence may qualify UTC. */
export interface CandleTimeBasisEvidence {
  kind: "original_utc" | "unavailable";
  basis: "UTC" | "BROKER_SERVER" | null;
  authority: string | null;
  reason: string | null;
}
export function unavailableCandleTimeBasis(source: string | null): CandleTimeBasisEvidence {
  return {
    kind: "unavailable",
    basis: source === "mt5_broker" ? "BROKER_SERVER" : null,
    authority: null,
    reason: source === "mt5_broker"
      ? "MT5 history uses broker/source-clock coordinates. Historical UTC mapping is unverified; ISO Z labels and a current heartbeat offset do not establish it."
      : "The original candle clock has no qualified UTC authority. ISO formatting and provider names do not establish historical UTC mapping.",
  };
}
/** Only the audited endpoint can issue bar-bound runtime evidence. Raw claims,
 * JSON rehydration and provider names alone never qualify historical UTC. */
export function resolveCandleTimeBasisEvidence(evidence: unknown, source: string | null, context?: OriginalCandleContext): CandleTimeBasisEvidence {
  if(isOriginalPolygonEvidence(evidence,source,context,"time"))return {kind:"original_utc",basis:"UTC",authority:POLYGON_FX_AUTHORITY,reason:null};
  if(isOriginalTwelveDataStockEvidence(evidence,source,context,"time"))return {kind:"original_utc",basis:"UTC",authority:TWELVE_DATA_STOCK_AUTHORITY,reason:null};
  return unavailableCandleTimeBasis(source);
}
