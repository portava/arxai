import { useGetOpenPositions, getGetOpenPositionsQueryKey } from "@workspace/api-client-react";

const STATUS_TONE: Record<string, string> = {
  OPEN: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  PARTIALLY_CLOSED: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  SYNC_PENDING: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30",
  BROKER_ERROR: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
};

export function OpenPositionsPanel({ onSelect }: { onSelect?: (id: number) => void }) {
  const { data, isLoading } = useGetOpenPositions({ query: { queryKey: getGetOpenPositionsQueryKey(), refetchInterval: 5_000 } });
  if (isLoading || !data) return <div className="text-xs text-zinc-500">Loading positions…</div>;
  if (data.positions.length === 0) return <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4 text-sm text-zinc-500">No open positions.</div>;
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900 text-xs text-zinc-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Symbol</th>
            <th className="px-3 py-2 text-left font-medium">Side</th>
            <th className="px-3 py-2 text-right font-medium">Lot</th>
            <th className="px-3 py-2 text-right font-medium">Entry</th>
            <th className="px-3 py-2 text-right font-medium">Price</th>
            <th className="px-3 py-2 text-right font-medium">uPnL</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {data.positions.map((p) => {
            const upnl = p.unrealizedProfitLoss ?? 0;
            return (
              <tr key={p.id} onClick={() => onSelect?.(p.id)}
                className="cursor-pointer bg-zinc-950/40 hover:bg-zinc-900/60">
                <td className="px-3 py-2 font-medium text-zinc-100">{p.symbol}</td>
                <td className={`px-3 py-2 ${p.direction === "BUY" ? "text-emerald-300" : "text-rose-300"}`}>{p.direction}</td>
                <td className="px-3 py-2 text-right text-zinc-300">{p.lotSize}</td>
                <td className="px-3 py-2 text-right text-zinc-300">{p.entryPrice}</td>
                <td className="px-3 py-2 text-right text-zinc-300">{p.currentPrice ?? "—"}</td>
                <td className={`px-3 py-2 text-right ${upnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{upnl.toFixed(2)}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${STATUS_TONE[p.status] ?? "bg-zinc-700/40 text-zinc-300 ring-zinc-700"}`}>{p.status.replace(/_/g, " ")}</span></td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onSelect?.(p.id); }}
                    className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
                    data-testid={`position-manage-${p.id}`}
                    aria-label={`Manage position ${p.symbol}`}
                  >
                    Manage · Close / Modify
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
