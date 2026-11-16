// Truth regression: each reconciliation detector caps its list (50 rows, or
// 25 per blocked/rejected queue). When more rows match than the cap, the count
// shown is "at least N", not the total — the aggregate must say which lists
// were cut so no surface presents a capped count as the real number.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// The fake pool honours the SQL LIMIT, like Postgres would.
let rowsFor: (sql: string) => Record<string, unknown>[] = () => [];
function limited(sql: string, params?: unknown[]): Record<string, unknown>[] {
  const rows = rowsFor(sql);
  const lit = /LIMIT\s+(\d+)/i.exec(sql);
  const param = /LIMIT\s+\$(\d+)/i.exec(sql);
  const limit = lit ? Number(lit[1]) : param ? Number(params?.[Number(param[1]) - 1]) : Infinity;
  return rows.slice(0, limit);
}
const fakePool = { query: async (sql: string, params?: unknown[]) => ({ rows: limited(sql, params) }) };
const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, pool: fakePool } });

type Conn = { id: number; userId: number; status: string; mode: string; accountNumber: string | null; lastHeartbeat: Date | null; updatedAt: Date };
let connections: Conn[] = [];
const realConnections = await import("../../brokerHub/connections.js");
mock.module("../../brokerHub/connections.js", {
  namedExports: {
    ...realConnections,
    listConnections: async (q: { modes?: string[]; connectionIds?: number[] } = {}) =>
      connections.filter((c) =>
        (!q.modes || q.modes.includes(c.mode)) && (!q.connectionIds || q.connectionIds.includes(c.id))),
  },
});

const { aggregateReconciliationIssues } = await import("../detect.js");

function many(n: number, f: (i: number) => Record<string, unknown>) {
  return Array.from({ length: n }, (_, i) => f(i + 1));
}

test("lists cut at their cap are flagged; counts are lower bounds, not totals", async () => {
  rowsFor = (sql) => {
    if (/FROM arx_live_positions/.test(sql)) return many(60, (i) => ({ id: i, user_id: i, symbol: "EURUSD" }));
    if (/FROM arx_live_commands/.test(sql) && /'BLOCKED','REJECTED','LIVE_BLOCKED'\)\s+AND created_at/.test(sql)) {
      return many(30, (i) => ({ id: i, command_id: `c${i}`, user_id: 1, status: "BLOCKED" }));
    }
    return [];
  };
  // 70 ACTIVE live bridges without an account number and with no heartbeat.
  connections = many(70, (i) => ({
    id: i, userId: i, status: "ACTIVE", mode: "LIVE", accountNumber: null, lastHeartbeat: null, updatedAt: new Date(),
  })) as Conn[];

  const agg = await aggregateReconciliationIssues();

  assert.equal(agg.truncated, true);
  for (const t of ["ORPHAN_BROKER_POSITION", "BRIDGE_MISMATCH", "STALE_HEARTBEAT", "BLOCKED_REJECTED_COMMAND"] as const) {
    assert.ok(agg.truncatedTypes.includes(t), `${t} is flagged as cut at its cap`);
  }
  assert.equal(agg.countsByType.ORPHAN_BROKER_POSITION, 50, "the list itself is still capped at 50");
  assert.equal(agg.countsByType.BLOCKED_REJECTED_COMMAND, 25);
  const orphan = agg.truncatedChecks.find((c) => c.check === "orphan_broker");
  assert.deepEqual(orphan, { check: "orphan_broker", type: "ORPHAN_BROKER_POSITION", severity: "critical", limit: 50 });
  assert.ok(agg.truncatedSeverities.includes("critical"), "critical count is a lower bound");
  assert.ok(agg.truncatedSeverities.includes("high"));
  assert.ok(agg.truncatedSeverities.includes("medium"));
  assert.ok(!agg.truncatedSeverities.includes("low"), "the demo queue was not cut");
  assert.ok(!agg.truncatedTypes.includes("MISSING_ATTRIBUTION"));
});

test("exactly the cap is not truncated", async () => {
  rowsFor = (sql) => (/FROM arx_live_positions/.test(sql) ? many(50, (i) => ({ id: i, user_id: i })) : []);
  connections = [];

  const agg = await aggregateReconciliationIssues();

  assert.equal(agg.countsByType.ORPHAN_BROKER_POSITION, 50);
  assert.equal(agg.truncated, false);
  assert.deepEqual(agg.truncatedTypes, []);
  assert.deepEqual(agg.truncatedChecks, []);
  assert.deepEqual(agg.truncatedSeverities, []);
});
