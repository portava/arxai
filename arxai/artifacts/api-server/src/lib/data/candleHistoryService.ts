// ── Candle history service (Task #432) ───────────────────────────────────────
//
// The paginated, honesty-stamped read layer that gives every market deep,
// scrollable candle history. It composes:
//   - the persisted `market_candles` cache (deep, accumulating storage),
//   - the live `marketDataRouter` (to learn the primary provider + seed cache),
//   - the Deriv deep-fetch cursor (older-than backfill for synthetics),
// into a single `getCandleHistory()` with a `before` cursor and an explicit,
// non-fabricated metadata block (source, status, depth coverage, provider
// limits, cache hit, fetchedAt).
//
// SAFETY / HONESTY SCOPE (must hold):
//   - MARKET-DATA / TELEMETRY ONLY. Never touches execution, the 16-gate live
//     pipeline, `arx_live_*` tables, balances, or fills.
//   - ONE coherent source per response. We never mix synthetic-scaled and
//     broker-native bars in a single series.
//   - Never labels historical/stale data as live. A page reached via a `before`
//     cursor is `historical_only` by definition; the newest window's live/stale
//     verdict comes from the shared `buildFeedStatus` precedence.
//   - Never fabricates. When a provider can't reach the depth target it is
//     reported via `providerLimitReached` + `providerMessage`, never padded.

import {
  classifySymbol,
  routeCandles,
  type AssetClass,
} from "./marketDataRouter.js";
import {
  getCacheCoverage,
  listCachedSources,
  readCachedCandles,
  upsertCandles,
} from "./candleCache.js";
import { getDerivCandles } from "./providers/derivProvider.js";
import {
  depthTargetDaysFor,
  getProviderRoute,
  sourceSupportsDeepCursor,
} from "./providerRoutingMap.js";
import { buildFeedStatus } from "./freshness.js";
import type { Candle } from "./types.js";

export type CandleHistoryStatus =
  | "live" // newest window, fresh feed
  | "stale" // newest window, but feed is delayed/stale
  | "historical_only" // a back-page (reached via `before`) — never "live"
  | "unavailable"; // no source / no candles

export interface CandleHistoryResult {
  ok: boolean;
  symbol: string;
  timeframe: string;
  assetClass: AssetClass;
  /** The single source this page was served from (provenance). */
  source: string | null;
  candles: Candle[]; // ascending by time
  status: CandleHistoryStatus;
  returnedCount: number;
  oldest: string | null;
  newest: string | null;
  /** More history exists (in cache, or pageable from a deep-cursor provider). */
  hasMoreHistory: boolean;
  /** Cursor to pass as `before` for the next (older) page; null when exhausted. */
  nextBefore: string | null;
  /** The provider could not reach the requested depth (honest ceiling, not truncation). */
  providerLimitReached: boolean;
  providerMessage: string | null;
  /** This page was served from cache without a fresh provider fetch this call. */
  cacheHit: boolean;
  fetchedAt: string;
  /** Per-timeframe deep-history target (days) and how much we actually cover. */
  depthTargetDays: number;
  coverageDays: number | null;
  depthTargetMet: boolean;
  /** The history provider chain (deepest-capable first) consulted for this class. */
  sourcePriorityUsed: string[];
  /** Why deeper history is unavailable, when a real provider ceiling was hit (null otherwise). */
  limitationReason: string | null;
  userMessage: string;
  adminDetail: string;
}

export interface GetCandleHistoryArgs {
  symbol: string;
  timeframe: string;
  limit?: number;
  /** ISO time — return bars strictly OLDER than this (back-pagination cursor). */
  before?: string | null;
  /** Continuation: the source echoed by a previous page (keeps one coherent series). */
  source?: string | null;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const MAX_DERIV_BACKFILL_FETCHES = 3; // bound the per-call deep-fetch work

const TF_NORMALIZE: Record<string, string> = {
  "1m": "M1", "2m": "M2", "3m": "M3", "5m": "M5", "10m": "M10",
  "15m": "M15", "30m": "M30",
  "1h": "H1", "2h": "H2", "4h": "H4", "8h": "H8",
  "1d": "D1", "d1": "D1", "1day": "D1", "daily": "D1",
};

function normalizeTimeframe(tf: string): string {
  const t = (tf ?? "").trim();
  if (!t) return "M5";
  const upper = t.toUpperCase();
  if (/^[MHD]\d+$/.test(upper) || upper === "D1") return upper;
  return TF_NORMALIZE[t.toLowerCase()] ?? upper;
}

/** Milliseconds per bar for a canonical timeframe (best-effort; defaults to 5m). */
function timeframeMs(tf: string): number {
  const m = /^([MHD])(\d+)$/.exec(tf);
  if (!m) return 5 * 60_000;
  const n = Number(m[2]);
  switch (m[1]) {
    case "M": return n * 60_000;
    case "H": return n * 3_600_000;
    case "D": return n * 86_400_000;
    default: return 5 * 60_000;
  }
}

function derivToCandles(rows: Array<{ epoch: number; open: number; high: number; low: number; close: number }>): Candle[] {
  return rows.map((r) => ({
    time: new Date(r.epoch * 1000).toISOString(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
  }));
}

function coverageDaysFrom(oldestIso: string | null, newestIso: string | null): number | null {
  if (!oldestIso || !newestIso) return null;
  const o = new Date(oldestIso).getTime();
  const n = new Date(newestIso).getTime();
  if (!Number.isFinite(o) || !Number.isFinite(n) || n < o) return null;
  return (n - o) / 86_400_000;
}

/**
 * Fetch a page of candle history for (symbol, timeframe), oldest-first, with an
 * honest metadata block. See file header for the safety/honesty contract.
 */
export async function getCandleHistory(args: GetCandleHistoryArgs): Promise<CandleHistoryResult> {
  const symbol = (args.symbol ?? "").trim().toUpperCase();
  const timeframe = normalizeTimeframe(args.timeframe ?? "");
  const limit = Math.max(1, Math.min(MAX_LIMIT, args.limit ?? DEFAULT_LIMIT));
  const before = args.before?.trim() || null;
  const fetchedAt = new Date().toISOString();
  const assetClass = classifySymbol(symbol);
  const route = getProviderRoute(assetClass);
  const depthTargetDays = depthTargetDaysFor(timeframe);

  const base = {
    symbol,
    timeframe,
    assetClass,
    fetchedAt,
    depthTargetDays,
    sourcePriorityUsed: route.historySourceChain,
    limitationReason: null as string | null,
  };

  if (!symbol) {
    return {
      ...base,
      ok: false,
      source: null,
      candles: [],
      status: "unavailable",
      returnedCount: 0,
      oldest: null,
      newest: null,
      hasMoreHistory: false,
      nextBefore: null,
      providerLimitReached: false,
      providerMessage: null,
      cacheHit: false,
      coverageDays: null,
      depthTargetMet: false,
      userMessage: "No symbol provided.",
      adminDetail: "getCandleHistory called with empty symbol.",
    };
  }

  // Fail-closed cursor validation: a non-empty `before` that does not parse as a
  // real timestamp must NEVER silently fall through to a newest-window read (the
  // cache filter would be skipped, then the page would be mislabeled
  // historical_only). Reject an unparsable cursor honestly instead.
  if (before !== null && !Number.isFinite(new Date(before).getTime())) {
    return {
      ...base,
      ok: false,
      source: null,
      candles: [],
      status: "unavailable",
      returnedCount: 0,
      oldest: null,
      newest: null,
      hasMoreHistory: false,
      nextBefore: null,
      providerLimitReached: false,
      providerMessage: null,
      cacheHit: false,
      coverageDays: null,
      depthTargetMet: false,
      userMessage: "Invalid history cursor.",
      adminDetail: `getCandleHistory received an unparsable 'before' cursor: ${JSON.stringify(args.before)}.`,
    };
  }

  // ── Resolve the single source for this series ──────────────────────────────
  let source = args.source?.trim() || null;
  let cacheHit = true;
  let providerMessage: string | null = null;
  let providerLimitReached = false;
  let routerUserMessage: string | null = null;
  let routerOk = false;

  // Initial page (no explicit source): consult the router to learn the primary
  // provider and SEED the cache from the live newest window. We do this only
  // when no source is being continued, so back-pages don't re-hit the router.
  if (!source) {
    const routed = await routeCandles(symbol, timeframe, limit);
    routerOk = routed.ok;
    routerUserMessage = routed.userMessage || null;
    if (routed.ok && routed.primaryProvider && routed.candles.length > 0) {
      source = routed.primaryProvider;
      cacheHit = false;
      await upsertCandles(symbol, timeframe, source, routed.candles);
    } else {
      // Router could not answer fresh — fall back to the deepest cached source
      // (if any) so a previously-seeded series still scrolls.
      const cachedSources = await listCachedSources(symbol, timeframe);
      if (cachedSources.length > 0) {
        source = cachedSources[0]!.source;
      }
    }
  }

  if (!source) {
    return {
      ...base,
      ok: false,
      source: null,
      candles: [],
      status: "unavailable",
      returnedCount: 0,
      oldest: null,
      newest: null,
      hasMoreHistory: false,
      nextBefore: null,
      providerLimitReached: false,
      providerMessage: null,
      cacheHit: false,
      coverageDays: null,
      depthTargetMet: false,
      userMessage: routerUserMessage ?? "No market-data source available for this symbol.",
      adminDetail: `No provider answered and no cached series for ${symbol} ${timeframe}. assetClass=${assetClass}, chain=${route.historySourceChain.join(" → ")}.`,
    };
  }

  // ── Read the requested page from cache ──────────────────────────────────────
  let page = await readCachedCandles({ symbol, timeframe, source, before, limit });

  // ── Deep-fetch older history when the cache is short for this window ─────────
  // Only providers exposing a true older-than cursor (Deriv synthetics today)
  // can page deeper server-side. Forward-only sources (assistant free tiers) and
  // EA-push-only (mt5_broker) report an honest limit instead of fabricating.
  const wantOlder = page.count < limit;
  if (wantOlder && !page.hasOlderInCache) {
    if (sourceSupportsDeepCursor(source) && assetClass === "synthetic") {
      let cursorIso = page.oldest ?? before ?? null;
      let fetches = 0;
      while (page.count < limit && fetches < MAX_DERIV_BACKFILL_FETCHES) {
        const cursorMs = cursorIso ? new Date(cursorIso).getTime() : Date.now();
        const endEpochSeconds = Math.floor(cursorMs / 1000) - 1;
        const res = await getDerivCandles(symbol, timeframe, MAX_LIMIT, endEpochSeconds);
        fetches += 1;
        cacheHit = false;
        if (!res.ok || res.candles.length === 0) {
          providerLimitReached = true;
          providerMessage = res.reason
            ? `Deriv returned no older bars: ${res.reason}`
            : "Deriv returned no older history beyond this point.";
          break;
        }
        const older = derivToCandles(res.candles);
        await upsertCandles(symbol, timeframe, source, older);
        // Re-read the same window now that older bars are cached.
        page = await readCachedCandles({ symbol, timeframe, source, before, limit });
        const newOldest = page.oldest;
        if (newOldest && newOldest === cursorIso) break; // no progress — stop
        cursorIso = newOldest ?? cursorIso;
      }
    } else if (wantOlder) {
      // Forward-only / EA-push-only: we cannot fetch older server-side.
      providerLimitReached = true;
      providerMessage =
        route.historyDepthSupport === "ea_push_only"
          ? "Deeper history requires the MT5 EA to stream candle history (not yet active)."
          : "Provider free tier has no older-than cursor; deeper history is unavailable from this source.";
    }
  }

  // ── Honest status verdict ───────────────────────────────────────────────────
  let status: CandleHistoryStatus;
  if (page.count === 0) {
    status = "unavailable";
  } else if (before) {
    // A page reached via the back-cursor is historical by definition.
    status = "historical_only";
  } else if (!routerOk) {
    // Newest window served from cache only (router did not answer this call, or
    // an explicit source was pinned so the router was never consulted). We have
    // candles, but with NO fresh provider confirmation we can honestly report at
    // best "stale" — never "live". Cache availability alone never means live.
    status = "stale";
  } else {
    // Newest window with a fresh provider answer: derive live/stale from the
    // shared freshness precedence over the observed trailing-interval gap.
    const newestMs = page.newest ? new Date(page.newest).getTime() : null;
    const trailingIntervals =
      newestMs != null ? (Date.now() - newestMs) / timeframeMs(timeframe) : null;
    const verdict = buildFeedStatus({
      routerOk: true,
      hasSource: true,
      candleCount: page.count,
      trailingIntervals,
      syntheticAwaitingTick: false,
      routerUserMessage,
    });
    if (verdict.quality === "clean") status = "live";
    else if (verdict.quality === "unavailable" || verdict.quality === "empty") status = "unavailable";
    else status = "stale";
  }

  const coverage = await getCacheCoverage(symbol, timeframe, source);
  const coverageDays = coverageDaysFrom(coverage.oldest, coverage.newest);
  const depthTargetMet = coverageDays != null && coverageDays >= depthTargetDays;

  // More history is available when older bars remain cached, OR a deep-cursor
  // provider can still page back (and hasn't reported a limit this call).
  const hasMoreHistory =
    page.hasOlderInCache ||
    (sourceSupportsDeepCursor(source) && assetClass === "synthetic" && !providerLimitReached);

  const nextBefore = page.oldest; // oldest returned bar is the next back-cursor

  return {
    ...base,
    ok: page.count > 0,
    source,
    candles: page.candles,
    status,
    returnedCount: page.count,
    oldest: page.oldest,
    newest: page.newest,
    hasMoreHistory,
    nextBefore: hasMoreHistory ? nextBefore : null,
    providerLimitReached,
    providerMessage,
    limitationReason: providerLimitReached ? providerMessage : null,
    cacheHit,
    coverageDays,
    depthTargetMet,
    userMessage:
      page.count > 0
        ? `Loaded ${page.count} ${timeframe} candle(s) for ${symbol}.`
        : routerUserMessage ?? "No candles available for this window.",
    adminDetail: `source=${source} assetClass=${assetClass} depthSupport=${route.historyDepthSupport} coverageDays=${coverageDays?.toFixed(1) ?? "n/a"}/${depthTargetDays} cacheHit=${cacheHit} providerLimitReached=${providerLimitReached}`,
  };
}
