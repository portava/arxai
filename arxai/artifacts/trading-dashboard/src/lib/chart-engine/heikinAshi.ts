import type { ChartEngineCandle } from "./types";

// Display-only transforms for the Heikin Ashi and hollow-candle chart styles.
//
// Every value produced here is a DISPLAY encoding of the canonical OHLC history.
// None of it may feed studies, the smart reader, drawings, magnet snapping,
// overlays, price lines or any execution path: those always read the canonical
// candles. Heikin Ashi bodies are averages, not traded prices.

export const HOLLOW_UP_COLOR = "#10b981";
export const HOLLOW_DOWN_COLOR = "#ef4444";
const HOLLOW_BODY = "transparent";

/**
 * One Heikin Ashi bar.
 * close = (O + H + L + C) / 4
 * open  = (previous HA open + previous HA close) / 2, or (O + C) / 2 on the first bar
 * high  = max(H, HA open, HA close); low = min(L, HA open, HA close)
 * Because HA high >= H and HA low <= L, above/below-bar markers placed on the HA
 * bar always clear the canonical extremes.
 */
export function heikinAshiBar(candle: ChartEngineCandle, previous: ChartEngineCandle | null): ChartEngineCandle {
  const close = (candle.open + candle.high + candle.low + candle.close) / 4;
  const open = previous ? (previous.open + previous.close) / 2 : (candle.open + candle.close) / 2;
  return { time: candle.time, open, high: Math.max(candle.high, open, close), low: Math.min(candle.low, open, close), close };
}

/**
 * Rebuild `cache` in place from index `from` so it equals heikinAshi(candles).
 * The caller guarantees that cache[0, from) was computed from the same first
 * `from` candles (an unchanged prefix). `from` is clamped to both lengths, so a
 * cache longer than the candles is truncated. Returns the same array.
 */
export function heikinAshiSuffix(candles: readonly ChartEngineCandle[], cache: ChartEngineCandle[], from: number): ChartEngineCandle[] {
  const start = Math.max(0, Math.min(Number.isFinite(from) ? Math.floor(from) : 0, cache.length, candles.length));
  cache.length = start;
  for (let i = start; i < candles.length; i++) cache.push(heikinAshiBar(candles[i]!, i > 0 ? cache[i - 1]! : null));
  return cache;
}

export function heikinAshi(candles: readonly ChartEngineCandle[]): ChartEngineCandle[] {
  return heikinAshiSuffix(candles, [], 0);
}

export interface HollowCandlePoint extends ChartEngineCandle { color: string; borderColor: string; wickColor: string }

/**
 * One hollow-candle point: the canonical OHLC unchanged, plus per-bar colours.
 * Fill: hollow (transparent body) when close >= open, filled otherwise.
 * Colour: up when close >= previous close, down otherwise; the first loaded bar
 * has no previous close and compares close with its own open.
 * Equal prices count as hollow / up (an ARX convention).
 */
export function hollowPoint(candle: ChartEngineCandle, previousClose: number | null): HollowCandlePoint {
  const up = previousClose == null ? candle.close >= candle.open : candle.close >= previousClose;
  const colour = up ? HOLLOW_UP_COLOR : HOLLOW_DOWN_COLOR;
  return { ...candle, color: candle.close >= candle.open ? HOLLOW_BODY : colour, borderColor: colour, wickColor: colour };
}
