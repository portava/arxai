// Phase 27-B — Prop Firm notification mapping.
//
// Maps prop-challenge violations + lifecycle events into NotifyInput records
// with the exact verbatim safety language required by the spec. Per-user
// scoped, deduped, and fail-closed: never fabricates push delivery, never
// invents rule compliance.
//
// SAFETY: this file NEVER places trades, NEVER unlocks live execution,
// NEVER queues MT5 commands. It only produces notification payloads.

import type { NotifyInput, NotifSeverity } from "./rules.js";

// Required verbatim alert language (spec — DO NOT modify).
export const PROP_WARNING_LANG = "Prop firm rule warning — no trade was executed.";
export const PROP_BLOCK_LANG   = "Prop firm guardrail blocked this paper action.";
export const PROP_LIVE_LOCK_LANG = "Live execution remains locked.";

export type PropFirmAlertKind =
  | "TRAILING_DRAWDOWN_WARN" | "TRAILING_DRAWDOWN_BREACH"
  | "MAX_RISK_PER_TRADE_WARN" | "MAX_RISK_PER_TRADE_BREACH"
  | "MAX_OPEN_TRADES" | "MAX_PENDING_ORDERS"
  | "MAX_POSITION_SIZE_WARN" | "MAX_POSITION_SIZE_BREACH"
  | "NEWS_RESTRICTION_WARN"
  | "WEEKEND_RESTRICTION_WARN"
  | "OVERNIGHT_RESTRICTION_WARN"
  | "INSUFFICIENT_DATA"
  | "PAPER_ACTION_BLOCKED"
  | "PROP_MODE_ENABLED" | "PROP_MODE_DISABLED";

interface PropAlertArgs {
  challengeId: number;
  ruleChecked: string;
  detail?: string;
  /**
   * Per-user dedupe scoping (required). Without this, the global dedupe
   * key in `notifications/service.ts` could collide across users sharing
   * a challengeId range. Always pass the authenticated user's id.
   */
  userId: number;
}

// 1-hour dedupe bucket for repeated alerts on the same rule + day.
function bucket1h(): string {
  return String(Math.floor(Date.now() / 3_600_000));
}

/** Build a NotifyInput for a prop-firm alert with required verbatim language. */
export function buildPropFirmAlert(kind: PropFirmAlertKind, args: PropAlertArgs): NotifyInput {
  const day = new Date().toISOString().slice(0, 10);
  // Per-user dedupe key — collisions across users impossible.
  const baseDedupe = `LL:PROP:u${args.userId}:${kind}:${args.challengeId}:${args.ruleChecked}:${day}:${bucket1h()}`;

  // Severity map.
  const sevByKind: Record<PropFirmAlertKind, NotifSeverity> = {
    TRAILING_DRAWDOWN_WARN: "WARNING",
    TRAILING_DRAWDOWN_BREACH: "CRITICAL",
    MAX_RISK_PER_TRADE_WARN: "WARNING",
    MAX_RISK_PER_TRADE_BREACH: "HIGH",
    MAX_OPEN_TRADES: "HIGH",
    MAX_PENDING_ORDERS: "INFO",
    MAX_POSITION_SIZE_WARN: "WARNING",
    MAX_POSITION_SIZE_BREACH: "HIGH",
    NEWS_RESTRICTION_WARN: "WARNING",
    WEEKEND_RESTRICTION_WARN: "WARNING",
    OVERNIGHT_RESTRICTION_WARN: "WARNING",
    INSUFFICIENT_DATA: "INFO",
    PAPER_ACTION_BLOCKED: "HIGH",
    PROP_MODE_ENABLED: "INFO",
    PROP_MODE_DISABLED: "INFO",
  };

  const titleByKind: Record<PropFirmAlertKind, string> = {
    TRAILING_DRAWDOWN_WARN:   "Trailing drawdown warning",
    TRAILING_DRAWDOWN_BREACH: "Trailing drawdown breached",
    MAX_RISK_PER_TRADE_WARN:  "Max risk per trade warning",
    MAX_RISK_PER_TRADE_BREACH:"Max risk per trade breached",
    MAX_OPEN_TRADES:          "Max open trades reached",
    MAX_PENDING_ORDERS:       "Max pending orders reached",
    MAX_POSITION_SIZE_WARN:   "Max position size warning",
    MAX_POSITION_SIZE_BREACH: "Max position size breached",
    NEWS_RESTRICTION_WARN:    "News trading restriction warning",
    WEEKEND_RESTRICTION_WARN: "Weekend holding restriction warning",
    OVERNIGHT_RESTRICTION_WARN: "Overnight holding restriction warning",
    INSUFFICIENT_DATA:        "Prop rule insufficient data",
    PAPER_ACTION_BLOCKED:     "Paper action blocked by prop rule",
    PROP_MODE_ENABLED:        "Prop firm mode enabled",
    PROP_MODE_DISABLED:       "Prop firm mode disabled",
  };

  // Body uses the verbatim spec language depending on whether this is a
  // warning, a block, or a lifecycle event. Live-lock language is ALWAYS
  // appended for warning/block alerts.
  const isBlock = kind === "PAPER_ACTION_BLOCKED";
  const isLifecycle = kind === "PROP_MODE_ENABLED" || kind === "PROP_MODE_DISABLED";
  const isInsufficient = kind === "INSUFFICIENT_DATA";

  let message: string;
  if (isBlock) {
    message = `${PROP_BLOCK_LANG} ${PROP_LIVE_LOCK_LANG}${args.detail ? ` Detail: ${args.detail}.` : ""}`;
  } else if (isInsufficient) {
    message = `Prop rule cannot be evaluated — INSUFFICIENT_DATA. ${args.detail ?? ""}`.trim();
  } else if (isLifecycle) {
    message = `${titleByKind[kind]} for challenge #${args.challengeId}. ${PROP_LIVE_LOCK_LANG}`;
  } else {
    message = `${PROP_WARNING_LANG} ${args.detail ?? ""} ${PROP_LIVE_LOCK_LANG}`.replace(/\s+/g, " ").trim();
  }

  return {
    type: isBlock ? "SAFETY" : "RISK",
    severity: sevByKind[kind],
    sourceBuild: "HH", // closest existing build code for risk/safety alerts
    sourceEventId: `prop:${args.challengeId}:${kind}`,
    title: titleByKind[kind],
    message,
    actionUrl: `/prop-challenge?id=${args.challengeId}`,
    metadata: {
      propChallengeId: args.challengeId,
      ruleChecked: args.ruleChecked,
      alertKind: kind,
      simulated: true,
      liveExecutionLocked: true,
    },
    dedupeKey: baseDedupe,
  };
}

/** Map an evaluator violation row → a prop-firm alert kind, or null. */
export function violationToAlertKind(args: {
  type: string;
  severity: "INFO" | "WARN" | "HARD";
}): PropFirmAlertKind | null {
  switch (args.type) {
    case "TRAILING_DRAWDOWN":
      return args.severity === "HARD" ? "TRAILING_DRAWDOWN_BREACH" : "TRAILING_DRAWDOWN_WARN";
    case "MAX_RISK_PER_TRADE":
      return args.severity === "WARN" ? "MAX_RISK_PER_TRADE_BREACH" : "MAX_RISK_PER_TRADE_WARN";
    case "MAX_OPEN_TRADES":
      return args.severity === "INFO" ? null : "MAX_OPEN_TRADES";
    case "MAX_PENDING_ORDERS":
      return "MAX_PENDING_ORDERS";
    case "MAX_POSITION_SIZE":
      return args.severity === "WARN" ? "MAX_POSITION_SIZE_BREACH" : "MAX_POSITION_SIZE_WARN";
    case "NEWS_RESTRICTION":
      return "NEWS_RESTRICTION_WARN";
    case "WEEKEND_RESTRICTION":
      return "WEEKEND_RESTRICTION_WARN";
    case "OVERNIGHT_RESTRICTION":
      return "OVERNIGHT_RESTRICTION_WARN";
    default:
      return null;
  }
}
