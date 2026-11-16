// Whether a backtest run's aggregate metrics were actually measured.
//
// The backtest_runs schema defaults every metric column to 0, and the
// INSUFFICIENT_DATA broker path inserts a row without running a simulation at
// all. A run with no completed simulated trades therefore carries finite zeros
// that are NOT observations: win rate, profit factor, P&L, expectancy, R:R and
// drawdown are undefined when nothing traded. This helper only ever DOWNGRADES
// what the server returned to "Not measured"; it never invents a value.

export const BACKTEST_NOT_MEASURED = "Not measured";

export function backtestMetricsUnmeasured(run: { status?: unknown; totalTrades?: unknown }): boolean {
  if (run.status === "INSUFFICIENT_DATA") return true;
  return typeof run.totalTrades === "number" && Number.isFinite(run.totalTrades) && run.totalTrades === 0;
}
