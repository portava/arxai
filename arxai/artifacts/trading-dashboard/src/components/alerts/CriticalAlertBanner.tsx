import React from "react";
import { useGetCriticalAlerts, useMarkAlertRead, getGetCriticalAlertsQueryKey, getGetAlertUnreadCountQueryKey, getGetAlertsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, X } from "lucide-react";
import { Button } from "@/components/ui/button";

// (L) Persistent top-of-dashboard banner for CRITICAL unread alerts.
// Renders nothing when there are no critical alerts so it doesn't take
// vertical space in the steady state.
export function CriticalAlertBanner() {
  const qc = useQueryClient();
  const { data } = useGetCriticalAlerts({
    query: { queryKey: getGetCriticalAlertsQueryKey(), refetchInterval: 7000 },
  });
  const markRead = useMarkAlertRead();
  const alerts = data?.alerts ?? [];
  if (alerts.length === 0) return null;

  const dismiss = async (id: number) => {
    await markRead.mutateAsync({ id });
    qc.invalidateQueries({ queryKey: getGetCriticalAlertsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAlertUnreadCountQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAlertsQueryKey() });
  };

  return (
    <div className="space-y-2 mb-4" data-testid="banner-critical-alerts">
      {alerts.map((a) => (
        <div key={a.id} className="flex items-start gap-3 rounded-md border border-red-500/50 bg-red-500/10 p-3">
          <AlertOctagon className="h-5 w-5 text-red-500 mt-0.5 shrink-0 animate-pulse" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm text-red-700 dark:text-red-300" data-testid={`text-critical-title-${a.id}`}>{a.title}</div>
            <div className="text-xs text-red-700/90 dark:text-red-200/90 mt-0.5">{a.message}</div>
          </div>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => dismiss(a.id)} data-testid={`button-dismiss-critical-${a.id}`}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
