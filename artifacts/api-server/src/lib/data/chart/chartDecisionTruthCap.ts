// Chart read verification → decision-summary cap (truth upgrade, 2026-10-28).
//
// The decision summary (readiness quality → "ready"/"prepare") is built from
// the candle engines, which only know whether the feed is AI-usable and not
// stale. The chart-truth gate is a separate, stricter verdict: Chart Truth
// below 75, a stale feed, a failed broker mirror or a feed that is not live
// means the read has NOT been verified. Ruby already answers "Chart data is
// syncing…" in that state; without this cap Chart Pulse said "A · Ready" and
// the best-action sentence said "act with a defined stop" on the same board.
//
// The cap only ever LOWERS an actionable summary to "watch" and names why. It
// never raises anything and never touches an execution gate: the chart never
// executes from the decision summary, and the gate output itself is unchanged.

import { CHART_TRUTH_THRESHOLD, type ChartGateOutput } from "./chartGateOutput.js";
import type { ChartFeedStatus } from "./chartDataService.js";
import type { ChartDecisionState } from "./chartIntelligence.js";

export interface ChartReadVerification {
  /** True only when every chart-truth check behind a confident read passes. */
  verified: boolean;
  /** Plain-English reasons the read is not verified (empty when verified). */
  reasons: string[];
}

type GateFacts = Pick<
  ChartGateOutput,
  "chartTruthScore" | "confidentReadAllowed" | "autonomousChartActionAllowed" | "tradeConfirmationAllowed"
>;

/**
 * Whether the chart read is verified enough to invite action. Same conditions
 * Ruby's chart read requires (truth ≥ 75, feed not stale, mirror not failed),
 * plus a live feed: a closed market or stored bars cannot back "act now".
 * A missing gate or feed status is treated as not verified.
 */
export function chartReadVerification(
  gate: GateFacts | null | undefined,
  feed: Pick<ChartFeedStatus, "isLive"> | null | undefined,
): ChartReadVerification {
  const reasons: string[] = [];
  if (!gate) {
    reasons.push("the chart truth check was not available");
  } else {
    if (!gate.confidentReadAllowed) {
      reasons.push(
        `Chart Truth is ${gate.chartTruthScore}/100, below the ${CHART_TRUTH_THRESHOLD} needed for a verified read`,
      );
    }
    if (!gate.autonomousChartActionAllowed) reasons.push("the feed is stale");
    if (!gate.tradeConfirmationAllowed) {
      reasons.push("the chart's prices failed the broker-mirror check");
    }
  }
  if (!feed || feed.isLive !== true) reasons.push("the feed is not live right now");
  return { verified: reasons.length === 0, reasons };
}

/**
 * Lower a "ready"/"prepare" decision summary to "watch" when the chart read is
 * not verified. Anything else (already watch / stand aside / unpopulated) is
 * returned unchanged.
 */
export function capDecisionStateByChartTruth(
  decision: ChartDecisionState,
  verification: ChartReadVerification,
): ChartDecisionState {
  if (verification.verified || !decision.populated) return decision;
  if (decision.actionability !== "ready" && decision.actionability !== "prepare") {
    return decision;
  }
  const tail = decision.decision?.split(" — ").slice(1).join(" — ") ?? "";
  const why = verification.reasons.join("; ");
  return {
    ...decision,
    actionability: "watch",
    decision: tail ? `watch — ${tail} (not verified)` : "watch (not verified)",
    note: `Read-only summary of the engine outputs. Capped at watch because the chart read is not verified: ${why}. The chart never executes from this state.`,
  };
}
