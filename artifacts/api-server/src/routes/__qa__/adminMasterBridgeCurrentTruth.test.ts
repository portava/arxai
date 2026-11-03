// GET /api/admin/master-bridge/current — the Master Bridge page states whether
// shared live and master-bridge live are on. It used to hard-code "Live trading
// via master bridge is disabled … the shared LIVE flag remains OFF" whatever
// the stored settings said, because this response carried no settings at all.
// The response now carries the stored master-live settings, read from the one
// switch authority, and unreadable settings are null (never "off").
//
// The real router runs; the detector and the settings read are module mocks.
// No database, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/routes/__qa__/adminMasterBridgeCurrentTruth.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { withRouter } from "./_fakeRouteDb.js";
import type { PlatformSwitches, GlobalTradingConfig, PlatformStop } from "../../lib/safety/platformSwitches.js";

type Settings = { switches: PlatformSwitches; config: GlobalTradingConfig | null };
let settings: Settings;
let stop: PlatformStop;

const realSwitches = await import("../../lib/safety/platformSwitches.js");
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    ...realSwitches,
    loadPlatformSettings: async () => settings,
    platformStopWith: async () => stop,
  },
});
const realDetector = await import("../../lib/mt5/currentConnectedBridgeDetector.js");
mock.module("../../lib/mt5/currentConnectedBridgeDetector.js", {
  namedExports: {
    ...realDetector,
    detectCurrentConnectedBridge: async () => ({ ok: false, primaryReason: "NO_BRIDGE_REGISTERED", latestHint: null }),
  },
});
const router = (await import("../adminMasterBridge.js")).default;

function switchesWith(over: Partial<PlatformSwitches> = {}): PlatformSwitches {
  return {
    ...realSwitches.switchesFromRows([{ ...realSwitches.DEFAULT_SWITCH_ROW, platformMode: "LIVE" }]),
    ...over,
  };
}
function config(over: Partial<GlobalTradingConfig>): GlobalTradingConfig {
  return {
    accountRoutingMode: "SHARED_MASTER_MT5",
    sharedLiveTradingEnabled: false,
    masterBridgeLiveEnabled: false,
    platformMasterBridgeConnectionId: null,
    ...over,
  } as GlobalTradingConfig;
}

async function current(): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 1, role: "OWNER" }, async (base) => {
    const r = await fetch(`${base}/admin/master-bridge/current`);
    assert.equal(r.status, 200);
    body = (await r.json()) as Record<string, unknown>;
  });
  return body;
}

stop = realSwitches.NO_PLATFORM_STOP;

test("shared live and master-bridge live ON are reported ON, with the platform mode and routing", async () => {
  settings = {
    switches: switchesWith(),
    config: config({ sharedLiveTradingEnabled: true, masterBridgeLiveEnabled: true, platformMasterBridgeConnectionId: 41 }),
  };
  const s = (await current())["masterLiveSettings"] as Record<string, unknown>;
  assert.equal(s["readable"], true);
  assert.equal(s["sharedLiveTradingEnabled"], true);
  assert.equal(s["masterBridgeLiveEnabled"], true);
  assert.equal(s["platformMode"], "LIVE");
  assert.equal(s["accountRoutingMode"], "SHARED_MASTER_MT5");
  assert.equal(s["platformMasterBridgeConnectionId"], 41);
  assert.equal(typeof s["readAt"], "string");
});

test("flags OFF are reported OFF", async () => {
  settings = { switches: switchesWith(), config: config({}) };
  const s = (await current())["masterLiveSettings"] as Record<string, unknown>;
  assert.equal(s["readable"], true);
  assert.equal(s["sharedLiveTradingEnabled"], false);
  assert.equal(s["masterBridgeLiveEnabled"], false);
});

test("unreadable settings are null, not OFF", async () => {
  settings = { switches: switchesWith({ readable: false, unreadableReason: "error" }), config: null };
  const s = (await current())["masterLiveSettings"] as Record<string, unknown>;
  assert.equal(s["readable"], false);
  assert.equal(s["sharedLiveTradingEnabled"], null);
  assert.equal(s["masterBridgeLiveEnabled"], null);
  assert.equal(s["platformMode"], null);
});

// The page's "ready" badge and env box must not read green while the
// effective switch (env AND operator arm) is off or a platform stop is
// engaged. The response carries that execution state.
const savedEnv = process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"];
process.on("exit", () => {
  if (savedEnv === undefined) delete process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"];
  else process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"] = savedEnv;
});

function armedSwitches(armed: boolean): PlatformSwitches {
  return realSwitches.switchesFromRows([
    { ...realSwitches.DEFAULT_SWITCH_ROW, platformMode: "LIVE", liveBrokerExecutionArmed: armed },
  ]);
}

test("env on but not armed: the effective live switch is off", async () => {
  process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"] = "true";
  settings = { switches: armedSwitches(false), config: config({ sharedLiveTradingEnabled: true, masterBridgeLiveEnabled: true }) };
  stop = realSwitches.NO_PLATFORM_STOP;
  const body = await current();
  assert.equal(body["liveBrokerExecutionEnabled"], true, "the env-only field is unchanged");
  const x = body["liveExecution"] as Record<string, unknown>;
  assert.equal(x["readable"], true);
  assert.equal(x["envEnabled"], true);
  assert.equal(x["operatorArmed"], false);
  assert.equal(x["effectiveEnabled"], false);
  assert.equal(x["platformStopEngaged"], false);
});

test("env on and armed, but the safety-core kill switch is engaged: the stop is reported", async () => {
  process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"] = "true";
  settings = { switches: armedSwitches(true), config: config({}) };
  stop = realSwitches.platformStopFrom(
    { readable: true, emergencyStop: { engaged: false, reason: null, engagedAt: null } },
    { readable: true, engaged: true, reason: "operator halt" },
  );
  const x = (await current())["liveExecution"] as Record<string, unknown>;
  assert.equal(x["effectiveEnabled"], true);
  assert.equal(x["platformStopEngaged"], true);
  assert.deepEqual(x["platformStopSources"], ["safety_core_kill_switch"]);
  assert.match(String(x["platformStopReason"]), /operator halt/);
});

test("unreadable switches: arm unknown, effective switch off, readable false", async () => {
  process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"] = "true";
  settings = { switches: switchesWith({ readable: false, unreadableReason: "error" }), config: null };
  stop = realSwitches.NO_PLATFORM_STOP;
  const x = (await current())["liveExecution"] as Record<string, unknown>;
  assert.equal(x["readable"], false);
  assert.equal(x["operatorArmed"], null);
  assert.equal(x["effectiveEnabled"], false);
});
