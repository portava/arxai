// Phase 13 — Protective Auto-Close: decision model.
//
// SAFETY: This module ONLY produces a decision object. It NEVER closes a
// trade, calls the gate, modifies risk, or writes to MT5. The 15 eligibility
// checks all default to DENY — auto-close is only eligible when every input
// is positively confirmed. Any unknown input → ALERT_ONLY at best.

import type { EffectiveSettings } from "./settings.js";
import type { ActivityStatus } from "./inactivity.js";
import type { ReversalAnalysis } from "./reversalSignals.js";

export type Decision =
  | "NO_ACTION"
  | "ALERT_ONLY"
  | "RECOMMEND_CLOSE"
  | "RECOMMEND_PARTIAL_CLOSE"
  | "AUTO_CLOSE_ELIGIBLE"
  | "BLOCKED";

export interface DecisionInput {
  userId: number;
  tradeKey: string;
  symbol: string;
  settings: EffectiveSettings;
  activity: ActivityStatus;
  reversal: ReversalAnalysis;
  // External-context inputs determined by engine before calling decide()
  attributionClear: boolean;
  paperOnlyLock: boolean;       // forced true today (mt5.ts:662)
  liveLocked: boolean;          // forced true today (SAFETY_ENVELOPE)
  bridgeConnected: boolean;
  recentDuplicateClose: boolean; // a protective close was attempted within cooldownMin
  tradeIsOpen: boolean;
}

export interface DecisionOutput {
  decision: Decision;
  reason: string;
  confidence: ReversalAnalysis["confidence"];
  dataStatus: ReversalAnalysis["dataStatus"];
  reversalSignals: ReversalAnalysis["signals"];
  invalidationLevel: number | null;
  currentPnl: number | null;
  peakPnl: number | null;
  givebackPercent: number | null;
  suggestedClosePercent: number | null;
  suggestedAction: "CLOSE_FULL" | "CLOSE_PARTIAL" | "TIGHTEN_STOP" | "ALERT_ONLY" | "NO_ACTION" | null;
  userInactive: boolean;
  inactiveDurationMs: number | null;
  userOptedIn: boolean;
  guardsPassed: boolean;
  blockedReason: string | null;
}

function suggestedClosePercent(s: EffectiveSettings): number {
  if (s.closeType === "FULL") return 100;
  if (s.closeType === "PARTIAL") return Math.max(1, Math.min(100, s.partialClosePercent));
  return 0; // TIGHTEN — not a close
}

export function decideProtectiveAction(input: DecisionInput): DecisionOutput {
  const { settings, activity, reversal } = input;
  const userInactive = activity.status === "INACTIVE";
  const userOptedIn = settings.enabled && !settings.killSwitchEngaged;
  const base = {
    confidence: reversal.confidence,
    dataStatus: reversal.dataStatus,
    reversalSignals: reversal.signals,
    invalidationLevel: reversal.invalidationLevel,
    currentPnl: reversal.currentPnl,
    peakPnl: reversal.peakPnl,
    givebackPercent: reversal.givebackPercent,
    userInactive,
    inactiveDurationMs: activity.inactiveDurationMs,
    userOptedIn,
  };

  // ── HARD BLOCKS (BLOCKED return) ────────────────────────────────────────
  if (!input.tradeIsOpen) {
    return { ...base, decision: "BLOCKED", reason: "trade is not open", suggestedClosePercent: null, suggestedAction: null, guardsPassed: false, blockedReason: "TRADE_NOT_OPEN" };
  }
  if (!input.attributionClear) {
    return { ...base, decision: "BLOCKED", reason: "shared-master attribution unclear", suggestedClosePercent: null, suggestedAction: "ALERT_ONLY", guardsPassed: false, blockedReason: "SHARED_MASTER_ATTRIBUTION_UNCLEAR" };
  }
  // SAFETY: UNKNOWN activity must downgrade to ALERT_ONLY BEFORE any
  // cooldown/dedupe block, so an UNKNOWN evaluation cannot escalate to
  // a BLOCKED:DUPLICATE_WITHIN_COOLDOWN decision (which would skip the
  // alert path entirely). Invariant #4.
  if (activity.status === "UNKNOWN") return alertOnly(base, "user activity status unknown — alert only");
  if (input.recentDuplicateClose) {
    return { ...base, decision: "BLOCKED", reason: "recent protective close attempt within cooldown", suggestedClosePercent: null, suggestedAction: "NO_ACTION", guardsPassed: false, blockedReason: "DUPLICATE_WITHIN_COOLDOWN" };
  }

  // ── NO_ACTION when no signals at all and user didn't opt in ─────────────
  if (!userOptedIn && reversal.confidence === "INSUFFICIENT_DATA") {
    return { ...base, decision: "NO_ACTION", reason: "no reversal signals; user not opted in", suggestedClosePercent: null, suggestedAction: null, guardsPassed: true, blockedReason: null };
  }

  // ── ALERT_ONLY conditions (per Phase 6 safety rules) ────────────────────
  // Rule: if no opt-in → alert only at most.
  // Rule: if bridge disconnected → alert only.
  // Rule: if data stale / insufficient → alert only.
  // Rule: if confidence not high enough → alert only.
  // Rule: if activity status unknown → alert only.
  // Rule: if mode is ALERT_ONLY → alert only.
  // Rule: if user is active → no auto-close; recommend / alert.
  if (!userOptedIn) return alertOnly(base, "user not opted in to protective auto-close");
  if (!input.bridgeConnected) return alertOnly(base, "MT5 bridge disconnected — alert only");
  if (reversal.dataStatus === "INSUFFICIENT" || reversal.dataStatus === "INCOMPLETE") return alertOnly(base, `data status ${reversal.dataStatus}; cannot auto-act`);
  // NOTE: activity.status === "UNKNOWN" handled earlier as a hard
  // pre-cooldown gate (see above). At this point status is ACTIVE or INACTIVE.
  if (settings.mode === "ALERT_ONLY") return alertOnly(base, "user mode is ALERT_ONLY");
  if (reversal.confidence === "INSUFFICIENT_DATA" || reversal.confidence === "LOW") return alertOnly(base, `reversal confidence ${reversal.confidence} below threshold`);

  // Confidence threshold gate.
  if (settings.minConfidence === "HIGH" && reversal.confidence !== "HIGH") {
    return alertOnly(base, `confidence ${reversal.confidence} below user-required HIGH`);
  }

  // Multi-signal requirement.
  if (settings.requireMultiSignal && reversal.strongCount + reversal.moderateCount < 2) {
    return alertOnly(base, "fewer than 2 confirming reversal signals");
  }

  // User active + mode CONFIRM_IF_ACTIVE → RECOMMEND, not auto.
  if (!userInactive && settings.mode === "CONFIRM_IF_ACTIVE") {
    const pct = suggestedClosePercent(settings);
    return {
      ...base,
      decision: pct >= 100 ? "RECOMMEND_CLOSE" : "RECOMMEND_PARTIAL_CLOSE",
      reason: "user active + confirm-if-active mode: recommend close, do not auto-execute",
      suggestedClosePercent: pct,
      suggestedAction: pct >= 100 ? "CLOSE_FULL" : "CLOSE_PARTIAL",
      guardsPassed: true,
      blockedReason: null,
    };
  }

  // AUTO_IF_INACTIVE requires inactivity.
  if (settings.mode === "AUTO_IF_INACTIVE" && !userInactive) {
    return alertOnly(base, "mode AUTO_IF_INACTIVE but user is active");
  }

  // ── AUTO_CLOSE_ELIGIBLE — all 15 conditions satisfied ───────────────────
  // The engine still re-checks paper/live locks before enqueueing. We
  // surface the eligibility decision here. The gate forces BLOCKED in
  // production today (paperOnlyLock) which the engine maps to BLOCKED.
  if (input.paperOnlyLock || input.liveLocked) {
    return {
      ...base,
      decision: "BLOCKED",
      reason: input.paperOnlyLock
        ? "paper-only lock active — auto-close blocked at gate"
        : "live trading locked — auto-close blocked at gate",
      suggestedClosePercent: suggestedClosePercent(settings),
      suggestedAction: settings.closeType === "FULL" ? "CLOSE_FULL" : "CLOSE_PARTIAL",
      guardsPassed: false,
      blockedReason: input.paperOnlyLock ? "BLOCKED_BY_PAPER_LOCK" : "LIVE_LOCKED",
    };
  }

  const pct = suggestedClosePercent(settings);
  return {
    ...base,
    decision: "AUTO_CLOSE_ELIGIBLE",
    reason: `all eligibility checks passed: ${reversal.strongCount} strong + ${reversal.moderateCount} moderate signals, user inactive ${Math.round((activity.inactiveDurationMs ?? 0) / 1000)}s ≥ threshold`,
    suggestedClosePercent: pct,
    suggestedAction: pct >= 100 ? "CLOSE_FULL" : "CLOSE_PARTIAL",
    guardsPassed: true,
    blockedReason: null,
  };
}

function alertOnly(base: Omit<DecisionOutput, "decision" | "reason" | "suggestedClosePercent" | "suggestedAction" | "guardsPassed" | "blockedReason">, reason: string): DecisionOutput {
  return {
    ...base,
    decision: "ALERT_ONLY",
    reason,
    suggestedClosePercent: null,
    suggestedAction: "ALERT_ONLY",
    guardsPassed: true,
    blockedReason: null,
  };
}
