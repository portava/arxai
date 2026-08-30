// Phase 10A/10B/10C — Per-user notifications, preferences, push subscriptions.
// SAFETY: requireUser; scope by req.authUser.id; no userId from client; VAPID keys
// (public/private) are env-only and the private key is NEVER returned.
import { Router } from "express";
import { db, userNotificationsTable, userNotificationPreferencesTable, userPushSubscriptionsTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { requireUser } from "../lib/auth/middleware.js";
import { ensurePrefs, createActivityEvent } from "../lib/notificationService.js";
import { sendPushToUser, isPushConfigured, getPushSummaryForUser } from "../lib/push/sendService.js";

const router = Router();

// This envelope describes what THIS ROUTER can do, not what the platform can
// do. It used to assert `safetyMode: "paper_only"` and `liveLocked: true` —
// platform-wide claims that are false on a build that dispatches real orders,
// and that this router has no standing to make. It now states only the fact it
// can actually vouch for: nothing under /me/notifications* can place, modify or
// close an order.
const SAFETY_ENVELOPE = {
  surface: "notifications" as const,
  placesOrders: false as const,
  allowOrderExecution: false as const,
};

// ── Notifications ─────────────────────────────────────────────────────────
router.get("/me/notifications", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const source = typeof req.query.source === "string" ? req.query.source : null;
  const where = and(
    eq(userNotificationsTable.userId, userId),
    status ? eq(userNotificationsTable.status, status) : undefined,
    source ? eq(userNotificationsTable.source, source) : undefined,
  );
  const rows = await db.select().from(userNotificationsTable).where(where).orderBy(desc(userNotificationsTable.createdAt)).limit(200);
  const unread = rows.filter((r) => r.status === "unread").length;
  res.json({ notifications: rows, unread, isEmpty: rows.length === 0, ...SAFETY_ENVELOPE });
});

router.post("/me/notifications/:id/read", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const u = await db.update(userNotificationsTable).set({ status: "read", readAt: new Date(), updatedAt: new Date() })
    .where(and(eq(userNotificationsTable.id, id), eq(userNotificationsTable.userId, userId))).returning();
  if (!u[0]) { res.status(404).json({ error: "Not found" }); return; }
  void createActivityEvent(userId, { eventType: "notification_read", title: "Notification read",
    source: "system", entityType: "notification", entityId: id }).catch(() => undefined);
  res.json({ ...u[0], ...SAFETY_ENVELOPE });
});

router.post("/me/notifications/:id/dismiss", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const u = await db.update(userNotificationsTable).set({ status: "dismissed", dismissedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(userNotificationsTable.id, id), eq(userNotificationsTable.userId, userId))).returning();
  if (!u[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...u[0], ...SAFETY_ENVELOPE });
});

router.post("/me/notifications/read-all", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const u = await db.update(userNotificationsTable).set({ status: "read", readAt: new Date(), updatedAt: new Date() })
    .where(and(eq(userNotificationsTable.userId, userId), eq(userNotificationsTable.status, "unread"))).returning();
  res.json({ updated: u.length, ...SAFETY_ENVELOPE });
});

// T024 — Bulk multi-select actions. Every mutation is user-scoped (ids alone
// are never trusted: each UPDATE additionally filters by userId so a caller can
// only ever touch their OWN notifications). "dismiss" is a soft archive
// (status='dismissed') — it NEVER deletes the underlying notification row, and
// it touches nothing outside user_notifications (no trades/commands/ledger).
const BULK_MAX = 500;
router.post("/me/notifications/bulk", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const body = (req.body ?? {}) as { ids?: unknown; action?: unknown };
  const action = body.action;
  if (action !== "read" && action !== "unread" && action !== "dismiss") {
    res.status(400).json({ error: "invalid action (expected read|unread|dismiss)" }); return;
  }
  const ids = Array.isArray(body.ids)
    ? Array.from(new Set(body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)))
    : [];
  if (ids.length === 0) { res.status(400).json({ error: "ids must be a non-empty array of positive integers" }); return; }
  if (ids.length > BULK_MAX) { res.status(400).json({ error: `too many ids (max ${BULK_MAX})` }); return; }
  const now = new Date();
  const patch =
    action === "read" ? { status: "read", readAt: now, updatedAt: now }
    : action === "unread" ? { status: "unread", readAt: null, updatedAt: now }
    : { status: "dismissed", dismissedAt: now, updatedAt: now };
  const u = await db.update(userNotificationsTable).set(patch)
    .where(and(eq(userNotificationsTable.userId, userId), inArray(userNotificationsTable.id, ids))).returning();
  res.json({ action, requested: ids.length, updated: u.length, ...SAFETY_ENVELOPE });
});

// T024 — "Clear read" = soft-archive (dismiss) every already-read notification.
// Same safety posture: user-scoped, soft delete only, nothing outside this table.
router.post("/me/notifications/clear-read", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const now = new Date();
  const u = await db.update(userNotificationsTable).set({ status: "dismissed", dismissedAt: now, updatedAt: now })
    .where(and(eq(userNotificationsTable.userId, userId), eq(userNotificationsTable.status, "read"))).returning();
  res.json({ cleared: u.length, ...SAFETY_ENVELOPE });
});

// ── Preferences ───────────────────────────────────────────────────────────
const PREF_BOOL_KEYS = [
  "inAppEnabled", "pushEnabled", "emailEnabled", "mt5StatusEnabled", "riskAlertsEnabled",
  "tradeEventsEnabled", "aiCoachingEnabled", "playbookChecklistEnabled", "journalRemindersEnabled",
  "sessionRemindersEnabled", "securityAlertsEnabled", "quietHoursEnabled",
] as const;
const PREF_STR_KEYS = ["quietHoursStart", "quietHoursEnd", "timezone"] as const;

// RANK 77 — `minimumPushSeverity` is the push-delivery floor sendService.ts
// reads on every non-critical push. It was in NEITHER key list here and had no
// other writer anywhere in the repo, so no user, admin or script could ever
// change it: real gate code that no value could ever reach. It is accepted here
// with a strict enum (never a free string — an unrecognised value would make
// severityAtLeast() behave unpredictably on the delivery path).
export const PUSH_SEVERITY_VALUES = ["info", "warning", "critical"] as const;
type PushSeverity = (typeof PUSH_SEVERITY_VALUES)[number];
const isPushSeverity = (v: unknown): v is PushSeverity =>
  typeof v === "string" && (PUSH_SEVERITY_VALUES as readonly string[]).includes(v);

router.get("/me/notification-preferences", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const prefs = await ensurePrefs(userId);
  res.json({
    ...prefs,
    // The two facts the preference UI must state truthfully rather than imply:
    // CRITICAL cannot be silenced by any of these switches, and push delivery
    // additionally depends on server-side VAPID configuration.
    criticalAlwaysDelivered: true as const,
    pushConfigured: isPushConfigured(),
    ...SAFETY_ENVELOPE,
  });
});

router.patch("/me/notification-preferences", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  await ensurePrefs(userId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of PREF_BOOL_KEYS) if (typeof body[k] === "boolean") patch[k] = body[k];
  for (const k of PREF_STR_KEYS) if (typeof body[k] === "string" || body[k] === null) patch[k] = body[k];
  if ("minimumPushSeverity" in body) {
    if (!isPushSeverity(body["minimumPushSeverity"])) {
      // Refuse loudly rather than dropping the field — a silently ignored
      // preference write is exactly the failure this defect was made of.
      res.status(400).json({
        error: "INVALID_MINIMUM_PUSH_SEVERITY",
        allowed: PUSH_SEVERITY_VALUES,
        message: "minimumPushSeverity must be one of: info, warning, critical.",
      });
      return;
    }
    patch["minimumPushSeverity"] = body["minimumPushSeverity"];
  }
  const u = await db.update(userNotificationPreferencesTable).set(patch).where(eq(userNotificationPreferencesTable.userId, userId)).returning();
  res.json({
    ...u[0],
    // Echo exactly which keys were persisted so the client can never render a
    // "Saved" state for a field the server dropped.
    updatedFields: Object.keys(patch).filter((k) => k !== "updatedAt"),
    criticalAlwaysDelivered: true as const,
    pushConfigured: isPushConfigured(),
    ...SAFETY_ENVELOPE,
  });
});

// ── Push subscriptions (real web-push delivery when VAPID env present) ────
// Fail-closed when VAPID is unset: status reports configured:false, subscribe
// returns 202 stored:false, test returns 503. We never fabricate push.

router.get("/me/push/status", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const summary = await getPushSummaryForUser(userId);
  res.json({
    configured: summary.configured,
    publicKey: summary.configured ? process.env["VAPID_PUBLIC_KEY"] ?? null : null,
    activeSubscriptions: summary.activeSubscriptions,
    revokedSubscriptions: summary.revokedSubscriptions,
    pushEnabled: summary.pushEnabled,
    setupHint: summary.configured
      ? (summary.activeSubscriptions === 0
          ? "Push is configured. Enable it in your browser to receive notifications on this device."
          : null)
      : "Push notifications are not configured on this server yet.",
    ...SAFETY_ENVELOPE,
  });
});

router.post("/me/push/subscribe", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const body = req.body as { subscription?: { endpoint?: string }; deviceLabel?: string };
  const sub = body?.subscription;
  if (!sub || typeof sub.endpoint !== "string" || sub.endpoint.length < 10) {
    res.status(400).json({ error: "invalid subscription" }); return;
  }
  if (!isPushConfigured()) {
    // Gracefully accept the readiness intent but tell the client setup is pending.
    res.status(202).json({ stored: false, reason: "Push setup not configured yet", configured: false, ...SAFETY_ENVELOPE });
    return;
  }
  const endpointHash = createHash("sha256").update(sub.endpoint).digest("hex").slice(0, 32);
  const json = JSON.stringify(sub);
  const ua = (req.headers["user-agent"] ?? null) as string | null;
  // Upsert: same (userId, endpointHash) reactivates and refreshes the row so a
  // user re-enabling push on the same device never accumulates duplicates.
  await db.insert(userPushSubscriptionsTable).values({
    userId, endpointHash, subscriptionJson: json, userAgent: ua,
    deviceLabel: body.deviceLabel ?? null, status: "active", lastUsedAt: new Date(),
  }).onConflictDoUpdate({
    target: [userPushSubscriptionsTable.userId, userPushSubscriptionsTable.endpointHash],
    set: { subscriptionJson: json, userAgent: ua, status: "active", revokedAt: null, lastUsedAt: new Date() },
  });
  // Honor the user's intent: opting in via subscribe enables push preference.
  await ensurePrefs(userId);
  await db.update(userNotificationPreferencesTable)
    .set({ pushEnabled: true, updatedAt: new Date() })
    .where(eq(userNotificationPreferencesTable.userId, userId));
  void createActivityEvent(userId, { eventType: "settings_updated", title: "Push subscription added",
    source: "security", entityType: "push_subscription" }).catch(() => undefined);
  res.json({ stored: true, configured: true, ...SAFETY_ENVELOPE });
  void randomBytes;
});

// Send a test push only to the current user. Honest about each failure mode.
router.post("/me/push/test", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  if (!isPushConfigured()) {
    res.status(503).json({ ok: false, configured: false, reason: "vapid_not_configured",
      message: "Push notifications are not configured on this server yet.", ...SAFETY_ENVELOPE });
    return;
  }
  const result = await sendPushToUser(userId, {
    title: "ARX AI test push",
    body: "If you can read this, push notifications are working on this device.",
    type: "system",
    url: "/notifications",
  }, { bypassPreference: true });
  if (result.sent === 0 && result.reason === "no_active_subscription") {
    res.status(409).json({ ok: false, configured: true, reason: "no_active_subscription",
      message: "Push is configured, but this user has no active subscription. Enable push in your browser first.",
      ...SAFETY_ENVELOPE });
    return;
  }
  res.json({ ok: result.sent > 0, ...result, ...SAFETY_ENVELOPE });
});

router.post("/me/push/unsubscribe", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const endpoint = (req.body as { endpoint?: string })?.endpoint;
  const where = endpoint
    ? and(eq(userPushSubscriptionsTable.userId, userId), eq(userPushSubscriptionsTable.endpointHash, createHash("sha256").update(endpoint).digest("hex").slice(0, 32)))
    : eq(userPushSubscriptionsTable.userId, userId);
  const u = await db.update(userPushSubscriptionsTable).set({ status: "revoked", revokedAt: new Date() }).where(where).returning();
  res.json({ revoked: u.length, ...SAFETY_ENVELOPE });
});

export default router;
