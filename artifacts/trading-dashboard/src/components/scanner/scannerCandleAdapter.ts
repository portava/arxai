// Pure candle adapter for the Scanner chart.
//
// GET /api/chart/candles returns NormalizedChartCandle bars whose time lives in
// the ISO `openTime` / `closeTime` strings — there is NO numeric `time` field.
// Older / bare provider shapes may instead carry a numeric `time` (ms) or
// `timestamp`. This adapter resolves ALL of those shapes to epoch
// MILLISECONDS (the chart layer later does `time / 1000`).
//
// Regression guard (Task #367): the chart silently went blank for every symbol
// when the adapter only read a numeric `time` field — every NormalizedChartCandle
// parsed to NaN and was filtered out, so a healthy backend still showed
// "No live candles". `scannerCandleAdapter.test.ts` locks both shapes in.

export type Candle = { time: number; open: number; high: number; low: number; close: number };

/**
 * Map raw candle objects (from /api/chart/candles, in either the
 * NormalizedChartCandle ISO shape or a legacy numeric-`time` shape) to the
 * chart's internal {time: epoch-ms, open, high, low, close} shape, dropping
 * any bar that fails to parse to a finite time or has a non-positive open.
 */
export function adaptChartCandles(arr: ReadonlyArray<Record<string, unknown>>): Candle[] {
  return arr
    .map((c) => ({
      // NormalizedChartCandle carries the ISO `openTime` (with `closeTime` as
      // the close); older/bare shapes may carry a numeric `time` (ms) or
      // `timestamp`. Resolve all of them to epoch MILLISECONDS.
      time:
        typeof c.time === "number"
          ? c.time
          : new Date(String(c.openTime ?? c.closeTime ?? c.time ?? c.timestamp ?? "")).getTime(),
      open: Number(c.open ?? 0),
      high: Number(c.high ?? 0),
      low: Number(c.low ?? 0),
      close: Number(c.close ?? 0),
    }))
    .filter((c) => Number.isFinite(c.time) && c.open > 0);
}
