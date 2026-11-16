// Legacy /news/calendar event shape. Every event comes from the shared,
// provider-backed calendar service (economicCalendarService.ts).
export interface EconomicEvent {
  id: string;
  title: string;
  country: string;
  currency: string;
  impact: "low" | "medium" | "high";
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  eventTime: string;
  affectedMarkets: string[];
  source: string;
  // ── Provenance (set by toMockShapeEvents from the shared calendar) ───────
  /** Provider id that served the event. */
  provider?: string;
  /** When ARX fetched the event from the provider (ISO). */
  fetchedAt?: string;
  /** Freshness of that fetch. */
  freshness?: "LIVE" | "DELAYED" | "STALE" | "UNAVAILABLE";
  /** True when the fetch is stale: label it, never present as live. */
  stale?: boolean;
  /** "date": eventTime is a date-only sentinel (no countdown, no clock time). */
  timePrecision?: "exact" | "date";
}

// The former in-memory mock generator (a hardcoded FOMC/CPI/NFP schedule at
// invented times, source "Mock") is removed: no surface may show it.


