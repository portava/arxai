// GET /api/mt5/state — the platform mt5_state row (account, balances,
// liveAllowed, positions) is whichever EA terminal heartbeated last. It has
// no owner column, so it must never be served as the caller's own account,
// and never to an anonymous caller. Operators see it marked scope
// "platform"; everyone else sees only their own bridge connection (or the
// shared-master bridge they route through), with positions marked not read.
//
// Only the database handle, the connection lookup and the shared-bridge read
// are stubbed; the real router runs. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/mt5StateScope.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const PLATFORM_ROW = {
  id: 1, userId: null, account: "99887766", broker: "Other Tenant Broker", server: "OT-Live",
  balance: 250_000, equity: 251_000, margin: 1_000, freeMargin: 250_000, marginLevel: 25_100,
  currency: "USD", liveAllowed: true,
  positions: [{ ticket: 555, symbol: "XAUUSD", type: "BUY", volume: 5, profit: 900 }],
  lastHeartbeatAt: new Date(Date.now() - 2_000), lastSyncAt: new Date(Date.now() - 2_000),
};

const database = await import("@workspace/db");
function chain(rows: unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return q;
}
mock.module("@workspace/db", {
  namedExports: {
    ...database,
    db: {
      select: () => chain([PLATFORM_ROW]),
      insert: () => { throw new Error("GET /mt5/state must not write"); },
    },
  },
});

let connection: Record<string, unknown> | null = null;
const realConnections = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", {
  namedExports: { ...realConnections, getUserActiveConnection: async () => connection },
});

let shared: { route: string; sharedMasterBridge: Record<string, unknown> | null } = { route: "NONE", sharedMasterBridge: null };
const realShared = await import("../mt5SharedBridgeStatus.js");
mock.module("../mt5SharedBridgeStatus.js", {
  namedExports: { ...realShared, readSharedMasterBridgeForUser: async () => shared },
});

const { default: express } = await import("express");
const { default: router } = await import("../mt5.js");

async function get(authUser: { id: number; role: string } | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use((req, _res, next) => {
    if (authUser) (req as unknown as { authUser: unknown }).authUser = authUser;
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/mt5/state`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function assertNoPlatformLeak(body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  assert.ok(!text.includes("99887766"), "platform account number leaked");
  assert.ok(!text.includes("Other Tenant Broker"), "platform broker leaked");
  assert.ok(!text.includes("250000"), "platform balance leaked");
  assert.deepEqual(body["positions"], []);
  assert.equal(body["positionsMeasured"], false);
  assert.equal(body["liveAllowed"], false);
}

test("an anonymous caller is refused", async () => {
  const r = await get(null);
  assert.equal(r.status, 401);
  assert.ok(!JSON.stringify(r.body).includes("99887766"));
});

test("a trader with no bridge sees scope none, not another tenant's account", async () => {
  connection = null;
  shared = { route: "NONE", sharedMasterBridge: null };
  const r = await get({ id: 31, role: "USER" });
  assert.equal(r.status, 200);
  assert.equal(r.body["scope"], "none");
  assert.equal(r.body["connected"], false);
  assert.equal(r.body["account"], null);
  assertNoPlatformLeak(r.body);
});

test("a trader with their own connection sees only that connection", async () => {
  connection = {
    id: 5, userId: 31, mode: "DEMO", lastHeartbeat: new Date(Date.now() - 2_000), accountSyncedAt: new Date(Date.now() - 4_000),
    accountNumber: "1234567", brokerName: "QA Broker", serverName: "QA-Demo", accountBalance: 10_000,
    accountEquity: 10_050, margin: 40, freeMargin: 9_960, accountCurrency: "USD",
  };
  shared = { route: "NONE", sharedMasterBridge: null };
  const r = await get({ id: 31, role: "USER" });
  assert.equal(r.status, 200);
  assert.equal(r.body["scope"], "own_connection");
  assert.equal(r.body["account"], "1234567");
  assert.equal(r.body["balance"], 10_000);
  assert.equal(r.body["connected"], true);
  assertNoPlatformLeak(r.body);
});

test("a shared-master trader sees the shared bridge's reachability, not its account", async () => {
  connection = null;
  shared = {
    route: "SHARED_MASTER",
    sharedMasterBridge: { availability: "HEALTHY", connected: true, message: "Shared bridge healthy.", lastSnapshotAt: new Date(Date.now() - 3_000).toISOString(), snapshotAgeSeconds: 3, source: "shared_master_bridge_pool" },
  };
  const r = await get({ id: 32, role: "INVESTOR" });
  assert.equal(r.status, 200);
  assert.equal(r.body["scope"], "shared_master_bridge");
  assert.equal(r.body["connected"], true);
  assert.equal(r.body["account"], null);
  assertNoPlatformLeak(r.body);
});

test("an operator sees the platform row, marked as the install-wide feed", async () => {
  const r = await get({ id: 1, role: "ADMIN" });
  assert.equal(r.status, 200);
  assert.equal(r.body["scope"], "platform");
  assert.match(String(r.body["scopeNote"]), /not tied to any one user/);
  assert.equal(r.body["account"], "99887766");
  assert.equal((r.body["positions"] as unknown[]).length, 1);
  assert.equal(r.body["liveAllowed"], true);
});
