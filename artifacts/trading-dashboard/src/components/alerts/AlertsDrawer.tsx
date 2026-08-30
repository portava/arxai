import React from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertDetailCard } from "./AlertDetailCard";
import { CheckCheck, RefreshCw } from "lucide-react";
import { markActionStart, markActionEnd, markUiFeedback, markRenderComplete } from "@/lib/perf";
import {
  fetchAlerts, markAlertRead, markAllAlertsRead,
  ME_ALERTS_KEY, ME_ALERTS_UNREAD_KEY,
  type UserAlert, type UserAlertCounts, type UserAlertList,
} from "./meAlerts";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Slide-out drawer listing the user's unread alerts.
//
// RANK 53 — this drawer used to read the LEGACY `/api/alerts` router, which
// has returned a hard-coded empty envelope since Phase 22C. It therefore
// rendered "No alerts. You're all caught up." on every open, for every user,
// forever — including for a user with unread CRITICAL alerts sitting in the
// per-user store. Its "Run scan" button POSTed /api/alerts/generate (410 Gone)
// and its "Mark all read" POSTed /api/alerts/read-all (410 Gone), both with no
// error UI, so the drawer silently did nothing and said everything was fine.
//
// It now reads and writes `/api/me/alerts*` — the same per-user store the bell
// counts, `requireUser` + `req.authUser.id` scoped server-side. The dead
// "Run scan" button is gone: the legacy rule engine it invoked writes to the
// `alerts` table, which no read surface in this app has ever exposed. It is
// replaced by an honest Refresh that re-reads the store.
export function AlertsDrawer({ open, onClose }: Props) {
  const qc = useQueryClient();
  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ME_ALERTS_KEY,
    queryFn: fetchAlerts,
    refetchInterval: open ? 20_000 : false,
    enabled: open,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ME_ALERTS_KEY });
    qc.invalidateQueries({ queryKey: ME_ALERTS_UNREAD_KEY });
  };

  const [failure, setFailure] = React.useState<string | null>(null);

  // Optimistic update so dismissing an alert removes it from the list and
  // decrements the bell badge before the server confirms. invalidate()
  // reconciles any drift afterwards.
  const optimisticallyMarkOne = (id: number) => {
    const list = qc.getQueryData<UserAlertList | null>(ME_ALERTS_KEY);
    const dismissed = list?.alerts?.find((a) => a.id === id);
    const wasCritical = String(dismissed?.severity ?? "").toLowerCase() === "critical";
    qc.setQueryData<UserAlertList | null>(ME_ALERTS_KEY, (cur) =>
      cur ? { ...cur, alerts: cur.alerts.filter((a) => a.id !== id), unread: Math.max(0, cur.unread - 1) } : cur);
    qc.setQueryData<UserAlertCounts | null>(ME_ALERTS_UNREAD_KEY, (cur) =>
      cur
        ? {
            unreadCount: Math.max(0, cur.unreadCount - 1),
            criticalCount: wasCritical ? Math.max(0, cur.criticalCount - 1) : cur.criticalCount,
          }
        : cur);
  };
  const optimisticallyMarkAll = () => {
    qc.setQueryData<UserAlertList | null>(ME_ALERTS_KEY, (cur) => (cur ? { ...cur, alerts: [], unread: 0 } : cur));
    qc.setQueryData<UserAlertCounts | null>(ME_ALERTS_UNREAD_KEY, (cur) =>
      cur ? { unreadCount: 0, criticalCount: 0 } : cur);
  };

  const markAll = useMutation({ mutationFn: markAllAlertsRead });
  const markOne = useMutation({ mutationFn: (id: number) => markAlertRead(id) });

  const onMarkAll = async () => {
    const pid = markActionStart("alerts.markAllRead", { page: typeof location !== "undefined" ? location.pathname : undefined });
    setFailure(null);
    optimisticallyMarkAll();
    markUiFeedback(pid); markRenderComplete(pid);
    try {
      // A failed mutation must SAY so — the previous version swallowed a 410.
      if (!(await markAll.mutateAsync())) setFailure("Could not mark your alerts read. Nothing was changed.");
    } catch {
      setFailure("Could not mark your alerts read. Nothing was changed.");
    } finally { invalidate(); markActionEnd(pid); }
  };
  const onMarkOne = async (id: number) => {
    const pid = markActionStart("alerts.dismissOne", { page: typeof location !== "undefined" ? location.pathname : undefined });
    setFailure(null);
    optimisticallyMarkOne(id);
    markUiFeedback(pid); markRenderComplete(pid);
    try {
      if (!(await markOne.mutateAsync(id))) setFailure("Could not mark that alert read. Nothing was changed.");
    } catch {
      setFailure("Could not mark that alert read. Nothing was changed.");
    } finally { invalidate(); markActionEnd(pid); }
  };
  const onRefresh = async () => {
    const pid = markActionStart("alerts.refresh", { page: typeof location !== "undefined" ? location.pathname : undefined });
    setFailure(null);
    try { await refetch(); } finally { markActionEnd(pid); }
  };

  const alerts: UserAlert[] = data?.alerts ?? [];
  // `data === null` means the read itself failed. That is NOT an empty inbox.
  const unreadable = isError || data === null;

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col" data-testid="drawer-alerts">
        <SheetHeader>
          <SheetTitle>Alerts</SheetTitle>
          <SheetDescription>
            Your unread alerts — MT5 bridge, risk locks, live dispatch, coaching and session reminders.
            Only your own alerts appear here. Critical alerts can never be silenced.
          </SheetDescription>
        </SheetHeader>

        <div className="flex items-center gap-2 py-3 border-b">
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={isFetching} data-testid="button-alert-refresh">
            <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={onMarkAll} disabled={markAll.isPending || unreadable} data-testid="button-alert-mark-all">
            <CheckCheck className="h-4 w-4 mr-1" />
            Mark all read
          </Button>
          <Link href="/alert-preferences" className="ml-auto text-xs text-muted-foreground hover:underline" data-testid="link-alert-preferences">
            Preferences
          </Link>
        </div>

        {failure && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="alerts-drawer-error">
            {failure}
          </div>
        )}

        <ScrollArea className="flex-1 -mx-6 px-6">
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-6">Loading…</div>
          ) : unreadable ? (
            // Never "you're all caught up" when we could not read the store.
            <div className="text-sm text-warning py-6" data-testid="alerts-drawer-unreadable">
              Your alerts could not be loaded, so we cannot tell you whether you have any.
              This is not a confirmation that your inbox is empty — try Refresh.
            </div>
          ) : alerts.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6" data-testid="alerts-drawer-empty">
              No unread alerts.
            </div>
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
