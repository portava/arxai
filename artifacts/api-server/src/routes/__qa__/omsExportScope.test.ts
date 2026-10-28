// /oms/dashboard-summary and /export/* read the process-wide simulator book.
// The summary is shown to one person and must cover only their own rows; a
// TESTER export must carry only the caller's rows; operator exports carry
// everyone's, and every response says which.
//
// The real OMS book, routes and scoped summary run. Stubbed: the pre-trade
// risk governor (allows, so orders are created; LIVE_TESTER_INTENT orders
// park at PENDING_MT5_CONNECTION and never execute) and the audit writer.
// No DB, no broker, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/omsExportScope.test.ts

import { mock, test, before } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const realEnforce = await import("../../lib/riskGovernor/enforce.js");
mock.module("../../lib/riskGovernor/enforce.js", {
  namedExports: {
    ...realEnforce,
    enforcePreTradeRisk: async () => ({ allowed: true, blockedBy: [], primaryReason: null, auditEventId: null }),
  },
});
const realAudit = await import("../../lib/systemHealth/audit.js");
mock.module("../../lib/systemHealth/audit.js", {
  namedExports: { ...realAudit, auditEvent: async () => undefined, listAudit: async () => [] },
});

const { placeOrder } = await import("../../lib/oms.js");
const { default: express } = await import("express");
const { default: omsRouter } = await import("../oms.js");
const { default: exportsRouter } = await import("../exports.js");

async function get(path: string, authUser: { id: number; role: string }): Promise<{ status: number; headers: Headers; text: string }> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = authUser;
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(omsRouter);
  app.use(exportsRouter);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, headers: res.headers, text: await res.text() };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const A = { id: 11, role: "TESTER" };
const B = { id: 12, role: "TESTER" };
const ADMIN = { id: 1, role: "ADMIN" };

before(async () => {
  const intent = (n: number) => ({
    environment: "LIVE_TESTER_INTENT" as const, source: "MANUAL" as const, symbol: "EURUSD",
    direction: "BUY" as const, lotSize: 0.01, stopLoss: 1.0, takeProfit: 1.3, idempotencyKey: `qa-${n}`,
  });
  for (let i = 0; i < 2; i += 1) await placeOrder(intent(100 + i), { userId: A.id });
  for (let i = 0; i < 3; i += 1) await placeOrder(intent(200 + i), { userId: B.id });
});

test("/oms/dashboard-summary counts only the caller's own simulator book and says so", async () => {
  const r = await get("/oms/dashboard-summary", A);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text) as Record<string, unknown>;
  assert.equal(body["pendingMt5Intents"], 2, "another user's parked intents were counted");
  assert.equal(body["pendingOrders"], 2);
  assert.equal(body["scope"], "own_simulator_book");
  assert.match(String(body["scopeNote"]), /Your own simulator orders/);
});

test("a TESTER's orders export holds only their own rows, labeled", async () => {
  const r = await get("/export/orders.json", B);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text) as { scope: string; orders: Array<{ ownerUserId: number }>; totalOrders: number };
  assert.equal(body.scope, "own_simulator_book");
  assert.equal(body.orders.length, 3);
  assert.ok(body.orders.every((o) => o.ownerUserId === B.id), "another user's orders were exported");
  assert.equal(body.totalOrders, 3);
});

test("a TESTER's full-system report scopes the book and labels platform sections", async () => {
  const r = await get("/export/full-system-report", A);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text) as { scope: string; scopeNote: string; oms: { pendingMt5Intents: number } };
  assert.equal(body.scope, "own_simulator_book");
  assert.equal(body.oms.pendingMt5Intents, 2);
  assert.match(body.scopeNote, /recentAudit: Platform-wide/);
  // The audit log holds other users' actions: it is not "engine output, not
  // tied to one user's account".
  assert.match(body.scopeNote, /recentAudit: Platform-wide audit log: events from every user and service/);
  assert.doesNotMatch(body.scopeNote, /recentAudit: Platform-wide engine output/);
});

test("the audit export says it holds every user's events", async () => {
  const r = await get("/export/audit.json", A);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text) as { scope: string; scopeNote: string };
  assert.equal(body.scope, "platform");
  assert.match(body.scopeNote, /events from every user and service/);
});

test("a TESTER's trades CSV is scoped and says so in headers", async () => {
  const r = await get("/export/trades.csv", A);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-arx-export-scope"), "own_simulator_book");
  assert.equal(r.headers.get("x-arx-export-truncated"), "false");
});

test("an operator export carries every user's rows, labeled platform_all_users", async () => {
  const r = await get("/export/orders.json", ADMIN);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text) as { scope: string; orders: Array<{ ownerUserId: number }> };
  assert.equal(body.scope, "platform_all_users");
  assert.ok(body.orders.some((o) => o.ownerUserId === A.id) && body.orders.some((o) => o.ownerUserId === B.id));
});
