// Learning memory scopes on a real database (Tier 1 finalization, item 8).
//
// strategy_edges / mistake_patterns are no longer one global pool. Proves:
//   - a trader's private memory is theirs: another trader never reads it,
//   - strategy / account / broker / instrument / portfolio scopes are owned,
//   - the platform cohort is anonymized (no owner, no trade id) and shown to
//     traders only once PLATFORM_MIN_CONTRIBUTORS distinct traders back it;
//     one trader repeating an outcome does not count twice,
//   - legacy global rows (contributors NULL) are operator-only,
//   - the learning engine teaches the debrief owner's memory only, refuses a
//     debrief owned by someone else and an ownerless payload, and shares an
//     outcome beyond private memory only when a real debrief of the owner backs it,
//   - the decision view reads own edges, falls back to the platform cohort
//     while the own sample is LOW, and never shows another trader's mistakes,
//   - the /learning routes require a session and never return another
//     trader's rows.
//
// Run: pnpm --filter @workspace/api-server run test:learning-scopes

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { inArray, like, eq, sql } from "drizzle-orm";
import {
  arxAssistantMemoryTable, arxAssistantConversationsTable, authUserSessionsTable, db, learningEventsTable, mistakePatternsTable, postTradeDebriefsTable,
  strategyEdgesTable, usersTable, paperOrdersTable,
} from "@workspace/db";
import { createUserSession } from "../../auth/userSessions.js";
import { getSymbolLearningView, processLearningPayload, type LearningPayload } from "../../learningEngine.js";
import {
  listEdgesForOperator, listOwnEdges, listOwnMistakes, listPlatformEdges, listPlatformMistakes,
  PLATFORM_MIN_CONTRIBUTORS, recordEdgeOutcome, recordMistakeOutcome, type EdgeOutcome,
} from "../scopedMemory.js";
import { runAutoDebrief } from "../../autoDebriefService.js";
import { retryPendingLearning } from "../retryWorker.js";
import { getMemory, setConversationPendingAction, getConversationPendingAction } from "../../assistant/memoryStore.js";
import learningRouter from "../../../routes/learning.js";

const EMAILS = ["qa+learn-a@arx.test", "qa+learn-b@arx.test", "qa+learn-c@arx.test"];
const PREFIX = "QA-SCOPE-";
const stamp = Date.now();
let sym = "";
let n = 0;
let a = 0, b = 0, c = 0;
let cookieA = "", cookieB = "";
let server: Server;
let base = "";
const debriefIds: number[] = [];

const edge = (over: Partial<EdgeOutcome> = {}): EdgeOutcome => ({
  symbol: sym, signalName: "strategyEngine", action: "BUY", result: "WIN", pnl: 10, tradeId: 900_000 + n,
  deltaEdge: 3, deltaConf: 1, deltaRisk: -1, ...over,
});

async function wipeMemory(): Promise<void> {
  await db.delete(strategyEdgesTable).where(like(strategyEdgesTable.symbol, `${PREFIX}%`));
  await db.delete(mistakePatternsTable).where(like(mistakePatternsTable.symbol, `${PREFIX}%`));
}

async function cleanup(): Promise<void> {
  await wipeMemory();
  const ids = (await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.email, EMAILS))).map((u) => u.id);
  if (ids.length) {
    await db.delete(learningEventsTable).where(inArray(learningEventsTable.userId, ids));
    await db.delete(postTradeDebriefsTable).where(inArray(postTradeDebriefsTable.userId, ids));
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
  await db.delete(learningEventsTable).where(like(learningEventsTable.symbol, `${PREFIX}%`));
  if (debriefIds.length) await db.delete(postTradeDebriefsTable).where(inArray(postTradeDebriefsTable.id, debriefIds.splice(0)));
}

async function debrief(userId: number | null): Promise<number> {
  // Unique per run: trade_id is unique and a null-owner debrief is not found by owner.
  const [row] = await db.insert(postTradeDebriefsTable).values({ userId, tradeId: 1_500_000_000 + (stamp % 400_000_000) + (++n) })
    .returning({ id: postTradeDebriefsTable.id });
  debriefIds.push(row!.id);
  return row!.id;
}

function payload(debriefId: number, over: Partial<LearningPayload> = {}): LearningPayload {
  return {
    trade_id: 700_000 + (++n), decision_id: null, debrief_id: debriefId, result: "LOSS", pnl: -8, pnl_percent: -0.8,
    symbol: sym, action: "BUY", confidence_before_trade: 60, risk_score_before_trade: 40,
    signals_used: [{ source: "strategyEngine", status: "PASS", score: 30 }],
    mistake_tags: ["REVENGE_TRADE"], lesson: "qa", ready_for_learning: true, ...over,
  };
}

before(async () => {
  await cleanup();
  const rows = await db.insert(usersTable).values(EMAILS.map((email) => ({ email, name: "QA Learn", role: "USER", isSystemUser: true })))
    .returning({ id: usersTable.id });
  [a, b, c] = rows.map((r) => r.id) as [number, number, number];
  cookieA = `arx_user_session=${(await createUserSession({ userId: a })).rawToken}`;
  cookieB = `arx_user_session=${(await createUserSession({ userId: b })).rawToken}`;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: unknown }).log = { error: noop, warn: noop, info: noop, debug: noop };
    next();
  });
  app.use("/api", learningRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await wipeMemory();
  sym = `${PREFIX}${stamp}-${++n}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

test("private memory is the owner's; another trader never reads it", async () => {
  await recordEdgeOutcome(a, edge());
  await recordMistakeOutcome(a, { tag: "OVERSIZED", symbol: sym, action: "BUY", isLoss: true, tradeId: 1, guardrail: "cap" });
  assert.equal((await listOwnEdges(a, { symbol: sym })).length, 1);
  assert.equal((await listOwnMistakes(a, { symbol: sym })).length, 1);
  assert.deepEqual(await listOwnEdges(b, { symbol: sym }), []);
  assert.deepEqual(await listOwnMistakes(b, { symbol: sym }), []);
});

test("strategy / account scopes are owned and separate from the private row", async () => {
  await recordEdgeOutcome(a, edge(), [{ type: "account", key: "paper:1" }, { type: "strategy", key: "breakout" }, { type: "account", key: "paper:1" }]);
  const scoped = await listOwnEdges(a, { symbol: sym, scopeTypes: ["account", "strategy"] });
  assert.deepEqual(scoped.map((e) => `${e.scopeType}:${e.scopeKey}`).sort(), ["account:paper:1", "strategy:breakout"], "duplicates dropped");
  assert.ok(scoped.every((e) => e.scopeOwner === a && e.userId === a));
  assert.equal((await listOwnEdges(a, { symbol: sym })).length, 1, "user scope alone by default");
  assert.deepEqual(await listOwnEdges(b, { symbol: sym, scopeTypes: ["account", "strategy"] }), []);
});

test("platform cohort: anonymized, shown only with enough distinct traders", async () => {
  assert.equal(PLATFORM_MIN_CONTRIBUTORS, 3);
  await recordEdgeOutcome(a, edge());
  await recordEdgeOutcome(a, edge());
  await recordEdgeOutcome(a, edge());
  await recordEdgeOutcome(b, edge());
  assert.deepEqual(await listPlatformEdges({ symbol: sym }), [], "two traders are not enough, however many trades");
  await recordEdgeOutcome(c, edge());
  const [p] = await listPlatformEdges({ symbol: sym });
  assert.ok(p, "the third distinct trader unlocks the cohort");
  assert.equal(p.contributors, 3);
  assert.equal(p.sampleCount, 5);
  assert.equal("userId" in p, false);
  assert.equal("lastTradeId" in p, false);
  assert.equal("scopeOwner" in p, false);

  for (const u of [a, b]) await recordMistakeOutcome(u, { tag: "REVENGE", symbol: sym, action: "BUY", isLoss: true, tradeId: 1, guardrail: "cool off" });
  assert.deepEqual(await listPlatformMistakes({ symbol: sym }), []);
});

test("legacy global rows (contributors NULL) are operator-only", async () => {
  await db.insert(strategyEdgesTable).values({ symbol: sym, strategyName: "legacy", signalName: "legacy", action: "BUY", sampleCount: 40, scopeType: "platform" });
  assert.deepEqual(await listPlatformEdges({ symbol: sym }), []);
  assert.deepEqual(await listOwnEdges(a, { symbol: sym }), []);
  assert.equal((await listEdgesForOperator({ symbol: sym })).length, 1);
  await recordEdgeOutcome(a, edge({ signalName: "legacy" }));
  const legacy = (await listEdgesForOperator({ symbol: sym, scopeType: "platform" }))[0]!;
  assert.equal(legacy.contributors, null, "a legacy row never becomes trader-visible");
});

test("engine: refuses another trader's debrief and an ownerless payload", async () => {
  const bDebrief = await debrief(b);
  const r = await processLearningPayload(payload(bDebrief), { ownerUserId: a });
  assert.equal(r.status, "skipped_invalid_payload");
  assert.deepEqual(await listOwnEdges(a, { symbol: sym }), []);
  assert.deepEqual(await listOwnEdges(b, { symbol: sym }), []);

  const orphan = await debrief(null);
  assert.equal((await processLearningPayload(payload(orphan))).status, "skipped_invalid_payload");
  assert.deepEqual(await listEdgesForOperator({ symbol: sym }), [], "nothing learned at all");
});

test("engine: the debrief owner's memory learns; only a real own debrief is shared", async () => {
  const canonical = payload(await debrief(a));
  await db.update(postTradeDebriefsTable).set({ learningPayload: canonical }).where(eq(postTradeDebriefsTable.id, canonical.debrief_id));
  const own = await processLearningPayload(canonical);
  assert.equal(own.status, "processed");
  assert.deepEqual(own.warnings, []);
  assert.equal((await listOwnEdges(a, { symbol: sym })).length, 1);
  assert.equal((await listOwnMistakes(a, { symbol: sym })).length, 1);
  assert.equal((await listEdgesForOperator({ symbol: sym, scopeType: "platform" }))[0]?.contributors, 1);

  // A synthesized payload (no debrief row) teaches the caller's private memory only.
  const fake = await processLearningPayload(payload(2_000_000_000 + (stamp % 100_000_000)), { ownerUserId: b });
  assert.equal(fake.status, "processed");
  assert.match(fake.warnings[0] ?? "", /private memory only/);
  assert.equal((await listOwnEdges(b, { symbol: sym })).length, 1);
  const platform = (await listEdgesForOperator({ symbol: sym, scopeType: "platform" }))[0]!;
  assert.equal(platform.contributors, 1, "the fabricated outcome did not join the cohort");
  assert.equal(platform.sampleCount, 1);
  await db.delete(learningEventsTable).where(like(learningEventsTable.symbol, sym));
});

test("decision view: own edges, platform fallback while LOW, own mistakes only", async () => {
  assert.equal((await getSymbolLearningView(a, sym, "BUY")).source, "none");
  for (const u of [a, b, c]) for (let i = 0; i < 2; i++) await recordEdgeOutcome(u, edge());
  await recordMistakeOutcome(b, { tag: "REVENGE", symbol: sym, action: "BUY", isLoss: true, tradeId: 1, guardrail: "cool off" });

  const v = await getSymbolLearningView(a, sym, "BUY");
  assert.equal(v.source, "platform", "own n=2 < 5; the 3-trader cohort (n=6) is used");
  assert.equal(v.totalSampleSize, 6);
  assert.deepEqual(v.knownMistakeWarnings, [], "B's mistake never reaches A");

  for (let i = 0; i < 3; i++) await recordEdgeOutcome(a, edge());
  const mine = await getSymbolLearningView(a, sym, "BUY");
  assert.equal(mine.source, "own");
  assert.equal(mine.totalSampleSize, 5);
  assert.equal((await getSymbolLearningView(b, sym, "BUY")).knownMistakeWarnings.length, 1);
});

test("routes: a session is required and rows stay with their owner", async () => {
  for (const [method, path] of [["GET", "/learning/edges"], ["GET", "/learning/mistakes"], ["GET", "/learning/events"],
    ["GET", `/learning/view?symbol=${sym}`], ["POST", "/learning/process"], ["POST", "/learning/demo"]] as const) {
    const res = await fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  await recordEdgeOutcome(a, edge());
  await recordMistakeOutcome(a, { tag: "OVERSIZED", symbol: sym, action: "BUY", isLoss: true, tradeId: 1, guardrail: "cap" });
  const get = async (path: string, cookie: string) => (await fetch(`${base}/api${path}`, { headers: { cookie } })).json() as Promise<Record<string, unknown>>;
  assert.equal(((await get(`/learning/edges?symbol=${sym}`, cookieA)).edges as unknown[]).length, 1);
  const bEdges = await get(`/learning/edges?symbol=${sym}&scope=all`, cookieB);
  assert.equal((bEdges.edges as unknown[]).length, 0, "scope=all is operator-only; B sees nothing of A's");
  assert.equal(((bEdges.platform as { edges: unknown[] }).edges).length, 0);
  assert.equal(((await get(`/learning/mistakes?symbol=${sym}`, cookieB)).mistakes as unknown[]).length, 0);
});


test("concurrent first outcomes preserve every sample and distinct contributor", async () => {
  const owners = Array.from({ length: 18 }, (_, i) => [a, b, c][i % 3]!);
  await Promise.all(owners.map(u => recordEdgeOutcome(u, edge({ pnl: 1 }))));
  const [platform] = await listPlatformEdges({ symbol: sym });
  assert.equal(platform.sampleCount, 18);
  assert.equal(platform.netPnl, 18);
  assert.equal(platform.contributors, 3);
  for (const u of [a, b, c]) assert.equal((await listOwnEdges(u, { symbol: sym }))[0].sampleCount, 6);
  await Promise.all(owners.map(u => recordMistakeOutcome(u, { tag: "CONCURRENT", symbol: sym, action: "BUY", isLoss: true, tradeId: 1, guardrail: "wait" })));
  const [mistake] = await listPlatformMistakes({ symbol: sym });
  assert.equal(mistake.count, 18);
  assert.equal(mistake.contributors, 3);
});

test("racing duplicate debriefs fold once; opposing signal order does not deadlock", async () => {
  const id = await debrief(a);
  const p = payload(id);
  const results = await Promise.all(Array.from({ length: 8 }, () => processLearningPayload(p, { ownerUserId: a })));
  assert.equal(results.filter(r => r.status === "processed").length, 1);
  assert.equal(results.filter(r => r.status === "skipped_already_processed").length, 7);
  assert.equal((await listOwnEdges(a, { symbol: sym }))[0].sampleCount, 1);
  const signals = [{ source: "first", status: "PASS", score: 1 }, { source: "second", status: "PASS", score: 1 }];
  const outcomes = await Promise.all([
    processLearningPayload(payload(await debrief(a), { signals_used: signals }), { ownerUserId: a }),
    processLearningPayload(payload(await debrief(b), { signals_used: [...signals].reverse() }), { ownerUserId: b }),
  ]);
  assert.ok(outcomes.every(r => r.status === "processed"));
  assert.equal((await processLearningPayload(p, { ownerUserId: b })).status, "skipped_invalid_payload");
});

test("a mid-fold database failure rolls back the event and every scope; retry succeeds", async () => {
  const id = await debrief(a), p = payload(id, { mistake_tags: ["QA_SCOPE_FAIL"] });
  await db.execute(sql`ALTER TABLE mistake_patterns ADD CONSTRAINT qa_scope_failure CHECK (tag <> 'QA_SCOPE_FAIL') NOT VALID`);
  try {
    assert.equal((await processLearningPayload(p, { ownerUserId: a })).status, "error");
    assert.deepEqual(await listOwnEdges(a, { symbol: sym }), []);
    assert.deepEqual(await listEdgesForOperator({ symbol: sym }), []);
    assert.deepEqual(await db.select().from(learningEventsTable).where(eq(learningEventsTable.debriefId, id)), []);
  } finally {
    await db.execute(sql`ALTER TABLE mistake_patterns DROP CONSTRAINT qa_scope_failure`);
  }
  assert.equal((await processLearningPayload(p, { ownerUserId: a })).status, "processed");
  assert.equal((await listOwnEdges(a, { symbol: sym }))[0].sampleCount, 1);
});


test("an owned debrief does not authorize forged shared learning evidence", async () => {
  const canonical = payload(await debrief(a));
  await db.update(postTradeDebriefsTable).set({ learningPayload: canonical }).where(eq(postTradeDebriefsTable.id, canonical.debrief_id));
  for (const change of [{ pnl: 9999 }, { result: "WIN" }, { symbol: "OTHER" }, { trade_id: 42 }, { signals_used: [] }]) {
    const result = await processLearningPayload({ ...canonical, ...change }, { ownerUserId: a });
    assert.equal(result.status, "skipped_invalid_payload");
  }
  assert.deepEqual(await db.select().from(learningEventsTable).where(eq(learningEventsTable.debriefId, canonical.debrief_id)), []);
  assert.equal((await processLearningPayload(canonical, { ownerUserId: a })).status, "processed");
});


test("pending stored outcomes recover after a worker restart and remain idempotent", async () => {
  const canonical = payload(await debrief(a));
  await db.update(postTradeDebriefsTable).set({ learningPayload: canonical }).where(eq(postTradeDebriefsTable.id, canonical.debrief_id));
  const replay = await retryPendingLearning(0, 100);
  assert.ok(replay.processed >= 1);
  const receipt = await db.select().from(learningEventsTable).where(eq(learningEventsTable.debriefId, canonical.debrief_id));
  assert.equal(receipt.length, 1);
  await retryPendingLearning(0, 100);
  assert.equal((await listOwnEdges(a, { symbol: sym }))[0].sampleCount, 1);
});

test("assistant memory redacts repeated and nested credentials and keeps owner boundaries", async () => {
  const [conversation] = await db.insert(arxAssistantConversationsTable).values({ userId: a, title: "privacy probe" }).returning();
  const secret = "sk-abcdefghijklmnopqrstuvwx";
  const action = { type: "generic", status: "open" as const, userIntent: `API_KEY=opaqueSecret ${secret} ${secret}`,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastAssistantPromise: "Check EURUSD",
    toolResult: { apiKey: "nestedSecret", quote: 1.08 } };
  await setConversationPendingAction(a, conversation.id, action);
  const [stored] = await db.select().from(arxAssistantConversationsTable).where(eq(arxAssistantConversationsTable.id, conversation.id));
  for (const value of [secret, "opaqueSecret", "nestedSecret"]) assert.ok(!JSON.stringify(stored.pendingAction).includes(value));
  assert.equal((await getConversationPendingAction(a, conversation.id))?.lastAssistantPromise, "Check EURUSD");
  await setConversationPendingAction(b, conversation.id, null);
  assert.equal(await getConversationPendingAction(b, conversation.id), null);
  assert.ok(await getConversationPendingAction(a, conversation.id));
  await db.insert(arxAssistantMemoryTable).values({ userId: a, rollingSummary: secret, preferences: { apiKey: "legacySecret", market: "EURUSD" } })
    .onConflictDoUpdate({ target: arxAssistantMemoryTable.userId, set: { rollingSummary: secret, preferences: { apiKey: "legacySecret", market: "EURUSD" } } });
  const memory = await getMemory(a);
  assert.ok(!JSON.stringify(memory).includes(secret));
  assert.ok(!JSON.stringify(memory).includes("legacySecret"));
  assert.equal(memory.preferences?.market, "EURUSD");
});


test("private-only history never prevents later verified cohort membership", async () => {
  const m = { tag: "PRIVATE_FIRST", symbol: sym, action: "BUY", isLoss: true, tradeId: 1, guardrail: "wait" };
  for (const owner of [a, b, c]) {
    await recordEdgeOutcome(owner, edge(), [], false);
    await recordMistakeOutcome(owner, m, [], false);
  }
  assert.equal((await listPlatformEdges({ symbol: sym })).length, 0);
  for (const owner of [a, b, c, a]) {
    await recordEdgeOutcome(owner, edge(), [], true);
    await recordMistakeOutcome(owner, m, [], true);
  }
  const [e] = await listPlatformEdges({ symbol: sym });
  const [mistake] = await listPlatformMistakes({ symbol: sym });
  assert.equal(e?.contributors, 3);
  assert.equal(e?.sampleCount, 4);
  assert.equal(mistake?.contributors, 3);
  assert.equal(mistake?.count, 4);
});


test("auto-debrief insertion and canonical learning ID roll back together", async () => {
  const [order] = await db.insert(paperOrdersTable).values({ paperAccountId: -42, symbol: sym,
    direction: "BUY", entryPrice: 100, stopLoss: 90, takeProfit: 110,
    status: "CLOSED_TP", exitPrice: 110, profitLoss: 10, closedAt: new Date() }).returning();
  try {
    await db.execute(sql.raw(`ALTER TABLE post_trade_debriefs ADD CONSTRAINT qa_canonical_id_failure CHECK (trade_id <> ${order!.id} OR (learning_payload->>'debrief_id')::int = 0) NOT VALID`));
    try {
      const failed = await runAutoDebrief(order!.id, { triggeredBy: "qa" });
      assert.equal(failed.status, "error");
      assert.equal((await db.select().from(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.tradeId, order!.id))).length, 0);
    } finally { await db.execute(sql`ALTER TABLE post_trade_debriefs DROP CONSTRAINT qa_canonical_id_failure`); }
    const recovered = await runAutoDebrief(order!.id, { triggeredBy: "qa" });
    assert.equal(recovered.status, "created");
    const [stored] = await db.select().from(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.tradeId, order!.id));
    assert.equal((stored!.learningPayload as Record<string, unknown>).debrief_id, stored!.id);
    debriefIds.push(stored!.id);
  } finally { await db.delete(paperOrdersTable).where(eq(paperOrdersTable.id, order!.id)); }
});

test("recovery repairs only provenance-backed historical system draft IDs", async () => {
  for (const system of [false, true]) {
    const id = await debrief(a);
    const [row] = await db.select().from(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.id, id));
    const draft = payload(0, { trade_id: row!.tradeId });
    await db.update(postTradeDebriefsTable).set({ learningPayload: draft,
      createdBy: system ? "SYSTEM_AUTO_DEBRIEF" : "USER",
      autoMeta: { created_by: "SYSTEM_AUTO_DEBRIEF", trade_id: row!.tradeId, symbol: sym, action: "BUY" },
    }).where(eq(postTradeDebriefsTable.id, id));
    await retryPendingLearning(id - 1, 1);
    const receipts = await db.select().from(learningEventsTable).where(eq(learningEventsTable.debriefId, id));
    assert.equal(receipts.length, system ? 1 : 0);
  }
});
