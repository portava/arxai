import { useEffect, useState } from "react";
import PushSettingsCard from "../components/PushSettingsCard";
import { EmptyState } from "@/components/trading/EmptyState";
import { Bell } from "lucide-react";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useViewMode } from "@/hooks/useViewMode";
import { safeArray, safeDate, safeString } from "@/lib/safeFormat";

type Notif = {
  notificationId: string;
  type: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status: "UNREAD" | "READ" | "ACKNOWLEDGED" | "DISMISSED" | "SNOOZED";
  title: string;
  message: string;
  sourceBuild: string;
  symbol: string | null;
  recommendedAction: string | null;
  actionUrl: string | null;
  repeatCount: number;
  snoozedUntil: string | null;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
};

type Counts = {
  total: number; unread: number; critical: number; criticalUnread: number;
  high: number; warning: number; info: number;
  byType: Record<string, number>; byStatus: Record<string, number>;
};

type Digest = {
  digestId: string;
  rangeStart: string; rangeEnd: string;
  totalNotifications: number;
  criticalCount: number; warningCount: number;
  tradeCount: number; learningCount: number; safetyCount: number;
  summary: { bySeverity?: Record<string, number>; byType?: Record<string, number>; bySourceBuild?: Record<string, number>; actionRequired?: number; topCritical?: Array<{ id: string; title: string }> };
} | null;

// Seeded operator rows carry `metadata.demo = true` and an "[DEMO] " title
// prefix from seedDemo(). Either marker is enough to badge the row.
export function isDemoRow(n: { title?: string; metadata?: unknown }): boolean {
  if (typeof n.title === "string" && n.title.startsWith("[DEMO] ")) return true;
  const meta = n.metadata as { demo?: unknown } | null | undefined;
  return meta?.demo === true;
}

const SEV_COLOR: Record<string, string> = {
  CRITICAL: "bg-danger text-foreground",
  HIGH:     "bg-warning text-foreground",
  WARNING:  "bg-warning text-black",
  INFO:     "bg-primary text-foreground",
};

export default function NotificationsPage() {
  const mode = useTradingMode();
  const { effectiveIsAdmin: isAdmin } = useViewMode();
  const [items, setItems] = useState<Notif[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [digest, setDigest] = useState<Digest>(null);
  const [filterType, setFilterType] = useState("");
  const [filterSev, setFilterSev] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");

  async function refresh() {
    const params = new URLSearchParams();
    if (filterType) params.set("type", filterType);
    if (filterSev) params.set("severity", filterSev);
    if (filterStatus) params.set("status", filterStatus);
    params.set("limit", "100");
    const [n, c, d] = await Promise.all([
      fetch(`/api/notifications?${params.toString()}`).then(r => r.json()),
      fetch(`/api/notifications/counts`).then(r => r.json()),
      fetch(`/api/notifications/digest`).then(r => r.json()),
    ]);
    setItems(n.notifications ?? []);
    setCounts(c.counts ?? null);
    setDigest(d.digest ?? null);
  }
  useEffect(() => { void refresh(); }, [filterType, filterSev, filterStatus]);

  // The status line used to render the raw endpoint path back at the user
  // ("OK: /api/notifications/demo"). Callers now pass what actually happened.
  async function call(path: string, init: RequestInit = {}, okMessage = "Done.") {
    setBusy(true); setMsg("");
    try {
      const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
      const r = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok || r?.error) setMsg(r?.error ? `Not done — ${r.error}` : `Not done — the server refused (HTTP ${res.status}).`);
      else setMsg(okMessage);
    } catch { setMsg("Not done — the request did not reach the server."); }
    finally { await refresh(); setBusy(false); }
  }

  const safeItems = safeArray(items);
  const visible = safeItems.filter(n =>
    !search ||
    safeString(n.title, "").toLowerCase().includes(search.toLowerCase()) ||
    safeString(n.message, "").toLowerCase().includes(search.toLowerCase())
  );

  const criticalUnread = safeItems.filter(n => n.severity === "CRITICAL" && n.status === "UNREAD");

  // T003-5: the LIVE TRADING DISABLED badge was a lie any time the
  // user was actually armed for live. Notifications are an alert channel
  // and never place trades themselves — that copy belongs on the trade
  // pages, not here. We show only the alerts-only marker and let the
  // global SafetyHeader own the trading-mode badge.
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-bold">Notification Center</h1>
        <span className="px-2 py-1 rounded text-xs bg-ruby text-foreground">ALERTS ONLY</span>
        {mode.envelope && (
          <span
            className="px-2 py-1 rounded text-xs bg-secondary text-foreground"
            data-testid="notifications-mode-label"
            title={mode.cleanUserMessage}
          >
            {mode.cleanModeLabel}
          </span>
        )}
      </div>
      <p className="text-sm text-txt-muted">Trade, risk, and system alerts for your account. This page never places trades — it only shows what your bot or operator already did.</p>

      <PushSettingsCard />

      {/* Critical safety banner — always visible if any unread CRITICAL exists */}
      {criticalUnread.length > 0 && (
        <div className="border-2 border-danger bg-danger dark:bg-danger p-3 rounded space-y-2" data-testid="critical-safety-banner">
          <div className="font-bold text-danger dark:text-danger">⚠ {criticalUnread.length} CRITICAL alert{criticalUnread.length > 1 ? "s" : ""} — review immediately</div>
          {criticalUnread.slice(0, 5).map(n => (
            <div key={n.notificationId} className="flex justify-between items-start gap-2 text-sm">
              <div className="flex-1">
                <div className="font-semibold">{n.title}</div>
                <div className="text-xs opacity-80">{n.message}</div>
                {n.recommendedAction && <div className="text-xs italic mt-1">→ {n.recommendedAction}</div>}
              </div>
              <button disabled={busy} onClick={() => call(`/api/notifications/${n.notificationId}/acknowledge`, { method: "POST" })}
                className="px-2 py-1 bg-danger hover:bg-danger text-foreground rounded text-xs">Acknowledge</button>
            </div>
          ))}
        </div>
      )}

      {/* Counts panel */}
      {counts && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 text-sm" data-testid="counts-panel">
          <div className="border rounded p-2"><div className="text-xs opacity-60">Total</div><div className="font-bold text-lg">{counts.total}</div></div>
          <div className="border rounded p-2"><div className="text-xs opacity-60">Unread</div><div className="font-bold text-lg">{counts.unread}</div></div>
          <div className="border rounded p-2 bg-danger dark:bg-danger"><div className="text-xs opacity-60">Critical</div><div className="font-bold text-lg text-danger dark:text-danger">{counts.critical}</div></div>
          <div className="border rounded p-2 bg-danger dark:bg-danger"><div className="text-xs opacity-60">Critical Unread</div><div className="font-bold text-lg text-danger dark:text-danger">{counts.criticalUnread}</div></div>
          <div className="border rounded p-2"><div className="text-xs opacity-60">High</div><div className="font-bold text-lg">{counts.high}</div></div>
          <div className="border rounded p-2"><div className="text-xs opacity-60">Warning</div><div className="font-bold text-lg">{counts.warning}</div></div>
          <div className="border rounded p-2"><div className="text-xs opacity-60">Info</div><div className="font-bold text-lg">{counts.info}</div></div>
        </div>
      )}

      {/* Action bar
          RANK 79: "Generate demo" and "Ingest from system" were offered to
          every end user. seedDemo() writes FABRICATED CRITICAL safety alerts
          ("Risk Governor LOCKED", "Unsafe BROKER_MODE rejected") into the
          caller's real inbox and instantly fires the red critical banner above
          — a curious trader could not tell them from the real thing. Both are
          operator tools and are admin-gated on the server; the UI no longer
          offers them to anyone else. The status line also printed raw endpoint
          paths ("OK: /api/notifications/demo") at every user; it reports a
          plain-English outcome now. */}
      <div className="flex flex-wrap gap-2 items-center">
        <button disabled={busy} onClick={() => call("/api/notifications/mark-all-read", { method: "POST" }, "All notifications marked read.")}
          className="px-3 py-1.5 bg-muted hover:bg-muted text-foreground rounded text-sm">Mark all read</button>
        <button disabled={busy} onClick={() => call("/api/notifications/digest/generate", { method: "POST", body: "{}" }, "Digest rebuilt from your own notifications.")}
          className="px-3 py-1.5 bg-success hover:bg-success text-foreground rounded text-sm">Rebuild my digest</button>
        <button disabled={busy} onClick={refresh}
          className="px-3 py-1.5 bg-muted hover:bg-muted text-foreground rounded text-sm">Refresh</button>
        {isAdmin && (
          <>
            <span className="text-[10px] uppercase tracking-wider text-txt-muted pl-2 border-l border-border">Operator</span>
            <button disabled={busy} onClick={() => call("/api/notifications/demo", { method: "POST" }, "Seeded [DEMO] notifications into your own inbox.")}
              className="px-3 py-1.5 bg-secondary hover:bg-secondary text-foreground rounded text-sm">Seed [DEMO] rows</button>
            <button disabled={busy} onClick={() => call("/api/notifications/ingest", { method: "POST", body: "{}" }, "Re-ingested from every source build.")}
              className="px-3 py-1.5 bg-secondary hover:bg-secondary text-foreground rounded text-sm">Ingest from system</button>
          </>
        )}
        {msg && <span className="text-xs text-txt-muted" data-testid="notifications-status">{msg}</span>}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center text-sm">
        <select value={filterType} onChange={e => setFilterType(e.target.value)} className="border rounded px-2 py-1 bg-background">
          <option value="">All types</option>
          {["SAFETY","RISK","TRADE","LEARNING","SYSTEM","COACH","DATA","REPLAY","BROKER"].map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={filterSev} onChange={e => setFilterSev(e.target.value)} className="border rounded px-2 py-1 bg-background">
          <option value="">All severities</option>
          {["CRITICAL","HIGH","WARNING","INFO"].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border rounded px-2 py-1 bg-background">
          <option value="">All statuses</option>
          {["UNREAD","READ","ACKNOWLEDGED","DISMISSED","SNOOZED"].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search…" className="border rounded px-2 py-1 bg-background" />
      </div>

      {/* List */}
      <div className="border rounded">
        <div className="p-2 font-semibold bg-muted dark:bg-secondary">Notifications ({visible.length})</div>
        <div className="divide-y">
          {visible.map(n => (
            <div key={n.notificationId} className="p-3 flex flex-col sm:flex-row sm:items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-xs ${SEV_COLOR[n.severity]}`}>{n.severity}</span>
                  <span className="px-2 py-0.5 rounded text-xs bg-muted dark:bg-muted">{n.type}</span>
                  <span className="px-2 py-0.5 rounded text-xs bg-muted dark:bg-muted">{n.sourceBuild}</span>
                  <span className="px-2 py-0.5 rounded text-xs bg-muted dark:bg-muted">{n.status}</span>
                  {n.repeatCount > 1 && <span className="px-2 py-0.5 rounded text-xs bg-warning text-warning">×{n.repeatCount}</span>}
                  {/* RANK 79 — seeded rows are fabricated. They must never be
                      mistakable for a real governor lock at a glance. */}
                  {isDemoRow(n) && (
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-secondary text-foreground border border-border" data-testid={`badge-demo-${n.notificationId}`}>
                      DEMO — NOT REAL
                    </span>
                  )}
                  {n.symbol && <span className="text-xs opacity-60">{n.symbol}</span>}
                  <span className="text-xs opacity-50 ml-auto">{safeDate(n.createdAt)}</span>
                </div>
                <div className="font-semibold text-sm mt-1">{n.title}</div>
                <div className="text-xs opacity-80">{n.message}</div>
                {n.recommendedAction && <div className="text-xs italic mt-1">→ {n.recommendedAction}</div>}
                {n.actionUrl && <a href={n.actionUrl} className="text-xs text-primary hover:underline">{n.actionUrl}</a>}
              </div>
              <div className="flex gap-1 flex-wrap shrink-0">
                {n.status === "UNREAD" && (
                  <button disabled={busy} onClick={() => call(`/api/notifications/${n.notificationId}/read`, { method: "POST" })}
                    className="px-2 py-1 bg-muted hover:bg-muted text-foreground rounded text-xs">Read</button>
                )}
                <button disabled={busy} onClick={() => call(`/api/notifications/${n.notificationId}/acknowledge`, { method: "POST" })}
                  className="px-2 py-1 bg-success hover:bg-success text-foreground rounded text-xs">Ack</button>
                <button disabled={busy} onClick={() => call(`/api/notifications/${n.notificationId}/snooze`, { method: "POST", body: JSON.stringify({ minutes: 60 }) })}
                  className="px-2 py-1 bg-warning hover:bg-warning text-foreground rounded text-xs">Snooze 1h</button>
                <button disabled={busy} onClick={() => call(`/api/notifications/${n.notificationId}/dismiss`, { method: "POST" })}
                  className="px-2 py-1 bg-muted hover:bg-muted text-foreground rounded text-xs">Dismiss</button>
              </div>
            </div>
          ))}
          {visible.length === 0 && (
            <EmptyState
              icon={Bell}
              title="No notifications yet."
              description="Alerts about your trades, risk events, and system status will appear here. We never show other users' notifications or global admin alerts."
            />
          )}
        </div>
      </div>

      {/* Digest panel
          RANK 35: this rendered a digest computed over EVERY user's
          notifications — platform-wide counts, plus the literal titles of other
          users' CRITICAL alerts in "Top critical" — directly beneath the empty
          state promising "We never show other users' notifications". The digest
          is scoped to req.authUser.id on both the read and the rebuild now, and
          the panel says whose data it is. */}
      {digest && (
        <div className="border rounded p-3 space-y-1 text-sm" data-testid="digest-panel">
          <div className="font-semibold">Your latest digest</div>
          <div className="text-xs opacity-70">Covers only your own notifications.</div>
          <div className="text-xs opacity-70">{safeDate(digest.rangeStart)} → {safeDate(digest.rangeEnd)}</div>
          <div>Total: {digest.totalNotifications} • Critical: {digest.criticalCount} • Warnings: {digest.warningCount} • Trades: {digest.tradeCount} • Learning: {digest.learningCount} • Safety: {digest.safetyCount}</div>
          {digest.summary.topCritical && digest.summary.topCritical.length > 0 && (
            <div className="text-xs">Top critical: {digest.summary.topCritical.map(t => t.title).join(" · ")}</div>
          )}
        </div>
      )}
    </div>
  );
}
