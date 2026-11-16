import {
  type AgentVote, type DecisionId, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./dataVault.types";

// ═══════════════════════════════════════════════════════════════════════════
// Agent Vote Store — per-agent ballots cast on a decision. Used for
// confidence calibration ("which agent is right when?"), regime-fit
// analysis, and Trade Court replay.
//
// Composite uniqueness: one vote per (decisionId, agentId). Re-vote
// throws — callers should use a new voteId or recognize that re-voting
// is an audit-relevant action.
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentVoteStorePort {
  append(vote: AgentVote): Promise<void>;
  list(query?: VaultQuery): Promise<AgentVote[]>;
  byDecision(decisionId: DecisionId): Promise<AgentVote[]>;
}

export function createInMemoryAgentVoteStore(): AgentVoteStorePort {
  const votes: AgentVote[] = [];
  const seen = new Set<string>();              // `${decisionId}::${agentId}`
  const voteIds = new Set<string>();           // global voteId uniqueness
  return {
    async append(vote) {
      // voteIds must be globally unique — replay bundles reference them
      // and ambiguity would break replay.
      if (voteIds.has(vote.voteId)) {
        throw new Error(`voteId ${vote.voteId} already exists — voteIds must be globally unique`);
      }
      const key = `${vote.decisionId}::${vote.agentId ?? "_"}`;
      if (seen.has(key)) {
        throw new Error(`vote already exists for decision ${vote.decisionId} by agent ${vote.agentId} — re-vote forbidden`);
      }
      voteIds.add(vote.voteId);
      seen.add(key);
      votes.push(copy(vote));
    },
    async list(query) {
      const q = query ?? {};
      const filtered = votes.map(copy).filter((v) => matchesEnvelope(v, q));
      return applyLimit(filtered, q.limit);
    },
    async byDecision(decisionId) {
      return votes.filter((v) => v.decisionId === decisionId).map(copy);
    },
  };
}

function copy(v: AgentVote): AgentVote {
  return { ...v, reasons: [...v.reasons] };
}
