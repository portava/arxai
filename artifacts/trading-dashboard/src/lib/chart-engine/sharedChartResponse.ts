import type { ChartCandlesResponse } from "@workspace/api-client-react";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Accept the original normalized response for display, never the Scanner's
 * legacy OHLC-only projection. This validates display shape/identity only:
 * missing or contradictory finality/provenance stays missing or contradictory.
 * Smart Reader and replay independently require their full evidence contracts. */
export function sharedChartResponse(value: unknown, symbol: string, timeframe: string): ChartCandlesResponse | undefined {
  if (!record(value) || value.symbol !== symbol || value.timeframe !== timeframe
    || !Array.isArray(value.candles) || !record(value.feedStatus)
    || !(typeof value.feedStatus.source === "string" || value.feedStatus.source === null)
    || typeof value.quality !== "string" || typeof value.aiUsable !== "boolean") return undefined;
  const source = value.feedStatus.source;
  if (!value.candles.every(candle => record(candle) && candle.symbol === symbol
    && candle.timeframe === timeframe && candle.source === source
    && typeof candle.openTime === "string" && Number.isFinite(Date.parse(candle.openTime))
    && [candle.open, candle.high, candle.low, candle.close].every(price => typeof price === "number" && Number.isFinite(price)))) return undefined;
  // Preserve the object byte-for-byte; in particular never manufacture closed
  // flags, closeTime, quality flags, account/source identity or volume.
  return value as unknown as ChartCandlesResponse;
}
