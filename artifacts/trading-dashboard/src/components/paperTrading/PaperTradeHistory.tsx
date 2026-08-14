import { useQuery } from "@tanstack/react-query";

interface Order {
  id: number; symbol: string; direction: string; lotSize: number;
  entryPrice: number; exitPrice: number | null; status: string;
  profitLoss: number; openedAt: string; closedAt: string | null;
}
interface Hist { orders: Order[]; closedCount: number; wins: number; losses: number; winRate: number; netPnl: number; }

export function PaperTradeHistory({ accountId }: { accountId: number | null }) {
  const { data } = useQuery<Hist>({
    queryKey: ["paper-history", accountId],
    queryFn: async () => {
      const r = await fetch(`/api/paper/history?accountId=${accountId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: accountId != null,
    refetchInterval: 6000,
  });
  const closed = (data?.orders ?? []).filter((o) => o.status !== "OPEN");
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Demo trade history ({closed.length})</h3>
      {closed.length === 0 ? <p className="text-xs text-slate-500">No closed demo trades yet.</p> :
        <div className="max-h-64 overflow-auto text-xs">
          <table className="w-full">
            <thead className="sticky top-0 bg-slate-900 text-left text-[10px] uppercase text-slate-500">
              <tr><th className="p-1">Symbol</th><th className="p-1">Dir</th><th className="p-1">Status</th><th className="p-1">P&L</th></tr>
            </thead>
            <tbody>
              {closed.map((o) => (
                <tr key={o.id} className="border-t border-slate-800">
                  <td className="p-1 font-mono">{o.symbol}</td>
                  <td className="p-1">{o.direction}</td>
                  <td className="p-1">
                    <span className={`rounded px-1 py-0.5 text-[10px] ${o.status==="CLOSED_TP"?"bg-green-700 text-white":o.status==="CLOSED_SL"?"bg-red-700 text-white":"bg-slate-700 text-slate-200"}`}>
                      {o.status.replace("CLOSED_","")}
                    </span>
                  </td>
                  <td className={`p-1 font-mono ${o.profitLoss>=0?"text-green-400":"text-red-400"}`}>{o.profitLoss>=0?"+":""}{o.profitLoss.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
      <p className="mt-2 text-[10px] text-amber-300">Simulated — demo trading does not guarantee live results.</p>
    </div>
  );
}
