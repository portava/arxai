// What a calendar surface may say about the economic calendar it shows.
//
// GET /news/calendar returns a bare array and returns [] both when the
// provider listed nothing and when it could not be read at all (no provider
// configured, or a failing fetch). An empty list is only "no events" when the
// live provider status (GET /economic-calendar/events, the unified endpoint)
// says the provider is connected. Otherwise the calendar was not checked and
// the surface must say so — never "No events" / an all-clear.
//
// Event times: FRED publishes release DATES only (the server emits a
// midnight-UTC date sentinel), so a FRED event has no release time to show,
// count down to, or call past while its date is today.

export interface CalendarProviderStatus {
  connected: boolean;
  configured: boolean;
  provider: string;
  lastErrorMessage?: string | null;
}

export interface CalendarCoverage {
  /** True only when a connected provider was read: an empty list then means "none listed". */
  read: boolean;
  /** Plain-English reason the calendar was not read ("" when read). */
  note: string;
}

const PROVIDER_LABELS: Record<string, string> = { fred: "FRED", trading_economics: "Trading Economics" };

export function calendarProviderLabel(provider: string | null | undefined): string {
  if (!provider || provider === "none") return "The calendar provider";
  return PROVIDER_LABELS[provider] ?? provider;
}

export function describeCalendarCoverage(input: {
  status: CalendarProviderStatus | undefined;
  statusError: boolean;
  listError: boolean;
}): CalendarCoverage {
  const notAllClear = "This is not an all-clear.";
  if (input.listError) {
    return { read: false, note: `Could not load the economic calendar, so scheduled events were not checked. ${notAllClear}` };
  }
  if (input.statusError) {
    return { read: false, note: `Could not read the calendar provider status, so scheduled events were not checked. ${notAllClear}` };
  }
  const s = input.status;
  if (!s) return { read: false, note: "Checking the calendar provider…" };
  if (!s.configured) {
    return { read: false, note: `No economic calendar provider is configured, so scheduled events were not checked. ${notAllClear}` };
  }
  if (!s.connected) {
    const why = s.lastErrorMessage ? ` (${s.lastErrorMessage})` : "";
    return {
      read: false,
      note: `${calendarProviderLabel(s.provider)} could not be read${why}, so scheduled events were not checked. ${notAllClear}`,
    };
  }
  return { read: true, note: "" };
}

/** The calendar read state GET /news/calendar/envelope returns with its events. */
export interface CalendarEnvelopeState {
  read: boolean;
  provider?: string | null;
  eventsAsOf?: string | null;
  note?: string | null;
}

/**
 * What a surface may say about a calendar it read through ONE envelope
 * response (events + read state together). A failed request is "could not
 * load", a read that did not reach a connected provider carries the server's
 * plain note, and only a read calendar may call an empty list "no events".
 */
export function describeCalendarEnvelope(input: {
  envelope: CalendarEnvelopeState | undefined;
  isError: boolean;
}): CalendarCoverage {
  const notAllClear = "This is not an all-clear.";
  if (input.isError) {
    return { read: false, note: `Could not load the economic calendar, so scheduled events were not checked. ${notAllClear}` };
  }
  const env = input.envelope;
  if (!env) return { read: false, note: "Checking the calendar provider…" };
  if (env.read === true) return { read: true, note: "" };
  const note = typeof env.note === "string" && env.note.trim() ? env.note.trim() : "";
  return {
    read: false,
    note: note || `${calendarProviderLabel(env.provider)} was not read, so scheduled events were not checked. ${notAllClear}`,
  };
}

/** "Trading Economics · events fetched 09:15 UTC", or null when the fetch time is unknown. */
export function calendarEventsAsOfLabel(env: CalendarEnvelopeState | undefined): string | null {
  if (!env || env.read !== true || !env.eventsAsOf) return null;
  const t = Date.parse(env.eventsAsOf);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${calendarProviderLabel(env.provider)} · events fetched ${hhmm} UTC`;
}

export function isDateOnlyCalendarSource(source: string | null | undefined): boolean {
  return typeof source === "string" && source.trim().toLowerCase() === "fred";
}

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface CalendarEventWhen {
  /** Countdown / age text, e.g. "in 2h", "3h ago", "today · time not published". */
  label: string;
  /** True when the event is confirmed to be in the past. */
  past: boolean;
  /** Date (and time when known) for display. */
  display: string;
}

export function calendarEventWhen(e: { eventTime: string; source?: string | null }, nowMs: number): CalendarEventWhen {
  const t = new Date(e.eventTime).getTime();
  if (Number.isNaN(t)) return { label: "", past: false, display: "—" };
  if (isDateOnlyCalendarSource(e.source)) {
    const ymd = e.eventTime.slice(0, 10);
    const today = localYmd(new Date(nowMs));
    const days = Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    const display = `${ymd} (release time not published)`;
    if (days === 0) return { label: "today · time not published", past: false, display };
    if (days > 0) return { label: days === 1 ? "tomorrow" : `in ${days}d`, past: false, display };
    return { label: `${-days}d ago`, past: true, display };
  }
  const display = new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const mins = (t - nowMs) / 60_000;
  const abs = Math.abs(mins);
  const span = abs < 60 ? `${Math.round(abs)}m` : abs < 1440 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  if (mins < 0) return { label: `${span} ago`, past: true, display };
  return { label: `in ${span}`, past: false, display };
}
