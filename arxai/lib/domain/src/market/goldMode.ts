// ── GOLD STRATEGY MODE — ASSET PROFILE + ACTIVATION (Task #657) ──────────────
//
// PURE specialization of the shared #654 `AssetPatternProfile` for GOLD. Gold is
// its own asset class: high volatility, heavy wicks, strong news/dollar/yield/
// safe-haven sensitivity, deep-but-fast liquidity, and tight stops that invalidate
// quickly. This module defines the `GoldAssetProfile` and the symbol→Gold-Mode
// activation check so ONLY gold symbols activate the gold strategy layer.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
// DISPLAY / DECISION-SUPPORT only. No IO, no DB, no HTTP, no clock, no role input.
// The profile is a set of honest behavioural defaults + caveats. Nothing here
// grants entry, sizes a real order, raises readiness, or touches an execution
// gate. Activation merely selects WHICH analysis layer reads the symbol — it can
// never authorize a trade.

import {
  classifyAssetClass,
  getAssetPatternProfile,
  type AssetPatternProfile,
} from "./assetPatternProfile";

/** Sensitivity tiers for the gold driver groups (display-only). */
export type GoldSensitivity = "low" | "medium" | "medium_high" | "high";

/** Order-flow mode honest to the available feed. */
export type GoldOrderFlowMode = "true_order_flow" | "proxy_order_flow";

/** Trade styles with their own minimum candle expectations. */
export type GoldTradeStyle = "scalp" | "intraday" | "swing";

export interface GoldAssetProfile {
  assetClass: "gold";
  /** Canonical gold symbols this layer recognises. */
  symbols: readonly string[];
  quoteCurrency: "USD";
  volatilityProfile: "high";
  wickProfile: "high";
  newsSensitivity: GoldSensitivity;
  dollarSensitivity: GoldSensitivity;
  yieldSensitivity: GoldSensitivity;
  safeHavenSensitivity: GoldSensitivity;
  centralBankSensitivity: GoldSensitivity;
  liquidityProfile: string;
  /** true_order_flow only when a futures/depth provider is actually available. */
  defaultOrderFlowMode: GoldOrderFlowMode;
  /** Minimum closed candles by style — gold needs more context than majors. */
  minimumCandleCount: Record<GoldTradeStyle, number>;
  /** ATR multiplier for describing stop/target ROOM (wider than forex). */
  atrMultiplier: number;
  /** Extra ATR buffer beyond structure for gold stops (display-only). */
  atrStopBufferMultiple: number;
  defaultRiskWarning: string;
  /** The shared #654 base profile this specializes (kept for reuse). */
  base: AssetPatternProfile;
}

/** Recognised gold spot/CFD symbols (normalised, punctuation-stripped). */
export const GOLD_SPOT_SYMBOLS = ["XAUUSD", "GOLD", "XAUEUR", "XAUGBP", "XAUAUD"] as const;

/** Futures-month code suffix, e.g. GCZ24 / MGCG5 (optional). */
const FUTURES_MONTH = "[FGHJKMNQUVXZ]";
/** GC = COMEX gold future, MGC = micro gold future. */
const GOLD_FUTURES_RE = new RegExp(`^M?GC(=F|${FUTURES_MONTH}\\d{0,2})?$`);

function normalizeSymbol(symbol: string): string {
  return (symbol ?? "").toUpperCase().replace(/[\s_/-]/g, "");
}

/**
 * True when a symbol is gold — XAUUSD/GOLD/metal-vs-fiat gold pairs OR a GC/MGC
 * gold future. Conservative: a symbol the base classifier already calls "gold"
 * activates, plus explicit COMEX gold futures the base classifier does not cover.
 * Never matches silver/platinum/palladium or a non-gold pair.
 */
export function isGoldSymbol(symbol: string): boolean {
  const s = normalizeSymbol(symbol);
  if (!s) return false;
  if (classifyAssetClass(s) === "gold") return true;
  if (GOLD_FUTURES_RE.test(s)) return true;
  return false;
}

/**
 * Gold Mode activation check. Identical to {@link isGoldSymbol} today — a named
 * alias so call-sites read intent ("is Gold Mode active for this symbol?") and so
 * any future activation nuance (e.g. an admin disable) lives in ONE place.
 */
export function isGoldMode(symbol: string): boolean {
  return isGoldSymbol(symbol);
}

/**
 * Build the immutable Gold asset profile. `futuresDepthAvailable` is the ONLY
 * input that can raise order-flow to `true_order_flow`; with a CFD/spot feed it
 * stays the honest `proxy_order_flow`. Pure — same inputs ⇒ same profile.
 */
export function getGoldAssetProfile(
  opts: { futuresDepthAvailable?: boolean } = {},
): GoldAssetProfile {
  const base = getAssetPatternProfile("gold");
  return {
    assetClass: "gold",
    symbols: [...GOLD_SPOT_SYMBOLS, "GC", "MGC"],
    quoteCurrency: "USD",
    volatilityProfile: "high",
    wickProfile: "high",
    newsSensitivity: "high",
    dollarSensitivity: "high",
    yieldSensitivity: "high",
    safeHavenSensitivity: "high",
    centralBankSensitivity: "medium_high",
    liquidityProfile: "deep but fast-moving",
    defaultOrderFlowMode: opts.futuresDepthAvailable === true ? "true_order_flow" : "proxy_order_flow",
    minimumCandleCount: { scalp: 300, intraday: 500, swing: 1000 },
    atrMultiplier: base.atrMultiplier,
    atrStopBufferMultiple: 0.5,
    defaultRiskWarning:
      "Gold can move fast, wick hard, and invalidate tight stops quickly — use ATR-aware, structure-based stops.",
    base,
  };
}

/**
 * Minimum candles required for a given gold trade style. Display/decision-support
 * only — this is the IDEAL context depth, separate from (and never a replacement
 * for) the shared candle-sufficiency gate, which still applies independently.
 */
export function goldMinimumCandles(style: GoldTradeStyle): number {
  return getGoldAssetProfile().minimumCandleCount[style];
}
