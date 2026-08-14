// ── Profit Mission Phase 6 — Mission risk budget, ladders, modes & gate compose ─
//
// SAFETY / SCOPE:
//   - PURE, DETERMINISTIC, IO-FREE. No clock, DB, network, or global reads.
//   - Mission risk is ADDITIVE and STRICTER-ONLY: it composes ON TOP of the
//     per-user Risk Governor and can only make trading *stricter*, never looser.
//     `composeMissionGate` is the choke-point that proves this — its decision is
//     always at least as strict as the Governor decision it is handed.
//   - FAIL-SAFE toward stricter: ambiguous inputs escalate protection.
//   - NO MARTINGALE: a trade size is never increased merely because the previous
//     trade lost; `martingaleAllowed` defaults to false and is honoured here.
//   - Behind-pace may raise scanning frequency only — it never lowers trade
//     quality or relaxes a risk limit. Ahead-pace reduces aggression.

import type { BlowupAction } from "./blowupRisk.js";

/** Outcome-driven mission mode, ordered least → most strict for max-strictness. */
export type MissionMode =
  | "attack"
  | "normal"
  | "protect"
  | "recovery"
  | "cooldown"
  | "stop";

const MODE_SEVERITY: Record<MissionMode, number> = {
  attack: 0,
  normal: 1,
  protect: 2,
  recovery: 3,
  cooldown: 4,
  stop: 5,
};

/** Return the stricter (higher-severity) of a set of modes. */
export function strictestMode(...modes: MissionMode[]): MissionMode {
  return modes.reduce<MissionMode>(
    (acc, m) => (MODE_SEVERITY[m] > MODE_SEVERITY[acc] ? m : acc),
    "attack",
  );
}

/** Pace of the mission against its required run-rate. */
export type MissionPace = "ahead" | "on_track" | "behind";

/** Loss-containment ladder action. */
export type LadderAction = "normal" | "reduce_risk" | "a_only" | "cooldown" | "stop";

export interface MissionRiskBudget {
  maxTradesPerDay: number;
  maxScalpsPerSession: number;
  /** Max risk on a single trade, percent of mission capital. */
  maxLossPerTradePct: number;
  /** Daily realised-loss cap, percent of capital → pause. */
  maxLossPerDayPct: number;
  /** Per-session realised-loss cap, percent of capital. */
  maxLossPerSessionPct: number;
  /** Hard mission drawdown stop, percent. */
  maxMissionDrawdownPct: number;
  /** Max open positions on the same symbol. */
  maxSameSymbolExposure: number;
  /** Max open positions across correlated symbols. */
  maxCorrelatedExposure: number;
  maxConsecutiveLosses: number;
  cooldownAfterLossMinutes: number;
  cooldownAfterStreakMinutes: number;
  /** Martingale is OFF by default and can never be enabled silently. */
  martingaleAllowed: boolean;
}

/** Safe, conservative defaults. `martingaleAllowed` is false by default. */
export const DEFAULT_MISSION_RISK_BUDGET: MissionRiskBudget = {
  maxTradesPerDay: 5,
  maxScalpsPerSession: 3,
  maxLossPerTradePct: 1,
  maxLossPerDayPct: 5,
  maxLossPerSessionPct: 3,
  maxMissionDrawdownPct: 10,
  maxSameSymbolExposure: 1,
  maxCorrelatedExposure: 2,
  maxConsecutiveLosses: 3,
  cooldownAfterLossMinutes: 30,
  cooldownAfterStreakMinutes: 120,
  martingaleAllowed: false,
};

export interface LadderRung {
  drawdownPct: number;
  action: LadderAction;
}

/** Default loss-containment ladder: 3% reduce → 5% A-only → 8% cooldown → 10% stop. */
export const DEFAULT_LOSS_LADDER: readonly LadderRung[] = [
  { drawdownPct: 3, action: "reduce_risk" },
  { drawdownPct: 5, action: "a_only" },
  { drawdownPct: 8, action: "cooldown" },
  { drawdownPct: 10, action: "stop" },
];

/**
 * Resolve the loss-containment ladder for a given drawdown. Returns the most
 * severe rung whose threshold is met. Pure.
 */
export function evaluateLossLadder(
  drawdownPct: number,
  ladder: readonly LadderRung[] = DEFAULT_LOSS_LADDER,
): { action: LadderAction; rung: LadderRung | null } {
  const sorted = [...ladder].sort((a, b) => a.drawdownPct - b.drawdownPct);
  let action: LadderAction = "normal";
  let rung: LadderRung | null = null;
  for (const r of sorted) {
    if (drawdownPct >= r.drawdownPct) {
      action = r.action;
      rung = r;
    }
  }
  return { action, rung };
}

export interface LossProtocolResult {
  mode: MissionMode;
  cooldown: boolean;
  /** Risk multiplier in [0, 1] — never > 1 (no martingale). */
  riskMultiplier: number;
}

/**
 * Consecutive-loss protocol (1/2/3/4+). With the default cap of 3:
 *   ≤1 loss → normal (full risk)
 *    2 → protect (half risk)
 *    3 → recovery + cooldown (quarter risk)
 *   4+ → stop (no risk)
 * The multiplier is always ≤ 1. Pure.
 */
export function consecutiveLossProtocol(
  consecutiveLosses: number,
  maxConsecutiveLosses: number = DEFAULT_MISSION_RISK_BUDGET.maxConsecutiveLosses,
): LossProtocolResult {
  const n = Math.max(0, Math.floor(consecutiveLosses));
  if (n > maxConsecutiveLosses) return { mode: "stop", cooldown: true, riskMultiplier: 0 };
  if (n === maxConsecutiveLosses) return { mode: "recovery", cooldown: true, riskMultiplier: 0.25 };
  if (n === maxConsecutiveLosses - 1) return { mode: "protect", cooldown: false, riskMultiplier: 0.5 };
  return { mode: "normal", cooldown: false, riskMultiplier: 1 };
}

export interface MissionModeInput {
  pace: MissionPace;
  drawdownPct: number;
  consecutiveLosses: number;
  dailyLossPct: number;
  budget?: MissionRiskBudget;
  ladder?: readonly LadderRung[];
  /** A cooldown timer is currently active. */
  cooldownActive?: boolean;
  /** Emergency stop is currently engaged. */
  emergencyTriggered?: boolean;
}

export interface MissionModeResult {
  mode: MissionMode;
  ladderAction: LadderAction;
  reasons: string[];
}

/**
 * Outcome-driven mode controller. Combines pace, the loss ladder, the
 * consecutive-loss protocol, the daily-loss cap, cooldown, and emergency into a
 * single mode via max-strictness. Pure + fail-safe toward stricter.
 *
 * Pace rule (mission pressure must never relax risk):
 *   - behind  → `attack` (scanning frequency only; per-trade risk unchanged)
 *   - ahead   → `protect` (reduce aggression to protect gains)
 *   - on_track→ `normal`
 */
export function resolveMissionMode(input: MissionModeInput): MissionModeResult {
  const budget = input.budget ?? DEFAULT_MISSION_RISK_BUDGET;
  const ladder = input.ladder ?? DEFAULT_LOSS_LADDER;
  const reasons: string[] = [];

  let paceMode: MissionMode = "normal";
  if (input.pace === "ahead") {
    paceMode = "protect";
    reasons.push("Ahead of pace — reducing aggression to protect gains.");
  } else if (input.pace === "behind") {
    paceMode = "attack";
    reasons.push("Behind pace — increasing scanning frequency only; risk discipline unchanged.");
  }

  const lad = evaluateLossLadder(input.drawdownPct, ladder);
  let ladderMode: MissionMode = "normal";
  if (lad.action === "reduce_risk" || lad.action === "a_only") ladderMode = "protect";
  else if (lad.action === "cooldown") ladderMode = "cooldown";
  else if (lad.action === "stop") ladderMode = "stop";
  if (lad.rung) reasons.push(`Drawdown ${input.drawdownPct.toFixed(1)}% — loss ladder: ${lad.action}.`);

  const proto = consecutiveLossProtocol(input.consecutiveLosses, budget.maxConsecutiveLosses);
  if (proto.mode !== "normal") {
    reasons.push(`Consecutive losses ${input.consecutiveLosses} — protocol: ${proto.mode}.`);
  }

  let dailyMode: MissionMode = "normal";
  if (budget.maxLossPerDayPct > 0 && input.dailyLossPct >= budget.maxLossPerDayPct) {
    dailyMode = "cooldown";
    reasons.push(`Daily loss ${input.dailyLossPct.toFixed(1)}% ≥ cap ${budget.maxLossPerDayPct}%.`);
  }

  let mode = strictestMode(paceMode, ladderMode, proto.mode, dailyMode);
  if (input.cooldownActive && MODE_SEVERITY[mode] < MODE_SEVERITY.cooldown) {
    mode = "cooldown";
    reasons.push("Cooldown timer active.");
  }
  if (input.emergencyTriggered) {
    mode = "stop";
    reasons.push("Emergency stop engaged.");
  }

  return { mode, ladderAction: lad.action, reasons };
}

// ── Trade sizing (no martingale) ────────────────────────────────────────────

export interface MissionTradeSizeInput {
  /** Base per-trade risk percent (already ≤ the budget cap). */
  baseRiskPct: number;
  /** Mode/protocol multiplier in [0, 1]. */
  riskMultiplier: number;
  /** Whether the immediately preceding trade was a loss. */
  lastTradeWasLoss: boolean;
  /** Honoured as-is; defaults to the budget's `martingaleAllowed` (false). */
  martingaleAllowed: boolean;
}

export interface MissionTradeSizeResult {
  riskPct: number;
  note: "no_martingale" | "martingale_allowed";
}

/**
 * Resolve the next trade's risk size. The multiplier is clamped to [0, 1] so the
 * size can never exceed the base — i.e. it is NEVER increased because the last
 * trade lost. Martingale is off by default; even when allowed this helper still
 * never amplifies size after a loss. Pure.
 */
export function missionTradeSize(input: MissionTradeSizeInput): MissionTradeSizeResult {
  const mult = Math.max(0, Math.min(1, input.riskMultiplier));
  const riskPct = Math.max(0, input.baseRiskPct) * mult;
  return { riskPct, note: input.martingaleAllowed ? "martingale_allowed" : "no_martingale" };
}

// ── Mission gate composition (STRICTER-ONLY over the Risk Governor) ──────────

export type MissionGateDecision = "pass" | "warning" | "block";

const GATE_SEVERITY: Record<MissionGateDecision, number> = {
  pass: 0,
  warning: 1,
  block: 2,
};

export interface MissionGateInput {
  /** The per-user Risk Governor's decision for this intent. */
  governorDecision: MissionGateDecision;
  mode: MissionMode;
  ladderAction: LadderAction;
  blowupAction: BlowupAction;
  /** A daily/trade/loss budget limit has been hit. */
  budgetExceeded: boolean;
  cooldownActive: boolean;
  emergencyTriggered: boolean;
  /** Whether the intent carries a stop-loss. */
  hasStopLoss: boolean;
  /** Edge tier of the setup, for A-only ladder enforcement. */
  edgeTier?: string | null;
  spread?: "normal" | "wide" | "extreme";
  isScalp?: boolean;
}

export interface MissionGateResult {
  allow: boolean;
  decision: MissionGateDecision;
  blockReasons: string[];
}

/**
 * Compose the mission's risk state ON TOP of the Risk Governor decision. The
 * result is ALWAYS at least as strict as `governorDecision` (stricter-only).
 * Any mission protective state can add a block; nothing here can ever turn a
 * Governor block into a pass. Pure.
 */
export function composeMissionGate(input: MissionGateInput): MissionGateResult {
  const blockReasons: string[] = [];
  // Start no weaker than the Governor.
  let decision: MissionGateDecision = input.governorDecision;
  if (input.governorDecision === "block") blockReasons.push("RISK_GOVERNOR_BLOCK");

  const escalate = (to: MissionGateDecision, reason: string): void => {
    if (GATE_SEVERITY[to] > GATE_SEVERITY[decision]) decision = to;
    if (to === "block") blockReasons.push(reason);
  };

  if (!input.hasStopLoss) escalate("block", "MISSION_STOP_LOSS_REQUIRED");
  if (input.emergencyTriggered) escalate("block", "MISSION_EMERGENCY_STOP");
  if (input.mode === "stop") escalate("block", "MISSION_MODE_STOP");
  if (input.mode === "cooldown" || input.cooldownActive)
    escalate("block", "MISSION_COOLDOWN_ACTIVE");
  if (input.budgetExceeded) escalate("block", "MISSION_RISK_BUDGET_EXCEEDED");

  if (input.ladderAction === "stop") escalate("block", "LOSS_LADDER_STOP");
  else if (input.ladderAction === "cooldown") escalate("block", "LOSS_LADDER_COOLDOWN");
  else if (input.ladderAction === "a_only" && (input.edgeTier ?? "").toUpperCase() !== "A")
    escalate("block", "LOSS_LADDER_A_ONLY");
  else if (input.ladderAction === "reduce_risk") escalate("warning", "LOSS_LADDER_REDUCE_RISK");

  if (input.blowupAction === "stop_mission") escalate("block", "BLOWUP_STOP_MISSION");
  else if (input.blowupAction === "pause") escalate("block", "BLOWUP_PAUSE");
  else if (input.blowupAction === "approval_required") escalate("block", "BLOWUP_APPROVAL_REQUIRED");
  else if (input.blowupAction === "reduce_risk") escalate("warning", "BLOWUP_REDUCE_RISK");

  if (input.spread === "extreme") escalate("block", "SPREAD_EXTREME");
  if (input.isScalp && input.spread === "wide") escalate("block", "SCALP_WIDE_SPREAD");

  return { allow: decision !== "block", decision, blockReasons };
}
