// Phase 3 — Chart Read Score engine.
//
// Answers "is the chart's setup actually readable/tradable?" independently
// of the Chart Truth Score. A high-quality data feed does NOT guarantee a
// readable setup, and a readable setup on bad data is dangerous — they are
// separate scores consumed independently by Phase 4 gate consumers.
//
// Readability dimensions:
//   HistoryWindow        — enough bars to read structure (pattern visibility)
//   StructureClarity     — trend + level clarity (how easy is the setup to see)
//   SetupMaturity        — is there an active, non-stale setup to read
//   CandleContext        — candle pressure + intent clarity
//   TimeframeContext     — timeframe agreement + scalp-only warnings
//   VolatilityReadability — range vs noise (is price moving in a readable way)
//
// Score is 0–100. Labels:
//   90–100  Highly Readable
//   75–89   Readable
//   55–74   Partially Readable
//   35–54   Marginal
//   <35     Unreadable
//
// SAFETY: advisory read only; never gates a trade directly.
// Phase 4 will consume this score through the ChartGateOutput.

import { clamp, round } from "./engines/chartMath.js";
import type { ChartReadinessRead } from "./engines/marketUnderstandingTypes.js";
import type { ChartMarketUnderstanding, ChartDecisionState, ChartCandleStats } from "./chartIntelligence.js";
import type { ChartSetupRead } from "./engines/setupLifecycle.js";

export type ChartReadLabel =
  | "Highly Readable"
  | "Readable"
  | "Partially Readable"
  | "Marginal"
  | "Unreadable";

export interface ChartReadSubMetric {
  key: string;
  label: string;
  rawScore: number;
  detail: string;
}

export interface ChartReadScore {
  score: number;
  label: ChartReadLabel;
  subMetrics: ChartReadSubMetric[];
  primaryConcern: string | null;
  note: string;
}

function labelFor(score: number): ChartReadLabel {
  if (score >= 90) return "Highly Readable";
  if (score >= 75) return "Readable";
  if (score >= 55) return "Partially Readable";
  if (score >= 35) return "Marginal";
  return "Unreadable";
}

function met(key: string, label: string, rawScore: number, detail: string): ChartReadSubMetric {
  return { key, label, rawScore: round(clamp(rawScore, 0, 100)), detail };
}

export interface ChartReadScoreInputs {
  /** Closed bar count from candle stats. */
  barsAnalyzed: number;
  /** Whether the feed is AI-usable (clean quality). */
  aiUsable: boolean;
  /** Market understanding engines output. */
  marketUnderstanding: ChartMarketUnderstanding;
  /** Setup lifecycle state. */
  setup: ChartSetupRead;
  /** Decision state summary. */
  decisionState: ChartDecisionState;
  /** Readiness from Engine 6. */
  readiness: ChartReadinessRead;
  /** Candle stats for volatility read. */
  candleStats: ChartCandleStats;
}

export function computeChartReadScore(inputs: ChartReadScoreInputs): ChartReadScore {
  const {
    barsAnalyzed,
    aiUsable,
    marketUnderstanding,
    setup,
    decisionState,
    readiness,
    candleStats,
  } = inputs;

  const subMetrics: ChartReadSubMetric[] = [];

  // ── 1. History Window (bars available to read structure) ─────────────────
  const historyRaw =
    barsAnalyzed >= 150 ? 100
    : barsAnalyzed >= 80 ? 80
    : barsAnalyzed >= 40 ? 60
    : barsAnalyzed >= 20 ? 40
    : barsAnalyzed >= 5 ? 20
    : 0;
  subMetrics.push(met(
    "history_window",
    "History Window",
    historyRaw,
    barsAnalyzed >= 150
      ? `${barsAnalyzed} closed bars — full window for structure reading.`
      : `${barsAnalyzed} closed bars — limited pattern visibility.`,
  ));

  // ── 2. Structure Clarity (trend + level clarity) ──────────────────────────
  if (!marketUnderstanding.populated) {
    subMetrics.push(met(
      "structure_clarity",
      "Structure Clarity",
      0,
      "Market understanding engines not populated — insufficient candle window.",
    ));
  } else {
    const trend = marketUnderstanding.trend;
    const levels = marketUnderstanding.levels;

    const trendScore =
      trend.regime === "trending" ? clamp((trend.strength ?? 0) * 0.8 + 20)
      : trend.regime === "volatile" ? 40
      : trend.regime === "ranging" ? 50
      : trend.regime === "quiet" ? 30
      : 20;

    const levelScore =
      levels.levels.length >= 4 ? 100
      : levels.levels.length >= 2 ? 75
      : levels.levels.length >= 1 ? 40
      : 10;

    const structureRaw = trendScore * 0.6 + levelScore * 0.4;
    subMetrics.push(met(
      "structure_clarity",
      "Structure Clarity",
      structureRaw,
      `Regime: ${trend.regime} (strength ${trend.strength ?? 0}); ${levels.levels.length} level(s) mapped.`,
    ));
  }

  // ── 3. Setup Maturity (is there an active non-stale setup) ───────────────
  let setupRaw: number;
  let setupDetail: string;
  switch (setup.stage) {
    case "entry_valid":
    case "trigger":
      setupRaw = 100;
      setupDetail = `Setup at "${setup.stage}" — actionable entry opportunity.`;
      break;
    case "confirmation_needed":
      setupRaw = 75;
      setupDetail = "Setup awaiting confirmation — nearly readable.";
      break;
    case "watchlist":
      setupRaw = 55;
      setupDetail = "Setup on watchlist — not yet triggered.";
      break;
    case "idea_forming":
      setupRaw = 40;
      setupDetail = "Idea forming — setup not yet clear.";
      break;
    case "trade_active":
    case "management":
      setupRaw = 80;
      setupDetail = `Trade in progress (stage: ${setup.stage}) — chart is active.`;
      break;
    case "exit":
    case "review":
      setupRaw = 50;
      setupDetail = `Stage "${setup.stage}" — setup concluding.`;
      break;
    case "stale":
      setupRaw = 15;
      setupDetail = "Setup stale — decayed or expired opportunity.";
      break;
    case "invalid":
      setupRaw = 5;
      setupDetail = "Setup invalid — do not trade this read.";
      break;
    default:
      setupRaw = 30;
      setupDetail = "No active setup detected.";
  }
  if (setup.decayScore != null && setup.decayScore >= 80) {
    setupRaw = Math.min(setupRaw, 20);
    setupDetail += ` (decay ${setup.decayScore} — heavily decayed)`;
  }
  subMetrics.push(met("setup_maturity", "Setup Maturity", setupRaw, setupDetail));

  // ── 4. Candle Context (pressure + intent clarity) ─────────────────────────
  const ci = marketUnderstanding.candleIntent;
  if (!ci.populated) {
    subMetrics.push(met("candle_context", "Candle Context", 20, "Candle intent not populated."));
  } else {
    const clearIntent = ci.latestIntent !== "noise";
    const clearPressure = ci.dominantPressure !== "unknown" && ci.dominantPressure !== "balanced";
    const contextRaw =
      clearIntent && clearPressure ? 90
      : clearIntent || clearPressure ? 65
      : 30;
    subMetrics.push(met(
      "candle_context",
      "Candle Context",
      contextRaw,
      `Intent: ${ci.latestIntent}; pressure: ${ci.dominantPressure}.`,
    ));
  }

  // ── 5. Timeframe Context ──────────────────────────────────────────────────
  const tf = marketUnderstanding.timeframeAgreement;
  let tfRaw: number;
  let tfDetail: string;
  if (!tf.populated) {
    tfRaw = 40;
    tfDetail = "Timeframe agreement computing in background.";
  } else if (tf.scalpOnlyWarning) {
    tfRaw = 50;
    tfDetail = "Timeframe conflict — scalp only; do not hold.";
  } else {
    tfRaw = clamp(tf.agreementScore ?? 50);
    tfDetail = `Timeframe agreement ${tf.agreementScore ?? "N/A"} (${tf.alignedDirection}).`;
  }
  subMetrics.push(met("timeframe_context", "Timeframe Context", tfRaw, tfDetail));

  // ── 6. Volatility Readability ─────────────────────────────────────────────
  // Low ATR relative to range = choppy/unreadable; clear directional moves = readable.
  let volatilityRaw: number;
  let volatilityDetail: string;
  if (candleStats.atr == null || candleStats.avgRange == null || candleStats.avgRange === 0) {
    volatilityRaw = 50;
    volatilityDetail = "ATR/range not computed — defaulting to 50.";
  } else {
    // Body-to-range ratio: high = clear directional candles.
    const body = candleStats.body ?? 0;
    const range = candleStats.range ?? candleStats.avgRange;
    const bodyRatio = range > 0 ? body / range : 0;
    // Momentum burst check: recent range vs ATR.
    const rangeMomentum = candleStats.atr > 0 ? candleStats.avgRange / candleStats.atr : 1;
    volatilityRaw = clamp(
      bodyRatio * 50         // body ratio contributes up to 50
      + Math.min(rangeMomentum, 1) * 50, // momentum clarity contributes up to 50
    );
    volatilityDetail = `Body:range=${(bodyRatio * 100).toFixed(0)}%; avg-range/ATR=${rangeMomentum.toFixed(2)}.`;
  }
  subMetrics.push(met("volatility_readability", "Volatility Readability", volatilityRaw, volatilityDetail));

  // ── Aggregate — equal weight across 6 dimensions ─────────────────────────
  const rawSum = subMetrics.reduce((s, m) => s + m.rawScore, 0);
  let score = round(rawSum / subMetrics.length);

  // Hard floor: if feed not usable, chart is not readable for trading.
  if (!aiUsable) {
    score = Math.min(score, 30);
  }

  // Readiness score from Engine 6 acts as a reality check (soft cap when very low).
  if (readiness.populated && readiness.score != null && readiness.score < 25) {
    score = Math.min(score, 40);
  }

  const concern = subMetrics
    .filter((m) => m.rawScore < 40)
    .sort((a, b) => a.rawScore - b.rawScore);
  const primaryConcern = concern[0]?.detail ?? null;

  return {
    score,
    label: labelFor(score),
    subMetrics,
    primaryConcern,
    note: `Chart Read Score ${score} (${labelFor(score)}).`
      + (primaryConcern ? ` Primary concern: ${primaryConcern}` : ""),
  };
}
