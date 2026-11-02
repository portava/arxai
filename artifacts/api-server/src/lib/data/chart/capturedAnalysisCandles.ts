import { createHash } from "node:crypto";
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

/** Fingerprint the exact closed analysis projection. Receipt times, display
 * flags and forming ticks are not analysis revisions. This is equality evidence,
 * not proof that prices, clocks or provider statements are correct. */
export function closedAnalysisWindowIdentity(candles: readonly NormalizedChartCandle[]): string | null {
  const inputs = capturedAnalysisCandles(candles);
  if (!inputs.length) return null;
  let prior = -Infinity;
  for (const candle of inputs) {
    const at = Date.parse(candle.time);
    if (!Number.isFinite(at) || at <= prior || ![candle.open,candle.high,candle.low,candle.close].every(Number.isFinite)
      || candle.high < Math.max(candle.open,candle.close,candle.low) || candle.low > Math.min(candle.open,candle.close,candle.high)) return null;
    prior = at;
  }
  // Sort object keys so equivalent producer metadata does not become a revision
  // solely because a transport recreated its properties in another order.
  function stable(value: unknown): unknown {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid analysis input");
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,stable(v)]));
    return value;
  }
  try {
    return createHash("sha256").update(JSON.stringify(["arx.closed-analysis.v1",stable(inputs)])).digest("hex");
  } catch { return null; }
}
