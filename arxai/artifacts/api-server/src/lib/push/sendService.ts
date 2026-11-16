// Phase 22D — Real web-push send service.
// SAFETY:
// - Strictly user-scoped: only sends to userPushSubscriptionsTable rows whose
//   userId matches the supplied userId. Never sends to another user.
// - Fail-closed when VAPID env is missing — returns {sent:0, configured:false}.
// - Auto-disables (status='revoked') any subscription that web-push reports as
//   410/404 (gone/not-found), so we never retry dead endpoints forever.
// - Respects per-user notification preferences (pushEnabled). CRITICAL severity
//   bypasses pushEnabled gate but still requires VAPID + subscription.
// - VAPID_PRIVATE_KEY is read from env only; never logged, never returned.
// - Payload is intentionally minimal: title/body/type/notificationId/url. We
//   never embed secrets, broker tokens, or trade execution instructions.
import { db, userPushSubscriptionsTable, userNotificationPreferencesTable, alertDeliveryLogsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import webpush from "web-push";
import { logger } from "../logger.js";

// (Unified Alerts QA-fix) Severity rank for the minimumPushSeverity gate.
const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };
function severityAtLeast(actual: string | undefined, threshold: string | undefined): boolean {
  const a = SEVERITY_RANK[String(actual ?? "info").toLowerCase()] ?? 0;
  const t = SEVERITY_RANK[String(threshold ?? "info").toLowerCase()] ?? 0;
  return a >= t;
}

// (Unified Alerts QA-fix) Append-only delivery audit. Never stores tokens,
// endpoints, payload bodies, or upstream errors — only short status codes.
async function logDelivery(args: {
  userId: number;
  channel: "in_app" | "push";
  status: "delivered" | "failed" | "revoked" | "skipped";
  failureReason?: string | null;
  severity?: string | null;
  category?: string | null;
  alertId?: number | null;
}): Promise<void> {
  try {
    await db.insert(alertDeliveryLogsTable).values({
      userId: args.userId,
      alertId: args.alertId ?? null,
      deliveryChannel: args.channel,
      deliveryStatus: args.status,
      failureReason: args.failureReason ?? null,
      severity: args.severity ?? null,
      category: args.category ?? null,
      deliveredAt: args.status === "delivered" ? new Date() : null,
    });
  } catch (err) {
    // Audit logging must never break delivery. Log and move on.
    logger.warn({ err: String(err).slice(0, 200) }, "[push] alert_delivery_logs insert failed");
  }
}

let vapidConfigured = false;
function configureVapidOnce(): boolean {
  if (vapidConfigured) return true;
  const pub = process.env["VAPID_PUBLIC_KEY"];
  const priv = process.env["VAPID_PRIVATE_KEY"];
  const subject = process.env["VAPID_SUBJECT"] ?? "mailto:noreply@arx.ai";
  if (!pub || !priv) return false;
  try {
    webpush.setVapidDetails(subject, pub, priv);
    vapidConfigured = true;
    return true;
  } catch (err) {
    logger.error({ err: String(err).slice(0, 200) }, "[push] setVapidDetails failed");
    return false;
  }
}

export function isPushConfigured(): boolean {
  return Boolean(process.env["VAPID_PUBLIC_KEY"] && process.env["VAPID_PRIVATE_KEY"]);
}

export interface PushPayload {
  title: string;
  body: string;
  type?: string;            // notification category, e.g. "risk", "system"
  notificationId?: number | string;
  url?: string;             // safe deep link; receiver decides where to focus
  createdAt?: string;
  // (Unified Alerts QA-fix) severity is consulted by both the
  // minimumPushSeverity preference gate and the alert_delivery_logs audit.
  severity?: "info" | "warning" | "critical";
}

export interface SendResult {
  configured: boolean;
  sent: number;
  failed: number;
  revoked: number;
  reason?: string;
}

/**
 * Send a push notification to one user across all their active subscriptions.
 * - userId: must come from server-side session (never from client args).
 * - opts.bypassPreference: only true for CRITICAL safety/risk events; default
 *   false means we honor the user's pushEnabled preference.
 */
export async function sendPushToUser(
  userId: number,
  payload: PushPayload,
  opts: { bypassPreference?: boolean } = {},
): Promise<SendResult> {
  const severity = payload.severity ?? "info";
  const category = payload.type ?? null;
  const alertId = typeof payload.notificationId === "number" ? payload.notificationId : null;

  if (!configureVapidOnce()) {
    await logDelivery({ userId, channel: "push", status: "skipped", failureReason: "vapid_not_configured", severity, category, alertId });
    return { configured: false, sent: 0, failed: 0, revoked: 0, reason: "vapid_not_configured" };
  }

  // Preference check (CRITICAL bypasses).
  if (!opts.bypassPreference) {
    const [prefs] = await db
      .select()
      .from(userNotificationPreferencesTable)
      .where(eq(userNotificationPreferencesTable.userId, userId))
      .limit(1);
    if (prefs && prefs.pushEnabled === false) {
      await logDelivery({ userId, channel: "push", status: "skipped", failureReason: "push_disabled_by_user", severity, category, alertId });
      return { configured: true, sent: 0, failed: 0, revoked: 0, reason: "push_disabled_by_user" };
    }
    // (Unified Alerts QA-fix) Honor minimumPushSeverity. CRITICAL never blocked here.
    const minThreshold = (prefs as { minimumPushSeverity?: string } | undefined)?.minimumPushSeverity ?? "info";
    if (severity !== "critical" && !severityAtLeast(severity, minThreshold)) {
      await logDelivery({ userId, channel: "push", status: "skipped", failureReason: "below_min_severity", severity, category, alertId });
      return { configured: true, sent: 0, failed: 0, revoked: 0, reason: "below_min_severity" };
    }
  }

  const subs = await db
    .select()
    .from(userPushSubscriptionsTable)
    .where(and(
      eq(userPushSubscriptionsTable.userId, userId),
      eq(userPushSubscriptionsTable.status, "active"),
    ));

  if (subs.length === 0) {
    await logDelivery({ userId, channel: "push", status: "skipped", failureReason: "no_active_subscription", severity, category, alertId });
    return { configured: true, sent: 0, failed: 0, revoked: 0, reason: "no_active_subscription" };
  }

  // Build a minimal, secret-free payload. Cap sizes defensively.
  const safePayload = JSON.stringify({
    title: String(payload.title ?? "ARX AI").slice(0, 120),
    body: String(payload.body ?? "").slice(0, 240),
    type: payload.type ? String(payload.type).slice(0, 32) : undefined,
    notificationId: payload.notificationId ?? undefined,
    url: payload.url && /^\/[A-Za-z0-9/_\-?=&.%]*$/.test(payload.url) ? payload.url : "/notifications",
    createdAt: payload.createdAt ?? new Date().toISOString(),
    safetyMode: "paper_only",
    liveLocked: true,
  });

  let sent = 0;
  let failed = 0;
  let revoked = 0;
  await Promise.all(subs.map(async (sub) => {
    let parsed: { endpoint: string; keys?: { p256dh?: string; auth?: string } } | null = null;
    try {
      parsed = JSON.parse(sub.subscriptionJson);
    } catch {
      // Malformed row — disable so we never try again.
      await db.update(userPushSubscriptionsTable)
        .set({ status: "failed", revokedAt: new Date() })
        .where(eq(userPushSubscriptionsTable.id, sub.id));
      revoked++;
      return;
    }
    if (!parsed?.endpoint || !parsed.keys?.p256dh || !parsed.keys?.auth) {
      await db.update(userPushSubscriptionsTable)
        .set({ status: "failed", revokedAt: new Date() })
        .where(eq(userPushSubscriptionsTable.id, sub.id));
      revoked++;
      return;
    }
    try {
      await webpush.sendNotification(
        { endpoint: parsed.endpoint, keys: { p256dh: parsed.keys.p256dh, auth: parsed.keys.auth } },
        safePayload,
        { TTL: 60 * 30 },
      );
      sent++;
      await db.update(userPushSubscriptionsTable)
        .set({ lastUsedAt: new Date() })
        .where(eq(userPushSubscriptionsTable.id, sub.id));
      await logDelivery({ userId, channel: "push", status: "delivered", severity, category, alertId });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode ?? 0;
      if (status === 404 || status === 410) {
        await db.update(userPushSubscriptionsTable)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(eq(userPushSubscriptionsTable.id, sub.id));
        revoked++;
        await logDelivery({ userId, channel: "push", status: "revoked", failureReason: "endpoint_gone", severity, category, alertId });
      } else {
        failed++;
        logger.warn({ status, subId: sub.id }, "[push] send failed");
        await logDelivery({ userId, channel: "push", status: "failed", failureReason: `send_error_${status || "unknown"}`, severity, category, alertId });
      }
    }
  }));

  return { configured: true, sent, failed, revoked };
}

/**
 * Returns counts for the assistant/UI to render honest status.
 */
export async function getPushSummaryForUser(userId: number) {
  const subs = await db
    .select({ status: userPushSubscriptionsTable.status })
    .from(userPushSubscriptionsTable)
    .where(eq(userPushSubscriptionsTable.userId, userId));
  const active = subs.filter((s) => s.status === "active").length;
  const revoked = subs.filter((s) => s.status === "revoked" || s.status === "failed").length;
  const [prefs] = await db
    .select({ pushEnabled: userNotificationPreferencesTable.pushEnabled })
    .from(userNotificationPreferencesTable)
    .where(eq(userNotificationPreferencesTable.userId, userId))
    .limit(1);
  return {
    configured: isPushConfigured(),
    activeSubscriptions: active,
    revokedSubscriptions: revoked,
    pushEnabled: prefs?.pushEnabled ?? false,
  };
}
