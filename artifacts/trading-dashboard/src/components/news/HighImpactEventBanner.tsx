// (N) Dashboard banner — shows when a HIGH/CRITICAL economic event is within
// the next 60 minutes OR was released within the last 30 minutes (the same
// post-release window the Truth news radar treats as LIVE). Polls
// /economic-events/upcoming?hours=1&minImpact=HIGH&pastMinutes=30.
// Pulses red on CRITICAL.
//
// Truth rules:
//   - A released event reads "released Xm ago", never "0m".
//   - A failed calendar check renders a "could not check" notice, never the
//     same empty rendering as a quiet calendar.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CalendarCoverage } from "./UpcomingEventsList";

interface UpcomingEvent {
  id: number; eventName: string; currency: string; impactLevel: "HIGH" | "CRITICAL" | string;
  eventTime: string;
}

// Matches the radar's post-release LIVE window (smartChartLayers RECENT_WINDOW_S).
export const HIGH_IMPACT_POST_RELEASE_WINDOW_MIN = 30;

export function HighImpactEventBanner() {
  const { data, isError, dataUpdatedAt } = useQuery<{ events: UpcomingEvent[]; calendarCoverage?: CalendarCoverage }>({
    queryKey: ["upcoming-high-impact"],
    queryFn: async () => {
      const r = await fetch(
        `/api/economic-events/upcoming?hours=1&minImpact=HIGH&pastMinutes=${HIGH_IMPACT_POST_RELEASE_WINDOW_MIN}`,
      );
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    refetchInterval: 60_000,
  });
  // Re-render between polls so the countdown moves and expired events drop.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  if (isError) {
    const lastOk = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : null;
    return (
      <div
        className="rounded-md border border-slate-600 bg-slate-800/60 p-3 text-xs text-slate-300"
        data-testid="high-impact-banner-unavailable"
      >
        <span className="font-semibold text-slate-200">Could not check the economic calendar.</span>{" "}
        High-impact events are not being monitored right now
        {lastOk ? ` (last successful check ${lastOk})` : ""}. No banner here is not an all-clear.
      </div>
    );
  }

  const windowStartMs = nowMs - HIGH_IMPACT_POST_RELEASE_WINDOW_MIN * 60_000;
  const events = (data?.events ?? []).filter((e) => {
    const t = new Date(e.eventTime).getTime();
    return Number.isFinite(t) && t > windowStartMs;
  });
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
  const anyReleased = events.some((e) => new Date(e.eventTime).getTime() <= nowMs);
  const anyUpcoming = events.some((e) => new Date(e.eventTime).getTime() > nowMs);
  const cls = hasCritical
    ? "border-red-700 bg-red-950/60 text-red-100 animate-pulse"
    : "border-orange-700 bg-orange-950/40 text-orange-100";
  const plural = events.length > 1 ? "s" : "";
  const when = anyReleased && anyUpcoming
    ? `released in the last ${HIGH_IMPACT_POST_RELEASE_WINDOW_MIN} min or due within 1 hour`
    : anyReleased
      ? `released in the last ${HIGH_IMPACT_POST_RELEASE_WINDOW_MIN} min — post-release volatility window`
      : "within 1 hour";
  return (
    <div className={`rounded-md border p-3 text-sm ${cls}`} data-testid="high-impact-banner">
      <div className="font-semibold">⚠ {hasCritical ? "Critical" : "High-impact"} economic event{plural} {when}</div>
      <ul className="mt-1 space-y-0.5 text-xs">
        {events.slice(0, 4).map((e) => {
          const eventMs = new Date(e.eventTime).getTime();
          const deltaMin = Math.round((eventMs - nowMs) / 60000);
          const label = eventMs <= nowMs
            ? `released ${Math.max(0, -deltaMin)}m ago`
            : deltaMin <= 0 ? "in <1m" : `in ${deltaMin}m`;
          return (
            <li key={e.id} data-testid={`high-impact-event-${e.id}`}>
              <span className="font-mono">{label}</span> · {e.impactLevel} · {e.currency} · {e.eventName}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
