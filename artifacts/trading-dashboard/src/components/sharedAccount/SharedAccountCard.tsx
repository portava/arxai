// User-facing Shared Master Account card.
//
// Backed by read-only typed React Query hooks (generated from openapi.yaml):
//   useGetMeSharedAccountSummary       — includes owner/admin-only masterMt5
//   useGetMeSharedAccountPositions     — open attributed positions
//   useGetMeSharedAccountAttributions  — attribution history
//   useRefreshMeSharedAccountSnapshot  — owner/admin real MT5 resync
//
// Owner/admin see the REAL MT5 master account (from the EA heartbeat snapshot)
// clearly separated from the ARX virtual allocation. Normal users see the ARX
// allocation only. Shows real backend data only — never placeholder balances or
// fabricated trades. Honest staleness via syncStatus. Near-real-time polling,
// paused on hidden tabs.

import { useEffect, useMemo, useState } from "react";
import {
  useGetMeSharedAccountSummary,
  getGetMeSharedAccountSummaryQueryKey,
  useGetMeSharedAccountPositions,
  getGetMeSharedAccountPositionsQueryKey,
  useGetMeSharedAccountAttributions,
  useRefreshMeSharedAccountSnapshot,
  type MasterMt5Snapshot,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircle,
  RefreshCw,
  Shield,
  TrendingDown,
  TrendingUp,
  Wallet,
  Activity,
  Server,
  AlertTriangle,
} from "lucide-react";
import { formatPnl, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const POLL_MS = 3000;

function useTabVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden,
  );
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

function ageLabel(ms: number | null | undefined): string {
  if (ms == null) return "unknown";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function SharedAccountCard({ className }: { className?: string }) {
  const visible = useTabVisible();

  const summaryQ = useGetMeSharedAccountSummary({
    query: {
      queryKey: getGetMeSharedAccountSummaryQueryKey(),
      refetchInterval: visible ? POLL_MS : false,
      refetchIntervalInBackground: false,
    },
  });
  const positionsQ = useGetMeSharedAccountPositions({
    query: {
      queryKey: getGetMeSharedAccountPositionsQueryKey(),
      refetchInterval: visible ? POLL_MS : false,
      refetchIntervalInBackground: false,
    },
  });
  const attributionsQ = useGetMeSharedAccountAttributions({ limit: 5 });

  const refreshMut = useRefreshMeSharedAccountSnapshot();
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const loading = summaryQ.isLoading;
  const error = summaryQ.error ? "Could not load your shared account." : null;
  const summary = summaryQ.data;
  const accounts = summary?.accounts ?? [];
  const master = (summary?.masterMt5 ?? null) as MasterMt5Snapshot | null;
  // Canonical per-user allocation — the SAME source the live gate/preflight use.
  // Normal-user ARX figures must read from here, never the static virtual_balance.
  const allocationView = summary?.allocationView ?? null;
  const positions = positionsQ.data?.rows ?? [];
  const attributions = attributionsQ.data?.rows ?? [];

  // Capability flag from the backend — true for owner/admin even when the
  // snapshot is null (bridge unpinned/offline), so a real resync stays
  // available. Never inferred from `master != null`.
  const isOwnerAdmin = Boolean(summary?.masterAccess);

  const reloadAll = () => {
    void summaryQ.refetch();
    void positionsQ.refetch();
    void attributionsQ.refetch();
  };

  // Real MT5 resync (owner/admin): recompute the pool from the freshest EA
  // heartbeat server-side, then pull the fresh snapshot back.
  const doRefresh = async () => {
    setRefreshError(null);
    if (isOwnerAdmin) {
      try {
        const resp = await refreshMut.mutateAsync();
        if (!resp?.ok) {
          setRefreshError(
            resp?.error === "MASTER_BRIDGE_NOT_AVAILABLE"
              ? "No master bridge is connected to sync."
              : "Sync failed. The bridge may be offline.",
          );
        }
      } catch {
        setRefreshError("Sync failed. The bridge may be offline.");
      }
    }
    reloadAll();
  };

  const refreshing = refreshMut.isPending || summaryQ.isFetching;

  const allocTotals = useMemo(() => ({
    count: accounts.length,
    balance: accounts.reduce((s, a) => s + Number(a.virtualBalance || 0), 0),
    equity: accounts.reduce((s, a) => s + Number(a.virtualEquity || 0), 0),
    pnl: accounts.reduce((s, a) => s + Number(a.virtualPnl || 0), 0),
    realized7d: accounts.reduce((s, a) => s + Number(a.realizedPnl7d || 0), 0),
    open: accounts.reduce((s, a) => s + Number(a.openAttributions || 0), 0),
  }), [accounts]);

  if (loading && !summary) {
    return (
      <Card className={cn("w-full", className)} data-testid="shared-account-card-loading">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" /> Shared Master Account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={cn("w-full border-danger/40", className)} data-testid="shared-account-card-error">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertCircle className="h-4 w-4 text-danger" /> Shared Master Account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-txt-secondary">{error}</p>
          <Button size="sm" variant="outline" className="mt-3 min-h-[40px]" onClick={reloadAll}>
            <RefreshCw className="h-3 w-3 mr-1" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Normal users with no allocation and no master snapshot: empty state.
  if (!summary || (!isOwnerAdmin && allocTotals.count === 0)) {
    return (
      <Card className={cn("w-full", className)} data-testid="shared-account-card-empty">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" /> Shared Master Account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-txt-secondary">
            You don't have a shared master account assigned. When an admin enables
            shared-master mode and assigns you to a master, your ARX allocation
            and trade attributions will appear here.
          </p>
          <p className="text-xs text-txt-muted mt-2">
            Live orders route through the shared master bridge when execution is armed.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Split attributions into open positions vs recent activity.
  const recentActivity = attributions.filter(
    r => String(r.status).toLowerCase() !== "open",
  );

  const sync = master?.syncStatus ?? "UNAVAILABLE";
  const badge = refreshing
    ? { text: "Refreshing", cls: "bg-warning/10 text-warning border-warning/30" }
    : sync === "LIVE"
      ? { text: "Live", cls: "bg-success/10 text-success border-success/30" }
      : sync === "STALE"
        ? { text: "Stale", cls: "bg-warning/10 text-warning border-warning/30" }
        : { text: "Unavailable", cls: "bg-muted text-txt-secondary border-border/30" };

  return (
    <Card className={cn("w-full overflow-hidden", className)} data-testid="shared-account-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" /> Shared Master Account
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={cn("text-[10px] uppercase", badge.cls)} data-testid="shared-account-sync-badge">
              {refreshing && <RefreshCw className="h-2.5 w-2.5 mr-1 animate-spin" />}
              {badge.text}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 min-h-[28px]"
              aria-label="Refresh"
              disabled={refreshing}
              onClick={() => void doRefresh()}
              data-testid="shared-account-refresh-btn"
            >
              <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
            </Button>
          </div>
        </div>
        {isOwnerAdmin && (
          <p className="text-[11px] text-txt-muted mt-1">
            MT5 synced {ageLabel(master?.snapshotAgeMs)}
            {master?.lastMt5SnapshotAt ? ` · ${formatDate(master.lastMt5SnapshotAt)}` : ""}
          </p>
        )}
        {refreshError && (
          <p className="text-[11px] text-danger mt-1" data-testid="shared-account-refresh-error">{refreshError}</p>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── Owner/admin, bridge offline: honest unavailable state ────── */}
        {isOwnerAdmin && !master && (
          <section data-testid="master-mt5-unavailable" className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="text-[11px] uppercase tracking-wide text-txt-secondary flex items-center gap-1.5 font-medium mb-1">
              <Server className="h-3.5 w-3.5" /> MT5 Real Account
            </div>
            <p className="text-xs text-txt-muted">
              No master bridge snapshot is available. Connect the MT5 bridge, then
              use Refresh to pull the live account state. No data is fabricated.
            </p>
          </section>
        )}

        {/* ── Owner/admin: REAL MT5 master account ─────────────────────── */}
        {isOwnerAdmin && master && (
          <section data-testid="master-mt5-section" className="rounded-lg border border-success/40 bg-success/[0.03] p-3">
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <div className="text-[11px] uppercase tracking-wide text-success/90 flex items-center gap-1.5 font-medium">
                <Server className="h-3.5 w-3.5" /> MT5 Real Account
              </div>
              <div className="text-[10px] text-txt-muted truncate">
                {[master.brokerName, master.serverName].filter(Boolean).join(" · ") || "—"}
                {master.accountNumberMasked ? ` · ${master.accountNumberMasked}` : ""}
                {master.accountTypeLabel ? ` · ` : ""}
                {master.accountTypeLabel && (
                  <span className="uppercase text-txt-secondary">{master.accountTypeLabel}</span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
              <Stat label={`Balance${master.accountCurrency ? ` (${master.accountCurrency})` : ""}`}
                value={`$${master.mt5Balance.toFixed(2)}`} icon={<Wallet className="h-3 w-3" />} />
              <Stat label="Equity" value={`$${master.mt5Equity.toFixed(2)}`} icon={<Shield className="h-3 w-3" />} />
              <Stat label="Open P/L"
                value={formatPnl(master.mt5OpenPnl)}
                valueClass={master.mt5OpenPnl > 0 ? "text-success" : master.mt5OpenPnl < 0 ? "text-danger" : ""}
                icon={master.mt5OpenPnl >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />} />
              <Stat label="Used Margin" value={`$${master.mt5UsedMargin.toFixed(2)}`} />
              <Stat label="Free Margin" value={`$${master.mt5FreeMargin.toFixed(2)}`} />
              <Stat label="Open Positions" value={String(master.openPositions)} icon={<Activity className="h-3 w-3" />} />
            </div>
            {master.unattributedCount > 0 && (
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-warning" data-testid="master-unattributed">
                <AlertTriangle className="h-3 w-3" />
                {master.unattributedCount} manual / unattributed MT5 trade{master.unattributedCount === 1 ? "" : "s"} pending review
              </div>
            )}
          </section>
        )}

        {/* ── ARX virtual allocation (everyone with an allocation) ──────── */}
        {isOwnerAdmin && master ? (
          <section data-testid="arx-allocation-section">
            <div className="text-[11px] uppercase tracking-wide text-txt-muted mb-2 flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5" /> ARX Allocation
              {master.isOverAllocated && (
                <Badge variant="outline" className="text-[9px] bg-danger/10 text-danger border-danger/30 ml-1">OVER-ALLOCATED</Badge>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
              <Stat label="Allocated" value={`$${master.arxAllocated.toFixed(2)}`} />
              <Stat label="Available" value={`$${master.arxAvailable.toFixed(2)}`} />
              <Stat label="Reserved" value={`$${master.arxReserved.toFixed(2)}`} />
              <Stat label="Realized (7d)"
                value={formatPnl(master.realizedPnl7d)}
                valueClass={master.realizedPnl7d > 0 ? "text-success" : master.realizedPnl7d < 0 ? "text-danger" : ""} />
            </div>
          </section>
        ) : (
          <section data-testid="arx-allocation-section">
            <div className="text-[11px] uppercase tracking-wide text-txt-muted mb-2 flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5" /> ARX Allocation
            </div>
            {/* Canonical per-user allocation (allocationView) — the SAME figures
                the live gate enforces. Allocated/Available/Reserved come from the
                view, not the static virtual_balance; Available is the headroom a
                live order is actually checked against. Open P/L + Realized stay
                from the per-account aggregates (display-only, not gate inputs). */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
              <Stat
                label="Allocated"
                value={`$${(allocationView?.assignedAllocation ?? allocTotals.balance).toFixed(2)}`}
                icon={<Wallet className="h-3 w-3" />} />
              <Stat
                label="Available"
                value={`$${(allocationView?.availableAllocation ?? allocTotals.balance).toFixed(2)}`}
                valueClass={allocationView != null && allocationView.availableAllocation <= 0 ? "text-danger" : ""}
                icon={<Shield className="h-3 w-3" />} />
              <Stat
                label="Reserved"
                value={`$${(allocationView?.reservedRisk ?? 0).toFixed(2)}`}
                icon={<Shield className="h-3 w-3" />} />
              <Stat label="Open P/L"
                value={formatPnl(allocTotals.pnl)}
                valueClass={allocTotals.pnl > 0 ? "text-success" : allocTotals.pnl < 0 ? "text-danger" : ""}
                icon={allocTotals.pnl >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />} />
            </div>
            {allocationView != null && !allocationView.hasAllocation && (
              <p className="mt-2 text-[11px] font-medium text-warning" data-testid="arx-no-allocation-note">
                No live allocation assigned yet — an operator must assign allocation before you can place a live order.
              </p>
            )}
            {allocationView != null && allocationView.hasAllocation && allocationView.availableAllocation <= 0 && (
              <p className="mt-2 text-[11px] font-medium text-warning" data-testid="arx-allocation-exhausted-note">
                Available is $0 — assigned funds are fully used by reserved risk (${allocationView.reservedRisk.toFixed(2)}) and open floating loss (${allocationView.openFloatingLoss.toFixed(2)}). Close positions or contact your operator.
              </p>
            )}
            <div className="space-y-2 mt-2">
              {accounts.map(a => (
                <div key={a.id} className="rounded border border-border p-2.5 text-xs" data-testid={`shared-account-row-${a.id}`}>
                  <div className="flex items-center justify-between flex-wrap gap-1">
                    <div className="font-medium text-foreground">
                      {a.masterBrokerName ?? "Master"} • {a.masterAccountNumberMasked ?? "—"} • <span className="uppercase">{a.accountType}</span>
                    </div>
                    <Badge variant={a.status === "active" ? "default" : "outline"} className="text-[10px]">{a.status}</Badge>
                  </div>
                  <div className="mt-1.5 grid grid-cols-3 gap-2 text-txt-secondary">
                    <div>Bal <span className="text-foreground">${Number(a.virtualBalance).toFixed(2)}</span></div>
                    <div>Eq <span className="text-foreground">${Number(a.virtualEquity).toFixed(2)}</span></div>
                    <div>Open <span className="text-foreground">{a.openAttributions}</span></div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Open positions (MT5-confirmed only) ──────────────────────── */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="text-[11px] uppercase tracking-wide text-txt-muted">
              Open positions ({positionsQ.data?.count ?? 0})
            </div>
            {positionsQ.data?.lastMt5SyncAt && (
              <div className="text-[10px] text-txt-muted">
                Last MT5 sync · {formatDate(String(positionsQ.data.lastMt5SyncAt))}
              </div>
            )}
          </div>
          {isOwnerAdmin && (positionsQ.data?.reconciledOrphanCount ?? 0) > 0 && (
            <div className="mb-1.5 text-[10px] text-warning/90">
              {positionsQ.data?.reconciledOrphanCount} stale ARX record
              {(positionsQ.data?.reconciledOrphanCount ?? 0) === 1 ? "" : "s"} reconciled — see Recent activity.
            </div>
          )}
          {positions.length ? (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-txt-muted">
                    <th className="text-left font-normal py-1 px-1">Symbol</th>
                    <th className="text-left font-normal">Side</th>
                    <th className="text-right font-normal">Lot</th>
                    <th className="text-right font-normal">Entry</th>
                    <th className="text-right font-normal">Now</th>
                    <th className="text-right font-normal">P/L</th>
                    <th className="text-right font-normal">Ticket</th>
                    <th className="text-right font-normal">Opened</th>
                    <th className="text-right font-normal">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.slice(0, 8).map(r => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-1 px-1 text-foreground">
                        {r.symbol}
                        {r.stale && (
                          <span className="ml-1 text-[9px] text-warning/80 align-middle">Syncing…</span>
                        )}
                      </td>
                      <td className={r.side === "BUY" ? "text-success" : "text-danger"}>{r.side}</td>
                      <td className="text-right text-txt-secondary">{r.lotSize}</td>
                      <td className="text-right text-txt-secondary">{r.entryPrice ?? "—"}</td>
                      <td className="text-right text-txt-secondary">
                        {r.stale ? <span className="text-txt-muted text-[10px]">Syncing…</span> : (r.currentPrice ?? "—")}
                      </td>
                      <td className={`text-right ${r.pnl == null ? "text-txt-muted" : r.pnl > 0 ? "text-success" : r.pnl < 0 ? "text-danger" : "text-txt-secondary"}`}>
                        {r.stale || r.pnl == null ? "Syncing…" : formatPnl(r.pnl)}
                      </td>
                      <td className="text-right text-txt-secondary text-[10px] font-mono">{r.brokerTicket}</td>
                      <td className="text-right text-txt-muted text-[10px]">{r.openedAt ? formatDate(String(r.openedAt)) : "—"}</td>
                      <td className="text-right text-txt-muted text-[10px]">{r.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-txt-muted italic">No MT5-confirmed open positions.</p>
          )}
        </div>

        {/* ── Recent activity (closed / reconciled / failed) ───────────── */}
        <div>
          <div className="text-[11px] uppercase tracking-wide text-txt-muted mb-1.5">Recent activity</div>
          {recentActivity.length ? (
            <ul className="space-y-1.5">
              {recentActivity.slice(0, 5).map(r => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0 truncate">
                    <span className="text-txt-secondary">{r.symbol}</span>
                    <span className={r.side === "BUY" ? "text-success ml-2" : "text-danger ml-2"}>{r.side}</span>
                    <span className="text-txt-muted ml-2">{r.lotSize} lot</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="text-[10px] capitalize">{r.status}</Badge>
                    <span className={cn("font-mono", (r.pnl ?? 0) > 0 ? "text-success" : (r.pnl ?? 0) < 0 ? "text-danger" : "text-txt-secondary")}>
                      {r.pnl != null ? formatPnl(r.pnl) : "—"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-txt-muted italic">No recent activity.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, valueClass, icon }: { label: string; value: string; valueClass?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded bg-muted/60 p-2">
      <div className="text-[10px] uppercase tracking-wide text-txt-muted flex items-center gap-1">{icon}{label}</div>
      <div className={cn("text-sm font-semibold mt-0.5 truncate", valueClass)}>{value}</div>
    </div>
  );
}

export default SharedAccountCard;
