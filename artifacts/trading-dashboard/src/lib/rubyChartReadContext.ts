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


export interface RubyChartDraft { side: "BUY" | "SELL"; entry: number; sl: number; tp: number }

/** Exact submitted-plan identity only: never rounds prices or turns nonfinite
 * numbers into JSON null. This establishes no account, feed or age authority. */
export function rubyChartDraftKey(draft: RubyChartDraft | null): string | null {
  if (draft === null) return "null";
  if (!draft || (draft.side !== "BUY" && draft.side !== "SELL")
    || ![draft.entry, draft.sl, draft.tp].every(value => typeof value === "number" && Number.isFinite(value))) return null;
  return JSON.stringify([draft.side, ...[draft.entry, draft.sl, draft.tp].map(value => Object.is(value, -0) ? "-0" : value)]);
}

export function rubyChartReadPlanKey(symbol: string, timeframe: string, draft: RubyChartDraft | null): string | null {
  const plan = rubyChartDraftKey(draft);
  if (plan === null) return null;
  const market = rubyChartReadKey(symbol, timeframe);
  // The legacy API remains a chart-only (no draft) assessment.
  return draft === null ? market : JSON.stringify(["plan", market, plan]);
}
