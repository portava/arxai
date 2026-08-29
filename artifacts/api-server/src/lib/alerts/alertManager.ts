// NOTE — the Build L "smart alert rule engine" (lib/alerts/ruleEngine.ts) was
// REMOVED, not wired. Do not rebuild it against this module.
//
// It implemented 8 proactive safety rules (broker disconnected, position near
// stop loss, risk lock active, near daily loss limit, …) and had zero callers:
// no route, no worker, no scheduler. Wiring it looked like the obvious fix and
// is not, because this table is read and written WITHOUT USER SCOPE, while the
// rules read global tables and embed per-user detail in the message — symbols,
// live position ids, plan ids, today's realised loss. Those rows are read back
// by getCriticalUnread(), which reaches any authenticated caller through
// POST /api/help/why-blocked. Firing the engine would have leaked one user's
// open positions and P/L into another user's "Why am I blocked?" drawer —
// precisely the global-scope leak Phase 22C closed when it neutralised
// routes/alerts.ts.
//
// CORRECTED (review). An earlier version of this note said the `alerts` table
// "has no userId column". It does: lib/db/src/schema/alerts.ts declares a
// nullable `user_id`, added by Build L and marked "for future multi-user". The
// defect is not a missing column, it is an UNUSED one — CreateAlertInput below
// has no userId field so every producer writes NULL, and getAlerts() /
// getUnreadCount() / getCriticalUnread() filter on nothing. Stating it as a
// missing column hid the cheapest remedy from the next maintainer: populate the
// column that already exists and scope the reads by it. That remedy is a
// separate piece of work — every existing row is NULL, so a naive
// `where userId = :caller` would silently hide real alerts, which is worse than
// the leak it closes.
//
// SCOPE OF THE CLAIM. The eight rule-engine rules are not generated — that is
// what was removed. Alerts as such ARE still produced: 16 live createAlert()
// call sites across 11 files (fundControls, reconciliationAudit,
// mt5FeedStalenessWatchdog, onboarding state/whyBlocked, and the
// tradeManagement / mt5 / newsCalendar / adminBridgeControl / tradePlans /
// portfolioRisk routes) write rows here, including safety ones such as
// MT5_DISCONNECTED and CRITICAL fund-control alerts. Saying "nothing generates
// alerts" would be false. Rebuilding the RULE ENGINE belongs on the per-user
// surface (routes/meNotifications.ts), which is the canonical successor named
// by routes/alerts.ts.

import {
  db,
  alertsTable,
  alertSettingsTable,
  alertPreferencesTable,
  type Alert,
  type AlertPreferences,
} from "@workspace/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { scrubString } from "../security/redact.js";
import { logger } from "../logger.js";

// (L) Build L extends ALERT_TYPES additively. Existing types kept for
// back-compat with mt5.ts and tradeManagement.ts. New types map to the spec
// categories that the rule engine + frontend understand.
export const ALERT_TYPES = [
  // existing
  "HIGH_CONFIDENCE_SIGNAL",
  "TRADE_OPENED",
  "TRADE_CLOSED",
  "RISK_LIMIT_HIT",
  "LOSING_STREAK",
  "MT5_DISCONNECTED",
  "NEWS_RISK",
  "KILL_SWITCH_ACTIVATED",
  "BACKTEST_COMPLETE",
  // (L) new
  "MARKET_CONDITION",
  "RISK_LOCK",
  "BROKER_HEALTH",
  "POSITION_WARNING",
  "TRADE_PLAN_READY",
  "TRADE_PLAN_INVALIDATED",
  "AI_COACH",
  "WEEKLY_REVIEW",
  "REPLAY_DRILL",
  "EXECUTION_SAFETY",
] as const;

export type AlertType = typeof ALERT_TYPES[number];
export type AlertPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AlertSeverity = "info" | "warning" | "danger" | "success";

// (L) Map a category to the matching preference column. Used by the quiet-hours
// + category-toggle gate. Types not in this map (legacy ones) bypass the gate.
const CATEGORY_KEYS: Partial<Record<AlertType, keyof AlertPreferences>> = {
  MARKET_CONDITION: "marketAlertsEnabled",
  RISK_LOCK: "riskAlertsEnabled",
  BROKER_HEALTH: "brokerAlertsEnabled",
  MT5_DISCONNECTED: "brokerAlertsEnabled",
  POSITION_WARNING: "positionAlertsEnabled",
  TRADE_PLAN_READY: "tradePlanAlertsEnabled",
  TRADE_PLAN_INVALIDATED: "tradePlanAlertsEnabled",
  AI_COACH: "coachAlertsEnabled",
  WEEKLY_REVIEW: "weeklyReviewAlertsEnabled",
  REPLAY_DRILL: "coachAlertsEnabled",
  EXECUTION_SAFETY: "executionSafetyAlertsEnabled",
  KILL_SWITCH_ACTIVATED: "executionSafetyAlertsEnabled",
};

// CRITICAL alerts override quiet hours and category toggles — the trader must
// see them. This is an inviolable safety contract: no preference can suppress
// a CRITICAL alert.
function isCritical(p: AlertPriority): boolean { return p === "CRITICAL"; }

export interface CreateAlertInput {
  type: AlertType;
  priority?: AlertPriority;
  severity?: AlertSeverity;
  title: string;
  message: string;
  symbol?: string;
  relatedTradeId?: number;
  relatedPositionId?: number;
  relatedTradePlanId?: number;
  actionRequired?: boolean;
  // (L) Optional explicit dedupe key. If omitted, derived from
  // type+symbol+related ids so the same logical event doesn't re-alert.
  dedupeKey?: string;
}

const DEFAULT_DEDUPE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function defaultDedupeKey(input: CreateAlertInput): string {
  const raw = [
    input.type,
    input.symbol ?? "",
    input.relatedTradeId ?? "",
    input.relatedPositionId ?? "",
    input.relatedTradePlanId ?? "",
  ].join("|");
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 24);
}

export async function getPreferences(): Promise<AlertPreferences> {
  const rows = await db.select().from(alertPreferencesTable).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(alertPreferencesTable).values({}).returning();
  return inserted[0]!;
}

export async function updatePreferences(patch: Partial<AlertPreferences>): Promise<AlertPreferences> {
  const cur = await getPreferences();
  const updated = await db.update(alertPreferencesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(alertPreferencesTable.id, cur.id))
    .returning();
  return updated[0]!;
}

// Quiet hours: if [start..end] wraps midnight (e.g. 22→7), it spans the wrap.
function inQuietHours(prefs: AlertPreferences, now: Date): boolean {
  const s = prefs.quietHoursStart, e = prefs.quietHoursEnd;
  if (s == null || e == null) return false;
  const h = now.getUTCHours();
  return s === e ? false : (s < e ? (h >= s && h < e) : (h >= s || h < e));
}

export async function createAlert(input: CreateAlertInput): Promise<Alert> {
  const priority: AlertPriority = input.priority ?? "MEDIUM";
  const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input);

  // 1. Per-type on/off (existing alert_settings) — bypass for CRITICAL.
  if (!isCritical(priority)) {
    const setting = await db.select().from(alertSettingsTable).where(eq(alertSettingsTable.type, input.type)).limit(1);
    if (setting[0] && setting[0].enabled === 0) return suppressed(input, priority, dedupeKey);
  }

  // 2. Category toggle + quiet hours (new alert_preferences) — bypass for CRITICAL.
  if (!isCritical(priority)) {
    const prefs = await getPreferences();
    const catKey = CATEGORY_KEYS[input.type];
    if (catKey && prefs[catKey] === false) return suppressed(input, priority, dedupeKey);
    if (inQuietHours(prefs, new Date())) return suppressed(input, priority, dedupeKey);
  }

  // 3. Dedupe: if an unread alert with the same dedupeKey was created within
  //    the TTL window, skip. Prevents spam from repeated rule-engine scans.
  const cutoff = new Date(Date.now() - DEFAULT_DEDUPE_TTL_MS);
  const dupes = await db.select({ id: alertsTable.id })
    .from(alertsTable)
    .where(and(
      eq(alertsTable.dedupeKey, dedupeKey),
      eq(alertsTable.read, 0),
      gt(alertsTable.createdAt, cutoff),
    )).limit(1);
  if (dupes[0]) return suppressed(input, priority, dedupeKey);

  // 4. Persist. Redact-before-write: user-visible free text never carries a
  //    raw secret even if a caller accidentally interpolates one.
  const inserted = await db.insert(alertsTable).values({
    type: input.type,
    priority,
    severity: input.severity ?? defaultSeverity(priority),
    title: scrubString(input.title),
    message: scrubString(input.message),
    symbol: input.symbol ?? null,
    relatedTradeId: input.relatedTradeId ?? null,
    relatedPositionId: input.relatedPositionId ?? null,
    relatedTradePlanId: input.relatedTradePlanId ?? null,
    actionRequired: input.actionRequired ?? false,
    dedupeKey,
  }).returning();
  void sendEmailAlert(inserted[0]!);
  void sendSMSAlert(inserted[0]!);
  void sendPushNotification(inserted[0]!);
  return inserted[0]!;
}

function defaultSeverity(p: AlertPriority): AlertSeverity {
  return p === "CRITICAL" ? "danger" : p === "HIGH" ? "warning" : p === "LOW" ? "info" : "info";
}

// In-memory shape returned when an alert is suppressed (per-type off / quiet
// hours / dedupe). Marked read=1 so it never appears in unread queries.
function suppressed(input: CreateAlertInput, priority: AlertPriority, dedupeKey: string): Alert {
  return {
    id: 0, userId: null, type: input.type, priority, severity: input.severity ?? defaultSeverity(priority),
    title: input.title, message: input.message, symbol: input.symbol ?? null,
    relatedTradeId: input.relatedTradeId ?? null, relatedPositionId: input.relatedPositionId ?? null,
    relatedTradePlanId: input.relatedTradePlanId ?? null, actionRequired: input.actionRequired ?? false,
    dedupeKey, read: 1, createdAt: new Date(),
  };
}

export async function getAlerts(limit = 50): Promise<Alert[]> {
  return db.select().from(alertsTable).orderBy(desc(alertsTable.createdAt)).limit(limit);
}

export async function getUnreadCount(): Promise<number> {
  const r = await db.select({ c: sql<number>`count(*)::int` }).from(alertsTable).where(eq(alertsTable.read, 0));
  return r[0]?.c ?? 0;
}

export async function getCriticalUnread(): Promise<Alert[]> {
  return db.select().from(alertsTable)
    .where(and(eq(alertsTable.read, 0), eq(alertsTable.priority, "CRITICAL")))
    .orderBy(desc(alertsTable.createdAt))
    .limit(10);
}

// (L) True COUNT (not list length) so the badge stays accurate when there
// are more than 10 unread CRITICAL alerts.
export async function getCriticalUnreadCount(): Promise<number> {
  const r = await db.select({ c: sql<number>`count(*)::int` })
    .from(alertsTable)
    .where(and(eq(alertsTable.read, 0), eq(alertsTable.priority, "CRITICAL")));
  return r[0]?.c ?? 0;
}

export async function markRead(id: number): Promise<Alert | null> {
  const updated = await db.update(alertsTable).set({ read: 1 }).where(eq(alertsTable.id, id)).returning();
  return updated[0] ?? null;
}

export async function markAllRead(): Promise<number> {
  const r = await db.update(alertsTable).set({ read: 1 }).where(eq(alertsTable.read, 0)).returning({ id: alertsTable.id });
  return r.length;
}

export async function clearAlerts(): Promise<number> {
  const r = await db.delete(alertsTable).returning({ id: alertsTable.id });
  return r.length;
}

void isNull;

// Delivery hooks. NO email / SMS / push provider is wired — each hook must say
// so (warn + delivered:false) instead of resolving silently as if the alert
// left the app. In-app delivery (the alerts table + NotificationCenter) is the
// only real channel today.
interface AlertDeliveryResult {
  channel: "email" | "sms" | "push";
  delivered: false;
  reason: "DELIVERY_CHANNEL_NOT_CONFIGURED";
}

function undelivered(channel: AlertDeliveryResult["channel"], alert: Alert): AlertDeliveryResult {
  logger.warn({ channel, alertId: alert.id, alertType: alert.type }, "alert delivery channel not configured — alert NOT sent");
  return { channel, delivered: false, reason: "DELIVERY_CHANNEL_NOT_CONFIGURED" };
}

async function sendEmailAlert(alert: Alert): Promise<AlertDeliveryResult> { return undelivered("email", alert); }
async function sendSMSAlert(alert: Alert): Promise<AlertDeliveryResult> { return undelivered("sms", alert); }
async function sendPushNotification(alert: Alert): Promise<AlertDeliveryResult> { return undelivered("push", alert); }
