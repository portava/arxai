// Owner decision 15 (2026-10-25): My Trades DEMO opens go through the
// governed DEMO pipeline; My Trades LIVE opens stay refused. Real database,
// real routes, real Trade Action guard chain and Risk Governor.
//
//   - a confirmed DEMO open becomes a Trade Action, passes runActionGuards
//     (ownership, stops, DEMO venue switch, routing, account type, lot cap,
//     Risk Governor venue DEMO, duplicate, connection) and reaches the demo
//     command queue through submitTrade mode DEMO, stamped ME_TRADES_DEMO_OPEN;
//   - the legacy placeOrder chain is not used (no trade_command_audit_log row,
//     no mt5_commands row);
//   - LIVE is refused with MY_TRADES_LIVE_OPEN_NOT_ENABLED and creates nothing;
//   - confirmation is required; the trader's mode must permit DEMO;
//   - ownership: a trader's open uses only their own connection, and another
//     trader cannot confirm it;
//   - sizing / Risk Governor refusals and the queue's own refusal are returned
//     by name, and a duplicate in flight is refused.
//
// The only stub is the demo command queue (it needs a live EA, per-user
// arming and a VERIFIED_DEMO gate; its own tests and
// test:risk-governor-pipelines cover it): it records each call and either
// accepts or refuses. Nothing reaches a broker.
//
// Run: pnpm --filter @workspace/api-server run test:my-trades-demo-open

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

type QueueCall = { fn: string; args: Record<string, unknown> };
const calls: QueueCall[] = [];
let queueMode: "send" | "refuse" = "send";
const realQueue = await import("../../mt5/demoCommandQueue.js");
mock.module("../../mt5/demoCommandQueue.js", {
  namedExports: {
    ...realQueue,
    createDraftCommand: async (args: Record<string, unknown>) => {
      calls.push({ fn: "createDraftCommand", args });
      if (queueMode === "refuse") return { ok: false, reason: "NOT_ARMED_FOR_DEMO_EXECUTION" };
      return { ok: true, command: { commandId: `dmcmd_qa_${calls.length}`, status: "USER_CONFIRMATION_REQUIRED" } };
    },
    confirmCommand: async (args: Record<string, unknown>) => {
      calls.push({ fn: "confirmCommand", args });
      return { ok: true, command: { commandId: args["commandId"], status: "DEMO_APPROVED" } };
    },
    dispatchApprovedCommand: async (args: Record<string, unknown>) => {
      calls.push({ fn: "dispatchApprovedCommand", args });
      return { ok: true, command: { commandId: args["commandId"], status: "SENT_TO_MT5_DEMO" } };
    },
  },
});

const { default: express } = await import("express");
const { default: cookieParser } = await import("cookie-parser");
const { eq, inArray } = await import("drizzle-orm");
const {
  arxSymbolSpecsTable, authUserSessionsTable, db, globalTradingSettingsTable, mt5CommandsTable, mt5ConnectionTable,
  notificationsTable, safetyCoreTable, tradeActionRequestsTable, tradeCommandAuditLogTable, tradeDecisionTimelineTable,
  userRiskEventsTable, userRiskLimitsTable, userTradingPermissionsTable, usersTable,
} = await import("@workspace/db");
const { attachAuthUser } = await import("../../auth/middleware.js");
const { createUserSession } = await import("../../auth/userSessions.js");
const { confirmAction } = await import("../confirm.js");
const { openMyTradesDemo, MY_TRADES_DEMO_SOURCE, MY_TRADES_LIVE_NOT_ENABLED } = await import("../myTradesOpen.js");
const { default: meTradesRouter } = await import("../../../routes/meTrades.js");

const EMAIL_A = "qa+my-trades-demo-a@arx.test";
const EMAIL_B = "qa+my-trades-demo-b@arx.test";
const SYMBOL = "EURUSD";
const SL = 1.095;
const TP = 1.11;
const u = { a: 0, b: 0 };
const c = { a: "", b: "" };
const conn = { a: 0 };
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
  await db.delete(mt5CommandsTable).where(inArray(mt5CommandsTable.userId, ids));
  await db.delete(arxSymbolSpecsTable).where(inArray(arxSymbolSpecsTable.userId, ids));
  await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.userId, ids));
  await db.delete(userRiskLimitsTable).where(inArray(userRiskLimitsTable.userId, ids));
  await db.delete(userTradingPermissionsTable).where(inArray(userTradingPermissionsTable.userId, ids));
  await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

/** A trader allowed DEMO, with operator limits; `bridge` seeds their own fresh demo connection. */
async function seedUser(email: string, bridge: boolean): Promise<{ id: number; cookie: string; conn: number }> {
  const [user] = await db.insert(usersTable).values({ email, name: email, role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  const id = user!.id;
  const { rawToken } = await createUserSession({ userId: id });
  let connId = 0;
  if (bridge) {
    const [row] = await db.insert(mt5ConnectionTable).values({
      userId: id, connectionName: "QA demo bridge", status: "connected", lastHeartbeat: new Date(), accountSyncedAt: new Date(),
      accountCurrency: "USD", accountBalance: 10_000, accountEquity: 10_000, freeMargin: 9_000, leverage: 100, accountType: "demo",
    }).returning({ id: mt5ConnectionTable.id });
    connId = row!.id;
    await db.insert(arxSymbolSpecsTable).values({
      userId: id, bridgeConnectionId: connId, symbol: SYMBOL, contractSize: 100_000, profitCurrency: "USD",
      volumeStep: 0.01, minVolume: 0.01, maxVolume: 50, bid: 1.1, ask: 1.1001, lastTickTime: new Date(),
    });
  }
  await db.insert(userTradingPermissionsTable).values({ userId: id, tradingMode: "DEMO", demoEnabled: true, suspended: false });
  await db.insert(userRiskLimitsTable).values({ userId: id, maxLotSize: 1, allowedAccountType: "both" });
  return { id, cookie: `arx_user_session=${rawToken}`, conn: connId };
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

async function fresh(...userIds: number[]): Promise<void> {
  calls.length = 0;
  queueMode = "send";
  for (const id of userIds) {
    await db.delete(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.userId, id));
    await db.delete(tradeCommandAuditLogTable).where(eq(tradeCommandAuditLogTable.userId, id));
  }
}

const actions = (userId: number) => db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.userId, userId));
const audits = (userId: number) => db.select().from(tradeCommandAuditLogTable).where(eq(tradeCommandAuditLogTable.userId, userId));
const drafts = () => calls.filter((x) => x.fn === "createDraftCommand");

function post(cookie: string | null, body: unknown): Promise<Response> {
  return fetch(`${base}/me/trades/open`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
}
const demoBody = (over: Record<string, unknown> = {}) =>
  ({ symbol: SYMBOL, side: "BUY", lotSize: 0.1, mode: "DEMO", stopLoss: SL, takeProfit: TP, confirmedByUser: true, ...over });

before(async () => {
  await deleteFixtures();
  const a = await seedUser(EMAIL_A, true);
  const b = await seedUser(EMAIL_B, false);
  Object.assign(u, { a: a.id, b: b.id });
  Object.assign(c, { a: a.cookie, b: b.cookie });
  conn.a = a.conn;
  // Both install-wide stops released and the DEMO venue open; live stays off. Restored after.
  await setRow("platform", { emergencyKillSwitch: false, platformMode: "DEMO", demoEnabled: true, liveEnabled: false, accountRoutingMode: "USER_OWNED_MT5" });
  await setRow("safety_core", { killSwitchEngaged: false });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachAuthUser);
  app.use(meTradesRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  for (const r of restore.reverse()) await r();
  restore = [];
  await deleteFixtures();
});

test("DEMO: a confirmed open goes through the guards and the Risk Governor to the demo queue, never placeOrder", async () => {
  await fresh(u.a);
  const res = await post(c.a, demoBody());
  const json = await res.json() as {
    ok: boolean; mode: string; venue: string;
    demo: { actionId: number; status: string; commandId: string; sent: boolean };
  };
  assert.equal(res.status, 200);
  assert.ok(json.ok, JSON.stringify(json));
  assert.equal(json.mode, "DEMO");
  assert.equal(json.venue, "DEMO");
  assert.equal(json.demo.sent, true);
  assert.match(json.demo.commandId, /^dmcmd_qa_/);

  // The governed queue got the trader's order, stamped with this surface, in order.
  assert.deepEqual(calls.map((x) => x.fn), ["createDraftCommand", "confirmCommand", "dispatchApprovedCommand"]);
  const d = drafts()[0]!.args;
  assert.equal(d["userId"], u.a);
  assert.equal(d["commandType"], "PLACE_MARKET_ORDER");
  const payload = d["payload"] as Record<string, unknown>;
  assert.deepEqual(
    { symbol: payload["symbol"], side: payload["side"], lotSize: payload["lotSize"], stopLoss: payload["stopLoss"], takeProfit: payload["takeProfit"], sourcePage: payload["sourcePage"] },
    { symbol: SYMBOL, side: "BUY", lotSize: 0.1, stopLoss: SL, takeProfit: TP, sourcePage: MY_TRADES_DEMO_SOURCE },
  );

  // The Trade Action record: the trader's own, explicit DEMO, every guard passed.
  const [row] = await actions(u.a);
  assert.equal(row!.id, json.demo.actionId);
  assert.equal(row!.requestedMode, "DEMO");
  assert.equal(row!.status, "sent_to_mt5");
  assert.equal(row!.executionVenue, "DEMO");
  assert.equal(row!.venueCommandId, json.demo.commandId);
  assert.equal(row!.confirmedByUser, true);
  const guard = row!.guardResult as { passed: boolean; checks: Array<{ id: string; passed: boolean }> };
  assert.equal(guard.passed, true);
  for (const id of ["ownership", "kill_switch", "platform_mode", "routing", "account_type", "risk_limits", "risk_governor", "duplicate", "queueable"]) {
    assert.ok(guard.checks.some((x) => x.id === id && x.passed), `guard ${id} ran and passed`);
  }
  // The Risk Governor decided on this order with venue DEMO.
  const governed = (await db.select().from(userRiskEventsTable).where(eq(userRiskEventsTable.userId, u.a)))
    .map((e) => (e.details as { intent?: Record<string, unknown> }).intent ?? {})
    .filter((i) => i["venue"] === "DEMO" && i["action"] === "OPEN" && i["symbol"] === SYMBOL);
  assert.ok(governed.length >= 1, "the Risk Governor evaluated the DEMO open");

  // Not the legacy chain: no order-guard audit row, no legacy mailbox row.
  assert.equal((await audits(u.a)).length, 0);
  assert.equal((await db.select().from(mt5CommandsTable).where(eq(mt5CommandsTable.userId, u.a))).length, 0);
});

test("LIVE: a My Trades live open is refused by name and creates nothing", async () => {
  await fresh(u.a);
  for (const body of [demoBody({ mode: "LIVE" }), demoBody({ mode: "LIVE", lotSize: 0.01 })]) {
    const res = await post(c.a, body);
    assert.equal(res.status, 403);
    const json = await res.json() as { ok: boolean; mode: string; error: string; message: string; sent: boolean };
    assert.equal(json.ok, false);
    assert.equal(json.mode, "LIVE");
    assert.equal(json.error, MY_TRADES_LIVE_NOT_ENABLED);
    assert.match(json.message, /broker validation/);
    assert.match(json.message, /authoriz/);
    assert.equal(json.sent, false);
  }
  assert.equal(calls.length, 0, "no venue was called");
  assert.equal((await actions(u.a)).length, 0, "nothing drafted");
  assert.equal((await audits(u.a)).length, 0, "no order-guard run");
});

test("confirmation is required: an unconfirmed DEMO open creates nothing", async () => {
  await fresh(u.a);
  const res = await post(c.a, demoBody({ confirmedByUser: false }));
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, "CONFIRMATION_REQUIRED");
  const direct = await openMyTradesDemo({ userId: u.a, symbol: SYMBOL, side: "BUY", lotSize: 0.1, stopLoss: SL, takeProfit: TP, confirmedByUser: false });
  assert.equal(direct.ok ? null : direct.error, "CONFIRMATION_REQUIRED");
  assert.equal(calls.length, 0);
  assert.equal((await actions(u.a)).length, 0);
});

test("ownership: unauthenticated is refused; a trader's open uses only their own connection; another trader cannot confirm it", async () => {
  await fresh(u.a, u.b);
  const anon = await post(null, demoBody());
  assert.equal(anon.status, 401);

  // Trader B has no MT5 connection of their own: refused before any queue,
  // never routed to trader A's connection.
  const res = await post(c.b, demoBody());
  const json = await res.json() as { ok: boolean; error: string; message: string };
  assert.equal(json.ok, false, JSON.stringify(json));
  assert.equal(json.error, "guard_rejected");
  assert.equal(calls.length, 0, "the queue was never called");
  const [rowB] = await actions(u.b);
  assert.equal(rowB!.userId, u.b);
  assert.equal(rowB!.status, "rejected");
  const failed = (rowB!.guardResult as { failedCheckId: string }).failedCheckId;
  assert.ok(["routing", "queueable"].includes(failed), `refused for the missing connection, not ${failed}: ${rowB!.rejectionReason}`);
  assert.equal((await actions(u.a)).length, 0, "nothing was recorded for trader A");

  // An action created for trader A cannot be confirmed by trader B.
  queueMode = "refuse";
  const mine = await openMyTradesDemo({ userId: u.a, symbol: SYMBOL, side: "SELL", lotSize: 0.1, stopLoss: 1.105, takeProfit: 1.09, confirmedByUser: true });
  assert.equal(mine.ok, false);
  const actionId = (await actions(u.a))[0]!.id;
  const foreign = await confirmAction({ userId: u.b, actionId, sourcePage: MY_TRADES_DEMO_SOURCE });
  assert.equal(foreign.ok ? null : foreign.error, "action_not_found");
});

test("mode: a trader whose mode does not permit DEMO is refused before anything is recorded", async () => {
  await fresh(u.a);
  await db.update(userTradingPermissionsTable).set({ demoEnabled: false }).where(eq(userTradingPermissionsTable.userId, u.a));
  try {
    const res = await post(c.a, demoBody());
    const json = await res.json() as { ok: boolean; error: string };
    assert.equal(json.ok, false);
    assert.ok(["USER_TRADING_DISABLED", "MODE_NOT_PERMITTED_FOR_USER:DEMO"].includes(json.error), json.error);
    assert.equal(calls.length, 0);
    assert.equal((await actions(u.a)).length, 0);
  } finally {
    await db.update(userTradingPermissionsTable).set({ demoEnabled: true }).where(eq(userTradingPermissionsTable.userId, u.a));
  }
});

test("sizing and the Risk Governor: an oversized DEMO open is refused by name and never queued", async () => {
  await fresh(u.a);
  const res = await post(c.a, demoBody({ lotSize: 2 }));
  const json = await res.json() as { ok: boolean; error: string; message: string };
  assert.equal(json.ok, false);
  assert.equal(json.error, "guard_rejected");
  assert.equal(calls.length, 0, "never queued");
  const [row] = await actions(u.a);
  assert.equal(row!.status, "rejected");
  assert.equal((row!.guardResult as { failedCheckId: string }).failedCheckId, "risk_governor");
  assert.equal(json.message, row!.rejectionReason);
});

test("the demo queue's own refusal is returned as-is, and a duplicate in flight is refused", async () => {
  await fresh(u.a);
  queueMode = "refuse";
  const refused = await post(c.a, demoBody());
  const rj = await refused.json() as { ok: boolean; error: string; message: string };
  assert.equal(rj.ok, false);
  assert.equal(rj.error, "venue_rejected");
  assert.match(rj.message, /The DEMO queue refused this action: NOT_ARMED_FOR_DEMO_EXECUTION/);

  await fresh(u.a);
  const first = await post(c.a, demoBody());
  assert.ok((await first.json() as { ok: boolean }).ok);
  const second = await post(c.a, demoBody());
  const sj = await second.json() as { ok: boolean; error: string; message: string };
  assert.equal(sj.ok, false);
  assert.equal(sj.error, "guard_rejected");
  assert.match(sj.message, /already in flight/);
  assert.equal(drafts().length, 1, "only the first order reached the queue");
  void conn;
});
