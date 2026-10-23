import React from "react";
import { useGetRiskEvents, getGetRiskEventsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Info, ShieldX } from "lucide-react";
import { cn } from "@/lib/utils";

const SEV_STYLE = {
  INFO:     { icon: Info,           tone: "text-slate-300" },
  WARN:     { icon: AlertTriangle,  tone: "text-amber-300" },
  DANGER:   { icon: ShieldX,        tone: "text-orange-300" },
  CRITICAL: { icon: ShieldX,        tone: "text-red-300" },
} as const;

export function RiskEventFeed({ limit = 20, className }: { limit?: number; className?: string }) {
  const { data, isLoading } = useGetRiskEvents(
    { limit },
    { query: { queryKey: getGetRiskEventsQueryKey({ limit }), refetchInterval: 15_000 } },
  );
  const events = data?.events ?? [];

  return (
    <Card className={cn("border-slate-700/50 bg-slate-900/40", className)}>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Risk Events</CardTitle></CardHeader>
      <CardContent>
        {isLoading && <div className="text-xs text-slate-400">Loading…</div>}
        {!isLoading && events.length === 0 && <div className="text-xs text-slate-500">No risk events yet.</div>}
        <ul className="space-y-2">
          {events.map((e) => {
            const sev = SEV_STYLE[e.severity as keyof typeof SEV_STYLE] ?? SEV_STYLE.INFO;
            const Icon = sev.icon;
            return (
              <li key={e.id} className="flex items-start gap-2 text-xs">
                <Icon size={14} className={cn("shrink-0 mt-0.5", sev.tone)} />
                <div className="flex-1 min-w-0">
                  <div className="text-slate-200 truncate">{e.summary}</div>
                  <div className="text-[10px] text-slate-500">
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
