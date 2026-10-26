import { formatBacktestPriceUnits, formatBacktestPercent, formatBacktestProfitFactor } from "./format.js";

/** Current legacy OHLC runs are diagnostic observations, never verification.
 * Stored labels and caller-supplied evidence cannot upgrade this producer.
 * A future verified producer must have its own persisted experiment contract.
 */
export interface BacktestEvidence {
  version: 1;
  classification: "diagnostic";
  verification: "unverified";
  comparisonEligible: false;
  source: "generated_prices" | "unattested_broker_history" | "unknown";
  pnlUnit: "price_units";
  costs: "not_modelled";
  holdout: "not_recorded";
  limitations: string[];
}

export function backtestEvidence(dataSource: unknown): BacktestEvidence {
  const source = dataSource === "synthetic" ? "generated_prices"
    : dataSource === "broker" ? "unattested_broker_history" : "unknown";
  return {
    version: 1, classification: "diagnostic", verification: "unverified",
    comparisonEligible: false, source, pnlUnit: "price_units",
    costs: "not_modelled", holdout: "not_recorded",
    limitations: [
      source === "generated_prices" ? "Prices were generated, not observed market history."
        : source === "unattested_broker_history" ? "Historical source and account identity were not preserved for this run."
          : "The historical price source is unknown.",
      "Fills are a simplified OHLC simulation; fees, spreads, slippage and liquidity are not modelled.",
      "P&L is an unscaled price difference, not account currency.",
      "No immutable experiment record or chronological holdout is attached.",
    ],
  };
}

export function backtestSourceLabel(dataSource: unknown): string {
  return dataSource === "synthetic" ? "Generated prices"
    : dataSource === "broker" ? "Broker history · identity unverified" : "Source unknown";
}

export interface BacktestSummaryInput {
  strategyId: string; symbol: string; timeframe: string;
  totalTrades: number; winRate: number; profitFactor: number; netProfitLoss: number;
  dataSource?: unknown; status?: unknown;
}

export function backtestDiagnosticSummary(run: BacktestSummaryInput): string {
  const evidence = backtestEvidence(run.dataSource);
  const measured = [run.totalTrades, run.winRate, run.profitFactor, run.netProfitLoss].every(Number.isFinite);
  const observations = run.status === "INSUFFICIENT_DATA" && run.totalTrades === 0
    ? "Insufficient data; no completed simulated trades."
    : measured ? `${run.totalTrades} simulated trades; win rate ${formatBacktestPercent(run.winRate)}; gross P&L ${formatBacktestPriceUnits(run.netProfitLoss)} price units; profit factor ${formatBacktestProfitFactor(run.profitFactor)}.`
      : "Some recorded metrics are unavailable.";
  return `Diagnostic only — ${run.strategyId} on ${run.symbol} (${run.timeframe}). ${observations} ${evidence.limitations.join(" ")} Past performance does not guarantee future results.`;
}

/** Read projection preserves the database row, but never republishes its old
 * VERIFIED flag, prose, or an injected evidence object as current authority. */
export function projectBacktestRun<T extends BacktestSummaryInput>(run: T) {
  return {
    ...run,
    isVerified: "UNVERIFIED" as const,
    evidence: backtestEvidence(run.dataSource),
    aiSummary: backtestDiagnosticSummary(run),
  };
}
