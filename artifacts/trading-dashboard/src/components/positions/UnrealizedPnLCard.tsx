import { useGetOpenPositions, getGetOpenPositionsQueryKey } from "@workspace/api-client-react";

export function UnrealizedPnLCard() {
  const { data } = useGetOpenPositions({ query: { queryKey: getGetOpenPositionsQueryKey(), refetchInterval: 5_000 } });
  const upnl = (data?.positions ?? []).reduce((s, p) => s + (p.unrealizedProfitLoss ?? 0), 0);
  const tone = upnl >= 0 ? "text-success" : "text-danger";
  return (
    <div className="rounded-xl border border-border bg-background/50 p-4">
      <div className="text-xs uppercase tracking-wide text-txt-muted">Unrealized P&L</div>
      <div className={`mt-1 text-2xl font-semibold ${tone}`}>{upnl.toFixed(2)}</div>
      <div className="mt-1 text-xs text-txt-muted">{data?.positions.length ?? 0} open</div>
    </div>
  );
}
