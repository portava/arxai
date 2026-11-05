// Live Shared readiness — a failed readiness query must say so, never read as
// a measured state.
//
// The defect this locks: any query error inside GET /admin/live-shared/readiness
// returned 200 with emergencyKillSwitch:true, approvedCount 0, open exposure 0
// and serverMasterSwitchEnabled = the env flag alone, and the message claimed
// "live dispatch remains blocked" (this report gates nothing). The values stay
// fail-closed stand-ins for older consumers, but every section is now marked
// readable:false, the effective master switch is never reported on when the
// operator arm was not read, and the message says what is unknown.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/liveSharedReadinessDegraded.test.ts

import { after, mock, test } from "node:test";
import assert from "node:assert/strict";

const prevEnv = process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED;
process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED = "true";
after(() => {
  if (prevEnv === undefined) delete process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED;
  else process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED = prevEnv;
});

const switches = await import("../../lib/safety/platformSwitches.js");
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    ...switches,
    loadPlatformSettings: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:5432"); },
  },
});

const { withRouter } = await import("./_fakeRouteDb.js");
const router = (await import("../adminLiveSharedReadiness.js")).default;

test("a failed readiness query is marked unreadable, not a measured kill switch / 0 users / 0 exposure", async () => {
  await withRouter(router, { id: 3, role: "OWNER" }, async (base) => {
    const res = await fetch(`${base}/admin/live-shared/readiness`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.degraded, true);
    assert.equal(body.degradedReason, "READINESS_QUERY_FAILED");
    // Each stand-in section says it was not read.
    assert.equal(body.globalSwitches.readable, false);
    assert.equal(body.liveAccount.readable, false);
    assert.equal(body.approvedUsers.readable, false);
    assert.equal(body.openExposure.readable, false);
    // Env on, operator arm unread: the effective switch is not reported on.
    assert.equal(body.globalSwitches.serverMasterSwitchEnvOnly, true);
    assert.equal(body.globalSwitches.serverMasterSwitchEnabled, false);
    // The message names what is unknown and claims no dispatch effect.
    assert.match(body.message, /could not be loaded/);
    assert.match(body.message, /unknown, not zero/);
    assert.doesNotMatch(body.message, /remains blocked/);
  });
});
