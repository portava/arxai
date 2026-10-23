import type {
  KillSwitchSnapshot, KillTrigger,
} from "./killSwitch.types";

// evaluateKillTriggers — pure scan over the snapshot; returns ALL triggers
// that fired (caller decides recovery mode from the set). Each trigger
// has a severity for downstream ranking.
export function evaluateKillTriggers(s: KillSwitchSnapshot): KillTrigger[] {
  const out: KillTrigger[] = [];

  if (s.dailyPnLPct <= s.dailyLossLimitPct) {
    out.push({
      kind: "DAILY_LOSS_HIT", severity: "CRITICAL",
      reason: `daily PnL ${s.dailyPnLPct.toFixed(2)}% past limit ${s.dailyLossLimitPct.toFixed(2)}%`,
    });
  }
  if (s.consecutiveLosses >= s.losingStreakCriticalCount) {
    out.push({
      kind: "LOSING_STREAK", severity: "CRITICAL",
      reason: `${s.consecutiveLosses} consecutive losses ≥ critical ${s.losingStreakCriticalCount}`,
    });
  } else if (s.consecutiveLosses >= Math.max(2, Math.floor(s.losingStreakCriticalCount * 0.6))) {
    out.push({
      kind: "LOSING_STREAK", severity: "WARN",
      reason: `${s.consecutiveLosses} consecutive losses approaching critical ${s.losingStreakCriticalCount}`,
    });
  }
  if (s.tradesInLastHour > s.overtradingHourlyLimit) {
    out.push({
      kind: "OVERTRADING", severity: "WARN",
      reason: `${s.tradesInLastHour} trades in last hour > ceiling ${s.overtradingHourlyLimit}`,
    });
  }
  if (s.minutesSinceLastTrade !== null
      && s.consecutiveLosses > 0
      && s.minutesSinceLastTrade < s.cooldownMinutesAfterLoss) {
    out.push({
      kind: "REVENGE_BEHAVIOR", severity: "CRITICAL",
      reason: `${s.minutesSinceLastTrade}m since last loss < cooldown ${s.cooldownMinutesAfterLoss}m`,
    });
  }
  if (s.emotionalState === "TILT" || s.emotionalState === "FRUSTRATED") {
    out.push({
      kind: "REVENGE_BEHAVIOR",
      severity: s.emotionalState === "TILT" ? "CRITICAL" : "WARN",
      reason: `operator state ${s.emotionalState}`,
    });
  }
  if (s.recentAverageSlippagePips > s.abnormalSlippagePipsThreshold) {
    out.push({
      kind: "ABNORMAL_SLIPPAGE", severity: "WARN",
      reason: `recent avg slippage ${s.recentAverageSlippagePips.toFixed(1)}p > threshold ${s.abnormalSlippagePipsThreshold.toFixed(1)}p`,
    });
  }
  if (s.recentManualOverrideCount >= s.ruleBreakingOverrideThreshold) {
    out.push({
      kind: "RULE_BREAKING", severity: "WARN",
      reason: `${s.recentManualOverrideCount} manual overrides ≥ threshold ${s.ruleBreakingOverrideThreshold}`,
    });
  }

  return out;
}
