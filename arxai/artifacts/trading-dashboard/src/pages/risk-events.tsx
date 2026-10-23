import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollText } from "lucide-react";

type Ev = { eventId: string; ts: string; environment?: string; symbol?: string; source?: string; orderId?: string; rule: string; severity: "INFO" | "WARN" | "BLOCK"; decision: string; explanation: string; auditLogId?: string };

const SEV_COLOR: Record<string, string> = { INFO: "bg-emerald-500/20 text-emerald-400", WARN: "bg-amber-500/20 text-amber-400", BLOCK: "bg-rose-500/20 text-rose-400" };

export default function RiskEvents() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [filter, setFilter] = useState<"ALL" | "BLOCK" | "WARN">("ALL");
  useEffect(() => {
    const load = () => fetch("/api/risk/events?limit=200").then((r) => r.json()).then((d) => setEvents(d.events ?? []));
    load(); const id = setInterval(load, 3000); return () => clearInterval(id);
  }, []);
  const filtered = filter === "ALL" ? events : events.filter((e) => e.severity === filter);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ScrollText className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Risk Event Log</h1>
          <p className="text-sm text-muted-foreground">Every risk decision: approved, rejected, warned, blocked. Source of truth for the audit vault.</p>
        </div>
        <Badge variant="outline">SIMULATOR</Badge>
        {(["ALL", "WARN", "BLOCK"] as const).map((f) => (
          <button key={f} className={`text-xs px-2 py-1 rounded border ${filter === f ? "bg-primary text-primary-foreground" : ""}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">{filtered.length} events</CardTitle><CardDescription>Most recent first</CardDescription></CardHeader>
        <CardContent className="space-y-1">
          {filtered.map((e) => (
            <div key={e.eventId} className="border rounded p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={SEV_COLOR[e.severity]}>{e.severity}</Badge>
                <span className="font-semibold">{e.rule}</span>
                <Badge variant="outline">{e.decision}</Badge>
                {e.symbol && <Badge variant="outline">{e.symbol}</Badge>}
                {e.environment && <Badge variant="outline">{e.environment}</Badge>}
                {e.source && <Badge variant="outline">{e.source}</Badge>}
                <span className="ml-auto text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
              </div>
              <div className="text-muted-foreground mt-1">{e.explanation}</div>
              {e.orderId && <div className="text-muted-foreground">order={e.orderId}</div>}
              {e.auditLogId && <div className="text-muted-foreground">audit={e.auditLogId}</div>}
            </div>
          ))}
          {filtered.length === 0 && <p className="text-xs text-muted-foreground">No events match filter.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
