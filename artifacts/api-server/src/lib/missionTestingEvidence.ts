import {
  summarizeMissionTest,
  summarizeRObservations,
  studentT975,
  roundRStat,
  type RObservationSummary,
  type MissionTestEvidence,
  type MissionTestKind,
  type MissionTestMetrics,
} from "@workspace/domain/profit-mission";
import type { BacktestRunMetrics, BacktestSimTrade } from "@workspace/domain/backtest";

export const GENERATED_PRICE_EVIDENCE: MissionTestEvidence = {
  version: 1, source: "generated_prices", validation: "unverified",
};
export const CLOSED_DRAFT_EVIDENCE: MissionTestEvidence = {
  version: 1, source: "closed_mission_drafts", validation: "unverified",
};

export function roundMetric(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round((Number.isFinite(value) ? value : 0) * scale) / scale;
}

/** Realised R for one simulated trade, or null when the initial stop risk is not
 * finite and positive or the P/L is not finite (those trades have no observed R). */
export function tradeRiskR(trade: BacktestSimTrade): number | null {
  const risk = Math.abs(trade.entryPrice - trade.stopLoss);
  return risk > 0 && Number.isFinite(risk) && Number.isFinite(trade.profitLoss)
    ? trade.profitLoss / risk : null;
}

/** Observed R values for the uncertainty record; excludedCount covers both a
 * non-positive/non-finite stop distance and a non-finite P/L. */
export function backtestRObservations(trades: BacktestSimTrade[]): { values: number[]; excludedCount: number } {
  const values: number[] = [];
  for (const trade of trades) {
    const r = tradeRiskR(trade);
    if (r != null) values.push(r);
  }
  return { values, excludedCount: trades.length - values.length };
}

export type RStatisticsRecord = { version: 1; excludedCount: number } & RObservationSummary;

/** Append-only experiment record: experiment.rStatistics. Never part of MissionTestMetrics. */
export function buildRStatisticsRecord(values: readonly number[], excludedCount: number): RStatisticsRecord {
  return { version: 1, excludedCount, ...summarizeRObservations(values) };
}

/** Realised simulated R uses the actual exit, including partial end-of-run moves.
 * These are gross price-unit returns: the current simulator has no cost model. */
export function backtestToMissionMetrics(
  metrics: BacktestRunMetrics, trades: BacktestSimTrade[], initialBalance: number,
): MissionTestMetrics {
  const riskReturns = trades.map((trade) => tradeRiskR(trade) ?? 0);
  const positiveReturns = riskReturns.filter((r) => r > 0);
  let peak = initialBalance;
  let drawdownPct = 0;
  for (const equity of metrics.equityCurve) {
    if (!Number.isFinite(equity)) continue;
    peak = Math.max(peak, equity);
    if (peak > 0) drawdownPct = Math.max(drawdownPct, (peak - equity) / peak * 100);
  }
  return {
    totalTrades: metrics.totalTrades,
    winningTrades: metrics.winningTrades,
    losingTrades: metrics.losingTrades,
    winRate: roundMetric(metrics.winRate),
    netProfitLoss: roundMetric(metrics.netProfitLoss, 2),
    maxDrawdownPct: roundMetric(drawdownPct, 2),
    averageRr: roundMetric(positiveReturns.length ? positiveReturns.reduce((a, b) => a + b, 0) / positiveReturns.length : 0),
    expectancyR: roundMetric(riskReturns.length ? riskReturns.reduce((a, b) => a + b, 0) / riskReturns.length : 0),
    profitFactor: roundMetric(Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : 999, 3),
  };
}

const EMPTY_METRICS: MissionTestMetrics = {
  totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, netProfitLoss: 0,
  maxDrawdownPct: 0, averageRr: 0, expectancyR: 0, profitFactor: 0,
};

export function readMissionMetrics(value: unknown): MissionTestMetrics | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(EMPTY_METRICS)) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) return null;
  }
  const m = raw as unknown as MissionTestMetrics;
  if (![m.totalTrades, m.winningTrades, m.losingTrades].every((n) => Number.isSafeInteger(n) && n >= 0)
    || m.winningTrades + m.losingTrades > m.totalTrades || m.winRate < 0 || m.winRate > 1
    || m.maxDrawdownPct < 0 || m.profitFactor < 0) return null;
  // Copy only the supported metrics; JSON fields and old eligibility flags are not authority.
  return Object.fromEntries(Object.keys(EMPTY_METRICS).map((key) => [key, raw[key]])) as unknown as MissionTestMetrics;
}

export interface StoredMissionTestResult {
  id: number; missionId: number; kind: string; strategyKey: string; symbol: string; timeframe: string;
  metricsJson: unknown; createdAt: Date;
}

/** Rebuild every read from supported evidence. Legacy labels/verified flags are not reused. */
export function projectMissionTestResult(row: StoredMissionTestResult) {
  const blob = row.metricsJson != null && typeof row.metricsJson === "object" && !Array.isArray(row.metricsJson)
    ? row.metricsJson as Record<string, unknown> : {};
  const parsed = readMissionMetrics(blob.metrics);
  const metrics = parsed ?? { ...EMPTY_METRICS };
  const kind: MissionTestKind = row.kind === "FORWARD" ? "FORWARD" : "BACKTEST";
  const summary = summarizeMissionTest({
    kind, strategyKey: row.strategyKey, symbol: row.symbol, timeframe: row.timeframe, metrics,
    evidence: blob.evidence as MissionTestEvidence | undefined,
  });
  const notes = [...summary.notes];
  let headline = summary.headline;
  let warning = summary.sampleWarning;
  if (!parsed) notes.unshift("Stored metrics are incomplete or invalid; they cannot be used as trading evidence.");
  if (summary.evidence.source === "generated_prices") notes.push("P/L is measured in unscaled price units, not account currency. Fees, spread and slippage are excluded.");
  const experiment = blob.experiment != null && typeof blob.experiment === "object"
    ? blob.experiment as Record<string, unknown> : {};
  // Forward R coverage; shared with the uncertainty record so the two notes cannot disagree.
  const rCoverageCount = summary.evidence.source === "closed_mission_drafts"
    && experiment.version === 1 && experiment.engine === "closed-draft-aggregate-v1"
    && experiment.closedDraftCount === metrics.totalTrades
    && typeof experiment.rObservedCount === "number" && Number.isSafeInteger(experiment.rObservedCount)
    && experiment.rObservedCount >= 0 && experiment.rObservedCount <= metrics.totalTrades
    ? experiment.rObservedCount : null;
  if (summary.evidence.source === "closed_mission_drafts") {
    const count = rCoverageCount;
    const coverage = count == null ? "Realised R coverage is unknown."
      : `Realised R is recorded for ${count} of ${metrics.totalTrades} closed trades.`;
    notes.push(coverage);
    if (count == null || count === 0 || count < metrics.totalTrades) {
      const detail = count != null && count > 0
        ? `observed-subset expectancy ${metrics.expectancyR.toFixed(2)}R (${count}/${metrics.totalTrades} R observations)`
        : "R metrics unavailable";
      headline = headline.replace(`expectancy ${metrics.expectancyR.toFixed(2)}R`, detail);
      notes.push("Missing R outcomes are not zero. Any reported R average covers only the observed subset, not all closed trades.");
      warning = [warning, coverage, "R metrics are incomplete."].filter(Boolean).join(" ");
    }
  }
  // listMissionTestResults maps every row through this projection, so an uncertainty
  // read that throws for one stored record must not break the whole history read:
  // that row reads the invalid-record note instead.
  let uncertaintyNote = R_UNAVAILABLE_INVALID;
  try {
    uncertaintyNote = rUncertaintyNote(readRStatistics({
      experiment, metrics, parsedOk: parsed != null, source: summary.evidence.source, coverageCount: rCoverageCount,
    }), summary.evidence.source);
  } catch { /* fail safe: the invalid-record note */ }
  notes.push(uncertaintyNote);
  return {
    id: row.id, missionId: row.missionId, kind,
    strategyKey: row.strategyKey, symbol: row.symbol, timeframe: row.timeframe,
    label: summary.label, sampleSize: summary.sampleSize, sampleWarning: warning,
    isVerified: false, metrics, headline, notes,
    promotionEligible: summary.promotionEligible, evidence: summary.evidence,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── R-expectancy sample uncertainty: validation of the stored record + note ───

const R_STATISTICS_ENGINE: Partial<Record<MissionTestEvidence["source"], string>> = {
  generated_prices: "generated-price-diagnostic-v1",
  closed_mission_drafts: "closed-draft-aggregate-v1",
};
const R_UNAVAILABLE_REASONS = new Set([
  "insufficient_observations", "non_finite_input", "non_finite_result", "interval_below_precision", "no_variation",
]);
const isPlainObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** Stored statistics are always 6-decimal rounded finite numbers. */
const isStored6 = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && roundRStat(v) === v;

/**
 * Accept experiment.rStatistics only when it is coherent with its own fields, the
 * producing engine, the R coverage count and the headline expectancy; otherwise
 * null (the row reads "uncertainty unavailable"). These checks catch incoherent or
 * edited records, not a forged record that is fully self-consistent: raw R values
 * are not stored. The only writer is persistTestResult in missionTestingLabService.
 */
export function readRStatistics(args: {
  experiment: Record<string, unknown>; metrics: MissionTestMetrics; parsedOk: boolean;
  source: MissionTestEvidence["source"]; coverageCount: number | null;
}): RStatisticsRecord | null {
  const { experiment, metrics, source, coverageCount } = args;
  if (!args.parsedOk || experiment.version !== 1) return null;
  const engine = R_STATISTICS_ENGINE[source];
  if (engine == null || experiment.engine !== engine) return null;
  const rs = experiment.rStatistics;
  if (!isPlainObject(rs) || rs.version !== 1 || !isCount(rs.n) || !isCount(rs.excludedCount)) return null;
  const n = rs.n;
  const excludedCount = rs.excludedCount;
  const total = metrics.totalTrades;
  if (source === "generated_prices") {
    if (n + excludedCount !== total) return null;
  } else if (coverageCount == null || n !== coverageCount || excludedCount !== total - coverageCount) return null;
  // Forward expectancyR is the mean of the same subset; the backtest headline counts
  // excluded trades as exactly 0R, so it equals mean·n/totalTrades.
  const agreesWithHeadline = (mean: number) => source === "closed_mission_drafts"
    ? Math.abs(mean - metrics.expectancyR) <= 1e-4
    : total > 0 && Math.abs(mean * n / total - metrics.expectancyR) <= 1e-4;

  if (rs.status === "available") {
    const iv = rs.interval95;
    if (n < 2 || !isPlainObject(iv) || iv.method !== "student_t") return null;
    const { mean, sampleSd, standardError, includesZero } = rs;
    const { low, high } = iv;
    const degreesOfFreedom = n - 1;
    const quantile = studentT975(degreesOfFreedom);
    if (!isStored6(mean) || !isStored6(sampleSd) || !isStored6(standardError) || !isStored6(low) || !isStored6(high)) return null;
    if (rs.degreesOfFreedom !== degreesOfFreedom || rs.quantile !== quantile || typeof includesZero !== "boolean") return null;
    if (!(sampleSd > 0 && standardError >= 0 && low <= mean && mean <= high && high > low)) return null;
    if (Math.abs(standardError - sampleSd / Math.sqrt(n)) > 1.5e-6) return null;
    // Rounding error on a bound: 0.5e-6 (mean) + q·0.5e-6 (SE) + 0.5e-6 (bound).
    const tolerance = (2 + quantile) * 1e-6;
    if (Math.abs(low - (mean - quantile * standardError)) > tolerance
      || Math.abs(high - (mean + quantile * standardError)) > tolerance) return null;
    if (!agreesWithHeadline(mean)) return null;
    if (includesZero !== (low <= 0 && high >= 0)) return null;
    return {
      version: 1, excludedCount, status: "available", n, mean, sampleSd, standardError,
      degreesOfFreedom, quantile, interval95: { low, high, method: "student_t" }, includesZero,
    };
  }
  if (rs.status !== "unavailable" || typeof rs.reason !== "string" || !R_UNAVAILABLE_REASONS.has(rs.reason)) return null;
  const reason = rs.reason as Exclude<RObservationSummary, { status: "available" }>["reason"];
  if (reason === "insufficient_observations") {
    return n < 2 ? { version: 1, excludedCount, status: "unavailable", n, reason } : null;
  }
  if (reason === "no_variation") {
    const value = rs.value;
    return n >= 2 && isStored6(value) && agreesWithHeadline(value)
      ? { version: 1, excludedCount, status: "unavailable", n, reason, value } : null;
  }
  if (reason === "interval_below_precision" || reason === "non_finite_result") {
    return n >= 2 ? { version: 1, excludedCount, status: "unavailable", n, reason } : null;
  }
  return n >= 1 ? { version: 1, excludedCount, status: "unavailable", n, reason } : null;
}

/** Fixed decimals without a negative sign on an all-zero result ("-0.00" never prints). */
function fmtR(x: number, digits: number): string {
  const text = x.toFixed(digits);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const R_UNAVAILABLE_INVALID = "R uncertainty unavailable: no valid sample statistics are stored for this record; no interval is reported.";

/** Exactly one uncertainty note per projected row; never the word "confidence". */
export function rUncertaintyNote(record: RStatisticsRecord | null, source: MissionTestEvidence["source"]): string {
  if (record == null) return R_UNAVAILABLE_INVALID;
  const exclusion = source === "generated_prices" && record.excludedCount > 0
    ? `${plural(record.excludedCount, "trade", "trades")} without positive stop distance excluded (this count also covers any non-finite P/L)`
    : null;
  if (record.status === "unavailable") {
    let text: string;
    if (record.reason === "no_variation") {
      const digits = [2, 4, 6].find((d) => Number(fmtR(record.value, d)) === record.value) ?? 6;
      text = `R uncertainty unavailable: all ${record.n} observed R values equal ${fmtR(record.value, digits)}R; no interval is reported.`;
    } else if (record.reason === "interval_below_precision") {
      text = `R uncertainty unavailable: the ${record.n} observed R values vary by less than the stored 6-decimal precision; no interval is reported.`;
    } else if (record.reason === "insufficient_observations") {
      text = `R uncertainty unavailable: ${record.n === 1 ? "only 1 observed R value" : "no observed R values"}; at least 2 are needed; no interval is reported.`;
    } else return R_UNAVAILABLE_INVALID;
    return exclusion ? `${text} ${exclusion[0]!.toUpperCase()}${exclusion.slice(1)}; the headline expectancy counts those trades as 0R.` : text;
  }
  const { low, high } = record.interval95;
  const digits = [2, 4, 6].find((d) => fmtR(low, d) !== fmtR(high, d));
  if (digits == null) return R_UNAVAILABLE_INVALID;
  const se = record.standardError;
  const seText = se === 0 ? "below 0.000001R"
    : `${Number(fmtR(se, digits)) !== 0 ? fmtR(se, digits) : fmtR(se, 6)}R`;
  const qualifier = source === "generated_prices" ? "(gross, before costs)" : "(costs unverified)";
  const df = record.degreesOfFreedom;
  let text = `R sample interval (95%, Student t, ${plural(df, "degree", "degrees")} of freedom): `
    + `${fmtR(low, digits)}R to ${fmtR(high, digits)}R around a mean of ${fmtR(record.mean, digits)}R `
    + `over ${record.n} observed R values (standard error ${seText}). `
    + "Assumes independent, identically distributed trade outcomes; a sample interval, not a forecast.";
  // From the validated bounds, never the stored flag alone.
  text += low <= 0 && high >= 0
    ? ` The interval includes 0R, so this sample does not distinguish the sample mean from 0R ${qualifier}.`
    : ` The interval excludes 0R ${qualifier}, which does not validate an edge: costs, execution and out-of-sample validation are not established.`;
  if (exclusion) {
    text += ` Mean over ${plural(record.n, "observed trade", "observed trades")}; ${exclusion}. `
      + "The headline expectancy counts those trades as 0R, so it can differ from this mean.";
  }
  return text;
}
