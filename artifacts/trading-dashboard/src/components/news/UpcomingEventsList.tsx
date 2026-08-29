// (N) Compact list of upcoming events — used on Calendar page and any
// risk-overview surface that wants a 24h preview.

import { useQuery } from "@tanstack/react-query";

interface UpcomingEvent {
  id: number; eventName: string; currency: string; country: string;
  impactLevel: string; eventTime: string;
}

const IMPACT_STYLES: Record<string, string> = {
  CRITICAL: "bg-danger/15 text-white",
  HIGH:     "bg-warning/15 text-white",
  MEDIUM:   "bg-warning/15 text-white",
  LOW:      "bg-muted text-foreground",
};

export function UpcomingEventsList({ hours = 24, minImpact = "MEDIUM" }: { hours?: number; minImpact?: string }) {
  const { data, isLoading } = useQuery<{ events: UpcomingEvent[] }>({
    queryKey: ["upcoming-events", hours, minImpact],
    queryFn: async () => {
      const r = await fetch(`/api/economic-events/upcoming?hours=${hours}&minImpact=${minImpact}`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    refetchInterval: 120_000,
  });
  const events = data?.events ?? [];

  return (
    <div className="space-y-1">
      {isLoading && <p className="text-xs text-txt-muted">Loading…</p>}
      {!isLoading && events.length === 0 && (
        <p className="text-xs text-txt-muted">No upcoming events in the next {hours}h at {minImpact}+ impact.</p>
      )}
      {events.map((e) => {
        const m = Math.round((new Date(e.eventTime).getTime() - Date.now()) / 60000);
        const when = m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
        return (
          <div key={e.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/40 p-2 text-xs">
            <span className="w-16 font-mono text-txt-secondary">{when}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${IMPACT_STYLES[e.impactLevel] ?? "bg-muted text-foreground"}`}>{e.impactLevel}</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-txt-secondary">{e.currency}</span>
            <span className="flex-1 text-foreground">{e.eventName}</span>
            <span className="text-[10px] text-txt-muted">{new Date(e.eventTime).toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}
