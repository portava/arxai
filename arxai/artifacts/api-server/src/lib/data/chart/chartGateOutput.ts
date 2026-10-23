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
//   feed stale               ⇒ autonomousChartActionAllowed = false
//
// SAFETY: this gate NEVER blocks candle rendering or the live 16-gate pipeline.
// It is an advisory chokepoint for chart-BASED confirmations only. Phase 4
// consumers enforce the hard rules; they may add stricter local checks on top.

import type { ChartTruthScore } from "./chartTruthScore.js";
import type { ChartReadScore } from "./chartReadScore.js";
import type { BrokerPriceAlignment } from "./brokerPriceAlignment.js";
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
   * alignment within wide tolerance). When false, chart-based trade confirmation
   * (entry/stop reference from the chart) is blocked.
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
  if (!trustworthy) {
    blockedReasons.push(
      `Chart Truth Score ${truthScore.score} < ${TRUTH_THRESHOLD} (${truthScore.label}) — chart-based confirmation blocked.`,
    );
  }

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
  const tradeConfirmationAllowed = !seamFailed && !alignmentFailed;
  if (seamFailed) {
    blockedReasons.push("Merge-seam integrity failed — chart-based trade confirmation blocked.");
  }
  if (alignmentFailed) {
    blockedReasons.push("Broker price alignment failed — chart-based trade confirmation blocked.");
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
