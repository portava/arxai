import {
  type ConfidenceDecayReport, type ExitWarningLevel, type ExitWarningReport,
  type OpenTradeStatus, type TradeHealthReport,
  AGENT_SYSTEM_THRESHOLDS,
} from "../agentSystem.types";

// exitWarning — combines health + decay + structural triggers into a
// 4-level exit warning. Pre-computed health/decay are accepted to keep
// reports byte-consistent across the monitoring bundle.
export function computeExitWarning(
  t: OpenTradeStatus,
  health: TradeHealthReport,
  decay: ConfidenceDecayReport,
): ExitWarningReport {
  const T = AGENT_SYSTEM_THRESHOLDS.monitoring;
  const triggers: string[] = [];
  const reasons: string[] = [];

  // STRONG triggers
  if (health.score < T.exitWarningStrongHealthBelow) {
    triggers.push("HEALTH_CRITICAL");
    reasons.push(`health ${health.score} < ${T.exitWarningStrongHealthBelow}`);
  }
  if (decay.decay > T.exitWarningStrongDecayAbove) {
    triggers.push("DECAY_HIGH");
    reasons.push(`decay ${decay.decay.toFixed(0)} > ${T.exitWarningStrongDecayAbove}`);
  }
  if (t.agentDirectionReversed) {
    triggers.push("AGENT_REVERSAL");
    reasons.push("agents reversed direction");
  }
  // MAE within 5% of stop (price-distance proxy via R: |MAE| ≥ 0.95R)
  if (Math.abs(t.maxAdverseExcursionR) >= 0.95) {
    triggers.push("NEAR_STOP");
    reasons.push(`MAE ${Math.abs(t.maxAdverseExcursionR).toFixed(2)}R within 5% of stop`);
  }

  // Stale-losing — only when expected hold is set and trade is meaningfully losing
  if (t.expectedHoldSeconds > 0 && t.unrealizedR < -0.5 && t.ageSeconds > t.expectedHoldSeconds) {
    triggers.push("STALE_LOSING");
    reasons.push(`losing ${t.unrealizedR.toFixed(2)}R past expected hold`);
  }

  let level: ExitWarningLevel;
  let urgency: number;
  if (triggers.length >= 2 || triggers.includes("HEALTH_CRITICAL") || triggers.includes("NEAR_STOP")) {
    level = "STRONG"; urgency = 90;
  } else if (triggers.length === 1) {
    level = "CONSIDER"; urgency = 70;
  } else if (health.score < 60 || decay.decay > 50) {
    level = "WATCH"; urgency = 35;
    reasons.push("watch — health or decay elevated but no hard trigger");
  } else {
    level = "NONE"; urgency = 0;
  }

  return { level, urgency, triggers, reasons };
}
