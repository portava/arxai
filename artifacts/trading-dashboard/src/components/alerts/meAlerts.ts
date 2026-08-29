// Canonical per-user alert client — RANKS 33 + 53.
//
// THE DEFECT
//   Every alert surface a user can actually see was wired to the LEGACY
//   `/api/alerts*` router. routes/alerts.ts has been fully deprecated since
//   Phase 22C: every GET returns a fixed empty envelope
//   (`{ notifications: [], alerts: [], unreadCount: 0, criticalCount: 0 }`) and
//   every mutation returns 410 Gone. So:
//     * NotificationBell's badge was structurally pinned to 0 for every user,
//       forever, no matter how many unread CRITICAL alerts they had;
//     * AlertsDrawer rendered "No alerts. You're all caught up." over an
//       endpoint that cannot return an alert — a reassuring lie;
//     * "Run scan" and "Mark all read" POSTed into a 410 with no error UI.
//   Meanwhile alert content was being written the whole time: upsertAlertOnce()
//   in routes/meAlerts.ts is called by the live command pipeline, the chart AI
//   alerts, the pool-view anomaly detector and the daily report scheduler.
//
// THE FIX
//   One module that speaks to `/api/me/alerts*` — the per-user store with real
//   writers, `requireUser`, and `req.authUser.id` scoping on every query. Both
//   the bell and the drawer read the SAME source, so the badge count and the
//   drawer contents can no longer disagree.
//
// HONESTY RULE
//   A failed read returns null, never an empty list and never 0. "I could not
//   read your alerts" and "you have no alerts" are different facts, and the
//   whole point of this defect class is that the UI kept reporting the second
//   when the first was true.

export type UserAlertSeverity = "info" | "warning" | "critical";
export type UserAlertStatus = "unread" | "read" | "dismissed";

export interface UserAlert {
  id: number;
  alertType: string;
  severity: UserAlertSeverity | string;
  title: string;
  message: string;
  source: string;
  status: UserAlertStatus | string;
  actionLabel: string | null;
  actionTarget: string | null;
  createdAt: string | null;
}

export interface UserAlertCounts {
  unreadCount: number;
  criticalCount: number;
}

export interface UserAlertList {
  alerts: UserAlert[];
  unread: number;
}

export const ME_ALERTS_KEY = ["me", "alerts", "list"] as const;
export const ME_ALERTS_UNREAD_KEY = ["me", "alerts", "unread-count"] as const;

async function getJson(path: string): Promise<unknown | null> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) return null;
  return (await res.json()) as unknown;
}

/** null = the count could not be read. Never coerced to a reassuring 0. */
export async function fetchUnreadCounts(): Promise<UserAlertCounts | null> {
  const data = (await getJson("/api/me/alerts/unread-count")) as
    | { unreadCount?: unknown; criticalCount?: unknown }
    | null;
  if (!data || typeof data.unreadCount !== "number") return null;
  return {
    unreadCount: data.unreadCount,
    criticalCount: typeof data.criticalCount === "number" ? data.criticalCount : 0,
  };
}

/** null = the list could not be read. Never coerced to an empty inbox. */
export async function fetchAlerts(): Promise<UserAlertList | null> {
  const data = (await getJson("/api/me/alerts?status=unread")) as
    | { alerts?: unknown; unread?: unknown }
    | null;
  if (!data || !Array.isArray(data.alerts)) return null;
  return {
    alerts: data.alerts as UserAlert[],
    unread: typeof data.unread === "number" ? data.unread : (data.alerts as UserAlert[]).length,
  };
}

async function post(path: string): Promise<boolean> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
  });
  return res.ok;
}

export const markAlertRead = (id: number) => post(`/api/me/alerts/${id}/read`);
export const markAllAlertsRead = () => post("/api/me/alerts/read-all");
export const clearResolvedAlerts = () => post("/api/me/alerts/clear-resolved");
