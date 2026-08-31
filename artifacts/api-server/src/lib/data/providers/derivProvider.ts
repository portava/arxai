// Deriv synthetic-index feed adapter — config, status, and data surface.
//
// Wraps the lazy WebSocket client (`derivWsClient.ts`) and exposes a
// clean, candle-shaped interface to the rest of the app:
//
//   getDerivFeedStatus()                  — diagnostics (no secrets)
//   getDerivCandles(symbol, tf, count)    — historical OHLC via WS
//   getDerivTick(symbol)                  — cached/subscribed last tick
//   resolveDerivSymbol(label)             — clean label → Deriv id
//
// Inviolables:
//   - Never logs DERIV_APP_ID or DERIV_API_TOKEN.
//   - Returns booleans for env presence — never raw values.
//   - When unconfigured, getDerivCandles returns `{ ok:false }` and
//     never fabricates synthetic candles.

import { getDerivWsClient, DERIV_PUBLIC_DATA_ONLY, type DerivCandle, type DerivGranularity } from "./derivWsClient.js";
import { getInstrumentPassport, venueCodeSymbol } from "@workspace/domain/market";

export interface DerivSyntheticSymbol {
  symbol: string;          // ARX-internal label
  derivId: string;         // Deriv WS symbol id
  displayName: string;     // friendly name
  oneHertz: boolean;       // 1Hz tick stream
}

/**
 * D3b — build an entry for an APPROVED market by reading THROUGH its
 * Instrument Passport (`@workspace/domain/market`): the ARX symbol, the Deriv
 * venue id and the display name are passport facts, no longer a copy that can
 * drift. A canonical named here without a passport is a wiring bug — fail
 * loudly at module load rather than serve a symbol map that lies.
 */
function fromPassport(canonical: string, oneHertz: boolean): DerivSyntheticSymbol {
  const pp = getInstrumentPassport(canonical);
  if (!pp) {
    throw new Error(`DERIV_SYNTHETIC_SYMBOLS: "${canonical}" has no Instrument Passport`);
  }
  return {
    symbol: pp.canonicalSymbol,
    derivId: venueCodeSymbol(pp),
    displayName: pp.displayName,
    oneHertz,
  };
}

/**
 * Canonical synthetic-index symbol map — the venue's capability list.
 *
 * Approved (Focus) symbols derive from their Instrument Passport. The four
 * literal entries (V25, V10_1S, V100_1S, STEP) are Deriv symbols the feed can
 * discover that are NOT in the approved ARX Focus universe — venue-only
 * facts, so the passport deliberately does not own them.
 */
export const DERIV_SYNTHETIC_SYMBOLS: DerivSyntheticSymbol[] = [
  fromPassport("V10", false),
  { symbol: "V25",      derivId: "R_25",      displayName: "Volatility 25 Index",       oneHertz: false },
  fromPassport("V50", false),
  fromPassport("V75", false),
  fromPassport("V100", false),
  { symbol: "V10_1S",   derivId: "1HZ10V",    displayName: "Volatility 10 (1s) Index",  oneHertz: true  },
  fromPassport("V25_1S", true),
  fromPassport("V50_1S", true),
  fromPassport("V75_1S", true),
  { symbol: "V100_1S",  derivId: "1HZ100V",   displayName: "Volatility 100 (1s) Index", oneHertz: true  },
  fromPassport("BOOM300", false),
  fromPassport("BOOM500", false),
  fromPassport("BOOM1000", false),
  fromPassport("CRASH300", false),
  fromPassport("CRASH500", false),
  fromPassport("CRASH1000", false),
  { symbol: "STEP",     derivId: "stpRNG",    displayName: "Step Index",                oneHertz: false },
  fromPassport("JUMP10", false),
  fromPassport("JUMP25", false),
  fromPassport("JUMP50", false),
  fromPassport("JUMP75", false),
  fromPassport("JUMP100", false),
];

export interface DerivFeedStatus {
  configured: boolean;
  connected: boolean;
  appIdConfigured: boolean;
  apiTokenConfigured: boolean;
  accountIdConfigured: boolean;
  mode: "new" | "legacy" | "none";
  maskedAppId: string;
  maskedToken: string;
  wsUrl: string;
  knownSyntheticSymbolCount: number;
  activeSymbolCount: number;
  subscribedSymbols: string[];
  lastTickAt: string | null;
  connectedAt: string | null;
  reconnectCount: number;
  message: string;
  errorMessage: string | null;
  otpLastResult: string | null;
  /**
   * The session's REAL authorize state (client.isAuthorized()) — true only
   * after a successful `authorize` on this connection. NEVER derived from feed
   * health: ticks flow on unauthorized public sessions too, and an authorized
   * session can be tickless.
   */
  authorized: boolean;
  /**
   * True when this is a deliberate public-data-only session (Ruling 15, new
   * API mode): `authorize` is withheld BY DESIGN, so authorized=false here is
   * the intended healthy state — not a credential failure.
   */
  publicDataOnly: boolean;
  healthSummary: "healthy" | "degraded" | "failed" | "unconfigured" | "warming";
  // Phase 22X — warm-up lifecycle visibility.
  activeSymbolsLoaded: boolean;
  activeSymbolsCachedCount: number | null;
  activeSymbolsLoadedAt: string | null;
  activeSymbolsError: string | null;
  eagerWarmupSymbols: string[];
  warmupAttemptedAt: string | null;
  warmupCompletedAt: string | null;
  lastTickAgeMs: number | null;
  hasRecentTick: boolean;
  lastCandleAt: string | null;
  feedReadinessState:
    | "UNCONFIGURED"
    | "CONNECTING"
    | "AUTH_FAILED"
    | "CONNECTED_AWAITING_FEED"
    | "HISTORY_READY_AWAITING_LIVE_TICK"
    | "LIVE_FEED";
}

const DEFAULT_DERIV_WS_URL = "wss://ws.derivws.com/websockets/v3";

/** Map clean ARX label → Deriv WS symbol id, or null when unknown. */
/** Phase 22X — per-symbol live-tick freshness check. Returns true when the
 *  cached tick for this specific Deriv symbol arrived within `maxAgeMs`.
 *  Used by the scanner to decide LIVE_FEED vs HISTORY_READY_AWAITING_LIVE_TICK
 *  on a per-row basis (so one ticking symbol does NOT promote the rest). */
export function hasRecentDerivTickFor(symbolOrLabel: string, maxAgeMs: number = 30_000): boolean {
  const map = resolveDerivSymbol(symbolOrLabel);
  if (!map) return false;
  const client = getDerivWsClient();
  const tick = client.getCachedTickByDerivId(map.derivId);
  if (!tick || typeof tick.epoch !== "number") return false;
  const ageMs = Date.now() - tick.epoch * 1000;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

export function resolveDerivSymbol(symbolOrLabel: string): DerivSyntheticSymbol | null {
  const up = symbolOrLabel.trim().toUpperCase();
  for (const s of DERIV_SYNTHETIC_SYMBOLS) {
    if (s.symbol === up || s.derivId.toUpperCase() === up) return s;
  }
  // Tolerant: accept "VOLATILITY 75", "VOLATILITY 75 1S", "BOOM 1000", "CRASH 1000".
  const compact = up.replace(/\s+/g, "");
  for (const s of DERIV_SYNTHETIC_SYMBOLS) {
    const name = s.displayName.toUpperCase().replace(/\s+/g, "").replace(/INDEX$/, "");
    if (compact === name || compact === name + "INDEX") return s;
  }
  return null;
}

export function isDerivSyntheticSymbol(symbol: string): boolean {
  return resolveDerivSymbol(symbol) !== null;
}

/** Map an ARX timeframe (M1/M5/M15/H1/H4/D1) → Deriv `granularity` seconds. */
export function toDerivGranularity(tf: string): DerivGranularity | null {
  switch (tf.toUpperCase()) {
    case "M1":  return 60;
    case "M2":  return 120;
    case "M3":  return 180;
    case "M5":  return 300;
    case "M10": return 600;
    case "M15": return 900;
    case "M30": return 1800;
    case "H1":  return 3600;
    case "H2":  return 7200;
    case "H4":  return 14400;
    case "H8":  return 28800;
    case "D1":  return 86400;
    default:    return null;
  }
}

export function getDerivFeedStatus(): DerivFeedStatus {
  const appIdConfigured   = Boolean(process.env.DERIV_APP_ID && process.env.DERIV_APP_ID.trim());
  const apiTokenConfigured = Boolean(process.env.DERIV_API_TOKEN && process.env.DERIV_API_TOKEN.trim());
  const client = getDerivWsClient();
  if (appIdConfigured) client.ensureConnection();
  const subs       = client.getSubscribedSymbols();
  const connected  = client.isConnected();
  const authorized = client.isAuthorized();
  const mode       = client.getMode();
  const errMsg     = client.getLastErrorMessage();
  const authErr    = client.getLastAuthorizeError();

  const activeSymbolsLoaded = client.isActiveSymbolsLoaded();
  const hasRecentTick = client.hasRecentTick();
  const lastTickAgeMs = client.getLastTickAgeMs();

  // Phase 22X — explicit warm-up lifecycle state used by the scanner,
  // admin diagnostics, and the user-facing feed banner.
  //
  // Precedence: live ticks ALWAYS win. Public synthetic-index data does
  // not require an authorized session, so a stale/invalid DERIV_API_TOKEN
  // must not demote a feed that is actively streaming ticks. AUTH_FAILED
  // is only surfaced when authorize was attempted and rejected AND no
  // live data is flowing — i.e. it is purely informational for the
  // private-account features that require auth.
  const feedReadinessState: DerivFeedStatus["feedReadinessState"] =
    !appIdConfigured                                            ? "UNCONFIGURED" :
    !connected                                                   ? "CONNECTING" :
    hasRecentTick                                                ? "LIVE_FEED" :
    // A PUBLIC-DATA-ONLY session (new mode) never attempted authorize — by
    // design, per Ruling 15 — so it must never present as a failed one.
    (!authorized && (process.env.DERIV_API_TOKEN ?? "").trim() && authErr
      && authErr !== DERIV_PUBLIC_DATA_ONLY)                     ? "AUTH_FAILED" :
    activeSymbolsLoaded                                          ? "HISTORY_READY_AWAITING_LIVE_TICK" :
                                                                   "CONNECTED_AWAITING_FEED";

  // Health rolls up readiness state. Anything past CONNECTING that has not
  // yet hit LIVE_FEED is reported as "warming" — not "degraded" — so the
  // admin UI distinguishes a healthy boot from an actual provider failure.
  const healthSummary: DerivFeedStatus["healthSummary"] =
    feedReadinessState === "UNCONFIGURED"                       ? "unconfigured" :
    feedReadinessState === "AUTH_FAILED"                         ? "degraded" :
    feedReadinessState === "CONNECTING" && errMsg                ? "failed" :
    feedReadinessState === "CONNECTING"                          ? "warming" :
    feedReadinessState === "CONNECTED_AWAITING_FEED"             ? "warming" :
    feedReadinessState === "HISTORY_READY_AWAITING_LIVE_TICK"    ? "warming" :
                                                                   "healthy";

  const message = !appIdConfigured
    ? "Deriv feed not configured. Add DERIV_APP_ID (and DERIV_API_TOKEN for new API mode)."
    : feedReadinessState === "LIVE_FEED"
      ? `Deriv feed connected (${mode} mode) — live ticks streaming.`
      : feedReadinessState === "HISTORY_READY_AWAITING_LIVE_TICK"
        ? `Deriv feed connected (${mode} mode). Historical candles ready; waiting for first live tick…`
        : feedReadinessState === "CONNECTED_AWAITING_FEED"
          ? `Deriv feed connected (${mode} mode). Loading active symbols and tick subscriptions…`
          : feedReadinessState === "AUTH_FAILED"
            ? `Deriv feed connected (${mode} mode) but authorize failed; public synthetic data still available.`
            : `Deriv feed configured (${mode} mode). Connecting…`;

  return {
    configured: appIdConfigured,
    connected,
    appIdConfigured,
    apiTokenConfigured,
    accountIdConfigured: client.getAccountIdConfigured(),
    mode,
    maskedAppId:  client.getMaskedAppId(),
    maskedToken:  client.getMaskedToken(),
    wsUrl: connected ? "connected" : "connecting…",
    knownSyntheticSymbolCount: DERIV_SYNTHETIC_SYMBOLS.length,
    activeSymbolCount: subs.length,
    subscribedSymbols: subs,
    lastTickAt: client.getLastTickAt(),
    connectedAt: client.getConnectedAt(),
    reconnectCount: client.getReconnectCount(),
    message,
    errorMessage: errMsg,
    otpLastResult: mode === "new" ? client.getOtpLastResult() : null,
    // Truthful authorize state — see the interface docs. `publicDataOnly` is
    // keyed off the Ruling-15 sentinel the client stamps when it deliberately
    // withholds `authorize` on a new-mode (public data) session.
    authorized,
    publicDataOnly: authErr === DERIV_PUBLIC_DATA_ONLY,
    healthSummary,
    activeSymbolsLoaded,
    activeSymbolsCachedCount: client.getActiveSymbolsCount(),
    activeSymbolsLoadedAt: client.getActiveSymbolsLoadedAt(),
    activeSymbolsError: client.getActiveSymbolsError(),
    eagerWarmupSymbols: client.getEagerWarmupSymbols(),
    warmupAttemptedAt: client.getWarmupAttemptedAt(),
    warmupCompletedAt: client.getWarmupCompletedAt(),
    lastTickAgeMs,
    hasRecentTick,
    lastCandleAt: client.getLastCandleAt(),
    feedReadinessState,
  };
}

export interface DerivSymbolFeedStatus {
  /** Whether the label resolved to a known Deriv synthetic instrument. */
  resolved: boolean;
  derivId: string | null;
  /** THIS symbol's own most-recent cached tick time (ISO), or null. */
  lastTickAt: string | null;
  lastTickAgeMs: number | null;
  /** True ONLY when THIS symbol ticked within `maxAgeMs`. */
  hasRecentTick: boolean;
  /** Per-symbol readiness — same precedence as the global resolver, but
   *  LIVE_FEED is gated on THIS symbol's own recent tick, never another's. */
  feedReadinessState: DerivFeedStatus["feedReadinessState"];
}

/**
 * Phase 1B (Task #542) — the ONE per-symbol Deriv feed verdict.
 *
 * Every surface that needs to know whether a SPECIFIC synthetic is live reads
 * this, so the chart badge popover (State / Last tick / Readiness / AI-usable),
 * the scanner row, and the live-entry floor can never tell different stories
 * for the same symbol. `LIVE_FEED` / `hasRecentTick` here mean THIS symbol is
 * genuinely ticking now — a different synthetic ticking never promotes it
 * (that was the false-negative: a global "LIVE_FEED" while this symbol awaited
 * its first tick). Never fabricates: an unresolved/unticking symbol reads
 * honestly as awaiting/historical.
 */
export function getDerivSymbolFeedStatus(
  symbolOrLabel: string,
  maxAgeMs: number = 30_000,
): DerivSymbolFeedStatus {
  const appIdConfigured = Boolean(process.env.DERIV_APP_ID && process.env.DERIV_APP_ID.trim());
  const client = getDerivWsClient();
  if (appIdConfigured) client.ensureConnection();
  const connected = client.isConnected();
  const authorized = client.isAuthorized();
  const authErr = client.getLastAuthorizeError();
  const activeSymbolsLoaded = client.isActiveSymbolsLoaded();

  const map = resolveDerivSymbol(symbolOrLabel);
  let lastTickAt: string | null = null;
  let lastTickAgeMs: number | null = null;
  let hasRecentTick = false;
  if (map) {
    const tick = client.getCachedTickByDerivId(map.derivId);
    if (tick && typeof tick.epoch === "number") {
      const epochMs = tick.epoch * 1000;
      const ageMs = Date.now() - epochMs;
      lastTickAgeMs = ageMs;
      lastTickAt = new Date(epochMs).toISOString();
      hasRecentTick = ageMs >= 0 && ageMs <= maxAgeMs;
    }
  }

  // Same precedence as getDerivFeedStatus(), but LIVE_FEED is gated on THIS
  // symbol's own recent tick. AUTH_FAILED stays purely informational — public
  // synthetic data does not require an authorized session.
  const feedReadinessState: DerivFeedStatus["feedReadinessState"] =
    !appIdConfigured                                                        ? "UNCONFIGURED" :
    !connected                                                              ? "CONNECTING" :
    hasRecentTick                                                           ? "LIVE_FEED" :
    (!authorized && (process.env.DERIV_API_TOKEN ?? "").trim() && authErr
      && authErr !== DERIV_PUBLIC_DATA_ONLY)                                ? "AUTH_FAILED" :
    activeSymbolsLoaded                                                     ? "HISTORY_READY_AWAITING_LIVE_TICK" :
                                                                             "CONNECTED_AWAITING_FEED";

  return {
    resolved: map != null,
    derivId: map?.derivId ?? null,
    lastTickAt,
    lastTickAgeMs,
    hasRecentTick,
    feedReadinessState,
  };
}

export interface DerivCandlesResult {
  ok: boolean;
  reason: string | null;
  candles: DerivCandle[];
  symbol: string;
  derivSymbol: string | null;
  granularitySeconds: number | null;
}

/** Fetch candles for a synthetic symbol via the WS client.
 *  `endEpochSeconds` (optional) anchors the fetch to a point in the PAST for
 *  deep-history backfill; omitted = latest window (unchanged default). */
export async function getDerivCandles(
  symbol: string,
  timeframe: string,
  count: number,
  endEpochSeconds?: number,
): Promise<DerivCandlesResult> {
  const map = resolveDerivSymbol(symbol);
  if (!map) {
    return { ok: false, reason: "SYMBOL_UNAVAILABLE_FROM_DERIV_FEED", candles: [], symbol, derivSymbol: null, granularitySeconds: null };
  }
  const granularity = toDerivGranularity(timeframe);
  if (!granularity) {
    return { ok: false, reason: "TIMEFRAME_UNSUPPORTED", candles: [], symbol, derivSymbol: map.derivId, granularitySeconds: null };
  }
  const client = getDerivWsClient();
  if (!client.configured()) {
    return { ok: false, reason: "DERIV_NOT_CONFIGURED", candles: [], symbol, derivSymbol: map.derivId, granularitySeconds: granularity };
  }
  client.ensureConnection();
  try {
    const candles = await client.getCandles(map.derivId, granularity, count, endEpochSeconds);
    return { ok: candles.length > 0, reason: candles.length > 0 ? null : "NO_CANDLES_RETURNED", candles, symbol, derivSymbol: map.derivId, granularitySeconds: granularity };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.replace(/app_id=[^&\s]+/gi, "app_id=<redacted>"), candles: [], symbol, derivSymbol: map.derivId, granularitySeconds: granularity };
  }
}

export interface DerivTickResult {
  ok: boolean;
  reason: string | null;
  tick: { symbol: string; derivSymbol: string; epoch: number; quote: number } | null;
}

export async function getDerivTick(symbol: string): Promise<DerivTickResult> {
  const map = resolveDerivSymbol(symbol);
  if (!map) return { ok: false, reason: "SYMBOL_UNAVAILABLE_FROM_DERIV_FEED", tick: null };
  const client = getDerivWsClient();
  if (!client.configured()) return { ok: false, reason: "DERIV_NOT_CONFIGURED", tick: null };
  client.ensureConnection();
  try {
    const t = await client.subscribeTicks(map.derivId);
    if (!t) {
      const cached = client.getCachedTick(map.derivId);
      if (!cached) return { ok: false, reason: "NO_TICK_AVAILABLE", tick: null };
      return { ok: true, reason: null, tick: { symbol, derivSymbol: map.derivId, epoch: cached.epoch, quote: cached.quote } };
    }
    return { ok: true, reason: null, tick: { symbol, derivSymbol: map.derivId, epoch: t.epoch, quote: t.quote } };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.replace(/app_id=[^&\s]+/gi, "app_id=<redacted>"), tick: null };
  }
}
