import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { STATUS_COLORS } from "@/lib/design-tokens";

type Ev = { eventId: string; ts: string; environment?: string; symbol?: string; source?: string; orderId?: string; rule: string; severity: "INFO" | "WARN" | "BLOCK"; decision: string; explanation: string; auditLogId?: string };

// Severity → semantic tone (STATUS_COLORS renders correctly in both themes).
const SEV_BADGE: Record<string, string> = {
  INFO: STATUS_COLORS.success.badge,
  WARN: STATUS_COLORS.warning.badge,
  BLOCK: STATUS_COLORS.danger.badge,
};

export default function RiskEvents() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [filter, setFilter] = useState<"ALL" | "BLOCK" | "WARN">("ALL");
  useEffect(() => {
    const load = () => fetch("/api/risk/events?limit=200").then((r) => r.json()).then((d) => setEvents(d.events ?? []));
    load(); const id = setInterval(load, 3000); return () => clearInterval(id);
  }, []);
  const filtered = filter === "ALL" ? events : events.filter((e) => e.severity === filter);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <ScrollText className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Risk Event Log</h1>
          <p className="text-sm text-muted-foreground">Every risk decision: approved, rejected, warned, blocked. Source of truth for the audit vault.</p>
        </div>
        <Badge variant="outline">SIMULATOR</Badge>
        {(["ALL", "WARN", "BLOCK"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant="outline"
            className={cn("h-7 text-xs", filter === f && "border-primary/40 bg-primary/10 text-primary")}
            onClick={() => setFilter(f)}
          >{f}</Button>
        ))}
      </div>
      <Card>
        <CardHeader><CardTitle className="tabular-nums">{filtered.length} events</CardTitle><CardDescription>Most recent first</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          {filtered.map((e) => (
            <div key={e.eventId} className="rounded-lg bg-muted/40 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={SEV_BADGE[e.severity]}>{e.severity}</Badge>
                <span className="font-semibold">{e.rule}</span>
                <Badge variant="outline">{e.decision}</Badge>
                {e.symbol && <Badge variant="outline">{e.symbol}</Badge>}
                {e.environment && <Badge variant="outline">{e.environment}</Badge>}
                {e.source && <Badge variant="outline">{e.source}</Badge>}
                <span className="ml-auto text-muted-foreground tabular-nums">{new Date(e.ts).toLocaleTimeString()}</span>
              </div>
              <div className="text-muted-foreground mt-1">{e.explanation}</div>
              {e.orderId && <div className="text-muted-foreground">order={e.orderId}</div>}
              {e.auditLogId && <div className="text-muted-foreground">audit={e.auditLogId}</div>}
            </div>
          ))}
          {filtered.length === 0 && (
            <EmptyState
              compact
              icon={ScrollText}
              title="No risk events match this filter."
              description="Risk decisions will appear here as trades are checked. Try the ALL filter, or place a simulated trade to generate events."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
