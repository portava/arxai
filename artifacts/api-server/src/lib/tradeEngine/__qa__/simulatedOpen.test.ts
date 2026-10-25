// Owner decision 13 (2026-10-25): a confirmed SIMULATED open in the Trade
// Action Center or My Trades books ONE PAPER order through the Trade Engine
// pipeline, on a real database.
//
//   - drafts and previews book nothing;
//   - the confirm must say SIMULATED explicitly; the response says SIMULATED / PAPER;
//   - the order is governed (Risk Governor, venue PAPER) and filled at a real
//     current quote (its provenance recorded); no valid quote → refused,
//     nothing booked; mark-to-market never settles it at the synthetic price;
//   - retry-safe: a repeated or concurrent confirm, or a retried My Trades
//     request with the same key, books exactly one order;
//   - tenant isolation: another trader cannot confirm the action, and request
//     keys are per trader.
//
// The only stub is the market-data feed (the sandbox has no real provider):
// a switchable snapshot stands in for it. Nothing reaches a broker.
//
// Run: pnpm --filter @workspace/api-server run test:simulated-open

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MarketDataSnapshot } from "../../marketData/types.js";

const realMd = await import("../../marketData/marketDataService.js");
const QUOTE = { bid: 1.1, ask: 1.1002, mid: 1.1001 };
let feed: "fresh" | "fallback" | "stale" = "fresh";
function snapshot(symbol: string): MarketDataSnapshot {
  const now = Date.now();
  const at = feed === "stale" ? now - 10 * 60_000 : now;
  return {
    symbol, source: feed === "fallback" ? "FALLBACK" : "REAL", provider: "qa-stub", ...QUOTE, spread: 0.0002,
    timestamp: new Date(at).toISOString(), timeframe: "M5",
    candles: Array.from({ length: 100 }, (_, i) => ({
      time: new Date(at - (100 - i) * 300_000).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1, volume: 100,
    })),
    sessionContext: { sessionName: "London", isMarketOpen: true, liquidityLevel: "NORMAL", volatilityLevel: "NORMAL" },
    dataQuality: { status: "GOOD", latencyMs: 5, candlesAvailable: 100, warnings: [] },
  };
}
mock.module("../../marketData/marketDataService.js", {
  namedExports: {
    ...realMd,
    getMarketData: async (req: { symbol: string }) => {
      const s = snapshot(req.symbol);
      return { snapshot: s, blockers: realMd.computeBlockers(s), usedFallback: feed === "fallback" };
    },
  },
});

const { default: express } = await import("express");
const { default: cookieParser } = await import("cookie-parser");
const { and, desc, eq, inArray } = await import("drizzle-orm");
const {
  arxSymbolSpecsTable, authUserSessionsTable, db, globalTradingSettingsTable, mt5ConnectionTable, notificationsTable,
  paperAccountsTable, paperOrdersTable, paperTradeEventsTable, safetyCoreTable, tradeActionRequestsTable,
  tradeCommandAuditLogTable, tradeDecisionTimelineTable, userRiskEventsTable, userRiskLimitsTable, userTradingPermissionsTable,
  usersTable,
} = await import("@workspace/db");
const { attachAuthUser } = await import("../../auth/middleware.js");
const { createUserSession } = await import("../../auth/userSessions.js");
const { createActionDraft } = await import("../../tradeAction/create.js");
const { confirmAction } = await import("../../tradeAction/confirm.js");
const { runActionGuards } = await import("../../tradeAction/guards.js");
const { openSimulatedPaperOrder } = await import("../simulatedOpen.js");
const { MARKET_PRICED_SIMULATED_OPEN, markToMarket } = await import("../paperVenue.js");
const { default: paperRouter } = await import("../../../routes/paperTrading.js");
const { default: meTradesRouter } = await import("../../../routes/meTrades.js");

const EMAIL_A = "qa+simulated-open-a@arx.test";
const EMAIL_B = "qa+simulated-open-b@arx.test";
const SYMBOL = "EURUSD";
const SL = 1.095;
const TP = 1.11;
const u = { a: 0, b: 0 };
const c = { a: "", b: "" };
const acct = { a: 0, b: 0 };
let server: Server;
let base = "";
let restore: Array<() => Promise<void>> = [];

async function deleteFixtures(): Promise<void> {
  const ids = (await db.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.email, [EMAIL_A, EMAIL_B]))).map((x) => x.id);
  if (!ids.length) return;
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(notificationsTable).where(inArray(notificationsTable.userId, ids));
  await db.delete(tradeDecisionTimelineTable).where(inArray(tradeDecisionTimelineTable.userId, ids));
  await db.delete(tradeActionRequestsTable).where(inArray(tradeActionRequestsTable.userId, ids));
  await db.delete(tradeCommandAuditLogTable).where(inArray(tradeCommandAuditLogTable.userId, ids));
  await db.delete(paperTradeEventsTable).where(inArray(paperTradeEventsTable.userId, ids));
  await db.delete(paperOrdersTable).where(inArray(paperOrdersTable.userId, ids));
  await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.userId, ids));
  await db.delete(arxSymbolSpecsTable).where(inArray(arxSymbolSpecsTable.userId, ids));
  await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.userId, ids));
  await db.delete(userRiskLimitsTable).where(inArray(userRiskLimitsTable.userId, ids));
  await db.delete(userTradingPermissionsTable).where(inArray(userTradingPermissionsTable.userId, ids));
  await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function seedUser(email: string): Promise<{ id: number; cookie: string; acct: number }> {
  const [user] = await db.insert(usersTable).values({ email, name: email, role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  const id = user!.id;
  const { rawToken } = await createUserSession({ userId: id });
  const [a] = await db.insert(paperAccountsTable).values({
    userId: id, accountName: "QA simulated", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, isActive: 1,
  }).returning({ id: paperAccountsTable.id });
  // A bridge quote for the pre-trade guards (the venue prices from the market feed).
  const [conn] = await db.insert(mt5ConnectionTable).values({
    userId: id, connectionName: "QA bridge", status: "connected", lastHeartbeat: new Date(), accountSyncedAt: new Date(),
    accountCurrency: "USD", accountBalance: 10_000, accountEquity: 10_000, freeMargin: 9_000, leverage: 100, accountType: "demo",
  }).returning({ id: mt5ConnectionTable.id });
  await db.insert(arxSymbolSpecsTable).values({
    userId: id, bridgeConnectionId: conn!.id, symbol: SYMBOL, contractSize: 100_000, profitCurrency: "USD",
    volumeStep: 0.01, minVolume: 0.01, maxVolume: 50, bid: QUOTE.bid, ask: QUOTE.ask, lastTickTime: new Date(),
  });
  // My Trades: a trader allowed to trade, with operator limits.
  await db.insert(userTradingPermissionsTable).values({ userId: id, tradingMode: "DEMO", demoEnabled: true, suspended: false });
  await db.insert(userRiskLimitsTable).values({ userId: id, maxLotSize: 1, allowedAccountType: "both" });
  return { id, cookie: `arx_user_session=${rawToken}`, acct: a!.id };
}

async function setRow(which: "platform" | "safety_core", set: Record<string, unknown>): Promise<void> {
  const t = which === "platform" ? globalTradingSettingsTable : safetyCoreTable;
  const rows = await db.select().from(t).orderBy(t.id).limit(1);
  let id = rows[0]?.id;
  if (id == null) {
    id = (await db.insert(t).values({} as never).returning({ id: t.id }))[0]!.id;
    restore.push(async () => { await db.delete(t).where(eq(t.id, id!)); });
  } else {
    const prev = Object.fromEntries(Object.keys(set).map((k) => [k, (rows[0] as Record<string, unknown>)[k]]));
    restore.push(async () => { await db.update(t).set(prev as never).where(eq(t.id, id!)); });
  }
  await db.update(t).set(set as never).where(eq(t.id, id));
}

/** A clean slate for a trader (the governor's duplicate / conflict rules see recent orders and actions). */
async function fresh(...userIds: number[]): Promise<void> {
  for (const id of userIds) {
    await db.delete(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.userId, id));
    await db.delete(paperTradeEventsTable).where(eq(paperTradeEventsTable.userId, id));
    await db.delete(paperOrdersTable).where(eq(paperOrdersTable.userId, id));
  }
}

const orders = (userId: number) => db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, userId));
const riskRows = (userId: number) => db.select().from(userRiskEventsTable).where(eq(userRiskEventsTable.userId, userId));

async function draft(userId: number, over: Partial<Parameters<typeof createActionDraft>[0]> = {}) {
  const d = await createActionDraft({
    userId, actionType: "OPEN", tradeKey: null, requestedMode: "SIMULATED",
    symbol: SYMBOL, side: "BUY", lotSize: 0.1, stopLoss: SL, takeProfit: TP, ...over,
  });
  assert.ok(d.ok, JSON.stringify(d));
  return d.action.id;
}
const actionRow = async (id: number) => (await db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, id)))[0]!;

function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
}

before(async () => {
  await deleteFixtures();
  const a = await seedUser(EMAIL_A);
  const b = await seedUser(EMAIL_B);
  Object.assign(u, { a: a.id, b: b.id });
  Object.assign(c, { a: a.cookie, b: b.cookie });
  Object.assign(acct, { a: a.acct, b: b.acct });
  // Every install-wide stop released and the demo venue open, restored after.
  await setRow("platform", { emergencyKillSwitch: false, platformMode: "LIVE", demoEnabled: true });
  await setRow("safety_core", { killSwitchEngaged: false });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachAuthUser);
  app.use(meTradesRouter);
  app.use(paperRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  for (const r of restore.reverse()) await r();
  restore = [];
  await deleteFixtures();
});

test("Trade Action Center: a draft and a preview book nothing", async () => {
  feed = "fresh";
  const id = await draft(u.a);
  assert.equal((await orders(u.a)).length, 0, "a draft books nothing");
  const preview = await runActionGuards({
    userId: u.a, actionId: id, actionType: "OPEN", requestedMode: "SIMULATED", symbol: SYMBOL, side: "BUY", lotSize: 0.1,
    stopLoss: SL, takeProfit: TP, tradeKey: null, confirmedByUser: false, expiresAt: null, previewMode: true,
  });
  assert.equal(typeof preview.passed, "boolean");
  assert.equal((await orders(u.a)).length, 0, "a preview books nothing");
  assert.equal((await actionRow(id)).status, "awaiting_confirmation");
});

test("Trade Action Center: a SIMULATED open must be confirmed as SIMULATED explicitly", async () => {
  feed = "fresh";
  const id = await draft(u.a);
  for (const confirmedMode of [undefined, null, "DEMO", "PAPER"]) {
    const r = await confirmAction({ userId: u.a, actionId: id, confirmedMode });
    assert.equal(r.ok ? null : r.error, "simulated_mode_label_required");
  }
  assert.equal((await actionRow(id)).status, "awaiting_confirmation", "nothing moved");
  assert.equal((await orders(u.a)).length, 0);
});

test("Trade Action Center: a confirmed SIMULATED open books one governed PAPER order at the real quote; a repeat returns it", async () => {
  feed = "fresh";
  await fresh(u.a);
  const id = await draft(u.a);
  const r = await confirmAction({ userId: u.a, actionId: id, confirmedMode: "SIMULATED" });
  assert.ok(r.ok, JSON.stringify(r));
  const p = r.paper!;
  assert.equal(p.mode, "SIMULATED");
  assert.equal(p.venue, "PAPER");
  assert.match(p.label, /Simulated/);
  assert.equal(p.replayed, false);
  assert.equal(p.fillPrice, QUOTE.ask, "a BUY fills at the quote's ask");
  assert.equal(p.priceSource, "REAL:qa-stub");
  assert.ok(p.quoteAt);

  const row = await actionRow(id);
  assert.equal(row.status, "executed");
  assert.equal(row.executionVenue, "PAPER");
  assert.equal(row.venueCommandId, `paper_order:${p.paperOrderId}`);
  assert.equal(row.fillPrice, QUOTE.ask);

  const mine = await orders(u.a);
  assert.equal(mine.length, 1);
  const order = mine[0]!;
  assert.equal(order.id, p.paperOrderId);
  assert.equal(order.paperAccountId, acct.a);
  assert.equal(order.clientRequestKey, `trade_action:${id}`);
  assert.equal(order.strategyId, MARKET_PRICED_SIMULATED_OPEN);
  assert.equal(order.status, "OPEN");
  const [ev] = await db.select().from(paperTradeEventsTable).where(eq(paperTradeEventsTable.paperOrderId, order.id));
  assert.match(ev!.message, /price REAL:qa-stub at /, "the fill's price provenance is recorded");

  const governed = (await riskRows(u.a)).map((e) => (e.details as { intent: Record<string, unknown> }).intent)
    .filter((i) => i["venue"] === "PAPER" && i["action"] === "OPEN" && i["intentRef"] === `trade_action:${id}`);
  assert.ok(governed.length >= 2, "the guard chain and the venue each ran the Risk Governor (venue PAPER) on this action");

  // Retry-safe: the same confirm returns the same order, books nothing, governs nothing new.
  const before = (await riskRows(u.a)).length;
  const again = await confirmAction({ userId: u.a, actionId: id, confirmedMode: "SIMULATED" });
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal(again.paper!.paperOrderId, order.id);
  assert.equal(again.paper!.replayed, true);
  assert.equal((await orders(u.a)).length, 1, "still one paper order");
  assert.equal((await riskRows(u.a)).length, before, "no second governor decision");

  // Never a fabricated exit: mark-to-market leaves a market-priced order to real market data.
  const valuation = await markToMarket(acct.a);
  assert.ok(valuation);
  assert.ok(Math.abs(valuation.equity - (valuation.currentBalance + (QUOTE.bid - order.entryPrice) * order.lotSize * 100)) < 0.01,
    "equity uses the real liquidation bid, never the simulator model");
  feed = "stale";
  assert.equal(await markToMarket(acct.a), null, "stale real prices make valuation unavailable");
  const unavailable = await fetch(`${base}/paper/accounts/active`, { headers: { cookie: c.a } });
  assert.equal(unavailable.status, 503, "account API does not fall back to the cached valuation");
  feed = "fallback";
  assert.equal(await markToMarket(acct.a), null, "fallback prices cannot value real-priced paper orders");
  feed = "fresh";
  const [still] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, order.id));
  assert.equal(still!.status, "OPEN");
  assert.equal(still!.exitPrice, null);
});

test("Trade Action Center: two concurrent confirms of one action book exactly one order", async () => {
  feed = "fresh";
  await fresh(u.a);
  const id = await draft(u.a, { side: "SELL", stopLoss: 1.105, takeProfit: 1.09 });
  const [x, y] = await Promise.all([
    confirmAction({ userId: u.a, actionId: id, confirmedMode: "SIMULATED" }),
    confirmAction({ userId: u.a, actionId: id, confirmedMode: "SIMULATED" }),
  ]);
  assert.ok(x.ok || y.ok, JSON.stringify({ x, y }));
  const keyed = (await orders(u.a)).filter((o) => o.clientRequestKey === `trade_action:${id}`);
  assert.equal(keyed.length, 1, "one order per action");
  assert.equal(keyed[0]!.entryPrice, QUOTE.bid, "a SELL fills at the quote's bid");
});

test("Trade Action Center: without a valid current price nothing is booked", async () => {
  for (const mode of ["fallback", "stale"] as const) {
    feed = mode;
    await fresh(u.a);
    const before = (await orders(u.a)).length;
    const id = await draft(u.a);
    const r = await confirmAction({ userId: u.a, actionId: id, confirmedMode: "SIMULATED" });
    assert.equal(r.ok ? null : r.error, "venue_rejected", mode);
    const row = await actionRow(id);
    assert.equal(row.status, "rejected", mode);
    assert.match(row.rejectionReason ?? "", /No valid current price/, mode);
    assert.equal((await orders(u.a)).length, before, `${mode}: nothing booked`);
  }
  feed = "fresh";
});

test("tenant isolation: another trader cannot confirm the action, and request keys are per trader", async () => {
  feed = "fresh";
  await fresh(u.a, u.b);
  const id = await draft(u.a);
  const foreign = await confirmAction({ userId: u.b, actionId: id, confirmedMode: "SIMULATED" });
  assert.equal(foreign.ok ? null : foreign.error, "action_not_found");
  assert.equal((await orders(u.b)).length, 0);
  assert.equal((await actionRow(id)).status, "awaiting_confirmation");

  const mine = await openSimulatedPaperOrder({
    userId: u.a, surface: "TRADE_ACTION_CENTER", requestKey: "shared-key-1", symbol: SYMBOL, side: "BUY", lots: 0.05,
    stopLoss: SL, takeProfit: TP, sourcePage: "QA",
  });
  assert.ok(mine.ok, JSON.stringify(mine));
  const theirs = await openSimulatedPaperOrder({
    userId: u.b, surface: "TRADE_ACTION_CENTER", requestKey: "shared-key-1", symbol: SYMBOL, side: "BUY", lots: 0.05,
    stopLoss: SL, takeProfit: TP, sourcePage: "QA",
  });
  assert.ok(theirs.ok, JSON.stringify(theirs));
  assert.equal(theirs.receipt.replayed, false, "the same key never returns another trader's order");
  assert.notEqual(theirs.receipt.paperOrderId, mine.receipt.paperOrderId);
  assert.equal(theirs.receipt.paperAccountId, acct.b);
});

test("refusals book nothing: no paper account, pending order, missing stop, Risk Governor", async () => {
  feed = "fresh";
  await fresh(u.b);
  const base = { userId: u.b, surface: "TRADE_ACTION_CENTER" as const, symbol: SYMBOL, side: "BUY", lots: 0.1, stopLoss: SL, takeProfit: TP, sourcePage: "QA" };
  const before = (await orders(u.b)).length;
  const pending = await openSimulatedPaperOrder({ ...base, requestKey: "r-pending", pending: true });
  assert.equal(pending.ok ? null : pending.reason, "SIMULATED_PENDING_NOT_SUPPORTED");
  const noStop = await openSimulatedPaperOrder({ ...base, requestKey: "r-nostop", stopLoss: null });
  assert.equal(noStop.ok ? null : noStop.reason, "SIMULATED_REQUIRES_STOP_AND_TARGET");
  const big = await openSimulatedPaperOrder({ ...base, requestKey: "r-big", lots: 6 });
  assert.equal(big.ok ? null : big.reason, "RISK_GOVERNOR_BLOCK");
  assert.ok(!big.ok && (big.detail?.blockedBy?.length ?? 0) > 0);
  await db.update(paperAccountsTable).set({ isActive: 0 }).where(eq(paperAccountsTable.userId, u.b));
  const noAcct = await openSimulatedPaperOrder({ ...base, requestKey: "r-noacct" });
  assert.equal(noAcct.ok ? null : noAcct.reason, "NO_ACTIVE_PAPER_ACCOUNT");
  await db.update(paperAccountsTable).set({ isActive: 1 }).where(eq(paperAccountsTable.userId, u.b));
  assert.equal((await orders(u.b)).length, before, "no refusal booked an order");
});

test("My Trades: a SIMULATED open needs a key, books one PAPER order through the guards, and a retry returns it", async () => {
  feed = "fresh";
  await fresh(u.a, u.b);
  const body = { symbol: SYMBOL, side: "BUY", lotSize: 0.1, mode: "SIMULATED", stopLoss: SL, takeProfit: TP, confirmedByUser: true };
  const noKey = await post("/me/trades/open", c.a, body);
  assert.equal(noKey.status, 400);
  assert.equal((await noKey.json() as { error: string }).error, "IDEMPOTENCY_KEY_REQUIRED");

  const before = (await orders(u.a)).length;
  const key = `mt-${Date.now()}`;
  const res = await post("/me/trades/open", c.a, { ...body, idempotencyKey: key });
  const json = await res.json() as { ok: boolean; mode: string; venue: string; replayed: boolean; simulated: { paperOrderId: number; fillPrice: number; priceSource: string }; result: { auditLogId: number } };
  assert.equal(res.status, 200);
  assert.ok(json.ok, JSON.stringify(json));
  assert.equal(json.mode, "SIMULATED");
  assert.equal(json.venue, "PAPER");
  assert.equal(json.replayed, false);
  assert.equal(json.simulated.fillPrice, QUOTE.ask);
  assert.equal(json.simulated.priceSource, "REAL:qa-stub");
  const after1 = await orders(u.a);
  assert.equal(after1.length, before + 1);
  const order = after1.find((o) => o.id === json.simulated.paperOrderId)!;
  assert.equal(order.clientRequestKey, `my_trades:${key}`);
  const [audit] = await db.select().from(tradeCommandAuditLogTable).where(eq(tradeCommandAuditLogTable.id, json.result.auditLogId));
  assert.equal(audit!.status, "EXECUTED");
  assert.equal((audit!.guardSnapshot as { placement: { venue: string; paperOrderId: number } }).placement.venue, "PAPER");

  const audits = (await db.select().from(tradeCommandAuditLogTable).where(eq(tradeCommandAuditLogTable.userId, u.a))).length;
  const retry = await post("/me/trades/open", c.a, { ...body, idempotencyKey: key });
  const rj = await retry.json() as { ok: boolean; replayed: boolean; simulated: { paperOrderId: number } };
  assert.ok(rj.ok);
  assert.equal(rj.replayed, true);
  assert.equal(rj.simulated.paperOrderId, order.id);
  assert.equal((await orders(u.a)).length, before + 1, "the retry booked nothing");
  assert.equal((await db.select().from(tradeCommandAuditLogTable).where(eq(tradeCommandAuditLogTable.userId, u.a))).length, audits,
    "a replay does not run the guard chain again");

  // The same key from another trader is that trader's own order.
  const other = await post("/me/trades/open", c.b, { ...body, idempotencyKey: key });
  const oj = await other.json() as { ok: boolean; replayed: boolean; simulated: { paperOrderId: number; paperAccountId: number } };
  assert.ok(oj.ok, JSON.stringify(oj));
  assert.equal(oj.replayed, false);
  assert.equal(oj.simulated.paperAccountId, acct.b);
});

test("My Trades: without a valid current price the SIMULATED open is refused and nothing is booked", async () => {
  feed = "fallback";
  await fresh(u.a);
  const before = (await orders(u.a)).length;
  const res = await post("/me/trades/open", c.a, {
    symbol: SYMBOL, side: "BUY", lotSize: 0.1, mode: "SIMULATED", stopLoss: SL, takeProfit: TP, confirmedByUser: true,
    idempotencyKey: `mt-noprice-${Date.now()}`,
  });
  const json = await res.json() as { ok: boolean; error: string; result: { auditLogId: number } };
  assert.equal(json.ok, false);
  assert.equal(json.error, "NO_VALID_PRICE_SOURCE");
  assert.equal((await orders(u.a)).length, before);
  const [audit] = await db.select().from(tradeCommandAuditLogTable).where(eq(tradeCommandAuditLogTable.id, json.result.auditLogId));
  assert.equal(audit!.status, "FAILED");
  feed = "fresh";
  void and; void desc;
});


test("market-priced paper closes require real quotes and competing closes cannot overwrite a fill", async () => {
  feed = "fresh";
  const opened = await openSimulatedPaperOrder({ userId: u.b, surface: "MY_TRADES", requestKey: "real-close-unique",
    symbol: SYMBOL, side: "BUY", lots: 0.01, stopLoss: SL, takeProfit: TP, sourcePage: "QA_CLOSE" });
  assert.ok(opened.ok, JSON.stringify(opened));
  const { submitTrade } = await import("../pipeline.js");
  const req = { mode: "PAPER" as const, intent: "CLOSE" as const, userId: u.b,
    orderId: opened.receipt.paperOrderId, sourcePage: "QA_CLOSE" };
  assert.equal((await submitTrade({ ...req, userId: u.a })).ok, false, "foreign user cannot close");
  for (const invalid of ["fallback", "stale"] as const) {
    feed = invalid;
    const refusal = await submitTrade(req);
    assert.equal(refusal.ok ? null : refusal.reason, "NO_VALID_PRICE_SOURCE");
  }
  feed = "fresh";
  const results = await Promise.all([submitTrade(req), submitTrade(req)]);
  assert.equal(results.filter(r => r.ok).length, 1, "one close wins");
  const [row] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, req.orderId));
  assert.equal(row!.exitPrice, QUOTE.bid, "BUY exits at real bid, never a simulator price");
  const events = await db.select().from(paperTradeEventsTable).where(eq(paperTradeEventsTable.paperOrderId, req.orderId));
  assert.equal(events.filter(e => e.eventType === "CLOSED_MANUAL").length, 1);
});


test("unsupported SIMULATED management is refused instead of reported queued", async () => {
  const { routeConfirmedAction } = await import("../../tradeAction/route.js");
  for (const actionType of ["CLOSE", "PARTIAL_CLOSE", "MODIFY_TP_SL", "CANCEL_ORDER"] as const) {
    const result = await routeConfirmedAction({ userId: u.a, actionType, requestedMode: "SIMULATED", tradeKey: null,
      symbol: SYMBOL, side: "BUY", lotSize: 0.1, stopLoss: SL, takeProfit: TP, orderType: null, requestedPrice: null, source: "user_initiated" });
    assert.equal(result.ok ? null : result.reason, "SIMULATED_ACTION_NOT_SUPPORTED");
    assert.equal(result.commandId, null);
  }
});
