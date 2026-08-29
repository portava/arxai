import { useGetOpenPositions, getGetOpenPositionsQueryKey } from "@workspace/api-client-react";

const STATUS_TONE: Record<string, string> = {
  OPEN: "bg-success/15 text-success ring-success/30",
  PARTIALLY_CLOSED: "bg-warning/15 text-warning ring-warning/30",
  SYNC_PENDING: "bg-muted text-txt-secondary ring-border/30",
  BROKER_ERROR: "bg-danger/15 text-danger ring-danger/30",
};

export function OpenPositionsPanel({ onSelect }: { onSelect?: (id: number) => void }) {
  const { data, isLoading } = useGetOpenPositions({ query: { queryKey: getGetOpenPositionsQueryKey(), refetchInterval: 5_000 } });
  if (isLoading || !data) return <div className="text-xs text-txt-muted">Loading positions…</div>;
  if (data.positions.length === 0) return <div className="rounded-lg border border-border bg-background/50 p-4 text-sm text-txt-muted">No open positions.</div>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-card text-xs text-txt-muted">
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
        <tbody className="divide-y divide-border">
          {data.positions.map((p) => {
            const upnl = p.unrealizedProfitLoss ?? 0;
            return (
              <tr key={p.id} onClick={() => onSelect?.(p.id)}
                className="cursor-pointer bg-background/40 hover:bg-muted/60">
                <td className="px-3 py-2 font-medium text-foreground">{p.symbol}</td>
                <td className={`px-3 py-2 ${p.direction === "BUY" ? "text-success" : "text-danger"}`}>{p.direction}</td>
                <td className="px-3 py-2 text-right text-txt-secondary">{p.lotSize}</td>
                <td className="px-3 py-2 text-right text-txt-secondary">{p.entryPrice}</td>
                <td className="px-3 py-2 text-right text-txt-secondary">{p.currentPrice ?? "—"}</td>
                <td className={`px-3 py-2 text-right ${upnl >= 0 ? "text-success" : "text-danger"}`}>{upnl.toFixed(2)}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${STATUS_TONE[p.status] ?? "bg-muted/40 text-txt-secondary ring-border"}`}>{p.status.replace(/_/g, " ")}</span></td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onSelect?.(p.id); }}
                    className="rounded border border-border bg-card px-2 py-1 text-[11px] text-foreground hover:bg-secondary"
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
