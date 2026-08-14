import { z } from "zod/v4";

// ── 6 master kill-switches — exactly the conditions the spec listed ───────
export const KillSwitchKindSchema = z.enum([
  "MAX_DAILY_LOSS",     // realized daily P&L drawdown crossed the cap
  "SPREAD_TOO_HIGH",    // current spread exceeds the per-symbol ceiling
  "MT5_UNSTABLE",       // bridge latency / heartbeat / health gate failed
  "NEWS_LOCKOUT",       // currently inside (or too close to) a high-impact news window
  "REVENGE_TRADING",    // trader-DNA detector flagged revenge level HIGH/CRITICAL
  "OVEREXPOSURE",       // open trade count or total exposure % over cap
]);
export type KillSwitchKind = z.infer<typeof KillSwitchKindSchema>;

export const KILL_SWITCH_LABELS: Record<KillSwitchKind, string> = {
  MAX_DAILY_LOSS:   "Max daily loss hit",
  SPREAD_TOO_HIGH:  "Spread too high",
  MT5_UNSTABLE:     "MT5 unstable",
  NEWS_LOCKOUT:     "News lockout",
  REVENGE_TRADING:  "Revenge trading detected",
  OVEREXPOSURE:     "Overexposure",
};

// ── Inputs — one nested object per kill-switch ────────────────────────────
//
// Designed so callers can fill in each section from whatever upstream
// source they have (live-inputs sensors, drawdown guard, exposure guard,
// revenge detector, etc.). Every section is required; a section that
// genuinely has no data should pass `null` for its measurement field — the
// engine will then surface "data missing" rather than silently passing.

export interface DailyLossInput {
  realizedDailyLossPct: number | null;   // 0..100; positive number = loss
  maxDailyLossPct: number;
}

export interface SpreadInput {
  currentPips: number | null;
  maxPips: number;
}

export interface Mt5StabilityInput {
  isHealthy: boolean;
  avgLatencyMs: number | null;
  maxLatencyMs: number;
  lastHeartbeatAgeSec: number | null;
  maxHeartbeatAgeSec: number;
}

export interface NewsLockoutInput {
  inBlackoutWindow: boolean;
  minutesUntilBlackoutEnds: number | null;   // null when not in a window
  minutesUntilNextBlackout: number | null;   // null when no upcoming high-impact event
  preEventLockoutMinutes: number;            // how long before an event we lock out
}

export const RevengeLevelSchema = z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RevengeLevel = z.infer<typeof RevengeLevelSchema>;

export interface RevengeTradingInput {
  level: RevengeLevel;
  // Block threshold — anything at this level or higher fires the switch.
  // Default convention: HIGH and CRITICAL block.
  blockAtOrAbove: RevengeLevel;
}

export interface ExposureInput {
  openTradeCount: number;
  maxOpenTrades: number;
  totalExposurePct: number | null;        // 0..100, total notional exposure / equity
  maxExposurePct: number;
}

export interface KillSwitchInput {
  dailyLoss: DailyLossInput;
  spread: SpreadInput;
  mt5: Mt5StabilityInput;
  news: NewsLockoutInput;
  revenge: RevengeTradingInput;
  exposure: ExposureInput;
  now?: Date;
}

// ── Per-trigger record — surfaced even when not firing, so UI can show ────
//    "5/6 green, 1/6 firing".
export interface KillSwitchTrigger {
  kind: KillSwitchKind;
  label: string;
  triggered: boolean;
  reason: string;                  // human-readable
  observed: number | string | null; // measured value
  threshold: number | string;       // configured threshold
  dataMissing: boolean;             // true when input was null and the switch fails-closed
}

// ── Final verdict ────────────────────────────────────────────────────────
export interface KillSwitchVerdict {
  blocked: boolean;
  triggers: KillSwitchTrigger[];           // always all 6, in declaration order
  blockingKinds: KillSwitchKind[];         // subset that fired
  reasons: string[];                        // human-readable per blocker, prefixed with kind
  evaluatedAt: string;
}

// Convention: when an input value is `null` we cannot prove the condition
// is safe — so the switch fires (fail-closed). This is consistent with
// the bridge-token and stability-gate behavior elsewhere in the system.
export const FAIL_CLOSED_ON_MISSING_DATA = true as const;
