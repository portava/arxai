// Scheduled expiring-registration-keys admin email digest.
//
// WHAT: A lightweight background scheduler that, once per UTC day at/after a
//   target hour, collects PENDING registration keys whose expiry falls within a
//   configurable look-ahead window and emails every admin/OWNER a masked digest
//   so they can extend or revoke the keys before they lapse — without opening
//   the dashboard.
//
// NO-NOISE RULE: when nothing is expiring in the window, NO email is sent and NO
//   durable "sent" marker is written. An in-memory empty-check marker avoids
//   redundant DB scans for the rest of the UTC day.
//
// SAFETY / SCOPE (inviolable):
//   * OBSERVATION ONLY. Reads beta_invites (read-only) + the users table for
//     admin recipients, sends email, and writes ONE durable audit row when a
//     digest is actually sent. NOTHING here trades, queues a command, gates, or
//     touches the live pipeline. It never mutates beta_invites.
//   * Raw keys are never available here — only the masked display prefix is sent.
//   * Admin-only delivery: recipients are exclusively non-system users whose role
//     is ADMIN or OWNER and who have an email address.
//   * Idempotent: at most one digest per UTC day (durable audit-log guard + an
//     in-memory fast path).
//   * Fail-soft: any failure is caught + logged; never crashes the process and
//     never holds it open (the interval is unref'd). First cycle after one
//     interval, so server start is never blocked.

import {
  betaInvitesRepo,
  db,
  adminActionAuditLogTable,
  usersTable,
} from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import type { ExpiringKeyDigestItem } from "@workspace/domain/email";
import { logger } from "../logger.js";
import {
  sendExpiringKeysDigestEmail,
  type ExpiringKeysDigestEmailInput,
} from "../email/expiringKeysDigestEmail.js";
import { isEmailNotConfiguredError } from "../email/resend.js";

/**
 * Send seam for the digest. Defaults to the real Resend-backed
 * `sendExpiringKeysDigestEmail`; tests inject a stub so the positive delivery
 * path can be asserted WITHOUT any real email leaving the environment. The
 * production interval never passes this — it always uses the real sender.
 */
export type SendExpiringKeysDigestEmailFn = (
  input: ExpiringKeysDigestEmailInput,
) => Promise<{ id: string }>;

// How often the scheduler wakes to check whether today's digest is due. The
// check is cheap and runs well off any request hot path.
const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

// Deliver at/after this UTC hour so the digest reflects a settled day.
const TARGET_DELIVERY_HOUR_UTC = clampHour(
  parseIntEnv(process.env.REGISTRATION_KEY_DIGEST_HOUR_UTC, 13),
);

// Look-ahead window (days). Keys lapsing within this many days are included.
// Exported so the in-app admin "expiring soon" view reuses the SAME window as
// the email digest — the dashboard list and the email stay in exact parity.
export const WINDOW_DAYS = clampWindow(
  parseIntEnv(process.env.REGISTRATION_KEY_DIGEST_WINDOW_DAYS, 7),
);

const DELIVERY_AUDIT_ACTION = "REGISTRATION_KEY_EXPIRY_DIGEST_SENT";

function parseIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampHour(h: number): number {
  if (!Number.isFinite(h) || h < 0) return 0;
  if (h > 23) return 23;
  return Math.floor(h);
}

function clampWindow(d: number): number {
  if (!Number.isFinite(d) || d < 1) return 7;
  if (d > 90) return 90;
  return Math.floor(d);
}

function resolvePublicOrigin(): string {
  const configured = process.env.APP_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const published = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (published) return `https://${published}`;
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (dev) return `https://${dev}`;
  return "http://localhost";
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

// In-memory fast paths so a healthy process answers without a DB read. The
// durable audit-log guard remains the source of truth for "sent" across
// restarts; the empty marker is intentionally in-memory only.
let lastSentDate: string | null = null;
let lastEmptyCheckDate: string | null = null;

export interface AdminRecipient {
  id: number;
  email: string;
}

/** Non-system ADMIN/OWNER users with an email address. */
export async function loadAdminRecipients(): Promise<AdminRecipient[]> {
  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      role: usersTable.role,
      isSystemUser: usersTable.isSystemUser,
    })
    .from(usersTable);
  return rows
    .filter(
      (u) =>
        (u.role === "ADMIN" || u.role === "OWNER") &&
        !u.isSystemUser &&
        !!u.email &&
        u.email.includes("@"),
    )
    .map((u) => ({ id: u.id, email: u.email }));
}

/** Durable per-UTC-day guard: has a digest already been sent today? */
async function alreadySentToday(now: Date): Promise<boolean> {
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

export type ExpiringKeysDigestSkipReason =
  | "BEFORE_TARGET_HOUR"
  | "ALREADY_SENT"
  | "NOTHING_EXPIRING"
  | "NO_RECIPIENTS"
  | "EMAIL_NOT_CONFIGURED"
  | "DELIVERY_FAILED";

export interface ExpiringKeysDigestResult {
  ranAt: string;
  reportDate: string;
  skipped: ExpiringKeysDigestSkipReason | null;
  windowDays: number;
  expiringCount: number;
  recipients: number;
  delivered: number;
  errors: number;
}

/**
 * Collect expiring keys and email the masked digest to all admins, once per UTC
 * day. Returns a structured result; never throws.
 *
 * `force` bypasses the target-hour gate AND the per-day dedupe (tests / manual
 * trigger only). The interval always calls with force=false.
 */
export async function runExpiringKeysDigest(opts: {
  now?: Date;
  force?: boolean;
  /** Test-only send seam (see SendExpiringKeysDigestEmailFn). Defaults to the
   *  real Resend-backed sender — production never overrides this. */
  sendDigestEmail?: SendExpiringKeysDigestEmailFn;
} = {}): Promise<ExpiringKeysDigestResult> {
  const now = opts.now ?? new Date();
  const sendDigestEmail = opts.sendDigestEmail ?? sendExpiringKeysDigestEmail;
  const ranAt = now.toISOString();
  const reportDate = startOfUtcDay(now).toISOString().slice(0, 10);

  const skip = (reason: ExpiringKeysDigestSkipReason): ExpiringKeysDigestResult => ({
    ranAt,
    reportDate,
    skipped: reason,
    windowDays: WINDOW_DAYS,
    expiringCount: 0,
    recipients: 0,
    delivered: 0,
    errors: 0,
  });

  // Guard 1 — deliver only at/after the target UTC hour (force bypasses).
  if (!opts.force && now.getUTCHours() < TARGET_DELIVERY_HOUR_UTC) {
    return skip("BEFORE_TARGET_HOUR");
  }

  // Guard 2 — at most once per UTC day (force bypasses).
  if (!opts.force) {
    if (lastSentDate === reportDate) return skip("ALREADY_SENT");
    if (await alreadySentToday(now)) {
      lastSentDate = reportDate;
      return skip("ALREADY_SENT");
    }
    // Cheap fast path: already scanned today and found nothing.
    if (lastEmptyCheckDate === reportDate) return skip("NOTHING_EXPIRING");
  }

  // Collect expiring keys (read-only). No-noise rule: nothing → no email.
  const keys = await betaInvitesRepo.listExpiringPendingKeys(WINDOW_DAYS, now);
  if (keys.length === 0) {
    if (!opts.force) lastEmptyCheckDate = reportDate;
    return skip("NOTHING_EXPIRING");
  }

  const recipients = await loadAdminRecipients();
  if (recipients.length === 0) {
    // Mark empty-check so we don't re-scan repeatedly; no durable "sent" row.
    if (!opts.force) lastEmptyCheckDate = reportDate;
    logger.warn({ expiringCount: keys.length }, "expiring_keys_digest_no_recipients");
    return { ...skip("NO_RECIPIENTS"), expiringCount: keys.length };
  }

  const items: ExpiringKeyDigestItem[] = keys.map((k) => ({
    maskedKey: betaInvitesRepo.maskArxKey(k.keyPrefix) ?? "ARX-••••-****",
    daysLeft: betaInvitesRepo.daysUntilExpiry(k.expiresAt, now),
    assignedEmail: k.email,
    roleGrant: k.roleGrant,
    expiresAtIso: k.expiresAt.toISOString(),
  }));

  const manageLink = `${resolvePublicOrigin()}/admin/beta-control`;

  let delivered = 0;
  let errors = 0;
  let emailNotConfigured = false;
  for (const recipient of recipients) {
    try {
      await sendDigestEmail({
        to: recipient.email,
        items,
        windowDays: WINDOW_DAYS,
        manageLink,
      });
      delivered += 1;
    } catch (e) {
      errors += 1;
      if (isEmailNotConfiguredError(e)) emailNotConfigured = true;
      logger.warn(
        { err: String(e), recipientId: recipient.id },
        "expiring_keys_digest_send_failed",
      );
    }
  }

  // If NOTHING was delivered we must NOT write a durable "sent" marker and must
  // NOT set the in-memory guard — otherwise a transient transport outage (or an
  // unconfigured email provider) would silently suppress the whole digest for
  // the rest of the UTC day. Leaving both unset lets the next interval retry and
  // a later configured/recovered run the same day still deliver.
  if (delivered === 0) {
    const reason: ExpiringKeysDigestSkipReason = emailNotConfigured
      ? "EMAIL_NOT_CONFIGURED"
      : "DELIVERY_FAILED";
    logger.warn(
      { expiringCount: keys.length, recipients: recipients.length, errors, reason },
      "expiring_keys_digest_not_delivered",
    );
    return {
      ...skip(reason),
      expiringCount: keys.length,
      recipients: recipients.length,
      errors,
    };
  }

  // One fail-soft audit row recording the automatic send — also the durable
  // per-day guard. System actor (adminId NULL). Masked key prefixes only.
  try {
    await db.insert(adminActionAuditLogTable).values({
      adminId: null,
      adminRole: "SYSTEM",
      action: DELIVERY_AUDIT_ACTION,
      beforeState: {},
      afterState: {
        reportDate,
        windowDays: WINDOW_DAYS,
        expiringCount: keys.length,
        recipients: recipients.length,
        delivered,
        deliveryErrors: errors,
        keyPrefixes: keys.map((k) => k.keyPrefix ?? null),
      },
      reason: "automatic expiring-registration-keys admin email digest (observation only)",
    });
  } catch (e) {
    errors += 1;
    logger.warn({ err: String(e) }, "expiring_keys_digest_audit_failed");
  }

  lastSentDate = reportDate;

  return {
    ranAt,
    reportDate,
    skipped: null,
    windowDays: WINDOW_DAYS,
    expiringCount: keys.length,
    recipients: recipients.length,
    delivered,
    errors,
  };
}

let schedulerTimer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Start the background scheduler. Idempotent (a second call is a no-op). The
 * interval is unref'd so it never holds the process open on its own.
 */
export function startExpiringKeysDigestWorker(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    if (running) return;
    running = true;
    runExpiringKeysDigest()
      .then((r) => {
        if (!r.skipped) {
          logger.info(
            {
              reportDate: r.reportDate,
              windowDays: r.windowDays,
              expiringCount: r.expiringCount,
              recipients: r.recipients,
              delivered: r.delivered,
              errors: r.errors,
            },
            "expiring_keys_digest_delivered",
          );
        }
      })
      .catch((err) => logger.warn({ err: String(err) }, "expiring_keys_digest_sweep_failed"))
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS).unref();
  logger.info(
    { intervalMs: SWEEP_INTERVAL_MS, targetHourUtc: TARGET_DELIVERY_HOUR_UTC, windowDays: WINDOW_DAYS },
    "expiring_keys_digest_worker_started (observation only; admin email digest)",
  );
}

export function stopExpiringKeysDigestWorker(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
