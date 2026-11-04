// ── SHOOTING STAR TRUTH (Task #654) ─────────────────────────────────────────
//
// Dedicated, PURE detector for the shooting-star bearish-reversal candle. Kept
// separate from the generic catalogue because its TRUTH rules are precise and
// frequently mis-stated by naive detectors:
//   • It only counts AFTER a prior UPTREND (a long upper wick in a downtrend is
//     not a shooting star).
//   • Geometry: a long UPPER shadow (≥ 2× the body), a small body sitting near
//     the candle's LOW, and a small lower shadow.
//   • It is UNCONFIRMED (forming) until the NEXT candle confirms by closing
//     BELOW the star's low; it FAILS if the next candle closes ABOVE the star's
//     high.
//   • Location matters — a shooting star into resistance is stronger.
//
// DISPLAY / DECISION-SUPPORT only. No IO, no clock. The caller passes
// already-decided feed facts in; this never grants entry or overrides a feed.
// Honest empty: too few candles ⇒ status "none", nothing fabricated.

import type {
  PatternLocationQuality,
  PatternQuality,
} from "./patternDetectionContract";

export interface ShootingStarCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ShootingStarStatus = "none" | "forming" | "confirmed" | "failed";

export interface ShootingStarInput {
  /** Chronological, CLOSED candles (oldest first). */
  candles: ShootingStarCandle[];
  /** Feed genuinely live-confirmed (else the read is context only). */
  feedConfirmed: boolean;
  /** Feed delayed/stale. */
  feedStale: boolean;
  /** Optional ATR for proportionality checks; null ⇒ ratio-only geometry. */
  atr?: number | null;
}

export interface ShootingStarRead {
  detected: boolean;
  status: ShootingStarStatus;
  /** Always "sell" or "neutral" — a shooting star is never bullish. */
  direction: "sell" | "neutral";
  body: number | null;
  upperWick: number | null;
  lowerWick: number | null;
  /** upperWick / body, the headline ratio (null when body is ~0). */
  upperToBodyRatio: number | null;
  priorUptrend: boolean;
  locationQuality: PatternLocationQuality;
  /** A close below this (star low) confirms. */
  confirmationLevel: number | null;
  /** A close above this (star high) invalidates. */
  invalidationLevel: number | null;
  confidence: number;
  quality: PatternQuality;
  candlesUsed: number;
  minCandles: number;
  contextOnly: boolean;
  reasons: string[];
  warnings: string[];
  explanation: string;
}

const MIN_CANDLES = 6;
const TREND_LOOKBACK = 5;

function emptyRead(
  candlesUsed: number,
  contextOnly: boolean,
  reason: string,
): ShootingStarRead {
  return {
    detected: false,
    status: "none",
    direction: "neutral",
    body: null,
    upperWick: null,
    lowerWick: null,
    upperToBodyRatio: null,
    priorUptrend: false,
    locationQuality: "unknown",
    confirmationLevel: null,
    invalidationLevel: null,
    confidence: 0,
    quality: "none",
    candlesUsed,
    minCandles: MIN_CANDLES,
    contextOnly,
    reasons: [reason],
    warnings: [],
    explanation: reason,
  };
}

/** True when the `lookback` closes leading up to (and excluding) `idx` rise. */
function hasPriorUptrend(
  candles: ShootingStarCandle[],
  idx: number,
  lookback: number,
): boolean {
  const start = idx - lookback;
  if (start < 0) return false;
  const first = candles[start].close;
  const last = candles[idx - 1].close;
  if (!(last > first)) return false;
  // Require a majority of up-closes, not just net drift, to avoid a single spike.
  let ups = 0;
  for (let i = start + 1; i < idx; i++) {
    if (candles[i].close >= candles[i - 1].close) ups++;
  }
  return ups >= Math.ceil(lookback / 2);
}

function matchesShootingStarGeometry(c: ShootingStarCandle): {
  ok: boolean;
  body: number;
  upperWick: number;
  lowerWick: number;
  ratio: number | null;
} {
  const body = Math.abs(c.close - c.open);
  const top = Math.max(c.open, c.close);
  const bottom = Math.min(c.open, c.close);
  const upperWick = c.high - top;
  const lowerWick = bottom - c.low;
  const range = c.high - c.low;
  const ratio = body > 0 ? upperWick / body : null;
  if (range <= 0) return { ok: false, body, upperWick, lowerWick, ratio };
  const longUpper = upperWick >= 2 * body && upperWick >= 0.5 * range;
  const smallLower = lowerWick <= body && lowerWick <= 0.15 * range;
  const bodyNearLow = body <= 0.4 * range;
  return {
    ok: longUpper && smallLower && bodyNearLow,
    body,
    upperWick,
    lowerWick,
    ratio,
  };
}

/**
 * Resolve the shooting-star read over a candle window. Scans from the most
 * recent closed candle backward for the first candle that BOTH matches the
 * geometry AND has a prior uptrend; then evaluates confirmation/failure using
 * the following candle (if any). The star at the very last index stays "forming"
 * because confirmation needs the next close.
 */
export function resolveShootingStarTruth(
  input: ShootingStarInput,
): ShootingStarRead {
  const candles = input.candles ?? [];
  const contextOnly = !input.feedConfirmed || input.feedStale;

  if (candles.length < MIN_CANDLES) {
    return emptyRead(
      candles.length,
      contextOnly,
      `Not enough candles to read a shooting star (need ${MIN_CANDLES}).`,
    );
  }

  const last = candles.length - 1;
  // Only the last candle (forming) or the second-to-last (already confirmable)
  // are relevant for a CURRENT read — older stars are history, not a read.
  for (let idx = last; idx >= last - 1 && idx >= TREND_LOOKBACK; idx--) {
    const star = candles[idx];
    const geo = matchesShootingStarGeometry(star);
    if (!geo.ok) continue;
    if (!hasPriorUptrend(candles, idx, TREND_LOOKBACK)) continue;

    const confirmationLevel = star.low;
    const invalidationLevel = star.high;

    let status: ShootingStarStatus;
    const reasons: string[] = [
      `Long upper wick (${geo.upperWick.toFixed(5)}) ≥ 2× body — rejection of higher prices.`,
      "Small body near the low after an advance — classic shooting-star shape.",
    ];

    if (idx === last) {
      status = "forming";
      reasons.push("Unconfirmed — needs the next candle to close below the star's low.");
    } else {
      const next = candles[idx + 1];
      if (next.close < star.low) {
        status = "confirmed";
        reasons.push("Next candle closed below the star's low — confirmed.");
      } else if (next.close > star.high) {
        status = "failed";
        reasons.push("Next candle closed above the star's high — the signal failed.");
      } else {
        status = "forming";
        reasons.push("Next candle did not close below the low yet — still unconfirmed.");
      }
    }

    // Location: a rejection after an uptrend reads as resistance rejection.
    const locationQuality: PatternLocationQuality = "at_resistance";

    // Confidence from the wick/body proportion, capped, with state + feed caps.
    let confidence = 50;
    if (geo.ratio != null) {
      confidence += Math.min(30, (geo.ratio - 2) * 10);
    }
    if (status === "confirmed") confidence += 15;
    if (status === "failed") confidence = Math.min(confidence, 20);
    if (status === "forming") confidence = Math.min(confidence, 60);
    if (contextOnly) confidence = Math.min(confidence, 35);
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));

    const quality: PatternQuality =
      status === "failed"
        ? "low"
        : confidence >= 70
          ? "high"
          : confidence >= 45
            ? "medium"
            : "low";

    const warnings: string[] = [];
    if (contextOnly) {
      warnings.push("Feed is not live-confirmed — read this as context, not a live trigger.");
    }
    if (input.atr != null && input.atr > 0 && geo.upperWick < input.atr) {
      warnings.push("Upper wick is small relative to ATR — weaker rejection than it looks.");
    }

    const explanation =
      status === "forming"
        ? "A shooting star is printing after an advance — wait for a close below its low to confirm the rejection."
        : status === "confirmed"
          ? "A shooting star confirmed by a lower close — sellers stepped in after the rejection."
          : "A shooting star attempt failed — price closed back above the star's high.";

    return {
      detected: true,
      status,
      direction: status === "failed" ? "neutral" : "sell",
      body: geo.body,
      upperWick: geo.upperWick,
      lowerWick: geo.lowerWick,
      upperToBodyRatio: geo.ratio,
      priorUptrend: true,
      locationQuality,
      confirmationLevel,
      invalidationLevel,
      confidence,
      quality,
      candlesUsed: candles.length,
      minCandles: MIN_CANDLES,
      contextOnly,
      reasons,
      warnings,
      explanation,
    };
  }

  return emptyRead(
    candles.length,
    contextOnly,
    "No shooting star: geometry or the required prior uptrend is absent.",
  );
}
