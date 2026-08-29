// Phase 25 — Pending Orders panel.
// Lists the current user's pending-order drafts saved via /me/pending-order-draft.
// Per-user-scoped backend (eq userId), DELETE soft-cancels.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface DraftRow {
  id: number;
  orderType: string | null;
  symbol: string;
  side: string;
  lotSize: number;
  entryPrice: number | null;
  stopTriggerPrice: number | null;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expiration: string | null;
  pendingStatus: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
}

interface ListResp { ok: boolean; drafts?: DraftRow[] }

export function PendingOrdersPanel() {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery<ListResp>({
    queryKey: ["/me/pending-order-drafts"],
    queryFn: () => fetch("/api/me/pending-order-drafts", { credentials: "include" }).then((r) => (r.ok ? r.json() : { ok: false } as ListResp)),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
  const cancel = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/me/pending-order-draft/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error("cancel_failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/me/pending-order-drafts"] }),
  });

  const drafts = (data?.drafts ?? []).filter((d) => d.status !== "cancelled" && d.pendingStatus !== "CANCELLED");

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-4" data-testid="pending-orders-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Pending Orders <span className="text-xs text-txt-secondary">({drafts.length})</span></h3>
        <button onClick={() => refetch()} className="rounded border border-border px-2 py-0.5 text-[10px] text-txt-secondary hover:bg-secondary">Refresh</button>
      </div>
      {isLoading ? (
        <p className="text-xs text-txt-secondary">Loading…</p>
      ) : drafts.length === 0 ? (
        <p className="text-xs text-txt-secondary">No pending-order drafts. Use the order ticket above with a Limit / Stop / Stop-Limit type to create one.</p>
      ) : (
        <ul className="space-y-2">
          {drafts.map((d) => (
            <li key={d.id} className="rounded border border-border bg-background/40 p-2 text-[11px] text-foreground" data-testid={`pending-order-${d.id}`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-foreground">{d.orderType ?? d.side} · {d.symbol} · {d.lotSize} lots</span>
                <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold text-warning">
                  {d.pendingStatus ?? "DRAFT"}
                </span>
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1 font-mono text-[10px] text-txt-secondary">
                {d.entryPrice != null && <span>Entry: <span className="text-foreground">{d.entryPrice}</span></span>}
                {d.stopTriggerPrice != null && <span>Trigger: <span className="text-foreground">{d.stopTriggerPrice}</span></span>}
                {d.stopLimitPrice != null && <span>Limit: <span className="text-foreground">{d.stopLimitPrice}</span></span>}
                {d.stopLoss != null && <span>SL: <span className="text-danger">{d.stopLoss}</span></span>}
                {d.takeProfit != null && <span>TP: <span className="text-success">{d.takeProfit}</span></span>}
                {d.expiration && <span>Exp: {new Date(d.expiration).toLocaleString()}</span>}
              </div>
              {d.reason && <p className="mt-1 text-[10px] text-txt-secondary">{d.reason}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => cancel.mutate(d.id)}
                  disabled={cancel.isPending}
                  className="rounded bg-danger/80 px-2 py-1 text-[10px] font-semibold text-white hover:bg-danger disabled:opacity-50"
                  data-testid={`button-cancel-${d.id}`}
                >
                  {cancel.isPending ? "Cancelling…" : "Cancel draft"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] text-warning">
        Pending-order drafts are validated locally and stored per-user, but NEVER sent to a live broker. The MT5 bridge does not yet accept pending orders; until the bridge is upgraded and live trading is unlocked, drafts remain non-executable.
      </p>
    </div>
  );
}
