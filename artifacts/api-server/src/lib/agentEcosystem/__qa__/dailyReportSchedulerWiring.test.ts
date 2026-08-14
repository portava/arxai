// Agent Ecosystem — Layer 4: scheduled daily Household Report delivery test.
// Run via:
//   node --import tsx --test src/lib/agentEcosystem/__qa__/dailyReportSchedulerWiring.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:daily-report-scheduler`)
//
// Proves the automatic daily delivery end-to-end (what a pure-engine test
// cannot): before the target UTC hour it skips (no work); a forced run generates
// today's report, delivers the plain-English summary to a real admin recipient
// as an in-app alert, and writes ONE system-actor audit row; and the durable
// per-UTC-day guard then makes a subsequent non-forced run skip ALREADY_DELIVERED.
//
// SAFETY / SCOPE: OBSERVATION ONLY — nothing here trades or touches the 16-gate
// path. Hits the real dev DB; the throwaway admin uses a TEST_ prefix and is
// cleaned up fail-closed (aborts if the scope looks wrong).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  db, usersTable, userAlertsTable, adminActionAuditLogTable,
} from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { runDailyReportDelivery } from "../dailyReportScheduler.js";

const SUFFIX = randomUUID().slice(0, 8);
const TEST_EMAIL = `test_dailyreport_${SUFFIX}@example.invalid`;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

async function cleanup(userId: number) {
  if (userId > 0 && TEST_EMAIL.startsWith("test_dailyreport_")) {
    await db.delete(userAlertsTable).where(eq(userAlertsTable.userId, userId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    // Intentionally NOT deleting the report row or audit rows: both are
    // legitimate, durable evidence of the automatic daily run.
  } else {
    throw new Error("ABORT: refusing cleanup — unexpected test scope");
  }
}

test("daily scheduler: hour-gates, generates+delivers to admins, audits, and dedupes per UTC day", async () => {
  // A throwaway ADMIN recipient (non-system) so the delivery has a real target.
  const [admin] = await db.insert(usersTable).values({
    email: TEST_EMAIL,
    passwordHash: "x",
    role: "ADMIN",
    isSystemUser: false,
  }).returning({ id: usersTable.id });
  const userId = admin!.id;

  try {
    const reportDate = startOfUtcDay(new Date()).toISOString().slice(0, 10);
    const alertType = `daily_household_report:${reportDate}`;

    // ── 1. Before the target UTC hour → skip, no work ──────────────────────────
    const early = new Date(Date.UTC(2026, 0, 1, 8, 0, 0)); // 08:00 UTC
    const earlyResult = await runDailyReportDelivery({ now: early });
    assert.equal(earlyResult.skipped, "BEFORE_TARGET_HOUR", "before target hour skips");
    assert.equal(earlyResult.reportId, null, "no report generated before target hour");

    // ── 2. Forced run generates today's report + delivers to the admin ─────────
    const r1 = await runDailyReportDelivery({ force: true });
    assert.equal(r1.skipped, null, "forced run is not skipped");
    assert.ok(r1.reportId && r1.reportId.length > 0, "a report was generated");
    assert.equal(r1.reportDate, reportDate, "report carries today's UTC date");
    assert.ok(r1.recipients >= 1, "at least our test admin is a recipient");
    assert.ok(r1.notified >= 1, "at least one admin was notified");

    // The in-app alert landed for our admin and carries the plain-English summary.
    const [alert] = await db.select().from(userAlertsTable)
      .where(and(eq(userAlertsTable.userId, userId), eq(userAlertsTable.alertType, alertType)))
      .limit(1);
    assert.ok(alert, "an in-app alert was delivered to the admin");
    assert.equal(alert!.severity, "info", "daily report alert is informational");
    assert.ok(alert!.message.length > 0, "alert carries the plain-English summary");
    // Plain-English: must not leak internal codes/table/route names.
    const msg = alert!.message.toLowerCase();
    for (const forbidden of ["agentkey", "authorityweight", "/api/", "16-gate", "agent_household_reports"]) {
      assert.ok(!msg.includes(forbidden), `summary must not leak internal token "${forbidden}"`);
    }

    // A single system-actor audit row was written for today.
    const audits = await db.select().from(adminActionAuditLogTable)
      .where(and(
        eq(adminActionAuditLogTable.action, "AGENT_ECO_DAILY_REPORT_AUTO_DELIVERED"),
        gte(adminActionAuditLogTable.createdAt, startOfUtcDay(new Date())),
      ));
    assert.ok(audits.length >= 1, "a system audit row was written for the automatic delivery");
    assert.ok(audits.some((a) => a.adminId === null && a.adminRole === "SYSTEM"),
      "audit row is a system actor (adminId NULL, adminRole SYSTEM)");

    // ── 3. Durable per-UTC-day guard: a non-forced run now skips ───────────────
    const lateToday = new Date();
    lateToday.setUTCHours(23, 30, 0, 0);
    const r2 = await runDailyReportDelivery({ now: lateToday });
    assert.equal(r2.skipped, "ALREADY_DELIVERED", "second non-forced run dedupes for the day");
    assert.equal(r2.reportId, null, "no second generation for the same UTC day");
  } finally {
    await cleanup(userId);
  }
});
