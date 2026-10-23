import { useGetOpenPositions, getGetOpenPositionsQueryKey } from "@workspace/api-client-react";

export function UnrealizedPnLCard() {
  const { data } = useGetOpenPositions({ query: { queryKey: getGetOpenPositionsQueryKey(), refetchInterval: 5_000 } });
  const upnl = (data?.positions ?? []).reduce((s, p) => s + (p.unrealizedProfitLoss ?? 0), 0);
  const tone = upnl >= 0 ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">Unrealized P&L</div>
      <div className={`mt-1 text-2xl font-semibold ${tone}`}>{upnl.toFixed(2)}</div>
      <div className="mt-1 text-xs text-zinc-500">{data?.positions.length ?? 0} open</div>
    </div>
  );
}
