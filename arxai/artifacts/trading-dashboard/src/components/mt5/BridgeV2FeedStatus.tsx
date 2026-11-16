// Task #398 — user-facing Bridge v2 feed status (compact, honest, redacted)
//
// Renders ONLY when the user actually has a Bridge v2 connection reporting
// (hasV2Bridge). In steady state the production bridge is v1.50, so this
// component renders nothing — no banner, no "coming soon" noise.
//
// SAFETY: reads the redacted /api/me/bridge/v2/status projection only. It never
// exposes sequences, trace rows, gate snapshots, or raw tokens. Feed freshness
// is observability, NOT an execution affordance — no trade buttons here.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Wifi, WifiOff } from "lucide-react";
import { useGetMeBridgeV2Status, getGetMeBridgeV2StatusQueryKey } from "@workspace/api-client-react";

function freshnessBadge(f: string) {
  const map: Record<string, string> = {
    LIVE: "bg-success/15 text-success border-success/30",
    STALE: "bg-warning/15 text-warning border-warning/30",
    OFFLINE: "bg-danger/15 text-danger border-danger/30",
    UNKNOWN: "border-border text-txt-secondary",
  };
  return <Badge className={map[f] ?? ""}>{f}</Badge>;
}

function ts(s: string | null | undefined): string {
  return s ? new Date(s).toLocaleTimeString() : "—";
}

export function BridgeV2FeedStatus() {
  const { data } = useGetMeBridgeV2Status({
    query: {
      queryKey: getGetMeBridgeV2StatusQueryKey(),
      refetchInterval: 15000,
      refetchIntervalInBackground: false,
    },
  });

  // Honest absence: render nothing unless a v2 bridge is actually reporting.
  if (!data || !data.hasV2Bridge) return null;

  return (
    <Card data-testid="bridge-v2-feed-status">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            {data.connected ? <Wifi className="w-4 h-4 text-success" /> : <WifiOff className="w-4 h-4 text-txt-secondary" />}
            <Activity className="w-4 h-4" /> Bridge v2 feed
          </span>
          {freshnessBadge(data.feedFreshness)}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm space-y-1.5">
        <div className="flex justify-between"><span className="text-txt-secondary">Account</span><span>{(data.accountType ?? "unknown").toUpperCase()}</span></div>
        <div className="flex justify-between"><span className="text-txt-secondary">Last heartbeat</span><span>{ts(data.lastHeartbeatAt)}</span></div>
        <div className="flex justify-between"><span className="text-txt-secondary">Last quote</span><span>{ts(data.lastQuoteAt)}</span></div>
        <div className="flex justify-between"><span className="text-txt-secondary">Last candle</span><span>{ts(data.lastCandleAt)}</span></div>
        <p className="text-xs text-txt-muted pt-1">
          Live feed status only. This does not place or change any trade.
        </p>
      </CardContent>
    </Card>
  );
}
