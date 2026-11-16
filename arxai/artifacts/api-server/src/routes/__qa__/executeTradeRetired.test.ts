// Owner decision 14 (2026-10-25): POST /execute-trade is retired.
//
// Mounts the real trades router on a real database and proves:
//   - an unauthenticated call is still refused before anything else (401);
//   - every authenticated call — a simulated-looking body, a body that asks
//     for LIVE, a body carrying a confirmation id — gets 410 with code
//     EXECUTE_TRADE_RETIRED and the governed paths to use instead;
//   - nothing is executed or recorded: no trades row, no paper order, no
//     claimed confirmation, and a LIVE request is never converted to PAPER;
//   - historical trades rows stay readable through GET /trades, owner-scoped.
//
// Run: pnpm --filter @workspace/api-server run test:execute-trade-retired

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { eq, inArray } from "drizzle-orm";
import {
  authUserSessionsTable,
  db,
  executionConfirmationsTable,
  paperOrdersTable,
  tradesTable,
  usersTable,
} from "@workspace/db";
import { attachAuthUser } from "../../lib/auth/middleware.js";
import { createUserSession } from "../../lib/auth/userSessions.js";
import tradesRouter from "../trades.js";

const EMAIL_A = "qa+execute-trade-retired-a@arx.test";
const EMAIL_B = "qa+execute-trade-retired-b@arx.test";

let server: Server;
let base = "";
const u = { a: 0, b: 0 };
const c = { a: "", b: "" };

async function deleteFixtures(): Promise<void> {
  const ids = (await db.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.email, [EMAIL_A, EMAIL_B]))).map((x) => x.id);
  if (!ids.length) return;
  await db.delete(executionConfirmationsTable).where(inArray(executionConfirmationsTable.userId, ids.map(String)));
  await db.delete(tradesTable).where(inArray(tradesTable.userId, ids));
  await db.delete(paperOrdersTable).where(inArray(paperOrdersTable.userId, ids));
  await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function seedUser(email: string): Promise<{ id: number; cookie: string }> {
  const [user] = await db.insert(usersTable).values({ email, name: email, role: "USER", isSystemUser: true })
    .returning({ id: usersTable.id });
  const { rawToken } = await createUserSession({ userId: user!.id });
  return { id: user!.id, cookie: `arx_user_session=${rawToken}` };
}

const BODY = {
  symbol: "EURUSD", direction: "BUY", lot: 0.1, entry: 1.1, sl: 1.09, tp: 1.12, strategy: "QA", confidence: 80,
};

function call(method: string, path: string, cookie: string | null, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function counts(userId: number) {
  const trades = await db.select({ id: tradesTable.id }).from(tradesTable).where(eq(tradesTable.userId, userId));
  const paper = await db.select({ id: paperOrdersTable.id }).from(paperOrdersTable).where(eq(paperOrdersTable.userId, userId));
  return { trades: trades.length, paper: paper.length };
}

before(async () => {
  await deleteFixtures();
  const a = await seedUser(EMAIL_A);
  const b = await seedUser(EMAIL_B);
  Object.assign(u, { a: a.id, b: b.id });
  Object.assign(c, { a: a.cookie, b: b.cookie });
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(attachAuthUser);
  app.use(tradesRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await deleteFixtures();
});

test("an unauthenticated call is refused before anything else", async () => {
  const res = await call("POST", "/execute-trade", null, BODY);
  assert.equal(res.status, 401);
});

test("every authenticated call gets 410 EXECUTE_TRADE_RETIRED with where to go instead, and nothing is recorded", async () => {
  const before = await counts(u.a);
  for (const body of [BODY, {}, { ...BODY, confidence: 5 }]) {
    const res = await call("POST", "/execute-trade", c.a, body);
    assert.equal(res.status, 410);
    const json = await res.json() as Record<string, unknown> & { instead: Record<string, { path: string }> };
    assert.equal(json["code"], "EXECUTE_TRADE_RETIRED");
    assert.equal(json["ok"], false);
    assert.equal(json["executed"], false);
    assert.equal(json["converted"], false);
    assert.equal(json.instead["PAPER"]!.path, "/api/paper/orders");
    assert.equal(json.instead["DEMO"]!.path, "/api/me/trade-actions");
    assert.ok(json.instead["LIVE"], "a LIVE caller is told where LIVE goes, not converted");
    assert.equal(json["tradeId"], undefined, "no trade id: nothing was booked");
  }
  assert.deepEqual(await counts(u.a), before, "no trades row and no paper order");
});

test("a LIVE request is refused, never converted into a simulated trade", async () => {
  const before = await counts(u.a);
  const res = await call("POST", "/execute-trade", c.a, { ...BODY, mode: "LIVE" });
  assert.equal(res.status, 410);
  const json = await res.json() as Record<string, unknown>;
  assert.equal(json["code"], "EXECUTE_TRADE_RETIRED");
  assert.equal(json["converted"], false);
  assert.deepEqual(await counts(u.a), before);
});

test("a confirmation id is not claimed", async () => {
  const [conf] = await db.insert(executionConfirmationsTable).values({
    userId: String(u.a), symbol: BODY.symbol, direction: BODY.direction, lotSize: BODY.lot,
    entryPrice: BODY.entry, stopLoss: BODY.sl, takeProfit: BODY.tp, estimatedRisk: 10, rewardToRisk: 2,
    marketCondition: "UNKNOWN", permissionStatus: "CLEAR", status: "CONFIRMED", userConfirmed: true,
    confirmedAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000),
  }).returning();
  const res = await call("POST", "/execute-trade", c.a, { ...BODY, confirmationId: conf!.id });
  assert.equal(res.status, 410);
  const [after] = await db.select().from(executionConfirmationsTable).where(eq(executionConfirmationsTable.id, conf!.id));
  assert.equal(after!.status, "CONFIRMED", "the retired endpoint never claims or rejects a confirmation");
});

test("historical trades rows stay readable, owner-scoped", async () => {
  await db.insert(tradesTable).values([
    { userId: u.a, symbol: "EURUSD", direction: "BUY", lot: 0.1, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, strategy: "QA", confidence: 80, status: "OPEN", mode: "LIVE" },
    { userId: u.b, symbol: "GBPUSD", direction: "SELL", lot: 0.1, entryPrice: 1.3, stopLoss: 1.31, takeProfit: 1.28, strategy: "QA", confidence: 80, status: "OPEN", mode: "DEMO" },
  ]);
  const res = await call("GET", "/trades", c.a);
  assert.equal(res.status, 200);
  const rows = await res.json() as Array<{ symbol: string; mode: string }>;
  assert.deepEqual(rows.map((r) => r.symbol), ["EURUSD"], "only the caller's own history");
  assert.equal(rows[0]!.mode, "LIVE", "the historical mode field (Safety Core state) is kept as written");
  const open = await call("GET", "/trades/open", c.b);
  assert.deepEqual((await open.json() as Array<{ symbol: string }>).map((r) => r.symbol), ["GBPUSD"]);
});
