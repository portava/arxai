// Phase 3 — Chart Truth Score engine.
//
// Computes a weighted 0–100 score answering "is the data real, fresh, synced,
// correctly mapped/timed/mirrored/rendered?" from real Phase 1 / Phase 2
// signals. Missing evidence has a null sub-score and earns no aggregate
// points. Weights are never redistributed to hide an unmeasured dimension.
//
// Weights (must sum to 1.0):
//   OHLCIntegrity            0.20  — bad OHLC bars, duplicates, out-of-order
//   SourceAuthenticity       0.15  — mock detection, real-OHLC flag, sourceMode
//   TimeframeAccuracy        0.13  — history minimum, assessment
//   SymbolMirrorAccuracy     0.12  — seam overlap/gap, broker-symbol match
//   HistoricalLiveMergeQuality 0.10 — merge seam quality (gap intervals)
//   FeedFreshness            0.09  — stale, quality, trailing gap
//   PricePrecision           0.08  — precision violations
//   RenderAccuracy           0.07  — unavailable until observed in the renderer
//   ScaleQuality             0.04  — unavailable until observed in the renderer
//   InteractionStability     0.02  — unavailable until interactions are measured
//
// Score labels:
//   95–100  Verified
//   85–94   Healthy
//   75–84   Usable-but-watch
//   60–74   Degraded
//   <60     Read-blocked

import { clamp, round } from "./engines/chartMath.js";
import type { TimeframeTruthResult } from "./candleTruthEngine.js";
import type { ChartFeedStatus } from "./chartDataService.js";
import { hasMeasuredBrokerAlignment, type BrokerPriceAlignment } from "./brokerPriceAlignment.js";

export type ChartTruthLabel =
  | "Verified"
  | "Healthy"
  | "Usable-but-watch"
  | "Degraded"
  | "Read-blocked";

export interface ChartTruthSubMetric {
  key: string;
  label: string;
  weight: number;
  rawScore: number | null;
  weightedScore: number | null;
  evidenceStatus: "measured" | "unavailable";
  detail: string;
}

export interface ChartTruthScore {
  score: number;
  label: ChartTruthLabel;
  subMetrics: ChartTruthSubMetric[];
  /** Fraction of the fixed total weight supported by measured evidence. */
  evidenceCoverage: number;
  unmeasuredKeys: string[];
  primaryConcern: string | null;
  note: string;
}

function labelFor(score: number): ChartTruthLabel {
  if (score >= 95) return "Verified";
  if (score >= 85) return "Healthy";
  if (score >= 75) return "Usable-but-watch";
  if (score >= 60) return "Degraded";
  return "Read-blocked";
}

function sub(
  key: string,
  label: string,
  weight: number,
  rawScore: number | null,
  detail: string,
): ChartTruthSubMetric {
  const clamped = rawScore != null && Number.isFinite(rawScore) ? clamp(rawScore, 0, 100) : null;
  return {
    key,
    label,
    weight,
    rawScore: clamped == null ? null : round(clamped),
    weightedScore: clamped == null ? null : round(clamped * weight),
    evidenceStatus: clamped == null ? "unavailable" : "measured",
    detail,
  };
}

function aggregate(subMetrics: ChartTruthSubMetric[]): ChartTruthScore {
  const score = round(subMetrics.reduce((sum, metric) => sum + (metric.weightedScore ?? 0), 0));
  const evidenceCoverage = round(subMetrics.reduce((sum, metric) => sum +
    (metric.evidenceStatus === "measured" ? metric.weight : 0), 0), 4);
  const unmeasured = subMetrics.filter(metric => metric.evidenceStatus === "unavailable");
  const worst = subMetrics.filter(metric => metric.rawScore != null && metric.rawScore < 90)
    .sort((a, b) => b.weight * (100 - b.rawScore!) - a.weight * (100 - a.rawScore!))[0];
  const primaryConcern = worst?.detail ?? (unmeasured.length
    ? `Not measured: ${unmeasured.map(metric => metric.label).join(", ")}.` : null);
  const label = labelFor(score);
  return { score, label, subMetrics, evidenceCoverage, unmeasuredKeys: unmeasured.map(metric => metric.key), primaryConcern,
    note: `Chart evidence score ${score} (${label}); ${round(evidenceCoverage * 100)}% of weighted checks measured. ` +
      (unmeasured.length ? "Unmeasured checks earn no points; this is incomplete verification. " : "") +
      (primaryConcern ?? "All measured checks healthy.") };
}

/**
 * Compute the Chart Truth Score from Phase 1 truth result + feed status.
 *
 * @param alignment - Optional broker price alignment. When supplied,
 *   `brokerDataAvailable === true` AND its quote binding is BOUND (same
 *   provider/bridge/owner as the series, observed fresh tick), the broker
 *   deviation is folded into the SymbolMirrorAccuracy sub-metric so real
 *   mis-sync degrades the score. An unbound comparison stays unmeasured.
 *   Pass `undefined` or `noBrokerAlignment(...)` when no per-user broker
 *   data is available (broker mirror accuracy is then unmeasured).
 *
 * When truthResult is null (no candles returned), returns the minimum honest score.
 */
export function computeChartTruthScore(
  truthResult: TimeframeTruthResult | null,
  feedStatus: ChartFeedStatus,
  alignment?: BrokerPriceAlignment,
): ChartTruthScore {
  const subMetrics: ChartTruthSubMetric[] = [];

  if (!truthResult || !Number.isFinite(truthResult.candleCount) || truthResult.candleCount <= 0) {
    const floor = sub(
      "ohlc_integrity",
      "OHLC Integrity",
      0.20,
      null,
      "No candles returned — feed unavailable.",
    );
    const rest: ChartTruthSubMetric[] = [
      sub("source_authenticity", "Source Authenticity", 0.15, null, "No feed data."),
      sub("timeframe_accuracy", "Timeframe Accuracy", 0.13, null, "No feed data."),
      sub("symbol_mirror_accuracy", "Symbol Mirror Accuracy", 0.12, null, "No feed data."),
      sub("historical_live_merge", "Historical/Live Merge Quality", 0.10, null, "No feed data."),
      sub("feed_freshness", "Feed Freshness", 0.09, 0, "No feed data."),
      sub("price_precision", "Price Precision", 0.08, null, "No feed data."),
      sub("render_accuracy", "Render Accuracy", 0.07, null, "Renderer measurements unavailable."),
      sub("scale_quality", "Scale Quality", 0.04, null, "Scale measurements unavailable."),
      sub("interaction_stability", "Interaction Stability", 0.02, null, "Interaction measurements unavailable."),
    ];
    const all = [floor, ...rest];
    return aggregate(all);
  }

  const n = truthResult.candleCount;

  // ── 1. OHLC Integrity (0.20) ──────────────────────────────────────────────
  // Perfect = 0 bad bars. Each class of anomaly penalises proportionally.
  const invalidRate = n > 0 ? truthResult.invalidOhlcCount / n : 1;
  const dupRate = n > 0 ? truthResult.duplicateCount / n : 0;
  const oooRate = n > 0 ? truthResult.outOfOrderCount / n : 0;
  const spikeRate = n > 0 ? truthResult.outlierSpikeCount / n : 0;
  // Weighted deductions: invalid OHLC is worst, spikes advisory only.
  const ohlcRaw = clamp(
    100
    - invalidRate * 100         // hard penalise invalid bars
    - dupRate * 40              // duplicates are provider sloppiness
    - oooRate * 40
    - spikeRate * 10,           // spikes are advisory flags, not hard failures
  );
  const ohlcDetail = [
    truthResult.invalidOhlcCount > 0 ? `${truthResult.invalidOhlcCount} invalid OHLC bar(s)` : null,
    truthResult.duplicateCount > 0 ? `${truthResult.duplicateCount} duplicate(s)` : null,
    truthResult.outOfOrderCount > 0 ? `${truthResult.outOfOrderCount} out-of-order bar(s)` : null,
    truthResult.outlierSpikeCount > 0 ? `${truthResult.outlierSpikeCount} spike outlier(s)` : null,
  ].filter(Boolean).join("; ") || "All bars valid.";
  subMetrics.push(sub("ohlc_integrity", "OHLC Integrity", 0.20, ohlcRaw, ohlcDetail));

  // ── 2. Source Authenticity (0.15) ─────────────────────────────────────────
  // Mock data = 0, real OHLC from live source = 100.
  let sourceRaw: number | null;
  let sourceDetail: string;
  if (truthResult.mockDataDetected) {
    sourceRaw = 0;
    sourceDetail = "Mock/simulated data detected — not safe as tradable truth.";
  } else if (!truthResult.providerDeliversRealOhlc) {
    sourceRaw = 45;
    sourceDetail = `ohlcSourceType=${truthResult.ohlcSourceType} — provider does not deliver true OHLC bars.`;
  } else if (truthResult.sourceMode === "live") {
    sourceRaw = 100;
    sourceDetail = `Live source: ${truthResult.source ?? "unknown"} (${truthResult.ohlcSourceType}).`;
  } else if (truthResult.sourceMode === "demo") {
    sourceRaw = 85;
    sourceDetail = "Demo/paper mode — price is real but account context is demo.";
  } else if (truthResult.sourceMode === "dev") {
    sourceRaw = 20;
    sourceDetail = "Dev/test source — not safe as tradable truth.";
  } else {
    sourceRaw = null;
    sourceDetail = `Source mode: ${truthResult.sourceMode} — authenticity unconfirmed.`;
  }
  subMetrics.push(sub("source_authenticity", "Source Authenticity", 0.15, sourceRaw, sourceDetail));

  // ── 3. Timeframe Accuracy (0.13) ──────────────────────────────────────────
  // Based on: history minimum met, assessment verdict.
  let tfRaw: number;
  let tfDetail: string;
  switch (truthResult.assessment) {
    case "CLEAN":
      tfRaw = truthResult.historyMinimumMet ? 100 : 75;
      tfDetail = truthResult.historyMinimumMet
        ? "Assessment CLEAN; history minimum met."
        : `Assessment CLEAN but history below minimum (${n} bars).`;
      break;
    case "PARTIAL":
      tfRaw = truthResult.historyMinimumMet ? 65 : 50;
      tfDetail = `Assessment PARTIAL — ${truthResult.assessmentReasons.slice(0, 2).join("; ")}.`;
      break;
    case "STALE":
      tfRaw = 40;
      tfDetail = `Assessment STALE — ${truthResult.assessmentReasons[0] ?? "feed lagging"}.`;
      break;
    case "DEGRADED":
      tfRaw = 10;
      tfDetail = `Assessment DEGRADED — ${truthResult.assessmentReasons[0] ?? "data integrity failure"}.`;
      break;
    default:
      tfRaw = 0;
      tfDetail = "Assessment UNAVAILABLE — no timeframe data.";
  }
  subMetrics.push(sub("timeframe_accuracy", "Timeframe Accuracy", 0.13, tfRaw, tfDetail));

  // ── 4. Symbol Mirror Accuracy (0.12) ──────────────────────────────────────
  // Combines seam integrity (Phase 1) with broker price deviation (Phase 3).
  // When real broker bid/ask is available, a wide or failed deviation means the
  // chart price and broker price have diverged — a real mirror sync issue.
  const seam = truthResult.mergeSeam;
  const seamMeasured = seam.formingBarDetected && Number.isSafeInteger(seam.formingBarCount) &&
    seam.formingBarCount > 0 && n > seam.formingBarCount && Number.isSafeInteger(seam.seamGapIntervals) && seam.seamGapIntervals >= 0;
  let mirrorRaw: number;
  let mirrorDetail: string;
  if (!seamMeasured) {
    mirrorRaw = 80;
    mirrorDetail = "No closed-to-forming pair available — seam not assessable.";
  } else if (seam.overlapAtSeam) {
    mirrorRaw = 30;
    mirrorDetail = "Seam overlap detected — forming bar open overlaps last closed bar.";
  } else if (seam.gapAtSeam) {
    const gapPenalty = Math.min(seam.seamGapIntervals * 15, 60);
    mirrorRaw = clamp(100 - gapPenalty);
    mirrorDetail = `Seam gap: ${seam.seamGapIntervals} missing interval(s) between last closed and forming bar.`;
  } else {
    mirrorRaw = 100;
    mirrorDetail = "Seam clean — forming bar aligns immediately after last closed bar.";
  }
  // Penalise if real OHLC not delivered (mirror truth is lower quality).
  if (!truthResult.providerDeliversRealOhlc) mirrorRaw = clamp(mirrorRaw * 0.75);
  // Fold in broker price alignment when real broker data is present.
  // Tight/normal = no additional penalty; wide = -15; failed = -40.
  // SYNTHETIC price basis = additional -10 (broker mid comparison less meaningful).
  if (alignment?.brokerDataAvailable) {
    const basisPenalty = alignment.chartPriceBasis === "SYNTHETIC" ? 10 : 0;
    let alignPenalty = 0;
    let alignNote = "";
    switch (alignment.tolerance) {
      case "tight":
      case "normal":
        alignNote = `Broker price aligned (${alignment.tolerance}).`;
        break;
      case "wide":
        alignPenalty = 15;
        alignNote = `Broker deviation WIDE — chart and broker prices diverging.`;
        break;
      case "failed":
        alignPenalty = 40;
        alignNote = `Broker deviation FAILED — chart price significantly out of sync with broker.`;
        break;
      default:
        alignNote = `Broker alignment ${alignment.tolerance}.`;
    }
    mirrorRaw = clamp(mirrorRaw - alignPenalty - basisPenalty);
    // Preserve the observed failed comparison in the downstream <50 FAIL band.
    if (alignment.tolerance === "failed") mirrorRaw = Math.min(mirrorRaw, 49);
    mirrorDetail = [mirrorDetail, alignNote].filter(Boolean).join(" ");
  } else if (alignment) {
    // Broker not enumerated — note it without penalising.
    mirrorDetail += " Broker quote unavailable for alignment check.";
  }
  const alignmentMeasured = hasMeasuredBrokerAlignment(alignment);
  // A numeric comparison whose quote is not bound to this series' identity and
  // freshness earns nothing; the observed binding failure stays named.
  const binding = alignment?.quoteBinding;
  const unboundDetail = alignment?.brokerDataAvailable && binding && binding.status !== "BOUND"
    ? `Broker mirror accuracy unmeasured — broker quote ${binding.status === "MISMATCH" ? "identity does not match this chart series"
      : binding.status === "STALE" ? "tick time is outside the freshness budget" : "identity or tick time is unverified"}` +
      (binding.reasons.length ? ` (${binding.reasons.join(", ")}).` : ".")
    : alignment?.brokerDataAvailable && !binding
      ? "Broker mirror accuracy unmeasured — broker quote identity and freshness were not evaluated."
      : "Broker mirror accuracy unmeasured — no usable broker-price comparison.";
  subMetrics.push(sub("symbol_mirror_accuracy", "Symbol Mirror Accuracy", 0.12,
    alignmentMeasured ? mirrorRaw : null,
    alignmentMeasured ? mirrorDetail : unboundDetail));

  // ── 5. Historical/Live Merge Quality (0.10) ───────────────────────────────
  // Strictly the quality of the merge seam itself.
  let mergeRaw: number;
  let mergeDetail: string;
  if (!seamMeasured) {
    mergeRaw = 85;
    mergeDetail = "No closed-to-forming pair available — merge seam unmeasured.";
  } else if (seam.gapAtSeam) {
    mergeRaw = clamp(100 - seam.seamGapIntervals * 20);
    mergeDetail = `Merge gap of ${seam.seamGapIntervals} interval(s).`;
  } else if (seam.overlapAtSeam) {
    mergeRaw = 50;
    mergeDetail = "Overlap at merge seam.";
  } else {
    mergeRaw = 100;
    mergeDetail = "Clean merge seam.";
  }
  subMetrics.push(sub("historical_live_merge", "Historical/Live Merge Quality", 0.10,
    seamMeasured ? mergeRaw : null, mergeDetail));

  // ── 6. Feed Freshness (0.09) ──────────────────────────────────────────────
  let freshnessRaw: number;
  let freshnessDetail: string;
  switch (feedStatus.quality) {
    case "clean":
      freshnessRaw = 100;
      freshnessDetail = "Feed clean and current.";
      break;
    case "delayed":
      freshnessRaw = 70;
      freshnessDetail = "Feed delayed — not yet confirmed real-time.";
      break;
    case "stale":
      freshnessRaw = 35;
      freshnessDetail = "Feed stale — lagging by 3+ intervals.";
      break;
    case "partial":
      freshnessRaw = 55;
      freshnessDetail = "Feed partial — sequence anomalies present.";
      break;
    case "invalid":
      freshnessRaw = 10;
      freshnessDetail = "Feed invalid — integrity check failed.";
      break;
    case "empty":
      freshnessRaw = 5;
      freshnessDetail = "Feed empty — no candles returned.";
      break;
    default:
      freshnessRaw = 0;
      freshnessDetail = "Feed unavailable.";
  }
  if (feedStatus.stale && freshnessRaw > 35) {
    freshnessRaw = 35;
    freshnessDetail = "Feed marked stale — current data is not confirmed.";
  } else if (!feedStatus.stale && feedStatus.isLive !== true && freshnessRaw > 70) {
    freshnessRaw = 70;
    freshnessDetail = "Feed is not confirmed live.";
  }
  subMetrics.push(sub("feed_freshness", "Feed Freshness", 0.09, freshnessRaw, freshnessDetail));

  // ── 7. Price Precision (0.08) ─────────────────────────────────────────────
  const precRate = n > 0 ? truthResult.precisionViolationCount / n : 0;
  const precisionRaw = clamp(100 - precRate * 100);
  const precisionDetail = truthResult.precisionViolationCount > 0
    ? `${truthResult.precisionViolationCount} precision violation(s) out of ${n} bars (${truthResult.pricePrecision ?? "unknown"} expected decimal places).`
    : truthResult.pricePrecision != null
      ? `Price precision ${truthResult.pricePrecision}dp — all bars within expected range.`
      : "Price precision profile unavailable; violations not measured.";
  subMetrics.push(sub("price_precision", "Price Precision", 0.08,
    truthResult.pricePrecision != null && Number.isSafeInteger(truthResult.pricePrecision) && truthResult.pricePrecision >= 0
      ? precisionRaw : null, precisionDetail));

  // ── 8. Render Accuracy (0.07) — Phase 2 proxy ────────────────────────────
  // Proxy: outlier wick count + phantom zero-volume bars as a render-truth proxy.
  // Phase 2 will replace with real render / scale / interaction signals.
  const renderDetail = [
    truthResult.outlierWickCount > 0 ? `${truthResult.outlierWickCount} wick outlier(s)` : null,
    truthResult.zeroVolumeGhostCount > 0 ? `${truthResult.zeroVolumeGhostCount} zero-volume ghost(s)` : null,
    "Source-bar diagnostics do not measure rendering; renderer evidence unavailable",
  ].filter(Boolean).join("; ");
  subMetrics.push(sub("render_accuracy", "Render Accuracy", 0.07, null, renderDetail));

  // ── 9. Scale Quality (0.04) — Phase 2 proxy ──────────────────────────────
  // Proxy: historical-period-shift bars distort auto-scale.
  const scaleDetail = truthResult.historicalPeriodShiftCount > 0
    ? `${truthResult.historicalPeriodShiftCount} bar(s) from a different price epoch; actual chart scale has not been measured.`
    : "No historical-period-shift bars detected; actual chart scale has not been measured.";
  subMetrics.push(sub("scale_quality", "Scale Quality", 0.04, null, scaleDetail));

  // ── 10. Interaction Stability (0.02) — Phase 2 placeholder ───────────────
  // Absence of a reported failure is not a successful interaction measurement.
  subMetrics.push(sub(
    "interaction_stability",
    "Interaction Stability",
    0.02,
    null,
    "Interaction measurements unavailable.",
  ));

  // ── Aggregate ─────────────────────────────────────────────────────────────
  return aggregate(subMetrics);
}
