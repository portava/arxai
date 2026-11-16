// A heartbeat dated after the server's clock has no verifiable age.
//
// The defect this locks: the master-bridge detector (toEvidence) and the
// admin connection projection (maskConnection) computed
// Math.max(0, now - lastHeartbeat), so a future-dated heartbeat (server clock
// stepped back, or skew between instances) read as "0s", "live" and
// "master-live capable: yes" while the shared heartbeat policy says
// future-dated is unknown, never fresh, and classifyBridge on the same row
// says offline. The age is now null (unknown) and the detector refuses with
// MASTER_BRIDGE_HEARTBEAT_STALE. Only the connection list is stubbed.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/mt5/__qa__/futureHeartbeatAge.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { classifyHeartbeatAgeSeconds } from "../../brokerHub/freshness.js";
import { maskConnection } from "../../live/bridgeConnectionView.js";

let liveRows: Array<Record<string, unknown>> = [];
const connMod = await import("../../brokerHub/connections.js");
mock.module("../../brokerHub/connections.js", {
  namedExports: { ...connMod, listConnections: async () => liveRows },
});
const { detectCurrentConnectedBridge, evaluateBridgeAsMasterLive } = await import("../currentConnectedBridgeDetector.js");

function liveCapableRow(lastHeartbeat: Date) {
  return {
    id: 21, userId: 2, mode: "LIVE", accountType: "live", eaVersion: "1.50",
    brokerName: "Broker", serverName: "Broker-Live", accountNumber: "77001234",
    lastHeartbeat, tokenRevokedAt: null,
    capabilities: { eaInputs: { terminalConnected: true, algoTradingAllowed: true, readOnlyMode: false, enableLiveExecution: true } },
  };
}

beforeEach(() => { liveRows = []; });

test("detector: a heartbeat 30 s in the future is not fresh — MASTER_BRIDGE_HEARTBEAT_STALE, age unknown", async () => {
  liveRows = [liveCapableRow(new Date(Date.now() + 30_000))];
  const det = await detectCurrentConnectedBridge();
  assert.equal(det.ok, false);
  if (det.ok) return;
  assert.equal(det.primaryReason, "MASTER_BRIDGE_HEARTBEAT_STALE");
  assert.equal(det.latestHint?.heartbeatAgeSec, null);
  assert.equal(classifyHeartbeatAgeSeconds(det.latestHint?.heartbeatAgeSec), "unknown");
  assert.deepEqual(evaluateBridgeAsMasterLive(det.latestHint!), { ok: false, reason: "MASTER_BRIDGE_HEARTBEAT_STALE" });
});

test("detector: the same bridge with a 2 s old heartbeat still qualifies", async () => {
  liveRows = [liveCapableRow(new Date(Date.now() - 2_000))];
  const det = await detectCurrentConnectedBridge();
  assert.equal(det.ok, true);
  if (det.ok) assert.ok(det.bridge.heartbeatAgeSec != null && det.bridge.heartbeatAgeSec >= 1 && det.bridge.heartbeatAgeSec <= 3);
});

test("maskConnection: a future-dated heartbeat has no age (never 0s)", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");
  const base = {
    id: 1, userId: 1, connectionName: "c", status: "ACTIVE", accountType: "live", accountNumber: "1",
    brokerName: "b", serverName: "s", eaVersion: "1.50", tokenLast4: "abcd", tokenCreatedAt: null,
    tokenRevokedAt: null, tokenRotatedAt: null, tokenRotatedByAdminId: null, tokenRotationReason: null,
    previousTokenExpiresAt: null,
  };
  const future = maskConnection({ ...base, lastHeartbeat: new Date(now.getTime() + 30_000) }, now);
  assert.equal(future.heartbeatAgeSeconds, null);
  assert.equal(future.lastHeartbeatAt, "2026-10-28T12:00:30.000Z");
  const past = maskConnection({ ...base, lastHeartbeat: new Date(now.getTime() - 4_500) }, now);
  assert.equal(past.heartbeatAgeSeconds, 4);
});
