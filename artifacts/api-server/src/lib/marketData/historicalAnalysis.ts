// Historical analysis service — thin wrapper around the existing candle
// provider (dataManager.getMarketData) plus the pure domain engine
// (analyzeHistoricalComparison from @workspace/domain/historical-comparison).
//
// This service NEVER fabricates candles. If the active provider returns
// nothing, the result surfaces an empty bias with INSUFFICIENT_DATA and a
// clean "data unavailable" warning. It NEVER places trades, touches MT5
// surfaces, or mutates safety state.

import { logger } from "../logger.js";
import { getMarketData } from "../data/dataManager.js";
import {
  analyzeHistoricalComparison,
  type HistoricalComparisonResult,
  type HistoricalCandle,
} from "@workspace/domain/historical-comparison";

const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { ts: number; result: HistoricalComparisonResult }>();

function cacheKey(symbol: string, timeframe: string): string {
  return `${symbol.toUpperCase()}::${timeframe}`;
}

const SAFE_TIMEFRAMES = new Set([
  "1m", "5m", "15m", "30m",
  "1h", "4h",
  "1d", "1w", "1M",
  "M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1",
]);

function normalizeTimeframe(tf: string): string {
  if (SAFE_TIMEFRAMES.has(tf)) return tf;
  const map: Record<string, string> = {
    M1: "1m", M5: "5m", M15: "15m", M30: "30m",
    H1: "1h", H4: "4h", D1: "1d", W1: "1w", MN1: "1M",
  };
  return map[tf] ?? "1h";
}

export async function getHistoricalAnalysis(args: {
  symbol: string;
  timeframe?: string;
  limit?: number;
}): Promise<HistoricalComparisonResult> {
  const symbol = args.symbol.trim();
  const timeframe = normalizeTimeframe(args.timeframe ?? "1d");
  const limit = Math.min(Math.max(args.limit ?? 2000, 200), 5000);

  const key = cacheKey(symbol, timeframe);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < CACHE_TTL_MS) {
    return hit.result;
  }

  let candles: HistoricalCandle[] = [];
  try {
    const raw = await getMarketData(symbol, timeframe, limit);
    candles = raw
      .map((c) => {
        const ts = typeof c.time === "string"
          ? Date.parse(c.time)
          : Number(c.time);
        if (!Number.isFinite(ts)) return null;
        if (![c.open, c.high, c.low, c.close].every((v) => typeof v === "number")) {
          return null;
        }
        return {
          timestamp: ts,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
        };
      })
      .filter((c): c is HistoricalCandle => c !== null);
  } catch (err) {
    logger.warn({ symbol, timeframe, err: String(err) },
      "historicalAnalysis: provider fetch failed — returning empty bias");
    candles = [];
  }

  const result = analyzeHistoricalComparison({
    symbol,
    timeframe,
    candles,
    now,
  });

  cache.set(key, { ts: now, result });
  return result;
}
