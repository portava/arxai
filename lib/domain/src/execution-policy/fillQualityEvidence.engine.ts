// Capability #27 — fill-quality evidence aggregation (pure).
//
// Turns normalized FillRecords (fed from the EXISTING demo fill records —
// requested vs filled price, queue-to-fill latency) into per-shape evidence.
// Pure and deterministic: no IO, no clock. Empty input degrades to an honest
// "no evidence" value with a reason, never to synthesized statistics.

import type {
  ExecutionShape, FillQualityEvidence, FillRecord,
} from "./executionPolicy.types";

/** Signed adverse slippage in price units: positive = filled worse than
 *  requested (paid more on BUY, received less on SELL). */
export function adverseSlippage(r: FillRecord): number {
  return r.side === "BUY"
    ? r.filledPrice - r.requestedPrice
    : r.requestedPrice - r.filledPrice;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Aggregate fill-quality evidence for ONE shape from the records that belong
 * to it. Records for other shapes are ignored (not an error — the caller may
 * hand over the whole store).
 */
export function aggregateFillQuality(
  shape: ExecutionShape,
  records: readonly FillRecord[],
): FillQualityEvidence {
  const own = records.filter(
    (r) =>
      r.shape === shape &&
      Number.isFinite(r.requestedPrice) &&
      Number.isFinite(r.filledPrice),
  );
  if (own.length === 0) {
    return {
      available: false,
      shape,
      reason: `no usable fill records for shape ${shape}`,
    };
  }

  const slippages = own.map(adverseSlippage).sort((a, b) => a - b);
  const latencies = own
    .map((r) => r.latencyMs)
    .filter((l): l is number => l !== null && Number.isFinite(l) && l >= 0)
    .sort((a, b) => a - b);

  return {
    available: true,
    stats: {
      shape,
      sampleSize: own.length,
      meanAdverseSlippage: slippages.reduce((a, b) => a + b, 0) / slippages.length,
      medianAdverseSlippage: median(slippages),
      maxAdverseSlippage: slippages[slippages.length - 1]!,
      medianLatencyMs: latencies.length > 0 ? median(latencies) : null,
      latencySampleSize: latencies.length,
    },
  };
}
