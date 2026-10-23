// Phase 3 — Chart Truth Score engine.
//
// Computes a weighted 0–100 score answering "is the data real, fresh, synced,
// correctly mapped/timed/mirrored/rendered?" from real Phase 1 / Phase 2
// signals. NEVER fabricates a sub-metric — when a Phase 2 surface hasn't
// reported yet, the sub-metric honestly defaults to its conservative baseline.
//
// Weights (must sum to 1.0):
//   OHLCIntegrity            0.20  — bad OHLC bars, duplicates, out-of-order
//   SourceAuthenticity       0.15  — mock detection, real-OHLC flag, sourceMode
//   TimeframeAccuracy        0.13  — history minimum, assessment
//   SymbolMirrorAccuracy     0.12  — seam overlap/gap, broker-symbol match
//   HistoricalLiveMergeQuality 0.10 — merge seam quality (gap intervals)
//   FeedFreshness            0.09  — stale, quality, trailing gap
//   PricePrecision           0.08  — precision violations
//   RenderAccuracy           0.07  — Phase 2 proxy (outlier wicks / historic shift)
//   ScaleQuality             0.04  — Phase 2 proxy (historical period shift)
//   InteractionStability     0.02  — Phase 2 placeholder (honest full score until wired)
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
import type { BrokerPriceAlignment } from "./brokerPriceAlignment.js";

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
  rawScore: number;
  weightedScore: number;
  detail: string;
}

export interface ChartTruthScore {
  score: number;
  label: ChartTruthLabel;
  subMetrics: ChartTruthSubMetric[];
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
  rawScore: number,
  detail: string,
): ChartTruthSubMetric {
  const clamped = clamp(rawScore, 0, 100);
  return {
    key,
    label,
    weight,
    rawScore: round(clamped),
    weightedScore: round(clamped * weight),
    detail,
  };
}

/**
 * Compute the Chart Truth Score from Phase 1 truth result + feed status.
 *
 * @param alignment - Optional broker price alignment. When supplied and
 *   `brokerDataAvailable === true`, the broker deviation is folded into the
 *   SymbolMirrorAccuracy sub-metric so real mis-sync degrades the score.
 *   Pass `undefined` or `noBrokerAlignment(...)` when no per-user broker
 *   data is available (the sub-metric then uses seam-only evidence).
 *
 * When truthResult is null (no candles returned), returns the minimum honest score.
 */
export function computeChartTruthScore(
  truthResult: TimeframeTruthResult | null,
  feedStatus: ChartFeedStatus,
  alignment?: BrokerPriceAlignment,
): ChartTruthScore {
  const subMetrics: ChartTruthSubMetric[] = [];

  if (!truthResult) {
    const floor = sub(
      "ohlc_integrity",
      "OHLC Integrity",
      0.20,
      0,
      "No candles returned — feed unavailable.",
    );
    const rest: ChartTruthSubMetric[] = [
      sub("source_authenticity", "Source Authenticity", 0.15, 0, "No feed data."),
      sub("timeframe_accuracy", "Timeframe Accuracy", 0.13, 0, "No feed data."),
      sub("symbol_mirror_accuracy", "Symbol Mirror Accuracy", 0.12, 0, "No feed data."),
      sub("historical_live_merge", "Historical/Live Merge Quality", 0.10, 0, "No feed data."),
      sub("feed_freshness", "Feed Freshness", 0.09, 0, "No feed data."),
      sub("price_precision", "Price Precision", 0.08, 0, "No feed data."),
      sub("render_accuracy", "Render Accuracy", 0.07, 50, "Phase 2 placeholder — defaulting 50."),
      sub("scale_quality", "Scale Quality", 0.04, 50, "Phase 2 placeholder — defaulting 50."),
      sub("interaction_stability", "Interaction Stability", 0.02, 100, "No Phase 2 data — honest 100."),
    ];
    const all = [floor, ...rest];
    const score = round(all.reduce((s, m) => s + m.weightedScore, 0));
    return {
      score,
      label: labelFor(score),
      subMetrics: all,
      primaryConcern: "No candles returned — feed unavailable",
      note: `Chart Truth Score ${score} (${labelFor(score)}) — feed returned no data; data-driven sub-metrics scored 0.`,
    };
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
  let sourceRaw: number;
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
    sourceRaw = 60;
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
  let mirrorRaw: number;
  let mirrorDetail: string;
  if (!seam.formingBarDetected) {
    mirrorRaw = 80;
    mirrorDetail = "No forming bar detected — seam not assessable; assumed clean.";
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
    mirrorDetail = [mirrorDetail, alignNote].filter(Boolean).join(" ");
  } else if (alignment) {
    // Broker not enumerated — note it without penalising.
    mirrorDetail += " Broker quote unavailable for alignment check.";
  }
  subMetrics.push(sub("symbol_mirror_accuracy", "Symbol Mirror Accuracy", 0.12, mirrorRaw, mirrorDetail));

  // ── 5. Historical/Live Merge Quality (0.10) ───────────────────────────────
  // Strictly the quality of the merge seam itself.
  let mergeRaw: number;
  let mergeDetail: string;
  if (!seam.formingBarDetected) {
    mergeRaw = 85;
    mergeDetail = "No forming bar — merge seam N/A.";
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
  subMetrics.push(sub("historical_live_merge", "Historical/Live Merge Quality", 0.10, mergeRaw, mergeDetail));

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
  subMetrics.push(sub("feed_freshness", "Feed Freshness", 0.09, freshnessRaw, freshnessDetail));

  // ── 7. Price Precision (0.08) ─────────────────────────────────────────────
  const precRate = n > 0 ? truthResult.precisionViolationCount / n : 0;
  const precisionRaw = clamp(100 - precRate * 100);
  const precisionDetail = truthResult.precisionViolationCount > 0
    ? `${truthResult.precisionViolationCount} precision violation(s) out of ${n} bars (${truthResult.pricePrecision ?? "unknown"} expected decimal places).`
    : truthResult.pricePrecision != null
      ? `Price precision ${truthResult.pricePrecision}dp — all bars within expected range.`
      : "Price precision profile unavailable; violations not measured.";
  subMetrics.push(sub("price_precision", "Price Precision", 0.08, precisionRaw, precisionDetail));

  // ── 8. Render Accuracy (0.07) — Phase 2 proxy ────────────────────────────
  // Proxy: outlier wick count + phantom zero-volume bars as a render-truth proxy.
  // Phase 2 will replace with real render / scale / interaction signals.
  const wickRate = n > 0 ? truthResult.outlierWickCount / n : 0;
  const ghostRate = n > 0 ? truthResult.zeroVolumeGhostCount / n : 0;
  const renderRaw = clamp(
    100
    - wickRate * 30          // wick outliers reduce render clarity
    - ghostRate * 25,        // zero-volume ghosts distort renders
  );
  const renderDetail = [
    truthResult.outlierWickCount > 0 ? `${truthResult.outlierWickCount} wick outlier(s)` : null,
    truthResult.zeroVolumeGhostCount > 0 ? `${truthResult.zeroVolumeGhostCount} zero-volume ghost(s)` : null,
    "(Phase 2 proxy — real render signals pending)",
  ].filter(Boolean).join("; ");
  subMetrics.push(sub("render_accuracy", "Render Accuracy", 0.07, renderRaw, renderDetail));

  // ── 9. Scale Quality (0.04) — Phase 2 proxy ──────────────────────────────
  // Proxy: historical-period-shift bars distort auto-scale.
  const shiftRate = n > 0 ? truthResult.historicalPeriodShiftCount / n : 0;
  const scaleRaw = clamp(100 - shiftRate * 60);
  const scaleDetail = truthResult.historicalPeriodShiftCount > 0
    ? `${truthResult.historicalPeriodShiftCount} bar(s) from a different price epoch — Y-axis auto-scale may be distorted. (Phase 2 proxy)`
    : "No historical-period-shift bars detected. (Phase 2 proxy)";
  subMetrics.push(sub("scale_quality", "Scale Quality", 0.04, scaleRaw, scaleDetail));

  // ── 10. Interaction Stability (0.02) — Phase 2 placeholder ───────────────
  // No Phase 2 interaction signals available yet. Honest 100 (not degraded,
  // not fabricated — we simply have no evidence of instability).
  subMetrics.push(sub(
    "interaction_stability",
    "Interaction Stability",
    0.02,
    100,
    "No Phase 2 interaction signals available yet — honest 100 (no evidence of instability).",
  ));

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const score = round(subMetrics.reduce((s, m) => s + m.weightedScore, 0));

  // Primary concern: worst weighted penalty sub-metric (excluding placeholders).
  const worstByGap = subMetrics
    .filter((m) => m.key !== "interaction_stability" && m.rawScore < 90)
    .sort((a, b) => (b.weight * (100 - b.rawScore)) - (a.weight * (100 - a.rawScore)));
  const primaryConcern = worstByGap[0]?.detail ?? null;

  const note = `Chart Truth Score ${score} (${labelFor(score)}). `
    + (primaryConcern ? `Primary concern: ${primaryConcern}` : "All sub-metrics healthy.");

  return {
    score,
    label: labelFor(score),
    subMetrics,
    primaryConcern,
    note,
  };
}
