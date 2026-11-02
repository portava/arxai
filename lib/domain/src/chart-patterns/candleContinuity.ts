/** Partition chronological observations without inventing missing candles or
 * treating an elapsed gap as a verified market closure. Bounds are seconds;
 * callers separately qualify source, prices, duration and closed-bar evidence.
 * Invalid/overlapping bounds return null rather than being sorted or dropped. */
export function partitionCandleContinuity<T>(
  candles: readonly T[], bounds: (candle: T) => { open: number; close: number },
): T[][] | null {
  const segments: T[][] = [];
  let previous: { open: number; close: number } | null = null;
  for (const candle of candles) {
    const current = bounds(candle);
    if (!Number.isFinite(current.open) || !Number.isFinite(current.close)
      || current.open <= 0 || current.close <= current.open
      || (previous && (current.open <= previous.open || current.open < previous.close - 0.001))) return null;
    if (!previous || Math.abs(current.open - previous.close) >= 0.001) segments.push([candle]);
    else segments.at(-1)!.push(candle);
    previous = current;
  }
  return segments;
}
