import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatInstrumentPrice, resolveDisplayPricePrecision } from "@/lib/instrumentPriceFormat";

interface PaperOrder {
  id: number; symbol: string; direction: string; lotSize: number;
  entryPrice: number; stopLoss: number; takeProfit: number;
  status: string; profitLoss: number; openedAt: string;
}

export function PaperOpenPositionsPanel({ accountId }: { accountId: number | null }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ orders: PaperOrder[] }>({
    queryKey: ["paper-orders", accountId, "OPEN"],
    queryFn: async () => {
      const r = await fetch(`/api/paper/orders?accountId=${accountId}&status=OPEN`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: accountId != null,
    refetchInterval: 4000,
  });
  const close = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/paper/orders/${id}/close`, { method: "POST" });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["paper-orders"] }),
  });
  const orders = data?.orders ?? [];
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Open demo positions ({orders.length})</h3>
      {orders.length === 0 ? <p className="text-xs text-slate-500">No open demo positions.</p> :
        <div className="max-h-64 overflow-auto text-xs">
          <table className="w-full">
            <thead className="sticky top-0 bg-slate-900 text-left text-[10px] uppercase text-slate-500">
              <tr><th className="p-1">Symbol</th><th className="p-1">Dir</th><th className="p-1">Lot</th><th className="p-1">Entry</th><th className="p-1">SL/TP</th><th className="p-1"></th></tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                // One precision per row, from the digits this order's own
                // prices carry (no server spec on this endpoint) — never a
                // fixed 4 dp that rounds away or invents digits.
                const dp = resolveDisplayPricePrecision(null, [o.entryPrice, o.stopLoss, o.takeProfit]);
                const px = (v: number) => formatInstrumentPrice(v, dp);
                return (
                <tr key={o.id} className="border-t border-slate-800">
                  <td className="p-1 font-mono">{o.symbol}</td>
                  <td className="p-1">{o.direction}</td>
                  <td className="p-1">{o.lotSize}</td>
                  <td className="p-1 font-mono">{px(o.entryPrice)}</td>
                  <td className="p-1 font-mono text-[10px]">{`${px(o.stopLoss)} / ${px(o.takeProfit)}`}</td>
                  <td className="p-1">
                    <button onClick={()=>close.mutate(o.id)} disabled={close.isPending}
                      className="rounded bg-slate-700 px-2 py-0.5 text-[10px] hover:bg-slate-600 disabled:opacity-50">Close</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      }
    </div>
  );
}
