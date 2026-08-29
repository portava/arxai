// Risk Event Log — YOUR risk decisions, from the durable per-user table.
//
// WHAT WAS WRONG (rank-62 audit finding): this page read GET /api/risk/events,
// which returns lib/riskGovernor2.ts's module-level `events` array — a
// process-global ring buffer capped at 1000 entries, shared across every user
// and wiped on restart. The header called it the "Source of truth for the audit
// vault". It was neither a source of truth (it is volatile) nor per-user (it
// showed other people's simulator decisions) nor the vault (that is the
// DB-backed vault_events table on a different endpoint).
//
// It now reads GET /api/me/risk/events (routes/meRiskGovernor.ts, requireUser,
// user_risk_events) — durable, per-user, and scoped by the session. The vault
// claim is gone and the real audit surfaces are linked instead.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { STATUS_COLORS } from "@/lib/design-tokens";

// Shape of user_risk_events (lib/db/src/schema/userRiskGovernor.ts).
type Ev = {
  id: number;
  eventType: string;
  severity: "info" | "warning" | "critical" | string;
  decision: "pass" | "warning" | "block" | string;
  reason: string;
  details?: Record<string, unknown> | null;
  paperTradeId?: number | null;
  tradingSessionId?: number | null;
  createdAt: string;
};

type Filter = "ALL" | "block" | "warning";

// Severity → semantic tone (STATUS_COLORS renders correctly in both themes).
const SEV_BADGE: Record<string, string> = {
  info: STATUS_COLORS.success.badge,
  warning: STATUS_COLORS.warning.badge,
  critical: STATUS_COLORS.danger.badge,
};

export default function RiskEvents() {
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/me/risk/events", { credentials: "include" });
        if (!r.ok) {
          // A failed read degrades to an honest typed null with a reason —
          // never to an empty list that reads as "you had no risk events".
          if (!cancelled) setError(r.status === 401 ? "Sign in to see your risk events." : `Could not load your risk events (HTTP ${r.status}).`);
          return;
        }
        const d = await r.json() as { events?: Ev[] };
        if (cancelled) return;
        setError(null);
        setEvents(Array.isArray(d.events) ? d.events : []);
      } catch {
        if (!cancelled) setError("Could not reach the risk-events API. This list is not current.");
      }
    };
    void load();
    const id = setInterval(() => { void load(); }, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const filtered = events === null ? [] : filter === "ALL" ? events : events.filter((e) => e.decision === filter);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <ScrollText className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Your Risk Event Log</h1>
          <p className="text-sm text-muted-foreground">
            Risk decisions recorded for your account: passed, warned, blocked. Durable and per-user — it survives
            restarts. This is not the audit vault; see the{" "}
            <a href="/audit-log" className="underline text-primary">full audit log</a> for that.
          </p>
        </div>
        {(["ALL", "warning", "block"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant="outline"
            className={cn("h-7 text-xs uppercase", filter === f && "border-primary/40 bg-primary/10 text-primary")}
            onClick={() => setFilter(f)}
          >{f}</Button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger" data-testid="risk-events-error">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="tabular-nums">
            {events === null ? (error ? "—" : "Loading…") : `${filtered.length} events`}
          </CardTitle>
          <CardDescription>Most recent first</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {filtered.map((e) => (
            <div key={e.id} className="rounded-lg bg-muted/40 p-3 text-xs" data-testid={`risk-event-${e.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={SEV_BADGE[e.severity] ?? STATUS_COLORS.warning.badge}>{e.severity.toUpperCase()}</Badge>
                <span className="font-semibold">{e.eventType}</span>
                <Badge variant="outline">{e.decision.toUpperCase()}</Badge>
                {e.paperTradeId != null && <Badge variant="outline">paper trade #{e.paperTradeId}</Badge>}
                <span className="ml-auto text-muted-foreground tabular-nums">{new Date(e.createdAt).toLocaleString()}</span>
              </div>
              {e.reason && <div className="text-muted-foreground mt-1">{e.reason}</div>}
            </div>
          ))}
          {events !== null && filtered.length === 0 && !error && (
            <EmptyState
              compact
              icon={ScrollText}
              title="No risk events match this filter."
              description="Risk decisions appear here as your trades are checked. Try the ALL filter, or place a simulated trade to generate events."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
