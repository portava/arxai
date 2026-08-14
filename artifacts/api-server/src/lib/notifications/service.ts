// Build LL — Notification service.
//
// Centralized create/upsert with dedupe, severity routing, snooze respect,
// preference checks, and rich logging. Read/write is for alerts only — this
// service NEVER places trades, NEVER changes canPlaceTrades, NEVER calls MT5.

import {
  db,
  notificationsTable, notificationPreferencesTable,
  notificationLogsTable, notificationDigestsTable,
} from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { NotifyInput } from "./rules.js";

// ── secret redaction (LL hard rule) ─────────────────────────────────────────
const SECRET_KEY_RE = /(api[_-]?key|api[_-]?secret|password|passwd|pwd|bearer|secret|token|auth|credential)/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g, // JWT
  /\b(?:sk|pk|rk|whsec|xox[baprs])_[A-Za-z0-9_-]{12,}\b/g,               // Stripe/Slack-style
  /\bghp_[A-Za-z0-9]{20,}\b/g, /\bgho_[A-Za-z0-9]{20,}\b/g,             // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g,                                                // AWS access key
  /\b[A-Za-z0-9_-]{32,}\b/g,                                              // long opaque tokens
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,        // DB URIs (often contain creds)
  /(?:bearer\s+)[A-Za-z0-9._-]{12,}/gi,                                  // bearer <token>
];
const SECRET_KV_RE = /\b(api[_-]?key|api[_-]?secret|password|passwd|pwd|secret|token|auth|credential)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;}]+)/gi;
function scrubString(s: string): string {
  if (!s) return s;
  let out = s.replace(SECRET_KV_RE, (_m, k) => `${k}=[REDACTED]`);
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}
function scrubObject(o: unknown): unknown {
  if (o == null) return o;
  if (typeof o === "string") return scrubString(o);
  if (Array.isArray(o)) return o.map(scrubObject);
  if (typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) out[k] = "[REDACTED]";
      else out[k] = scrubObject(v);
    }
    return out;
  }
  return o;
}

// ── logging helper ──────────────────────────────────────────────────────────
async function logEvent(notificationId: string | null, eventType: string, severity: string, message: string, details: Record<string, unknown> = {}) {
  try {
    await db.insert(notificationLogsTable).values({
      notificationId, eventType, severity, message: scrubString(message),
      details: scrubObject(details) as Record<string, unknown>,
    });
  } catch { /* logging never throws */ }
}

// ── preferences ─────────────────────────────────────────────────────────────
type Prefs = typeof notificationPreferencesTable.$inferSelect;

// Phase-2: preferences row is per-user. New users get a fresh row on first call.
export async function getPreferences(userId: number): Promise<Prefs> {
  const [row] = await db.select().from(notificationPreferencesTable)
    .where(eq(notificationPreferencesTable.userId, userId)).limit(1);
  if (row) return row;
  const [created] = await db.insert(notificationPreferencesTable).values({ userId }).returning();
  return created;
}

export async function setPreferences(userId: number, input: Partial<Omit<Prefs, "id"|"createdAt"|"updatedAt"|"userId">>) {
  const cur = await getPreferences(userId);
  const merged = { ...cur, ...input, updatedAt: new Date() };
  // Hard rule: critical alerts cannot be turned off, safety_alerts cannot be disabled.
  merged.criticalAlertsAlwaysOn = true;
  merged.safetyAlertsEnabled = true;
  await db.update(notificationPreferencesTable)
    .set(merged)
    .where(eq(notificationPreferencesTable.id, cur.id));
  return getPreferences(userId);
}

function categoryEnabled(prefs: Prefs, type: string): boolean {
  switch (type) {
    case "SAFETY":   return true; // always on
    case "RISK":     return prefs.safetyAlertsEnabled;
    case "TRADE":    return prefs.tradeAlertsEnabled;
    case "LEARNING": return prefs.learningAlertsEnabled;
    case "COACH":    return prefs.coachAlertsEnabled;
    case "REPLAY":   return prefs.replayAlertsEnabled;
    case "DATA":     return prefs.dataAlertsEnabled;
    case "BROKER":   return prefs.brokerAlertsEnabled;
    case "SYSTEM":   return true;
    default:         return true;
  }
}

// ── core notify (upsert by dedupe_key, with severity-aware reactivation) ────
export interface NotifyResult {
  status: "CREATED" | "UPDATED" | "SKIPPED";
  notification: typeof notificationsTable.$inferSelect | null;
  reason?: string;
}

export async function notify(input: NotifyInput & { userId?: number | null }, opts: { idempotent?: boolean } = {}): Promise<NotifyResult> {
  // Phase-2: notifications without an explicit userId stay null (system-wide
  // events). When a userId is supplied, preferences are read for that user;
  // otherwise we fall back to user_id=1 (legacy / system) so secret-redaction,
  // category gating, and dedupe all keep working without per-call churn.
  const prefsUserId = typeof input.userId === "number" ? input.userId : 1;
  const prefs = await getPreferences(prefsUserId);
  const isCritical = input.severity === "CRITICAL";

  await logEvent(null, "EVENT_RECEIVED", input.severity, `Event from ${input.sourceBuild} type=${input.type} dedupe=${input.dedupeKey}`, {
    type: input.type, sourceBuild: input.sourceBuild,
  });

  // Preference gate (CRITICAL bypasses)
  if (!isCritical) {
    if (!prefs.inAppEnabled) {
      await logEvent(null, "PREF_BLOCKED", "INFO", "in_app_enabled=false", { dedupeKey: input.dedupeKey });
      return { status: "SKIPPED", notification: null, reason: "in_app_enabled=false" };
    }
    if (!categoryEnabled(prefs, input.type)) {
      await logEvent(null, "PREF_BLOCKED", "INFO", `category ${input.type} disabled`, { dedupeKey: input.dedupeKey });
      return { status: "SKIPPED", notification: null, reason: `category ${input.type} disabled` };
    }
  }

  // Scrub user-provided message/title/metadata for secrets.
  const safeTitle = scrubString(input.title);
  const safeMessage = scrubString(input.message);
  const safeMetadata = scrubObject(input.metadata ?? {}) as Record<string, unknown>;

  // Dedupe lookup
  const [existing] = await db.select().from(notificationsTable)
    .where(eq(notificationsTable.dedupeKey, input.dedupeKey)).limit(1);

  if (existing) {
    // Idempotent ingest re-runs of unchanged source rows must NOT bump repeat_count.
    // We compare the source identity tuple (sourceEventId, severity, message). If the
    // caller signals idempotent and nothing material changed, treat as SKIPPED.
    const incomingSourceId = input.sourceEventId ?? null;
    const sameSource =
      incomingSourceId !== null &&
      existing.sourceEventId === incomingSourceId &&
      existing.severity === input.severity &&
      existing.message === safeMessage;
    if (opts.idempotent && sameSource) {
      await logEvent(existing.notificationId, "INGEST_NOOP", "INFO",
        `Ingest re-run, no state change for dedupe=${input.dedupeKey}`, {});
      return { status: "SKIPPED", notification: existing, reason: "idempotent re-ingest" };
    }
    // Update repeat_count, refresh message/metadata, reactivate if CRITICAL.
    const newRepeat = existing.repeatCount + 1;
    let newStatus = existing.status;
    let newSnoozedUntil = existing.snoozedUntil;
    if (isCritical) {
      newStatus = "UNREAD"; // CRITICAL bypass snooze/dismiss
      newSnoozedUntil = null;
    }
    const [updated] = await db.update(notificationsTable).set({
      severity: input.severity,
      title: safeTitle,
      message: safeMessage,
      metadata: { ...((existing.metadata as Record<string, unknown>) ?? {}), ...safeMetadata, lastEventAt: new Date().toISOString() },
      repeatCount: newRepeat,
      status: newStatus,
      snoozedUntil: newSnoozedUntil,
      updatedAt: new Date(),
    }).where(eq(notificationsTable.id, existing.id)).returning();

    await logEvent(updated.notificationId, "NOTIFICATION_UPDATED", input.severity,
      `Updated existing notification (repeatCount=${newRepeat}${isCritical ? ", reactivated CRITICAL" : ""})`,
      { dedupeKey: input.dedupeKey });
    return { status: "UPDATED", notification: updated };
  }

  // Insert new
  const notificationId = `notif_${randomUUID()}`;
  const expiresAt = input.expiresAtMs ? new Date(input.expiresAtMs) : null;
  const [created] = await db.insert(notificationsTable).values({
    notificationId,
    userId: typeof input.userId === "number" ? input.userId : null,
    type: input.type,
    severity: input.severity,
    status: "UNREAD",
    title: safeTitle,
    message: safeMessage,
    sourceBuild: input.sourceBuild,
    sourceEventId: input.sourceEventId ?? null,
    symbol: input.symbol ?? null,
    relatedTradeId: input.relatedTradeId ?? null,
    relatedDecisionId: input.relatedDecisionId ?? null,
    relatedDebriefId: input.relatedDebriefId ?? null,
    relatedLearningEventId: input.relatedLearningEventId ?? null,
    relatedReplayRunId: input.relatedReplayRunId ?? null,
    actionRequired: input.actionRequired ?? false,
    recommendedAction: input.recommendedAction ?? null,
    actionUrl: input.actionUrl ?? null,
    metadata: safeMetadata,
    dedupeKey: input.dedupeKey,
    repeatCount: 1,
    expiresAt,
  }).returning();

  await logEvent(notificationId, "NOTIFICATION_CREATED", input.severity,
    `Created ${input.severity} ${input.type} from ${input.sourceBuild}`,
    { dedupeKey: input.dedupeKey, actionUrl: input.actionUrl ?? null });
  return { status: "CREATED", notification: created };
}

// ── queries ─────────────────────────────────────────────────────────────────
export interface ListFilters {
  type?: string; severity?: string; status?: string; sourceBuild?: string;
  limit?: number;
}
export async function listNotifications(userId: number, f: ListFilters = {}) {
  const conds = [eq(notificationsTable.userId, userId)] as Array<ReturnType<typeof eq>>;
  if (f.type)        conds.push(eq(notificationsTable.type, f.type));
  if (f.severity)    conds.push(eq(notificationsTable.severity, f.severity));
  if (f.status)      conds.push(eq(notificationsTable.status, f.status));
  if (f.sourceBuild) conds.push(eq(notificationsTable.sourceBuild, f.sourceBuild));
  return db.select().from(notificationsTable)
    .where(and(...conds))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(f.limit ?? 50);
}

export async function getCounts(userId: number) {
  const all = await db.select({ severity: notificationsTable.severity, status: notificationsTable.status, type: notificationsTable.type })
    .from(notificationsTable)
    .where(eq(notificationsTable.userId, userId));
  const counts = { total: all.length, unread: 0, critical: 0, high: 0, warning: 0, info: 0,
    byType: {} as Record<string, number>, byStatus: {} as Record<string, number>, criticalUnread: 0 };
  for (const r of all) {
    counts.byType[r.type] = (counts.byType[r.type] ?? 0) + 1;
    counts.byStatus[r.status] = (counts.byStatus[r.status] ?? 0) + 1;
    if (r.status === "UNREAD") counts.unread++;
    if (r.severity === "CRITICAL") { counts.critical++; if (r.status === "UNREAD") counts.criticalUnread++; }
    if (r.severity === "HIGH")     counts.high++;
    if (r.severity === "WARNING")  counts.warning++;
    if (r.severity === "INFO")     counts.info++;
  }
  return counts;
}

export async function getById(userId: number, notificationId: string) {
  const [row] = await db.select().from(notificationsTable)
    .where(and(eq(notificationsTable.notificationId, notificationId), eq(notificationsTable.userId, userId)))
    .limit(1);
  return row ?? null;
}

async function setStatus(userId: number, notificationId: string, status: string, extra: Record<string, unknown> = {}) {
  const [updated] = await db.update(notificationsTable).set({
    status, updatedAt: new Date(), ...extra,
  }).where(and(eq(notificationsTable.notificationId, notificationId), eq(notificationsTable.userId, userId))).returning();
  if (updated) {
    await logEvent(notificationId, `STATUS_${status}`, "INFO", `Notification marked ${status}`, extra);
  }
  return updated ?? null;
}

export const markRead          = (uid: number, id: string) => setStatus(uid, id, "READ",         { readAt: new Date() });
export const markAcknowledged  = (uid: number, id: string) => setStatus(uid, id, "ACKNOWLEDGED", { acknowledgedAt: new Date(), readAt: new Date() });
export const markDismissed     = (uid: number, id: string) => setStatus(uid, id, "DISMISSED",    { dismissedAt: new Date() });

export async function snooze(uid: number, id: string, minutes: number) {
  const until = new Date(Date.now() + minutes * 60_000);
  return setStatus(uid, id, "SNOOZED", { snoozedUntil: until });
}

export async function markAllRead(userId: number) {
  const updated = await db.update(notificationsTable).set({ status: "READ", readAt: new Date(), updatedAt: new Date() })
    .where(and(eq(notificationsTable.status, "UNREAD"), eq(notificationsTable.userId, userId)))
    .returning({ id: notificationsTable.notificationId });
  await logEvent(null, "MARK_ALL_READ", "INFO", `Marked ${updated.length} notifications read for user=${userId}`);
  return updated.length;
}

// ── digest ──────────────────────────────────────────────────────────────────
export async function generateDigest(rangeHours = 24) {
  const end = new Date();
  const start = new Date(end.getTime() - rangeHours * 3_600_000);
  const rows = await db.select().from(notificationsTable).where(gte(notificationsTable.createdAt, start));
  const summary = {
    bySeverity: {} as Record<string, number>,
    byType: {} as Record<string, number>,
    bySourceBuild: {} as Record<string, number>,
    actionRequired: 0,
    topCritical: [] as Array<{ id: string; title: string }>,
  };
  for (const r of rows) {
    summary.bySeverity[r.severity] = (summary.bySeverity[r.severity] ?? 0) + 1;
    summary.byType[r.type] = (summary.byType[r.type] ?? 0) + 1;
    summary.bySourceBuild[r.sourceBuild] = (summary.bySourceBuild[r.sourceBuild] ?? 0) + 1;
    if (r.actionRequired) summary.actionRequired++;
    if (r.severity === "CRITICAL" && summary.topCritical.length < 10)
      summary.topCritical.push({ id: r.notificationId, title: r.title });
  }
  const digestId = `digest_${randomUUID()}`;
  const [created] = await db.insert(notificationDigestsTable).values({
    digestId, rangeStart: start, rangeEnd: end,
    totalNotifications: rows.length,
    criticalCount: summary.bySeverity["CRITICAL"] ?? 0,
    warningCount: summary.bySeverity["WARNING"] ?? 0,
    tradeCount: summary.byType["TRADE"] ?? 0,
    learningCount: summary.byType["LEARNING"] ?? 0,
    safetyCount: summary.byType["SAFETY"] ?? 0,
    summary,
  }).returning();
  await logEvent(null, "DIGEST_GENERATED", "INFO", `Digest ${digestId} for ${rangeHours}h covering ${rows.length} notifications`);
  return created;
}

export async function latestDigest() {
  const [row] = await db.select().from(notificationDigestsTable)
    .orderBy(desc(notificationDigestsTable.createdAt)).limit(1);
  return row ?? null;
}

// ── logs ────────────────────────────────────────────────────────────────────
export async function listLogs(limit = 50) {
  return db.select().from(notificationLogsTable)
    .orderBy(desc(notificationLogsTable.createdAt)).limit(limit);
}

// ── demo seeding ────────────────────────────────────────────────────────────
// Phase-2: every seeded demo notification is stamped with the supplied userId
// so different test users get isolated demo data.
export async function seedDemo(userId: number) {
  const stamp = Date.now();
  const inputs: NotifyInput[] = [
    { type: "SAFETY",   severity: "CRITICAL", sourceBuild: "HH", title: "Risk Governor LOCKED",     message: "Demo: governor LOCKED by hard block.", actionRequired: true, recommendedAction: "Review hard blocks.", actionUrl: "/risk-settings", dedupeKey: `DEMO:HH:LOCKED:${stamp}` },
    { type: "SAFETY",   severity: "CRITICAL", sourceBuild: "KK", title: "Unsafe BROKER_MODE rejected", message: "Demo: BROKER_MODE=write refused.", actionRequired: true, actionUrl: "/broker-readonly", dedupeKey: `DEMO:KK:UNSAFE:${stamp}` },
    { type: "RISK",     severity: "HIGH",     sourceBuild: "HH", title: "Approaching daily loss limit", message: "Demo: 80% of limit reached.", dedupeKey: `DEMO:HH:LOSS_NEAR:${stamp}` },
    { type: "DATA",     severity: "WARNING",  sourceBuild: "DD", title: "Wide spread on V75",          message: "Demo: spread=0.45 on Volatility 75 Index.", symbol: "Volatility 75 Index", dedupeKey: `DEMO:DD:WIDE_SPREAD:${stamp}` },
    { type: "TRADE",    severity: "INFO",     sourceBuild: "EE", title: "Paper trade opened",          message: "Demo: V75 BUY 0.10 @ 1023.50.", symbol: "Volatility 75 Index", relatedTradeId: "p_demo_1", dedupeKey: `DEMO:EE:OPENED:${stamp}` },
    { type: "TRADE",    severity: "WARNING",  sourceBuild: "EE", title: "Stop-loss hit",               message: "Demo: paper SL hit on V100.", symbol: "Volatility 100 Index", relatedTradeId: "p_demo_2", dedupeKey: `DEMO:EE:SL_HIT:${stamp}` },
    { type: "LEARNING", severity: "INFO",     sourceBuild: "BB", title: "Auto-debrief created",        message: "Demo: BB debrief saved.", relatedDebriefId: "deb_demo_1", actionUrl: "/post-trade-debriefs", dedupeKey: `DEMO:BB:CREATED:${stamp}` },
    { type: "LEARNING", severity: "WARNING",  sourceBuild: "CC", title: "Repeated mistake pattern rising", message: "Demo: 'overtrading' seen 5 times.", relatedLearningEventId: "le_demo_1", actionUrl: "/trader-coach", dedupeKey: `DEMO:CC:REPEATED:${stamp}` },
    { type: "COACH",    severity: "INFO",     sourceBuild: "II", title: "Trader Coach report ready",   message: "Demo: weekly coach report.", actionUrl: "/trader-coach", dedupeKey: `DEMO:II:REPORT:${stamp}` },
    { type: "REPLAY",   severity: "INFO",     sourceBuild: "JJ", title: "Replay report ready",         message: "Demo: replay rrun_demo_1 finished.", relatedReplayRunId: "rrun_demo_1", actionUrl: "/replay-simulator", dedupeKey: `DEMO:JJ:REPORT:${stamp}` },
  ];
  const results: NotifyResult[] = [];
  for (const i of inputs) results.push(await notify({ ...i, userId }));
  return { count: results.length, statuses: results.map(r => r.status) };
}
