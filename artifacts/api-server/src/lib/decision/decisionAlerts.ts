// Phase UX7 — Decision-driven alert candidates.
//
// Pure function: takes (prior decision, new decision) and returns
// candidate alerts to insert into trade_exit_alerts via the existing
// dedup path (pg_advisory_xact_lock + 5-min recent-window). Only emit
// when there is a genuine transition or severity increase.

import type { TradeDecision } from "./types.js";
import type { PriorDecision } from "./persistence.js";

export type DecisionAlertType =
  | "decision_changed"
  | "decision_urgency_jumped"
  | "decision_confidence_dropped"
  | "decision_protect_profit"
  | "decision_review_close"
  | "decision_invalidated"
  | "decision_data_stale";

export interface DecisionAlertCandidate {
  alertType: DecisionAlertType;
  severity: "info" | "watch" | "warning" | "urgent";
  title: string;
  message: string;
  recommendedAction: string;
  context: Record<string, unknown>;
}

const NON_ACTION_LABELS = new Set(["Hold", "Healthy pullback", "Continuation still valid"]);

export function evaluateDecisionAlerts(
  symbol: string,
  current: TradeDecision,
  prior: PriorDecision | null,
): DecisionAlertCandidate[] {
  const out: DecisionAlertCandidate[] = [];

  // 1) decision label changed (only emit when it moves to a *different*
  //    state — same label = no alert, same dq.missing = no alert).
  const labelChanged = prior?.decisionLabel
    && prior.decisionLabel !== current.decisionLabel;

  if (labelChanged) {
    out.push({
      alertType: "decision_changed",
      severity: current.urgencyScore != null && current.urgencyScore >= 70 ? "warning" : "watch",
      title: `${symbol} decision: ${current.decisionLabel}`,
      message: `${current.reasonSummary}`,
      recommendedAction: current.decisionAction,
      context: { from: prior!.decisionLabel, to: current.decisionLabel },
    });
  }

  // 2) urgency jumped >= 25 vs prior.
  const urgPrev = prior?.urgencyScore ?? 0;
  const urgNow = current.urgencyScore ?? 0;
  if (urgNow - urgPrev >= 25 && urgNow >= 60) {
    out.push({
      alertType: "decision_urgency_jumped",
      severity: urgNow >= 80 ? "urgent" : "warning",
      title: `${symbol} urgency rising`,
      message: `Urgency moved from ${Math.round(urgPrev)} to ${Math.round(urgNow)}: ${current.mainReason}`,
      recommendedAction: current.decisionAction,
      context: { urgencyPrev: urgPrev, urgencyNow: urgNow },
    });
  }

  // 3) confidence dropped >= 25 vs prior.
  const conPrev = prior?.confidenceScore ?? 0;
  const conNow = current.confidenceScore ?? 0;
  if (prior?.confidenceScore != null && conPrev - conNow >= 25) {
    out.push({
      alertType: "decision_confidence_dropped",
      severity: "watch",
      title: `${symbol} decision confidence dropped`,
      message: `Confidence moved from ${Math.round(conPrev)} to ${Math.round(conNow)}.`,
      recommendedAction: current.decisionAction,
      context: { confidencePrev: conPrev, confidenceNow: conNow },
    });
  }

  // 4) entered Protect profit (transition).
  if (current.decisionLabel === "Protect profit" && prior?.decisionLabel !== "Protect profit") {
    out.push({
      alertType: "decision_protect_profit",
      severity: "warning",
      title: `${symbol} — protect profit`,
      message: current.reasonSummary,
      recommendedAction: current.decisionAction,
      context: { protectProfitLevel: current.protectProfitLevel },
    });
  }

  // 5) entered a review-close state (transition).
  const reviewClose = ["Review full close", "Review partial close"].includes(current.decisionLabel);
  const wasReviewClose = prior?.decisionLabel
    ? ["Review full close", "Review partial close"].includes(prior.decisionLabel)
    : false;
  if (reviewClose && !wasReviewClose) {
    out.push({
      alertType: "decision_review_close",
      severity: "warning",
      title: `${symbol} — ${current.decisionLabel.toLowerCase()}`,
      message: current.reasonSummary,
      recommendedAction: current.decisionAction,
      context: { from: prior?.decisionLabel ?? null },
    });
  }

  // 6) entered Trade invalidated (transition).
  if (current.decisionLabel === "Trade invalidated" && prior?.decisionLabel !== "Trade invalidated") {
    out.push({
      alertType: "decision_invalidated",
      severity: "urgent",
      title: `${symbol} — trade invalidated`,
      message: current.reasonSummary,
      recommendedAction: current.decisionAction,
      context: { invalidationLevel: current.invalidationLevel },
    });
  }

  // 7) data quality became stale (transition into Data insufficient).
  if (current.decisionLabel === "Data insufficient" && prior?.decisionLabel != null
      && prior.decisionLabel !== "Data insufficient"
      && !NON_ACTION_LABELS.has(prior.decisionLabel)) {
    out.push({
      alertType: "decision_data_stale",
      severity: "info",
      title: `${symbol} — decision data became stale`,
      message: "Live data is no longer fresh enough to score this trade.",
      recommendedAction: "WATCH_CLOSELY",
      context: { missing: current.dataQuality.missing },
    });
  }

  return out;
}
