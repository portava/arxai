// Opportunity Spine (#17) — pure mapping from one supervisor-resolved
// DecisionCandidate to an owning-object observation. The api-server lifecycle
// manager subscribes at the existing decision-cycle seam and feeds candidates
// through this derivation; no scanner/mission read path changes.

import type { DecisionCandidate } from "../self-trade/selfTradeDecision.types.js";
import {
  buildOpportunityKey,
  timeframeHorizonClass,
  type HorizonClass,
  type OpportunityActiveState,
} from "./opportunityStateMachine.js";

const ACTIONABLE_OUTCOMES = new Set(["APPROVED", "APPROVED_REDUCED", "PREPARE_ONLY"]);

export interface OpportunityObservation {
  opportunityKey: string;
  symbol: string;
  timeframe: string;
  horizonClass: HorizonClass;
  side: "BUY" | "SELL";
  setup: string;
  observedStage: OpportunityActiveState;
  agentKey: string;
  rankScore: number;
  outcome: string;
  /** ISO string when the candidate carries a setup expiry; else null. */
  setupExpiresAt: string | null;
  thesis: DecisionCandidate["thesis"];
}

/**
 * Derive the owning-object observation for one candidate, or null when the
 * candidate is not a setup at all (no side / no classified setup). Honest:
 * a directionless read never fabricates an opportunity object.
 */
export function deriveOpportunityObservation(
  c: DecisionCandidate,
): OpportunityObservation | null {
  if (c.side == null || c.setup === "NONE") return null;

  const hasEntryZone = c.thesis?.entryZone != null;
  const actionable = ACTIONABLE_OUTCOMES.has(c.outcome);

  // Stage derivation mirrors the read-side lifecycle engine's semantics:
  // "act now" (actionable + concrete entry zone) is the ONLY window-open state.
  const observedStage: OpportunityActiveState =
    actionable && hasEntryZone
      ? "ENTRY_WINDOW_OPEN"
      : hasEntryZone
        ? "ENTRY_APPROACHING"
        : "SETUP_FORMING";

  return {
    opportunityKey: buildOpportunityKey({
      symbol: c.symbol,
      timeframe: c.timeframe,
      side: c.side,
      setup: c.setup,
    }),
    symbol: c.symbol,
    timeframe: c.timeframe,
    horizonClass: timeframeHorizonClass(c.timeframe),
    side: c.side,
    setup: c.setup,
    observedStage,
    agentKey: c.agentKey,
    rankScore: c.rankScore,
    outcome: c.outcome,
    setupExpiresAt: c.setupExpiresAt,
    thesis: c.thesis,
  };
}
