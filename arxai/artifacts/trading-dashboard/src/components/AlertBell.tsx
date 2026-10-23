import React from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// T005-3: AlertBell now reads from the per-user /api/me/alerts unread-count
// endpoint (legacy /api/alerts is deprecated and always empty). Strictly
// per-user — the session cookie scopes the response server-side.
async function fetchUnreadCount(): Promise<number> {
  const res = await fetch("/api/me/alerts/unread-count", { credentials: "include" });
  if (!res.ok) return 0;
  const data = (await res.json()) as { count?: number };
  return typeof data?.count === "number" ? data.count : 0;
}

export function AlertBell() {
  // Badge polling: 20s is plenty for a glance-level indicator. With the
  // global refetchIntervalInBackground:false default, this also stops
  // entirely when the tab is hidden.
  const { data: count = 0 } = useQuery({
    queryKey: ["me", "alerts", "unread-count"],
    queryFn: fetchUnreadCount,
    refetchInterval: 20_000,
    staleTime: 15_000,
  });
  return (
    <Link href="/alerts" data-testid="link-alert-bell">
      <div className="relative inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-sidebar-accent/50 cursor-pointer">
        <Bell size={18} className="text-sidebar-foreground/70" />
        {count > 0 ? (
          <Badge variant="destructive" className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px]">
            {count > 9 ? "9+" : count}
          </Badge>
        ) : null}
      </div>
    </Link>
  );
}
