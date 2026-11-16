// falseApprovalTracker — flag agents that voted FOR (or STRONG_FOR) with
// material confidence on a trade that ultimately LOST. These are the agents
// that would, unchecked, walk the council into losers.

import type { AgentPerformanceRecord } from "./agentPerformance.types";

export interface FalseApproval {
  agentId: string;
  agentName: string;
  decisionId: string;
  confidence01: number;
  outcome: "LOSS";
  reason: string;
}

const APPROVING_VOTES = new Set(["STRONG_FOR", "FOR"]);
const MIN_CONFIDENCE = 0.55;

export function trackFalseApprovals(
  records: ReadonlyArray<AgentPerformanceRecord>,
): FalseApproval[] {
  return records
    .filter(r => r.outcome === "LOSS"
      && APPROVING_VOTES.has(r.vote)
      && r.confidence01 >= MIN_CONFIDENCE)
    .map(r => ({
      agentId: r.agentId, agentName: r.agentName,
      decisionId: r.decisionId,
      confidence01: r.confidence01, outcome: "LOSS",
      reason: `${r.agentName} voted ${r.vote} @ ${(r.confidence01 * 100).toFixed(0)}% on a losing trade`,
    }));
}

/** Roll-up: per-agent false-approval rate over the supplied window. */
export function falseApprovalRate(
  records: ReadonlyArray<AgentPerformanceRecord>,
): Record<string, { approvals: number; falseApprovals: number; rate01: number }> {
  const out: Record<string, { approvals: number; falseApprovals: number; rate01: number }> = {};
  for (const r of records) {
    if (!APPROVING_VOTES.has(r.vote)) continue;
    const slot = (out[r.agentId] ??= { approvals: 0, falseApprovals: 0, rate01: 0 });
    slot.approvals += 1;
    if (r.outcome === "LOSS" && r.confidence01 >= MIN_CONFIDENCE) slot.falseApprovals += 1;
  }
  for (const k of Object.keys(out)) {
    const s = out[k]!;
    s.rate01 = s.approvals === 0 ? 0 : +(s.falseApprovals / s.approvals).toFixed(4);
  }
  return out;
}
