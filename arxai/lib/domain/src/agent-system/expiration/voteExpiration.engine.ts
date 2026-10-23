// voteExpiration — checks whether each agent council vote has passed its TTL.
// Stale votes are still surfaced for transparency but cannot drive a live
// EXECUTE decision (see staleDecisionGuard.engine).

import type { AgentCouncilVote } from "../agentVote.types";

export interface VoteExpirationCheck {
  agentId: string;
  agentName: string;
  isCritical: boolean;
  expiresAtIso: string;
  ageMs: number;
  expired: boolean;
  reason: string;
}

export function checkVoteExpiration(
  votes: ReadonlyArray<AgentCouncilVote>,
  now: Date,
): VoteExpirationCheck[] {
  const nowMs = now.getTime();
  return votes.map((v) => {
    const expMs = Date.parse(v.expiresAtIso);
    const ageMs = Math.max(0, nowMs - expMs);
    const expired = nowMs > expMs;
    return {
      agentId: v.agentId, agentName: v.agentName,
      isCritical: v.isCritical, expiresAtIso: v.expiresAtIso,
      ageMs, expired,
      reason: expired
        ? `vote expired ${ageMs}ms ago`
        : `vote valid for another ${-ageMs}ms`,
    };
  });
}

/** Quickly summarise how many critical votes are stale. */
export function staleCriticalCount(checks: ReadonlyArray<VoteExpirationCheck>): number {
  return checks.filter(c => c.expired && c.isCritical).length;
}
