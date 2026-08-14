import { z } from "zod/v4";

// AI Kill Switch + Recovery Mode — a SAFETY layer that overrides every
// other layer when behavior or risk markers cross policy. Recovery modes
// throttle the system back to safer operation rather than just halting.

export const KillTriggerKindSchema = z.enum([
  "DAILY_LOSS_HIT",
  "LOSING_STREAK",
  "OVERTRADING",
  "REVENGE_BEHAVIOR",
  "ABNORMAL_SLIPPAGE",
  "RULE_BREAKING",
]);
export type KillTriggerKind = z.infer<typeof KillTriggerKindSchema>;

export const TriggerSeveritySchema = z.enum(["INFO", "WARN", "CRITICAL"]);
export type TriggerSeverity = z.infer<typeof TriggerSeveritySchema>;

export interface KillTrigger {
  kind: KillTriggerKind;
  severity: TriggerSeverity;
  reason: string;
}

// Snapshot the kill switch evaluates against. Self-contained — no
// coupling to agent-system's PolicyContext / AccountObservation.
export interface KillSwitchSnapshot {
  dailyPnLPct: number;
  dailyLossLimitPct: number;        // negative
  consecutiveLosses: number;
  losingStreakCriticalCount: number;
  tradesInLastHour: number;
  overtradingHourlyLimit: number;
  minutesSinceLastTrade: number | null;
  cooldownMinutesAfterLoss: number;
  recentAverageSlippagePips: number;
  abnormalSlippagePipsThreshold: number;
  recentManualOverrideCount: number;
  ruleBreakingOverrideThreshold: number;
  emotionalState: "CALM" | "FOCUSED" | "CAUTIOUS" | "FRUSTRATED" | "TILT";
  observedAt: string;
}

export const RecoveryModeSchema = z.enum([
  "NORMAL",            // no triggers fired
  "REDUCED_SIZE",      // mild — cap size
  "A_PLUS_ONLY",       // only allow APPROVE (full) with high confidence
  "PAPER_ONLY",        // simulate, don't send to broker
  "BLOCK_ALL",         // hard halt
]);
export type RecoveryMode = z.infer<typeof RecoveryModeSchema>;

export interface KillSwitchState {
  mode: RecoveryMode;
  activeTriggers: KillTrigger[];
  enteredAt: string;
  reasons: string[];
}

export const ProposedActionSchema = z.enum(["APPROVE", "APPROVE_REDUCED", "REJECT"]);
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export interface ActionUnderRecovery {
  action: ProposedAction;
  sizeMultiplier: number;
  confidence: number;
  paperOnly: boolean;
  modifiedReasons: string[];
}

export interface KillSwitchStorePort {
  saveState(s: KillSwitchState): Promise<void>;
  loadState(): Promise<KillSwitchState | null>;
}

export const KILL_SWITCH_DEFAULTS = {
  reducedSizeMultiplierCap: 0.5,
  aPlusMinConfidence: 80,
} as const;
