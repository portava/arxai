// Phase 3 — Broker / chart price alignment.
//
// Computes whether the chart's latest candle close is aligned with the MT5
// broker's reported bid/ask for the same symbol. Misalignment beyond tolerance
// indicates either: the chart is using a different price basis (MID vs BID),
// a data-feed lag, or a symbol-casing mismatch. It feeds the SymbolMirrorAccuracy
// sub-metric of the Chart Truth Score.
//
// USER-FACING: "Syncing with broker..." (never surfaced raw deviation numbers).
// ADMIN-FACING: full diagnostic with bid/ask/deviation/spread.
//
// Tolerance bands (pct deviation of chartPrice from brokerMid):
//   forex/metals: <0.05% tight, <0.20% normal, <0.80% wide, ≥0.80% failed
//   synthetics:   <0.10% tight, <0.50% normal, <2.00% wide, ≥2.00% failed
//   other:        <0.10% tight, <0.50% normal, <2.00% wide, ≥2.00% failed
//
// SAFETY: read-only. Never touches any execution gate or trade path.

import type { AssetClass } from "../marketDataRouter.js";
import { isBoundBrokerQuote, type BrokerQuoteBinding } from "./brokerQuoteBinding.js";

export type AlignmentTolerance = "tight" | "normal" | "wide" | "failed" | "unknown";

export interface BrokerPriceAlignment {
  /** True when broker data was available and deviation is within normal tolerance. */
  aligned: boolean;
  tolerance: AlignmentTolerance;
  /** Last candle close used as the chart price reference. */
  chartPrice: number | null;
  brokerBid: number | null;
  brokerAsk: number | null;
  brokerMid: number | null;
  /** Broker-reported spread in points, or null when unavailable. */
  spreadPoints: number | null;
  /** Absolute pct deviation of chartPrice from brokerMid, or null when unknown. */
  deviationPct: number | null;
  /** Price basis the chart is using (BID / MID / LAST / SYNTHETIC / UNKNOWN). */
  chartPriceBasis: string;
  /**
   * User-safe message. Never contains raw deviation numbers or internal gate names.
   */
  userMessage: string;
  /**
   * Admin-only diagnostic. Contains bid/ask/deviation/spread — never shown to
   * end users. Null when broker data is unavailable.
   */
  adminDetail: string | null;
  /** True when broker bid/ask was actually available from the symbol directory. */
  brokerDataAvailable: boolean;
  /**
   * Additive: whether the compared quote is bound to the chart series
   * (provider/bridge/owner identity and an observed tick time within the
   * freshness budget). Only a BOUND comparison can earn chart-Truth points or
   * claim alignment; null/absent = no binding evaluated (unmeasured).
   */
  quoteBinding?: BrokerQuoteBinding | null;
}

export interface BrokerAlignmentInputs {
  /** Last closed candle close price. Null if no candles. */
  chartPrice: number | null;
  /** Price basis the chart candles use. */
  chartPriceBasis: string;
  /** Asset class of the symbol. */
  assetClass: AssetClass;
  /** Broker bid from arx_symbol_specs (null if not enumerated). */
  brokerBid: number | null;
  /** Broker ask from arx_symbol_specs (null if not enumerated). */
  brokerAsk: number | null;
  /** Broker-reported spread in points (null if not available). */
  spreadPoints: number | null;
  /** Identity/freshness binding of this quote to the chart series. Omitted =
   *  not evaluated: the numbers are compared but cannot be claimed aligned. */
  quoteBinding?: BrokerQuoteBinding | null;
}

interface Tolerances {
  tight: number;
  normal: number;
  wide: number;
}

function tolerancesFor(assetClass: AssetClass): Tolerances {
  if (assetClass === "forex" || assetClass === "metals") {
    return { tight: 0.0005, normal: 0.002, wide: 0.008 };
  }
  return { tight: 0.001, normal: 0.005, wide: 0.02 };
}

function classifyDeviation(deviationPct: number, tolerances: Tolerances): AlignmentTolerance {
  if (deviationPct < tolerances.tight) return "tight";
  if (deviationPct < tolerances.normal) return "normal";
  if (deviationPct < tolerances.wide) return "wide";
  return "failed";
}

/**
 * Compute broker price alignment from chart candle data and broker tick data.
 * All inputs are optional — the result is honest when data is missing.
 */
export function computeBrokerPriceAlignment(inputs: BrokerAlignmentInputs): BrokerPriceAlignment {
  const { chartPrice, chartPriceBasis, assetClass, brokerBid, brokerAsk, spreadPoints } = inputs;
  const quoteBinding = inputs.quoteBinding ?? null;
  const bound = isBoundBrokerQuote(quoteBinding);

  const hasBrokerData = brokerBid != null && brokerAsk != null &&
    Number.isFinite(brokerBid) && Number.isFinite(brokerAsk) && brokerBid > 0 && brokerAsk >= brokerBid;
  const hasChartPrice = chartPrice != null && Number.isFinite(chartPrice) && chartPrice > 0;

  if (!hasChartPrice) {
    return {
      // aligned=false: no price to compare — status unknown, not "aligned".
      // Downstream consumers must check brokerDataAvailable before trusting aligned.
      aligned: false,
      tolerance: "unknown",
      chartPrice: null,
      brokerBid: null,
      brokerAsk: null,
      brokerMid: null,
      spreadPoints: null,
      deviationPct: null,
      chartPriceBasis,
      userMessage: "No chart price available — waiting for feed.",
      adminDetail: null,
      brokerDataAvailable: false,
      quoteBinding,
    };
  }

  if (!hasBrokerData) {
    return {
      // aligned=false: broker quote not available — alignment unknown, not "aligned".
      // Downstream consumers must check brokerDataAvailable before trusting aligned.
      // Gates that block on alignment failure already check brokerDataAvailable first.
      aligned: false,
      tolerance: "unknown",
      chartPrice,
      brokerBid: null,
      brokerAsk: null,
      brokerMid: null,
      spreadPoints: null,
      deviationPct: null,
      chartPriceBasis,
      userMessage: "A usable broker quote is not available for this symbol.",
      adminDetail: "Broker comparison requires finite positive bid/ask with ask at least bid — alignment unmeasured.",
      brokerDataAvailable: false,
      quoteBinding,
    };
  }

  const brokerMid = brokerBid! + (brokerAsk! - brokerBid!) / 2;

  // Compute deviation: chart price vs broker mid.
  // For BID-basis charts we compare against brokerBid; for others against brokerMid.
  const referencePrice =
    chartPriceBasis === "BID" ? brokerBid! : brokerMid;
  const deviation = Math.abs(chartPrice - referencePrice);
  const deviationPct = deviation / referencePrice;
  if (!Number.isFinite(deviationPct)) return { ...noBrokerAlignment(chartPrice, chartPriceBasis), quoteBinding };

  const tolerances = tolerancesFor(assetClass);
  const tolerance = classifyDeviation(deviationPct, tolerances);
  // An unbound quote's numbers are still compared (an observed "failed"
  // deviation keeps blocking trade confirmation exactly as before), but they
  // cannot establish that the chart is aligned with this account's broker.
  const aligned = bound && (tolerance === "tight" || tolerance === "normal");

  const deviationPctDisplay = (deviationPct * 100).toFixed(4);
  const bindingDetail = quoteBinding
    ? ` quoteBinding=${quoteBinding.status}${quoteBinding.reasons.length ? `(${quoteBinding.reasons.join(",")})` : ""}.`
    : " quoteBinding=not evaluated.";
  const adminDetail =
    `chartPrice=${chartPrice} (${chartPriceBasis}); brokerBid=${brokerBid}; brokerAsk=${brokerAsk}; `
    + `brokerMid=${brokerMid.toFixed(5)}; deviation=${deviationPctDisplay}%; spread=${spreadPoints ?? "N/A"}pts; tolerance=${tolerance}.`
    + bindingDetail;

  const userMessage = !bound
    ? (quoteBinding?.status === "MISMATCH"
      ? "Broker quote belongs to a different feed or account than this chart — alignment not confirmed."
      : quoteBinding?.status === "STALE"
        ? "Broker quote is not current — alignment not confirmed."
        : "Broker quote identity or tick time is unverified — alignment not confirmed.")
    : aligned
      ? "Chart price aligned with broker quote."
      : tolerance === "wide"
        ? "Chart is syncing with the broker — minor delay expected."
        : "Chart price is syncing with broker — please wait.";

  return {
    aligned,
    tolerance,
    chartPrice,
    brokerBid,
    brokerAsk,
    brokerMid,
    spreadPoints,
    deviationPct: parseFloat(deviationPct.toFixed(6)),
    chartPriceBasis,
    userMessage,
    adminDetail,
    brokerDataAvailable: true,
    quoteBinding,
  };
}

/** A cached/type-cast object cannot establish alignment from flags alone.
 *  The compared quote must also be bound to the chart series' identity with
 *  an observed tick time inside the freshness budget. */
export function hasMeasuredBrokerAlignment(alignment: BrokerPriceAlignment | undefined): boolean {
  if (!alignment || alignment.brokerDataAvailable !== true || !isBoundBrokerQuote(alignment.quoteBinding) ||
      !["tight", "normal", "wide", "failed"].includes(alignment.tolerance)) return false;
  const { chartPrice, brokerBid, brokerAsk, brokerMid, deviationPct } = alignment;
  return [chartPrice, brokerBid, brokerAsk, brokerMid].every(value => value != null && Number.isFinite(value) && value > 0) &&
    brokerAsk! >= brokerBid! && deviationPct != null && Number.isFinite(deviationPct) && deviationPct >= 0;
}

/**
 * Honest "Mirror …" segment for a chart trust line.
 *
 * Reflects the REAL broker-alignment granularity rather than the binary
 * `tradeConfirmationAllowed` gate alone, so a read-chart surface never claims
 * the chart price is synced with the broker when it is only drifting or cannot
 * be verified at all:
 *   - `tradeConfirmationAllowed === false` because neither the seam nor a
 *       bound broker comparison could be checked (`cause.notChecked`)
 *       → "Mirror not checked"  (absence is never called a failure)
 *   - `tradeConfirmationAllowed === false` (merge-seam OR alignment "failed")
 *       → "Mirror degraded"  (composes seam AND alignment state)
 *   - aligned (tight/normal) with broker data → "Mirror synced"
 *   - wide drift                             → "Mirror drifting"
 *   - unknown / no broker quote              → null (NO alignment claim)
 *
 * Honesty invariant: NEVER returns "Mirror synced" unless `aligned === true`
 * AND `brokerDataAvailable === true` AND the quote binding is BOUND. Display-copy only — never an execution
 * gate, never weakens the 16-gate live pipeline.
 */
export function mirrorTrustSegment(
  tradeConfirmationAllowed: boolean,
  alignment: Pick<BrokerPriceAlignment, "aligned" | "tolerance" | "brokerDataAvailable" | "quoteBinding">,
  cause?: { seamFailed: boolean; notChecked: boolean },
): string | null {
  // Nothing observed: the gate is closed for lack of evidence, not a failure.
  if (!tradeConfirmationAllowed && cause?.notChecked) return "Mirror not checked";
  // Seam failure or alignment failure already collapsed tradeConfirmationAllowed
  // to false — surface that as degraded regardless of the raw tolerance band.
  if (!tradeConfirmationAllowed) return "Mirror degraded";
  // tradeConfirmationAllowed === true ⇒ seam clean AND tolerance !== "failed".
  if (!alignment.brokerDataAvailable) return null; // unknown → make no claim
  // A quote not bound to this series' identity/freshness proves nothing.
  if (!isBoundBrokerQuote(alignment.quoteBinding)) return null;
  if (alignment.aligned) return "Mirror synced"; // tight / normal
  return "Mirror drifting"; // wide
}

/**
 * Returns an honest alignment result when no broker data source is available
 * (e.g. no MT5 bridge connected for this user).
 */
export function noBrokerAlignment(chartPrice: number | null, chartPriceBasis: string): BrokerPriceAlignment {
  return {
    // aligned=false: no broker connection — status unknown, not "aligned".
    // Consumers must check brokerDataAvailable before trusting aligned.
    aligned: false,
    tolerance: "unknown",
    chartPrice,
    brokerBid: null,
    brokerAsk: null,
    brokerMid: null,
    spreadPoints: null,
    deviationPct: null,
    chartPriceBasis,
    userMessage: "Broker quote not connected.",
    adminDetail: "No MT5 bridge connection for this user — broker alignment unavailable.",
    brokerDataAvailable: false,
    quoteBinding: null,
  };
}
