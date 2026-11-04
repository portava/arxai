// One paper book (docs/TIER1_PAPER_BOOK.md), on a real database.
//
//   paper_orders / paper_trade_events are written only by the PAPER venue:
//     openPaperFill   — governed OPEN (venue PAPER), books at the caller's
//                       fill price; a refusal writes nothing.
//     closePaperFill  — governed CLOSE, owner-scoped.
//     settlePaperOrder / voidPaperOrder — venue fills / rollback, not
//                       re-governed, only status / exit / P&L move.
//   The Build EE monitor settles stop/target hits and governs manual closes
//   through the venue, with the same rows and event text as before.
//   trades (legacy record of the retired /execute-trade) is updated only by
//   lib/trades/paperBook.ts; the emergency-stop cancel stays owner-scoped.
//
// Nothing here reaches a broker.
//
// Run: pnpm --filter @workspace/api-server run test:paper-book

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  analyticsSnapshotsTable,
  db,
  paperAccountsTable,
  paperOrdersTable,
  paperTradeEventsTable,
  postTradeDebriefsTable,
  tradesTable,
  userRiskEventsTable,
  usersTable,
} from "@workspace/db";
import {
  SIMULATED_TAG, closePaperFill, openPaperFill, settlePaperOrder, voidPaperOrder, type PaperFillOpenArgs,
} from "../paperVenue.js";
import { fillPaperTrade, settlePaperTrade, voidPaperTrade } from "../pipeline.js";
import { closePaperManually, runPaperMonitor } from "../../paperExecution/paperExecutionMonitor.js";
import { cancelOpenLegacyTrades } from "../../trades/paperBook.js";

const EMAIL_A = "qa+paper-book-a@arx.test";
const EMAIL_B = "qa+paper-book-b@arx.test";
const SYMBOL = "QAPBUSD";
const SYMBOL_2 = "QAPCUSD"; // a second order on the same symbol and side is a governor duplicate
const PX = 1.1;
const u = { a: 0, b: 0 };

async function userIds(): Promise<number[]> {
  return (await db.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.email, [EMAIL_A, EMAIL_B]))).map((x) => x.id);
}

async function clearBooks(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(postTradeDebriefsTable).where(inArray(postTradeDebriefsTable.userId, ids));
  await db.delete(analyticsSnapshotsTable).where(inArray(analyticsSnapshotsTable.userId, ids));
  await db.delete(paperTradeEventsTable).where(inArray(paperTradeEventsTable.userId, ids));
  await db.delete(paperOrdersTable).where(inArray(paperOrdersTable.userId, ids));
  await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.userId, ids));
  await db.delete(tradesTable).where(inArray(tradesTable.userId, ids));
}

async function deleteFixtures(): Promise<void> {
  const ids = await userIds();
  await clearBooks(ids);
  if (ids.length) await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function seedUser(email: string): Promise<number> {
  const [user] = await db.insert(usersTable).values({ email, name: email, role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  return user!.id;
}

async function freshAccount(userId: number): Promise<number> {
  await clearBooks([userId]);
  const [acct] = await db.insert(paperAccountsTable).values({
    userId, accountName: "QA paper book", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, isActive: 1,
  }).returning({ id: paperAccountsTable.id });
  return acct!.id;
}

const fill = (userId: number, paperAccountId: number, over: Partial<PaperFillOpenArgs> = {}) => openPaperFill({
  userId, paperAccountId, symbol: SYMBOL, side: "BUY", lots: 0.1, fillPrice: PX,
  stopLoss: 1.09, takeProfit: 1.12, decisionId: null, strategyId: "build_ee_paper_execution",
  origin: "automation", governedEntryPrice: null,
  quote: { bid: PX, ask: PX, at: new Date(), source: "qa_paper_book" },
  auditContext: { caller: "QA paper book" },
  placedMessage: `${SIMULATED_TAG} QA placed`,
  ...over,
});

async function riskRows(userId: number) {
  return db.select().from(userRiskEventsTable).where(eq(userRiskEventsTable.userId, userId)).orderBy(asc(userRiskEventsTable.id));
}
async function events(orderId: number) {
  return db.select().from(paperTradeEventsTable).where(eq(paperTradeEventsTable.paperOrderId, orderId)).orderBy(asc(paperTradeEventsTable.id));
}

before(async () => {
  await deleteFixtures();
  u.a = await seedUser(EMAIL_A);
  u.b = await seedUser(EMAIL_B);
});

after(async () => {
  await deleteFixtures();
});

test("openPaperFill: governed OPEN with venue PAPER, books at the caller's fill price with its event", async () => {
  const acct = await freshAccount(u.a);
  const r = await fill(u.a, acct);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.order.userId, u.a);
  assert.equal(r.order.entryPrice, PX);
  assert.equal(r.order.status, "OPEN");
  assert.equal(r.order.orderType, "MARKET");
  assert.equal(r.order.strategyId, "build_ee_paper_execution");
  const audit = await riskRows(u.a);
  assert.equal(audit.length, 1, "exactly one governor decision");
  const intent = (audit[0]!.details as { intent: Record<string, unknown> }).intent;
  assert.equal(intent["venue"], "PAPER");
  assert.equal(intent["action"], "OPEN");
  assert.equal(intent["origin"], "automation");
  const ev = await events(r.order.id);
  assert.deepEqual(ev.map((e) => [e.eventType, e.message]), [["PLACED", `${SIMULATED_TAG} QA placed`]]);

  const quiet = await fill(u.a, acct, { symbol: SYMBOL_2, placedMessage: null, strategyId: null, origin: "system", intentRef: "qa_fixture" });
  assert.ok(quiet.ok);
  assert.equal((await events(quiet.order.id)).length, 0, "the QA fixture path writes no event, as before");
});

test("openPaperFill: a Risk Governor refusal books nothing and returns the decision", async () => {
  const acct = await freshAccount(u.a);
  const r = await fill(u.a, acct, { lots: 6 });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.risk.blockedBy.includes("max_position_size"), JSON.stringify(!r.ok && r.risk.blockedBy));
  assert.equal((await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.paperAccountId, acct))).length, 0);
  assert.equal((await db.select().from(paperTradeEventsTable).where(eq(paperTradeEventsTable.userId, u.a))).length, 0);
});

test("Trade Engine PAPER fills: fillPaperTrade / settlePaperTrade / voidPaperTrade pass through to the venue unchanged", async () => {
  const acct = await freshAccount(u.a);
  const args = (over: Partial<PaperFillOpenArgs> = {}): PaperFillOpenArgs => ({
    userId: u.a, paperAccountId: acct, symbol: SYMBOL, side: "BUY", lots: 0.1, fillPrice: PX,
    stopLoss: 1.09, takeProfit: 1.12, decisionId: null, strategyId: "build_ee_paper_execution",
    origin: "automation", governedEntryPrice: null,
    quote: { bid: PX, ask: PX, at: new Date(), source: "qa_paper_book" },
    auditContext: { caller: "QA paper book" }, placedMessage: `${SIMULATED_TAG} QA placed`, ...over,
  });
  // OPEN: same row and event as the venue's own fill.
  const viaPipe = await fillPaperTrade({ mode: "PAPER", intent: "OPEN" }, args());
  const direct = await openPaperFill(args({ symbol: SYMBOL_2 }));
  assert.ok(viaPipe.ok && direct.ok, JSON.stringify([viaPipe, direct]));
  const strip = (o: Record<string, unknown>) => {
    const { id: _i, symbol: _s, createdAt: _c, updatedAt: _u, openedAt: _o, ...rest } = o;
    return rest;
  };
  assert.deepEqual(strip(viaPipe.order), strip(direct.order));
  assert.equal(viaPipe.risk.allowed, true);
  assert.deepEqual((await events(viaPipe.order.id)).map((e) => [e.eventType, e.message]), [["PLACED", `${SIMULATED_TAG} QA placed`]]);

  // A Risk Governor refusal keeps its full rule detail (Build EE's rejection rows read it).
  const refusedPipe = await fillPaperTrade({ mode: "PAPER", intent: "OPEN" }, args({ symbol: "QAPDUSD", lots: 6 }));
  const refusedDirect = await openPaperFill(args({ symbol: "QAPEUSD", lots: 6 }));
  assert.ok(!refusedPipe.ok && !refusedDirect.ok);
  assert.equal(refusedPipe.reason, "RISK_GOVERNOR_BLOCK");
  assert.deepEqual(refusedPipe.risk.blockedBy, refusedDirect.risk.blockedBy);
  assert.equal(refusedPipe.risk.primaryReason, refusedDirect.risk.primaryReason);
  assert.ok(refusedPipe.risk.blockedBy.includes("max_position_size"));
  assert.equal(typeof refusedPipe.risk.auditEventId, "number", "the refusal carries its own audit row");

  // CLOSE: owner-scoped and governed exactly like closePaperFill.
  const foreign = await fillPaperTrade({ mode: "PAPER", intent: "CLOSE" }, {
    userId: u.b, order: viaPipe.order, exitPrice: 1.11, intentRef: "qa", auditContext: {}, eventLabel: "QA close",
  });
  assert.deepEqual(foreign, { ok: false, reason: "PAPER_ORDER_NOT_FOUND" });
  const closedPipe = await fillPaperTrade({ mode: "PAPER", intent: "CLOSE" }, {
    userId: u.a, order: viaPipe.order, exitPrice: 1.11, intentRef: `qa_close:${viaPipe.order.id}`, auditContext: { caller: "QA" }, eventLabel: "QA close",
  });
  const closedDirect = await closePaperFill({
    userId: u.a, order: direct.order, exitPrice: 1.11, intentRef: `qa_close:${direct.order.id}`, auditContext: { caller: "QA" }, eventLabel: "QA close",
  });
  assert.deepEqual(closedPipe, closedDirect);
  assert.equal((await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, viaPipe.order.id)))[0]!.status, "CLOSED_MANUAL");

  // Settlement and rollback: not re-governed, same columns move.
  const s = await fillPaperTrade({ mode: "PAPER", intent: "OPEN" }, args({ symbol: "QAPFUSD" }));
  const v = await fillPaperTrade({ mode: "PAPER", intent: "OPEN" }, args({ symbol: "QAPGUSD" }));
  assert.ok(s.ok && v.ok);
  const before = (await riskRows(u.a)).length;
  await settlePaperTrade({ order: s.order, status: "CLOSED_TP", exitPrice: 1.12, pnl: 2, eventMessage: "QA tp" });
  await voidPaperTrade(v.order.id);
  assert.equal((await riskRows(u.a)).length, before, "no governor call for a venue fill or a rollback");
  const [rs] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, s.order.id));
  assert.equal(rs!.status, "CLOSED_TP");
  assert.equal(rs!.profitLoss, 2);
  const [rv] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, v.order.id));
  assert.equal(rv!.status, "CANCELLED");
  assert.equal(rv!.closedAt, null);

  // An unknown stage is refused and books nothing.
  const count = (await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.paperAccountId, acct))).length;
  const bad = await (fillPaperTrade as (s: unknown, a: unknown) => Promise<unknown>)({ mode: "LIVE", intent: "OPEN" }, args({ symbol: "QAPHUSD" }));
  assert.deepEqual(bad, { ok: false, reason: "UNKNOWN_TRADE_MODE" });
  assert.equal((await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.paperAccountId, acct))).length, count);
});

test("closePaperFill: governed CLOSE, owner-scoped, CLOSED_MANUAL with P&L and its event", async () => {
  const acct = await freshAccount(u.a);
  const opened = await fill(u.a, acct);
  assert.ok(opened.ok);
  const foreign = await closePaperFill({
    userId: u.b, order: opened.order, exitPrice: 1.11, intentRef: "qa", auditContext: {}, eventLabel: "QA close",
  });
  assert.equal(foreign.ok ? null : foreign.reason, "PAPER_ORDER_NOT_FOUND");
  assert.equal((await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, opened.order.id)))[0]!.status, "OPEN");

  const closed = await closePaperFill({
    userId: u.a, order: opened.order, exitPrice: 1.11, intentRef: `qa_close:${opened.order.id}`, auditContext: { caller: "QA" }, eventLabel: "QA close",
  });
  assert.ok(closed.ok, JSON.stringify(closed));
  assert.ok(Math.abs(closed.pnl - (1.11 - PX) * 0.1 * 100) < 1e-9);
  const [row] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, opened.order.id));
  assert.equal(row!.status, "CLOSED_MANUAL");
  assert.ok(row!.closedAt);
  assert.ok(Math.abs(row!.exitPrice! - 1.11) < 1e-6);
  const actions = (await riskRows(u.a)).map((r) => (r.details as { intent: { action: string } }).intent.action);
  assert.deepEqual(actions, ["OPEN", "CLOSE"]);
  const last = (await events(opened.order.id)).at(-1)!;
  assert.equal(last.eventType, "CLOSED_MANUAL");
  assert.match(last.message, /QA close @ 1\.11000, P&L /);
});

test("settlePaperOrder and voidPaperOrder: venue fills, not re-governed, only status / exit / P&L move", async () => {
  const acct = await freshAccount(u.a);
  const a = await fill(u.a, acct);
  const b = await fill(u.a, acct, { symbol: SYMBOL_2 });
  assert.ok(a.ok && b.ok);
  const before = (await riskRows(u.a)).length;
  await settlePaperOrder({ order: a.order, status: "CLOSED_TP", exitPrice: 1.12, pnl: 2, eventMessage: "QA tp" });
  await voidPaperOrder(b.order.id);
  assert.equal((await riskRows(u.a)).length, before, "no governor call for a venue fill or a rollback");
  const [ra] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, a.order.id));
  assert.equal(ra!.status, "CLOSED_TP");
  assert.equal(ra!.profitLoss, 2);
  assert.ok(ra!.closedAt);
  assert.equal(ra!.stopLoss, a.order.stopLoss);
  assert.equal(ra!.lotSize, a.order.lotSize);
  assert.deepEqual((await events(a.order.id)).map((e) => e.eventType), ["PLACED", "CLOSED_TP"]);
  const [rb] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, b.order.id));
  assert.equal(rb!.status, "CANCELLED");
  assert.equal(rb!.closedAt, null, "a rollback is not a close");
  assert.deepEqual((await events(b.order.id)).map((e) => e.eventType), ["PLACED"]);
});

test("Build EE monitor: stop/target hits settle through the venue; manual close is governed there", async () => {
  const acct = await freshAccount(u.a);
  const tp = await fill(u.a, acct);
  const manual = await fill(u.a, acct, { symbol: SYMBOL_2 });
  assert.ok(tp.ok && manual.ok);
  // Close `manual` first so the forced-price scan only sees `tp`.
  const before = (await riskRows(u.a)).length;
  const closed = await closePaperManually(manual.order.id, u.a, { exitPrice: 1.095 });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const afterClose = await riskRows(u.a);
  assert.equal(afterClose.length, before + 1);
  const closeIntent = (afterClose.at(-1)!.details as { intent: Record<string, unknown> }).intent;
  assert.equal(closeIntent["action"], "CLOSE");
  assert.equal(closeIntent["intentRef"], `paper_execution_close:${manual.order.id}`);
  assert.match((await events(manual.order.id)).at(-1)!.message, new RegExp(`^${SIMULATED_TAG} EE manual close @ 1\\.09500, P&L `));
  const notOpen = await closePaperManually(manual.order.id, u.a, { exitPrice: 1.095 });
  assert.deepEqual(notOpen, { ok: false, error: "Order not open (status=CLOSED_MANUAL)" });
  const foreign = await closePaperManually(tp.order.id, u.b, { exitPrice: 1.095 });
  assert.deepEqual(foreign, { ok: false, error: "Paper order not found" });

  const summary = await runPaperMonitor({ forcePrice: 1.125, forceSymbol: SYMBOL, userId: u.a });
  assert.equal(summary.closed, 1);
  assert.equal(summary.closures[0]!.hit, "TP");
  assert.equal((await riskRows(u.a)).length, before + 1, "a target hit is a venue fill, not a new governed order");
  const [row] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, tp.order.id));
  assert.equal(row!.status, "CLOSED_TP");
  assert.ok(Math.abs(row!.exitPrice! - 1.12) < 1e-6);
  assert.match((await events(tp.order.id)).at(-1)!.message, new RegExp(`^${SIMULATED_TAG} EE-monitor TP hit at 1\\.12000, P&L `));
});

test("legacy trades book: the emergency-stop cancel of existing rows stays owner-scoped", async () => {
  await clearBooks([u.a, u.b]);
  // Historical rows (the retired /execute-trade wrote them; owner decision 14
  // closed the book to new rows, so the fixture inserts them directly).
  const [mine] = await db.insert(tradesTable).values({
    userId: u.a, symbol: SYMBOL, direction: "BUY", lot: 0.01, entryPrice: PX, stopLoss: 1.09, takeProfit: 1.12,
    strategy: "QA", confidence: 50, status: "OPEN", mode: "DEMO",
  }).returning();
  const [theirs] = await db.insert(tradesTable).values({
    userId: u.b, symbol: SYMBOL, direction: "SELL", lot: 0.01, entryPrice: PX, stopLoss: 1.11, takeProfit: 1.08,
    strategy: "QA", confidence: 50, status: "OPEN", mode: "DEMO",
  }).returning();
  if (!mine || !theirs) throw new Error("fixture insert failed");
  assert.equal(mine.userId, u.a);
  const cancelled = await cancelOpenLegacyTrades(u.a);
  assert.deepEqual(cancelled.map((t) => t.id), [mine.id]);
  assert.equal(cancelled[0]!.status, "OPEN", "returns the rows as they were before the cancel");
  const [m] = await db.select().from(tradesTable).where(eq(tradesTable.id, mine.id));
  assert.equal(m!.status, "CANCELLED");
  assert.equal(m!.pnl, 0);
  assert.ok(m!.closedAt);
  const [t] = await db.select().from(tradesTable).where(and(eq(tradesTable.id, theirs.id), eq(tradesTable.userId, u.b)))
    .orderBy(desc(tradesTable.id));
  assert.equal(t!.status, "OPEN", "another trader's row is untouched");
});


test("competing caller-priced closes and duplicate venue settlements cannot overwrite a fill", async () => {
  const acct = await freshAccount(u.a);
  const opened = await fill(u.a, acct);
  assert.ok(opened.ok);
  const results = await Promise.all([1.11, 1.12].map(exitPrice => closePaperFill({
    userId: u.a, order: opened.order, exitPrice, intentRef: "qa_race_close", auditContext: {}, eventLabel: "QA race",
  })));
  assert.equal(results.filter(r => r.ok).length, 1);
  const [closed] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, opened.order.id));
  await settlePaperOrder({ order: opened.order, status: "CLOSED_SL", exitPrice: 1, pnl: -999, eventMessage: "late duplicate" });
  const [after] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, opened.order.id));
  assert.equal(after!.status, closed!.status);
  assert.equal(after!.exitPrice, closed!.exitPrice);
  assert.equal(after!.profitLoss, closed!.profitLoss);
  assert.equal((await events(opened.order.id)).filter(e => e.eventType.startsWith("CLOSED")).length, 1);
});
