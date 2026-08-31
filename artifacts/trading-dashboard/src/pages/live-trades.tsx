import React, { useState } from "react";
import { useGetOpenTrades, useGetMt5State, getGetOpenTradesQueryKey, getGetMt5StateQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, AlertTriangle, Wifi, WifiOff } from "lucide-react";
import { LiveTradeCard } from "@/components/LiveTradeCard";
import { LiveSlotSummaryCard } from "@/components/live/LiveSlotSummaryCard";
import { LiveOpenTradesPanel } from "@/components/live/LiveOpenTradesPanel";
import { AaciSyncChip } from "@/components/aaci/AaciSyncChip";
import { LiveBridgeAutoRefreshControl } from "@/components/live/LiveBridgeAutoRefreshControl";
import { useLiveBridgeRefresh } from "@/hooks/useLiveBridgeRefresh";

export default function LiveTrades() {
  const bridge = useLiveBridgeRefresh();
  const pollInterval = bridge.autoRefreshEnabled ? 5000 : false;
  // Truth rule: a FAILED read is not an EMPTY read. isError is surfaced for
  // both queries so a broken fetch can never render as "No open trades." or
  // silently remove the MT5 Positions block (both indistinguishable from flat).
  const { data: trades, isLoading, isError: tradesError, refetch: refetchTrades, isFetching: tradesFetching } =
    useGetOpenTrades({ query: { queryKey: getGetOpenTradesQueryKey(), refetchInterval: pollInterval } });
  const { data: mt5, isError: mt5Error } = useGetMt5State({ query: { queryKey: getGetMt5StateQueryKey(), refetchInterval: pollInterval } });
  const [selected, setSelected] = useState<number | null>(null);
  void selected;
  const firstSymbol = trades && trades.length > 0 ? trades[0]!.symbol : null;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="text-primary" /> Live Trades
          </h2>
          <p className="text-muted-foreground">Active positions with health, suggestions, and AI coaching.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 max-w-full min-w-0">
          {mt5Error ? (
            // Failed read ≠ offline: we could not read the MT5 state at all, so
            // neither "Connected" nor "Offline" (nor LIVE/DEMO) can be claimed.
            <Badge variant="outline" className="text-warning border-warning/40 gap-1" data-testid="badge-mt5-state-unknown"><AlertTriangle size={12} /> MT5 status unavailable</Badge>
          ) : mt5?.connected ? (
            <Badge className="bg-success/20 text-success gap-1"><Wifi size={12} /> System MT5 Connected{mt5.account ? ` • ${mt5.account}` : ""}</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground gap-1"><WifiOff size={12} /> System MT5 Offline</Badge>
          )}
          {mt5Error ? null : mt5?.liveAllowed ? <Badge variant="destructive">LIVE</Badge> : <Badge variant="outline">DEMO</Badge>}
          {firstSymbol ? <AaciSyncChip symbol={firstSymbol} /> : null}
          <LiveBridgeAutoRefreshControl
            autoRefreshEnabled={bridge.autoRefreshEnabled}
            toggleAutoRefresh={bridge.toggleAutoRefresh}
            refreshNow={bridge.refreshNow}
            isRefreshing={bridge.isRefreshing}
            lastRefreshAt={bridge.lastRefreshAt}
            nextRefreshInMs={bridge.nextRefreshInMs}
            bridgeState={bridge.bridgeState}
          />
        </div>
      </div>

      <LiveSlotSummaryCard />
      <LiveOpenTradesPanel />

      {isLoading ? <Skeleton className="h-64 w-full" /> :
        tradesError ? (
          // Explicit could-not-read state — never the confident "No open
          // trades." empty state for a failed fetch.
          <Card>
            <CardContent className="py-10 text-center" role="alert" data-testid="open-trades-read-error">
              <AlertTriangle size={32} className="mx-auto mb-3 text-warning" />
              <p className="font-semibold text-warning">Couldn&apos;t load open trades — do not assume you are flat.</p>
              <p className="mt-1 text-xs text-muted-foreground">Your broker may still hold open positions. Check MT5 directly before acting.</p>
              <button
                type="button"
                className="mt-3 rounded border border-border px-3 py-1 text-xs hover:bg-muted"
                onClick={() => void refetchTrades()}
                disabled={tradesFetching}
                data-testid="btn-retry-open-trades-page"
              >
                {tradesFetching ? "Retrying…" : "Retry"}
              </button>
            </CardContent>
          </Card>
        ) : !trades || trades.length === 0 ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground"><Activity size={48} className="mx-auto opacity-30 mb-3" /><p>No open trades.</p></CardContent></Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {trades.map((t) => (
              <LiveTradeCard key={t.id} trade={t} onCoach={() => setSelected(t.id)} />
            ))}
          </div>
        )
      }

      {mt5Error ? (
        // A failed mt5-state read must not silently remove this block — that is
        // indistinguishable from "no broker positions".
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">MT5 Positions</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm text-warning" role="alert" data-testid="mt5-positions-read-error">
              <AlertTriangle size={16} className="shrink-0" />
              <span>Couldn&apos;t read MT5 positions — the broker may still hold open positions.</span>
            </div>
          </CardContent>
        </Card>
      ) : mt5 && mt5.positions && mt5.positions.length > 0 ? (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">MT5 Positions ({mt5.positions.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1">
              {mt5.positions.map((p) => (
                <div key={p.ticket} className="flex justify-between items-center p-2 rounded border border-border/50 text-sm font-mono">
                  <span>#{p.ticket} {p.symbol} {p.side} {p.lot} @ {p.entry}</span>
                  {/* An unreported P/L (EA omitted `profit`) is unknown, not a
                      flat 0.00 — render a muted em dash instead. */}
                  <span className={p.profit == null ? "text-muted-foreground" : p.profit >= 0 ? "text-success" : "text-destructive"}>
                    {p.profit == null ? "—" : p.profit.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
