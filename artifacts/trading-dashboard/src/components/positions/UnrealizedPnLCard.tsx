import { useGetOpenPositions, getGetOpenPositionsQueryKey } from "@workspace/api-client-react";

export function UnrealizedPnLCard() {
  const { data, isLoading, isError } = useGetOpenPositions({ query: { queryKey: getGetOpenPositionsQueryKey(), refetchInterval: 5_000 } });

  // A failed read is not a flat book. Never print a confident, green "0.00"
  // over an error or a not-yet-arrived response.
  if (isError || (!isLoading && !data)) {
    return (
      <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
        <div className="text-xs uppercase tracking-wide text-warning">Unrealized P&L</div>
        <div className="mt-1 text-2xl font-semibold text-warning">—</div>
        <div className="mt-1 text-xs text-warning">Unavailable — positions could not be read.</div>
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="rounded-xl border border-border bg-background/50 p-4">
        <div className="text-xs uppercase tracking-wide text-txt-muted">Unrealized P&L</div>
        <div className="mt-1 text-2xl font-semibold text-txt-muted">—</div>
        <div className="mt-1 text-xs text-txt-muted">Loading…</div>
      </div>
    );
  }

  const positions = data.positions ?? [];
  // A position whose P/L has never synced is unknown, not zero: it is excluded
  // from the sum and the total is labeled incomplete rather than folding a
  // fabricated 0 in silently.
  const priced = positions.filter((p) => p.unrealizedProfitLoss != null);
  const missing = positions.length - priced.length;
  const upnl = priced.reduce((s, p) => s + (p.unrealizedProfitLoss ?? 0), 0);
  const allUnknown = positions.length > 0 && priced.length === 0;
  // No readable value = no directional claim, so no green/red.
  const tone = allUnknown ? "text-txt-muted" : upnl >= 0 ? "text-success" : "text-danger";

  return (
    <div className="rounded-xl border border-border bg-background/50 p-4">
      <div className="text-xs uppercase tracking-wide text-txt-muted">Unrealized P&L</div>
      <div className={`mt-1 text-2xl font-semibold ${tone}`}>{allUnknown ? "—" : upnl.toFixed(2)}</div>
      <div className="mt-1 text-xs text-txt-muted">{positions.length} open</div>
      {missing > 0 && (
        <div className="mt-1 text-xs text-warning">
          Incomplete — {missing} position{missing === 1 ? "" : "s"} not yet synced.
        </div>
      )}
    </div>
  );
}
