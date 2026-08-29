// Phase UX8 — Trade Action Center.
//
// One central hub for every AI-suggested or user-initiated trade action.
// Read-first design: lists actions, opens the unified review modal, and
// shows an audit timeline. Never executes anything directly — every
// state transition goes through the backend Action Router.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, RefreshCw, ShieldCheck, Eye, History } from "lucide-react";
import { TradeActionReviewModal, type TradeActionSummary } from "@/components/action-center/TradeActionReviewModal";
import { humanizeReason } from "@/lib/friendlyLabels";

const PENDING_STATUSES = new Set([
  "ai_suggested","user_reviewing","awaiting_confirmation","confirmed","guard_checking","queued","sent_to_mt5",
]);

const STATUS_BADGE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  ai_suggested: "secondary",
  user_reviewing: "secondary",
  awaiting_confirmation: "secondary",
  confirmed: "default",
  guard_checking: "default",
  queued: "default",
  sent_to_mt5: "default",
  executed: "default",
  rejected: "destructive",
  failed: "destructive",
  expired: "outline",
  cancelled: "outline",
};

interface AuditEvent {
  id: number;
  eventType: string;
  severity: string;
  title: string;
  message: string | null;
  createdAt: string;
}

export default function ActionCenterPage() {
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [actions, setActions] = useState<TradeActionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<TradeActionSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/me/trade-actions?limit=100");
      const data = await r.json();
      if (!r.ok || !data.ok) { setErr(data.error ?? `HTTP ${r.status}`); return; }
      setActions(data.actions ?? []);
    } catch (e) {
      setErr((e as Error).message ?? "load_failed");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void reload();
    const t = window.setInterval(reload, 8000);
    return () => window.clearInterval(t);
  }, [reload]);

  const filtered = useMemo(() => {
    if (tab === "pending") return actions.filter((a) => PENDING_STATUSES.has(a.status));
    return actions;
  }, [actions, tab]);

  const pendingCount = useMemo(() => actions.filter((a) => PENDING_STATUSES.has(a.status)).length, [actions]);

  const openModal = useCallback(async (a: TradeActionSummary) => {
    setActive(a); setOpen(true); setAudit(null); setAuditLoading(true);
    try {
      const r = await fetch(`/api/me/trade-actions/${a.id}/audit`);
      const data = await r.json();
      if (r.ok && data.ok) setAudit(data.events ?? []);
    } finally { setAuditLoading(false); }
  }, []);

  return (
    <div className="container mx-auto max-w-5xl space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" /> Trade Action Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Review, confirm, and audit every AI-suggested or user-initiated trade action. ARX never executes automatically — every action requires your explicit confirmation. Decision support only — not guaranteed.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reload} disabled={loading} data-testid="button-refresh-actions">
          {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          Refresh
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "pending" | "all")}>
        <TabsList>
          <TabsTrigger value="pending" data-testid="tab-pending">
            Pending {pendingCount > 0 && <Badge variant="default" className="ml-2 h-5 px-1.5">{pendingCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {err && <div className="text-xs text-destructive" data-testid="text-load-error">Error: {err}</div>}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{tab === "pending" ? "Pending actions" : "All actions"}</CardTitle>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center" data-testid="text-empty-actions">
              {tab === "pending" ? "No pending actions. AI drafts and your manual review requests will appear here." : "No actions yet."}
            </div>
          ) : (
            <ul className="divide-y" data-testid="list-actions">
              {filtered.map((a) => (
                <li key={a.id} className="py-2.5 flex items-center justify-between gap-3 flex-wrap"
                    data-testid={`row-action-${a.id}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">#{a.id} {a.actionType.replaceAll("_"," ")}</span>
                      {a.symbol && <span className="text-xs text-muted-foreground">{a.symbol}</span>}
                      <Badge variant={STATUS_BADGE[a.status] ?? "outline"} className="text-[10px]">{a.status}</Badge>
                      <Badge variant={a.requestedMode === "LIVE" ? "destructive" : "secondary"} className="text-[10px]">{a.requestedMode}</Badge>
                    </div>
                    {a.reason && <p className="text-xs text-muted-foreground mt-0.5 truncate">{a.reason}</p>}
                    {(a.mt5PositionTicket || a.fillPrice != null) && (
                      <p className="text-[11px] text-muted-foreground mt-0.5" data-testid={`text-fill-${a.id}`}>
                        {a.mt5PositionTicket && <>Ticket {a.mt5PositionTicket} · </>}
                        {a.fillPrice != null && <>Fill {a.fillPrice}</>}
                        {a.slippage != null && <> · slippage {a.slippage}</>}
                      </p>
                    )}
                    {a.status === "rejected" && a.rejectionReason && (
                      <p className="text-[11px] text-destructive mt-0.5" data-testid={`text-rejected-${a.id}`}>
                        Broker: {humanizeReason(a.rejectionReason)}
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">{new Date(a.createdAt).toLocaleString()}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => openModal(a)} data-testid={`button-review-${a.id}`}>
                    <Eye className="h-3 w-3 mr-1" /> Review
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {active && open && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <History className="h-4 w-4" /> Audit timeline — action #{active.id}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {auditLoading ? (
              <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            ) : !audit || audit.length === 0 ? (
              <div className="text-xs text-muted-foreground">No audit events yet.</div>
            ) : (
              <ul className="space-y-1.5 text-xs" data-testid="list-audit-events">
                {audit.map((e) => (
                  <li key={e.id} className="flex gap-2 items-start">
                    <Badge variant="outline" className="text-[10px] shrink-0">{e.severity}</Badge>
                    <div className="min-w-0">
                      <div className="font-medium">{e.title}</div>
                      {e.message && <div className="text-muted-foreground">{e.message}</div>}
                      <div className="text-[10px] text-muted-foreground/70">{new Date(e.createdAt).toLocaleString()}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <TradeActionReviewModal
        open={open}
        action={active}
        onClose={() => { setOpen(false); setActive(null); }}
        onConfirmed={(next) => { setActions((prev) => prev.map((p) => p.id === next.id ? next : p)); }}
        onCancelled={(next) => { setActions((prev) => prev.map((p) => p.id === next.id ? next : p)); }}
      />
    </div>
  );
}
