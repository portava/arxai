import React from "react";
import { useGetRiskEvents, getGetRiskEventsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Info, ShieldX } from "lucide-react";
import { cn } from "@/lib/utils";

const SEV_STYLE = {
  INFO:     { icon: Info,           tone: "text-txt-secondary" },
  WARN:     { icon: AlertTriangle,  tone: "text-warning" },
  DANGER:   { icon: ShieldX,        tone: "text-warning" },
  CRITICAL: { icon: ShieldX,        tone: "text-danger" },
} as const;

export function RiskEventFeed({ limit = 20, className }: { limit?: number; className?: string }) {
  const { data, isLoading } = useGetRiskEvents(
    { limit },
    { query: { queryKey: getGetRiskEventsQueryKey({ limit }), refetchInterval: 15_000 } },
  );
  const events = data?.events ?? [];

  return (
    <Card className={cn("border-border/50 bg-muted/40", className)}>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Risk Events</CardTitle></CardHeader>
      <CardContent>
        {isLoading && <div className="text-xs text-txt-secondary">Loading…</div>}
        {!isLoading && events.length === 0 && <div className="text-xs text-txt-muted">No risk events yet.</div>}
        <ul className="space-y-2">
          {events.map((e) => {
            const sev = SEV_STYLE[e.severity as keyof typeof SEV_STYLE] ?? SEV_STYLE.INFO;
            const Icon = sev.icon;
            return (
              <li key={e.id} className="flex items-start gap-2 text-xs">
                <Icon size={14} className={cn("shrink-0 mt-0.5", sev.tone)} />
                <div className="flex-1 min-w-0">
                  <div className="text-foreground truncate">{e.summary}</div>
                  <div className="text-[10px] text-txt-muted">
                    {e.kind} · {e.source} · {new Date(e.generatedAtIso).toLocaleString()}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
