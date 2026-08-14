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

  const hasBrokerData = brokerBid != null && brokerAsk != null;
  const hasChartPrice = chartPrice != null && chartPrice > 0;

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
      userMessage: "Broker quote not yet available for this symbol.",
      adminDetail: "Broker bid/ask not enumerated in arx_symbol_specs for this user — alignment check skipped.",
      brokerDataAvailable: false,
    };
  }

  const brokerMid = (brokerBid! + brokerAsk!) / 2;

  // Compute deviation: chart price vs broker mid.
  // For BID-basis charts we compare against brokerBid; for others against brokerMid.
  const referencePrice =
    chartPriceBasis === "BID" ? brokerBid! : brokerMid;
  const deviation = Math.abs(chartPrice - referencePrice);
  const deviationPct = referencePrice > 0 ? deviation / referencePrice : 0;

  const tolerances = tolerancesFor(assetClass);
  const tolerance = classifyDeviation(deviationPct, tolerances);
  const aligned = tolerance === "tight" || tolerance === "normal";

  const deviationPctDisplay = (deviationPct * 100).toFixed(4);
  const adminDetail =
    `chartPrice=${chartPrice} (${chartPriceBasis}); brokerBid=${brokerBid}; brokerAsk=${brokerAsk}; `
    + `brokerMid=${brokerMid.toFixed(5)}; deviation=${deviationPctDisplay}%; spread=${spreadPoints ?? "N/A"}pts; tolerance=${tolerance}.`;

  const userMessage = aligned
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
  };
}

/**
 * Honest "Mirror …" segment for a chart trust line.
 *
 * Reflects the REAL broker-alignment granularity rather than the binary
 * `tradeConfirmationAllowed` gate alone, so a read-chart surface never claims
 * the chart price is synced with the broker when it is only drifting or cannot
 * be verified at all:
 *   - `tradeConfirmationAllowed === false` (merge-seam OR alignment "failed")
 *       → "Mirror degraded"  (composes seam AND alignment state)
 *   - aligned (tight/normal) with broker data → "Mirror synced"
 *   - wide drift                             → "Mirror drifting"
 *   - unknown / no broker quote              → null (NO alignment claim)
 *
 * Honesty invariant: NEVER returns "Mirror synced" unless `aligned === true`
 * AND `brokerDataAvailable === true`. Display-copy only — never an execution
 * gate, never weakens the 16-gate live pipeline.
 */
export function mirrorTrustSegment(
  tradeConfirmationAllowed: boolean,
  alignment: Pick<BrokerPriceAlignment, "aligned" | "tolerance" | "brokerDataAvailable">,
): string | null {
  // Seam failure or alignment failure already collapsed tradeConfirmationAllowed
  // to false — surface that as degraded regardless of the raw tolerance band.
  if (!tradeConfirmationAllowed) return "Mirror degraded";
  // tradeConfirmationAllowed === true ⇒ seam clean AND tolerance !== "failed".
  if (!alignment.brokerDataAvailable) return null; // unknown → make no claim
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
  };
}
