// Owner decision 2026-10-28: no invented AI confidence policy. This temporary
// hold is independent of the trader's overridable discipline settings.
import type { IntentOrigin, TradeIntent } from "../riskGovernor/preTrade.js";
import type { SafetyCorePosture } from "./platformSwitches.js";

export const AI_ENTRY_POLICY_PENDING = "AI_ENTRY_POLICY_PENDING: AI-generated entries are disabled until the owner approves a confidence policy.";
export type PaperPosture = SafetyCorePosture & { engaged: boolean };

/** A known AI decision cannot be relabelled manual/api/system; retain the
 * original generated actor when one was already supplied. */
export function paperEntryOrigin(origin: IntentOrigin = "manual", decisionId?: number | null): IntentOrigin {
  return decisionId != null && ["manual", "api", "system"].includes(origin) ? "ruby" : origin;
}

export function aiEntryPolicyReason(intent: Pick<TradeIntent, "action" | "origin">): string | null {
  return intent.action === "OPEN" && ["ruby", "automation", "strategy"].includes(intent.origin)
    ? AI_ENTRY_POLICY_PENDING : null;
}

export function paperEntryPolicyReason(posture: PaperPosture): string | null {
  if (!posture.readable || !posture.present) return "PAPER_SAFETY_STATE_UNAVAILABLE: one readable Safety Core state is required before a paper entry.";
  if (posture.engaged) return "PAPER_SAFETY_STOP: the Safety Core kill switch is engaged.";
  if (!["PAPER_TRADING", "LIVE_TRADING"].includes(posture.operationalMode ?? ""))
    return `PAPER_MODE_BLOCK: Safety Core mode ${posture.operationalMode ?? "unknown"} does not permit booking paper orders.`;
  // Preserve the existing Safety Core trading-state policy (tradeGate).
  // Recovery, degraded and shutdown states do not prove permission for new risk.
  const states = ["NORMAL", "HIGH_VOLATILITY", "TREND_EXPANSION", "CHOP_DANGER", "NEWS_RISK", "LOW_LIQUIDITY", "EXECUTION_RISK", "COGNITIVE_FATIGUE", "DEFENSIVE_MODE"];
  return states.includes(posture.globalState ?? "") ? null
    : `PAPER_STATE_BLOCK: Safety Core state ${posture.globalState ?? "unknown"} does not permit new paper orders.`;
}
