// Agent Ecosystem — Layer 2: Promotion Board lifecycle runner (wiring).
//
// For every non-archived agent, reads its recent reviews, asks the PURE domain
// engine for a recommended transition, applies the advisory-only changes
// (status / rank / authority weight), and appends a lifecycle event row.
//
// SAFETY / SCOPE:
//   - OBSERVATION / GOVERNANCE ONLY. Authority weight is advisory ranking, never
//     a live-execution input. Nothing here trades or touches the 16-gate path.
//   - liveInfluenceAllowed is NEVER flipped here — only an admin can grant live
//     influence (a later layer). The board can recommend, not unlock.
//   - Full shutdown (ARCHIVED) is admin-only: an automatic run may only set
//     status SHUTDOWN_RECOMMENDED, never archive an agent.

import {
  db, agentsTable, agentPredictionReviewsTable, agentLifecycleEventsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  evaluateAgentLifecycle,
  type AgentLifecycleStatus, type AgentRank, type ReviewSummary,
  type CouncilAgentGrade,
} from "@workspace/domain/agent-system";
import { openLearningCamp, hasOpenLearningCamp } from "./learningCamp.js";

export interface PromotionRunResult {
  agentsEvaluated: number;
  transitions: number;
  shutdownRecommended: number;
  campsOpened: number;
}

/** Aggregate the penalty tags across recent reviews into a de-duped, frequency
 *  ordered list of failure patterns Learning Camp turns into correction rules. */
function failurePatternsFromReviews(penaltyTagJson: Array<string | null>): string[] {
  const counts = new Map<string, number>();
  for (const raw of penaltyTagJson) {
    if (!raw) continue;
    let tags: unknown;
    try { tags = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(tags)) continue;
    for (const t of tags) {
      if (typeof t === "string" && t.length > 0) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/**
 * Run the Promotion Board across all active agents. `triggeredBy` distinguishes
 * an automatic SYSTEM sweep from an ADMIN-initiated one (audited separately by
 * the caller). Returns counts.
 */
export async function runPromotionBoard(opts: {
  triggeredBy?: "SYSTEM" | "ADMIN";
  triggeredByUserId?: number;
  reviewsPerAgent?: number;
  agentIds?: number[];
} = {}): Promise<PromotionRunResult> {
  const triggeredBy = opts.triggeredBy ?? "SYSTEM";
  const window = opts.reviewsPerAgent ?? 100;
  const now = new Date();

  // Default: every non-archived agent. An optional agentIds scope lets a caller
  // re-evaluate specific agents only (preserves blast radius; default unchanged).
  const agentScope = opts.agentIds && opts.agentIds.length > 0
    ? and(isNull(agentsTable.archivedAt), inArray(agentsTable.id, opts.agentIds))
    : isNull(agentsTable.archivedAt);
  const agents = await db.select().from(agentsTable).where(agentScope);
  let transitions = 0, shutdownRecommended = 0, campsOpened = 0;

  for (const agent of agents) {
    const reviewRows = await db
      .select({
        grade: agentPredictionReviewsTable.grade,
        scoreDelta: agentPredictionReviewsTable.scoreDelta,
        penaltyTags: agentPredictionReviewsTable.penaltyTags,
      })
      .from(agentPredictionReviewsTable)
      .where(eq(agentPredictionReviewsTable.agentId, agent.id))
      .orderBy(desc(agentPredictionReviewsTable.createdAt))
      .limit(window);

    if (reviewRows.length === 0) continue; // nothing to judge yet

    const reviews: ReviewSummary[] = reviewRows.map((r) => ({
      grade: (r.grade ?? "C") as CouncilAgentGrade,
      scoreDelta: r.scoreDelta ?? 0,
    }));

    const evalResult = evaluateAgentLifecycle({
      currentStatus: (agent.currentStatus ?? "ACTIVE") as AgentLifecycleStatus,
      currentRank: (agent.currentRank ?? "TRAINEE") as AgentRank,
      currentAuthorityWeight: agent.authorityWeight ?? 0,
      liveInfluenceAllowed: agent.liveInfluenceAllowed ?? false,
      reviews,
    });

    if (evalResult.action === "HOLD") continue;

    // An automatic run never archives (full shutdown is admin-only). It may set
    // SHUTDOWN_RECOMMENDED as a flag for the admin to act on.
    const newStatus = evalResult.recommendedStatus;
    if (newStatus === "SHUTDOWN_RECOMMENDED") shutdownRecommended++;

    const before = {
      status: agent.currentStatus, rank: agent.currentRank, weight: agent.authorityWeight,
    };

    // NOTE: liveInfluenceAllowed is intentionally NOT in this set.
    const learningCampCount = (agent.learningCampCount ?? 0) + (evalResult.action === "LEARNING_CAMP" ? 1 : 0);
    const shutdownWarningCount = (agent.shutdownWarningCount ?? 0) +
      (evalResult.action === "WARN" || evalResult.action === "PROBATION" || evalResult.action === "SHUTDOWN_RECOMMEND" ? 1 : 0);

    await db.update(agentsTable).set({
      currentStatus: newStatus,
      currentRank: evalResult.recommendedRank,
      authorityWeight: evalResult.recommendedAuthorityWeight,
      learningCampCount,
      shutdownWarningCount,
      updatedAt: now,
    }).where(eq(agentsTable.id, agent.id));

    await db.insert(agentLifecycleEventsTable).values({
      eventId: randomUUID(),
      agentId: agent.id,
      action: evalResult.action,
      triggeredBy,
      triggeredByUserId: opts.triggeredByUserId ?? null,
      fromStatus: before.status,
      toStatus: newStatus,
      fromRank: before.rank,
      toRank: evalResult.recommendedRank,
      authorityWeightBefore: before.weight,
      authorityWeightAfter: evalResult.recommendedAuthorityWeight,
      poorRecent: evalResult.poorRecent,
      reason: evalResult.reasons.join("; "),
    });
    transitions++;

    // On a LEARNING_CAMP transition, open a camp record (correction, not
    // deletion) with correction rules derived from the agent's recent failure
    // tags. The runner owns the agent-row transition above, so skipAgentUpdate
    // prevents a double status/count write. Guard against duplicate records:
    // only open if the agent has no in-progress camp already.
    if (evalResult.action === "LEARNING_CAMP" && !(await hasOpenLearningCamp(agent.id))) {
      const failurePatterns = failurePatternsFromReviews(reviewRows.map((r) => r.penaltyTags));
      await openLearningCamp({
        agentId: agent.id,
        reason: evalResult.reasons.join("; ") || "Promotion Board: poor-streak threshold reached",
        failurePatterns,
        skipAgentUpdate: true,
      });
      campsOpened++;
    }
  }

  return { agentsEvaluated: agents.length, transitions, shutdownRecommended, campsOpened };
}
