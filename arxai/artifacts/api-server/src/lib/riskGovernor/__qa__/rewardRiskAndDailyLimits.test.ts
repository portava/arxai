// Owner decisions 10 and 9.
//
// 10. The pending-order draft applies the trader's real minimum reward:risk
//     (user_risk_settings.min_reward_risk_ratio, resolved by the risk
//     authority) with the governor's own calculation (checkRewardRiskFloor),
//     in every mode. Missing / invalid inputs are not measured, exactly as in
//     rule 13. This intentionally adds refusals.
//  9. The daily-trade limit counts on the governor's trading day (UTC) from
//     its activity source; the order guard's rolling-24h approved-command
//     count is the separately named operational rate cap.
//
// Run: pnpm --filter @workspace/api-server run test:risk-governor-rr-daily
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { inArray } from "drizzle-orm";
import {
  db,
  paperAccountsTable,
  paperOrdersTable,
  tradeActionRequestsTable,
  tradeCommandAuditLogTable,
  userRiskEventsTable,
  userRiskSettingsTable,
  usersTable,
} from "@workspace/db";
import { checkRewardRiskFloor, measureRewardRisk, summarizeActivity, tradingDayStart } from "../preTrade.js";
import { loadTradingActivity } from "../enforce.js";
import { enforceTradeTicketRules } from "../../tradeAction/riskGovernorEnforcement.js";
import {
  OPERATIONAL_RATE_CAP_WINDOW_MS,
  operationalRateCapCheck,
  operationalRateCapRefusal,
} from "../../adminTrading/orderGuard.js";
import pendingOrderDraftRouter from "../../../routes/pendingOrderDraft.js";

const P = process.pid;
const u = { floor2: 0, noRow: 0, off: 0, rate: 0, other: 0, paper: 0 };
let server: Server;
let base = "";

before(async () => {
  for (const k of Object.keys(u) as Array<keyof typeof u>) {
    const [row] = await db.insert(usersTable)
      .values({ email: `qa+rr-daily-${k}-${P}@arx.test`, name: k, role: "USER", isSystemUser: true }).returning();
    u[k] = row!.id;
  }
  await db.insert(userRiskSettingsTable).values([
    { userId: u.floor2, minRewardRiskRatio: 2 },
    { userId: u.off, minRewardRiskRatio: 0 },
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: { id: number } }).authUser = { id: Number(req.header("x-test-user")) };
    next();
  });
  app.use(pendingOrderDraftRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  const ids = Object.values(u).filter(Boolean);
  if (!ids.length) return;
  await db.delete(tradeActionRequestsTable).where(inArray(tradeActionRequestsTable.userId, ids));
  await db.delete(userRiskEventsTable).where(inArray(userRiskEventsTable.userId, ids));
  await db.delete(tradeCommandAuditLogTable).where(inArray(tradeCommandAuditLogTable.userId, ids));
  await db.delete(paperOrdersTable).where(inArray(paperOrdersTable.userId, ids));
  await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.userId, ids));
  await db.delete(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
});

// ── Decision 10: one R:R calculation ──────────────────────────────────────

test("checkRewardRiskFloor: boundaries, sides, missing and invalid inputs", () => {
  // BUY at 1.1000, stop 1.0900 (risk 0.0100), target 1.1200 (reward 0.0200) → 2.0
  assert.equal(checkRewardRiskFloor(2, "BUY", 1.1, 1.09, 1.12).outcome, "PASS", "exactly at the floor passes");
  const below = checkRewardRiskFloor(2.01, "BUY", 1.1, 1.09, 1.12);
  assert.equal(below.outcome, "BELOW_FLOOR");
  assert.match(below.reason ?? "", /reward:risk 2 is below your minimum of 2.01/);
  assert.equal(checkRewardRiskFloor(2, "SELL", 1.1, 1.11, 1.085).outcome, "BELOW_FLOOR", "SELL 1.5 < 2");
  assert.equal(checkRewardRiskFloor(1.5, "SELL", 1.1, 1.11, 1.085).outcome, "PASS", "SELL 1.5 = 1.5");
  // Missing inputs: not measured, never refused by the floor.
  for (const [side, ref, sl, tp] of [["BUY", 1.1, null, 1.12], ["BUY", 1.1, 1.09, null], ["BUY", null, 1.09, 1.12], [null, 1.1, 1.09, 1.12]] as const) {
    assert.equal(checkRewardRiskFloor(2, side, ref, sl, tp).outcome, "NOT_MEASURED");
  }
  // Invalid geometry (stop / target on the wrong side) and non-finite prices: not measured.
  assert.equal(checkRewardRiskFloor(2, "BUY", 1.1, 1.11, 1.12).outcome, "NOT_MEASURED");
  assert.equal(checkRewardRiskFloor(2, "BUY", 1.1, 1.09, 1.08).outcome, "NOT_MEASURED");
  assert.equal(checkRewardRiskFloor(2, "BUY", Number.NaN, 1.09, 1.12).outcome, "NOT_MEASURED");
  assert.equal(measureRewardRisk("BUY", 1.1, 1.1, 1.12), null, "zero risk");
  // No floor: null, 0, negative, NaN.
  for (const f of [null, 0, -1, Number.NaN]) assert.equal(checkRewardRiskFloor(f, "BUY", 1.1, 1.09, 1.0901).outcome, "NO_FLOOR");
});

test("ticket rules: the floor applies in every mode, with the governor's semantics", () => {
  const t = (mode: "SIMULATED" | "DEMO" | "LIVE", floor: number | null, tp: number | null, orderType: "BUY_LIMIT" | "SELL_LIMIT" = "BUY_LIMIT") =>
    enforceTradeTicketRules({
      userId: 1, requestedMode: mode, orderType, lotSize: 0.01, currentPrice: orderType === "BUY_LIMIT" ? 1.105 : 1.095,
      entryPrice: 1.1, stopTriggerPrice: null, stopLimitPrice: null,
      stopLoss: orderType === "BUY_LIMIT" ? 1.09 : 1.11, takeProfit: tp, minRiskRewardRatio: floor,
    });
  for (const mode of ["SIMULATED", "DEMO", "LIVE"] as const) {
    const r = t(mode, 2, 1.115); // 1.5 < 2
    assert.equal(r.passed, false, `${mode} refused below the floor`);
    assert.equal(r.checkId, "rg_rr_ratio_min");
    assert.match(r.reason ?? "", /reward:risk 1.5 is below your minimum of 2/);
    assert.equal(t(mode, 2, 1.12).passed, true, `${mode} at the floor passes`);
  }
  assert.equal(t("DEMO", 2, null).passed, true, "no target: not measured, not refused by the floor");
  assert.equal(t("DEMO", null, 1.101).passed, true, "no floor");
  assert.equal(t("DEMO", 0, 1.101).passed, true, "floor 0 = off");
  assert.equal(t("DEMO", 2, 1.085, "SELL_LIMIT").passed, false, "SELL 1.5 < 2");
});

async function draft(userId: number, body: Record<string, unknown>) {
  const r = await fetch(`${base}/me/pending-order-draft`, {
    method: "POST", headers: { "content-type": "application/json", "x-test-user": String(userId) },
    body: JSON.stringify({ orderType: "BUY_LIMIT", symbol: "EURUSD", lotSize: 0.01, currentPrice: 1.105,
      entryPrice: 1.1, stopLoss: 1.09, requestedMode: "DEMO", ...body }),
  });
  return (await r.json()) as { ok: boolean; checkId?: string; reason?: string };
}

test("pending-order draft reads the configured min_reward_risk_ratio through the risk authority", async () => {
  // Saved floor 2: R:R 1.5 refused (was never refused before: the hook read a missing field).
  const a = await draft(u.floor2, { takeProfit: 1.115 });
  assert.equal(a.ok, false);
  assert.equal(a.checkId, "rg_rr_ratio_min");
  assert.match(a.reason ?? "", /below your minimum of 2/);
  // SIMULATED drafts too (the old hook skipped them).
  assert.equal((await draft(u.floor2, { takeProfit: 1.115, requestedMode: "SIMULATED" })).checkId, "rg_rr_ratio_min");
  // At the floor the ticket step passes (the governor preview decides next).
  assert.notEqual((await draft(u.floor2, { takeProfit: 1.12 })).checkId, "rg_rr_ratio_min");
  // No target: not measured, so not refused by the floor.
  assert.notEqual((await draft(u.floor2, { takeProfit: null })).checkId, "rg_rr_ratio_min");
});

test("no saved row = the governor's default floor (1.5); a saved 0 switches it off", async () => {
  assert.equal((await draft(u.noRow, { takeProfit: 1.114 })).checkId, "rg_rr_ratio_min", "1.4 < default 1.5");
  // Entry 1.2, stop 1.0, target 1.5: 0.3 / 0.2 = 1.5 (1.5000000000000004 in binary floating point).
  assert.notEqual((await draft(u.noRow, { currentPrice: 1.25, entryPrice: 1.2, stopLoss: 1.0, takeProfit: 1.5 })).checkId,
    "rg_rr_ratio_min", "1.5 = default");
  assert.notEqual((await draft(u.off, { takeProfit: 1.101 })).checkId, "rg_rr_ratio_min", "floor off");
});

// ── Decision 9: trading day vs operational rate cap ───────────────────────

test("the governor's trading day is the UTC calendar day", () => {
  const now = new Date("2026-10-25T00:30:00.000Z");
  assert.equal(tradingDayStart(now).toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(tradingDayStart(new Date("2026-10-24T23:59:59.999Z")).toISOString(), "2026-10-24T00:00:00.000Z");
  const a = summarizeActivity([
    { closedAt: new Date("2026-10-24T23:59:59.999Z"), pnl: 1 },
    { closedAt: new Date("2026-10-25T00:00:00.000Z"), pnl: 1 },
  ], 0, now, "t");
  assert.equal(a.tradesToday, 1, "a close at 23:59:59.999 belongs to the previous trading day");
});

test("operational rate cap: approved commands in a rolling 24h, own reason, per user", async () => {
  const now = new Date();
  const row = (userId: number, status: string, ageMs: number) => ({
    userId, mode: "SIMULATED", symbol: "EURUSD", side: "BUY", lotSize: 0.01, status, requestedBy: "user",
    createdAt: new Date(now.getTime() - ageMs),
  });
  await db.insert(tradeCommandAuditLogTable).values([
    row(u.rate, "APPROVED", OPERATIONAL_RATE_CAP_WINDOW_MS - 60_000),  // inside the window
    row(u.rate, "APPROVED", OPERATIONAL_RATE_CAP_WINDOW_MS + 60_000),  // outside
    row(u.rate, "REJECTED", 60_000),                                   // not approved
    ...Array.from({ length: 5 }, () => row(u.other, "APPROVED", 60_000)), // another trader
  ]);
  assert.equal(await operationalRateCapCheck(u.rate, 1, now), operationalRateCapRefusal(1));
  assert.equal(await operationalRateCapCheck(u.rate, 2, now), null);
  assert.equal(await operationalRateCapCheck(u.rate, 0, now), null, "no cap");
  assert.equal(await operationalRateCapCheck(u.other, 5, now), operationalRateCapRefusal(5));
  assert.match(operationalRateCapRefusal(3), /^OPERATIONAL_RATE_CAP_REACHED:3_APPROVED_COMMANDS_PER_ROLLING_24H$/);
  assert.doesNotMatch(operationalRateCapRefusal(3), /TRADES_PER_DAY|per day/i);
});

test("both caps measure differently at the day boundary", async () => {
  // 00:30 UTC: a trade closed at 23:50 yesterday is outside the governor's
  // trading day but inside the rolling 24h rate window.
  const now = new Date(Date.UTC(2026, 9, 25, 0, 30));
  const [acct] = await db.insert(paperAccountsTable).values({ userId: u.paper }).returning();
  const order = (openedAt: Date, closedAt: Date | null) => ({
    userId: u.paper, paperAccountId: acct!.id, symbol: "EURUSD", direction: "BUY", entryPrice: 1.1, stopLoss: 1.09,
    takeProfit: 1.12, status: closedAt ? "CLOSED_TP" : "OPEN", openedAt, closedAt, profitLoss: closedAt ? 2 : 0,
  });
  await db.insert(paperOrdersTable).values([
    order(new Date(Date.UTC(2026, 9, 24, 23, 40)), new Date(Date.UTC(2026, 9, 24, 23, 50))),
    order(new Date(Date.UTC(2026, 9, 25, 0, 5)), new Date(Date.UTC(2026, 9, 25, 0, 10))),
    order(new Date(Date.UTC(2026, 9, 25, 0, 20)), null),
  ]);
  const activity = await loadTradingActivity(u.paper, "PAPER", { now });
  assert.ok(activity);
  assert.equal(activity.tradesToday, 2, "closed today + opened today and still open; yesterday's close excluded");
  assert.equal(activity.source, `paper_orders:account:${acct!.id}`);
  await db.insert(tradeCommandAuditLogTable).values({
    userId: u.paper, mode: "SIMULATED", symbol: "EURUSD", side: "BUY", lotSize: 0.01, status: "APPROVED",
    requestedBy: "user", createdAt: new Date(Date.UTC(2026, 9, 24, 23, 40)),
  });
  assert.equal(await operationalRateCapCheck(u.paper, 1, now), operationalRateCapRefusal(1), "yesterday 23:40 still inside the rolling window");
  // No active paper account: nothing to count, not "unreadable".
  const none = await loadTradingActivity(u.noRow, "PAPER", { now });
  assert.equal(none?.tradesToday, 0);
});
