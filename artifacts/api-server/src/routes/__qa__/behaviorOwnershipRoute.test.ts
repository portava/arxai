// Paper sandbox + behaviour-coaching ownership boundary — real DB + genuine
// session route proof.
//
// Seeds two authenticated users plus legacy ownerless rows, mounts the real
// paper, debrief, auto-debrief, prop-challenge, mentor, skill, analytics, edge,
// rule-contract, weekly-review, trade-decision and readiness routers, and
// proves:
//   - anonymous callers get 401 everywhere,
//   - user B can never read, edit, close or evaluate user A's rows (404),
//   - legacy rows with user_id NULL are invisible to everyone,
//   - "single active" invariants (paper account, rule contract) are per user,
//   - aggregates (analytics, weekly review) only count the caller's own rows,
//   - rows a user creates are stamped with that user's id.
//
// Run: pnpm --filter @workspace/api-server run test:behavior-ownership-route

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { eq, inArray } from "drizzle-orm";
import {
  aiMentorSessionsTable,
  analyticsHeatmapsTable,
  analyticsSnapshotsTable,
  authUserSessionsTable,
  db,
  edgeDiscoveryReportsTable,
  edgeWarningsTable,
  mentorActionItemsTable,
  paperAccountsTable,
  paperOrdersTable,
  paperTradeEventsTable,
  postTradeDebriefsTable,
  propChallengesTable,
  sessionCommitmentsTable,
  skillLevelHistoryTable,
  tradeDecisionLogsTable,
  traderSkillProfilesTable,
  tradesTable,
  tradingReadinessChecksTable,
  tradingRuleContractsTable,
  tradingRuleViolationsTable,
  usersTable,
  weeklyImprovementGoalsTable,
  weeklyPerformanceReviewsTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import paperTradingRouter from "../paperTrading.js";
import postTradeDebriefsRouter from "../postTradeDebriefs.js";
import autoDebriefRouter from "../autoDebrief.js";
import propChallengesRouter from "../propChallenges.js";
import aiMentorRouter from "../aiMentor.js";
import traderSkillRouter from "../traderSkill.js";
import analyticsRouter from "../analytics.js";
import edgeDiscoveryRouter from "../edgeDiscovery.js";
import ruleContractsRouter from "../ruleContracts.js";
import weeklyReviewsRouter from "../weeklyReviews.js";
import tradeDecisionRouter from "../tradeDecision.js";
import tradingReadinessRouter from "../tradingReadiness.js";

const EMAIL_A = "qa+behavior-owner-a@arx.test";
const EMAIL_B = "qa+behavior-owner-b@arx.test";

// Prices that the synthetic mark-to-market can never reach, so seeded OPEN
// orders stay OPEN for the whole run.
const ENTRY = 100;
const FAR_SL = 0.0001;
const FAR_TP = 1e9;

let server: Server;
let base = "";
let userAId = 0;
let userBId = 0;
let cookieA = "";
let cookieB = "";

// Ownerless legacy rows, tracked by id for cleanup.
const legacy = {
  accountId: 0,
  orderId: 0,
  closedOrderId: 0,
  debriefId: 0,
  mentorSessionId: 0,
  skillProfileId: 0,
  edgeReportId: 0,
  contractId: 0,
  decisionId: 0,
  readinessId: 0,
};

// User-owned seed rows used across tests.
let accountAId = 0;
let accountBId = 0;
let openOrderAId = 0;
let closedOrderAId = 0;
let closedOrderBId = 0;

async function deleteByUser(userId: number): Promise<void> {
  await db.delete(mentorActionItemsTable).where(eq(mentorActionItemsTable.userId, userId));
  await db.delete(aiMentorSessionsTable).where(eq(aiMentorSessionsTable.userId, userId));
  await db.delete(skillLevelHistoryTable).where(eq(skillLevelHistoryTable.userId, userId));
  await db.delete(traderSkillProfilesTable).where(eq(traderSkillProfilesTable.userId, userId));
  await db.delete(analyticsSnapshotsTable).where(eq(analyticsSnapshotsTable.userId, userId));
  await db.delete(analyticsHeatmapsTable).where(eq(analyticsHeatmapsTable.userId, userId));
  await db.delete(edgeWarningsTable).where(eq(edgeWarningsTable.userId, userId));
  await db.delete(edgeDiscoveryReportsTable).where(eq(edgeDiscoveryReportsTable.userId, userId));
  await db.delete(tradingRuleViolationsTable).where(eq(tradingRuleViolationsTable.userId, userId));
  await db.delete(sessionCommitmentsTable).where(eq(sessionCommitmentsTable.userId, userId));
  await db.delete(tradingRuleContractsTable).where(eq(tradingRuleContractsTable.userId, userId));
  await db.delete(weeklyImprovementGoalsTable).where(eq(weeklyImprovementGoalsTable.userId, userId));
  await db.delete(weeklyPerformanceReviewsTable).where(eq(weeklyPerformanceReviewsTable.userId, userId));
  await db.delete(tradeDecisionLogsTable).where(eq(tradeDecisionLogsTable.userId, userId));
  await db.delete(tradingReadinessChecksTable).where(eq(tradingReadinessChecksTable.userId, userId));
  await db.delete(propChallengesTable).where(eq(propChallengesTable.userId, userId));
  await db.delete(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.userId, userId));
  await db.delete(paperTradeEventsTable).where(eq(paperTradeEventsTable.userId, userId));
  await db.delete(paperOrdersTable).where(eq(paperOrdersTable.userId, userId));
  await db.delete(paperAccountsTable).where(eq(paperAccountsTable.userId, userId));
  await db.delete(tradesTable).where(eq(tradesTable.userId, userId));
}

async function deleteFixtures(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.email, [EMAIL_A, EMAIL_B]));
  for (const user of users) {
    await deleteByUser(user.id);
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, user.id));
    await db.delete(usersTable).where(eq(usersTable.id, user.id));
  }
  const ids = (n: number) => (n ? [n] : [-1]);
  await db.delete(postTradeDebriefsTable).where(inArray(postTradeDebriefsTable.id, ids(legacy.debriefId)));
  await db.delete(paperOrdersTable)
    .where(inArray(paperOrdersTable.id, [legacy.orderId || -1, legacy.closedOrderId || -1]));
  await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.id, ids(legacy.accountId)));
  await db.delete(aiMentorSessionsTable).where(inArray(aiMentorSessionsTable.id, ids(legacy.mentorSessionId)));
  await db.delete(traderSkillProfilesTable).where(inArray(traderSkillProfilesTable.id, ids(legacy.skillProfileId)));
  await db.delete(edgeDiscoveryReportsTable).where(inArray(edgeDiscoveryReportsTable.id, ids(legacy.edgeReportId)));
  await db.delete(tradingRuleContractsTable).where(inArray(tradingRuleContractsTable.id, ids(legacy.contractId)));
  await db.delete(tradeDecisionLogsTable).where(inArray(tradeDecisionLogsTable.id, ids(legacy.decisionId)));
  await db.delete(tradingReadinessChecksTable).where(inArray(tradingReadinessChecksTable.id, ids(legacy.readinessId)));
}

async function seedUser(email: string, name: string): Promise<{ id: number; cookie: string }> {
  const [user] = await db.insert(usersTable)
    .values({ email, name, role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  assert.ok(user);
  const { rawToken } = await createUserSession({ userId: user.id });
  return { id: user.id, cookie: `arx_user_session=${rawToken}` };
}

async function seedAccount(userId: number | null, name: string, isActive = 1): Promise<number> {
  const [row] = await db.insert(paperAccountsTable).values({
    userId, accountName: name, startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, isActive,
  }).returning({ id: paperAccountsTable.id });
  return row!.id;
}

async function seedOrder(
  userId: number | null, accountId: number, symbol: string,
  closed?: { exitPrice: number; profitLoss: number },
): Promise<number> {
  const [row] = await db.insert(paperOrdersTable).values({
    userId, paperAccountId: accountId, symbol, direction: "BUY", lotSize: 0.01,
    entryPrice: ENTRY, stopLoss: FAR_SL, takeProfit: FAR_TP,
    status: closed ? "CLOSED_MANUAL" : "OPEN",
    exitPrice: closed?.exitPrice ?? null,
    profitLoss: closed?.profitLoss ?? 0,
    closedAt: closed ? new Date() : null,
  }).returning({ id: paperOrdersTable.id });
  return row!.id;
}

function request(path: string, cookie?: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${base}/api${path}`, { ...init, headers });
}

function send(method: string, path: string, cookie: string | undefined, body?: unknown): Promise<Response> {
  return request(path, cookie, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json() as T;
}

before(async () => {
  await deleteFixtures();
  const a = await seedUser(EMAIL_A, "QA Behavior Owner A");
  const b = await seedUser(EMAIL_B, "QA Behavior Owner B");
  userAId = a.id; cookieA = a.cookie;
  userBId = b.id; cookieB = b.cookie;

  accountAId = await seedAccount(userAId, "A practice");
  accountBId = await seedAccount(userBId, "B practice");
  openOrderAId = await seedOrder(userAId, accountAId, "QAOWN.A");
  closedOrderAId = await seedOrder(userAId, accountAId, "QAOWN.A", { exitPrice: ENTRY + 1, profitLoss: 1 });
  // B's closed trade carries a large, recognisable P&L so any leak into A's
  // aggregates is obvious.
  closedOrderBId = await seedOrder(userBId, accountBId, "QAOWN.B", { exitPrice: ENTRY + 500, profitLoss: 500 });

  legacy.accountId = await seedAccount(null, "legacy single-tenant");
  legacy.orderId = await seedOrder(null, legacy.accountId, "QAOWN.LEGACY");
  legacy.closedOrderId = await seedOrder(null, legacy.accountId, "QAOWN.LEGACY", { exitPrice: ENTRY + 900, profitLoss: 900 });

  [{ id: legacy.debriefId }] = await db.insert(postTradeDebriefsTable).values({
    userId: null, tradeId: legacy.closedOrderId, result: "WIN", checklist: [], followedPlan: 1,
    biggestMistake: "legacy-mistake-marker",
  }).returning({ id: postTradeDebriefsTable.id }) as [{ id: number }];
  [{ id: legacy.mentorSessionId }] = await db.insert(aiMentorSessionsTable).values({
    userId: null, sessionType: "DAILY_BRIEFING", skillLevel: "Beginner",
    mainFocus: "legacy-mentor-marker", mentorMessage: "legacy", recommendedAction: "legacy",
  }).returning({ id: aiMentorSessionsTable.id }) as [{ id: number }];
  [{ id: legacy.skillProfileId }] = await db.insert(traderSkillProfilesTable).values({
    userId: null, skillLevel: "Elite Trader", totalScore: 99,
  }).returning({ id: traderSkillProfilesTable.id }) as [{ id: number }];
  [{ id: legacy.edgeReportId }] = await db.insert(edgeDiscoveryReportsTable).values({
    userId: null, edgeName: "legacy-edge-marker", status: "STRONG_EDGE", confidenceScore: 100,
  }).returning({ id: edgeDiscoveryReportsTable.id }) as [{ id: number }];
  [{ id: legacy.contractId }] = await db.insert(tradingRuleContractsTable).values({
    userId: null, contractName: "legacy-contract-marker", isActive: 1,
  }).returning({ id: tradingRuleContractsTable.id }) as [{ id: number }];
  [{ id: legacy.decisionId }] = await db.insert(tradeDecisionLogsTable).values({
    userId: null, symbol: "QAOWN.LEGACY",
  }).returning({ id: tradeDecisionLogsTable.id }) as [{ id: number }];
  [{ id: legacy.readinessId }] = await db.insert(tradingReadinessChecksTable).values({
    userId: null, sessionName: "legacy-readiness-marker", readinessScore: 100, status: "READY",
  }).returning({ id: tradingReadinessChecksTable.id }) as [{ id: number }];

  await db.insert(tradeDecisionLogsTable).values([
    { userId: userAId, symbol: "QAOWN.A" },
    { userId: userBId, symbol: "QAOWN.B" },
  ]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Routers log through pino-http in production; a silent stand-in keeps error
  // paths from throwing here.
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: unknown }).log = { error: noop, warn: noop, info: noop, debug: noop };
    next();
  });
  for (const r of [
    paperTradingRouter, postTradeDebriefsRouter, autoDebriefRouter, propChallengesRouter,
    aiMentorRouter, traderSkillRouter, analyticsRouter, edgeDiscoveryRouter,
    ruleContractsRouter, weeklyReviewsRouter, tradeDecisionRouter, tradingReadinessRouter,
  ]) app.use("/api", r);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteFixtures();
});

test("every scoped namespace rejects anonymous callers", async () => {
  const probes: Array<[string, string]> = [
    ["GET", "/paper/accounts"], ["GET", "/paper/accounts/active"],
    ["POST", "/paper/orders"], ["PATCH", `/paper/orders/${openOrderAId}`],
    ["POST", `/paper/orders/${openOrderAId}/close`],
    ["GET", `/paper/orders?accountId=${accountAId}`], ["GET", `/paper/history?accountId=${accountAId}`],
    ["GET", "/post-trade-debriefs"], ["GET", "/auto-debrief/recent"],
    ["GET", "/mentor/sessions"], ["GET", "/mentor/action-items"],
    ["GET", "/skill/profile"], ["POST", "/skill/calculate"],
    ["GET", "/analytics/snapshot"], ["GET", "/analytics/drawdown"],
    ["GET", "/edge/reports"], ["GET", "/edge/warnings"],
    ["GET", "/rule-contracts"], ["GET", "/session-commitments/active"],
    ["GET", "/weekly-reviews"], ["GET", "/weekly-goals"],
    ["GET", "/trade-decision/logs"], ["GET", "/trade-decision/latest"],
    ["GET", "/readiness/checks"],
  ];
  const results = await Promise.all(probes.map(([m, p]) => send(m, p, undefined, m === "GET" ? undefined : {})));
  results.forEach((r, i) => assert.equal(r.status, 401, `${probes[i]![0]} ${probes[i]![1]} must be 401`));
});

test("paper accounts: each user lists only their own; legacy accounts are invisible", async () => {
  const [ra, rb] = await Promise.all([request("/paper/accounts", cookieA), request("/paper/accounts", cookieB)]);
  const a = await json<{ accounts: Array<{ id: number }> }>(ra);
  const b = await json<{ accounts: Array<{ id: number }> }>(rb);
  assert.deepEqual(a.accounts.map((x) => x.id), [accountAId]);
  assert.deepEqual(b.accounts.map((x) => x.id), [accountBId]);

  const active = await json<{ account: { id: number } }>(await request("/paper/accounts/active", cookieA));
  assert.equal(active.account.id, accountAId);
});

test("paper orders: user B cannot place on, list, edit or close user A's orders", async () => {
  const place = await send("POST", "/paper/orders", cookieB, {
    paperAccountId: accountAId, symbol: "QAOWN.B", direction: "BUY",
    entryPrice: ENTRY, stopLoss: FAR_SL, takeProfit: FAR_TP,
  });
  assert.equal(place.status, 404);

  assert.equal((await request(`/paper/orders?accountId=${accountAId}`, cookieB)).status, 404);
  assert.equal((await request(`/paper/history?accountId=${accountAId}`, cookieB)).status, 404);
  assert.equal((await request(`/paper/orders?accountId=${legacy.accountId}`, cookieA)).status, 404);

  const patch = await send("PATCH", `/paper/orders/${openOrderAId}`, cookieB, { stopLoss: 50 });
  assert.equal(patch.status, 404);
  const close = await send("POST", `/paper/orders/${openOrderAId}/close`, cookieB);
  assert.equal(close.status, 404);
  const legacyPatch = await send("PATCH", `/paper/orders/${legacy.orderId}`, cookieA, { stopLoss: 50 });
  assert.equal(legacyPatch.status, 404);

  const [row] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, openOrderAId));
  assert.equal(row!.status, "OPEN", "B's close attempt must not close A's order");
  assert.equal(row!.stopLoss, FAR_SL, "B's edit attempt must not move A's stop");
  assert.equal((await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.paperAccountId, accountAId))).length, 2,
    "B must not be able to add an order to A's account");
});

test("paper orders: the owner can still edit their own order and new orders are stamped", async () => {
  const patch = await send("PATCH", `/paper/orders/${openOrderAId}`, cookieA, { stopLoss: 0.001 });
  assert.equal(patch.status, 200);
  assert.equal((await json<{ order: { stopLoss: number } }>(patch)).order.stopLoss, 0.001);

  const place = await send("POST", "/paper/orders", cookieA, {
    paperAccountId: accountAId, symbol: "QAOWN.A", direction: "BUY",
    entryPrice: ENTRY, stopLoss: FAR_SL, takeProfit: FAR_TP,
  });
  assert.equal(place.status, 200);
  const { order } = await json<{ order: { id: number; userId: number } }>(place);
  assert.equal(order.userId, userAId);
  const events = await db.select().from(paperTradeEventsTable).where(eq(paperTradeEventsTable.paperOrderId, order.id));
  assert.ok(events.length > 0 && events.every((e) => e.userId === userAId), "order events carry the owner");

  const listed = await json<{ orders: Array<{ id: number }> }>(await request(`/paper/orders?accountId=${accountAId}`, cookieA));
  assert.ok(listed.orders.some((o) => o.id === order.id));
});

test("paper accounts: creating an account only deactivates the creator's other accounts", async () => {
  const res = await send("POST", "/paper/accounts", cookieB, { accountName: "B second", startingBalance: 5000 });
  assert.equal(res.status, 200);
  const { account } = await json<{ account: { id: number; userId: number } }>(res);
  assert.equal(account.userId, userBId);

  const [a] = await db.select().from(paperAccountsTable).where(eq(paperAccountsTable.id, accountAId));
  const [l] = await db.select().from(paperAccountsTable).where(eq(paperAccountsTable.id, legacy.accountId));
  const [bOld] = await db.select().from(paperAccountsTable).where(eq(paperAccountsTable.id, accountBId));
  assert.equal(a!.isActive, 1, "A's active account must stay active");
  assert.equal(l!.isActive, 1, "legacy account must be untouched");
  assert.equal(bOld!.isActive, 0, "B's previous account is deactivated");
});

test("debriefs: user B cannot debrief, read or edit user A's trade", async () => {
  assert.equal((await send("POST", "/post-trade-debriefs", cookieB, { tradeId: closedOrderAId, checklist: [] })).status, 404);

  const created = await send("POST", "/post-trade-debriefs", cookieA, { tradeId: closedOrderAId, checklist: [] });
  assert.equal(created.status, 200);
  const { debrief } = await json<{ debrief: { id: number; userId: number } }>(created);
  assert.equal(debrief.userId, userAId);

  assert.equal((await request(`/post-trade-debriefs/by-trade/${closedOrderAId}`, cookieB)).status, 404);
  assert.equal((await request(`/auto-debrief/by-trade/${closedOrderAId}`, cookieB)).status, 404);
  assert.equal((await request(`/auto-debrief/learning-payload/${closedOrderAId}`, cookieB)).status, 404);
  assert.equal((await send("PATCH", `/post-trade-debriefs/${debrief.id}`, cookieB, { lessonLearned: "hijack" })).status, 404);
  assert.equal((await send("POST", `/post-trade-debriefs/${debrief.id}/regenerate`, cookieB)).status, 404);
  assert.equal((await send("POST", `/auto-debrief/process/${closedOrderAId}`, cookieB)).status, 404);

  const listB = await json<{ debriefs: Array<{ id: number }> }>(await request("/post-trade-debriefs", cookieB));
  assert.equal(listB.debriefs.length, 0);
  const listA = await json<{ debriefs: Array<{ id: number }> }>(await request("/post-trade-debriefs", cookieA));
  assert.deepEqual(listA.debriefs.map((d) => d.id), [debrief.id], "legacy debriefs stay invisible");
});

test("prop challenges cannot be opened on another user's or a legacy paper account", async () => {
  const body = { challengeName: "qa" };
  assert.equal((await send("POST", "/prop-challenges", cookieB, { ...body, paperAccountId: accountAId })).status, 404);
  assert.equal((await send("POST", "/prop-challenges", cookieA, { ...body, paperAccountId: legacy.accountId })).status, 404);
});

test("analytics aggregates only the caller's own closed trades", async () => {
  const res = await send("POST", "/analytics/snapshot", cookieA);
  assert.equal(res.status, 200);
  const { snapshot } = await json<{ snapshot: { userId: number; totalTrades: number; netProfitLoss: number } }>(res);
  assert.equal(snapshot.userId, userAId);
  assert.equal(snapshot.totalTrades, 1, "only A's one closed trade counts");
  assert.ok(snapshot.netProfitLoss < 100, `B's and legacy P&L must not leak into A (got ${snapshot.netProfitLoss})`);

  const latestB = await json<{ snapshot: unknown }>(await request("/analytics/snapshot", cookieB));
  assert.equal(latestB.snapshot, null);

  const dd = await json<{ equityCurve: Array<{ tradeId: number }> }>(await request("/analytics/drawdown", cookieA));
  assert.deepEqual(dd.equityCurve.map((p) => p.tradeId), [closedOrderAId]);
  const strat = await json<{ strategies: Array<{ symbol: string }> }>(await request("/analytics/strategy", cookieA));
  assert.deepEqual(strat.strategies.map((s) => s.symbol), ["QAOWN.A"]);
});

test("mentor sessions and action items are per user", async () => {
  const gen = await send("POST", "/mentor/sessions", cookieA, { sessionType: "DAILY_BRIEFING" });
  assert.equal(gen.status, 200);
  const { session, actionItems } = await json<{ session: { id: number; userId: number; mainFocus: string }; actionItems: Array<{ id: number; userId: number }> }>(gen);
  assert.equal(session.userId, userAId);
  assert.ok(actionItems.length > 0 && actionItems.every((i) => i.userId === userAId));

  const latestB = await json<{ session: unknown }>(await request("/mentor/sessions/latest", cookieB));
  assert.equal(latestB.session, null, "B sees neither A's nor the legacy session");
  const listA = await json<{ sessions: Array<{ id: number }> }>(await request("/mentor/sessions", cookieA));
  assert.deepEqual(listA.sessions.map((s) => s.id), [session.id]);
  const itemsB = await json<{ actionItems: unknown[] }>(await request("/mentor/action-items", cookieB));
  assert.equal(itemsB.actionItems.length, 0);

  const patch = await send("PATCH", `/mentor/action-items/${actionItems[0]!.id}`, cookieB, { status: "DONE" });
  assert.equal(patch.status, 404);
  const [item] = await db.select().from(mentorActionItemsTable).where(eq(mentorActionItemsTable.id, actionItems[0]!.id));
  assert.equal(item!.status, "PENDING");
});

test("skill profiles are computed from and visible to the owner only", async () => {
  const calc = await send("POST", "/skill/calculate", cookieA);
  assert.equal(calc.status, 200);
  const { profile } = await json<{ profile: { userId: number } }>(calc);
  assert.equal(profile.userId, userAId);

  const b = await json<{ profile: unknown }>(await request("/skill/profile", cookieB));
  assert.equal(b.profile, null, "the legacy Elite profile must not surface for B");
  const sugg = await json<{ suggestions: Array<{ area: string }> }>(await request("/skill/suggestions", cookieB));
  assert.equal(sugg.suggestions[0]!.area, "GETTING_STARTED");
});

test("edge reports are built from and visible to the owner only", async () => {
  const gen = await send("POST", "/edge/reports", cookieA, { groupBy: "symbol" });
  assert.equal(gen.status, 200);
  const { reports } = await json<{ reports: Array<{ id: number; userId: number; edgeName: string }> }>(gen);
  assert.ok(reports.length > 0);
  assert.ok(reports.every((r) => r.userId === userAId));
  assert.ok(reports.every((r) => !r.edgeName.includes("QAOWN.B") && !r.edgeName.includes("LEGACY")),
    "A's report must not group B's or legacy trades");

  assert.equal((await request(`/edge/reports/${reports[0]!.id}`, cookieB)).status, 404);
  assert.equal((await request(`/edge/reports/${legacy.edgeReportId}`, cookieA)).status, 404);
  const listB = await json<{ reports: unknown[] }>(await request("/edge/reports", cookieB));
  assert.equal(listB.reports.length, 0);
  const strongB = await json<{ reports: unknown[] }>(await request("/edge/strongest", cookieB));
  assert.equal(strongB.reports.length, 0);
});

test("rule contracts: per-user single-active invariant and no cross-user edit or evaluate", async () => {
  const mk = (cookie: string, name: string) => send("POST", "/rule-contracts", cookie, { contractName: name, isActive: true });
  const ca = await json<{ contract: { id: number; userId: number } }>(await mk(cookieA, "A rules"));
  assert.equal(ca.contract.userId, userAId);
  const cb = await json<{ contract: { id: number } }>(await mk(cookieB, "B rules"));

  const [aRow] = await db.select().from(tradingRuleContractsTable).where(eq(tradingRuleContractsTable.id, ca.contract.id));
  const [lRow] = await db.select().from(tradingRuleContractsTable).where(eq(tradingRuleContractsTable.id, legacy.contractId));
  assert.equal(aRow!.isActive, 1, "B activating a contract must not deactivate A's");
  assert.equal(lRow!.isActive, 1, "legacy contract must be untouched");

  const activeB = await json<{ contract: { id: number } }>(await request("/rule-contracts/active", cookieB));
  assert.equal(activeB.contract.id, cb.contract.id);

  assert.equal((await send("PATCH", `/rule-contracts/${ca.contract.id}`, cookieB, { contractName: "hijack" })).status, 404);
  assert.equal((await send("POST", `/rule-contracts/${ca.contract.id}/evaluate`, cookieB)).status, 404);
  assert.equal((await send("POST", "/session-commitments", cookieB, { contractId: ca.contract.id, commitmentText: "x" })).status, 404);
  assert.equal((await request(`/rule-contracts/${ca.contract.id}/violations`, cookieB)).status, 200);
  const violationsB = await json<{ violations: unknown[] }>(await request(`/rule-contracts/${ca.contract.id}/violations`, cookieB));
  assert.equal(violationsB.violations.length, 0);

  const evalA = await send("POST", `/rule-contracts/${ca.contract.id}/evaluate`, cookieA);
  assert.equal(evalA.status, 200);
  const { summary } = await json<{ summary: { tradesEvaluated: number } }>(evalA);
  const todaysA = (await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, userAId))).length;
  assert.equal(summary.tradesEvaluated, todaysA, "only A's own paper orders are evaluated");
});

test("weekly reviews count only the caller's trades and upsert per user", async () => {
  await db.insert(tradesTable).values({
    userId: userBId, symbol: "QAOWN.B", direction: "BUY", lot: 1, entryPrice: 1, stopLoss: 0.5, takeProfit: 2,
    strategy: "qa", confidence: 50, status: "CLOSED_WIN", pnl: 777, closedAt: new Date(),
  });
  const ra = await send("POST", "/weekly-reviews/generate", cookieA, {});
  assert.equal(ra.status, 200);
  const a = await json<{ review: { id: number; totalTrades: number; netProfitLoss: number } }>(ra);
  assert.equal(a.review.totalTrades, 0, "B's real trade must not count toward A's week");

  const rb = await send("POST", "/weekly-reviews/generate", cookieB, {});
  assert.equal(rb.status, 200);
  const b = await json<{ review: { id: number; totalTrades: number } }>(rb);
  assert.equal(b.review.totalTrades, 1);
  assert.notEqual(a.review.id, b.review.id, "same week, separate rows per user");

  const again = await json<{ review: { id: number } }>(await send("POST", "/weekly-reviews/generate", cookieA, {}));
  assert.equal(again.review.id, a.review.id, "re-generating upserts the caller's own row");

  const listA = await json<{ reviews: Array<{ id: number }> }>(await request("/weekly-reviews", cookieA));
  assert.deepEqual(listA.reviews.map((r) => r.id), [a.review.id]);
  const goalsB = await json<{ goals: Array<{ weeklyReviewId: number }> }>(await request(`/weekly-goals?reviewId=${a.review.id}`, cookieB));
  assert.equal(goalsB.goals.length, 0);
});

test("trade decision logs are per user", async () => {
  const logsA = await json<{ logs: Array<{ symbol: string }> }>(await request("/trade-decision/logs", cookieA));
  assert.deepEqual(logsA.logs.map((l) => l.symbol), ["QAOWN.A"]);
  const latestB = await json<{ latest: { symbol: string } }>(await request("/trade-decision/latest", cookieB));
  assert.equal(latestB.latest.symbol, "QAOWN.B");
  const legacyLookup = await json<{ latest: unknown }>(await request("/trade-decision/latest?symbol=QAOWN.LEGACY", cookieA));
  assert.equal(legacyLookup.latest, null);
});

test("readiness checks are stamped with and visible to the owner only", async () => {
  const res = await send("POST", "/readiness/checks", cookieA, {
    sessionName: "London", strategyReady: true, riskRulesConfirmed: true,
  });
  assert.equal(res.status, 200);
  const { check } = await json<{ check: { userId: number } }>(res);
  assert.equal(check.userId, userAId);
  assert.equal((await request("/readiness/checks/latest", cookieB)).status, 404);
  const listA = await json<{ checks: Array<{ sessionName: string }> }>(await request("/readiness/checks", cookieA));
  assert.deepEqual(listA.checks.map((c) => c.sessionName), ["London"]);
});
