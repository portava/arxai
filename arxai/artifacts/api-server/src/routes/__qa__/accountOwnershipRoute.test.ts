// Account, broker, paper-execution and coaching ownership boundary — real DB +
// genuine session route proof (step 1b of the per-user isolation work).
//
// Seeds two traders, one operator (ADMIN) and legacy ownerless rows, mounts
// the real live-positions, trade-management, portfolio-risk, broker, paper
// execution, autopilot, performance, coach, paper-session, cockpit, playbook,
// paper-ideas and backtest routers, and proves:
//   - a trader can never read or act on another trader's rows (404),
//   - legacy user_id NULL rows (the shared MT5 connection) reach operators only,
//   - server-wide singletons (shared feed sync, paper autopilot) are operator-only,
//   - aggregates (performance, coach, cockpit, portfolio risk) count only the
//     caller's own book,
//   - alerts and notifications from one user never surface or merge into
//     another user's.
//
// Run: pnpm --filter @workspace/api-server run test:account-ownership-route

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import {
  alertsTable,
  authUserSessionsTable,
  brokerHealthStateTable,
  backtestRunsTable,
  db,
  livePositionsTable,
  mt5CommandsTable,
  notificationsTable,
  paperAccountsTable,
  paperExecutionsTable,
  paperOrdersTable,
  paperSessionsTable,
  paperTradeEventsTable,
  paperTradeIdeasTable,
  playbookEntriesTable,
  portfolioRiskSnapshotsTable,
  positionEventsTable,
  traderCoachReportsTable,
  tradesTable,
  tradingPlaybooksTable,
  usersTable,
} from "@workspace/db";
import { attachAuthUser } from "../../lib/auth/middleware.js";
import { createUserSession } from "../../lib/auth/userSessions.js";
import { createAlert, getAlerts } from "../../lib/alerts/alertManager.js";
import { notify } from "../../lib/notifications/service.js";
import { MT5BridgeProvider } from "../../lib/broker/mt5BridgeProvider.js";
import livePositionsRouter from "../livePositions.js";
import tradeManagementRouter from "../tradeManagement.js";
import portfolioRiskRouter from "../portfolioRisk.js";
import brokerRouter from "../broker.js";
import brokerHealthRouter from "../brokerHealth.js";
import paperExecutionRouter from "../paperExecution.js";
import paperAutopilotRouter from "../paperAutopilot.js";
import performanceRouter from "../performanceCommandCenter.js";
import traderCoachRouter from "../traderCoach.js";
import paperSessionsRouter from "../paperSessions.js";
import tradingCockpitRouter from "../tradingCockpit.js";
import tradingPlaybooksRouter from "../tradingPlaybooks.js";
import paperIntelligenceRouter from "../paperIntelligence.js";
import backtestRunsRouter from "../backtestRuns.js";

const EMAIL_A = "qa+account-owner-a@arx.test";
const EMAIL_B = "qa+account-owner-b@arx.test";
const EMAIL_OP = "qa+account-owner-op@arx.test";
const MARK = "QAACCT";

const ENTRY = 100;
const FAR_SL = 0.0001;
const FAR_TP = 1e9;

let server: Server;
let base = "";
const u = { a: 0, b: 0, op: 0 };
const c = { a: "", b: "", op: "" };

const seed = {
  posA: 0, posB: 0, posLegacy: 0,
  tradeA: 0, tradeLegacy: 0,
  accountA: 0, accountB: 0,
  openOrderA: 0, closedOrderA: 0, closedOrderB: 0,
  execA: 0,
  playbookA: 0,
  ideaA: 0,
  backtestA: 0, backtestLegacy: 0,
  cmdA: 0, cmdLegacy: 0,
};

async function deleteFixtures(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.email, [EMAIL_A, EMAIL_B, EMAIL_OP]));
  const ids = users.map((x) => x.id);
  if (ids.length) {
    await db.delete(alertsTable).where(inArray(alertsTable.userId, ids));
    await db.delete(notificationsTable).where(inArray(notificationsTable.userId, ids));
    await db.delete(traderCoachReportsTable).where(inArray(traderCoachReportsTable.userId, ids));
    await db.delete(portfolioRiskSnapshotsTable).where(inArray(portfolioRiskSnapshotsTable.userId, ids));
    await db.delete(paperSessionsTable).where(inArray(paperSessionsTable.userId, ids));
    await db.delete(playbookEntriesTable).where(inArray(playbookEntriesTable.userId, ids));
    await db.delete(tradingPlaybooksTable).where(inArray(tradingPlaybooksTable.userId, ids));
    await db.delete(paperTradeIdeasTable).where(inArray(paperTradeIdeasTable.userId, ids));
    await db.delete(paperExecutionsTable).where(inArray(paperExecutionsTable.userId, ids));
    await db.delete(paperTradeEventsTable).where(inArray(paperTradeEventsTable.userId, ids));
    await db.delete(paperOrdersTable).where(inArray(paperOrdersTable.userId, ids));
    await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.userId, ids));
    await db.delete(backtestRunsTable).where(inArray(backtestRunsTable.userId, ids));
    await db.delete(mt5CommandsTable).where(inArray(mt5CommandsTable.userId, ids));
    await db.delete(livePositionsTable).where(inArray(livePositionsTable.userId, ids));
    await db.delete(tradesTable).where(inArray(tradesTable.userId, ids));
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
  // Ownerless fixtures carry the MARK in a text column.
  const legacyPos = await db.select({ id: livePositionsTable.id }).from(livePositionsTable)
    .where(and(isNull(livePositionsTable.userId), like(livePositionsTable.symbol, `${MARK}%`)));
  if (legacyPos.length) {
    await db.delete(positionEventsTable).where(inArray(positionEventsTable.livePositionId, legacyPos.map((p) => p.id)));
    await db.delete(livePositionsTable).where(inArray(livePositionsTable.id, legacyPos.map((p) => p.id)));
  }
  await db.delete(tradesTable).where(and(isNull(tradesTable.userId), like(tradesTable.symbol, `${MARK}%`)));
  await db.delete(backtestRunsTable).where(and(isNull(backtestRunsTable.userId), like(backtestRunsTable.symbol, `${MARK}%`)));
  await db.delete(mt5CommandsTable).where(and(isNull(mt5CommandsTable.userId), like(mt5CommandsTable.symbol, `${MARK}%`)));
  await db.delete(alertsTable).where(like(alertsTable.title, `${MARK}%`));
  await db.delete(notificationsTable).where(like(notificationsTable.dedupeKey, `%${MARK}%`));
}

async function seedUser(email: string, name: string, role = "USER"): Promise<{ id: number; cookie: string }> {
  const [user] = await db.insert(usersTable)
    .values({ email, name, role, isSystemUser: true })
    .returning({ id: usersTable.id });
  assert.ok(user);
  const { rawToken } = await createUserSession({ userId: user.id });
  return { id: user.id, cookie: `arx_user_session=${rawToken}` };
}

async function seedPosition(userId: number | null, symbol: string): Promise<number> {
  const [row] = await db.insert(livePositionsTable).values({
    userId, brokerPositionId: `${symbol}-${userId ?? "legacy"}-${Date.now()}`,
    symbol, direction: "BUY", lotSize: 0.01, entryPrice: ENTRY, currentPrice: ENTRY,
    stopLoss: 90, takeProfit: 120, status: "OPEN", openedAt: new Date(),
  }).returning({ id: livePositionsTable.id });
  return row!.id;
}

async function seedTrade(userId: number | null, symbol: string): Promise<number> {
  const [row] = await db.insert(tradesTable).values({
    userId, symbol, direction: "BUY", lot: 0.5, entryPrice: ENTRY, stopLoss: 90, takeProfit: 120,
    strategy: "qa", confidence: 50, status: "OPEN",
  }).returning({ id: tradesTable.id });
  return row!.id;
}

async function seedAccount(userId: number, name: string): Promise<number> {
  const [row] = await db.insert(paperAccountsTable).values({
    userId, accountName: name, startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, isActive: 1,
  }).returning({ id: paperAccountsTable.id });
  return row!.id;
}

async function seedOrder(userId: number, accountId: number, symbol: string, profitLoss?: number): Promise<number> {
  const closed = profitLoss !== undefined;
  const [row] = await db.insert(paperOrdersTable).values({
    userId, paperAccountId: accountId, symbol, direction: "BUY", lotSize: 0.01,
    entryPrice: ENTRY, stopLoss: FAR_SL, takeProfit: FAR_TP,
    status: closed ? "CLOSED_MANUAL" : "OPEN",
    exitPrice: closed ? ENTRY + profitLoss : null,
    profitLoss: profitLoss ?? 0,
    closedAt: closed ? new Date() : null,
  }).returning({ id: paperOrdersTable.id });
  return row!.id;
}

async function seedBacktest(userId: number | null): Promise<number> {
  const [row] = await db.insert(backtestRunsTable).values({
    userId, strategyId: "trendContinuation", symbol: `${MARK}.BT`, timeframe: "M5",
    startTime: new Date(Date.now() - 86_400_000), endTime: new Date(),
  }).returning({ id: backtestRunsTable.id });
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
  const a = await seedUser(EMAIL_A, "QA Account Owner A");
  const b = await seedUser(EMAIL_B, "QA Account Owner B");
  const op = await seedUser(EMAIL_OP, "QA Account Operator", "ADMIN");
  u.a = a.id; c.a = a.cookie;
  u.b = b.id; c.b = b.cookie;
  u.op = op.id; c.op = op.cookie;

  seed.posA = await seedPosition(u.a, `${MARK}.A`);
  seed.posB = await seedPosition(u.b, `${MARK}.B`);
  seed.posLegacy = await seedPosition(null, `${MARK}.LEGACY`);
  seed.tradeA = await seedTrade(u.a, `${MARK}.A`);
  seed.tradeLegacy = await seedTrade(null, `${MARK}.LEGACY`);

  seed.accountA = await seedAccount(u.a, "A sandbox");
  seed.accountB = await seedAccount(u.b, "B sandbox");
  seed.openOrderA = await seedOrder(u.a, seed.accountA, `${MARK}.A`);
  seed.closedOrderA = await seedOrder(u.a, seed.accountA, `${MARK}.A`, 1);
  // B's closed trade carries a large, recognisable P&L so a leak into A's
  // aggregates is obvious.
  seed.closedOrderB = await seedOrder(u.b, seed.accountB, `${MARK}.B`, 500);

  [{ id: seed.execA }] = await db.insert(paperExecutionsTable).values({
    userId: u.a, executionId: `exec_${MARK}_a_${Date.now()}`, decisionId: 2_000_000_000 - (Date.now() % 1_000_000),
    orderId: seed.openOrderA, symbol: `${MARK}.A`, action: "BUY", status: "PAPER_OPENED",
    fillType: "SIMULATED_MARKET", executionMode: "PAPER",
  }).returning({ id: paperExecutionsTable.id }) as [{ id: number }];

  [{ id: seed.playbookA }] = await db.insert(tradingPlaybooksTable).values({
    userId: u.a, title: `${MARK} A playbook`,
  }).returning({ id: tradingPlaybooksTable.id }) as [{ id: number }];
  [{ id: seed.ideaA }] = await db.insert(paperTradeIdeasTable).values({
    userId: u.a, symbol: `${MARK}.A`, direction: "BUY", entryIdea: ENTRY, stopLossIdea: 90, takeProfitIdea: 120,
  }).returning({ id: paperTradeIdeasTable.id }) as [{ id: number }];
  seed.backtestA = await seedBacktest(u.a);
  seed.backtestLegacy = await seedBacktest(null);

  [{ id: seed.cmdA }] = await db.insert(mt5CommandsTable).values({
    userId: u.a, action: "MODIFY", status: "BLOCKED", symbol: `${MARK}.A`,
  }).returning({ id: mt5CommandsTable.id }) as [{ id: number }];
  [{ id: seed.cmdLegacy }] = await db.insert(mt5CommandsTable).values({
    userId: null, action: "MODIFY", status: "BLOCKED", symbol: `${MARK}.LEGACY`,
  }).returning({ id: mt5CommandsTable.id }) as [{ id: number }];

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachAuthUser);
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: unknown }).log = { error: noop, warn: noop, info: noop, debug: noop };
    next();
  });
  for (const r of [
    // Same order as routes/index.ts: broker before live positions, so
    // /positions/live is not read as /positions/:id.
    brokerHealthRouter, brokerRouter, livePositionsRouter, tradeManagementRouter, portfolioRiskRouter,
    paperExecutionRouter, paperAutopilotRouter, performanceRouter, traderCoachRouter,
    paperSessionsRouter, tradingCockpitRouter, tradingPlaybooksRouter, backtestRunsRouter,
  ]) app.use("/api", r);
  app.use("/api/paper", paperIntelligenceRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteFixtures();
});

// ── live positions ─────────────────────────────────────────────────────────

test("live positions: a trader lists only their own, an operator also sees the shared feed", async () => {
  const idsOf = async (cookie: string) =>
    (await json<{ positions: { id: number }[] }>(await request("/positions", cookie))).positions.map((p) => p.id);
  const a = await idsOf(c.a);
  assert.ok(a.includes(seed.posA));
  assert.ok(!a.includes(seed.posB) && !a.includes(seed.posLegacy));
  const op = await idsOf(c.op);
  assert.ok(op.includes(seed.posLegacy));
  assert.ok(!op.includes(seed.posA) && !op.includes(seed.posB), "an operator does not see traders' own rows");
  assert.equal((await request("/positions")).status, 401);
});

test("live positions: another trader's or a legacy position answers 404 on read and every mutation", async () => {
  for (const id of [seed.posB, seed.posLegacy]) {
    assert.equal((await request(`/positions/${id}`, c.a)).status, 404);
    assert.equal((await request(`/positions/${id}/events`, c.a)).status, 404);
    assert.equal((await send("PATCH", `/positions/${id}/stop-loss`, c.a, { stopLoss: 95 })).status, 404);
    assert.equal((await send("PATCH", `/positions/${id}/take-profit`, c.a, { takeProfit: 130 })).status, 404);
    assert.equal((await send("POST", `/positions/${id}/close-confirmation`, c.a)).status, 404);
    assert.equal((await send("POST", `/positions/${id}/close`, c.a, { confirm: true })).status, 404);
  }
  const [b] = await db.select().from(livePositionsTable).where(eq(livePositionsTable.id, seed.posB));
  assert.equal(b!.status, "OPEN");
  assert.equal(b!.stopLoss, 90);
  assert.equal((await request(`/positions/${seed.posA}`, c.a)).status, 200);
});

test("live positions: only an operator may sync the shared broker feed", async () => {
  assert.equal((await send("POST", "/positions/sync", c.a)).status, 403);
  const res = await send("POST", "/positions/sync", c.op);
  assert.equal(res.status, 200);
  const ids = (await json<{ positions: { id: number }[] }>(res)).positions.map((p) => p.id);
  assert.ok(!ids.includes(seed.posA) && !ids.includes(seed.posB), "sync response is scoped to the operator");
});

// ── trade management ───────────────────────────────────────────────────────

test("trade management: another user's or a legacy trade is 404 and is never modified", async () => {
  for (const path of ["snapshot"]) {
    assert.equal((await request(`/trade-management/${seed.tradeA}/${path}`, c.b)).status, 404);
    assert.equal((await request(`/trade-management/${seed.tradeLegacy}/${path}`, c.b)).status, 404);
  }
  for (const action of ["breakeven", "trail", "partial-close", "close"]) {
    assert.equal((await send("POST", `/trade-management/${seed.tradeA}/${action}`, c.b, {})).status, 404, action);
  }
  const [t] = await db.select().from(tradesTable).where(eq(tradesTable.id, seed.tradeA));
  assert.equal(t!.status, "OPEN");
  assert.equal(t!.lot, 0.5);
  assert.equal(t!.stopLoss, 90);
  assert.equal((await request(`/trade-management/${seed.tradeA}/snapshot`, c.a)).status, 200);
  assert.equal((await request(`/trade-management/${seed.tradeLegacy}/snapshot`, c.op)).status, 200);
});

test("trade management: break-even never widens a stop already locked in profit", async () => {
  const id = await seedTrade(u.a, `${MARK}.GUARD`);
  await db.update(tradesTable).set({ stopLoss: ENTRY + 5 }).where(eq(tradesTable.id, id));
  const res = await send("POST", `/trade-management/${id}/breakeven`, c.a, {});
  assert.equal(res.status, 409);
  assert.equal((await json<{ error: string }>(res)).error, "STOP_WOULD_WIDEN");
  const [t] = await db.select().from(tradesTable).where(eq(tradesTable.id, id));
  assert.equal(t!.stopLoss, ENTRY + 5);
  await db.update(tradesTable).set({ stopLoss: 90 }).where(eq(tradesTable.id, id));
  const ok = await send("POST", `/trade-management/${id}/breakeven`, c.a, {});
  assert.equal(ok.status, 200, "moving a stop below entry up to break-even tightens it");
});

// ── portfolio risk ─────────────────────────────────────────────────────────

test("portfolio risk: a snapshot counts only the caller's own open positions", async () => {
  const res = await send("POST", "/portfolio-risk/snapshot", c.a);
  assert.equal(res.status, 200);
  const body = await json<{ openPositionsCount: number; inputsSnapshot: { positions: { symbol: string }[] } }>(res);
  const symbols = body.inputsSnapshot.positions.map((p) => p.symbol);
  assert.deepEqual(symbols, [`${MARK}.A`]);
  assert.equal(body.openPositionsCount, 1);
});

// ── broker reads ───────────────────────────────────────────────────────────

test("broker reads: the MT5 bridge provider returns only the caller's positions and commands", async () => {
  // The registry defaults to the mock provider in tests, so drive the real MT5
  // provider directly with the owner the broker routes pass it.
  const mt5 = new MT5BridgeProvider();
  const posB = (await mt5.positions({ userId: u.b, includeLegacy: false })).map((p) => p.symbol);
  assert.ok(posB.includes(`${MARK}.B`));
  assert.ok(!posB.includes(`${MARK}.A`) && !posB.includes(`${MARK}.LEGACY`));
  const posOp = (await mt5.positions({ userId: u.op, includeLegacy: true })).map((p) => p.symbol);
  assert.ok(posOp.includes(`${MARK}.LEGACY`) && !posOp.includes(`${MARK}.A`));
  const ordB = (await mt5.orders({ userId: u.b, includeLegacy: false }, 500)).map((o) => o.id);
  assert.ok(!ordB.includes(String(seed.cmdA)) && !ordB.includes(String(seed.cmdLegacy)));
  const ordA = (await mt5.orders({ userId: u.a, includeLegacy: false }, 500)).map((o) => o.id);
  assert.ok(ordA.includes(String(seed.cmdA)));
  // The route builds the owner from the session, so it answers for the caller.
  assert.equal((await request("/positions/live", c.b)).status, 200);
});

// ── paper execution ────────────────────────────────────────────────────────

test("paper execution: lists, detail, manual close and monitor stay inside the caller's book", async () => {
  const openB = await json<{ open: { id: number }[] }>(await request("/paper-execution/open", c.b));
  assert.ok(!openB.open.some((e) => e.id === seed.execA));
  const tradesB = await json<{ trades: { id: number }[] }>(await request("/paper-execution/trades", c.b));
  assert.ok(!tradesB.trades.some((e) => e.id === seed.execA));
  assert.equal((await request(`/paper-execution/trade/${seed.execA}`, c.b)).status, 404);
  assert.equal((await request(`/paper-execution/trade/${seed.execA}`, c.a)).status, 200);

  assert.equal((await send("POST", `/paper-execution/close/${seed.openOrderA}`, c.b, { exitPrice: 1 })).status, 409);
  // B forces a crash price; only B's own open orders may be touched.
  const mon = await json<{ monitor: { updates: { paperOrderId: number }[] } }>(
    await send("POST", "/paper-execution/monitor", c.b, { forcePrice: FAR_SL / 10, forceSymbol: `${MARK}.A` }));
  assert.ok(!mon.monitor.updates.some((x) => x.paperOrderId === seed.openOrderA));
  const [o] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, seed.openOrderA));
  assert.equal(o!.status, "OPEN");
  assert.equal((await request("/paper-execution/open")).status, 401);
});

test("paper execution: a decision id that belongs to someone else cannot be executed", async () => {
  const res = await send("POST", "/paper-execution/from-decision", c.b, { decisionId: 2_000_000_000 });
  assert.equal(res.status, 404);
});

// ── autopilot singleton ────────────────────────────────────────────────────

test("paper autopilot: the server-wide loop is operator-only", async () => {
  for (const [m, p] of [
    ["GET", "/paper-autopilot/status"], ["GET", "/paper-autopilot/settings"],
    ["POST", "/paper-autopilot/settings"], ["POST", "/paper-autopilot/start"],
    ["POST", "/paper-autopilot/stop"], ["POST", "/paper-autopilot/run-once"],
    ["GET", "/paper-autopilot/cycles"], ["GET", "/paper-autopilot/logs"],
    ["GET", "/paper-autopilot/cooldowns"],
  ] as const) {
    assert.equal((await send(m, p, c.a, m === "POST" ? {} : undefined)).status, 403, `${m} ${p}`);
  }
  assert.equal((await request("/paper-autopilot/status", c.op)).status, 200);
});

// ── performance + coach + cockpit aggregates ───────────────────────────────

test("performance: range summary and command center count only the caller's trades", async () => {
  const s = await json<{ summary: { net_pnl: number; total_trades: number } }>(
    await request("/performance/range-summary?range=7d", c.a));
  assert.ok(s.summary.net_pnl < 500, `A's net P&L ${s.summary.net_pnl} includes B's trade`);
  const sb = await json<{ summary: { net_pnl: number } }>(await request("/performance/range-summary?range=7d", c.b));
  assert.ok(sb.summary.net_pnl >= 500);
  const symA = await json<{ symbols: { symbol: string }[] }>(await request("/performance/symbols?range=7d", c.a));
  assert.ok(!symA.symbols.some((x) => x.symbol === `${MARK}.B`));
});

test("trader coach: reports are generated from and stored for the caller only", async () => {
  const gen = await json<{ coach: { coach_report_id: string; performanceSummary: { netPnl: number } } }>(
    await send("POST", "/trader-coach/generate", c.a, {}));
  assert.ok(gen.coach.performanceSummary.netPnl < 500);
  const [row] = await db.select().from(traderCoachReportsTable)
    .where(eq(traderCoachReportsTable.coachReportId, gen.coach.coach_report_id));
  assert.equal(row!.userId, u.a);
  const listB = await json<{ reports: { coachReportId: string }[] }>(await request("/trader-coach/reports", c.b));
  assert.ok(!listB.reports.some((r) => r.coachReportId === gen.coach.coach_report_id));
  assert.equal((await send("POST", "/trader-coach/playbook/generate", c.a, {})).status, 403);
  assert.equal((await request("/trader-coach/logs", c.a)).status, 403);
});

test("cockpit: open paper trades and today's performance are the caller's", async () => {
  const s = await json<{ summary: { openPaperTrades: { id: number }[]; todayPerformance: { netPnl: number } } }>(
    await request("/trading-cockpit/summary", c.a));
  assert.ok(s.summary.openPaperTrades.some((t) => t.id === seed.openOrderA));
  assert.ok(s.summary.todayPerformance.netPnl < 500);
  const sb = await json<{ summary: { openPaperTrades: { id: number }[] } }>(await request("/trading-cockpit/summary", c.b));
  assert.ok(!sb.summary.openPaperTrades.some((t) => t.id === seed.openOrderA));
});

// ── paper sessions ─────────────────────────────────────────────────────────

test("paper sessions: sessions, the active session and lifecycle actions are per trader", async (t) => {
  // Paper sessions need paper_trade:create, which a plain USER (VIEWER) lacks
  // in production and, with one role model, in dev too. Both traders are
  // testers for this case only.
  await db.update(usersTable).set({ role: "TESTER" }).where(inArray(usersTable.id, [u.a, u.b]));
  t.after(async () => { await db.update(usersTable).set({ role: "USER" }).where(inArray(usersTable.id, [u.a, u.b])); });
  const start = await json<{ result: { session: { paper_session_id: string } } }>(
    await send("POST", "/paper-sessions/start", c.a, {}));
  const sid = start.result.session.paper_session_id;
  const [row] = await db.select().from(paperSessionsTable).where(eq(paperSessionsTable.paperSessionId, sid));
  assert.equal(row!.userId, u.a);

  const listB = await json<{ sessions: { paper_session_id: string }[] }>(await request("/paper-sessions", c.b));
  assert.ok(!listB.sessions.some((x) => x.paper_session_id === sid));
  assert.equal((await request(`/paper-sessions/${sid}`, c.b)).status, 404);
  assert.equal((await request(`/paper-sessions/${sid}/events`, c.b)).status, 404);
  assert.equal((await request(`/paper-sessions/${sid}/trades`, c.b)).status, 404);
  assert.equal((await send("POST", "/paper-sessions/end", c.b, { paperSessionId: sid })).status, 400);
  const [still] = await db.select().from(paperSessionsTable).where(eq(paperSessionsTable.paperSessionId, sid));
  assert.notEqual(still!.status, "ENDED");
  const activeB = await json<{ active: unknown }>(await request("/paper-sessions/active", c.b));
  if (row!.status === "ACTIVE") assert.equal(activeB.active, null, "A's active session is not B's");
});

// ── playbooks, ideas, backtests ────────────────────────────────────────────

test("playbooks: a trader cannot list, edit, add entries to or mine another trader's playbook", async () => {
  const listB = await json<{ playbooks: { id: number }[] }>(await request("/playbooks", c.b));
  assert.ok(!listB.playbooks.some((p) => p.id === seed.playbookA));
  assert.equal((await send("PATCH", `/playbooks/${seed.playbookA}`, c.b, { title: "hijack" })).status, 404);
  assert.equal((await send("POST", "/playbook-entries", c.b,
    { playbookId: seed.playbookA, entryType: "RULE", title: "x" })).status, 404);
  assert.equal((await request(`/playbook-entries?playbookId=${seed.playbookA}`, c.b)).status, 404);
  assert.equal((await send("POST", `/playbooks/${seed.playbookA}/suggest`, c.b)).status, 404);
  const [pb] = await db.select().from(tradingPlaybooksTable).where(eq(tradingPlaybooksTable.id, seed.playbookA));
  assert.equal(pb!.title, `${MARK} A playbook`);
  const created = await json<{ playbook: { id: number; userId: number } }>(
    await send("POST", "/playbooks", c.b, { title: `${MARK} B playbook` }));
  assert.equal(created.playbook.userId, u.b);
});

test("paper ideas: the watchlist is per trader", async () => {
  const listB = await json<{ ideas: { id: number }[] }>(await request("/paper/ideas", c.b));
  assert.ok(!listB.ideas.some((i) => i.id === seed.ideaA));
  assert.equal((await send("PATCH", `/paper/ideas/${seed.ideaA}`, c.b, { status: "REJECTED" })).status, 404);
  const [idea] = await db.select().from(paperTradeIdeasTable).where(eq(paperTradeIdeasTable.id, seed.ideaA));
  assert.equal(idea!.status, "WATCHLIST");
});

test("backtests: a trader sees their own runs; legacy runs belong to the operator", async () => {
  for (const id of [seed.backtestA, seed.backtestLegacy]) {
    assert.equal((await request(`/backtest-runs/${id}`, c.b)).status, 404);
    assert.equal((await request(`/backtest-runs/${id}/trades`, c.b)).status, 404);
    assert.equal((await send("POST", `/backtest-runs/${id}/ai-review`, c.b)).status, 404);
  }
  assert.notEqual((await request(`/backtest-runs/${seed.backtestLegacy}`, c.op)).status, 404);
});

// ── alerts + notifications ─────────────────────────────────────────────────

test("alerts: a user's alert is visible to them and never to another user", async () => {
  await createAlert({ userId: u.a, type: "TRADE_CLOSED", title: `${MARK} A closed`, message: "A pnl 42", dedupeKey: `${MARK}:same` });
  // Same dedupe key from B must not be swallowed by A's alert.
  const bAlert = await createAlert({ userId: u.b, type: "TRADE_CLOSED", title: `${MARK} B closed`, message: "B pnl 7", dedupeKey: `${MARK}:same` });
  assert.notEqual(bAlert.id, 0);
  const titlesB = (await getAlerts(u.b, 500)).map((x) => x.title);
  assert.ok(titlesB.includes(`${MARK} B closed`));
  assert.ok(!titlesB.includes(`${MARK} A closed`));
});

test("notifications: the same event for two users creates two notifications, not a merged one", async () => {
  const base = { type: "TRADE" as const, severity: "INFO" as const, sourceBuild: "EE" as const, title: "Paper trade", dedupeKey: `${MARK}:evt` };
  const ra = await notify({ ...base, message: "A detail", userId: u.a });
  const rb = await notify({ ...base, message: "B detail", userId: u.b });
  assert.equal(ra.status, "CREATED");
  assert.equal(rb.status, "CREATED");
  const [na] = await db.select().from(notificationsTable)
    .where(and(eq(notificationsTable.userId, u.a), like(notificationsTable.dedupeKey, `%${MARK}:evt`)));
  assert.equal(na!.message, "A detail");
});

// ── broker health (server-wide MT5 feed) ───────────────────────────────────

test("broker health: a trader can read the status but not the operator's account number, and cannot flip operator toggles", async () => {
  const read = await request("/broker/health", c.a);
  assert.equal(read.status, 200);
  assert.equal((await json<{ accountNumber: unknown }>(read)).accountNumber, null);
  // The read initializes a missing singleton to disabled. Capture that real
  // baseline after initialization, before any forbidden mutation attempt.
  const before = await db.select().from(brokerHealthStateTable).limit(1);
  assert.ok(before[0], "health read initialized its canonical state");
  for (const path of ["/broker/health-check", "/broker/reconnect", "/broker/disable-execution", "/broker/enable-execution"]) {
    const res = await send("POST", path, c.a, {});
    assert.equal(res.status, 403, `${path} is operator-only`);
  }
  const afterRows = await db.select().from(brokerHealthStateTable).limit(1);
  assert.equal(afterRows[0]?.executionEnabled, before[0]?.executionEnabled, "a trader's disable attempt changed nothing");
  const op = await send("POST", "/broker/health-check", c.op, {});
  assert.equal(op.status, 200, await op.clone().text());
});
