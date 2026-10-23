// ── ASSET PATTERN PROFILES (Task #654) ──────────────────────────────────────
//
// PURE per-asset-class behaviour for pattern detection + reading. The SAME
// candlestick / chart structure behaves differently on EURUSD vs XAUUSD vs US30
// vs a Deriv synthetic — volatility, session sensitivity, spread sensitivity,
// news sensitivity, ATR-based sizing, minimum candle counts, order-flow
// availability, and (critically) which RELIABILITY BUCKET its outcomes belong
// to. Synthetic-index stats are ALWAYS kept separate from forex/gold/indices and
// are volatility-normalised; mixing them would fabricate confidence.
//
// DISPLAY / DECISION-SUPPORT only. The warnings here can only DOWNGRADE or
// caveat a read (e.g. "high-impact news window — treat patterns with caution").
// Nothing here grants entry, sizes a real order, or touches an execution gate.
// No IO, no clock — the caller passes already-decided session/news facts in.

import type { PatternAssetClass } from "./patternDetectionContract";

/** Coarse volatility tier used to scale ATR expectations + sizing caveats. */
export type AssetVolatilityTier = "low" | "medium" | "high" | "very_high";

/** Which reliability bucket an asset's pattern outcomes aggregate into. */
export type ReliabilityBucket = "forex_indices" | "synthetic" | "crypto";

export interface AssetPatternProfile {
  assetClass: PatternAssetClass;
  volatility: AssetVolatilityTier;
  /** Multiplier applied to ATR when describing stop/target ROOM (display only). */
  atrMultiplier: number;
  /** Minimum closed candles before a pattern read is trustworthy on this class. */
  minCandles: number;
  /** Patterns near scheduled high-impact news must be caveated. */
  newsSensitive: boolean;
  /** Reads depend on the active session (open/close, RTH vs overnight). */
  sessionSensitive: boolean;
  /** Wide spread degrades scalp/precise reads on this class. */
  spreadSensitive: boolean;
  /** Whether a usable order-flow proxy exists for this class. */
  orderFlowMode: "proxy" | "none";
  /** Reliability outcomes for this class aggregate into this bucket. */
  statsBucket: ReliabilityBucket;
  /** Always-on, asset-specific caveats (honest, downgrade-only). */
  baseWarnings: readonly string[];
}

const PROFILES: Record<PatternAssetClass, AssetPatternProfile> = {
  forex: {
    assetClass: "forex",
    volatility: "medium",
    atrMultiplier: 1.0,
    minCandles: 20,
    newsSensitive: true,
    sessionSensitive: true,
    spreadSensitive: true,
    orderFlowMode: "proxy",
    statsBucket: "forex_indices",
    baseWarnings: [],
  },
  gold: {
    assetClass: "gold",
    volatility: "high",
    atrMultiplier: 1.6,
    minCandles: 24,
    newsSensitive: true,
    sessionSensitive: true,
    spreadSensitive: true,
    orderFlowMode: "proxy",
    statsBucket: "forex_indices",
    baseWarnings: [
      "Gold whipsaws hard around USD news and the London/NY overlap — wider stops, more false breaks.",
    ],
  },
  indices: {
    assetClass: "indices",
    volatility: "high",
    atrMultiplier: 1.4,
    minCandles: 24,
    newsSensitive: true,
    sessionSensitive: true,
    spreadSensitive: true,
    orderFlowMode: "proxy",
    statsBucket: "forex_indices",
    baseWarnings: [
      "Index opening-range and cash-close hours move violently — patterns at the open/close fail more often.",
    ],
  },
  synthetic: {
    assetClass: "synthetic",
    volatility: "very_high",
    atrMultiplier: 1.8,
    minCandles: 30,
    newsSensitive: false,
    sessionSensitive: false,
    spreadSensitive: true,
    orderFlowMode: "none",
    statsBucket: "synthetic",
    baseWarnings: [
      "Synthetic indices are algorithmic and trade 24/7 — outcomes are tracked in a SEPARATE, volatility-normalised stats bucket and never mixed with forex/indices.",
    ],
  },
  metals: {
    assetClass: "metals",
    volatility: "high",
    atrMultiplier: 1.5,
    minCandles: 24,
    newsSensitive: true,
    sessionSensitive: true,
    spreadSensitive: true,
    orderFlowMode: "proxy",
    statsBucket: "forex_indices",
    baseWarnings: [
      "Industrial/precious metals gap on macro news and can be thin — expect wider spreads off-session.",
    ],
  },
  crypto: {
    assetClass: "crypto",
    volatility: "very_high",
    atrMultiplier: 1.8,
    minCandles: 30,
    newsSensitive: true,
    sessionSensitive: false,
    spreadSensitive: true,
    orderFlowMode: "none",
    statsBucket: "crypto",
    baseWarnings: [
      "Crypto trades 24/7 with deep weekend wicks and venue-specific liquidity — patterns fail more often into low-liquidity hours.",
    ],
  },
  generic: {
    assetClass: "generic",
    volatility: "medium",
    atrMultiplier: 1.2,
    minCandles: 24,
    newsSensitive: true,
    sessionSensitive: true,
    spreadSensitive: true,
    orderFlowMode: "none",
    statsBucket: "forex_indices",
    baseWarnings: [],
  },
};

/** Look up the immutable profile for an asset class. */
export function getAssetPatternProfile(
  assetClass: PatternAssetClass,
): AssetPatternProfile {
  return PROFILES[assetClass] ?? PROFILES.generic;
}

/**
 * Classify a raw symbol into an asset class. Pure string heuristics — never a
 * network/registry lookup. Conservative: an unrecognised symbol is "generic"
 * rather than guessed, so behaviour fails toward the safer (more caveated) side.
 */
export function classifyAssetClass(symbol: string): PatternAssetClass {
  const s = (symbol ?? "").toUpperCase().replace(/[\s_/-]/g, "");
  if (!s) return "generic";

  // Deriv synthetics first (they can contain digits that look like indices).
  if (
    /(VOLATILITY|VOL)\d*INDEX/.test(s) ||
    /^(R_|RB?\d|V\d{2,3})/.test(s) ||
    /(BOOM|CRASH)\d+/.test(s) ||
    /(STEP|JUMP|RANGEBREAK|DRIFTSWITCH)\d*/.test(s) ||
    /VOLATILITY\d+/.test(s)
  ) {
    return "synthetic";
  }
  if (/(XAU|GOLD)/.test(s)) return "gold";
  if (/(XAG|SILVER|XPT|XPD|PLATINUM|PALLADIUM|COPPER)/.test(s)) return "metals";
  if (
    /(US30|US100|US500|NAS100|SPX|NDX|DJI|GER40|DAX|UK100|FTSE|JP225|NIKKEI|HK50|AUS200|WALLST)/.test(
      s,
    )
  ) {
    return "indices";
  }
  if (/(BTC|ETH|XRP|LTC|SOL|ADA|DOGE|BNB|USDT|USDC)/.test(s)) return "crypto";
  // A clean 6-letter pair of known currency codes ⇒ forex.
  if (/^[A-Z]{6}$/.test(s)) return "forex";
  return "generic";
}

/** Already-decided situational facts the caller feeds in (no clock here). */
export interface AssetWarningInput {
  assetClass: PatternAssetClass;
  /** A scheduled high-impact news event is within the caution window. */
  nearHighImpactNews?: boolean;
  /** Outside the asset's regular trading hours / main session. */
  outsideRegularHours?: boolean;
  /** Inside the volatile opening-range window (indices especially). */
  atOpeningRange?: boolean;
  /** Spread is currently wider than normal for the class. */
  wideSpread?: boolean;
}

/**
 * Build the asset-specific, DOWNGRADE-ONLY warning list for a read. Always
 * includes the profile's base warnings, then adds situational caveats the caller
 * flagged. Returns plain trader sentences — never enum tokens, never a grant.
 */
export function assetPatternWarnings(input: AssetWarningInput): string[] {
  const profile = getAssetPatternProfile(input.assetClass);
  const out: string[] = [...profile.baseWarnings];

  if (input.nearHighImpactNews && profile.newsSensitive) {
    out.push(
      "High-impact news is near — treat any pattern as low-confidence until the dust settles.",
    );
  }
  if (input.outsideRegularHours && profile.sessionSensitive) {
    out.push(
      "Outside the main session — thinner liquidity makes structures less reliable.",
    );
  }
  if (input.atOpeningRange && profile.sessionSensitive) {
    out.push(
      "Inside the opening-range window — breakouts here whipsaw and trap often.",
    );
  }
  if (input.wideSpread && profile.spreadSensitive) {
    out.push("Spread is wider than normal — precise/scalp reads degrade.");
  }
  return out;
}
