// Agent stance history — PURE payload adapter (no DB imports).
//
// Split from agentStanceHistory.ts so the offline test lane can prove the
// persisted-payload mapping without a DATABASE_URL.

import type { AgentStanceObservation } from "@workspace/domain/agent-system";

/** PURE — map persisted AGENT_VOTE payloads onto stance observations.
 *  Rows missing any of decisionId/agentId/vote (or with wrong types) are
 *  dropped — garbage never becomes correlation evidence. */
export function stanceObservationsFromVotePayloads(
  payloads: Array<Record<string, unknown> | null | undefined>,
): AgentStanceObservation[] {
  const out: AgentStanceObservation[] = [];
  for (const p of payloads) {
    if (!p) continue;
    const caseId = typeof p["decisionId"] === "string" ? p["decisionId"] : null;
    const agentId = typeof p["agentId"] === "string" ? p["agentId"] : null;
    const stance = typeof p["vote"] === "string" ? p["vote"] : null;
    if (!caseId || !agentId || !stance) continue;
    out.push({ caseId, agentId, stance });
  }
  return out;
}
