// Trade Engine pipeline — LIVE / DEMO / PAPER as modes of one entry, on a
// real database.
//
//   PAPER  submitTrade runs the Risk Governor (venue PAPER) and writes the
//          paper simulator book; refusals write nothing; rows stay owned.
//   DEMO / LIVE position ops resolve the trader's own ARX-governed position
//          and refuse a position opened outside ARX or held on the other
//          venue, before any queue is touched.
//   An unknown mode is refused.
//
// Nothing here reaches a broker: no bridge EA runs, and the only command a
// case can create is a DEMO draft in the governed demo queue.
//
// Run: pnpm --filter @workspace/api-server run test:trade-engine-pipeline

import { executablePaperFixture } from "../../safety/__qa__/paperModeFixture.js";
let restorePaperMode: (() => Promise<void>) | undefined;
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { desc, eq, inArray } from "drizzle-orm";
import {
  arxLiveCommandsTable,
  db,
  mt5CommandsTable,
  mt5ConnectionTable,
  mt5DemoCommandsTable,
  paperAccountsTable,
  paperOrdersTable,
  paperTradeEventsTable,
  userRiskEventsTable,
  usersTable,
} from "@workspace/db";
import { generateDeterministicCandles } from "../../backtestStrategyRegistry.js";
import { submitTrade, type TradeRequest } from "../pipeline.js";

const EMAIL_A = "qa+trade-engine-a@arx.test";
const EMAIL_B = "qa+trade-engine-b@arx.test";
const SYMBOL = "EURUSD";
const u = { a: 0, b: 0 };

async function deleteFixtures(): Promise<void> {
  const ids = (await db.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.email, [EMAIL_A, EMAIL_B]))).map((x) => x.id);
  if (!ids.length) return;
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(mt5DemoCommandsTable).where(inArray(mt5DemoCommandsTable.userId, ids));
  await db.delete(arxLiveCommandsTable).where(inArray(arxLiveCommandsTable.userId, ids));
  await db.delete(mt5CommandsTable).where(inArray(mt5CommandsTable.userId, ids));
  await db.delete(paperTradeEventsTable).where(inArray(paperTradeEventsTable.userId, ids));
  await db.delete(paperOrdersTable).where(inArray(paperOrdersTable.userId, ids));
  await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.userId, ids));
  await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function seedUser(email: string): Promise<number> {
  const [user] = await db.insert(usersTable).values({ email, name: email, role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  return user!.id;
}

async function paperAccount(userId: number): Promise<number> {
  await db.delete(paperTradeEventsTable).where(eq(paperTradeEventsTable.userId, userId));
  await db.delete(paperOrdersTable).where(eq(paperOrdersTable.userId, userId));
  await db.delete(paperAccountsTable).where(eq(paperAccountsTable.userId, userId));
  const [acct] = await db.insert(paperAccountsTable).values({
    userId, accountName: "QA engine", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, isActive: 1,
  }).returning({ id: paperAccountsTable.id });
  return acct!.id;
}

/** The paper simulator's price (same generator as the PAPER venue). */
function paperPrice(): number {
  const bucket = Math.floor(Date.now() / 60_000) * 60_000;
  return generateDeterministicCandles({ symbol: SYMBOL, count: 1, timeframe: "M1", seed: `paper-mtm|${bucket}`, baseTimeMs: bucket })[0]!.close;
}

const paperOpen = (userId: number, paperAccountId: number, over: Partial<Extract<TradeRequest, { mode: "PAPER"; intent: "OPEN" }>> = {}) => {
  const px = paperPrice();
  return submitTrade({
    mode: "PAPER", intent: "OPEN", userId, paperAccountId, symbol: SYMBOL, side: "BUY", lots: 0.1,
    orderType: "MARKET", entryPrice: null, stopLoss: px * 0.98, takeProfit: px * 1.04, sourcePage: "QA trade engine",
    ...over,
  });
};

before(async () => {
  restorePaperMode = await executablePaperFixture();
  await deleteFixtures();
  u.a = await seedUser(EMAIL_A);
  u.b = await seedUser(EMAIL_B);
});

after(async () => {
  await restorePaperMode?.();
  await deleteFixtures();
});

test("PAPER: open, tighten and close go through the pipeline, each governed and audited with venue PAPER", async () => {
  const acct = await paperAccount(u.a);
  const opened = await paperOpen(u.a, acct);
  assert.ok(opened.ok, JSON.stringify(opened));
  assert.equal(opened.mode, "PAPER");
  assert.equal(opened.commandId, null, "a paper trade sends no broker command");
  const order = opened.paperOrder!;
  assert.equal(order.status, "OPEN");
  assert.equal(order.userId, u.a);
  const [ev] = await db.select().from(userRiskEventsTable).where(eq(userRiskEventsTable.userId, u.a))
    .orderBy(desc(userRiskEventsTable.id)).limit(1);
  const intent = (ev!.details as { intent: Record<string, unknown> }).intent;
  assert.equal(intent["venue"], "PAPER");
  assert.equal(intent["action"], "OPEN");

  const tighter = order.stopLoss + (order.entryPrice - order.stopLoss) / 2;
  const modified = await submitTrade({ mode: "PAPER", intent: "MODIFY", userId: u.a, orderId: order.id, stopLoss: tighter, sourcePage: "QA" });
  assert.ok(modified.ok, JSON.stringify(modified));
  assert.ok(Math.abs(modified.paperOrder!.stopLoss - tighter) < 1e-4, "the stop moved (stored at column precision)");
  assert.ok(modified.paperOrder!.stopLoss > order.stopLoss, "tightened");
  assert.equal(modified.paperOrder!.takeProfit, order.takeProfit, "an omitted field keeps its value");

  const closed = await submitTrade({ mode: "PAPER", intent: "CLOSE", userId: u.a, orderId: order.id, sourcePage: "QA" });
  assert.ok(closed.ok, JSON.stringify(closed));
  assert.equal(closed.paperOrder!.status, "CLOSED_MANUAL");
  const again = await submitTrade({ mode: "PAPER", intent: "CLOSE", userId: u.a, orderId: order.id, sourcePage: "QA" });
  assert.equal(again.ok ? null : again.reason, "PAPER_ORDER_NOT_OPEN");

  const audited = await db.select().from(userRiskEventsTable).where(eq(userRiskEventsTable.userId, u.a));
  const actions = audited.map((r) => (r.details as { intent: { action: string } }).intent.action).sort();
  assert.deepEqual(actions, ["CLOSE", "MODIFY", "OPEN"], "one governor decision per step");
});

test("PAPER: a Risk Governor refusal and a geometry refusal write nothing", async () => {
  const acct = await paperAccount(u.a);
  const big = await paperOpen(u.a, acct, { lots: 6 });
  assert.equal(big.ok, false);
  assert.equal(big.ok ? null : big.reason, "RISK_GOVERNOR_BLOCK");
  assert.ok(!big.ok && big.detail?.blockedBy?.includes("max_position_size"), JSON.stringify(big));
  const px = paperPrice();
  const bad = await paperOpen(u.a, acct, { stopLoss: px * 1.02 });
  assert.equal(bad.ok ? null : bad.reason, "INVALID_SLTP_GEOMETRY");
  const rows = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.paperAccountId, acct));
  assert.equal(rows.length, 0);
});

test("PAPER: another trader's account and order are not found, and stay untouched", async () => {
  const acct = await paperAccount(u.a);
  const opened = await paperOpen(u.a, acct);
  assert.ok(opened.ok);
  const foreignOpen = await paperOpen(u.b, acct);
  assert.equal(foreignOpen.ok ? null : foreignOpen.reason, "PAPER_ACCOUNT_NOT_FOUND");
  const foreignClose = await submitTrade({ mode: "PAPER", intent: "CLOSE", userId: u.b, orderId: opened.paperOrder!.id, sourcePage: "QA" });
  assert.equal(foreignClose.ok ? null : foreignClose.reason, "PAPER_ORDER_NOT_FOUND");
  const [row] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, opened.paperOrder!.id));
  assert.equal(row!.status, "OPEN");
});

test("DEMO / LIVE: a position opened outside ARX, or held on the other venue, is refused before any queue", async () => {
  for (const mode of ["DEMO", "LIVE"] as const) {
    const r = await submitTrade({ mode, intent: "CLOSE", userId: u.a, target: { ticket: "qa-te-unknown" }, sourcePage: "QA" });
    assert.equal(r.ok ? null : r.reason, "NOT_AN_ARX_GOVERNED_POSITION", mode);
  }
  await db.insert(mt5DemoCommandsTable).values({
    commandId: "qa_te_open_1", userId: u.a, bridgeConnectionId: 1, commandType: "PLACE_MARKET_ORDER",
    payload: { symbol: SYMBOL, side: "BUY", lotSize: 0.1, stopLoss: 1.0951 }, status: "FILLED_DEMO",
    safetyGateSnapshot: {}, brokerTicket: "qa-te-1", fillVolume: 0.1, filledAt: new Date(),
  });
  const live = await submitTrade({ mode: "LIVE", intent: "MODIFY", userId: u.a, target: { ticket: "qa-te-1" },
    stopLoss: 1.096, takeProfit: null, sourcePage: "QA" });
  assert.equal(live.ok ? null : live.reason, "POSITION_IS_DEMO", "a DEMO position is never changed through the LIVE venue");
  const foreign = await submitTrade({ mode: "DEMO", intent: "CLOSE", userId: u.b, target: { ticket: "qa-te-1" }, sourcePage: "QA" });
  assert.equal(foreign.ok ? null : foreign.reason, "NOT_AN_ARX_GOVERNED_POSITION", "another trader's ticket is not theirs");
  const liveCmds = await db.select().from(arxLiveCommandsTable).where(inArray(arxLiveCommandsTable.userId, [u.a, u.b]));
  assert.equal(liveCmds.length, 0, "no live command was drafted");
  const mailbox = await db.select().from(mt5CommandsTable).where(inArray(mt5CommandsTable.userId, [u.a, u.b]));
  assert.equal(mailbox.length, 0, "nothing reaches the legacy mailbox");
});

test("DEMO: a governed position's close is handed to the demo queue (its own gates decide)", async () => {
  const r = await submitTrade({ mode: "DEMO", intent: "CLOSE", userId: u.a, target: { ticket: "qa-te-1" }, sourcePage: "QA" });
  assert.equal(r.mode, "DEMO");
  if (r.ok) {
    assert.ok(r.commandId);
    assert.equal(r.position?.venue, "DEMO");
  } else {
    assert.notEqual(r.reason, "NOT_AN_ARX_GOVERNED_POSITION");
    assert.notEqual(r.reason, "POSITION_IS_LIVE");
  }
  const mailbox = await db.select().from(mt5CommandsTable).where(eq(mt5CommandsTable.userId, u.a));
  assert.equal(mailbox.length, 0, "the pipeline never writes the legacy mailbox");
});

test("an unknown mode is refused and writes nothing", async () => {
  const before = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, u.a));
  const r = await submitTrade({ mode: "SIMULATED", intent: "CLOSE", userId: u.a, orderId: 1, sourcePage: "QA" } as unknown as TradeRequest);
  assert.equal(r.ok ? null : r.reason, "UNKNOWN_TRADE_MODE");
  const afterRows = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, u.a));
  assert.equal(afterRows.length, before.length);
});
