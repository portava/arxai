// My Alerts — the user's trading radar inbox. Full redesign to the ARX
// dashboard direction. UI/UX + alert-management pass ONLY.
//
// Wiring preserved verbatim: data comes from GET /api/me/notifications
// (credentials-included, 5s poll, dismissed filtered out). Read/dismiss/
// read-all/bulk/clear-read all use the existing notification endpoints and
// invalidate the unread-count badge exactly as before. Categorization,
// severity ranking, and repeat-grouping are the existing presentational
// helpers. Every count and row is derived from real notifications.
//
// Snooze is intentionally ABSENT. The only snooze endpoint on the server
// (POST /api/notifications/:id/snooze) operates on the legacy Notification
// Center `notifications` table keyed by string notificationId — NOT the
// `user_notifications` rows (numeric serial id) this page lists via
// /api/me/notifications. Wiring it here would 404 on every row. A real
// per-user snooze needs a /api/me/notifications/:id/snooze surface plus
// snooze state on user_notifications (server + schema work, out of scope
// for this page).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { getGetAlertUnreadCountQueryKey } from "@workspace/api-client-react";
import {
  Bell, CheckCircle2, AlertTriangle, AlertOctagon, Info, X, CheckCheck,
  Clock, ShieldAlert, TrendingUp, Server, Sparkles, Cog, Search, Settings,
  MessageCircle, ChevronRight, Eye, CalendarDays, Globe, Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAssistantName } from "@/lib/assistant-name";

type Notification = {
  id: number;
  severity: string;
  status: string;
  title: string;
  message: string;
  symbol?: string | null;
  source?: string | null;
  notificationType?: string | null;
  repeatCount?: number | null;
  lastOccurrenceAt?: string | null;
  createdAt?: string | null;
};

const RUBY_OPEN_KEY = "arx.assistant.open.v2";
function openRubyLiveChat() {
  try {
    sessionStorage.setItem(RUBY_OPEN_KEY, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: RUBY_OPEN_KEY }));
  } catch { /* silent */ }
}

async function jget(url: string, init?: RequestInit) {
  const r = await fetch(url, { credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  const text = await r.text(); let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

const isUnread = (s: string) => String(s).toUpperCase() === "UNREAD";
const isRead = (s: string) => String(s).toUpperCase() === "READ";
const isDismissed = (s: string) => String(s).toUpperCase() === "DISMISSED";

const sevRank = (sev: string) => {
  const s = String(sev).toUpperCase();
  if (s === "CRITICAL" || s === "DANGER") return 4;
  if (s === "HIGH" || s === "WARNING") return 3;
  if (s === "SUCCESS" || s === "RESOLVED") return 1;
  return 2; // info/reminder
};
type SevKey = "critical" | "warning" | "reminder" | "info" | "resolved";
function sevKey(sev: string, type?: string | null): SevKey {
  const s = String(sev).toUpperCase();
  if (s === "CRITICAL" || s === "DANGER") return "critical";
  if (s === "HIGH" || s === "WARNING") return "warning";
  if (s === "SUCCESS" || s === "RESOLVED") return "resolved";
  if (String(type ?? "").toLowerCase().includes("remind") || String(type ?? "").toLowerCase().includes("review")) return "reminder";
  return "info";
}
const SEV_META: Record<SevKey, { label: string; text: string; dot: string; chip: string; icon: React.ReactNode }> = {
  critical: { label: "Critical", text: "text-danger", dot: "bg-danger", chip: "border-danger/40 bg-danger/10 text-danger", icon: <AlertOctagon size={16} className="text-danger" /> },
  warning:  { label: "Warning",  text: "text-warning", dot: "bg-warning", chip: "border-warning/40 bg-warning/10 text-warning", icon: <AlertTriangle size={16} className="text-warning" /> },
  reminder: { label: "Reminder", text: "text-[#A855F7]", dot: "bg-[#A855F7]", chip: "border-[#A855F7]/40 bg-[#A855F7]/10 text-[#A855F7]", icon: <Bell size={16} className="text-[#A855F7]" /> },
  info:     { label: "Info",     text: "text-primary", dot: "bg-primary", chip: "border-primary/40 bg-primary/10 text-primary", icon: <Info size={16} className="text-primary" /> },
  resolved: { label: "Resolved", text: "text-success", dot: "bg-success", chip: "border-success/40 bg-success/10 text-success", icon: <CheckCircle2 size={16} className="text-success" /> },
};

// Category model (presentational only — never mutates the alert).
type CategoryKey = "duration" | "execution" | "risk" | "mt5" | "market" | "system";
function categorize(n: Notification): CategoryKey {
  const t = String(n.notificationType ?? "").toLowerCase();
  const src = String(n.source ?? "").toLowerCase();
  const title = String(n.title ?? "").toLowerCase();
  if (t.includes("hold_time") || t.includes("near_breakeven") || title.includes("holding longer") || title.includes("intraday window")) return "duration";
  if (src === "risk" || t.includes("risk") || t.includes("kill") || t.includes("governor") || t.includes("cooldown") || t.includes("drawdown")) return "risk";
  if (src === "mt5" || t.includes("mt5") || t.includes("bridge") || t.includes("broker") || t.includes("heartbeat")) return "mt5";
  if (src === "ai" || t.includes("ruby") || t.includes("signal") || t.includes("scanner") || t.includes("market") || t.includes("opportunity")) return "market";
  if (src === "trade" || t.includes("trade_") || t.includes("position") || t.includes("fill") || t.includes("close")) return "execution";
  if (t.includes("calendar") || t.includes("news") || t.includes("event") || t.includes("cpi") || t.includes("fomc")) return "market";
  return "system";
}

// User-facing tabs mapped onto categories/severity.
type TabKey = "all" | "urgent" | "risk" | "trades" | "scanner" | "calendar" | "ruby" | "account";
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "all", label: "All" }, { key: "urgent", label: "Urgent" }, { key: "risk", label: "Risk" },
  { key: "trades", label: "Trades" }, { key: "scanner", label: "Scanner" }, { key: "calendar", label: "Calendar" },
  { key: "ruby", label: "Assistant" }, { key: "account", label: "Account" },
];
function tabSource(n: Notification): string {
  const t = String(n.notificationType ?? "").toLowerCase();
  const src = String(n.source ?? "").toLowerCase();
  if (t.includes("calendar") || t.includes("news") || t.includes("cpi") || t.includes("fomc") || t.includes("event")) return "calendar";
  if (t.startsWith("heat_")) return "scanner";
  if (src === "heat") return "scanner";
  if (src === "risk" || categorize(n) === "risk") return "risk";
  if (src === "mt5" || categorize(n) === "mt5") return "account";
  if (t.includes("scanner") || t.includes("signal") || t.includes("scalp")) return "scanner";
  if (src === "ai" || t.includes("ruby") || t.includes("review") || t.includes("lesson") || t.includes("remind")) return "ruby";
  const c = categorize(n);
  if (c === "execution" || c === "duration") return "trades";
  return "account";
}
function matchesTab(n: Notification, tab: TabKey): boolean {
  if (tab === "all") return true;
  if (tab === "urgent") return sevRank(n.severity) >= 4;
  return tabSource(n) === tab;
}

function fmtShort(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtFull(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function Alerts() {
  const [, navigate] = useLocation();
  const { name } = useAssistantName();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabKey>("all");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "unread" | "read">("all");
  const [selected, setSelected] = useState<Notification | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const qc = useQueryClient();

  const invalidateBadge = () => {
    qc.invalidateQueries({ queryKey: getGetAlertUnreadCountQueryKey() });
    qc.invalidateQueries({ queryKey: ["me", "alerts", "unread-count"] });
  };

  const load = useCallback(async () => {
    const r = await jget("/api/me/notifications");
    const list: Notification[] = Array.isArray(r.body?.notifications) ? r.body.notifications : [];
    setItems(list.filter((n) => !isDismissed(n.status)));
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => clearInterval(t);
  }, [load]);

  // ── Actions (preserved endpoints) ─────────────────────────────────────────
  const markRead = async (id: number) => {
    setItems((prev) => prev ? prev.map((n) => n.id === id ? { ...n, status: "read" } : n) : prev);
    await jget(`/api/me/notifications/${id}/read`, { method: "POST" });
    void load(); invalidateBadge();
  };
  const dismiss = async (id: number) => {
    setItems((prev) => prev ? prev.filter((n) => n.id !== id) : prev);
    if (selected?.id === id) setSelected(null);
    await jget(`/api/me/notifications/${id}/dismiss`, { method: "POST" });
    void load(); invalidateBadge();
  };
  const markAllRead = async () => {
    setBusy(true);
    await jget("/api/me/notifications/read-all", { method: "POST" });
    await load(); invalidateBadge(); setBusy(false);
  };
  const clearRead = async () => {
    setBusy(true);
    setItems((prev) => prev ? prev.filter((n) => !isRead(n.status)) : prev);
    await jget("/api/me/notifications/clear-read", { method: "POST" });
    await load(); invalidateBadge(); setBusy(false);
  };

  const all = items ?? [];
  const loading = items === null;

  // ── Derived counts (real) ─────────────────────────────────────────────────
  const counts = useMemo(() => {
    const total = all.length;
    const unread = all.filter((n) => isUnread(n.status)).length;
    const urgent = all.filter((n) => sevRank(n.severity) >= 4).length;
    const bySev: Record<SevKey, number> = { critical: 0, warning: 0, reminder: 0, info: 0, resolved: 0 };
    const byTab: Record<string, number> = {};
    for (const n of all) {
      bySev[sevKey(n.severity, n.notificationType)]++;
      const s = tabSource(n);
      byTab[s] = (byTab[s] ?? 0) + 1;
    }
    return { total, unread, urgent, bySev, byTab };
  }, [all]);

  const visible = useMemo(() => {
    let list = all.filter((n) => matchesTab(n, tab));
    if (statusFilter === "unread") list = list.filter((n) => isUnread(n.status));
    else if (statusFilter === "read") list = list.filter((n) => isRead(n.status));
    if (query) list = list.filter((n) => `${n.title} ${n.message} ${n.symbol ?? ""}`.toLowerCase().includes(query.toLowerCase()));
    return list.sort((a, b) => {
      const ar = isUnread(a.status) ? 1 : 0, br = isUnread(b.status) ? 1 : 0;
      if (ar !== br) return br - ar;
      return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
    });
  }, [all, tab, statusFilter, query]);

  // Timeline (chronological, newest first).
  const timeline = useMemo(() =>
    [...all].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()).slice(0, 6),
  [all]);

  // Grouped repeated alerts (repeatCount > 1).
  const grouped = useMemo(() =>
    all.filter((n) => (n.repeatCount ?? 0) > 1)
      .sort((a, b) => (b.repeatCount ?? 0) - (a.repeatCount ?? 0)).slice(0, 5),
  [all]);

  const sysStatus = counts.urgent > 0 ? { label: "Needs Attention", tone: "text-warning" } : counts.total > 0 ? { label: "Monitoring", tone: "text-success" } : { label: "Quiet", tone: "text-txt-secondary" };

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 p-4 md:p-6 pb-32 md:pb-6">
      {/* Hero */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#A855F7]/10 text-[#A855F7] ring-1 ring-[#A855F7]/25">
            <Bell className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold leading-tight">My Alerts</h1>
            <p className="text-sm text-txt-secondary">Track trading alerts, risk warnings, {name} reminders, and account notifications.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={openRubyLiveChat} className="inline-flex items-center gap-2 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby hover:bg-ruby/15">
            <MessageCircle className="h-4 w-4" /> Ask {name}
          </button>
          <button onClick={() => setSettingsOpen((v) => !v)} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
            <Settings className="h-4 w-4" /> Alert Settings
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="rounded-2xl border border-border bg-card p-4 text-sm text-txt-secondary">
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground">Alert Settings</span>
            <div className="flex gap-2">
              <button onClick={markAllRead} disabled={busy} className="rounded-lg border border-border px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-50">Mark all read</button>
              <button onClick={clearRead} disabled={busy} className="rounded-lg border border-border px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-50">Clear read</button>
            </div>
          </div>
          <p className="mt-2">Per-category delivery preferences will appear here.</p>
        </div>
      )}

      {/* Alert Overview */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-txt-muted">Alert Overview</div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Ov label="Total Alerts" sub="All time" value={String(counts.total)} />
          <Ov label="Urgent" sub="Requires action" value={String(counts.urgent)} tone="text-danger" />
          <Ov label="Unread" sub="New alerts" value={String(counts.unread)} tone="text-primary" />
          <Ov label="Risk Alerts" sub="Risk & exposure" value={String(counts.byTab["risk"] ?? 0)} tone="text-warning" />
          <Ov label="Trade Alerts" sub="Positions & fills" value={String(counts.byTab["trades"] ?? 0)} />
          <Ov label="Scanner Alerts" sub="Signals" value={String(counts.byTab["scanner"] ?? 0)} />
          <Ov label="System" sub={sysStatus.label} value="" tone={sysStatus.tone} icon={<Activity className="h-4 w-4 text-success" />} />
        </div>
      </div>

      {/* Ruby read + severity */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-[#A855F7]/25 bg-card p-4 lg:col-span-2">
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-[#A855F7]" /><h3 className="text-sm font-semibold text-[#A855F7]">{name}’s Alert Read</h3></div>
          {counts.total === 0 ? (
            <p className="mt-2 text-sm text-txt-muted">{name} will summarize alerts when alert history is available.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-txt-secondary">
                You have {counts.urgent} alert{counts.urgent === 1 ? "" : "s"} that need attention and {counts.unread} unread.
                {counts.urgent > 0 ? " Review the urgent items before entering another trade." : " Nothing critical right now — stay aware."}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Pill label={`Unread: ${counts.unread}`} tone="border-primary/40 text-primary" />
                <Pill label={`Urgent: ${counts.urgent}`} tone="border-danger/40 text-danger" />
                <Pill label={`Risk alerts: ${counts.byTab["risk"] ?? 0}`} tone="border-warning/40 text-warning" />
              </div>
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={openRubyLiveChat} className="inline-flex items-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-2.5 py-1.5 text-xs text-ruby"><MessageCircle className="h-3.5 w-3.5" /> Ask {name}</button>
            <button onClick={() => setTab("urgent")} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground hover:border-primary/40"><AlertTriangle className="h-3.5 w-3.5" /> Review Urgent</button>
            <button onClick={markAllRead} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground hover:border-primary/40 disabled:opacity-50"><CheckCheck className="h-3.5 w-3.5" /> Mark all read</button>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-txt-muted">Alerts by Severity</div>
          <div className="mt-3 space-y-2">
            {(["critical","warning","reminder","info","resolved"] as SevKey[]).map((k) => {
              const c = counts.bySev[k];
              const pct = counts.total ? Math.round((c / counts.total) * 100) : 0;
              return (
                <div key={k}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="inline-flex items-center gap-1.5"><span className={cn("h-2 w-2 rounded-full", SEV_META[k].dot)} /><span className="text-txt-secondary">{SEV_META[k].label}</span></span>
                    <span className="text-txt-muted">{c} ({pct}%)</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-secondary"><div className={cn("h-1.5 rounded-full", SEV_META[k].dot)} style={{ width: `${pct}%` }} /></div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main: list + detail */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          {/* Tabs */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {TABS.map(({ key, label }) => {
              const c = key === "all" ? counts.total : key === "urgent" ? counts.urgent : counts.byTab[key] ?? 0;
              return (
                <button key={key} onClick={() => setTab(key)}
                  className={cn("shrink-0 rounded-lg border px-3 py-1.5 text-sm", tab === key ? "border-primary bg-primary text-white" : "border-border bg-card text-txt-secondary hover:text-foreground")}>
                  {key === "ruby" ? name : label} <span className={cn("ml-1 text-xs", tab === key ? "text-white/80" : "text-txt-muted")}>{c}</span>
                </button>
              );
            })}
          </div>

          {/* Search + status */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[160px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-muted" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search alerts…" className="w-full rounded-lg border border-border bg-card pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
            </div>
            {(["all","unread","read"] as const).map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={cn("rounded-lg border px-3 py-2 text-sm capitalize", statusFilter === s ? "border-primary bg-primary text-white" : "border-border bg-card text-txt-secondary hover:text-foreground")}>
                {s === "all" ? "All Status" : s}
              </button>
            ))}
          </div>

          {/* Alert list */}
          <div className="rounded-2xl border border-border bg-card p-2">
            {loading ? (
              <p className="py-10 text-center text-sm text-txt-muted">Loading alerts…</p>
            ) : visible.length === 0 ? (
              <p className="py-10 text-center text-sm text-txt-muted">{tab === "urgent" ? "No urgent alerts." : statusFilter === "unread" ? "No unread alerts." : `No alerts right now. ${name} will notify you when something needs attention.`}</p>
            ) : (
              <div className="divide-y divide-border/60">
                {visible.map((n) => {
                  const sk = sevKey(n.severity, n.notificationType);
                  const unread = isUnread(n.status);
                  return (
                    <button key={n.id} onClick={() => setSelected(n)}
                      className={cn("flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left hover:bg-background/40", selected?.id === n.id && "bg-background/40 ring-1 ring-primary/30")}>
                      <span className="mt-0.5 shrink-0">{SEV_META[sk].icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cn("truncate text-sm", unread ? "font-semibold text-foreground" : "text-txt-secondary")}>{n.title}</span>
                          {(n.repeatCount ?? 0) > 1 && <span className="rounded bg-secondary px-1.5 text-[10px] text-txt-muted">×{n.repeatCount}</span>}
                        </div>
                        <div className="mt-0.5 text-[11px] text-txt-muted capitalize">{tabSource(n)} · {n.source ?? n.notificationType ?? "alert"}</div>
                        {n.symbol && <div className="mt-1 flex flex-wrap gap-1">{n.symbol.split(/[,\s]+/).filter(Boolean).slice(0, 4).map((s) => <span key={s} className="rounded border border-border bg-secondary/60 px-1.5 py-0.5 text-[10px] text-txt-secondary">{s}</span>)}</div>}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", SEV_META[sk].chip)}>{SEV_META[sk].label}</span>
                        <span className="text-[11px] text-txt-muted">{fmtShort(n.createdAt)}</span>
                        <span className={cn("inline-flex items-center gap-1 text-[11px]", unread ? "text-primary" : "text-txt-muted")}>
                          {unread ? <><span className="h-1.5 w-1.5 rounded-full bg-primary" /> Unread</> : <><CheckCheck className="h-3 w-3" /> Read</>}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Detail panel */}
        <div className="rounded-2xl border border-border bg-card p-4">
          {!selected ? (
            <div className="text-sm text-txt-muted">Select an alert to see its detail.</div>
          ) : (() => {
            const sk = sevKey(selected.severity, selected.notificationType);
            const src = tabSource(selected);
            return (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-txt-muted">Alert Detail</div>
                  <button onClick={() => setSelected(null)} className="text-txt-muted hover:text-foreground"><X className="h-4 w-4" /></button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", SEV_META[sk].chip)}>{SEV_META[sk].label}</span>
                  <span className="text-xs text-txt-muted capitalize">{src}</span>
                </div>
                <h3 className="mt-2 text-lg font-bold leading-tight">{selected.title}</h3>
                <div className="mt-0.5 text-xs text-txt-muted">{fmtFull(selected.createdAt)}</div>
                <p className="mt-3 text-sm text-txt-secondary">{selected.message}</p>
                {selected.symbol && (
                  <div className="mt-3">
                    <div className="text-[11px] text-txt-muted">Related Symbols</div>
                    <div className="mt-1 flex flex-wrap gap-1">{selected.symbol.split(/[,\s]+/).filter(Boolean).map((s) => <span key={s} className="rounded border border-border bg-secondary/60 px-1.5 py-0.5 text-xs text-txt-secondary">{s}</span>)}</div>
                  </div>
                )}
                {(selected.repeatCount ?? 0) > 1 && (
                  <div className="mt-3 text-xs text-txt-muted">Repeated {selected.repeatCount} times · last {fmtShort(selected.lastOccurrenceAt ?? selected.createdAt)}</div>
                )}

                {/* Context-aware actions */}
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button onClick={openRubyLiveChat} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ruby/15 border border-ruby/40 px-3 py-2 text-xs text-ruby"><MessageCircle className="h-3.5 w-3.5" /> Ask {name}</button>
                  {src === "calendar" && <button onClick={() => navigate("/economic-calendar")} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40"><CalendarDays className="h-3.5 w-3.5" /> View Calendar</button>}
                  {src === "scanner" && !String(selected?.notificationType ?? "").startsWith("heat_") && <button onClick={() => navigate("/market-scanner")} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40"><Search className="h-3.5 w-3.5" /> Open Scanner</button>}
                  {src === "scanner" && String(selected?.notificationType ?? "").startsWith("heat_") && <button onClick={() => navigate("/market-heat-map")} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40"><Globe className="h-3.5 w-3.5" /> Heat Map</button>}
                  {src === "trades" && <button onClick={() => navigate("/my-trades")} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40"><TrendingUp className="h-3.5 w-3.5" /> Open Trades</button>}
                  {(src === "risk" || src === "account") && <button onClick={() => navigate(src === "risk" ? "/risk-settings" : "/analytics")} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40"><ShieldAlert className="h-3.5 w-3.5" /> {src === "risk" ? "Review Risk" : "View Account"}</button>}
                  {isUnread(selected.status) && <button onClick={() => markRead(selected.id)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40"><CheckCheck className="h-3.5 w-3.5" /> Mark Read</button>}
                  <button onClick={() => dismiss(selected.id)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-danger/40 px-3 py-2 text-xs text-danger hover:bg-danger/10"><X className="h-3.5 w-3.5" /> Dismiss</button>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* Lower: timeline + grouped + quick filters */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2"><Clock className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Alert Timeline</h3></div>
          <div className="mt-3 space-y-2">
            {timeline.length === 0 ? (
              <p className="text-xs text-txt-muted">Alert history will appear here as events happen.</p>
            ) : timeline.map((n) => {
              const sk = sevKey(n.severity, n.notificationType);
              return (
                <div key={n.id} className="flex items-center gap-2 text-xs">
                  <span className="w-16 shrink-0 text-txt-muted">{fmtShort(n.createdAt)}</span>
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", SEV_META[sk].dot)} />
                  <span className="min-w-0 flex-1 truncate text-txt-secondary">{n.title}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2"><Server className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Grouped Alerts</h3></div>
          <div className="mt-3 space-y-2">
            {grouped.length === 0 ? (
              <p className="text-xs text-txt-muted">No grouped alerts right now.</p>
            ) : grouped.map((n) => {
              const sk = sevKey(n.severity, n.notificationType);
              return (
                <button key={n.id} onClick={() => setSelected(n)} className="flex w-full items-center gap-2 rounded-lg border border-border bg-background/40 px-2.5 py-2 text-left hover:border-primary/40">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-bold">{n.repeatCount}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{n.title}</div>
                    <div className="text-[11px] text-txt-muted">Repeated {n.repeatCount} times · last {fmtShort(n.lastOccurrenceAt ?? n.createdAt)}</div>
                  </div>
                  <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", SEV_META[sk].chip)}>{SEV_META[sk].label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2"><Eye className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Quick Filters</h3></div>
          <div className="mt-3 space-y-2">
            <QF label="Unread" count={counts.unread} active={statusFilter === "unread"} onClick={() => setStatusFilter(statusFilter === "unread" ? "all" : "unread")} />
            <QF label="Urgent" count={counts.urgent} active={tab === "urgent"} onClick={() => setTab(tab === "urgent" ? "all" : "urgent")} />
            <QF label="Risk" count={counts.byTab["risk"] ?? 0} active={tab === "risk"} onClick={() => setTab(tab === "risk" ? "all" : "risk")} />
            <QF label={`${name} Reminders`} count={counts.byTab["ruby"] ?? 0} active={tab === "ruby"} onClick={() => setTab(tab === "ruby" ? "all" : "ruby")} />
            <QF label="Scanner Signals" count={counts.byTab["scanner"] ?? 0} active={tab === "scanner"} onClick={() => setTab(tab === "scanner" ? "all" : "scanner")} />
          </div>
          <button onClick={() => { setTab("all"); setStatusFilter("all"); setQuery(""); }} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-txt-secondary hover:border-primary/40"><X className="h-3.5 w-3.5" /> Clear Filters</button>
        </div>
      </div>
    </div>
  );
}

function Ov({ label, sub, value, tone, icon }: { label: string; sub: string; value: string; tone?: string; icon?: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-txt-muted">{label}</div>
      <div className={cn("text-2xl font-bold leading-tight", tone ?? "text-foreground")}>{value || <span className={tone}>{sub}</span>}{value && icon}</div>
      {value && <div className="text-[10px] text-txt-muted">{sub}</div>}
    </div>
  );
}
function Pill({ label, tone }: { label: string; tone: string }) {
  return <span className={cn("rounded-lg border bg-background/40 px-2 py-0.5 text-[11px]", tone)}>{label}</span>;
}
function QF({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-sm", active ? "border-primary bg-primary/10 text-primary" : "border-border bg-background/40 text-txt-secondary hover:text-foreground")}>
      <span>{label}</span>
      <span className={cn("rounded px-1.5 text-xs", active ? "bg-primary/20 text-primary" : "bg-secondary text-txt-muted")}>{count}</span>
    </button>
  );
}
