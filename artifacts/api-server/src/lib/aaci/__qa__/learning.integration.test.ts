// AACI Learning — persistence + lifecycle integration tests (Task #232, Phase 6).
//
// The sibling `learning.test.ts` covers the PURE domain math. This suite covers
// the behaviours the math tests cannot: that REAL reconciled evidence folds into
// per-entity trust across every dimension the evidence supports, that an audit
// row is written per applied change, that re-ingestion is idempotent (no double
// count), and that the admin change lifecycle (propose recommend-only → approve,
// with a CAS guard against a double-approve race) is correct against the real DB.
//
// These tests touch the real database (DATABASE_URL). Every row they create is
// uniquely keyed and removed in a finally block so they never leak fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  selfTradeAgentsTable,
  selfTradeDecisionsTable,
  selfTradeAgentExecutionsTable,
  aaciLearningAuditTable,
  aaciTrustScoresTable,
  aaciAdaptiveWeightsTable,
} from "@workspace/db";
import { ingestAgentOutcomes } from "../learning/outcomeIngestion.js";
import {
  proposeWeightChange,
  approveWeightChange,
} from "../learning/weightService.js";
import { countLearningChanges } from "../learning/learningAudit.js";

const TAG = `qa-aaci-int-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test("ingest folds REAL evidence into every supported entity dimension, audited once each", async () => {
  const agentKey = `${TAG}-agent`;
  const symbol = `${TAG}-SYM`;
  const setupType = `${TAG}-BOS`;
  const timeframe = "M15";
  const sourceRefs: string[] = [];
  const entityKeys = [agentKey, symbol, setupType, timeframe];

  let agentId = 0;
  try {
    const [agent] = await db
      .insert(selfTradeAgentsTable)
      .values({ agentKey, name: `${TAG} agent`, profileTemplate: "ALPHA" })
      .returning();
    agentId = agent!.id;

    const [decision] = await db
      .insert(selfTradeDecisionsTable)
      .values({
        agentId,
        agentKey,
        cycleId: `${TAG}-cycle`,
        symbol,
        timeframe,
        outcome: "TRADE",
        setupType,
        confidence: 0.85, // a GOOD decision → a win is rewarded (not luck)
        plannedAction: "BUY",
        reason: "qa fixture",
      })
      .returning();

    const [exec] = await db
      .insert(selfTradeAgentExecutionsTable)
      .values({
        agentId,
        agentKey,
        decisionId: decision!.id,
        symbol,
        side: "BUY",
        idempotencyKey: `${TAG}-idem`,
        status: "CLOSED",
        realizedPnl: 18.4, // real close fill, a win
      })
      .returning();
    sourceRefs.push(`exec:${exec!.id}`);

    // First ingest: agent + symbol + strategy(setupType) + timeframe all move.
    const first = await ingestAgentOutcomes(agentId, null);
    assert.equal(first.scanned, 1, "exactly one closed execution scanned");
    assert.equal(first.applied, 4, "all four real dimensions folded");

    const touchedTypes = first.touchedEntities.map((e) => e.entityType).sort();
    assert.deepEqual(
      touchedTypes,
      ["agent", "strategy", "symbol", "timeframe"],
      "drift re-eval set spans every evidence-backed dimension, not just symbol",
    );

    // One TRUST_UPDATE audit row per dimension, keyed by the execution sourceRef.
    const auditRows = await db
      .select({ id: aaciLearningAuditTable.id, entityType: aaciLearningAuditTable.entityType })
      .from(aaciLearningAuditTable)
      .where(
        and(
          eq(aaciLearningAuditTable.changeType, "TRUST_UPDATE"),
          inArray(aaciLearningAuditTable.sourceRef, sourceRefs),
        ),
      );
    assert.equal(auditRows.length, 4, "one audit row written per applied change");

    // Second ingest: idempotent — nothing re-applies, no new audit rows.
    const second = await ingestAgentOutcomes(agentId, null);
    assert.equal(second.applied, 0, "re-ingest applies nothing (idempotent)");
    assert.equal(second.touchedEntities.length, 0, "no entities move on re-ingest");

    const auditAfter = await db
      .select({ id: aaciLearningAuditTable.id })
      .from(aaciLearningAuditTable)
      .where(
        and(
          eq(aaciLearningAuditTable.changeType, "TRUST_UPDATE"),
          inArray(aaciLearningAuditTable.sourceRef, sourceRefs),
        ),
      );
    assert.equal(auditAfter.length, 4, "idempotent re-ingest writes no extra audit rows");
  } finally {
    // Clean up in FK-safe order. Trust + audit rows are normally immutable
    // safety evidence; here they belong to a uniquely-tagged QA entity only.
    await db.delete(aaciTrustScoresTable).where(inArray(aaciTrustScoresTable.entityKey, entityKeys));
    if (sourceRefs.length > 0) {
      await db.delete(aaciLearningAuditTable).where(inArray(aaciLearningAuditTable.sourceRef, sourceRefs));
    }
    await db.delete(aaciLearningAuditTable).where(inArray(aaciLearningAuditTable.entityKey, entityKeys));
    if (agentId) {
      await db.delete(selfTradeAgentExecutionsTable).where(eq(selfTradeAgentExecutionsTable.agentId, agentId));
      await db.delete(selfTradeDecisionsTable).where(eq(selfTradeDecisionsTable.agentId, agentId));
      await db.delete(selfTradeAgentsTable).where(eq(selfTradeAgentsTable.id, agentId));
    }
  }
});

test("a MAJOR change is recommend-only and a double-approve is CAS-guarded (applied exactly once)", async () => {
  const weightKey = `${TAG}-weight`;
  const adminUserId = 999_000_001;
  try {
    const proposed = await proposeWeightChange({
      weightKey,
      userId: 0,
      changeType: "RAISE_LOT", // major / risk-increasing → recommend-only
      evidence: 9999, // even with overwhelming evidence, major stays recommend-only
      reward: 0.5,
      reason: "qa: major change must require admin approval",
    });
    assert.equal(proposed.applied, false, "major change never auto-applies");
    assert.equal((proposed as { recommended: boolean }).recommended, true);
    const changeId = proposed.auditId;
    assert.ok(changeId != null, "a recommendation audit row id is returned");
    const proposedValue = (proposed as { proposedValue: number }).proposedValue;

    // Pre-approval: a recommend-only proposal must NOT have applied its value.
    // ensureWeightRow may have created a neutral row; it must sit at the neutral
    // prior, never at the (higher, risk-increasing) proposed value.
    const beforeRows = await db
      .select({ value: aaciAdaptiveWeightsTable.value })
      .from(aaciAdaptiveWeightsTable)
      .where(eq(aaciAdaptiveWeightsTable.weightKey, weightKey));
    for (const r of beforeRows) {
      assert.notEqual(r.value, proposedValue, "proposed value must not be applied pre-approval");
    }

    // First approve wins; second loses the CAS and changes nothing.
    const first = await approveWeightChange({ changeId: changeId!, adminUserId, adminRole: "ADMIN", reason: "qa approve" });
    assert.equal(first.ok, true, "first approval succeeds");
    assert.equal((first as { status: string }).status, "APPROVED");
    const appliedValue = (first as { appliedValue: number }).appliedValue;

    const second = await approveWeightChange({ changeId: changeId!, adminUserId, adminRole: "ADMIN", reason: "qa re-approve" });
    assert.equal(second.ok, false, "second approval is rejected by the CAS guard");
    assert.equal((second as { reason: string }).reason, "NOT_PENDING");

    // Post-approval: the active weight reflects the approved value exactly once.
    const afterRows = await db
      .select({ value: aaciAdaptiveWeightsTable.value, isActive: aaciAdaptiveWeightsTable.isActive })
      .from(aaciAdaptiveWeightsTable)
      .where(and(eq(aaciAdaptiveWeightsTable.weightKey, weightKey), eq(aaciAdaptiveWeightsTable.isActive, true)));
    assert.equal(afterRows.length, 1, "one active weight row after approval");
    assert.equal(afterRows[0]!.value, appliedValue, "active weight equals the approved value");

    // Summary count is a real SQL aggregate over this entity's audit trail.
    const total = await countLearningChanges({ entityKey: weightKey });
    assert.ok(total >= 2, "recommendation + applied effect rows are both audited");
  } finally {
    await db.delete(aaciLearningAuditTable).where(eq(aaciLearningAuditTable.entityKey, weightKey));
    await db.delete(aaciAdaptiveWeightsTable).where(eq(aaciAdaptiveWeightsTable.weightKey, weightKey));
  }
});
