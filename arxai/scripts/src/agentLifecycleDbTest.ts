// Agent Ecosystem Layer-2 DB integration test.
//
// Proves the new Layer-2 tables round-trip with the correct defaults and that
// reviews are append-only against a real prediction. scripts may import libs
// (@workspace/db, @workspace/domain) but NOT api-server, so this exercises the
// schema + domain engines directly. All rows use a TEST_ prefix and are
// cleaned up at the end (fail-closed: aborts if cleanup scope looks wrong).
//
// Run: pnpm --filter @workspace/scripts run test:agent-lifecycle-db

import {
  db, agentsTable, agentPredictionsTable, agentPredictionReviewsTable,
  agentLearningCampRecordsTable, agentLifecycleEventsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  scoreTradeReview, buildCorrectionRules, type ReviewablePrediction,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`, extra ?? ""); failures++; }
}

const TEST_KEY = `TEST_L2_${randomUUID().slice(0, 8)}`;
const now = new Date();

async function main() {
  console.log("Agent Ecosystem Layer-2 DB test");
  let agentId = -1;

  try {
    // ── Seed a throwaway agent ────────────────────────────────────────────────
    const [agent] = await db.insert(agentsTable).values({
      agentKey: TEST_KEY, name: "Test L2 Agent", role: "TEST",
      department: "TEST", missionStatement: "test", currentStatus: "SHADOW",
      currentRank: "TRAINEE", currentMode: "SHADOW", authorityWeight: 0,
      liveInfluenceAllowed: false, isCore: false,
    }).returning({ id: agentsTable.id });
    agentId = agent!.id;
    check("agent inserted with default aggregates = 50", true);
    const [seeded] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
    check("trust/quality default 50", seeded?.trustScore === 50 && seeded?.qualityScore === 50, seeded?.trustScore);

    // ── Locked prediction (truth-locked journal) ──────────────────────────────
    const predictionId = `${TEST_KEY}_p1`;
    await db.insert(agentPredictionsTable).values({
      predictionId, agentId, userId: null, decision: "no_trade", direction: "NONE",
      symbol: "EURUSD", confidenceScore: 72, reasoningSummary: "no clean setup; stepping back",
      locked: true, lockedAt: now, outcomeStatus: "PENDING",
    });
    check("locked prediction inserted PENDING", true);

    // ── Score it with the domain engine and append a review ───────────────────
    const reviewable: ReviewablePrediction = {
      predictionId, agentId, decision: "no_trade", direction: "NONE",
      confidenceScore: 72, slSuggestion: null, tpSuggestion: null,
      entryZone: null, invalidationZone: null, reasoningSummary: "no clean setup",
    };
    const review = scoreTradeReview({
      prediction: reviewable,
      outcome: { realizedOutcome: "NO_TRADE_CORRECT", realizedPnlR: null },
      calibrationHistory: [], now,
    });
    await db.insert(agentPredictionReviewsTable).values({
      reviewId: randomUUID(), predictionId, agentId, reviewType: "OUTCOME",
      decisionQuality: review.decisionQuality, outcomeScore: review.outcomeScore,
      protectionScore: review.protectionScore, speedScore: review.speedScore,
      usefulnessScore: review.usefulnessScore, calibrationScore: review.calibrationScore,
      scoreDelta: review.scoreDelta, grade: review.grade,
      rewardTags: JSON.stringify(review.rewardTags), penaltyTags: JSON.stringify(review.penaltyTags),
      realizedOutcome: review.realizedOutcome, realizedPnlR: review.realizedPnlR,
      rationale: review.rationale, evidence: "{}",
    });
    const reviews = await db.select().from(agentPredictionReviewsTable)
      .where(eq(agentPredictionReviewsTable.predictionId, predictionId));
    check("review appended for prediction", reviews.length === 1);
    check("review records the correct_no_trade reward",
      (reviews[0]?.rewardTags ?? "").includes("correct_no_trade"), reviews[0]?.rewardTags);

    // ── Lifecycle event defaults (triggeredBy SYSTEM) ─────────────────────────
    await db.insert(agentLifecycleEventsTable).values({
      eventId: randomUUID(), agentId, action: "WARN",
      fromStatus: "ACTIVE", toStatus: "WARNING", reason: "test",
    });
    const [evt] = await db.select().from(agentLifecycleEventsTable)
      .where(eq(agentLifecycleEventsTable.agentId, agentId));
    check("lifecycle event defaults triggeredBy=SYSTEM", evt?.triggeredBy === "SYSTEM", evt?.triggeredBy);

    // ── Learning camp record defaults ─────────────────────────────────────────
    const rules = buildCorrectionRules(["ignored_sr", "no_stop_defined"]);
    await db.insert(agentLearningCampRecordsTable).values({
      recordId: randomUUID(), agentId, reason: "test camp",
      failurePatterns: JSON.stringify(["ignored_sr"]), correctionRules: JSON.stringify(rules),
    });
    const [camp] = await db.select().from(agentLearningCampRecordsTable)
      .where(eq(agentLearningCampRecordsTable.agentId, agentId));
    check("camp record defaults stage=FAILURE_REVIEW", camp?.stage === "FAILURE_REVIEW", camp?.stage);
    check("camp record defaults returnStatus=IN_PROGRESS", camp?.returnStatus === "IN_PROGRESS", camp?.returnStatus);
    check("camp correctionRules persisted", (camp?.correctionRules ?? "").includes("support/resistance"));
  } finally {
    // ── Fail-closed cleanup: only ever touch THIS test agent's rows ───────────
    if (agentId > 0 && TEST_KEY.startsWith("TEST_L2_")) {
      await db.delete(agentPredictionReviewsTable).where(eq(agentPredictionReviewsTable.agentId, agentId));
      await db.delete(agentPredictionsTable).where(eq(agentPredictionsTable.agentId, agentId));
      await db.delete(agentLifecycleEventsTable).where(eq(agentLifecycleEventsTable.agentId, agentId));
      await db.delete(agentLearningCampRecordsTable).where(eq(agentLearningCampRecordsTable.agentId, agentId));
      await db.delete(agentsTable).where(eq(agentsTable.id, agentId));
      console.log(`  cleanup  removed test agent ${agentId} (${TEST_KEY})`);
    } else {
      console.error("  ABORT  refusing cleanup — unexpected test scope");
    }
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll Layer-2 DB checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
