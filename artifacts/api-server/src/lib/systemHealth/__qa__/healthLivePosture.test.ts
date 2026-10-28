// System Health returned liveTradingStatus "DISABLED" / mode "PAPER_ONLY" as
// the only live-trading words in the report, even when the platform's live
// broker execution switch is on and LIVE_SHARED traders are armed (the
// dashboard's Trading Permission card says "Live trading is active"). The
// constants stay (they are persisted and name the paper stack), and the
// report now also says what they cover and carries the platform switch as
// read for the report (livePosture). An unreadable switch is UNKNOWN.
//
// The real runHealthCheck runs with its I/O seams mocked: no database, no
// broker, no network (fetch is stubbed).
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/systemHealth/__qa__/healthLivePosture.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const state = { readable: true, enabled: true };

function chain(): unknown {
  const handler: ProxyHandler<() => void> = {
    get(_t, prop) {
      if (prop === "then") return (a: (v: unknown) => unknown, b: (e: unknown) => unknown) => Promise.resolve([]).then(a, b);
      if (prop === "catch") return (b: (e: unknown) => unknown) => Promise.resolve([]).catch(b);
      if (prop === "finally") return (f: () => void) => Promise.resolve([]).finally(f);
      return () => chain();
    },
  };
  return new Proxy(() => undefined, handler);
}
const table = () => ({ id: {}, createdAt: {} });
mock.module("@workspace/db", {
  namedExports: {
    db: { execute: async () => ({ rows: [] }), select: () => chain(), insert: () => ({ values: async () => undefined }) },
    systemHealthChecksTable: table(), notificationsTable: table(), notificationLogsTable: table(),
    autopilotSettingsTable: table(), autopilotCyclesTable: table(), paperOrdersTable: table(),
    riskGovernorEvaluationsTable: table(), mt5CommandsTable: table(),
  },
});
mock.module("../../positions/ledger.js", { namedExports: { countDemoPositions: async () => 0, demoPositionColumns: {} } });
mock.module("../audit.js", { namedExports: { auditEvent: async () => undefined } });
mock.module("../config.js", { namedExports: { patchConfig: async () => undefined, getConfig: async () => ({}) } });
mock.module("../../safety/platformSwitches.js", {
  namedExports: {
    platformStop: async () => ({}),
    platformStopForVenue: () => ({ engaged: false, detail: {} }),
    readSafetyCorePosture: async () => ({ operationalMode: "PAPER_ONLY" }),
    readPlatformSwitches: async () => ({
      readable: state.readable,
      liveBrokerExecution: { envEnabled: state.enabled, operatorArmed: state.enabled, enabled: state.enabled && state.readable, armedAt: null, armedBy: null, armedBridgeId: null },
    }),
  },
});
mock.module("../../marketData/marketDataService.js", {
  namedExports: { marketDataHealthCheck: async () => ({ active: { name: "fixture", source: "fixture" }, realProvider: { ok: true, detail: "" } }) },
});

const { runHealthCheck } = await import("../health.js");
const { platformPostureFrom } = await import("../platformLivePosture.js");

test("live execution switched on: the report says so beside its paper-stack constants", async (t) => {
  state.readable = true; state.enabled = true;
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  const r = (await runHealthCheck()) as unknown as Record<string, unknown>;
  const lp = r.livePosture as { state: string; plainEnglish: string } | undefined;
  assert.ok(lp, "livePosture present");
  assert.equal(lp.state, "ON");
  assert.match(lp.plainEnglish, /switched on for the platform/);
  assert.equal(r.liveTradingStatus, "DISABLED");
  assert.match(String(r.liveTradingStatusScope), /not whether live trading is on/);
});

test("switch unreadable: livePosture is UNKNOWN, not OFF", async (t) => {
  state.readable = false; state.enabled = false;
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  const r = (await runHealthCheck()) as unknown as Record<string, unknown>;
  const lp = r.livePosture as { state: string; plainEnglish: string };
  assert.equal(lp.state, "UNKNOWN");
  assert.match(lp.plainEnglish, /could not be read/);
});

test("platformPostureFrom: off names both halves of the switch", () => {
  const at = new Date("2026-10-28T09:05:00Z");
  const off = platformPostureFrom({ readable: true, liveBrokerExecution: { envEnabled: true, operatorArmed: false, enabled: false, armedAt: null, armedBy: null, armedBridgeId: null } }, at);
  assert.equal(off.state, "OFF");
  assert.equal(off.plainEnglish, "Live broker execution is switched off for the platform (server setting on, operator arm off; checked 09:05 UTC).");
});
