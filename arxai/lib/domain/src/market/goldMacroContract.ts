// ── GOLD MACRO READ — PURE DRIVER VERDICT (Task #657) ───────────────────────
//
// PURE folding of the gold MACRO driver groups — U.S. dollar pressure, U.S.
// yields / Fed expectations, U.S. news risk, and safe-haven flow — into ONE
// honest `GoldMacroVerdict`. The caller passes ALREADY-DECIDED, already-connected
// facts in (e.g. from the economic-calendar/news seam); this contract never
// fetches anything and never invents a value.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
// Macro SUPPORTS or CAPS a thesis — it can NEVER create an entry by itself.
//   • Missing/disconnected driver ⇒ that field is `unknown`, and with NO driver
//     connected the overall `macroBias` is `unavailable` — never silently
//     `neutral` or `favorable`.
//   • A macro conflict CAPS confidence (downgrade-only).
//   • High-impact USD news near entry BLOCKS/downgrades scalps.
// No IO, no DB, no clock, no role input. Same inputs ⇒ same verdict. Carries NO
// execution-permission field and can never reach a live-execution path.

export type GoldDirectionalPressure =
  | "bullish_for_gold"
  | "bearish_for_gold"
  | "neutral"
  | "unknown";

export type GoldRiskTier = "high" | "medium" | "low" | "unknown";

export type GoldSafeHavenFlow = "supportive" | "negative" | "neutral" | "unknown";

export type GoldMacroBias = "bullish" | "bearish" | "neutral" | "mixed" | "unavailable";

/** Already-decided, already-connected macro facts. `null`/omitted ⇒ NOT connected. */
export interface GoldMacroInput {
  /** USD trend (DXY / dollar index / major-pair confirmation). */
  dollarTrend?: "strong" | "weak" | "neutral" | null;
  /** Nominal Treasury-yield trend. */
  yieldTrend?: "rising" | "falling" | "neutral" | null;
  /** Real-yield trend (stronger gold driver than nominal). */
  realYieldTrend?: "rising" | "falling" | "neutral" | null;
  /** Fed/rate expectation (FedWatch / FOMC stance). */
  fedExpectation?: "hawkish" | "dovish" | "neutral" | null;
  /** A scheduled high-impact USD event (FOMC/CPI/NFP/GDP…) is within the window. */
  highImpactUsdNewsImminent?: boolean | null;
  /** Whether the news/calendar provider is actually connected. */
  newsConnected?: boolean;
  /** Risk sentiment for safe-haven flow. */
  riskSentiment?: "risk_off" | "risk_on" | "neutral" | null;
  /** Elevated geopolitical/financial stress (supports gold). */
  stressElevated?: boolean | null;
}

export interface GoldMacroVerdict {
  dollarPressure: GoldDirectionalPressure;
  yieldPressure: GoldDirectionalPressure;
  fedRisk: GoldRiskTier;
  newsRisk: GoldRiskTier;
  safeHavenFlow: GoldSafeHavenFlow;
  macroBias: GoldMacroBias;
  /** 0–100, modest — macro is support/cap only, never a trigger. */
  confidence: number;
  /** Confidence CEILING the caller must apply (downgrade-only). 100 = no cap. */
  confidenceCap: number;
  /** True when high-impact USD news should block/downgrade a gold scalp. */
  blocksScalp: boolean;
  /** Which side macro leans, for support checks only — never an entry. */
  leansDirection: "buy" | "sell" | "none";
  warnings: string[];
}

function isConnected<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

function dollarPressure(trend: GoldMacroInput["dollarTrend"]): GoldDirectionalPressure {
  if (!isConnected(trend)) return "unknown";
  if (trend === "strong") return "bearish_for_gold"; // strong USD pressures USD-priced gold
  if (trend === "weak") return "bullish_for_gold";
  return "neutral";
}

function yieldPressure(input: GoldMacroInput): GoldDirectionalPressure {
  // Prefer real yields; fall back to nominal. Rising yields pressure gold.
  const r = input.realYieldTrend;
  const n = input.yieldTrend;
  const pick = isConnected(r) ? r : isConnected(n) ? n : null;
  if (!isConnected(pick)) return "unknown";
  if (pick === "rising") return "bearish_for_gold";
  if (pick === "falling") return "bullish_for_gold";
  return "neutral";
}

function fedRisk(input: GoldMacroInput): GoldRiskTier {
  const fed = input.fedExpectation;
  const news = input.highImpactUsdNewsImminent;
  if (!isConnected(fed) && !isConnected(news)) return "unknown";
  // A directional Fed stance with an imminent high-impact event is high risk.
  if (news === true) return "high";
  if (isConnected(fed) && fed !== "neutral") return "medium";
  return "low";
}

function newsRisk(input: GoldMacroInput): GoldRiskTier {
  if (input.newsConnected !== true && !isConnected(input.highImpactUsdNewsImminent)) {
    return "unknown";
  }
  if (input.highImpactUsdNewsImminent === true) return "high";
  return "low";
}

function safeHaven(input: GoldMacroInput): GoldSafeHavenFlow {
  const s = input.riskSentiment;
  const stress = input.stressElevated;
  if (!isConnected(s) && !isConnected(stress)) return "unknown";
  if (stress === true || s === "risk_off") return "supportive";
  if (s === "risk_on") return "negative";
  return "neutral";
}

function pressureVote(p: GoldDirectionalPressure | GoldSafeHavenFlow): number {
  // +1 bullish for gold, −1 bearish for gold, 0 neutral/unknown.
  if (p === "bullish_for_gold" || p === "supportive") return 1;
  if (p === "bearish_for_gold" || p === "negative") return -1;
  return 0;
}

function isKnownDirectional(p: GoldDirectionalPressure | GoldSafeHavenFlow): boolean {
  return p !== "unknown";
}

/**
 * Resolve the gold macro verdict. Pure. With no connected driver the bias is
 * `unavailable` (never `neutral`); a conflict among connected drivers yields
 * `mixed` and caps confidence; imminent high-impact USD news blocks scalps.
 */
export function resolveGoldMacro(input: GoldMacroInput): GoldMacroVerdict {
  const dp = dollarPressure(input.dollarTrend);
  const yp = yieldPressure(input);
  const fr = fedRisk(input);
  const nr = newsRisk(input);
  const sh = safeHaven(input);

  const directional = [dp, yp, sh];
  const known = directional.filter(isKnownDirectional);
  const warnings: string[] = [];

  let macroBias: GoldMacroBias;
  let leansDirection: "buy" | "sell" | "none" = "none";
  let confidence = 0;
  let confidenceCap = 100;

  if (known.length === 0) {
    // NOTHING connected — honest "unavailable", never neutral/favorable.
    macroBias = "unavailable";
    warnings.push("Gold macro data is unavailable — no dollar, yield, or safe-haven driver is connected.");
  } else {
    const votes = known.map(pressureVote);
    const sum = votes.reduce((a, b) => a + b, 0);
    const hasBull = votes.some((v) => v > 0);
    const hasBear = votes.some((v) => v < 0);
    if (hasBull && hasBear) {
      macroBias = "mixed";
      confidenceCap = 45; // conflict caps confidence (downgrade-only)
      warnings.push("Gold macro drivers conflict — confidence is capped until they align.");
    } else if (sum > 0) {
      macroBias = "bullish";
      leansDirection = "buy";
    } else if (sum < 0) {
      macroBias = "bearish";
      leansDirection = "sell";
    } else {
      macroBias = "neutral";
    }
    // Modest confidence: scales with agreeing connected drivers, capped low.
    const agreeing = votes.filter((v) => (sum >= 0 ? v > 0 : v < 0)).length;
    confidence = macroBias === "mixed" ? 25 : Math.min(60, 20 + agreeing * 15);
  }

  if (known.length > 0 && known.length < directional.length) {
    warnings.push("Some gold macro drivers are not connected — read this bias as partial.");
  }

  const blocksScalp = nr === "high" || fr === "high";
  if (blocksScalp) {
    warnings.push("High-impact USD news is near — block or downgrade gold scalps until spread/candle stabilise.");
  }

  return {
    dollarPressure: dp,
    yieldPressure: yp,
    fedRisk: fr,
    newsRisk: nr,
    safeHavenFlow: sh,
    macroBias,
    confidence: Math.max(0, Math.min(100, Math.round(confidence))),
    confidenceCap,
    blocksScalp,
    leansDirection,
    warnings,
  };
}

/**
 * How macro relates to a proposed technical direction — SUPPORT/CAP only, never
 * an entry. `unavailable` is honestly reported (not treated as neutral support).
 */
export function goldMacroSupport(
  verdict: GoldMacroVerdict,
  direction: "buy" | "sell",
): "supports" | "caps" | "neutral" | "unavailable" {
  if (verdict.macroBias === "unavailable") return "unavailable";
  if (verdict.macroBias === "mixed") return "caps";
  if (verdict.leansDirection === "none") return "neutral";
  return verdict.leansDirection === direction ? "supports" : "caps";
}
