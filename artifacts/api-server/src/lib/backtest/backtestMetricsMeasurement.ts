// Whether a stored backtest run's aggregate metrics were actually measured.
//
// The backtest_runs metric columns default to 0, and the INSUFFICIENT_DATA
// broker path inserts a row without running a simulation at all. A run with no
// completed simulated trades (or one that never finished) therefore carries
// finite zeros that are NOT observations: win rate, P&L, drawdown, R:R,
// expectancy and profit factor are undefined when nothing traded.
//
// The numeric fields keep their stored values (the API contract types them as
// numbers); this statement rides alongside so every consumer — the dashboard,
// the assistant, exports — can tell a placeholder from a result. Pure,
// DB-free, display-only: it never changes a stored row or any gate.

export const BACKTEST_AGGREGATE_METRIC_FIELDS = [
  "winningTrades", "losingTrades", "netProfitLoss", "maxDrawdown",
  "winRate", "averageRr", "expectancy", "profitFactor",
] as const;

export interface BacktestMetricsMeasurement {
  /** True only for a COMPLETED run with at least one completed simulated trade. */
  measured: boolean;
  /** Metric fields whose stored values are placeholders, not results ([] when measured). */
  unmeasuredFields: string[];
  /** Plain-English reason the metrics were not measured; null when they were. */
  note: string | null;
}

const PLACEHOLDER =
  "The zeros in those fields are placeholders, not results.";
const METRICS_LIST = "win rate, P&L, drawdown, R:R, expectancy and profit factor";

export function backtestMetricsMeasurement(run: { status?: unknown; totalTrades?: unknown }): BacktestMetricsMeasurement {
  const trades = typeof run.totalTrades === "number" && Number.isFinite(run.totalTrades) ? run.totalTrades : null;
  let note: string | null = null;
  if (run.status === "INSUFFICIENT_DATA") {
    note = `There was not enough data for this run to complete any simulated trades, so ${METRICS_LIST} were not measured. ${PLACEHOLDER}`;
  } else if (run.status !== "COMPLETED") {
    note = `This run did not finish (status ${typeof run.status === "string" ? run.status : "unknown"}), so ${METRICS_LIST} were not measured. ${PLACEHOLDER}`;
  } else if (trades == null || trades <= 0) {
    note = `This run completed no simulated trades, so ${METRICS_LIST} were not measured. ${PLACEHOLDER}`;
  }
  return note == null
    ? { measured: true, unmeasuredFields: [], note: null }
    : { measured: false, unmeasuredFields: [...BACKTEST_AGGREGATE_METRIC_FIELDS], note };
}
