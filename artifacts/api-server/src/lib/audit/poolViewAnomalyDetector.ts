// Phase Audit-Center — Shared Bridge Pool view anomaly detector.
//
// WHAT: A lightweight, scheduled detector that scans recent
// ALLOCATION_POOL_VIEWED rows in admin_action_audit_log and proactively
// raises an admin-facing alert when:
//   1. A brand-new (adminId, ipAddress) origin opens the Shared Bridge
//      Pool view for the first time (credential-theft / lateral-movement
//      signal), or
//   2. A single admin opens the pool more than N times in M minutes
//      (burst / scripted-access signal).
//
// SAFETY:
//   * READ-ONLY against admin_action_audit_log — never inserts, updates,
//     or deletes any audit row. The only writes are into user_alerts
//     (the existing per-user alerts surface that backs the bell badge),
//     scoped to ADMIN/OWNER recipients only.
//   * Admin-only: recipients are exclusively users whose role is
//     ADMIN or OWNER. IP addresses and admin emails only ever land in an
//     admin recipient's own alert row; non-admins never receive these.
//   * Idempotent: alert identity is encoded into the alertType, and
//     upsertAlertOnce dedupes per (userId, alertType, hourly bucket), so
//     a given anomaly raises at most one alert per recipient per hour
//     even though the sweep runs every minute.

import { db, adminActionAuditLogTable, usersTable } from "@workspace/db";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "../logger.js";
import { upsertAlertOnce } from "../../routes/meAlerts.js";

const POOL_VIEW_ACTION = "ALLOCATION_POOL_VIEWED";

// How often the detector sweeps.
const SWEEP_INTERVAL_MS = 60 * 1000; // every 60s
// The rolling window used for both "new origin" recency and burst counting.
const SCAN_WINDOW_MINUTES = 10;
// Burst threshold — more than this many views by one admin inside the window.
const BURST_THRESHOLD = 5;

// Alert type prefixes. The pair/admin identity is appended (hashed for the
// origin pair) so distinct anomalies get distinct idempotency slots while
// still collapsing to one-per-hour via the (userId, alertType, bucket) index.
const ALERT_TYPE_NEW_ORIGIN = "pool_view_new_origin";
const ALERT_TYPE_BURST = "pool_view_burst";

export interface PoolViewSweepResult {
  scanned: number;
  recipients: number;
  newOriginAlerts: number;
  burstAlerts: number;
  errors: number;
}

interface RecentView {
  id: number;
  adminId: number | null;
  ipAddress: string | null;
  createdAt: Date;
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function maskEmail(email: string | null): string {
  if (!email) return "unknown account";
  const at = email.indexOf("@");
  if (at <= 1) return email;
  const name = email.slice(0, at);
  const domain = email.slice(at);
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${"*".repeat(Math.max(1, name.length - head.length))}${domain}`;
}

// Admin/OWNER recipients that should receive security alerts. Excludes
// system/seed users so QA rows never get a bell badge.
async function loadAdminRecipientIds(): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id, role: usersTable.role, isSystemUser: usersTable.isSystemUser })
    .from(usersTable);
  return rows
    .filter((u) => (u.role === "ADMIN" || u.role === "OWNER") && !u.isSystemUser)
    .map((u) => u.id);
}

// Does this exact (adminId, ipAddress) pair appear in any pool-view row
// created BEFORE the rolling window? If not, the pair is brand-new.
async function pairSeenBefore(
  adminId: number,
  ipAddress: string,
  windowStart: Date,
): Promise<boolean> {
  const prior = await db
    .select({ id: adminActionAuditLogTable.id })
    .from(adminActionAuditLogTable)
    .where(
      and(
        eq(adminActionAuditLogTable.action, POOL_VIEW_ACTION),
        eq(adminActionAuditLogTable.adminId, adminId),
        eq(adminActionAuditLogTable.ipAddress, ipAddress),
        lt(adminActionAuditLogTable.createdAt, windowStart),
      ),
    )
    .limit(1);
  return prior.length > 0;
}

export async function sweepPoolViewAnomalies(
  now: Date = new Date(),
): Promise<PoolViewSweepResult> {
  const windowStart = new Date(now.getTime() - SCAN_WINDOW_MINUTES * 60_000);
  let newOriginAlerts = 0;
  let burstAlerts = 0;
  let errors = 0;

  // Read-only: recent pool-view rows inside the rolling window.
  const recent: RecentView[] = await db
    .select({
      id: adminActionAuditLogTable.id,
      adminId: adminActionAuditLogTable.adminId,
      ipAddress: adminActionAuditLogTable.ipAddress,
      createdAt: adminActionAuditLogTable.createdAt,
    })
    .from(adminActionAuditLogTable)
    .where(
      and(
        eq(adminActionAuditLogTable.action, POOL_VIEW_ACTION),
        gte(adminActionAuditLogTable.createdAt, windowStart),
      ),
    )
    .orderBy(desc(adminActionAuditLogTable.createdAt))
    .limit(500);

  if (recent.length === 0) {
    return { scanned: 0, recipients: 0, newOriginAlerts: 0, burstAlerts: 0, errors: 0 };
  }

  const recipientIds = await loadAdminRecipientIds();
  if (recipientIds.length === 0) {
    return { scanned: recent.length, recipients: 0, newOriginAlerts: 0, burstAlerts: 0, errors: 0 };
  }

  // Resolve subject emails for the admin ids we are about to mention.
  const subjectAdminIds = Array.from(
    new Set(recent.map((r) => r.adminId).filter((v): v is number => v !== null)),
  );
  const emailById = new Map<number, string | null>();
  if (subjectAdminIds.length > 0) {
    const subjects = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable);
    for (const s of subjects) {
      if (subjectAdminIds.includes(s.id)) emailById.set(s.id, s.email ?? null);
    }
  }

  // ── 1) New-origin detection ───────────────────────────────────────────────
  // Distinct (adminId, ip) pairs seen in the window where both are known.
  const seenPairKeys = new Set<string>();
  for (const v of recent) {
    if (v.adminId === null || !v.ipAddress) continue;
    const pairKey = `${v.adminId}|${v.ipAddress}`;
    if (seenPairKeys.has(pairKey)) continue;
    seenPairKeys.add(pairKey);

    try {
      const before = await pairSeenBefore(v.adminId, v.ipAddress, windowStart);
      if (before) continue; // not new

      const subjectEmail = maskEmail(emailById.get(v.adminId) ?? null);
      const alertType = `${ALERT_TYPE_NEW_ORIGIN}:${shortHash(pairKey)}`;
      for (const recipientId of recipientIds) {
        await upsertAlertOnce(recipientId, {
          alertType,
          severity: "warning",
          title: "New origin opened the Shared Bridge Pool",
          message:
            `A new admin/IP combination opened the Shared Bridge Pool view for the first time — ` +
            `${subjectEmail} from ${v.ipAddress}. If this was not an authorized operator, ` +
            `rotate credentials and review the access trail.`,
          source: "system",
          actionLabel: "Review pool access",
          actionTarget: "/admin/audit-center",
        });
      }
      newOriginAlerts += 1;
    } catch (e) {
      errors += 1;
      logger.warn({ err: e, adminId: v.adminId }, "pool_view_new_origin_alert_failed");
    }
  }

  // ── 2) Burst detection ────────────────────────────────────────────────────
  const countByAdmin = new Map<number, number>();
  for (const v of recent) {
    if (v.adminId === null) continue;
    countByAdmin.set(v.adminId, (countByAdmin.get(v.adminId) ?? 0) + 1);
  }
  for (const [adminId, count] of countByAdmin) {
    if (count <= BURST_THRESHOLD) continue;
    try {
      const subjectEmail = maskEmail(emailById.get(adminId) ?? null);
      const alertType = `${ALERT_TYPE_BURST}:${adminId}`;
      for (const recipientId of recipientIds) {
        await upsertAlertOnce(recipientId, {
          alertType,
          severity: "critical",
          title: "Rapid Shared Bridge Pool access detected",
          message:
            `${subjectEmail} opened the Shared Bridge Pool view ${count} times in the last ` +
            `${SCAN_WINDOW_MINUTES} minutes (threshold ${BURST_THRESHOLD}). Confirm this is an ` +
            `authorized operator before continuing.`,
          source: "system",
          actionLabel: "Review pool access",
          actionTarget: "/admin/audit-center",
        });
      }
      burstAlerts += 1;
    } catch (e) {
      errors += 1;
      logger.warn({ err: e, adminId }, "pool_view_burst_alert_failed");
    }
  }

  return {
    scanned: recent.length,
    recipients: recipientIds.length,
    newOriginAlerts,
    burstAlerts,
    errors,
  };
}

let detectorTimer: NodeJS.Timeout | null = null;
let running = false;

export function startPoolViewAnomalyDetector(): void {
  if (detectorTimer) return;
  detectorTimer = setInterval(() => {
    if (running) return;
    running = true;
    sweepPoolViewAnomalies()
      .then((r) => {
        if (r.newOriginAlerts > 0 || r.burstAlerts > 0 || r.errors > 0) {
          logger.info(r, "pool_view_anomaly_detector_swept");
        }
      })
      .catch((err) => logger.warn({ err }, "pool_view_anomaly_detector_sweep_failed"))
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS).unref();
  logger.info(
    { intervalMs: SWEEP_INTERVAL_MS, windowMinutes: SCAN_WINDOW_MINUTES, burstThreshold: BURST_THRESHOLD },
    "pool_view_anomaly_detector_started",
  );
}

export function stopPoolViewAnomalyDetector(): void {
  if (detectorTimer) {
    clearInterval(detectorTimer);
    detectorTimer = null;
  }
}
