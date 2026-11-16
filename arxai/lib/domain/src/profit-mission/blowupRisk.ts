// ── Profit Mission Phase 6 — Blow-up risk, behavioral detectors & emergency stop ─
//
// SAFETY / SCOPE:
//   - PURE, DETERMINISTIC, IO-FREE. No clock, DB, network, or global reads. These
//     engines only COMPUTE a risk read + a required protective action. They can
//     never relax, override, or trigger any execution gate — they can only make a
//     mission STRICTER (pause / stop / require approval / reduce risk).
//   - FAIL-SAFE toward stricter: ambiguous / unknown inputs escalate protection,
//     never weaken it.
//   - These compose ON TOP of the per-user Risk Governor; they are additive and
//     never a substitute for it.

/** Blow-up risk severity band. */
export type BlowupRiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Required protective action, ordered from least to most strict. The mission
 * gate composes these; a stricter action always wins.
 */
export type BlowupAction =
  | "continue"
  | "reduce_risk"
  | "approval_required"
  | "pause"
  | "stop_mission";

const BLOWUP_ACTION_SEVERITY: Record<BlowupAction, number> = {
  continue: 0,
  reduce_risk: 1,
  approval_required: 2,
  pause: 3,
  stop_mission: 4,
};

/** Return the stricter (higher-severity) of two blow-up actions. */
export function stricterBlowupAction(a: BlowupAction, b: BlowupAction): BlowupAction {
  return BLOWUP_ACTION_SEVERITY[b] > BLOWUP_ACTION_SEVERITY[a] ? b : a;
}

export interface BlowupInput {
  /** Mission drawdown from peak/starting capital, in percent (≥ 0). */
  drawdownPct: number;
  /** Current consecutive-loss streak (≥ 0). */
  consecutiveLosses: number;
  /** Today's realised loss as a percent of capital (≥ 0). */
  dailyLossPct: number;
  /** The mission's configured daily-loss cap (percent). 0/neg disables. */
  maxDailyLossPct: number;
  /** Revenge-trading pattern observed. */
  revengeDetected: boolean;
  /** Overtrading pattern observed. */
  overtradingDetected: boolean;
  /** Risk budget consumed (0–100): trades-used / loss-budget-used. */
  budgetUsedPct: number;
  /** Broker margin used (0–100), when known; null when unavailable. */
  marginUsedPct?: number | null;
}

export interface BlowupRiskResult {
  level: BlowupRiskLevel;
  action: BlowupAction;
  /** 0–100 composite score. */
  score: number;
  factors: string[];
}

/**
 * Compute a mission blow-up risk read + the required protective action. Higher
 * score ⇒ stricter band. The action is the band's base action escalated by any
 * hard single-factor condition (drawdown ≥ 10% ⇒ stop; daily-loss cap ⇒ pause;
 * revenge + overtrading together ⇒ approval). Pure.
 */
export function computeBlowupRisk(input: BlowupInput): BlowupRiskResult {
  const factors: string[] = [];
  let score = 0;
  const add = (pts: number, factor: string): void => {
    score += pts;
    factors.push(factor);
  };

  const drawdown = Math.max(0, input.drawdownPct);
  if (drawdown >= 10) add(40, "drawdown>=10%");
  else if (drawdown >= 8) add(30, "drawdown>=8%");
  else if (drawdown >= 5) add(20, "drawdown>=5%");
  else if (drawdown >= 3) add(10, "drawdown>=3%");

  const streak = Math.max(0, Math.floor(input.consecutiveLosses));
  if (streak >= 4) add(30, "consecutiveLosses>=4");
  else if (streak === 3) add(20, "consecutiveLosses=3");
  else if (streak === 2) add(10, "consecutiveLosses=2");

  const dailyCapHit =
    input.maxDailyLossPct > 0 && input.dailyLossPct >= input.maxDailyLossPct;
  if (dailyCapHit) add(25, "dailyLossCapHit");
  else if (input.maxDailyLossPct > 0 && input.dailyLossPct >= input.maxDailyLossPct * 0.6)
    add(12, "dailyLossElevated");

  if (input.revengeDetected) add(15, "revenge");
  if (input.overtradingDetected) add(15, "overtrading");

  const budget = Math.max(0, input.budgetUsedPct);
  if (budget >= 100) add(15, "budgetExhausted");
  else if (budget >= 80) add(8, "budgetHigh");

  if (input.marginUsedPct != null && input.marginUsedPct >= 80) add(15, "marginHigh");

  score = Math.min(100, score);

  const level: BlowupRiskLevel =
    score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";

  // Base action by band.
  let action: BlowupAction =
    level === "critical"
      ? "stop_mission"
      : level === "high"
        ? "reduce_risk"
        : level === "medium"
          ? "reduce_risk"
          : "continue";

  // Hard single-factor escalations (fail-safe toward stricter).
  if (drawdown >= 10) action = stricterBlowupAction(action, "stop_mission");
  if (dailyCapHit) action = stricterBlowupAction(action, "pause");
  if (input.revengeDetected && input.overtradingDetected)
    action = stricterBlowupAction(action, "approval_required");

  return { level, action, score, factors };
}

// ── Behavioral detectors (revenge + overtrading) ────────────────────────────

export interface BehavioralDetectorInput {
  /** Trades closed in the last hour (from the per-user Risk Governor history). */
  recentClosesInLastHour: number;
  /** Re-entries taken right after a loss in the last hour. */
  reentriesAfterLossInLastHour: number;
  /** Overtrading threshold (closes/hr). Default 5 — matches the Risk Governor. */
  overtradingThreshold?: number;
  /** Revenge threshold (loss re-entries/hr). Default 2 — matches the Governor. */
  revengeThreshold?: number;
}

export interface BehavioralDetectorResult {
  overtrading: boolean;
  revenge: boolean;
  /** True when either pattern fires — the caller starts a cooldown. */
  cooldownTriggered: boolean;
  /** Points to dock from the contributing agent's advisory score. */
  scoreDock: number;
  reasons: string[];
}

/**
 * Detect revenge-trading and overtrading from the per-user Risk Governor's
 * aggregated history. Either pattern triggers a cooldown and docks the
 * contributing agent's advisory score. Pure — never an execution decision on its
 * own; it only feeds the (stricter) mission gate. Thresholds mirror the Governor
 * so the two never disagree.
 */
export function detectBehavioralRisk(
  input: BehavioralDetectorInput,
): BehavioralDetectorResult {
  const overThreshold = input.overtradingThreshold ?? 5;
  const revengeThreshold = input.revengeThreshold ?? 2;
  const reasons: string[] = [];

  const overtrading = input.recentClosesInLastHour >= overThreshold;
  const revenge = input.reentriesAfterLossInLastHour >= revengeThreshold;

  let scoreDock = 0;
  if (overtrading) {
    scoreDock += 10;
    reasons.push(`Overtrading: ${input.recentClosesInLastHour} closes in the last hour.`);
  }
  if (revenge) {
    scoreDock += 15;
    reasons.push(`Revenge pattern: ${input.reentriesAfterLossInLastHour} re-entries after a loss.`);
  }

  return {
    overtrading,
    revenge,
    cooldownTriggered: overtrading || revenge,
    scoreDock,
    reasons,
  };
}

// ── Emergency-stop engine ───────────────────────────────────────────────────

/** Every emergency-stop condition a mission watches. */
export type EmergencyCondition =
  | "max_mission_loss"
  | "max_daily_loss"
  | "kill_switch"
  | "broker_disconnect"
  | "stale_feed"
  | "stale_quote"
  | "ghost_position"
  | "equity_mismatch"
  | "abnormal_spread"
  | "abnormal_slippage"
  | "repeated_execution_failure"
  | "severe_drift"
  | "high_impact_news"
  | "blowup_critical"
  | "user_emergency_stop";

export const EMERGENCY_CONDITIONS: readonly EmergencyCondition[] = [
  "max_mission_loss",
  "max_daily_loss",
  "kill_switch",
  "broker_disconnect",
  "stale_feed",
  "stale_quote",
  "ghost_position",
  "equity_mismatch",
  "abnormal_spread",
  "abnormal_slippage",
  "repeated_execution_failure",
  "severe_drift",
  "high_impact_news",
  "blowup_critical",
  "user_emergency_stop",
];

/** Conditions that STOP the mission outright; the rest pause new entries. */
const STOP_CONDITIONS: ReadonlySet<EmergencyCondition> = new Set<EmergencyCondition>([
  "max_mission_loss",
  "kill_switch",
  "blowup_critical",
  "user_emergency_stop",
]);

export interface EmergencyStopInput {
  missionLossPct: number;
  maxMissionLossPct: number;
  dailyLossPct: number;
  maxDailyLossPct: number;
  killSwitchActive: boolean;
  brokerConnected: boolean;
  feedStatus: "live" | "delayed" | "stale" | "unknown";
  quoteFresh: boolean;
  ghostPosition: boolean;
  equityMismatch: boolean;
  spread: "normal" | "wide" | "extreme";
  slippageAbnormal: boolean;
  executionFailures: number;
  maxExecutionFailures?: number;
  severeDrift: boolean;
  highImpactNews: boolean;
  blowupLevel: BlowupRiskLevel;
  userEmergencyStop: boolean;
}

export interface EmergencyStopResult {
  triggered: boolean;
  action: "none" | "pause" | "stop";
  conditions: EmergencyCondition[];
  /** Highest-priority condition (a stop condition outranks a pause condition). */
  primary: EmergencyCondition | null;
}

/**
 * Evaluate every emergency-stop condition. Any STOP condition halts the mission;
 * otherwise any other matched condition pauses new entries. Pure + fail-safe:
 * unknown/stale feed, a disconnected broker, or a missing-fresh quote all trip
 * protection rather than allowing a trade. Never relaxes a gate.
 */
export function evaluateEmergencyStop(input: EmergencyStopInput): EmergencyStopResult {
  const maxFailures = input.maxExecutionFailures ?? 3;
  const matched: EmergencyCondition[] = [];

  if (input.maxMissionLossPct > 0 && input.missionLossPct >= input.maxMissionLossPct)
    matched.push("max_mission_loss");
  if (input.maxDailyLossPct > 0 && input.dailyLossPct >= input.maxDailyLossPct)
    matched.push("max_daily_loss");
  if (input.killSwitchActive) matched.push("kill_switch");
  if (!input.brokerConnected) matched.push("broker_disconnect");
  if (input.feedStatus === "stale" || input.feedStatus === "unknown")
    matched.push("stale_feed");
  if (!input.quoteFresh) matched.push("stale_quote");
  if (input.ghostPosition) matched.push("ghost_position");
  if (input.equityMismatch) matched.push("equity_mismatch");
  if (input.spread === "extreme") matched.push("abnormal_spread");
  if (input.slippageAbnormal) matched.push("abnormal_slippage");
  if (input.executionFailures >= maxFailures) matched.push("repeated_execution_failure");
  if (input.severeDrift) matched.push("severe_drift");
  if (input.highImpactNews) matched.push("high_impact_news");
  if (input.blowupLevel === "critical") matched.push("blowup_critical");
  if (input.userEmergencyStop) matched.push("user_emergency_stop");

  if (matched.length === 0) {
    return { triggered: false, action: "none", conditions: [], primary: null };
  }

  // Order by canonical priority so `primary` is stable; stop conditions first.
  const ordered = EMERGENCY_CONDITIONS.filter((c) => matched.includes(c));
  const hasStop = ordered.some((c) => STOP_CONDITIONS.has(c));
  const primary =
    ordered.find((c) => STOP_CONDITIONS.has(c)) ?? ordered[0] ?? null;

  return {
    triggered: true,
    action: hasStop ? "stop" : "pause",
    conditions: ordered,
    primary,
  };
}
