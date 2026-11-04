// Display-only fallback adapted from portava/arxai PR #112.
// One stored series, never blended, never current-market decision evidence.
import * as candleCache from "./candleCache.js";
import { MT5_BROKER_MIRROR_SOURCE } from "./brokerCandleStore.js";
import type { MarketCandlesResult } from "./marketDataRouter.js";
import type { SeriesProvenance } from "./types.js";

export const STORED_HISTORY_SUB_PROVIDER = "stored_history";

const TIMEFRAME_ALIASES: Record<string, string> = {
  "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1d": "D1",
};

function normalizeTimeframe(tf: string): string {
  const t = tf.trim();
  return (TIMEFRAME_ALIASES[t.toLowerCase()] ?? t.toUpperCase()) || "M5";
}

export function isNonMarketSource(source: string): boolean {
  return /mock|(?:^|[_:-])(?:dev|test)(?:$|[_:-])/i.test(source.trim());
}

function brokerCodeForSource(source: string): SeriesProvenance["brokerCode"] {
  if (source === MT5_BROKER_MIRROR_SOURCE) return "mt5";
  if (source.startsWith("deriv")) return "deriv";
  return "third_party";
}

/** Preserve the exhausted result on a missing/failed read. Never joins feeds. */
export async function routeStoredCandleHistory(
  symbol: string,
  timeframe: string,
  limit: number,
  prior: MarketCandlesResult,
): Promise<MarketCandlesResult> {
  if (prior.ok) return prior;
  const tf = normalizeTimeframe(timeframe);
  try {
    const sources = (await candleCache.listCachedSources(symbol, tf))
      .filter(s => s.count > 0 && s.newest != null && !isNonMarketSource(s.source));
    if (sources.length === 0) return prior;
    const chosen = sources.find(s => s.source === MT5_BROKER_MIRROR_SOURCE)
      ?? [...sources].sort((a, b) => Date.parse(b.newest!) - Date.parse(a.newest!))[0]!;
    const read = await candleCache.readCachedCandles({ symbol, timeframe: tf, source: chosen.source, limit });
    if (read.count === 0) return prior;
    const provenance: SeriesProvenance = {
      providerId: chosen.source,
      subProviderId: STORED_HISTORY_SUB_PROVIDER,
      brokerCode: brokerCodeForSource(chosen.source),
      bridgeConnectionId: null,
      userId: null,
      brokerSymbol: null,
      environment: "unknown",
      receivedAt: new Date().toISOString(),
      delayed: null,
      source: "DERIVED",
      sourceId: `${chosen.source}:${symbol.trim().toUpperCase()}:${tf}`,
    };
    return {
      ok: true,
      symbol,
      assetClass: prior.assetClass,
      candles: read.candles,
      primaryProvider: chosen.source,
      attempts: prior.attempts,
      userMessage: "Showing stored history; no live feed is available.",
      adminDetail: `Live chain exhausted (${prior.adminDetail}); served ${read.count} stored ${chosen.source} bars, newest ${read.newest}.`,
      provenance,
    };
  } catch {
    return prior;
  }
}
