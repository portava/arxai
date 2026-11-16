// Smart Alert rule engine — every alert about a trader's own state goes to
// that trader only, on a real database.
//
// An alert with no userId is shown to every user, so a rule over trader rows
// must attribute the alert to the row's owner and must skip ownerless legacy
// rows. Proves it for risk locks and the daily-loss budget (the two rules that
// used to broadcast), and that the budget uses the trader's own limit; and that
// the near-stop-loss sweep reads only ALERT_ELIGIBLE DEMO rows (owner decision
// 11): owned, status OPEN, closed_at unset. Ownerless and closed rows raise no
// alert, and each alert goes to the row's owner only.
//
// Run: pnpm --filter @workspace/api-server run test:alert-rule-ownership

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { inArray, like } from "drizzle-orm";
import { alertsTable, db, livePositionsTable, performanceDailyTable, riskLocksTable, userRiskSettingsTable, usersTable } from "@workspace/db";
import { evaluateAndGenerate } from "../ruleEngine.js";

const EMAILS = ["qa+alert-owner-a@arx.test", "qa+alert-owner-b@arx.test"];
const REASON = "qa-alert-ownership";
let a = 0;
let b = 0;
const lockIds: number[] = [];
const dayIds: number[] = [];
const posIds: { own: number; ownerless: number; stamped: number; closed: number } = { own: 0, ownerless: 0, stamped: 0, closed: 0 };
const POS_TICKET = `qa-alert-pos-${process.pid}`;

async function cleanup(): Promise<void> {
  if (lockIds.length) {
    await db.delete(alertsTable).where(inArray(alertsTable.dedupeKey, lockIds.map((id) => `risk-lock:${id}`)));
    await db.delete(riskLocksTable).where(inArray(riskLocksTable.id, lockIds));
  }
  if (dayIds.length) await db.delete(performanceDailyTable).where(inArray(performanceDailyTable.id, dayIds));
  const pos = Object.values(posIds).filter(Boolean);
  if (pos.length) {
    await db.delete(alertsTable).where(inArray(alertsTable.relatedPositionId, pos));
    await db.delete(livePositionsTable).where(inArray(livePositionsTable.id, pos));
  }
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.email, EMAILS));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.delete(alertsTable).where(inArray(alertsTable.userId, ids));
    await db.delete(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
}

before(async () => {
  await cleanup();
  const users = await db.insert(usersTable).values(EMAILS.map((email, i) => ({
    email, name: `QA alert owner ${i}`, role: "USER", isSystemUser: true,
  }))).returning({ id: usersTable.id });
  [a, b] = [users[0]!.id, users[1]!.id];

  const locks = await db.insert(riskLocksTable).values([
    { userId: a, lockType: "DAILY_LOSS", reason: REASON },
    { userId: null, lockType: "DAILY_LOSS", reason: REASON },
  ]).returning({ id: riskLocksTable.id });
  lockIds.push(...locks.map((l) => l.id));

  // B lost 60 on a 1000 balance: 6%, past a 5% personal limit.
  await db.insert(userRiskSettingsTable).values({ userId: b, maxDailyLossPercent: 5 });
  const today = new Date().toISOString().slice(0, 10);
  const days = await db.insert(performanceDailyTable).values([
    { userId: b, date: today, pnl: -60, endBalance: 1000 },
    { userId: null, date: today, pnl: -900, endBalance: 1000 },
  ]).returning({ id: performanceDailyTable.id });
  dayIds.push(...days.map((d) => d.id));

  // DEMO rows 10% of the stop distance from the stop (inside the 25% band).
  const near = { symbol: "EURUSD", direction: "BUY", lotSize: 0.1, entryPrice: 1.1, stopLoss: 1.09, currentPrice: 1.091 };
  const pos = await db.insert(livePositionsTable).values([
    { ...near, userId: a, brokerPositionId: `${POS_TICKET}-own`, status: "OPEN" },
    { ...near, userId: null, brokerPositionId: `${POS_TICKET}-ownerless`, status: "OPEN" },
    { ...near, userId: a, brokerPositionId: `${POS_TICKET}-stamped`, status: "OPEN", closedAt: new Date() },
    { ...near, userId: b, brokerPositionId: `${POS_TICKET}-closed`, status: "CLOSED", closedAt: new Date() },
  ]).returning({ id: livePositionsTable.id });
  [posIds.own, posIds.ownerless, posIds.stamped, posIds.closed] = pos.map((p) => p.id) as [number, number, number, number];

  await evaluateAndGenerate();
});
after(cleanup);

test("a risk lock alerts its owner only; an ownerless lock is never broadcast", async () => {
  const rows = await db.select().from(alertsTable).where(inArray(alertsTable.dedupeKey, lockIds.map((id) => `risk-lock:${id}`)));
  const own = rows.filter((r) => r.dedupeKey === `risk-lock:${lockIds[0]}`);
  assert.equal(own.length, 1);
  assert.equal(own[0]!.userId, a);
  assert.equal(rows.filter((r) => r.dedupeKey === `risk-lock:${lockIds[1]}`).length, 0, "legacy lock raised no alert");
});

test("the daily-loss budget alerts the trader who lost, against their own limit", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.select().from(alertsTable).where(like(alertsTable.dedupeKey, `daily-loss:${today}:%`));
  const mine = rows.filter((r) => r.userId === b);
  assert.equal(mine.length, 1, "B is alerted");
  assert.equal(mine[0]!.priority, "CRITICAL", "6% loss on a 5% limit is past the budget");
  assert.equal(rows.filter((r) => r.userId == null && r.createdAt != null && r.createdAt > new Date(Date.now() - 60_000)).length, 0,
    "no ownerless daily-loss alert was broadcast");
  assert.equal(rows.filter((r) => r.userId === a).length, 0, "A is not told about B's losses");
});

test("near-stop-loss alerts only ALERT_ELIGIBLE DEMO rows, to their owner; ownerless and closed rows raise nothing", async () => {
  const rows = await db.select().from(alertsTable).where(inArray(alertsTable.relatedPositionId, Object.values(posIds)));
  const own = rows.filter((r) => r.relatedPositionId === posIds.own);
  assert.equal(own.length, 1, "the owned open row near its stop is alerted");
  assert.equal(own[0]!.userId, a, "attributed to the row's owner");
  assert.equal(own[0]!.type, "POSITION_WARNING");
  assert.equal(rows.filter((r) => r.relatedPositionId === posIds.ownerless).length, 0, "ownerless row is never alerted (would broadcast)");
  assert.equal(rows.filter((r) => r.relatedPositionId === posIds.stamped).length, 0, "row with a stamped closed_at is not alerted");
  assert.equal(rows.filter((r) => r.relatedPositionId === posIds.closed).length, 0, "closed row is not alerted");
  assert.equal(rows.filter((r) => r.userId === b || r.userId == null).length, 0, "B and the broadcast audience hear nothing about A's position");
});
