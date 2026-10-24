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
import { inArray, like } from "drizzle-orm";
import {
  authUserSessionsTable, db, learningEventsTable, mistakePatternsTable, postTradeDebriefsTable,
  strategyEdgesTable, usersTable,
} from "@workspace/db";
import { createUserSession } from "../../auth/userSessions.js";
import { getSymbolLearningView, processLearningPayload, type LearningPayload } from "../../learningEngine.js";
import {
  listEdgesForOperator, listOwnEdges, listOwnMistakes, listPlatformEdges, listPlatformMistakes,
  PLATFORM_MIN_CONTRIBUTORS, recordEdgeOutcome, recordMistakeOutcome, type EdgeOutcome,
} from "../scopedMemory.js";
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
}

async function debrief(userId: number | null): Promise<number> {
  const [row] = await db.insert(postTradeDebriefsTable).values({ userId, tradeId: 800_000 + (++n) }).returning({ id: postTradeDebriefsTable.id });
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
  const own = await processLearningPayload(payload(await debrief(a)));
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
