// ARX AI — Unified Market Data Router (Phase 22W).
//
// One entry point that picks the correct provider for a symbol based on
// its asset class, tries the configured providers in priority order, and
// only reports "no feed" after every valid provider in the chain has
// failed honestly.
//
// Why:
//   - The legacy `dataManager.ts` cascade was MT5 → TwelveData shim → AlphaV
//     → Mock regardless of symbol type. In practice TwelveData here is a
//     mock shim (returns isConnected:false), the EA never pushes ticks
//     into mt5Provider, and AlphaV is a stub. So every non-synthetic
//     candle request silently fell through to mockProvider — that's the
//     "no feed / simulator data" symptom users reported.
//   - Real TwelveData / Polygon / Finnhub / Alpha Vantage adapters live
//     in `lib/assistant/marketProvider.ts` and were not reachable from
//     the data-layer callers.
//   - Synthetic (V75 / Boom / Crash / Step) data lives in derivProvider
//     and is gated by DERIV_APP_ID.
//
// What this module does:
//   - Classify a symbol → AssetClass.
//   - For each AssetClass, walk a provider priority chain.
//   - Return a normalized {candles | quote, primaryProvider, attempts[],
//     userMessage, adminDetail} shape so the UI can show a clean,
//     non-leaky status and admins can see exactly which provider was
//     tried and why each link failed.
//
// What this module does NOT do:
//   - Fabricate candles or quotes when nothing succeeded.
//   - Touch any safety chokepoint, MT5 dispatch, or order placement.
//   - Substitute mock data into a "REAL" result.
//
// MT5 broker slot:
//   - Each chain reserves the top slot for the MT5 broker feed so that,
//     when the EA eventually pushes ticks (v1.28+ work), the broker quote
//     wins for tradable symbols without any router change. Today
//     `mt5Provider.isConnected()` returns false because nothing calls
//     `updateCandlesFromMT5` / `updateQuoteFromMT5`, so the slot is a
//     no-op and the router falls through to the next provider.

import type { Candle, MarketQuote } from "./types.js";
import {
  getDerivCandles,
  getDerivTick,
  getDerivFeedStatus,
  isDerivSyntheticSymbol,
  resolveDerivSymbol,
} from "./providers/derivProvider.js";
import { mt5Provider, getMt5CandleAvailability } from "./providers/mt5Provider.js";
import { getMarketProvider } from "../assistant/marketProvider.js";
import { readCachedCandles } from "./candleCache.js";
import {
  MT5_BROKER_MIRROR_SOURCE,
  normalizeBrokerTimeframe,
  TIMEFRAME_MS,
} from "./brokerCandleStore.js";

export type AssetClass =
  | "synthetic"   // Deriv volatility / boom / crash / step / jump
  | "forex"       // EURUSD, GBPUSD, etc.
  | "metals"      // XAU, XAG
  | "indices"     // US30, NAS100, SPX500, GER40, UK100, JP225
  | "crypto"      // BTCUSDT, ETHUSDT, etc.
  | "stocks"      // TSLA, AAPL, etc.
  | "unknown";

export interface ProviderAttempt {
  provider: string;
  ok: boolean;
  reason: string | null;
  candleCount: number;
  ms: number;
}

export interface MarketCandlesResult {
  ok: boolean;
  symbol: string;
  assetClass: AssetClass;
  candles: Candle[];
  primaryProvider: string | null;
  attempts: ProviderAttempt[];
  /** Friendly, non-leaky message safe for any user. */
  userMessage: string;
  /** Detail safe to show admins only (may name providers / configs). */
  adminDetail: string;
}

export interface MarketQuoteResult {
  ok: boolean;
  symbol: string;
  assetClass: AssetClass;
  quote: MarketQuote | null;
  primaryProvider: string | null;
  attempts: ProviderAttempt[];
  userMessage: string;
  adminDetail: string;
}

// ── Timeframe normalization ──────────────────────────────────────────────
// Legacy callers (`/api/data`, `/api/watchlists`, `/api/multi-timeframe`)
// pass lowercase strings like "1m", "5m", "1h". Some downstream adapters
// (Deriv) only accept the ARX "M1/M5/H1" form. Normalize at the router
// boundary so legacy callers keep working without per-caller changes.
const TIMEFRAME_NORMALIZE: Record<string, string> = {
  "1m": "M1", "2m": "M2", "3m": "M3", "5m": "M5", "10m": "M10",
  "15m": "M15", "30m": "M30",
  "1h": "H1", "2h": "H2", "4h": "H4", "8h": "H8",
  "1d": "D1", "d1": "D1", "1day": "D1", "daily": "D1",
};
function normalizeTimeframe(tf: string): string {
  const t = (tf ?? "").trim();
  if (!t) return "M5";
  const upper = t.toUpperCase();
  if (/^[MHD]\d+$/.test(upper) || /^D1$/.test(upper)) return upper;
  const lower = t.toLowerCase();
  return TIMEFRAME_NORMALIZE[lower] ?? upper;
}

// ── Symbol classification ────────────────────────────────────────────────

const FOREX_PAIRS = new Set([
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURJPY", "GBPJPY", "EURGBP", "EURCHF", "AUDJPY", "CADJPY", "CHFJPY",
  "NZDJPY", "AUDNZD", "EURAUD", "EURCAD", "EURNZD", "GBPAUD", "GBPCAD",
  "GBPCHF", "GBPNZD",
]);
const METALS = new Set(["XAUUSD", "XAGUSD", "XPTUSD", "XPDUSD"]);
const INDICES = new Set([
  "US30", "NAS100", "SPX500", "GER40", "UK100", "JP225",
  "FRA40", "AUS200", "HK50", "EU50",
  // ARX Focus index canonicals not covered above (Task #558). DXY (US Dollar
  // Index) and GER30 (DAX, an alias of GER40) classify as indices so they route
  // through the index provider chain (mt5_broker → assistant_real) and fall to
  // an honest empty feed rather than misclassifying as a stock/unknown.
  "DXY", "GER30",
]);

/** Public: classify any ARX-canonical or free-form symbol into an asset class. */
export function classifySymbol(symbolOrLabel: string): AssetClass {
  const s = (symbolOrLabel ?? "").trim().toUpperCase();
  if (!s) return "unknown";

  // Synthetic — anything Deriv knows about, plus tolerant V## / VOLATILITY / BOOM / CRASH / STEP / JUMP.
  if (isDerivSyntheticSymbol(s)) return "synthetic";
  if (/^V\d+(_1S)?$/.test(s)) return "synthetic";
  if (/VOLATILITY|BOOM|CRASH|STEP|JUMP/.test(s)) return "synthetic";

  if (METALS.has(s)) return "metals";
  if (INDICES.has(s)) return "indices";
  if (FOREX_PAIRS.has(s)) return "forex";

  // Crypto: BASE + USDT or BASE + USD (3-6 letters base).
  if (/^[A-Z]{3,6}USDT$/.test(s)) return "crypto";
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|MATIC|LTC|LINK|DOT)USD$/.test(s)) return "crypto";

  // Stocks: 1-5 plain letters (TSLA, AAPL, MSFT, NVDA, AMZN, META, GOOGL).
  if (/^[A-Z]{1,5}$/.test(s)) return "stocks";

  return "unknown";
}

// ── Provider chain definitions ───────────────────────────────────────────

type ProviderId = "mt5_broker" | "deriv" | "assistant_real";

const CHAIN_BY_CLASS: Record<AssetClass, ProviderId[]> = {
  synthetic: ["mt5_broker", "deriv"],
  forex:     ["mt5_broker", "assistant_real"],
  metals:    ["mt5_broker", "assistant_real"],
  indices:   ["mt5_broker", "assistant_real"],
  crypto:    ["mt5_broker", "assistant_real"],
  stocks:    ["mt5_broker", "assistant_real"],
  unknown:   ["mt5_broker", "assistant_real"],
};

// ── Adapters: provider → normalized {Candle[] | MarketQuote} ─────────────

// ── Durable broker-candle store read (Task #470) ─────────────────────────────
//
// The volatile in-memory mt5Provider holds only what the EA pushed SINCE the
// last server start. The durable broker_candles store (mirrored into
// market_candles under MT5_BROKER_MIRROR_SOURCE) survives a restart, so after a
// restart broker-native history is still available even though the in-memory
// provider is empty. We prefer that durable broker history over the fallback
// providers (Deriv / assistant_real) when — and ONLY when — it is both FRESH
// and SUFFICIENT, and we fall through honestly otherwise. This never fabricates
// a bar: it only serves what a real EA already stored.
// Bar interval (ms) per canonical timeframe is owned by brokerCandleStore
// (imported as TIMEFRAME_MS) so the durable store and this router can never
// drift apart.
// Newest stored bar must trail the current bar by FEWER than this many intervals
// to be preferred — matches the chart truth engine's STALE threshold so the
// router never prefers a series the chart would immediately flag stale.
const DURABLE_BROKER_STALE_INTERVALS = 3;
// Minimum bars (relative to the requested window) to consider the durable series
// "sufficient" to prefer over a possibly-deeper fallback provider.
const DURABLE_BROKER_MIN_BARS = 30;

interface DurableBrokerVerdict {
  served: Candle[] | null;
  hasAny: boolean;
  count: number;
  stale: boolean;
  insufficient: boolean;
}

async function readDurableBrokerCandles(
  symbol: string,
  timeframe: string,
  limit: number,
  now: number,
): Promise<DurableBrokerVerdict> {
  const empty: DurableBrokerVerdict = { served: null, hasAny: false, count: 0, stale: false, insufficient: false };
  // The durable store holds the canonical MT5 timeframe set; a token that does
  // not normalize to one of them has no broker history → nothing to prefer.
  const tf = normalizeBrokerTimeframe(timeframe);
  if (!tf) return empty;
  let read;
  try {
    read = await readCachedCandles({ symbol, timeframe: tf, source: MT5_BROKER_MIRROR_SOURCE, limit });
  } catch {
    return empty;
  }
  if (read.count === 0 || !read.newest) return empty;

  const tfMs = TIMEFRAME_MS[tf];
  const newestMs = Date.parse(read.newest);
  const trailing = Number.isNaN(newestMs)
    ? Number.POSITIVE_INFINITY
    : Math.floor(Math.max(0, now - newestMs) / tfMs);
  const stale = trailing >= DURABLE_BROKER_STALE_INTERVALS;
  const sufficiencyFloor = Math.min(limit, DURABLE_BROKER_MIN_BARS);
  const insufficient = read.count < sufficiencyFloor;
  if (stale || insufficient) {
    return { served: null, hasAny: true, count: read.count, stale, insufficient };
  }
  return { served: read.candles, hasAny: true, count: read.count, stale: false, insufficient: false };
}

async function tryMt5Candles(symbol: string, timeframe: string, limit: number): Promise<ProviderAttempt & { candles: Candle[] }> {
  const t0 = Date.now();
  // 1) LIVE in-memory provider — the freshest pushed bars win when present.
  const connected = await mt5Provider.isConnected();
  let liveError: string | null = null;
  if (connected) {
    try {
      const candles = await mt5Provider.getCandles(symbol, timeframe, limit);
      if (candles.length > 0) {
        return { provider: "mt5_broker", ok: true, reason: null, candleCount: candles.length, ms: Date.now() - t0, candles };
      }
    } catch (err) {
      // Capture the precise error, but still try the durable store below before
      // giving up — the in-memory provider failing does not mean broker-native
      // history is unavailable.
      liveError = redact(String((err as Error).message ?? err));
    }
  }

  // 2) DURABLE broker store — survives a restart that empties the in-memory
  //    provider. Preferred over fallback providers only when fresh + sufficient.
  const durable = await readDurableBrokerCandles(symbol, timeframe, limit, t0);
  if (durable.served) {
    return { provider: "mt5_broker", ok: true, reason: null, candleCount: durable.served.length, ms: Date.now() - t0, candles: durable.served };
  }

  // 3) Honest no-serve reason (precise for diagnostics/UI).
  let reason: string;
  if (durable.stale) {
    reason = "MT5_BROKER_HISTORY_STALE";
  } else if (durable.insufficient) {
    reason = "MT5_BROKER_HISTORY_INSUFFICIENT";
  } else if (liveError) {
    reason = liveError;
  } else if (connected) {
    // Live feed connected, but neither the in-memory series nor the durable
    // store has this timeframe. Distinguish "this symbol was never pushed" from
    // "this timeframe specifically is missing while the symbol pushes others".
    const avail = getMt5CandleAvailability(symbol, timeframe);
    reason = avail.symbolHasAnySeries ? "MT5_TIMEFRAME_MISSING" : "MT5_CANDLES_NOT_PUSHED";
  } else {
    reason = "MT5_BROKER_FEED_NOT_ACTIVE";
  }
  return { provider: "mt5_broker", ok: false, reason, candleCount: 0, ms: Date.now() - t0, candles: [] };
}

async function tryMt5Quote(symbol: string): Promise<ProviderAttempt & { quote: MarketQuote | null }> {
  const t0 = Date.now();
  const connected = await mt5Provider.isConnected();
  if (!connected) {
    return { provider: "mt5_broker", ok: false, reason: "MT5_BROKER_FEED_NOT_ACTIVE", candleCount: 0, ms: Date.now() - t0, quote: null };
  }
  try {
    const q = await mt5Provider.getQuote(symbol);
    const hasPrice = (q.bid != null && q.bid > 0) || (q.ask != null && q.ask > 0) || (q.last != null && q.last > 0);
    if (!hasPrice) {
      return { provider: "mt5_broker", ok: false, reason: "MT5_QUOTES_NOT_PUSHED", candleCount: 0, ms: Date.now() - t0, quote: null };
    }
    return { provider: "mt5_broker", ok: true, reason: null, candleCount: 0, ms: Date.now() - t0, quote: q };
  } catch (err) {
    return { provider: "mt5_broker", ok: false, reason: redact(String((err as Error).message ?? err)), candleCount: 0, ms: Date.now() - t0, quote: null };
  }
}

async function tryDerivCandles(symbol: string, timeframe: string, limit: number): Promise<ProviderAttempt & { candles: Candle[] }> {
  const t0 = Date.now();
  const status = getDerivFeedStatus();
  if (!status.configured) {
    return { provider: "deriv", ok: false, reason: "DERIV_NOT_CONFIGURED", candleCount: 0, ms: Date.now() - t0, candles: [] };
  }
  const r = await getDerivCandles(symbol, timeframe, limit);
  if (!r.ok) {
    return { provider: "deriv", ok: false, reason: r.reason ?? "DERIV_FETCH_FAILED", candleCount: 0, ms: Date.now() - t0, candles: [] };
  }
  // Normalize DerivCandle → lib/data Candle.
  const candles: Candle[] = r.candles.map((c) => ({
    time: new Date(c.epoch * 1000).toISOString(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: 0,
  }));
  return { provider: "deriv", ok: true, reason: null, candleCount: candles.length, ms: Date.now() - t0, candles };
}

async function tryDerivQuote(symbol: string): Promise<ProviderAttempt & { quote: MarketQuote | null }> {
  const t0 = Date.now();
  const status = getDerivFeedStatus();
  if (!status.configured) {
    return { provider: "deriv", ok: false, reason: "DERIV_NOT_CONFIGURED", candleCount: 0, ms: Date.now() - t0, quote: null };
  }
  const r = await getDerivTick(symbol);
  if (!r.ok || !r.tick) {
    return { provider: "deriv", ok: false, reason: r.reason ?? "DERIV_NO_TICK", candleCount: 0, ms: Date.now() - t0, quote: null };
  }
  const quote: MarketQuote = {
    symbol,
    last: r.tick.quote,
    timestamp: new Date(r.tick.epoch * 1000).toISOString(),
  };
  return { provider: "deriv", ok: true, reason: null, candleCount: 0, ms: Date.now() - t0, quote };
}

async function tryAssistantCandles(symbol: string, timeframe: string, limit: number): Promise<ProviderAttempt & { candles: Candle[] }> {
  const t0 = Date.now();
  const p = getMarketProvider();
  if (!p.connected || !p.features.candles) {
    return { provider: `assistant_real:${p.name}`, ok: false, reason: p.connected ? "PROVIDER_NO_CANDLE_SUPPORT" : "NO_MARKET_PROVIDER_CONFIGURED", candleCount: 0, ms: Date.now() - t0, candles: [] };
  }
  try {
    const r = await p.getCandles(symbol, timeframe, limit);
    if (!r.connected || r.candles.length === 0) {
      return { provider: `assistant_real:${p.name}`, ok: false, reason: r.notes ?? (r.connected ? "NO_CANDLES_RETURNED" : "PROVIDER_NOT_CONNECTED"), candleCount: 0, ms: Date.now() - t0, candles: [] };
    }
    // Normalize assistant {t,o,h,l,c,v} → lib/data {time,open,high,low,close,volume}.
    const candles: Candle[] = r.candles.map((c) => ({
      time: c.t,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: c.v,
    }));
    // Name the ACTUAL winning sub-provider (r.source) — not the composite
    // descriptor — so the feed-confidence chip can truthfully say which
    // third-party source served these bars (e.g. assistant_real:twelve_data).
    return { provider: `assistant_real:${r.source}`, ok: true, reason: null, candleCount: candles.length, ms: Date.now() - t0, candles };
  } catch (err) {
    return { provider: `assistant_real:${p.name}`, ok: false, reason: redact(String((err as Error).message ?? err)), candleCount: 0, ms: Date.now() - t0, candles: [] };
  }
}

async function tryAssistantQuote(symbol: string): Promise<ProviderAttempt & { quote: MarketQuote | null }> {
  const t0 = Date.now();
  const p = getMarketProvider();
  if (!p.connected || !p.features.quotes) {
    return { provider: `assistant_real:${p.name}`, ok: false, reason: p.connected ? "PROVIDER_NO_QUOTE_SUPPORT" : "NO_MARKET_PROVIDER_CONFIGURED", candleCount: 0, ms: Date.now() - t0, quote: null };
  }
  try {
    const r = await p.getLiveQuote(symbol);
    if (r.freshness === "UNAVAILABLE" || r.freshness === "ERROR" || (r.price == null && r.bid == null && r.ask == null)) {
      return { provider: `assistant_real:${p.name}`, ok: false, reason: r.freshness === "ERROR" ? "PROVIDER_FETCH_ERROR" : "NO_QUOTE_AVAILABLE", candleCount: 0, ms: Date.now() - t0, quote: null };
    }
    const quote: MarketQuote = {
      symbol,
      bid: r.bid ?? undefined,
      ask: r.ask ?? undefined,
      last: r.price ?? undefined,
      spread: (r.bid != null && r.ask != null) ? r.ask - r.bid : undefined,
      timestamp: r.asOf ?? new Date().toISOString(),
    };
    return { provider: `assistant_real:${r.source}`, ok: true, reason: null, candleCount: 0, ms: Date.now() - t0, quote };
  } catch (err) {
    return { provider: `assistant_real:${p.name}`, ok: false, reason: redact(String((err as Error).message ?? err)), candleCount: 0, ms: Date.now() - t0, quote: null };
  }
}

// ── Public router API ────────────────────────────────────────────────────

export async function routeCandles(symbol: string, timeframe: string, limit: number): Promise<MarketCandlesResult> {
  const assetClass = classifySymbol(symbol);
  const chain = CHAIN_BY_CLASS[assetClass];
  const attempts: ProviderAttempt[] = [];
  const tf = normalizeTimeframe(timeframe);

  for (const id of chain) {
    if (id === "mt5_broker") {
      const r = await tryMt5Candles(symbol, tf, limit);
      attempts.push(stripCandles(r));
      if (r.ok) return success(symbol, assetClass, r.candles, r.provider, attempts);
    } else if (id === "deriv") {
      const r = await tryDerivCandles(symbol, tf, limit);
      attempts.push(stripCandles(r));
      if (r.ok) return success(symbol, assetClass, r.candles, r.provider, attempts);
    } else if (id === "assistant_real") {
      const r = await tryAssistantCandles(symbol, tf, limit);
      attempts.push(stripCandles(r));
      if (r.ok) return success(symbol, assetClass, r.candles, r.provider, attempts);
    }
  }

  // Exhausted — honest empty.
  return {
    ok: false,
    symbol,
    assetClass,
    candles: [],
    primaryProvider: null,
    attempts,
    userMessage: noFeedMessage(assetClass, /*candles*/ true),
    adminDetail: `All providers failed for ${symbol} (${assetClass}). Chain: ${chain.join(" → ")}. Reasons: ${attempts.map((a) => `${a.provider}=${a.reason ?? "ok"}`).join("; ")}`,
  };
}

export async function routeQuote(symbol: string): Promise<MarketQuoteResult> {
  const assetClass = classifySymbol(symbol);
  const chain = CHAIN_BY_CLASS[assetClass];
  const attempts: ProviderAttempt[] = [];

  for (const id of chain) {
    if (id === "mt5_broker") {
      const r = await tryMt5Quote(symbol);
      attempts.push(stripQuote(r));
      if (r.ok && r.quote) return successQuote(symbol, assetClass, r.quote, r.provider, attempts);
    } else if (id === "deriv") {
      const r = await tryDerivQuote(symbol);
      attempts.push(stripQuote(r));
      if (r.ok && r.quote) return successQuote(symbol, assetClass, r.quote, r.provider, attempts);
    } else if (id === "assistant_real") {
      const r = await tryAssistantQuote(symbol);
      attempts.push(stripQuote(r));
      if (r.ok && r.quote) return successQuote(symbol, assetClass, r.quote, r.provider, attempts);
    }
  }

  return {
    ok: false,
    symbol,
    assetClass,
    quote: null,
    primaryProvider: null,
    attempts,
    userMessage: noFeedMessage(assetClass, /*candles*/ false),
    adminDetail: `All providers failed for ${symbol} (${assetClass}). Chain: ${chain.join(" → ")}. Reasons: ${attempts.map((a) => `${a.provider}=${a.reason ?? "ok"}`).join("; ")}`,
  };
}

// ── Per-chain health snapshot for admin diagnostics ──────────────────────

export interface RouterDiagnostics {
  providers: Array<{
    id: ProviderId;
    name: string;
    configured: boolean;
    connected: boolean;
    detail: string;
  }>;
  chainsByAssetClass: Record<AssetClass, ProviderId[]>;
  mt5: { configured: boolean; connected: boolean; note: string };
  deriv: { configured: boolean; connected: boolean; appIdConfigured: boolean; apiTokenConfigured: boolean; subscribedSymbolCount: number; activeSymbolCount: number | null; authorized: boolean; lastTickAt: string | null; reconnectCount: number; errorMessage: string | null };
  assistant: { name: string; connected: boolean; features: { quotes: boolean; candles: boolean; news: boolean }; notes: string | undefined };
}

export function getRouterDiagnostics(): RouterDiagnostics {
  const deriv = getDerivFeedStatus();
  const assistant = getMarketProvider();
  return {
    providers: [
      {
        id: "mt5_broker",
        name: "MetaTrader 5 broker bridge",
        configured: true,
        connected: false, // best-effort sync probe; mt5Provider.isConnected is async — see /diagnostics route for accurate probe
        detail: "Per-user EA bridge (primary slot). Live in-memory pushes win when fresh; otherwise the router prefers the durable broker_candles store (mirrored to the mt5_broker cache slot) when it is fresh + sufficient, and falls through to Deriv / assistant_real otherwise.",
      },
      {
        id: "deriv",
        name: "Deriv synthetic indices (WebSocket)",
        configured: deriv.configured,
        connected: deriv.connected,
        detail: deriv.message,
      },
      {
        id: "assistant_real",
        name: `Market data adapters (${assistant.name})`,
        configured: assistant.connected,
        connected: assistant.connected,
        detail: assistant.notes ?? (assistant.connected ? "Active." : "No market-data adapter configured."),
      },
    ],
    chainsByAssetClass: CHAIN_BY_CLASS,
    mt5: {
      configured: true,
      connected: false,
      note: "Primary slot. Live in-memory EA pushes win when fresh; otherwise the durable broker_candles store (mirrored to the mt5_broker cache slot) is preferred over fallback providers when fresh + sufficient, falling through honestly otherwise.",
    },
    deriv: {
      configured: deriv.configured,
      connected: deriv.connected,
      appIdConfigured: deriv.appIdConfigured,
      apiTokenConfigured: deriv.apiTokenConfigured,
      subscribedSymbolCount: deriv.subscribedSymbols.length,
      activeSymbolCount: deriv.activeSymbolCount,
      authorized: deriv.healthSummary === "healthy",
      lastTickAt: deriv.lastTickAt,
      reconnectCount: deriv.reconnectCount,
      errorMessage: deriv.errorMessage,
    },
    assistant: {
      name: assistant.name,
      connected: assistant.connected,
      features: { quotes: assistant.features.quotes, candles: assistant.features.candles, news: assistant.features.news },
      notes: assistant.notes,
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function stripCandles<T extends { candles: Candle[] } & ProviderAttempt>(r: T): ProviderAttempt {
  const { candles: _candles, ...rest } = r;
  return rest;
}
function stripQuote<T extends { quote: MarketQuote | null } & ProviderAttempt>(r: T): ProviderAttempt {
  const { quote: _quote, ...rest } = r;
  return rest;
}

function success(symbol: string, assetClass: AssetClass, candles: Candle[], provider: string, attempts: ProviderAttempt[]): MarketCandlesResult {
  return {
    ok: true,
    symbol,
    assetClass,
    candles,
    primaryProvider: provider,
    attempts,
    userMessage: "Live feed active",
    adminDetail: `Served by ${provider}; ${candles.length} candles; ${attempts.length} provider(s) tried.`,
  };
}
function successQuote(symbol: string, assetClass: AssetClass, quote: MarketQuote, provider: string, attempts: ProviderAttempt[]): MarketQuoteResult {
  return {
    ok: true,
    symbol,
    assetClass,
    quote,
    primaryProvider: provider,
    attempts,
    userMessage: "Live feed active",
    adminDetail: `Served by ${provider}; ${attempts.length} provider(s) tried.`,
  };
}

function noFeedMessage(assetClass: AssetClass, _candles: boolean): string {
  switch (assetClass) {
    case "synthetic":
      return "Live feed for synthetic indices isn't available right now. Connect MetaTrader 5 with a broker that offers volatility indices, or ask your admin to enable the synthetic-index feed.";
    case "forex":
    case "metals":
    case "indices":
    case "crypto":
    case "stocks":
      return "No live feed is available for this symbol right now. Try a different symbol or check back shortly.";
    case "unknown":
    default:
      return "This symbol isn't supported by any configured feed. Pick a symbol from the market list or check the symbol spelling.";
  }
}

/** Redact secret-looking query params from provider error strings before
 *  they reach the admin diagnostics surface. */
function redact(s: string): string {
  return s
    .replace(/app_id=[^&\s]+/gi, "app_id=<redacted>")
    .replace(/api[_-]?key=[^&\s]+/gi, "api_key=<redacted>")
    .replace(/token=[^&\s]+/gi, "token=<redacted>")
    .slice(0, 280);
}

/** Convenience re-export for callers that need it. */
export { resolveDerivSymbol };
