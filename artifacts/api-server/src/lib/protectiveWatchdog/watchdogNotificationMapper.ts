// Capability #28 — app side of the alert path: watchdog finding → the
// product's existing notification payload.
//
// This is deliberately a MAPPER, not a notifier. It produces the exact
// `NotifyPayload` shape that `lib/notificationService.ts#createNotification`
// already consumes — the same service behind `/api/me/notifications`, the
// NotificationCenter, the bell, and web push. No second alert silo, no new
// table of "watchdog alerts" nobody opens.
//
// PURE: no `@workspace/db`, no IO — so it runs in the offline CI lane.
//
// HONESTY: every message carries the provenance ("independent watchdog,
// read-only, outside the app") and the standing ALERT-ONLY disclaimer. The
// watchdog has no execution authority, and its notification must never read
// as though something was done about the problem.

import type { WatchdogWireFinding } from "./watchdogAlertEnvelope.js";

/** Mirrors NotifyPayload in lib/notificationService.ts (kept structural so
 *  this module needs no import from the DB-backed service). */
export interface WatchdogNotifyPayload {
  notificationType: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  source: "mt5" | "risk" | "session" | "trade" | "ai" | "playbook" | "journal" | "security" | "system";
  entityType: string;
  entityId: number;
  actionLabel: string;
  actionTarget: string;
  cooldownMs: number;
}

export const WATCHDOG_NOTIFICATION_TYPE = "PROTECTION_WATCHDOG";
/** A persistent condition collapses into one row per 15 minutes. */
export const WATCHDOG_NOTIFICATION_COOLDOWN_MS = 15 * 60_000;

/** The standing disclaimer. The watchdog observes; it never acts. */
export const WATCHDOG_ALERT_ONLY_SUFFIX =
  "Detected by the independent protection watchdog, which runs outside the app on a read-only database session. Alert only — nothing was placed, modified or closed.";

interface Route {
  /** Matched against the finding key prefix (before the first ":"). */
  family: string;
  source: WatchdogNotifyPayload["source"];
  title: string;
  actionLabel: string;
  actionTarget: string;
}

const ROUTES: readonly Route[] = [
  { family: "unprotected_position", source: "risk", title: "Open position with no stop loss recorded", actionLabel: "Review positions", actionTarget: "/position-control" },
  { family: "stale_position_sync", source: "risk", title: "Open position has not synced", actionLabel: "Review positions", actionTarget: "/positions" },
  { family: "never_synced_position", source: "risk", title: "Open position has never synced", actionLabel: "Review positions", actionTarget: "/positions" },
  { family: "stuck_command", source: "mt5", title: "Broker command is stuck", actionLabel: "Check the bridge", actionTarget: "/system-health" },
  { family: "main_app_silent", source: "system", title: "Main app has gone silent", actionLabel: "Check system health", actionTarget: "/system-health" },
  { family: "main_app_no_liveness_evidence", source: "system", title: "Main-app liveness cannot be established", actionLabel: "Check system health", actionTarget: "/system-health" },
  { family: "kill_switch_engaged", source: "risk", title: "Kill switch is engaged", actionLabel: "Review positions", actionTarget: "/position-control" },
  { family: "cannot_verify", source: "system", title: "Watchdog CANNOT VERIFY protection state", actionLabel: "Check system health", actionTarget: "/system-health" },
  { family: "watchdog_alert_path", source: "system", title: "Watchdog alert path degraded", actionLabel: "Check system health", actionTarget: "/system-health" },
];

const FALLBACK: Route = {
  family: "unknown",
  source: "system",
  title: "Protection watchdog finding",
  actionLabel: "Open notifications",
  actionTarget: "/notifications",
};

export function findingFamily(key: string): string {
  const idx = key.indexOf(":");
  return idx === -1 ? key : key.slice(0, idx);
}

/** The numeric tail of a scoped key (`unprotected_position:42` → 42) so the
 *  notification dedupe key is stable PER position/command rather than folding
 *  every unprotected position into one row. */
export function findingEntityId(key: string): number {
  const idx = key.indexOf(":");
  if (idx === -1) return 0;
  const tail = key.slice(idx + 1);
  const n = Number(tail);
  if (Number.isSafeInteger(n) && n >= 0) return n;
  // Non-numeric scope (e.g. `cannot_verify:open_positions`): fold to a small
  // stable non-negative integer so distinct sections still get distinct rows.
  let h = 0;
  for (let i = 0; i < tail.length; i++) h = (h * 31 + tail.charCodeAt(i)) % 2_000_000_000;
  return h;
}

function severityOf(f: WatchdogWireFinding): WatchdogNotifyPayload["severity"] {
  return f.severity === "CRITICAL" ? "critical" : f.severity === "WARN" ? "warning" : "info";
}

export function mapFindingToNotification(f: WatchdogWireFinding, instanceId: string): WatchdogNotifyPayload {
  const family = findingFamily(f.key);
  const route = ROUTES.find((r) => r.family === family) ?? FALLBACK;
  return {
    notificationType: WATCHDOG_NOTIFICATION_TYPE,
    severity: severityOf(f),
    title: route.title,
    message: `${f.message} — ${WATCHDOG_ALERT_ONLY_SUFFIX} (watchdog instance ${instanceId})`,
    source: route.source,
    // entityType carries the family so dedupe is per-condition-kind, and
    // entityId carries the scope so two unprotected positions are two alerts.
    entityType: `watchdog:${family}`,
    entityId: findingEntityId(f.key),
    actionLabel: route.actionLabel,
    actionTarget: route.actionTarget,
    cooldownMs: WATCHDOG_NOTIFICATION_COOLDOWN_MS,
  };
}

export function mapEnvelopeToNotifications(
  findings: readonly WatchdogWireFinding[],
  instanceId: string,
): WatchdogNotifyPayload[] {
  return findings.map((f) => mapFindingToNotification(f, instanceId));
}
