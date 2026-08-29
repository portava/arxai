// Agent stance history — evidence-diversity input for the council.
//
// The council already persists one AGENT_VOTE audit event per agent per
// decision (routes/agents.ts → shadowCapture). This module reads those
// PERSISTED records back into per-agent stance observations and derives the
// evidence-diversity weights (correlated agents discounted toward one vote).
//
// FAIL-OPEN TO NO DISCOUNT: any read failure, or too little shared history,
// yields null — the council then runs with the classic unadjusted score.
// Absence of evidence of correlation is never treated as correlation, and the
// discount itself can only ADD disagreement (enforced in the domain engine).

import { desc, eq } from "drizzle-orm";
import { db, auditEventsTable } from "@workspace/db";
import {
  computePairwiseAgreements,
  deriveDiversityWeights,
  type DiversityWeights,
} from "@workspace/domain/agent-system";
import { logger } from "./logger.js";
import { stanceObservationsFromVotePayloads } from "./agentStanceHistoryPolicy.js";

export { stanceObservationsFromVotePayloads };

/** How many recent AGENT_VOTE rows to fold into the agreement estimate. */
const MAX_VOTE_EVENTS = 3_000;

/**
 * Derive diversity weights from the persisted council vote history.
 * Returns null (no discount) when history is unreadable or too thin.
 */
export async function loadCouncilDiversityWeights(): Promise<DiversityWeights | null> {
  try {
    const rows = await db
      .select({ payload: auditEventsTable.payload })
      .from(auditEventsTable)
      .where(eq(auditEventsTable.eventType, "AGENT_VOTE"))
      .orderBy(desc(auditEventsTable.id))
      .limit(MAX_VOTE_EVENTS);
    const observations = stanceObservationsFromVotePayloads(
      rows.map((r) => r.payload as Record<string, unknown> | null),
    );
    if (observations.length === 0) return null;
    const weights = deriveDiversityWeights(computePairwiseAgreements(observations));
    return weights.clusters.length > 0 ? weights : null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "agent stance history unreadable — council runs without diversity discount (fail-open to no discount)",
    );
    return null;
  }
}
