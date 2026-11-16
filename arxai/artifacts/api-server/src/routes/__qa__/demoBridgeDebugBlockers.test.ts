// Truth: GET /me/demo-bridge-debug must not report probe artifacts as the
// user's blockers. The endpoint evaluates the dispatch gate with
// userConfirmed:false (no order is being confirmed), so USER_NOT_CONFIRMED is
// always present and says nothing about the user; WRONG_EXECUTION_MODE means
// "demo execution not armed", which is reported as its own `armed` field.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
const fake = createFakeDb({});
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });

let heartbeatAgeSec = 5;
let armed = false;
const conn = () => ({
  id: 41, userId: 7, accountNumber: "55501234", accountType: "demo", eaVersion: "1.27",
  lastHeartbeat: new Date(Date.now() - heartbeatAgeSec * 1000), tokenRevokedAt: null, tokenLast4: "abcd",
  capabilities: { eaInputs: { readOnlyMode: false, enableDemoExecution: true, reportedAt: new Date().toISOString() } },
  hasBridgeToken: true,
});
const realConn = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", { namedExports: { ...realConn, listUserConnections: async () => [conn()] } });
const realVerify = await import("../../lib/mt5/demoVerificationGate.js");
mock.module("../../lib/mt5/demoVerificationGate.js", { namedExports: {
  ...realVerify, runDemoVerificationGate: async () => ({ status: "VERIFIED_DEMO", reasons: [], blockers: [] }),
} });
const realArm = await import("../../lib/mt5/demoArmingService.js");
mock.module("../../lib/mt5/demoArmingService.js", { namedExports: { ...realArm, isArmedForDemo: async () => armed } });
const realQueue = await import("../../lib/mt5/demoCommandQueue.js");
mock.module("../../lib/mt5/demoCommandQueue.js", { namedExports: { ...realQueue, expireStaleSentCommands: async () => ({ expiredCommandIds: [] }) } });
const router = (await import("../meDemoBridgeDebug.js")).default;

async function debug(): Promise<{ bridge: Record<string, unknown> }> {
  let body = { bridge: {} as Record<string, unknown> };
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/me/demo-bridge-debug`);
    assert.equal(r.status, 200);
    body = await r.json() as { bridge: Record<string, unknown> };
  });
  return body;
}

test("fresh demo bridge, unarmed user: no USER_NOT_CONFIRMED; armed=false reported on its own", async () => {
  heartbeatAgeSec = 5; armed = false;
  const { bridge } = await debug();
  const gate = bridge["gateBlockers"] as string[];
  assert.ok(!gate.includes("USER_NOT_CONFIRMED"), JSON.stringify(gate));
  assert.ok(!gate.includes("WRONG_EXECUTION_MODE"), JSON.stringify(gate));
  assert.ok(gate.includes("DEMO_EXECUTION_NOT_ARMED"), JSON.stringify(gate));
  assert.equal(bridge["armed"], false);
  assert.equal(bridge["verifiedDemo"], true);
});

test("armed user with a stale (20 s) heartbeat: only real blockers are listed", async () => {
  heartbeatAgeSec = 20; armed = true;
  const { bridge } = await debug();
  const gate = bridge["gateBlockers"] as string[];
  assert.ok(!gate.includes("USER_NOT_CONFIRMED"), JSON.stringify(gate));
  assert.ok(!gate.includes("DEMO_EXECUTION_NOT_ARMED"), JSON.stringify(gate));
  assert.ok(gate.includes("HEARTBEAT_STALE"), JSON.stringify(gate));
  assert.equal(bridge["armed"], true);
  assert.equal(bridge["bridgeReady"], false);
});
