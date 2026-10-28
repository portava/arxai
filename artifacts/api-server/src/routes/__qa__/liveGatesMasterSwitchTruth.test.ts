// Live Gates diagnostic — the master switch row reports the switch the
// dispatch gate reads (env flag AND operator arm), not the env flag alone.
//
// The defect this locks: with ARX_LIVE_BROKER_EXECUTION_ENABLED=true and no
// operator arm, the panel showed "Server master switch: pass" and "Broker
// placement layer: pass" although gate 1 refuses every live dispatch until an
// operator arms; when off it named BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED while
// the gate's refusal is LIVE_BROKER_EXECUTION_DISABLED.
//
// Only the DB handle, the settings read and the bridge readers are stubbed;
// the real router runs. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/liveGatesMasterSwitchTruth.test.ts

import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const prevEnv = process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED;
process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED = "true";
after(() => {
  if (prevEnv === undefined) delete process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED;
  else process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED = prevEnv;
});

const database = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...database, db: createFakeDb({}).db } });

let armed = false;
const switches = await import("../../lib/safety/platformSwitches.js");
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    ...switches,
    loadPlatformSettings: async () => ({
      switches: switches.switchesFromRows([{ ...switches.DEFAULT_SWITCH_ROW, liveBrokerExecutionArmed: armed }]),
      config: null,
    }),
  },
});
const detectorMod = await import("../../lib/mt5/currentConnectedBridgeDetector.js");
mock.module("../../lib/mt5/currentConnectedBridgeDetector.js", {
  namedExports: { ...detectorMod, detectCurrentConnectedBridge: async () => ({ ok: false, primaryReason: "NO_BRIDGE", latestHint: null }) },
});
const gateMod = await import("../../lib/mt5/masterLiveBridgeGate.js");
mock.module("../../lib/mt5/masterLiveBridgeGate.js", {
  namedExports: { ...gateMod, loadAndEvaluateMasterLiveBridgeGate: async () => ({ decision: "BLOCKED", primaryReason: "NO_PINNED_BRIDGE" }) },
});

const router = (await import("../adminLiveGatesDiagnostic.js")).default;

type Gate = { id: string; status: string; detail: string; rawCode?: string };
async function diagnostic(): Promise<{ gates: Gate[]; nextPlatformStep: string }> {
  let out: { gates: Gate[]; nextPlatformStep: string } | null = null;
  await withRouter(router, { id: 1, role: "OWNER" }, async (base) => {
    const res = await fetch(`${base}/admin/live-gates/diagnostic`);
    assert.equal(res.status, 200);
    out = (await res.json()) as { gates: Gate[]; nextPlatformStep: string };
  });
  return out!;
}
const gate = (d: { gates: Gate[] }, id: string): Gate => {
  const g = d.gates.find((x) => x.id === id);
  assert.ok(g, `row ${id} missing`);
  return g;
};

beforeEach(() => { armed = false; });

test("env on, operator not armed: master switch and placement layer are not 'pass' and name the gate's refusal", async () => {
  const d = await diagnostic();
  for (const id of ["server_master_switch", "broker_placement_layer"]) {
    const g = gate(d, id);
    assert.notEqual(g.status, "pass", `${id} must not pass while the operator arm is off`);
    assert.equal(g.rawCode, "LIVE_BROKER_EXECUTION_DISABLED");
  }
  assert.match(gate(d, "server_master_switch").detail, /env ARX_LIVE_BROKER_EXECUTION_ENABLED is set and no operator has armed/);
  // The next step is the arm, not setting an env flag that is already set.
  assert.doesNotMatch(d.nextPlatformStep, /Set ARX_LIVE_BROKER_EXECUTION_ENABLED=true/);
  assert.match(d.nextPlatformStep, /arm/);
});

test("env on and operator armed: the master switch passes", async () => {
  armed = true;
  const d = await diagnostic();
  assert.equal(gate(d, "server_master_switch").status, "pass");
  assert.equal(gate(d, "server_master_switch").rawCode, "LIVE_BROKER_EXECUTION_ENABLED");
  assert.equal(gate(d, "broker_placement_layer").status, "pass");
});
