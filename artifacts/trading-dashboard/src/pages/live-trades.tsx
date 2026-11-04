import React, { useState } from "react";
import { useGetOpenTrades, useGetMt5State, getGetOpenTradesQueryKey, getGetMt5StateQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Wifi, WifiOff } from "lucide-react";
import { LiveTradeCard } from "@/components/LiveTradeCard";
import { LiveSlotSummaryCard } from "@/components/live/LiveSlotSummaryCard";
import { LiveOpenTradesPanel } from "@/components/live/LiveOpenTradesPanel";
import { AaciSyncChip } from "@/components/aaci/AaciSyncChip";
import { LiveBridgeAutoRefreshControl } from "@/components/live/LiveBridgeAutoRefreshControl";
import { useLiveBridgeRefresh } from "@/hooks/useLiveBridgeRefresh";

export default function LiveTrades() {
  const bridge = useLiveBridgeRefresh();
  const pollInterval = bridge.autoRefreshEnabled ? 5000 : false;
  const { data: trades, isLoading } = useGetOpenTrades({ query: { queryKey: getGetOpenTradesQueryKey(), refetchInterval: pollInterval } });
  const { data: mt5 } = useGetMt5State({ query: { queryKey: getGetMt5StateQueryKey(), refetchInterval: pollInterval } });
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
          {mt5?.connected ? (
            <Badge className="bg-green-500/20 text-green-500 gap-1"><Wifi size={12} /> System MT5 Connected{mt5.account ? ` • ${mt5.account}` : ""}</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground gap-1"><WifiOff size={12} /> System MT5 Offline</Badge>
          )}
          {mt5?.liveAllowed ? <Badge variant="destructive">LIVE</Badge> : <Badge variant="outline">DEMO</Badge>}
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
        !trades || trades.length === 0 ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground"><Activity size={48} className="mx-auto opacity-30 mb-3" /><p>No open trades.</p></CardContent></Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {trades.map((t) => (
              <LiveTradeCard key={t.id} trade={t} onCoach={() => setSelected(t.id)} />
            ))}
          </div>
        )
      }

      {mt5 && mt5.positions && mt5.positions.length > 0 ? (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">MT5 Positions ({mt5.positions.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1">
              {mt5.positions.map((p) => (
                <div key={p.ticket} className="flex justify-between items-center p-2 rounded border border-border/50 text-sm font-mono">
                  <span>#{p.ticket} {p.symbol} {p.side} {p.lot} @ {p.entry}</span>
                  <span className={(p.profit ?? 0) >= 0 ? "text-green-500" : "text-destructive"}>{(p.profit ?? 0).toFixed(2)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
