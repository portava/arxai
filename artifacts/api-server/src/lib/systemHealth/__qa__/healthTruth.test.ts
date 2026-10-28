// System Health truth: a check that did not run is never reported as passed.
//
// Locks three inaccuracies on the admin System Health page:
//   (a) the secret-redaction scan swallowed a failed DB query into zero
//       findings, so the page said "Working: true" with the database down;
//   (b) overallStatus was computed BEFORE the persist step pushed
//       "failed to persist health check" into the same errors list, so the
//       report read HEALTHY beside its own error;
//   (c) an unauthenticated GET answering 2xx was reported as subsystem "OK"
//       with constant claims nobody measured ("critical alerts work",
//       "secrets redacted", "paper-only enforced", ...).
//
// Runs the REAL runHealthCheck with its I/O seams replaced by module mocks:
// no database, no broker, no network (fetch is stubbed).

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const state = { dbDown: false, insertFails: false };

const EXPECTED_TABLES = [
  "trades", "signals", "alerts", "safety_core",
  "paper_orders", "autopilot_settings", "autopilot_cycles",
  "risk_governor_evaluations", "broker_health_state",
  "notifications", "notification_preferences", "notification_logs", "notification_digests",
  "system_health_checks", "system_audit_logs", "admin_action_logs", "system_config_registry",
];
// One row shape that answers both the information_schema query and count queries.
const ROWS = EXPECTED_TABLES.map((t) => ({ table_name: t, c: 0 }));

// A chainable drizzle-like query: every builder method returns the chain; the
// chain is awaitable and resolves (or rejects) when awaited.
function chain(resolve: () => Promise<unknown>): unknown {
  const handler: ProxyHandler<() => void> = {
    get(_t, prop) {
      if (prop === "then") return (a: (v: unknown) => unknown, b: (e: unknown) => unknown) => resolve().then(a, b);
      if (prop === "catch") return (b: (e: unknown) => unknown) => resolve().catch(b);
      if (prop === "finally") return (f: () => void) => resolve().finally(f);
      return () => chain(resolve);
    },
  };
  return new Proxy(() => undefined, handler);
}

const fakeDb = {
  execute: async () => {
    if (state.dbDown) throw new Error("connect ECONNREFUSED (fixture)");
    return { rows: ROWS };
  },
  select: () => chain(async () => {
    if (state.dbDown) throw new Error("connect ECONNREFUSED (fixture)");
    return [];
  }),
  insert: () => ({
    values: async () => {
      if (state.dbDown || state.insertFails) throw new Error("insert failed (fixture)");
    },
  }),
};
const table = () => ({ id: {}, createdAt: {} });

mock.module("@workspace/db", {
  namedExports: {
    db: fakeDb,
    systemHealthChecksTable: table(),
    notificationsTable: table(),
    notificationLogsTable: table(),
    autopilotSettingsTable: table(),
    autopilotCyclesTable: table(),
    paperOrdersTable: table(),
    riskGovernorEvaluationsTable: table(),
    mt5CommandsTable: table(),
  },
});
mock.module("../../positions/ledger.js", {
  namedExports: { countDemoPositions: async () => 0, demoPositionColumns: {} },
});
mock.module("../audit.js", { namedExports: { auditEvent: async () => undefined } });
mock.module("../config.js", {
  namedExports: { patchConfig: async () => undefined, getConfig: async () => ({}) },
});
mock.module("../../safety/platformSwitches.js", {
  namedExports: {
    platformStop: async () => ({}),
    platformStopForVenue: () => ({ engaged: false, detail: {} }),
    readSafetyCorePosture: async () => ({ operationalMode: "PAPER_ONLY" }),
  },
});
mock.module("../../marketData/marketDataService.js", {
  namedExports: {
    marketDataHealthCheck: async () => ({
      active: { name: "fixture", source: "fixture" },
      realProvider: { ok: true, detail: "" },
    }),
  },
});

const { runHealthCheck } = await import("../health.js");

function stubFetch(t: { mock: typeof mock }) {
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
}

test("baseline: every probe passes and nothing failed → HEALTHY", async (t) => {
  state.dbDown = false; state.insertFails = false;
  stubFetch(t);
  const r = await runHealthCheck();
  assert.deepEqual(r.errors, []);
  assert.equal(r.overallStatus, "HEALTHY");
  assert.equal(r.secretSafetyStatus.redactionWorking, true);
  assert.equal(r.secretSafetyStatus.scanChecked, true);
});

test("(a) a secret scan that could not run is not 'redaction working'", async (t) => {
  state.dbDown = true; state.insertFails = false;
  stubFetch(t);
  const r = await runHealthCheck();
  assert.notEqual(r.secretSafetyStatus.redactionWorking, true);
  assert.equal(r.secretSafetyStatus.scanChecked, false);
  assert.notEqual(r.overallStatus, "HEALTHY");
  assert.equal(r.performanceStatus.latestNotificationCriticalCount, null,
    "a failed count is unknown, never zero");
  assert.ok(r.errors.some((e) => /database not reachable/.test(e)), r.errors.join(" | "));
});

test("(b) a persist failure is reflected in overallStatus and the healthy recommendation", async (t) => {
  state.dbDown = false; state.insertFails = true;
  stubFetch(t);
  const r = await runHealthCheck();
  assert.ok(r.errors.some((e) => /failed to persist health check/.test(e)));
  assert.notEqual(r.overallStatus, "HEALTHY");
  assert.ok(!r.recommendedAdminActions.includes("System healthy — no admin action required"));
});

test("(c) a 2xx probe is reported as reachability only, with no unmeasured claims", async (t) => {
  state.dbDown = false; state.insertFails = false;
  stubFetch(t);
  const r = await runHealthCheck();
  const UNMEASURED = [
    /critical alerts work/i, /secrets redacted/i, /paper-only enforced/i, /playbook readable/i,
    /no live recommendations/i, /replay trades isolated/i, /mode=REPLAY_ONLY/, /mode=PAPER_ONLY/,
    /canPlaceLiveTrade=false/, /liveTradingStatus=DISABLED/,
  ];
  for (const [build, sub] of Object.entries(r.subsystemStatus)) {
    for (const note of sub.notes) {
      for (const rx of UNMEASURED) assert.doesNotMatch(note, rx, `${build}: ${note}`);
    }
    if (build === "DD") assert.equal(sub.checkScope, "IN_PROCESS");
    else if (sub.status === "OK") assert.equal(sub.checkScope, "REACHABILITY_ONLY", build);
  }
});
