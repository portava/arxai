import type { ChartEngineCandle } from "./types";

export function sameCandle(a: ChartEngineCandle, b: ChartEngineCandle): boolean {
  return a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
}

/** Number of observed candles whose OHLC and timestamp are unchanged. Study
 * state before this index is causal and may survive appends or truncation. */
export function unchangedCandlePrefix(previous: readonly ChartEngineCandle[], next: readonly ChartEngineCandle[]): number {
  let index = 0;
  while (index < previous.length && index < next.length && sameCandle(previous[index]!, next[index]!)) index++;
  return index;
}

/** Only an unchanged prefix can use update(). Corrections/prepends need setData. */
export function incrementalCandles(previous: readonly ChartEngineCandle[], next: readonly ChartEngineCandle[]): ChartEngineCandle[] | null {
  if (!previous.length || next.length < previous.length) return null;
  for (let i = 0; i < previous.length - 1; i++) {
    if (!sameCandle(previous[i]!, next[i]!)) return null;
  }
  const last = previous.length - 1;
  if (previous[last]!.time !== next[last]!.time) return null;
  return next.slice(sameCandle(previous[last]!, next[last]!) ? previous.length : last);
}

/** Preserve the viewed timestamps when history is prepended OR rolls off. */
export function historyRangeShift(previous: readonly ChartEngineCandle[], next: readonly ChartEngineCandle[]): number {
  if (!previous.length || !next.length) return 0;
  let a = 0;
  let b = 0;
  while (a < previous.length && b < next.length) {
    if (previous[a]!.time === next[b]!.time) return b - a;
    if (previous[a]!.time < next[b]!.time) a++; else b++;
  }
  return 0;
}

/** Display precision only, never order tick size or execution metadata. */
export function candleDisplayPrecision(candles: readonly ChartEngineCandle[], symbol = ""): number {
  const fiat = /^(EUR|USD|GBP|AUD|NZD|CAD|CHF|JPY)(EUR|USD|GBP|AUD|NZD|CAD|CHF|JPY)$/;
  let precision = fiat.test(symbol) ? (symbol.endsWith("JPY") ? 3 : 5) : 2;
  for (const c of candles.slice(-100)) {
    for (const value of [c.open, c.high, c.low, c.close]) {
      for (let digits = precision; digits <= 8; digits++) {
        if (Math.abs(value - Number(value.toFixed(digits))) < 1e-9 || digits === 8) {
          precision = Math.max(precision, digits);
          break;
        }
      }
    }
  }
  return precision;
}
