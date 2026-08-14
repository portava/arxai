// ── Profit Mission Phase 3 — proposal types + pure review/selection ──────────
//
// PLANNING / ADVISORY ONLY. An AgentProposal is an analysis artifact: a
// structured, read-only record of a setup an agent scouted. The Risk reviewer
// and Execution Judge here are PURE selection logic — they annotate proposals
// (objection / best / no-trade) but create NO draft and NO execution. Strategy
// fields (direction, confidence, entry, SL, TP) originate from the existing
// strategy/scanner engines upstream; this module never re-derives them.

import type { MissionAgentKey } from "./team.js";

export type ProposalDirection = "BUY" | "SELL" | "NONE";
export type ProposalUrgency = "low" | "medium" | "high";
export type ProposalStatus =
  | "proposed" // live, survived risk review, not the single best pick
  | "selected" // the Execution Judge's single best candidate
  | "rejected" // not selected (kept for transparency)
  | "vetoed" // Risk reviewer attached an objection
  | "expired" // past expiry
  | "context_only"; // no actionable edge — context, not a setup

export interface ProposalEntryPlan {
  entryPrice: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
}

export interface ProposalRiskPlan {
  stopLoss: number | null;
  takeProfit: number | null;
  riskAmount: number | null;
  expectedR: number | null;
}

export interface AgentProposal {
  proposalId: string;
  agentKey: MissionAgentKey;
  symbol: string;
  timeframe: string;
  direction: ProposalDirection;
  setupType: string | null;
  confidence: number; // 0..100
  urgency: ProposalUrgency;
  entryPlan: ProposalEntryPlan;
  riskPlan: ProposalRiskPlan;
  reason: string;
  invalidationLevel: string | null;
  warnings: string[];
  marketSnapshot: Record<string, unknown> | null;
  status: ProposalStatus;
  riskObjection: string | null;
  judgeDecision: "best" | "no_trade" | null;
  selectionReason: string | null;
  rejectionReason: string | null;
}

export interface RiskReviewConfig {
  /** Below this confidence the Risk reviewer objects. */
  minConfidence: number;
  /** Below this reward-to-risk the Risk reviewer objects (when R is known). */
  minExpectedR: number;
}

export const DEFAULT_RISK_REVIEW_CONFIG: RiskReviewConfig = {
  minConfidence: 55,
  minExpectedR: 1,
};

/**
 * Pure Risk reviewer. Returns an objection string when the setup endangers
 * capital, else null. Context-only (direction NONE) proposals are never
 * objected to — they carry no setup to protect against. Risk protection
 * outranks opportunity, so the FIRST failing rule wins.
 */
export function assessRiskObjection(
  p: AgentProposal,
  cfg: RiskReviewConfig = DEFAULT_RISK_REVIEW_CONFIG,
): string | null {
  if (p.direction === "NONE") return null;
  if (p.riskPlan.stopLoss === null) {
    return "No protective stop on the setup.";
  }
  if (p.confidence < cfg.minConfidence) {
    return `Conviction ${Math.round(p.confidence)} is below the risk floor of ${cfg.minConfidence}.`;
  }
  if (p.riskPlan.expectedR !== null && p.riskPlan.expectedR < cfg.minExpectedR) {
    return `Reward-to-risk ${p.riskPlan.expectedR.toFixed(2)} is below the ${cfg.minExpectedR}R floor.`;
  }
  return null;
}

export interface JudgeSelection {
  selectedProposalId: string | null;
  decision: "best" | "no_trade";
  reason: string;
}

/**
 * Pure Execution Judge — SELECTION ONLY. Picks the single highest-conviction
 * candidate that has a real direction and survived risk review, breaking ties
 * by the better reward-to-risk. Returns "no_trade" when nothing qualifies.
 * Creates no draft and no execution.
 */
export function selectBestProposal(proposals: readonly AgentProposal[]): JudgeSelection {
  const candidates = proposals.filter(
    (p) =>
      p.direction !== "NONE" &&
      p.status !== "vetoed" &&
      p.riskObjection === null &&
      p.confidence > 0,
  );
  if (candidates.length === 0) {
    return {
      selectedProposalId: null,
      decision: "no_trade",
      reason: "No qualifying setup survived risk review.",
    };
  }
  const best = [...candidates].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const ar = a.riskPlan.expectedR ?? 0;
    const br = b.riskPlan.expectedR ?? 0;
    return br - ar;
  })[0]!;
  return {
    selectedProposalId: best.proposalId,
    decision: "best",
    reason: "Highest-conviction setup that passed risk review.",
  };
}

/**
 * Pure team review: runs the Risk reviewer over every proposal (attaching
 * objections + flipping status to vetoed/context_only) then the Execution Judge
 * to mark the single best candidate. Returns NEW proposal objects (input not
 * mutated) plus the judge's selection. No execution, no draft.
 */
export function reviewProposals(
  proposals: readonly AgentProposal[],
  cfg: RiskReviewConfig = DEFAULT_RISK_REVIEW_CONFIG,
): { proposals: AgentProposal[]; selection: JudgeSelection } {
  // Pass 1 — Risk reviewer.
  const reviewed: AgentProposal[] = proposals.map((p) => {
    if (p.direction === "NONE") {
      return { ...p, status: "context_only" as ProposalStatus, judgeDecision: null };
    }
    const objection = assessRiskObjection(p, cfg);
    if (objection) {
      return {
        ...p,
        status: "vetoed" as ProposalStatus,
        riskObjection: objection,
        rejectionReason: objection,
        judgeDecision: null,
      };
    }
    return { ...p, status: "proposed" as ProposalStatus, riskObjection: null };
  });

  // Pass 2 — Execution Judge selection (selection only).
  const selection = selectBestProposal(reviewed);
  const finalProposals = reviewed.map((p) => {
    if (selection.decision === "best" && p.proposalId === selection.selectedProposalId) {
      return {
        ...p,
        status: "selected" as ProposalStatus,
        judgeDecision: "best" as const,
        selectionReason: selection.reason,
      };
    }
    return p;
  });

  return { proposals: finalProposals, selection };
}
