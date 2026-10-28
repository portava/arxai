// (N) Dashboard banner — shows when a HIGH/CRITICAL economic event is within
// the next 60 minutes. Polls /economic-events/upcoming?hours=1&minImpact=HIGH.
// Pulses red on CRITICAL.

import { useQuery } from "@tanstack/react-query";
import type { CalendarCoverage } from "./UpcomingEventsList";

interface UpcomingEvent {
  id: number; eventName: string; currency: string; impactLevel: "HIGH" | "CRITICAL" | string;
  eventTime: string;
}

export function HighImpactEventBanner() {
  const { data } = useQuery<{ events: UpcomingEvent[]; calendarCoverage?: CalendarCoverage }>({
    queryKey: ["upcoming-high-impact"],
    queryFn: async () => {
      const r = await fetch("/api/economic-events/upcoming?hours=1&minImpact=HIGH");
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    refetchInterval: 60_000,
  });
  const events = data?.events ?? [];
  if (events.length === 0) {
    // No banner is read as "nothing in the next hour". When the stored
    // calendar does not reach that far, say it was not checked instead.
    if (data?.calendarCoverage?.windowCovered === false) {
      return (
        <div data-testid="high-impact-banner-not-checked" className="rounded-md border border-slate-600 bg-slate-900/60 p-2 text-xs text-slate-300">
          High-impact events in the next hour were not checked: {data.calendarCoverage.note ?? "the stored economic calendar does not cover it."}
        </div>
      );
    }
    return null;
  }
  const hasCritical = events.some((e) => e.impactLevel === "CRITICAL");
  const cls = hasCritical
    ? "border-red-700 bg-red-950/60 text-red-100 animate-pulse"
    : "border-orange-700 bg-orange-950/40 text-orange-100";
  return (
    <div className={`rounded-md border p-3 text-sm ${cls}`}>
      <div className="font-semibold">⚠ {hasCritical ? "Critical" : "High-impact"} economic event{events.length > 1 ? "s" : ""} within 1 hour</div>
      <ul className="mt-1 space-y-0.5 text-xs">
        {events.slice(0, 4).map((e) => {
          const m = Math.max(0, Math.round((new Date(e.eventTime).getTime() - Date.now()) / 60000));
          return (
            <li key={e.id}>
              <span className="font-mono">{m}m</span> · {e.impactLevel} · {e.currency} · {e.eventName}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
