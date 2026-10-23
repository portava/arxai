import {
  type HealthReport, type HealthStatus, type TradeSnapshot,
  TRADE_ADVISOR_THRESHOLDS,
} from "./tradeAdvisor.types";

// computeTradeHealth
//
// Pure: scores 0..100 starting at a baseline of 50 and adjusting up/down by
// five orthogonal factors. Higher = healthier. Status tiers come straight
// from TRADE_ADVISOR_THRESHOLDS so the UI never re-derives buckets.
export function computeTradeHealth(snap: TradeSnapshot): HealthReport {
  const reasons: string[] = [];
  let score = 50;

  // ── Factor 1: P&L contribution (signed, capped) ─────────────────────────
  // Each +1R adds 12 points; each −1R subtracts 12. Capped at ±36.
  const pnlContribution = clamp(snap.trade.unrealizedR * 12, -36, 36);
  score += pnlContribution;
  if (pnlContribution > 0)      reasons.push(`+${pnlContribution.toFixed(1)} from unrealized ${snap.trade.unrealizedR.toFixed(2)}R`);
  else if (pnlContribution < 0) reasons.push(`${pnlContribution.toFixed(1)} from unrealized ${snap.trade.unrealizedR.toFixed(2)}R`);

  // ── Factor 2: MFE retracement penalty ───────────────────────────────────
  // If we ever made favorable progress and have given back > 50% of it,
  // that's a degraded state even when still profitable.
  let mfeRetracementPenalty = 0;
  if (snap.extremes.maxFavorableExcursionR > 0.25 &&
      snap.extremes.maxFavorableExcursionR > snap.trade.unrealizedR) {
    const retraced = (snap.extremes.maxFavorableExcursionR - snap.trade.unrealizedR)
      / snap.extremes.maxFavorableExcursionR;
    mfeRetracementPenalty = -clamp(retraced * 25, 0, 20);
    score += mfeRetracementPenalty;
    if (mfeRetracementPenalty < 0) {
      reasons.push(`${mfeRetracementPenalty.toFixed(1)} from ${(retraced * 100).toFixed(0)}% MFE retracement`);
    }
  }

  // ── Factor 3: Age stretch penalty ───────────────────────────────────────
  // Trades that have outstayed their expected hold without resolving lose
  // 5 points per multiple of expected duration past the first.
  let ageStretchPenalty = 0;
  if (snap.entry.expectedHoldSeconds > 0) {
    const stretch = snap.trade.ageSeconds / snap.entry.expectedHoldSeconds;
    if (stretch > 1) {
      ageStretchPenalty = -clamp((stretch - 1) * 5, 0, 15);
      score += ageStretchPenalty;
      reasons.push(`${ageStretchPenalty.toFixed(1)} — open ${stretch.toFixed(1)}× expected hold`);
    }
  }

  // ── Factor 4: Spread pressure ───────────────────────────────────────────
  // Current spread > 2× entry spread → pressure penalty (exit cost rising).
  let spreadPressurePenalty = 0;
  if (snap.market.spreadAtEntryPips !== null && snap.market.spreadAtEntryPips > 0) {
    const ratio = snap.market.currentSpreadPips / snap.market.spreadAtEntryPips;
    if (ratio > 2) {
      spreadPressurePenalty = -clamp((ratio - 2) * 5, 0, 15);
      score += spreadPressurePenalty;
      reasons.push(`${spreadPressurePenalty.toFixed(1)} — spread ${ratio.toFixed(1)}× entry`);
    }
  }

  // ── Factor 5: Condition drift (volatility regime change) ────────────────
  let conditionDriftPenalty = 0;
  if (snap.market.volatilityAtEntry !== null && snap.market.volatilityNow !== null
      && snap.market.volatilityAtEntry > 0) {
    const volRatio = snap.market.volatilityNow / snap.market.volatilityAtEntry;
    if (volRatio > 1.5 || volRatio < 0.5) {
      conditionDriftPenalty = -10;
      score += conditionDriftPenalty;
      reasons.push(`${conditionDriftPenalty.toFixed(1)} — volatility ${volRatio.toFixed(2)}× entry (regime drift)`);
    }
  }
  // Live agent reversal is a sharp condition signal
  if (snap.live.agentDirectionReversed) {
    conditionDriftPenalty -= 15;
    score -= 15;
    reasons.push(`-15 — agents now favor opposite direction`);
  }

  score = clamp(score, 0, 100);
  const status = scoreToStatus(score);
  if (reasons.length === 0) reasons.push("baseline 50/100, no penalties or boosts active");

  return {
    score, status,
    factors: { pnlContribution, mfeRetracementPenalty, ageStretchPenalty, spreadPressurePenalty, conditionDriftPenalty },
    reasons,
  };
}

function scoreToStatus(s: number): HealthStatus {
  const T = TRADE_ADVISOR_THRESHOLDS.health;
  if (s >= T.excellent) return "EXCELLENT";
  if (s >= T.good)      return "GOOD";
  if (s >= T.fair)      return "FAIR";
  if (s >= T.poor)      return "POOR";
  return "CRITICAL";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
