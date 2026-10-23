// ── Provider routing map (Task #432) ─────────────────────────────────────────
//
// A typed, single-source-of-truth description of WHERE each market category's
// market data comes from: live quotes, candle HISTORY (with real provider depth
// limits), the execution venue, broker-symbol mapping notes, and the fallback
// chain. This documents — and lets diagnostics surface — the routing the
// `marketDataRouter` actually performs (CHAIN_BY_CLASS) plus the deep-history
// behavior added in this task.
//
// HONESTY: the depth limits below are the REAL provider ceilings, not wishes.
//   - Deriv synthetics: deep history via the WS `ticks_history` end-cursor.
//   - MT5 broker: deep history only once the EA streams CopyRates history (the
//     producer side is untestable in this environment — see mt5History.ts).
//   - Assistant real providers (TwelveData / Polygon / AlphaVantage): the FREE
//     tiers are forward-window limited and have NO true older-than cursor, so a
//     target deeper than the tier allows is reported as a provider limit rather
//     than silently truncated.
//
// This module is MARKET-DATA / TELEMETRY ONLY. It never touches execution, the
// 16-gate live pipeline, `arx_live_*` tables, balances, or fills. The
// `executionSource` field is DESCRIPTIVE (where a live order would route) — it
// does not enable, gate, or perform any execution.

import type { AssetClass } from "./marketDataRouter.js";

export type HistoryDepthSupport =
  | "deep_cursor" // provider supports an older-than cursor → can page deep history
  | "forward_only" // provider returns only a recent window; no older cursor
  | "ea_push_only" // history only when the EA streams it (no server-side fetch)
  | "none"; // no history available from this provider

export interface ProviderRouteEntry {
  assetClass: AssetClass;
  /** Human description of the category. */
  description: string;
  /** Provider that answers live quotes (first usable in the chain). */
  liveQuoteSource: string;
  /** Provider chain that answers candle HISTORY, deepest-capable first. */
  historySourceChain: string[];
  /** How deep history can actually go for the primary history source. */
  historyDepthSupport: HistoryDepthSupport;
  /** Where a LIVE order for this class would route (DESCRIPTIVE — never enables execution). */
  executionSource: string;
  /** Broker-symbol mapping note (resolution happens only at the live boundary). */
  brokerSymbolNote: string;
  /** Ordered fallback providers when the primary is unavailable. */
  fallbackChain: string[];
  /** Honest, human-readable note about real provider depth limits. */
  providerLimitNote: string;
}

/**
 * Per-timeframe deep-history depth TARGETS (in days). A provider that can reach
 * the target should; one that can't must report the real limit honestly.
 *
 * The targets are MONOTONIC NON-DECREASING along the canonical timeframe order
 * (M1…MN1): finer timeframes get a shallower day budget because bar counts
 * explode, coarser ones get deeper history. The seven originally-tuned anchors
 * (M1/M5/M15/M30/H1/H4/D1) keep their EXACT values — the deep-history scroll
 * test hard-asserts them — and the remaining timeframes fill the gaps between
 * those anchors at the nearest sensible band. (The earlier "M30 inherits M15"
 * note is now just one case of this general rule.)
 */
export const DEPTH_TARGET_DAYS: Record<string, number> = {
  M1: 365, // ~1y of 1-minute bars (anchor)
  M2: 365,
  M3: 365,
  M4: 365,
  M5: 730, // ~2y (anchor)
  M6: 730,
  M10: 730,
  M12: 730,
  M15: 1095, // ~3y (anchor)
  M20: 1095,
  M30: 1095, // ~3y (anchor)
  H1: 1825, // ~5y (anchor)
  H2: 1825,
  H3: 1825,
  H4: 2555, // ~7y (anchor)
  H6: 2555,
  H8: 2555,
  H12: 2555,
  D1: 3650, // ~10y (anchor — deepest practical daily history)
  W1: 3650, // ~10y (coarser than D1; equal day-budget is plenty of weekly bars)
  MN1: 3650, // ~10y (coarser than D1; equal day-budget is plenty of monthly bars)
};

/** Default target for an unrecognized timeframe (mirrors the shallowest). */
export const DEFAULT_DEPTH_TARGET_DAYS = 365;

export function depthTargetDaysFor(timeframe: string): number {
  return DEPTH_TARGET_DAYS[timeframe] ?? DEFAULT_DEPTH_TARGET_DAYS;
}

export const PROVIDER_ROUTING_MAP: Record<AssetClass, ProviderRouteEntry> = {
  synthetic: {
    assetClass: "synthetic",
    description: "Deriv volatility / boom / crash / step / jump indices",
    liveQuoteSource: "deriv (WS ticks)",
    historySourceChain: ["mt5_broker", "deriv"],
    historyDepthSupport: "deep_cursor",
    executionSource: "mt5_broker (per-user EA bridge)",
    brokerSymbolNote:
      "Deriv id (e.g. R_75) for data; broker Market-Watch name (e.g. Volatility 75 Index) for execution — resolved only at the live boundary.",
    fallbackChain: ["deriv"],
    providerLimitNote:
      "Deriv ticks_history supports an end-cursor, so synthetics can page deep history (capped per request at 5000 bars). MT5 broker history requires EA CopyRates streaming.",
  },
  forex: {
    assetClass: "forex",
    description: "Major / minor FX pairs (EURUSD, GBPUSD, …)",
    liveQuoteSource: "mt5_broker → assistant_real (TwelveData/Polygon/AlphaVantage)",
    historySourceChain: ["mt5_broker", "assistant_real"],
    historyDepthSupport: "forward_only",
    executionSource: "mt5_broker (per-user EA bridge)",
    brokerSymbolNote:
      "ARX symbol == broker symbol for most brokers; suffixes (EURUSD.r) resolved at the live boundary only.",
    fallbackChain: ["assistant_real"],
    providerLimitNote:
      "Assistant free tiers are forward-window limited with no older-than cursor; Polygon free tier serves D1 + /prev only. Deep targets beyond the tier are reported as provider limits, never truncated silently. MT5 broker history requires EA CopyRates streaming.",
  },
  metals: {
    assetClass: "metals",
    description: "Precious metals (XAUUSD, XAGUSD, …)",
    liveQuoteSource: "mt5_broker → assistant_real",
    historySourceChain: ["mt5_broker", "assistant_real"],
    historyDepthSupport: "forward_only",
    executionSource: "mt5_broker (per-user EA bridge)",
    brokerSymbolNote: "Broker metal symbol (XAUUSD / GOLD) resolved at the live boundary only.",
    fallbackChain: ["assistant_real"],
    providerLimitNote:
      "Same forward-only assistant limit as forex; deeper history requires MT5 broker CopyRates streaming.",
  },
  indices: {
    assetClass: "indices",
    description: "Equity indices (US30, NAS100, SPX500, GER40, …)",
    liveQuoteSource: "mt5_broker → assistant_real",
    historySourceChain: ["mt5_broker", "assistant_real"],
    historyDepthSupport: "forward_only",
    executionSource: "mt5_broker (per-user EA bridge)",
    brokerSymbolNote:
      "ARX index alias mapped to the broker CFD symbol (US30 → DJ30 etc.) at the live boundary only.",
    fallbackChain: ["assistant_real"],
    providerLimitNote:
      "Assistant free tiers are forward-window limited; deeper history requires MT5 broker CopyRates streaming.",
  },
  crypto: {
    assetClass: "crypto",
    description: "Crypto pairs (BTCUSDT, ETHUSDT, …)",
    liveQuoteSource: "mt5_broker → assistant_real",
    historySourceChain: ["mt5_broker", "assistant_real"],
    historyDepthSupport: "forward_only",
    executionSource: "mt5_broker (per-user EA bridge)",
    brokerSymbolNote: "ARX BASEQUOTE mapped to broker crypto symbol at the live boundary only.",
    fallbackChain: ["assistant_real"],
    providerLimitNote:
      "Assistant free tiers are forward-window limited; deeper history requires MT5 broker CopyRates streaming.",
  },
  stocks: {
    assetClass: "stocks",
    description: "Single-name equities (TSLA, AAPL, …)",
    liveQuoteSource: "mt5_broker → assistant_real",
    historySourceChain: ["mt5_broker", "assistant_real"],
    historyDepthSupport: "forward_only",
    executionSource: "mt5_broker (per-user EA bridge)",
    brokerSymbolNote: "Broker equity symbol resolved at the live boundary only.",
    fallbackChain: ["assistant_real"],
    providerLimitNote:
      "Assistant free tiers are forward-window limited; deeper history requires MT5 broker CopyRates streaming.",
  },
  unknown: {
    assetClass: "unknown",
    description: "Unclassified symbol — best-effort routing",
    liveQuoteSource: "mt5_broker → assistant_real",
    historySourceChain: ["mt5_broker", "assistant_real"],
    historyDepthSupport: "forward_only",
    executionSource: "mt5_broker (per-user EA bridge)",
    brokerSymbolNote: "No mapping rule — symbol passed through verbatim.",
    fallbackChain: ["assistant_real"],
    providerLimitNote:
      "Treated like the general (forward-only) chain; honest limit reporting applies.",
  },
};

/** Lookup the routing entry for an asset class. */
export function getProviderRoute(assetClass: AssetClass): ProviderRouteEntry {
  return PROVIDER_ROUTING_MAP[assetClass] ?? PROVIDER_ROUTING_MAP.unknown;
}

/** Whether the given history source can page OLDER history server-side. Only the
 *  Deriv synthetic feed supports a true older-than cursor today. */
export function sourceSupportsDeepCursor(source: string | null): boolean {
  if (!source) return false;
  return source === "deriv";
}
