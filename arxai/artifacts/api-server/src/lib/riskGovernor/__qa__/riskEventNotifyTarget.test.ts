// A Risk Governor block or warning sends a notification whose button says
// "View risk events". It used to open /risk-settings, which has no event list
// and whose legacy audit banner can still read GREEN while the governor has
// just blocked a trade. The button now opens /risk-events, the page that lists
// the trader's own user_risk_events rows (GET /api/risk/events).
//
// logRiskEvent runs for real with the database and notification service
// mocked: no database, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/riskEventNotifyTarget.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const sent: Array<{ userId: number; p: Record<string, unknown> }> = [];
const table = () => ({ id: {}, userId: {}, createdAt: {} });
mock.module("@workspace/db", {
  namedExports: {
    db: {
      insert: () => ({ values: () => ({ returning: async () => [{ id: 1 }] }) }),
      select: () => { throw new Error("not used"); },
      // logRiskEvent writes its row (and, for governor decisions, the vault
      // and audit mirrors) in one transaction; these events have no mirror.
      transaction: async (fn: (tx: unknown) => unknown) => fn({
        insert: () => ({ values: () => ({ returning: async () => [{ id: 1 }] }) }),
      }),
    },
    userRiskSettingsTable: table(), userRiskEventsTable: table(), userRiskLimitsTable: table(),
    vaultEventsTable: table(), auditEventsTable: table(),
  },
});
mock.module("../../notificationService.js", {
  namedExports: { fireNotify: (userId: number, p: Record<string, unknown>) => { sent.push({ userId, p }); } },
});

const { logRiskEvent } = await import("../riskEvents.js");

for (const decision of ["block", "warning"] as const) {
  test(`a ${decision} notification's "View risk events" button opens the risk events page`, async () => {
    sent.length = 0;
    await logRiskEvent({ userId: 7, eventType: "daily_loss_limit", severity: "critical", decision, reason: "Daily loss 50 reached the 50 cap." });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.userId, 7);
    assert.equal(sent[0]!.p["actionLabel"], "View risk events");
    assert.equal(sent[0]!.p["actionTarget"], "/risk-events");
  });
}

test("a pass is not notified", async () => {
  sent.length = 0;
  await logRiskEvent({ userId: 7, eventType: "pre_trade", severity: "info", decision: "pass", reason: "ok" });
  assert.equal(sent.length, 0);
});
