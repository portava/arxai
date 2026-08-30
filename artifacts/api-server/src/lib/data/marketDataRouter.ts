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

import type { Candle, MarketQuote, SeriesProvenance } from "./types.js";
import { resolveCanonicalSymbol, type CanonicalAssetClass } from "./symbolResolution.js";
import {
  getDerivCandles,
  getDerivTick,
  getDerivFeedStatus,
  resolveDerivSymbol,
} from "./providers/derivProvider.js";
import {
  mt5Provider,
  getMt5CandleAvailability,
  readMt5Candles,
  MULTI_BRIDGE_CONTENTION_NOTE,
} from "./providers/mt5Provider.js";
import { getMarketProvider } from "../assistant/marketProvider.js";
import { foldAssistantQuoteTick } from "./chart/assistantFormingBridge.js";
import { readCachedCandles } from "./candleCache.js";
import {
  MT5_BROKER_MIRROR_SOURCE,
  normalizeBrokerTimeframe,
  TIMEFRAME_MS,
} from "./brokerCandleStore.js";

// R4 slice 6: the union now has a single declaration in symbolResolution.ts
// (the canonical resolver). Re-exported under the historical name so every
// existing `import type { AssetClass } from "./marketDataRouter.js"` keeps
// working unchanged — same seven literals, same meaning.
export type AssetClass = CanonicalAssetClass;

export interface ProviderAttempt {
  provider: string;
  ok: boolean;
  reason: string | null;
  candleCount: number;
  ms: number;
}

/**
 * Per-attempt deadline for one provider hop.
 *
 * WHY THIS EXISTS: nothing in this router or in six of its seven non-WebSocket
 * providers bounded a request. With no feed attached — the state a fresh
 * install is in — every symbol walked the whole chain and each hop failed only
 * as fast as the underlying call happened to fail. The scanner fans out over
 * the approved universe at a shared concurrency of 8, so a handful of slow
 * hops parked every worker and a scan that should report "no feed" in a
 * fraction of a second took tens of seconds to say the same thing.
 *
 * HONESTY: a timeout is NOT "the provider said no data". It is "we did not
 * hear back", and it is recorded as its own reason (PROVIDER_TIMEOUT_MS) so the
 * admin detail can never present silence as a negative answer. The verdict is
 * unchanged either way — an unanswered provider yields no candles, exactly as
 * a refusing one does, and the caller still gets the same honest empty.
 */
export const PROVIDER_ATTEMPT_TIMEOUT_MS = 4_000;

export async function withAttemptDeadline<T extends { ok: boolean; reason: string | null; ms: number }>(
  provider: string,
  timeoutMs: number,
  run: () => Promise<T>,
  onTimeout: (attempt: ProviderAttempt) => T,
): Promise<T> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("timed-out");
  try {
    const raced = await Promise.race([
      run(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (raced === TIMED_OUT) {
      // The in-flight call is abandoned, not cancelled: these providers expose
      // no abort handle. It may still settle and is simply ignored — it can
      // never write a result, because the caller already moved on.
      return onTimeout({
        provider,
        ok: false,
        reason: `PROVIDER_TIMEOUT_MS: the provider did not respond within ${timeoutMs}ms — silence, not an answer either way`,
        candleCount: 0,
        ms: Date.now() - started,
      });
    }
    return raced;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  /**
   * Structured provenance for the served series. Present exactly when
   * `ok === true`; absent on an exhausted (honest-empty) result — an empty
   * result has no producing feed to attribute, and fabricating one is
   * forbidden. Additive: the legacy `primaryProvider` string label is
   * unchanged.
   */
  provenance?: SeriesProvenance;
  /**
   * Provenance qualifier notes for the served series (R4 slice 2), e.g.
   * MULTI_BRIDGE_CONTENTION when ≥2 attributed bridges held fresh series for
   * this symbol|timeframe and the read served the primary (most recent)
   * WITHOUT blending. Present only when non-empty; additive — carried beside
   * the envelope because `SeriesProvenance` (types.ts, wave-2 ownership) has
   * no notes field yet.
   */
  provenanceNotes?: string[];
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
  /** Same contract as `MarketCandlesResult.provenance`. */
  provenance?: SeriesProvenance;
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
//
// R4 slice 6 (audit-marketdata §4.1/§4.2): classification is DELEGATED to the
// canonical resolver, which consults the approved @workspace/markets Top 250
// universe FIRST and only then the router's previous regex/set logic (ported
// verbatim into symbolResolution.ts as the fallback tier). Behavior for every
// symbol the old classifier knew is preserved; unknown stays an explicit
// "unknown" and flows to this router's existing honest no-feed refusal —
// never to a silent synthetic default (that foot-gun lived in
// lib/data/types.ts getMarketType, now deprecated).

/** Public: classify any ARX-canonical or free-form symbol into an asset class. */
export function classifySymbol(symbolOrLabel: string): AssetClass {
  return resolveCanonicalSymbol(symbolOrLabel).assetClass;
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

// ── Provenance envelope construction ─────────────────────────────────────
//
// Threads the per-result source labeling the adapters already compute into the
// structured `SeriesProvenance` envelope (audit-marketdata S1). THREADING
// ONLY: no chain/fallback behavior may change here, and the legacy
// `primaryProvider` string labels stay byte-identical. Facts the serving
// layer cannot attribute today (bridge, owner, broker-native symbol) MUST be
// null — never guessed.
function makeProvenance(args: {
  providerId: string;
  subProviderId?: string | null;
  brokerCode: SeriesProvenance["brokerCode"];
  environment?: SeriesProvenance["environment"];
  delayed: boolean | null;
  source: SeriesProvenance["source"];
  sourceId: string;
  /** Serving-bridge identity (R4 slice 2): the in-memory mt5 store is
   *  bridge-partitioned, so live reads CAN attribute a bridge/owner now.
   *  Omitted/null = unattributable (durable mirror, non-broker providers) —
   *  stays null, never guessed. */
  bridgeConnectionId?: number | null;
  userId?: number | null;
}): SeriesProvenance {
  return {
    providerId: args.providerId,
    subProviderId: args.subProviderId ?? null,
    brokerCode: args.brokerCode,
    bridgeConnectionId: args.bridgeConnectionId ?? null,
    userId: args.userId ?? null,
    brokerSymbol: null,
    environment: args.environment ?? "unknown",
    receivedAt: new Date().toISOString(),
    delayed: args.delayed,
    source: args.source,
    sourceId: args.sourceId,
  };
}

/** Stable symbol token for `sourceId` — matches the providers' own key
 *  normalization (trim + uppercase) so the identifier cannot fork on casing. */
function sourceSymbolKey(symbol: string): string {
  return (symbol ?? "").trim().toUpperCase();
}

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

async function tryMt5Candles(
  symbol: string,
  timeframe: string,
  limit: number,
  opts?: { bridgeConnectionId?: number | null },
): Promise<ProviderAttempt & { candles: Candle[]; provenance: SeriesProvenance | null; notes?: string[] }> {
  const t0 = Date.now();
  // 1) LIVE in-memory provider — the freshest pushed bars win when present.
  const connected = await mt5Provider.isConnected();
  let liveError: string | null = null;
  if (connected) {
    try {
      // Bridge-scoped read (R4 slice 2): with opts.bridgeConnectionId the read
      // is pinned to that bridge's partition (miss → honest fall-through);
      // without, it serves the single most-recently-pushing writer and reports
      // that identity — series are NEVER blended across bridges.
      const read = readMt5Candles(symbol, timeframe, limit, {
        bridgeConnectionId: opts?.bridgeConnectionId ?? null,
      });
      if (read.candles.length > 0) {
        return {
          provider: "mt5_broker", ok: true, reason: null, candleCount: read.candles.length, ms: Date.now() - t0, candles: read.candles,
          // Live branch serves only what a connected EA pushed from the
          // terminal's own real-time chart series → delayed: false. Bars are
          // tick aggregates → "DERIVED" under the lib/provenance taxonomy.
          provenance: makeProvenance({
            providerId: "mt5_broker",
            brokerCode: "mt5",
            delayed: false,
            source: "DERIVED",
            sourceId: `mt5_broker:${sourceSymbolKey(symbol)}:${timeframe}`,
            bridgeConnectionId: read.bridgeConnectionId,
            userId: read.userId,
          }),
          // Contention is a serve-time truth about the store (two attributed
          // bridges fresh on one series): named, never silently resolved.
          ...(read.contention ? { notes: [MULTI_BRIDGE_CONTENTION_NOTE] } : {}),
        };
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
    return {
      provider: "mt5_broker", ok: true, reason: null, candleCount: durable.served.length, ms: Date.now() - t0, candles: durable.served,
      // The mirror read path does not carry the origin row's entitlement or
      // bridge facts (keyed symbol|timeframe|source only) → delayed unknown.
      provenance: makeProvenance({
        providerId: "mt5_broker",
        subProviderId: "durable_mirror",
        brokerCode: "mt5",
        delayed: null,
        source: "DERIVED",
        sourceId: `mt5_broker:${sourceSymbolKey(symbol)}:${timeframe}`,
      }),
    };
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
    // store served this request. Distinguish: (a) a bridge-pinned read missed
    // while ANOTHER writer serves this symbol|timeframe (must not be
    // mislabeled as a missing timeframe), (b) this timeframe is missing while
    // the symbol pushes others, (c) the symbol was never pushed at all.
    const avail = getMt5CandleAvailability(symbol, timeframe);
    if (opts?.bridgeConnectionId != null && avail.requestedFresh) {
      reason = "MT5_BRIDGE_SERIES_MISSING";
    } else {
      reason = avail.symbolHasAnySeries ? "MT5_TIMEFRAME_MISSING" : "MT5_CANDLES_NOT_PUSHED";
    }
  } else {
    reason = "MT5_BROKER_FEED_NOT_ACTIVE";
  }
  return { provider: "mt5_broker", ok: false, reason, candleCount: 0, ms: Date.now() - t0, candles: [], provenance: null };
}

async function tryMt5Quote(symbol: string): Promise<ProviderAttempt & { quote: MarketQuote | null; provenance: SeriesProvenance | null }> {
  const t0 = Date.now();
  const connected = await mt5Provider.isConnected();
  if (!connected) {
    return { provider: "mt5_broker", ok: false, reason: "MT5_BROKER_FEED_NOT_ACTIVE", candleCount: 0, ms: Date.now() - t0, quote: null, provenance: null };
  }
  try {
    const q = await mt5Provider.getQuote(symbol);
    const hasPrice = (q.bid != null && q.bid > 0) || (q.ask != null && q.ask > 0) || (q.last != null && q.last > 0);
    if (!hasPrice) {
      return { provider: "mt5_broker", ok: false, reason: "MT5_QUOTES_NOT_PUSHED", candleCount: 0, ms: Date.now() - t0, quote: null, provenance: null };
    }
    return {
      provider: "mt5_broker", ok: true, reason: null, candleCount: 0, ms: Date.now() - t0, quote: q,
      // A served quote is a fresh reading off the EA's real-time push → LIVE_TICK.
      provenance: makeProvenance({
        providerId: "mt5_broker",
        brokerCode: "mt5",
        delayed: false,
        source: "LIVE_TICK",
        sourceId: `mt5_broker:${sourceSymbolKey(symbol)}`,
      }),
    };
  } catch (err) {
    return { provider: "mt5_broker", ok: false, reason: redact(String((err as Error).message ?? err)), candleCount: 0, ms: Date.now() - t0, quote: null, provenance: null };
  }
}

async function tryDerivCandles(symbol: string, timeframe: string, limit: number): Promise<ProviderAttempt & { candles: Candle[]; provenance: SeriesProvenance | null }> {
  const t0 = Date.now();
  const status = getDerivFeedStatus();
  if (!status.configured) {
    return { provider: "deriv", ok: false, reason: "DERIV_NOT_CONFIGURED", candleCount: 0, ms: Date.now() - t0, candles: [], provenance: null };
  }
  const r = await getDerivCandles(symbol, timeframe, limit);
  if (!r.ok) {
    return { provider: "deriv", ok: false, reason: r.reason ?? "DERIV_FETCH_FAILED", candleCount: 0, ms: Date.now() - t0, candles: [], provenance: null };
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
  return {
    provider: "deriv", ok: true, reason: null, candleCount: candles.length, ms: Date.now() - t0, candles,
    // Deriv candles come off the live WS subscription (no delayed tier on that
    // endpoint) → delayed: false. The WS app connection is platform-level, not
    // account-bound → environment stays "unknown".
    provenance: makeProvenance({
      providerId: "deriv",
      brokerCode: "deriv",
      delayed: false,
      source: "DERIVED",
      sourceId: `deriv:${sourceSymbolKey(symbol)}:${timeframe}`,
    }),
  };
}

async function tryDerivQuote(symbol: string): Promise<ProviderAttempt & { quote: MarketQuote | null; provenance: SeriesProvenance | null }> {
  const t0 = Date.now();
  const status = getDerivFeedStatus();
  if (!status.configured) {
    return { provider: "deriv", ok: false, reason: "DERIV_NOT_CONFIGURED", candleCount: 0, ms: Date.now() - t0, quote: null, provenance: null };
  }
  const r = await getDerivTick(symbol);
  if (!r.ok || !r.tick) {
    return { provider: "deriv", ok: false, reason: r.reason ?? "DERIV_NO_TICK", candleCount: 0, ms: Date.now() - t0, quote: null, provenance: null };
  }
  const quote: MarketQuote = {
    symbol,
    last: r.tick.quote,
    timestamp: new Date(r.tick.epoch * 1000).toISOString(),
  };
  return {
    provider: "deriv", ok: true, reason: null, candleCount: 0, ms: Date.now() - t0, quote,
    provenance: makeProvenance({
      providerId: "deriv",
      brokerCode: "deriv",
      delayed: false,
      source: "LIVE_TICK",
      sourceId: `deriv:${sourceSymbolKey(symbol)}`,
    }),
  };
}

async function tryAssistantCandles(symbol: string, timeframe: string, limit: number): Promise<ProviderAttempt & { candles: Candle[]; provenance: SeriesProvenance | null }> {
  const t0 = Date.now();
  const p = getMarketProvider();
  if (!p.connected || !p.features.candles) {
    return { provider: `assistant_real:${p.name}`, ok: false, reason: p.connected ? "PROVIDER_NO_CANDLE_SUPPORT" : "NO_MARKET_PROVIDER_CONFIGURED", candleCount: 0, ms: Date.now() - t0, candles: [], provenance: null };
  }
  try {
    const r = await p.getCandles(symbol, timeframe, limit);
    if (!r.connected || r.candles.length === 0) {
      return { provider: `assistant_real:${p.name}`, ok: false, reason: r.notes ?? (r.connected ? "NO_CANDLES_RETURNED" : "PROVIDER_NOT_CONNECTED"), candleCount: 0, ms: Date.now() - t0, candles: [], provenance: null };
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
    return {
      provider: `assistant_real:${r.source}`, ok: true, reason: null, candleCount: candles.length, ms: Date.now() - t0, candles,
      // Third-party feed: the adapter's own freshness verdict is the only
      // entitlement fact available — anything else stays unknown, not guessed.
      provenance: makeProvenance({
        providerId: "assistant_real",
        subProviderId: r.source,
        brokerCode: "third_party",
        delayed: r.freshness === "DELAYED" ? true : r.freshness === "REALTIME" ? false : null,
        source: "DERIVED",
        sourceId: `assistant_real:${r.source}:${sourceSymbolKey(symbol)}:${timeframe}`,
      }),
    };
  } catch (err) {
    return { provider: `assistant_real:${p.name}`, ok: false, reason: redact(String((err as Error).message ?? err)), candleCount: 0, ms: Date.now() - t0, candles: [], provenance: null };
  }
}

async function tryAssistantQuote(symbol: string): Promise<ProviderAttempt & { quote: MarketQuote | null; provenance: SeriesProvenance | null }> {
  const t0 = Date.now();
  const p = getMarketProvider();
  if (!p.connected || !p.features.quotes) {
    return { provider: `assistant_real:${p.name}`, ok: false, reason: p.connected ? "PROVIDER_NO_QUOTE_SUPPORT" : "NO_MARKET_PROVIDER_CONFIGURED", candleCount: 0, ms: Date.now() - t0, quote: null, provenance: null };
  }
  try {
    const r = await p.getLiveQuote(symbol);
    if (r.freshness === "UNAVAILABLE" || r.freshness === "ERROR" || (r.price == null && r.bid == null && r.ask == null)) {
      return { provider: `assistant_real:${p.name}`, ok: false, reason: r.freshness === "ERROR" ? "PROVIDER_FETCH_ERROR" : "NO_QUOTE_AVAILABLE", candleCount: 0, ms: Date.now() - t0, quote: null, provenance: null };
    }
    const quote: MarketQuote = {
      symbol,
      bid: r.bid ?? undefined,
      ask: r.ask ?? undefined,
      last: r.price ?? undefined,
      spread: (r.bid != null && r.ask != null) ? r.ask - r.bid : undefined,
      timestamp: r.asOf ?? new Date().toISOString(),
    };
    // R1 residual: fold this REAL quote observation into the forming-bar
    // composer so assistant_real-served charts get a live (poll-cadence) tip.
    // REALTIME only — a DELAYED/STALE/DEMO reading folded "now" would claim a
    // liveness the provider never reported. The bridge dedupes cache replays
    // and the composer/chart service enforce basis coherence downstream.
    if (r.freshness === "REALTIME") {
      foldAssistantQuoteTick(symbol, {
        price: r.price ?? null,
        bid: r.bid ?? null,
        asOf: r.asOf ?? null,
      });
    }
    return {
      provider: `assistant_real:${r.source}`, ok: true, reason: null, candleCount: 0, ms: Date.now() - t0, quote,
      // The adapter's freshness verdict is threaded, not re-judged: DELAYED /
      // REALTIME map to the delayed flag, DEMO marks the environment, and a
      // STALE reading stays a real-but-old observation → "STALE" origin.
      provenance: makeProvenance({
        providerId: "assistant_real",
        subProviderId: r.source,
        brokerCode: "third_party",
        environment: r.freshness === "DEMO" ? "demo" : "unknown",
        delayed: r.freshness === "DELAYED" ? true : r.freshness === "REALTIME" ? false : null,
        source: r.freshness === "STALE" ? "STALE" : "LIVE_TICK",
        sourceId: `assistant_real:${r.source}:${sourceSymbolKey(symbol)}`,
      }),
    };
  } catch (err) {
    return { provider: `assistant_real:${p.name}`, ok: false, reason: redact(String((err as Error).message ?? err)), candleCount: 0, ms: Date.now() - t0, quote: null, provenance: null };
  }
}

// ── Public router API ────────────────────────────────────────────────────

export async function routeCandles(symbol: string, timeframe: string, limit: number): Promise<MarketCandlesResult> {
  const assetClass = classifySymbol(symbol);
  const chain = CHAIN_BY_CLASS[assetClass];
  const attempts: ProviderAttempt[] = [];
  const tf = normalizeTimeframe(timeframe);

  for (const id of chain) {
    // Every hop is deadlined (see withAttemptDeadline): an unanswered provider
    // must cost the caller a bounded wait, not an open-ended one. The chain,
    // its order, and the honest-empty verdict below are unchanged.
    const timedOut = (provider: string) => (a: ProviderAttempt) => ({
      ...a, provider, candles: [] as Candle[], provenance: null,
    });
    if (id === "mt5_broker") {
      const r = await withAttemptDeadline("mt5_broker", PROVIDER_ATTEMPT_TIMEOUT_MS,
        () => tryMt5Candles(symbol, tf, limit), timedOut("mt5_broker") as never);
      attempts.push(stripCandles(r));
      if (r.ok) return success(symbol, assetClass, r.candles, r.provider, attempts, r.provenance, r.notes);
    } else if (id === "deriv") {
      const r = await withAttemptDeadline("deriv", PROVIDER_ATTEMPT_TIMEOUT_MS,
        () => tryDerivCandles(symbol, tf, limit), timedOut("deriv") as never);
      attempts.push(stripCandles(r));
      if (r.ok) return success(symbol, assetClass, r.candles, r.provider, attempts, r.provenance);
    } else if (id === "assistant_real") {
      const r = await withAttemptDeadline("assistant_real", PROVIDER_ATTEMPT_TIMEOUT_MS,
        () => tryAssistantCandles(symbol, tf, limit), timedOut("assistant_real") as never);
      attempts.push(stripCandles(r));
      if (r.ok) return success(symbol, assetClass, r.candles, r.provider, attempts, r.provenance);
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

// ── Decision-grade routing (R4 slice 4 prep — audit-marketdata §3.3, §10.2.6) ─
//
// Decision/execution surfaces must never ride a silently substituted venue:
// when the EXECUTION broker's feed is stale/absent, the answer is WAIT — not a
// fresh-looking series borrowed from assistant_real/twelvedata/deriv. Display
// surfaces keep the full labeled fallback chain (`routeCandles`, unchanged).

/** The venue that will EXECUTE the order this decision feeds. "mt5" = the
 *  MT5 broker bridge (default; the only execution path shipped today).
 *  "deriv" = a Deriv API connection — valid ONLY for synthetics, and only when
 *  the executing venue genuinely IS the Deriv connection (no Deriv execution
 *  adapter exists yet; parameterized so the wave-4 integrator names the venue
 *  instead of this router guessing it). */
export type IntendedExecutionVenue = "mt5" | "deriv";

/** WAIT reason when the caller names a Deriv execution venue for a symbol that
 *  is not a Deriv synthetic — cross-venue decision data is refused, never
 *  substituted. */
export const DECISION_VENUE_MISMATCH_REASON = "DERIV_EXECUTION_VENUE_REQUIRES_SYNTHETIC";
/** Fallback WAIT reason when an execution-broker attempt failed without naming
 *  a more precise one. */
export const DECISION_FEED_UNAVAILABLE_REASON = "EXECUTION_BROKER_FEED_UNAVAILABLE";

export interface DecisionCandlesResult {
  ok: boolean;
  /** "SERVE" exactly when ok === true; "WAIT" is the honest refusal state. */
  verdict: "SERVE" | "WAIT";
  /** Refusal code when verdict === "WAIT" (reuses the router's existing reason
   *  taxonomy, e.g. MT5_BROKER_HISTORY_STALE / MT5_BROKER_FEED_NOT_ACTIVE /
   *  DERIV_NOT_CONFIGURED); null when served. */
  reason: string | null;
  symbol: string;
  assetClass: AssetClass;
  intendedVenue: IntendedExecutionVenue;
  candles: Candle[];
  primaryProvider: string | null;
  attempts: ProviderAttempt[];
  userMessage: string;
  adminDetail: string;
  provenance?: SeriesProvenance;
  provenanceNotes?: string[];
}

function decisionWait(
  symbol: string,
  assetClass: AssetClass,
  intendedVenue: IntendedExecutionVenue,
  reason: string,
  attempts: ProviderAttempt[],
): DecisionCandlesResult {
  return {
    ok: false,
    verdict: "WAIT",
    reason,
    symbol,
    assetClass,
    intendedVenue,
    candles: [],
    primaryProvider: null,
    attempts,
    userMessage:
      "Waiting for the execution broker's live feed. Decisions never use a substitute data source.",
    adminDetail: `Decision-grade WAIT for ${symbol} (${assetClass}); execution venue ${intendedVenue}; reason ${reason}. Fallback providers deliberately NOT attempted.`,
  };
}

/**
 * Decision-grade candle read: serves ONLY the execution broker's feed and
 * returns `{ ok:false, verdict:"WAIT", reason }` when that feed is stale,
 * insufficient, or absent — it NEVER falls through to assistant_real/
 * twelvedata (and reaches deriv only when the caller names the Deriv
 * connection as the executing venue for a synthetic). Display paths must keep
 * using `routeCandles`.
 *
 * `opts.bridgeConnectionId` pins the LIVE in-memory read to the executing
 * bridge's partition. The durable-mirror fallback inside the mt5 slot cannot
 * be bridge-filtered until the market_candles migration lands; bars it serves
 * carry `provenance.bridgeConnectionId: null` (honestly unattributed) so a
 * same-bridge dispatch gate can see — and refuse — the missing attribution.
 */
export async function routeCandlesForDecision(
  symbol: string,
  timeframe: string,
  opts?: {
    limit?: number;
    intendedVenue?: IntendedExecutionVenue;
    bridgeConnectionId?: number | null;
  },
): Promise<DecisionCandlesResult> {
  const assetClass = classifySymbol(symbol);
  const intendedVenue: IntendedExecutionVenue = opts?.intendedVenue ?? "mt5";
  const limit = opts?.limit ?? 200;
  const tf = normalizeTimeframe(timeframe);
  const attempts: ProviderAttempt[] = [];

  if (intendedVenue === "deriv") {
    // The Deriv WS feed may feed a decision ONLY when the executing venue IS
    // the Deriv connection — and that venue trades synthetics only.
    if (assetClass !== "synthetic") {
      return decisionWait(symbol, assetClass, intendedVenue, DECISION_VENUE_MISMATCH_REASON, attempts);
    }
    const r = await tryDerivCandles(symbol, tf, limit);
    attempts.push(stripCandles(r));
    if (r.ok) {
      return {
        ...success(symbol, assetClass, r.candles, r.provider, attempts, r.provenance),
        verdict: "SERVE",
        reason: null,
        intendedVenue,
      };
    }
    return decisionWait(
      symbol, assetClass, intendedVenue, r.reason ?? DECISION_FEED_UNAVAILABLE_REASON, attempts,
    );
  }

  // Execution venue "mt5": the broker slot is the WHOLE chain. Its internal
  // live→durable preference is unchanged; only the cross-venue fall-through is
  // removed.
  const r = await tryMt5Candles(symbol, tf, limit, {
    bridgeConnectionId: opts?.bridgeConnectionId ?? null,
  });
  attempts.push(stripCandles(r));
  if (r.ok) {
    return {
      ...success(symbol, assetClass, r.candles, r.provider, attempts, r.provenance, r.notes),
      verdict: "SERVE",
      reason: null,
      intendedVenue,
    };
  }
  return decisionWait(
    symbol, assetClass, intendedVenue, r.reason ?? DECISION_FEED_UNAVAILABLE_REASON, attempts,
  );
}

export async function routeQuote(symbol: string): Promise<MarketQuoteResult> {
  const assetClass = classifySymbol(symbol);
  const chain = CHAIN_BY_CLASS[assetClass];
  const attempts: ProviderAttempt[] = [];

  for (const id of chain) {
    // Deadlined for the same reason as routeCandles: an unanswered provider
    // costs a bounded wait, and the silence is recorded as silence.
    const timedOutQ = (provider: string) => (a: ProviderAttempt) => ({
      ...a, provider, quote: null as MarketQuote | null, provenance: null,
    });
    if (id === "mt5_broker") {
      const r = await withAttemptDeadline("mt5_broker", PROVIDER_ATTEMPT_TIMEOUT_MS,
        () => tryMt5Quote(symbol), timedOutQ("mt5_broker") as never);
      attempts.push(stripQuote(r));
      if (r.ok && r.quote) return successQuote(symbol, assetClass, r.quote, r.provider, attempts, r.provenance);
    } else if (id === "deriv") {
      const r = await withAttemptDeadline("deriv", PROVIDER_ATTEMPT_TIMEOUT_MS,
        () => tryDerivQuote(symbol), timedOutQ("deriv") as never);
      attempts.push(stripQuote(r));
      if (r.ok && r.quote) return successQuote(symbol, assetClass, r.quote, r.provider, attempts, r.provenance);
    } else if (id === "assistant_real") {
      const r = await withAttemptDeadline("assistant_real", PROVIDER_ATTEMPT_TIMEOUT_MS,
        () => tryAssistantQuote(symbol), timedOutQ("assistant_real") as never);
      attempts.push(stripQuote(r));
      if (r.ok && r.quote) return successQuote(symbol, assetClass, r.quote, r.provider, attempts, r.provenance);
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

// Attempts are diagnostics that get serialized to admin surfaces — they must
// carry neither the payload nor the provenance envelope nor its notes (the
// envelope belongs to the WINNING result only; a failed attempt has nothing to
// attribute).
function stripCandles<T extends { candles: Candle[]; provenance: SeriesProvenance | null; notes?: string[] } & ProviderAttempt>(r: T): ProviderAttempt {
  const { candles: _candles, provenance: _provenance, notes: _notes, ...rest } = r;
  return rest;
}
function stripQuote<T extends { quote: MarketQuote | null; provenance: SeriesProvenance | null } & ProviderAttempt>(r: T): ProviderAttempt {
  const { quote: _quote, provenance: _provenance, ...rest } = r;
  return rest;
}

function success(symbol: string, assetClass: AssetClass, candles: Candle[], provider: string, attempts: ProviderAttempt[], provenance: SeriesProvenance | null, notes?: string[]): MarketCandlesResult {
  return {
    ok: true,
    symbol,
    assetClass,
    candles,
    primaryProvider: provider,
    attempts,
    userMessage: "Live feed active",
    adminDetail: `Served by ${provider}; ${candles.length} candles; ${attempts.length} provider(s) tried.`,
    // Spread keeps the field ABSENT (not `undefined`-valued) when an adapter
    // produced no envelope/notes, so JSON serializations stay byte-compatible.
    ...(provenance ? { provenance } : {}),
    ...(notes && notes.length > 0 ? { provenanceNotes: notes } : {}),
  };
}
function successQuote(symbol: string, assetClass: AssetClass, quote: MarketQuote, provider: string, attempts: ProviderAttempt[], provenance: SeriesProvenance | null): MarketQuoteResult {
  return {
    ok: true,
    symbol,
    assetClass,
    quote,
    primaryProvider: provider,
    attempts,
    userMessage: "Live feed active",
    adminDetail: `Served by ${provider}; ${attempts.length} provider(s) tried.`,
    ...(provenance ? { provenance } : {}),
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
