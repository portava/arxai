// Live Shared readiness — a stop that could not be read is reported as such.
//
// The defect this locks: when the safety_core read throws, readSafetyCoreSwitch()
// fails closed (readable:false, engaged:true, "state unreadable"), but
// GET /admin/live-shared/readiness sent only platformStopReport(), which has no
// readable flag and no per-source detail. The activation page then said the
// safety-core kill switch "is engaged ... release it on the Emergency page",
// and when the platform emergency stop was engaged too, "state unreadable"
// appeared nowhere. The route now also sends platformStopReadable and
// platformStopDetail (additive, as GET /admin/trading/settings does).
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/liveSharedReadinessStopReadable.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const settingsRow = {
  id: 1, platformMode: "LIVE", simulatedEnabled: true, demoEnabled: true, liveEnabled: true,
  emergencyKillSwitch: false, killSwitchEngagedAt: null, killSwitchReason: null,
  liveBrokerExecutionArmed: false, liveBrokerExecutionArmedAt: null,
  liveBrokerExecutionArmedBy: null, liveBrokerExecutionArmedBridgeId: null,
  accountRoutingMode: "SHARED_MASTER_MT5", sharedLiveTradingEnabled: true,
  masterBridgeLiveEnabled: true, complianceReviewFlag: false, platformMasterBridgeConnectionId: null,
};
let safetyCoreThrows = true;
const rows: Record<string, unknown[]> = { global_trading_settings: [settingsRow] };
Object.defineProperty(rows, "safety_core", {
  enumerable: true,
  get() {
    if (safetyCoreThrows) throw new Error("relation \"safety_core\" does not exist");
    return [{ on: false, why: null, at: null, mode: "NORMAL", state: "OK" }];
  },
});

const realDb = await import("@workspace/db");
const fake = createFakeDb(rows);
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });

const realDetector = await import("../../lib/mt5/currentConnectedBridgeDetector.js");
mock.module("../../lib/mt5/currentConnectedBridgeDetector.js", {
  namedExports: { ...realDetector, detectCurrentConnectedBridge: async () => ({ ok: false, primaryReason: "NO_BRIDGE", latestHint: null }) },
});
const realGate = await import("../../lib/mt5/masterLiveBridgeGate.js");
mock.module("../../lib/mt5/masterLiveBridgeGate.js", {
  namedExports: { ...realGate, loadAndEvaluateMasterLiveBridgeGate: async () => ({ decision: "BLOCKED", primaryReason: "NO_PINNED_BRIDGE" }) },
});

const router = (await import("../adminLiveSharedReadiness.js")).default;

async function readiness(): Promise<Record<string, any>> {
  let body: Record<string, any> = {};
  await withRouter(router, { id: 3, role: "OWNER" }, async (base) => {
    const res = await fetch(`${base}/admin/live-shared/readiness`);
    assert.equal(res.status, 200);
    body = (await res.json()) as Record<string, any>;
  });
  return body;
}

test("an unreadable safety-core switch is reported unreadable, with its per-source detail", async () => {
  safetyCoreThrows = true;
  const body = await readiness();
  assert.notEqual(body.degraded, true);
  const g = body.globalSwitches;
  // Still fail-closed for every consumer that reads the combined fields.
  assert.equal(g.platformStopEngaged, true);
  assert.deepEqual(g.platformStopSources, ["safety_core_kill_switch"]);
  // New, additive: the stop was not read, and which source says so.
  assert.equal(g.platformStopReadable, false);
  assert.deepEqual(g.platformStopDetail, { safety_core_kill_switch: "state unreadable" });
  // The platform emergency stop itself was read and is released.
  assert.equal(g.emergencyKillSwitch, false);
});

test("readable stops report readable:true and no detail when released", async () => {
  safetyCoreThrows = false;
  const body = await readiness();
  const g = body.globalSwitches;
  assert.equal(g.platformStopEngaged, false);
  assert.equal(g.platformStopReadable, true);
  assert.deepEqual(g.platformStopDetail, {});
});
