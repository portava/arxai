import { type SafetySignals } from "./systemMode.types";

export interface SafetyAssessment {
  lockdownRequired: boolean;
  triggers: string[];
  reasons: string[];
}

export const SAFETY_THRESHOLDS = {
  drawdownLockdownPct: 12,
  consecutiveLossLockdown: 6,
  errorRateLockdown01: 0.20,            // 20% recent error rate triggers lockdown
} as const;

// evaluateSafety — examines all safety signals; if ANY trigger fires,
// returns lockdownRequired=true. Risk Governor's direct lockdown signal
// has priority and short-circuits the check (it's an explicit,
// authoritative request).
export function evaluateSafety(signals: SafetySignals): SafetyAssessment {
  const T = SAFETY_THRESHOLDS;
  const triggers: string[] = [];
  const reasons: string[] = [];

  if (signals.riskGovernorForcesLockdown) {
    triggers.push("RISK_GOVERNOR_FORCED_LOCKDOWN");
    reasons.push("Risk Governor explicitly requested LOCKDOWN — short-circuit");
    return { lockdownRequired: true, triggers, reasons };
  }
  if (signals.killSwitchActive) {
    triggers.push("KILL_SWITCH_ACTIVE");
  }
  if (!signals.brokerOnline) {
    triggers.push("BROKER_OFFLINE");
  }
  if (signals.drawdownPct >= T.drawdownLockdownPct) {
    triggers.push(`DRAWDOWN_${signals.drawdownPct.toFixed(1)}%_>=_${T.drawdownLockdownPct}%`);
  }
  if (signals.consecutiveLossCount >= T.consecutiveLossLockdown) {
    triggers.push(`CONSECUTIVE_LOSSES_${signals.consecutiveLossCount}_>=_${T.consecutiveLossLockdown}`);
  }
  if (signals.errorRate01 >= T.errorRateLockdown01) {
    triggers.push(`ERROR_RATE_${(signals.errorRate01 * 100).toFixed(1)}%_>=_${(T.errorRateLockdown01 * 100).toFixed(1)}%`);
  }

  if (triggers.length > 0) {
    reasons.push(`${triggers.length} safety trigger(s) fired → lockdown required`, ...triggers);
    return { lockdownRequired: true, triggers, reasons };
  }
  reasons.push(`all safety signals nominal — no lockdown`);
  return { lockdownRequired: false, triggers: [], reasons };
}
