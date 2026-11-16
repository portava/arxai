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
