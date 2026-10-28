// Reconciliation Center — an action on an issue must be able to name it.
//
// Issue ids are SHA-256(type|naturalKey) and every action POST must send the
// natural key back (the server re-derives the id and refuses a mismatch). For
// ORPHAN_BROKER_POSITION, MISSING_ATTRIBUTION, USER_ALLOCATION_MISMATCH,
// MASTER_BRIDGE_EXPOSURE_WARNING and USER_APPROVAL_RISK_LOCK_CONFLICT the key
// is built from a row id the issue did not carry, so the page sent "" and
// every Dismiss / Mark reviewed / Resolve failed with NATURAL_KEY_REQUIRED.
// Each issue now carries its naturalKey; and because actions only record an
// audit note (they never change or hide an issue), each issue also carries its
// most recent recorded action so a dismissed issue does not look untouched.
//
// The real detectors and router run against an in-memory db / pool.
// No database, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/routes/__qa__/reconciliationCenterActionKey.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const auditRows: unknown[] = [];
const realDb = await import("@workspace/db");
const fake = createFakeDb({ admin_action_audit_log: auditRows });
const pool = {
  query: async (text: string) => {
    if (text.includes("FROM shared_trade_attribution")) {
      return { rows: [{ id: 9, user_id: 3, symbol: "EURUSD", side: "buy", lot_size: 0.1 }] };
    }
    if (text.includes("FROM virtual_trading_accounts")) {
      return { rows: [{ id: 12, user_id: 4, routing_mode: "SHARED_MASTER", account_type: "demo", status: "active" }] };
    }
    if (text.includes("FROM shared_master_accounts")) {
      return { rows: [{ id: 2, status: "paused", is_active: true, account_type: "live", broker_name: "B" }] };
    }
    if (text.includes("FROM user_master_live_access")) {
      return { rows: [{ id: 5, user_id: 6, master_live_status: "APPROVED", master_live_trading_enabled: true, master_live_disabled_at: null, master_live_approved_at: null }] };
    }
    return { rows: [] };
  },
};
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db, pool } });
const realLedger = await import("../../lib/positions/ledger.js");
mock.module("../../lib/positions/ledger.js", {
  namedExports: {
    ...realLedger,
    readOrphanLivePositions: async () => ({
      rows: [{ id: 55, user_id: 7, bridge_connection_id: 41, source_command_id: null, broker_ticket: "123", symbol: "XAUUSD", opened_at: new Date(), broker_absent_snapshot_count: 0 }],
    }),
  },
});
const realConn = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", { namedExports: { ...realConn, listConnections: async () => [] } });

const { issueId } = await import("../../lib/reconciliation/detect.js");
const router = (await import("../adminReconciliationCenter.js")).default;

type Issue = { id: string; type: string; naturalKey?: string; userId: number | null; lastAction?: unknown };

async function getIssues(base: string): Promise<{ issues: Issue[]; actionsReadable: unknown }> {
  const r = await fetch(`${base}/admin/reconciliation-center/issues`);
  assert.equal(r.status, 200);
  return (await r.json()) as { issues: Issue[]; actionsReadable: unknown };
}

const ROW_ID_TYPES = [
  "ORPHAN_BROKER_POSITION",
  "MISSING_ATTRIBUTION",
  "USER_ALLOCATION_MISMATCH",
  "MASTER_BRIDGE_EXPOSURE_WARNING",
  "USER_APPROVAL_RISK_LOCK_CONFLICT",
] as const;

test("every issue carries the natural key its id is derived from", async () => {
  await withRouter(router, { id: 1, role: "OWNER" }, async (base) => {
    const { issues } = await getIssues(base);
    for (const t of ROW_ID_TYPES) {
      const i = issues.find((x) => x.type === t);
      assert.ok(i, `${t} detected`);
      assert.equal(typeof i!.naturalKey, "string", `${t} has a naturalKey`);
      assert.ok(i!.naturalKey!.length > 0);
      assert.equal(issueId(t, i!.naturalKey!), i!.id, `${t} id = issueId(type, naturalKey)`);
    }
    assert.equal(issues.find((x) => x.type === "ORPHAN_BROKER_POSITION")!.naturalKey, "pos:55");
  });
});

test("Dismiss with the issue's naturalKey succeeds for the five row-id issue types", async () => {
  await withRouter(router, { id: 1, role: "OWNER" }, async (base) => {
    const { issues } = await getIssues(base);
    for (const t of ROW_ID_TYPES) {
      const i = issues.find((x) => x.type === t)!;
      const r = await fetch(`${base}/admin/reconciliation-center/issues/${i.id}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "operator checked", type: i.type, naturalKey: i.naturalKey, targetUserId: i.userId }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      assert.equal(r.status, 200, `${t}: ${j.error ?? ""}`);
      assert.equal(j.ok, true);
    }
  });
});

test("an issue's most recent recorded action is listed with it; untouched issues have none", async () => {
  await withRouter(router, { id: 1, role: "OWNER" }, async (base) => {
    const first = await getIssues(base);
    const orphan = first.issues.find((x) => x.type === "ORPHAN_BROKER_POSITION")!;
    auditRows.splice(0, auditRows.length, {
      action: "RECONCILIATION_ISSUE_DISMISSED",
      createdAt: new Date("2026-10-28T11:00:00Z"),
      adminId: 3,
      reason: "known test position",
      afterState: { issueId: orphan.id, type: orphan.type, naturalKey: orphan.naturalKey },
    });
    const { issues, actionsReadable } = await getIssues(base);
    assert.equal(actionsReadable, true);
    assert.deepEqual(issues.find((x) => x.id === orphan.id)!.lastAction, {
      action: "RECONCILIATION_ISSUE_DISMISSED",
      at: "2026-10-28T11:00:00.000Z",
      adminId: 3,
      reason: "known test position",
    });
    assert.equal(issues.find((x) => x.type === "MISSING_ATTRIBUTION")!.lastAction, null);
  });
});
