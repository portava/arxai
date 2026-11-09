// Stored history for a closed market or a down feed (chart display only).
//
// When every provider declines (market closed, bridge disconnected, no feed
// key) the chart still owns real bars it stored earlier in market_candles: the
// MT5 broker mirror and the provider series the history service seeded. This
// serves them, unchanged, so the chart shows the market up to its last bar
// instead of an empty canvas. It is NEVER part of `routeCandles` or
// `routeCandlesForDecision`: only the chart display feed calls it, after the
// live chain was exhausted. The served result is tagged
// `subProviderId: "stored_history"` with `delayed: null`, and the chart feed
// reports it not live, not AI-usable and without Truth market evidence.

import * as candleCache from "./candleCache.js";
import { MT5_BROKER_MIRROR_SOURCE, normalizeBrokerTimeframe, TIMEFRAME_MS } from "./brokerCandleStore.js";
import { readBridgeStoredCandles } from "./bridgeStoredCandles.js";
import type { MarketCandlesResult } from "./marketDataRouter.js";
import type { SeriesProvenance } from "./types.js";

/** Router sub-provider id of a stored-history serve (any stored source). */
export const STORED_HISTORY_SUB_PROVIDER = "stored_history";

const TIMEFRAME_ALIASES: Record<string, string> = {
  "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1d": "D1",
};

function normalizeTimeframe(tf: string): string {
  const t = (tf ?? "").trim();
  if (!t) return "M5";
  const upper = t.toUpperCase();
  if (/^[MHDW]N?\d+$/.test(upper)) return upper;
  return TIMEFRAME_ALIASES[t.toLowerCase()] ?? upper;
}

/** Explicit mock / developer sources are never shown as market history. */
export function isNonMarketSource(source: string): boolean {
  return /mock|(?:^|[_:-])(?:dev|test)(?:$|[_:-])/i.test(source.trim());
}

function brokerCodeForSource(source: string): SeriesProvenance["brokerCode"] {
  if (source === MT5_BROKER_MIRROR_SOURCE) return "mt5";
  if (source.startsWith("deriv")) return "deriv";
  return "third_party";
}

/** The MT5 mirror is preferred only while its newest bar is this close to the newest stored source. */
export const MT5_MIRROR_PREFERENCE_INTERVALS = 3;

function intervalMsFor(tf: string): number {
  const btf = normalizeBrokerTimeframe(tf);
  return btf ? TIMEFRAME_MS[btf] : 5 * 60_000;
}

export interface StoredHistoryOptions {
  /** The reader's own bridge: its broker_candles rows are served first (own_bridge). */
  bridgeConnectionId?: number | null;
}

/**
 * The newest stored bars for one symbol|timeframe, from ONE stored source
 * (series are never blended). A reader with a bridge gets that bridge's own
 * stored broker bars when it has any. Otherwise the shared market_candles
 * store: the MT5 broker mirror when its newest bar is within
 * MT5_MIRROR_PREFERENCE_INTERVALS of the newest stored source, else the
 * stored source whose newest bar is the most recent. Returns `prior` (the
 * exhausted live result) unchanged when nothing is stored or the store cannot
 * be read.
 */
export async function routeStoredCandleHistory(
  symbol: string,
  timeframe: string,
  limit: number,
  prior: MarketCandlesResult,
  opts: StoredHistoryOptions = {},
): Promise<MarketCandlesResult> {
  if (prior.ok) return prior;
  const tf = normalizeTimeframe(timeframe);
  const pin = opts.bridgeConnectionId;
  if (typeof pin === "number" && Number.isFinite(pin)) {
    try {
      const own = await readBridgeStoredCandles(pin, symbol, tf, limit);
      if (own && own.candles.length > 0) {
        return {
          ok: true,
          symbol,
          assetClass: prior.assetClass,
          candles: own.candles,
          primaryProvider: MT5_BROKER_MIRROR_SOURCE,
          attempts: prior.attempts,
          userMessage: "Showing stored history; no live feed is available.",
          adminDetail: `Live chain exhausted (${prior.adminDetail}); served ${own.candles.length} stored broker bars of bridge ${pin}, newest ${own.newest}.`,
          provenance: {
            providerId: MT5_BROKER_MIRROR_SOURCE,
            subProviderId: STORED_HISTORY_SUB_PROVIDER,
            brokerCode: "mt5",
            bridgeConnectionId: pin,
            userId: own.userId,
            brokerSymbol: own.brokerSymbol,
            environment: "unknown",
            receivedAt: new Date().toISOString(),
            delayed: null,
            source: "DERIVED",
            sourceId: `${MT5_BROKER_MIRROR_SOURCE}:${symbol.trim().toUpperCase()}:${tf}`,
          },
        };
      }
    } catch {
      // The bridge store is unreadable: fall through to the shared mirror.
    }
  }
  try {
    const sources = (await candleCache.listCachedSources(symbol, tf))
      .filter((s) => s.count > 0 && s.newest != null && !isNonMarketSource(s.source));
    if (sources.length === 0) return prior;
    const newestFirst = [...sources].sort((a, b) => Date.parse(b.newest!) - Date.parse(a.newest!));
    const newestMs = Date.parse(newestFirst[0]!.newest!);
    const mirror = sources.find((s) => s.source === MT5_BROKER_MIRROR_SOURCE);
    const mirrorCurrent = mirror != null
      && newestMs - Date.parse(mirror.newest!) <= MT5_MIRROR_PREFERENCE_INTERVALS * intervalMsFor(tf);
    const chosen = mirrorCurrent ? mirror! : newestFirst[0]!;
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
