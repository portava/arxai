// ── Profit Mission Phase 5 — Opportunity Router & Queue (pure ranking) ──────
//
// PLANNING / ADVISORY ONLY. The router takes the scouted + debated proposals,
// scores each with the Edge Engine, and ranks them by RISK-ADJUSTED MISSION FIT
// — never by raw confidence. It surfaces a single best candidate plus an ordered
// queue, and returns a "wait" decision when no candidate reaches the actionable
// A/B band.
//
// Discipline contract:
//   - NEVER takes the first weak trade: candidates are sorted by edge standing,
//     so a later A-tier beats an earlier C-tier; if nothing is A/B, the decision
//     is `wait` (not "force the best of a bad set").
//   - Edge standing is already risk-adjusted (the Edge Engine folds reward-to-
//     risk, penalties, and honest caps into the score), so ranking by it — not by
//     confidence — is the risk-adjusted mission fit.
//   - Records the opportunity cost of every candidate (gap to the best) so the
//     reviewer can see what is given up by acting on anything but the leader.
//
// PURE + DETERMINISTIC + IO-FREE.

import type { ProposalDirection } from "./agents/proposal.js";
import { type EdgeScore } from "./edgeEngine.js";

export interface RouterCandidate {
  proposalId: string;
  agentKey: string;
  symbol: string;
  timeframe: string;
  direction: ProposalDirection;
  edge: EdgeScore;
  /** Reward-to-risk of the planned setup (advisory; tiebreak only). */
  expectedR?: number | null;
  /** Estimated $ contribution toward remaining mission profit (advisory). */
  estimatedProfitContribution?: number | null;
  /** Planned $ at risk (advisory; used for the risk-adjusted display metric). */
  riskAmount?: number | null;
}

export interface RouterMissionContext {
  /** Remaining $ profit needed to reach the mission target. */
  remainingProfit: number;
  /** Required go-forward daily pace ($/day) from mission math. */
  requiredDailyProfit: number;
}

export interface RankedOpportunity {
  candidate: RouterCandidate;
  /** 1-based position in the ordered queue. */
  rank: number;
  /** Risk-adjusted display metric (edge standing scaled by reward-to-risk). */
  riskAdjustedScore: number;
  /** Advisory fit: how much of the required daily pace this could cover (0..1+). */
  missionFit: number;
  /** Only A+/A/B candidates from a trusted feed are actionable. */
  actionable: boolean;
  /** Score gap to the best actionable opportunity (0 for the best). */
  opportunityCost: number;
  reasons: string[];
}

export type OpportunityDecision = "act" | "wait";

export interface OpportunityQueue {
  decision: OpportunityDecision;
  /** The single best actionable opportunity, or null when the decision is wait. */
  best: RankedOpportunity | null;
  /** Full ordered queue (actionable first, then flagged-skip context rows). */
  queue: RankedOpportunity[];
  /** Honest machine reason when waiting (e.g. "NO_ACTIONABLE_EDGE"). */
  waitReason: string | null;
  /** Runner-up actionable score forgone by acting on the best (0 if none). */
  bestAlternativeForgone: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Risk-adjusted display metric: edge standing scaled by reward-to-risk. */
function riskAdjusted(edgeScore: number, expectedR: number | null | undefined): number {
  const r = expectedR != null && Number.isFinite(expectedR) && expectedR > 0 ? expectedR : 1;
  // R=2 → ×1.0, R=3 → ×1.25, R=1 → ×0.75. Bounded so it tiebreaks, not dominates.
  const factor = clamp(0.5 + r / 4, 0.5, 1.5);
  return round1(edgeScore * factor);
}

/**
 * Rank candidates into an opportunity queue + a single best (or "wait"). Pure.
 * Sorting is stable + deterministic: actionable first, then by edge score, then
 * the risk-adjusted metric, then reward-to-risk, then proposalId.
 */
export function routeOpportunities(
  candidates: readonly RouterCandidate[],
  mission: RouterMissionContext,
): OpportunityQueue {
  if (candidates.length === 0) {
    return { decision: "wait", best: null, queue: [], waitReason: "NO_CANDIDATES", bestAlternativeForgone: 0 };
  }

  const requiredPace = Number.isFinite(mission.requiredDailyProfit) && mission.requiredDailyProfit > 0
    ? mission.requiredDailyProfit
    : 0;

  const enriched = candidates.map((candidate) => {
    const edgeScore = candidate.edge.finalEdgeScore;
    const actionable = candidate.edge.actionable;
    const ras = riskAdjusted(edgeScore, candidate.expectedR);
    const contribution = candidate.estimatedProfitContribution != null && Number.isFinite(candidate.estimatedProfitContribution)
      ? Number(candidate.estimatedProfitContribution)
      : 0;
    const missionFit = requiredPace > 0 ? round1(clamp(contribution / requiredPace, 0, 5) * 100) / 100 : 0;
    const reasons: string[] = [];
    reasons.push(candidate.edge.reason);
    if (!actionable && !candidate.edge.contextOnly && !candidate.edge.blocked) {
      reasons.push(`Tier ${candidate.edge.tier} is below the actionable A/B floor — skip, do not force.`);
    }
    return { candidate, edgeScore, actionable, riskAdjustedScore: ras, missionFit, reasons };
  });

  enriched.sort((a, b) => {
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    if (b.edgeScore !== a.edgeScore) return b.edgeScore - a.edgeScore;
    if (b.riskAdjustedScore !== a.riskAdjustedScore) return b.riskAdjustedScore - a.riskAdjustedScore;
    const ar = a.candidate.expectedR ?? 0;
    const br = b.candidate.expectedR ?? 0;
    if (br !== ar) return br - ar;
    return a.candidate.proposalId.localeCompare(b.candidate.proposalId);
  });

  const actionableRows = enriched.filter((e) => e.actionable);
  const topScore = actionableRows.length > 0 ? actionableRows[0]!.edgeScore : 0;
  const secondScore = actionableRows.length > 1 ? actionableRows[1]!.edgeScore : 0;

  const queue: RankedOpportunity[] = enriched.map((e, i) => ({
    candidate: e.candidate,
    rank: i + 1,
    riskAdjustedScore: e.riskAdjustedScore,
    missionFit: e.missionFit,
    actionable: e.actionable,
    // Opportunity cost = how far below the best actionable this row sits.
    opportunityCost: e.actionable ? round1(Math.max(0, topScore - e.edgeScore)) : round1(topScore),
    reasons: e.reasons,
  }));

  if (actionableRows.length === 0) {
    return {
      decision: "wait",
      best: null,
      queue,
      waitReason: "NO_ACTIONABLE_EDGE",
      bestAlternativeForgone: 0,
    };
  }

  return {
    decision: "act",
    best: queue[0] ?? null,
    queue,
    waitReason: null,
    bestAlternativeForgone: round1(Math.max(0, secondScore)),
  };
}
