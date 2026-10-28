// Truth: POST /me/pending-order-draft used to stamp every draft
// pendingStatus "EA_UPGRADE_REQUIRED" with a fixed "the MT5 EA does not yet
// support pending-order execution" reason, without looking at the user's
// bridge. The draft is never sent to the broker either way; what the status
// and reason claim about the EA must come from the bridge it reports.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
const fake = createFakeDb({});
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });

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
mock.module("../mt5.js", { namedExports: { queueMt5CommandWithGate: async () => ({ ok: false }) } });
const router = (await import("../pendingOrderDraft.js")).default;

const conn = (capabilities: Record<string, unknown>, heartbeatAgeMs = 5_000) => ({
  id: 41, userId: 7, accountNumber: "55501234", accountType: "demo", eaVersion: "1.50",
  lastHeartbeat: new Date(Date.now() - heartbeatAgeMs), tokenRevokedAt: null, capabilities,
});

async function draft(orderType = "BUY_LIMIT") {
  let out: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/me/pending-order-draft`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderType, symbol: "EURUSD", lotSize: 0.01, requestedMode: "DEMO", currentPrice: 1.105,
        entryPrice: 1.1, stopTriggerPrice: orderType.endsWith("STOP_LIMIT") ? 1.11 : null,
        stopLimitPrice: orderType.endsWith("STOP_LIMIT") ? 1.1 : null, stopLoss: 1.09, takeProfit: 1.13,
      }),
    });
    out = { status: r.status, body: await r.json() as Record<string, unknown> };
  });
  return out;
}

const lastInsertStatus = () => fake.inserts.at(-1)?.values["pendingStatus"];

test("EA reporting pending-order support (legacy key): not 'EA upgrade required'; held by the paper-only lock", async () => {
  connectionsThrow = false;
  connection = conn({ pendingOrders: true });
  const { body } = await draft();
  assert.equal(body["ok"], true);
  assert.equal(body["pendingStatus"], "BLOCKED_BY_PAPER_LOCK");
  assert.equal(lastInsertStatus(), "BLOCKED_BY_PAPER_LOCK");
  assert.match(String(body["reason"]), /reports pending-order support/);
  assert.match(String(body["reason"]), /not been sent to your broker/);
  assert.doesNotMatch(String(body["reason"]), /does not yet support/);
});

test("EA reporting supportsPendingOrders (v1.50 vocabulary) counts as support", async () => {
  connection = conn({ v150: { normalized: { supportsPendingOrders: true } } });
  const { body } = await draft();
  assert.equal(body["pendingStatus"], "BLOCKED_BY_PAPER_LOCK");
});

test("EA that does not report pending-order support: EA_UPGRADE_REQUIRED, said as reported", async () => {
  connection = conn({ marketOrders: true });
  const { body } = await draft();
  assert.equal(body["pendingStatus"], "EA_UPGRADE_REQUIRED");
  assert.equal(lastInsertStatus(), "EA_UPGRADE_REQUIRED");
  assert.match(String(body["reason"]), /does not report pending-order support/);
});

test("stop-limit needs the stop-limit capability too", async () => {
  connection = conn({ pendingOrders: true });
  const { body } = await draft("BUY_STOP_LIMIT");
  assert.equal(body["pendingStatus"], "EA_UPGRADE_REQUIRED");
  assert.match(String(body["reason"]), /stop-limit/);
});

test("no online bridge: support could not be checked (BRIDGE_DISCONNECTED)", async () => {
  connection = conn({ pendingOrders: true }, 10 * 60_000);
  const { body } = await draft();
  assert.equal(body["pendingStatus"], "BRIDGE_DISCONNECTED");
  assert.match(String(body["reason"]), /could not be checked/);
});

test("bridge status unreadable: draft not saved, said plainly", async () => {
  connectionsThrow = true;
  const before = fake.inserts.length;
  const { status, body } = await draft();
  assert.equal(status, 500);
  assert.equal(body["ok"], false);
  assert.equal(fake.inserts.length, before);
  connectionsThrow = false;
});
