// Truth: a draft's stored pendingStatus is the bridge answer from when it was
// saved (or last submitted); it is only rewritten on /submit. The drafts list
// must not let that snapshot pass for the bridge's state now: it also says
// what the submit gate would answer at the time of the read, and when it read
// it, without rewriting the stored row.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
let updates = 0;
const dbProxy = new Proxy({}, {
  get: (_t, p) => {
    if (p === "update") updates++;
    return (fake.db as Record<string | symbol, unknown>)[p];
  },
});
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

let connection: Record<string, unknown> | null = null;
let connectionsThrow = false;
const realConn = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", { namedExports: {
  ...realConn,
  listUserConnections: async () => {
    if (connectionsThrow) throw new Error("db down");
    return connection ? [connection] : [];
  },
} });
mock.module("../mt5.js", { namedExports: { queueMt5CommandWithGate: async () => ({ ok: false }) } });
const router = (await import("../pendingOrderDraft.js")).default;

const SAVED_AT = new Date("2026-10-28T09:00:00.000Z");
const draftRow = (over: Record<string, unknown> = {}) => ({
  id: 9, userId: 7, orderType: "BUY_LIMIT", symbol: "EURUSD", side: "BUY", lotSize: 0.01,
  requestedPrice: 1.1, stopTriggerPrice: null, stopLimitPrice: null, stopLoss: 1.09, takeProfit: 1.13,
  expiration: null, pendingStatus: "BRIDGE_DISCONNECTED", status: "awaiting_confirmation", reason: null,
  createdAt: SAVED_AT, updatedAt: SAVED_AT, ...over,
});

async function list(): Promise<Record<string, any>> {
  let body: Record<string, any> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/me/pending-order-drafts`);
    body = await r.json() as Record<string, any>;
    assert.equal(r.status, 200, JSON.stringify(body));
  });
  return body;
}

test("saved while disconnected, EA back online: the list says the bridge's answer now, as of when", async () => {
  connectionsThrow = false;
  connection = { id: 41, userId: 7, eaVersion: "1.50", lastHeartbeat: new Date(Date.now() - 5_000), capabilities: { pendingOrders: true } };
  fake = createFakeDb({ trade_action_requests: [draftRow()] });
  const before = Date.now();
  const body = await list();
  const d = body.drafts[0];
  // The stored snapshot is still reported as what it is…
  assert.equal(d.pendingStatus, "BRIDGE_DISCONNECTED");
  assert.equal(d.createdAt, SAVED_AT.toISOString());
  // …next to the answer the submit gate gives now.
  assert.equal(d.currentPendingStatus, "READ_ONLY");
  assert.match(String(d.currentPendingReason), /reports pending-order support/);
  assert.ok(Date.parse(body.bridgeCheckedAt) >= before - 1000, String(body.bridgeCheckedAt));
  assert.equal(updates, 0, "the list never rewrites a stored draft");
});

test("bridge unreadable: the list still loads and says the current answer could not be checked", async () => {
  connectionsThrow = true;
  fake = createFakeDb({ trade_action_requests: [draftRow()] });
  const body = await list();
  const d = body.drafts[0];
  assert.equal(d.pendingStatus, "BRIDGE_DISCONNECTED");
  assert.equal(d.currentPendingStatus, null);
  assert.equal(body.bridgeCheckedAt, null);
  assert.match(String(body.bridgeCheckError), /could not be read/);
  connectionsThrow = false;
});

test("a placed or cancelled draft gets no 'would submit now' answer", async () => {
  connection = { id: 41, userId: 7, eaVersion: "1.50", lastHeartbeat: new Date(Date.now() - 5_000), capabilities: { pendingOrders: true } };
  fake = createFakeDb({ trade_action_requests: [draftRow({ pendingStatus: "PLACED", status: "queued" })] });
  const body = await list();
  assert.equal(body.drafts[0].currentPendingStatus, null);
});
