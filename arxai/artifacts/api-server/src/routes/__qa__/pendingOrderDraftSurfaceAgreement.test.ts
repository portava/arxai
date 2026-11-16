// Truth: the same bridge state must be described the same way on every
// pending-order surface. POST /me/pending-order-draft had its own resolver
// that skipped the READ_ONLY / LIVE_LOCKED steps and read the v1.50
// capability list the submit gate ignores, so a fresh draft said
// BLOCKED_BY_PAPER_LOCK while GET /me/bridge-capabilities and
// POST /me/pending-order-draft/:id/submit said READ_ONLY (or
// BRIDGE_UNSUPPORTED) for the same connection.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

let connection: Record<string, unknown> | null = null;
const realConn = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", { namedExports: {
  ...realConn,
  listUserConnections: async () => (connection ? [connection] : []),
} });
const realLimits = await import("../../lib/riskGovernor/limitSettings.js");
mock.module("../../lib/riskGovernor/limitSettings.js", { namedExports: {
  ...realLimits,
  loadEffectiveLimits: async () => ({ discipline: { minRewardRiskRatio: null } }),
} });
const realRg = await import("../../lib/tradeAction/riskGovernorEnforcement.js");
mock.module("../../lib/tradeAction/riskGovernorEnforcement.js", { namedExports: {
  ...realRg,
  enforceRiskGovernor: async () => ({ passed: true, checkId: "rg_preview" }),
} });
const realRouting = await import("../../lib/adminTrading/routingResolver.js");
mock.module("../../lib/adminTrading/routingResolver.js", { namedExports: {
  ...realRouting,
  resolveRouting: async () => ({ ok: true, effectiveRoutingMode: "USER_OWNED_MT5", connectionId: 41, virtualAccountId: null, sharedMasterAccountId: null, blockReason: null }),
} });
let queued = 0;
mock.module("../mt5.js", { namedExports: { queueMt5CommandWithGate: async () => { queued++; return { ok: false }; } } });
const router = (await import("../pendingOrderDraft.js")).default;

const conn = (capabilities: Record<string, unknown>) => ({
  id: 41, userId: 7, accountNumber: "55501234", accountType: "demo", eaVersion: "1.50",
  lastHeartbeat: new Date(Date.now() - 5_000), tokenRevokedAt: null, capabilities,
});

type Json = Record<string, unknown>;
async function call(method: string, path: string, body?: Json): Promise<Json> {
  let out: Json = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    out = await r.json() as Json;
    assert.equal(r.status, 200, JSON.stringify(out));
  });
  return out;
}

const DRAFT = {
  orderType: "BUY_LIMIT", symbol: "EURUSD", lotSize: 0.01, requestedMode: "DEMO", currentPrice: 1.105,
  entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.13,
};

async function threeSurfaces(capabilities: Record<string, unknown>) {
  connection = conn(capabilities);
  fake = createFakeDb({});
  const created = await call("POST", "/me/pending-order-draft", DRAFT);
  const caps = await call("GET", "/me/bridge-capabilities");
  fake = createFakeDb({
    trade_action_requests: [{
      id: Number(created["draftId"]), userId: 7, orderType: "BUY_LIMIT", symbol: "EURUSD", side: "BUY",
      lotSize: 0.01, pendingStatus: created["pendingStatus"], status: "awaiting_confirmation",
    }],
  });
  const submitted = await call("POST", `/me/pending-order-draft/${created["draftId"]}/submit`, {});
  return { created, caps, submitted };
}

test("EA reports pendingOrders: create, capabilities and submit give one status and one reason", async () => {
  const { created, caps, submitted } = await threeSurfaces({ pendingOrders: true });
  assert.equal(created["pendingStatus"], submitted["pendingStatus"]);
  assert.equal(caps["currentSubmitStatus"], submitted["pendingStatus"]);
  assert.equal(created["pendingStatus"], "READ_ONLY");
  // One reason, said the same way (the draft adds only the "saved" preface).
  assert.equal(caps["currentSubmitExplanation"], submitted["reason"]);
  assert.ok(String(created["reason"]).endsWith(String(submitted["reason"])), String(created["reason"]));
  assert.match(String(submitted["reason"]), /reports pending-order support/);
  // The connection is not read-only; ARX's pending-order path is.
  assert.doesNotMatch(String(submitted["reason"]), /Your MT5 connection is in read-only mode/);
  assert.equal(created["executable"], false);
  assert.equal(submitted["executable"], false);
  assert.equal(queued, 0);
});

test("EA reports support only in the v1.50 list: every surface says the gate does not read it", async () => {
  const { created, caps, submitted } = await threeSurfaces({ v150: { normalized: { supportsPendingOrders: true } } });
  assert.equal(created["pendingStatus"], submitted["pendingStatus"]);
  assert.equal(caps["currentSubmitStatus"], submitted["pendingStatus"]);
  assert.equal(submitted["pendingStatus"], "BRIDGE_UNSUPPORTED");
  assert.equal(caps["currentSubmitExplanation"], submitted["reason"]);
  // It is not true that the EA reports no support.
  assert.doesNotMatch(String(submitted["reason"]), /does not report support for pending-order execution/);
  assert.match(String(submitted["reason"]), /v1\.50/);
  assert.match(String(submitted["reason"]), /pendingOrders/);
  assert.equal(queued, 0);
});

test("stop-limit without the stop-limit capability: the reason names stop-limit on every surface", async () => {
  connection = conn({ pendingOrders: true });
  fake = createFakeDb({});
  const created = await call("POST", "/me/pending-order-draft", {
    ...DRAFT, orderType: "BUY_STOP_LIMIT", stopTriggerPrice: 1.11, stopLimitPrice: 1.1,
  });
  fake = createFakeDb({
    trade_action_requests: [{
      id: Number(created["draftId"]), userId: 7, orderType: "BUY_STOP_LIMIT", symbol: "EURUSD", side: "BUY",
      lotSize: 0.01, pendingStatus: created["pendingStatus"], status: "awaiting_confirmation",
    }],
  });
  const submitted = await call("POST", `/me/pending-order-draft/${created["draftId"]}/submit`, {});
  assert.equal(created["pendingStatus"], "BRIDGE_UNSUPPORTED");
  assert.equal(submitted["pendingStatus"], "BRIDGE_UNSUPPORTED");
  assert.match(String(submitted["reason"]), /stop-limit/);
  assert.ok(String(created["reason"]).endsWith(String(submitted["reason"])));
});
