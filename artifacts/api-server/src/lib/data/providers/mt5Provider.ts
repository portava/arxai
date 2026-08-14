import type { Candle, DataProvider, MarketQuote } from "../types.js";
import { MT5_CANDLE_TTL_MS, MT5_FEED_FRESH_MS } from "../freshness.js";

// ── MT5 broker market-data provider ──────────────────────────────────────────
//
// Holds candle/quote data PUSHED from the per-user MT5 EA bridge (CopyRates +
// tick). The provider is a pure in-memory store; it never fetches. Data arrives
// via updateCandlesFromMT5 / updateQuoteFromMT5, called by the EA-facing
// ingestion endpoints (POST /api/mt5/sync-candles, /api/mt5/sync-quotes).
//
// SYMBOL+TIMEFRAME KEYING (critical correctness fix):
//   Candles are keyed by `${symbol}|${timeframe}` so M5 bars can NEVER be served
//   under an H1 request. Each series tracks its own freshness; a stale series is
//   not served. The legacy symbol-only signature is preserved as a thin wrapper
//   that defaults the timeframe, so any pre-existing caller keeps compiling.
//
// FRESHNESS:
//   Each series stores `updatedAt`. getCandles returns [] for a series older
//   than CANDLE_TTL_MS (so the router falls through to the next provider rather
//   than serving stale broker bars). isConnected() is true when ANY series OR
//   quote is fresh within FEED_FRESH_MS — i.e. the EA is actively pushing.

const DEFAULT_TIMEFRAME = "M5";

// A broker candle series is considered usable for this long after its last push.
// Generous vs the bar interval because the EA pushes on a cadence, not per-tick.
// Sourced from the shared freshness module and re-exported under the legacy name
// so the feed-staleness watchdog (and other callers) use the SAME threshold the
// provider uses to stop serving a series — one source of truth for "stale".
export const CANDLE_TTL_MS = MT5_CANDLE_TTL_MS; // 5 minutes
// The provider counts as "connected" when something was pushed this recently.
const FEED_FRESH_MS = MT5_FEED_FRESH_MS; // 60s

function normalizeTf(tf: string | undefined | null): string {
  const t = (tf ?? "").trim();
  if (!t) return DEFAULT_TIMEFRAME;
  const upper = t.toUpperCase();
  if (/^[MHD]\d+$/.test(upper) || upper === "D1") return upper;
  const map: Record<string, string> = {
    "1m": "M1", "2m": "M2", "3m": "M3", "5m": "M5", "10m": "M10",
    "15m": "M15", "30m": "M30",
    "1h": "H1", "2h": "H2", "4h": "H4", "8h": "H8",
    "1d": "D1", "d1": "D1", "1day": "D1", "daily": "D1",
  };
  return map[t.toLowerCase()] ?? upper;
}

// Normalize an ARX/display symbol to a stable in-memory store key. Trim +
// uppercase so a quote pushed as "eurusd" and a chart read for "EURUSD" land on
// the SAME series — applied identically on WRITE and READ for both candles and
// quotes. This is NOT broker-symbol resolution (that happens only at the
// live-execution boundary); it is purely a consistent analysis-store key so the
// quote store matches the candle-series keying.
export function normalizeSymbolKey(symbol: string): string {
  return (symbol ?? "").trim().toUpperCase();
}

function seriesKey(symbol: string, timeframe: string): string {
  return `${normalizeSymbolKey(symbol)}|${normalizeTf(timeframe)}`;
}

interface CandleSeries {
  candles: Candle[];
  updatedAt: number;
}

const candleStore = new Map<string, CandleSeries>();
const quoteStore = new Map<string, { quote: MarketQuote; updatedAt: number }>();
let lastUpdate = 0;

/**
 * Push a candle series for an exact symbol+timeframe. Replaces the stored series
 * (the EA sends the latest window each push). Stamps freshness. The legacy
 * 2-arg form `updateCandlesFromMT5(symbol, candles)` still works and defaults
 * the timeframe to M5 so older callers compile unchanged.
 */
export function updateCandlesFromMT5(
  symbol: string,
  candles: Candle[],
  timeframe: string = DEFAULT_TIMEFRAME,
): void {
  candleStore.set(seriesKey(symbol, timeframe), { candles, updatedAt: Date.now() });
  lastUpdate = Date.now();
}

// The most bars a single series retains. The v2 bridge pushes ONE closed bar
// per CANDLE event (unlike the v1 sync path, which replaces the whole window),
// so a long-running stream would grow unboundedly without a cap. Keep the most
// recent window — more than enough for every chart/scan timeframe.
const MAX_MERGED_BARS = 1500;

/**
 * Merge ONE closed broker bar into the stored series for an exact
 * symbol+timeframe, WITHOUT discarding the existing history. This is the v2
 * bridge ingest path: the EA emits one closed CANDLE per event, so we must
 * append/upsert it onto the existing series rather than replace the whole
 * window (which `updateCandlesFromMT5` does for the v1 full-window sync).
 *
 * Semantics:
 *   - dedupe/upsert by bar `time` (last write wins for a re-sent same-time bar),
 *   - keep ascending time order,
 *   - cap to the most recent MAX_MERGED_BARS,
 *   - stamp freshness so the router serves it and `isConnected()` flips true.
 */
export function mergeCandleFromMT5(
  symbol: string,
  candle: Candle,
  timeframe: string = DEFAULT_TIMEFRAME,
): void {
  const key = seriesKey(symbol, timeframe);
  const existing = candleStore.get(key);
  const byTime = new Map<string, Candle>();
  if (existing) {
    for (const c of existing.candles) byTime.set(c.time, c);
  }
  // Last-write-wins on identical bar time (an idempotent re-send is a no-op).
  byTime.set(candle.time, candle);
  const merged = Array.from(byTime.values()).sort((a, b) =>
    a.time < b.time ? -1 : a.time > b.time ? 1 : 0,
  );
  const capped =
    merged.length > MAX_MERGED_BARS ? merged.slice(-MAX_MERGED_BARS) : merged;
  candleStore.set(key, { candles: capped, updatedAt: Date.now() });
  lastUpdate = Date.now();
}

export function updateQuoteFromMT5(symbol: string, quote: MarketQuote): void {
  quoteStore.set(normalizeSymbolKey(symbol), { quote, updatedAt: Date.now() });
  lastUpdate = Date.now();
}

/** Test/diagnostic helper — clear all pushed data. */
export function __resetMt5ProviderStore(): void {
  candleStore.clear();
  quoteStore.clear();
  lastUpdate = 0;
}

/** Per-series freshness probe (used by diagnostics). */
export function getMt5SeriesFreshness(
  symbol: string,
  timeframe: string,
  now: number = Date.now(),
): { hasSeries: boolean; ageMs: number | null; fresh: boolean; barCount: number } {
  const s = candleStore.get(seriesKey(symbol, timeframe));
  if (!s) return { hasSeries: false, ageMs: null, fresh: false, barCount: 0 };
  const ageMs = now - s.updatedAt;
  return { hasSeries: true, ageMs, fresh: ageMs <= CANDLE_TTL_MS, barCount: s.candles.length };
}

/**
 * Candle-store introspection for the router: lets it report a PRECISE reason
 * when MT5 has no fresh bars for a request — distinguishing "this timeframe is
 * missing but the symbol is pushing other timeframes" from "this symbol was
 * never pushed at all". Read-only; never mutates the store.
 */
export function getMt5CandleAvailability(
  symbol: string,
  timeframe: string,
  now: number = Date.now(),
): {
  requestedHasSeries: boolean;
  requestedFresh: boolean;
  symbolHasAnySeries: boolean;
  symbolHasAnyFreshSeries: boolean;
} {
  const wantKey = seriesKey(symbol, timeframe);
  const wantSym = normalizeSymbolKey(symbol);
  let requestedHasSeries = false;
  let requestedFresh = false;
  let symbolHasAnySeries = false;
  let symbolHasAnyFreshSeries = false;
  for (const [key, s] of candleStore.entries()) {
    const [sym] = key.split("|") as [string, string];
    const fresh = now - s.updatedAt <= CANDLE_TTL_MS && s.candles.length > 0;
    if (key === wantKey) {
      requestedHasSeries = true;
      requestedFresh = fresh;
    }
    if (sym === wantSym) {
      symbolHasAnySeries = true;
      if (fresh) symbolHasAnyFreshSeries = true;
    }
  }
  return { requestedHasSeries, requestedFresh, symbolHasAnySeries, symbolHasAnyFreshSeries };
}

/**
 * Quote-store introspection for the router (read-only). `hasPrice` mirrors the
 * router's usable-quote test (a positive bid/ask/last).
 */
export function getMt5QuoteAvailability(
  symbol: string,
  now: number = Date.now(),
): { hasQuote: boolean; fresh: boolean; hasPrice: boolean; ageMs: number | null } {
  const q = quoteStore.get(normalizeSymbolKey(symbol));
  if (!q) return { hasQuote: false, fresh: false, hasPrice: false, ageMs: null };
  const ageMs = Math.max(0, now - q.updatedAt);
  const fresh = ageMs <= CANDLE_TTL_MS;
  const { bid, ask, last } = q.quote;
  const hasPrice =
    (bid != null && bid > 0) || (ask != null && ask > 0) || (last != null && last > 0);
  return { hasQuote: true, fresh, hasPrice, ageMs };
}

export type Mt5SeriesContributionStatus =
  | "contributing"      // fresh, non-empty — this series IS answering chart requests
  | "stale"             // pushed data exists but exceeded CANDLE_TTL_MS — router falls through
  | "non-contributing"  // no data for this series, but the MT5 feed IS connected
                        // (the EA is pushing other series) — just not this one
  | "unavailable";      // no data for this series AND the MT5 feed is not connected
                        // at all (the bridge candle feed mechanism is offline)

export interface Mt5SeriesStatusEntry {
  symbol: string;
  timeframe: string;
  status: Mt5SeriesContributionStatus;
  barCount: number;
  ageMs: number | null;
  updatedAt: string | null;
}

/**
 * Returns the contribution status of every symbol+timeframe series the EA has
 * pushed since server start. Used by admin diagnostics to show per-feed health.
 * Never fabricates entries — an absent series is simply absent from the list.
 */
export function getMt5AllSeriesStatus(now: number = Date.now()): Mt5SeriesStatusEntry[] {
  const out: Mt5SeriesStatusEntry[] = [];
  for (const [key, s] of candleStore.entries()) {
    const [symbol, timeframe] = key.split("|") as [string, string];
    const ageMs = now - s.updatedAt;
    const fresh = ageMs <= CANDLE_TTL_MS;
    const hasBars = s.candles.length > 0;
    // Separate the two states the old code conflated:
    //   aged-out (age > TTL)        → "stale"            (router falls through)
    //   fresh push but empty series → "non-contributing" (connected, no usable
    //                                  bars yet) — NOT "stale"
    //   fresh push with bars        → "contributing"
    // A feed-stopped watchdog must gate on ageMs > CANDLE_TTL_MS, never on the
    // status string alone, because "non-contributing" is a fresh (live) push.
    const status: Mt5SeriesContributionStatus =
      !fresh ? "stale" : hasBars ? "contributing" : "non-contributing";
    out.push({
      symbol,
      timeframe,
      status,
      barCount: s.candles.length,
      ageMs,
      updatedAt: new Date(s.updatedAt).toISOString(),
    });
  }
  return out;
}

export class Mt5Provider implements DataProvider {
  name = "mt5";

  // Timeframe is now AUTHORITATIVE: a series is only returned for the exact
  // symbol+timeframe it was pushed under, and only while fresh. A stale or
  // absent series returns [] so the router falls through to the next provider.
  async getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    const s = candleStore.get(seriesKey(symbol, timeframe));
    if (!s) return [];
    if (Date.now() - s.updatedAt > CANDLE_TTL_MS) return [];
    return s.candles.slice(-limit);
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    const q = quoteStore.get(normalizeSymbolKey(symbol));
    if (q && Date.now() - q.updatedAt <= CANDLE_TTL_MS) return q.quote;
    return { symbol, timestamp: new Date().toISOString() };
  }

  async isConnected(): Promise<boolean> {
    // Connected when the EA pushed candles or a quote within the freshness
    // window — i.e. the broker feed is actively flowing. Until the EA's
    // CopyRates push ships, nothing calls the update fns and this stays false.
    return lastUpdate > 0 && Date.now() - lastUpdate < FEED_FRESH_MS;
  }
}

export const mt5Provider = new Mt5Provider();
