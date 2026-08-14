// Agent Court auto-wiring bridge.
//
// Maps a completed governance review (the advisory Court outcome a surface
// already computed) into a Court disagreement record draft — but ONLY when a
// genuine multi-agent disagreement actually occurred (a real rejection, risk
// veto, or escalation between opposing camps). The common no-conflict case
// returns null so nothing is persisted.
//
// This is pure (no I/O) and safe to run on the hot path: surfaces call it
// synchronously to decide whether a disagreement happened, then fire-and-forget
// the persistence write. It NEVER runs on the live execution path.

import type {
  GovernancePosition,
  GovernanceOutcome,
  GovernanceReview,
} from "../governance/agentCourt.engine";
import type {
  CourtDecision,
  CourtOutcome,
  CourtTradeType,
  DisagreementRecordDraft,
} from "./agentCourt.engine";

export interface DisagreementDraftContext {
  symbol: string;
  timeframe: string;
  tradeType: CourtTradeType;
  /** Free-text market-condition tag; defaults to "<surface>:<direction>". */
  condition?: string;
}

/** Positions that constitute active opposition (a challenge against the camp). */
const OPPOSITION_POSITIONS = new Set<GovernancePosition>([
  "rejection",
  "downgrade",
  "challenge",
]);

/** Map a governance position to the Court decision camp it votes for. */
function positionToDecision(p: GovernancePosition): CourtDecision | null {
  switch (p) {
    case "rejection":
      return "reject";
    case "downgrade":
    case "challenge":
    case "caution":
      return "caution";
    case "needs_more_data":
      return "no_trade";
    case "support":
      return "approve";
    // escalation / performance_objection / abstain cast no decision vote.
    default:
      return null;
  }
}

/** Map the review outcome to the Court decision that prevailed. */
function outcomeToWinningDecision(o: GovernanceOutcome): CourtDecision {
  switch (o) {
    case "rejected":
      return "reject";
    case "escalated":
      return "caution";
    case "downgraded":
    case "approved_with_caution":
      return "caution";
    case "needs_more_data":
      return "no_trade";
    case "approved":
      return "approve";
    default:
      return "observe";
  }
}

/** Map the review outcome to the persisted Court outcome label. */
function outcomeToCourtOutcome(o: GovernanceOutcome): CourtOutcome {
  switch (o) {
    case "rejected":
      return "REJECT";
    case "escalated":
      return "WATCHLIST";
    case "downgraded":
    case "approved_with_caution":
      return "CAUTION";
    case "needs_more_data":
      return "NO_TRADE";
    case "approved":
      return "APPROVE";
    default:
      return "WATCHLIST";
  }
}

/** True when the Risk agent applied a protective veto (rejection/downgrade). */
export function riskVetoInReview(review: GovernanceReview): boolean {
  return review.challenges.some(
    (c) =>
      c.byAgentKey === "RISK" &&
      (c.challengeType === "rejection" || c.challengeType === "downgrade"),
  );
}

/**
 * Detect a genuine multi-agent disagreement in a governance review and, when
 * present, build a Court disagreement record draft for persistence. Returns
 * null for the common no-conflict case: pure pass-through, advisory agreement,
 * a surface where governance did not apply, or a single-camp outcome. Pure: no
 * I/O, safe on the hot path.
 */
export function buildDisagreementDraftFromReview(
  review: GovernanceReview,
  ctx: DisagreementDraftContext,
): DisagreementRecordDraft | null {
  // Governance must actually have applied (≥1 agent with standing). Pure
  // pass-through reviews carry no disagreement.
  if (!review.governanceApplied) return null;

  const hasOpposition = review.challenges.some((c) =>
    OPPOSITION_POSITIONS.has(c.challengeType),
  );
  const riskVeto = riskVetoInReview(review);
  const conflictOutcome =
    review.outcome === "rejected" || review.outcome === "escalated";
  const vetoDowngrade = riskVeto && review.outcome === "downgraded";

  // Only a real conflict (opposition AND a conflict/veto outcome) is recorded.
  if (!hasOpposition || !(conflictOutcome || vetoDowngrade)) return null;

  // Build the camp positions from agents that actually carried weight.
  const positions = review.positions
    .map((p) => {
      const decision = positionToDecision(p.position);
      if (decision === null || p.weight <= 0) return null;
      return {
        agentKey: p.agentKey,
        decision,
        confidence: Math.round(Math.max(0, Math.min(1, p.weight)) * 100),
        weight: p.weight,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // A disagreement needs at least two camps voting different decisions.
  const distinctDecisions = new Set(positions.map((p) => p.decision));
  if (distinctDecisions.size < 2) return null;

  const winningDecision = outcomeToWinningDecision(review.outcome);
  const winningAgentKeys = positions
    .filter((p) => p.decision === winningDecision)
    .map((p) => p.agentKey);

  return {
    symbol: ctx.symbol,
    timeframe: ctx.timeframe,
    tradeType: ctx.tradeType,
    condition: ctx.condition ?? `${review.surface}:${review.direction}`,
    positions,
    resolvedOutcome: outcomeToCourtOutcome(review.outcome),
    winningDecision,
    winningAgentKeys,
    riskVetoApplied: riskVeto,
    reasoning: review.winningReasoning,
  };
}
