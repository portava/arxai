// Phase 4 — Chart Handshake for AACI.
//
// Translates Phase 3 gate outputs (ChartGateOutput + ChartTruthScore subMetrics)
// into a 10-field PASS/WARN/FAIL handshake that AACI consumers read to lower
// market-truth confidence when chart data is degraded.
//
// SAFETY: READ-ONLY, advisory only. Never an execution gate, never modifies the
// 16-gate live pipeline, never fabricates a PASS when evidence is absent.

import type { ChartGateOutput } from "./chartGateOutput.js";
import type { ChartTruthScore } from "./chartTruthScore.js";

export type ChartHandshakeVerdict = "PASS" | "WARN" | "FAIL";

export interface AaciChartHandshake {
  /** Real OHLC source present — candlestickModeAllowed from gate. */
  ChartSource: ChartHandshakeVerdict;
  /** OHLC integrity sub-metric (bad bars, duplicates, out-of-order). */
  OHLCIntegrity: ChartHandshakeVerdict;
  /** Timeframe accuracy sub-metric (history minimum met). */
  TimeframeAccuracy: ChartHandshakeVerdict;
  /** Broker-price mirror — seam clean AND alignment within tolerance. */
  MirrorSync: ChartHandshakeVerdict;
  /** Feed freshness — not stale, trailing gap ok. */
  FeedFreshness: ChartHandshakeVerdict;
  /** Historical/live merge quality — seam gap intervals. */
  HistoricalLiveMerge: ChartHandshakeVerdict;
  /** Broker price alignment — chart close vs MT5 bid/ask. */
  BrokerPriceAlignment: ChartHandshakeVerdict;
  /** Render accuracy proxy (Phase 2) — outlier wicks, historic shift. */
  RenderHealth: ChartHandshakeVerdict;
  /** Ruby read allowed — confidentReadAllowed from gate. */
  RubyReadAllowed: ChartHandshakeVerdict;
  /** Self-trade chart allowed — selfTradeChartAllowed from gate. */
  SelfTradeChartAllowed: ChartHandshakeVerdict;

  /**
   * Overall rollup: PASS only when all 10 are PASS.
   * WARN when ≥1 WARN and no FAIL. FAIL when ≥1 FAIL.
   */
  overall: ChartHandshakeVerdict;

  /** Compact Chart Truth Score (0–100) for AACI market-truth weighting. */
  chartTruthScore: number;
  /** Compact Chart Read Score (0–100). */
  chartReadScore: number;
  /** Primary block reason, or null when all pass. */
  primaryBlockReason: string | null;
}

function rollup(verdicts: ChartHandshakeVerdict[]): ChartHandshakeVerdict {
  if (verdicts.includes("FAIL")) return "FAIL";
  if (verdicts.includes("WARN")) return "WARN";
  return "PASS";
}

function boolToVerdict(pass: boolean, failMode: "FAIL" | "WARN" = "FAIL"): ChartHandshakeVerdict {
  return pass ? "PASS" : failMode;
}

/** Find a sub-metric raw score by key from the subMetrics array. */
function subMetricScore(score: ChartTruthScore, key: string): number | null {
  const m = score.subMetrics.find((s) => s.key === key);
  return m != null ? m.rawScore : null;
}

function scoreToVerdict(
  rawScore: number | null,
  passThreshold = 75,
  warnThreshold = 50,
): ChartHandshakeVerdict {
  if (rawScore == null) return "WARN";
  if (rawScore >= passThreshold) return "PASS";
  if (rawScore >= warnThreshold) return "WARN";
  return "FAIL";
}

/**
 * Translate Phase 3 gate outputs into an AACI chart handshake.
 *
 * Conservative: unknown evidence → WARN; clear gate failure → FAIL.
 * When `truthScore` is provided, per-sub-metric raw scores are used for
 * finer WARN/FAIL granularity. When absent, gate booleans alone decide.
 */
export function buildChartHandshake(
  gate: ChartGateOutput,
  truthScore?: ChartTruthScore,
): AaciChartHandshake {
  const ChartSource = boolToVerdict(gate.candlestickModeAllowed);

  const OHLCIntegrity = truthScore
    ? scoreToVerdict(subMetricScore(truthScore, "ohlc_integrity"))
    : boolToVerdict(gate.confidentReadAllowed, "WARN");

  const TimeframeAccuracy = truthScore
    ? scoreToVerdict(subMetricScore(truthScore, "timeframe_accuracy"))
    : boolToVerdict(gate.confidentReadAllowed, "WARN");

  const MirrorSync = boolToVerdict(gate.tradeConfirmationAllowed);

  const FeedFreshness = boolToVerdict(gate.autonomousChartActionAllowed);

  const HistoricalLiveMerge = truthScore
    ? scoreToVerdict(subMetricScore(truthScore, "historical_live_merge"))
    : boolToVerdict(gate.tradeConfirmationAllowed, "WARN");

  const BrokerPriceAlignment = truthScore
    ? scoreToVerdict(subMetricScore(truthScore, "symbol_mirror_accuracy"))
    : boolToVerdict(gate.tradeConfirmationAllowed, "WARN");

  const RenderHealth = truthScore
    ? scoreToVerdict(subMetricScore(truthScore, "render_accuracy"))
    : boolToVerdict(gate.confidentReadAllowed, "WARN");

  const RubyReadAllowed = boolToVerdict(gate.confidentReadAllowed);

  const SelfTradeChartAllowed = boolToVerdict(gate.selfTradeChartAllowed);

  const all: ChartHandshakeVerdict[] = [
    ChartSource,
    OHLCIntegrity,
    TimeframeAccuracy,
    MirrorSync,
    FeedFreshness,
    HistoricalLiveMerge,
    BrokerPriceAlignment,
    RenderHealth,
    RubyReadAllowed,
    SelfTradeChartAllowed,
  ];

  return {
    ChartSource,
    OHLCIntegrity,
    TimeframeAccuracy,
    MirrorSync,
    FeedFreshness,
    HistoricalLiveMerge,
    BrokerPriceAlignment,
    RenderHealth,
    RubyReadAllowed,
    SelfTradeChartAllowed,
    overall: rollup(all),
    chartTruthScore: gate.chartTruthScore,
    chartReadScore: gate.chartReadScore,
    primaryBlockReason: gate.primaryBlockReason,
  };
}
