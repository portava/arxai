// Truth regression: a reconciliation detector that could not run (DB down,
// query error, missing table) must be reported as "could not be checked",
// never folded into "0 issues". The aggregate stays non-throwing (EA Health and
// Bridge Diagnostics render the rest of the page), but it now says which checks
// failed and that the counts cover only the checks that ran.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

type QueryImpl = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
let queryImpl: QueryImpl = async () => ({ rows: [] });
const fakePool = { query: (sql: string) => queryImpl(sql) };

const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, pool: fakePool } });

let connectionsImpl: () => Promise<unknown[]> = async () => [];
const realConnections = await import("../../brokerHub/connections.js");
mock.module("../../brokerHub/connections.js", {
  namedExports: { ...realConnections, listConnections: async () => connectionsImpl() },
});

const { aggregateReconciliationIssues, RECONCILIATION_ISSUE_TYPES } = await import("../detect.js");

test("every detector failing is reported as unchecked, not as 'no issues'", async () => {
  queryImpl = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:5432"); };
  connectionsImpl = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:5432"); };

  const agg = await aggregateReconciliationIssues();

  assert.equal(agg.total, 0, "nothing was found, because nothing ran");
  assert.equal(agg.complete, false, "a run where checks failed is not a complete check");
  assert.deepEqual(
    [...agg.uncheckedTypes].sort(),
    [...RECONCILIATION_ISSUE_TYPES].sort(),
    "every issue type is unchecked when every detector failed",
  );
  // 10 types, BLOCKED_REJECTED_COMMAND has two queues (live + demo).
  assert.equal(agg.failedChecks.length, 11);
  for (const f of agg.failedChecks) {
    assert.match(f.error, /ECONNREFUSED/, `failure for ${f.check} carries the cause`);
    assert.ok(RECONCILIATION_ISSUE_TYPES.includes(f.type));
  }
});

test("one failing detector marks only its type unchecked; others still report", async () => {
  queryImpl = async (sql) => {
    if (/FROM arx_live_commands/.test(sql) && /SENT_TO_MT5_LIVE/.test(sql)) {
      throw new Error('relation "arx_live_commands" does not exist');
    }
    if (/FROM shared_trade_attribution/.test(sql)) {
      return { rows: [{ id: 7, user_id: 3, symbol: "EURUSD", side: "BUY", lot_size: 0.1 }] };
    }
    return { rows: [] };
  };
  connectionsImpl = async () => [];

  const agg = await aggregateReconciliationIssues();

  assert.equal(agg.complete, false);
  assert.deepEqual(agg.uncheckedTypes, ["COMMAND_RESULT_MISMATCH"]);
  assert.equal(agg.failedChecks.length, 1);
  assert.equal(agg.failedChecks[0]!.type, "COMMAND_RESULT_MISMATCH");
  assert.equal(agg.failedChecks[0]!.severity, "critical");
  assert.equal(agg.countsByType.MISSING_ATTRIBUTION, 1, "the checks that ran still report");
});

test("all detectors running cleanly is the only 'complete' result", async () => {
  queryImpl = async () => ({ rows: [] });
  connectionsImpl = async () => [];

  const agg = await aggregateReconciliationIssues();

  assert.equal(agg.complete, true);
  assert.deepEqual(agg.failedChecks, []);
  assert.deepEqual(agg.uncheckedTypes, []);
  assert.equal(agg.total, 0);
});
