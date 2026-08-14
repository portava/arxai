import {
  type HealthStatus, type OpenTradeStatus, type TradeHealthReport,
  AGENT_SYSTEM_THRESHOLDS,
} from "../agentSystem.types";

// tradeHealth — score 0..100 of how a live trade is doing.
// baseline 50 + signed PnL contribution capped ±36 + penalties for MFE
// retracement, condition drift, age stretch.
export function computeTradeHealth(t: OpenTradeStatus): TradeHealthReport {
  const T = AGENT_SYSTEM_THRESHOLDS.monitoring;
  const reasons: string[] = [];
  let score = 50;

  // Signed PnL contribution
  const pnlContribution = Math.max(-36, Math.min(36, t.unrealizedR * 18));
  score += pnlContribution;
  reasons.push(`PnL contribution ${pnlContribution.toFixed(0)} from ${t.unrealizedR.toFixed(2)}R`);

  // MFE retracement penalty
  if (t.maxFavorableExcursionR > 0.5 && t.unrealizedR < t.maxFavorableExcursionR * 0.5) {
    const pen = Math.min(20, (t.maxFavorableExcursionR - t.unrealizedR) * 10);
    score -= pen;
    reasons.push(`-${pen.toFixed(0)} from MFE retracement (peak ${t.maxFavorableExcursionR.toFixed(2)}R, now ${t.unrealizedR.toFixed(2)}R)`);
  }

  // Condition drift — spread expanded materially
  if (t.spreadAtEntryPips > 0 && t.currentSpreadPips > t.spreadAtEntryPips * 2) {
    score -= 10;
    reasons.push(`-10 from spread expansion ${t.spreadAtEntryPips.toFixed(1)}→${t.currentSpreadPips.toFixed(1)}p`);
  }

  // Age stretch — past expected hold
  if (t.expectedHoldSeconds > 0 && t.ageSeconds > t.expectedHoldSeconds * 1.5) {
    score -= 8;
    reasons.push(`-8 from age past expected hold (${t.ageSeconds}s vs ${t.expectedHoldSeconds}s)`);
  }

  score = Math.max(0, Math.min(100, score));
  let status: HealthStatus;
  if (score < T.healthCriticalBelow) status = "CRITICAL";
  else if (score < T.healthPoorBelow)  status = "POOR";
  else if (score < 60)                  status = "FAIR";
  else if (score < 80)                  status = "GOOD";
  else                                  status = "EXCELLENT";

  return { score, status, reasons };
}
