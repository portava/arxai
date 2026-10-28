// Live Shared activation smoke test — a check may say "pass" only when this
// call observed what it names.
//
// The defect this locks: C5 (validate endpoint), C6 (master switch), C10
// (admin all-records read) and C11 (audit write) were hard-coded pass:true,
// and C4 / C8 were `count >= 0` (always true). A failed count query or audit
// write crashed the route instead of failing its row, and C11 claimed the
// audit row before it was written. Only the DB handle and the bridge
// readers are stubbed; the real router runs. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/liveSharedSmokeTestTruth.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";

let failingTables = new Set<string>();
let auditThrows = false;
let audits: Array<Record<string, unknown>> = [];

function chain(resolve: () => unknown[]): unknown {
  const self: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve().then(resolve).then(ok, bad);
      }
      return () => self;
    },
  });
  return self;
}

const fakeDb = {
  select: (cols?: unknown) => ({
    from: (table: Table) => chain(() => {
      const name = getTableName(table);
      if (failingTables.has(name)) throw new Error(`relation "${name}" is unavailable`);
      // COUNT(*) reads (a column map) answer one row; whole-row reads find nothing.
      return cols ? [{ n: 0 }] : [];
    }),
  }),
  insert: (table: Table) => ({
    values: (values: Record<string, unknown>) => chain(() => {
      if (auditThrows) throw new Error("audit insert refused");
      audits.push({ table: getTableName(table), ...values });
      return [];
    }),
  }),
  update: () => ({ set: () => chain(() => []) }),
  transaction: async () => { throw new Error("no transactions in this test"); },
};

const database = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const connections = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", {
  namedExports: { ...connections, listConnections: async () => [] },
});
const detectorMod = await import("../../lib/mt5/currentConnectedBridgeDetector.js");
mock.module("../../lib/mt5/currentConnectedBridgeDetector.js", {
  namedExports: { ...detectorMod, detectCurrentConnectedBridge: async () => ({ ok: false, primaryReason: "NO_BRIDGE", latestHint: null }) },
});
const gateMod = await import("../../lib/mt5/masterLiveBridgeGate.js");
mock.module("../../lib/mt5/masterLiveBridgeGate.js", {
  namedExports: { ...gateMod, loadAndEvaluateMasterLiveBridgeGate: async () => ({ decision: "BLOCKED", primaryReason: "NO_PINNED_BRIDGE" }) },
});

const { withRouter } = await import("./_fakeRouteDb.js");
const router = (await import("../adminLiveSharedActivation.js")).default;

type Check = { id: string; pass: boolean; status?: string; detail: string };
type Body = { ok: boolean; summary: { total: number; passed: number; failed: number; notChecked?: number }; checks: Check[] };

async function run(): Promise<{ status: number; body: Body }> {
  let out: { status: number; body: Body } | null = null;
  await withRouter(router, { id: 7, role: "ADMIN" }, async (base) => {
    const res = await fetch(`${base}/admin/live-shared/activation-smoke-test`, { method: "POST" });
    out = { status: res.status, body: (await res.json()) as Body };
  });
  return out!;
}
const byId = (b: Body, id: string): Check => {
  const c = b.checks.find((x) => x.id === id);
  assert.ok(c, `check ${id} missing`);
  return c;
};

beforeEach(() => { failingTables = new Set(); auditThrows = false; audits = []; });

test("C5 and C6 run nothing that could fail: not checked, never pass, not counted as passed", async () => {
  const { status, body } = await run();
  assert.equal(status, 200);
  for (const id of ["C5_validate_endpoint", "C6_execute_blocked_when_master_off"]) {
    const c = byId(body, id);
    assert.equal(c.pass, false, `${id} must not report pass:true`);
    assert.equal(c.status, "not_checked");
    assert.match(c.detail, /^Not checked/);
  }
  const passIds = body.checks.filter((c) => c.status === "pass").map((c) => c.id);
  assert.equal(body.summary.passed, passIds.length);
  assert.equal(body.summary.notChecked, 2);
  assert.equal(body.summary.failed, body.checks.filter((c) => c.status === "fail").length);
  assert.equal(body.summary.passed + body.summary.failed + (body.summary.notChecked ?? 0), body.summary.total);
});

test("C4 / C8: a failed lookup fails its row as 'could not be loaded' (not a 0 count, not a 500)", async () => {
  failingTables = new Set(["user_master_live_access", "shared_trade_attribution"]);
  const { status, body } = await run();
  assert.equal(status, 200);
  const c4 = byId(body, "C4_approved_user_lookup");
  const c8 = byId(body, "C8_attribution_reachable");
  assert.equal(c4.pass, false);
  assert.match(c4.detail, /could not be loaded/);
  assert.doesNotMatch(c4.detail, /\b0 approved/);
  assert.equal(c8.pass, false);
  assert.match(c8.detail, /could not be loaded/);
  // C9 reads the same table: unknown, not "every approved user has a maxLot".
  assert.equal(byId(body, "C9_user_isolation_caps").pass, false);
});

test("C10: passes only when the unscoped reads returned", async () => {
  let { body } = await run();
  assert.equal(byId(body, "C10_admin_all_records").pass, true);
  failingTables = new Set(["arx_live_commands"]);
  ({ body } = await run());
  const c10 = byId(body, "C10_admin_all_records");
  assert.equal(c10.pass, false);
  assert.match(c10.detail, /C7 could not be loaded/);
});

test("C11: passes only after the audit row was written; a refused write fails the row", async () => {
  let { body } = await run();
  assert.equal(audits.length, 1);
  assert.equal(byId(body, "C11_audit_log_write").pass, true);
  assert.match(byId(body, "C11_audit_log_write").detail, /wrote one/);

  auditThrows = true;
  const res = await run();
  assert.equal(res.status, 200, "a failed audit write is reported in the row, not as a 500");
  body = res.body;
  const c11 = byId(body, "C11_audit_log_write");
  assert.equal(c11.pass, false);
  assert.equal(c11.status, "fail");
  assert.match(c11.detail, /could not write/);
});
