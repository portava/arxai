import React, { useState } from "react";
import { useGetAlertUnreadCount, getGetAlertUnreadCountQueryKey } from "@workspace/api-client-react";
import { Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AlertsDrawer } from "./AlertsDrawer";
import { useAllUnlocks } from "@/hooks/useFeatureUnlock";

// (L) Replaces the older AlertBell. The badge polls the cheap unread-count
// endpoint so it stays current without re-pulling the full alert list.
// CRITICAL alerts paint the badge in destructive red; non-critical use default.
//
// First-load gate: only poll once any private feature is unlocked, otherwise
// a fresh browser would see the operator's global unread/critical alerts.
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unlocks = useAllUnlocks();
  const anyUnlocked = unlocks.mt5 || unlocks.paper || unlocks.analysis || unlocks.simulator;
  const { data } = useGetAlertUnreadCount({
    query: {
      queryKey: getGetAlertUnreadCountQueryKey(),
      refetchInterval: 5000,
      enabled: anyUnlocked,
    },
  });
  const unread = data?.unreadCount ?? 0;
  const critical = data?.criticalCount ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="button-notification-bell"
        className="relative inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-sidebar-accent/50 cursor-pointer"
        aria-label={`${unread} unread alert${unread === 1 ? "" : "s"}${critical > 0 ? `, ${critical} critical` : ""}`}
      >
        <Bell size={18} className={critical > 0 ? "text-red-500 animate-pulse" : "text-sidebar-foreground/70"} />
        {unread > 0 ? (
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
