import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchAlerts, markAlertRead, ME_ALERTS_KEY, ME_ALERTS_UNREAD_KEY,
  type UserAlert,
} from "./meAlerts";

// Persistent top-of-dashboard banner for CRITICAL unread alerts.
//
// RANK 33 / 53 (same defect class as the bell) — this banner polled
// `useGetCriticalAlerts()` → GET /api/alerts/critical, a deprecated route that
// has returned `{ alerts: [] }` unconditionally since Phase 22C. `alerts.length
// === 0` was therefore always true, so the banner returned null on every
// render: the loudest safety affordance on the dashboard could never fire, for
// anyone, no matter what happened to their account.
//
// It now derives from the same per-user store the bell counts and the drawer
// lists (/api/me/alerts, requireUser + req.authUser.id scoped), so all three
// surfaces agree. A failed read renders nothing — this banner's job is to shout
// about a KNOWN critical alert, and the drawer is where an unreadable inbox is
// reported honestly.
export function CriticalAlertBanner() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ME_ALERTS_KEY,
    queryFn: fetchAlerts,
    refetchInterval: 20_000,
    staleTime: 15_000,
  });
  const markRead = useMutation({ mutationFn: (id: number) => markAlertRead(id) });

  const critical: UserAlert[] = (data?.alerts ?? []).filter(
    (a) => String(a.severity).toLowerCase() === "critical",
  );
  if (critical.length === 0) return null;

  const dismiss = async (id: number) => {
    await markRead.mutateAsync(id);
    qc.invalidateQueries({ queryKey: ME_ALERTS_KEY });
    qc.invalidateQueries({ queryKey: ME_ALERTS_UNREAD_KEY });
  };

  return (
    <div className="space-y-2 mb-4" data-testid="banner-critical-alerts">
      {critical.map((a) => (
        <div key={a.id} className="flex items-start gap-3 rounded-md border border-danger/50 bg-danger/10 p-3">
          <AlertOctagon className="h-5 w-5 text-danger mt-0.5 shrink-0 animate-pulse" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm text-danger dark:text-danger" data-testid={`text-critical-title-${a.id}`}>{a.title}</div>
            <div className="text-xs text-danger/90 dark:text-danger/90 mt-0.5">{a.message}</div>
          </div>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => dismiss(a.id)} data-testid={`button-dismiss-critical-${a.id}`}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
