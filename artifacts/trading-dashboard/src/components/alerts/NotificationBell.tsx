import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AlertsDrawer } from "./AlertsDrawer";
import { fetchUnreadCounts, ME_ALERTS_UNREAD_KEY } from "./meAlerts";

// The global alert bell (rendered in the Topbar on every page).
//
// RANK 33 / RANK 53 — this badge was structurally incapable of showing a
// number. It polled `useGetAlertUnreadCount()` → GET /api/alerts/unread-count,
// which routes/alerts.ts has served as a deprecated fixed-empty envelope since
// Phase 22C (`unreadCount: 0, criticalCount: 0`, always). Every user's bell
// looked permanently clean regardless of how many unread CRITICAL risk or
// broker alerts they had. It now reads the canonical per-user store —
// /api/me/alerts/unread-count — which is `requireUser`, scoped to
// req.authUser.id, and genuinely written to. See ./meAlerts.ts.
//
// The old "first-load gate" on useAllUnlocks() existed because the legacy
// endpoint was GLOBAL: a fresh browser would have seen the operator's alerts.
// The per-user endpoint cannot leak another user's rows (the server derives the
// user from the session cookie and never accepts a userId from the client), so
// the gate is gone — and with it the bug where a user with alerts but no
// "unlocked" feature never saw their own badge.
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { data, isError } = useQuery({
    queryKey: ME_ALERTS_UNREAD_KEY,
    queryFn: fetchUnreadCounts,
    refetchInterval: 20_000,
    staleTime: 15_000,
  });

  // `null` = the read failed. That is UNKNOWN, not zero — the bell says so
  // rather than reporting a reassuring clean state it cannot vouch for.
  const unavailable = data === null || isError;
  const unread = data?.unreadCount ?? 0;
  const critical = data?.criticalCount ?? 0;

  const label = unavailable
    ? "Alerts — unread count unavailable"
    : `${unread} unread alert${unread === 1 ? "" : "s"}${critical > 0 ? `, ${critical} critical` : ""}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="button-notification-bell"
        className="relative inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-sidebar-accent/50 cursor-pointer"
        aria-label={label}
        title={label}
      >
        <Bell size={18} className={!unavailable && critical > 0 ? "text-danger animate-pulse" : "text-sidebar-foreground/70"} />
        {unavailable ? (
          <span
            className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full border border-border bg-muted px-1 text-[10px] text-muted-foreground"
            data-testid="badge-alert-unavailable"
          >
            ?
          </span>
        ) : unread > 0 ? (
          <Badge
            variant={critical > 0 ? "destructive" : "secondary"}
            className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px]"
            data-testid="badge-alert-unread-count"
          >
            {unread > 9 ? "9+" : unread}
          </Badge>
        ) : null}
      </button>
      <AlertsDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}
