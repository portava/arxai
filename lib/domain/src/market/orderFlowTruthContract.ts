// ── ORDER FLOW TRUTH — DISPLAY / DECISION-SUPPORT CONTRACT (Task #652, Phase 2) ─
//
// SHARED, PURE definition of "does buying/selling pressure SUPPORT or REJECT the
// setup, and how reliable is that read given the data we actually have?". Where
// true Level-2 / depth / tape is unavailable, this contract uses proxy metrics
// and labels them HONESTLY — it NEVER presents proxy order flow as institutional
// order flow, and NEVER fabricates pressure when no usable data exists.
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same verdict.
//
// ── SAFETY: ORDER FLOW TRUTH IS A *CHILD INPUT*, DISPLAY-ONLY ────────────────
// Order flow may only RAISE-WITHIN-CAP or LOWER what the user SEES. A
// contradiction CAPS Scanner/Scalp confidence; it never grants permission. The
// verdict carries NO execution-permission field and never influences
// live-execution permission, broker dispatch, the kill switch, owner/admin
// overrides, or the trade button. `dataTier` is the honesty spine: `unavailable`
// can never read as pressure, and `proxy_order_flow` is always labelled as proxy.

export type OrderFlowDataTier = "true_order_flow" | "proxy_order_flow" | "unavailable";

export type OrderFlowPressure = "buying" | "selling" | "balanced" | "mixed" | "unknown";

export type OrderFlowStrength = "weak" | "moderate" | "strong";

export type SpreadCondition = "normal" | "wide" | "unstable" | "unknown";

export type VolumeCondition = "low" | "normal" | "high" | "spike" | "unknown";

export type OrderFlowSupports = "yes" | "no" | "mixed" | "unknown";

export type OrderFlowQuality = "high" | "medium" | "low" | "none";

export type OrderFlowScannerLabelHint =
  | "none"
  | "context_only"
  | "unavailable" // no usable data — order flow unavailable
  | "proxy_supportive" // proxy pressure agrees (still proxy, still capped)
  | "proxy_contradiction" // proxy pressure disagrees → cap
  | "true_supportive" // true depth agrees
  | "true_contradiction" // true depth disagrees → cap
  | "absorption_caution" // absorption at a level → caution
  | "wide_spread" // wide/unstable spread → downgrade
  | "supportive"; // true order flow agrees + live feed → small nudge

export interface OrderFlowDisplayContext {
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
  chartReadConfidenceLow: boolean;
}

/** True Level-2 / tape inputs (Tier 1). All optional — null when unavailable. */
export interface TrueOrderFlowData {
  bidAskImbalance: number | null; // >0 bid-heavy, <0 ask-heavy
  delta: number | null;
  cumulativeDelta: number | null;
  aggressiveBuyRatio: number | null; // 0..1
  absorptionDetected: boolean;
  icebergDetected: boolean;
}

/** Proxy inputs derived from candles (Tier 2). All optional. */
export interface ProxyOrderFlowData {
  /** Net candle-body pressure: >0 bullish bodies dominate, <0 bearish. */
  bodyPressure: number | null;
  /** Tick volume z-score / spike indicator. */
  volumeSpike: boolean;
  /** Momentum impulse direction: >0 up, <0 down. */
  momentumImpulse: number | null;
  /** A rejection candle printed (wick + reversal). */
  rejectionCandle: boolean;
  /** Liquidity sweep then reclaim/rejection observed. */
  liquiditySweep: { detected: boolean; side: "buy_side" | "sell_side" | null; reclaimed: boolean };
}

export interface OrderFlowTruthInput {
  /** Setup direction the order flow is being tested against. */
  setupDirection: "buy" | "sell" | "none";
  trueData: TrueOrderFlowData | null;
  proxyData: ProxyOrderFlowData | null;
  spreadCondition: SpreadCondition;
  volumeCondition: VolumeCondition;
  /** True when price is at a pivot/S/R where absorption matters. */
  atKeyLevel: boolean;
}

export interface OrderFlowScannerImpact {
  labelHint: OrderFlowScannerLabelHint;
  confidenceCeiling: number;
  qualityCeiling: OrderFlowQuality;
  conditional: boolean;
  contextOnly: boolean;
  edgeAdjustment: number;
  supportive: boolean;
}

export interface OrderFlowTruthVerdict {
  dataTier: OrderFlowDataTier;
  pressure: OrderFlowPressure;
  strength: OrderFlowStrength;
  absorptionDetected: boolean;
  imbalanceDetected: boolean;
  spreadCondition: SpreadCondition;
  volumeCondition: VolumeCondition;
  liquiditySweep: { detected: boolean; side: "buy_side" | "sell_side" | null; reclaimed: boolean };
  supportsDirection: OrderFlowSupports;
  confidence: number;
  quality: OrderFlowQuality;
  /** Always honest: true when proxy data is used so the UI can label it proxy. */
  isProxy: boolean;
  confidenceCapReason: string | null;
  scannerTruthImpact: OrderFlowScannerImpact;
  rubyExplanation: string;
  warnings: string[];
}

const QUALITY_RANK: Record<OrderFlowQuality, number> = { none: 0, low: 1, medium: 2, high: 3 };

function minQuality(a: OrderFlowQuality, b: OrderFlowQuality): OrderFlowQuality {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const CONTEXT_ONLY_CONF_CAP = 35;
const UNAVAILABLE_CONF_CAP = 0;
const PROXY_CONF_CAP = 55; // proxy order flow can never read as high-confidence true flow
const CONTRADICTION_CONF_CAP = 30;

function num(n: number | null): number | null {
  return n != null && Number.isFinite(n) ? n : null;
}

/** True when the Tier-1 object carries at least one usable signal. */
function hasTrueData(d: TrueOrderFlowData | null): boolean {
  if (!d) return false;
  return (
    num(d.bidAskImbalance) != null ||
    num(d.delta) != null ||
    num(d.cumulativeDelta) != null ||
    num(d.aggressiveBuyRatio) != null ||
    d.absorptionDetected ||
    d.icebergDetected
  );
}

/** True when the Tier-2 object carries at least one usable proxy signal. */
function hasProxyData(d: ProxyOrderFlowData | null): boolean {
  if (!d) return false;
  return (
    num(d.bodyPressure) != null ||
    d.volumeSpike ||
    num(d.momentumImpulse) != null ||
    d.rejectionCandle ||
    d.liquiditySweep.detected
  );
}

function pressureToBias(p: OrderFlowPressure): "buy" | "sell" | "none" {
  if (p === "buying") return "buy";
  if (p === "selling") return "sell";
  return "none";
}

/**
 * Build the ONE shared order-flow verdict. Tier selection is honest: true data if
 * usable, else proxy if usable, else `unavailable` (never fabricated).
 * `scannerTruthImpact` is downgrade-only; a contradiction caps confidence, and a
 * small supportive nudge is gated on TRUE order flow agreeing on a live feed.
 */
export function resolveOrderFlowTruth(
  input: OrderFlowTruthInput,
  display: OrderFlowDisplayContext,
): OrderFlowTruthVerdict {
  const warnings: string[] = [];
  const contextOnly =
    !display.feedConfirmed || display.feedStale || !display.sufficiencyAllowsSetup;

  // ── Tier selection (honest fallback) ───────────────────────────────────────
  const trueOk = hasTrueData(input.trueData);
  const proxyOk = hasProxyData(input.proxyData);
  const dataTier: OrderFlowDataTier = trueOk
    ? "true_order_flow"
    : proxyOk
      ? "proxy_order_flow"
      : "unavailable";
  const isProxy = dataTier === "proxy_order_flow";

  // ── Unavailable → never read as pressure; honest empty ─────────────────────
  if (dataTier === "unavailable") {
    warnings.push("Order flow unavailable — no usable depth or proxy data. Not fabricated.");
    return {
      dataTier,
      pressure: "unknown",
      strength: "weak",
      absorptionDetected: false,
      imbalanceDetected: false,
      spreadCondition: input.spreadCondition,
      volumeCondition: input.volumeCondition,
      liquiditySweep: { detected: false, side: null, reclaimed: false },
      supportsDirection: "unknown",
      confidence: 0,
      quality: "none",
      isProxy: false,
      confidenceCapReason: "Order flow unavailable.",
      scannerTruthImpact: {
        labelHint: "unavailable",
        confidenceCeiling: UNAVAILABLE_CONF_CAP,
        qualityCeiling: "none",
        conditional: true,
        contextOnly,
        edgeAdjustment: 0,
        supportive: false,
      },
      rubyExplanation: "Order flow is unavailable for this symbol — no depth or reliable proxy data.",
      warnings: dedupe(warnings),
    };
  }

  // ── Pressure + strength ────────────────────────────────────────────────────
  let pressure: OrderFlowPressure = "unknown";
  let strengthScore = 0;
  let absorptionDetected = false;
  let imbalanceDetected = false;
  let liquiditySweep = { detected: false, side: null as "buy_side" | "sell_side" | null, reclaimed: false };

  if (trueOk && input.trueData) {
    const d = input.trueData;
    const signals: number[] = [];
    if (num(d.bidAskImbalance) != null) signals.push(Math.sign(d.bidAskImbalance!));
    if (num(d.delta) != null) signals.push(Math.sign(d.delta!));
    if (num(d.cumulativeDelta) != null) signals.push(Math.sign(d.cumulativeDelta!));
    if (num(d.aggressiveBuyRatio) != null) signals.push(d.aggressiveBuyRatio! >= 0.5 ? 1 : -1);
    const net = signals.reduce((a, b) => a + b, 0);
    pressure = net > 0 ? "buying" : net < 0 ? "selling" : signals.length > 0 ? "balanced" : "unknown";
    if (signals.length > 0 && Math.abs(net) < signals.length) pressure = pressure === "balanced" ? "balanced" : "mixed";
    strengthScore = Math.abs(net);
    absorptionDetected = d.absorptionDetected;
    imbalanceDetected = num(d.bidAskImbalance) != null && Math.abs(d.bidAskImbalance!) > 0;
  } else if (proxyOk && input.proxyData) {
    const d = input.proxyData;
    const signals: number[] = [];
    if (num(d.bodyPressure) != null) signals.push(Math.sign(d.bodyPressure!));
    if (num(d.momentumImpulse) != null) signals.push(Math.sign(d.momentumImpulse!));
    if (d.rejectionCandle && d.liquiditySweep.side) {
      signals.push(d.liquiditySweep.side === "sell_side" ? 1 : -1); // swept sell-side liquidity → bullish reclaim
    }
    const net = signals.reduce((a, b) => a + b, 0);
    pressure = net > 0 ? "buying" : net < 0 ? "selling" : signals.length > 0 ? "balanced" : "unknown";
    if (signals.length > 1 && Math.abs(net) < signals.length) pressure = "mixed";
    strengthScore = Math.abs(net) + (d.volumeSpike ? 1 : 0);
    liquiditySweep = d.liquiditySweep;
    imbalanceDetected = d.volumeSpike;
  }

  const strength: OrderFlowStrength =
    strengthScore >= 3 ? "strong" : strengthScore >= 2 ? "moderate" : "weak";

  // ── supportsDirection vs the setup ─────────────────────────────────────────
  const ofBias = pressureToBias(pressure);
  let supportsDirection: OrderFlowSupports;
  if (input.setupDirection === "none" || pressure === "unknown") supportsDirection = "unknown";
  else if (pressure === "mixed" || pressure === "balanced") supportsDirection = "mixed";
  else if (ofBias === input.setupDirection) supportsDirection = "yes";
  else supportsDirection = "no";

  // ── Display caps + label, downgrade-only ───────────────────────────────────
  let confidenceCeiling = trueOk ? 100 : PROXY_CONF_CAP;
  let qualityCeiling: OrderFlowQuality = trueOk ? "high" : "medium";
  let conditional = !trueOk;
  let edgeAdjustment = 0;
  let supportive = false;
  let labelHint: OrderFlowScannerLabelHint = isProxy ? "none" : "none";
  let confidenceCapReason: string | null = isProxy
    ? "Proxy order flow — not institutional depth/tape; capped."
    : null;
  let confidence = 40 + strengthScore * 10;

  if (isProxy) warnings.push("Order flow is PROXY (derived from candles/tick), not true depth/tape.");

  if (supportsDirection === "no") {
    labelHint = trueOk ? "true_contradiction" : "proxy_contradiction";
    confidenceCeiling = Math.min(confidenceCeiling, CONTRADICTION_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    edgeAdjustment = -20;
    confidenceCapReason = "Order flow contradicts the setup direction — confidence capped.";
    warnings.push(confidenceCapReason);
  } else if (supportsDirection === "yes") {
    labelHint = trueOk ? "true_supportive" : "proxy_supportive";
    // Supportive nudge ONLY on true order flow, agreeing, strong, live feed.
    const canSupport = trueOk && strength === "strong" && !contextOnly && !display.chartReadConfidenceLow;
    if (canSupport) {
      labelHint = "supportive";
      supportive = true;
      edgeAdjustment = 8;
    } else {
      conditional = true;
      qualityCeiling = minQuality(qualityCeiling, "medium");
    }
  } else {
    labelHint = isProxy ? "none" : "none";
    conditional = true;
    qualityCeiling = minQuality(qualityCeiling, "medium");
  }

  // Absorption at a level → caution (cap, never block alone).
  if (absorptionDetected && input.atKeyLevel) {
    if (labelHint !== "true_contradiction" && labelHint !== "proxy_contradiction") labelHint = "absorption_caution";
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, -5);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    confidenceCapReason ??= "Absorption detected at a key level — proceed with caution.";
    warnings.push("Absorption at a key level — pressure may be getting soaked up.");
  }

  // Wide/unstable spread downgrades.
  if (input.spreadCondition === "wide" || input.spreadCondition === "unstable") {
    if (labelHint === "supportive" || labelHint === "true_supportive" || labelHint === "proxy_supportive")
      labelHint = "wide_spread";
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, -5);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    confidenceCapReason ??= "Spread is wide/unstable — entry quality downgraded.";
    warnings.push("Spread is wide/unstable.");
  }

  // Feed not live-confirmed → context only. Highest-precedence cap.
  if (contextOnly) {
    labelHint = "context_only";
    confidenceCeiling = Math.min(confidenceCeiling, CONTEXT_ONLY_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    confidenceCapReason = display.feedStale
      ? "Feed is delayed — order flow shown as context only."
      : !display.sufficiencyAllowsSetup
        ? "Not enough live data — order flow shown as context only."
        : "Feed not live-confirmed — order flow shown as context only.";
    warnings.push(confidenceCapReason);
  }

  const cappedConfidence = Math.min(clampConfidence(confidence), confidenceCeiling);
  const baseQuality: OrderFlowQuality =
    cappedConfidence >= 70 ? "high" : cappedConfidence >= 50 ? "medium" : cappedConfidence > 0 ? "low" : "none";
  const quality = minQuality(baseQuality, qualityCeiling);

  return {
    dataTier,
    pressure,
    strength,
    absorptionDetected,
    imbalanceDetected,
    spreadCondition: input.spreadCondition,
    volumeCondition: input.volumeCondition,
    liquiditySweep,
    supportsDirection,
    confidence: cappedConfidence,
    quality,
    isProxy,
    confidenceCapReason,
    scannerTruthImpact: {
      labelHint,
      confidenceCeiling,
      qualityCeiling,
      conditional,
      contextOnly,
      edgeAdjustment,
      supportive,
    },
    rubyExplanation: buildOrderFlowExplanation({
      dataTier,
      pressure,
      strength,
      supportsDirection,
      absorptionDetected,
      atKeyLevel: input.atKeyLevel,
      spreadCondition: input.spreadCondition,
      contextOnly,
    }),
    warnings: dedupe(warnings),
  };
}

function buildOrderFlowExplanation(args: {
  dataTier: OrderFlowDataTier;
  pressure: OrderFlowPressure;
  strength: OrderFlowStrength;
  supportsDirection: OrderFlowSupports;
  absorptionDetected: boolean;
  atKeyLevel: boolean;
  spreadCondition: SpreadCondition;
  contextOnly: boolean;
}): string {
  const { dataTier, pressure, strength, supportsDirection, absorptionDetected, atKeyLevel, spreadCondition, contextOnly } =
    args;
  const tierLabel =
    dataTier === "true_order_flow" ? "True order flow" : "Proxy order flow";
  const parts: string[] = [`${tierLabel}: ${strength} ${pressure} pressure.`];
  if (supportsDirection === "yes") parts.push("It supports the setup direction.");
  else if (supportsDirection === "no") parts.push("It contradicts the setup direction, which caps confidence.");
  else parts.push("It is mixed/unclear on the setup direction.");
  if (absorptionDetected && atKeyLevel) parts.push("Absorption at a key level suggests caution.");
  if (spreadCondition === "wide" || spreadCondition === "unstable") parts.push("Spread is wide/unstable.");
  if (dataTier === "proxy_order_flow") parts.push("This is proxy data, not institutional depth/tape.");
  if (contextOnly) parts.push("Feed is not live-confirmed, so treat it as context only.");
  return parts.join(" ");
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim().length > 0))];
}
