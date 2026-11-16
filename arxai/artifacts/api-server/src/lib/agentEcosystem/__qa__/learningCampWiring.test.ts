// Agent Ecosystem — Layer 2: Learning Camp wiring integration test.
// Run via:
//   node --import tsx --test src/lib/agentEcosystem/__qa__/learningCampWiring.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:agent-learning-camp`)
//
// Proves the END-TO-END Learning Camp flow that pure-engine tests cannot:
//   1. A poor streak (>=8/10) run through the Promotion Board auto-OPENS a camp
//      record with correction rules derived from the agent's failure tags.
//   2. The board owns the agent-row transition (no double status/count write).
//   3. A repeated sweep does NOT open a duplicate camp (in-progress guard).
//   4. Advancing the stage machine returns the agent SUPERVISED first (PROBATION)
//      and then FULL (ACTIVE), appending an audited lifecycle event each time.
//
// SAFETY / SCOPE: correction only — nothing here trades or touches the 16-gate
// path. Hits the real dev DB; every row uses a TEST_ prefix and is cleaned up
// fail-closed (aborts if the scope looks wrong).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  db, agentsTable, agentPredictionReviewsTable,
  agentLearningCampRecordsTable, agentLifecycleEventsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { runPromotionBoard } from "../promotionLifecycle.js";
import { advanceLearningCamp } from "../learningCamp.js";

const TEST_KEY = `TEST_LCWIRE_${randomUUID().slice(0, 8)}`;

async function cleanup(agentId: number) {
  if (agentId > 0 && TEST_KEY.startsWith("TEST_LCWIRE_")) {
    await db.delete(agentPredictionReviewsTable).where(eq(agentPredictionReviewsTable.agentId, agentId));
    await db.delete(agentLearningCampRecordsTable).where(eq(agentLearningCampRecordsTable.agentId, agentId));
    await db.delete(agentLifecycleEventsTable).where(eq(agentLifecycleEventsTable.agentId, agentId));
    await db.delete(agentsTable).where(eq(agentsTable.id, agentId));
  } else {
    throw new Error("ABORT: refusing cleanup — unexpected test scope");
  }
}

test("poor streak -> board auto-opens camp -> advance returns supervised then full", async () => {
  // ── Seed a throwaway ACTIVE agent (Shadow influence, advisory only) ──────────
  const [agent] = await db.insert(agentsTable).values({
    agentKey: TEST_KEY, name: "Test LC Wiring Agent", role: "TEST",
    department: "TEST", missionStatement: "test", currentStatus: "ACTIVE",
    currentRank: "JUNIOR", currentMode: "SHADOW", authorityWeight: 0,
    liveInfluenceAllowed: false, isCore: false,
  }).returning({ id: agentsTable.id });
  const agentId = agent!.id;

  try {
    // ── Seed 8 poor reviews (grade F + negative delta) carrying failure tags ───
    const penaltySets = [
      ["ignored_sr"], ["no_stop_defined"], ["ignored_sr"], ["unrealistic_target"],
      ["no_stop_defined"], ["late_chase"], ["ignored_sr"], ["overconfident_loss"],
    ];
    for (let i = 0; i < penaltySets.length; i++) {
      await db.insert(agentPredictionReviewsTable).values({
        reviewId: randomUUID(), predictionId: `${TEST_KEY}_p${i}`, agentId,
        reviewType: "OUTCOME", grade: "F", scoreDelta: -1.5,
        realizedOutcome: "LOSS", realizedPnlR: -1,
        penaltyTags: JSON.stringify(penaltySets[i]), rewardTags: "[]", evidence: "{}",
      });
    }

    // ── Promotion Board sweep (scoped to this agent for deterministic blast) ────
    const run = await runPromotionBoard({
      triggeredBy: "ADMIN", triggeredByUserId: 1, agentIds: [agentId],
    });
    assert.equal(run.campsOpened, 1, "board should open exactly one camp");

    const [agentAfter] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
    assert.equal(agentAfter?.currentStatus, "LEARNING_CAMP", "agent moved to LEARNING_CAMP");
    assert.equal(agentAfter?.learningCampCount, 1, "camp count incremented exactly once (no double-write)");

    const camps = await db.select().from(agentLearningCampRecordsTable)
      .where(eq(agentLearningCampRecordsTable.agentId, agentId));
    assert.equal(camps.length, 1, "exactly one camp record created");
    const camp = camps[0]!;
    assert.equal(camp.stage, "FAILURE_REVIEW");
    assert.equal(camp.returnStatus, "IN_PROGRESS");
    const rules = JSON.parse(camp.correctionRules) as string[];
    assert.ok(rules.length > 0, "correction rules derived from failure patterns");
    assert.ok(rules.some((r) => r.includes("support/resistance")), "ignored_sr -> S/R rule present");
    assert.ok(rules.some((r) => r.toLowerCase().includes("invalidation")), "no_stop -> invalidation rule present");

    // ── A repeated sweep must NOT open a duplicate camp (in-progress guard) ─────
    const run2 = await runPromotionBoard({
      triggeredBy: "ADMIN", triggeredByUserId: 1, agentIds: [agentId],
    });
    assert.equal(run2.campsOpened, 0, "no duplicate camp opened while one is in progress");
    const campsAfter2 = await db.select().from(agentLearningCampRecordsTable)
      .where(eq(agentLearningCampRecordsTable.agentId, agentId));
    assert.equal(campsAfter2.length, 1, "still exactly one camp record");

    // ── Advance the stage machine to a SUPERVISED return ───────────────────────
    // FAILURE_REVIEW -> PATTERN_CORRECTION -> REPLAY_TRAINING -> SHADOW_MODE ...
    let r = await advanceLearningCamp({ recordId: camp.recordId, improved: true, triggeredBy: "ADMIN", triggeredByUserId: 1 });
    assert.equal(r.stage, "PATTERN_CORRECTION");
    r = await advanceLearningCamp({ recordId: camp.recordId, improved: true, triggeredBy: "ADMIN", triggeredByUserId: 1 });
    assert.equal(r.stage, "REPLAY_TRAINING");
    r = await advanceLearningCamp({ recordId: camp.recordId, improved: true, triggeredBy: "ADMIN", triggeredByUserId: 1 });
    assert.equal(r.stage, "SHADOW_MODE");
    // ... -> SUPERVISED_RETURN (improved) — agent returns supervised, not full.
    r = await advanceLearningCamp({ recordId: camp.recordId, improved: true, triggeredBy: "ADMIN", triggeredByUserId: 1 });
    assert.equal(r.stage, "SUPERVISED_RETURN");
    assert.equal(r.returnStatus, "RETURNED_SUPERVISED");
    assert.equal(r.terminal, false, "supervised return is not terminal");
    assert.equal(r.agentStatus, "PROBATION", "agent returns under supervision (PROBATION), never straight to a privileged state");

    const [agentSupervised] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
    assert.equal(agentSupervised?.currentStatus, "PROBATION", "agent row reconciled to PROBATION");

    const probationEvents = await db.select().from(agentLifecycleEventsTable)
      .where(and(eq(agentLifecycleEventsTable.agentId, agentId), eq(agentLifecycleEventsTable.action, "PROBATION")));
    assert.ok(probationEvents.length >= 1, "audited lifecycle event appended for supervised return");

    // ── One more improved advance -> FULL_RETURN (terminal) -> agent ACTIVE ─────
    r = await advanceLearningCamp({ recordId: camp.recordId, improved: true, triggeredBy: "ADMIN", triggeredByUserId: 1 });
    assert.equal(r.stage, "FULL_RETURN");
    assert.equal(r.returnStatus, "RETURNED_FULL");
    assert.equal(r.terminal, true, "full return is terminal");
    assert.equal(r.agentStatus, "ACTIVE", "agent restored to ACTIVE on full return");

    const [campFinal] = await db.select().from(agentLearningCampRecordsTable)
      .where(eq(agentLearningCampRecordsTable.recordId, camp.recordId));
    assert.equal(campFinal?.returnStatus, "RETURNED_FULL");
    assert.ok(campFinal?.endedAt != null, "terminal stage stamps endedAt");
  } finally {
    await cleanup(agentId);
  }
});
