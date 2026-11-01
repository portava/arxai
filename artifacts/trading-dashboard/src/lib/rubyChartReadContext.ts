import { parseChartInterval } from "./chart-engine/chartIntervals";

export interface RubyChartReadContext { symbol: string; timeframe: string }

/** UI market identity only. Preserve broker suffixes and unknown intervals;
 * never guess a market alias or replace an unknown interval with a default. */
export function rubyChartReadContext(symbol: string, timeframe: string): RubyChartReadContext {
  return {
    symbol: symbol.trim().toUpperCase(),
    timeframe: parseChartInterval(timeframe) ?? timeframe.trim(),
  };
}

export function rubyChartReadKey(symbol: string, timeframe: string): string {
  const context = rubyChartReadContext(symbol, timeframe);
  return JSON.stringify([context.symbol, context.timeframe]);
}

/** Match the endpoint's echoed market to the requested UI market. This does
 * not establish candle source, account, window, observation age or correctness. */
export function matchesRubyChartReadContext(value: Record<string, unknown>, expected: RubyChartReadContext): boolean {
  if (typeof value.symbol !== "string" || !value.symbol.trim()
    || typeof value.timeframe !== "string" || !value.timeframe.trim()) return false;
  const wanted = rubyChartReadContext(expected.symbol, expected.timeframe);
  const actual = rubyChartReadContext(value.symbol, value.timeframe);
  if (!wanted.symbol || !wanted.timeframe || actual.symbol !== wanted.symbol || actual.timeframe !== wanted.timeframe) return false;
  // Unknown intervals can return an explicit refusal, never an affirmative read.
  return parseChartInterval(wanted.timeframe) !== null || value.gated === true;
}
