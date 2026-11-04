// LivePendingOrders — the user's working MT5 pending orders on live
// (Buy/Sell Limit, Stop, Stop Limit) from GET /api/me/live/pending-orders.
//
// The list is built from the last terminal answer for each order (there is no
// terminal pending-order snapshot yet), and it says so. Cancel / modify from
// ARX is not offered yet: the live pipeline has no cancel-pending command type,
// so the row points the trader to MT5 instead of showing a button that cannot
// work.
import { useQuery } from "@tanstack/react-query";
import { Clock, ListOrdered } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export type LivePendingOrder = {
  commandId: string;
  orderTicket: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: string;
  volume: number;
  price: number | null;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expiration: string | null;
  placedAt: string | null;
};

type Resp = { ok?: boolean; items?: LivePendingOrder[]; note?: string };

export const LIVE_PENDING_CANCEL_NOTE =
  "Cancel or change a live pending order in MT5 for now. ARX does not send live pending-order cancels yet.";

const norm = (s: string | null | undefined) => (s ?? "").replace(/^.*:/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

function fmt(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  return v.toFixed(abs >= 1000 ? 2 : abs >= 10 ? 3 : 5);
}

export function LivePendingOrders({ symbol, enabled = true, compact = false }: { symbol?: string; enabled?: boolean; compact?: boolean }) {
  const q = useQuery<Resp>({
    queryKey: ["live", "pending-orders"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/me/live/pending-orders`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Resp;
    },
    enabled,
    refetchInterval: 10_000,
  });
  if (!enabled) return null;
  const all = q.data?.items ?? [];
  const items = symbol ? all.filter((o) => norm(o.symbol) === norm(symbol)) : all;
  // On the chart, stay out of the way when there is nothing to show.
  if (compact && (q.isLoading || (!q.isError && items.length === 0))) return null;

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2" data-testid="live-pending-orders">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
        <ListOrdered className="h-3.5 w-3.5 text-amber-400" /> Live pending orders
        {!q.isLoading && !q.isError && <span className="font-normal text-txt-secondary">({items.length})</span>}
      </div>
      {q.isLoading ? (
        <p className="text-[11px] text-txt-secondary" data-testid="live-pending-loading">Loading pending orders…</p>
      ) : q.isError ? (
        <p className="text-[11px] text-amber-300" data-testid="live-pending-error">Couldn&apos;t load live pending orders. Check MT5 directly.</p>
      ) : items.length === 0 ? (
        <p className="text-[11px] text-txt-secondary" data-testid="live-pending-empty">No working pending orders placed from ARX.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((o) => (
            <li key={o.orderTicket} className="flex flex-wrap items-center gap-2 text-[11px]" data-testid={`live-pending-${o.orderTicket}`}>
              <Badge variant="outline" className="border-amber-500/40 text-amber-300">{o.orderType.replace(/_/g, " ")}</Badge>
              <span className="font-mono text-zinc-300">{o.symbol}</span>
              <span className="font-mono text-zinc-400">{o.volume} @ {fmt(o.price)}{o.stopLimitPrice != null ? ` → ${fmt(o.stopLimitPrice)}` : ""}</span>
              <span className="font-mono text-[10px] text-txt-secondary">SL {fmt(o.stopLoss)} · TP {fmt(o.takeProfit)}</span>
              <span className="font-mono text-[10px] text-txt-secondary">#{o.orderTicket}</span>
              {o.expiration && (
                <span className="flex items-center gap-0.5 text-[10px] text-txt-secondary"><Clock className="h-3 w-3" /> {new Date(o.expiration).toLocaleString()}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[10px] text-txt-secondary" data-testid="live-pending-note">
        {q.data?.note ?? "From the last terminal answer for each order."} {LIVE_PENDING_CANCEL_NOTE}
      </p>
    </div>
  );
}
