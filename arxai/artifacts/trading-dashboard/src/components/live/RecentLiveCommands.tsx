import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { History, RefreshCw } from "lucide-react";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type LiveCmd = {
  commandId: string;
  status: string;
  rejectionReason: string | null;
  commandType: string;
  symbol: string;
  side: string;
  requestedVolume: number;
  executedVolume: number | null;
  brokerTicket: string | null;
  fillPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  sourcePage: string;
  createdAt: string;
  sentToMt5At: string | null;
  filledAt: string | null;
  rejectedAt: string | null;
};

const STATUS_TONE: Record<string, string> = {
  LIVE_DRAFT: "bg-slate-500/20 text-slate-300",
  LIVE_CONFIRMATION_REQUIRED: "bg-amber-500/20 text-amber-300",
  LIVE_APPROVED: "bg-amber-500/20 text-amber-200",
  SENT_TO_MT5_LIVE: "bg-sky-500/20 text-sky-300",
  LIVE_FILLED: "bg-emerald-500/20 text-emerald-300",
  LIVE_REJECTED: "bg-rose-500/20 text-rose-300",
  LIVE_FAILED: "bg-rose-500/20 text-rose-300",
  LIVE_BLOCKED: "bg-rose-500/25 text-rose-200 border border-rose-500/50",
  LIVE_CANCELLED: "bg-zinc-500/20 text-zinc-300",
  LIVE_CLOSED: "bg-zinc-500/20 text-zinc-300",
};

function fmt(t: string | null | undefined) {
  if (!t) return "—";
  return new Date(t).toLocaleString();
}

export function RecentLiveCommands() {
  const q = useQuery<{ items: LiveCmd[]; count: number }>({
    queryKey: ["live", "commands"],
    queryFn: () => fetch(`${BASE}/api/me/live/commands?limit=50`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 5_000,
  });

  const items = q.data?.items ?? [];

  return (
    <Card data-testid="recent-live-commands">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5" /> Recent Live Commands
          <span className="text-xs text-muted-foreground font-normal">({items.length})</span>
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => q.refetch()} data-testid="btn-refresh-live-commands">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center" data-testid="live-commands-empty">
            No live commands yet. Create one from the Live Trade Ticket.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-zinc-800">
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2 pr-2">Symbol</th>
                  <th className="py-2 pr-2">Side</th>
                  <th className="py-2 pr-2">Vol</th>
                  <th className="py-2 pr-2">SL/TP</th>
                  <th className="py-2 pr-2">Source</th>
                  <th className="py-2 pr-2">Ticket</th>
                  <th className="py-2 pr-2">Fill</th>
                  <th className="py-2 pr-2">Reason</th>
                  <th className="py-2 pr-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.commandId} className="border-b border-zinc-900" data-testid={`live-cmd-${c.commandId}`}>
                    <td className="py-2 pr-2"><Badge className={STATUS_TONE[c.status] ?? ""}>{c.status}</Badge></td>
                    <td className="py-2 pr-2 font-mono">{c.symbol}</td>
                    <td className="py-2 pr-2">{c.side}</td>
                    <td className="py-2 pr-2">{c.requestedVolume}</td>
                    <td className="py-2 pr-2 text-xs">{c.stopLoss ?? "—"} / {c.takeProfit ?? "—"}</td>
                    <td className="py-2 pr-2 text-xs">{c.sourcePage}</td>
                    <td className="py-2 pr-2 font-mono">{c.brokerTicket ?? "—"}</td>
                    <td className="py-2 pr-2">{c.fillPrice ?? "—"}</td>
                    <td className="py-2 pr-2 text-xs text-rose-300/80 max-w-xs truncate" title={c.rejectionReason ?? ""}>
                      {c.rejectionReason ?? "—"}
                    </td>
                    <td className="py-2 pr-2 text-xs text-muted-foreground">{fmt(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
