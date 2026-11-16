// Actual PostgreSQL transactions. A held advisory lock queues every contender
// before release, so coverage does not depend on JS scheduling or sleeps.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, pool, aaciTrustScoresTable as trusts, aaciAdaptiveWeightsTable as weights,
  aaciLearningAuditTable as audits, selfTradeAgentsTable as agents,
  selfTradeDecisionsTable as decisions, selfTradeAgentExecutionsTable as executions } from "@workspace/db";
import { trustScore0to100, type AaciSharedTruthSnapshot } from "@workspace/domain/aaci";
import { applyOutcomeToTrust, getTrustRow, getLearnedTrustForDecision } from "../learning/trustStore.js";
import { learningLockKey } from "../learning/learningLocks.js";
import { proposeWeightChange, approveWeightChange, rollbackWeightChange, outcomeWeightKey, getActiveWeight } from "../learning/weightService.js";
import { applyRegimeReset } from "../learning/driftService.js";
import { ingestAgentOutcomes } from "../learning/outcomeIngestion.js";
import { buildAaciDecision } from "../decisionService.js";

const tag = `qa-learning-race-${randomUUID()}`;
const keys = new Set<string>();
const weightKeys = new Set<string>();
const agentIds: number[] = [];
function key(suffix: string): string {
  const value = `${tag}-${suffix}`; keys.add(value);
  weightKeys.add(outcomeWeightKey("symbol", value));
  return value;
}
after(async () => {
  for (const id of agentIds) {
    await db.delete(executions).where(eq(executions.agentId, id));
    await db.delete(decisions).where(eq(decisions.agentId, id));
    await db.delete(agents).where(eq(agents.id, id));
  }
  await db.delete(audits).where(inArray(audits.entityKey, [...keys, ...weightKeys]));
  await db.delete(weights).where(inArray(weights.weightKey, [...keys, ...weightKeys]));
  await db.delete(trusts).where(inArray(trusts.entityKey, [...keys]));
});

async function queued<T>(kind: "trust" | "weight", entityKey: string, work: Array<() => Promise<T>>): Promise<T[]> {
  const holder = await pool.connect();
  let settled: Promise<PromiseSettledResult<T>[]> | undefined;
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [learningLockKey(kind, 0, entityKey, kind === "trust" ? "symbol" : "")]);
    const lock = (await holder.query("SELECT classid, objid, objsubid FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted", [pid])).rows[0]!;
    settled = Promise.allSettled(work.map(run => run()));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const row = (await pool.query<{ n: string }>("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=$1 AND objid=$2 AND objsubid=$3", [lock.classid, lock.objid, lock.objsubid])).rows[0]!;
      if (Number(row.n) === work.length) break;
      assert.ok(Date.now() < deadline, `all ${work.length} transactions must serialize before reading mutable state (observed ${row.n})`);
      await delay(5);
    }
  } finally {
    await holder.query("ROLLBACK"); holder.release();
    // A failed barrier assertion must still drain writers before fixture cleanup.
    if (settled) await settled;
  }
  const results = await settled!;
  for (const result of results) assert.equal(result.status, "fulfilled", JSON.stringify(result));
  return results.map(result => (result as PromiseFulfilledResult<T>).value);
}
const fold = (entityKey: string, sourceRef: string) => db.transaction(tx => applyOutcomeToTrust(tx, {
  entityType: "symbol", entityKey, decisionQuality: 85, realizedPnl: 10, sourceRef,
}));
const tighten = (weightKey: string) => proposeWeightChange({ weightKey, changeType: "REDUCE_TRUST", evidence: 20, penalty: 1, reason: "QA observed loss" });
const admin = (changeId: number) => ({ changeId, adminUserId: 999000001, adminRole: "ADMIN", reason: "QA reviewed change" });
const weightRow = async (weightKey: string) => (await db.select().from(weights).where(eq(weights.weightKey, weightKey)))[0]!;

for (const existing of [false, true]) test(`distinct concurrent trust outcomes preserve every update (${existing ? "existing" : "first write"})`, async () => {
  const entityKey = key(`distinct-${existing}`);
  if (existing) await fold(entityKey, `${tag}-seed`);
  const results = await queued("trust", entityKey, Array.from({ length: 4 }, (_, i) => () => fold(entityKey, `${tag}-distinct-${i}`)));
  assert.equal(results.filter(result => result.applied).length, 4);
  const row = (await getTrustRow(db, { entityType: "symbol", entityKey }))!;
  const count = existing ? 5 : 4;
  assert.equal(row.evidenceCount, count);
  assert.equal(row.version, count + 1);
  assert.ok(Math.abs(row.alpha - (1 + count * 0.05)) < 1e-10);
  assert.equal(row.beta, 1);
  const trail = await db.select().from(audits).where(and(eq(audits.entityKey, entityKey), eq(audits.changeType, "TRUST_UPDATE")));
  assert.equal(trail.length, count);
});

for (const existing of [false, true]) test(`same-source concurrent ingestion returns one applied result without failed transactions (${existing ? "existing" : "first write"})`, async () => {
  const entityKey = key(`duplicate-${existing}`);
  if (existing) await fold(entityKey, `${tag}-seed`);
  const results = await queued("trust", entityKey, Array.from({ length: 4 }, () => () => fold(entityKey, `${tag}-same-source`)));
  assert.equal(results.filter(result => result.applied).length, 1);
  assert.equal(results.filter(result => !result.applied && result.reason === "ALREADY_INGESTED").length, 3);
  const row = (await getTrustRow(db, { entityType: "symbol", entityKey }))!;
  assert.equal(row.evidenceCount, existing ? 2 : 1);
  const weightAudit = await db.select().from(audits).where(eq(audits.entityKey, outcomeWeightKey("symbol", entityKey)));
  assert.equal(weightAudit.length, existing ? 2 : 1, "weight proposals are also exactly once");
});

test("concurrent weight reductions serialize from a missing row", async () => {
  const weightKey = key("weight-race");
  const results = await queued("weight", weightKey, Array.from({ length: 4 }, () => () => tighten(weightKey)));
  assert.ok(results.every(result => result.applied));
  const row = await weightRow(weightKey);
  assert.ok(Math.abs(row.value - 0.8) < 1e-10);
  assert.equal(row.version, 5);
});

test("only one simultaneous administrator can approve a recommendation", async () => {
  const weightKey = key("approval-race");
  const proposal = await proposeWeightChange({ weightKey, changeType: "WEIGHT_UPDATE", evidence: 100, reward: 1, reason: "QA increase must require approval" });
  assert.equal(proposal.applied, false);
  const results = await queued("weight", weightKey, Array.from({ length: 2 }, () => () => approveWeightChange(admin(proposal.auditId!))));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => !result.ok && result.reason === "NOT_PENDING").length, 1);
  assert.equal((await weightRow(weightKey)).version, 2);
});

test("stale approval and rollback cannot overwrite intervening tightening", async () => {
  const weightKey = key("stale");
  const proposal = await proposeWeightChange({ weightKey, changeType: "RAISE_LOT", evidence: 100, reward: 1, reason: "QA proposed expansion" });
  const first = await tighten(weightKey);
  assert.deepEqual(await approveWeightChange(admin(proposal.auditId!)), { ok: false, reason: "STALE_VERSION" });
  const second = await tighten(weightKey);
  assert.deepEqual(await rollbackWeightChange(admin(first.auditId!)), { ok: false, reason: "STALE_VERSION" });
  assert.ok(Math.abs((await weightRow(weightKey)).value - 0.9) < 1e-10);
  assert.equal((await rollbackWeightChange(admin(second.auditId!))).ok, true);
  assert.ok(Math.abs((await weightRow(weightKey)).value - 0.95) < 1e-10);
  assert.deepEqual(await rollbackWeightChange(admin(first.auditId!)), { ok: false, reason: "STALE_VERSION" }, "returning to the same value does not revive a stale version");
});

test("regime reset and outcome folding share serialization and preserve the final audited state", async () => {
  const entityKey = key("reset");
  await fold(entityKey, `${tag}-reset-seed1`); await fold(entityKey, `${tag}-reset-seed2`);
  await queued<unknown>("trust", entityKey, [
    () => applyRegimeReset({ entityType: "symbol", entityKey, reason: "QA regime transition" }),
    () => fold(entityKey, `${tag}-reset-outcome`),
  ]);
  const row = (await getTrustRow(db, { entityType: "symbol", entityKey }))!;
  assert.equal(row.evidenceCount, 3); assert.equal(row.version, 5);
  assert.ok([1.1, 1.075].some(value => Math.abs(row.alpha - value) < 1e-10));
  const trail = await db.select().from(audits).where(eq(audits.entityKey, entityKey)).orderBy(asc(audits.id));
  assert.equal((trail.at(-1)!.newValue as { alpha: number }).alpha, row.alpha);
});

test("trust, adaptive weight and both audits roll back together", async () => {
  const entityKey = key("atomic");
  await assert.rejects(db.transaction(async tx => {
    await applyOutcomeToTrust(tx, { entityType: "symbol", entityKey, decisionQuality: 85, realizedPnl: 10, sourceRef: `${tag}-atomic` });
    throw new Error("forced transaction failure");
  }), /forced transaction failure/);
  assert.equal(await getTrustRow(db, { entityType: "symbol", entityKey }), null);
  assert.equal(await weightRow(outcomeWeightKey("symbol", entityKey)), undefined);
  assert.equal((await db.select().from(audits).where(inArray(audits.entityKey, [entityKey, outcomeWeightKey("symbol", entityKey)]))).length, 0);
});

test("real closed outcomes update bounded weights consumed by actual AACI decision scoring", async () => {
  const agentKey = key("pipeline-agent"), symbol = key("pipeline-symbol"), timeframe = key("pipeline-timeframe"), setupType = key("pipeline-classifier");
  weightKeys.add(outcomeWeightKey("strategy", setupType));
  weightKeys.add(outcomeWeightKey("timeframe", timeframe));
  weightKeys.add(outcomeWeightKey("agent", agentKey));
  const [agent] = await db.insert(agents).values({ agentKey, name: "QA learning pipeline", profileTemplate: "ALPHA" }).returning();
  agentIds.push(agent!.id);
  const [decision] = await db.insert(decisions).values({ agentId: agent!.id, agentKey, cycleId: tag, symbol, timeframe, setupType, outcome: "TRADE", confidence: 0, setupScore: 95, plannedAction: "BUY", reason: "QA: zero confidence must remain a poor decision" }).returning();
  await db.insert(executions).values(Array.from({ length: 20 }, (_, i) => ({ agentId: agent!.id, agentKey, decisionId: decision!.id, symbol, side: "BUY", idempotencyKey: `${tag}-pipeline-${i}`, status: "CLOSED", realizedPnl: -1 })));
  const ingested = await ingestAgentOutcomes(agent!.id);
  assert.equal(ingested.applied, 80);
  const scope = { entityType: "symbol" as const, entityKey: symbol };
  const row = (await getTrustRow(db, scope))!;
  const weight = await getActiveWeight({ weightKey: outcomeWeightKey("symbol", symbol) });
  assert.ok(weight < 1 && weight >= 0.5);
  const learned = await getLearnedTrustForDecision(scope);
  assert.ok(learned.learnedTrustScore < trustScore0to100(row));
  const snapshot: AaciSharedTruthSnapshot = { snapshotId: tag, timestamp: new Date().toISOString(), user: { userId: "7", role: "system" }, symbolContext: { selectedSymbol: symbol }, account: {}, bridge: { status: "unknown" }, positions: { openCount: 0 } };
  const scored = await buildAaciDecision({ snapshot, userId: 7, actorType: "user", symbol, actionRequested: "advisory", persist: false });
  assert.equal(scored.learnedTrustScore, learned.learnedTrustScore);
  assert.deepEqual(scored.learningEvidence, [learned.learningEvidence]);
  assert.equal(scored.learningEvidence![0]!.trustVersion, row.version);
  assert.equal(scored.learningEvidence![0]!.weightVersion, (await weightRow(outcomeWeightKey("symbol", symbol))).version);
  assert.equal(scored.hardGatePass, false, "learned weights never bypass the unavailable bridge/risk gates");
  const classifierTrust = await getLearnedTrustForDecision({ entityType: "strategy", entityKey: setupType });
  const classifierDecision = await buildAaciDecision({ snapshot, userId: 7, actorType: "user", setupType,
    actionRequested: "advisory", persist: false });
  assert.equal(classifierDecision.learnedTrustScore, classifierTrust.learnedTrustScore);
  assert.deepEqual(classifierDecision.learningEvidence, [classifierTrust.learningEvidence]);
  assert.equal(classifierDecision.hardGatePass, false);
  const unrelated = await buildAaciDecision({ snapshot, userId: 7, actorType: "user", setupType: `${setupType}-other`, actionRequested: "advisory", persist: false });
  assert.equal(unrelated.learnedTrustScore, 50, "a different classifier cannot inherit this strategy's history");
  assert.equal((await ingestAgentOutcomes(agent!.id)).applied, 0);
  assert.equal(await getActiveWeight({ weightKey: outcomeWeightKey("symbol", symbol) }), weight);
  const [lucky] = await db.insert(executions).values({ agentId: agent!.id, agentKey, decisionId: decision!.id, symbol, side: "BUY", idempotencyKey: `${tag}-lucky`, status: "CLOSED", realizedPnl: 100 }).returning();
  await ingestAgentOutcomes(agent!.id);
  const luckyAudit = (await db.select().from(audits).where(and(eq(audits.entityKey, symbol), eq(audits.sourceRef, `exec:${lucky!.id}`))))[0]!;
  assert.equal((luckyAudit.newValue as { rewarded: boolean }).rewarded, false, "confidence=0 cannot be replaced with a positive setup score");
  assert.ok(await getActiveWeight({ weightKey: outcomeWeightKey("symbol", symbol) }) <= weight);
  const weightKey = outcomeWeightKey("symbol", symbol);
  for (let i = 0; i < 3; i++) {
    const proposal = await proposeWeightChange({ weightKey, changeType: "WEIGHT_UPDATE", evidence: 100, reward: 1, reason: "QA explicitly approved recovery" });
    assert.equal(proposal.applied, false, "every upward change remains recommend-only");
    assert.equal((await approveWeightChange(admin(proposal.auditId!))).ok, true);
  }
  assert.ok(await getActiveWeight({ weightKey }) > 1);
  const capped = await getLearnedTrustForDecision(scope);
  assert.equal(capped.learningEvidence!.adaptiveWeight, 1);
  assert.equal(capped.learnedTrustScore, capped.learningEvidence!.unweightedTrustScore, "approved weights above neutral never amplify scoring");
});

test("positive learned evidence cannot promote neutral AACI authority", async () => {
  const symbol = key("positive-authority");
  for (let i = 0; i < 4; i++) await fold(symbol, `${tag}-positive-${i}`);
  const measured = await getLearnedTrustForDecision({ entityType: "symbol", entityKey: symbol });
  assert.ok(measured.learnedTrustScore > 50, "control really contains positive learned trust");
  const snapshot: AaciSharedTruthSnapshot = { snapshotId: tag, timestamp: new Date().toISOString(), user: { userId: "7", role: "system" }, symbolContext: { selectedSymbol: symbol }, account: {}, bridge: { status: "unknown" }, positions: { openCount: 0 } };
  const scored = await buildAaciDecision({ snapshot, userId: 7, actorType: "user", symbol, actionRequested: "advisory", persist: false });
  assert.equal(scored.learnedTrustScore, 50, "caution-only aggregation retains its neutral ceiling");
  assert.equal(scored.hardGatePass, false);
});


for (const realizedPnl of [0, null]) test(`explicit safety evidence with ${realizedPnl === null ? "unmeasured" : "flat"} P&L is penalized exactly once`, async () => {
  const entityKey = key(`safety-${realizedPnl}`);
  const input = { entityType: "symbol" as const, entityKey, decisionQuality: 100, realizedPnl, sourceRef: `${tag}-safety-${realizedPnl}` };
  assert.deepEqual(await db.transaction(tx => applyOutcomeToTrust(tx, input)), { applied: false, reason: "NO_EVIDENCE" });
  assert.equal((await db.transaction(tx => applyOutcomeToTrust(tx, { ...input, safetyViolation: true }))).applied, true);
  assert.deepEqual(await db.transaction(tx => applyOutcomeToTrust(tx, { ...input, safetyViolation: true })), { applied: false, reason: "ALREADY_INGESTED" });
  const row = (await getTrustRow(db, input))!;
  assert.equal(row.alpha, 1);
  assert.equal(row.beta, 1.15);
  assert.equal(row.evidenceCount, 1);
  const trail = await db.select().from(audits).where(eq(audits.entityKey, entityKey));
  assert.equal(trail.length, 1);
  assert.match(trail[0]!.reason, /Explicit safety violation; outcome NEUTRAL/);
  const proposed = await db.select().from(audits).where(eq(audits.entityKey, outcomeWeightKey("symbol", entityKey)));
  assert.equal(proposed.length, 1);
  assert.equal((proposed[0]!.newValue as { value: number }).value, 0.85);
});
