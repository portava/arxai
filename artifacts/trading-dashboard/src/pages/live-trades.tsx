import React, { useState } from "react";
import { useGetOpenTrades, getGetOpenTradesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity } from "lucide-react";
import { LiveTradeCard } from "@/components/LiveTradeCard";
import { LiveSlotSummaryCard } from "@/components/live/LiveSlotSummaryCard";
import { LiveOpenTradesPanel } from "@/components/live/LiveOpenTradesPanel";
import { AaciSyncChip } from "@/components/aaci/AaciSyncChip";
import { LiveBridgeAutoRefreshControl } from "@/components/live/LiveBridgeAutoRefreshControl";
import { useLiveBridgeRefresh } from "@/hooks/useLiveBridgeRefresh";
import { useTradingMode } from "@/hooks/useTradingMode";

// The header used GET /mt5/state, the platform-wide singleton that whichever
// EA heartbeated last overwrites (account number, liveAllowed, positions). It
// is not the viewer's bridge or mode, so this page no longer reads it: the
// viewer's bridge state comes from useLiveBridgeRefresh (shown by the refresh
// control) and the mode badge from the viewer's own account-mode envelope.
function modeBadge(mode: ReturnType<typeof useTradingMode>): React.ReactNode {
  if (mode.isLoading) return null;
  if (mode.isError || !mode.envelope) return <Badge variant="outline" data-testid="live-trades-mode">Mode unknown</Badge>;
  if (mode.isLiveShared) return <Badge variant="destructive" data-testid="live-trades-mode">LIVE</Badge>;
  if (mode.isDemo) return <Badge variant="outline" data-testid="live-trades-mode">DEMO</Badge>;
  if (mode.isPaper) return <Badge variant="outline" data-testid="live-trades-mode">PAPER</Badge>;
  return <Badge variant="outline" data-testid="live-trades-mode">{mode.cleanModeLabel || "Mode unknown"}</Badge>;
}

export default function LiveTrades() {
  const bridge = useLiveBridgeRefresh();
  const pollInterval = bridge.autoRefreshEnabled ? 5000 : false;
  const { data: trades, isLoading } = useGetOpenTrades({ query: { queryKey: getGetOpenTradesQueryKey(), refetchInterval: pollInterval } });
  const tradingMode = useTradingMode();
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
          {modeBadge(tradingMode)}
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

    </div>
  );
}
