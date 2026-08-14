// (N) Compact list of upcoming events — used on Calendar page and any
// risk-overview surface that wants a 24h preview.

import { useQuery } from "@tanstack/react-query";

interface UpcomingEvent {
  id: number; eventName: string; currency: string; country: string;
  impactLevel: string; eventTime: string;
}

const IMPACT_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-700 text-white",
  HIGH:     "bg-orange-700 text-white",
  MEDIUM:   "bg-amber-700 text-white",
  LOW:      "bg-slate-700 text-slate-200",
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
      {isLoading && <p className="text-xs text-slate-500">Loading…</p>}
      {!isLoading && events.length === 0 && (
        <p className="text-xs text-slate-500">No upcoming events in the next {hours}h at {minImpact}+ impact.</p>
      )}
      {events.map((e) => {
        const m = Math.round((new Date(e.eventTime).getTime() - Date.now()) / 60000);
        const when = m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
        return (
          <div key={e.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 p-2 text-xs">
            <span className="w-16 font-mono text-slate-400">{when}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${IMPACT_STYLES[e.impactLevel] ?? "bg-slate-700 text-slate-200"}`}>{e.impactLevel}</span>
            <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">{e.currency}</span>
            <span className="flex-1 text-slate-200">{e.eventName}</span>
            <span className="text-[10px] text-slate-500">{new Date(e.eventTime).toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}
