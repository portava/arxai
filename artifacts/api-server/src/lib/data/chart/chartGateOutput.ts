// Phase 3 — Chart Gate Output.
//
// Evaluates the hard rules from the mission and exposes them as a single,
// reusable gate result that Phase 4 consumers (Ruby, Scanner, Self-Trade,
// AACI) read without re-implementing the threshold logic.
//
// Hard rules (from the mission):
//   Chart Truth <75          ⇒ confidentReadAllowed = false
//                              scannerConfirmAllowed = false
//                              selfTradeChartAllowed = false
//   providerDeliversRealOhlc = false ⇒ candlestickModeAllowed = false
//   mirror fail (seam overlap OR deviation failed) ⇒ tradeConfirmationAllowed = false
//   mirror not checked (no seam AND no bound broker comparison) ⇒ tradeConfirmationAllowed = false
//   feed stale               ⇒ autonomousChartActionAllowed = false
//
// SAFETY: this gate NEVER blocks candle rendering or the live 16-gate pipeline.
// It is an advisory chokepoint for chart-BASED confirmations only. Phase 4
// consumers enforce the hard rules; they may add stricter local checks on top.

import { isMergeSeamMeasured, type ChartTruthScore } from "./chartTruthScore.js";
import type { ChartReadScore } from "./chartReadScore.js";
import { hasMeasuredBrokerAlignment, unboundQuoteDescription, type BrokerPriceAlignment } from "./brokerPriceAlignment.js";
import type { TimeframeTruthResult } from "./candleTruthEngine.js";

export interface ChartGateOutput {
  /** 0–100 weighted Chart Truth Score. */
  chartTruthScore: number;
  /** 0–100 Chart Read Score (readability/tradability). */
  chartReadScore: number;
  /** Chart Truth label band. */
  truthLabel: string;
  /** Chart Read label band. */
  readLabel: string;

  // ── Hard gate decisions ────────────────────────────────────────────────────
  /**
   * True when Chart Truth ≥ 75 — required for any chart-based confident read
   * (Ruby chart-read copy, Scanner chart-confirmation, etc.).
   */
  confidentReadAllowed: boolean;
  /**
   * True when Chart Truth ≥ 75 — required for scanner chart-confirmation flag.
   * Phase 4 scanner integration reads this.
   */
  scannerConfirmAllowed: boolean;
  /**
   * True when Chart Truth ≥ 75 — required for self-trade chart-based confirmation.
   * Phase 4 self-trade gate reads this.
   */
  selfTradeChartAllowed: boolean;
  /**
   * True when the provider delivers real OHLC bars (true_ohlc or tick_aggregated).
   * When false, the chart must display a line/area mode rather than candlesticks.
   */
  candlestickModeAllowed: boolean;
  /**
   * True when the feed is NOT stale — required before any autonomous (bot-driven)
   * chart-based action. A stale feed must not drive automated decisions.
   */
  autonomousChartActionAllowed: boolean;
  /**
   * True when the broker-price mirror has NOT failed (seam clean AND broker
   * alignment within wide tolerance) AND at least one of the two was actually
   * observed. When neither the seam nor a bound broker comparison could be
   * checked, "allowed" would rest on absent evidence, so it is false and the
   * reason says the mirror could not be checked (not that it failed).
   * When false, chart-based trade confirmation (entry/stop reference from the
   * chart) is blocked.
   */
  tradeConfirmationAllowed: boolean;

  // ── Blocked reasons (human-readable) ─────────────────────────────────────
  blockedReasons: string[];
  /**
   * Single most important reason all gates are not fully open, or null.
   */
  primaryBlockReason: string | null;

  note: string;
}

const TRUTH_THRESHOLD = 75;

export const MERGE_SEAM_FAILED_REASON = "Merge-seam integrity failed — chart-based trade confirmation blocked.";
export const MIRROR_NOT_CHECKED_REASON =
  "Neither the merge seam nor a broker price comparison could be checked — chart-based trade confirmation is not allowed without evidence.";

/**
 * Trust-line candle segment. Passing the 75 gate is not "verified": the word
 * is used only inside the score's own Verified band; otherwise the line
 * states the score and its band.
 */
export function candleTrustSegment(
  gate: Pick<ChartGateOutput, "confidentReadAllowed" | "chartTruthScore" | "truthLabel">,
  timeframe: string,
): string {
  if (!gate.confidentReadAllowed) return `${timeframe} candles syncing`;
  if (gate.truthLabel === "Verified") return `Verified ${timeframe} candles`;
  return `${timeframe} candles: Chart Truth ${gate.chartTruthScore} (${gate.truthLabel})`;
}

/**
 * Trust-line feed segment. "Not stale" is not "live": "Live feed" needs a
 * clean feed that is confirmed live; a delayed or not-live feed says so.
 */
export function feedTrustSegment(
  autonomousChartActionAllowed: boolean,
  feed: { quality?: string | null; isLive?: boolean | null } | null | undefined,
): string {
  if (!autonomousChartActionAllowed || feed?.quality === "stale") return "Feed stale";
  if (feed?.quality === "delayed") return "Feed delayed";
  if (feed?.isLive === false) return "Feed not live";
  if (feed?.quality === "clean" && feed.isLive === true) return "Live feed";
  return "Feed not confirmed live";
}

/** The gate's mirror reasons, read back from its own blocked reasons (also for cached gates). */
export function gateMirrorBlockCause(gate: Pick<ChartGateOutput, "tradeConfirmationAllowed" | "blockedReasons">): {
  seamFailed: boolean; notChecked: boolean;
} {
  const reasons = Array.isArray(gate.blockedReasons) ? gate.blockedReasons : [];
  return {
    seamFailed: reasons.includes(MERGE_SEAM_FAILED_REASON),
    notChecked: !gate.tradeConfirmationAllowed && reasons.includes(MIRROR_NOT_CHECKED_REASON),
  };
}

/**
 * Plain-English reason for a Chart Truth Score under the threshold. The score
 * band (e.g. "Degraded") is named only when a MEASURED check found a concern;
 * a score that is low only because checks could not run says exactly that and
 * names them, because unmeasured checks earn no points.
 */
function truthShortfallReason(truthScore: ChartTruthScore): string {
  const head = `Chart Truth Score ${truthScore.score} < ${TRUTH_THRESHOLD}`;
  const metrics = Array.isArray(truthScore.subMetrics) ? truthScore.subMetrics : [];
  if (!metrics.length) return `${head} (${truthScore.label}) — chart-based confirmation blocked.`;
  const measured = (m: ChartTruthScore["subMetrics"][number]) =>
    m.evidenceStatus === "measured" && m.rawScore != null && Number.isFinite(m.rawScore);
  const concerns = metrics.filter(m => measured(m) && m.rawScore! < 90);
  const unmeasured = metrics.filter(m => !measured(m));
  return (concerns.length ? `${head} (${truthScore.label})` : head) + " — chart-based confirmation blocked. " +
    (concerns.length
      ? `Measured concerns: ${concerns.map(m => `${m.label} ${m.rawScore}/100`).join(", ")}.`
      : "No measured check found a problem.") +
    (unmeasured.length
      ? ` Could not be checked (earn no points): ${unmeasured.map(m => m.label).join(", ")}.` : "");
}

export function computeChartGateOutput(
  truthScore: ChartTruthScore,
  readScore: ChartReadScore,
  alignment: BrokerPriceAlignment,
  truthResult: TimeframeTruthResult | null,
  feedStale: boolean,
): ChartGateOutput {
  const blockedReasons: string[] = [];

  // ── 1. confident read / scanner / self-trade — Truth ≥ 75 ─────────────────
  const trustworthy = truthScore.score >= TRUTH_THRESHOLD;
  const confidentReadAllowed = trustworthy;
  const scannerConfirmAllowed = trustworthy;
  const selfTradeChartAllowed = trustworthy;
  if (!trustworthy) blockedReasons.push(truthShortfallReason(truthScore));

  // ── 2. candlestick mode — real OHLC required ───────────────────────────────
  const hasRealOhlc = truthResult?.providerDeliversRealOhlc ?? false;
  const candlestickModeAllowed = hasRealOhlc;
  if (!hasRealOhlc) {
    const ohlcType = truthResult?.ohlcSourceType ?? "unknown";
    blockedReasons.push(
      `Provider ohlcSourceType="${ohlcType}" — candlestick mode requires true_ohlc; use line/area chart.`,
    );
  }

  // ── 3. autonomous chart action — feed must not be stale ───────────────────
  const autonomousChartActionAllowed = !feedStale;
  if (feedStale) {
    blockedReasons.push("Feed is stale — autonomous chart-based actions are blocked until the feed is current.");
  }

  // ── 4. trade confirmation — mirror must not have failed ───────────────────
  const seamFailed = truthResult
    ? (truthResult.mergeSeam.overlapAtSeam || (truthResult.mergeSeam.gapAtSeam && truthResult.mergeSeam.seamGapIntervals > 2))
    : false;
  const alignmentFailed = alignment.brokerDataAvailable && alignment.tolerance === "failed";
  // "Not failed" is not evidence: with no observed seam and no bound broker
  // comparison there is nothing to confirm the chart's prices against.
  const mirrorNotChecked = !seamFailed && !alignmentFailed &&
    !isMergeSeamMeasured(truthResult) && !hasMeasuredBrokerAlignment(alignment);
  const tradeConfirmationAllowed = !seamFailed && !alignmentFailed && !mirrorNotChecked;
  if (seamFailed) {
    blockedReasons.push(MERGE_SEAM_FAILED_REASON);
  }
  if (alignmentFailed) {
    // The gate stays closed either way; the copy names what was compared. A
    // quote from another feed or an old tick says nothing about this chart.
    const unbound = unboundQuoteDescription(alignment.quoteBinding);
    blockedReasons.push(unbound
      ? `The chart price differs beyond the failure band from ${unbound.reason} — chart-based trade confirmation blocked. ` +
        "That comparison does not show whether this chart matches your broker."
      : "Broker price alignment failed — chart-based trade confirmation blocked.");
  }
  if (mirrorNotChecked) {
    blockedReasons.push(MIRROR_NOT_CHECKED_REASON);
  }

  const primaryBlockReason = blockedReasons[0] ?? null;

  const allOpen =
    confidentReadAllowed &&
    candlestickModeAllowed &&
    autonomousChartActionAllowed &&
    tradeConfirmationAllowed;

  const note = allOpen
    ? `All chart gates OPEN (Truth ${truthScore.score}, Read ${readScore.score}).`
    : `${blockedReasons.length} gate(s) closed. (Truth ${truthScore.score}, Read ${readScore.score})`;

  return {
    chartTruthScore: truthScore.score,
    chartReadScore: readScore.score,
    truthLabel: truthScore.label,
    readLabel: readScore.label,
    confidentReadAllowed,
    scannerConfirmAllowed,
    selfTradeChartAllowed,
    candlestickModeAllowed,
    autonomousChartActionAllowed,
    tradeConfirmationAllowed,
    blockedReasons,
    primaryBlockReason,
    note,
  };
}
