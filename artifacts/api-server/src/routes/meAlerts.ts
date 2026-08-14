// Phase 9E — Per-user dashboard alerts.
// SAFETY: requireUser, scope by req.authUser.id, never accept userId from client.
import { Router } from "express";
import { db, userAlertsTable } from "@workspace/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

router.get("/me/alerts", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const where = status ? and(eq(userAlertsTable.userId, userId), eq(userAlertsTable.status, status))
                        : eq(userAlertsTable.userId, userId);
  const rows = await db.select().from(userAlertsTable).where(where).orderBy(desc(userAlertsTable.createdAt)).limit(200);
  const unread = rows.filter((r) => r.status === "unread").length;
  res.json({ alerts: rows, unread, isEmpty: rows.length === 0 });
});

router.post("/me/alerts/:id/read", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const u = await db.update(userAlertsTable).set({ status: "read", readAt: new Date() })
    .where(and(eq(userAlertsTable.id, id), eq(userAlertsTable.userId, userId))).returning();
  if (!u[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(u[0]);
});

router.post("/me/alerts/:id/dismiss", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const u = await db.update(userAlertsTable).set({ status: "dismissed", dismissedAt: new Date() })
    .where(and(eq(userAlertsTable.id, id), eq(userAlertsTable.userId, userId))).returning();
  if (!u[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(u[0]);
});

router.post("/me/alerts/read-all", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const u = await db.update(userAlertsTable).set({ status: "read", readAt: new Date() })
    .where(and(eq(userAlertsTable.userId, userId), eq(userAlertsTable.status, "unread"))).returning();
  res.json({ updated: u.length });
});

// T005-3 — Cheap unread-count for the bell badge. The FE polls this every
// few seconds; returning the full alert list (~30 KB) just to count would
// blow the badge's perf budget. Per-user scoped via requireUser; never
// accepts a userId from the client.
router.get("/me/alerts/unread-count", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  // SQL aggregate — never materialise rows on the badge poll path.
  const agg = await db.select({
    unreadCount: sql<number>`count(*)::int`,
    criticalCount: sql<number>`count(*) filter (where ${userAlertsTable.severity} = 'critical')::int`,
  }).from(userAlertsTable)
    .where(and(eq(userAlertsTable.userId, userId), eq(userAlertsTable.status, "unread")));
  const row = agg[0] ?? { unreadCount: 0, criticalCount: 0 };
  res.json({ unreadCount: row.unreadCount, criticalCount: row.criticalCount });
});

// T005-3 — Bulk-dismiss everything the user has already read. Lets users
// clear the drawer without dismissing each row individually. Per-user
// scoped; will not touch unread or already-dismissed rows.
router.post("/me/alerts/clear-resolved", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  // No .returning() — we only need the affected-row count, not the bodies.
  const u = await db.update(userAlertsTable).set({ status: "dismissed", dismissedAt: new Date() })
    .where(and(eq(userAlertsTable.userId, userId), eq(userAlertsTable.status, "read")));
  res.json({ cleared: u.rowCount ?? 0 });
});

// Internal helper. Strictly idempotent via DB unique (userId, alertType, hourly bucket)
// + ON CONFLICT DO NOTHING. Concurrent pollers cannot create duplicates.
export async function upsertAlertOnce(userId: number, args: {
  alertType: string; severity: "info" | "warning" | "critical";
  title: string; message?: string; source?: string;
  actionLabel?: string | null; actionTarget?: string | null;
}) {
  const bucket = Math.floor(Date.now() / (60 * 60_000)); // unix-hour bucket
  await db.insert(userAlertsTable).values({
    userId, alertType: args.alertType, severity: args.severity, title: args.title,
    message: args.message ?? "", source: args.source ?? "system",
    actionLabel: args.actionLabel ?? null, actionTarget: args.actionTarget ?? null,
    bucket,
  }).onConflictDoNothing({ target: [userAlertsTable.userId, userAlertsTable.alertType, userAlertsTable.bucket] });
  const row = await db.select().from(userAlertsTable)
    .where(and(eq(userAlertsTable.userId, userId), eq(userAlertsTable.alertType, args.alertType), eq(userAlertsTable.bucket, bucket)))
    .limit(1);
  return row[0]!;
}

// Auto-dismiss all non-dismissed alerts of the given type(s) for a user.
// Used to collapse stale condition alerts (e.g. mt5_disconnected) the moment
// the underlying condition recovers — so a fresh heartbeat clears the warning
// instead of leaving it on screen until the hourly bucket rolls over.
export async function dismissAlertsByType(userId: number, alertTypes: string[]) {
  if (alertTypes.length === 0) return 0;
  let dismissed = 0;
  for (const t of alertTypes) {
    const u = await db.update(userAlertsTable)
      .set({ status: "dismissed", dismissedAt: new Date() })
      .where(and(
        eq(userAlertsTable.userId, userId),
        eq(userAlertsTable.alertType, t),
        ne(userAlertsTable.status, "dismissed"),
      )).returning();
    dismissed += u.length;
  }
  return dismissed;
}

// Compatibility export — the alert/notification contract QA test imports this
// by name. Auto-resolves (collapses) the MT5 connection alerts for a user when
// the bridge heartbeat recovers. Delegates to dismissAlertsByType.
export async function autoResolveMt5AlertsForUser(userId: number): Promise<number> {
  return dismissAlertsByType(userId, ["mt5_disconnected", "mt5_stale"]);
}

export default router;
