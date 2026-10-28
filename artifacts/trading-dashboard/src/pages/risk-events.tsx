import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollText } from "lucide-react";

type Ev = { eventId: string; ts: string; environment?: string; symbol?: string; source?: string; orderId?: string; rule: string; severity: "INFO" | "WARN" | "BLOCK"; decision: string; explanation: string; auditLogId?: string };

const SEV_COLOR: Record<string, string> = { INFO: "bg-emerald-500/20 text-emerald-400", WARN: "bg-amber-500/20 text-amber-400", BLOCK: "bg-rose-500/20 text-rose-400" };

export default function RiskEvents() {
  // null = never read. A failed read is shown as such, never as an empty log.
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"ALL" | "BLOCK" | "WARN">("ALL");
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/risk/events?limit=200");
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (!d || !Array.isArray(d.events)) throw new Error("the server's answer had no event list");
        if (!alive) return;
        setEvents(d.events); setLoadedAt(new Date()); setLoadError(null);
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      }
    };
    void load(); const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const filtered = events == null ? [] : filter === "ALL" ? events : events.filter((e) => e.severity === filter);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ScrollText className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Risk Event Log</h1>
          <p className="text-sm text-muted-foreground">Risk Governor decisions recorded for your account (passed, warned, blocked) on paper, demo and live orders. Each row shows the venue its record names.</p>
        </div>
        {(["ALL", "WARN", "BLOCK"] as const).map((f) => (
          <button key={f} className={`text-xs px-2 py-1 rounded border ${filter === f ? "bg-primary text-primary-foreground" : ""}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      {events == null ? (
        <Card>
          <CardContent className="pt-6 text-sm">
            {loadError
              ? <p className="text-rose-400">Risk events could not be loaded ({loadError}). Blocks and warnings may exist that are not shown here.</p>
              : <p className="text-muted-foreground">Loading risk events…</p>}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader><CardTitle className="text-base">{filtered.length} events</CardTitle><CardDescription>Most recent first</CardDescription></CardHeader>
          <CardContent className="space-y-1">
            {loadError && loadedAt && (
              <p className="text-xs text-amber-400">
                The log could not be refreshed ({loadError}). Showing the events as loaded at {loadedAt.toLocaleString()}; newer events may be missing.
              </p>
            )}
            {filtered.map((e) => (
              <div key={e.eventId} className="border rounded p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={SEV_COLOR[e.severity]}>{e.severity}</Badge>
                  <span className="font-semibold">{e.rule}</span>
                  <Badge variant="outline">{e.decision}</Badge>
                  {e.symbol && <Badge variant="outline">{e.symbol}</Badge>}
                  {e.environment
                    ? <Badge variant="outline">{e.environment}</Badge>
                    : <Badge variant="outline" className="text-muted-foreground">venue not recorded</Badge>}
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
      )}
    </div>
  );
}
