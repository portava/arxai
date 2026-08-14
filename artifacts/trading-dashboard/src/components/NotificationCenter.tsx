// Phase 10G — Notification Center (bell + panel + filters).
// Polls /api/me/notifications. Mark-as-read / dismiss / read-all. Honors empty state.
import { useState } from "react";
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

  const unread = q.data?.unread ?? 0;
  const list = (q.data?.notifications ?? []).filter((n) => filter === "all" ? true : n.source === filter);

  return (
    <div className="relative">
      <Button variant="ghost" size="icon" onClick={() => setOpen((v) => !v)} aria-label="Notifications">
        <Bell className="w-5 h-5" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] rounded-full bg-rose-600 text-white">{unread}</span>
        )}
      </Button>
      {open && (
        <div className="absolute right-0 mt-2 w-[380px] max-h-[80vh] overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-xl z-50">
          <div className="flex items-center justify-between p-3 border-b border-zinc-800">
            <div className="font-semibold">Notifications</div>
            <Button variant="ghost" size="sm" onClick={() => mAll.mutate()} disabled={unread === 0}>Mark all read</Button>
          </div>
          <div className="flex flex-wrap gap-1 p-2 border-b border-zinc-800">
            {SOURCES.map((s) => (
              <button key={s} onClick={() => setFilter(s)} className={`px-2 py-1 text-xs rounded ${filter === s ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-300"}`}>{s}</button>
            ))}
          </div>
          {q.isLoading && <div className="p-4 text-sm text-zinc-400">Loading…</div>}
          {!q.isLoading && list.length === 0 && (
            <div className="p-6 text-sm text-zinc-400 text-center">
              <div>No notifications yet</div>
              <div className="text-xs mt-1">Important bridge, risk, trade, and AI updates will appear here</div>
            </div>
          )}
          {list.map((n) => (
            <div key={n.id} className={`p-3 border-b border-zinc-800 ${n.status === "unread" ? "bg-zinc-800/40" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={n.severity === "critical" ? "destructive" : n.severity === "warning" ? "secondary" : "outline"}>{n.severity}</Badge>
                    <span className="text-xs text-zinc-500">{n.source}</span>
                  </div>
                  <div className="font-medium text-sm mt-1 truncate">{n.title}</div>
                  {n.message && <div className="text-xs text-zinc-400 mt-1">{n.message}</div>}
                  {n.actionLabel && n.actionTarget && (
                    <a href={n.actionTarget} className="inline-block mt-1 text-xs text-blue-400 hover:underline">{n.actionLabel} →</a>
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
