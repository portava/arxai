// A failing readiness-gate run sends users a notification. It ended with
// "Live trading remains DISABLED." — a claim about live trading that this
// paper-stack gate never reads (an armed LIVE_SHARED trader can trade live).
// It now says what the gate covers.
//
// The real runReadinessGate runs; its test runner and database are stubbed.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/readiness/__qa__/gateNotificationLiveClaim.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const tables = {
  readinessReportsTable: { name: "readiness_reports" },
  readinessGateStatusTable: { name: "readiness_gate_status" },
  productionGateLogsTable: { name: "production_gate_logs" },
  notificationsTable: { name: "notifications" },
};
function selectChain(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.orderBy = self; q.limit = self;
  q.then = (r: (v: unknown[]) => unknown) => Promise.resolve([]).then(r);
  return q;
}
mock.module("@workspace/db", {
  namedExports: {
    db: {
      insert: (table: unknown) => ({ values: async (values: Record<string, unknown>) => { inserted.push({ table, values }); } }),
      select: () => selectChain(),
      execute: async () => ({ rows: [] }),
    },
  },
});
mock.module("@workspace/db/schema", { namedExports: tables });
mock.module("../runner.js", {
  namedExports: {
    TEST_GROUPS: ["safety", "database"],
    runTestGroups: async () => ({
      results: [
        { test_id: "t1", group: "database", name: "required table present", status: "FAIL", severity: "CRITICAL", duration_ms: 1, details: {}, errors: ["missing table (fixture)"], created_at: new Date().toISOString() },
      ],
    }),
  },
});

const { runReadinessGate } = await import("../gate.js");

test("failed gate notification does not claim live trading is disabled", async () => {
  const r = await runReadinessGate();
  assert.equal(r.overallStatus, "FAIL");
  const n = inserted.find((i) => i.table === tables.notificationsTable);
  assert.ok(n, "notification inserted");
  const msg = String(n.values.message);
  assert.doesNotMatch(msg, /live trading (remains|is) disabled/i);
  assert.match(msg, /checks the paper stack only/);
  // Persisted constants are unchanged.
  const row = inserted.find((i) => i.table === tables.readinessReportsTable);
  assert.equal(row?.values.liveTradingStatus, "DISABLED");
});
