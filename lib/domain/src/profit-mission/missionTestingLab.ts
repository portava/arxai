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
  /** P/L in the producer's declared units; generated runs use gross price units. */
  netProfitLoss: number;
  /** Maximum peak-relative realised drawdown, non-negative percentage. */
  maxDrawdownPct: number;
  /** Average realised R among profitable trades. */
  averageRr: number;
  /** Expectancy in R per trade. */
  expectancyR: number;
  /** Profit factor (gross win / gross loss); 0 when undefined. */
  profitFactor: number;
}

export type MissionTestKind = "BACKTEST" | "FORWARD";

/** Honest label for each result kind — never implies live unless truly forward-live. */
export const MISSION_TEST_LABEL: Record<MissionTestKind, string> = {
  BACKTEST: "Backtest — source unverified",
  FORWARD: "Forward — execution mode unverified",
};

// Minimum sample sizes a result must reach before it counts toward promotion.
// Below these, the result is shown with an explicit small-sample warning and the
// promotion gate treats the corresponding gate as NOT satisfied.
export const MISSION_TEST_MIN_SAMPLES: Record<MissionTestKind, number> = {
  BACKTEST: 30,
  FORWARD: 20,
};

/** Current producers have no independently validated market/transaction record.
 * A new verified producer must supply an audited contract before promotion can use it.
 * These values are evidence descriptions, never client-supplied authorizations. */
export interface MissionTestEvidence {
  version: 1;
  source: "generated_prices" | "closed_mission_drafts" | "unknown";
  validation: "unverified";
}

export function normalizeMissionTestEvidence(value: unknown, kind: MissionTestKind): MissionTestEvidence {
  const raw = value != null && typeof value === "object" ? value as Record<string, unknown> : {};
  const source = raw.version === 1 && raw.validation === "unverified" && (
    (kind === "BACKTEST" && raw.source === "generated_prices") ||
    (kind === "FORWARD" && raw.source === "closed_mission_drafts")
  ) ? raw.source as MissionTestEvidence["source"] : "unknown";
  return { version: 1, source, validation: "unverified" };
}

export function labelForKind(kind: MissionTestKind, evidence?: MissionTestEvidence): string {
  const source = normalizeMissionTestEvidence(evidence, kind).source;
  if (source === "generated_prices") return "Generated-price simulation";
  if (source === "closed_mission_drafts") return "Closed mission drafts — execution mode unverified";
  return MISSION_TEST_LABEL[kind];
}

export function minSamplesForKind(kind: MissionTestKind): number {
  return MISSION_TEST_MIN_SAMPLES[kind];
}

/** A product minimum only; sample size alone does not establish statistical significance. */
export function hasSufficientSample(kind: MissionTestKind, sampleSize: number): boolean {
  return Number.isSafeInteger(sampleSize) && sampleSize >= MISSION_TEST_MIN_SAMPLES[kind];
}

/** Honest small-sample warning string, or null when the sample is sufficient. */
export function sampleWarning(kind: MissionTestKind, sampleSize: number): string | null {
  const min = MISSION_TEST_MIN_SAMPLES[kind];
  if (hasSufficientSample(kind, sampleSize)) return null;
  return `Small sample: ${Number.isFinite(sampleSize) ? Math.max(0, Math.trunc(sampleSize)) : 0} trade(s) — at least ${min} are required by the minimum-sample rule. This threshold does not establish statistical significance.`;
}

export interface MissionTestSummaryInput {
  kind: MissionTestKind;
  strategyKey: string;
  symbol: string;
  timeframe: string;
  metrics: MissionTestMetrics;
  evidence?: MissionTestEvidence;
}

export interface MissionTestSummary {
  kind: MissionTestKind;
  evidence: MissionTestEvidence;
  label: string;
  sampleSize: number;
  sampleSufficient: boolean;
  sampleWarning: string | null;
  /** Validated evidence is required in addition to sample size and positive results. */
  promotionEligible: boolean;
  headline: string;
  notes: string[];
}

/**
 * Build a labelled diagnostic summary of one test result.
 * Minimum sample size and positive gross metrics do not verify a strategy.
 * Current generated-price and unreconciled-draft producers are diagnostics only.
 * No current producer establishes costs, execution identity, and independent
 * chronological validation, so neither can authorize promotion.
 */
export function summarizeMissionTest(input: MissionTestSummaryInput): MissionTestSummary {
  const m = input.metrics;
  const sampleSize = Number.isSafeInteger(m.totalTrades) && m.totalTrades >= 0 ? m.totalTrades : 0;
  const evidence = normalizeMissionTestEvidence(input.evidence, input.kind);
  const label = labelForKind(input.kind, evidence);
  const sufficient = hasSufficientSample(input.kind, sampleSize);
  const positiveEdge = m.expectancyR > 0 && m.profitFactor > 1;
  const promotionEligible = false;
  const evidenceNote = evidence.source === "generated_prices"
    ? "Generated prices are diagnostic data, not observed market history. Costs and chronological out-of-sample validation are not modelled. Excluded from promotion and strategy-drift evidence."
    : evidence.source === "closed_mission_drafts"
      ? "Closed draft outcomes have not been reconciled to execution mode, complete realised risk, and net trading costs. Excluded from promotion and strategy-drift evidence."
      : "This stored result has no supported evidence provenance. Previous verified or eligible flags are not proof. Excluded from promotion and strategy-drift evidence.";

  const notes: string[] = [evidenceNote];
  if (sufficient) notes.push("Minimum sample threshold met; this does not establish statistical significance or a validated edge.");
  const warn = sampleWarning(input.kind, sampleSize);
  if (warn) notes.push(warn);
  if (!positiveEdge) {
    notes.push("No positive edge in this sample — expectancy and profit factor must both clear breakeven.");
  }
  notes.push("Past results are an estimate only and do not predict future outcomes; losses are possible.");

  const winPct = (m.winRate * 100).toFixed(1);
  const headline =
    `${label} — ${input.strategyKey} on ${input.symbol} ${input.timeframe}: ` +
    `${sampleSize} trades, ${winPct}% win rate, expectancy ${m.expectancyR.toFixed(2)}R, ` +
    `profit factor ${m.profitFactor.toFixed(2)}, max drawdown ${m.maxDrawdownPct.toFixed(1)}%.`;

  return {
    kind: input.kind,
    evidence,
    label,
    sampleSize,
    sampleSufficient: sufficient,
    sampleWarning: warn,
    promotionEligible,
    headline,
    notes,
  };
}

// ── R-expectancy sample uncertainty (n, SD, standard error, 95% interval) ─────
//
// Pure, deterministic, IO-free. Describes how much the sample mean of observed R
// values could move under resampling. It assumes independent, identically
// distributed trade outcomes (often false for trade sequences, which makes the
// interval too narrow) and is a sample interval, not a forecast, a validation of
// an edge or a statement about future returns.
//
// Method: two-sided 95% Student t interval, mean ± t(0.975, n-1) · s/√n, with an
// embedded quantile table. Degrees of freedom between table rows step DOWN to the
// nearest tabulated row, which gives a wider (conservative) interval.
//
// Deliberate deviation from the item-9 spec (which says "available for n>=2"):
// the spec also forbids a zero-width interval, so identical observed values
// ("no_variation", e.g. every trade at exactly +1R) and variation below the stored
// 6-decimal precision ("interval_below_precision") are reported as unavailable
// even when n>=2. The record also carries status, degreesOfFreedom and quantile
// in addition to the spec's keys. Non-finite inputs are rejected, never coerced.

/** Student t 0.975 quantiles (two-sided 95%), rounded to 6 decimals. */
export const STUDENT_T_975: ReadonlyArray<readonly [df: number, quantile: number]> = [
  [1, 12.706205], [2, 4.302653], [3, 3.182446], [4, 2.776445], [5, 2.570582],
  [6, 2.446912], [7, 2.364624], [8, 2.306004], [9, 2.262157], [10, 2.228139],
  [11, 2.200985], [12, 2.178813], [13, 2.160369], [14, 2.144787], [15, 2.131450],
  [16, 2.119905], [17, 2.109816], [18, 2.100922], [19, 2.093024], [20, 2.085963],
  [21, 2.079614], [22, 2.073873], [23, 2.068658], [24, 2.063899], [25, 2.059539],
  [26, 2.055529], [27, 2.051831], [28, 2.048407], [29, 2.045230], [30, 2.042272],
  [40, 2.021075], [50, 2.008559], [60, 2.000298], [80, 1.990063], [100, 1.983972],
  [120, 1.979930], [200, 1.971896], [500, 1.964720], [1000, 1.962339],
];

/** t(0.975, df) from the embedded table, stepping down to the largest tabulated df <= input. */
export function studentT975(df: number): number {
  if (!Number.isSafeInteger(df) || df < 1) throw new RangeError(`studentT975: df must be a positive integer, got ${df}`);
  let quantile = STUDENT_T_975[0]![1];
  for (const [rowDf, q] of STUDENT_T_975) {
    if (rowDf > df) break;
    quantile = q;
  }
  return quantile;
}

/** Round to the stored 6-decimal precision; -0 becomes 0. Finite inputs only. */
export function roundRStat(x: number): number {
  const r = Math.round(x * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

export type RObservationUnavailableReason =
  | "insufficient_observations" | "non_finite_input" | "non_finite_result" | "interval_below_precision";

export type RObservationSummary =
  | {
    status: "available"; n: number; mean: number; sampleSd: number; standardError: number;
    degreesOfFreedom: number; quantile: number;
    interval95: { low: number; high: number; method: "student_t" };
    includesZero: boolean;
  }
  | { status: "unavailable"; n: number; reason: RObservationUnavailableReason }
  | { status: "unavailable"; n: number; reason: "no_variation"; value: number };

/**
 * Summarise observed R values with a 95% Student t sample interval.
 * Available only when n>=2, every value is finite, the sample varies and the
 * rounded bounds differ; otherwise unavailable with a reason (never zero width).
 */
export function summarizeRObservations(values: readonly number[]): RObservationSummary {
  const n = values.length;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) return { status: "unavailable", n, reason: "non_finite_input" };
  }
  if (n < 2) return { status: "unavailable", n, reason: "insufficient_observations" };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  if (!Number.isFinite(mean) || !Number.isFinite(ss)) return { status: "unavailable", n, reason: "non_finite_result" };
  // Identical values are "no_variation" even when the float mean is off by an ulp
  // (three 0.1 values sum to 0.30000000000000004), which leaves ss tiny but non-zero.
  // Distinct values whose ss underflows to 0 reach interval_below_precision below.
  if (values.every((v) => v === values[0])) return { status: "unavailable", n, reason: "no_variation", value: roundRStat(values[0]!) };
  const sd = Math.sqrt(ss / (n - 1));
  const se = sd / Math.sqrt(n);
  const degreesOfFreedom = n - 1;
  const quantile = studentT975(degreesOfFreedom);
  const low = mean - quantile * se;
  const high = mean + quantile * se;
  if (![sd, se, low, high].every(Number.isFinite)) return { status: "unavailable", n, reason: "non_finite_result" };
  const r = {
    mean: roundRStat(mean), sampleSd: roundRStat(sd), standardError: roundRStat(se),
    low: roundRStat(low), high: roundRStat(high),
  };
  // A stored SD of 0 or equal stored bounds would read as a zero-width interval.
  if (r.sampleSd <= 0 || r.high <= r.low) return { status: "unavailable", n, reason: "interval_below_precision" };
  return {
    status: "available", n, mean: r.mean, sampleSd: r.sampleSd, standardError: r.standardError,
    degreesOfFreedom, quantile,
    interval95: { low: r.low, high: r.high, method: "student_t" },
    includesZero: r.low <= 0 && r.high >= 0,
  };
}
