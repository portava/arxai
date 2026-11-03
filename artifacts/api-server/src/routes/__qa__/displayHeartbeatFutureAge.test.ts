// A heartbeat dated after the server's clock has no verifiable age, on the
// display sites too.
//
// The defect this locks: the gates were moved to the shared policy helper
// (brokerHub/freshness.heartbeatAgeSecondsFrom: future-dated → null), but six
// display sites still computed Math.max(0, now − lastHeartbeat), so a
// heartbeat dated after the server's clock (clock skew between instances, a
// clock stepped back) read "0s" — the freshest possible age — on the broker
// connection card, the read-only broker hub health, the admin cockpit
// overview and bridge table, the admin performance page, the /me/live
// refresh snapshot and the Live Shared readiness pinned bridge. They now use
// the shared helper: the age is null (unknown), and where the payload has a
// reason field it says the heartbeat is dated after the server's clock. The
// Live Shared test-connection preflight now passes the heartbeat time so gate
// 7 can say so too. Display only: no gate reads these fields.
//
// Offline: an in-memory db, a stub pg pool and a stubbed connection list.
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/displayHeartbeatFutureAge.test.ts
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const settingsRow = {
  id: 1, platformMode: "LIVE", simulatedEnabled: true, demoEnabled: true, liveEnabled: true,
  emergencyKillSwitch: false, killSwitchEngagedAt: null, killSwitchReason: null,
  liveBrokerExecutionArmed: false, liveBrokerExecutionArmedAt: null,
  liveBrokerExecutionArmedBy: null, liveBrokerExecutionArmedBridgeId: null,
  accountRoutingMode: "SHARED_MASTER_MT5", sharedLiveTradingEnabled: true,
  masterBridgeLiveEnabled: true, complianceReviewFlag: false, platformMasterBridgeConnectionId: 31,
};
const realDb = await import("@workspace/db");
const fake = createFakeDb({ global_trading_settings: [settingsRow] });
const pool = { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }), query: async () => ({ rows: [] }) };
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db, pool } });

let bridgeRow: Record<string, unknown> | null = null;
const connMod = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", {
  namedExports: {
    ...connMod,
    getConnection: async () => bridgeRow,
    getUserActiveConnection: async () => bridgeRow,
    listConnections: async () => (bridgeRow ? [bridgeRow] : []),
    listUserConnections: async () => (bridgeRow ? [bridgeRow] : []),
  },
});

// The test-connection preflight runs only when the detector finds a bridge.
let detected: unknown = { ok: false, primaryReason: "NO_BRIDGE", latestHint: null };
const realDetector = await import("../../lib/mt5/currentConnectedBridgeDetector.js");
mock.module("../../lib/mt5/currentConnectedBridgeDetector.js", {
  namedExports: { ...realDetector, detectCurrentConnectedBridge: async () => detected },
});
const realGate = await import("../../lib/mt5/masterLiveBridgeGate.js");
mock.module("../../lib/mt5/masterLiveBridgeGate.js", {
  namedExports: { ...realGate, loadAndEvaluateMasterLiveBridgeGate: async () => ({ decision: "BLOCKED", primaryReason: "NO_PINNED_BRIDGE" }) },
});

const { buildConnectionCard } = await import("../../lib/brokerHub/connectionCard.js");
const { Mt5ReadOnlyAdapter } = await import("../../lib/brokerHub/mt5ReadOnlyAdapter.js");
const sharedReadiness = (await import("../adminLiveSharedReadiness.js")).default;
const adminPerformance = (await import("../adminPerformance.js")).default;
const adminCockpit = (await import("../adminCockpit.js")).default;
const meLive = (await import("../meLive.js")).default;

const NOW = Date.now();
const future = () => new Date(Date.now() + 30_000);
const ago = (s: number) => new Date(Date.now() - s * 1000);
function bridge(lastHeartbeat: Date) {
  return {
    id: 31, userId: 3, mode: "LIVE", accountType: "live", eaVersion: "1.50", status: "connected",
    brokerName: "Broker", serverName: "Broker-Live", accountNumber: "77001234", connectionName: "Master",
    lastHeartbeat, tokenRevokedAt: null, readOnlyMode: false, clockDriftSeconds: null, clockDriftSeverity: "OK",
    capabilities: { eaInputs: { terminalConnected: true, algoTradingAllowed: true, readOnlyMode: false, enableLiveExecution: true } },
  };
}
async function getJson(router: Parameters<typeof withRouter>[0], path: string, init?: RequestInit) {
  let body: Record<string, any> = {};
  await withRouter(router, { id: 3, role: "OWNER" }, async (base) => {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 600));
    body = JSON.parse(text) as Record<string, any>;
  });
  return body;
}

test("connection card: a future-dated heartbeat has no age and the card says why; a past one is whole seconds", () => {
  const now = new Date(NOW);
  const base = {
    connectionName: "My MT5", status: "connected", accountNumber: "1234567", brokerName: "B", serverName: "S",
    accountCurrency: "USD", mode: "DEMO", accountType: "demo", eaVersion: "1.55", lastPositionsSnapshotAt: now,
    clockDriftSeconds: 0, readOnlyMode: false, allowOrderExecution: true, tokenRevokedAt: null, tokenRotatedAt: null,
    allocationStatus: "active", tradingFrozen: false, closeOnlyMode: false, allocatedFunds: 1000,
    approvedForMasterLive: true, masterLiveStatus: "approved", lastReconciledAt: now, now,
  } as const;
  const card = buildConnectionCard({ ...base, lastHeartbeat: new Date(NOW + 30_000) } as Parameters<typeof buildConnectionCard>[0]);
  assert.equal(card.heartbeatAgeSeconds, null, "was 0");
  assert.equal(card.state, "DISCONNECTED");
  assert.ok(card.unavailable.some((u) => /heartbeatAgeSeconds: the last heartbeat is dated after the server's clock/.test(u)));
  const past = buildConnectionCard({ ...base, lastHeartbeat: new Date(NOW - 4_500) } as Parameters<typeof buildConnectionCard>[0]);
  assert.equal(past.heartbeatAgeSeconds, 4);
  assert.ok(!past.unavailable.some((u) => u.startsWith("heartbeatAgeSeconds")));
  const never = buildConnectionCard({ ...base, lastHeartbeat: null } as Parameters<typeof buildConnectionCard>[0]);
  assert.equal(never.heartbeatAgeSeconds, null);
  assert.ok(!never.unavailable.some((u) => u.startsWith("heartbeatAgeSeconds")));
});

test("read-only broker hub health: a future-dated heartbeat is stale with no age, never 0 seconds", async () => {
  const conn = {
    id: 44, userId: 7, status: "connected", lastHeartbeat: new Date(NOW + 30_000), accountNumber: "1234567890",
    brokerName: "B", serverName: "S", accountCurrency: "USD", accountBalance: 1_000, accountEquity: 1_000, margin: 0,
    freeMargin: 1_000, accountSyncedAt: new Date(NOW), leverage: 100, mode: "LIVE", accountType: "real",
    capabilitiesReportedAt: new Date(NOW),
  };
  const reader = {
    readOwnedConnection: async () => conn,
    readOwnedInstruments: async () => [],
    readLatestOwnedCandle: async () => null,
    readOwnedCandles: async () => [],
  };
  const health = await new Mt5ReadOnlyAdapter(reader as never, 7, 44, () => NOW).readHealth();
  assert.equal(health.connected, false);
  assert.equal(health.status, "STALE");
  assert.equal(health.staleSeconds, null, "was 0");
  conn.lastHeartbeat = new Date(NOW - 5_000);
  assert.equal((await new Mt5ReadOnlyAdapter(reader as never, 7, 44, () => NOW).readHealth()).staleSeconds, 5);
});

test("Live Shared readiness: the pinned bridge's future-dated heartbeat has no age", async () => {
  bridgeRow = bridge(future());
  const body = await getJson(sharedReadiness, "/admin/live-shared/readiness");
  const pinned = body.liveAccount.pinnedBridge;
  assert.ok(pinned.lastHeartbeatAt);
  assert.equal(pinned.heartbeatAgeSeconds, null, "was 0");
  bridgeRow = bridge(ago(7));
  assert.equal((await getJson(sharedReadiness, "/admin/live-shared/readiness")).liveAccount.pinnedBridge.heartbeatAgeSeconds, 7);
});

test("Live Shared test-connection: gate 7 is given the heartbeat time, so an age it cannot verify is not 'No heartbeat received yet'", async () => {
  const hb = future();
  detected = {
    ok: true,
    bridge: {
      bridgeId: 31, userId: 3, mode: "LIVE", accountType: "live", eaVersion: "1.50", brokerName: "Broker",
      serverName: "Broker-Live", accountNumber: "77001234", lastHeartbeat: hb, heartbeatAgeSec: null,
      eaInputs: { terminalConnected: true, algoTradingAllowed: true, readOnlyMode: false, enableLiveExecution: true },
      tokenRevokedAt: null,
    },
  };
  try {
    const body = await getJson(sharedReadiness, "/admin/live-shared/test-connection", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const g7 = (body.preflight.gates as Array<{ key: string; passed: boolean; detail: string | null }>).find((g) => g.key === "EA_HEARTBEAT_STALE");
    assert.equal(g7?.passed, false);
    assert.match(g7?.detail ?? "", new RegExp(`dated ${hb.toISOString()}, after the server's clock`));
    assert.doesNotMatch(g7?.detail ?? "", /No heartbeat received yet/);
  } finally {
    detected = { ok: false, primaryReason: "NO_BRIDGE", latestHint: null };
  }
});

test("admin performance: a bridge with a future-dated heartbeat shows no age, never 0", async () => {
  bridgeRow = bridge(future());
  const body = await getJson(adminPerformance, "/admin/performance");
  const rows = JSON.stringify(body);
  assert.match(rows, /"heartbeatAgeSec":null/, rows.slice(0, 600));
  bridgeRow = bridge(ago(12));
  assert.match(JSON.stringify(await getJson(adminPerformance, "/admin/performance")), /"heartbeatAgeSec":12/);
});

test("admin cockpit: the overview and the bridge table show no age for a future-dated heartbeat", async () => {
  bridgeRow = bridge(future());
  const overview = await getJson(adminCockpit, "/admin/cockpit/overview");
  assert.equal(overview.bridge.heartbeatAgeSeconds, null, "was 0");
  assert.equal(overview.bridge.connected, false);
  const table = await getJson(adminCockpit, "/admin/cockpit/bridge");
  const row = (table.connections ?? table.rows ?? table.bridges ?? [])[0];
  assert.ok(row, JSON.stringify(table).slice(0, 400));
  assert.equal(row.heartbeatAgeSeconds, null, "was 0");
  bridgeRow = bridge(ago(3));
  assert.equal((await getJson(adminCockpit, "/admin/cockpit/overview")).bridge.heartbeatAgeSeconds, 3);
});

test("/me/live/refresh-snapshot: a future-dated heartbeat has no age and the reason says why", async () => {
  bridgeRow = bridge(future());
  const body = await getJson(meLive, "/me/live/refresh-snapshot");
  assert.equal(body.bridgeState.state, "stale");
  assert.equal(body.bridgeState.heartbeatAgeMs, null, "was 0");
  assert.equal(body.bridgeState.stateReason, "Bridge heartbeat is dated after the server's clock, so its age cannot be verified");
  bridgeRow = bridge(ago(20));
  const later = await getJson(meLive, "/me/live/refresh-snapshot");
  assert.equal(later.bridgeState.state, "delayed");
  assert.ok(later.bridgeState.heartbeatAgeMs >= 20_000 && later.bridgeState.heartbeatAgeMs < 25_000);
  bridgeRow = null;
});
