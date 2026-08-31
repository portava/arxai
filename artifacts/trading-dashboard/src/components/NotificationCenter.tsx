// Phase 10G — Notification Center (bell + panel + filters).
// Polls /api/me/notifications. Mark-as-read / dismiss / read-all. Honors empty state.
import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Notif = {
  id: number; notificationType: string; severity: "info" | "warning" | "critical";
  title: string; message: string; source: string; status: "unread" | "read" | "dismissed";
  actionLabel: string | null; actionTarget: string | null; createdAt: string;
};
type Resp = { notifications: Notif[]; unread: number; isEmpty: boolean };

const SOURCES = ["all", "mt5", "risk", "trade", "ai", "playbook", "system"] as const;
type Source = typeof SOURCES[number];

async function getJSON<T>(u: string): Promise<T> {
  const r = await fetch(u, { credentials: "include" });
  if (!r.ok) throw new Error(`${u} ${r.status}`);
  return (await r.json()) as T;
}
async function postJSON(u: string) {
  const r = await fetch(u, { method: "POST", credentials: "include" });
  if (!r.ok) throw new Error(`${u} ${r.status}`);
  return r.json();
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Source>("all");
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["meNotifications"],
    queryFn: () => getJSON<Resp>("/api/me/notifications"),
    refetchInterval: 15_000,
  });
  const mRead = useMutation({ mutationFn: (id: number) => postJSON(`/api/me/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ["meNotifications"] }) });
  const mDismiss = useMutation({ mutationFn: (id: number) => postJSON(`/api/me/notifications/${id}/dismiss`), onSuccess: () => qc.invalidateQueries({ queryKey: ["meNotifications"] }) });
  const mAll = useMutation({ mutationFn: () => postJSON("/api/me/notifications/read-all"), onSuccess: () => qc.invalidateQueries({ queryKey: ["meNotifications"] }) });

  // A failed read is UNKNOWN, not zero: the bell must not look clean when we
  // could not see the queue. (q.data survives a later failed refetch, so the
  // unknown state only applies when we have never had a successful read.)
  const readFailed = q.isError && q.data == null;
  const unread = q.data?.unread ?? 0;
  const list = (q.data?.notifications ?? []).filter((n) => filter === "all" ? true : n.source === filter);

  return (
    <div className="relative">
      <Button variant="ghost" size="icon" onClick={() => setOpen((v) => !v)} aria-label="Notifications">
        <Bell className="w-5 h-5" />
        {readFailed ? (
          <span
            className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] rounded-full bg-warning text-black"
            title="Notifications could not be loaded — unread count unknown"
            data-testid="notif-badge-unknown"
          >?</span>
        ) : unread > 0 ? (
          <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] rounded-full bg-danger text-white">{unread}</span>
        ) : null}
      </Button>
      {open && (
        <div className="absolute right-0 mt-2 w-[380px] max-h-[80vh] overflow-y-auto rounded-md border border-border bg-card shadow-xl z-50">
          <div className="flex items-center justify-between p-3 border-b border-border">
            <div className="font-semibold">Notifications</div>
            <Button variant="ghost" size="sm" onClick={() => mAll.mutate()} disabled={unread === 0}>Mark all read</Button>
          </div>
          <div className="flex flex-wrap gap-1 p-2 border-b border-border">
            {SOURCES.map((s) => (
              <button key={s} onClick={() => setFilter(s)} className={`px-2 py-1 text-xs rounded ${filter === s ? "bg-primary text-white" : "bg-secondary text-txt-secondary"}`}>{s}</button>
            ))}
          </div>
          {q.isLoading && <div className="p-4 text-sm text-txt-secondary">Loading…</div>}
          {/* Failed read ≠ empty queue. "No notifications yet" may only render
              after a successful response returned an empty list. */}
          {!q.isLoading && readFailed && (
            <div className="p-6 text-sm text-center" role="alert" data-testid="notif-panel-error">
              <div className="font-medium text-warning">Couldn&apos;t load your alerts — treat this as unknown, not as clear.</div>
              <button
                type="button"
                className="mt-2 px-2 py-1 text-xs rounded border border-warning/50 text-warning hover:bg-warning/10"
                onClick={() => void q.refetch()}
                disabled={q.isFetching}
              >
                {q.isFetching ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
          {!q.isLoading && !readFailed && list.length === 0 && (
            <div className="p-6 text-sm text-txt-secondary text-center">
              <div>No notifications yet</div>
              <div className="text-xs mt-1">Important bridge, risk, trade, and AI updates will appear here</div>
            </div>
          )}
          {list.map((n) => (
            <div key={n.id} className={`p-3 border-b border-border ${n.status === "unread" ? "bg-muted/40" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={n.severity === "critical" ? "destructive" : n.severity === "warning" ? "secondary" : "outline"}>{n.severity}</Badge>
                    <span className="text-xs text-txt-muted">{n.source}</span>
                  </div>
                  <div className="font-medium text-sm mt-1 truncate">{n.title}</div>
                  {n.message && <div className="text-xs text-txt-secondary mt-1">{n.message}</div>}
                  {n.actionLabel && n.actionTarget && (
                    <Link href={n.actionTarget} className="inline-block mt-1 text-xs text-primary hover:underline">{n.actionLabel} →</Link>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {n.status === "unread" && (
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => mRead.mutate(n.id)} aria-label="Mark read"><Check className="w-3 h-3" /></Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => mDismiss.mutate(n.id)} aria-label="Dismiss"><X className="w-3 h-3" /></Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default NotificationCenter;
