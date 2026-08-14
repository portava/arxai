// Profit Mission Phase 9 — Testing Lab labels, sample-size honesty & summaries.
//
// PLANNING / DISPLAY ONLY. This module normalizes backtest (historical/simulated)
// and forward-test (paper/demo/live) results into one honest, labelled shape with
// sample-size warnings. It is pure, deterministic, IO-free. Results are ADVISORY:
// they can describe a strategy's record, never grant live permission or bypass any
// live execution gate. Forward results must come from REAL executed-trade evidence
// — this module never fabricates a forward record.

/** Normalized metric shape shared by the lab, drift detector, and promotion gate. */
export interface MissionTestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  /** Win rate as a fraction 0..1. */
  winRate: number;
  /** Net realised P/L over the sample (account currency or R-normalised). */
  netProfitLoss: number;
  /** Max drawdown as a non-negative percentage (0..100). */
  maxDrawdownPct: number;
  /** Average reward-to-risk realised. */
  averageRr: number;
  /** Expectancy in R per trade. */
  expectancyR: number;
  /** Profit factor (gross win / gross loss); 0 when undefined. */
  profitFactor: number;
}

export type MissionTestKind = "BACKTEST" | "FORWARD";

/** Honest label for each result kind — never implies live unless truly forward-live. */
export const MISSION_TEST_LABEL: Record<MissionTestKind, string> = {
  BACKTEST: "Historical / simulated",
  FORWARD: "Forward (paper / demo / live)",
};

// Minimum sample sizes a result must reach before it counts toward promotion.
// Below these, the result is shown with an explicit small-sample warning and the
// promotion gate treats the corresponding gate as NOT satisfied.
export const MISSION_TEST_MIN_SAMPLES: Record<MissionTestKind, number> = {
  BACKTEST: 30,
  FORWARD: 20,
};

export function labelForKind(kind: MissionTestKind): string {
  return MISSION_TEST_LABEL[kind];
}

export function minSamplesForKind(kind: MissionTestKind): number {
  return MISSION_TEST_MIN_SAMPLES[kind];
}

/** True once the result has enough trades to be statistically meaningful. */
export function hasSufficientSample(kind: MissionTestKind, sampleSize: number): boolean {
  return Number.isFinite(sampleSize) && sampleSize >= MISSION_TEST_MIN_SAMPLES[kind];
}

/** Honest small-sample warning string, or null when the sample is sufficient. */
export function sampleWarning(kind: MissionTestKind, sampleSize: number): string | null {
  const min = MISSION_TEST_MIN_SAMPLES[kind];
  if (hasSufficientSample(kind, sampleSize)) return null;
  return `Small sample: ${Math.max(0, Math.trunc(sampleSize))} trade(s) — at least ${min} are needed before this result is meaningful. Treat it as a low-confidence estimate, not proof.`;
}

export interface MissionTestSummaryInput {
  kind: MissionTestKind;
  strategyKey: string;
  symbol: string;
  timeframe: string;
  metrics: MissionTestMetrics;
}

export interface MissionTestSummary {
  kind: MissionTestKind;
  label: string;
  sampleSize: number;
  sampleSufficient: boolean;
  sampleWarning: string | null;
  /** Eligible-for-promotion verdict for THIS result (sample + positive edge). */
  promotionEligible: boolean;
  headline: string;
  notes: string[];
}

/**
 * Build an honest, banned-vocabulary-clean summary of one test result. A result is
 * "promotionEligible" only when it has a sufficient sample AND a positive edge
 * (expectancy > 0 and profit factor > 1) — and even then it is advisory input to
 * the promotion gate, never a grant.
 */
export function summarizeMissionTest(input: MissionTestSummaryInput): MissionTestSummary {
  const m = input.metrics;
  const sampleSize = Math.max(0, Math.trunc(m.totalTrades));
  const sufficient = hasSufficientSample(input.kind, sampleSize);
  const positiveEdge = m.expectancyR > 0 && m.profitFactor > 1;
  const promotionEligible = sufficient && positiveEdge;

  const notes: string[] = [];
  const warn = sampleWarning(input.kind, sampleSize);
  if (warn) notes.push(warn);
  if (!positiveEdge) {
    notes.push("No positive edge in this sample — expectancy and profit factor must both clear breakeven.");
  }
  notes.push("Past results are an estimate only and do not predict future outcomes; losses are possible.");

  const winPct = (m.winRate * 100).toFixed(1);
  const headline =
    `${MISSION_TEST_LABEL[input.kind]} — ${input.strategyKey} on ${input.symbol} ${input.timeframe}: ` +
    `${sampleSize} trades, ${winPct}% win rate, expectancy ${m.expectancyR.toFixed(2)}R, ` +
    `profit factor ${m.profitFactor.toFixed(2)}, max drawdown ${m.maxDrawdownPct.toFixed(1)}%.`;

  return {
    kind: input.kind,
    label: MISSION_TEST_LABEL[input.kind],
    sampleSize,
    sampleSufficient: sufficient,
    sampleWarning: warn,
    promotionEligible,
    headline,
    notes,
  };
}
