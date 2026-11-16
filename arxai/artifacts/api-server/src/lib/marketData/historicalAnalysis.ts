// Historical analysis service — thin wrapper around the existing candle
// provider (dataManager.getMarketData) plus the pure domain engine
// (analyzeHistoricalComparison from @workspace/domain/historical-comparison).
//
// This service NEVER fabricates candles. If the active provider returns
// nothing, the result surfaces an empty bias with INSUFFICIENT_DATA and a
// clean "data unavailable" warning. It NEVER places trades, touches MT5
// surfaces, or mutates safety state.

import { logger } from "../logger.js";
import { getMarketDataWithProvenance } from "../data/dataManager.js";
import { getCandleHistory } from "../data/candleHistoryService.js";
import { currentFeedScope } from "../data/feedScope.js";
import { normalizeChartTimeframe } from "../data/chart/timeframes.js";
import { createHash } from "node:crypto";
import {
  analyzeHistoricalComparison,
  type HistoricalComparisonResult,
  type HistoricalCandle,
} from "@workspace/domain/historical-comparison";

const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { ts: number; result: HistoricalComparisonResult }>();

export async function getHistoricalAnalysis(args: {
  symbol: string;
  timeframe?: string;
  limit?: number;
  before?: string;
  userId?: number;
}): Promise<HistoricalComparisonResult> {
  const symbol = args.symbol.trim();
  const timeframe = normalizeChartTimeframe(args.timeframe ?? "D1");
  if (!timeframe) throw new Error("Unsupported historical timeframe");
  const limit = Math.min(Math.max(args.limit ?? 2000, 200), 5000);

  const now = Date.now();
  let key = "";
  let candles: HistoricalCandle[] = [];
  let nativeClock = false;
  try {
    const routed = await getMarketDataWithProvenance(symbol, timeframe, limit);
    const userId = args.userId ?? currentFeedScope()?.userId ?? undefined;
    const source = routed.provenance?.providerId;
    const history = source === "mt5_broker" && userId != null
      ? await getCandleHistory({ symbol, timeframe, limit, before: args.before, source, userId }) : null;
    const raw = history ? history.candles : routed.candles;
    nativeClock = history?.nativeHistoryEvidence?.clockBasis === "broker_server";
    // Include the actual source, owner, requested limit/cursor and observed
    // window; no request can inherit another account's cached analysis.
    key = createHash("sha256").update(JSON.stringify([symbol, timeframe, limit, args.before ?? null,
      userId ?? null, routed.provenance?.providerId, routed.provenance?.sourceId, history?.nativeHistoryEvidence?.sourceIdentity, raw])).digest("hex");
    const hit = cache.get(key);
    if (hit && now - hit.ts < CACHE_TTL_MS) return hit.result;
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
    now: nativeClock && candles.length ? candles.at(-1)!.timestamp : args.before ? Date.parse(args.before) : now,
  });
  result.generatedAt = now;
  if (nativeClock) result.dataQuality.coverageWarnings.push("Comparison anchored to the newest loaded native broker candle. Source-clock dates are preserved; historical UTC mapping is unverified.");

  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  if (key) cache.set(key, { ts: now, result });
  return result;
}
