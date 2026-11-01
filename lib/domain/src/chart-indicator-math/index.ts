/** Exact checkpoint arithmetic shared by Smart Chart and historical research.
 * No source selection or validation policy: callers supply validated numbers.
 * Missing input resets the warmup; EMA/Wilder seed from a full simple mean. */
export type AverageMethod = "sma" | "ema" | "smma" | "wma";
export interface SeededAverageState { input: number | null; count: number; sum: number; weighted: number; value: number | null }
export function advanceStudyAverage(input: number | null, period: number, method: AverageMethod,
  prior: SeededAverageState | undefined, expired: number): SeededAverageState {
  const count = input == null ? 0 : (prior?.count ?? 0) + 1;
  const sum = input == null ? 0 : (prior?.sum ?? 0) + input - (count > period ? expired : 0);
  const weighted = method !== "wma" || input == null ? 0 : count <= period
    ? (prior?.weighted ?? 0) + count * input
    : (prior?.weighted ?? 0) - (prior?.sum ?? 0) + period * input;
  let value: number | null = null;
  if (input != null && count >= period) {
    if (method === "wma") value = weighted / (period * (period + 1) / 2);
    else if (method === "sma" || prior?.value == null) value = sum / period;
    else value = prior.value + (method === "smma" ? 1 / period : 2 / (period + 1)) * (input - prior.value);
  }
  return { input, count, sum, weighted, value };
}
/** The first observation contributes high-low, matching the chart ATR seed. */
export function chartTrueRange(bar: {high:number;low:number}, previousClose?: number): number {
  return previousClose == null ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
}
