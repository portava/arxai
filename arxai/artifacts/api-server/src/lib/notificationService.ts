// Phase 10E — Central event service.
// Provides createNotification / createActivityEvent / createNotificationAndActivity.
// Race-safe dedupe via UNIQUE (userId, type, entityType, entityId, bucket=hour) +
// ON CONFLICT DO NOTHING. Respects per-user preferences and quiet hours for
// non-critical events. Critical security/risk alerts always pass.
//
// SAFETY: never accept userId from client; never log raw bridge tokens or any
// secret-named fields. Caller payloads are scrubbed defensively.
import { db, userNotificationsTable, userNotificationPreferencesTable, userActivityTimelineTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

const SECRET_KEY_RE = /token|secret|password|bridge|api[_-]?key|authorization|cookie|x-mt5/i;
const SECRET_VAL_RE = /MT5_BRIDGE_TOKEN|X-MT5-Bridge-Token/i;

function scrubText(v: string): string {
  return SECRET_VAL_RE.test(v) ? "[REDACTED]" : v;
}
function scrubValue(v: unknown, depth = 0): unknown {
  if (v == null) return v;
  if (depth > 8) return "[REDACTED_DEPTH_LIMIT]";
  if (typeof v === "string") return scrubText(v);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) out[k] = "[REDACTED]";
      else out[k] = scrubValue(val, depth + 1);
    }
    return out;
  }
  return v;
}
function scrubMeta(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!obj) return {};
  return scrubValue(obj) as Record<string, unknown>;
}

const PREF_MAP: Record<string, keyof typeof userNotificationPreferencesTable.$inferSelect> = {
  mt5: "mt5StatusEnabled",
  risk: "riskAlertsEnabled",
  trade: "tradeEventsEnabled",
  ai: "aiCoachingEnabled",
  playbook: "playbookChecklistEnabled",
  journal: "journalRemindersEnabled",
  session: "sessionRemindersEnabled",
  security: "securityAlertsEnabled",
};

export async function ensurePrefs(userId: number) {
  const existing = await db.select().from(userNotificationPreferencesTable).where(eq(userNotificationPreferencesTable.userId, userId)).limit(1);
  if (existing[0]) return existing[0];
  const ins = await db.insert(userNotificationPreferencesTable).values({ userId }).onConflictDoNothing({ target: userNotificationPreferencesTable.userId }).returning();
  if (ins[0]) return ins[0];
  const re = await db.select().from(userNotificationPreferencesTable).where(eq(userNotificationPreferencesTable.userId, userId)).limit(1);
  return re[0]!;
}

function inQuietHours(prefs: { quietHoursEnabled: boolean; quietHoursStart: string | null; quietHoursEnd: string | null }): boolean {
  if (!prefs.quietHoursEnabled || !prefs.quietHoursStart || !prefs.quietHoursEnd) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = prefs.quietHoursStart.split(":").map(Number);
  const [eh, em] = prefs.quietHoursEnd.split(":").map(Number);
  const start = (sh ?? 0) * 60 + (sm ?? 0);
  const end = (eh ?? 0) * 60 + (em ?? 0);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

export type NotifyPayload = {
  notificationType: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message?: string;
  source: "mt5" | "risk" | "session" | "trade" | "ai" | "playbook" | "journal" | "security" | "system";
  entityType?: string | null;
  entityId?: number | null;
  actionLabel?: string | null;
  actionTarget?: string | null;
  // T024 — dedupe cooldown window. The dedupe bucket = floor(now / cooldownMs).
  // Defaults to 1h. A *persistent* condition (e.g. "held too long") should pass
  // a longer window so repeated emissions collapse into a single notification
  // whose repeatCount + lastOccurrenceAt are bumped, instead of spawning a new
  // row each hour. Callers MUST also pass a STABLE (entityType, entityId) for
  // the same logical condition or dedupe cannot collapse.
  cooldownMs?: number;
};

export type ActivityPayload = {
  eventType: string;
  title: string;
  description?: string;
  source?: string;
  entityType?: string | null;
  entityId?: number | null;
  metadata?: Record<string, unknown>;
};

export async function createNotification(userId: number, p: NotifyPayload) {
  const prefs = await ensurePrefs(userId);
  // Critical security/risk alerts always pass; non-critical respect per-source toggles + quiet hours.
  if (p.severity !== "critical") {
    const prefKey = PREF_MAP[p.source];
    if (prefKey && prefs[prefKey] === false) return null;
    if (!prefs.inAppEnabled) return null;
    if (inQuietHours(prefs)) return null;
  }
  // T024 — dedupe bucket is configurable. A longer cooldown collapses a
  // persistent condition (e.g. "held too long") into one row whose
  // repeatCount + lastOccurrenceAt are bumped, instead of a new row each hour.
  const windowMs = p.cooldownMs && p.cooldownMs > 0 ? p.cooldownMs : 60 * 60_000;
  const bucket = Math.floor(Date.now() / windowMs);
  // Use non-null sentinels so Postgres UNIQUE actually collides (NULLs don't).
  const entityType = p.entityType ?? "_none_";
  const entityId = p.entityId ?? 0;
  const now = new Date();
  const row = {
    userId, notificationType: p.notificationType, severity: p.severity,
    title: scrubText(p.title), message: scrubText(p.message ?? ""), source: p.source,
    entityType, entityId,
    actionLabel: p.actionLabel ?? null, actionTarget: p.actionTarget ?? null,
    deliveredInApp: true, deliveredPush: false, bucket,
  };
  // Use returning() so we can detect whether INSERT actually produced a new
  // row (vs. dedupe collision). Only true new inserts should trigger a push.
  const inserted = await db.insert(userNotificationsTable).values(row).onConflictDoNothing({
    target: [userNotificationsTable.userId, userNotificationsTable.notificationType, userNotificationsTable.entityType, userNotificationsTable.entityId, userNotificationsTable.bucket],
  }).returning();
  const isFreshInsert = inserted.length > 0;
  // T024 — on dedupe collision, COLLAPSE: bump repeatCount + lastOccurrenceAt so
  // the UI can show "· N repeated · latest <time>" instead of N duplicate rows.
  // We deliberately do NOT resurface a read/dismissed alert (no status reset),
  // so honouring the user's dismissal is preserved; a genuinely new condition
  // only re-fires once the cooldown bucket rolls over.
  if (!isFreshInsert) {
    await db.update(userNotificationsTable)
      .set({ repeatCount: sql`${userNotificationsTable.repeatCount} + 1`, lastOccurrenceAt: now, updatedAt: now })
      .where(and(
        eq(userNotificationsTable.userId, userId),
        eq(userNotificationsTable.notificationType, p.notificationType),
        eq(userNotificationsTable.entityType, entityType),
        eq(userNotificationsTable.entityId, entityId),
        eq(userNotificationsTable.bucket, bucket),
      ));
  }
  // Look up by full dedupe key so we always return the correct dedupe row.
  const found = isFreshInsert ? inserted : await db.select().from(userNotificationsTable)
    .where(and(
      eq(userNotificationsTable.userId, userId),
      eq(userNotificationsTable.notificationType, p.notificationType),
      eq(userNotificationsTable.entityType, entityType),
      eq(userNotificationsTable.entityId, entityId),
      eq(userNotificationsTable.bucket, bucket),
    ))
    .limit(1);
  const created = found[0] ?? null;
  // Phase 22D: opportunistically deliver to web-push if VAPID is configured AND
  // the user has push enabled AND has an active subscription. Best-effort —
  // never blocks creation, never throws to caller. CRITICAL bypasses preference
  // (already passed the in-app gate above for non-critical).
  // NOTE: only send push for FRESH inserts. Dedupe collisions return the
  // existing row but must not re-send push (would double-notify the user).
  if (created && isFreshInsert) {
    void import("./push/sendService.js").then(({ sendPushToUser }) =>
      sendPushToUser(userId, {
        title: created.title,
        body: created.message,
        type: created.notificationType,
        notificationId: created.id,
        url: created.actionTarget && created.actionTarget.startsWith("/") ? created.actionTarget : "/notifications",
        createdAt: created.createdAt?.toISOString?.() ?? new Date().toISOString(),
        severity: created.severity as "info" | "warning" | "critical",
      }, { bypassPreference: p.severity === "critical" }).then((r) => {
        if (r.sent > 0) {
          // Mark deliveredPush so observers can audit. Best-effort.
          return db.update(userNotificationsTable)
            .set({ deliveredPush: true, updatedAt: new Date() })
            .where(eq(userNotificationsTable.id, created.id));
        }
        return undefined;
      }),
    ).catch(() => undefined);
  }
  return created;
}

export async function createActivityEvent(userId: number, p: ActivityPayload) {
  const ins = await db.insert(userActivityTimelineTable).values({
    userId, eventType: p.eventType, title: scrubText(p.title),
    description: scrubText(p.description ?? ""), source: p.source ?? "system",
    entityType: p.entityType ?? null, entityId: p.entityId ?? null,
    metadata: scrubMeta(p.metadata),
  }).returning();
  return ins[0]!;
}

export async function createNotificationAndActivity(userId: number, n: NotifyPayload, a: ActivityPayload) {
  const [notif, act] = await Promise.all([
    createNotification(userId, n).catch(() => null),
    createActivityEvent(userId, a).catch(() => null),
  ]);
  return { notif, act };
}

// Helper: safe fire-and-forget wrapper. Errors never escape the caller path.
export function fireNotify(userId: number, p: NotifyPayload, a?: ActivityPayload) {
  if (a) {
    void createNotificationAndActivity(userId, p, a).catch(() => undefined);
  } else {
    void createNotification(userId, p).catch(() => undefined);
  }
}
export function fireActivity(userId: number, a: ActivityPayload) {
  void createActivityEvent(userId, a).catch(() => undefined);
}
