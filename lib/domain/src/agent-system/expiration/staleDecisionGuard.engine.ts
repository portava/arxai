// staleDecisionGuard — single switch that says "this council artifact is
// too stale to execute on". Stale critical votes always block execution.

import type { VoteExpirationCheck } from "./voteExpiration.engine";

export interface StaleGuardResult {
  hasStaleVotes: boolean;
  hasStaleCritical: boolean;
  staleAgentIds: string[];
  blockExecution: boolean;
  reason: string;
}

export function staleDecisionGuard(
  checks: ReadonlyArray<VoteExpirationCheck>,
): StaleGuardResult {
  const stale = checks.filter(c => c.expired);
  const staleCritical = stale.filter(c => c.isCritical);
  const staleAgentIds = stale.map(c => c.agentId);
  const blockExecution = staleCritical.length > 0;
  let reason: string;
  if (stale.length === 0) reason = "all votes fresh";
  else if (blockExecution) {
    reason = `${staleCritical.length} critical vote(s) expired — execution blocked: ${staleCritical.map(c => c.agentId).join(", ")}`;
  } else {
    reason = `${stale.length} non-critical vote(s) expired — execution allowed but flagged`;
  }
  return {
    hasStaleVotes: stale.length > 0,
    hasStaleCritical: staleCritical.length > 0,
    staleAgentIds, blockExecution, reason,
  };
}
