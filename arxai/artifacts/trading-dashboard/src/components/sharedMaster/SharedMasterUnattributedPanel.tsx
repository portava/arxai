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
    reconciler: "bg-blue-900/40 text-blue-200",
    sync_positions: "bg-amber-900/40 text-amber-200",
    manual: "bg-zinc-800 text-zinc-200",
  };
  return map[source] ?? "bg-zinc-800 text-zinc-300";
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
    <section className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 sm:p-6" data-testid="shared-master-unattributed-panel">
      <div className="flex items-start justify-between gap-2 flex-wrap mb-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" /> Shared Master — Unattributed Queue
        </h2>
        <button
          onClick={reload}
          className="text-xs px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800 min-h-[32px] flex items-center gap-1"
          aria-label="Refresh"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      {overview && overview.masters.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-4">
          {overview.masters.map(m => (
            <div key={m.id} className="rounded border border-zinc-800 p-2.5 text-xs" data-testid={`master-overview-${m.id}`}>
              <div className="flex items-center justify-between">
                <div className="font-medium text-zinc-200 truncate">
                  {m.brokerName ?? "Master"} • {m.accountNumberMasked ?? "—"} • <span className="uppercase">{m.accountType}</span>
                </div>
                {m.pendingUnattributed > 0 && (
                  <span className="ml-2 inline-flex items-center justify-center rounded-full bg-amber-900/60 text-amber-200 text-[10px] px-1.5 py-0.5 min-w-[18px]">
                    {m.pendingUnattributed}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1 mt-1.5 text-zinc-400">
                <div>Users <span className="text-zinc-200">{m.userCount}</span></div>
                <div>Open <span className="text-zinc-200">{m.openAttributions}</span></div>
                <div>24h <span className={m.realizedPnl24h > 0 ? "text-emerald-400" : m.realizedPnl24h < 0 ? "text-red-400" : "text-zinc-200"}>${m.realizedPnl24h.toFixed(2)}</span></div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 mb-3 border-b border-zinc-800">
        {(["pending_review", "linked", "dismissed"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-2 text-xs uppercase tracking-wide min-h-[36px] ${tab === t ? "border-b-2 border-amber-400 text-amber-300" : "text-zinc-500 hover:text-zinc-300"}`}
            data-testid={`tab-${t}`}>
            {t.replace("_", " ")}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-zinc-500">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="text-sm text-zinc-500 italic">Nothing in this queue.</p>
      )}

      <div className="space-y-2">
        {rows.map(r => {
          const sev = severityForRow(r);
          return (
            <article key={r.id} className="rounded border border-zinc-800 p-3 text-xs" data-testid={`unattr-row-${r.id}`}>
              <header className="flex items-start justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span className="font-mono text-zinc-300">#{r.id}</span>
                  <span className="font-medium text-zinc-100">{r.symbol}</span>
                  {r.side && (
                    <span className={r.side === "BUY" ? "text-emerald-400" : "text-red-400"}>{r.side}</span>
                  )}
                  <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${sourceBadge(r.source)}`}>{r.source.replace("_", " ")}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${sev === "HIGH" ? "bg-red-900/50 text-red-200" : sev === "MED" ? "bg-amber-900/50 text-amber-200" : "bg-zinc-800 text-zinc-300"}`}>
                    {sev}
                  </span>
                </div>
                {r.status === "linked" && <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-label="Linked" />}
                {r.status === "dismissed" && <XCircle className="h-4 w-4 text-zinc-500" aria-label="Dismissed" />}
              </header>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 text-zinc-400">
                <div>Lot <span className="text-zinc-200">{r.lotSize ?? "—"}</span></div>
                <div>Fill <span className="text-zinc-200">{r.fillPrice ?? "—"}</span></div>
                <div>Pos# <span className="text-zinc-200 font-mono">{r.mt5PositionTicket ?? "—"}</span></div>
                <div>Cmd <span className="text-zinc-200">{r.tradeCommandId ?? "—"}</span></div>
              </div>

              {r.brokerMessage && (
                <p className="mt-2 text-zinc-500 italic break-words">"{r.brokerMessage}"</p>
              )}

              <footer className="mt-2 flex items-center justify-between gap-2 flex-wrap">
                <div className="text-[10px] text-zinc-500">
                  Master #{r.masterConnectionId} • created {new Date(r.createdAt).toLocaleString()}
                  {r.linkedAttributionId != null && <> • linked → attr #{r.linkedAttributionId}</>}
                </div>
                {r.status === "pending_review" && (
                  <div className="flex items-center gap-1.5">
                    <button
                      disabled={busyId === r.id}
                      onClick={() => void linkRow(r)}
                      className="text-xs px-2 py-1 rounded border border-emerald-700 text-emerald-300 hover:bg-emerald-900/30 disabled:opacity-50 min-h-[32px] flex items-center gap-1"
                      data-testid={`link-${r.id}`}
                    >
                      <Link2 className="h-3 w-3" /> Link
                    </button>
                    <button
                      disabled={busyId === r.id}
                      onClick={() => void dismissRow(r)}
                      className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 min-h-[32px] flex items-center gap-1"
                      data-testid={`dismiss-${r.id}`}
                    >
                      <XCircle className="h-3 w-3" /> Dismiss
                    </button>
                  </div>
                )}
              </footer>

              {r.reviewNotes && (
                <p className="mt-2 text-[11px] text-zinc-500">Notes: {r.reviewNotes}</p>
              )}
            </article>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] text-zinc-600">
        These actions are bookkeeping only — they never place, modify, or close a broker order. ARX remains in paper-only mode.
      </p>
    </section>
  );
}

export default SharedMasterUnattributedPanel;
