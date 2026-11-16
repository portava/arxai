import { computeTradeHealth } from "./tradeHealth.engine";
import { computeConfidenceDecay } from "./confidenceDecay.engine";
import { computeDangerScore } from "./dangerScore.engine";
import {
  type ExitWarning, type ExitWarningLevel, type TradeSnapshot,
  type HealthReport, type ConfidenceDecayReport, type DangerScore,
  TRADE_ADVISOR_THRESHOLDS,
} from "./tradeAdvisor.types";

// computeExitWarning
//
// Pure: combines health, decay, and danger into a single graduated warning.
// Caller can pass pre-computed reports (cheap path, used by the orchestrator)
// or pass just the snapshot (this module computes them on demand).
//
// Levels — only the strongest level fires; triggers list every reason found.
//   STRONG   = exit-now-class evidence (any single critical trigger)
//   CONSIDER = multiple soft triggers OR one moderate trigger
//   WATCH    = single early-warning trigger
//   NONE     = nothing material
export interface ExitWarningInput {
  snapshot: TradeSnapshot;
  health?: HealthReport;
  decay?: ConfidenceDecayReport;
  danger?: DangerScore;
}

export function computeExitWarning(input: ExitWarningInput): ExitWarning {
  const T = TRADE_ADVISOR_THRESHOLDS.exit;
  const health = input.health ?? computeTradeHealth(input.snapshot);
  const decay  = input.decay  ?? computeConfidenceDecay(input.snapshot);
  const danger = input.danger ?? computeDangerScore({ snapshot: input.snapshot, health });

  const triggers: string[] = [];
  const reasons:  string[] = [];

  // ── STRONG triggers ────────────────────────────────────────────────────
  let level: ExitWarningLevel = "NONE";
  let urgency = 0;

  if (health.score < T.healthCriticalAt) {
    level = "STRONG"; urgency = Math.max(urgency, 90);
    triggers.push("HEALTH_CRITICAL");
    reasons.push(`health ${health.score}/100 < critical floor ${T.healthCriticalAt}`);
  }
  if (danger.score > T.dangerStrongAt) {
    level = "STRONG"; urgency = Math.max(urgency, 90);
    triggers.push("DANGER_STRONG");
    reasons.push(`danger ${danger.score}/100 > strong-exit floor ${T.dangerStrongAt}`);
  }
  if (input.snapshot.live.agentDirectionReversed) {
    level = "STRONG"; urgency = Math.max(urgency, 85);
    triggers.push("AGENT_REVERSAL");
    reasons.push("live agents now favor opposite direction — entry thesis invalidated");
  }
  // Stop-out proximity: MAE has reached or passed the stop in R-terms
  if (input.snapshot.extremes.maxAdverseExcursionR <= -0.95) {
    level = "STRONG"; urgency = Math.max(urgency, 95);
    triggers.push("STOP_OUT_PROXIMITY");
    reasons.push(`MAE ${input.snapshot.extremes.maxAdverseExcursionR.toFixed(2)}R within 5% of stop`);
  }

  // ── CONSIDER triggers (only escalate if not already STRONG) ─────────────
  const considerTriggers: string[] = [];
  if (decay.decay > T.decayConsiderAt) {
    considerTriggers.push("HIGH_DECAY");
    reasons.push(`confidence decay ${decay.decay.toFixed(0)} > ${T.decayConsiderAt} (driver: ${decay.primaryDriver})`);
  }
  if (health.score < 50 && danger.score > 50) {
    considerTriggers.push("HEALTH_DANGER_INVERTED");
    reasons.push(`health ${health.score}/100 below danger ${danger.score}/100`);
  }
  // Stale-losing requires a real expected-hold floor; an unset (0) expected
  // hold would otherwise mark every losing trade as stale on the first tick.
  if (input.snapshot.entry.expectedHoldSeconds > 0
      && input.snapshot.trade.unrealizedR < -0.5
      && input.snapshot.trade.ageSeconds > input.snapshot.entry.expectedHoldSeconds) {
    considerTriggers.push("STALE_LOSING");
    reasons.push(`losing ${input.snapshot.trade.unrealizedR.toFixed(2)}R past expected hold`);
  }

  // ── WATCH triggers ──────────────────────────────────────────────────────
  const watchTriggers: string[] = [];
  if (health.score < 60) {
    watchTriggers.push("HEALTH_BELOW_GOOD");
    reasons.push(`health ${health.score}/100 below GOOD`);
  }
  if (decay.decay > 25) {
    watchTriggers.push("EARLY_DECAY");
    reasons.push(`confidence decay ${decay.decay.toFixed(0)} above early-warning floor`);
  }

  if (level !== "STRONG") {
    if (considerTriggers.length >= 2 || considerTriggers.length === 1) {
      level = "CONSIDER";
      urgency = Math.max(urgency, considerTriggers.length >= 2 ? 70 : 55);
      triggers.push(...considerTriggers);
    } else if (watchTriggers.length > 0) {
      level = "WATCH";
      urgency = Math.max(urgency, 35);
      triggers.push(...watchTriggers);
    } else {
      reasons.push("no exit triggers active — hold");
    }
  } else {
    // Already STRONG — still attach lower-tier triggers for context
    if (considerTriggers.length > 0) triggers.push(...considerTriggers);
    if (watchTriggers.length > 0)   triggers.push(...watchTriggers);
  }

  return { level, urgency, triggers, reasons };
}
