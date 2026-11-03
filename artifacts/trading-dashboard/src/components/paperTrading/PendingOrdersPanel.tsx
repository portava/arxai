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
  /** What a submit would answer for the bridge at bridgeCheckedAt (server-measured). */
  currentPendingStatus?: string | null;
  currentPendingReason?: string | null;
}

interface ListResp { ok: boolean; drafts?: DraftRow[]; bridgeCheckedAt?: string | null; bridgeCheckError?: string | null }

function utcMinute(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function PendingOrdersPanel() {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery<ListResp>({
    queryKey: ["/me/pending-order-drafts"],
    // A failed read throws, so it is shown as "could not be loaded" rather
    // than as an empty list.
    queryFn: async () => {
      const r = await fetch("/api/me/pending-order-drafts", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<ListResp>;
    },
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
  const checkedAt = utcMinute(data?.bridgeCheckedAt);

  return (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/40 p-4" data-testid="pending-orders-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Pending Orders <span className="text-xs text-slate-400">({drafts.length})</span></h3>
        <button onClick={() => refetch()} className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800">Refresh</button>
      </div>
      {isLoading ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : isError && !data ? (
        <p className="text-xs text-rose-300" data-testid="pending-orders-load-error">Your pending-order drafts could not be loaded. Try Refresh.</p>
      ) : drafts.length === 0 ? (
        <p className="text-xs text-slate-400">No pending-order drafts. Use the order ticket above with a Limit / Stop / Stop-Limit type to create one.</p>
      ) : (
        <ul className="space-y-2">
          {drafts.map((d) => {
            // The stored pendingStatus is the bridge answer from when the
            // draft was saved or last submitted. When the server read the
            // bridge for this list, its current answer is the badge (with the
            // time it was read) and the stored one is labelled as recorded.
            const now = d.currentPendingStatus && checkedAt ? d.currentPendingStatus : null;
            const savedAt = utcMinute(d.createdAt);
            return (
            <li key={d.id} className="rounded border border-slate-700 bg-slate-950/40 p-2 text-[11px] text-slate-200" data-testid={`pending-order-${d.id}`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-slate-100">{d.orderType ?? d.side} · {d.symbol} · {d.lotSize} lots</span>
                <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300" data-testid={`pending-order-status-${d.id}`}>
                  {now ?? d.pendingStatus ?? "DRAFT"}
                </span>
              </div>
              <div className="mt-0.5 text-[10px] text-slate-500" data-testid={`pending-order-asof-${d.id}`}>
                {now ? (
                  <>
                    Bridge checked {checkedAt}.
                    {d.pendingStatus && d.pendingStatus !== now && <> Recorded when saved or last submitted: {d.pendingStatus}.</>}
                  </>
                ) : (
                  <>Recorded when saved or last submitted{d.pendingStatus ? `: ${d.pendingStatus}` : ""}.</>
                )}
                {savedAt && <> Draft saved {savedAt}.</>}
              </div>
              {now && d.currentPendingReason && <p className="mt-1 text-[10px] text-slate-300">{d.currentPendingReason}</p>}
              <div className="mt-1 grid grid-cols-3 gap-1 font-mono text-[10px] text-slate-400">
                {d.entryPrice != null && <span>Entry: <span className="text-slate-200">{d.entryPrice}</span></span>}
                {d.stopTriggerPrice != null && <span>Trigger: <span className="text-slate-200">{d.stopTriggerPrice}</span></span>}
                {d.stopLimitPrice != null && <span>Limit: <span className="text-slate-200">{d.stopLimitPrice}</span></span>}
                {d.stopLoss != null && <span>SL: <span className="text-red-300">{d.stopLoss}</span></span>}
                {d.takeProfit != null && <span>TP: <span className="text-emerald-300">{d.takeProfit}</span></span>}
                {d.expiration && <span>Exp: {new Date(d.expiration).toLocaleString()}</span>}
              </div>
              {d.reason && <p className="mt-1 text-[10px] text-slate-400">{d.reason}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => cancel.mutate(d.id)}
                  disabled={cancel.isPending}
                  className="rounded bg-red-700/80 px-2 py-1 text-[10px] font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                  data-testid={`button-cancel-${d.id}`}
                >
                  {cancel.isPending ? "Cancelling…" : "Cancel draft"}
                </button>
              </div>
            </li>
            );
          })}
        </ul>
      )}
      {data?.bridgeCheckError && (
        <p className="text-[10px] text-slate-400" data-testid="pending-orders-bridge-error">{data.bridgeCheckError}</p>
      )}
      <p className="text-[10px] text-amber-300" data-testid="pending-orders-footer">
        Pending-order drafts are validated by the server and stored for your account only. They are never sent to a broker: ARX's pending-order path is read-only and paper-only, whatever your EA reports. Each draft's status says what your MT5 bridge reports about pending-order support.
      </p>
    </div>
  );
}
