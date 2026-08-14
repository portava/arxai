// ── GOLD TECHNICAL TACTICS + CANDLESTICK EMPHASIS — PURE (Task #657) ─────────
//
// PURE encoding of the gold tactics (liquidity sweep + reclaim, breakout +
// retest, trend pullback, wick rejection at level, news impulse, range-edge
// bounce, exhaustion fade) and the gold candlestick emphasis — including the
// gold-specific Shooting Star rule (prior bullish push + key level + confirmation,
// never mid-range, never wick-only). Each rule COMPOSES the shared #654 detectors
// and only RESHAPES the read for gold; it never re-derives geometry.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
// DISPLAY / DECISION-SUPPORT only. Every gold candle/tactic read is at most
// CONDITIONAL — gold is never shorted/bought from candle shape alone. No IO, no
// clock. Carries NO execution-permission field; can never produce READY_NOW or
// reach a live-execution gate.

import {
  resolveShootingStarTruth,
  type ShootingStarCandle,
} from "./shootingStarTruthContract";
import { detectHammer, type OHLC } from "./candlestickReversalContract";

export type GoldTactic =
  | "liquidity_sweep_reclaim"
  | "breakout_retest"
  | "trend_pullback"
  | "wick_rejection"
  | "news_impulse"
  | "range_edge_bounce"
  | "exhaustion_fade";

export type GoldTacticDecision =
  | "wait"
  | "conditional_buy"
  | "conditional_sell"
  | "no_trade"
  | "too_late";

export type GoldStrength = "weak" | "medium" | "strong";

export interface GoldCandleVerdict {
  tactic: GoldTactic;
  pattern: string;
  decision: GoldTacticDecision;
  /** Gold candle/tactic reads are conditional by design — never automatic. */
  conditional: boolean;
  strength: GoldStrength;
  confidence: number;
  atKeyLevel: boolean;
  confirmation: string;
  invalidation: string;
  reasons: string[];
  warnings: string[];
}

function strengthFromConfidence(c: number): GoldStrength {
  return c >= 65 ? "strong" : c >= 40 ? "medium" : "weak";
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export interface GoldShootingStarInput {
  candles: ShootingStarCandle[];
  feedConfirmed: boolean;
  feedStale: boolean;
  atr?: number | null;
  /** At resistance / prior high / R1–R3 / upper trendline / liquidity sweep. */
  atKeyResistance: boolean;
  /** Price is mid-range (no level nearby). */
  midRange: boolean;
}

/**
 * Gold Shooting Star rule. Composes the shared shooting-star geometry and then
 * applies gold emphasis: meaningful ONLY after a bullish push, AT a key level,
 * with confirmation — never mid-range, never from wick shape alone. Output is at
 * most a CONDITIONAL sell; gold is never shorted automatically off a shooting star.
 */
export function resolveGoldShootingStar(input: GoldShootingStarInput): GoldCandleVerdict {
  const base = resolveShootingStarTruth({
    candles: input.candles,
    feedConfirmed: input.feedConfirmed,
    feedStale: input.feedStale,
    atr: input.atr ?? null,
  });

  const reasons = [...base.reasons];
  const warnings = [...base.warnings];
  warnings.push("Gold wicks heavily — do not short from candle shape alone.");

  if (!base.detected) {
    return {
      tactic: "wick_rejection",
      pattern: "Shooting Star",
      decision: "no_trade",
      conditional: false,
      strength: "weak",
      confidence: 0,
      atKeyLevel: input.atKeyResistance,
      confirmation: "No shooting star with the required prior bullish push.",
      invalidation: "—",
      reasons,
      warnings,
    };
  }

  // Mid-range or no key level ⇒ weak; gold does not short a mid-range wick.
  if (input.midRange || !input.atKeyResistance) {
    reasons.push("Shooting star is not at a key resistance/level — gold reads this as weak.");
    return {
      tactic: "wick_rejection",
      pattern: "Shooting Star",
      decision: "wait",
      conditional: false,
      strength: "weak",
      confidence: clamp(Math.min(base.confidence, 30)),
      atKeyLevel: false,
      confirmation: "Needs a shooting star AT resistance/prior high with confirmation — not mid-range.",
      invalidation: base.invalidationLevel != null ? `Above ${base.invalidationLevel}.` : "Above the wick high.",
      reasons,
      warnings,
    };
  }

  // At a key level: a CONDITIONAL sell only, even when confirmed.
  reasons.push("Shooting star at a key gold resistance/level — conditional short, pending confirmation.");
  const confidence = clamp(Math.min(base.confidence, base.status === "confirmed" ? 70 : 55));
  return {
    tactic: "wick_rejection",
    pattern: "Shooting Star",
    decision: "conditional_sell",
    conditional: true,
    strength: strengthFromConfidence(confidence),
    confidence,
    atKeyLevel: true,
    confirmation:
      base.confirmationLevel != null
        ? `Sell thesis strengthens only on a close below ${base.confirmationLevel} or a failed retest.`
        : "Sell only below the shooting-star low or after a failed retest.",
    invalidation:
      base.invalidationLevel != null
        ? `Cancel if gold closes above ${base.invalidationLevel} (the wick high).`
        : "Cancel if gold closes above the wick high.",
    reasons,
    warnings,
  };
}

export interface GoldHammerInput {
  candles: OHLC[];
  feedConfirmed: boolean;
  feedStale: boolean;
  /** At support / prior low / S1–S3 / lower trendline / liquidity sweep. */
  atKeySupport: boolean;
  midRange: boolean;
}

/**
 * Gold Hammer rule — bullish mirror of the shooting-star rule. Composes the
 * shared hammer detector; meaningful ONLY at a key support with confirmation.
 * Output is at most a CONDITIONAL buy; never an automatic long off a wick.
 */
export function resolveGoldHammer(input: GoldHammerInput): GoldCandleVerdict {
  const base = detectHammer({
    candles: input.candles,
    feedConfirmed: input.feedConfirmed,
    feedStale: input.feedStale,
  });

  const reasons = [...base.reasons];
  const warnings = ["Gold wicks heavily — do not buy from candle shape alone."];

  if (!base.detected) {
    return {
      tactic: "wick_rejection",
      pattern: "Hammer",
      decision: "no_trade",
      conditional: false,
      strength: "weak",
      confidence: 0,
      atKeyLevel: input.atKeySupport,
      confirmation: "No hammer with the required prior decline.",
      invalidation: "—",
      reasons,
      warnings,
    };
  }

  if (input.midRange || !input.atKeySupport) {
    reasons.push("Hammer is not at a key support/level — gold reads this as weak.");
    return {
      tactic: "wick_rejection",
      pattern: "Hammer",
      decision: "wait",
      conditional: false,
      strength: "weak",
      confidence: clamp(Math.min(base.confidence, 30)),
      atKeyLevel: false,
      confirmation: "Needs a hammer AT support/prior low with confirmation — not mid-range.",
      invalidation: base.invalidationLevel != null ? `Below ${base.invalidationLevel}.` : "Below the wick low.",
      reasons,
      warnings,
    };
  }

  reasons.push("Hammer at a key gold support/level — conditional long, pending confirmation.");
  const confidence = clamp(Math.min(base.confidence, base.status === "confirmed" ? 70 : 55));
  return {
    tactic: "wick_rejection",
    pattern: "Hammer",
    decision: "conditional_buy",
    conditional: true,
    strength: strengthFromConfidence(confidence),
    confidence,
    atKeyLevel: true,
    confirmation:
      base.confirmationLevel != null
        ? `Buy thesis strengthens only on a close above ${base.confirmationLevel} or a successful retest.`
        : "Buy only above the hammer high or after a successful retest.",
    invalidation:
      base.invalidationLevel != null
        ? `Cancel if gold closes below ${base.invalidationLevel} (the wick low).`
        : "Cancel if gold closes below the wick low.",
    reasons,
    warnings,
  };
}

export interface GoldLiquiditySweepInput {
  /** The prior level swept (prior high/low, support/resistance, Asian level). */
  level: number;
  /** Sweep above a high, or below a low. */
  side: "high" | "low";
  /** Recent closed candles, oldest first. */
  recentCandles: OHLC[];
  feedConfirmed: boolean;
  feedStale: boolean;
  /** Room toward midpoint/pivot/prior high/liquidity exists. */
  targetRoom: boolean;
}

/**
 * Gold Liquidity Sweep + Reclaim. Detects a pierce of the level that CLOSES back
 * on the right side (reclaim), forming a CONDITIONAL reversal setup — bullish on
 * a swept low, bearish on a swept high. Never automatic; blocked when there is no
 * target room.
 */
export function resolveGoldLiquiditySweep(input: GoldLiquiditySweepInput): GoldCandleVerdict {
  const contextOnly = !input.feedConfirmed || input.feedStale;
  const warnings: string[] = [];
  if (contextOnly) warnings.push("Feed is not live-confirmed — read this sweep as context only.");

  let swept = false;
  let reclaimCandle: OHLC | null = null;
  for (let i = input.recentCandles.length - 1; i >= 0; i--) {
    const c = input.recentCandles[i]!;
    if (input.side === "high" && c.high > input.level && c.close < input.level) {
      swept = true;
      reclaimCandle = c;
      break;
    }
    if (input.side === "low" && c.low < input.level && c.close > input.level) {
      swept = true;
      reclaimCandle = c;
      break;
    }
  }

  if (!swept || !reclaimCandle) {
    return {
      tactic: "liquidity_sweep_reclaim",
      pattern: "Liquidity Sweep + Reclaim",
      decision: "no_trade",
      conditional: false,
      strength: "weak",
      confidence: 0,
      atKeyLevel: true,
      confirmation: `Needs a sweep ${input.side === "high" ? "above" : "below"} ${input.level} that closes back inside.`,
      invalidation: "—",
      reasons: ["No sweep-and-reclaim of the level in the recent candles."],
      warnings,
    };
  }

  if (!input.targetRoom) {
    warnings.push("No room to a sensible target — setup is blocked despite the sweep.");
    return {
      tactic: "liquidity_sweep_reclaim",
      pattern: "Liquidity Sweep + Reclaim",
      decision: "no_trade",
      conditional: false,
      strength: "weak",
      confidence: clamp(contextOnly ? 20 : 30),
      atKeyLevel: true,
      confirmation: "Wait for a setup with room to the midpoint/pivot/prior level.",
      invalidation: `Beyond the sweep extreme of ${reclaimCandle[input.side]}.`,
      reasons: ["Sweep-and-reclaim printed, but there is no target room."],
      warnings,
    };
  }

  const direction = input.side === "low" ? "conditional_buy" : "conditional_sell";
  const confidence = clamp(contextOnly ? 35 : 55);
  return {
    tactic: "liquidity_sweep_reclaim",
    pattern: "Liquidity Sweep + Reclaim",
    decision: direction,
    conditional: true,
    strength: strengthFromConfidence(confidence),
    confidence,
    atKeyLevel: true,
    confirmation: "Confirm with a close/retest holding back inside the level.",
    invalidation: `Cancel beyond the sweep extreme of ${reclaimCandle[input.side]}.`,
    reasons: [
      input.side === "low"
        ? "Price swept the level low then reclaimed — bullish liquidity grab."
        : "Price swept the level high then reclaimed — bearish liquidity grab.",
    ],
    warnings,
  };
}

export interface GoldBreakoutRetestInput {
  /** Close beyond the level happened. */
  closedBeyond: boolean;
  /** A retest held / rejected (confirmation). */
  retestHeld: boolean;
  /** Momentum supports continuation. */
  momentumSupports: boolean;
  spreadAcceptable: boolean;
  /** Break ran straight into an immediate opposing level. */
  intoOpposingLevel: boolean;
  direction: "buy" | "sell";
  feedConfirmed: boolean;
  feedStale: boolean;
}

/**
 * Gold Breakout + Retest. Gold breakouts fake out, so a bare break without a
 * retest stays LOWER confidence; a held retest RAISES confidence (still
 * conditional). Wide spread blocks; a break into an opposing level downgrades.
 */
export function resolveGoldBreakoutRetest(input: GoldBreakoutRetestInput): GoldCandleVerdict {
  const contextOnly = !input.feedConfirmed || input.feedStale;
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (contextOnly) warnings.push("Feed is not live-confirmed — read this breakout as context only.");

  if (!input.closedBeyond) {
    return {
      tactic: "breakout_retest",
      pattern: "Breakout + Retest",
      decision: "wait",
      conditional: false,
      strength: "weak",
      confidence: clamp(contextOnly ? 15 : 25),
      atKeyLevel: true,
      confirmation: "Wait for a candle to CLOSE beyond the level.",
      invalidation: "Back inside the level.",
      reasons: ["No close beyond the level yet."],
      warnings,
    };
  }

  if (!input.spreadAcceptable) {
    warnings.push("Spread is unacceptable for a gold breakout entry — blocked.");
    return {
      tactic: "breakout_retest",
      pattern: "Breakout + Retest",
      decision: "no_trade",
      conditional: false,
      strength: "weak",
      confidence: clamp(20),
      atKeyLevel: true,
      confirmation: "Wait for spread to normalise.",
      invalidation: "Back inside the level.",
      reasons: ["Close beyond the level, but spread is too wide."],
      warnings,
    };
  }

  // Base: bare breakout (no retest) is LOWER confidence on gold.
  let confidence = 40;
  reasons.push("Close beyond the level — but gold breakouts fake out, so this alone is low confidence.");

  if (input.retestHeld) {
    confidence = 65;
    reasons.push("Retest held/rejected — confirmation raises confidence.");
  }
  if (input.momentumSupports) confidence += 5;
  if (input.intoOpposingLevel) {
    confidence -= 15;
    warnings.push("Break ran into an immediate opposing level — limited room.");
  }
  if (contextOnly) confidence = Math.min(confidence, 35);
  confidence = clamp(confidence);

  return {
    tactic: "breakout_retest",
    pattern: "Breakout + Retest",
    decision: input.direction === "buy" ? "conditional_buy" : "conditional_sell",
    conditional: true,
    strength: strengthFromConfidence(confidence),
    confidence,
    atKeyLevel: true,
    confirmation: input.retestHeld
      ? "Retest held — manage from the retest level."
      : "Wait for the retest to hold before committing.",
    invalidation: "A close back inside the level invalidates the breakout.",
    reasons,
    warnings,
  };
}
