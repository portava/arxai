import {
  summarizeMissionTest,
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

/** Realised simulated R uses the actual exit, including partial end-of-run moves.
 * These are gross price-unit returns: the current simulator has no cost model. */
export function backtestToMissionMetrics(
  metrics: BacktestRunMetrics, trades: BacktestSimTrade[], initialBalance: number,
): MissionTestMetrics {
  const riskReturns = trades.map((trade) => {
    const risk = Math.abs(trade.entryPrice - trade.stopLoss);
    return risk > 0 && Number.isFinite(risk) && Number.isFinite(trade.profitLoss)
      ? trade.profitLoss / risk : 0;
  });
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
  if (summary.evidence.source === "closed_mission_drafts") {
    const experiment = blob.experiment != null && typeof blob.experiment === "object"
      ? blob.experiment as Record<string, unknown> : {};
    const count = experiment.version === 1 && experiment.engine === "closed-draft-aggregate-v1"
      && experiment.closedDraftCount === metrics.totalTrades
      && typeof experiment.rObservedCount === "number" && Number.isSafeInteger(experiment.rObservedCount)
      && experiment.rObservedCount >= 0 && experiment.rObservedCount <= metrics.totalTrades
      ? experiment.rObservedCount : null;
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
  return {
    id: row.id, missionId: row.missionId, kind,
    strategyKey: row.strategyKey, symbol: row.symbol, timeframe: row.timeframe,
    label: summary.label, sampleSize: summary.sampleSize, sampleWarning: warning,
    isVerified: false, metrics, headline, notes,
    promotionEligible: summary.promotionEligible, evidence: summary.evidence,
    createdAt: row.createdAt.toISOString(),
  };
}
