// blockerHierarchy — rank concrete blockers (per-agent objections) by
// (a) authority level descending, (b) critical-flag, (c) order seen.
// The result is a deterministic, queryable ranking used by the audit log
// and the explanation surface.

import type { AgentCouncilVote } from "../agentVote.types";
import {
  type AuthorityLevel, type AuthorityDecision,
} from "../authority/agentAuthority.types";

export interface RankedBlocker {
  rank: number;
  agentId: string;
  agentName: string;
  authorityLevel: AuthorityLevel;
  isCritical: boolean;
  severity: "DANGER" | "WARN";
  reason: string;
}

export function rankBlockers(
  votes: ReadonlyArray<AgentCouncilVote>,
  authorities: ReadonlyArray<AuthorityDecision>,
): RankedBlocker[] {
  const authById = new Map(authorities.map(a => [a.agentId, a]));
  const raw: Array<Omit<RankedBlocker, "rank">> = [];

  for (const v of votes) {
    const auth = authById.get(v.agentId);
    const lvl = auth?.authorityLevel ?? 1;
    for (const reason of v.blockers) {
      raw.push({
        agentId: v.agentId, agentName: v.agentName,
        authorityLevel: lvl,
        isCritical: v.isCritical,
        severity: v.isCritical ? "DANGER" : "WARN",
        reason,
      });
    }
  }

  raw.sort((a, b) => {
    if (a.authorityLevel !== b.authorityLevel) return b.authorityLevel - a.authorityLevel;
    if (a.isCritical !== b.isCritical) return a.isCritical ? -1 : +1;
    return 0;
  });

  return raw.map((r, i) => ({ rank: i + 1, ...r }));
}
