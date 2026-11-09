// Truth: when GET /me/demo-bridge-debug cannot evaluate the dispatch gate
// (evaluatePerUserDispatchGate throws), the strict heartbeat and EA-version
// verdicts were never measured. They must be reported as unknown (null) with
// gateEvaluated:false — not as false, which the trade modal narrates as a
// measured "heartbeat stale" / "EA version below minimum" failure.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
const fake = createFakeDb({});
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });

let gateThrows = true;
const conn = () => ({
  id: 41, userId: 7, accountNumber: "55501234", accountType: "demo", eaVersion: "1.26",
  lastHeartbeat: new Date(Date.now() - 3_000), tokenRevokedAt: null, tokenLast4: "abcd",
  capabilities: { eaInputs: { readOnlyMode: false, enableDemoExecution: true, reportedAt: new Date().toISOString() } },
  hasBridgeToken: true,
});
const realConn = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", { namedExports: { ...realConn, listUserConnections: async () => [conn()] } });
const realGate = await import("../../lib/mt5/demoDispatchGate.js");
mock.module("../../lib/mt5/demoDispatchGate.js", { namedExports: {
  ...realGate,
  evaluatePerUserDispatchGate: async (...args: Parameters<typeof realGate.evaluatePerUserDispatchGate>) => {
    if (gateThrows) throw new Error("gate unavailable");
    return realGate.evaluatePerUserDispatchGate(...args);
  },
} });
const realQueue = await import("../../lib/mt5/demoCommandQueue.js");
mock.module("../../lib/mt5/demoCommandQueue.js", { namedExports: { ...realQueue, expireStaleSentCommands: async () => ({ expiredCommandIds: [] }) } });
const router = (await import("../meDemoBridgeDebug.js")).default;

test("gate evaluation failed: strict heartbeat / EA version / readiness are unknown, not false", async () => {
  gateThrows = true;
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/me/demo-bridge-debug`);
    assert.equal(r.status, 200);
    const { bridge } = await r.json() as { bridge: Record<string, unknown> };
    assert.equal(bridge["gateEvaluated"], false);
    assert.equal(bridge["heartbeatFreshStrict"], null, "a 3 s heartbeat was never judged stale");
    assert.equal(bridge["eaVersionAtLeast"], null, "EA 1.26 was never judged below the minimum");
    assert.equal(bridge["bridgeReady"], null, "readiness is unknown, not a measured 'not ready'");
    assert.equal(bridge["heartbeatAgeSeconds"], 3);
    // No blocker list was measured: an empty array would read as "nothing
    // blocking" and the trade modal would say demo execution is enabled.
    assert.equal(bridge["gateBlockers"], null, "no gate ran, so there is no blocker list");
  });
});
