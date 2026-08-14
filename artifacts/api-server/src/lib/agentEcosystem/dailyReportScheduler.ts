// Agent Ecosystem — Layer 4: scheduled daily Household Report delivery.
//
// WHAT: A lightweight background scheduler that, once per UTC day, automatically
//   (1) generates (refreshes) the canonical Household Report for the current UTC
//       day — the same idempotent per-day upsert an admin would trigger by hand,
//   (2) delivers the plain-English Ruby summary to every admin/OWNER as an in-app
//       alert (the bell-badge surface), so operators get the daily team summary
//       without remembering to open the Agent Ecosystem page and click generate,
//   (3) writes a single fail-soft audit row recording the automatic generation +
//       delivery (system actor — adminId NULL, adminRole "SYSTEM").
//
//   Delivery fires at/after a target UTC hour (so the snapshot covers a nearly
//   complete day rather than an empty just-after-midnight window) and at most
//   once per UTC day. The per-day guard is durable: it queries the audit log for
//   today's delivery row, so a restart mid-day never re-delivers.
//
// SAFETY / SCOPE (inviolable):
//   * OBSERVATION ONLY. Reads the advisory registry + in-memory traces and
//     persists a report row + admin alerts + one audit row. NOTHING here trades,
//     queues a command, gates, slows, or touches the 16-gate live pipeline. No
//     change to the advisory/shadow scope.
//   * Admin-only delivery: alert recipients are exclusively users whose role is
//     ADMIN or OWNER and who are not system/seed users. Normal users never
//     receive the report.
//   * Idempotent: at most one generation + one delivery per UTC day (durable
//     audit-log guard + an in-memory fast path). upsertAlertOnce additionally
//     dedupes per (userId, alertType, hourly bucket).
//   * Fail-soft: any failure is caught and logged; the scheduler never crashes
//     the process and never holds it open (the interval is unref'd).

import { db, adminActionAuditLogTable, usersTable } from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import { logger } from "../logger.js";
import { generateHouseholdReport } from "./householdReport.js";
import { upsertAlertOnce } from "../../routes/meAlerts.js";

// How often the scheduler wakes to check whether today's report is due. The
// check is cheap (one in-memory comparison, then at most one indexed audit-log
// read) and runs well off any request hot path.
const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

// Deliver at/after this UTC hour so the daily snapshot covers a nearly complete
// UTC day instead of an empty just-after-midnight window.
const TARGET_DELIVERY_HOUR_UTC = 23;

// Durable per-day delivery marker (system audit action) + the in-app alert type
// prefix. The report date is appended to the alert type so the dedupe slot is
// unambiguous and a future date never collides with today's.
const DELIVERY_AUDIT_ACTION = "AGENT_ECO_DAILY_REPORT_AUTO_DELIVERED";
const ALERT_TYPE_PREFIX = "daily_household_report";

// Frontend route for the Agent Ecosystem admin page (where the full report and
// its history live).
const REPORT_PAGE_TARGET = "/admin/n";

export type DailyReportSkipReason =
  | "BEFORE_TARGET_HOUR"
  | "ALREADY_DELIVERED";

export interface DailyReportDeliveryResult {
  ranAt: string;
  reportDate: string;
  skipped: DailyReportSkipReason | null;
  reportId: string | null;
  recipients: number;
  notified: number;
  errors: number;
}

/** UTC start-of-day used for both the report date and the durable per-day guard. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

// In-memory fast path so a healthy process answers "already done today" without
// a DB read. The durable audit-log guard remains the source of truth across
// restarts.
let lastDeliveredDate: string | null = null;

// Admin/OWNER recipients that should receive the daily report. Excludes
// system/seed users so QA rows never get a bell badge.
async function loadAdminRecipientIds(): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id, role: usersTable.role, isSystemUser: usersTable.isSystemUser })
    .from(usersTable);
  return rows
    .filter((u) => (u.role === "ADMIN" || u.role === "OWNER") && !u.isSystemUser)
    .map((u) => u.id);
}

/** Durable per-UTC-day guard: has the automatic delivery already run today? */
async function alreadyDeliveredToday(now: Date): Promise<boolean> {
  const dayStart = startOfUtcDay(now);
  const prior = await db
    .select({ id: adminActionAuditLogTable.id })
    .from(adminActionAuditLogTable)
    .where(
      and(
        eq(adminActionAuditLogTable.action, DELIVERY_AUDIT_ACTION),
        gte(adminActionAuditLogTable.createdAt, dayStart),
      ),
    )
    .limit(1);
  return prior.length > 0;
}

/**
 * Generate today's Household Report and deliver its plain-English summary to all
 * admins, once per UTC day. Returns a structured result; never throws.
 *
 * `force` bypasses BOTH the target-hour gate and the per-day dedupe — it exists
 * only for tests / an explicit manual trigger. The interval always calls with
 * force=false.
 */
export async function runDailyReportDelivery(opts: {
  now?: Date;
  force?: boolean;
} = {}): Promise<DailyReportDeliveryResult> {
  const now = opts.now ?? new Date();
  const ranAt = now.toISOString();
  const reportDate = startOfUtcDay(now).toISOString().slice(0, 10);

  const skip = (reason: DailyReportSkipReason): DailyReportDeliveryResult => ({
    ranAt,
    reportDate,
    skipped: reason,
    reportId: null,
    recipients: 0,
    notified: 0,
    errors: 0,
  });

  // Guard 1 — deliver only at/after the target UTC hour (force bypasses).
  if (!opts.force && now.getUTCHours() < TARGET_DELIVERY_HOUR_UTC) {
    return skip("BEFORE_TARGET_HOUR");
  }

  // Guard 2 — at most once per UTC day (force bypasses). Cheap in-memory check
  // first, then the durable audit-log guard.
  if (!opts.force) {
    if (lastDeliveredDate === reportDate) return skip("ALREADY_DELIVERED");
    if (await alreadyDeliveredToday(now)) {
      lastDeliveredDate = reportDate;
      return skip("ALREADY_DELIVERED");
    }
  }

  // Generate (refresh) today's report — idempotent per-UTC-day upsert. System
  // actor: no generatedByUserId attribution.
  const report = await generateHouseholdReport({ generatedByUserId: null, now });

  // Deliver the plain-English summary to every admin as an in-app alert.
  const recipientIds = await loadAdminRecipientIds();
  let notified = 0;
  let errors = 0;
  for (const recipientId of recipientIds) {
    try {
      await upsertAlertOnce(recipientId, {
        alertType: `${ALERT_TYPE_PREFIX}:${reportDate}`,
        severity: "info",
        title: "Daily trading-team report is ready",
        message: report.rubySummary,
        source: "system",
        actionLabel: "Open the team report",
        actionTarget: REPORT_PAGE_TARGET,
      });
      notified += 1;
    } catch (e) {
      errors += 1;
      logger.warn({ err: e, recipientId }, "daily_household_report_alert_failed");
    }
  }

  // One fail-soft audit row recording the automatic generation + delivery. This
  // doubles as the durable per-day guard. System actor (adminId NULL).
  try {
    await db.insert(adminActionAuditLogTable).values({
      adminId: null,
      adminRole: "SYSTEM",
      action: DELIVERY_AUDIT_ACTION,
      beforeState: {},
      afterState: {
        reportId: report.reportId,
        reportDate: report.reportDate,
        recipients: recipientIds.length,
        notified,
        deliveryErrors: errors,
      },
      reason: "automatic daily household report generation + delivery (observation only)",
    });
  } catch (e) {
    errors += 1;
    logger.warn({ err: e }, "daily_household_report_audit_failed");
  }

  lastDeliveredDate = reportDate;

  return {
    ranAt,
    reportDate,
    skipped: null,
    reportId: report.reportId,
    recipients: recipientIds.length,
    notified,
    errors,
  };
}

let schedulerTimer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Start the background scheduler. Idempotent (a second call is a no-op). The
 * interval is unref'd so it never holds the process open on its own. Each tick
 * runs a SYSTEM delivery attempt; the target-hour + per-day guards decide
 * whether it actually does work.
 */
export function startDailyHouseholdReportScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    if (running) return;
    running = true;
    runDailyReportDelivery()
      .then((r) => {
        if (!r.skipped) {
          logger.info(
            { reportDate: r.reportDate, recipients: r.recipients, notified: r.notified, errors: r.errors },
            "daily_household_report_delivered",
          );
        }
      })
      .catch((err) => logger.warn({ err }, "daily_household_report_scheduler_sweep_failed"))
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS).unref();
  logger.info(
    { intervalMs: SWEEP_INTERVAL_MS, targetHourUtc: TARGET_DELIVERY_HOUR_UTC },
    "daily_household_report_scheduler_started (advisory/observation only; admin in-app delivery)",
  );
}

export function stopDailyHouseholdReportScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
