import { isOriginalPolygonEvidence, type OriginalCandleContext } from "../assistant/polygonFxCandles.js";
/** Original producer declaration, not a symbol-family guess or broker fill
 * attestation. Optional on legacy candles; never reconstructed from a cache. */
export interface CandlePriceBasisEvidence {
  kind: "producer_declared" | "unavailable";
  basis: "BID" | "MID" | "LAST" | "SYNTHETIC" | null;
  reason: string | null;
}
export const unavailableCandlePriceBasis = (
  reason: string,
): CandlePriceBasisEvidence => ({
  kind: "unavailable",
  basis: null,
  reason,
});
/** Authenticated MT5 candle-ingest boundary only. Existing wire declarations
 * are lower-case. ASK is intentionally unsupported by the chart basis enum. */
export function mt5PriceBasisEvidence(
  declaration: unknown,
): CandlePriceBasisEvidence {
  const basis =
    declaration === "bid"
      ? "BID"
      : declaration === "mid"
        ? "MID"
        : declaration === "last"
          ? "LAST"
          : null;
  return basis
    ? { kind: "producer_declared", basis, reason: null }
    : unavailableCandlePriceBasis(
        "The MT5 candle producer did not declare a supported original price basis; provider name and instrument family cannot establish it.",
      );
}
/** An evidence object may qualify only for the original serving producer. */
export function resolveCandlePriceBasisEvidence(
  evidence: unknown,
  source: string | null,
  context?: OriginalCandleContext,
): CandlePriceBasisEvidence {
  if(isOriginalPolygonEvidence(evidence,source,context,"price"))return {kind:"producer_declared",basis:"BID",reason:null};
  if (source !== "mt5_broker")
    return unavailableCandlePriceBasis(
      "This source has no qualified original producer price-basis declaration; any compatibility label is not evidence for historical execution modeling.",
    );
  if (evidence && typeof evidence === "object") {
    const e = evidence as Partial<CandlePriceBasisEvidence>;
    if (
      e.kind === "producer_declared" &&
      e.reason === null &&
      (e.basis === "BID" || e.basis === "MID" || e.basis === "LAST")
    )
      return { kind: "producer_declared", basis: e.basis, reason: null };
  }
  return unavailableCandlePriceBasis(
    "Original MT5 price-basis evidence is missing, inconsistent or unsupported; cached numeric OHLC cannot establish chart mode.",
  );
}
