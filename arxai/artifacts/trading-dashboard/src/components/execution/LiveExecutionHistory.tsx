import React from "react";
import { useGetExecutionHistory, getGetExecutionHistoryQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, XCircle, Clock, ShieldX, Hourglass } from "lucide-react";

const STATUS_META: Record<string, { icon: React.ComponentType<{ size?: number; className?: string }>; tone: string; label: string }> = {
  PENDING:   { icon: Clock,        tone: "text-muted-foreground", label: "Pending" },
  CONFIRMED: { icon: CheckCircle2, tone: "text-blue-400",         label: "Confirmed" },
  EXECUTED:  { icon: CheckCircle2, tone: "text-green-500",        label: "Executed" },
  CANCELLED: { icon: XCircle,      tone: "text-muted-foreground", label: "Cancelled" },
  REJECTED:  { icon: ShieldX,      tone: "text-red-500",          label: "Rejected" },
  EXPIRED:   { icon: Hourglass,    tone: "text-muted-foreground", label: "Expired" },
};

/**
 * Live Execution History — Build F.
 * Shows the most recent N execution-confirmation rows with their status.
 * Polls every 5 s so newly confirmed/executed/rejected rows appear live.
 */
export function LiveExecutionHistory({ limit = 25 }: { limit?: number }) {
  const { data, isLoading } = useGetExecutionHistory(
    { limit },
    {
      query: {
        queryKey: getGetExecutionHistoryQueryKey({ limit }),
        refetchInterval: 5000,
      },
    },
  );
  const rows = data?.confirmations ?? [];

  return (
    <Card className="border-card-border" data-testid="live-execution-history">
      <CardHeader className="pb-3 border-b border-border">
        <CardTitle className="text-sm font-semibold uppercase tracking-wider">Live Execution History</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">No execution attempts yet.</div>
        ) : (
          <ul className="divide-y divide-border/50">
            {rows.map((r) => {
              const meta = STATUS_META[r.status] ?? STATUS_META["PENDING"]!;
              const Icon = meta.icon;
              return (
                <li key={r.id} className="px-3 py-2.5 flex items-center gap-3 text-xs hover:bg-muted/30">
                  <Icon size={14} className={meta.tone} />
                  <div className="flex-1 min-w-0">
                    <div className="font-mono font-semibold truncate">
                      #{r.id} · {r.symbol} {r.direction} {r.lotSize}
                    </div>
                    <div className="text-muted-foreground truncate">
                      {r.executionResult ?? `Risk $${r.estimatedRisk.toFixed(2)} · R:R ${r.rewardToRisk.toFixed(2)}`}
                    </div>
                  </div>
                  <div className={`text-[10px] uppercase font-bold ${meta.tone}`}>{meta.label}</div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
