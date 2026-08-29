// Phase 3 — Admin Shared Master review panel.
//
// Backed by typed React Query hooks (generated from openapi.yaml):
//   useGetAdminSharedMasterOverview
//   useGetAdminSharedMasterUnattributed
//   useLinkAdminSharedMasterUnattributed
//   useDismissAdminSharedMasterUnattributed
//
// SAFETY:
//   * Admin role required (server-side gates with requireAdmin).
//   * No secrets displayed (no broker credentials, no apiKeyHash, no server).
//   * Link/Dismiss are bookkeeping only — they DO NOT cause a new broker order.

import { useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, Link2, XCircle } from "lucide-react";
import {
  useGetAdminSharedMasterOverview,
  useGetAdminSharedMasterUnattributed,
  useLinkAdminSharedMasterUnattributed,
  useDismissAdminSharedMasterUnattributed,
  type UnattributedMasterTradeRow,
} from "@workspace/api-client-react";

function sourceBadge(source: string) {
  const map: Record<string, string> = {
    reconciler: "bg-primary/40 text-primary",
    sync_positions: "bg-warning/40 text-warning",
    manual: "bg-secondary text-foreground",
  };
  return map[source] ?? "bg-secondary text-txt-secondary";
}

function severityForRow(r: UnattributedMasterTradeRow): "HIGH" | "MED" | "LOW" {
  if (r.source === "sync_positions") return "HIGH";
  if (r.source === "reconciler") return "MED";
  return "LOW";
}

export function SharedMasterUnattributedPanel() {
  const [tab, setTab] = useState<"pending_review" | "linked" | "dismissed">("pending_review");
  const [busyId, setBusyId] = useState<number | null>(null);

  const overviewQ = useGetAdminSharedMasterOverview();
  const queueQ = useGetAdminSharedMasterUnattributed({ status: tab, limit: 100 });
  const linkM = useLinkAdminSharedMasterUnattributed();
  const dismissM = useDismissAdminSharedMasterUnattributed();

  const reload = () => {
    void overviewQ.refetch();
    void queueQ.refetch();
  };

  async function linkRow(row: UnattributedMasterTradeRow) {
    const raw = window.prompt(
      `Link unattributed master fill #${row.id} (${row.symbol}, ticket ${row.mt5PositionTicket ?? "?"}) to a shared_trade_attribution.id?\n\n` +
      `Enter the attribution row id this fill belongs to:`,
      "",
    );
    if (!raw) return;
    const attributionId = parseInt(raw, 10);
    if (!Number.isFinite(attributionId) || attributionId <= 0) {
      alert("Invalid attribution id.");
      return;
    }
    const notes = window.prompt("Notes (optional, audit trail):", "") ?? "";
    setBusyId(row.id);
    try {
      await linkM.mutateAsync({ id: row.id, data: { attributionId, ...(notes ? { notes } : {}) } });
    } catch (e) {
      alert(`Link failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusyId(null);
      await queueQ.refetch();
      await overviewQ.refetch();
    }
  }

  async function dismissRow(row: UnattributedMasterTradeRow) {
    const notes = window.prompt(`Dismiss unattributed fill #${row.id} (${row.symbol}). Reason / notes:`, "") ?? "";
    if (!notes || notes.trim().length < 3) return;
    setBusyId(row.id);
    try {
      await dismissM.mutateAsync({ id: row.id, data: { notes } });
    } catch (e) {
      alert(`Dismiss failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusyId(null);
      await queueQ.refetch();
      await overviewQ.refetch();
    }
  }

  const overview = overviewQ.data;
  const rows = queueQ.data?.rows ?? [];
  const loading = queueQ.isLoading || overviewQ.isLoading;
  const error = (overviewQ.error || queueQ.error) ? "Could not load shared-master data. Admin role required." : null;

  return (
    <section className="rounded-lg border border-border bg-background/40 p-4 sm:p-6" data-testid="shared-master-unattributed-panel">
      <div className="flex items-start justify-between gap-2 flex-wrap mb-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" /> Shared Master — Unattributed Queue
        </h2>
        <button
          onClick={reload}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-secondary min-h-[32px] flex items-center gap-1"
          aria-label="Refresh"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      {overview && overview.masters.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-4">
          {overview.masters.map(m => (
            <div key={m.id} className="rounded border border-border p-2.5 text-xs" data-testid={`master-overview-${m.id}`}>
              <div className="flex items-center justify-between">
                <div className="font-medium text-foreground truncate">
                  {m.brokerName ?? "Master"} • {m.accountNumberMasked ?? "—"} • <span className="uppercase">{m.accountType}</span>
                </div>
                {m.pendingUnattributed > 0 && (
                  <span className="ml-2 inline-flex items-center justify-center rounded-full bg-warning/60 text-warning text-[10px] px-1.5 py-0.5 min-w-[18px]">
                    {m.pendingUnattributed}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1 mt-1.5 text-txt-secondary">
                <div>Users <span className="text-foreground">{m.userCount}</span></div>
                <div>Open <span className="text-foreground">{m.openAttributions}</span></div>
                <div>24h <span className={m.realizedPnl24h > 0 ? "text-success" : m.realizedPnl24h < 0 ? "text-danger" : "text-foreground"}>${m.realizedPnl24h.toFixed(2)}</span></div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 mb-3 border-b border-border">
        {(["pending_review", "linked", "dismissed"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-2 text-xs uppercase tracking-wide min-h-[36px] ${tab === t ? "border-b-2 border-warning text-warning" : "text-txt-muted hover:text-txt-secondary"}`}
            data-testid={`tab-${t}`}>
            {t.replace("_", " ")}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-txt-muted">Loading…</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="text-sm text-txt-muted italic">Nothing in this queue.</p>
      )}

      <div className="space-y-2">
        {rows.map(r => {
          const sev = severityForRow(r);
          return (
            <article key={r.id} className="rounded border border-border p-3 text-xs" data-testid={`unattr-row-${r.id}`}>
              <header className="flex items-start justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span className="font-mono text-txt-secondary">#{r.id}</span>
                  <span className="font-medium text-foreground">{r.symbol}</span>
                  {r.side && (
                    <span className={r.side === "BUY" ? "text-success" : "text-danger"}>{r.side}</span>
                  )}
                  <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${sourceBadge(r.source)}`}>{r.source.replace("_", " ")}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${sev === "HIGH" ? "bg-danger/50 text-danger" : sev === "MED" ? "bg-warning/50 text-warning" : "bg-secondary text-txt-secondary"}`}>
                    {sev}
                  </span>
                </div>
                {r.status === "linked" && <CheckCircle2 className="h-4 w-4 text-success" aria-label="Linked" />}
                {r.status === "dismissed" && <XCircle className="h-4 w-4 text-txt-muted" aria-label="Dismissed" />}
              </header>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 text-txt-secondary">
                <div>Lot <span className="text-foreground">{r.lotSize ?? "—"}</span></div>
                <div>Fill <span className="text-foreground">{r.fillPrice ?? "—"}</span></div>
                <div>Pos# <span className="text-foreground font-mono">{r.mt5PositionTicket ?? "—"}</span></div>
                <div>Cmd <span className="text-foreground">{r.tradeCommandId ?? "—"}</span></div>
              </div>

              {r.brokerMessage && (
                <p className="mt-2 text-txt-muted italic break-words">"{r.brokerMessage}"</p>
              )}

              <footer className="mt-2 flex items-center justify-between gap-2 flex-wrap">
                <div className="text-[10px] text-txt-muted">
                  Master #{r.masterConnectionId} • created {new Date(r.createdAt).toLocaleString()}
                  {r.linkedAttributionId != null && <> • linked → attr #{r.linkedAttributionId}</>}
                </div>
                {r.status === "pending_review" && (
                  <div className="flex items-center gap-1.5">
                    <button
                      disabled={busyId === r.id}
                      onClick={() => void linkRow(r)}
                      className="text-xs px-2 py-1 rounded border border-success/40 text-success hover:bg-success/30 disabled:opacity-50 min-h-[32px] flex items-center gap-1"
                      data-testid={`link-${r.id}`}
                    >
                      <Link2 className="h-3 w-3" /> Link
                    </button>
                    <button
                      disabled={busyId === r.id}
                      onClick={() => void dismissRow(r)}
                      className="text-xs px-2 py-1 rounded border border-border text-txt-secondary hover:bg-secondary disabled:opacity-50 min-h-[32px] flex items-center gap-1"
                      data-testid={`dismiss-${r.id}`}
                    >
                      <XCircle className="h-3 w-3" /> Dismiss
                    </button>
                  </div>
                )}
              </footer>

              {r.reviewNotes && (
                <p className="mt-2 text-[11px] text-txt-muted">Notes: {r.reviewNotes}</p>
              )}
            </article>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] text-txt-muted">
        These actions are bookkeeping only — they never place, modify, or close a broker order. ARX remains in paper-only mode.
      </p>
    </section>
  );
}

export default SharedMasterUnattributedPanel;
