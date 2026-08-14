// Agent Ecosystem — Layer 2: Learning Camp management (wiring).
//
// Opens a Learning Camp record for a struggling agent (correction, not
// deletion) and advances it through the supervised stage machine. PURE stage
// logic lives in the domain engine; this layer only persists rows.
//
// SAFETY / SCOPE:
//   - OBSERVATION / CORRECTION ONLY. Never trades, never touches the 16-gate
//     path. An agent in camp keeps authorityWeight handling to the Promotion
//     Board; this module does not grant live influence.

import {
  db, agentLearningCampRecordsTable, agentsTable, agentLifecycleEventsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  buildCorrectionRules, nextCampStage, returnStatusForStage, isTerminalStage,
  type CampStage,
} from "@workspace/domain/agent-system";

/** True when the agent already has an open (IN_PROGRESS) camp record — used to
 *  keep repeated Promotion-Board sweeps from opening duplicate records. */
export async function hasOpenLearningCamp(agentId: number): Promise<boolean> {
  const [open] = await db.select({ id: agentLearningCampRecordsTable.id })
    .from(agentLearningCampRecordsTable)
    .where(and(
      eq(agentLearningCampRecordsTable.agentId, agentId),
      eq(agentLearningCampRecordsTable.returnStatus, "IN_PROGRESS"),
    ))
    .limit(1);
  return open != null;
}

/** Open a Learning Camp record for an agent. Returns the created recordId.
 *
 *  When `skipAgentUpdate` is true the caller (e.g. the Promotion Board runner)
 *  owns the agents-row transition + lifecycle event, so this only writes the
 *  camp record and does NOT touch the agent row (avoids a double status/count
 *  update). When false (a direct caller) it reflects LEARNING_CAMP status +
 *  increments the camp count on the agent itself. */
export async function openLearningCamp(args: {
  agentId: number;
  reason: string;
  failurePatterns?: string[];
  trainingExamples?: string[];
  skipAgentUpdate?: boolean;
}): Promise<{ recordId: string; correctionRules: string[] }> {
  const recordId = randomUUID();
  const failurePatterns = args.failurePatterns ?? [];
  const correctionRules = buildCorrectionRules(failurePatterns);
  const now = new Date();

  await db.insert(agentLearningCampRecordsTable).values({
    recordId,
    agentId: args.agentId,
    reason: args.reason,
    failurePatterns: JSON.stringify(failurePatterns),
    correctionRules: JSON.stringify(correctionRules),
    trainingExamples: JSON.stringify(args.trainingExamples ?? []),
    stage: "FAILURE_REVIEW",
    returnStatus: "IN_PROGRESS",
  });

  // Reflect camp status + count on the agent (advisory only) unless the caller
  // already owns the agent-row transition.
  if (!args.skipAgentUpdate) {
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, args.agentId)).limit(1);
    if (agent) {
      await db.update(agentsTable).set({
        currentStatus: "LEARNING_CAMP",
        learningCampCount: (agent.learningCampCount ?? 0) + 1,
        updatedAt: now,
      }).where(eq(agentsTable.id, args.agentId));
    }
  }

  return { recordId, correctionRules };
}

// When a camp stage produces a (return/terminal) outcome, the agent itself moves
// back out of LEARNING_CAMP into the matching advisory status. A return is
// always supervised first (PROBATION) — never straight to a privileged state —
// and authority weight is left to the Promotion Board (never raised here).
const CAMP_STAGE_TO_AGENT_STATUS: Partial<Record<CampStage, { status: string; action: string }>> = {
  SUPERVISED_RETURN:   { status: "PROBATION", action: "PROBATION" },
  FULL_RETURN:         { status: "ACTIVE", action: "PROMOTE" },
  FURTHER_RESTRICTION: { status: "RESTRICTED", action: "RESTRICT" },
};

/** Advance an in-progress camp record one stage based on observed improvement.
 *  On a return/terminal stage the agent is moved out of LEARNING_CAMP into the
 *  matching advisory status (supervised first) and an audited lifecycle event is
 *  appended. Authority weight is never raised here — that stays with the Board. */
export async function advanceLearningCamp(args: {
  recordId: string;
  improved: boolean;
  performanceAfterReturn?: number | null;
  triggeredBy?: "SYSTEM" | "ADMIN";
  triggeredByUserId?: number | null;
}): Promise<{ stage: CampStage; returnStatus: string; terminal: boolean; agentStatus?: string }> {
  const [rec] = await db.select().from(agentLearningCampRecordsTable)
    .where(eq(agentLearningCampRecordsTable.recordId, args.recordId)).limit(1);
  if (!rec) throw new Error("LEARNING_CAMP_RECORD_NOT_FOUND");

  const next = nextCampStage(rec.stage as CampStage, args.improved);
  const returnStatus = returnStatusForStage(next);
  const terminal = isTerminalStage(next);
  const now = new Date();

  await db.update(agentLearningCampRecordsTable).set({
    stage: next,
    returnStatus,
    performanceAfterReturn: args.performanceAfterReturn ?? rec.performanceAfterReturn,
    endedAt: terminal ? now : null,
    updatedAt: now,
  }).where(eq(agentLearningCampRecordsTable.recordId, args.recordId));

  // Reconcile the agent's advisory status when the stage yields a return/outcome.
  let agentStatus: string | undefined;
  const transition = CAMP_STAGE_TO_AGENT_STATUS[next];
  if (transition) {
    const [agent] = await db.select().from(agentsTable)
      .where(eq(agentsTable.id, rec.agentId)).limit(1);
    if (agent) {
      agentStatus = transition.status;
      await db.update(agentsTable).set({
        currentStatus: transition.status,
        updatedAt: now,
      }).where(eq(agentsTable.id, rec.agentId));
      await db.insert(agentLifecycleEventsTable).values({
        eventId: randomUUID(),
        agentId: rec.agentId,
        action: transition.action,
        triggeredBy: args.triggeredBy ?? "SYSTEM",
        triggeredByUserId: args.triggeredByUserId ?? null,
        fromStatus: agent.currentStatus ?? "LEARNING_CAMP",
        toStatus: transition.status,
        fromRank: agent.currentRank ?? null,
        toRank: agent.currentRank ?? null,
        authorityWeightBefore: agent.authorityWeight ?? 0,
        authorityWeightAfter: agent.authorityWeight ?? 0,
        reason: `Learning Camp ${next} (${returnStatus})`,
      });
    }
  }

  return { stage: next, returnStatus, terminal, agentStatus };
}

/** List camp records, optionally scoped to one agent (newest first). */
export async function listLearningCampRecords(agentId?: number) {
  if (agentId != null) {
    return db.select().from(agentLearningCampRecordsTable)
      .where(eq(agentLearningCampRecordsTable.agentId, agentId))
      .orderBy(desc(agentLearningCampRecordsTable.createdAt));
  }
  return db.select().from(agentLearningCampRecordsTable)
    .orderBy(desc(agentLearningCampRecordsTable.createdAt));
}
