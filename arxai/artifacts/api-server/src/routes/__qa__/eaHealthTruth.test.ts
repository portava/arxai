// EA Health — every field says what was observed.
//
// Command pick age: the row's "command-poll age" was the age of the user's
// latest command pick (per user, any bridge). An EA polling every second
// showed days when nothing was queued. The value is now published as
// lastCommandPickedAgeSeconds (commandPollAgeSeconds stays as a deprecated
// alias) with the command's bound bridge.
//
// Unreported version / capabilities: with no EA version the row said "Update
// available: no", and with no capabilities report every feature (and
// self-update) read "unsupported". updateAvailable is now null (unknown) when
// the version is missing, with updateAvailableBasis, and capabilitiesReported
// / featuresNotReported / selfUpdateReported say what the EA never reported.
//
// Future-dated timestamps: ageSeconds clamped (now - ts) to 0, so a heartbeat
// dated after the server's clock read "Heartbeat age 0s" on an OFFLINE row.
// It is now null (unknown), as the shared heartbeat policy says.
//
// Only the DB handle, the connection list, the reconciliation feed and the
// update-gate safety preview are stubbed; the real router runs. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/eaHealthTruth.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter, type FakeRows } from "./_fakeRouteDb.js";

let rows: FakeRows = {};
const fake = { get db() { return createFakeDb(rows).db; } };
const database = await import("@workspace/db");
mock.module("@workspace/db", {
  namedExports: {
    ...database,
    db: new Proxy({}, { get: (_t, prop) => (fake.db as Record<string | symbol, unknown>)[prop] }),
  },
});

let connections: Array<Record<string, unknown>> = [];
const connMod = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", {
  namedExports: { ...connMod, listConnections: async () => connections },
});
const recon = await import("../../lib/reconciliation/detect.js");
mock.module("../../lib/reconciliation/detect.js", {
  namedExports: {
    ...recon,
    aggregateReconciliationIssues: async () => ({
      issues: [], computedAt: new Date().toISOString(), complete: true, uncheckedTypes: [], truncatedTypes: [],
    }),
  },
});
const gateInputs = await import("../../lib/mt5/eaUpdateGateInputs.js");
mock.module("../../lib/mt5/eaUpdateGateInputs.js", {
  namedExports: {
    ...gateInputs,
    previewEaUpdateGateSafety: async () => ({
      platformStopEngaged: false, hasOpenLiveTrade: false, hasPendingCommand: false,
      heartbeatStable: true, killSwitchEngaged: false, maintenanceMode: false,
    }),
  },
});

const router = (await import("../adminEaHealth.js")).default;

function connection(over: Record<string, unknown> = {}) {
  return {
    id: 11, userId: 5, connectionName: "Main", status: "ACTIVE", accountType: "live",
    accountNumber: "123456", brokerName: "B", serverName: "S", eaVersion: "1.27",
    tokenLast4: "abcd", tokenCreatedAt: null, tokenRevokedAt: null, tokenRotatedAt: null,
    tokenRotatedByAdminId: null, tokenRotationReason: null, previousTokenExpiresAt: null,
    lastHeartbeat: new Date(Date.now() - 2_000), capabilities: null, capabilitiesReportedAt: null,
    allowOrderExecution: false, liveLocked: true, clockDriftSeconds: null, clockDriftSeverity: null,
    ...over,
  };
}

async function health(): Promise<Record<string, any>> {
  let out: Record<string, any> = {};
  await withRouter(router, { id: 1, role: "ADMIN" }, async (base) => {
    const res = await fetch(`${base}/admin/ea/health`);
    assert.equal(res.status, 200);
    out = (await res.json()) as Record<string, any>;
  });
  return out;
}

beforeEach(() => { rows = {}; connections = []; });

test("the latest command's pick age is published as a pick age, with the bridge it was bound to", async () => {
  const threeDays = 3 * 24 * 3600;
  connections = [connection()];
  rows = {
    arx_live_commands: [{
      commandId: "c1", commandType: "PLACE_LIVE_MARKET_ORDER", status: "LIVE_FILLED", symbol: "EURUSD", side: "BUY",
      mt5Retcode: 10009, rejectionReason: null, bridgeConnectionId: 12,
      pickedByEaAt: new Date(Date.now() - threeDays * 1000), resultRecordedAt: null,
      createdAt: new Date(Date.now() - threeDays * 1000 - 5_000),
    }],
  };
  const body = await health();
  const row = body.rows[0];
  assert.ok(Math.abs(row.lastCommandPickedAgeSeconds - threeDays) <= 2, `got ${row.lastCommandPickedAgeSeconds}`);
  assert.equal(row.lastCommand.bridgeConnectionId, 12);
  // The deprecated name carries the same value (older clients), never a poll age.
  assert.equal(row.commandPollAgeSeconds, row.lastCommandPickedAgeSeconds);
});

test("a command not picked yet has no pick age", async () => {
  connections = [connection()];
  rows = {
    arx_live_commands: [{
      commandId: "c2", commandType: "PLACE_LIVE_MARKET_ORDER", status: "QUEUED", symbol: "EURUSD", side: "BUY",
      mt5Retcode: null, rejectionReason: null, bridgeConnectionId: null,
      pickedByEaAt: null, resultRecordedAt: null, createdAt: new Date(),
    }],
  };
  const row = (await health()).rows[0];
  assert.equal(row.lastCommandPickedAgeSeconds, null);
  assert.equal(row.lastCommand.bridgeConnectionId, null);
});

test("no EA version: update availability is unknown, not 'no'", async () => {
  connections = [connection({ eaVersion: null })];
  rows = { ea_update_manifest: [{ version: "1.30", channel: "stable", releaseStatus: "approved", sha256Checksum: "x", isUpdaterCapable: true, approvedAt: new Date() }] };
  const row = (await health()).rows[0];
  assert.equal(row.update.updateAvailable, null);
  assert.equal(row.update.updateAvailableBasis, "EA_VERSION_NOT_REPORTED");
});

test("no approved build: no update to take, and it says why", async () => {
  connections = [connection({ eaVersion: "1.27" })];
  const row = (await health()).rows[0];
  assert.equal(row.update.updateAvailable, false);
  assert.equal(row.update.updateAvailableBasis, "NO_APPROVED_MANIFEST");
});

test("a version both sides know is compared", async () => {
  connections = [connection({ eaVersion: "1.27" })];
  rows = { ea_update_manifest: [{ version: "1.30", channel: "stable", releaseStatus: "approved", sha256Checksum: "x", isUpdaterCapable: true, approvedAt: new Date() }] };
  const row = (await health()).rows[0];
  assert.equal(row.update.updateAvailable, true);
  assert.equal(row.update.updateAvailableBasis, "COMPARED");
});

test("capabilities never reported: marked not reported, not reported-unsupported", async () => {
  connections = [connection({ capabilities: null })];
  const row = (await health()).rows[0];
  assert.equal(row.capabilitiesReported, false);
  assert.ok(row.featuresNotReported.includes("supportsSelfUpdate"));
  assert.equal(row.featuresNotReported.length, Object.keys(row.featureSupport).length);
  assert.equal(row.selfUpdateReported, false);
  // The gate default is unchanged: an unreported feature is still never "SUPPORTED".
  assert.equal(row.featureSupport.supportsSelfUpdate, "UNSUPPORTED_ADMIN_WARNING");
});

test("a reported capability false is a report; a missing key is not", async () => {
  connections = [connection({ capabilities: { supportsSelfUpdate: false, supportsWatchdog: true } })];
  const row = (await health()).rows[0];
  assert.equal(row.capabilitiesReported, true);
  assert.equal(row.selfUpdateReported, true);
  assert.ok(!row.featuresNotReported.includes("supportsSelfUpdate"));
  assert.ok(!row.featuresNotReported.includes("supportsWatchdog"));
  assert.ok(row.featuresNotReported.includes("supportsRemoteConfig"));
});

test("a heartbeat dated in the future has no age (never 0s) and the row is not fresh", async () => {
  connections = [connection({ lastHeartbeat: new Date(Date.now() + 30_000) })];
  const row = (await health()).rows[0];
  assert.equal(row.heartbeatAgeSeconds, null);
  assert.equal(row.connection.heartbeatAgeSeconds, null);
  assert.notEqual(row.liveness, "fresh");
});
