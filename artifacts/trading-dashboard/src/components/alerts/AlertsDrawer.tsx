import React from "react";
import {
  useGetAlerts,
  useMarkAllAlertsRead,
  useMarkAlertRead,
  useGenerateSystemAlerts,
  getGetAlertsQueryKey,
  getGetAlertUnreadCountQueryKey,
  getGetCriticalAlertsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertDetailCard } from "./AlertDetailCard";
import { CheckCheck, RefreshCw } from "lucide-react";
import { markActionStart, markActionEnd, markUiFeedback, markRenderComplete } from "@/lib/perf";

interface Props {
  open: boolean;
  onClose: () => void;
}

// (L) Slide-out drawer listing the most recent alerts. The "Run scan" button
// invokes the rule engine on demand so the user can refresh state immediately;
// dedupe inside createAlert keeps re-scans from spamming.
export function AlertsDrawer({ open, onClose }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useGetAlerts({
    query: { queryKey: getGetAlertsQueryKey(), refetchInterval: open ? 5000 : false, enabled: open },
  });
  const markAll = useMarkAllAlertsRead();
  const markOne = useMarkAlertRead();
  const generate = useGenerateSystemAlerts();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetAlertsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAlertUnreadCountQueryKey() });
    qc.invalidateQueries({ queryKey: getGetCriticalAlertsQueryKey() });
  };

  // PART 4 — optimistic update so dismissing an alert removes it from the
  // list and decrements the unread-count badge BEFORE the server confirms.
  // The invalidate() that runs after the mutation reconciles any drift
  // (e.g. a critical alert that the server refused to mark read). All
  // three caches are touched in one shot so the bell badge updates on the
  // same frame as the row removal.
  type AlertsCache = { alerts?: Array<{ id: number; read?: boolean; severity?: string }> } | undefined;
  type UnreadCache = { unreadCount?: number; criticalCount?: number } | undefined;
  const optimisticallyMarkOne = (id: number) => {
    // Look up the dismissed alert's severity from the current list cache
    // so we can decrement criticalCount when (and only when) appropriate.
    // Without this, dismissing a critical alert leaves the red bell
    // badge stuck at its old number until the server response lands.
    const listCache = qc.getQueryData<AlertsCache>(getGetAlertsQueryKey());
    const dismissed = listCache?.alerts?.find((a) => a.id === id);
    const wasCritical = (dismissed?.severity ?? "").toLowerCase() === "critical";
    qc.setQueryData<AlertsCache>(getGetAlertsQueryKey(), (cur) => {
      if (!cur?.alerts) return cur;
      return { ...cur, alerts: cur.alerts.filter((a) => a.id !== id) };
    });
    qc.setQueryData<UnreadCache>(getGetAlertUnreadCountQueryKey(), (cur) => {
      if (!cur) return cur;
      return {
        ...cur,
        unreadCount: Math.max(0, (cur.unreadCount ?? 0) - 1),
        criticalCount: wasCritical ? Math.max(0, (cur.criticalCount ?? 0) - 1) : cur.criticalCount,
      };
    });
  };
  const optimisticallyMarkAll = () => {
    qc.setQueryData<AlertsCache>(getGetAlertsQueryKey(), (cur) => {
      if (!cur?.alerts) return cur;
      return { ...cur, alerts: [] };
    });
    qc.setQueryData<UnreadCache>(getGetAlertUnreadCountQueryKey(), (cur) => {
      if (!cur) return cur;
      return { ...cur, unreadCount: 0, criticalCount: 0 };
    });
  };

  const onMarkAll = async () => {
    const pid = markActionStart("alerts.markAllRead", { page: typeof location !== "undefined" ? location.pathname : undefined });
    optimisticallyMarkAll();
    markUiFeedback(pid); markRenderComplete(pid); // optimistic = paint is instant
    try { await markAll.mutateAsync(); } finally { invalidate(); markActionEnd(pid); }
  };
  const onMarkOne = async (id: number) => {
    const pid = markActionStart("alerts.dismissOne", { page: typeof location !== "undefined" ? location.pathname : undefined });
    optimisticallyMarkOne(id);
    markUiFeedback(pid); markRenderComplete(pid);
    try { await markOne.mutateAsync({ id }); } finally { invalidate(); markActionEnd(pid); }
  };
  const onScan = async () => {
    const pid = markActionStart("alerts.runScan", { page: typeof location !== "undefined" ? location.pathname : undefined });
    try { await generate.mutateAsync(); } finally { invalidate(); markActionEnd(pid); }
  };

  const alerts = data?.alerts ?? [];

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col" data-testid="drawer-alerts">
        <SheetHeader>
          <SheetTitle>Notifications</SheetTitle>
          <SheetDescription>
            Smart alerts compose data from market intelligence, broker health, risk locks, positions, trade plans, and the AI coach. Critical alerts can never be silenced.
          </SheetDescription>
        </SheetHeader>

        <div className="flex items-center gap-2 py-3 border-b">
          <Button size="sm" variant="outline" onClick={onScan} disabled={generate.isPending} data-testid="button-alert-scan">
            <RefreshCw className={`h-4 w-4 mr-1 ${generate.isPending ? "animate-spin" : ""}`} />
            Run scan
          </Button>
          <Button size="sm" variant="outline" onClick={onMarkAll} disabled={markAll.isPending} data-testid="button-alert-mark-all">
            <CheckCheck className="h-4 w-4 mr-1" />
            Mark all read
          </Button>
          <a href="/alert-preferences" className="ml-auto text-xs text-muted-foreground hover:underline" data-testid="link-alert-preferences">
            Preferences
          </a>
        </div>

        <ScrollArea className="flex-1 -mx-6 px-6">
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-6">Loading...</div>
          ) : alerts.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6">No alerts. You're all caught up.</div>
          ) : (
            <div className="space-y-2 py-2">
              {alerts.map((a) => (
                <AlertDetailCard key={a.id} alert={a} onMarkRead={onMarkOne} />
              ))}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
