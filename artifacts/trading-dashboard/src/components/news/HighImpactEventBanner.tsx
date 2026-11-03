// (N) Dashboard banner — shows when a HIGH/CRITICAL economic event is within
// the next 60 minutes OR was released within the last 30 minutes (the same
// post-release window the Truth news radar treats as LIVE). Polls
// /economic-events/upcoming?hours=1&minImpact=HIGH&pastMinutes=30 for timed
// events, and /economic-events (from before today's UTC midnight) for
// date-only releases dated today. Pulses red on a timed CRITICAL event.
//
// Truth rules:
//   - A released event reads "released Xm ago", never "0m".
//   - A failed calendar check renders a "could not check" notice, never the
//     same empty rendering as a quiet calendar.
//   - A date-only source (FRED: release date, midnight-UTC sentinel time) has
//     no observed release time, so it gets no countdown, no "released Xm ago",
//     no "within 1 hour"/post-release heading and no pulse — only its date and
//     "release time not published". With timed rows on screen, only they set
//     the heading's severity, count and colour; date-only rows are named in a
//     separate "also dated …" clause.
//   - A date-only row is shown for the whole UTC date it carries (day-wide
//     read), never selected by the 1-hour window: its midnight sentinel is not
//     a time, so it must not decide when the warning appears or disappears.
//     A failed day read says so — it is not an all-clear either.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CalendarCoverage } from "./UpcomingEventsList";
import { calendarEventWhen, isDateOnlyCalendarSource } from "@/lib/calendarCoverage";

interface UpcomingEvent {
  id: number; eventName: string; currency: string; impactLevel: "HIGH" | "CRITICAL" | string;
  eventTime: string;
  /** Calendar provider of the row; "fred" rows carry a date only. */
  source?: string | null;
}

// Matches the radar's post-release LIVE window (smartChartLayers RECENT_WINDOW_S).
export const HIGH_IMPACT_POST_RELEASE_WINDOW_MIN = 30;

function utcYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Hours back to ask GET /economic-events for so its window starts before
 * today's UTC midnight (where a date-only row's sentinel sits), with an hour
 * of slack for the time between this call and the server's clock read.
 */
export function pastHoursToUtcMidnight(nowMs: number): number {
  const sinceMidnightMs = nowMs - Date.parse(`${utcYmd(nowMs)}T00:00:00.000Z`);
  return Math.min(48, Math.ceil(sinceMidnightMs / 3_600_000) + 1);
}

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
  // Date-only releases (FRED) dated today, whatever the time of day: the
  // 1-hour window above only reaches their midnight sentinel between 23:00
  // and 00:30 UTC. Keyed by the UTC date so a new day reads afresh.
  const todayUtc = utcYmd(nowMs);
  const day = useQuery<{ events: UpcomingEvent[] }>({
    queryKey: ["high-impact-date-only", todayUtc],
    queryFn: async () => {
      const r = await fetch(`/api/economic-events?days=1&pastHours=${pastHoursToUtcMidnight(Date.now())}`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    refetchInterval: 5 * 60_000,
  });

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
  // Only events with a published release time can be "within 1 hour" or
  // "released Xm ago". A date-only row in the window response is there only
  // because of its sentinel, so it is never taken from it.
  const timed = (data?.events ?? []).filter((e) => {
    if (isDateOnlyCalendarSource(e.source)) return false;
    const t = new Date(e.eventTime).getTime();
    return Number.isFinite(t) && t > windowStartMs;
  });
  // Date-only rows are listed by the UTC date they carry: today's, all day.
  const dateOnly = (day.data?.events ?? []).filter((e) =>
    isDateOnlyCalendarSource(e.source) &&
    (e.impactLevel === "HIGH" || e.impactLevel === "CRITICAL") &&
    typeof e.eventTime === "string" && e.eventTime.slice(0, 10) === todayUtc);
  const dayReadFailed = day.isError;
  const events = [...timed, ...dateOnly];
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
    if (dayReadFailed) {
      return (
        <div data-testid="high-impact-banner-date-only-unavailable" className="rounded-md border border-slate-600 bg-slate-900/60 p-2 text-xs text-slate-300">
          Releases listed by date only (FRED, no published time) could not be loaded for {todayUtc} (UTC date), so one
          dated {todayUtc} cannot be ruled out. No banner here is not an all-clear.
        </div>
      );
    }
    return null;
  }
  // The heading's severity word, count and colour describe the rows its time
  // phrase is about: the timed rows when there are any. An untimed CRITICAL
  // row is not known to be within the hour, so it never makes a "within 1
  // hour" heading critical; it is named separately, by its date.
  const headed = timed.length > 0 ? timed : dateOnly;
  const headedCritical = headed.some((e) => e.impactLevel === "CRITICAL");
  const anyReleased = timed.some((e) => new Date(e.eventTime).getTime() <= nowMs);
  const anyUpcoming = timed.some((e) => new Date(e.eventTime).getTime() > nowMs);
  const cls = headedCritical
    ? `border-red-700 bg-red-950/60 text-red-100${timed.length > 0 ? " animate-pulse" : ""}`
    : "border-orange-700 bg-orange-950/40 text-orange-100";
  const plural = headed.length > 1 ? "s" : "";
  const dateOnlyDates = Array.from(new Set(dateOnly.map((e) => e.eventTime.slice(0, 10)))).join(", ");
  const when = timed.length === 0
    ? `dated ${dateOnlyDates} — release time not published`
    : anyReleased && anyUpcoming
      ? `released in the last ${HIGH_IMPACT_POST_RELEASE_WINDOW_MIN} min or due within 1 hour`
      : anyReleased
        ? `released in the last ${HIGH_IMPACT_POST_RELEASE_WINDOW_MIN} min — post-release volatility window`
        : "within 1 hour";
  const alsoDated = timed.length > 0 && dateOnly.length > 0
    ? ` · also dated ${dateOnlyDates}, release time not published: ${dateOnly
      .map((e) => `${e.eventName} (${String(e.impactLevel).toLowerCase()})`)
      .join(", ")}`
    : "";
  return (
    <div className={`rounded-md border p-3 text-sm ${cls}`} data-testid="high-impact-banner">
      <div className="font-semibold">⚠ {headedCritical ? "Critical" : "High-impact"} economic event{plural} {when}{alsoDated}</div>
      <ul className="mt-1 space-y-0.5 text-xs">
        {events.slice(0, 4).map((e) => {
          const eventMs = new Date(e.eventTime).getTime();
          const deltaMin = Math.round((eventMs - nowMs) / 60000);
          const label = isDateOnlyCalendarSource(e.source)
            ? calendarEventWhen(e, nowMs).display
            : eventMs <= nowMs
              ? `released ${Math.max(0, -deltaMin)}m ago`
              : deltaMin <= 0 ? "in <1m" : `in ${deltaMin}m`;
          return (
            <li key={e.id} data-testid={`high-impact-event-${e.id}`}>
              <span className="font-mono">{label}</span> · {e.impactLevel} · {e.currency} · {e.eventName}
            </li>
          );
        })}
      </ul>
      {dayReadFailed && (
        <p className="mt-1 text-xs opacity-80" data-testid="high-impact-banner-date-only-failed">
          Releases listed by date only (no published time) could not be loaded for {todayUtc} (UTC date).
        </p>
      )}
    </div>
  );
}
