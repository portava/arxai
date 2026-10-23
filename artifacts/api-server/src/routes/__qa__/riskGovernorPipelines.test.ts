// Pre-trade Risk Governor — end-to-end proof on a real database.
//
// Every case drives a real entry point and checks the whole chain the
// completion directive asks for: input → evaluation → decision → enforcement
// (the order row is or is not written) → rejection surfaced to the caller →
// audit trail (one user_risk_events row naming the rules).
//
//   A  demo, manual      POST /paper/orders through the real router + session
//   B  demo, Ruby        a Ruby-suggested Trade Action draft, confirmed
//   C  demo, automated   paper execution with origin "automation"
//                        (riskGovernorAutomation.test.ts)
//   D  live, sandbox     the LIVE venue against a seeded bridge and the live
//                        ledger (no EA, no broker, nothing dispatched), plus a
//                        source pin that live dispatch and the demo MT5 queue
//                        call the governor before their send step
//   +  demo/live boundary, degraded/disconnected broker, user isolation,
//      preview (no audit), and "user-edited limits reach the live venue".
//
// Run: pnpm --filter @workspace/api-server run test:risk-governor-pipelines

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  arxLiveArmingTable,
  arxLivePositionsTable,
  arxSymbolSpecsTable,
  authUserSessionsTable,
  db,
  globalTradingSettingsTable,
  livePositionsTable,
  mt5CommandsTable,
  mt5ConnectionTable,
  notificationsTable,
  paperAccountsTable,
  paperExecutionsTable,
  paperOrdersTable,
  paperTradeEventsTable,
  positionEventsTable,
  safetyCoreTable,
  tradeActionRequestsTable,
  userRiskEventsTable,
  userRiskSettingsTable,
  usersTable,
} from "@workspace/db";
import { attachAuthUser } from "../../lib/auth/middleware.js";
import { createUserSession } from "../../lib/auth/userSessions.js";
import { generateDeterministicCandles } from "../../lib/backtestStrategyRegistry.js";
import { enforcePreTradeRisk } from "../../lib/riskGovernor/enforce.js";
import { NO_HALT } from "../../lib/safety/tradingHalt.js";
import { createActionDraft } from "../../lib/tradeAction/create.js";
import { confirmAction } from "../../lib/tradeAction/confirm.js";
import paperTradingRouter from "../paperTrading.js";
import livePositionsRouter from "../livePositions.js";

// The stop switches have their own tests below; the rule tests run with every
// switch released (a fresh database engages the platform emergency stop).
const RELEASED = { facts: { halt: NO_HALT } };
const EMAIL_A = "qa+risk-gov-a@arx.test";
const EMAIL_B = "qa+risk-gov-b@arx.test";
const SYMBOL = "EURUSD";

let server: Server;
let base = "";
const u = { a: 0, b: 0 };
const c = { a: "", b: "" };

async function deleteFixtures(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.email, [EMAIL_A, EMAIL_B]));
  const ids = users.map((x) => x.id);
  if (!ids.length) return;
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, ids));
  await db.delete(notificationsTable).where(inArray(notificationsTable.userId, ids));
  await db.delete(tradeActionRequestsTable).where(inArray(tradeActionRequestsTable.userId, ids));
  await db.delete(mt5CommandsTable).where(inArray(mt5CommandsTable.userId, ids));
  await db.delete(paperExecutionsTable).where(inArray(paperExecutionsTable.userId, ids));
  await db.delete(paperTradeEventsTable).where(inArray(paperTradeEventsTable.userId, ids));
  await db.delete(paperOrdersTable).where(inArray(paperOrdersTable.userId, ids));
  await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.userId, ids));
  await db.delete(arxLivePositionsTable).where(inArray(arxLivePositionsTable.userId, ids));
  await db.delete(arxLiveArmingTable).where(inArray(arxLiveArmingTable.userId, ids));
  await db.delete(livePositionsTable).where(inArray(livePositionsTable.userId, ids));
  await db.delete(arxSymbolSpecsTable).where(inArray(arxSymbolSpecsTable.userId, ids));
  await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.userId, ids));
  await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function seedUser(email: string, name: string): Promise<{ id: number; cookie: string }> {
  const [user] = await db.insert(usersTable).values({ email, name, role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  assert.ok(user);
  const { rawToken } = await createUserSession({ userId: user.id });
  return { id: user.id, cookie: `arx_user_session=${rawToken}` };
}

/** The paper simulator's market price (same generator the route uses). */
function paperPrice(): number {
  const bucket = Math.floor(Date.now() / 60_000) * 60_000;
  const candles = generateDeterministicCandles({ symbol: SYMBOL, count: 1, timeframe: "M1", seed: `paper-mtm|${bucket}`, baseTimeMs: bucket });
  return candles[0]!.close;
}

async function resetPaper(userId: number): Promise<number> {
  await db.delete(mt5CommandsTable).where(eq(mt5CommandsTable.userId, userId));
  await db.delete(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.userId, userId));
  await db.delete(paperExecutionsTable).where(eq(paperExecutionsTable.userId, userId));
  await db.delete(paperTradeEventsTable).where(eq(paperTradeEventsTable.userId, userId));
  await db.delete(paperOrdersTable).where(eq(paperOrdersTable.userId, userId));
  await db.delete(paperAccountsTable).where(eq(paperAccountsTable.userId, userId));
  const [acct] = await db.insert(paperAccountsTable).values({
    userId, accountName: "QA risk", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, isActive: 1,
  }).returning({ id: paperAccountsTable.id });
  return acct!.id;
}

async function riskEvents(userId: number) {
  return db.select().from(userRiskEventsTable).where(eq(userRiskEventsTable.userId, userId))
    .orderBy(desc(userRiskEventsTable.id));
}

async function latestEvent(userId: number) {
  const [row] = await riskEvents(userId);
  assert.ok(row, "an audit row was written");
  const details = row.details as Record<string, unknown>;
  assert.equal(details["source"], "pre_trade_risk_governor");
  return { row, details, blockedBy: details["blockedBy"] as string[], intent: details["intent"] as Record<string, unknown> };
}

async function seedBridge(userId: number, heartbeatAgoMs = 0): Promise<number> {
  await db.delete(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, userId));
  const now = Date.now();
  const [conn] = await db.insert(mt5ConnectionTable).values({
    userId, connectionName: "QA sandbox bridge", status: "connected",
    lastHeartbeat: new Date(now - heartbeatAgoMs), accountSyncedAt: new Date(now),
    accountCurrency: "USD", accountBalance: 10_000, accountEquity: 10_000, freeMargin: 9_000, leverage: 100,
    accountType: "demo",
  }).returning({ id: mt5ConnectionTable.id });
  await db.delete(arxSymbolSpecsTable).where(eq(arxSymbolSpecsTable.userId, userId));
  await db.insert(arxSymbolSpecsTable).values({
    userId, bridgeConnectionId: conn!.id, symbol: SYMBOL, contractSize: 100_000, profitCurrency: "USD",
    volumeStep: 0.01, minVolume: 0.01, maxVolume: 50, bid: 1.1, ask: 1.1001, lastTickTime: new Date(now),
  });
  return conn!.id;
}

function request(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  const headers = new Headers({ cookie });
  if (body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

before(async () => {
  await deleteFixtures();
  const a = await seedUser(EMAIL_A, "QA Risk A");
  const b = await seedUser(EMAIL_B, "QA Risk B");
  u.a = a.id; c.a = a.cookie; u.b = b.id; c.b = b.cookie;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use(attachAuthUser);
  app.use("/api", paperTradingRouter);
  app.use("/api", livePositionsRouter);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteFixtures();
});

// ── A. Demo, manual ────────────────────────────────────────────────────────

test("A demo manual: an oversized order is rejected, never written, and audited", async () => {
  const acct = await resetPaper(u.a);
  const px = paperPrice();
  const res = await request("POST", "/paper/orders", c.a, {
    paperAccountId: acct, symbol: SYMBOL, direction: "BUY", lotSize: 6,
    stopLoss: px * 0.98, takeProfit: px * 1.04,
  });
  assert.equal(res.status, 422);
  const body = await res.json() as { code: string; blockedBy: string[]; auditEventId: number };
  assert.equal(body.code, "RISK_GOVERNOR_BLOCK");
  assert.ok(body.blockedBy.includes("max_position_size"));
  const orders = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.paperAccountId, acct));
  assert.equal(orders.length, 0, "no order row on a block");
  const ev = await latestEvent(u.a);
  assert.equal(ev.row.id, body.auditEventId);
  assert.equal(ev.row.decision, "block");
  assert.equal(ev.row.eventType, "blocked_trade");
  assert.ok(ev.blockedBy.includes("max_position_size"));
  assert.equal(ev.intent["venue"], "PAPER");
  assert.equal(ev.intent["origin"], "manual");
});

test("A demo manual: a sized order passes, is written, and its pass is audited; an identical repeat is a duplicate", async () => {
  const acct = await resetPaper(u.a);
  const px = paperPrice();
  const order = { paperAccountId: acct, symbol: SYMBOL, direction: "BUY", lotSize: 0.1, stopLoss: px * 0.98, takeProfit: px * 1.04 };
  const res = await request("POST", "/paper/orders", c.a, order);
  assert.equal(res.status, 200, await res.clone().text());
  const ok = await latestEvent(u.a);
  assert.equal(ok.row.decision, "pass");
  assert.equal(ok.row.eventType, "risk_check");
  assert.equal((ok.details["rules"] as unknown[]).length, 12);

  const dup = await request("POST", "/paper/orders", c.a, order);
  assert.equal(dup.status, 422);
  const dupBody = await dup.json() as { blockedBy: string[] };
  assert.ok(dupBody.blockedBy.includes("duplicate_or_conflicting"));
  const orders = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.paperAccountId, acct));
  assert.equal(orders.length, 1, "the duplicate was not written");
});

test("A demo manual: today's realized loss at the cap blocks new risk (daily loss limit)", async () => {
  const acct = await resetPaper(u.a);
  await db.insert(paperOrdersTable).values({
    userId: u.a, paperAccountId: acct, symbol: "GBPUSD", direction: "BUY", lotSize: 1,
    entryPrice: 1.3, stopLoss: 1.2, takeProfit: 1.4, status: "CLOSED_SL", exitPrice: 1.2,
    profitLoss: -400, closedAt: new Date(),
  });
  await db.update(paperAccountsTable).set({ currentBalance: 9_600, equity: 9_600 }).where(eq(paperAccountsTable.id, acct));
  const px = paperPrice();
  const res = await request("POST", "/paper/orders", c.a, {
    paperAccountId: acct, symbol: SYMBOL, direction: "BUY", lotSize: 0.1, stopLoss: px * 0.98, takeProfit: px * 1.04,
  });
  assert.equal(res.status, 422);
  const body = await res.json() as { blockedBy: string[]; error: string };
  assert.deepEqual(body.blockedBy, ["daily_loss_limit"]);
  assert.match(body.error, /Daily loss/);
});

// ── B. Demo, Ruby ──────────────────────────────────────────────────────────

test("Position Guardian (paper): a stop tightens freely; widening past the per-trade limit is refused, audited, and leaves the stop", async () => {
  const acct = await resetPaper(u.a);
  // Per-trade limit 0.1% of $10k = $10. Paper ledger: loss = |entry - stop| × lots × 100.
  await db.insert(userRiskSettingsTable).values({ userId: u.a, maxRiskPerTradePercent: 0.1 })
    .onConflictDoUpdate({ target: userRiskSettingsTable.userId, set: { maxRiskPerTradePercent: 0.1 } });
  try {
    const px = paperPrice();
    const placed = await request("POST", "/paper/orders", c.a, {
      paperAccountId: acct, symbol: SYMBOL, direction: "BUY", lotSize: 1, stopLoss: px * 0.95, takeProfit: px * 1.1,
    });
    assert.equal(placed.status, 200, await placed.clone().text());
    const { order } = await placed.json() as { order: { id: number; entryPrice: number } };
    const entry = order.entryPrice;

    const tighten = await request("PATCH", `/paper/orders/${order.id}`, c.a, { stopLoss: entry * 0.97 });
    assert.equal(tighten.status, 200, await tighten.clone().text());

    // entry × 0.15 × 100 ≈ $15 at risk, above the $10 limit.
    const widen = await request("PATCH", `/paper/orders/${order.id}`, c.a, { stopLoss: entry * 0.85 });
    assert.equal(widen.status, 422);
    const body = await widen.json() as { code: string; blockedBy: string[]; auditEventId: number };
    assert.equal(body.code, "RISK_GOVERNOR_BLOCK");
    assert.deepEqual(body.blockedBy, ["per_trade_loss_limit"]);
    const ev = await latestEvent(u.a);
    assert.equal(ev.row.id, body.auditEventId);
    assert.equal(ev.row.decision, "block");
    assert.equal(ev.intent["action"], "MODIFY");
    const [row] = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, order.id));
    assert.ok(Math.abs(row!.stopLoss - entry * 0.97) < 1e-5, "the refused widening left the stop where it was");

    // A smaller widening that stays inside the limit (~$7) goes through.
    const widenOk = await request("PATCH", `/paper/orders/${order.id}`, c.a, { stopLoss: entry * 0.93 });
    assert.equal(widenOk.status, 200, await widenOk.clone().text());
  } finally {
    await db.delete(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, u.a));
  }
});

test("Position Guardian (demo positions): removing a stop or widening it past the limit is refused; tightening goes through", async () => {
  await seedBridge(u.a);
  const [pos] = await db.insert(livePositionsTable).values({
    userId: u.a, symbol: SYMBOL, direction: "BUY", lotSize: 0.1, entryPrice: 1.1, stopLoss: 1.0951, status: "OPEN",
  }).returning({ id: livePositionsTable.id });
  try {
    await withSingleton("platform", false, async () => {
      const removed = await request("PATCH", `/positions/${pos!.id}/stop-loss`, c.a, { stopLoss: null, removeConfirmed: true });
      assert.equal(removed.status, 422);
      assert.deepEqual((await removed.json() as { blockedBy: string[] }).blockedBy, ["stop_loss_required"]);
      // 1.0850 puts $150 at risk against the $100 per-trade limit.
      const widened = await request("PATCH", `/positions/${pos!.id}/stop-loss`, c.a, { stopLoss: 1.085 });
      assert.equal(widened.status, 422);
      assert.deepEqual((await widened.json() as { blockedBy: string[] }).blockedBy, ["per_trade_loss_limit"]);
      const [still] = await db.select().from(livePositionsTable).where(eq(livePositionsTable.id, pos!.id));
      assert.equal(still!.stopLoss, 1.0951, "refused changes leave the stop where it was");
      const tightened = await request("PATCH", `/positions/${pos!.id}/stop-loss`, c.a, { stopLoss: 1.098 });
      assert.equal(tightened.status, 200, await tightened.clone().text());
    });
  } finally {
    await db.delete(positionEventsTable).where(eq(positionEventsTable.livePositionId, pos!.id));
    await db.delete(livePositionsTable).where(eq(livePositionsTable.id, pos!.id));
  }
});

test("Position Guardian: live, demo and trade-action modifies hand the governor the position being changed", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  assert.match(read("../../lib/live/liveCommandPipeline.ts"), /position: rgPosition/);
  assert.match(read("../../lib/mt5/demoCommandConsumer.ts"), /intentRef: `demo_command:\$\{row\.commandId\}`,\s*position,/);
  assert.match(read("../../lib/tradeAction/guards.ts"), /position: trade\s*\?/);
  assert.match(read("../paperTrading.ts"), /action: "MODIFY"/);
  assert.match(read("../livePositions.ts"), /action: "MODIFY"/);
});

test("B demo Ruby: a Ruby-suggested draft with no stop is rejected at confirm and audited as origin ruby", async () => {
  await resetPaper(u.a);
  await seedBridge(u.a); // gives the quote source for the paper venue
  const draft = await createActionDraft({
    userId: u.a, actionType: "OPEN", tradeKey: null, requestedMode: "SIMULATED",
    symbol: SYMBOL, side: "BUY", lotSize: 0.1, stopLoss: null, takeProfit: 1.11, source: "ai_suggested",
  });
  assert.ok(draft.ok);
  const result = await confirmAction({ userId: u.a, actionId: draft.action.id });
  assert.equal(result.ok, false);
  const [row] = await db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, draft.action.id));
  assert.equal(row!.status, "rejected");
  assert.match(row!.rejectionReason ?? "", /stop loss is required/i);
  const guard = row!.guardResult as { failedCheckId: string };
  assert.equal(guard.failedCheckId, "risk_governor");
  const cmds = await db.select().from(mt5CommandsTable).where(eq(mt5CommandsTable.userId, u.a));
  assert.equal(cmds.length, 0, "nothing queued");
  const ev = await latestEvent(u.a);
  assert.equal(ev.intent["origin"], "ruby");
  assert.ok(ev.blockedBy.includes("stop_loss_required"));
});

test("B demo Ruby: a sound Ruby draft passes the governor and moves on to the queue", async () => {
  await resetPaper(u.a);
  await seedBridge(u.a);
  const draft = await createActionDraft({
    userId: u.a, actionType: "OPEN", tradeKey: null, requestedMode: "SIMULATED",
    symbol: SYMBOL, side: "BUY", lotSize: 0.1, stopLoss: 1.095, takeProfit: 1.11, source: "ai_suggested",
  });
  assert.ok(draft.ok);
  const result = await confirmAction({ userId: u.a, actionId: draft.action.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  const ev = await latestEvent(u.a);
  assert.equal(ev.row.decision, "pass");
  assert.equal(ev.intent["origin"], "ruby");
  assert.equal(ev.intent["venue"], "PAPER");
});

// ── C. Demo, automated: riskGovernorAutomation.test.ts (needs a stubbed
//    market-data provider, so it runs in its own process). ─────────────────

// ── D. Live, sandbox only ──────────────────────────────────────────────────

test("D live sandbox: the live venue reads the trader's own edited limits (per-trade risk)", async () => {
  await seedBridge(u.a);
  await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, u.a));
  const intent = {
    userId: u.a, venue: "LIVE" as const, origin: "manual" as const, action: "OPEN" as const,
    symbol: SYMBOL, side: "BUY" as const, lots: 0.1, stopLoss: 1.0951, takeProfit: 1.11,
  };
  const pass = await enforcePreTradeRisk(intent, RELEASED);
  assert.equal(pass.decision, "ALLOW", pass.primaryReason ?? "");
  assert.equal(pass.limits?.maxRiskPerTradePercent, 1);

  // The trader tightens their own per-trade risk to 0.25% ($25): a $50 loss at stop now blocks.
  await db.insert(userRiskSettingsTable).values({ userId: u.a, maxRiskPerTradePercent: 0.25 })
    .onConflictDoUpdate({ target: userRiskSettingsTable.userId, set: { maxRiskPerTradePercent: 0.25 } });
  const block = await enforcePreTradeRisk(intent, RELEASED);
  assert.deepEqual(block.blockedBy, ["per_trade_loss_limit"]);
  assert.equal(block.limits?.sources["maxRiskPerTradePercent"], "user_risk_settings.max_risk_per_trade_percent");
  const ev = await latestEvent(u.a);
  assert.equal(ev.row.id, block.auditEventId);
  assert.equal(ev.intent["venue"], "LIVE");
  const facts = ev.details["facts"] as { account: { source: string } | null };
  assert.match(facts.account?.source ?? "", /^broker_hub:mt5:\d+:fresh$/, "the account snapshot comes from the Broker Hub");
  await db.delete(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, u.a));
});

test("D live sandbox: degraded bridge blocks new risk but not a close; a dead bridge blocks both", async () => {
  const intent = {
    userId: u.a, venue: "LIVE" as const, origin: "manual" as const, action: "OPEN" as const,
    symbol: SYMBOL, side: "BUY" as const, lots: 0.1, stopLoss: 1.0951, takeProfit: 1.11,
  };
  await seedBridge(u.a, 60_000);
  assert.deepEqual((await enforcePreTradeRisk(intent, RELEASED)).blockedBy, ["broker_unavailable"]);
  assert.equal((await enforcePreTradeRisk({ ...intent, action: "CLOSE" }, RELEASED)).decision, "ALLOW");
  await seedBridge(u.a, 10 * 60_000);
  assert.deepEqual((await enforcePreTradeRisk({ ...intent, action: "CLOSE" }, RELEASED)).blockedBy, ["broker_unavailable"]);
});

test("D live sandbox: a stale broker quote blocks the entry", async () => {
  await seedBridge(u.a);
  await db.update(arxSymbolSpecsTable).set({ lastTickTime: new Date(Date.now() - 5 * 60_000) })
    .where(eq(arxSymbolSpecsTable.userId, u.a));
  const d = await enforcePreTradeRisk({
    userId: u.a, venue: "LIVE", origin: "manual", action: "OPEN",
    symbol: SYMBOL, side: "BUY", lots: 0.1, stopLoss: 1.0951, takeProfit: 1.11,
  }, RELEASED);
  assert.deepEqual(d.blockedBy, ["stale_market_data"]);
});

test("D live dispatch and the demo MT5 queue call the governor before their send step", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const pipeline = read("../../lib/live/liveCommandPipeline.ts");
  const dispatch = pipeline.slice(pipeline.indexOf("export async function dispatchLiveCommand"));
  const gateAt = dispatch.indexOf("enforcePreTradeRisk(");
  const sendAt = dispatch.indexOf('status: "SENT_TO_MT5_LIVE"');
  assert.ok(gateAt > 0, "live dispatch calls enforcePreTradeRisk");
  assert.ok(sendAt > gateAt, "the governor runs before the SENT_TO_MT5_LIVE write");
  assert.match(dispatch.slice(gateAt, gateAt + 2_500), /status: "LIVE_BLOCKED"/);

  const consumer = read("../../lib/mt5/demoCommandConsumer.ts");
  const riskAt = consumer.indexOf("enforcePreTradeRisk(");
  assert.ok(riskAt > 0 && riskAt < consumer.indexOf("canDispatchToMt5(dispatchInputs)"), "demo queue checks risk before its chokepoint");
  assert.doesNotMatch(consumer, /riskGatePassed:\s*true/, "the demo chokepoint no longer hard-codes a passed risk gate");

  const meTrades = read("../meTrades.ts");
  const closeGate = meTrades.indexOf('action: "CLOSE",\n      symbol, side, lots: lotSize');
  assert.ok(closeGate > 0 && closeGate < meTrades.indexOf("// Queue the CLOSE command."), "the demo My Trades close is checked before it is queued");

  for (const rel of ["../paperTrading.ts", "../demoExecution.ts", "../../lib/adminTrading/orderGuard.ts",
    "../../lib/paperExecution/paperExecutionService.ts", "../../lib/tradeAction/riskGovernorEnforcement.ts"]) {
    assert.match(read(rel), /enforcePreTradeRisk\(/, `${rel} calls the governor`);
  }
  assert.match(read("../../lib/riskGovernor/enforce.ts"), /halt: f\.halt !== undefined\s*\? f\.halt\s*: await loadTradingHalt\(/,
    "every governed order reads the stop switches unless a test supplies them");
  assert.doesNotMatch(read("../../lib/tradeAction/riskGovernorEnforcement.ts"), /rg_skipped_simulated/, "simulated actions no longer skip the governor");
});

// ── Boundary, isolation, preview ───────────────────────────────────────────

test("demo/live boundary: a stopless live position blocks live entries but not paper ones", async () => {
  const conn = await seedBridge(u.a);
  await resetPaper(u.a);
  await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, u.a));
  await db.insert(arxLivePositionsTable).values({
    userId: u.a, bridgeConnectionId: conn, brokerTicket: "QA-RG-1", symbol: "GBPUSD", side: "BUY",
    volume: 0.01, entryPrice: 1.3, stopLoss: null, openedAt: new Date(Date.now() - 3_600_000),
  });
  const live = await enforcePreTradeRisk({
    userId: u.a, venue: "LIVE", origin: "manual", action: "OPEN",
    symbol: SYMBOL, side: "BUY", lots: 0.1, stopLoss: 1.0951, takeProfit: 1.11,
  }, RELEASED);
  assert.deepEqual(live.blockedBy, ["max_portfolio_exposure"]);
  const px = paperPrice();
  const paper = await enforcePreTradeRisk({
    userId: u.a, venue: "PAPER", origin: "manual", action: "OPEN",
    symbol: SYMBOL, side: "BUY", lots: 0.1, stopLoss: px * 0.98, takeProfit: px * 1.04,
  }, { facts: { quote: { bid: px, ask: px, at: new Date(), source: "qa" } } });
  assert.equal(paper.decision, "ALLOW", JSON.stringify(paper.rules.filter((r) => r.outcome === "BLOCK")));
  const demo = await enforcePreTradeRisk({
    userId: u.a, venue: "DEMO", origin: "manual", action: "OPEN",
    symbol: SYMBOL, side: "BUY", lots: 0.1, stopLoss: 1.0951, takeProfit: 1.11,
  }, RELEASED);
  assert.equal(demo.decision, "ALLOW", JSON.stringify(demo.rules.filter((r) => r.outcome === "BLOCK")));
  await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, u.a));
});

test("isolation: another trader's losses, positions and bridge never decide this trader's order", async () => {
  await seedBridge(u.b, 10 * 60_000); // B's bridge is dead
  const acctB = await resetPaper(u.b);
  await db.insert(paperOrdersTable).values({
    userId: u.b, paperAccountId: acctB, symbol: "GBPUSD", direction: "BUY", lotSize: 1,
    entryPrice: 1.3, stopLoss: 1.2, takeProfit: 1.4, status: "CLOSED_SL", exitPrice: 1.2, profitLoss: -900, closedAt: new Date(),
  });
  await seedBridge(u.a);
  await resetPaper(u.a);
  const live = await enforcePreTradeRisk({
    userId: u.a, venue: "LIVE", origin: "manual", action: "OPEN",
    symbol: SYMBOL, side: "BUY", lots: 0.1, stopLoss: 1.0951, takeProfit: 1.11,
  }, RELEASED);
  assert.equal(live.decision, "ALLOW", live.primaryReason ?? "");
  const px = paperPrice();
  const paper = await enforcePreTradeRisk({
    userId: u.a, venue: "PAPER", origin: "manual", action: "OPEN",
    symbol: SYMBOL, side: "BUY", lots: 0.1, stopLoss: px * 0.98, takeProfit: px * 1.04,
  }, { facts: { quote: { bid: px, ask: px, at: new Date(), source: "qa" } } });
  assert.equal(paper.decision, "ALLOW", JSON.stringify(paper.rules.filter((r) => r.outcome === "BLOCK")));
  const bEvents = await riskEvents(u.b);
  assert.equal(bEvents.length, 0, "A's checks never write to B's audit trail");
});

// ── Stop switches (lib/safety/tradingHalt) ────────────────────────────────

async function soundOpen(userId: number, venue: "PAPER" | "DEMO" | "LIVE") {
  const px = paperPrice();
  const paper = venue === "PAPER";
  return enforcePreTradeRisk({
    userId, venue, origin: "manual", action: "OPEN", symbol: SYMBOL, side: "BUY", lots: 0.1,
    stopLoss: paper ? px * 0.98 : 1.0951, takeProfit: paper ? px * 1.04 : 1.11,
  }, paper ? { facts: { quote: { bid: px, ask: px, at: new Date(), source: "qa" } } } : {});
}

/** Run with a singleton switch set, then put back what was there. */
async function withSingleton<T>(table: "platform" | "safety_core", on: boolean, fn: () => Promise<T>): Promise<T> {
  const t = table === "platform" ? globalTradingSettingsTable : safetyCoreTable;
  const col = table === "platform" ? "emergencyKillSwitch" : "killSwitchEngaged";
  const rows = await db.select().from(t).orderBy(t.id).limit(1);
  let id = rows[0]?.id;
  const prev = rows[0] ? (rows[0] as Record<string, unknown>)[col] as boolean : null;
  if (id == null) id = (await db.insert(t).values({}).returning({ id: t.id }))[0]!.id;
  await db.update(t).set({ [col]: on } as never).where(eq(t.id, id));
  try { return await fn(); } finally {
    if (prev == null) await db.delete(t).where(eq(t.id, id));
    else await db.update(t).set({ [col]: prev } as never).where(eq(t.id, id));
  }
}

test("halt: a trader's own kill switch stops their new risk on paper, demo and live, but never a close or a tightened stop, and never another trader", async () => {
  await seedBridge(u.a);
  await seedBridge(u.b);
  await resetPaper(u.a);
  await resetPaper(u.b);
  await db.insert(arxLiveArmingTable).values({ userId: u.a, killSwitchEngaged: true, killSwitchReason: "qa stop" });
  try {
    await withSingleton("platform", false, async () => {
      for (const venue of ["PAPER", "DEMO", "LIVE"] as const) {
        const d = await soundOpen(u.a, venue);
        assert.equal(d.decision, "BLOCK", venue);
        assert.equal(d.blockedBy[0], "trading_halt", venue);
        assert.deepEqual(d.halt?.sources, ["trader_kill_switch"], venue);
        assert.match(d.primaryReason!, /Your kill switch is engaged.*qa stop/);
        const ev = await latestEvent(u.a);
        assert.equal(ev.row.id, d.auditEventId);
        assert.deepEqual((ev.details["halt"] as { sources: string[] }).sources, ["trader_kill_switch"]);
      }
      const close = await enforcePreTradeRisk({
        userId: u.a, venue: "LIVE", origin: "manual", action: "CLOSE", symbol: SYMBOL, side: "BUY", lots: 0.1,
      });
      assert.equal(close.decision, "ALLOW", "closing is never halted by a kill switch");
      const stop = await enforcePreTradeRisk({
        userId: u.a, venue: "LIVE", origin: "manual", action: "MODIFY", symbol: SYMBOL, side: "BUY", lots: 0.1,
        stopLoss: 1.098, position: { entryPrice: 1.1, stopLoss: 1.0951 },
      });
      assert.equal(stop.decision, "ALLOW", "tightening a stop is never halted");
      const widen = await enforcePreTradeRisk({
        userId: u.a, venue: "LIVE", origin: "manual", action: "MODIFY", symbol: SYMBOL, side: "BUY", lots: 0.1,
        stopLoss: 1.095, position: { entryPrice: 1.1, stopLoss: 1.0951 },
      });
      assert.equal(widen.blockedBy[0], "trading_halt", "a widened stop is halted");
      const other = await soundOpen(u.b, "LIVE");
      assert.equal(other.decision, "ALLOW", other.primaryReason ?? "");
    });
  } finally {
    await db.delete(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, u.a));
  }
});

test("halt: the platform emergency stop halts demo and live for everyone; the paper simulator keeps running", async () => {
  await seedBridge(u.a);
  await resetPaper(u.a);
  await withSingleton("platform", true, async () => {
    for (const venue of ["DEMO", "LIVE"] as const) {
      const d = await soundOpen(u.a, venue);
      assert.deepEqual(d.blockedBy, ["trading_halt"], venue);
      assert.deepEqual(d.halt?.sources, ["platform_emergency_stop"]);
    }
    const paper = await soundOpen(u.a, "PAPER");
    assert.equal(paper.decision, "ALLOW", paper.primaryReason ?? "");
  });
  await withSingleton("platform", false, async () => {
    assert.equal((await soundOpen(u.a, "LIVE")).decision, "ALLOW");
  });
});

test("halt: the safety-core kill switch halts every venue, paper included", async () => {
  await seedBridge(u.a);
  await resetPaper(u.a);
  await withSingleton("platform", false, () => withSingleton("safety_core", true, async () => {
    for (const venue of ["PAPER", "DEMO", "LIVE"] as const) {
      const d = await soundOpen(u.a, venue);
      assert.deepEqual(d.blockedBy, ["trading_halt"], venue);
      assert.deepEqual(d.halt?.sources, ["safety_core_kill_switch"]);
    }
  }));
});

test("halt: paper POST /paper/orders refuses with the halt named while the trader's switch is engaged", async () => {
  const acct = await resetPaper(u.a);
  await db.insert(arxLiveArmingTable).values({ userId: u.a, killSwitchEngaged: true });
  try {
    const px = paperPrice();
    const res = await request("POST", "/paper/orders", c.a, {
      paperAccountId: acct, symbol: SYMBOL, direction: "BUY", lotSize: 0.1, stopLoss: px * 0.98, takeProfit: px * 1.04,
    });
    assert.equal(res.status, 422);
    const body = await res.json() as { blockedBy: string[] };
    assert.equal(body.blockedBy[0], "trading_halt");
    assert.equal((await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.paperAccountId, acct))).length, 0);
  } finally {
    await db.delete(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, u.a));
  }
});

test("preview evaluates without writing an audit row; a real check writes exactly one", async () => {
  await seedBridge(u.a);
  const before = (await riskEvents(u.a)).length;
  const intent = {
    userId: u.a, venue: "LIVE" as const, origin: "manual" as const, action: "OPEN" as const,
    symbol: SYMBOL, side: "BUY" as const, lots: 0.1, stopLoss: 1.0951, takeProfit: 1.11,
  };
  const p = await enforcePreTradeRisk(intent, { ...RELEASED, preview: true });
  assert.equal(p.auditEventId, null);
  assert.equal((await riskEvents(u.a)).length, before);
  const r = await enforcePreTradeRisk(intent, RELEASED);
  assert.ok(r.auditEventId);
  assert.equal((await riskEvents(u.a)).length, before + 1);
});
