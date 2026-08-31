// Market data provider adapter for ARX AI assistant.
//
// Phase 22E: real adapters for Polygon, Finnhub, Alpha Vantage, NewsAPI.
// Selected by env at startup with priority: Polygon > Finnhub > Alpha Vantage.
// NewsAPI is used for news only when no quote-provider news is available.
// When no key is set, uses nullProvider — { connected:false, ... } — and the
// assistant must say "live market data is not connected" rather than fabricate.
//
// Constraints (Phase 22E):
// - Backend-only API keys. Never returned to the client.
// - Honest unavailable / stale states. No fabrication.
// - Brief in-memory cache to avoid API spam (no DB writes).
// - Symbol validation. Provider failures never crash callers.

import { logger } from "../logger.js";
import {
  getEconomicCalendarResult,
  isEconomicCalendarConfigured,
} from "../news/calendar/economicCalendarService.js";
import { toAssistantEconomicEvents } from "../news/calendar/calendarAdapters.js";
import {
  classifyQuoteFreshness,
  QUOTE_FRESH_TTL_MS,
  QUOTE_STALE_AFTER_MS,
  ASSISTANT_CANDLE_CACHE_TTL_MS,
  ASSISTANT_NEWS_CACHE_TTL_MS,
} from "../data/freshness.js";

export interface MarketQuote {
  symbol: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  change: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  previousClose: number | null;
  asOf: string | null;
  freshness: "REALTIME" | "DELAYED" | "DEMO" | "UNAVAILABLE" | "STALE" | "ERROR";
  source: string;
  stale: boolean;
}
export interface NewsItem {
  headline: string;
  url: string;
  publishedAt: string;
  source: string;
  symbols?: string[];
  summary?: string;
}
export interface EconomicEvent {
  whenIso: string;
  region: string;
  title: string;
  importance: "low" | "medium" | "high";
  forecast?: string | null;
  previous?: string | null;
}

export interface MarketProviderFeatures {
  quotes: boolean;
  news: boolean;
  snapshots: boolean;
  economicCalendar: boolean;
  candles: boolean;
  /** Phase 24 — separate real-world / geopolitical events channel (additive). */
  currentEvents?: boolean;
}

/** Phase 24 — Current events / real-world news item. Separate channel from
 *  symbol-scoped financial market news (NewsItem). Use for geopolitical,
 *  macro-policy, war/conflict, supply-shock, regulatory headlines. */
export interface CurrentEventItem {
  headline: string;
  url: string | null;
  publishedAt: string;
  fetchedAt: string;
  source: string;
  category: "geopolitical" | "macro_policy" | "conflict" | "supply_shock" | "regulatory" | "natural_disaster" | "general";
  impactedAssets: string[];
  relevance: string;
  impact: "low" | "medium" | "high" | "unknown";
}
export interface CurrentEventsResult {
  connected: boolean;
  events: CurrentEventItem[];
  provider: string;
  reason: string;
  fetchedAt: string;
}

// Phase 22O — OHLC candle for live scanner ranking. Provider-agnostic.
export interface Candle {
  t: string; // ISO timestamp of bar close
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface CandleResult {
  connected: boolean;
  source: string;
  symbol: string;
  timeframe: string;
  candles: Candle[];
  freshness: "REALTIME" | "DELAYED" | "UNAVAILABLE";
  asOf: string | null;
  notes?: string;
}

export interface MarketProvider {
  readonly name: string;
  readonly connected: boolean;
  readonly notes?: string;
  readonly features: MarketProviderFeatures;
  getLiveQuote(symbol: string): Promise<MarketQuote>;
  getCandles(symbol: string, timeframe: string, limit?: number): Promise<CandleResult>;
  getMarketNews(query: string, limit?: number): Promise<{ connected: boolean; items: NewsItem[]; provider: string }>;
  getEconomicCalendar(opts?: { fromIso?: string; toIso?: string }): Promise<{ connected: boolean; events: EconomicEvent[]; provider: string }>;
  getSymbolOverview(symbol: string): Promise<{ connected: boolean; symbol: string; description: string | null; provider: string }>;
  getTradingSessionContext(): Promise<{ connected: boolean; sessions: Array<{ name: string; isOpen: boolean }>; nowUtc: string; provider: string }>;
  /** Phase 24 — Separate real-world / geopolitical events channel.
   *  OPTIONAL: providers that have not wired a real adapter omit this and the
   *  top-level wrapper `getCurrentEventsFromProvider()` returns connected:false. */
  getCurrentEvents?(limit?: number): Promise<CurrentEventsResult>;
}

/** Phase 24 — Top-level current-events fetch. NEVER fabricates: if no
 *  provider has implemented a real adapter (none do today), returns
 *  connected:false with an honest reason. Separate from `getRecentMarketNews`
 *  which is symbol-scoped financial news. */
export async function getCurrentEventsFromProvider(limit = 10): Promise<CurrentEventsResult> {
  const p = getMarketProvider();
  const fetchedAt = new Date().toISOString();
  if (typeof p.getCurrentEvents === "function") {
    try {
      const r = await p.getCurrentEvents(limit);
      // Defensive: if a real adapter returns malformed data, downgrade to connected:false.
      if (!r || typeof r !== "object" || !Array.isArray(r.events)) {
        return { connected: false, events: [], provider: p.name, reason: "Current-events adapter returned invalid shape.", fetchedAt };
      }
      return r;
    } catch (e) {
      return { connected: false, events: [], provider: p.name, reason: `Current-events adapter error: ${(e as Error).message}`, fetchedAt };
    }
  }
  return {
    connected: false,
    events: [],
    provider: p.name,
    reason: "No real-world / current-events provider is wired. Set a dedicated current-events API key (e.g. GDELT, NewsAPI top-headlines, or a geopolitical feed) to enable this channel. The assistant will NOT substitute symbol-scoped financial news as current events.",
    fetchedAt,
  };
}

// Phase 22O — Finnhub symbol + timeframe mapping for the scanner's universe.
const FINNHUB_RESOLUTION: Record<string, string> = {
  M1: "1", M5: "5", M15: "15", M30: "30", H1: "60", H4: "240", D1: "D",
};
function finnhubMapSymbol(sym: string): { kind: "forex" | "crypto" | "stock"; symbol: string } | null {
  const s = (sym ?? "").toUpperCase().trim();
  if (!s) return null;
  // Forex majors + gold (XAUUSD treated as forex on Finnhub via OANDA)
  const forex: Record<string, string> = {
    EURUSD: "OANDA:EUR_USD", GBPUSD: "OANDA:GBP_USD", USDJPY: "OANDA:USD_JPY",
    XAUUSD: "OANDA:XAU_USD", AUDUSD: "OANDA:AUD_USD", USDCAD: "OANDA:USD_CAD",
    USDCHF: "OANDA:USD_CHF", NZDUSD: "OANDA:NZD_USD",
  };
  if (forex[s]) return { kind: "forex", symbol: forex[s]! };
  // Crypto USDT pairs → Binance
  if (/^[A-Z]{3,6}USDT$/.test(s)) return { kind: "crypto", symbol: `BINANCE:${s}` };
  // Plain ticker → US stock
  if (/^[A-Z.]{1,8}$/.test(s)) return { kind: "stock", symbol: s };
  return null;
}

const PROVIDER_KEY_ENV_VARS = [
  "TWELVEDATA_API_KEY",
  "POLYGON_API_KEY",
  "FINNHUB_API_KEY",
  "ALPHA_VANTAGE_API_KEY",
  "NEWSAPI_API_KEY",
] as const;

// Polygon forex mapper. Polygon represents forex pairs as `C:BASEQUOTE`
// (e.g. EURUSD → C:EURUSD). Free tier covers forex aggregates + conversion.
function polygonForexPair(sym: string): { base: string; quote: string; ticker: string } | null {
  const s = (sym ?? "").toUpperCase().trim();
  const map: Record<string, [string, string]> = {
    EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], USDJPY: ["USD", "JPY"],
    XAUUSD: ["XAU", "USD"], AUDUSD: ["AUD", "USD"], USDCAD: ["USD", "CAD"],
    USDCHF: ["USD", "CHF"], NZDUSD: ["NZD", "USD"],
  };
  const p = map[s];
  if (!p) return null;
  return { base: p[0]!, quote: p[1]!, ticker: `C:${p[0]}${p[1]}` };
}
// Polygon aggregate timeframe mapper.
const POLYGON_TF: Record<string, { multiplier: number; timespan: string; barSeconds: number }> = {
  M1:  { multiplier: 1,  timespan: "minute", barSeconds: 60 },
  M5:  { multiplier: 5,  timespan: "minute", barSeconds: 300 },
  M15: { multiplier: 15, timespan: "minute", barSeconds: 900 },
  M30: { multiplier: 30, timespan: "minute", barSeconds: 1800 },
  H1:  { multiplier: 1,  timespan: "hour",   barSeconds: 3600 },
  H4:  { multiplier: 4,  timespan: "hour",   barSeconds: 14400 },
  D1:  { multiplier: 1,  timespan: "day",    barSeconds: 86400 },
};

// Phase 22O — TwelveData symbol + interval mapping for the scanner universe.
// TwelveData free tier: 800 req/day, 8 req/min. Covers forex+crypto+stocks.
const TWELVEDATA_INTERVAL: Record<string, string> = {
  M1: "1min", M5: "5min", M15: "15min", M30: "30min", H1: "1h", H4: "4h", D1: "1day",
};
function twelveDataMapSymbol(sym: string): string | null {
  const s = (sym ?? "").toUpperCase().trim();
  if (!s) return null;
  const forex: Record<string, string> = {
    EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY",
    XAUUSD: "XAU/USD", AUDUSD: "AUD/USD", USDCAD: "USD/CAD",
    USDCHF: "USD/CHF", NZDUSD: "NZD/USD",
  };
  if (forex[s]) return forex[s]!;
  // Crypto USDT pair → TwelveData uses BASE/USD form
  const cryptoMatch = s.match(/^([A-Z]{3,6})USDT$/);
  if (cryptoMatch) return `${cryptoMatch[1]}/USD`;
  if (/^[A-Z.]{1,8}$/.test(s)) return s; // stock
  return null;
}

// ── Liveness tracking (per provider) ─────────────────────────────────────
// Phase: Market Data Freshness — extended fields (lastAttemptedFetchAt,
// lastErrorMessage, lastErrorAt) so the UI and assistant can honestly
// distinguish "fresh" / "stale" / "unavailable due to error" / "never
// attempted" states instead of just showing a connected:true label.
// `lastObservedDataFreshness` / `lastObservedDataSource` track the
// *quality* of the most recent successful payload, NOT just whether the
// provider responded. Without this, when TwelveData is rate-limited and
// Polygon's free-tier /prev endpoint serves a DELAYED bar, the global
// status would falsely report FRESH because a fetch "succeeded" — that
// is the lie the user just caught (Ruby saying "feed is fresh" then
// "data is delayed" in the same conversation).
const providerLiveness = {
  lastCheckedAt: null as string | null,
  lastSuccessfulFetchAt: null as string | null,
  lastAttemptedFetchAt: null as string | null,
  lastErrorMessage: null as string | null,
  lastErrorAt: null as string | null,
  lastObservedDataFreshness: null as "REALTIME" | "DELAYED" | "UNAVAILABLE" | null,
  lastObservedDataSource: null as string | null,
};
function markChecked() {
  const n = new Date().toISOString();
  providerLiveness.lastCheckedAt = n;
  providerLiveness.lastAttemptedFetchAt = n;
}
function markSuccess(observed?: { freshness?: "REALTIME" | "DELAYED" | "UNAVAILABLE"; source?: string }) {
  const n = new Date().toISOString();
  providerLiveness.lastCheckedAt = n;
  providerLiveness.lastAttemptedFetchAt = n;
  providerLiveness.lastSuccessfulFetchAt = n;
  // Clear any previous error on a real success.
  providerLiveness.lastErrorMessage = null;
  providerLiveness.lastErrorAt = null;
  // Record the per-payload honesty signal if the caller supplied one.
  // Defaults are intentionally NOT set here — callers that omit this
  // remain "REALTIME" only if a prior call set it; otherwise null.
  if (observed?.freshness) providerLiveness.lastObservedDataFreshness = observed.freshness;
  if (observed?.source) providerLiveness.lastObservedDataSource = observed.source;
}
function markError(msg: string) {
  const n = new Date().toISOString();
  providerLiveness.lastCheckedAt = n;
  providerLiveness.lastAttemptedFetchAt = n;
  providerLiveness.lastErrorMessage = String(msg ?? "unknown_error").slice(0, 280);
  providerLiveness.lastErrorAt = n;
}
// Quote-freshness thresholds come from the shared freshness module so the
// assistant classifies "stale" identically to every other analysis surface.
function isStaleNow(): boolean {
  if (!providerLiveness.lastSuccessfulFetchAt) return true;
  const ageMs = Date.now() - new Date(providerLiveness.lastSuccessfulFetchAt).getTime();
  return classifyQuoteFreshness(ageMs).stale;
}

// ── Brief in-memory cache to avoid API spam (shared TTLs) ────────────────
const QUOTE_TTL_MS = QUOTE_FRESH_TTL_MS;
const NEWS_TTL_MS = ASSISTANT_NEWS_CACHE_TTL_MS;
// Phase 22O — Candle cache. TwelveData free tier is 8 req/min; one scan
// fires up to 16 candle requests across (symbol × timeframe) pairs. The
// shared 60s TTL plus in-flight Promise dedupe keeps repeated/concurrent
// scans inside the rate budget without ever invalidating real data with
// simulator data.
const CANDLE_TTL_MS = ASSISTANT_CANDLE_CACHE_TTL_MS;
const quoteCache = new Map<string, { at: number; value: MarketQuote }>();
const newsCache = new Map<string, { at: number; value: { connected: boolean; items: NewsItem[]; provider: string } }>();
const candleCache = new Map<string, { at: number; value: CandleResult }>();
const candleInflight = new Map<string, Promise<CandleResult>>();

function cacheGet<T>(map: Map<string, { at: number; value: T }>, key: string, ttl: number): T | null {
  const e = map.get(key);
  if (!e) return null;
  if (Date.now() - e.at > ttl) { map.delete(key); return null; }
  return e.value;
}
function cacheSet<T>(map: Map<string, { at: number; value: T }>, key: string, value: T): void {
  map.set(key, { at: Date.now(), value });
  if (map.size > 200) {
    // Drop oldest entries
    const entries = Array.from(map.entries()).sort((a, b) => a[1].at - b[1].at).slice(0, map.size - 100);
    for (const [k] of entries) map.delete(k);
  }
}

// ── Symbol validation (alphanumeric + . / : - _, max 24) ─────────────────
const SYMBOL_RE = /^[A-Za-z0-9._:\-/=]{1,24}$/;
export function validateSymbol(s: string): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toUpperCase();
  if (!t || !SYMBOL_RE.test(t)) return null;
  return t;
}

// ── HTTP helper with timeout, never throws to caller ─────────────────────
async function httpJson(url: string, headers?: Record<string, string>, timeoutMs = 5000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) {
      logger.warn({ url: url.replace(/[?&](apikey|token|api_key|apiKey)=[^&]+/gi, "$1=REDACTED"), status: r.status }, "marketProvider http non-2xx");
      return null;
    }
    return await r.json();
  } catch (e) {
    logger.warn({ url: url.replace(/[?&](apikey|token|api_key|apiKey)=[^&]+/gi, "$1=REDACTED"), err: (e as Error).message }, "marketProvider http error");
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── Empty quote helper ───────────────────────────────────────────────────
function emptyQuote(symbol: string, source: string, freshness: MarketQuote["freshness"] = "UNAVAILABLE"): MarketQuote {
  return {
    symbol, price: null, bid: null, ask: null, change: null, changePct: null,
    high: null, low: null, open: null, previousClose: null,
    asOf: null, freshness, source, stale: true,
  };
}

// ── Common session computation ───────────────────────────────────────────
function computeSessions() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay();
  const isWeekday = utcDay >= 1 && utcDay <= 5;
  return {
    nowUtc: now.toISOString(),
    sessions: [
      { name: "Tokyo", isOpen: isWeekday && (utcHour >= 0 && utcHour < 9) },
      { name: "London", isOpen: isWeekday && (utcHour >= 7 && utcHour < 16) },
      { name: "New York", isOpen: isWeekday && (utcHour >= 13 && utcHour < 22) },
      { name: "Sydney", isOpen: isWeekday && (utcHour >= 21 || utcHour < 6) },
    ],
  };
}

// ── nullProvider (no key set) ────────────────────────────────────────────
function nullProvider(): MarketProvider {
  return {
    name: "none",
    connected: false,
    notes: "No market data provider configured. Set one of: " + PROVIDER_KEY_ENV_VARS.join(", "),
    features: { quotes: false, news: false, snapshots: false, economicCalendar: false, candles: false },
    async getLiveQuote(symbol) { return emptyQuote(symbol || "", "no_provider_configured"); },
    async getCandles(symbol, timeframe) {
      return { connected: false, source: "none", symbol, timeframe, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: "No market data provider configured." };
    },
    async getMarketNews() { return { connected: false, items: [], provider: "none" }; },
    async getEconomicCalendar() { return { connected: false, events: [], provider: "none" }; },
    async getSymbolOverview(symbol) { return { connected: false, symbol, description: null, provider: "none" }; },
    async getTradingSessionContext() {
      const s = computeSessions();
      return { connected: false, sessions: s.sessions, nowUtc: s.nowUtc, provider: "deterministic_clock_only" };
    },
  };
}

// ── TwelveData adapter (Phase 22O — primary candle source) ──────────────
// Free tier: 800 req/day, 8 req/min. Quotes + OHLC for forex, crypto, stocks.
function twelveDataProvider(apiKey: string, newsApiKey: string | null): MarketProvider {
  const base = "https://api.twelvedata.com";
  return {
    name: "twelve_data",
    connected: true,
    notes: "Twelve Data connected. Real OHLC candles + quotes (free tier: 800 req/day, 8/min).",
    features: { quotes: true, news: false, snapshots: true, economicCalendar: false, candles: true },
    async getCandles(rawSymbol, timeframe, limit = 30) {
      const tf = (timeframe || "M15").toUpperCase();
      const interval = TWELVEDATA_INTERVAL[tf];
      const tdSym = twelveDataMapSymbol(rawSymbol);
      if (!interval || !tdSym) {
        return { connected: true, source: "twelve_data", symbol: rawSymbol, timeframe: tf, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: !interval ? `Unsupported timeframe ${tf}` : `Unsupported symbol mapping for ${rawSymbol}` };
      }
      const safeLimit = Math.max(10, Math.min(200, limit));
      const url = `${base}/time_series?symbol=${encodeURIComponent(tdSym)}&interval=${encodeURIComponent(interval)}&outputsize=${safeLimit}&apikey=${encodeURIComponent(apiKey)}`;
      markChecked();
      const j = (await httpJson(url).catch(() => null)) as { status?: string; values?: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume?: string }>; message?: string; code?: number } | null;
      if (!j || j.status === "error" || !Array.isArray(j.values) || j.values.length === 0) {
        const reason = j?.message ?? `status=${j?.status ?? "no_response"}`;
        markError(`candles ${tdSym}@${interval}: ${reason}`);
        return { connected: true, source: "twelve_data", symbol: rawSymbol, timeframe: tf, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: `Twelve Data returned no candle data for ${tdSym} @ ${interval}: ${reason}` };
      }
      // TwelveData returns newest-first; reverse to chronological for scoring
      const ordered = [...j.values].reverse();
      const candles: Candle[] = [];
      for (const r of ordered) {
        const o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close), v = Number(r.volume ?? 0);
        if (![o, h, l, c].every(Number.isFinite)) continue;
        // datetime is "YYYY-MM-DD HH:MM:SS" in UTC
        const iso = r.datetime.includes("T") ? r.datetime : r.datetime.replace(" ", "T") + "Z";
        candles.push({ t: iso, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
      }
      if (candles.length === 0) {
        markError(`candles ${tdSym}@${interval}: zero parsed numeric rows`);
        return { connected: true, source: "twelve_data", symbol: rawSymbol, timeframe: tf, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: `Twelve Data returned values for ${tdSym} but none parsed as numeric.` };
      }
      markSuccess({ freshness: "REALTIME", source: "twelve_data" });
      return { connected: true, source: "twelve_data", symbol: tdSym, timeframe: tf, candles, freshness: "REALTIME", asOf: candles[candles.length - 1]!.t };
    },
    async getLiveQuote(rawSymbol) {
      const symbol = validateSymbol(rawSymbol);
      if (!symbol) return emptyQuote(rawSymbol || "", "twelve_data", "ERROR");
      const cached = cacheGet(quoteCache, `td:${symbol}`, QUOTE_TTL_MS);
      if (cached) return cached;
      markChecked();
      const tdSym = twelveDataMapSymbol(symbol) ?? symbol;
      const url = `${base}/quote?symbol=${encodeURIComponent(tdSym)}&apikey=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url).catch(() => null)) as { status?: string; close?: string; open?: string; high?: string; low?: string; previous_close?: string; change?: string; percent_change?: string; timestamp?: number } | null;
      if (!j || j.status === "error" || j.close == null) {
        markError(`quote ${symbol}: ${j?.status === "error" ? "provider_error" : "no_response_or_missing_close"}`);
        const q = emptyQuote(symbol, "twelve_data", "UNAVAILABLE");
        cacheSet(quoteCache, `td:${symbol}`, q);
        return q;
      }
      const num = (s: string | undefined) => (s == null ? null : Number.isFinite(Number(s)) ? Number(s) : null);
      // A present-but-unparseable close is a FAILED read, not a price of zero.
      // Defaulting to 0 here would surface a confident REALTIME "price 0" when
      // TwelveData is the only configured quote provider (the composite chain's
      // price > 0 filter never sees it). Degrade to an honest UNAVAILABLE quote.
      const price = num(j.close);
      if (price == null) {
        markError(`quote ${symbol}: close present but not numeric`);
        const bad = emptyQuote(symbol, "twelve_data", "UNAVAILABLE");
        cacheSet(quoteCache, `td:${symbol}`, bad);
        return bad;
      }
      const q: MarketQuote = {
        symbol,
        price,
        bid: null, ask: null,
        change: num(j.change), changePct: num(j.percent_change),
        high: num(j.high), low: num(j.low),
        open: num(j.open), previousClose: num(j.previous_close),
        asOf: j.timestamp ? new Date(j.timestamp * 1000).toISOString() : new Date().toISOString(),
        freshness: "REALTIME", source: "twelve_data", stale: false,
      };
      markSuccess({ freshness: "REALTIME", source: "twelve_data" });
      cacheSet(quoteCache, `td:${symbol}`, q);
      return q;
    },
    async getMarketNews(query, limit = 5) {
      // TwelveData has no news endpoint on free tier — defer to NewsAPI if configured.
      if (newsApiKey) return newsApiFetch(newsApiKey, query, limit);
      return { connected: false, items: [], provider: "twelve_data" };
    },
    async getEconomicCalendar() { return { connected: false, events: [], provider: "twelve_data" }; },
    async getSymbolOverview(symbol) {
      return { connected: true, symbol, description: null, provider: "twelve_data" };
    },
    async getTradingSessionContext() {
      const s = computeSessions();
      return { connected: true, sessions: s.sessions, nowUtc: s.nowUtc, provider: "twelve_data" };
    },
  };
}

// ── Polygon adapter ──────────────────────────────────────────────────────
// Supports US equities (snapshot quotes) AND forex (aggregate candles +
// conversion-rate quotes). Forex aggregates work on Polygon's free tier
// and become the resilient fallback when TwelveData hits its daily cap.
function polygonProvider(apiKey: string, newsApiKey: string | null): MarketProvider {
  const base = "https://api.polygon.io";
  return {
    name: "polygon",
    connected: true,
    notes: "Polygon connected. Forex (aggregates + conversion) and US equities (snapshot).",
    features: { quotes: true, news: true, snapshots: true, economicCalendar: false, candles: true },
    async getCandles(rawSymbol, timeframe, limit = 30) {
      const tf = (timeframe || "M15").toUpperCase();
      const tfDef = POLYGON_TF[tf];
      const fx = polygonForexPair(rawSymbol);
      if (!tfDef) {
        return { connected: true, source: "polygon", symbol: rawSymbol, timeframe: tf, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: `Unsupported timeframe ${tf}` };
      }
      // Only forex aggregates wired here. Stock aggregates would use a plain
      // ticker (no `C:` prefix) but the stock adapter path is not in scope.
      if (!fx) {
        return { connected: true, source: "polygon", symbol: rawSymbol, timeframe: tf, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: `Polygon adapter currently maps only the supported forex universe; ${rawSymbol} not recognised.` };
      }
      const safeLimit = Math.max(10, Math.min(200, limit));
      // Pad the window 6x for weekends/closed sessions; Polygon caps `limit` server-side.
      const nowMs = Date.now();
      const fromMs = nowMs - tfDef.barSeconds * 1000 * safeLimit * 6;
      const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      // sort=desc + limit=N → server returns the MOST RECENT N bars in the
      // window. We then reverse to chronological (oldest → newest) for the
      // scanner / ATR consumers. Using sort=asc here would return the OLDEST
      // N bars (i.e. the start of the padded window), producing stale data.
      const url = `${base}/v2/aggs/ticker/${encodeURIComponent(fx.ticker)}/range/${tfDef.multiplier}/${tfDef.timespan}/${fmt(fromMs)}/${fmt(nowMs)}?adjusted=true&sort=desc&limit=${safeLimit}&apiKey=${encodeURIComponent(apiKey)}`;
      markChecked();
      const j = (await httpJson(url).catch(() => null)) as { status?: string; results?: Array<{ t: number; o: number; h: number; l: number; c: number; v?: number }>; resultsCount?: number; error?: string; message?: string } | null;
      if (!j || !Array.isArray(j.results) || j.results.length === 0) {
        const reason = j?.error ?? j?.message ?? j?.status ?? "no_response";
        markError(`polygon candles ${fx.ticker}@${tf}: ${reason}`);
        return { connected: true, source: "polygon", symbol: rawSymbol, timeframe: tf, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: `Polygon returned no candle data for ${fx.ticker} @ ${tf}: ${reason}` };
      }
      const ordered = [...j.results].reverse(); // desc → asc (chronological)
      const candles: Candle[] = [];
      for (const r of ordered) {
        if (![r.o, r.h, r.l, r.c].every((x) => typeof x === "number" && Number.isFinite(x))) continue;
        candles.push({ t: new Date(r.t).toISOString(), o: r.o, h: r.h, l: r.l, c: r.c, v: typeof r.v === "number" ? r.v : 0 });
      }
      if (candles.length === 0) {
        markError(`polygon candles ${fx.ticker}@${tf}: zero parsed rows`);
        return { connected: true, source: "polygon", symbol: rawSymbol, timeframe: tf, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: `Polygon returned aggregate rows for ${fx.ticker} but none parsed as numeric.` };
      }
      // Polygon free tier D1 bars are the latest closed daily bar — current
      // for end-of-day analysis. Intraday timeframes are usually empty/1-bar
      // and surface upstream as insufficient (the consumer decides).
      markSuccess({ freshness: "REALTIME", source: "polygon" });
      return { connected: true, source: "polygon", symbol: fx.ticker, timeframe: tf, candles, freshness: "REALTIME", asOf: candles[candles.length - 1]!.t };
    },
    async getLiveQuote(rawSymbol) {
      const symbol = validateSymbol(rawSymbol);
      if (!symbol) return emptyQuote(rawSymbol || "", "polygon", "ERROR");
      const cached = cacheGet(quoteCache, `polygon:${symbol}`, QUOTE_TTL_MS);
      if (cached) return cached;
      markChecked();
      // Forex: use the `/prev` aggregate endpoint (works on Polygon's free
      // tier; the `/v1/conversion/*` and forex snapshot endpoints are paid).
      // The bar timestamp is end-of-trading-day, so we honestly mark this as
      // DELAYED. Adequate for an end-of-day stop-loss recommendation when
      // TwelveData (real-time) has hit its daily cap.
      const fx = polygonForexPair(symbol);
      if (fx) {
        const url = `${base}/v2/aggs/ticker/${encodeURIComponent(fx.ticker)}/prev?adjusted=true&apiKey=${encodeURIComponent(apiKey)}`;
        const j = (await httpJson(url)) as { status?: string; results?: Array<{ T?: string; o?: number; h?: number; l?: number; c?: number; v?: number; t?: number }>; error?: string; message?: string } | null;
        const bar = Array.isArray(j?.results) && j!.results.length > 0 ? j!.results[0]! : null;
        const price = typeof bar?.c === "number" && Number.isFinite(bar.c) && bar.c > 0 ? bar.c : null;
        if (!bar || price == null) {
          markError(`polygon fx ${fx.ticker}/prev: ${j?.error ?? j?.message ?? j?.status ?? "no_bar"}`);
          const q = emptyQuote(symbol, "polygon", "UNAVAILABLE");
          cacheSet(quoteCache, `polygon:${symbol}`, q);
          return q;
        }
        const q: MarketQuote = {
          symbol,
          price,
          bid: null, ask: null,
          change: typeof bar.o === "number" ? +(price - bar.o).toFixed(6) : null,
          changePct: typeof bar.o === "number" && bar.o !== 0 ? +(((price - bar.o) / bar.o) * 100).toFixed(4) : null,
          high: bar.h ?? null, low: bar.l ?? null,
          open: bar.o ?? null, previousClose: null,
          asOf: typeof bar.t === "number" ? new Date(bar.t).toISOString() : new Date().toISOString(),
          freshness: "DELAYED",
          source: "polygon",
          stale: false,
        };
        // The Polygon /prev bar is yesterday's EOD close, never a live tick.
        // Recording DELAYED here is what stops the global status badge from
        // falsely claiming "FRESH" when only the Polygon fallback is alive.
        markSuccess({ freshness: "DELAYED", source: "polygon" });
        cacheSet(quoteCache, `polygon:${symbol}`, q);
        return q;
      }
      // Stocks: snapshot endpoint (unchanged from prior adapter).
      const url = `${base}/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}?apiKey=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url)) as { ticker?: { lastTrade?: { p?: number; t?: number }; day?: { o?: number; h?: number; l?: number; c?: number }; prevDay?: { c?: number }; todaysChange?: number; todaysChangePerc?: number; updated?: number } } | null;
      const t = j?.ticker;
      if (!t) {
        const q = emptyQuote(symbol, "polygon", "UNAVAILABLE");
        cacheSet(quoteCache, `polygon:${symbol}`, q);
        return q;
      }
      const price = t.lastTrade?.p ?? t.day?.c ?? null;
      const asOfMs = t.updated ?? t.lastTrade?.t ?? null;
      const q: MarketQuote = {
        symbol,
        price: price ?? null,
        bid: null, ask: null,
        change: t.todaysChange ?? null,
        changePct: t.todaysChangePerc ?? null,
        high: t.day?.h ?? null, low: t.day?.l ?? null,
        open: t.day?.o ?? null, previousClose: t.prevDay?.c ?? null,
        asOf: asOfMs ? new Date(typeof asOfMs === "number" && asOfMs > 1e12 ? asOfMs / 1e6 : asOfMs).toISOString() : null,
        freshness: price != null ? "REALTIME" : "UNAVAILABLE",
        source: "polygon",
        stale: false,
      };
      if (price != null) markSuccess();
      cacheSet(quoteCache, `polygon:${symbol}`, q);
      return q;
    },
    async getMarketNews(query, limit = 5) {
      const cacheKey = `polygon:news:${query}:${limit}`;
      const cached = cacheGet(newsCache, cacheKey, NEWS_TTL_MS);
      if (cached) return cached;
      markChecked();
      const url = `${base}/v2/reference/news?limit=${Math.min(Math.max(limit, 1), 20)}${query ? `&ticker=${encodeURIComponent(validateSymbol(query) ?? "")}` : ""}&apiKey=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url)) as { results?: Array<{ title?: string; article_url?: string; published_utc?: string; publisher?: { name?: string }; tickers?: string[]; description?: string }> } | null;
      if (!j?.results) {
        // fall through to NewsAPI if available
        if (newsApiKey) {
          const fb = await newsApiFetch(newsApiKey, query, limit);
          cacheSet(newsCache, cacheKey, fb);
          return fb;
        }
        const r = { connected: true, items: [], provider: "polygon" };
        cacheSet(newsCache, cacheKey, r);
        return r;
      }
      const items: NewsItem[] = j.results.map((n) => ({
        headline: String(n.title ?? "").slice(0, 300),
        url: String(n.article_url ?? ""),
        publishedAt: String(n.published_utc ?? new Date().toISOString()),
        source: String(n.publisher?.name ?? "polygon"),
        symbols: Array.isArray(n.tickers) ? n.tickers.slice(0, 8) : undefined,
        summary: typeof n.description === "string" ? n.description.slice(0, 500) : undefined,
      }));
      markSuccess();
      const r = { connected: true, items, provider: "polygon" };
      cacheSet(newsCache, cacheKey, r);
      return r;
    },
    async getEconomicCalendar() { return { connected: false, events: [], provider: "polygon_no_calendar" }; },
    async getSymbolOverview(rawSymbol) {
      const symbol = validateSymbol(rawSymbol);
      if (!symbol) return { connected: true, symbol: rawSymbol, description: null, provider: "polygon" };
      markChecked();
      const url = `${base}/v3/reference/tickers/${encodeURIComponent(symbol)}?apiKey=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url)) as { results?: { description?: string; name?: string } } | null;
      if (j?.results) markSuccess();
      return { connected: true, symbol, description: j?.results?.description ?? j?.results?.name ?? null, provider: "polygon" };
    },
    async getTradingSessionContext() {
      const s = computeSessions();
      return { connected: true, sessions: s.sessions, nowUtc: s.nowUtc, provider: "polygon" };
    },
  };
}

// ── Finnhub adapter ──────────────────────────────────────────────────────
function finnhubProvider(apiKey: string, newsApiKey: string | null): MarketProvider {
  const base = "https://finnhub.io/api/v1";
  return {
    name: "finnhub",
    connected: true,
    notes: "Finnhub connected.",
    features: { quotes: true, news: true, snapshots: true, economicCalendar: false, candles: true },
    async getCandles(rawSymbol, timeframe, limit = 30) {
      const tf = (timeframe || "M15").toUpperCase();
      const resolution = FINNHUB_RESOLUTION[tf];
      const mapped = finnhubMapSymbol(rawSymbol);
      if (!resolution || !mapped) {
        return { connected: true, source: "finnhub", symbol: rawSymbol, timeframe: tf, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: !resolution ? `Unsupported timeframe ${tf}` : `Unsupported symbol mapping for ${rawSymbol}` };
      }
      // Window: enough seconds to (almost certainly) cover `limit` bars on this resolution
      const tfSeconds = resolution === "D" ? 86400 : Number(resolution) * 60;
      const safeLimit = Math.max(10, Math.min(200, limit));
      const now = Math.floor(Date.now() / 1000);
      // Pad the window 6x for weekends/closed sessions; Finnhub returns up to the bars available
      const from = now - tfSeconds * safeLimit * 6;
      const path = mapped.kind === "forex" ? "forex/candle" : mapped.kind === "crypto" ? "crypto/candle" : "stock/candle";
      const url = `${base}/${path}?symbol=${encodeURIComponent(mapped.symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${encodeURIComponent(apiKey)}`;
      markChecked();
      const j = (await httpJson(url).catch(() => null)) as { s?: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; v?: number[] } | null;
      if (!j || j.s !== "ok" || !Array.isArray(j.t) || !Array.isArray(j.c) || j.c.length === 0) {
        return { connected: true, source: "finnhub", symbol: rawSymbol, timeframe: tf, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: `Finnhub returned no candle data for ${mapped.symbol} @ ${resolution} (status=${j?.s ?? "no_response"}). May be tier-restricted or off-hours.` };
      }
      const n = Math.min(j.t.length, safeLimit);
      const start = j.t.length - n;
      const candles: Candle[] = [];
      for (let i = start; i < j.t.length; i++) {
        const t = j.t[i]; const o = j.o?.[i]; const h = j.h?.[i]; const l = j.l?.[i]; const c = j.c?.[i]; const v = j.v?.[i] ?? 0;
        if (typeof t !== "number" || typeof o !== "number" || typeof h !== "number" || typeof l !== "number" || typeof c !== "number") continue;
        candles.push({ t: new Date(t * 1000).toISOString(), o, h, l, c, v });
      }
      markSuccess();
      const lastT = candles[candles.length - 1]?.t ?? null;
      return { connected: true, source: "finnhub", symbol: mapped.symbol, timeframe: tf, candles, freshness: "REALTIME", asOf: lastT };
    },
    async getLiveQuote(rawSymbol) {
      const symbol = validateSymbol(rawSymbol);
      if (!symbol) return emptyQuote(rawSymbol || "", "finnhub", "ERROR");
      const cached = cacheGet(quoteCache, `finnhub:${symbol}`, QUOTE_TTL_MS);
      if (cached) return cached;
      markChecked();
      const url = `${base}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url)) as { c?: number; d?: number; dp?: number; h?: number; l?: number; o?: number; pc?: number; t?: number } | null;
      if (!j || typeof j.c !== "number" || j.c === 0) {
        const q = emptyQuote(symbol, "finnhub", "UNAVAILABLE");
        cacheSet(quoteCache, `finnhub:${symbol}`, q);
        return q;
      }
      const q: MarketQuote = {
        symbol,
        price: j.c, bid: null, ask: null,
        change: j.d ?? null, changePct: j.dp ?? null,
        high: j.h ?? null, low: j.l ?? null,
        open: j.o ?? null, previousClose: j.pc ?? null,
        asOf: j.t ? new Date(j.t * 1000).toISOString() : new Date().toISOString(),
        freshness: "REALTIME", source: "finnhub", stale: false,
      };
      markSuccess();
      cacheSet(quoteCache, `finnhub:${symbol}`, q);
      return q;
    },
    async getMarketNews(query, limit = 5) {
      const cacheKey = `finnhub:news:${query}:${limit}`;
      const cached = cacheGet(newsCache, cacheKey, NEWS_TTL_MS);
      if (cached) return cached;
      markChecked();
      const symbol = validateSymbol(query);
      const url = symbol
        ? `${base}/company-news?symbol=${encodeURIComponent(symbol)}&from=${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}&token=${encodeURIComponent(apiKey)}`
        : `${base}/news?category=general&token=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url)) as Array<{ headline?: string; url?: string; datetime?: number; source?: string; related?: string; summary?: string }> | null;
      if (!Array.isArray(j)) {
        if (newsApiKey) {
          const fb = await newsApiFetch(newsApiKey, query, limit);
          cacheSet(newsCache, cacheKey, fb);
          return fb;
        }
        const r = { connected: true, items: [], provider: "finnhub" };
        cacheSet(newsCache, cacheKey, r);
        return r;
      }
      const items: NewsItem[] = j.slice(0, Math.min(limit, 20)).map((n) => ({
        headline: String(n.headline ?? "").slice(0, 300),
        url: String(n.url ?? ""),
        publishedAt: n.datetime ? new Date(n.datetime * 1000).toISOString() : new Date().toISOString(),
        source: String(n.source ?? "finnhub"),
        symbols: n.related ? String(n.related).split(",").filter(Boolean).slice(0, 8) : undefined,
        summary: typeof n.summary === "string" ? n.summary.slice(0, 500) : undefined,
      }));
      markSuccess();
      const r = { connected: true, items, provider: "finnhub" };
      cacheSet(newsCache, cacheKey, r);
      return r;
    },
    async getEconomicCalendar() {
      markChecked();
      const url = `${base}/calendar/economic?token=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url)) as { economicCalendar?: Array<{ time?: string; country?: string; event?: string; impact?: string; estimate?: string; prev?: string }> } | null;
      if (!j?.economicCalendar) return { connected: true, events: [], provider: "finnhub" };
      const events: EconomicEvent[] = j.economicCalendar.slice(0, 50).map((e) => ({
        whenIso: String(e.time ?? new Date().toISOString()),
        region: String(e.country ?? "?"),
        title: String(e.event ?? ""),
        importance: (e.impact === "high" || e.impact === "medium" || e.impact === "low") ? e.impact : "low",
        forecast: e.estimate ?? null,
        previous: e.prev ?? null,
      }));
      markSuccess();
      return { connected: true, events, provider: "finnhub" };
    },
    async getSymbolOverview(rawSymbol) {
      const symbol = validateSymbol(rawSymbol);
      if (!symbol) return { connected: true, symbol: rawSymbol, description: null, provider: "finnhub" };
      markChecked();
      const url = `${base}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url)) as { name?: string; finnhubIndustry?: string } | null;
      if (j) markSuccess();
      const desc = j?.name ? `${j.name}${j.finnhubIndustry ? ` (${j.finnhubIndustry})` : ""}` : null;
      return { connected: true, symbol, description: desc, provider: "finnhub" };
    },
    async getTradingSessionContext() {
      const s = computeSessions();
      return { connected: true, sessions: s.sessions, nowUtc: s.nowUtc, provider: "finnhub" };
    },
  };
}

// ── Alpha Vantage adapter ────────────────────────────────────────────────
function alphaVantageProvider(apiKey: string, newsApiKey: string | null): MarketProvider {
  const base = "https://www.alphavantage.co/query";
  return {
    name: "alpha_vantage",
    connected: true,
    notes: "Alpha Vantage connected. Note: free tier has strict rate limits.",
    features: { quotes: true, news: true, snapshots: true, economicCalendar: false, candles: false },
    async getCandles(symbol, timeframe) {
      // Alpha Vantage candle support not wired in this adapter yet (Phase 22O scoped to Finnhub).
      return { connected: true, source: "alpha_vantage", symbol, timeframe, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: "Alpha Vantage candle support not implemented in this adapter yet. Set FINNHUB_API_KEY to use live scanner candles." };
    },
    async getLiveQuote(rawSymbol) {
      const symbol = validateSymbol(rawSymbol);
      if (!symbol) return emptyQuote(rawSymbol || "", "alpha_vantage", "ERROR");
      const cached = cacheGet(quoteCache, `av:${symbol}`, QUOTE_TTL_MS);
      if (cached) return cached;
      markChecked();
      const url = `${base}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url)) as { "Global Quote"?: Record<string, string> } | null;
      const g = j?.["Global Quote"];
      if (!g || !g["05. price"]) {
        const q = emptyQuote(symbol, "alpha_vantage", "UNAVAILABLE");
        cacheSet(quoteCache, `av:${symbol}`, q);
        return q;
      }
      const num = (k: string) => { const n = parseFloat(g[k] ?? ""); return Number.isFinite(n) ? n : null; };
      const q: MarketQuote = {
        symbol,
        price: num("05. price"), bid: null, ask: null,
        change: num("09. change"),
        changePct: (() => { const s = (g["10. change percent"] ?? "").replace("%", ""); const n = parseFloat(s); return Number.isFinite(n) ? n : null; })(),
        high: num("03. high"), low: num("04. low"),
        open: num("02. open"), previousClose: num("08. previous close"),
        asOf: g["07. latest trading day"] ? new Date(g["07. latest trading day"]).toISOString() : new Date().toISOString(),
        freshness: "DELAYED", source: "alpha_vantage", stale: false,
      };
      if (q.price != null) markSuccess();
      cacheSet(quoteCache, `av:${symbol}`, q);
      return q;
    },
    async getMarketNews(query, limit = 5) {
      const cacheKey = `av:news:${query}:${limit}`;
      const cached = cacheGet(newsCache, cacheKey, NEWS_TTL_MS);
      if (cached) return cached;
      markChecked();
      const symbol = validateSymbol(query);
      const url = `${base}?function=NEWS_SENTIMENT${symbol ? `&tickers=${encodeURIComponent(symbol)}` : ""}&limit=${Math.min(Math.max(limit, 1), 20)}&apikey=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url)) as { feed?: Array<{ title?: string; url?: string; time_published?: string; source?: string; ticker_sentiment?: Array<{ ticker?: string }>; summary?: string }> } | null;
      if (!j?.feed) {
        if (newsApiKey) {
          const fb = await newsApiFetch(newsApiKey, query, limit);
          cacheSet(newsCache, cacheKey, fb);
          return fb;
        }
        const r = { connected: true, items: [], provider: "alpha_vantage" };
        cacheSet(newsCache, cacheKey, r);
        return r;
      }
      const items: NewsItem[] = j.feed.slice(0, limit).map((n) => ({
        headline: String(n.title ?? "").slice(0, 300),
        url: String(n.url ?? ""),
        publishedAt: n.time_published
          ? `${n.time_published.slice(0, 4)}-${n.time_published.slice(4, 6)}-${n.time_published.slice(6, 8)}T${n.time_published.slice(9, 11)}:${n.time_published.slice(11, 13)}:${n.time_published.slice(13, 15) || "00"}Z`
          : new Date().toISOString(),
        source: String(n.source ?? "alpha_vantage"),
        symbols: Array.isArray(n.ticker_sentiment) ? n.ticker_sentiment.map((t) => t.ticker ?? "").filter(Boolean).slice(0, 8) : undefined,
        summary: typeof n.summary === "string" ? n.summary.slice(0, 500) : undefined,
      }));
      markSuccess();
      const r = { connected: true, items, provider: "alpha_vantage" };
      cacheSet(newsCache, cacheKey, r);
      return r;
    },
    async getEconomicCalendar() { return { connected: false, events: [], provider: "alpha_vantage_no_calendar" }; },
    async getSymbolOverview(rawSymbol) {
      const symbol = validateSymbol(rawSymbol);
      if (!symbol) return { connected: true, symbol: rawSymbol, description: null, provider: "alpha_vantage" };
      markChecked();
      const url = `${base}?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
      const j = (await httpJson(url)) as { Description?: string; Name?: string } | null;
      if (j) markSuccess();
      return { connected: true, symbol, description: j?.Description ?? j?.Name ?? null, provider: "alpha_vantage" };
    },
    async getTradingSessionContext() {
      const s = computeSessions();
      return { connected: true, sessions: s.sessions, nowUtc: s.nowUtc, provider: "alpha_vantage" };
    },
  };
}

// ── NewsAPI helper (news only) ───────────────────────────────────────────
async function newsApiFetch(apiKey: string, query: string, limit: number) {
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query || "markets")}&pageSize=${Math.min(Math.max(limit, 1), 20)}&sortBy=publishedAt&language=en&apiKey=${encodeURIComponent(apiKey)}`;
  const j = (await httpJson(url)) as { articles?: Array<{ title?: string; url?: string; publishedAt?: string; source?: { name?: string }; description?: string }> } | null;
  if (!j?.articles) return { connected: true, items: [], provider: "newsapi" };
  const items: NewsItem[] = j.articles.slice(0, limit).map((a) => ({
    headline: String(a.title ?? "").slice(0, 300),
    url: String(a.url ?? ""),
    publishedAt: String(a.publishedAt ?? new Date().toISOString()),
    source: String(a.source?.name ?? "newsapi"),
    summary: typeof a.description === "string" ? a.description.slice(0, 500) : undefined,
  }));
  markSuccess();
  return { connected: true, items, provider: "newsapi" };
}

// ── Selection (priority: Polygon > Finnhub > Alpha Vantage) ──────────────
let _provider: MarketProvider | null = null;
let _newsOnlyKey: string | null = null;
function key(name: string): string | null {
  const v = process.env[name];
  return v && String(v).trim().length > 0 ? String(v).trim() : null;
}

// Phase 22O — Wrap any provider's getCandles with a 60s cache + in-flight
// dedupe so concurrent/repeated scans stay inside upstream rate limits
// (TwelveData free = 8 req/min) without ever falling back to fake data.
function withCandleCache(p: MarketProvider): MarketProvider {
  const inner = p.getCandles.bind(p);
  return {
    ...p,
    async getCandles(symbol, timeframe, limit = 30) {
      const k = `${p.name}:${symbol}:${timeframe}:${limit}`;
      const cached = cacheGet(candleCache, k, CANDLE_TTL_MS);
      if (cached) return cached;
      const inflight = candleInflight.get(k);
      if (inflight) return inflight;
      const promise = (async () => {
        try {
          const v = await inner(symbol, timeframe, limit);
          if (v.connected && v.candles.length > 0) cacheSet(candleCache, k, v);
          return v;
        } finally {
          candleInflight.delete(k);
        }
      })();
      candleInflight.set(k, promise);
      return promise;
    },
  };
}

// Phase 22O — Hybrid composition. When both TwelveData (candles) and Finnhub
// (quotes/news) keys are present, route per-feature: candles → TwelveData,
// quotes/news → Finnhub. Status reports the composite as "twelve_data" since
// TwelveData drives the scanner, but features.news reflects Finnhub support.
function hybridTwelveDataFinnhub(twelveDataKey: string, finnhubKey: string, newsKey: string | null): MarketProvider {
  const td = twelveDataProvider(twelveDataKey, newsKey);
  const fh = finnhubProvider(finnhubKey, newsKey);
  return {
    ...td,
    notes: "Twelve Data (candles) + Finnhub (quotes/news) hybrid. Real OHLC for the live scanner; Finnhub serves quotes & news.",
    features: {
      quotes: true,
      news: fh.features.news,
      snapshots: td.features.snapshots || fh.features.snapshots,
      economicCalendar: false,
      candles: true,
    },
    getLiveQuote: fh.getLiveQuote.bind(fh),
    getMarketNews: fh.getMarketNews.bind(fh),
  };
}

// Composite provider — fans each call across providers in priority order.
// On getCandles/getLiveQuote, returns the first provider that yields usable
// data (connected + non-empty candles, or a positive non-stale price); on
// upstream error/empty/quota-exhaustion, transparently falls through to the
// next provider. NEVER fabricates: if every provider returns empty/error,
// the last empty/error response is propagated honestly.
function compositeProvider(providers: MarketProvider[]): MarketProvider {
  if (providers.length === 0) return nullProvider();
  if (providers.length === 1) return providers[0]!;
  const primary = providers[0]!;
  const names = providers.map((p) => p.name).join(",");
  const compositeName = `composite(${names})`;
  return {
    name: compositeName,
    connected: providers.some((p) => p.connected),
    notes: `Composite over ${names}. Each call walks the list and falls through on failure / empty / quota-exhausted.`,
    features: {
      quotes:           providers.some((p) => p.features.quotes),
      news:             providers.some((p) => p.features.news),
      snapshots:        providers.some((p) => p.features.snapshots),
      economicCalendar: providers.some((p) => p.features.economicCalendar),
      candles:          providers.some((p) => p.features.candles),
      currentEvents:    providers.some((p) => p.features.currentEvents === true),
    },
    async getLiveQuote(symbol) {
      let last: MarketQuote | null = null;
      for (const p of providers) {
        if (!p.features.quotes) continue;
        try {
          const q = await p.getLiveQuote(symbol);
          if (q && typeof q.price === "number" && q.price > 0 && !q.stale && q.freshness !== "UNAVAILABLE" && q.freshness !== "ERROR") {
            return q;
          }
          last = q;
        } catch (e) {
          logger.warn({ provider: p.name, err: (e as Error).message, symbol }, "composite: quote provider threw, falling through");
        }
      }
      return last ?? emptyQuote(symbol || "", compositeName, "UNAVAILABLE");
    },
    async getCandles(symbol, timeframe, limit = 30) {
      let last: CandleResult | null = null;
      for (const p of providers) {
        if (!p.features.candles) continue;
        try {
          const r = await p.getCandles(symbol, timeframe, limit);
          if (r.connected && r.candles.length > 0) return r;
          last = r;
        } catch (e) {
          logger.warn({ provider: p.name, err: (e as Error).message, symbol, timeframe }, "composite: candle provider threw, falling through");
        }
      }
      return last ?? { connected: false, source: compositeName, symbol, timeframe, candles: [], freshness: "UNAVAILABLE", asOf: null, notes: `All providers (${names}) failed or returned empty.` };
    },
    async getMarketNews(query, limit) {
      let last: { connected: boolean; items: NewsItem[]; provider: string } | null = null;
      for (const p of providers) {
        if (!p.features.news) continue;
        try {
          const r = await p.getMarketNews(query, limit);
          if (r.connected && r.items.length > 0) return r;
          last = r;
        } catch (e) {
          logger.warn({ provider: p.name, err: (e as Error).message }, "composite: news provider threw, falling through");
        }
      }
      return last ?? { connected: false, items: [], provider: compositeName };
    },
    // Metadata methods use the same fall-through pattern as quotes/candles:
    // try each provider in chain order, accept the first connected result,
    // and only return a disconnected response if every provider failed.
    async getEconomicCalendar(opts) {
      let last: Awaited<ReturnType<MarketProvider["getEconomicCalendar"]>> | null = null;
      for (const p of providers) {
        try {
          const r = await p.getEconomicCalendar(opts);
          if (r.connected && r.events.length > 0) return r;
          last = r;
        } catch (e) {
          logger.warn({ provider: p.name, err: (e as Error).message }, "composite: economic calendar provider threw, falling through");
        }
      }
      return last ?? { connected: false, events: [], provider: compositeName };
    },
    async getSymbolOverview(symbol) {
      let last: Awaited<ReturnType<MarketProvider["getSymbolOverview"]>> | null = null;
      for (const p of providers) {
        try {
          const r = await p.getSymbolOverview(symbol);
          if (r.connected && r.description) return r;
          last = r;
        } catch (e) {
          logger.warn({ provider: p.name, err: (e as Error).message }, "composite: symbol overview provider threw, falling through");
        }
      }
      return last ?? { connected: false, symbol, description: null, provider: compositeName };
    },
    async getTradingSessionContext() {
      let last: Awaited<ReturnType<MarketProvider["getTradingSessionContext"]>> | null = null;
      for (const p of providers) {
        try {
          const r = await p.getTradingSessionContext();
          if (r.connected && r.sessions.length > 0) return r;
          last = r;
        } catch (e) {
          logger.warn({ provider: p.name, err: (e as Error).message }, "composite: trading session provider threw, falling through");
        }
      }
      return last ?? { connected: false, sessions: [], nowUtc: new Date().toISOString(), provider: compositeName };
    },
    ...(typeof primary.getCurrentEvents === "function" ? { getCurrentEvents: primary.getCurrentEvents.bind(primary) } : {}),
  };
}

export function getMarketProvider(): MarketProvider {
  if (_provider) return _provider;
  const twelveDataKey = key("TWELVEDATA_API_KEY");
  const polygonKey = key("POLYGON_API_KEY");
  const finnhubKey = key("FINNHUB_API_KEY");
  const avKey = key("ALPHA_VANTAGE_API_KEY");
  const newsKey = key("NEWSAPI_API_KEY");
  _newsOnlyKey = newsKey;

  // Build the priority chain. TwelveData (or the TD+Finnhub hybrid, which
  // pairs TD candles with Finnhub quotes/news) stays primary because it
  // currently has the richest real-OHLC coverage for the scanner universe.
  // Polygon is the resilient fallback for forex candles + quotes, so when
  // TwelveData hits its 800/day cap the assistant transparently continues
  // serving live data. Finnhub-alone and Alpha Vantage round out the chain.
  const chain: MarketProvider[] = [];
  if (twelveDataKey && finnhubKey)   chain.push(hybridTwelveDataFinnhub(twelveDataKey, finnhubKey, newsKey));
  else if (twelveDataKey)            chain.push(twelveDataProvider(twelveDataKey, newsKey));
  if (polygonKey)                    chain.push(polygonProvider(polygonKey, newsKey));
  if (finnhubKey && !twelveDataKey)  chain.push(finnhubProvider(finnhubKey, newsKey));
  if (avKey)                         chain.push(alphaVantageProvider(avKey, newsKey));

  let chosen: MarketProvider;
  if (chain.length === 0) {
    if (newsKey) {
      // News-only mode
      chosen = {
        ...nullProvider(),
        name: "newsapi",
        connected: true,
        notes: "Only NewsAPI is configured. Quotes and snapshots are unavailable.",
        features: { quotes: false, news: true, snapshots: false, economicCalendar: false, candles: false },
        async getMarketNews(q, limit = 5) { return newsApiFetch(newsKey, q, limit); },
      };
    } else {
      chosen = nullProvider();
    }
  } else if (chain.length === 1) {
    chosen = chain[0]!;
  } else {
    chosen = compositeProvider(chain);
  }

  const base = chosen.features.candles ? withCandleCache(chosen) : chosen;
  _provider = withTradingEconomicsCalendar(base);
  return _provider;
}

// When Trading Economics is configured as the economic-calendar provider, the
// chosen quote/news provider's (usually absent) calendar is overridden so the
// assistant + Ruby read the SAME real calendar service every other surface uses.
// No-key env returns the provider unchanged (back-compat honest-missing).
function withTradingEconomicsCalendar(provider: MarketProvider): MarketProvider {
  if (!isEconomicCalendarConfigured()) return provider;
  return {
    ...provider,
    features: { ...provider.features, economicCalendar: true },
    async getEconomicCalendar(opts) {
      const parsed = opts?.fromIso ? Date.parse(opts.fromIso) : Date.now();
      const nowMs = Number.isFinite(parsed) ? parsed : Date.now();
      const result = await getEconomicCalendarResult({ nowMs });
      // Honest: only surface events when the provider is genuinely connected.
      if (!result.connected) {
        return { connected: false, events: [], provider: result.provider };
      }
      return {
        connected: true,
        events: toAssistantEconomicEvents(result.events),
        provider: result.provider,
      };
    },
  };
}

// For tests — reset memoized provider & caches
export function _resetMarketProviderForTests() {
  _provider = null;
  _newsOnlyKey = null;
  quoteCache.clear();
  newsCache.clear();
  candleCache.clear();
  candleInflight.clear();
  providerLiveness.lastCheckedAt = null;
  providerLiveness.lastSuccessfulFetchAt = null;
  providerLiveness.lastAttemptedFetchAt = null;
  providerLiveness.lastErrorMessage = null;
  providerLiveness.lastErrorAt = null;
}

// For tests — inject a deterministic provider so the assistant marketContext
// path (getMarketProvider → buildMarketContext) can be driven to a known
// quality/freshness verdict WITHOUT real API keys or network. Used by the
// feed-not-confirmed honesty coverage to exercise the "feed confirmed" branch.
// Call `_resetMarketProviderForTests()` afterwards to restore real selection.
export function _setMarketProviderForTests(p: MarketProvider) {
  _provider = p;
}

// For tests — stamp a recent successful fetch so getMarketStatus() reports
// non-stale. The injected test provider's getLiveQuote never runs the internal
// markSuccess bookkeeping, so without this the staleness model stays
// NEVER_FETCHED and getMarketSnapshot's "feed confirmed" branch (which gates on
// getMarketStatus().stale) is unreachable. Cleared by
// `_resetMarketProviderForTests()`. Never used in production.
export function _markMarketFetchSuccessForTests(observed?: { freshness?: "REALTIME" | "DELAYED" | "UNAVAILABLE"; source?: string }) {
  markSuccess(observed);
}

/** Phase: Market Data Freshness — Force a fresh probe of the live
 *  provider. Used by `POST /api/me/market-data/refresh` to update the
 *  liveness model from a real fetch. Returns the symbols actually
 *  probed and per-symbol freshness; never throws. */
export async function refreshMarketProvider(probeSymbols: readonly string[] = ["EURUSD", "XAUUSD"]): Promise<{
  provider: string; connected: boolean;
  probes: Array<{ symbol: string; ok: boolean; freshness: MarketQuote["freshness"]; reason: string | null }>;
}> {
  const p = getMarketProvider();
  if (!p.connected) {
    return { provider: p.name, connected: false, probes: [] };
  }
  const probes: Array<{ symbol: string; ok: boolean; freshness: MarketQuote["freshness"]; reason: string | null }> = [];
  for (const sym of probeSymbols) {
    try {
      const q = await p.getLiveQuote(sym);
      const ok = !!(q && typeof q.price === "number" && q.price > 0 && !q.stale);
      probes.push({
        symbol: sym,
        ok,
        freshness: q?.freshness ?? "UNAVAILABLE",
        reason: ok ? null : `freshness=${q?.freshness ?? "missing"}`,
      });
    } catch (e) {
      probes.push({ symbol: sym, ok: false, freshness: "ERROR", reason: (e as Error).message });
    }
  }
  return { provider: p.name, connected: p.connected, probes };
}

// ── Canonical status (Phase 22E shape; Market-Data-Freshness extended) ─
// Adds lastAttemptedFetchAt, lastError, lastErrorAt, staleAfterMs,
// freshnessState, and a structured unavailableReason so the UI and the
// assistant can distinguish FRESH / STALE / UNAVAILABLE / NEVER_FETCHED.
// All previous fields preserved for backward compatibility.
export type MarketDataFreshnessState =
  | "FRESH"            // successful fetch within staleAfterMs
  | "STALE"            // last success older than staleAfterMs
  | "NEVER_FETCHED"    // configured but no successful fetch yet
  | "UNAVAILABLE"      // not configured / null provider
  | "ERROR";           // last attempt errored and no recent success

function freshnessState(configured: boolean, stale: boolean): MarketDataFreshnessState {
  if (!configured) return "UNAVAILABLE";
  if (providerLiveness.lastSuccessfulFetchAt && !stale) return "FRESH";
  if (!providerLiveness.lastSuccessfulFetchAt && providerLiveness.lastErrorMessage) return "ERROR";
  if (!providerLiveness.lastSuccessfulFetchAt) return "NEVER_FETCHED";
  return "STALE";
}

// ── Rate-limit detection (derived from lastError) ────────────────────────
// Cleanup phase E — expose `rateLimitStatus` as a discrete field so the
// dashboard can render a "Provider Rate Limited" badge. Detection is
// derived from the provider's most recent error string (no separate
// counter is added — the underlying refresh route already enforces a
// hard server-side 15s/user rate-limit independent of this field).
export type RateLimitStatus = {
  limited: boolean;
  retryAfterMs: number | null;
  lastHitAt: string | null;
  source: "lastError" | "none";
};
const RATE_LIMIT_RE = /\b429\b|rate[ _-]?limit|too[ _-]?many[ _-]?requests/i;
const RATE_LIMIT_BACKOFF_MS = 60_000;
function deriveRateLimitStatus(): RateLimitStatus {
  const err = providerLiveness.lastErrorMessage;
  const at = providerLiveness.lastErrorAt;
  if (!err || !at) return { limited: false, retryAfterMs: null, lastHitAt: null, source: "none" };
  if (!RATE_LIMIT_RE.test(err)) return { limited: false, retryAfterMs: null, lastHitAt: null, source: "none" };
  const ageMs = Date.now() - new Date(at).getTime();
  if (ageMs >= RATE_LIMIT_BACKOFF_MS) {
    return { limited: false, retryAfterMs: null, lastHitAt: at, source: "lastError" };
  }
  return { limited: true, retryAfterMs: RATE_LIMIT_BACKOFF_MS - ageMs, lastHitAt: at, source: "lastError" };
}

export function getMarketStatus() {
  const p = getMarketProvider();
  const configured = p.name !== "none";
  const stale = configured ? isStaleNow() : false;
  const fState = freshnessState(configured, stale);
  const setupHint = configured
    ? null
    : "Set TWELVEDATA_API_KEY (real OHLC candles for the live scanner; pair with FINNHUB_API_KEY for quotes/news) — or POLYGON_API_KEY / FINNHUB_API_KEY / ALPHA_VANTAGE_API_KEY / NEWSAPI_API_KEY — as a server secret.";
  // Structured unavailable reason — null when fresh.
  let unavailableReason: string | null = null;
  if (!configured) unavailableReason = "No market data provider configured.";
  else if (fState === "ERROR") unavailableReason = providerLiveness.lastErrorMessage ?? "Provider returned an error on last attempt.";
  else if (fState === "STALE") unavailableReason = `No successful fetch in the last ${Math.round(QUOTE_STALE_AFTER_MS / 60000)} minutes${providerLiveness.lastErrorMessage ? ` — last error: ${providerLiveness.lastErrorMessage}` : ""}.`;
  else if (fState === "NEVER_FETCHED") unavailableReason = "Provider configured but no fetch has succeeded yet.";
  return {
    // ── New canonical fields (Phase 22E) ───────────────────────────────
    provider: p.name as "polygon" | "finnhub" | "alpha_vantage" | "newsapi" | "twelve_data" | "none",
    connected: p.connected,
    configured,
    features: p.features,
    lastCheckedAt: providerLiveness.lastCheckedAt,
    lastSuccessfulFetchAt: providerLiveness.lastSuccessfulFetchAt,
    stale,
    notes: p.notes ?? (configured ? "" : "No market data provider configured."),
    setupHint,
    keysExposed: false as const,
    // ── Phase: Market Data Freshness — extended honesty fields ─────────
    lastAttemptedFetchAt: providerLiveness.lastAttemptedFetchAt,
    lastError: providerLiveness.lastErrorMessage,
    lastErrorAt: providerLiveness.lastErrorAt,
    staleAfterMs: QUOTE_STALE_AFTER_MS,
    freshnessState: fState,
    unavailableReason,
    // ── Per-payload honesty (added so callers/Ruby never describe a
    // DELAYED-only fallback as "Fresh"). `dataFreshness` reflects the
    // *quality* of the most recent successful payload, NOT whether the
    // provider responded. `dataSource` names the provider that produced it.
    // Null until the first successful fetch is observed.
    dataFreshness: providerLiveness.lastObservedDataFreshness,
    dataSource: providerLiveness.lastObservedDataSource,
    // Cleanup phase E — discrete rate-limit field (derived from lastError).
    rateLimitStatus: deriveRateLimitStatus(),
    // ── Backward-compat fields (kept for existing UI / tools) ──────────
    name: p.name,
    expectedKeys: PROVIDER_KEY_ENV_VARS,
    newsOnlyFallback: Boolean(_newsOnlyKey && p.name !== "newsapi"),
  };
}
