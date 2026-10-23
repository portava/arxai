import { computeTradeHealth } from "./tradeHealth.engine";
import {
  type DangerScore, type DangerTier, type HealthReport, type TradeSnapshot,
  TRADE_ADVISOR_THRESHOLDS,
} from "./tradeAdvisor.types";

// computeDangerScore
//
// Pure: 0..100 scalar where higher = more dangerous. Five orthogonal
// contributors (each capped) summed, with the SUM clamped to 100.
//
// Danger ≠ inverted health. Health rewards profitable progress; danger
// only measures risk-of-loss factors. A trade can be HEALTHY (well in
// profit) and ELEVATED danger simultaneously (e.g. spread shock incoming).
export interface DangerScoreInput {
  snapshot: TradeSnapshot;
  health?: HealthReport;     // optional — used only to surface as a reason context
}

export function computeDangerScore(input: DangerScoreInput): DangerScore {
  const T = TRADE_ADVISOR_THRESHOLDS.danger;
  const snap = input.snapshot;
  const reasons: string[] = [];

  // ── Contributor 1: MAE / stop proximity ─────────────────────────────────
  // |MAE in R| → mapped to 0..40. At -1R (touching stop) = 40 danger.
  const maeMag = Math.abs(snap.extremes.maxAdverseExcursionR);
  const maeProximity = clamp(maeMag * 40, 0, 40);
  if (maeProximity > 0) reasons.push(`+${maeProximity.toFixed(0)} from MAE ${maeMag.toFixed(2)}R`);

  // ── Contributor 2: Condition drift ──────────────────────────────────────
  let conditionDrift = 0;
  if (snap.market.volatilityAtEntry !== null && snap.market.volatilityNow !== null
      && snap.market.volatilityAtEntry > 0) {
    const ratio = snap.market.volatilityNow / snap.market.volatilityAtEntry;
    if (ratio > 2 || ratio < 0.5) {
      conditionDrift = 20;
      reasons.push(`+20 from severe volatility regime drift (${ratio.toFixed(2)}× entry)`);
    } else if (ratio > 1.5 || ratio < 0.66) {
      conditionDrift = 10;
      reasons.push(`+10 from moderate volatility drift (${ratio.toFixed(2)}× entry)`);
    }
  }

  // ── Contributor 3: Spread shock ─────────────────────────────────────────
  let spreadShock = 0;
  if (snap.market.spreadAtEntryPips !== null && snap.market.spreadAtEntryPips > 0) {
    const ratio = snap.market.currentSpreadPips / snap.market.spreadAtEntryPips;
    if (ratio >= 3) {
      spreadShock = 15;
      reasons.push(`+15 from spread shock (${ratio.toFixed(1)}× entry)`);
    } else if (ratio >= 2) {
      spreadShock = 8;
      reasons.push(`+8 from elevated spread (${ratio.toFixed(1)}× entry)`);
    }
  }

  // ── Contributor 4: Age decay (long-open + no progress) ──────────────────
  let ageDecay = 0;
  if (snap.entry.expectedHoldSeconds > 0) {
    const stretch = snap.trade.ageSeconds / snap.entry.expectedHoldSeconds;
    if (stretch > 1 && snap.trade.unrealizedR < 0.25) {
      ageDecay = clamp((stretch - 1) * 8, 0, 15);
      reasons.push(`+${ageDecay.toFixed(0)} from stale unproductive trade (${stretch.toFixed(1)}× expected hold, only ${snap.trade.unrealizedR.toFixed(2)}R)`);
    }
  }

  // ── Contributor 5: Agent reversal ───────────────────────────────────────
  let agentReversalPenalty = 0;
  if (snap.live.agentDirectionReversed) {
    agentReversalPenalty = 25;
    reasons.push(`+25 from live agent reversal (entry thesis invalidated)`);
  }

  let score = clamp(maeProximity + conditionDrift + spreadShock + ageDecay + agentReversalPenalty, 0, 100);
  const tier: DangerTier =
    score <= T.safeMax     ? "SAFE"
    : score <= T.elevatedMax ? "ELEVATED"
    : score <= T.highMax     ? "HIGH"
    : "CRITICAL";

  if (reasons.length === 0) reasons.push("no danger contributors active");
  if (input.health && input.health.score < 30) {
    reasons.push(`(context: trade health is ${input.health.score}/100 — ${input.health.status})`);
  }

  return {
    score, tier,
    contributors: { maeProximity, conditionDrift, spreadShock, ageDecay, agentReversalPenalty },
    reasons,
  };
}

// Convenience for callers that don't already have a health report.
export function computeDangerScoreStandalone(snap: TradeSnapshot): DangerScore {
  return computeDangerScore({ snapshot: snap, health: computeTradeHealth(snap) });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
