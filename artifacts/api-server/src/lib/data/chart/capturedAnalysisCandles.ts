import type { Candle } from "../types.js";
import type { NormalizedChartCandle } from "./candleNormalization.js";

/** Convert the already-normalized observation, not a new provider request.
 * ISO syntax is not UTC authority; copy original metadata without upgrading it.
 * Unknown numeric-volume placeholders are not observations of zero volume. */
export function capturedAnalysisCandles(candles: readonly NormalizedChartCandle[]): Candle[] {
  return candles.filter(c => c.isComplete === true && !c.isForming).map(c => ({
    time: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close,
    ...(c.volumeEvidence?.kind !== "unavailable" && c.volumeEvidence?.quantity != null
      ? { volume: c.volumeEvidence.quantity } : {}),
    ...(c.volumeEvidence ? { volumeEvidence: structuredClone(c.volumeEvidence) } : {}),
    ...(c.timeBasisEvidence ? { timeBasisEvidence: structuredClone(c.timeBasisEvidence) } : {}),
    ...(c.priceBasisEvidence ? { priceBasisEvidence: structuredClone(c.priceBasisEvidence) } : {}),
  }));
}
