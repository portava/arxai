// First-touch outcome labelling for replayed signals. PURE.
//
// A signal at bar i with an entry, stop and target is graded on the bars AFTER
// i only (no look-ahead into the signal bar). WIN when the target is touched
// before the stop, LOSS when the stop is touched first. A bar that touches
// both is a LOSS: intrabar order is unknown and the conservative read is the
// one that cannot flatter a strategy. A signal that touches neither within the
// horizon is UNRESOLVED and never enters a calibration sample.

export interface OhlcBar {
  high: number;
  low: number;
  close: number;
}

export type FirstTouch = 1 | 0 | null;

export function labelFirstTouch(
  bars: readonly OhlcBar[],
  signalIndex: number,
  direction: "BUY" | "SELL",
  stopLoss: number,
  takeProfit: number,
  horizonBars: number,
): FirstTouch {
  if (!(Number.isFinite(stopLoss) && Number.isFinite(takeProfit))) return null;
  const end = Math.min(bars.length - 1, signalIndex + horizonBars);
  for (let j = signalIndex + 1; j <= end; j++) {
    const b = bars[j];
    if (direction === "BUY") {
      const hitStop = b.low <= stopLoss;
      const hitTarget = b.high >= takeProfit;
      if (hitStop) return 0;
      if (hitTarget) return 1;
    } else {
      const hitStop = b.high >= stopLoss;
      const hitTarget = b.low <= takeProfit;
      if (hitStop) return 0;
      if (hitTarget) return 1;
    }
  }
  return null;
}
